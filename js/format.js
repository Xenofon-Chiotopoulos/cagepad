/* CagePad — puzzle formats.
 * Understands the SudokuPad "scl"/"ctc" format (lz-string + optional key "zipping"),
 * f-puzzles data, and the links people post on logic-masters.de.
 * Everything is normalised into one model (see normalize()).
 */
(function (CP) {
	'use strict';

	const DATA_PREFIX = /^(scl|ctc|fpuzzles|fpuz|scf)/;
	const SUDOKUPAD_HOSTS = ['sudokupad.app', 'beta.sudokupad.app', 'sudokupad.svencodes.com',
		'app.crackingthecryptic.com', 'crackingthecryptic.com'];
	const SHORTENER_HOSTS = ['tinyurl.com', 'bit.ly', 't.ly', 'is.gd', 'rb.gy', 'shorturl.at', 'tiny.cc', 'cutt.ly'];

	// ---------- input classification ----------

	// Read a query value without turning '+' into ' ' (lz-string base64 uses '+').
	const rawParam = (url, name) => {
		const m = url.match(new RegExp('[?&#]' + name + '=([^&#]*)'));
		return m ? safeDecode(m[1]) : null;
	};
	const safeDecode = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };

	const URL_RE = /^https?:\/\/([^/?#:]+)(?::\d+)?([^?#]*)/i;
	const hostOf = url => { const m = url.match(URL_RE); return m ? m[1].replace(/^www\./, '').toLowerCase() : ''; };
	const pathOf = url => { const m = url.match(URL_RE); return m ? m[2] : ''; };

	/** Work out what the user pasted. Returns {kind, ...}. */
	function classifyInput(input) {
		let s = String(input || '').trim();
		if (!s) return {kind: 'empty'};
		if (/^[0-9A-Za-z]{6}$/.test(s) && /\d/.test(s)) return {kind: 'lm', id: s.toUpperCase()};
		if (DATA_PREFIX.test(s) || s.startsWith('{')) return {kind: 'data', data: s};
		if (!/^https?:\/\//i.test(s) && /^[\w.-]+\.[a-z]{2,}\//i.test(s)) s = 'https://' + s;
		const host = hostOf(s);
		if (!host) return {kind: 'unknown', text: s};
		if (host.endsWith('logic-masters.de')) {
			const id = rawParam(s, 'id');
			return id ? {kind: 'lm', id: id.toUpperCase(), url: s} : {kind: 'unknown', text: s};
		}
		if (SUDOKUPAD_HOSTS.includes(host)) {
			const settings = {};
			s.replace(/[?&]setting-([\w-]+)=([^&#]*)/g, (_, k, v) => { settings[k] = v; });
			const data = rawParam(s, 'puzzle');
			if (data) return {kind: 'data', data, settings, url: s};
			let path = safeDecode(pathOf(s)).replace(/^\/+/, '').replace(/^(sudoku|puzzle)\//, '');
			if (DATA_PREFIX.test(path)) return {kind: 'data', data: path, settings, url: s};
			if (path) return {kind: 'sp', id: path, settings, url: s};
			return {kind: 'unknown', text: s};
		}
		if (host === 'f-puzzles.com') {
			const data = rawParam(s, 'load');
			return data ? {kind: 'data', data: 'fpuzzles' + data, url: s} : {kind: 'unknown', text: s};
		}
		if (SHORTENER_HOSTS.includes(host)) return {kind: 'short', url: s};
		return {kind: 'external', url: s};
	}

	// ---------- decoding ----------

	const PROP_MAP = {
		color: 'c', cages: 'ca', center: 'ct', borderColor: 'c1', backgroundColor: 'c2', cells: 'ce',
		cellSize: 'cs', arrows: 'a', overlays: 'o', underlays: 'u', width: 'w', height: 'h', value: 'v',
		videos: 'vd', lines: 'l', rounded: 'r', regions: 're', fontSize: 'fs', thickness: 'th',
		headLength: 'hl', wayPoints: 'wp', title: 't', text: 'te', duration: 'd', d: 'd2',
	};
	const REV_MAP = Object.fromEntries(Object.entries(PROP_MAP).map(([k, v]) => [v, k]));

	/** SudokuPad's "zipped" JSON: unquoted keys, short key names, f/t booleans, bare hex colours. */
	function unzipJson(z) {
		if (z.indexOf('"') === -1) z = z.replace(/\\'/g, '’').replace(/'/g, '"').replace(/’/g, '\'');
		const parts = z.split(/("(?:[^"\\]|\\.)*")/);
		const strings = parts.filter((_, i) => i % 2);
		let body = parts.map((p, i) => i % 2 ? `"__S${(i - 1) / 2}__"` : p).join('');
		body = body
			.replace(/([,{[])([a-zA-Z0-9]+):/g, '$1"$2":')
			.replace(/([,{[])(?=[,}\]])/g, '$1_').replace(/{_}/g, '{}').replace(/([,{[])_/g, '$1{}')
			.replace(/(:)f([,}\]])/g, '$1false$2').replace(/(:)t([,}\]])/g, '$1true$2')
			.replace(/(:)#0([,}\]])/g, '$1"#000000"$2').replace(/(:)#F([,}\]])/g, '$1"#FFFFFF"$2')
			.replace(/(:)([0-9a-fA-F]{6})([,}\]])/g, '$1"#$2"$3')
			.replace(/"__S(\d+)__"/g, (_, i) => strings[+i]);
		const remap = o => {
			if (Array.isArray(o)) return o.map(remap);
			if (o && typeof o === 'object') {
				const r = {};
				for (const k of Object.keys(o)) r[REV_MAP[k] || k] = remap(o[k]);
				return r;
			}
			if (typeof o === 'string' && /^[0-9a-fA-F]{6}$/.test(o)) return '#' + o;
			return o;
		};
		return remap(JSON.parse(body));
	}

	const parseJsonLoose = text => {
		try { return JSON.parse(text); } catch (e) { return unzipJson(text); }
	};

	function decompress(payload) {
		if (payload.startsWith('{')) return payload;
		let out = null;
		try { out = LZString.decompressFromBase64(payload); } catch (e) { out = null; }
		if (!out && payload.indexOf(' ') !== -1) {   // '+' mangled into ' ' by some URL handling
			try { out = LZString.decompressFromBase64(payload.replace(/ /g, '+')); } catch (e) { out = null; }
		}
		if (!out) throw new Error('Could not decompress puzzle data');
		return out;
	}

	/** Decode any puzzle data string to a SudokuPad-style object. */
	function decodeData(data) {
		data = String(data).trim();
		if (/%[0-9A-F]{2}/i.test(data)) data = safeDecode(data);
		const m = data.match(DATA_PREFIX);
		const prefix = m ? m[1] : '';
		const payload = data.slice(prefix.length);
		if (prefix === 'scf') throw new Error('The "scf" puzzle format is not supported yet');
		const obj = parseJsonLoose(decompress(payload));
		if (prefix.startsWith('fpuz') || (obj && obj.grid && obj.size)) return fromFPuzzles(obj);
		return obj;
	}

	// ---------- f-puzzles → SudokuPad-style object ----------

	const fpRC = rc => {
		const m = String(rc).match(/R(\d+)C(\d+)/i);
		return [+m[1] - 1, +m[2] - 1];
	};
	const centerOf = cells => {
		const rcs = cells.map(fpRC);
		return [rcs.reduce((a, [r]) => a + r + 0.5, 0) / rcs.length, rcs.reduce((a, [, c]) => a + c + 0.5, 0) / rcs.length];
	};
	const boxShape = n => {
		for (let h = Math.floor(Math.sqrt(n)); h >= 1; h--) if (n % h === 0) return [h, n / h];
		return [1, n];
	};
	const FP_COLORS = ['#a8a8a8', '#000000', '#ffa0a0', '#ffdf61', '#feffaf', '#b0ffb0', '#61d060', '#d0d0ff', '#8180f0', '#ff08ff', '#ffd0ff'];
	const LK_DIRS = {UL: [-1, -1], UR: [-1, 1], DL: [1, -1], DR: [1, 1]};

	function fromFPuzzles(fp) {
		const size = fp.size || (fp.grid || []).length || 9;
		const [bh, bw] = boxShape(size);
		const p = {cells: [], regions: [], cages: [], lines: [], arrows: [], overlays: [], underlays: [],
			metadata: {}, littleKillers: [], semantic: {}};
		const meta = p.metadata;
		if (fp.title) meta.title = fp.title;
		if (fp.author) meta.author = fp.author;
		if (fp.ruleset) meta.rules = fp.ruleset;
		const regions = {};
		(fp.grid || []).forEach((row, r) => {
			p.cells.push(row.map((cell, c) => {
				const out = {};
				if (cell.given && cell.value !== undefined) out.value = cell.value;
				const reg = cell.region === null ? null
					: cell.region === undefined ? Math.floor(r / bh) * bh + Math.floor(c / bw) : +cell.region;
				if (reg !== null) (regions[reg] = regions[reg] || []).push([r, c]);
				let col = cell.c || (cell.cArray || [])[0];
				if (col !== undefined && col !== null) {
					if (/^\d+$/.test(String(col))) col = FP_COLORS[+col];
					if (col) p.underlays.push({center: [r + 0.5, c + 0.5], width: 1, height: 1, backgroundColor: col});
				}
				return out;
			}));
		});
		p.regions = Object.keys(regions).sort((a, b) => a - b).map(k => regions[k]);
		if (fp.solution) {
			const sol = Array.isArray(fp.solution) ? fp.solution : String(fp.solution).split(String(fp.solution).includes(',') ? ',' : '');
			const s = sol.map(v => String(v).length === 1 ? String(v) : '?').join('');
			if (!/^[.0?]*$/.test(s)) meta.solution = s;
		}
		if (fp.antiknight) meta.antiknight = true;
		if (fp.antiking) meta.antiking = true;
		if (fp.nonconsecutive) meta.nonconsecutive = true;
		if (fp['diagonal+']) { meta['diagonal+'] = true; p.lines.push({wayPoints: [[size, 0], [0, size]], color: '#34BBE6', thickness: 2}); }
		if (fp['diagonal-']) { meta['diagonal-'] = true; p.lines.push({wayPoints: [[0, 0], [size, size]], color: '#34BBE6', thickness: 2}); }

		const pathOf = line => line.map(fpRC).map(([r, c]) => [r + 0.5, c + 0.5]);
		const each = (key, fn) => (fp[key] || []).forEach(fn);

		each('killercage', cage => {
			if (!cage.cells || !cage.cells.length) return;
			const v = cage.value !== undefined && cage.value !== null && cage.value !== '' ? String(cage.value) : undefined;
			p.cages.push({cells: cage.cells.map(fpRC), value: v, unique: true, style: 'killer'});
		});
		each('cage', cage => {
			const v = cage.value === undefined ? '' : String(cage.value);
			const metaMatch = v.match(/^([a-z]+):\s*([\s\S]*)$/i);
			if (metaMatch && (!cage.cells || !cage.cells.length || /#[0-9a-f]{3}0|#[0-9a-f]{6}00/i.test(cage.outlineC || '#0000'))) {
				meta[metaMatch[1].toLowerCase()] = metaMatch[2];
				return;
			}
			if (!cage.cells || !cage.cells.length) return;
			p.cages.push({cells: cage.cells.map(fpRC), value: v || undefined, unique: !!cage.unique,
				style: 'killer', borderColor: cage.outlineC, textColor: cage.fontC});
		});
		each('extraregion', er => p.cages.push({cells: er.cells.map(fpRC), unique: true, style: 'extraregion'}));
		each('littlekillersum', lk => {
			const [r, c] = fpRC(lk.cell), d = LK_DIRS[lk.direction] || [1, 1];
			const cr = r + 0.5, cc = c + 0.5;
			p.arrows.push({wayPoints: [[cr + 0.3 * d[0], cc + 0.3 * d[1]], [cr + 0.48 * d[0], cc + 0.48 * d[1]]], color: '#000000', thickness: 2, headLength: 0.15});
			if (lk.value !== undefined && lk.value !== '') p.overlays.push({center: [cr, cc], width: 0.25, height: 0.25, text: String(lk.value), fontSize: 28});
			p.littleKillers.push({start: [r, c], dir: d, value: lk.value});
		});
		each('arrow', a => {
			const bulb = a.cells.map(fpRC);
			(a.lines || []).forEach(line => {
				const pts = pathOf(line);
				if (pts.length < 2) return;
				const dr = pts[1][0] - pts[0][0], dc = pts[1][1] - pts[0][1], dist = Math.hypot(dr, dc);
				pts[0] = [pts[0][0] + 0.4 * dr / dist, pts[0][1] + 0.4 * dc / dist];
				p.arrows.push({wayPoints: pts, color: '#a1a1a1', thickness: 5, headLength: 0.3, bulb});
			});
			const rs = bulb.map(x => x[0]), cs = bulb.map(x => x[1]);
			const w = Math.max(...cs) - Math.min(...cs), h = Math.max(...rs) - Math.min(...rs);
			if (w === 0 || h === 0) {
				p.overlays.push({center: centerOf(a.cells), width: 0.83 + w, height: 0.83 + h, rounded: true,
					borderColor: '#a1a1a1', backgroundColor: '#ffffff', thickness: 5});
			} else {
				p.lines.push({wayPoints: bulb.map(([r, c]) => [r + 0.5, c + 0.5]), color: '#a1a1a1', thickness: 45});
				p.lines.push({wayPoints: bulb.map(([r, c]) => [r + 0.5, c + 0.5]), color: '#ffffff', thickness: 35});
			}
		});
		each('thermometer', t => (t.lines || []).forEach(line => {
			const pts = pathOf(line);
			p.underlays.push({center: pts[0], width: 0.85, height: 0.85, rounded: true, backgroundColor: '#CFCFCF', borderColor: '#CFCFCF'});
			p.lines.push({wayPoints: pts, color: '#CFCFCF', thickness: 21, kind: 'thermo'});
		}));
		each('palindrome', l => (l.lines || []).forEach(line => p.lines.push({wayPoints: pathOf(line), color: '#CFCFCF', thickness: 16})));
		each('line', l => (l.lines || []).forEach(line => p.lines.push({wayPoints: pathOf(line), color: l.outlineC || '#c0c0c0', thickness: 32 * (l.width || 0.3)})));
		const namedLines = {renban: '#f067f0', whispers: '#67f067', regionsumline: '#2ecbff', entropicline: '#ffa500', modularline: '#c19a6b', nabnerline: '#c8c800', zipperline: '#a0a0ff', doublearrow: '#bbbbbb'};
		Object.keys(namedLines).forEach(k => each(k, l => (l.lines || []).forEach(line =>
			p.lines.push({wayPoints: pathOf(line), color: l.outlineC || namedLines[k], thickness: 32 * (l.width || 0.4)}))));
		each('betweenline', l => (l.lines || []).forEach(line => {
			const pts = pathOf(line);
			[pts[0], pts[pts.length - 1]].forEach(ct => p.overlays.push({center: ct, width: 0.8, height: 0.8, rounded: true, borderColor: '#CFCFCF', backgroundColor: '#FFFFFF', thickness: 2}));
			p.lines.push({wayPoints: pts, color: '#CFCFCF', thickness: 2});
		}));
		const dot = (key, bg) => each(key, d => p.overlays.push({center: centerOf(d.cells), width: 0.3, height: 0.3, rounded: true,
			borderColor: '#000000', backgroundColor: bg, text: d.value || '', color: bg === '#000000' ? '#ffffff' : '#000000', fontSize: 14}));
		dot('ratio', '#000000');
		dot('difference', '#FFFFFF');
		each('xv', d => p.overlays.push({center: centerOf(d.cells), width: 0.25, height: 0.25, backgroundColor: '#FFFFFF', text: d.value, fontSize: 21}));
		each('sandwichsum', d => p.overlays.push({center: centerOf([d.cell]), width: 0.25, height: 0.25, text: d.value, fontSize: 32}));
		each('even', d => p.underlays.push({center: centerOf([d.cell]), width: 0.7, height: 0.7, backgroundColor: '#CFCFCF'}));
		each('odd', d => p.underlays.push({center: centerOf([d.cell]), width: 0.7, height: 0.7, rounded: true, backgroundColor: '#CFCFCF'}));
		each('clone', d => [...d.cells, ...(d.cloneCells || [])].forEach(rc => p.underlays.push({center: centerOf([rc]), width: 1, height: 1, backgroundColor: '#CFCFCF'})));
		each('quadruple', d => p.overlays.push({center: centerOf(d.cells), width: 0.7, height: 0.7, rounded: true, backgroundColor: '#FFFFFF', borderColor: '#000000', thickness: 1.5,
			text: (d.values || []).join(' '), fontSize: 14}));
		const minmax = (key, inwards) => each(key, d => {
			const [r, c] = fpRC(d.cell);
			p.underlays.push({center: [r + 0.5, c + 0.5], width: 1, height: 1, backgroundColor: '#cccccc'});
			const a = inwards ? 0.44 : 0.39, b = inwards ? 0.39 : 0.44;
			[[-1, 0], [0, 1], [1, 0], [0, -1]].forEach(([dy, dx]) => {
				const nr = r + dy, nc = c + dx;
				if (nr < 0 || nc < 0 || nr >= size || nc >= size) return;
				const cy = r + 0.5, cx = c + 0.5;
				p.lines.push({color: '#000000', thickness: 1, wayPoints: [
					[cy + dy * a + 0.1 * dx, cx + dx * a + 0.1 * dy], [cy + dy * b, cx + dx * b], [cy + dy * a - 0.1 * dx, cx + dx * a - 0.1 * dy]]});
			});
		});
		minmax('minimum', true);
		minmax('maximum', false);
		each('rectangle', d => p.overlays.push({center: centerOf(d.cells), width: d.width, height: d.height, backgroundColor: d.baseC, borderColor: d.outlineC, thickness: 1, text: d.value, color: d.fontC, angle: d.angle}));
		each('circle', d => p.overlays.push({center: centerOf(d.cells), width: d.width, height: d.height, rounded: true, backgroundColor: d.baseC, borderColor: d.outlineC, thickness: 1, text: d.value, color: d.fontC, angle: d.angle}));
		each('text', d => {
			if (d.value === undefined || d.value === '') return;
			p.overlays.push({center: centerOf(d.cells), width: 0.25, height: 0.25, text: String(d.value), color: d.fontC, fontSize: Math.round(32 * (d.size || 1)), angle: d.angle});
		});
		if (fp.disjointgroups) meta.disjoint = true;
		return p;
	}

	// ---------- normalisation ----------

	const META_CAGE = /^([a-z][a-z0-9]*):\s*([\s\S]*)$/i;
	const META_KEYS = new Set(['title', 'author', 'rules', 'solution', 'msgcorrect', 'msgincorrect', 'customstyle', 'sourcepuzzle']);
	const asNumber = v => (typeof v === 'number' || (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v))) ? +v : null;

	/**
	 * Normalised puzzle:
	 *  rows, cols, givens[i], regionOf[i], regions, cages (visible+hidden constraint groups),
	 *  lines/arrows/overlays/underlays (SudokuPad drawing primitives), meta, maxDigit.
	 */
	function normalize(raw, extra) {
		extra = extra || {};
		const cellsIn = raw.cells || [];
		const rows = cellsIn.length || 9;
		const cols = cellsIn.reduce((m, r) => Math.max(m, (r || []).length), 0) || 9;
		const N = rows * cols;
		const idx = (r, c) => r * cols + c;
		const inGrid = (r, c) => r >= 0 && c >= 0 && r < rows && c < cols;
		const meta = Object.assign({}, raw.metadata || {});
		['title', 'author', 'rules'].forEach(k => { if (raw[k] && !meta[k]) meta[k] = raw[k]; });

		const givens = new Array(N).fill('');
		cellsIn.forEach((row, r) => (row || []).forEach((cell, c) => {
			if (cell && cell.value !== undefined && cell.value !== null && cell.value !== '') givens[idx(r, c)] = String(cell.value);
		}));

		const regionOf = new Array(N).fill(-1);
		const regions = (raw.regions || []).map((cells, ri) => {
			const list = cells.filter(([r, c]) => inGrid(r, c)).map(([r, c]) => idx(r, c));
			list.forEach(i => { regionOf[i] = ri; });
			return list;
		}).filter(l => l.length);

		const cages = [];
		(raw.cages || []).forEach(cg => {
			const value = cg.value === undefined || cg.value === null ? '' : String(cg.value);
			const mm = value.match(META_CAGE);
			const noCells = !cg.cells || !cg.cells.length;
			// Legacy puzzles carry metadata as cages like {value: "title: Foo"}.
			if (noCells || (mm && (META_KEYS.has(mm[1].toLowerCase()) || cg.hidden || isTransparent(cg)))) {
				if (mm) meta[mm[1].toLowerCase()] = meta[mm[1].toLowerCase()] || mm[2];
				return;
			}
			const cells = cg.cells.filter(([r, c]) => inGrid(r, c)).map(([r, c]) => idx(r, c));
			if (!cells.length) return;
			const structural = cg.type === 'rowcol' || cg.type === 'region' || cg.type === 'disjoint' || cg.style === 'extraregion';
			const visible = !cg.hidden && !structural && cg.style !== null;
			const sum = cg.sum !== undefined ? asNumber(cg.sum) : asNumber(value);
			cages.push({
				cells, value, sum: visible || cg.sum !== undefined ? sum : null,
				unique: cg.unique !== undefined ? !!cg.unique : (visible && sum !== null),
				visible, style: cg.style || 'killer', structural,
				borderColor: cg.borderColor || cg.outlineC || cg.cageColor,
				textColor: cg.textColor || cg.fontC,
			});
		});

		// Puzzles with no regions at all still get uniqueness from rows/cols (unless "norowcol").
		const solution = typeof meta.solution === 'string' ? meta.solution.replace(/\s/g, '') : '';
		let maxDigit = 9;
		const regionSize = regions.reduce((m, r) => Math.max(m, r.length), 0);
		if (regionSize) maxDigit = regionSize;
		else if (rows === cols) maxDigit = rows;
		maxDigit = Math.min(Math.max(maxDigit, 1), 9);
		if (/[1-9]/.test(solution)) maxDigit = Math.max(maxDigit, ...solution.split('').filter(ch => /[1-9]/.test(ch)).map(Number));

		return {
			id: extra.id || raw.id || null,
			rows, cols, N, givens, regionOf, regions, cages,
			lines: raw.lines || [], arrows: raw.arrows || [], overlays: raw.overlays || [], underlays: raw.underlays || [],
			littleKillers: raw.littleKillers || [],
			meta, solution: solution.length === N ? solution : '',
			maxDigit,
			settings: extra.settings || {},
			unsupported: ['foglight', 'triggereffect'].filter(k => raw[k] && (raw[k].length || Object.keys(raw[k]).length)),
		};
	}
	const isTransparent = cg => /#[0-9a-f]{3}0$|#[0-9a-f]{6}00$/i.test(cg.outlineC || cg.borderColor || '#0000');

	CP.format = {classifyInput, decodeData, unzipJson, fromFPuzzles, normalize, rawParam, DATA_PREFIX};
})(typeof window !== 'undefined' ? (window.CP = window.CP || {}) : (globalThis.CP = globalThis.CP || {}));
