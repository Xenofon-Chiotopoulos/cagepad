/* CagePad — application: state, input, panels, loading, persistence. */
(function (CP) {
	'use strict';
	const {format: F, sums: S, render: R} = CP;
	const CONFIG = window.CAGEPAD_CONFIG || {};
	const $ = sel => document.querySelector(sel);
	const esc = R.esc;
	const SITE = location.origin + location.pathname.replace(/index\.html$/, '');

	// ---------- storage helpers (never throw) ----------
	const store = {
		get(key, fallback) {
			try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
		},
		set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ } },
		del(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } },
	};

	const DEFAULT_SETTINGS = {
		badgeMode: 'sum', badgeArrows: true, conflicts: true, autoClean: true, highlightSame: true,
		showSeen: false, showMistakes: false, showTimer: true, theme: 'auto', proxy: '', comboUsesMarks: true,
	};
	const settings = Object.assign({}, DEFAULT_SETTINGS, store.get('cagepad:settings', {}));
	const saveSettings = () => store.set('cagepad:settings', settings);

	// ---------- app state ----------
	let Z = null;              // normalised puzzle
	let G = null;              // game state
	let info = null;           // logic-masters / source info
	let pid = null;            // persistence key
	let peers = null, lines = [], arrows = [], labelCells = new Set(), cageLabelW = new Map();
	let selection = new Set(), cursor = null;
	let mode = 'normal', tempMode = null;
	let focusCells = null;
	let undoStack = [], redoStack = [];
	let timer = {elapsed: 0, running: false, since: 0, paused: false};
	let solved = false;
	let comboCalc = {size: 3, total: 15, digits: {}};
	let indexCache = null;

	class Game {
		constructor(n) {
			this.v = new Array(n).fill('');
			this.k = new Array(n).fill('');   // corner marks
			this.e = new Array(n).fill('');   // centre marks
			this.o = Array.from({length: n}, () => []); // colours
		}
		value(i) { return Z.givens[i] || this.v[i]; }
		corner(i) { return this.k[i]; }
		centre(i) { return this.e[i]; }
		colors(i) { return this.o[i]; }
		snapshot() { return JSON.stringify({v: this.v, k: this.k, e: this.e, o: this.o}); }
		restore(s) { const d = typeof s === 'string' ? JSON.parse(s) : s; ['v', 'k', 'e', 'o'].forEach(f => { if (Array.isArray(d[f]) && d[f].length === this[f].length) this[f] = d[f]; }); }
	}

	// ---------- toast ----------
	let toastTimer = null;
	function toast(msg, ms) {
		const el = $('#toast');
		el.textContent = msg; el.hidden = false;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => { el.hidden = true; }, ms || 2600);
	}

	// ---------- puzzle setup ----------

	function startPuzzle(data, opts) {
		opts = opts || {};
		let raw;
		try { raw = F.decodeData(data); } catch (e) { return showMessage(errorCard('Could not read this puzzle', e.message)); }
		Z = F.normalize(raw, {settings: opts.settings || (opts.info && opts.info.settings) || {}});
		info = opts.info || null;
		pid = opts.pid || ('d:' + hash(data));
		G = new Game(Z.N);
		peers = S.buildPeers(Z);
		lines = S.deriveLines(Z);
		arrows = S.deriveArrows(Z);
		labelCells = new Set(); cageLabelW = new Map();
		Z.cages.forEach((cg, k) => {
			if (!cg.visible) return;
			const lc = R.labelCell(cg.cells, Z.cols);
			if (cg.value !== '') { labelCells.add(lc); cageLabelW.set(k, String(cg.value).length * 14 * 0.6 + 3); }
		});
		selection = new Set(); cursor = null; undoStack = []; redoStack = []; solved = false; focusCells = null;
		timer = {elapsed: 0, running: false, since: 0, paused: false};
		const saved = store.get('cagepad:save:' + pid, null);
		if (saved && saved.state) {
			try { G.restore(saved.state); } catch (e) { /* ignore corrupt save */ }
			timer.elapsed = saved.elapsed || 0;
			solved = !!saved.solved;
		}
		drawStatic();
		document.body.classList.remove('no-puzzle');
		$('#boardMsg').hidden = true;
		$('#pausedCover').hidden = true;
		const title = Z.meta.title || (info && info.title) || 'Untitled puzzle';
		const author = Z.meta.author || (info && info.author) || '';
		$('#pTitle').textContent = title;
		$('#pSub').textContent = [author && 'by ' + author, Z.rows + '×' + Z.cols, info && info.id ? 'LM ' + info.id : ''].filter(Boolean).join(' · ');
		document.title = title + ' — CagePad';
		if (!solved) startTimer();
		updateTimer();
		buildPad();
		setTab(store.get('cagepad:tab', 'sums'));
		renderAll();
		remember(title, author, opts.route || location.hash);
		if (Z.unsupported.length) toast('Heads up: this puzzle uses ' + Z.unsupported.join(', ') + ', which CagePad does not support yet.', 6000);
	}

	const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

	function drawStatic() {
		const st = R.buildStatic(Z);
		const svg = $('#board');
		const vb = st.viewBox;
		svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
		svg.style.aspectRatio = `${vb.w} / ${vb.h}`;
		$('#lUnder').innerHTML = st.underlay;
		$('#lGrid').innerHTML = st.grid;
		$('#lCages').innerHTML = st.cages;
		$('#lLines').innerHTML = st.lines;
		$('#lOver').innerHTML = st.overlay;
	}

	// ---------- rendering ----------

	let renderQueued = false;
	function renderAll() {
		if (renderQueued) return;
		renderQueued = true;
		requestAnimationFrame(() => { renderQueued = false; renderNow(); });
	}

	function analyses() {
		const cages = [];
		Z.cages.forEach((cg, k) => {
			if (!cg.visible) return;
			const a = S.analyzeGroup(cg.cells, cg.sum, G, {unique: cg.unique, maxDigit: Z.maxDigit, withCombos: true});
			cages.push({kind: 'cage', index: k, cage: cg, cells: cg.cells, analysis: a, anchor: R.labelCell(cg.cells, Z.cols), labelWidth: cageLabelW.get(k) || 0});
		});
		const arr = arrows.map((ar, k) => {
			let target = null;
			if (ar.kind === 'littlekiller') target = ar.target;
			else {
				const ds = ar.bulb.map(i => G.value(i));
				if (ds.every(d => /^\d$/.test(d))) target = +ds.join('');
			}
			return {kind: ar.kind, index: k, cells: ar.cells, bulb: ar.bulb, target, anchor: ar.kind === 'arrow' ? ar.bulb[0] : ar.anchor,
				analysis: S.analyzeGroup(ar.cells, target, G, {unique: false, maxDigit: Z.maxDigit})};
		});
		return {cages, arrows: arr};
	}

	function renderNow() {
		if (!Z) return;
		const conflicts = settings.conflicts ? S.findConflicts(Z, peers, G) : new Set();
		const wrong = new Set();
		if (settings.showMistakes && Z.solution) {
			for (let i = 0; i < Z.N; i++) {
				const v = G.v[i], s = Z.solution[i];
				if (v && /\d/.test(s) && v !== s) wrong.add(i);
			}
		}
		// highlights
		let high = '';
		const single = selection.size === 1 ? [...selection][0] : null;
		if (single !== null && settings.showSeen) high += R.cellRects(Z, [...peers[single]], 'h-seen');
		if (settings.highlightSame && single !== null && G.value(single)) {
			const d = G.value(single);
			const same = [];
			for (let i = 0; i < Z.N; i++) if (i !== single && (G.value(i) === d || (!G.value(i) && (G.e[i].includes(d) || G.k[i].includes(d))))) same.push(i);
			high += R.cellRects(Z, same, 'h-same');
		}
		high += R.cellRects(Z, [...selection], 'h-sel');
		$('#lHigh').innerHTML = high;
		$('#lColors').innerHTML = R.colorsEl(Z, G);
		$('#lDigits').innerHTML = R.digitsEl(Z, G, {conflicts, wrong, labelCells});
		const A = analyses();
		const badgeItems = A.cages.concat(settings.badgeArrows ? A.arrows : []);
		$('#lBadges').innerHTML = R.badgesEl(Z, badgeItems, settings.badgeMode);
		$('#lSel').innerHTML = R.outlineEl(Z, [...selection], 'sel-outline');
		$('#lFocus').innerHTML = focusCells ? R.outlineEl(Z, focusCells, 'focus-outline') : '';
		renderSelBar(A);
		renderPadState();
		renderModes();
		const tab = currentTab();
		if (tab === 'sums') renderSums(A);
		else if (tab === 'rules') renderRules();
		else if (tab === 'tools') renderTools();
		$('#undoBtn').disabled = !undoStack.length;
		$('#redoBtn').disabled = !redoStack.length;
	}

	function renderSelBar(A) {
		const bar = $('#selBar');
		if (!selection.size) { bar.innerHTML = '<span>Tip: drag to select cells — the selection total appears here. Hold <kbd>Shift</kbd> for corner, <kbd>Ctrl</kbd> for centre marks.</span>'; return; }
		const cells = [...selection];
		let sum = 0, filled = 0;
		cells.forEach(i => { const v = S.digitVal(G.value(i)); if (v !== null) { sum += v; filled++; } });
		const parts = [`<span><b>${cells.length}</b> cell${cells.length > 1 ? 's' : ''}</span>`, `<span>Σ <b>${sum}</b>${filled < cells.length ? ` <span class="muted">(${filled} filled)</span>` : ''}</span>`];
		// 45-rule helper: cages completely inside the selection
		const inside = A.cages.filter(c => c.cage.sum !== null && c.cells.every(i => selection.has(i)));
		if (inside.length) {
			const covered = new Set(); inside.forEach(c => c.cells.forEach(i => covered.add(i)));
			const tot = inside.reduce((t, c) => t + c.cage.sum, 0);
			parts.push(`<span>cages inside: <b>${tot}</b> (${inside.length})${covered.size < cells.length ? ` + ${cells.length - covered.size} other cell${cells.length - covered.size > 1 ? 's' : ''}` : ''}</span>`);
		}
		if (single() !== null) {
			const i = single();
			parts.push(`<span class="muted">r${Math.floor(i / Z.cols) + 1}c${i % Z.cols + 1}</span>`);
		}
		bar.innerHTML = parts.join('');
	}
	const single = () => selection.size === 1 ? [...selection][0] : null;

	// ---------- digit pad ----------

	function buildPad() {
		const pad = $('#pad');
		let html = '';
		for (let d = 1; d <= 9; d++) {
			const hiddenDigit = d > Z.maxDigit && mode !== 'colour';
			html += `<button data-d="${d}"${hiddenDigit ? ' hidden' : ''}><span class="d">${d}</span><span class="cnt"></span></button>`;
		}
		pad.innerHTML = html;
	}

	function renderPadState() {
		const m = effMode();
		const pad = $('#pad');
		pad.className = 'pad mode-' + m;
		const expected = Z.regions.length || (Z.rows === Z.cols ? Z.rows : 0);
		const counts = {};
		for (let i = 0; i < Z.N; i++) { const v = G.value(i); if (v) counts[v] = (counts[v] || 0) + 1; }
		pad.querySelectorAll('button').forEach(b => {
			const d = +b.dataset.d;
			b.hidden = m !== 'colour' && d > Z.maxDigit;
			if (m === 'colour') {
				b.classList.add('swatch'); b.style.background = R.PALETTE[d - 1]; b.classList.remove('complete');
				b.querySelector('.cnt').textContent = '';
			} else {
				b.classList.remove('swatch'); b.style.background = '';
				const c = counts[d] || 0;
				b.classList.toggle('complete', expected > 0 && c >= expected);
				b.querySelector('.cnt').textContent = expected ? String(Math.max(0, expected - c)) : '';
			}
		});
	}

	function renderModes() {
		const m = effMode();
		document.querySelectorAll('.mode').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
	}
	const effMode = () => tempMode || mode;

	// ---------- editing ----------

	function commit(fn) {
		if (!G) return;
		const before = G.snapshot();
		fn();
		const after = G.snapshot();
		if (before === after) return;
		undoStack.push(before);
		if (undoStack.length > 1000) undoStack.shift();
		redoStack = [];
		changed();
	}

	function changed() {
		renderAll();
		scheduleSave();
		checkSolved(false);
	}

	function enterDigit(d) {
		if (!Z || !selection.size || timer.paused) return;
		const m = effMode();
		const ds = String(d);
		const cells = [...selection];
		commit(() => {
			if (m === 'colour') {
				const n = +d;
				if (n < 1 || n > 9) return;
				const all = cells.every(i => G.o[i].includes(n));
				cells.forEach(i => {
					if (all) G.o[i] = G.o[i].filter(x => x !== n);
					else if (!G.o[i].includes(n)) G.o[i] = G.o[i].concat(n).sort((a, b) => a - b);
				});
				return;
			}
			if (m === 'normal') {
				const targets = cells.filter(i => !Z.givens[i]);
				if (!targets.length) return;
				const all = targets.every(i => G.v[i] === ds);
				targets.forEach(i => { G.v[i] = all ? '' : ds; });
				if (!all && settings.autoClean) targets.forEach(i => peers[i].forEach(j => {
					G.k[j] = G.k[j].replace(ds, ''); G.e[j] = G.e[j].replace(ds, '');
				}));
				return;
			}
			const field = m === 'corner' ? 'k' : 'e';
			const targets = cells.filter(i => !G.value(i));
			if (!targets.length) return;
			const all = targets.every(i => G[field][i].includes(ds));
			targets.forEach(i => {
				const set = new Set(G[field][i].split('').filter(Boolean));
				if (all) set.delete(ds); else set.add(ds);
				G[field][i] = [...set].sort().join('');
			});
		});
	}

	function clearCells() {
		if (!Z || !selection.size || timer.paused) return;
		const m = effMode();
		const cells = [...selection];
		commit(() => {
			if (m === 'colour') { cells.forEach(i => { G.o[i] = []; }); return; }
			const withValue = cells.filter(i => G.v[i]);
			if (withValue.length) { withValue.forEach(i => { G.v[i] = ''; }); return; }
			const field = m === 'corner' ? 'k' : m === 'centre' ? 'e' : null;
			const hasField = field && cells.some(i => G[field][i]);
			const hasMarks = cells.some(i => G.k[i] || G.e[i]);
			cells.forEach(i => {
				if (hasField) G[field][i] = '';
				else if (hasMarks) { G.k[i] = ''; G.e[i] = ''; }
				else G.o[i] = [];   // nothing else left to clear: remove colours
			});
		});
	}

	function undo() {
		if (!undoStack.length) return;
		redoStack.push(G.snapshot());
		G.restore(undoStack.pop());
		changed();
	}
	function redo() {
		if (!redoStack.length) return;
		undoStack.push(G.snapshot());
		G.restore(redoStack.pop());
		changed();
	}

	/** Fill centre marks with every digit not ruled out by placed digits (and cage combinations). */
	function autoCandidates(cells, useCages) {
		commit(() => {
			const A = useCages ? analyses() : null;
			const cageOpts = new Map();
			if (A) A.cages.forEach(c => {
				if (!c.analysis.cellOptions) return;
				c.cells.forEach((i, k) => { if (c.analysis.cellOptions[k]) cageOpts.set(i, new Set(c.analysis.cellOptions[k].map(String))); });
			});
			cells.forEach(i => {
				if (G.value(i)) return;
				const out = [];
				for (let d = 1; d <= Z.maxDigit; d++) {
					const ds = String(d);
					let ok = true;
					for (const j of peers[i]) if (G.value(j) === ds) { ok = false; break; }
					if (ok && cageOpts.has(i) && !cageOpts.get(i).has(ds)) ok = false;
					if (ok) out.push(ds);
				}
				G.e[i] = out.join('');
			});
		});
	}

	// ---------- selection & pointer input ----------

	function cellAt(evt) {
		const svg = $('#board');
		const pt = svg.createSVGPoint();
		pt.x = evt.clientX; pt.y = evt.clientY;
		const m = svg.getScreenCTM();
		if (!m) return null;
		const p = pt.matrixTransform(m.inverse());
		const c = Math.floor(p.x / R.P), r = Math.floor(p.y / R.P);
		if (r < 0 || c < 0 || r >= Z.rows || c >= Z.cols) return null;
		// ignore the outer quarter of a cell while dragging so diagonal drags do not snag neighbours
		return {i: r * Z.cols + c, fx: p.x / R.P - c, fy: p.y / R.P - r};
	}

	let drag = null, lastClick = {i: -1, t: 0};
	function onPointerDown(evt) {
		if (!Z || timer.paused) return;
		if (evt.button !== undefined && evt.button > 0) return;
		const hit = cellAt(evt);
		const additive = evt.shiftKey || evt.ctrlKey || evt.metaKey;
		if (!hit) { if (!additive) { selection.clear(); renderAll(); } return; }
		evt.preventDefault();
		$('#board').setPointerCapture && $('#board').setPointerCapture(evt.pointerId);
		const now = Date.now();
		if (!additive && hit.i === lastClick.i && now - lastClick.t < 350) {
			selectSimilar(hit.i);
			lastClick = {i: -1, t: 0};
			drag = null;
			return;
		}
		lastClick = {i: hit.i, t: now};
		const removing = (evt.ctrlKey || evt.metaKey) && selection.has(hit.i);
		if (!additive) selection.clear();
		drag = {removing};
		if (removing) selection.delete(hit.i); else selection.add(hit.i);
		cursor = hit.i;
		renderAll();
	}
	function onPointerMove(evt) {
		if (!drag) return;
		const hit = cellAt(evt);
		if (!hit) return;
		if (hit.fx < 0.18 || hit.fx > 0.82 || hit.fy < 0.18 || hit.fy > 0.82) return;
		const had = selection.has(hit.i);
		if (drag.removing ? had : !had) {
			if (drag.removing) selection.delete(hit.i); else selection.add(hit.i);
			cursor = hit.i;
			renderAll();
		}
	}
	function onPointerUp() { drag = null; }

	function selectSimilar(i) {
		const v = G.value(i);
		selection.clear();
		if (v) { for (let j = 0; j < Z.N; j++) if (G.value(j) === v) selection.add(j); }
		else if (G.o[i].length) { const c = G.o[i].join(','); for (let j = 0; j < Z.N; j++) if (G.o[j].join(',') === c) selection.add(j); }
		else selection.add(i);
		renderAll();
	}

	function moveCursor(dr, dc, extend) {
		if (!Z) return;
		let i = cursor !== null ? cursor : 0;
		let r = Math.floor(i / Z.cols) + dr, c = i % Z.cols + dc;
		r = (r + Z.rows) % Z.rows; c = (c + Z.cols) % Z.cols;
		i = r * Z.cols + c;
		if (!extend) selection.clear();
		selection.add(i);
		cursor = i;
		renderAll();
	}

	// ---------- keyboard ----------

	function updateTempMode(evt) {
		const shift = evt.shiftKey, ctrl = evt.ctrlKey || evt.metaKey;
		const next = shift && ctrl ? 'colour' : ctrl ? 'centre' : shift ? 'corner' : null;
		if (next !== tempMode) { tempMode = next; if (Z) { renderPadState(); renderModes(); } }
	}

	function onKeyDown(evt) {
		const tag = (evt.target && evt.target.tagName) || '';
		if (/INPUT|TEXTAREA|SELECT/.test(tag) || (evt.target && evt.target.isContentEditable)) return;
		if (document.querySelector('dialog[open]')) return;
		updateTempMode(evt);
		const ctrl = evt.ctrlKey || evt.metaKey;
		const k = evt.key;
		const digit = (evt.code || '').match(/^(?:Digit|Numpad)(\d)$/);
		if (digit) {
			evt.preventDefault();
			const d = +digit[1];
			if (d === 0) return;
			enterDigit(d);
			return;
		}
		if (ctrl && (k === 'z' || k === 'Z')) { evt.preventDefault(); if (evt.shiftKey) redo(); else undo(); return; }
		if (ctrl && (k === 'y' || k === 'Y')) { evt.preventDefault(); redo(); return; }
		if (ctrl && (k === 'a' || k === 'A')) { evt.preventDefault(); if (Z) { selection = new Set(Array.from({length: Z.N}, (_, i) => i)); renderAll(); } return; }
		if (ctrl) return;
		switch (k) {
			case 'Backspace': case 'Delete': evt.preventDefault(); clearCells(); return;
			case 'Escape': selection.clear(); focusCells = null; renderAll(); return;
			case 'ArrowUp': evt.preventDefault(); moveCursor(-1, 0, evt.shiftKey); return;
			case 'ArrowDown': evt.preventDefault(); moveCursor(1, 0, evt.shiftKey); return;
			case 'ArrowLeft': evt.preventDefault(); moveCursor(0, -1, evt.shiftKey); return;
			case 'ArrowRight': evt.preventDefault(); moveCursor(0, 1, evt.shiftKey); return;
			case ' ': evt.preventDefault(); cycleMode(); return;
		}
		switch (k.toLowerCase()) {
			case 'z': setMode('normal'); return;
			case 'x': setMode('corner'); return;
			case 'c': setMode('centre'); return;
			case 'v': setMode('colour'); return;
			case 'p': togglePause(); return;
			case 'b': openBrowse(); return;
			case '?': openHelp(); return;
		}
	}
	function onKeyUp(evt) { updateTempMode(evt); }

	const MODES = ['normal', 'corner', 'centre', 'colour'];
	function setMode(m) { mode = m; if (Z) renderAll(); }
	function cycleMode() { setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]); }

	// ---------- side panels ----------

	const currentTab = () => (document.querySelector('.tab.active') || {}).dataset ? document.querySelector('.tab.active').dataset.tab : 'sums';
	function setTab(t) {
		document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
		['sums', 'rules', 'tools'].forEach(n => { $('#panel-' + n).hidden = n !== t; });
		store.set('cagepad:tab', t);
		if (Z) renderAll();
	}

	const fmtCombo = c => c.join('');
	const pillFor = a => {
		if (!a.filled) return '<span class="pill empty">—</span>';
		const cls = a.status === 'info' || a.status === 'info-done' ? '' : a.status;
		let extra = '';
		if (a.remaining !== null && a.remaining < 0) extra = ' · ' + -a.remaining + ' over';
		else if (a.remaining !== null && a.left) extra = ' · ' + a.remaining + ' left';
		return `<span class="pill ${cls}">${a.sum}${extra}</span>`;
	};

	function renderSums(A) {
		const panel = $('#panel-sums');
		const keepScroll = panel.scrollTop;
		let html = '';

		// selection / cage detail
		const selCells = [...selection];
		const cageHit = selCells.length ? A.cages.find(c => selCells.every(i => c.cells.includes(i))) : null;
		if (cageHit && cageHit.cage.sum !== null) {
			const a = cageHit.analysis, cg = cageHit.cage;
			html += `<div class="card"><h3><span class="grow">Cage ${esc(cg.value)} · ${cg.cells.length} cells</span>${pillFor(a)}</h3>`;
			if (a.combos) {
				const live = new Set(a.combos.map(fmtCombo));
				html += `<div class="small muted">${a.combos.length} of ${a.allCombos.length} combination${a.allCombos.length === 1 ? '' : 's'} still possible${settings.comboUsesMarks ? ' (using placed digits &amp; centre marks)' : ''}</div>`;
				html += '<div class="combo-list">' + a.allCombos.map(c => `<span class="combo${live.has(fmtCombo(c)) ? '' : ' dead'}">${fmtCombo(c)}</span>`).join('') + '</div>';
				if (a.combos.length) html += `<div class="small" style="margin-top:6px">Must contain: <b>${a.must.join('') || '—'}</b> · Can contain: <b>${a.may.join('')}</b></div>`;
				html += `<div class="row" style="margin-top:8px"><button class="btn btn-small" data-act="pencil-cage" data-cage="${cageHit.index}">Pencil in candidates</button><button class="btn btn-small" data-act="select-cage" data-cage="${cageHit.index}">Select cage</button></div>`;
			} else if (!cg.unique) html += '<div class="small muted">Digits may repeat in this cage, so no combination list.</div>';
			html += '</div>';
		}

		// combination calculator
		const calcSize = selCells.length > 1 && !cageHit ? selCells.length : comboCalc.size;
		html += `<div class="card"><h3><span class="grow">Combination calculator</span></h3>
			<div class="row small"><label>Cells <input class="num-in" type="number" min="1" max="${Z.maxDigit}" id="ccSize" value="${calcSize}"></label>
			<label>Total <input class="num-in" type="number" min="1" max="99" id="ccTotal" value="${comboCalc.total}"></label>
			<span class="muted">click digits: must / not</span></div>
			<div class="digit-chips" style="margin-top:6px">${range1(Z.maxDigit).map(d => `<button class="dchip ${comboCalc.digits[d] || ''}" data-cc="${d}">${d}</button>`).join('')}</div>
			<div id="ccOut">${comboCalcOut(calcSize)}</div></div>`;

		// cage list
		const cages = A.cages.filter(c => c.cage.sum !== null || c.cage.value === '');
		if (cages.length) {
			const sorted = cages.slice().sort((a, b) => a.anchor - b.anchor);
			const done = sorted.filter(c => c.analysis.status === 'done').length;
			html += `<div class="card"><h3><span class="grow">Cages</span><span class="muted" style="text-transform:none;letter-spacing:0">${done}/${sorted.length} complete</span></h3><div class="list">`;
			sorted.forEach(c => {
				const a = c.analysis, r = Math.floor(c.anchor / Z.cols) + 1, col = c.anchor % Z.cols + 1;
				const sub = a.combos ? `${a.combos.length} combo${a.combos.length === 1 ? '' : 's'}${a.must && a.must.length && a.combos.length > 1 ? ' · must ' + a.must.join('') : a.combos.length === 1 ? ': ' + fmtCombo(a.combos[0]) : ''}` : (c.cage.unique ? '' : 'repeats allowed');
				html += `<div class="li${c.analysis.status === 'bad' ? ' bad' : ''}" data-focus="cage:${c.index}"><span class="target">${esc(c.cage.value || '?')}</span>
					<span class="grow"><span>${c.cells.length} cells</span> <span class="sub">r${r}c${col}${sub ? ' · ' + sub : ''}</span></span>${pillFor(a)}</div>`;
			});
			html += '</div></div>';
		}

		// arrows
		const arr = A.arrows;
		if (arr.length) {
			html += '<div class="card"><h3><span class="grow">Arrows &amp; little killers</span></h3><div class="list">';
			arr.forEach(x => {
				const a = x.analysis, r = Math.floor(x.anchor / Z.cols) + 1, col = x.anchor % Z.cols + 1;
				const lbl = x.kind === 'arrow' ? (x.target !== null ? x.target : '?') : (x.target !== null ? x.target : '?');
				html += `<div class="li" data-focus="arrow:${x.index}"><span class="target">${lbl}</span><span class="grow">${x.kind === 'arrow' ? 'Arrow' : 'Little killer'} <span class="sub">r${r}c${col} · ${x.cells.length} cells</span></span>${pillFor(a)}</div>`;
			});
			html += '</div></div>';
		}

		// lines
		if (lines.length) {
			html += '<div class="card"><h3><span class="grow">Lines</span><span class="muted" style="text-transform:none;letter-spacing:0">sum · per-box segments</span></h3><div class="list">';
			lines.forEach((ln, k) => {
				const a = S.analyzeGroup(ln.cells, null, G, {});
				const segs = S.lineSegments(ln.cells, Z.regionOf, Z.cols).map(sg => {
					const sa = S.analyzeGroup(sg.cells, null, G, {});
					return sa.filled === sg.cells.length ? `<b>${sa.sum}</b>` : (sa.filled ? `${sa.sum}…` : '·');
				});
				const r = Math.floor(ln.cells[0] / Z.cols) + 1, c = ln.cells[0] % Z.cols + 1;
				html += `<div class="li" data-focus="line:${k}"><span class="swatch-dot" style="background:${esc(ln.color)}"></span>
					<span class="grow">${ln.cells.length} cells <span class="sub">from r${r}c${c}</span><div class="segs">${segs.length > 1 ? segs.join(' | ') : ''}</div></span>${pillFor(a)}</div>`;
			});
			html += '</div></div>';
		}
		if (!cages.length && !arr.length && !lines.length) html += '<div class="card small muted">This puzzle has no cages, arrows or lines — select any cells to see their total in the bar under the grid.</div>';
		panel.innerHTML = html;
		panel.scrollTop = keepScroll;
	}
	const range1 = n => Array.from({length: n}, (_, i) => i + 1);

	function comboCalcOut(size) {
		const include = Object.keys(comboCalc.digits).filter(d => comboCalc.digits[d] === 'must').map(Number);
		const exclude = Object.keys(comboCalc.digits).filter(d => comboCalc.digits[d] === 'not').map(Number);
		const all = S.combos(size, comboCalc.total, Z.maxDigit);
		let allowedSets = null;
		const selCells = [...selection];
		if (settings.comboUsesMarks && selCells.length === size && selCells.length > 1) allowedSets = selCells.map(i => S.allowedFor(i, G, Z.maxDigit));
		const ok = S.filterCombos(all, {include, exclude, allowedSets});
		if (!all.length) return '<div class="small muted" style="margin-top:6px">No combinations.</div>';
		const live = new Set(ok.map(fmtCombo));
		const sm = S.summarizeCombos(ok);
		return `<div class="combo-list">${all.map(c => `<span class="combo${live.has(fmtCombo(c)) ? '' : ' dead'}">${fmtCombo(c)}</span>`).join('')}</div>` +
			`<div class="small" style="margin-top:6px">${ok.length} possible${allowedSets ? ' for the selected cells' : ''}${ok.length ? ` · must <b>${sm.must.join('') || '—'}</b> · can <b>${sm.may.join('')}</b>` : ''}</div>`;
	}

	function renderRules() {
		const panel = $('#panel-rules');
		const m = Z.meta;
		let html = '<div class="card">';
		html += `<h3>Puzzle</h3><dl class="kv"><dt>Title</dt><dd>${esc(m.title || (info && info.title) || 'Untitled')}</dd>`;
		if (m.author || (info && info.author)) html += `<dt>Author</dt><dd>${esc(m.author || info.author)}</dd>`;
		if (info && info.difficulty) html += `<dt>Difficulty</dt><dd><span class="stars">${'★'.repeat(info.difficulty)}${'☆'.repeat(Math.max(0, 5 - info.difficulty))}</span></dd>`;
		if (info && info.solvedCount !== undefined && info.solvedCount !== null) html += `<dt>Solved</dt><dd>${info.solvedCount}× on logic-masters</dd>`;
		html += '</dl>';
		if (info && info.tags && info.tags.length) html += '<div style="margin-top:8px">' + info.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('') + '</div>';
		html += '<div class="row" style="margin-top:8px">';
		if (info && info.id) html += `<a class="btn btn-small" href="https://logic-masters.de/Raetselportal/Raetsel/zeigen.php?id=${esc(info.id)}" target="_blank" rel="noopener">Open on logic-masters ↗</a>`;
		const src = (info && info.link) || (info && info.src);
		if (src) html += `<a class="btn btn-small" href="${esc(src)}" target="_blank" rel="noopener">Original link ↗</a>`;
		html += '</div></div>';
		if (Z.unsupported.length) html += `<div class="card warn small">This puzzle uses ${esc(Z.unsupported.join(', '))}, which CagePad cannot show. Use the original link for the intended experience.</div>`;
		const rules = m.rules || (info && info.rules) || '';
		html += `<div class="card"><h3>Rules</h3><div class="rules-text">${esc(rules || 'No rules were included with this puzzle.')}</div></div>`;
		if (info && info.rules && m.rules && info.rules.trim() !== m.rules.trim()) {
			html += `<div class="card"><h3>From the logic-masters page</h3><div class="rules-text small">${esc(info.rules)}</div></div>`;
		}
		html += solutionCodeCard();
		panel.innerHTML = html;
	}

	/** Parse "Row 5" / "Column 3, top to bottom" style instructions and build the answer from the grid. */
	function solutionCode() {
		const text = info && info.solutionCode;
		if (!text) return null;
		const re = /\b(row|zeile|reihe|column|col|spalte)s?\s*(\d+)|\b([RC])(\d+)\b/gi;
		const parts = [];
		let m;
		while ((m = re.exec(text))) {
			const word = (m[1] || m[3]).toLowerCase();
			const n = +(m[2] || m[4]);
			const isRow = /^(row|zeile|reihe|r)$/.test(word);
			if (isRow ? n >= 1 && n <= Z.rows : n >= 1 && n <= Z.cols) parts.push({isRow, n});
		}
		if (!parts.length) return {text, code: null};
		const reverse = /right to left|von rechts nach links|bottom to top|von unten nach oben/i.test(text);
		let code = '', complete = true;
		parts.forEach(({isRow, n}) => {
			const cells = isRow ? range1(Z.cols).map(c => (n - 1) * Z.cols + c - 1) : range1(Z.rows).map(r => (r - 1) * Z.cols + n - 1);
			const ds = cells.map(i => G.value(i) || '?');
			if (ds.includes('?')) complete = false;
			code += (reverse ? ds.reverse() : ds).join('');
		});
		return {text, code, complete, parts};
	}

	function solutionCodeCard() {
		const sc = solutionCode();
		if (!sc) return '';
		let html = `<div class="card"><h3>Lösungscode (solution code)</h3><div class="small">${esc(sc.text)}</div>`;
		if (sc.code) {
			html += `<div class="row" style="margin-top:8px"><span class="code-out">${esc(sc.code)}</span><button class="btn btn-small" data-act="copy-code" ${sc.complete ? '' : 'disabled'}>Copy</button></div>`;
			html += `<div class="small muted" style="margin-top:4px">${sc.complete ? 'Built from your grid — double-check it against the instruction above before submitting.' : 'Fills in as you solve (“?” = empty cell).'}</div>`;
		}
		return html + '</div>';
	}

	function renderTools() {
		const panel = $('#panel-tools');
		const bm = bookmarkletHref();
		panel.innerHTML = `
			<div class="card"><h3>Pencil marks</h3>
				<div class="row"><button class="btn btn-small" data-act="auto-sel">Fill candidates in selection</button><button class="btn btn-small" data-act="auto-all">Fill all candidates</button></div>
				<label class="chk small" style="margin-top:6px"><input type="checkbox" id="autoUseCages" ${store.get('cagepad:autoUseCages', true) ? 'checked' : ''}> also use cage combinations</label>
				<div class="row" style="margin-top:8px"><button class="btn btn-small" data-act="clear-marks">Clear all pencil marks</button><button class="btn btn-small" data-act="clear-colours">Clear all colours</button></div>
			</div>
			<div class="card"><h3>Progress</h3>
				<div class="row"><button class="btn btn-small" data-act="restart">Restart puzzle</button><button class="btn btn-small" data-act="share">Copy CagePad link</button><button class="btn btn-small" data-act="export">Copy progress</button><button class="btn btn-small" data-act="import">Paste progress</button></div>
				<div class="small muted" style="margin-top:6px">Progress is saved automatically in this browser.</div>
			</div>
			<div class="card"><h3>Bookmarklet</h3>
				<div class="small">Drag this to your bookmarks bar. Click it on any SudokuPad, f-puzzles or logic-masters page to open that puzzle here instantly.</div>
				<div style="margin-top:8px"><a class="bookmarklet" href="${esc(bm)}" onclick="return false">Open in CagePad</a></div>
			</div>`;
	}

	// ---------- check / solved ----------

	function checkSolved(explicit) {
		if (!Z) return;
		let filled = true;
		for (let i = 0; i < Z.N; i++) if (!G.value(i)) { filled = false; break; }
		const conflicts = S.findConflicts(Z, peers, G);
		const A = analyses();
		const badCages = A.cages.filter(c => c.cage.sum !== null && c.analysis.status === 'bad').length;
		if (Z.solution) {
			let wrong = 0, unknown = 0;
			for (let i = 0; i < Z.N; i++) {
				const s = Z.solution[i], v = G.value(i);
				if (!/\d/.test(s)) { unknown++; continue; }
				if (v && v !== s) wrong++;
			}
			const done = filled && wrong === 0;
			if (done && !solved) return markSolved();
			if (explicit) {
				if (done) toast('Solved — nicely done!');
				else if (wrong) toast(`${wrong} digit${wrong > 1 ? 's are' : ' is'} not right yet.`);
				else toast('No mistakes so far.');
			}
			return;
		}
		if (explicit) {
			if (conflicts.size || badCages) toast(`${conflicts.size ? conflicts.size + ' conflicting cells' : ''}${conflicts.size && badCages ? ' and ' : ''}${badCages ? badCages + ' broken cage' + (badCages > 1 ? 's' : '') : ''}.`);
			else if (filled) toast('Grid is full with no conflicts. (No solution data to verify against.)');
			else toast('No conflicts found. (This puzzle has no stored solution.)');
		}
		if (filled && !conflicts.size && !badCages && !solved && !Z.solution && explicit) markSolved();
	}

	function markSolved() {
		solved = true;
		stopTimer();
		scheduleSave(true);
		const sc = solutionCode();
		$('#solvedTitle').textContent = 'Solved!';
		$('#solvedBody').innerHTML = `<p style="margin-top:0">You finished <b>${esc(Z.meta.title || 'the puzzle')}</b> in <b>${fmtTime(timer.elapsed)}</b>.</p>` +
			(sc && sc.code ? `<p class="small">${esc(sc.text)}</p><div class="row"><span class="code-out">${esc(sc.code)}</span><button class="btn btn-small" data-act="copy-code">Copy</button></div>` : '') +
			(info && info.id ? `<p><a class="btn btn-primary" href="https://logic-masters.de/Raetselportal/Raetsel/zeigen.php?id=${esc(info.id)}" target="_blank" rel="noopener">Submit on logic-masters ↗</a></p>` : '') +
			'<p class="row"><button class="btn" data-act="browse">Find another puzzle</button></p>';
		$('#solvedDlg').showModal();
		remember();
	}

	// ---------- timer ----------

	function startTimer() { if (!timer.running && !solved) { timer.running = true; timer.since = Date.now(); } }
	function stopTimer() { if (timer.running) { timer.elapsed += Date.now() - timer.since; timer.running = false; } }
	const elapsedNow = () => timer.elapsed + (timer.running ? Date.now() - timer.since : 0);
	function fmtTime(ms) {
		const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
		return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
	}
	function updateTimer() {
		$('#timer').textContent = fmtTime(elapsedNow());
		$('.timer-box').hidden = !settings.showTimer || !Z;
	}
	function togglePause() {
		if (!Z || solved) return;
		timer.paused = !timer.paused;
		if (timer.paused) stopTimer(); else startTimer();
		$('#pausedCover').hidden = !timer.paused;
		updateTimer();
	}

	// ---------- persistence ----------

	let saveTimer = null;
	function scheduleSave(now) {
		clearTimeout(saveTimer);
		const go = () => {
			if (!Z || !pid) return;
			const started = G.v.some(Boolean) || G.k.some(Boolean) || G.e.some(Boolean) || G.o.some(o => o.length);
			store.set('cagepad:save:' + pid, {state: G.snapshot(), elapsed: elapsedNow(), solved, started, savedAt: Date.now()});
		};
		if (now) go(); else saveTimer = setTimeout(go, 400);
	}

	function remember(title, author, route) {
		if (!pid) return;
		const list = store.get('cagepad:recent', []);
		const prev = list.find(x => x.pid === pid) || {};
		const entry = Object.assign(prev, {pid, savedAt: Date.now(), solved});
		if (title) entry.title = title;
		if (author !== undefined) entry.author = author;
		if (route) entry.route = route;
		if (info && info.id) entry.lm = info.id;
		const next = [entry].concat(list.filter(x => x.pid !== pid)).slice(0, 60);
		store.set('cagepad:recent', next);
	}
	const progressFor = lmId => {
		const s = store.get('cagepad:save:lm:' + lmId, null);
		if (!s) return null;
		return s.solved ? 'solved' : s.started ? 'progress' : null;
	};

	// ---------- loading ----------

	function showMessage(html) {
		const el = $('#boardMsg');
		el.innerHTML = html;
		el.hidden = false;
	}
	const errorCard = (title, detail) => `<div class="welcome"><h2>${esc(title)}</h2><p>${esc(detail || '')}</p></div>`;

	async function fetchJson(url) {
		const res = await fetch(url, {cache: 'no-cache'});
		if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
		return res.json();
	}
	async function loadIndex(force) {
		if (indexCache && !force) return indexCache;
		try { indexCache = await fetchJson('data/index.json'); } catch (e) { indexCache = {puzzles: [], error: e.message}; }
		return indexCache;
	}

	async function route() {
		const h = location.hash.replace(/^#/, '');
		if (!h) return showWelcome();
		const p = {};
		h.split('&').forEach(kv => { const k = kv.indexOf('='); if (k > 0) p[kv.slice(0, k)] = kv.slice(k + 1); });
		const dec = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
		if (p.data) return loadFromData(dec(p.data), {src: p.src ? dec(p.src) : null, lm: p.lm ? dec(p.lm) : null});
		if (p.lm) return loadLM(dec(p.lm).toUpperCase());
		if (p.sp) return loadSP(dec(p.sp));
		if (p.url) return loadInput(dec(p.url));
		showWelcome();
	}

	function go(hashStr) {
		if (location.hash === '#' + hashStr) route();
		else location.hash = hashStr;
	}

	async function loadInput(text) {
		const c = F.classifyInput(text);
		switch (c.kind) {
			case 'lm': return go('lm=' + c.id);
			case 'sp': return go('sp=' + encodeURIComponent(c.id) + (Object.keys(c.settings || {}).length ? '' : ''));
			case 'data': return go('data=' + encodeURIComponent(c.data) + (c.url ? '&src=' + encodeURIComponent(c.url) : ''));
			case 'short':
				if (settings.proxy) {
					try {
						const final = await proxyResolve(c.url);
						if (final) return loadInput(final);
					} catch (e) { /* fall through */ }
				}
				return showMessage(`<div class="welcome"><h2>Short link</h2><p>CagePad can't follow <b>${esc(c.url)}</b> from the browser. Open it, then paste the full SudokuPad / f-puzzles address here — or use the <b>Open in CagePad</b> bookmarklet on that page.</p><p><a class="btn" href="${esc(c.url)}" target="_blank" rel="noopener">Open link ↗</a></p></div>`);
			case 'external':
				return showMessage(`<div class="welcome"><h2>Unsupported link</h2><p>CagePad understands logic-masters.de, SudokuPad and f-puzzles links. This one (${esc(c.url)}) needs its own solver.</p><p><a class="btn" href="${esc(c.url)}" target="_blank" rel="noopener">Open it ↗</a></p></div>`);
			default:
				toast('Paste a logic-masters link or ID, a SudokuPad link or an f-puzzles link.');
		}
	}

	async function loadLM(id) {
		showMessage(`<div class="welcome"><p>Loading ${esc(id)}…</p></div>`);
		let rec = null;
		try { rec = await fetchJson('data/puzzles/' + id + '.json'); } catch (e) { rec = null; }
		if ((!rec || !rec.data) && settings.proxy) {
			try { rec = await proxyLoadLM(id, rec); } catch (e) { console.warn('proxy load failed', e); }
		}
		if (rec && rec.data) return startPuzzle(rec.data, {info: rec, pid: 'lm:' + id, route: '#lm=' + id, settings: rec.settings});
		showNotCached(id, rec);
	}

	async function loadSP(id) {
		const idx = await loadIndex();
		const hit = (idx.puzzles || []).find(p => p.spId === id);
		if (hit) return loadLM(hit.id);
		if (settings.proxy) {
			try {
				const text = (await proxyFetch('https://sudokupad.app/api/puzzle/' + encodeURIComponent(id))).trim();
				if (F.DATA_PREFIX.test(text) || text.startsWith('{')) return loadFromData(text, {src: 'https://sudokupad.app/' + id});
			} catch (e) { console.warn('proxy failed', e); }
		}
		showMessage(`<div class="welcome"><h2>SudokuPad puzzle “${esc(id)}”</h2>
			<p>This puzzle isn't in CagePad's logic-masters cache, and browsers can't read SudokuPad short links directly.</p>
			<p><b>Fastest:</b> open it on SudokuPad and click the <b>Open in CagePad</b> bookmarklet (see Tools → Bookmarklet).</p>
			<p>If it's a logic-masters puzzle, paste its logic-masters link or ID instead.</p>
			<p><a class="btn" href="https://sudokupad.app/${esc(encodeURIComponent(id))}" target="_blank" rel="noopener">Open on SudokuPad ↗</a></p></div>`);
	}

	async function loadFromData(data, opts) {
		let rec = null;
		const lmId = opts.lm;
		const idx = await loadIndex();
		if (lmId) rec = await fetchJson('data/puzzles/' + lmId + '.json').catch(() => null);
		if (!rec && opts.src) {
			const c = F.classifyInput(opts.src);
			if (c.kind === 'sp') {
				const hit = (idx.puzzles || []).find(p => p.spId === c.id);
				if (hit) rec = await fetchJson('data/puzzles/' + hit.id + '.json').catch(() => null);
			}
		}
		const infoObj = rec ? Object.assign({}, rec, {data: undefined}) : (opts.src ? {src: opts.src} : null);
		const c = opts.src ? F.classifyInput(opts.src) : null;
		const pidKey = rec ? 'lm:' + rec.id : 'd:' + hash(data);
		startPuzzle(data, {info: infoObj, pid: pidKey, route: location.hash, settings: (c && c.settings) || (rec && rec.settings)});
	}

	function showNotCached(id, rec) {
		const repo = CONFIG.repo;
		const issueUrl = repo ? `https://github.com/${repo}/issues/new?title=${encodeURIComponent('fetch ' + id)}&body=${encodeURIComponent('Fetch logic-masters puzzle ' + id + ' into the CagePad cache.\n\n(The workflow runs automatically for the repository owner.)')}` : null;
		const lmUrl = 'https://logic-masters.de/Raetselportal/Raetsel/zeigen.php?id=' + id;
		let why = 'CagePad hasn\'t cached this puzzle yet — the cache updates hourly with the newest logic-masters puzzles.';
		if (rec && !rec.data) {
			why = rec.links && rec.links.length && rec.links.every(l => l.kind === 'penpa')
				? 'This puzzle is only available as a penpa-edit link, which CagePad cannot play.'
				: (rec.links && rec.links.length ? 'The puzzle data could not be fetched yet' + (rec.error ? ' (' + rec.error.replace(/<[^>]*>/g, '').slice(0, 140) + ')' : '') + '. It is retried automatically.' : 'No SudokuPad or f-puzzles link was found on its logic-masters page.');
		}
		const playLinks = rec && rec.links ? rec.links.map(l => `<a class="btn btn-small" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.kind)} ↗</a>`).join(' ') : '';
		showMessage(`<div class="welcome"><h2>${esc((rec && rec.title) || 'Puzzle ' + id)}</h2><p>${esc(why)}</p>
			<p><b>Open it right now:</b> click through to SudokuPad and use the <b>Open in CagePad</b> bookmarklet (Tools tab).</p>
			${issueUrl ? `<p><b>Or add it to the cache:</b> <a class="btn btn-small" href="${esc(issueUrl)}" target="_blank" rel="noopener" data-act="requested" data-id="${esc(id)}">Request via GitHub ↗</a> — a GitHub Action fetches it in about two minutes; this page checks back automatically.</p>` : ''}
			<p class="row"><a class="btn btn-small" href="${esc(lmUrl)}" target="_blank" rel="noopener">logic-masters page ↗</a> ${playLinks}</p>
			<p id="pollStatus" class="small"></p></div>`);
	}

	let pollTimer = null;
	function pollFor(id) {
		clearInterval(pollTimer);
		let tries = 0;
		const statusEl = () => document.getElementById('pollStatus');
		pollTimer = setInterval(async () => {
			tries++;
			if (statusEl()) statusEl().textContent = `Waiting for the GitHub Action… (${tries * 20}s)`;
			try {
				const rec = await fetchJson('data/puzzles/' + id + '.json');
				if (rec && rec.data) { clearInterval(pollTimer); indexCache = null; return go('lm=' + id); }
			} catch (e) { /* not there yet */ }
			if (tries >= 24) { clearInterval(pollTimer); if (statusEl()) statusEl().textContent = 'Still not there — check the Actions tab of the repository.'; }
		}, 20000);
	}

	// optional user-configured CORS proxy (e.g. the Cloudflare Worker in /worker)
	async function proxyFetch(url) {
		const tpl = settings.proxy.trim();
		const full = tpl.includes('{url}') ? tpl.replace('{url}', encodeURIComponent(url)) : tpl + encodeURIComponent(url);
		const res = await fetch(full);
		if (!res.ok) throw new Error('proxy HTTP ' + res.status);
		return res.text();
	}
	async function proxyResolve(url) {
		const tpl = settings.proxy.trim();
		const full = (tpl.includes('{url}') ? tpl.replace('{url}', encodeURIComponent(url)) : tpl + encodeURIComponent(url)) + (tpl.includes('?') ? '&' : '?') + 'resolve=1';
		const res = await fetch(full);
		return res.ok ? (res.headers.get('x-final-url') || (await res.text()).trim()) : null;
	}
	async function proxyLoadLM(id, base) {
		const html = await proxyFetch('https://logic-masters.de/Raetselportal/Raetsel/zeigen.php?id=' + id);
		const doc = new DOMParser().parseFromString(html, 'text/html');
		const text = el => el ? el.textContent.replace(/\s+\n/g, '\n').trim() : '';
		const body = doc.querySelector('.rp_html');
		const rec = Object.assign({}, base || {}, {
			id, title: text(doc.querySelector('.rp_titel h2')),
			author: text(doc.querySelector('.rp_eingestellt a')),
			rules: body ? body.innerText || text(body) : '',
			solutionCode: text(doc.querySelector('.rp_loesungscode_descr')),
			links: [],
		});
		if (body) body.querySelectorAll('a[href]').forEach(a => {
			const c = F.classifyInput(a.getAttribute('href'));
			if (['sp', 'data', 'short'].includes(c.kind)) rec.links.push({url: a.getAttribute('href'), kind: c.kind});
		});
		for (const l of rec.links) {
			let c = F.classifyInput(l.url);
			if (c.kind === 'short') { const fin = await proxyResolve(l.url).catch(() => null); if (!fin) continue; c = F.classifyInput(fin); }
			if (c.kind === 'data') { rec.data = c.data; rec.link = l.url; rec.settings = c.settings; break; }
			if (c.kind === 'sp') {
				const t = (await proxyFetch('https://sudokupad.app/api/puzzle/' + encodeURIComponent(c.id))).trim();
				if (F.DATA_PREFIX.test(t) || t.startsWith('{')) { rec.data = t; rec.link = l.url; rec.settings = c.settings; break; }
			}
		}
		return rec;
	}

	// ---------- welcome / browse ----------

	async function showWelcome() {
		Z = null;
		document.body.classList.add('no-puzzle');
		document.title = 'CagePad';
		$('#pTitle').textContent = 'CagePad';
		$('#pSub').textContent = 'SudokuPad-style solving with live cage totals';
		['lUnder', 'lColors', 'lHigh', 'lGrid', 'lCages', 'lLines', 'lOver', 'lFocus', 'lDigits', 'lBadges', 'lSel'].forEach(id => { document.getElementById(id).innerHTML = ''; });
		$('#board').setAttribute('viewBox', '0 0 576 576');
		$('#board').style.aspectRatio = '1';
		updateTimer();
		const recent = store.get('cagepad:recent', []).filter(r => r.route).slice(0, 5);
		showMessage(`<div class="welcome"><h2>Pick a puzzle</h2>
			<p>Paste a logic-masters.de link or puzzle ID above — or start with one of the newest puzzles:</p>
			<div id="welcomeList" class="browse-list" style="min-height:0">Loading the newest puzzles…</div>
			<p class="row"><button class="btn" data-act="browse">Browse all</button></p>
			${recent.length ? '<h3 style="margin:14px 0 4px;font-size:14px">Continue</h3>' + recent.map(r => `<a class="bi" href="${esc(r.route)}"><span class="t">${esc(r.title || r.pid)}</span><span class="r">${recentStatus(r)}</span><span class="a">${esc(r.author || '')}</span></a>`).join('') : ''}
		</div>`);
		const idx = await loadIndex();
		const el = document.getElementById('welcomeList');
		if (!el) return;
		const items = (idx.puzzles || []).filter(p => p.playable).slice(0, 6);
		el.innerHTML = items.length ? items.map(browseItem).join('') : `<p>${idx.error ? 'The puzzle cache is not available yet.' : 'No cached puzzles yet — the GitHub Action fills this in within the hour.'}</p>`;
	}

	function recentStatus(r) {
		const s = store.get('cagepad:save:' + r.pid, null) || {};
		if (s.solved) return '<span class="status-solved">solved</span>';
		return s.started ? '<span class="status-progress">in progress</span>' : '<span class="muted">opened</span>';
	}

	function browseItem(p) {
		const st = progressFor(p.id);
		const tags = (p.tags || []).filter(t => !/^sudoku$/i.test(t)).slice(0, 3).map(t => t.replace(/\s*\(Variante\)/i, '')).join(', ');
		return `<a class="bi${p.playable ? '' : ' unplayable'}" href="#lm=${esc(p.id)}">
			<span class="t">${esc(p.title || p.id)}${p.cages ? ` <span class="tag">${p.cages} cages</span>` : ''}</span>
			<span class="r">${p.difficulty ? `<span class="stars">${'★'.repeat(p.difficulty)}</span><br>` : ''}${st === 'solved' ? '<span class="status-solved">solved</span>' : st === 'progress' ? '<span class="status-progress">in progress</span>' : (p.playable ? '' : 'not playable')}</span>
			<span class="a">${esc(p.author || '')}${p.solvedCount !== undefined ? ` · ${p.solvedCount} solves` : ''}${tags ? ' · ' + esc(tags) : ''}</span></a>`;
	}

	async function openBrowse() {
		const dlg = $('#browseDlg');
		if (!dlg.open) dlg.showModal();
		$('#browseList').innerHTML = '<p class="muted">Loading…</p>';
		const idx = await loadIndex(true);
		renderBrowse(idx);
	}
	function renderBrowse(idx) {
		idx = idx || indexCache || {puzzles: []};
		const q = $('#browseSearch').value.trim().toLowerCase();
		const playable = $('#browsePlayable').checked, cages = $('#browseCages').checked, hideSolved = $('#browseHideSolved').checked;
		const list = (idx.puzzles || []).filter(p =>
			(!playable || p.playable) && (!cages || p.cages) && (!hideSolved || progressFor(p.id) !== 'solved') &&
			(!q || [p.title, p.author, p.id, ...(p.tags || [])].join(' ').toLowerCase().includes(q)));
		$('#browseMeta').textContent = idx.error ? 'Puzzle cache unavailable (' + idx.error + ').' :
			`${list.length} of ${(idx.puzzles || []).length} cached puzzles${idx.updated ? ' · updated ' + new Date(idx.updated).toLocaleString() : ''}`;
		$('#browseList').innerHTML = list.slice(0, 400).map(browseItem).join('') || '<p class="muted">Nothing matches.</p>';
	}

	// ---------- settings & help dialogs ----------

	function openSettings() {
		const row = (key, label, hint, control) => `<div class="set-row"><span class="lbl">${label}${hint ? `<small>${hint}</small>` : ''}</span>${control}</div>`;
		const toggle = key => `<input type="checkbox" data-set="${key}" ${settings[key] ? 'checked' : ''}>`;
		const select = (key, opts) => `<select data-set="${key}">${opts.map(([v, l]) => `<option value="${v}" ${settings[key] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
		$('#settingsBody').innerHTML = [
			row('badgeMode', 'Cage totals on the grid', 'Running total shown next to each cage clue', select('badgeMode', [['sum', 'Current sum'], ['remaining', 'Still needed / cells left'], ['off', 'Off']])),
			row('badgeArrows', 'Totals on arrows', 'Shaft sum shown in the bulb cell', toggle('badgeArrows')),
			row('conflicts', 'Highlight conflicts', 'Rows, columns, boxes, cages, anti-king/knight', toggle('conflicts')),
			row('showMistakes', 'Show mistakes', 'Compare with the stored solution (when the puzzle has one)', toggle('showMistakes')),
			row('autoClean', 'Auto-remove pencil marks', 'Placing a digit removes it from marks in seen cells', toggle('autoClean')),
			row('highlightSame', 'Highlight same digit', '', toggle('highlightSame')),
			row('showSeen', 'Highlight seen cells', 'Tint cells that see the selected cell', toggle('showSeen')),
			row('comboUsesMarks', 'Combos use centre marks', 'Strike combinations that do not fit the pencil marks', toggle('comboUsesMarks')),
			row('showTimer', 'Show timer', '', toggle('showTimer')),
			row('theme', 'Theme', '', select('theme', [['auto', 'System'], ['light', 'Light'], ['dark', 'Dark']])),
			row('proxy', 'CORS proxy (optional)', 'Lets CagePad load any puzzle on demand. See README → worker.', `<input type="text" data-set="proxy" value="${esc(settings.proxy)}" placeholder="https://…workers.dev/?url={url}" style="width:220px">`),
		].join('');
		$('#settingsDlg').showModal();
	}
	function onSettingChange(evt) {
		const el = evt.target, key = el.dataset.set;
		if (!key) return;
		settings[key] = el.type === 'checkbox' ? el.checked : el.value;
		saveSettings();
		if (key === 'theme') applyTheme();
		updateTimer();
		if (Z) renderAll();
	}
	function applyTheme() {
		if (settings.theme === 'light' || settings.theme === 'dark') document.documentElement.dataset.theme = settings.theme;
		else delete document.documentElement.dataset.theme;
	}

	function bookmarkletHref() {
		const code = `(async()=>{const S=${JSON.stringify(SITE)};const h=location.hostname,q=new URLSearchParams(location.search);try{` +
			`if(/logic-masters\\.de$/.test(h)){const id=q.get('id');if(id){open(S+'#lm='+id);return}}` +
			`if(/f-puzzles\\.com$/.test(h)){const m=location.search.match(/[?&]load=([^&]*)/);if(m){open(S+'#data='+encodeURIComponent('fpuzzles'+decodeURIComponent(m[1]))+'&src='+encodeURIComponent(location.href));return}}` +
			`if(/sudokupad|crackingthecryptic/.test(h)){let m=location.search.match(/[?&]puzzle=([^&]*)/),d=m?decodeURIComponent(m[1]):null;` +
			`if(!d){const id=decodeURIComponent(location.pathname.replace(/^\\/(sudoku\\/|puzzle\\/)?/,''));d=/^(scl|ctc|fpuz)/.test(id)?id:(await(await fetch('/api/puzzle/'+encodeURIComponent(id))).text()).trim()}` +
			`if(d){open(S+'#data='+encodeURIComponent(d)+'&src='+encodeURIComponent(location.href));return}}` +
			`alert('CagePad: open a SudokuPad, f-puzzles or logic-masters puzzle page first.')}catch(e){alert('CagePad: '+e)}})()`;
		return 'javascript:' + encodeURIComponent(code);
	}

	function openHelp() {
		$('#helpBody').innerHTML = `
			<h3>Loading puzzles</h3>
			<p>Paste a <b>logic-masters.de</b> link or puzzle ID (like <code>000VJX</code>), a <b>SudokuPad</b> link or an <b>f-puzzles</b> link into the box at the top, or press <b>Browse</b> for the newest logic-masters puzzles. A GitHub Action caches the newest logic-masters puzzles every hour, because browsers aren't allowed to read logic-masters or SudokuPad directly.</p>
			<p>For anything not cached, drag this bookmarklet to your bookmarks bar and click it on the puzzle's SudokuPad page: <a class="bookmarklet" href="${esc(bookmarkletHref())}" onclick="return false">Open in CagePad</a></p>
			<h3>Cage totals</h3>
			<p>Every cage gets a little pill next to its clue with the sum of the digits placed so far: <span class="pill partial">9</span> on track, <span class="pill done">15</span> complete and correct, <span class="pill bad">17</span> over the total, repeated or no longer reachable. Switch to “remaining” in Settings to see what's left. The <b>Sums</b> tab lists every cage, arrow and line with its combinations, and selecting cells shows their total (plus the total of whole cages inside the selection, for the 45 rule).</p>
			<h3>Keyboard</h3>
			<div class="keys">
				<span><kbd>1</kbd>–<kbd>9</kbd></span><span>Enter digit (normal / corner / centre / colour, depending on mode)</span>
				<span><kbd>Z</kbd> <kbd>X</kbd> <kbd>C</kbd> <kbd>V</kbd></span><span>Normal, corner, centre, colour mode · <kbd>Space</kbd> cycles</span>
				<span>hold <kbd>Shift</kbd> / <kbd>Ctrl</kbd></span><span>Temporarily corner / centre marks (both: colour)</span>
				<span><kbd>Backspace</kbd></span><span>Clear selected cells</span>
				<span><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd></span><span>Undo / redo</span>
				<span>Arrows</span><span>Move selection (<kbd>Shift</kbd> extends)</span>
				<span>Drag / <kbd>Shift</kbd>+click</span><span>Select several cells · <kbd>Ctrl</kbd>+click removes</span>
				<span>Double-click</span><span>Select all cells with the same digit or colour</span>
				<span><kbd>Ctrl</kbd>+<kbd>A</kbd> · <kbd>Esc</kbd></span><span>Select all · deselect</span>
				<span><kbd>P</kbd> · <kbd>B</kbd> · <kbd>?</kbd></span><span>Pause · browse · this help</span>
			</div>`;
		$('#helpDlg').showModal();
	}

	// ---------- event wiring ----------

	function onPanelClick(evt) {
		const t = evt.target.closest('[data-act],[data-focus],[data-cc]');
		if (!t) return;
		if (t.dataset.cc) {
			const d = t.dataset.cc, cur = comboCalc.digits[d];
			comboCalc.digits[d] = cur === undefined ? 'must' : cur === 'must' ? 'not' : undefined;
			if (comboCalc.digits[d] === undefined) delete comboCalc.digits[d];
			renderAll();
			return;
		}
		if (t.dataset.focus) {
			const [kind, k] = t.dataset.focus.split(':');
			const cells = kind === 'cage' ? Z.cages[+k].cells : kind === 'arrow' ? arrows[+k].cells.concat(arrows[+k].bulb || []) : lines[+k].cells;
			selection = new Set(cells);
			cursor = cells[0];
			renderAll();
			return;
		}
		const act = t.dataset.act;
		const cageIdx = t.dataset.cage !== undefined ? +t.dataset.cage : null;
		switch (act) {
			case 'pencil-cage': autoCandidates(Z.cages[cageIdx].cells, true); break;
			case 'select-cage': selection = new Set(Z.cages[cageIdx].cells); renderAll(); break;
			case 'auto-sel': if (selection.size) autoCandidates([...selection], document.getElementById('autoUseCages').checked); else toast('Select some cells first.'); break;
			case 'auto-all': autoCandidates(Array.from({length: Z.N}, (_, i) => i), document.getElementById('autoUseCages').checked); break;
			case 'clear-marks': commit(() => { G.k.fill(''); G.e.fill(''); }); break;
			case 'clear-colours': commit(() => { G.o = G.o.map(() => []); }); break;
			case 'restart':
				if (confirm('Restart this puzzle? Your progress will be cleared (you can still undo).')) {
					commit(() => { G.v.fill(''); G.k.fill(''); G.e.fill(''); G.o = G.o.map(() => []); });
					solved = false; timer = {elapsed: 0, running: false, since: 0, paused: false}; startTimer();
				}
				break;
			case 'share': copy(SITE + location.hash, 'Link copied'); break;
			case 'export': copy(JSON.stringify({cagepad: 1, pid, state: JSON.parse(G.snapshot()), elapsed: elapsedNow()}), 'Progress copied to clipboard'); break;
			case 'import': {
				const txt = prompt('Paste progress JSON:');
				if (!txt) break;
				try { const d = JSON.parse(txt); commit(() => G.restore(d.state || d)); toast('Progress restored'); } catch (e) { toast('That did not look like CagePad progress.'); }
				break;
			}
			case 'copy-code': { const sc = solutionCode(); if (sc && sc.code) copy(sc.code, 'Solution code copied'); break; }
			case 'browse': $('#solvedDlg').close(); openBrowse(); break;
			case 'requested': pollFor(t.dataset.id); break;
		}
	}

	function onPanelHover(evt) {
		const t = evt.target.closest('[data-focus]');
		let cells = null;
		if (t && Z) {
			const [kind, k] = t.dataset.focus.split(':');
			cells = kind === 'cage' ? Z.cages[+k].cells : kind === 'arrow' ? arrows[+k].cells.concat(arrows[+k].bulb || []) : lines[+k].cells;
		}
		if (String(cells) !== String(focusCells)) {
			focusCells = cells;
			$('#lFocus').innerHTML = focusCells ? R.outlineEl(Z, focusCells, 'focus-outline') : '';
		}
	}

	async function copy(text, msg) {
		try { await navigator.clipboard.writeText(text); toast(msg || 'Copied'); }
		catch (e) { prompt('Copy this:', text); }
	}

	function init() {
		applyTheme();
		const svg = $('#board');
		svg.addEventListener('pointerdown', onPointerDown);
		svg.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', onPointerUp);
		document.addEventListener('keydown', onKeyDown);
		document.addEventListener('keyup', onKeyUp);
		window.addEventListener('blur', () => { tempMode = null; if (Z) renderAll(); });
		// click outside the grid & panels clears selection (like SudokuPad)
		document.addEventListener('pointerdown', evt => {
			if (!Z || evt.target.closest('#board, .side-col, dialog, .topbar, .sel-bar')) return;
			if (selection.size) { selection.clear(); renderAll(); }
		});
		$('#pad').addEventListener('click', evt => { const b = evt.target.closest('button'); if (b) enterDigit(+b.dataset.d); });
		document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
		$('#delBtn').addEventListener('click', clearCells);
		$('#undoBtn').addEventListener('click', undo);
		$('#redoBtn').addEventListener('click', redo);
		$('#checkBtn').addEventListener('click', () => checkSolved(true));
		$('#pauseBtn').addEventListener('click', togglePause);
		$('#resumeBtn').addEventListener('click', togglePause);
		document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
		['#panel-sums', '#panel-rules', '#panel-tools', '#solvedBody', '#boardMsg'].forEach(sel => $(sel).addEventListener('click', onPanelClick));
		$('#panel-sums').addEventListener('mouseover', onPanelHover);
		$('#panel-sums').addEventListener('mouseleave', () => { focusCells = null; if (Z) $('#lFocus').innerHTML = ''; });
		$('#panel-sums').addEventListener('input', evt => {
			if (evt.target.id === 'ccSize' || evt.target.id === 'ccTotal') {
				comboCalc.size = Math.max(1, Math.min(Z.maxDigit, +$('#ccSize').value || 1));
				comboCalc.total = Math.max(1, +$('#ccTotal').value || 1);
				if (evt.target.id === 'ccSize') selection.size > 1 && (selection = new Set());
				$('#ccOut').innerHTML = comboCalcOut(comboCalc.size);
			}
		});
		$('#panel-tools').addEventListener('change', evt => { if (evt.target.id === 'autoUseCages') store.set('cagepad:autoUseCages', evt.target.checked); });
		$('#loadForm').addEventListener('submit', evt => { evt.preventDefault(); const v = $('#loadInput').value; if (v.trim()) { loadInput(v); $('#loadInput').blur(); } });
		$('#loadInput').addEventListener('paste', () => setTimeout(() => { const v = $('#loadInput').value; if (v.trim() && F.classifyInput(v).kind !== 'unknown') loadInput(v); }, 0));
		$('#browseBtn').addEventListener('click', openBrowse);
		$('#settingsBtn').addEventListener('click', openSettings);
		$('#helpBtn').addEventListener('click', openHelp);
		['#browseSearch', '#browsePlayable', '#browseCages', '#browseHideSolved'].forEach(sel => $(sel).addEventListener('input', () => renderBrowse()));
		$('#browseList').addEventListener('click', evt => { if (evt.target.closest('a.bi')) $('#browseDlg').close(); });
		$('#settingsBody').addEventListener('change', onSettingChange);
		document.querySelectorAll('dialog').forEach(d => {
			d.addEventListener('click', evt => { if (evt.target === d || evt.target.closest('[data-close]')) d.close(); });
		});
		document.addEventListener('visibilitychange', () => {
			if (!Z || timer.paused || solved) return;
			if (document.hidden) { stopTimer(); scheduleSave(true); } else startTimer();
		});
		window.addEventListener('beforeunload', () => { if (Z) scheduleSave(true); });
		window.addEventListener('hashchange', route);
		setInterval(() => { if (Z) updateTimer(); }, 1000);
		setInterval(() => { if (Z && timer.running) scheduleSave(); }, 15000);
		route();
	}

	CP.app = {get puzzle() { return Z; }, get game() { return G; }, enterDigit, setMode, select: cells => { selection = new Set(cells); renderAll(); }, startPuzzle};
	init();
})(window.CP);
