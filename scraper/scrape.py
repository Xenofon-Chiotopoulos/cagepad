#!/usr/bin/env python3
"""Scrape the newest puzzles from the logic-masters.de Rätselportal and cache their
SudokuPad / f-puzzles data as static JSON, so the CagePad site can load them without
needing a CORS proxy.

Usage:
  python scraper/scrape.py                 # scan the newest-puzzles list
  python scraper/scrape.py --ids 000VJX    # (re)fetch specific puzzles
"""
import argparse
import datetime as dt
import html
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lzstring import decompress_from_base64  # noqa: E402

LM = "https://logic-masters.de/Raetselportal"
LIST_URL = LM + "/Suche/einfach.php?start={start}&sort=neu"
PUZZLE_URL = LM + "/Raetsel/zeigen.php?id={id}"
SUDOKUPAD_API = "https://sudokupad.app/api/puzzle/{id}"
UA = "CagePad-scraper/1.0 (+https://github.com/; caches puzzle data for a personal solver)"
REQUEST_DELAY = 1.0
ID_RE = re.compile(r"^(?=[0-9A-Z]*\d)[0-9A-Z]{6}$")  # logic-masters ids look like 000VJX
SUDOKUPAD_HOSTS = ("sudokupad.app", "beta.sudokupad.app", "sudokupad.svencodes.com",
                   "app.crackingthecryptic.com", "crackingthecryptic.com")
SHORTENER_HOSTS = ("tinyurl.com", "bit.ly", "t.ly", "is.gd", "rb.gy", "shorturl.at", "tiny.cc", "cutt.ly")
DATA_PREFIX_RE = re.compile(r"^(scl|ctc|fpuzzles|fpuz|scf)")

_last_request = 0.0


def fetch(url, retries=2):
    """GET a URL politely; returns (text, final_url)."""
    global _last_request
    err = None
    for attempt in range(retries + 1):
        wait = REQUEST_DELAY - (time.time() - _last_request)
        if wait > 0:
            time.sleep(wait)
        _last_request = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as res:
                raw = res.read()
                charset = res.headers.get_content_charset() or "utf-8"
                return raw.decode(charset, errors="replace"), res.geturl()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            err = e
        except urllib.error.URLError as e:
            # an invalid/expired certificate will not fix itself in a few seconds
            if isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError):
                raise
            err = e
        except Exception as e:  # other network errors: retry
            err = e
        time.sleep(2 * (attempt + 1))
    raise err


def html_to_text(fragment):
    s = re.sub(r"(?is)<(script|style)\b.*?</\1>", "", fragment)
    s = re.sub(r"(?i)<br\s*/?>", "\n", s)
    s = re.sub(r"(?i)</(p|div|li|h\d|tr)>", "\n", s)
    s = re.sub(r"(?i)<li\b[^>]*>", "• ", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s).replace("\xa0", " ").replace("\r", "")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r" *\n *", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def parse_listing(page_html):
    rows = []
    pattern = re.compile(
        r'zeigen\.php\?id=([0-9A-Z]{6})">(.*?)</a><br><span[^>]*>von <a [^>]*>(.*?)</a>\s*\(([^)]*)\)</span>'
        r'<td[^>]*>(\d+)<td[^>]*>(?:<img [^>]*alt="(\d)"[^>]*>)?(?:<br>)?(?:<span title="[^"]*">(.*?)</span>)?',
        re.S)
    for m in pattern.finditer(page_html):
        rows.append({
            "id": m.group(1),
            "title": html_to_text(m.group(2)),
            "author": html_to_text(m.group(3)),
            "solvedCount": int(m.group(5)),
            "difficulty": int(m.group(6)) if m.group(6) else None,
            "rating": html_to_text(m.group(7) or "") or None,
        })
    return rows


def classify_link(url):
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if host in SUDOKUPAD_HOSTS:
        return "sudokupad"
    if host == "f-puzzles.com":
        return "fpuzzles"
    if host in SHORTENER_HOSTS:
        return "short"
    if "penpa" in url:
        return "penpa"
    return None


