/* CagePad — sum logic: killer combinations, cage/line/arrow analysis, conflicts. */
(function (CP) {
	'use strict';

	const digitVal = d => (d && /^\d$/.test(d)) ? +d : null;

	// ---------- combinations ----------

	const comboCache = new Map();
	/** All sets of `n` distinct digits from 1..maxDigit that add up to `target`. */
	function combos(n, target, maxDigit) {
		maxDigit = maxDigit || 9;
		const key = n + ':' + target + ':' + maxDigit;
		if (comboCache.has(key)) return comboCache.get(key);
		const out = [];
		const rec = (start, left, sum, acc) => {
			if (left === 0) { if (sum === target) out.push(acc.slice()); return; }
			for (let d = start; d <= maxDigit; d++) {
				if (sum + d > target) break;
				// prune: even the smallest remaining digits overshoot / largest undershoot
				acc.push(d); rec(d + 1, left - 1, sum + d, acc); acc.pop();
			}
		};
		if (n > 0 && n <= maxDigit) rec(1, n, 0, []);
		comboCache.set(key, out);
		return out;
	}

	/** Can the digits of `combo` be assigned to `cells` given each cell's allowed set? (bipartite matching) */
	function assignable(combo, allowedSets) {
		if (combo.length !== allowedSets.length) return false;
		const match = new Array(combo.length).fill(-1); // digit index -> cell index
		const tryCell = (ci, seen) => {
			for (let di = 0; di < combo.length; di++) {
				if (seen[di] || !allowedSets[ci].has(combo[di])) continue;
				seen[di] = true;
				if (match[di] === -1 || tryCell(match[di], seen)) { match[di] = ci; return true; }
			}
			return false;
		};
		for (let ci = 0; ci < allowedSets.length; ci++) if (!tryCell(ci, new Array(combo.length).fill(false))) return false;
		return true;
	}

	/** Filter combos by required/excluded digits and per-cell candidate sets. */
	function filterCombos(list, {include = [], exclude = [], allowedSets = null} = {}) {
		return list.filter(c =>
			include.every(d => c.includes(d)) &&
			!exclude.some(d => c.includes(d)) &&
			(!allowedSets || assignable(c, allowedSets)));
	}

	const summarizeCombos = list => {
		if (!list.length) return {must: [], may: []};
		const may = new Set(), counts = {};
		list.forEach(c => c.forEach(d => { may.add(d); counts[d] = (counts[d] || 0) + 1; }));
		return {
			must: [...may].filter(d => counts[d] === list.length).sort((a, b) => a - b),
			may: [...may].sort((a, b) => a - b),
		};
	};

	// ---------- per-cell helpers ----------

	/** Allowed digits for a cell: its value, else its centre marks, else every digit. */
	function allowedFor(i, st, maxDigit) {
		const v = digitVal(st.value(i));
		if (v !== null) return new Set([v]);
		const ce = st.centre(i);
		if (ce.length) return new Set(ce.split('').map(Number).filter(d => d >= 1 && d <= maxDigit));
		const all = new Set();
		for (let d = 1; d <= maxDigit; d++) all.add(d);
		return all;
	}

	/**
	 * Analyse a group of cells against an optional target sum.
	 * status: 'empty' | 'partial' | 'done' (complete & correct) | 'bad' (over / wrong / repeat) | 'info' (no target)
	 */
	function analyzeGroup(cells, target, st, opts) {
		opts = opts || {};
		const maxDigit = opts.maxDigit || 9;
		let sum = 0, filled = 0, repeat = false;
		const seen = new Set(), placed = [];
		cells.forEach(i => {
			const v = digitVal(st.value(i));
			if (v === null) return;
			sum += v; filled++; placed.push(v);
			if (seen.has(v)) repeat = true;
			seen.add(v);
		});
		const total = cells.length, left = total - filled;
		let status;
		if (filled === 0) status = 'empty';
		else if (target === null || target === undefined) status = filled === total ? 'info-done' : 'info';
		else if ((opts.unique && repeat) || sum > target || (left === 0 && sum !== target)) status = 'bad';
		else if (left === 0) status = 'done';
		else {
			// also flag partial cages that can no longer reach the target
			const minRest = opts.unique ? smallestSum(left, seen, maxDigit) : left;
			const maxRest = opts.unique ? largestSum(left, seen, maxDigit) : left * maxDigit;
			status = (minRest === null || sum + minRest > target || sum + maxRest < target) ? 'bad' : 'partial';
		}
		const res = {sum, filled, total, left, repeat, status, remaining: target !== null && target !== undefined ? target - sum : null};
		if (opts.withCombos && target !== null && target !== undefined && opts.unique && total <= maxDigit) {
			const all = combos(total, target, maxDigit);
			const allowedSets = cells.map(i => allowedFor(i, st, maxDigit));
			const possible = filterCombos(all, {include: [...seen], allowedSets});
			res.allCombos = all;
			res.combos = possible;
			Object.assign(res, summarizeCombos(possible));
			// digits each empty cell can still take given the surviving combos
			res.cellOptions = cells.map((i, k) => {
				if (digitVal(st.value(i)) !== null) return null;
				const opt = new Set();
				possible.forEach(c => c.forEach(d => {
					if (!allowedSets[k].has(d) || seen.has(d)) return;
					// d is usable in cell k if the rest of the combo can fill the other cells
					const rest = c.filter(x => x !== d);
					const others = allowedSets.filter((_, j) => j !== k);
					if (assignable(rest, others)) opt.add(d);
				}));
				return [...opt].sort((a, b) => a - b);
			});
		}
		return res;
	}
	const smallestSum = (n, used, maxDigit) => {
		let s = 0, k = 0;
		for (let d = 1; d <= maxDigit && k < n; d++) if (!used.has(d)) { s += d; k++; }
		return k === n ? s : null;
	};
	const largestSum = (n, used, maxDigit) => {
		let s = 0, k = 0;
		for (let d = maxDigit; d >= 1 && k < n; d--) if (!used.has(d)) { s += d; k++; }
		return k === n ? s : null;
	};

	// ---------- geometry: derive cells from drawn lines / arrows ----------

	const isCenter = v => Math.abs(v - Math.floor(v) - 0.5) < 0.02;

	/** Cells along a polyline whose waypoints sit on cell centres (orthogonal/diagonal steps). */
	function cellsOnPath(points, rows, cols) {
		const out = [];
		const push = (r, c) => {
			if (r < 0 || c < 0 || r >= rows || c >= cols) return;
			const i = r * cols + c;
			if (out[out.length - 1] !== i) out.push(i);
		};
		for (let k = 0; k < points.length; k++) {
			const [r, c] = points[k];
			if (!isCenter(r) || !isCenter(c)) return null;
			const cr = Math.floor(r), cc = Math.floor(c);
			if (k === 0) { push(cr, cc); continue; }
			const [pr, pc] = [Math.floor(points[k - 1][0]), Math.floor(points[k - 1][1])];
			const dr = cr - pr, dc = cc - pc, steps = Math.max(Math.abs(dr), Math.abs(dc));
			if (steps === 0) continue;
			if (dr !== 0 && dc !== 0 && Math.abs(dr) !== Math.abs(dc)) { push(cr, cc); continue; } // knight-ish jump
			for (let s = 1; s <= steps; s++) push(pr + Math.sign(dr) * s, pc + Math.sign(dc) * s);
		}
		return out;
	}

	/** Group puzzle lines into "cell lines" (deduplicating outline/fill pairs). */
	function deriveLines(P) {
		const seen = new Map();
		const out = [];
		(P.lines || []).forEach((ln, li) => {
			if (!ln.wayPoints || ln.wayPoints.length < 2) return;
			if (ln.target === 'underlay' && (ln.thickness || 0) === 0) return;
			const cells = cellsOnPath(ln.wayPoints, P.rows, P.cols);
			if (!cells || cells.length < 2) return;
			const key = cells.join(',');
			const rkey = cells.slice().reverse().join(',');
			if (seen.has(key) || seen.has(rkey)) {
				const prev = out[seen.get(key) !== undefined ? seen.get(key) : seen.get(rkey)];
				if ((ln.thickness || 0) > prev.thickness) { prev.color = ln.color; prev.thickness = ln.thickness || 0; }
				return;
			}
			seen.set(key, out.length);
			out.push({cells, color: ln.color || '#999', thickness: ln.thickness || 0, kind: ln.kind || null, index: li});
		});
		// tiny "lines" that are really decoration (e.g. min/max chevrons) are already filtered by isCenter
		return out;
	}

	/** Region-split segments of a cell path (for region-sum / sumdex style lines). */
	function lineSegments(cells, regionOf, cols) {
		const segs = [];
		cells.forEach(i => {
			const reg = regionOf[i];
			const last = segs[segs.length - 1];
			if (last && last.region === reg) last.cells.push(i);
			else segs.push({region: reg, cells: [i]});
		});
		return segs;
	}

	/** Arrow semantics: bulb cells → shaft cells, and little-killer diagonals. */
	function deriveArrows(P) {
		const {rows, cols} = P;
		const inGrid = (r, c) => r >= 0 && c >= 0 && r < rows && c < cols;
		const out = [];
		(P.arrows || []).forEach(ar => {
			const wp = ar.wayPoints;
			if (!wp || wp.length < 2) return;
			const dr = wp[1][0] - wp[0][0], dc = wp[1][1] - wp[0][1], len = Math.hypot(dr, dc) || 1;
			// a point just behind the start, to find the cell the arrow leaves from
			const sr = Math.floor(wp[0][0] - 0.05 * dr / len), sc = Math.floor(wp[0][1] - 0.05 * dc / len);
			if (!inGrid(sr, sc)) {
				// little killer: clue outside the grid pointing diagonally in
				const ddr = Math.sign(dr), ddc = Math.sign(dc);
				if (!ddr || !ddc) return;
				const cells = [];
				let r = sr + ddr, c = sc + ddc;
				while (inGrid(r, c)) { cells.push(r * cols + c); r += ddr; c += ddc; }
				if (!cells.length) return;
				const clue = findClueNear(P, sr + 0.5, sc + 0.5);
				out.push({kind: 'littlekiller', cells, target: clue, anchor: cells[0]});
				return;
			}
			let bulb = ar.bulb ? ar.bulb.map(([r, c]) => r * cols + c) : bulbCells(P, sr, sc);
			const path = [[sr + 0.5, sc + 0.5], ...wp.slice(1)].map(([r, c]) => [snapC(r), snapC(c)]);
			let shaft = cellsOnPath(path, rows, cols);
			if (!shaft) return;
			shaft = shaft.filter(i => !bulb.includes(i));
			if (!shaft.length) return;
			out.push({kind: 'arrow', bulb, cells: shaft, anchor: bulb[0]});
		});
		return out;
	}
	// round arrow tips that stop short of the centre (head drawn inside the last cell)
	const snapC = v => Math.floor(v) + 0.5;

	function bulbCells(P, r, c) {
		const {cols} = P;
		const cr = r + 0.5, cc = c + 0.5;
		const ov = [...(P.overlays || []), ...(P.underlays || [])].find(o => o.rounded && o.center &&
			Math.abs(o.center[0] - cr) <= (o.height || 0) / 2 + 0.01 && Math.abs(o.center[1] - cc) <= (o.width || 0) / 2 + 0.01 &&
			((o.width || 0) > 1.2 || (o.height || 0) > 1.2));
		if (!ov) return [r * cols + c];
		const cells = [];
		for (let rr = Math.ceil(ov.center[0] - ov.height / 2 - 0.5); rr <= Math.floor(ov.center[0] + ov.height / 2 - 0.5); rr++)
			for (let c2 = Math.ceil(ov.center[1] - ov.width / 2 - 0.5); c2 <= Math.floor(ov.center[1] + ov.width / 2 - 0.5); c2++)
				if (rr >= 0 && c2 >= 0 && rr < P.rows && c2 < P.cols) cells.push(rr * cols + c2);
		return cells.length ? cells : [r * cols + c];
	}

	function findClueNear(P, r, c) {
		let best = null, bestD = 0.75;
		(P.overlays || []).forEach(o => {
			if (!o.center || o.text === undefined || o.text === '' || !/^\d+$/.test(String(o.text))) return;
			const d = Math.hypot(o.center[0] - r, o.center[1] - c);
			if (d < bestD) { bestD = d; best = +o.text; }
		});
		return best;
	}

	// ---------- uniqueness constraints & conflicts ----------

	/** Every group of cells that must not repeat a digit. */
	function uniqueGroups(P) {
		const groups = [];
		const {rows, cols, meta} = P;
		if (!meta.norowcol) {
			for (let r = 0; r < rows; r++) groups.push(range(cols).map(c => r * cols + c));
			for (let c = 0; c < cols; c++) groups.push(range(rows).map(r => r * cols + c));
		}
		P.regions.forEach(reg => groups.push(reg));
		P.cages.forEach(cg => { if (cg.unique && cg.cells.length > 1) groups.push(cg.cells); });
		if (meta['diagonal+'] && rows === cols) groups.push(range(rows).map(r => r * cols + (cols - 1 - r)));
		if (meta['diagonal-'] && rows === cols) groups.push(range(rows).map(r => r * cols + r));
		return groups;
	}
	const range = n => Array.from({length: n}, (_, i) => i);

	/** Pairwise "cannot be equal" neighbours from global rules (anti-king / anti-knight). */
	function extraNeighbours(P) {
		const offs = [];
		const truthy = v => v === true || v === 'true' || v === 1;
		if (truthy(P.meta.antiking)) offs.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
		if (truthy(P.meta.antiknight)) offs.push([-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]);
		return offs;
	}

	/** Peers of each cell (cells that may not share its digit). */
	function buildPeers(P) {
		const peers = Array.from({length: P.N}, () => new Set());
		uniqueGroups(P).forEach(g => g.forEach(a => g.forEach(b => { if (a !== b) peers[a].add(b); })));
		const offs = extraNeighbours(P);
		if (offs.length) {
			for (let r = 0; r < P.rows; r++) for (let c = 0; c < P.cols; c++) {
				offs.forEach(([dr, dc]) => {
					const rr = r + dr, cc = c + dc;
					if (rr >= 0 && cc >= 0 && rr < P.rows && cc < P.cols) peers[r * P.cols + c].add(rr * P.cols + cc);
				});
			}
		}
		return peers;
	}

	/** Cells whose digit clashes with a peer. */
	function findConflicts(P, peers, st) {
		const bad = new Set();
		for (let i = 0; i < P.N; i++) {
			const v = st.value(i);
			if (!v) continue;
			for (const j of peers[i]) if (st.value(j) === v) { bad.add(i); bad.add(j); }
		}
		return bad;
	}

	CP.sums = {combos, filterCombos, summarizeCombos, assignable, analyzeGroup, allowedFor,
		cellsOnPath, deriveLines, lineSegments, deriveArrows, uniqueGroups, buildPeers, findConflicts, digitVal};
})(typeof window !== 'undefined' ? (window.CP = window.CP || {}) : (globalThis.CP = globalThis.CP || {}));
