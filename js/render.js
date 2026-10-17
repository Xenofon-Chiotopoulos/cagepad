/* CagePad — SVG rendering. Units: 64px per cell, the same scale SudokuPad uses, so raw
 * SVG paths ("d") and pixel thicknesses from puzzle data can be used unchanged. */
(function (CP) {
	'use strict';

	const P = 64;
	const esc = s => String(s).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'}[ch]));
	const num = v => Math.round(v * 100) / 100;
	const attr = (name, v) => (v === undefined || v === null || v === '') ? '' : ` ${name}="${esc(v)}"`;

	// ---------- static puzzle drawing ----------

	function bounds(Z) {
		let minR = 0, minC = 0, maxR = Z.rows, maxC = Z.cols;
		const take = (r, c) => {
			if (!isFinite(r) || !isFinite(c)) return;
			minR = Math.min(minR, r); minC = Math.min(minC, c); maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
		};
		[...Z.overlays, ...Z.underlays].forEach(o => {
			if (!o.center) return;
			const h = (o.height || 0) / 2, w = (o.width || 0) / 2;
			take(o.center[0] - h, o.center[1] - w); take(o.center[0] + h, o.center[1] + w);
			if (o.text !== undefined && o.text !== '') take(o.center[0] - 0.25, o.center[1] - 0.25), take(o.center[0] + 0.25, o.center[1] + 0.25);
		});
		[...Z.lines, ...Z.arrows].forEach(l => (l.wayPoints || []).forEach(([r, c]) => take(r, c)));
		const lim = 2;
		minR = Math.max(minR, -lim); minC = Math.max(minC, -lim); maxR = Math.min(maxR, Z.rows + lim); maxC = Math.min(maxC, Z.cols + lim);
		const pad = 0.12;
		return {x: (minC - pad) * P, y: (minR - pad) * P, w: (maxC - minC + 2 * pad) * P, h: (maxR - minR + 2 * pad) * P};
	}

	function lineEl(ln) {
		const common = attr('stroke', ln.color || (ln.d ? undefined : '#000')) +
			attr('stroke-width', ln.thickness !== undefined ? ln.thickness : (ln.d ? 0 : 2)) +
			attr('fill', ln.fill || 'none') +
			attr('stroke-linecap', ln['stroke-linecap'] || 'round') +
			attr('stroke-linejoin', ln['stroke-linejoin'] || 'round') +
			attr('stroke-dasharray', ln['stroke-dasharray'] || ln.dashArray) +
			attr('opacity', ln.opacity);
		if (ln.d) return `<path d="${esc(ln.d)}"${common}/>`;
		if (!ln.wayPoints || !ln.wayPoints.length) return '';
		const pts = ln.wayPoints.map(([r, c]) => num(c * P) + ',' + num(r * P)).join(' ');
		return `<polyline points="${pts}"${common}/>`;
	}

	function arrowEl(ar) {
		const wp = ar.wayPoints;
		if (!wp || wp.length < 2) return '';
		const color = ar.color || '#a1a1a1', th = ar.thickness || 3;
		const pts = wp.map(([r, c]) => [c * P, r * P]);
		const [tx, ty] = pts[pts.length - 1], [px, py] = pts[pts.length - 2];
		const ang = Math.atan2(ty - py, tx - px), hl = (ar.headLength || 0.3) * P;
		const a1 = [tx - hl * Math.cos(ang - Math.PI / 4), ty - hl * Math.sin(ang - Math.PI / 4)];
		const a2 = [tx - hl * Math.cos(ang + Math.PI / 4), ty - hl * Math.sin(ang + Math.PI / 4)];
		const s = `stroke="${esc(color)}" stroke-width="${th}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
		return `<polyline points="${pts.map(p => num(p[0]) + ',' + num(p[1])).join(' ')}" ${s}/>` +
			`<polyline points="${num(a1[0])},${num(a1[1])} ${num(tx)},${num(ty)} ${num(a2[0])},${num(a2[1])}" ${s}/>`;
	}

	function shapeEl(o) {
		if (!o.center) return '';
		const cx = o.center[1] * P, cy = o.center[0] * P;
		const w = (o.width || 0) * P, h = (o.height || 0) * P;
		const transform = o.angle ? ` transform="rotate(${num(o.angle)} ${num(cx)} ${num(cy)})"` : '';
		const fill = o.backgroundColor || 'none';
		let stroke = o.borderColor, sw = o.borderSize !== undefined ? o.borderSize : o.thickness;
		if (!stroke && o.stroke && o.text === undefined) { stroke = o.stroke; sw = o['stroke-width']; }
		if (!stroke && o.stroke && fill !== 'none' && w > 0) { stroke = o.stroke; sw = o['stroke-width']; }
		if (stroke && sw === undefined) sw = 2;
		const style = attr('fill', fill) + attr('stroke', stroke || 'none') + attr('stroke-width', stroke ? sw : undefined) + attr('opacity', o.opacity);
		let out = '';
		if (w > 0 && h > 0 && (fill !== 'none' || stroke)) {
			if (o.rounded) out += `<ellipse cx="${num(cx)}" cy="${num(cy)}" rx="${num(w / 2)}" ry="${num(h / 2)}"${style}/>`;
			else out += `<rect x="${num(cx - w / 2)}" y="${num(cy - h / 2)}" width="${num(w)}" height="${num(h)}"${style}/>`;
		}
		if (o.text !== undefined && o.text !== null && String(o.text) !== '') {
			const fs = o.fontSize || Math.max(12, Math.min(28, Math.min(w || P, h || P) * 0.65));
			const color = o.color || o.textColor || '#000';
			const tStroke = o.textStroke || (o.stroke && !(w > 0 && fill !== 'none') ? o.stroke : null);
			const lines = String(o.text).split('\n');
			const strokeAttr = tStroke ? ` stroke="${esc(tStroke)}" stroke-width="${o['stroke-width'] || 2}" paint-order="stroke" stroke-linejoin="round"` : '';
			out += `<text x="${num(cx)}" y="${num(cy)}" font-size="${num(fs)}" fill="${esc(color)}"${strokeAttr} text-anchor="middle" dominant-baseline="central" class="ov-text">` +
				(lines.length === 1 ? esc(lines[0]) : lines.map((t, k) => `<tspan x="${num(cx)}" dy="${k === 0 ? num(-(lines.length - 1) * fs * 0.55) : num(fs * 1.1)}">${esc(t)}</tspan>`).join('')) + '</text>';
		}
		return out ? `<g${transform}>${out}</g>` : '';
	}

	function gridEl(Z) {
		const {rows, cols, regionOf} = Z;
		let thin = '', thick = '';
		if (!Z.settings.nogrid) {
			for (let r = 0; r <= rows; r++) thin += `M0 ${r * P}H${cols * P}`;
			for (let c = 0; c <= cols; c++) thin += `M${c * P} 0V${rows * P}`;
		}
		const hasRegions = Z.regions.length > 0;
		if (hasRegions) {
			const reg = (r, c) => (r < 0 || c < 0 || r >= rows || c >= cols) ? -2 : regionOf[r * cols + c];
			for (let r = 0; r <= rows; r++) for (let c = 0; c < cols; c++) {   // horizontal edges
				const a = reg(r - 1, c), b = reg(r, c);
				if (a !== b && (a >= 0 || b >= 0)) thick += `M${c * P} ${r * P}h${P}`;
			}
			for (let c = 0; c <= cols; c++) for (let r = 0; r < rows; r++) {   // vertical edges
				const a = reg(r, c - 1), b = reg(r, c);
				if (a !== b && (a >= 0 || b >= 0)) thick += `M${c * P} ${r * P}v${P}`;
			}
		} else if (!Z.settings.nogrid) {
			thick = `M0 0H${cols * P}V${rows * P}H0Z`;
		}
		return (thin ? `<path d="${thin}" class="grid-thin"/>` : '') + (thick ? `<path d="${thick}" class="grid-thick"/>` : '');
	}

	/** Inset outline of a set of cells as chained polylines (so dashes flow round corners). */
	function outlinePaths(cells, cols, inset) {
		const set = new Set(cells);
		const has = (r, c) => c >= 0 && c < cols && r >= 0 && set.has(r * cols + c);
		const segs = [];
		cells.forEach(i => {
			const r = Math.floor(i / cols), c = i % cols;
			// for each side: [neighbour dr,dc], start corner, end corner, along-direction
			// top edge (left→right)
			if (!has(r - 1, c)) segs.push(edge(r, c, 'top', has));
			if (!has(r, c + 1)) segs.push(edge(r, c, 'right', has));
			if (!has(r + 1, c)) segs.push(edge(r, c, 'bottom', has));
			if (!has(r, c - 1)) segs.push(edge(r, c, 'left', has));
		});
		function edge(r, c, side, has) {
			// endpoint offset rule: side-neighbour missing → inset; present with open diagonal → 0; present with diagonal → -inset (concave)
			const off = (sr, sc, dr, dc) => !has(sr, sc) ? inset : (has(sr + dr, sc + dc) ? -inset : 0);
			const i = inset;
			switch (side) {
				case 'top': {
					const y = r + i, a = off(r, c - 1, -1, 0), b = off(r, c + 1, -1, 0);
					return [[c + a, y], [c + 1 - b, y]];
				}
				case 'right': {
					const x = c + 1 - i, a = off(r - 1, c, 0, 1), b = off(r + 1, c, 0, 1);
					return [[x, r + a], [x, r + 1 - b]];
				}
				case 'bottom': {
					const y = r + 1 - i, a = off(r, c + 1, 1, 0), b = off(r, c - 1, 1, 0);
					return [[c + 1 - a, y], [c + b, y]];
				}
				default: {
					const x = c + i, a = off(r + 1, c, 0, -1), b = off(r - 1, c, 0, -1);
					return [[x, r + 1 - a], [x, r + b]];
				}
			}
		}
		// chain segments end→start
		const key = p => num(p[0]) + ',' + num(p[1]);
		const byStart = new Map();
		segs.forEach((s, k) => byStart.set(key(s[0]), k));
		const used = new Array(segs.length).fill(false);
		const paths = [];
		for (let k = 0; k < segs.length; k++) {
			if (used[k]) continue;
			const pts = [segs[k][0], segs[k][1]];
			used[k] = true;
			let cur = segs[k][1], guard = 0;
			while (guard++ < segs.length) {
				const nk = byStart.get(key(cur));
				if (nk === undefined || used[nk]) break;
				used[nk] = true;
				pts.push(segs[nk][1]);
				cur = segs[nk][1];
			}
			const closed = key(pts[0]) === key(pts[pts.length - 1]);
			paths.push('M' + pts.map(([x, y]) => num(x * P) + ' ' + num(y * P)).join('L') + (closed ? 'Z' : ''));
		}
		return paths.join('');
	}

	const labelCell = (cells, cols) => cells.reduce((best, i) => {
		const r = Math.floor(i / cols), c = i % cols, br = Math.floor(best / cols), bc = best % cols;
		return (r < br || (r === br && c < bc)) ? i : best;
	}, cells[0]);

	function cagesEl(Z) {
		let lines = '', labels = '';
		Z.cages.forEach(cg => {
			if (!cg.visible) return;
			const color = cg.borderColor || '#000';
			const dashed = cg.style !== 'box';
			lines += `<path d="${outlinePaths(cg.cells, Z.cols, dashed ? 0.07 : 0)}" fill="none" stroke="${esc(color)}" stroke-width="${dashed ? 1.3 : 3}"${dashed ? ' stroke-dasharray="4.5 3.5"' : ''}/>`;
			if (cg.value !== '' && cg.value !== undefined) {
				const i = labelCell(cg.cells, Z.cols), r = Math.floor(i / Z.cols), c = i % Z.cols;
				const fs = 14, w = String(cg.value).length * fs * 0.6 + 3;
				labels += `<rect x="${c * P + 1.5}" y="${r * P + 1.5}" width="${num(w)}" height="${fs + 1}" class="cage-label-bg"/>` +
					`<text x="${c * P + 3}" y="${r * P + 2 + fs * 0.85}" font-size="${fs}" class="cage-label"${attr('fill', cg.textColor || color)}>${esc(cg.value)}</text>`;
			}
		});
		return lines + labels;
	}

	/** Static puzzle SVG markup split into the layers that sit around the dynamic ones. */
	function buildStatic(Z) {
		const under = [], mid = [], over = [], gridExtra = [];
		Z.underlays.forEach(o => under.push(shapeEl(o)));
		Z.lines.forEach(ln => {
			const el = lineEl(ln);
			if (ln.target === 'underlay' || ln.target === 'cell-colors') under.push(el);
			else if (ln.target === 'overlay' || ln.target === 'cell-givens') over.push(el);
			else if (ln.target === 'cell-grids') gridExtra.push(el);
			else mid.push(el);
		});
		Z.arrows.forEach(a => mid.push(arrowEl(a)));
		Z.overlays.forEach(o => over.push(shapeEl(o)));
		return {
			viewBox: bounds(Z),
			underlay: under.join(''),
			grid: gridEl(Z) + gridExtra.join(''),
			cages: cagesEl(Z),
			lines: mid.join(''),
			overlay: over.join(''),
		};
	}

	// ---------- dynamic layers ----------

	const PALETTE = ['#d6d6d6', '#8a8a8a', '#3c3c3c', '#a8e077', '#e88fdc', '#f6b35d', '#f06d6a', '#f9ee72', '#7fc3f2'];

	/** Point on the cell square's perimeter in direction `a` (radians) from the centre. */
	function squarePoint(cx, cy, a) {
		const dx = Math.cos(a), dy = Math.sin(a), k = (P / 2) / Math.max(Math.abs(dx), Math.abs(dy));
		return [cx + dx * k, cy + dy * k];
	}

	function colorsEl(Z, st) {
		let out = '';
		for (let i = 0; i < Z.N; i++) {
			const cols = st.colors(i);
			if (!cols.length) continue;
			const x = (i % Z.cols) * P, y = Math.floor(i / Z.cols) * P;
			if (cols.length === 1) { out += `<rect x="${x}" y="${y}" width="${P}" height="${P}" fill="${PALETTE[cols[0] - 1] || '#ccc'}"/>`; continue; }
			const cx = x + P / 2, cy = y + P / 2, n = cols.length, start = -Math.PI * 0.75;
			cols.forEach((col, k) => {
				const a0 = start + (2 * Math.PI * k) / n, a1 = start + (2 * Math.PI * (k + 1)) / n;
				const pts = [[cx, cy], squarePoint(cx, cy, a0)];
				// include square corners between a0 and a1
				for (let q = -3; q <= 5; q++) {
					const ca = Math.PI / 4 + q * Math.PI / 2;
					if (ca > a0 && ca < a1) pts.push(squarePoint(cx, cy, ca));
				}
				pts.push(squarePoint(cx, cy, a1));
				out += `<polygon points="${pts.map(p => num(p[0]) + ',' + num(p[1])).join(' ')}" fill="${PALETTE[col - 1] || '#ccc'}"/>`;
			});
		}
		return out;
	}

	function cellRects(Z, cells, cls) {
		let out = '';
		cells.forEach(i => { out += `<rect x="${(i % Z.cols) * P}" y="${Math.floor(i / Z.cols) * P}" width="${P}" height="${P}" class="${cls}"/>`; });
		return out;
	}

	const CORNER_POS = [[0.2, 0.22], [0.8, 0.22], [0.2, 0.8], [0.8, 0.8], [0.5, 0.22], [0.5, 0.8], [0.2, 0.51], [0.8, 0.51], [0.5, 0.51]];

	function digitsEl(Z, st, view) {
		let out = '';
		const conflicts = view.conflicts, wrong = view.wrong || new Set();
		for (let i = 0; i < Z.N; i++) {
			const x = (i % Z.cols) * P, y = Math.floor(i / Z.cols) * P;
			const given = Z.givens[i];
			if (given) {
				out += `<text x="${x + P / 2}" y="${y + P / 2}" class="d-given${conflicts.has(i) ? ' d-bad' : ''}">${esc(given)}</text>`;
				continue;
			}
			const v = st.value(i);
			if (v) {
				out += `<text x="${x + P / 2}" y="${y + P / 2}" class="d-value${conflicts.has(i) || wrong.has(i) ? ' d-bad' : ''}">${esc(v)}</text>`;
				continue;
			}
			const corner = st.corner(i), centre = st.centre(i);
			if (corner) {
				corner.split('').forEach((d, k) => {
					const pos = CORNER_POS[k] || CORNER_POS[8];
					// keep the top-left mark clear of a cage label
					const dy = (k === 0 && view.labelCells.has(i)) ? 0.16 : 0;
					out += `<text x="${num(x + pos[0] * P)}" y="${num(y + (pos[1] + dy) * P)}" class="d-corner${view.markBad && view.markBad(i, d) ? ' d-bad' : ''}">${esc(d)}</text>`;
				});
			}
			if (centre) {
				const fs = centre.length <= 4 ? 18 : centre.length <= 6 ? 14 : 11;
				out += `<text x="${x + P / 2}" y="${y + P / 2}" class="d-centre" font-size="${fs}">${esc(centre)}</text>`;
			}
		}
		return out;
	}

	const STATUS_CLASS = {partial: 'b-partial', done: 'b-done', bad: 'b-bad', info: 'b-info', 'info-done': 'b-info'};

	/** Little pills showing the running total of each cage / arrow / line. */
	function badgesEl(Z, items, mode) {
		if (mode === 'off') return '';
		let out = '';
		items.forEach(it => {
			const a = it.analysis;
			if (!a || a.filled === 0) return;
			let text;
			if (mode === 'remaining' && a.remaining !== null) {
				if (a.remaining < 0) text = '+' + -a.remaining;          // over the target
				else if (a.left === 0) text = a.remaining === 0 ? '✓' : String(a.sum);
				else text = a.remaining + '/' + a.left;                  // still needed / cells left
			}
			else text = String(a.sum);
			const i = it.anchor, r = Math.floor(i / Z.cols), c = i % Z.cols;
			const fs = 11.5, w = text.length * fs * 0.62 + 7, h = fs + 4;
			let x, y;
			if (it.kind === 'cage') {
				x = c * P + 2 + (it.labelWidth ? it.labelWidth + 2 : 0); y = r * P + 2;
			} else { // arrows/lines: bottom-left of the anchor cell
				x = c * P + 2; y = r * P + P - h - 2;
			}
			out += `<g class="badge ${STATUS_CLASS[a.status] || 'b-info'}"><rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${h}" rx="${h / 2}"/>` +
				`<text x="${num(x + w / 2)}" y="${num(y + h / 2 + 0.5)}" font-size="${fs}">${esc(text)}</text></g>`;
		});
		return out;
	}

	/** Outline drawn around a set of cells (selection / hover focus). */
	function outlineEl(Z, cells, cls) {
		if (!cells || !cells.length) return '';
		return `<path d="${outlinePaths(cells, Z.cols, cls === 'sel-outline' ? 0.035 : 0.09)}" class="${cls}"/>`;
	}

	CP.render = {P, PALETTE, buildStatic, colorsEl, cellRects, digitsEl, badgesEl, outlineEl, labelCell, esc};
})(typeof window !== 'undefined' ? (window.CP = window.CP || {}) : (globalThis.CP = globalThis.CP || {}));