def parse_puzzle_page(page_html, pid):
    out = {"id": pid}
    m = re.search(r'<div class="rp_titel"><h2>(.*?)</h2>', page_html, re.S)
    out["title"] = html_to_text(m.group(1)) if m else None
    m = re.search(r'class="rp_eingestellt">\(Eingestellt (.*?) von <a [^>]*>(.*?)</a>', page_html, re.S)
    if m:
        out["posted"] = html_to_text(m.group(1))
        out["author"] = html_to_text(m.group(2))
    m = re.search(r'<div class="rp_html">(.*?)<!-- HTML-Code des Raetsels: Ende -->', page_html, re.S)
    body = m.group(1) if m else ""
    out["rules"] = html_to_text(body)
    m = re.search(r'<span class="rp_loesungscode_descr">(.*?)</span>', page_html, re.S)
    out["solutionCode"] = html_to_text(m.group(1)) if m else None
    m = re.search(r'Schwierigkeit:<td><img [^>]*alt="(\d)"', page_html)
    out["difficulty"] = int(m.group(1)) if m else None
    m = re.search(r'Gelöst:<td>(\d+) mal', page_html)
    out["solvedCount"] = int(m.group(1)) if m else None
    m = re.search(r'<div class="rp_tags">(.*?)</div>', page_html, re.S)
    out["tags"] = [t.strip() for t in re.split(r"[\n,]", html_to_text(m.group(1))) if t.strip()] if m else []
    links = []
    for href in re.findall(r'href="([^"]+)"', body) + re.findall(r"href='([^']+)'", body):
        href = html.unescape(href).strip()
        kind = classify_link(href)
        if kind and href not in [l["url"] for l in links]:
            links.append({"url": href, "kind": kind})
    out["links"] = links
    return out


def sudokupad_settings(url):
    q = urllib.parse.urlsplit(url).query
    return {k[len("setting-"):]: v for k, v in urllib.parse.parse_qsl(q) if k.startswith("setting-")}


def raw_query_param(url, name):
    """Read a query value WITHOUT turning '+' into ' ' (lz-string base64 uses '+')."""
    m = re.search(r"[?&]" + re.escape(name) + r"=([^&#]*)", url)
    return urllib.parse.unquote(m.group(1)) if m else None


def resolve_link(link):
    """Return (data_string, settings, resolved_url) for a puzzle link."""
    url, kind = link["url"], link["kind"]
    if kind == "short":
        _, final = fetch(url)
        kind = classify_link(final)
        if kind not in ("sudokupad", "fpuzzles"):
            return None, {}, final
        url = final
    if kind == "fpuzzles":
        data = raw_query_param(url, "load")
        return ("fpuzzles" + data if data else None), {}, url
    if kind == "sudokupad":
        settings = sudokupad_settings(url)
        data = raw_query_param(url, "puzzle")
        if data:
            return data, settings, url
        path = urllib.parse.unquote(urllib.parse.urlsplit(url).path).lstrip("/")
        path = re.sub(r"^(sudoku|puzzle)/", "", path)
        if DATA_PREFIX_RE.match(path):
            return path, settings, url
        if not path:
            return None, settings, url
        text, _ = fetch(SUDOKUPAD_API.format(id=urllib.parse.quote(path, safe="/")))
        text = text.strip()
        if DATA_PREFIX_RE.match(text) or text.startswith("{"):
            return text, settings, url
        return None, settings, url
    return None, {}, url


def unzip_scl(z):
    """Port of SudokuPad's PuzzleZipper.unzip for the 'zipped' JSON variant."""
    prop_map = {"color": "c", "cages": "ca", "center": "ct", "borderColor": "c1", "backgroundColor": "c2",
                "cells": "ce", "cellSize": "cs", "arrows": "a", "overlays": "o", "underlays": "u", "width": "w",
                "height": "h", "value": "v", "videos": "vd", "lines": "l", "rounded": "r", "regions": "re",
                "fontSize": "fs", "thickness": "th", "headLength": "hl", "wayPoints": "wp", "title": "t",
                "text": "te", "duration": "d", "d": "d2"}
    rev = {v: k for k, v in prop_map.items()}
    if '"' not in z:
        z = z.replace("\\'", "’").replace("'", '"').replace("’", "'")
    parts = re.split(r'("(?:[^"\\]|\\.)*")', z)
    strings = parts[1::2]
    body = "".join(p if i % 2 == 0 else '"__S%d__"' % (i // 2) for i, p in enumerate(parts))
    body = re.sub(r"([,{\[])([a-zA-Z0-9]+):", r'\1"\2":', body)
    body = re.sub(r"([,{\[])(?=[,}\]])", r"\1_", body).replace("{_}", "{}")
    body = re.sub(r"([,{\[])_", r"\1{}", body)
    body = re.sub(r"(:)f([,}\]])", r"\1false\2", body)
    body = re.sub(r"(:)t([,}\]])", r"\1true\2", body)
    body = re.sub(r"(:)#0([,}\]])", r'\1"#000000"\2', body)
    body = re.sub(r"(:)#F([,}\]])", r'\1"#FFFFFF"\2', body)
    body = re.sub(r"(:)([0-9a-fA-F]{6})([,}\]])", r'\1"#\2"\3', body)
    body = re.sub(r'"__S(\d+)__"', lambda m: strings[int(m.group(1))], body)

    def remap(o):
        if isinstance(o, list):
            return [remap(x) for x in o]
        if isinstance(o, dict):
            return {rev.get(k, k): remap(v) for k, v in o.items()}
        return o
    return remap(json.loads(body))


def summarize(data):
    """Decode puzzle data just enough to tag it (grid size, cages, solution)."""
    m = DATA_PREFIX_RE.match(data)
    prefix = m.group(1) if m else ""
    payload = data[len(prefix):]
    text = payload if payload.startswith("{") else decompress_from_base64(payload)
    if not text:
        return {"format": prefix or "unknown", "decoded": False}
    try:
        obj = json.loads(text)
    except ValueError:
        obj = unzip_scl(text)
    info = {"format": "fpuzzles" if prefix.startswith("fpuz") else (prefix or "json"), "decoded": True}
    if prefix.startswith("fpuz"):
        size = obj.get("size") or len(obj.get("grid") or [])
        info.update(rows=size, cols=size,
                    cages=len([c for c in obj.get("killercage", []) if c.get("value")]),
                    hasSolution=bool(obj.get("solution")))
        feats = [k for k in obj if k not in ("size", "title", "author", "ruleset", "grid", "solution")]
    else:
        cells = obj.get("cells") or []
        meta = obj.get("metadata") or {}
        visible = [c for c in obj.get("cages", []) if c.get("cells") and not c.get("hidden")
                   and c.get("type") not in ("rowcol", "region")]
        info.update(rows=len(cells), cols=max((len(r) for r in cells), default=0),
                    cages=len([c for c in visible if str(c.get("value", "")).strip()]),
                    hasSolution=bool(meta.get("solution")) or any(
                        str(c.get("value", "")).startswith("solution:") for c in obj.get("cages", [])))
        feats = [k for k in ("lines", "arrows", "overlays", "underlays") if obj.get(k)]
    info["features"] = feats
    return info


def scrape_puzzle(pid, base=None):
    rec = dict(base or {})
    rec["id"] = pid
    page, _ = fetch(PUZZLE_URL.format(id=pid))
    parsed = parse_puzzle_page(page, pid)
    if not parsed.get("title"):
        raise LookupError("no puzzle with this id")
    rec.update({k: v for k, v in parsed.items() if v not in (None, "", [])})
    rec["data"] = None
    rec["error"] = None
    for link in rec.get("links", []):
        if link["kind"] == "penpa":
            continue
        try:
            data, settings, resolved = resolve_link(link)
        except Exception as e:
            rec["error"] = "%s: %s" % (link["url"], e)
            continue
        if data:
            rec.update(data=data, settings=settings, link=resolved, linkKind=link["kind"], error=None)
            try:
                rec["summary"] = summarize(data)
            except Exception as e:
                rec["summary"] = {"decoded": False, "error": str(e)}
            break
    if not rec.get("link") and rec.get("links"):
        rec["link"] = rec["links"][0]["url"]
        rec["linkKind"] = rec["links"][0]["kind"]
    return rec


def index_entry(rec):
    s = rec.get("summary") or {}
    return {k: v for k, v in {
        "id": rec["id"], "title": rec.get("title"), "author": rec.get("author"),
        "firstSeen": rec.get("firstSeen"), "difficulty": rec.get("difficulty"),
        "solvedCount": rec.get("solvedCount"), "rating": rec.get("rating"),
        "playable": bool(rec.get("data")), "linkKind": rec.get("linkKind"),
        "rows": s.get("rows"), "cols": s.get("cols"), "cages": s.get("cages"),
        "hasSolution": s.get("hasSolution"), "tags": rec.get("tags") or None,
        "spId": sudokupad_short_id(rec.get("link")),
    }.items() if v is not None}


def sudokupad_short_id(url):
    if not url or classify_link(url) != "sudokupad" or "puzzle=" in url:
        return None
    path = urllib.parse.urlsplit(url).path.lstrip("/")
    path = re.sub(r"^(sudoku|puzzle)/", "", path)
    return path if path and not DATA_PREFIX_RE.match(path) and len(path) < 64 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
    ap.add_argument("--pages", type=int, default=3, help="listing pages to scan (20 puzzles each)")
    ap.add_argument("--max-new", type=int, default=150, help="max puzzle pages to fetch this run")
    ap.add_argument("--ids", default="", help="comma/space separated logic-masters ids to (re)fetch")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    pdir = os.path.join(out, "puzzles")
    os.makedirs(pdir, exist_ok=True)
    index_path = os.path.join(out, "index.json")
    try:
        with open(index_path) as f:
            index = {p["id"]: p for p in json.load(f).get("puzzles", [])}
    except (OSError, ValueError):
        index = {}

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    todo = []  # (id, listing row)
    forced = [i for i in re.split(r"[\s,]+", args.ids.upper()) if ID_RE.match(i)]
    for pid in forced:
        todo.append((pid, {}))

    if not forced:
        for page in range(args.pages):
            try:
                text, _ = fetch(LIST_URL.format(start=page * 20))
            except Exception as e:
                print("listing page %d failed: %s" % (page, e), file=sys.stderr)
                break
            rows = parse_listing(text)
            if not rows:
                break
            for row in rows:
                prev = index.get(row["id"])
                if prev:
                    # refresh cheap listing stats without refetching the page
                    for k in ("solvedCount", "difficulty", "rating"):
                        if row.get(k) is not None:
                            prev[k] = row[k]
                if prev is None or should_retry(load_record(pdir, row["id"])):
                    todo.append((row["id"], row))

    changed = 0
    for pid, row in todo[:args.max_new]:
        old = load_record(pdir, pid) or {}
        base = dict(old)
        base.update({k: v for k, v in row.items() if v is not None})
        base.setdefault("firstSeen", now)
        try:
            rec = scrape_puzzle(pid, base)
        except (urllib.error.HTTPError, LookupError) as e:
            print("%s: %s" % (pid, e), file=sys.stderr)
            continue
        except Exception as e:
            print("%s: %s" % (pid, e), file=sys.stderr)
            rec = base
            rec["error"] = str(e)
        rec["attempts"] = 0 if rec.get("data") else old.get("attempts", 0) + 1
        rec["fetched"] = now
        with open(os.path.join(pdir, pid + ".json"), "w") as f:
            json.dump(rec, f, ensure_ascii=False, separators=(",", ":"))
        index[pid] = index_entry(rec)
        changed += 1
        print("%s %-40s %s" % (pid, (rec.get("title") or "")[:40],
                                "ok" if rec.get("data") else "no data (%s)" % rec.get("error")))

    puzzles = sorted(index.values(), key=lambda p: p["id"], reverse=True)
    with open(index_path, "w") as f:
        json.dump({"updated": now, "count": len(puzzles), "puzzles": puzzles}, f,
                  ensure_ascii=False, separators=(",", ":"))
    print("updated %d puzzle(s); index has %d" % (changed, len(puzzles)))


def load_record(pdir, pid):
    try:
        with open(os.path.join(pdir, pid + ".json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def should_retry(rec):
    """Retry puzzles whose data could not be fetched (e.g. SudokuPad outage), with backoff."""
    if rec is None:
        return True
    if rec.get("data") or not any(l["kind"] != "penpa" for l in rec.get("links", [])):
        return False
    attempts = rec.get("attempts", 0)
    if attempts >= 12:
        return False
    try:
        last = dt.datetime.fromisoformat(rec["fetched"])
    except (KeyError, ValueError):
        return True
    return dt.datetime.now(dt.timezone.utc) - last >= dt.timedelta(hours=min(2 ** attempts, 24) / 2)


if __name__ == "__main__":
    main()
