// The desktop build sets this to true (build.py): a layout for a computer screen, mouse and keyboard, more cores.
const DESKTOP = /*DESKTOP*/false;
// BG Play's review: this is the BG Position Analyzer's script (its tile's index.html, turned into review.js by BG Play's
// mkreview.py), running in a frame inside BG Play. BG Play hands over the game's positions, the engine's weights, the
// opening book and, in the tile, Claude through window.parent.BGP_RV.
const RVX = (() => { try { return window.parent !== window ? window.parent.BGP_RV || null : null; } catch (e) { return null; } })();
const REVIEW = true;
const START = [0, -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2, 0];
const S = {
  mode: 'setup', board: START.slice(), placing: 1, dice: null, decision: 'checker', roPreset: 'standard',
  cube: { value: 1, owner: 0 }, game: { type: 'money', jacoby: true, beaver: true, len: 7, me: 0, opp: 0, crawford: false },
  workers: DESKTOP ? Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 2)) : 4, res: null, sel: 0, preview: null,
};
if (DESKTOP) document.body.classList.add('desk');
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------- position helpers
function counts(b) {
  let me = b[25], opp = b[0];
  for (let p = 1; p <= 24; p++) { if (b[p] > 0) me += b[p]; else opp -= b[p]; }
  return { me, opp };
}
function pips(b) {
  let me = 25 * b[25], op = 25 * b[0];
  for (let p = 1; p <= 24; p++) { if (b[p] > 0) me += p * b[p]; else if (b[p] < 0) op += (25 - p) * -b[p]; }
  return [me, op];
}
function flip(b) { const r = new Array(26).fill(0); r[0] = b[25]; r[25] = b[0]; for (let p = 1; p <= 24; p++) r[p] = -b[25 - p]; return r; }
function problems() {
  const c = counts(S.board), out = [];
  if (c.me > 15) out.push(`You have ${c.me} checkers (15 max)`);
  if (c.opp > 15) out.push(`Opponent has ${c.opp} checkers (15 max)`);
  if (c.me === 0) out.push('Place your checkers');
  else if (c.opp === 0) out.push("Place the opponent's checkers");
  if (!out.length && S.decision === 'checker' && !S.dice) out.push('Set the dice');
  return out;
}
const enc = (n, up) => n ? String.fromCharCode((up ? 64 : 96) + n) : '-';
function toXgid(st) {
  st = st || S; const b = st.board; let s = enc(b[0], false);
  for (let p = 1; p <= 24; p++) s += b[p] > 0 ? enc(b[p], true) : enc(-b[p], false);
  s += enc(b[25], true);
  const owner = st.cube.owner === 0 ? 0 : st.cube.owner === 1 ? 1 : -1;
  const dice = st === S ? (S.decision === 'checker' ? S.dice : null) : st.dice;
  const d = dice ? `${Math.max(...dice)}${Math.min(...dice)}` : '00';
  const g = st.game, match = g.type === 'match';
  const flag = match ? (g.crawford ? 1 : 0) : (g.jacoby ? 1 : 0) | (g.beaver ? 2 : 0);
  return `XGID=${s}:${Math.log2(st.cube.value)}:${owner}:1:${d}:${match ? g.me : 0}:${match ? g.opp : 0}:${flag}:${match ? g.len : 0}:10`;
}
function parseXgid(text) {
  const m = /XGID=(\S+)/.exec(text); const s = m ? m[1] : text.trim(); const f = s.split(':');
  if (f.length < 9 || f[0].length < 26) throw new Error('Not an XGID');
  const pos = f[0].slice(-26); let b = new Array(26).fill(0);
  for (let i = 0; i < 26; i++) { const ch = pos[i]; if (ch === '-') continue;
    const up = ch >= 'A' && ch <= 'Z', n = up ? ch.charCodeAt(0) - 64 : -(ch.charCodeAt(0) - 96);
    if (i === 0 || i === 25) b[i] = Math.abs(n); else b[i] = n; }
  const turn = +f[3], cpos = +f[2]; if (turn === -1) b = flip(b);
  const out = { board: b, cube: { value: 2 ** +f[1], owner: cpos === 0 ? 0 : cpos === turn ? 1 : 2 }, dice: /^[1-6][1-6]$/.test(f[4]) ? [+f[4][0], +f[4][1]] : null };
  const len = +f[8];
  if (len) { const [a, o] = turn === 1 ? [+f[5], +f[6]] : [+f[6], +f[5]]; out.game = { ...S.game, type: 'match', len, me: a, opp: o, crawford: !!(+f[7] & 1) }; }
  else out.game = { ...S.game, type: 'money', jacoby: !!(+f[7] & 1), beaver: !!(+f[7] & 2) };
  return out;
}
function fromXgid(text) {
  const x = parseXgid(text);
  S.board = x.board; S.cube = x.cube; S.dice = x.dice; S.decision = S.dice ? 'checker' : 'cube'; S.game = x.game;
}

// ------------------------------------------------------------- board geometry & drawing
let G = null;
function geometry(W, H) {
  const m = 3, lh = Math.max(15, Math.min(20, H * 0.055));
  const pw = (W - 2 * m) / (12 + 0.85 + 0.95);
  const bw = pw * 0.85, tw = pw * 0.95;
  const zt = (H - 2 * lh - 2 * m) / 10.6;           // a fifth of a point's length
  const r = Math.max(6, Math.min(pw * 0.47, zt * 0.5));
  const zh = Math.min(zt, 2 * r + 0.6), ph = zt * 5; // checkers stack touching; tap zones follow them
  const x0 = S.mirror ? m + tw : m;                  // mirrored: the tray comes first, on the left
  const colX = (c) => x0 + (c < 6 ? c * pw : bw + c * pw); // column 0..11 left to right
  const barX = x0 + 6 * pw, trayX = S.mirror ? m - 2 : x0 + 12 * pw + bw;
  const top = m + lh, bot = H - m - lh;
  return { W, H, m, x0, lh, pw, bw, tw, zh, ph, r, colX, barX, trayX, top, bot };
}
// Swap direction mirrors the board: Blue's home board on the left, the bear-off tray on the left.
const pointCol = (p) => { const r = p >= 13 ? { c: p - 13, top: true } : { c: 12 - p, top: false }; if (S.mirror) r.c = 11 - r.c; if (rvFlip()) r.top = !r.top; return r; };
function colPoint(c, isTop) { if (S.mirror) c = 11 - c; if (rvFlip()) isTop = !isTop; return isTop ? 13 + c : 12 - c; }

function drawBoard() {
  const svg = $('board');
  if (DESKTOP) {   // keep a board's proportions in a big window (width 1.3-1.6 times the height), centred
    const w = $('boardWrap'), W = w.clientWidth, H = w.clientHeight, k = W / H;
    const bw = k > 1.6 ? H * 1.6 : W, bh = k < 1.3 ? W / 1.3 : H;
    svg.style.width = bw + 'px'; svg.style.height = bh + 'px';
  }
  const R = svg.getBoundingClientRect();
  if (!R.width) return;
  G = geometry(R.width, R.height);
  svg.setAttribute('viewBox', `0 0 ${G.W} ${G.H}`);
  const b = S.mode === 'results' && S.preview ? S.preview.after : S.board;
  let s = `<rect x="0" y="0" width="${G.W}" height="${G.H}" rx="8" fill="var(--frame)"/>`;
  s += `<rect x="${G.x0}" y="${G.top - 2}" width="${12 * G.pw + G.bw}" height="${G.bot - G.top + 4}" fill="var(--felt)"/>`;
  s += `<rect x="${G.barX}" y="${G.top - 2}" width="${G.bw}" height="${G.bot - G.top + 4}" fill="var(--frame)" opacity=".85"/>`;
  s += `<rect x="${G.trayX + 2}" y="${G.top - 2}" width="${G.tw - 2}" height="${G.bot - G.top + 4}" fill="var(--frame)" opacity=".6"/>`;
  const ph = G.ph;
  for (let p = 1; p <= 24; p++) {
    const { c, top } = pointCol(p), x = G.colX(c);
    const y1 = top ? G.top : G.bot, y2 = top ? G.top + ph : G.bot - ph;
    s += `<polygon points="${x + 1},${y1} ${x + G.pw - 1},${y1} ${x + G.pw / 2},${y2}" fill="${(rvFlip() ? 25 - p : p) % 2 ? 'var(--pt1)' : 'var(--pt2)'}"/>`;
    const ly = top ? G.m + G.lh * 0.72 : G.H - G.m - G.lh * 0.22;
    s += `<text x="${x + G.pw / 2}" y="${ly}" font-size="${Math.min(12, G.lh * 0.7)}" font-weight="600" text-anchor="middle" fill="#efe6d2">${p}</text>`;
  }
  // checkers
  const chk = (cx, cy, mine, label, cls) => {
    let t = `<circle cx="${cx}" cy="${cy}" r="${G.r - 0.8}" fill="${mine ? 'var(--me)' : 'var(--opp)'}" stroke="${mine ? 'var(--me-edge)' : 'var(--opp-edge)'}" stroke-width="1.3" ${cls || ''}/>`;
    if (label) t += `<text x="${cx}" y="${cy + G.r * 0.36}" font-size="${G.r * 1.05}" font-weight="700" text-anchor="middle" fill="${mine ? 'var(--me-ink)' : 'var(--opp-ink)'}">${label}</text>`;
    return t;
  };
  const step = Math.min(G.zh, 2 * G.r);
  for (let p = 1; p <= 24; p++) {
    const n = b[p]; if (!n) continue;
    const { c, top } = pointCol(p), cx = G.colX(c) + G.pw / 2, cnt = Math.abs(n), show = Math.min(cnt, 5);
    for (let k = 0; k < show; k++) {
      const cy = top ? G.top + G.zh * (k + 0.5) : G.bot - G.zh * (k + 0.5);
      s += chk(cx, cy, n > 0, k === show - 1 && cnt > 5 ? cnt : '');
    }
  }
  // bar: opponent top half, you bottom half
  const bcx = G.barX + G.bw / 2, mid = G.H / 2;
  // centre of the bar: the cube when centred, with White's pip count above it and Blue's below
  const cs = Math.min(G.bw - 4, 24), fs = Math.min(13, G.bw * 0.4), cw = Math.min(G.bw - 4, fs * 2.3), ch = fs * 1.45;
  const ext = cs / 2 + 3 + ch;                       // how far the cube + chip stack reaches from the middle
  const barOff = Math.max(G.zh * 1.9, ext + G.r + 2);
  const fl = rvFlip() ? -1 : 1;
  if (b[0]) s += chk(bcx, mid - fl * barOff, false, b[0] > 1 ? b[0] : '');
  if (b[25]) s += chk(bcx, mid + fl * barOff, true, b[25] > 1 ? b[25] : '');
  { const [pm, po] = pips(b);
    const cube = (y, v) => `<rect x="${bcx - cs / 2}" y="${y}" width="${cs}" height="${cs}" rx="4" fill="#f4efe2" stroke="#222"/>` +
      `<text x="${bcx}" y="${y + cs * 0.68}" font-size="${cs * 0.48}" font-weight="700" text-anchor="middle" fill="#222">${v}</text>`;
    if (!S.cube.owner) s += cube(mid - cs / 2, 64);
    const half = S.cube.owner ? 4 : cs / 2 + 3;      // with no cube in the middle the chips close up
    const [rvU, rvUP, rvD, rvDP] = rvFlip() ? ['me', pm, 'opp', po] : ['opp', po, 'me', pm];   // the top chip is the top side's
    s += `<rect x="${bcx - cw / 2}" y="${mid - half - ch}" width="${cw}" height="${ch}" rx="4" fill="var(--${rvU})" stroke="var(--${rvU}-edge)"/>`;
    s += `<text x="${bcx}" y="${mid - half - ch * 0.27}" font-size="${fs}" font-weight="700" text-anchor="middle" fill="var(--${rvU}-ink)">${rvUP}</text>`;
    s += `<rect x="${bcx - cw / 2}" y="${mid + half}" width="${cw}" height="${ch}" rx="4" fill="var(--${rvD})" stroke="var(--${rvD}-edge)"/>`;
    s += `<text x="${bcx}" y="${mid + half + ch * 0.73}" font-size="${fs}" font-weight="700" text-anchor="middle" fill="var(--${rvD}-ink)">${rvDP}</text>`;
    G.cubeBox = S.cube.owner ? null : [mid - cs / 2, mid + cs / 2];
    if (S.cube.owner) G.ownedCube = cube; }
  // trays: borne-off (inferred)
  const c = counts(b), offMe = Math.max(0, 15 - c.me), offOpp = Math.max(0, 15 - c.opp);
  const tx = G.trayX + 2 + (G.tw - 2) / 2, slab = Math.min(6, (ph - 4) / 15);
  const tray = (n, isTop, mine) => {
    let t = '';
    for (let i = 0; i < n; i++) {
      const y = isTop ? G.top + 2 + i * slab : G.bot - 2 - (i + 1) * slab;
      t += `<rect x="${tx - G.tw * 0.34}" y="${y}" width="${G.tw * 0.68}" height="${slab - 1}" rx="1.5" fill="${mine ? 'var(--me)' : 'var(--opp)'}" stroke="${mine ? 'var(--me-edge)' : 'var(--opp-edge)'}" stroke-width=".6"/>`;
    }
    if (n) t += `<text x="${tx}" y="${isTop ? G.top + 2 + n * slab + 11 : G.bot - 2 - n * slab - 4}" font-size="10" font-weight="700" text-anchor="middle" fill="#efe6d2">${n}</text>`;
    return t;
  };
  s += rvFlip() ? tray(offOpp, false, false) + tray(offMe, true, true) : tray(offOpp, true, false) + tray(offMe, false, true);
  s += `<text x="${tx}" y="${mid + 4}" font-size="9" text-anchor="middle" fill="#efe6d2" opacity=".8">OFF</text>`;
  // dice on the board (right half, middle) and the cube on the bar
  if (S.decision === 'checker' && S.dice && S.mode === 'setup' && !S.rvItem) {
    const ds = Math.min(G.zh * 0.9, G.pw * 0.8), dx = G.colX(8) + G.pw / 2;
    S.dice.forEach((d, i) => { s += dieSvg(dx + i * (ds + 6) - (ds + 6) / 2 - ds / 2, mid - ds / 2, ds, d); });
  }
  if (S.rvItem && S.decision === 'checker' && S.dice) s += rvDice(mid);   // the roll, under the arrows
  if (S.mode === 'results' && S.preview) s += previewMarks(S.board, b) + arrows(S.board, b, S.preview.name);
  // an owned cube sits at its owner's end of the bar
  if (S.cube.owner) s += G.ownedCube((S.cube.owner === 1) !== rvFlip() ? G.bot - cs - 4 : G.top + 4, S.cube.value);
  svg.innerHTML = s;
}
function dieSvg(x, y, s, v) {
  const P = { 1: [[.5, .5]], 2: [[.27, .27], [.73, .73]], 3: [[.27, .27], [.5, .5], [.73, .73]], 4: [[.27, .27], [.73, .27], [.27, .73], [.73, .73]],
    5: [[.27, .27], [.73, .27], [.5, .5], [.27, .73], [.73, .73]], 6: [[.27, .25], [.73, .25], [.27, .5], [.73, .5], [.27, .75], [.73, .75]] }[v];
  return `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * 0.18}" fill="#fff" stroke="#333"/>` +
    P.map(([a, c]) => `<circle cx="${x + a * s}" cy="${y + c * s}" r="${s * 0.085}" fill="#222"/>`).join('');
}
function parseMove(name) {
  const out = [];
  for (let tok of (name || '').split(/\s+/)) {
    if (!tok) continue;
    let rep = 1; const m = /^(.*)\((\d)\)$/.exec(tok); if (m) { tok = m[1]; rep = +m[2]; }
    const hit = tok.includes('*'), pts = tok.replace(/\*/g, '').split('/').map((x) => x === 'bar' ? 25 : x === 'off' ? 0 : +x);
    for (let i = 0; i < rep; i++) out.push({ from: pts[0], to: pts[pts.length - 1], hit });
  }
  return out;
}
function checkerXY(p, k, mine) {
  if (p === 25) return [G.barX + G.bw / 2, G.H / 2 + (rvFlip() ? -1 : 1) * G.zh * 1.1];
  if (p === 0) return [G.trayX + 2 + (G.tw - 2) / 2, rvFlip() ? G.top + G.zh * 0.8 : G.bot - G.zh * 0.8];
  const { c, top } = pointCol(p), kk = Math.max(0, Math.min(4, k));
  return [G.colX(c) + G.pw / 2, top ? G.top + G.zh * (kk + 0.5) : G.bot - G.zh * (kk + 0.5)];
}
function arrows(before, after, name) {
  const steps = parseMove(name), usedFrom = {}, usedTo = {}, totalTo = {};
  steps.forEach((s) => { totalTo[s.to] = (totalTo[s.to] || 0) + 1; });
  const AC = rvArrowColour() || ['#e8871e', '#5a2d00'];   // the review colours the arrows by the play's cost
  let t = `<defs><marker id="ah" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${AC[0]}" stroke="${AC[1]}" stroke-width="1"/></marker></defs>`;
  for (const s of steps) {
    const nFrom = s.from === 25 ? before[25] : Math.max(0, before[s.from]);
    const kFrom = nFrom - 1 - (usedFrom[s.from] = (usedFrom[s.from] || 0) + 1) + 1;
    const nTo = s.to === 0 ? 0 : Math.max(0, after[s.to]);
    const kTo = nTo - totalTo[s.to] + (usedTo[s.to] = (usedTo[s.to] || 0) + 1) - 1;
    const [x1, y1] = checkerXY(s.from, kFrom, true), [x2, y2] = checkerXY(s.to, kTo, true);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const sx = x1 + dx / len * G.r * 0.6, sy = y1 + dy / len * G.r * 0.6, ex = x2 - dx / len * G.r * 0.95, ey = y2 - dy / len * G.r * 0.95;
    const bend = Math.min(40, len * 0.18), mx = (sx + ex) / 2 - dy / len * bend, my = (sy + ey) / 2 + dx / len * bend;
    const d = `M${sx},${sy} Q${mx},${my} ${ex},${ey}`;
    t += `<path d="${d}" fill="none" stroke="${AC[1]}" stroke-width="5" stroke-linecap="round" opacity=".55"/>`;
    t += `<path d="${d}" fill="none" stroke="${AC[0]}" stroke-width="3" stroke-linecap="round" marker-end="url(#ah)"/>`;
  }
  return t;
}
function previewMarks(before, after) {
  let t = '';
  for (let p = 1; p <= 24; p++) {
    const d = Math.max(0, after[p]) - Math.max(0, before[p]);
    const { c, top } = pointCol(p), cx = G.colX(c) + G.pw / 2;
    if (d > 0) { const n = Math.min(after[p], 5); for (let k = n - Math.min(d, n); k < n; k++) {
      const cy = top ? G.top + G.zh * (k + 0.5) : G.bot - G.zh * (k + 0.5);
      t += `<circle cx="${cx}" cy="${cy}" r="${G.r + 1.5}" fill="none" stroke="${landRing()}" stroke-width="2.5"/>`; } }
    if (d < 0) { const n = Math.min(Math.max(0, after[p]), 5); for (let k = n; k < Math.min(n - d, 5); k++) {
      const cy = top ? G.top + G.zh * (k + 0.5) : G.bot - G.zh * (k + 0.5);
      t += `<circle cx="${cx}" cy="${cy}" r="${G.r - 1}" fill="none" stroke="var(--me)" stroke-width="1.6" stroke-dasharray="3 3"/>`; } }
  }
  if (after[0] > before[0]) t += `<circle cx="${G.barX + G.bw / 2}" cy="${G.H / 2 - (rvFlip() ? -1 : 1) * G.zh * 1.1}" r="${G.r + 1.5}" fill="none" stroke="var(--bad)" stroke-width="2.5" stroke-dasharray="4 3"/>`;
  return t;
}

// ------------------------------------------------------------- entry (tap height = count, drag, edge numbers clear)
function hit(px, py) {
  if (!G) return null;
  // number strips clear a point
  const inCols = (x) => {
    if (x >= G.x0 && x < G.barX) return Math.floor((x - G.x0) / G.pw);
    if (x >= G.barX + G.bw && x < G.barX + G.bw + 6 * G.pw) return 6 + Math.floor((x - G.barX - G.bw) / G.pw);
    return -1;
  };
  if (px >= G.barX && px < G.barX + G.bw) {
    if (G.cubeBox && py >= G.cubeBox[0] - 4 && py <= G.cubeBox[1] + 4) return { kind: 'cube' };
    return { kind: 'bar', mine: (py > G.H / 2) !== rvFlip() };
  }
  const c = inCols(px); if (c < 0) return null;
  if (py < G.top) return { kind: 'clear', p: colPoint(c, true) };
  if (py > G.bot) return { kind: 'clear', p: colPoint(c, false) };
  const isTop = py < G.H / 2, p = colPoint(c, isTop);
  const dist = isTop ? py - G.top : G.bot - py;
  const zone = Math.max(1, Math.min(5, Math.floor(dist / G.zh) + 1));
  return { kind: 'point', p, zone };
}
let drag = null;
function setPoint(p, n, sign) { S.board[p] = n * sign; }
function maybeAutoSwitch(before) {
  const c = counts(S.board);
  if (S.placing === 1 && before.me < 15 && c.me === 15 && c.opp < 15) { S.placing = -1; toast('You have 15 · now placing opponent'); }
  else if (S.placing === -1 && before.opp < 15 && c.opp === 15 && c.me < 15) { S.placing = 1; toast('Opponent has 15 · now placing yours'); }
}
function onDown(ev) {
  if (S.mode !== 'setup') return;
  const R = $('board').getBoundingClientRect(), h = hit(ev.clientX - R.left, ev.clientY - R.top);
  if (!h) return;
  ev.preventDefault();
  const before = counts(S.board);
  if (h.kind === 'clear') { S.board[h.p] = 0; render(); return; }
  if (h.kind === 'cube') { openCube(); return; }
  if (h.kind === 'bar') { const i = h.mine ? 25 : 0; S.board[i] = (S.board[i] + 1) % 5; maybeAutoSwitch(before); render(); return; }
  const sign = S.placing, cur = S.board[h.p] * sign;
  let n;
  if (cur >= 5 && h.zone === 5) n = cur + 1;
  else if (cur === h.zone) n = h.zone - 1;
  else n = h.zone;
  setPoint(h.p, n, sign);
  drag = { id: ev.pointerId, p: h.p, n, zone: h.zone };
  $('board').setPointerCapture(ev.pointerId);
  maybeAutoSwitch(before); render();
}
function onMove(ev) {
  if (!drag || ev.pointerId !== drag.id) return;
  const R = $('board').getBoundingClientRect(), h = hit(ev.clientX - R.left, ev.clientY - R.top);
  if (!h || h.kind !== 'point') return;
  const before = counts(S.board);
  if (h.p === drag.p && h.zone !== drag.zone && (S.board[h.p] * S.placing) <= 5) { drag.zone = h.zone; drag.n = h.zone; setPoint(h.p, h.zone, S.placing); }
  else if (h.p !== drag.p) { drag.p = h.p; drag.zone = h.zone; if (drag.n) setPoint(h.p, drag.n, S.placing); }
  else return;
  maybeAutoSwitch(before); render();
}
function onUp(ev) { if (drag && ev.pointerId === drag.id) drag = null; }

// ------------------------------------------------------------- side panel: setup
function dieHtml(v, cls = '') {
  if (!v) return `<span class="die empty ${cls}"></span>`;
  const P = { 1: [[50, 50]], 2: [[27, 27], [73, 73]], 3: [[27, 27], [50, 50], [73, 73]], 4: [[27, 27], [73, 27], [27, 73], [73, 73]],
    5: [[27, 27], [73, 27], [50, 50], [27, 73], [73, 73]], 6: [[27, 25], [73, 25], [27, 50], [73, 50], [27, 75], [73, 75]] }[v];
  return `<span class="die ${cls}">${P.map(([x, y]) => `<i style="left:${x}%;top:${y}%"></i>`).join('')}</span>`;
}
function cubeText() {
  const c = S.cube; if (!c.owner) return 'Centred';
  return `${c.owner === 1 ? 'You own' : 'Opp owns'}`;
}
function sideSetup() {
  if (REVIEW) return rvWait();
  const c = counts(S.board), [pm, po] = pips(S.board), probs = problems();
  const gameTxt = S.game.type === 'money' ? `Money${S.game.jacoby ? ' · Jacoby' : ''}` : `${S.game.len}-pt match ${S.game.me}–${S.game.opp}${S.game.crawford ? ' C' : ''}`;
  $('side').innerHTML = `
    <div class="bar-top"><div class="title">Setup <span class="muted small">· ${gameTxt}</span></div>${fsBtn()}<button class="icon" onclick="openMenu()" aria-label="More">⋯</button></div>
    <div class="seg placing">
      <button class="${S.placing === 1 ? 'on' : ''}" onclick="S.placing=1;render()"><span class="chip me"></span>You <span class="cnt">${c.me}${c.me === 15 ? ' ✓' : '/15'}</span></button>
      <button class="${S.placing === -1 ? 'on' : ''}" onclick="S.placing=-1;render()"><span class="chip opp"></span>Opp <span class="cnt">${c.opp}${c.opp === 15 ? ' ✓' : '/15'}</span></button>
    </div>
    <div class="seg">
      ${[['checker', 'Checker play'], ['cube', 'Cube decision']].map(([k, l]) => `<button class="${S.decision === k ? 'on' : ''}" onclick="S.decision='${k}';render()">${l}</button>`).join('')}
    </div>
    <div class="row">
      ${S.decision === 'checker' ? `<div class="tile" onclick="openDice()">${dieHtml(S.dice && S.dice[0])}${dieHtml(S.dice && S.dice[1])}<span>${S.dice ? '' : 'Dice'}</span></div>`
        : `<div class="tile" style="cursor:default;white-space:normal"><span class="small">${S.cube.owner === 1 ? 'Redouble' : 'Double'} / take / pass</span></div>`}
      <div class="tile" onclick="openCube()"><span class="cube">${S.cube.owner ? S.cube.value : 64}</span><span class="small">${cubeText()}</span></div>
    </div>
    <div class="small muted" style="text-align:center;white-space:nowrap">Borne off: you ${Math.max(0, 15 - c.me)} · opp ${Math.max(0, 15 - c.opp)}</div>
    <div class="row"><button onclick="clearBtn()">${isEmpty() ? 'Starting position' : 'Clear'}</button><button onclick="swapBtn()">Swap sides</button></div>
    ${IMP ? impBanner() : `<div class="row"><button onclick="swapColour()">Swap colour</button><button onclick="swapDirection()">Swap direction</button></div>`}
    ${S.offerLast ? `<div class="row"><button id="offerLast" onclick="restoreLast()">↺ Last position analysed</button></div>` : ''}
    <div class="spacer"></div>
    ${DESKTOP ? '<div class="keys"><kbd>1</kbd>-<kbd>6</kbd> twice: dice · <kbd>C</kbd> cube decision · <kbd>Enter</kbd> analyze · <kbd>Ctrl</kbd>+<kbd>V</kbd> paste a screenshot · drop a photo on the board · results: <kbd>↑</kbd><kbd>↓</kbd> plays, <kbd>E</kbd> explain, <kbd>D</kbd> go deeper, <kbd>R</kbd> roll out, <kbd>Esc</kbd> back</div>' : ''}
    <div class="setfoot"><div class="onroll"><span class="chip me"></span> <b>${esc(meName())}</b> on roll${probs[0] || engineState !== 'ready' ? ` · <span class="warnt">${probs[0] || engineErr || 'Engine loading…'}</span>`
      : S.decision === 'cube' ? ' · cube decision' : ` · to play ${S.dice[0]}-${S.dice[1]}`}</div>
    <button class="primary go" ${probs.length || engineState !== 'ready' ? 'disabled' : ''} onclick="analyze()">Analyze</button></div>`;
}
const isEmpty = () => S.board.every((v) => v === 0);
function clearBtn() { S.board = isEmpty() ? START.slice() : new Array(26).fill(0); S.placing = 1; render(); }
function swapBtn() {
  S.board = flip(S.board);
  S.cube.owner = S.cube.owner === 1 ? 2 : S.cube.owner === 2 ? 1 : 0;
  [S.game.me, S.game.opp] = [S.game.opp, S.game.me];
  S.colorSwap = !S.colorSwap; applyLook();          // the checkers keep their colours: only the side on roll changes
  if (IMP) { IMP.roll = other(IMP.roll); IMP.homeYou = vNeighbour(IMP.homeYou); [IMP.youName, IMP.themName] = [IMP.themName, IMP.youName]; }
  saveState(); render(); toast(`${meName()} is now on roll (at the bottom)`);
}

// Display only: the position and the analysis don't change. Explanations name each side by the colour it shows.
// S.palette (from an imported photo) replaces the two colours: dark = the Blue slot, light = the White slot.
function applyLook() {
  document.body.classList.toggle('swapc', !!S.colorSwap);
  const st = document.documentElement.style, P = S.palette;
  for (const [slot, c] of [['blue', P && P.dark], ['white', P && P.light]]) {
    if (c && /^#[0-9a-f]{6}$/i.test(c.fill)) {
      const rgb = hexRgb(c.fill);
      st.setProperty(`--c-${slot}`, c.fill); st.setProperty(`--c-${slot}-edge`, edgeOf(rgb)); st.setProperty(`--c-${slot}-ink`, lumOf(rgb) > 0.6 ? '#222' : '#fff');
    } else ['', '-edge', '-ink'].forEach((x) => st.removeProperty(`--c-${slot}${x}`));
  }
}
function swapColour() { S.colorSwap = !S.colorSwap; applyLook(); saveState(); render(); toast(`You (bottom, on roll) now play ${meName()}`); }
function resetColours() { S.palette = null; applyLook(); saveState(); render(); openMenu(); toast('Checkers are Blue and White again'); }
// --- colours: names, values, the shade of the rim, the ink on a checker
const hexRgb = (h) => (/^#?[0-9a-f]{6}$/i.test(h || '') ? [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16)) : null);
const rgbHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const lumOf = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const edgeOf = (c) => rgbHex(lumOf(c) > 0.5 ? mixRgb(c, [0, 0, 0], 0.45) : mixRgb(c, [255, 255, 255], 0.32));
// Each colour word a reading may use -> the name shown and a clean shade for the screen.
const CANON = {
  white: ['White', '#fbfaf7'], pearl: ['White', '#f4f2ec'], ivory: ['Cream', '#efe5c8'], cream: ['Cream', '#efe5c8'], bone: ['Cream', '#efe5c8'],
  beige: ['Beige', '#dcc9a3'], tan: ['Tan', '#c9a578'], khaki: ['Beige', '#c8bb8a'], yellow: ['Yellow', '#e8c547'], gold: ['Gold', '#d4a72c'],
  amber: ['Orange', '#d99a2b'], orange: ['Orange', '#e07b2e'], copper: ['Orange', '#b8693a'], bronze: ['Brown', '#9c6b30'],
  red: ['Red', '#c0392b'], burgundy: ['Red', '#8b1e2a'], maroon: ['Red', '#7d1f26'], pink: ['Pink', '#e48aa8'], magenta: ['Pink', '#c2408a'],
  purple: ['Purple', '#6f42a1'], violet: ['Purple', '#7f56b5'], blue: ['Blue', '#2f5d8a'], navy: ['Blue', '#22355e'], cyan: ['Blue', '#3a8fb7'],
  teal: ['Green', '#2a7d62'], turquoise: ['Green', '#2e9580'], green: ['Green', '#2f7d4a'], olive: ['Green', '#6b6b2f'], lime: ['Green', '#7cb342'],
  brown: ['Brown', '#7a4e2a'], grey: ['Grey', '#8e8e8a'], silver: ['Grey', '#c4c6c8'], charcoal: ['Black', '#3b3b3b'], black: ['Black', '#262626'],
};
const cap1 = (w) => w.charAt(0).toUpperCase() + w.slice(1);
// The colour word in a description ("dark green" -> green, "off-white" -> white); '' if there is none.
function colourKey(t) {
  const w = (String(t || '').toLowerCase().match(/[a-z]+/g) || []).map((x) => (x === 'gray' ? 'grey' : x));
  for (let i = w.length - 1; i >= 0; i--) if (CANON[w[i]]) return w[i];
  return '';
}
// A palette with clean shades: each colour by its name; two shades of one colour become a lighter and a darker one.
function canonPalette(light, dark) {
  const L = CANON[light] || CANON.white, D = CANON[dark] || CANON.black;
  if (L[0] !== D[0]) return { light: { name: L[0], fill: L[1] }, dark: { name: D[0], fill: D[1] } };
  return { light: { name: 'Light-' + L[0].toLowerCase(), fill: rgbHex(mixRgb(hexRgb(L[1]), [255, 255, 255], 0.45)) },
    dark: { name: 'Dark-' + D[0].toLowerCase(), fill: rgbHex(mixRgb(hexRgb(D[1]), [0, 0, 0], 0.3)) } };
}
// A palette saved by v1.17 used the photo's own pixels: redo it with clean shades from its names.
function fixPalette(P) {
  if (!P || !P.dark || !P.light) return null;
  if (/^(Light|Dark)-/.test(P.light.name)) return P;
  const l = colourKey(P.light.name), d = colourKey(P.dark.name);
  return l && d ? canonPalette(l, d) : P;
}
// A plain name for a colour value, when the reading gave none.
function rgbWord(c) {
  const [r, g, b] = c.map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (l < 0.18) return 'Black';
  if (l > 0.86) return sat < 0.25 ? 'White' : 'Cream';
  if (sat < 0.15) return l > 0.7 ? 'White' : 'Grey';
  let h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360;
  if (h >= 15 && h < 70 && l > 0.68) return 'Cream';                       // light, warm: cream, beige, ivory
  if (h < 15 || h >= 345) return l < 0.3 ? 'Maroon' : 'Red';
  if (h < 45) return l < 0.45 ? 'Brown' : sat < 0.55 ? 'Tan' : 'Orange';
  if (h < 70) return l < 0.45 ? 'Brown' : 'Yellow';
  return h < 165 ? 'Green' : h < 200 ? 'Teal' : h < 255 ? 'Blue' : h < 290 ? 'Purple' : 'Pink';
}
function swapDirection() { S.mirror = !S.mirror; saveState(); render(); toast(`Your home board is now on the ${S.mirror ? 'left' : 'right'}`); }
// Colour names in the text sent to Claude follow the colours on screen (also inside data keys like blue_wins).
function landRing() {
  const ac = rvArrowColour(); if (ac) return ac[0];   // the landing rings match the arrows
  const f = S.palette && (S.colorSwap ? S.palette.light.fill : S.palette.dark.fill), c = f && hexRgb(f);
  if (!c) return 'var(--good)';
  const w = rgbWord(c); return w === 'Green' || w === 'Teal' ? '#e8871e' : 'var(--good)';
}
const darkName = () => (S.palette && S.palette.dark.name) || 'Blue', lightName = () => (S.palette && S.palette.light.name) || 'White';
const meName = () => (S.colorSwap ? lightName() : darkName()), oppName = () => (S.colorSwap ? darkName() : lightName());
function nameSwap(t) {
  const me = meName(), op = oppName();
  if (me === 'Blue' && op === 'White') return t;
  const m = { blue: me, white: op };
  return t.replace(/(?<![A-Za-z])(Blue|White|blue|white|BLUE|WHITE)(?![A-Za-z])/g, (x) => {
    const v = m[x.toLowerCase()];
    return x === x.toUpperCase() ? v.toUpperCase() : x === x.toLowerCase() ? v.toLowerCase() : v;
  });
}

// ------------------------------------------------------------- dice pad, cube picker, menu
let padFirst = null;
function openDice() { padFirst = null; renderPad(); $('ovDice').classList.add('open'); }
function renderPad() {
  $('diceTitle').textContent = padFirst ? `First die ${padFirst} · tap the second (same die again for doubles)` : 'Tap the first die';
  $('pad').innerHTML = [1, 2, 3, 4, 5, 6].map((v) => `<button class="${padFirst === v ? 'on' : ''}" onclick="padTap(${v})">${dieHtml(v)}</button>`).join('');
}
function padTap(v) { if (!padFirst) { padFirst = v; renderPad(); return; } S.dice = [Math.max(padFirst, v), Math.min(padFirst, v)]; closeOv(); saveState(); render(); }
function openCube() {
  const vals = [2, 4, 8, 16, 32, 64];
  const btn = (owner, v, label) => `<button class="${S.cube.owner === owner && (owner === 0 || S.cube.value === v) ? 'on' : ''}" onclick="S.cube={value:${v},owner:${owner}};openCube();render()">${label}</button>`;
  $('cubepick').innerHTML = `<span class="small">Centred</span>${btn(0, 1, 'Centred')}<span></span><span></span><span></span><span></span><span></span>
    <span class="small">You own</span>${vals.map((v) => btn(1, v, v)).join('')}
    <span class="small">Opp owns</span>${vals.map((v) => btn(2, v, v)).join('')}`;
  $('ovCube').classList.add('open');
}
function openMenu() {
  if (REVIEW) return rvMenu();
  const g = S.game;
  const tog = (on, js) => `<div class="seg" style="width:120px"><button class="${on ? 'on' : ''}" onclick="${js}=true;openMenu();render()">On</button><button class="${!on ? 'on' : ''}" onclick="${js}=false;openMenu();render()">Off</button></div>`;
  const step = (label, key, min, max) => `<div class="field"><span>${label}</span><span class="stepper"><button onclick="S.game.${key}=Math.max(${min},S.game.${key}-1);openMenu();render()">−</button><b style="min-width:22px;text-align:center">${g[key]}</b><button onclick="S.game.${key}=Math.min(${max},S.game.${key}+1);openMenu();render()">+</button></span></div>`;
  const P = S.palette;
  $('menu').innerHTML = `<h3>Settings</h3>
    <div class="mgrid"><section>
    <h4>Game</h4>
    <div class="seg"><button class="${g.type === 'money' ? 'on' : ''}" onclick="S.game.type='money';openMenu();render()">Money game</button><button class="${g.type === 'match' ? 'on' : ''}" onclick="S.game.type='match';openMenu();render()">Match</button></div>
    ${g.type === 'money' ? `<div class="field"><span>Jacoby rule</span>${tog(g.jacoby, 'S.game.jacoby')}</div><div class="field"><span>Beavers</span>${tog(g.beaver, 'S.game.beaver')}</div>`
      : `${step('Match length', 'len', 1, 25)}${step('Your score', 'me', 0, 24)}${step("Opponent's score", 'opp', 0, 24)}<div class="field"><span>Crawford game</span>${tog(g.crawford, 'S.game.crawford')}</div>`}
    <h4>Import a position</h4>
    <div class="row">${DESKTOP ? '' : `<button onclick="closeOv();$('impCam').click()">📷 Take a photo</button>`}<button onclick="closeOv();$('impFile').click()">${DESKTOP ? 'From a file (photo)' : '🖼 From gallery'}</button><button onclick="closeOv();importClipboard()">From clipboard</button></div>
    <div class="field"><span>Reading</span><div class="seg" style="width:220px"><button class="${S.impMode !== 'careful' ? 'on' : ''}" onclick="S.impMode='fast';saveState();openMenu()">Fast</button><button class="${S.impMode === 'careful' ? 'on' : ''}" onclick="S.impMode='careful';saveState();openMenu()">Careful (slower)</button></div></div>
    ${P ? `<h4>Checker colours</h4>
    <div class="field"><span><span class="chip" style="background:${P.dark.fill};border:1.5px solid ${edgeOf(hexRgb(P.dark.fill))}"></span> ${esc(P.dark.name)} &nbsp;<span class="chip" style="background:${P.light.fill};border:1.5px solid ${edgeOf(hexRgb(P.light.fill))}"></span> ${esc(P.light.name)} <span class="muted">(from the photo)</span></span><button onclick="resetColours()">Blue &amp; White</button></div>` : ''}
    <h4>Share</h4>
    <div class="row"><button onclick="openExport()">Export (email the results and XGID)</button></div>
    </section><section>
    <h4>Position</h4>
    <input type="text" id="xgidBox" value="${toXgid()}" onfocus="this.select()">
    <div class="row" style="margin-top:6px"><button onclick="copyX()">Copy XGID</button><button onclick="loadX()">Load XGID from box</button></div>
    <div class="row" style="margin-top:6px"><button onclick="restoreLast()">Last position analysed</button><button onclick="S.board=START.slice();S.dice=null;S.cube={value:1,owner:0};closeOv();if(S.mode!=='setup')backToSetup();render()">Starting position</button></div>
    <h4>Engine</h4>
    <div class="field"><span>Workers (cores used)</span><div class="seg" style="width:200px">${(DESKTOP ? [1, 2, 4, 6, 8, 12] : [1, 2, 4, 6]).map((n) => `<button class="${S.workers === n ? 'on' : ''}" onclick="setWorkers(${n})">${n}</button>`).join('')}</div></div>
    <div class="small muted">4 is fastest on your phone; 6 gained nothing in the speed test.</div>
    <div class="field"><span>Rollout</span><div class="seg" style="width:220px"><button class="${S.roPreset === 'quick' ? 'on' : ''}" onclick="S.roPreset='quick';saveState();openMenu()">Quick (1-ply)</button><button class="${S.roPreset === 'standard' ? 'on' : ''}" onclick="S.roPreset='standard';saveState();openMenu()">Standard (3-ply)</button></div></div>
    <div class="small muted">Quick: 1296 games at 1-ply, about 15 s a play. Standard: 360 games at 3-ply early and 2-ply late (≈ XG Roller++), about 30-45 s.</div>
    <h4>Explanations</h4>
    <div class="row"><button onclick="openRules()">Explanation rules &amp; reference positions</button></div>
    ${DESKTOP ? '' : `<h4>Screen</h4>
    ${document.fullscreenEnabled ? `<div class="row"><button data-nofs onclick="toggleFull()">${document.fullscreenElement ? 'Exit full screen' : 'Full screen'}</button></div>${fsLastErr ? `<div class="small muted">Last try was refused: ${esc(fsLastErr)}</div>` : ''}`
      : '<div class="small muted">This view doesn\'t allow full screen: the app shows the analyzer in a frame without that permission.</div>'}`}
    </section></div>
    <div class="row" style="margin-top:12px"><button class="primary" onclick="closeOv()">Done</button></div>`;
  $('ovMenu').classList.add('open');
}
async function copyX() { try { await navigator.clipboard.writeText(toXgid()); toast('XGID copied'); } catch (e) { toast('Copy blocked: select the box and copy'); } }
function loadX() { try { fromXgid($('xgidBox').value); closeOv(); saveState(); render(); toast('Position loaded'); } catch (e) { toast(e.message); } }
async function setWorkers(n) { if (n === S.workers) return; S.workers = n; S.workersSet = true; saveState(); openMenu(); if (weightsBuf) { await restartPool(); if (S.mode === 'results') backToSetup(); toast(`Engine restarted with ${n} worker${n > 1 ? 's' : ''}`); } }
function fsBtn() { return document.fullscreenElement ? `<button class="icon" onclick="toggleFull()" aria-label="Exit full screen" title="Exit full screen" style="font-size:16px;min-width:36px">⤡</button>` : ''; }
let fsLastErr = '';
async function toggleFull() {
  if (document.fullscreenElement) { fsUserExit = true; closeOv(); try { await document.exitFullscreen(); } catch (e) {} return; }
  if (!document.fullscreenEnabled) { closeOv(); toast('This view doesn\'t allow full screen: the app shows the analyzer in a frame without that permission', 5000); return; }
  fsUserExit = false;
  let p; try { p = document.documentElement.requestFullscreen(); } catch (e) { p = Promise.reject(e); }   // asked first, inside the tap
  closeOv();
  const slow = setTimeout(() => { if (!document.fullscreenElement) toast('Full screen didn\'t start: this view may not allow it', 4000); }, 2500);
  try { await p; clearTimeout(slow); toast('Full screen · tap ⤡ (top right) or swipe back to leave'); }
  catch (e) { clearTimeout(slow); fsLastErr = (e && e.message) || String(e); toast(`Full screen was refused: ${fsLastErr}`, 5000); }
}
function closeOv() { document.querySelectorAll('.ov').forEach((o) => o.classList.remove('open')); }
document.querySelectorAll('.ov').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o) closeOv(); }));
let toastT = 0;
function toast(t, ms = 1800) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), ms); }

// ------------------------------------------------------------- engine: worker pool
class Pool {
  constructor(n) { this.n = n; this.workers = []; this.idle = []; this.queue = []; this.cbs = {}; this.seq = 0; }
  async init(weights, manifest) {
    const inits = [];
    for (let i = 0; i < this.n; i++) {
      const w = RVX && RVX.worker ? RVX.worker() : new Worker('pa-worker.js');
      w.onmessage = (ev) => {
        const m = ev.data, cb = this.cbs[m.id];
        if (m.progress) { if (cb && cb.onProgress) cb.onProgress(m.progress); return; }
        delete this.cbs[m.id];
        if (!this.idle.includes(w)) this.idle.push(w);
        this.pump(); if (cb) cb.res(m);
      };
      this.workers.push(w);
      inits.push(this.direct(w, { cmd: 'init', weights: weights.slice(0), manifest }));
    }
    const rs = await Promise.all(inits);
    for (const r of rs) if (!r.ok) throw new Error(r.error);
  }
  direct(w, msg) {
    this.idle = this.idle.filter((x) => x !== w);
    return new Promise((res) => { msg.id = ++this.seq; this.cbs[msg.id] = { res }; w.postMessage(msg, msg.weights ? [msg.weights] : []); });
  }
  run(msg, onProgress) { return new Promise((res) => { this.queue.push([msg, res, onProgress]); this.pump(); }); }
  all(msg) { return Promise.all(this.workers.map((w) => this.direct(w, Object.assign({}, msg)))); }
  pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.shift(), [msg, res, onProgress] = this.queue.shift();
      msg.id = ++this.seq; this.cbs[msg.id] = { res, onProgress }; w.postMessage(msg);
    }
  }
  busy() { return this.queue.length > 0 || this.idle.length < this.workers.length; }
  terminate() { this.workers.forEach((w) => w.terminate()); this.queue.forEach(([m, res]) => res({ ok: false, error: 'cancelled' })); this.queue = []; }
}
let pool = null, weightsBuf = null, manifest = null, engineState = 'loading', engineErr = '';
async function loadEngine() {
  try {
    if (RVX && RVX.weights && RVX.manifest) { manifest = RVX.manifest; weightsBuf = RVX.weights; await startPool(); return; }   // BG Play's copy
    manifest = await (await fetch('manifest.json')).json();
    const resp = await fetch('weights-bundle.wasm'), total = manifest.total;
    const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
    if (!reader) weightsBuf = await resp.arrayBuffer();
    else {
      const u8 = new Uint8Array(total); let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; u8.set(value, got); got += value.length;
        engineErr = `Loading the engine: ${(got / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB`; if (S.mode === 'setup') sideSetup(); }
      weightsBuf = u8.buffer;
    }
    await startPool();
  } catch (e) { engineState = 'error'; engineErr = 'The engine failed to load: ' + (e.message || e); render(); }
}
// Restarts one after another (the review restarts the pool to drop a position's unfinished work when you move on).
let poolChain = Promise.resolve();
function startPool() {
  const run = poolChain.then(() => startPoolNow()); poolChain = run.catch(() => {});
  return run.then(() => { if (!RV.started) { RV.started = true; rvLoad(); } });
}
async function startPoolNow() {
  if (pool) pool.terminate();
  engineState = 'loading'; engineErr = 'Starting the engine…'; if (S.mode === 'setup') sideSetup();
  const p = new Pool(S.workers);
  await p.init(weightsBuf, manifest);
  pool = p; engineState = 'ready'; engineErr = ''; render();
}
async function restartPool() { gen++; await startPool(); }
function gameG(game, cube) {
  const g = game || S.game, c = cube || S.cube, money = g.type === 'money';
  return { cv: c.value, co: c.owner, jac: money && g.jacoby ? 1 : 0, bea: money && g.beaver ? 1 : 0,
    a1: money ? 0 : g.len - g.me, a2: money ? 0 : g.len - g.opp, cr: !money && g.crawford ? 1 : 0 };
}
async function job(msg, onProgress) { const r = await pool.run(msg, onProgress); if (!r.ok) throw new Error(r.error); return r.result; }

// ------------------------------------------------------------- the XG opening book (the BG Opening Trainer's data and rules)
// book.json and alt.json come from the trainer's page, reply-rules.json is its rules.json, t3/*.json its turn-3 files.
// Turn 1: page OJ (money, Jacoby) / ON (money without Jacoby, or a match with someone over 5-away) / O<a>-<b>[C]; plays XG
// floors at -1.000 are left out. Turn 2: the 34 reply pages, used at every score. Turn 3: Open Sage 3-ply, money with
// Jacoby, cube centred, used at every score. Only with the cube centred at 1, as in the trainer.
let BOOK = null, ALT = null, RRULES = null;
BOOK = RVX && RVX.book ? RVX.book : null;   // BG Play's opening book (open, dropped, reply); no turn-3 files
if (RVX && RVX.target === 'tile') fetch('pa/alt.json').then((r) => (r.ok ? r.json() : null)).then((d) => { ALT = d; }).catch(() => {});
if (RVX && RVX.target === 'tile') fetch('pa/reply-rules.json').then((r) => (r.ok ? r.json() : null)).then((d) => { RRULES = d; }).catch(() => {});
const T3 = new Map();
async function loadT3(file) {
  if (REVIEW) throw new Error('no turn-3 files in BG Play');
  if (!T3.has(file)) T3.set(file, fetch(`t3/${file}.json`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))).catch((e) => { T3.delete(file); throw e; }));
  return T3.get(file);
}
const encK = (n, up) => (n === 0 ? '-' : String.fromCharCode((up ? 64 : 96) + n));
function posKey(b) { let s = encK(b[0], false); for (let p = 1; p <= 24; p++) s += b[p] > 0 ? encK(b[p], true) : encK(-b[p], false); return s + encK(b[25], true); }
function keyBoard(k) {
  const v = (ch) => (ch === '-' ? 0 : ch >= 'a' ? ch.charCodeAt(0) - 96 : -(ch.charCodeAt(0) - 64));
  const b = new Array(26).fill(0);
  b[0] = Math.abs(v(k[0])); b[25] = Math.abs(v(k[25]));
  for (let p = 1; p <= 24; p++) b[p] = -v(k[p]);
  return b;
}
function bookSteps(mv) {
  const steps = [];
  for (let tok of mv.replace(/\*/g, '').trim().split(/\s+/)) {
    if (!tok) continue; let rep = 1; const m = tok.match(/^(.+)\((\d)\)$/); if (m) { tok = m[1]; rep = +m[2]; }
    const pts = tok.split('/').map((x) => (x.toLowerCase() === 'bar' ? 25 : x.toLowerCase() === 'off' ? 0 : parseInt(x, 10)));
    for (let r = 0; r < rep; r++) for (let i = 0; i + 1 < pts.length; i++) steps.push([pts[i], pts[i + 1]]);
  }
  return steps;
}
function bookApply(b, mv) {
  const a = b.slice();
  for (const [fr, to] of bookSteps(mv)) { a[fr]--; if (to) { if (a[to] === -1) { a[to] = 0; a[0]++; } a[to]++; } }
  return a;
}
let OPENER = null;   // [the opener's board after each opening play that has a reply page, that reply entry]
function openerList() {
  if (OPENER || !BOOK) return OPENER;
  OPENER = Object.entries(BOOK.reply).map(([k, entry]) => [flip(keyBoard(k)), entry]);
  return OPENER;
}
// Reply entries whose opening play fits Blue's checkers at turn 3: the same, except blots White's reply hit (now on the bar).
function t3Candidates(board) {
  const out = [];
  for (const [o, entry] of openerList() || []) {
    let hit = 0, ok = true;
    for (let p = 1; p <= 24 && ok; p++) {
      const mine = Math.max(board[p], 0), was = Math.max(o[p], 0);
      if (mine === was) continue;
      if (was === 1 && mine === 0) hit++; else ok = false;
    }
    if (ok && board[25] === hit) out.push(entry);
  }
  return out;
}
function pageText(page, game) {
  if (page === 'OJ') return 'money with Jacoby';
  if (page === 'ON') return game.type === 'match' ? 'money without Jacoby (the book’s match pages stop at 5-away)' : 'money without Jacoby';
  const m = page.match(/^O(\d)-(\d)(C?)$/);
  return m ? `opener ${m[1]}-away, opponent ${m[2]}-away${m[3] ? ', Crawford' : ''}` : '';
}
function openingPage(game) {
  if (game.type !== 'match') return game.jacoby ? 'OJ' : 'ON';
  const a = game.len - game.me, b = game.len - game.opp;
  if (Math.max(a, b) > 5) return 'ON';
  const craw = game.crawford && (a === 1 || b === 1) && !(a === 1 && b === 1);
  return `O${a}-${b}${craw ? 'C' : ''}`;
}
// The reply study's rule for a reply (turn 2), as the trainer shows it.
function replyRule(page, key, board, plays) {
  const R = RRULES && RRULES[key], v = R && R.p ? R.p[page] : undefined;
  if (v == null) return null;
  if (typeof v === 'number') return R.r[v] ? { l: R.r[v][0], t: R.r[v][1] } : null;
  const [n, head, play, m0] = v, at = posKey(bookApply(board, play)), p = plays.find((x) => posKey(bookApply(board, x.mv)) === at);
  if (p) p.rule = true;
  return { x: { n, head, play, m: p ? p.err : m0 } };
}
function withAltB(A, id, board) {
  const alt = ALT && id ? ALT[id] : null; if (!alt) return A;
  const at = (mv) => posKey(bookApply(board, mv));
  A.alt = alt; A.plays[0].models = ['xg'];
  for (const m of ['sage', 'gnu']) { if (!alt[m]) continue; const k = at(alt[m][0]), p = A.plays.find((x) => at(x.mv) === k); if (p) (p.models = p.models || []).push(m); }
  return A;
}
const rows2plays = (rows) => rows.map(([mv, e]) => ({ mv, eq: e / 10000, err: (rows[0][1] - e) / 10000 }));
// Book data for a checker play, or null. board = Blue's view, Blue on roll.
async function bookLookup(board, dice, cube, game) {
  if (!BOOK || cube.value !== 1 || cube.owner !== 0) return null;
  const key = `${Math.max(...dice)}${Math.min(...dice)}`;
  if (board.join() === START.join()) {
    if (dice[0] === dice[1]) return null;
    const page = openingPage(game);
    if ((BOOK.dropped[page] || []).includes(key)) return { kind: 'floored', turn: 1, page };
    const rows = (BOOK.open[page] || {})[key]; if (!rows) return null;
    const plays = rows2plays(rows);
    for (const p of plays) if (!BOOK.reply[posKey(flip(bookApply(board, p.mv)))]) p.tag = 'book ends after this play';
    return withAltB({ kind: 'list', turn: 1, page, plays, src: `XG Opening Book, page ${page}`, srcNote: pageText(page, game) + ', XG rollouts' }, page === 'OJ' ? `OJ_${key}` : null, board);
  }
  const entry = BOOK.reply[posKey(board)];
  if (entry) {
    const rows = entry[2][key]; if (!rows) return null;
    const A = withAltB({ kind: 'list', turn: 2, page: entry[0], plays: rows2plays(rows), src: `XG Opening Book, page ${entry[0]}`,
      srcNote: 'replies, money with Jacoby, XG rollouts' + (game.type === 'match' ? '; used at every match score' : '') }, `${entry[0]}_${key}`, board);
    A.rule = replyRule(entry[0], key, board, A.plays);
    return A;
  }
  let e3 = null, data = null, pos = null;
  for (const c of t3Candidates(board)) {
    try { const d = await loadT3(c[1]); if (d.pos[posKey(board)]) { e3 = c; data = d; pos = d.pos[posKey(board)]; break; } } catch (e) { /* file not loaded: no book */ }
  }
  if (!pos) return null;
  let ent = pos[key], level = data.level;
  if (ent && !Array.isArray(ent)) { level = ent.level; ent = ent.plays; }
  if (!ent || !ent.length) return null;
  return { kind: 'list', turn: 3, page: e3[0], plays: rows2plays(ent), level, src: level === '3ply' ? 'Open Sage 3-ply (the trainer’s stored turn 3)' : `Open Sage ${level} (the trainer’s stored turn 3)`,
    srcNote: 'money with Jacoby, cube centred' + (game.type === 'match' ? '; used at every match score' : ''),
    calib: level === '3ply' ? 'On the book’s own positions, 3-ply picks XG’s best play on about 9 rolls in 10 (misses cost up to 0.023).' : '' };
}
const sameB = (a, b) => a.every((v, i) => v === b[i]);
// Notes under the ranking, worded as in the trainer.
function bookNotes(r) {
  if (r.bookFloored) return `<p class="booknote">XG's page ${r.bookFloored} values every play of this roll at −1.000: the leader will drop the trailer's double (a free drop), so the play doesn't matter. The ranking is the engine's.</p>`;
  const A = r.book; if (!A) return '';
  let h = `<p class="booknote"><b>${esc(A.src)}</b> · ${esc(A.srcNote)}${A.turn < 3 ? '. Opening moves are never rolled out: these plays were rolled out for the book.' : ''}${A.calib ? ' ' + esc(A.calib) : ''} Plays the ${A.turn < 3 ? 'book doesn’t list' : 'trainer didn’t store'} are costed by the engine against the best${A.turn < 3 ? ' and never below the book’s worst listed play' : ''}.</p>`;
  if (A.rule) {
    if (!A.rule.x) h += `<p class="booknote rule"><b>${esc(A.rule.l)}.</b> ${esc(A.rule.t)}</p>`;
    else { const { n, head, play, m } = A.rule.x, roll = `${S.pos.dice[0]}-${S.pos.dice[1]}`;
      h += `<p class="booknote rule exc"><b>${esc(`${roll} rule ${n}${head ? `: ${head}` : ''}`)}</b>${head && head.includes(play) ? '' : ` (${esc(play)})`}. <b>This is an exception:</b> here ${A.alt ? 'XG’s book' : 'the book'} prefers ${esc(A.plays[0].mv)}${m != null ? `, by ${m.toFixed(3)}${m < 0.005 ? ' (practically a tie)' : ''}` : ''}.</p>`; }
  }
  if (A.alt) {
    const a = A.alt, shown = (m) => { const p = A.plays.find((x) => (x.models || []).includes(m)); return p ? p.mv : a[m][0]; }, parts = [`XG’s book (rollouts): ${esc(A.plays[0].mv)}`];
    if (a.sage) parts.push(`Open Sage, full rollout: ${esc(shown('sage'))}, XG’s play ${a.sage[1].toFixed(3)} lower (±${a.sage[2].toFixed(3)})`);
    if (a.gnu) parts.push(`GNU Backgammon 3-ply (BackgammonDB): ${esc(shown('gnu'))}, XG’s play ${a.gnu[1].toFixed(3)} lower`);
    if (a.sageXg) parts.push(`Open Sage’s full rollout agrees with XG (its next best ${a.sageXg[0].toFixed(3)} lower, ±${a.sageXg[1].toFixed(3)})`);
    h += `<p class="booknote models"><b>The models disagree.</b> ${parts.join('. ')}. The equities and errors above are XG’s.</p>`;
  }
  return h;
}
// Depth label for a ranked play.
const lvTxt = (p, short) => (p.lv === 6 ? (short ? 'book' : 'XG book') : p.lv === 5 ? (short ? `±${p.ro.se.toFixed(3)}` : `rollout ±${(p.ro.se || 0).toFixed(3)}`) : short ? p.lv + 'p' : p.lv + '-ply');

// ------------------------------------------------------------- analysis
let gen = 0;
const LEVELS = [{ ply: 2, keep: 16, margin: 0.20 }, { ply: 3, keep: 8, margin: 0.12 }];
async function analyze() {
  if (engineState !== 'ready') return;
  if (pool.busy()) await restartPool();
  const my = ++gen, g = gameG(), t0 = performance.now();
  S.mode = 'results'; S.sel = 0; S.explain = null; S.preview = null;
  S.pos = { board: S.board.slice(), dice: S.decision === 'checker' && S.dice ? S.dice.slice() : null, cube: { ...S.cube }, game: { ...S.game }, g };
  S.res = { kind: S.decision === 'checker' ? 'checker' : 'cube', depth: 0, t: [], plays: [], levels: {}, rollout: null };
  saveState(); saveLast(); render();
  await pool.all({ cmd: 'reset' });
  try {
    if (S.decision === 'checker') await analyzeChecker(my, g, t0); else await analyzeCube(my, g, t0);
  } catch (e) { if (my === gen) { S.res && (S.res.error = e.message); render(); } }
}
async function analyzeChecker(my, g, t0) {
  const [d1, d2] = S.dice, board = S.board.slice();
  S.res = { kind: 'checker', depth: 0, t: [], pending: 0, plays: [], rollout: null };
  const ms = await job({ cmd: 'moves', board, d1, d2, g });
  if (my !== gen) return;
  S.res.plays = ms.map((m) => ({ b: m.b, name: m.name, e1: m.e, p1: m.p }));
  const bk = await bookLookup(board, [d1, d2], S.cube, S.game).catch(() => null);
  if (my !== gen) return;
  if (bk && bk.kind === 'floored') S.res.bookFloored = bk.page;
  else if (bk) {   // tie each listed play to the engine's play with the same result; drop the book if one doesn't match
    bk.plays.forEach((x) => { const nb = bookApply(board, x.mv); x.ref = S.res.plays.find((p) => sameB(p.b, nb)); });
    if (bk.plays.every((x) => x.ref)) S.res.book = bk;
  }
  S.res.depth = 1; S.res.t[0] = performance.now() - t0; pickPreview(); render();
  if (S.res.plays.length < 2) { S.res.depth = 4; S.res.done = true; render(); return; }
  const evalAll = (cands, ply) => Promise.all(cands.map((c) => job({ cmd: 'eval', board, cand: c.b, ply, g }).then((r) => {
    if (my !== gen) return; c['e' + ply] = r.e; c['p' + ply] = r.p; render();
  })));
  let cur = S.res.plays.slice(), key = 'e1';
  for (const L of LEVELS) {
    const best = cur[0][key];
    const cands = cur.filter((c, i) => i < 2 || best - c[key] <= L.margin).slice(0, L.keep);
    rvForce(cands);   // the play made in the game is valued at every depth
    await evalAll(cands, L.ply); if (my !== gen) return;
    key = 'e' + L.ply; cur = cands.sort((a, b) => b[key] - a[key]);
    S.res.depth = L.ply; S.res.t[L.ply - 1] = performance.now() - t0; pickPreview(); render();
  }
  // Book positions stop here, as the trainer: turns 1-2 are the book's rollouts, turn 3 is the stored 3-ply list.
  if (S.res.book) { S.res.done = true; pickPreview(); render(); return; }
  // 4-ply: the best four first, then every other play that reached 3-ply.
  const first = cur.slice(0, 4), rest = cur.slice(4);
  S.res.pending = rest.length;
  await evalAll(first, 4); if (my !== gen) return;
  S.res.depth = 4; S.res.t[3] = performance.now() - t0; pickPreview(); render();
  if (rest.length) { await evalAll(rest, 4); if (my !== gen) return; }
  S.res.pending = 0; S.res.done = true; S.res.t[3] = performance.now() - t0; pickPreview(); render();
}
async function analyzeCube(my, g, t0) {
  const board = S.board.slice();
  S.res = { kind: 'cube', depth: 0, t: [], levels: {}, rollout: null };
  const got = (ply, r) => { if (my !== gen) return; S.res.levels[ply] = r; S.res.depth = Math.max(...Object.keys(S.res.levels).map(Number)); S.res.t[ply - 1] = performance.now() - t0; render(); };
  const p34 = [3, 4].map((ply) => job({ cmd: 'cube', board, ply, g }).then((r) => got(ply, r)));
  got(1, await job({ cmd: 'cube', board, ply: 1, g }));
  got(2, await job({ cmd: 'cube', board, ply: 2, g }));
  await Promise.all(p34); if (my !== gen) return;
  S.res.done = true; render();
}
// Ranking: each play at its deepest depth; errors against the leader at the play's own depth.
// The book's ranking (exactly the trainer's numbers), then the plays it doesn't list: the engine's cost against the book's
// best play at the deepest depth both have (3-ply at most), never below the book's worst listed play.
function bookRanked(r) {
  const A = r.book, worst = A.plays[A.plays.length - 1].err, best = A.plays[0];
  const deep = (p) => [3, 2, 1].find((k) => p['e' + k] != null);
  const out = A.plays.map((x) => { const p = x.ref, lv = A.turn < 3 ? 6 : 3;
    return { ...p, ref: p, lv, own: x.eq, e: x.eq, err: x.err, probs: p['p' + deep(p)] || p.p1, book: x }; });
  const listed = new Set(A.plays.map((x) => x.ref));
  const rest = r.plays.filter((p) => !listed.has(p)).map((p) => {
    const lv = [3, 2, 1].find((k) => p['e' + k] != null && best.ref['e' + k] != null);
    const cost = Math.max(worst, best.ref['e' + lv] - p['e' + lv]);
    return { ...p, ref: p, lv, own: best.eq - cost, e: best.eq - cost, err: cost, probs: p['p' + lv] || p.p1, unlisted: true };
  }).sort((a, b) => a.err - b.err);
  return out.concat(rest);
}
function ranked() {
  const r = S.res; if (!r || r.kind !== 'checker' || !r.plays.length) return [];
  if (r.book && !r.plays.some((p) => p.ro)) return bookRanked(r);
  const lvOf = (p) => (p.ro ? 5 : p.e4 != null ? 4 : p.e3 != null ? 3 : p.e2 != null ? 2 : 1);
  const val = (p, lv) => (lv === 5 ? p.ro.e : p['e' + lv]);
  const rows = r.plays.map((p) => { const lv = lvOf(p); return { ...p, ref: p, lv, own: val(p, lv), probs: lv === 5 ? p.ro.p : p['p' + lv] || p.p1 }; });
  const top = Math.max(...rows.map((x) => x.lv));
  const lead = rows.filter((x) => x.lv === top).sort((a, b) => b.own - a.own)[0];
  rows.forEach((x) => {
    let ref = val(lead.ref, x.lv);
    if (ref == null) { // the leader has no value at this depth (rollout rows): compare at the deepest shared depth
      const lv = [4, 3, 2, 1].find((k) => lead.ref['e' + k] != null && x.ref['e' + k] != null); ref = lead.ref['e' + lv]; x.err = ref - x.ref['e' + lv];
    } else x.err = ref - x.own;
    x.e = lead.own - x.err;
  });
  return rows.sort((a, b) => b.lv - a.lv || a.err - b.err);
}
function pickPreview() { if (S.rvItem && RV.follow) rvSync(); const r = ranked()[S.sel]; S.preview = r ? { after: r.b, name: r.name } : null; }
function backToSetup() { if (REVIEW) { rvReload(); return; } gen++; S.mode = 'setup'; S.preview = null; S.explain = null; if (pool && pool.busy()) restartPool(); render(); }
const eqs = (e) => (e >= 0 ? '+' : '−') + Math.abs(e).toFixed(3);
const pct = (x) => (100 * x).toFixed(1) + '%';
const fmtT = (t) => (t == null ? '' : t < 1000 ? ` · ${Math.round(t)} ms` : ` · ${(t / 1000).toFixed(1)} s`);
function statusLine() {
  const r = S.res;
  if (r.waiting) return `<div class="status"><span class="run">Starting…</span></div>`;
  if (!r.depth && !r.done && !r.error) return `<div class="status"><span class="run">Analysing…</span></div>`;   // not "No legal play" before the plays are listed
  if (r.error) return `<div class="status" style="color:var(--bad)">${r.error}</div>`;
  if (r.rollout && !r.rollout.done) return `<div class="status"><span class="run">Rolling out…</span></div>`;
  if (r.rollout && r.rollout.done) return `<div class="status"><b>✓ Rollout</b> · ${r.rollout.label}</div>`;
  if (r.kind === 'checker' && r.plays.length < 2) return `<div class="status"><b>${r.plays.length ? 'Only one legal play' : 'No legal play'}</b></div>`;
  if (r.book) return `<div class="status"><b>✓ ${r.book.turn < 3 ? 'XG opening book' : 'Stored 3-ply (as the trainer)'}</b>${r.done ? '' : ' · <span class="run">costing the other plays…</span>'}</div>`;
  if (r.done) return `<div class="status"><b>✓ 4-ply</b>${fmtT(r.t[3])}</div>`;
  if (r.depth >= 4) return `<div class="status"><b>✓ 4-ply top 4</b> · <span class="run">4-ply for the rest…</span></div>`;
  return `<div class="status"><b>✓ ${r.depth}-ply</b>${fmtT(r.t[r.depth - 1])} · <span class="run">${r.depth + 1}-ply…</span></div>`;
}
function probTable(P, when) {
  const f = (x) => (100 * x).toFixed(1);
  return `<table class="pt"><tr><th>${when}</th><th>Win</th><th>Gammon</th><th>Backgammon</th></tr>
    <tr class="me"><td><span class="chip me"></span>${rvWho(1)}</td><td>${f(P[0])}%</td><td>${f(P[1])}%</td><td>${f(P[2])}%</td></tr>
    <tr class="op"><td><span class="chip opp"></span>${rvWho(2)}</td><td>${f(1 - P[0])}%</td><td>${f(P[3])}%</td><td>${f(P[4])}%</td></tr></table>`;
}
function cubeVerdict(L, cube, game) {
  // Equities from the doubler's side, per unit of the current cube (+1 = opponent passes).
  const owned = cube.owner === 1, d = owned ? 'redouble' : 'double', D = owned ? 'Redouble' : 'Double';
  if (REVIEW && cube.owner !== 2 && game.type === 'match' && game.crawford) return { title: 'Crawford game: no doubling', rows: [['No double', L.equity_nd, true]], you: `can't double`, youCost: '', opp: '—', oppCost: '' };
  if (cube.owner === 2) return { title: `${rvWho(2)} ${rvWho(2) === 'You' ? 'own' : 'owns'} the cube`, rows: [['No double', L.equity_nd, true]], you: `can't double`, youCost: '', opp: '—', oppCost: '' };
  const nd = L.equity_nd, dp = L.equity_dp;
  const take = L.is_beaver ? L.equity_dt / 2 : L.equity_dt;      // the engine reports D/B in equity_dt when the opponent should beaver
  const beaverOK = game.type === 'money' && game.beaver;        // beavers apply to redoubles too
  const answers = [['take', take], ['pass', dp]]; if (beaverOK) answers.push(['beaver', 2 * take]);
  const resp = answers.reduce((a, b) => (b[1] < a[1] ? b : a));
  const doubled = resp[1], best = Math.max(nd, doubled);
  let title, you, youCost;
  // Cashing a game that is won anyway (no double = double/pass) is shown as Double, pass.
  if (doubled > nd + 1e-9 || (resp[0] === 'pass' && doubled >= nd - 1e-9)) { title = `${D}, ${resp[0]}`; you = D; youCost = ` (no ${d} −${(doubled - nd).toFixed(3)})`; }
  else if (nd > dp && resp[0] === 'pass') { title = `Too good to ${d}, pass`; you = 'Play on for the gammon'; youCost = ` (cashing −${(nd - doubled).toFixed(3)})`; }
  else { title = `No ${d}, ${resp[0]}`; you = `No ${d}`; youCost = ` (${d} −${(nd - doubled).toFixed(3)})`; }
  const opp = resp[0][0].toUpperCase() + resp[0].slice(1);
  const oppCost = ' (' + answers.filter((a) => a !== resp).map(([n, e]) => `${n} −${(e - doubled).toFixed(3)}`).join(', ') + ')';
  const rows = [[`No ${d}`, nd, best === nd], [`${D}, take`, take, best === doubled && resp[0] === 'take'], [`${D}, pass`, dp, best === doubled && resp[0] === 'pass']];
  if (beaverOK && resp[0] === 'beaver') rows.push([`${D}, beaver`, 2 * take, best === doubled]);
  return { title, rows, you, youCost, opp, oppCost };
}
function cubeLevel() {
  const r = S.res;
  if (r.rollout && r.rollout.done) return r.rollout.L;
  return r.levels[r.depth];
}

// ------------------------------------------------------------- rollouts (on the phone)
const RO_PRESETS = { quick: { preset: 1, n: 1296, label: '1-ply, truncated at 5 moves, 1296 games', cubeN: 1296 },
  standard: { preset: 3, n: 360, label: '3-ply/2-ply, truncated at 7 moves, 360 games (≈ XG Roller++)', cubeN: 432 } };
async function startRollout() {
  const r = S.res, my = gen, g = S.pos.g, P = RO_PRESETS[S.roPreset];
  if (pool.busy()) { await restartPool(); }
  const t0 = performance.now();
  r.rollout = { done: false, prog: {}, label: P.label };
  render();
  const tick = () => { if (my === gen) { const el = $('roProg'); if (el) { const v = Object.values(r.rollout.prog); const f = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; el.style.width = (100 * f).toFixed(1) + '%'; } } };
  try {
    if (r.kind === 'checker') {
      const list = ranked(), pick = list.slice(0, 4); const sel = list[S.sel]; if (sel && !pick.includes(sel)) pick.push(sel);
      await Promise.all(pick.map((x, i) => job({ cmd: 'rollPlay', post: x.b, preset: P.preset, n: P.n, seed: 1, g }, ([d, t]) => { r.rollout.prog[i] = d / t; tick(); })
        .then((res) => { if (my !== gen) return; x.ref.ro = res; x.ref.roPreset = P.preset; r.rollout.prog[i] = 1; tick(); })));
    } else {
      const parts = Math.min(4, S.workers), per = Math.round(P.cubeN / parts / 36) * 36 || 36;
      const out = await Promise.all(Array.from({ length: parts }, (_, i) => job({ cmd: 'rollCube', board: S.pos.board, preset: P.preset, n: per, seed: 1 + i * 7919, g }, ([d, t]) => { r.rollout.prog[i] = d / t; tick(); })));
      if (my !== gen) return;
      const mean = (k) => out.reduce((a, o) => a + o[k], 0) / out.length, se = (k) => Math.sqrt(out.reduce((a, o) => a + o[k] * o[k], 0)) / out.length;
      const nd = mean('nd'), dt = mean('dt'), probs = [0, 1, 2, 3, 4].map((i) => out.reduce((a, o) => a + o.p[i], 0) / out.length);
      const beav = S.pos.game.type === 'money' && S.pos.game.beaver && S.pos.cube.owner !== 2 && dt < 0;
      r.rollout.L = { equity_nd: nd, equity_dt: beav ? 2 * dt : dt, equity_dp: 1, is_beaver: beav, probs, nd_se: se('nd_se'), dt_se: se('dt_se') };
      r.rollout.label += ` · ±${Math.max(r.rollout.L.nd_se, r.rollout.L.dt_se).toFixed(3)}`;
    }
    if (my !== gen) return;
    r.rollout.done = true; r.rollout.secs = (performance.now() - t0) / 1000; r.rollout.label += ` · ${r.rollout.secs.toFixed(0)} s`;
    pickPreview(); render();
  } catch (e) { if (my === gen) { r.rollout = null; toast('Rollout stopped'); render(); } }
}
async function cancelRollout() { const r = S.res; r.rollout = null; if (r.kind === 'checker') r.plays.forEach((p) => delete p.ro); await restartPool(); render(); }
function rolloutBar() {
  return `<div class="row" style="align-items:center"><div style="flex:3"><div class="small muted">Rolling out on this phone…</div><div class="prog"><div id="roProg"></div></div></div><button style="flex:1" onclick="cancelRollout()">Cancel</button></div>`;
}

// ------------------------------------------------------------- results panel
function sideResults() {
  const r = S.res, title = S.rvItem && S.rvItem.dice ? rvTabs() : r.kind === 'checker' ? `To play ${S.pos.dice[0]}-${S.pos.dice[1]}` : `Cube decision`;
  if (S.rvItem && RV.follow) rvSync();
  const head = `${rvBar()}<div class="bar-top"><div class="title">${title}${statusLine()}</div>${fsBtn()}<button class="icon" onclick="openMenu()" aria-label="More">⋯</button></div>`;
  const busyRO = r.rollout && !r.rollout.done;
  if (r.kind === 'checker') {
    const list = ranked();
    const rows = list.map((p, i) => `<tr class="${i === S.sel ? 'sel' : ''} ${i === 0 ? 'first' : ''}" onclick="RV.follow=false;S.sel=${i};pickPreview();render()"${DESKTOP ? ` onmouseenter="hoverPlay(${i})"` : ''}><td class="n">${i + 1}</td><td class="mv">${p.name}${rvTag(p)}${p.book ? (p.book.models || []).map((m) => `<span class="mdl">${{ xg: 'XG', sage: 'Sage', gnu: 'GNU' }[m]}</span>`).join('') + (p.book.rule ? '<span class="mdl rl">Rule</span>' : '') + (p.book.tag ? `<small class="btag">${p.book.tag}</small>` : '') : ''}</td><td class="eq">${(r.book ? p.unlisted : p.lv < Math.max(...list.map((x) => x.lv))) ? `<i>${eqs(p.e)}</i>` : eqs(p.e)}</td><td class="err">${i ? '−' + Math.max(0, p.err).toFixed(3) : 'best'}</td><td class="d">${lvTxt(p, true)}</td></tr>`).join('');
    const sel = list[S.sel];
    $('side').innerHTML = `${head}<div class="list"><table${DESKTOP ? ' onmouseleave="hoverPlay(-1)"' : ''}>${rows}</table>${bookNotes(r)}</div>
      ${sel && sel.probs ? probTable(sel.probs, `after #${S.sel + 1}`) : ''}
      ${busyRO ? rolloutBar() : `<div class="row">${RV.canExplain ? `<button class="primary" style="flex:2;font-size:13.5px" ${list.length < 2 ? 'disabled' : ''} onclick="openExplain()">Explain #${S.sel + 1}</button>` : ''}<button style="flex:1.3" ${list.length < 2 || !r.done || (r.book && r.book.turn < 3) ? 'disabled' : ''} title="${r.book && r.book.turn < 3 ? 'Opening moves are never rolled out: the book’s plays were rolled out already' : ''}" onclick="startRollout()">${r.book && r.book.turn < 3 ? 'Book: no rollout' : r.rollout ? 'Roll out again' : 'Roll out'}</button></div>`}`;
  } else {
    const L = cubeLevel(); if (!L) { $('side').innerHTML = head + '<div class="small muted">Analysing…</div>'; return; }
    const v = cubeVerdict(L, S.pos.cube, S.pos.game);
    $('side').innerHTML = `${head}<div class="cubebox"><div class="verdict">${v.title}</div>
      <table>${v.rows.map(([n, e, best]) => `<tr><td>${best ? `<b>${n}</b>` : n}</td><td class="r">${eqs(e)}</td></tr>`).join('')}</table>
      <div class="verdict2">${rvWho(1)}: <b>${v.you}</b>${v.youCost}</div>
      <div class="verdict2">${rvWho(2)}: <b>${v.opp}</b>${v.oppCost}</div>${rvCubePlayed(L)}</div>
      ${probTable(L.probs, 'before rolling')}
      <div class="spacer"></div>
      ${busyRO ? rolloutBar() : `<div class="row">${RV.canExplain ? `<button class="primary" style="flex:2;font-size:13.5px" ${S.pos.cube.owner === 2 ? 'disabled' : ''} onclick="openExplain()">Explain</button>` : ''}<button style="flex:1.3" ${!r.done || S.pos.cube.owner === 2 ? 'disabled' : ''} onclick="startRollout()">${r.rollout ? 'Roll out again' : 'Roll out'}</button></div>`}`;
  }
}

// ------------------------------------------------------------- Explain (Claude via the page's `sample` capability)
let RULES = '', sampleFn = null, xcache = {};
if (RVX && RVX.explain) fetch('pa/rules.md').then((r) => (r.ok ? r.text() : '')).then((t) => { RULES = t; }).catch(() => {});
let METHOD = ''; if (RVX && RVX.explain) fetch('pa/project-method.md').then((r) => (r.ok ? r.text() : '')).then((t) => { METHOD = t; }).catch(() => {});
try { const CL = RVX && RVX.explain ? RVX.claude : null; if (CL && CL.use) CL.use('sample').then((f) => { sampleFn = f; }).catch(() => {}); } catch (e) {}
function md(t) {
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // rolls such as 4-3 never break across lines
  const inl = (x) => esc(x).replace(/(^|[^\d])([1-6]-[1-6])(?!\d)/g, '$1<span class="nw">$2</span>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$|[.,;:])/g, '$1<i>$2</i>');
  // Tables (GitHub style): a row of cells split by |, then a separator row of dashes, then the body rows.
  const cells = (line) => { let x = line.trim(); if (x.startsWith('|')) x = x.slice(1); if (x.endsWith('|') && !x.endsWith('\\|')) x = x.slice(0, -1); return x.split('|').map((c) => c.trim()); };
  const isSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
  const isRow = (line) => line.includes('|') && cells(line).length >= 2;
  const lines = t.split('\n');
  let out = '', inList = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      if (inList) { out += '</ul>'; inList = false; }
      const head = cells(line), right = cells(lines[i + 1]).map((c) => /-:$/.test(c));
      const num = (x) => /^[−+-]?\d*\.?\d+%?$/.test(x.replace(/\s/g, ''));
      const rows = []; let j = i + 2;
      for (; j < lines.length && isRow(lines[j]) && !isSep(lines[j]); j++) { const c = cells(lines[j]); while (c.length < head.length) c.push(''); rows.push(c.slice(0, head.length)); }
      // a column is right-aligned when the separator says so, or every filled cell in it is a number
      const numCol = head.map((_, k) => right[k] || (rows.some((r) => r[k]) && rows.every((r) => !r[k] || num(r[k]))));
      const body = rows.map((c) => '<tr>' + c.map((x, k) => `<td class="${numCol[k] ? 'num' : ''}">${inl(x)}</td>`).join('') + '</tr>').join('');
      out += `<div class="mdt"><table><thead><tr>${head.map((x, k) => `<th class="${numCol[k] ? 'num' : ''}">${inl(x)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
      i = j - 1; continue;
    }
    if (isSep(line) && /\|/.test(line)) continue;
    const m = /^\s*[-*•]\s+(.*)/.exec(line), h = /^(#{1,3})\s+(.*)/.exec(line);
    if (m) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${inl(m[1])}</li>`; continue; }
    if (inList) { out += '</ul>'; inList = false; }
    if (h) out += `<h${h[1].length}>${inl(h[2])}</h${h[1].length}>`; else if (line.trim()) out += `<p>${inl(line)}</p>`;
  }
  return out + (inList ? '</ul>' : '');
}
function openRules() {
  $('menu').innerHTML = `<div class="md">${RULES ? md(RULES) : '<p>Rules file not loaded.</p>'}</div><div class="row" style="margin-top:10px"><button class="primary" onclick="closeOv()">Close</button></div>`;
  $('ovMenu').classList.add('open');
}
function boardText(b) {
  const blue = [], white = [];
  for (let p = 24; p >= 1; p--) { if (b[p] > 0) blue.push(`${p}:${b[p]}`); if (b[p] < 0) white.push(`${p}:${-b[p]}`); }
  if (b[25]) blue.push(`bar:${b[25]}`); if (b[0]) white.push(`bar:${b[0]}`);
  const c = counts(b), [pm, po] = pips(b);
  return `Players: Blue (the user; on roll; the bottom side) and White. Points are numbered as on the board, from Blue's side: Blue moves from point 24 to point 1 and bears off from points 1-6; White moves from point 1 to point 24 and bears off from points 19-24.\nBlue's checkers (point:count): ${blue.join(' ')}; borne off ${15 - c.me}.\nWhite's checkers (point:count): ${white.join(' ')}; borne off ${15 - c.opp}.\nPip counts: Blue ${pm}, White ${po}.\n${factSheet(b)}`;
}
// Plain counts, so nobody has to count from the lists (and a checker can verify against them).
function factSheet(b) {
  const side = (sgn, name) => {
    const blots = [], made = [], home = []; let back = 0;
    for (let p = 1; p <= 24; p++) { const n = b[p] * sgn; if (n === 1) blots.push(p); if (n >= 2) { made.push(p); if (sgn > 0 ? p <= 6 : p >= 19) home.push(p); } if (n > 0 && (sgn > 0 ? p >= 19 : p <= 6)) back += n; }
    const bar = sgn > 0 ? b[25] : b[0], pl = (a) => a.length ? ` (on ${a.length > 1 ? 'points' : 'point'} ${a.join(', ')})` : '';
    return `${name} has ${blots.length} blot${blots.length === 1 ? '' : 's'}${pl(blots)}; ${made.length} made point${made.length === 1 ? '' : 's'}${pl(made)}, ${home.length} of them in ${name}'s home board; ${back} checker${back === 1 ? '' : 's'} back in the other home board; ${bar} on the bar.`;
  };
  return `Fact sheet: ${side(1, 'Blue')} ${side(-1, 'White')}${isRace(b) ? ' No contact remains (a pure race): single checkers can\'t be hit, so don\'t call them blots or count them as a risk.' : ''}`;
}
function gameText() {
  const g = S.pos.game, c = S.pos.cube;
  const cube = c.owner === 0 ? 'cube centred at 1' : `${c.owner === 1 ? 'Blue' : 'White'} owns the cube at ${c.value}`;
  return (g.type === 'money' ? `Money game, Jacoby ${g.jacoby ? 'on' : 'off'}, beavers ${g.beaver ? 'allowed' : 'not allowed'}, ${cube}.` : `${g.len}-point match, Blue ${g.me}, White ${g.opp}${g.crawford ? ', Crawford game' : ''}, ${cube}.`) + rvContext();
}
function keith(b) {
  const adj = (pts) => { let c = 0; for (const [p, n] of Object.entries(pts)) c += +p * n;
    c += 2 * Math.max(0, (pts[1] || 0) - 1) + Math.max(0, (pts[2] || 0) - 1) + Math.max(0, (pts[3] || 0) - 3);
    for (const q of [4, 5, 6]) if (!pts[q]) c += 1; return c; };
  const me = {}, op = {}; for (let p = 1; p <= 24; p++) { if (b[p] > 0) me[p] = b[p]; if (b[p] < 0) op[25 - p] = -b[p]; }
  const a = adj(me) + 25 * b[25], o = adj(op) + 25 * b[0], aRoll = a + Math.floor(a / 7);
  return { blue: a, blue_on_roll: aRoll, white: o, margin: aRoll - o };
}
function isRace(b) {
  let maxMe = 0, minOpp = 25;
  for (let p = 1; p <= 24; p++) { if (b[p] > 0) maxMe = Math.max(maxMe, p); if (b[p] < 0) minOpp = Math.min(minOpp, p); }
  if (b[25] || b[0]) return false;
  return minOpp > maxMe;
}
function explainTarget() {
  if (S.res.kind === 'checker') {
    const list = ranked(), sel = list[S.sel], best = list[0], other = sel === best ? list[1] : sel;
    const cost = best.e - other.e, changed = !best.book && other.e3 != null && best.e3 != null && other.e3 > best.e3;
    return { key: `c:${gen}:${meName()}/${oppName()}:${sel.name}`, sel, best, other, cost, changed, close: cost < 0.02 || changed,
      title: sel === best ? `Why ${best.name} is best` : `Why ${best.name} beats ${sel.name}` };
  }
  const L = cubeLevel(), v = cubeVerdict(L, S.pos.cube, S.pos.game);
  return { key: `q:${gen}:${meName()}/${oppName()}:${S.res.rollout && S.res.rollout.done ? 'ro' : S.res.depth}`, L, v, title: `Why: ${v.title}` };
}
// The plays in the explanation's table: the best play, the play compared with it, and the next play in the ranking (three at most), in ranking order.
function tablePlays(t) {
  const list = ranked(), names = [t.best.name, t.other.name];
  for (const p of list.slice(1, 3)) if (names.length < 3 && !names.includes(p.name)) names.push(p.name);
  const at = (n) => list.findIndex((p) => p.name === n);
  return names.sort((a, b) => at(a) - at(b)).map((n) => (n === t.best.name ? t.best : n === t.other.name ? t.other : list.find((p) => p.name === n)));
}
async function gatherChecker(t) {
  const g = S.pos.g, rows = tablePlays(t);
  const [facts, why] = await Promise.all([job({ cmd: 'facts', afters: rows.map((p) => p.b), before: S.pos.board, g }), job({ cmd: 'why', best: t.best.b, other: t.other.b, g })]);
  return { rows, facts, why };
}
// After the Blue rolls where White cashes: how many of White's rolls would end the game, and which miss (these never get rolled: White doubles first).
function whiteRollNote(rs) {
  const withEnd = rs.filter((r) => r.white_rolls_ending_the_game != null && r.white_rolls_ending_the_game > 0);
  if (!withEnd.length) return 'White would not bear off next turn anyway';
  const counts = [...new Set(withEnd.map((r) => r.white_rolls_ending_the_game))].sort((a, b) => a - b);
  const misses = [...new Set(withEnd.flatMap((r) => r.white_rolls_not_ending_it || []))];
  return `If White rolled, White would bear off with ${counts.join(' or ')} of 36 rolls${misses.length ? ` (missing with ${misses.join(', ')})` : ''}. White never rolls them: White doubles before rolling and Blue passes, so the game ends with the double, not with White bearing off.`;
}
async function gatherCube() {
  const g = S.pos.g, rolls = []; for (let a = 1; a <= 6; a++) for (let b = a; b <= 6; b++) rolls.push([a, b]);
  const parts = Math.min(S.workers, 4), chunks = Array.from({ length: parts }, (_, i) => rolls.filter((_, j) => j % parts === i));
  const rows = (await Promise.all(chunks.map((c) => job({ cmd: 'cubeRows', board: S.pos.board, rolls: c, g })))).flat();
  gatherCube.rows = rows;
  const [bb, bw] = await job({ cmd: 'bear', boards: [S.pos.board, flip(S.pos.board)] });
  gatherCube.bear = bb || bw ? { blue_this_turn: bb, white_next_turn: bw } : null;
  const groups = {};
  for (const r of rows) {
    const first = r.tags.split(',')[0].trim(), w = first.split(' ')[0];
    const label = r.ends_game ? 'bears off the last checker and wins' : r.white_cashes ? 'after it White doubles and Blue must pass' : { hits: 'hits', enters: 'enters, no hit', leaves: 'leaves a shot', bears: 'bears off' }[w] || first;
    const gq = groups[label] || (groups[label] = { group: label, rolls_of_36: 0, nd: 0, dt: 0, win: 0, gammon: 0, rolls: [] });
    gq.rolls_of_36 += r.w; gq.nd += r.nd * r.w; gq.dt += r.dt * r.w; gq.win += r.win * r.w; gq.gammon += r.gammon * r.w; gq.rolls.push(`${r.roll} ${r.play}`);
  }
  const market = rows.filter((r) => r.white_replies_leaving_a_pass >= 18).sort((a, b) => b.white_replies_leaving_a_pass - a.white_replies_leaving_a_pass);
  const seq = rows.reduce((a, r) => a + r.w * r.white_replies_leaving_a_pass, 0);
  const threat = rows.filter((r) => /hits|closes out|makes/.test(r.tags));
  const enders = rows.filter((r) => r.ends_game), cashes = rows.filter((r) => r.white_cashes), L0 = cubeLevel();
  const sum = (a, f) => a.reduce((x, r) => x + r.w * f(r), 0);
  const counting = sum(rows, (r) => (r.ends_game ? 1 : r.white_cashes ? 0 : r.win));
  gatherCube.extra = {
    ...(cashes.length ? { cube_access: {
      blue_wins_without_the_cube_of_36: L0 && L0.probs ? +(L0.probs[0] * 36).toFixed(2) : null,
      blue_wins_that_count_with_the_cube_of_36: +counting.toFixed(2),
      blue_rolls_after_which_white_doubles_blue_out: { rolls_of_36: sum(cashes, () => 1), rolls: cashes.map((r) => r.roll) },
      blue_rolls_after_which_white_redoubles_blue_out_if_white_took: sum(rows.filter((r) => r.white_cashes_after_take), () => 1),
      own_roll_of_white_after_blue_misses: whiteRollNote(cashes),
      note: 'Blue\'s wins that would come only after White\'s next cube turn are lost when White doubles Blue out first (cube access in the rules). If the two counts differ, that difference explains the verdict: say so first.',
    } } : {}),
    ...(enders.length ? { blue_rolls_that_end_the_game: { rolls_of_36: enders.reduce((a, r) => a + r.w, 0), rolls: enders.map((r) => r.roll),
      note: 'Blue rolls that bear off Blue\'s last checker this turn. Whether White would bear off with every roll afterwards is in cube_access (own_roll_of_white_after_blue_misses), when White can double Blue out; never assume it.' } } : {}),
    market_losers: { blue_rolls_of_36: market.reduce((a, r) => a + r.w, 0), rolls: market.map((r) => `${r.roll} ${r.play} (White passes after ${r.white_replies_leaving_a_pass} of 36 replies)`),
      sequences_of_1296: seq, note: 'a market loser here = a Blue roll after which at least 18 of White\'s 36 replies leave White a pass of a double next turn' },
    threats: { blue_rolls_of_36_that_hit_or_make_a_point: threat.reduce((a, r) => a + r.w, 0), rolls: threat.map((r) => `${r.roll} ${r.play} (${r.tags})`).slice(0, 10) },
  };
  return Object.values(groups).map((x) => ({ group: x.group, rolls_of_36: x.rolls_of_36, blue_wins_after: +(x.win / x.rolls_of_36).toFixed(3),
    blue_gammons_after: +(x.gammon / x.rolls_of_36).toFixed(3), take_share: +((x.dt - x.rolls_of_36) / 36).toFixed(3), double_share: +((x.dt - x.nd) / 36).toFixed(3),
    examples: x.rolls.slice(0, 3) })).sort((a, b) => Math.max(Math.abs(b.take_share), Math.abs(b.double_share)) - Math.max(Math.abs(a.take_share), Math.abs(a.double_share)));
}
// The book's notes for Claude: the source, the reply study's rule, where other engines disagree (as the trainer shows them).
function bookPromptText() {
  const r = S.res, A = r.book;
  if (r.bookFloored) return `\nOpening book note: XG's page ${r.bookFloored} values every play of this roll at -1.000: the leader will drop the trailer's double (a free drop), so the play doesn't matter.\n`;
  if (!A || r.plays.some((p) => p.ro)) return '';
  const tmp = document.createElement('div'); tmp.innerHTML = bookNotes(r);
  return `\n# Opening book notes (as the trainer shows them; quote the rule when it applies)\n${[...tmp.querySelectorAll('p')].map((x) => x.textContent).join('\n')}\n${A.turn < 3 ? 'This is an opening move (turn ' + A.turn + '): the ranking is the XG opening book\'s rollouts and is never rolled out again.' : 'Turn 3 of an opening line: the ranking is the trainer\'s stored Open Sage 3-ply list.'}\n`;
}
function promptChecker(t, data) {
  const list = ranked().slice(0, 8).map((p, i) => `${i + 1}. ${p.name}: ${i ? 'costs ' + Math.max(0, p.err).toFixed(3) : 'best'} (${lvTxt(p)}${p.unlisted ? ', not in the book' : ''})`).join('\n');
  const book = S.res.book && !S.res.plays.some((p) => p.ro), why = data.why, gap = why.gap_2ply;
  const costOf = (p) => (p.name === t.best.name ? 'best' : `costs ${Math.max(0, p.err).toFixed(3)}`);
  const facts = data.rows.map((p, i) => `${i + 1}. ${p.name} (${costOf(p)}): ${JSON.stringify(data.facts[i])}`).join('\n');
  const F = data.facts, any = (f) => F.some(f);
  const firm = t.cost < 0.01 ? `practically equal (cost ${t.cost.toFixed(3)}, under 0.010): say so in the first line, and that no rule of thumb separates them reliably`
    : t.cost < 0.02 ? `close (cost ${t.cost.toFixed(3)}): say so in the first line` : `clear (cost ${t.cost.toFixed(3)})`;
  const sw = [
    `The decision is ${firm}.${t.changed ? ' The order changed between depths: add that a rollout could change it.' : ''}`,
    book ? 'The ranking is the opening book\'s: say so in the first line, and quote the book\'s rule above if one is given.' : '',
    gap > 0.002 && t.cost >= 0.02 ? `Note: White's replies at 2-ply favour ${t.other.name} overall (gap_2ply ${gap}), although the ranking puts ${t.best.name} first. The deeper evaluation sees something the reply-by-reply look doesn't: say so, and don't invent a reason the data doesn't show.` : '',
    any((f) => f.white_entering) && new Set(F.map((f) => JSON.stringify(f.white_entering || null))).size > 1 ? 'The plays leave White different entering numbers: compare them like with like (rule 1a), from white_entering.' : '',
    any((f) => f.bear_off) ? 'Bear-off: compare the plays by the exact bear-off counts and quote them, with the missing rolls.' : '',
    why.groups.every((gr) => gr.group === 'no hit | no hit' || gr.group === 'White dances | White dances') ? 'White\'s replies hit nothing after either play: explain through structure (rule 1b.4).' : '',
  ].filter(Boolean).join('\n');
  return `${RULES}\n\n---\n# The position\n${gameText()}\n${boardText(S.pos.board)}\nBlue to play ${S.pos.dice[0]}-${S.pos.dice[1]}.\n\n# ${book ? `Ranking: ${S.res.book.src} (${S.res.book.srcNote}), exactly as the BG Opening Trainer shows it; plays it doesn't list are costed by the engine` : 'Engine ranking (Open Sage; error against the best play)'}\n${list}\n${bookPromptText()}\n# Focus\nThe user highlighted ${t.sel.name}. ${t.sel === t.best ? `It is the best play: explain why it beats ${t.other.name} (the runner-up, ${t.cost.toFixed(3)} behind).` : `Explain why ${t.best.name} is better (cost of ${t.sel.name}: ${t.cost.toFixed(3)}).`}

# Facts after each play for the table (computed on the phone; board numbering; "opp" means White)
${facts}
Fields: play_changes = what the play itself did (Blue's points made and given up, White checkers sent to the bar). blots, shots, shots_per_blot, hitting_rolls_per_blot = White's rolls of 36 that could hit (shots; shots_saved_by_duplication = rolls that hit two blots at once, counted once). white_best_reply = what White's best reply actually does over its 36 rolls: the rolls on which it hits (and hits two blots), the rolls on which White dances, and the hitting rolls. white_entering (only when White has checkers on the bar) = White's rolls that bring all its checkers in, leave some on the bar, or dance completely. checkers_on_1to3 = Blue checkers on points 1-3. next_roll = Blue's rolls of 36 that make a new point next turn if White stands still, by point. bear_off (when present) = exact bear-off counts after the play: blue_next_turn = Blue's rolls of 36 that bear off every remaining checker next turn (and the two-turn sequences of 1296); white_turn_first = the same for White, whose turn comes first; missing_rolls names the rolls that don't finish, or, when most rolls miss, finishing_rolls names the ones that do. no_contact (a race or bear-off after the play): pips, checkers_on_1to3 (wasted pips), gaps_on_points_4_to_6 (empty points among Blue's 4-6), checkers_left; there are no blots or shots to count.

# White's good and bad rolls after the two plays compared (rolls of 36; White's replies in the board's numbering)
After ${t.best.name}: ${JSON.stringify(why.white_rolls_after_best)}
After ${t.other.name}: ${JSON.stringify(why.white_rolls_after_other)}
(white_jokers: White's rolls that hurt Blue most; white_awkward_rolls: White's rolls that play badly for White; white_rolls_that_leave_blue_a_shot: White's rolls after which Blue has a shot. Compare them between the plays: duplication, anti-joker play, positioning for White's bad numbers.)

# Why: White's best reply to each of its 21 rolls after ${t.best.name} and after ${t.other.name}, grouped
Each group is named "what White's reply does after ${t.best.name} | after ${t.other.name}", largest share first (the reply is chosen at 1-ply and valued at 2-ply). share = the group's part of the 2-ply gap (${gap}; negative favours ${t.best.name}); favours = the play the group favours; part_of_gap = the share divided by the whole gap (1.0 = the whole gap; above 1 when other groups pull the other way). Use these to choose the decisive count; don't quote them. White's replies are written in the board's numbering (White moves upward, e.g. 1/7 = from point 1 to point 7); blue_shots_next = Blue's rolls of 36 that hit a White blot afterwards.
${JSON.stringify(why.groups)}

# Write the explanation now
Follow section 1b of the rules: the first line with the cost; the table of ${data.rows.map((p) => p.name).join(', ')} (in that order); two to four why bullets, the first one the decisive count from the largest group; the last line "At the table:".
${sw}
Call the players Blue and White (never "you", "I" or "the opponent"). Use the board's point numbers.`;
}
function hp(b, s) { const out = []; for (let p = 1; p <= 6; p++) { const q = s > 0 ? p : 25 - p; if (b[q] * s >= 2) out.push(q); } return out.length ? out.join(',') : 'none'; }
function anchorsOf(b, s) { const out = []; for (let p = 19; p <= 24; p++) { const q = s > 0 ? p : 25 - p; if (b[q] * s >= 2) out.push(q); } return out.length ? out.join(',') : 'none'; }
function primeOf(b, s) { let best = 0, run = 0; for (let p = 1; p <= 24; p++) { if (b[p] * s >= 2) { run++; best = Math.max(best, run); } else run = 0; } return best; }
// PRAT facts for one side; bb is the board from that side's view (+ = that side), pt maps its points to the board's numbering.
function pratSide(bb, pt) {
  const made = (p) => bb[p] >= 2, list = (ps) => ps.length ? `${ps.length} (on point${ps.length > 1 ? 's' : ''} ${ps.map(pt).join(', ')})` : '0';
  let rear = bb[0] > 0 ? 0 : 25; for (let p = 1; p <= 24; p++) if (bb[p] < 0) { rear = Math.min(rear, p); }
  const home = [], anchors = [], blots = [], front = []; let back = bb[25];
  for (let p = 1; p <= 24; p++) {
    if (p <= 6 && made(p)) home.push(p);
    if (p >= 19 && made(p)) anchors.push(p);
    if (p >= 19 && bb[p] > 0) back += bb[p];
    if (bb[p] === 1) blots.push(p);
  }
  // the other side moves up this side's numbering: points in the six in front of its rearmost checker (the ones that block it), and the longest run among them
  let run = 0, best = 0;
  if (rear < 25) for (let p = rear + 1; p <= Math.min(24, rear + 6); p++) { if (made(p)) { front.push(p); run++; best = Math.max(best, run); } else run = 0; }
  return { home_board_points: list(home), points_blocking_the_other_sides_rearmost_checkers: rear < 25 ? `${list(front)}, longest run ${best}` : 'none (no checkers left to block)',
    back_checkers_in_the_other_home_board_or_bar: back, anchors_in_the_other_home_board: list(anchors), number_of_blots: list(blots), checkers_on_the_bar: bb[25] };
}
// How firm the verdict is: answers at each depth, and the margins at the deepest one.
function firmness() {
  const r = S.res, keys = Object.keys(r.levels).map(Number).sort((a, b) => a - b), out = [];
  const parts = (L) => { const v = cubeVerdict(L, S.pos.cube, S.pos.game).title.split(', '); return { blue: v[0], white: v[1] || '' }; };
  for (const k of keys) out.push({ level: k + '-ply', verdict: cubeVerdict(r.levels[k], S.pos.cube, S.pos.game).title });
  if (r.rollout && r.rollout.done) out.push({ level: 'rollout', verdict: cubeVerdict(r.rollout.L, S.pos.cube, S.pos.game).title, standard_error: +Math.max(r.rollout.L.nd_se || 0, r.rollout.L.dt_se || 0).toFixed(3) });
  const L = cubeLevel(), take = L.is_beaver ? L.equity_dt / 2 : L.equity_dt, dp = L.equity_dp, nd = L.equity_nd, doubled = Math.min(take, dp);
  const deep = out.slice(-3), whiteFlip = new Set(deep.map((x) => x.verdict.split(', ')[1])).size > 1, blueFlip = new Set(deep.map((x) => x.verdict.split(', ')[0])).size > 1;
  const takeMargin = Math.abs(take - dp), doubleMargin = Math.abs(doubled - nd), CLOSE = 0.04;
  return { by_depth: out, take_or_pass_margin: +takeMargin.toFixed(3), double_or_not_margin: +doubleMargin.toFixed(3),
    take_or_pass_is_borderline: takeMargin < CLOSE || whiteFlip, double_or_not_is_borderline: doubleMargin < CLOSE || blueFlip,
    note: `Margins are in equity per unit of the cube; under ${CLOSE} is borderline, and so is an answer that changed between the deepest levels. Final answer: ${parts(L).blue}, ${parts(L).white}.` };
}
// A chance in coarse words ("about one game in four"), the way a player can say it at the table.
function coarse(f, noun = 'game', nouns = 'games') {
  const A = [[1 / 6, 'one', 'six'], [1 / 5, 'one', 'five'], [1 / 4, 'one', 'four'], [1 / 3, 'one', 'three'], [2 / 5, 'two', 'five'], [1 / 2, 'one', 'two'],
    [3 / 5, 'three', 'five'], [2 / 3, 'two', 'three'], [3 / 4, 'three', 'four'], [4 / 5, 'four', 'five'], [5 / 6, 'five', 'six']];
  if (f < 0.13) return `fewer than one ${noun} in seven`;
  if (f > 0.87) return `more than six ${nouns} in seven`;
  let b = A[0]; for (const a of A) if (Math.abs(a[0] - f) < Math.abs(b[0] - f)) b = a;
  const d = f - b[0];
  return `${Math.abs(d) < 0.015 ? 'about' : d > 0 ? 'a little more than' : 'a little less than'} ${b[1]} ${b[1] === 'one' ? noun : nouns} in ${b[2]}`;
}
// White's chances against what a take needs (money only): Janowski's take points with gammons, cube dead and fully live.
function takePoint(L) {
  if (S.pos.game.type !== 'money' || !L || !L.probs) return null;
  const P = L.probs, pw = 1 - P[0], pl = P[0];
  if (pw < 0.01 || pl < 0.01) return null;
  const W = (pw + P[3] + P[4]) / pw, Lv = (pl + P[1] + P[2]) / pl;
  const dead = (Lv - 0.5) / (W + Lv), live = (Lv - 0.5) / (W + Lv + 0.5);
  return {
    white_wins: coarse(pw), white_wins_value: +pw.toFixed(3),
    gammons_among_white_losses: coarse(P[1] / pl, 'White loss', 'White losses'), gammons_among_white_wins: coarse(P[3] / pw, 'White win', 'White wins'),
    white_needs_with_the_cube_dead: coarse(dead), white_needs_with_the_cube_dead_value: +dead.toFixed(3),
    white_needs_with_full_use_of_the_cube: coarse(live), white_needs_with_full_use_of_the_cube_value: +live.toFixed(3),
    note: 'Cubeless chances before Blue rolls. Janowski: the taker needs (L-0.5)/(W+L) with the cube dead and (L-0.5)/(W+L+0.5) with full use of it (W, L = White\'s average win and loss in points). Real positions sit between the two: nearer the full-use figure in long, fluid games; at the dead figure in last-roll positions. Write these in the words given (the _value fields are only for checking), and let the engine\'s verdict decide near the line.',
  };
}
function promptCube(t, groups) {
  const L = t.L, b = S.pos.board, [pm, po] = pips(b), k = keith(b), race = isRace(b), lead = ((po - pm) / pm * 100).toFixed(1);
  const d = S.pos.cube.owner === 1 ? 'redouble' : 'double', f = firmness(), short = race && pm + po < 30;
  const blue = pratSide(b, (p) => p), white = pratSide(flip(b), (p) => 25 - p);
  const rows = gatherCube.rows || [], leave = rows.filter((r) => r.white_shots > 0), avgShots = rows.reduce((a, r) => a + r.w * r.white_shots, 0) / 36;
  const close = f.take_or_pass_is_borderline || f.double_or_not_is_borderline;
  const tp = short ? null : takePoint(L), access = gatherCube.extra && gatherCube.extra.cube_access;   // short races: count rolls instead
  const sw = [
    access ? '- Cube access comes first: after some of Blue\'s rolls White doubles Blue out (cube_access in the data); explain the verdict through it.' : '',
    gatherCube.bear ? '- Bear-off: start from the exact counts, with the missing rolls.' : '',
    race ? (short ? '- Short race (under 30 pips in total): count rolls (last roll, near-last roll, cube access); don\'t cite Keith, 8-9-12 or the 10% rule.' : '- Race: the Keith count and the 8-9-12 rule, from the data above; White\'s chances against the take point if it helps.')
      : `- Contact: ${tp ? 'White\'s chances against what a take needs, in the coarse words of the take-point data; then ' : ''}one PRAT bullet (Position, Race and Threats, each with its fact, and "Blue leads in N of 3"); then market losers and gammons when they matter.${tp ? '' : ' Match play: the take point depends on the score, so skip the money take-point comparison.'}`,
    close ? '- Borderline: give the case for each answer (1c.3) instead of arguing for one.' : '',
  ].filter(Boolean).join('\n');
  const raceTxt = race ? `Pure race.${short ? ' Under 30 pips in total: count rolls; Keith, 8-9-12 and the 10% rule don\'t apply.' : ` Keith counts: Blue ${k.blue} (+1/7 for being on roll = ${k.blue_on_roll}), White ${k.white}; Blue's count is ${Math.abs(k.margin)} ${k.margin >= 0 ? 'above' : 'below'} White's (Blue's higher count = Blue behind).`}` : 'Contact remains: no race formulas (Keith, 8-9-12) — use PRAT.';
  return `${RULES}\n\n---\n# The position\n${gameText()}\n${boardText(b)}\nBlue is on roll and deciding whether to ${d}; White decides whether to take.\n\n# Engine cube verdict (Open Sage ${S.res.rollout && S.res.rollout.done ? 'rollout' : S.res.depth + '-ply'}; per unit of the current cube, from Blue's side)\nNo ${d} ${L.equity_nd.toFixed(3)}; ${d}/take ${(L.is_beaver ? L.equity_dt / 2 : L.equity_dt).toFixed(3)}; ${d}/pass ${L.equity_dp.toFixed(3)}${L.is_beaver ? `; ${d}/beaver ${L.equity_dt.toFixed(3)}` : ''}.\nVerdict: ${t.v.title}. Blue: ${t.v.you}${t.v.youCost}. White: ${t.v.opp}${t.v.oppCost}.\n\n# How firm the verdict is\n${JSON.stringify(f)}\n${close ? `BORDERLINE (${[f.double_or_not_is_borderline ? 'double or not' : '', f.take_or_pass_is_borderline ? 'take or pass' : ''].filter(Boolean).join('; ')}): follow 1c.3 (Borderline) in the rules.` : 'Clear-cut: explain the engine\'s answer.'}\n\n# Race\nPip counts: Blue ${pm}, White ${po}; Blue ${pm <= po ? 'leads' : 'trails'} by ${Math.abs(po - pm)} pips, ${Math.abs(lead)}% of Blue's count. ${raceTxt}\n${tp ? `\n# Take point (money; White's chances against what a take needs; write them in these words, never as percentages)\n${JSON.stringify(tp)}\n` : ''}${race ? '' : `\n# PRAT facts (computed on the phone; board numbering)\nPosition, Blue: ${JSON.stringify(blue)}\nPosition, White: ${JSON.stringify(white)}\nRace: Blue ${pm}, White ${po} (see above).\nThreats, Blue: ${(gatherCube.extra && gatherCube.extra.threats ? gatherCube.extra.threats.blue_rolls_of_36_that_hit_or_make_a_point : 0)} of Blue's 36 rolls hit or make a point next turn (list under Threats and market).\nThreats, White: after Blue's best play, ${leave.reduce((a, r) => a + r.w, 0)} of Blue's 36 rolls leave White a shot; White's hitting rolls average ${avgShots.toFixed(1)} of 36 across all Blue rolls.\n`}${gatherCube.bear ? `\n# Bear-off counts (exact, computed on the phone; quote these numbers, don't estimate)\n${JSON.stringify(gatherCube.bear)}\n(bears_off_this_turn_of_36: rolls that bear off every remaining checker this turn; missing_rolls: the rolls that don't (when most rolls miss, finishing_rolls lists the rolls that do and misses_with_rolls_of_36 counts the others); bears_off_within_two_turns_of_1296: sequences of two rolls, playing the first roll to give the best chance with the second. White's counts are for White's next turn, which comes after Blue's roll.)\n` : ''}\n# Threats and market (counts of rolls, never percentages)\n${JSON.stringify(gatherCube.extra)}\n\n# Blue's 21 rolls, grouped by what Blue's best play does (2-ply cube evaluations of White's position afterwards)\ntake_share > 0: White's take loses on those rolls; double_share > 0: doubling gains for Blue on those rolls. blue_wins_after / blue_gammons_after: Blue's chances after that group of rolls.\n${JSON.stringify(groups)}\n\n# Write the explanation now\nFollow section 1c of the rules: the first line with the engine's verdict exactly as given (${t.v.title})${close ? ', marked as close' : ''}, with what the wrong actions cost; then two to four bullets, in the order of 1c.2; the last line "At the table:".\n${sw}\nCall the players Blue and White (never "you", "I" or "the opponent"). Market losers and threats are numbers of rolls (for example "9 of Blue's 36 rolls"), game chances coarse words; never percentages. Use only counts that appear in the data; never say "every roll" or "all" unless the data gives 36 of 36.`;
}
async function openExplain() {
  const t = explainTarget();
  const hit = xcache[t.key];
  S.explain = { t, text: hit ? hit.text : '', by: hit ? hit.by : '', check: hit ? hit.check : null, prompt: hit ? hit.prompt : '', deep: hit ? hit.deep : [], state: hit ? 'done' : 'run', step: 'Gathering the facts on the phone…', err: '' };
  render();
  if (xcache[t.key]) return;
  const mine = S.explain;
  if (!sampleFn) { mine.state = 'err'; mine.err = 'Claude is not available to this page here. Open the analyzer inside the Claude app, signed in, and allow it to ask Claude.'; render(); return; }
  let waitT = 0, stopT = 0;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  mine.abort = () => { try { ctrl && ctrl.abort(); } catch (e) {} };
  try {
    const prompt = nameSwap(S.res.kind === 'checker' ? promptChecker(t, await gatherChecker(t)) : promptCube(t, await gatherCube()));
    if (S.explain !== mine) return;
    mine.prompt = prompt; mine.step = 'Claude is writing… (uses your Claude usage)'; render();
    // Claude's permission prompt is drawn by the app, outside this page: in full screen it can't be seen.
    // So leave full screen until the first explanation has worked once on this phone.
    let ok = false; try { ok = localStorage.getItem('bgpa-sample-ok') === '1'; } catch (e) {}
    if (!ok && document.fullscreenElement) { fsUserExit = true; try { await document.exitFullscreen(); } catch (e) {} setTimeout(() => { fsUserExit = false; }, 30000); }
    waitT = setTimeout(() => { if (S.explain === mine && !mine.text) { mine.slow = true; render(); } }, 20000);
    stopT = setTimeout(() => { if (!mine.text) mine.abort(); }, 120000);
    const opts = { ...QUICK_MODEL, onText: ({ text }) => { if (S.explain === mine) { mine.text = text; if (mine.slow) { mine.slow = false; render(); } updateExplainText(); } } };
    if (ctrl) opts.signal = ctrl.signal;
    const r = await sampleFn(prompt, opts);
    mine.text = r.text || mine.text; mine.by = whoAnswered(r, QUICK_MODEL);
    try { localStorage.setItem('bgpa-sample-ok', '1'); } catch (e) {}
    // Quality control: a second pass checks every claim in the draft against the same data, and fixes what's wrong.
    if (S.explain !== mine) return;
    mine.checking = true; mine.step = 'Checking every fact against the engine data…'; render();
    clearTimeout(stopT); stopT = setTimeout(() => mine.abort(), 120000);
    let check;
    try {
      const v = await sampleFn(verifyPrompt(prompt, mine.text), ctrl ? { ...QUICK_MODEL, signal: ctrl.signal } : { ...QUICK_MODEL });
      check = parseCheck(v.text); check.by = whoAnswered(v, QUICK_MODEL);
    } catch (e) { if (S.explain !== mine) return; check = { failed: true }; }
    if (S.explain !== mine) return;
    if (!check.failed) mine.text = check.text;
    mine.check = check; mine.checking = false; mine.state = 'done'; xcache[t.key] = { text: mine.text, check, prompt, deep: mine.deep, by: mine.by };
  } catch (e) {
    mine.state = 'err';
    mine.err = e && e.code === 'rate_limited' ? 'Claude is busy; try again in a minute.'
      : e && e.code === 'not_granted' ? 'Permission to ask Claude was not given. Explain needs it; it is asked again on the next try.'
      : e && (e.name === 'AbortError' || e.code === 'aborted') ? 'No reply from Claude after two minutes. Try again.'
      : 'Explain failed: ' + ((e && e.message) || String(e));
  }
  clearTimeout(waitT); clearTimeout(stopT);
  if (S.explain === mine) render();
}
function verifyPrompt(prompt, draft, o = {}) {
  const cube = S.res && S.res.kind !== 'checker';
  const format = o.deeper ? 'the format in item 6'
    : cube ? 'the first line with the verdict; two to four bullets in the order of rule 1c.2 (cube access first when the data has it; the exact bear-off counts when they are given; with contact, White\'s chances against the take point and a PRAT bullet)'
    : 'the first line with the cost; one table of the plays in the facts, best first; two to four why bullets, the first one the decisive count from the largest Why group';
  return `${prompt}

=====
# Your task now: check the draft below before the player sees it
The draft explanation was written from the data above. The board, the fact sheet and the engine data above are the only source of truth; the rules above say how it must be written. Check the draft line by line:
1. Every number: blots, made points, checkers, pips, borne-off counts, rolls of 36 and which rolls they are, sequences of 1296, costs and margins. Recount from the board and the fact sheet. A number that isn't in the data and can't be counted from the board is an error.${cube ? '' : ' Check every table cell against the facts for that play.'}
2. Every named point, play and roll matches the data, in the board's numbering (or White's own numbering where the draft says so).
3. Every claim about who leads, who is the favourite, what White's reply does, or what happens after a roll is supported by the data. Shots are not hits: a count of rolls on which White hits must come from white_best_reply or the Why groups, a count of shots from shots. "Every roll", "all" and "always" need 36 of 36 in the data. Entering rolls are compared like with like (all in, some on the bar, dancing completely).
4. The verdict: ${cube ? 'the first line gives the engine\'s verdict exactly. If the data marks the decision borderline, the draft says it\'s close and gives the case for each answer.' : 'the first line names the best play and the cost from the ranking. Under 0.010 it says the plays are practically equal; if the order changed between depths, it says a rollout could change it.'} A recurring theme named in the draft must fit the data.
5. The writing rules: Blue and White (never "you", "I", "the opponent"); rolls as counts and game chances in coarse words, never percentages or decimals; ${format}; about ${o.words || 180} words${cube || o.deeper ? '' : ' plus the table'}; the last line starts "At the table:".${o.deeper ? `
6. This is the deeper, project-style answer${o.q ? ` to the player's question "${o.q}"` : ''}. It follows "The project's analysis method" above (first line with the costs, one table of the top plays with costs and over-the-board facts, why bullets from the 3-ply Why section; for cube decisions the take point and the Cube section's groups), and it answers the question directly. Its numbers may come from the data, the deep pass and the tool results above; a number from none of them is an error. Check every cell of the table.` : ''}

Fix each error with the smallest change and leave correct parts as they are; delete a claim the data can't support. Return only JSON, with no other text:
{"errors":[{"claim":"the wrong statement, quoted","why":"what the data says","fix":"the corrected statement"}],"text":"the full corrected explanation in the same markdown format (the draft unchanged if there are no errors)"}

# Draft
${draft}`;
}
function parseCheck(raw) {
  try {
    const t = String(raw || ''), i = t.indexOf('{'), j = t.lastIndexOf('}');
    const o = JSON.parse(t.slice(i, j + 1));
    if (typeof o.text !== 'string' || !o.text.trim() || !Array.isArray(o.errors)) throw new Error('shape');
    return { text: o.text, errors: o.errors.filter((e) => e && e.claim) };
  } catch (e) { return { failed: true }; }
}
function checkFoot(c, retry = 'retryExplain()') {
  if (!c) return '';
  if (c.failed) return `<div class="xfoot close">Not fact-checked: the check didn't return a result. <button style="min-height:28px;margin-left:4px" onclick="${retry}">Try again</button></div>`;
  if (!c.errors.length) return '<div class="xfoot ok">✓ Fact-checked against the engine data: no errors found.</div>';
  return `<details class="xfoot ok"><summary>✓ Fact-checked: ${c.errors.length} correction${c.errors.length > 1 ? 's' : ''} made (tap to see)</summary><ul>${c.errors.map((e) => `<li><s>${esc(e.claim)}</s> → ${esc(e.fix || '')} <span class="muted">(${esc(e.why || '')})</span></li>`).join('')}</ul></details>`;
}
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// ------------------------------------------------------------- deeper analysis (on request, with the player's question)
// Same rules and data as the quick explanation, plus the quick answer and the question; the stronger model; page tools
// so Claude can get exact engine numbers the quick pass didn't have; then the same fact-check, with the tool results.
const normPlay = (x) => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
function findPlay(name) {
  const list = ranked(), n = normPlay(name);
  const p = list.find((x) => normPlay(x.name) === n) || list.find((x) => normPlay(x.name).replace(/\*/g, '') === n.replace(/\*/g, ''));
  if (!p) throw new Error(`No play "${name}" in the ranking. Plays: ${list.slice(0, 12).map((x) => x.name).join('; ')}`);
  return p;
}
// Deeper analysis: the model the user analyses with in the project (Opus 5.5, high effort), named explicitly, for the
// answer and for its fact-check. If it can't answer here, the platform falls back to the most capable tier and says so.
const DEEP_MODEL = { model: 'claude-opus-5-5', effort: 'high', modelTier: 'complex' };
const QUICK_MODEL = { modelTier: 'default' };
function whoAnswered(r, asked) {
  if (!r) return '';
  if (asked.model && r.modelApplied === asked.model) return `Opus 5.5, effort ${asked.effort}`;
  const tier = { complex: 'the most capable tier', default: 'the everyday tier', quick: 'the quick tier' }[r.modelTierApplied] || r.modelTierApplied || 'the platform\'s choice';
  return asked.model ? `${tier} (Opus 5.5 wasn't available)` : tier;
}
function deepTools(log) {
  const g = S.pos.g, out = (name, input, r) => { const t = nameSwap(JSON.stringify(r)); log.push(`${name} ${JSON.stringify(input)} -> ${t}`); return t.length > 6000 ? t.slice(0, 6000) + '…' : t; };
  let calls = 0;
  const T = (name, description, props, run) => ({ name, description, inputSchema: { type: 'object', properties: props, required: Object.keys(props) },
    execute: async (input) => { if (++calls > 10) throw new Error('Tool budget used (10 calls): write the answer now.'); return out(name, input, await run(input || {})); } });
  const tools = [];
  const evalX = T('evaluate_xgid', 'Analyse a different position given as an XGID (to test a what-if: a checker moved, a different roll, a different cube). With dice in the XGID: the best plays at 2-ply. Without dice: the cube decision at 2-ply. The side on roll in the XGID is the one deciding.',
    { xgid: { type: 'string', description: 'XGID=... ; the board part in the standard 26-character form' } },
    async ({ xgid }) => {
      const x = parseXgid(xgid), gx = gameG(x.game, x.cube);
      if (x.dice) {
        const ms = await job({ cmd: 'moves', board: x.board, d1: x.dice[0], d2: x.dice[1], g: gx });
        if (!ms.length) return { plays: [], note: 'no legal play' };
        const top = ms.slice(0, 8), ev = await Promise.all(top.map((m) => job({ cmd: 'eval', board: x.board, cand: m.b, ply: 2, g: gx })));
        const rows = top.map((m, i) => ({ play: m.name, equity_2ply: +ev[i].e.toFixed(3), win: +(ev[i].p[0] * 100).toFixed(1) })).sort((a, b) => b.equity_2ply - a.equity_2ply);
        return { dice: x.dice.join('-'), pips: pips(x.board), plays: rows.map((r) => ({ ...r, error: +(rows[0].equity_2ply - r.equity_2ply).toFixed(3) })) };
      }
      const c = await job({ cmd: 'cube', board: x.board, ply: 2, g: gx }), v = cubeVerdict(c, x.cube, x.game);
      return { verdict: v.title, no_double: +c.equity_nd.toFixed(3), double_take: +(c.is_beaver ? c.equity_dt / 2 : c.equity_dt).toFixed(3), double_pass: +c.equity_dp.toFixed(3), blue_wins_pct: +(c.probs[0] * 100).toFixed(1), pips: pips(x.board) };
    });
  if (S.res.kind === 'checker') {
    tools.push(T('ranking', 'The engine ranking of the plays for this roll: name, equity, error against the best, analysis depth.', {}, async () =>
      ranked().slice(0, 15).map((p) => ({ play: p.name, equity: +p.e.toFixed(3), error: +p.err.toFixed(3), depth: lvTxt(p) }))));
    tools.push(T('play_facts', 'Facts about the position after one play from the ranking: blots and White\'s shots at them (rolls of 36), made points, primes, anchors, pips, Blue\'s point-making rolls next turn, exact bear-off counts.',
      { play: { type: 'string', description: 'the play exactly as named in the ranking' } }, async ({ play }) => {
        const p = findPlay(play); const [f] = await job({ cmd: 'facts', afters: [p.b], g }); return { play: p.name, ...f }; }));
    tools.push(T('compare_plays', 'White\'s 21 replies after each of two plays, valued at 2-ply and grouped by what White does (hits, enters, makes a point...), with White\'s joker and awkward rolls after each: the over-the-board reason one play beats the other.',
      { better: { type: 'string', description: 'play name' }, worse: { type: 'string', description: 'play name' } }, async ({ better, worse }) => {
        const a = findPlay(better), b = findPlay(worse); return { better: a.name, worse: b.name, ...(await job({ cmd: 'why', best: a.b, other: b.b, g })) }; }));
  } else {
    tools.push(T('blue_roll', 'For one of Blue\'s 21 rolls in this cube decision: Blue\'s best play, what it does, White\'s cube action afterwards (2-ply), White\'s replies that would leave a pass, bear-off details.',
      { roll: { type: 'string', description: 'for example 6-5 or 3-3' } }, async ({ roll }) => {
        const m = String(roll).match(/([1-6])\D*([1-6])/); if (!m) throw new Error('roll like 6-5');
        const k = `${Math.max(+m[1], +m[2])}-${Math.min(+m[1], +m[2])}`, r = (gatherCube.rows || []).find((x) => x.roll === k);
        if (!r) throw new Error('roll not found'); return r; }));
  }
  tools.push(evalX);
  return tools;
}
// The project's deep pass, on the phone (START-HERE "How a position answer runs", step 4, and "Close plays"):
// checker plays: a truncated3 rollout of the best play, the play in question and every play within 0.08, then the
// Why section at 3-ply between the best and the play in question; cube decisions: the 4-ply verdict (or the rollout).
const ALLROLLS = (() => { const r = []; for (let a = 1; a <= 6; a++) for (let b = a; b <= 6; b++) r.push([a, b]); return r; })();
function isOpening(b) {
  const mine = b.map((v, i) => (i && i < 25 && v > 0 ? v : 0)), start = START.map((v, i) => (i && i < 25 && v > 0 ? v : 0));
  if (b[0] || b[25] || mine.join() !== start.join()) return false;
  return pips(b)[1] >= 167 - 24;            // Blue still on the starting position, White at most one roll in: turn 1 or 2
}
async function deepEnginePass(x, step) {
  const r = S.res, g = S.pos.g;
  if (r.kind !== 'checker') {
    const ro = r.rollout && r.rollout.done;
    return `# Deep pass (the project's deep pass for a cube decision, on the phone)\nThe cube verdict above is Open Sage's ${ro ? 'rollout' : '4-ply'} evaluation, the same depth as the project's deep pass; the Cube section (Blue's 21 rolls grouped, with market losers) is in the data above.`;
  }
  const P = RO_PRESETS.standard, before = ranked(), t0 = performance.now();
  const errBefore = Object.fromEntries(before.map((p) => [p.name, p.err]));
  const opening = r.book ? r.book.turn < 3 : isOpening(S.pos.board);
  let roLine;
  if (opening || before.length < 2) roLine = opening ? (r.book ? `Opening move (turn ${r.book.turn}): ranked from the ${r.book.src} (${r.book.srcNote}), never rolled out, as the project does; plays the book doesn't list are costed by the engine against the book's best play and never below its worst listed play.` : 'Opening move (turn 1 or 2) the book has no page for: not rolled out; the ranking is the engine\'s.') : 'Only one legal play.';
  else {
    const names = new Set([before[0].name, x.t.sel.name, x.t.other.name, ...before.filter((p) => before[0].e - p.e <= 0.08).map((p) => p.name)]);
    const pick = before.filter((p) => names.has(p.name)).slice(0, 8), need = pick.filter((p) => !(p.ref.ro && p.ref.roPreset === 3));
    const prog = {}, show = () => { const v = Object.values(prog), f = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 1; step(`Deep pass: rolling out ${pick.length} plays at truncated3 (as the project does)… ${Math.round(100 * f)}%`); };
    need.forEach((_, i) => { prog[i] = 0; }); show();
    await Promise.all(need.map((p, i) => job({ cmd: 'rollPlay', post: p.b, preset: P.preset, n: P.n, seed: 1, g }, ([d, t]) => { prog[i] = d / t; show(); })
      .then((res) => { p.ref.ro = res; p.ref.roPreset = 3; prog[i] = 1; })));
    // close.py's second round: a play left out that now lands within 0.08 of the rolled-out best is added (12 plays at most).
    const mid = ranked(), top = mid[0], more = mid.filter((p) => p.lv !== 5 && top.e - p.e <= 0.08).slice(0, Math.max(0, 12 - pick.length));
    if (more.length) {
      const prog2 = {}; more.forEach((_, i) => { prog2[i] = 0; });
      const show2 = () => { const v = Object.values(prog2); step(`Deep pass: second round, rolling out ${more.length} more play${more.length > 1 ? 's' : ''}… ${Math.round(100 * v.reduce((a, b) => a + b, 0) / v.length)}%`); };
      show2();
      await Promise.all(more.map((p, i) => job({ cmd: 'rollPlay', post: p.b, preset: P.preset, n: P.n, seed: 1, g }, ([d, t]) => { prog2[i] = d / t; show2(); })
        .then((res) => { p.ref.ro = res; p.ref.roPreset = 3; prog2[i] = 1; })));
      pick.push(...more);
    }
    roLine = `Close-plays rollout at truncated3 (3-ply early, 2-ply late, truncated at 7 moves, 360 games per play): ${pick.length} plays (${pick.map((p) => p.name).join('; ')})${more.length ? ', in two rounds' : ''}, ${((performance.now() - t0) / 1000).toFixed(0)} s.`;
  }
  const after = ranked(), best = after[0];
  const cmp = x.t.sel.name !== best.name ? after.find((p) => p.name === x.t.sel.name) : after[1];
  const lines = after.slice(0, 8).map((p, i) => `${i + 1}. ${p.name} | equity ${p.e.toFixed(3)} | cost ${p.err.toFixed(3)} | ${lvTxt(p)}${p.unlisted ? ' (not in the book)' : ''}`);
  const changes = after.filter((p) => p.lv === 5 && errBefore[p.name] != null && Math.abs(errBefore[p.name] - p.err) >= 0.005).map((p) => `${p.name}: cost ${errBefore[p.name].toFixed(3)} ${before[0].book ? 'in the stored 3-ply list' : 'at 4-ply'} -> ${p.err.toFixed(3)} rolled out`);
  if (before[0].name !== best.name) changes.unshift(`the best play changed from ${before[0].name} to ${best.name}`);
  if (opening) changes.length = 0;
  const ties = after.filter((p) => p !== best && p.lv === 5 && p.err < 0.01).map((p) => p.name);
  let why = null, facts = [];
  if (cmp) {
    step(`Deep pass: White's 21 replies after ${best.name} and ${cmp.name} at 3-ply…`);
    const parts = Math.max(1, Math.min(S.workers, 4)), chunks = Array.from({ length: parts }, (_, i) => ALLROLLS.filter((_, j) => j % parts === i));
    const rowsFor = async (p) => Object.assign({}, ...(await Promise.all(chunks.map((c) => job({ cmd: 'replyRows', after: p.b, g, ply: 3, rolls: c })))));
    const [A, B] = await Promise.all([rowsFor(best), rowsFor(cmp)]);
    why = await job({ cmd: 'whyGroup', A, B, ply: 3 });
  }
  step('Deep pass: facts for the top plays…');
  facts = await job({ cmd: 'facts', afters: after.slice(0, 5).map((p) => p.b), before: S.pos.board, g });
  return `# Deep pass (the project's deep pass for a checker play, computed on the phone with the same engine)
${roLine}
Ranking (cost = equity behind the best; rolled-out plays are compared with rolled-out plays):
${lines.join('\n')}
${opening ? '' : `Changes from the ${before[0].book ? 'stored 3-ply' : '4-ply'} ranking: ${changes.length ? changes.join('; ') : 'none of the costs moved by 0.005 or more'}.`}${bookPromptText()}${ties.length ? `\nWithin 0.01 of the best after the rollout: ${ties.join('; ')} (too close to separate at truncated3; a full rollout could).` : ''}
${why ? `\n# Why section at 3-ply: ${best.name} (best) against ${cmp.name}
White's best reply to each of its 21 rolls after each play (chosen at 1-ply, valued at 3-ply), grouped by what it does after ${best.name} | after ${cmp.name}; 'share' adds up to the 3-ply gap (${why.gap_3ply}); negative favours ${best.name}; favours = the play the group favours; part_of_gap = the share divided by the whole gap (above 1 when other groups pull the other way). White's replies use the board's numbering.
${JSON.stringify(why)}` : ''}
\n# Facts after each of the top plays (play_changes: points made and given up, White checkers hit; blots and White's shots at them in rolls of 36; white_best_reply: the rolls on which White's best reply actually hits, hits two, or dances; white_entering when White is on the bar; points, primes, anchors, pips, next-roll point making, bear-off counts)
${after.slice(0, 5).map((p, i) => `${p.name}: ${JSON.stringify(facts[i])}`).join('\n')}`;
}
function deepPrompt(x, q, data) {
  // x.prompt, the quick answer, earlier answers and the question already use the colours on screen; the rest is
  // written with Blue = the side on roll, so it goes through nameSwap (Swap colour) before those are put in.
  const T = '\u0001T\u0001', P = '\u0001P\u0001', Q = '\u0001Q\u0001';
  const prior = (x.deep || []).filter((d) => d.state === 'done').map((d) => `Question: ${d.q || '(none: the player wanted more depth)'}\nAnswer:\n${d.text}`).join('\n\n');
  const cube = S.res.kind !== 'checker';
  const tpl = `=====
${METHOD}

=====
${data}

=====
# Deeper analysis, requested by the player
The quick explanation the player already saw:
${T}
${prior ? `\nEarlier deeper answers in this session:\n${P}\n` : ''}
${prior ? `This is a follow-up question${q ? `: "${Q}"` : ' (none given: go further than the answers above)'}. Answer it directly from the deep pass tables, the data and the tools, building on the answers above without repeating them; include a table only if it helps this question. All the rules below still apply; under about 250 words. End with one line starting "At the table:".

For reference, the format of a first deeper answer was:` : `The player wants the analysis they would get by pasting this position into the Backgammon Analysis project${q ? `, and asks: "${Q}"` : ''}.

Write the answer the project would write after its deep pass,`} following "The project's analysis method" above, from the deep pass tables:
${cube ? `- First line: the cube verdict for both sides and what the wrong actions cost.
- White's chances against what a take needs, in the coarse words of the take-point data; then the Cube section's top groups as rolls Blue and White can count; market losers when timing matters; a PRAT bullet when contact remains; if the data marks it borderline, the case for each answer.`
  : `- First line: the best play and what the alternatives cost, from the rolled-out ranking; the cost of the play in question. Then one line on what the rollout changed (or that it changed nothing).
- One table of the top 3-5 plays, as a markdown table (a header row, a separator row of dashes, one row per play, cells split by |; keep cells short): cost, and facts a player can see over the board (rolls that hit, blots, points made or given up, anchors, pips when they matter). No win or gammon percentage columns.
- 3-5 "why" bullets from the 3-ply Why section's top groups, in table terms, the decisive count first: name the rolls, say what White does with them after each play, and what follows; then the trade-off in plain words.`}
- ${q ? 'Answer the player\'s question directly, and test their reasoning against the groups: say which parts hold and which don\'t, with the rolls that show it.' : 'Cover what the quick explanation missed.'}
- The ground rules in section 1a above still apply (Blue and White; rolls as counts and game chances in coarse words; only numbers from the data, the deep pass or a tool result; shots are not hits; entering rolls like with like), and so do exact bear-off counts and borderline decisions argued both ways. The format above replaces the quick explanation's layout and length: prose, one table, no headers, under about 300 words plus the table. End with one line starting "At the table:".
- Tools are available for anything the tables don't cover (say what you tested).`;
  return `${x.prompt}\n\n` + nameSwap(tpl).replace(T, () => x.text).replace(P, () => prior).replace(Q, () => q);
}
// ------------------------------------------------------------- copy for a Max-effort chat in the project
// Everything the analyzer knows about the position, for pasting into a new chat (the project, Opus at Max effort):
// the request, the XGID and position, the engine's results so far (ranking or cube verdict, any rollout, the deep pass),
// the facts and reply tables gathered for the explanation, and the explanations already given, marked as such.
function maxEffortText(q) {
  const x = S.explain, r = S.res, cube = r.kind !== 'checker';
  const Q = '\u0001Q\u0001', D = '\u0001D\u0001', E = '\u0001E\u0001';   // filled in after nameSwap: already in screen colours
  const prb = (P) => (P ? ` | Blue wins ${pct(P[0])} (gammons ${pct(P[1])}, backgammons ${pct(P[2])}), White wins ${pct(1 - P[0])} (gammons ${pct(P[3])}, backgammons ${pct(P[4])})` : '');
  const L = [q ? `Analyze this position, using this engine data as a start, and this additional information: ${Q}` : 'Analyze this position, using this engine data as a start.', '',
    '(Exported from my BG Position Analyzer, which runs the Open Sage engine on my phone. Blue is the side on roll: X in the XGID, at the bottom of the board. White is the opponent: O.)', '',
    toXgid(S.pos), gameText(),
    cube ? `Cube decision: Blue is on roll and deciding whether to ${S.pos.cube.owner === 1 ? 'redouble' : 'double'}; White decides whether to take.` : `Blue to play ${S.pos.dice[0]}-${S.pos.dice[1]}.`,
    boardText(S.pos.board), '', '# Engine analysis already done'];
  if (!cube) {
    const list = ranked(), bookRank = r.book && !r.plays.some((p) => p.ro);
    L.push(bookRank ? `Ranking: ${r.book.src} (${r.book.srcNote}); plays the book doesn't list are costed by the engine against the book's best play, never below its worst listed play.`
      : `Ranking: Open Sage, ${r.done ? '1- to 4-ply' : `up to ${r.depth}-ply (analysis not finished)`}${list.some((p) => p.lv === 5) ? ', rolled-out plays first' : ''}. Each play's error is against the best play at the deepest depth both have.`);
    list.slice(0, 10).forEach((p, i) => L.push(`${i + 1}. ${p.name} | equity ${eqs(p.e)} | ${i ? 'error ' + Math.max(0, p.err).toFixed(3) : 'best'} | ${lvTxt(p)}${p.lv === 5 ? ` (${(p.ref.roPreset === 1 ? RO_PRESETS.quick : RO_PRESETS.standard).label})` : ''}${p.unlisted ? ', not in the book' : ''}${prb(p.probs)}`));
    if (list.length > 10) L.push(`(${list.length - 10} more legal plays, all further behind)`);
    const bk = bookPromptText(); if (bk.trim()) L.push(bk.trim());
    if (x && x.t && x.t.sel) L.push(`The play I asked about: ${x.t.sel.name}${x.t.sel === x.t.best ? ` (the best play), compared with ${x.t.other.name}` : `, which costs ${x.t.cost.toFixed(3)} against ${x.t.best.name}`}.`);
  } else {
    const Lv = cubeLevel(), v = cubeVerdict(Lv, S.pos.cube, S.pos.game), f = firmness();
    L.push(`Cube verdict (Open Sage ${r.rollout && r.rollout.done ? `rollout: ${r.rollout.label}` : `${r.depth}-ply`}): ${v.title}`);
    v.rows.forEach(([n, e]) => L.push(`  ${n}: ${eqs(e)}`));
    L.push(`  Blue: ${v.you}${v.youCost}; White: ${v.opp}${v.oppCost}`, `  Chances${prb(Lv.probs).slice(2)}`,
      `Verdict at each depth: ${f.by_depth.map((d) => `${d.level} ${d.verdict}${d.standard_error ? ` (±${d.standard_error})` : ''}`).join('; ')}.`,
      `Margins at the deepest level: take or pass ${f.take_or_pass_margin}, double or not ${f.double_or_not_margin}${f.take_or_pass_is_borderline || f.double_or_not_is_borderline ? ' (borderline)' : ''}.`);
  }
  if (x && x.deepData) L.push('', x.deepData);
  L.push(D, E);
  // the facts and reply tables gathered for the quick explanation (from its prompt, without the analyzer's own rules)
  let sup = '';
  if (x && x.prompt && !(x.deepData && !cube)) {   // for a checker play the deep pass's 3-ply tables supersede these 2-ply ones
    const from = x.prompt.indexOf(cube ? '\n# Race' : '\n# Facts after each play'), to = x.prompt.lastIndexOf('\n\n# Write the explanation now');
    if (from > 0 && to > from) sup = `\n# More engine data the analyzer computed (2-ply)${x.prompt.slice(from, to)}`;
  }
  const done = x ? [x.state === 'done' && x.text ? `Quick explanation (${x.t.title}):\n${x.text}` : '',
    ...(x.deep || []).filter((d) => d.state === 'done').map((d) => `Deeper analysis${d.q ? ` (my question: ${d.q})` : ''}:\n${d.text}`)].filter(Boolean) : [];
  const expl = done.length ? `\n# What the analyzer's explanations already said (for reference only: check it, it may contain mistakes)\n${done.join('\n\n')}` : '';
  return nameSwap(L.join('\n')).replace(Q, () => q).replace(D, () => sup).replace(E, () => expl).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
async function copyMaxEffort() {
  const x = S.explain; if (!x) return;
  const q = String(($('deepQ') && $('deepQ').value) || x.qDraft || '').trim();
  const text = maxEffortText(q);
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
    try { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'; document.body.appendChild(ta); ta.focus(); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch (e2) { ok = false; }
  }
  if (ok) { x.asking = false; render(); toast('Copied: paste it into a new chat in the Backgammon Analysis project, with Opus 5.5 at Max effort'); return; }
  // Copying blocked here: show the text to copy by hand.
  $('impSheet').innerHTML = `<h3>Copy for Max effort</h3><div class="small" style="margin-bottom:6px">Copying was blocked here. Tap Select all, then copy.</div>
    <textarea id="maxTxt" readonly style="width:100%;height:55vh;font:12px/1.35 ui-monospace,monospace;border:1px solid var(--line);border-radius:8px;padding:6px;background:var(--panel);color:inherit">${esc(text)}</textarea>
    <div class="row" style="margin-top:8px"><button class="primary" onclick="const t=$('maxTxt');t.focus();t.select();try{document.execCommand('copy')}catch(e){}">Select all</button><button onclick="closeOv()">Close</button></div>`;
  $('ovImport').classList.add('open');
}
const maxBtn = (label) => `<button onclick="${label.endsWith('…') ? 'deepAsk()' : 'copyMaxEffort()'}" style="min-height:30px" title="Copies the position, the engine's results so far and a prompt, for a new chat in the Backgammon Analysis project at Max effort">${label}</button>`;
function deepAsk() { const x = S.explain; if (!x) return; x.asking = true; render(); setTimeout(() => { const el = $('deepQ'); if (el) el.focus(); }, 50); }
async function runDeeper(retryOf) {
  const x = S.explain; if (!x || !x.prompt) return;
  const q = retryOf ? retryOf.q : String(($('deepQ') && $('deepQ').value) || x.qDraft || '').trim();
  if (retryOf) x.deep.splice(x.deep.indexOf(retryOf), 1);
  const d = { q, text: '', state: 'run', step: 'Deep pass on the phone…', check: null };
  x.deep.push(d); x.asking = false; x.qDraft = ''; render(); scrollDeep();
  const ctrl = new AbortController(); d.abort = () => { try { ctrl.abort(); } catch (e) {} };
  const stopT = setTimeout(() => d.abort(), 240000), log = [], live = () => S.explain === x;
  try {
    const step = (m) => { d.step = m; if (live()) updateExplainText(); };
    // A follow-up reuses the first deeper round's engine work (the rollout and the 3-ply Why are already done).
    const data = x.deepData || await deepEnginePass(x, step); x.deepData = data;
    if (!live()) return;
    step('Claude is writing the project-style analysis… (stronger model; about a minute)');
    const prompt = deepPrompt(x, q, data);
    const r = await sampleFn(prompt, { ...DEEP_MODEL, signal: ctrl.signal, tools: deepTools(log),
      onText: ({ text }) => { if (live()) { d.text = text; updateExplainText(); } } });
    d.text = r.text || d.text; d.by = whoAnswered(r, DEEP_MODEL);
    if (!live()) return;
    d.step = 'Checking every fact against the engine data…'; d.checking = true; render();
    let check;
    try {
      const base = `${x.prompt}\n\n${nameSwap(`=====\n${METHOD}\n\n=====\n${data}`)}${log.length ? `\n\n# Tool results the deeper analysis used (engine, computed on the phone)\n${log.join('\n')}` : ''}`;
      const v = await sampleFn(verifyPrompt(base, d.text, { words: 300, deeper: true, q }), { ...DEEP_MODEL, signal: ctrl.signal });
      check = parseCheck(v.text); check.by = whoAnswered(v, DEEP_MODEL);
    } catch (e) { if (!live()) return; check = { failed: true }; }
    if (!check.failed) d.text = check.text;
    d.check = check; d.checking = false; d.state = 'done'; d.tools = log.length;
  } catch (e) {
    d.state = 'err';
    d.err = e && e.code === 'rate_limited' ? 'Claude is busy; try again in a minute.' : e && (e.name === 'AbortError' || e.code === 'aborted') ? 'No answer within four minutes.'
      : 'Deeper analysis failed: ' + ((e && e.message) || String(e));
  }
  clearTimeout(stopT);
  if (live()) { render(); scrollDeep(); }
}
function retryDeep(i) { const x = S.explain; if (x && x.deep[i]) runDeeper(x.deep[i]); }
function scrollDeep() { const el = document.querySelector('#xtext .deep:last-child'); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
function deepHtml() {
  const x = S.explain; if (!x || !x.deep || !x.deep.length) return '';
  return x.deep.map((d, i) => `<div class="deep"><div class="dq">Deeper${d.q ? `: <i>${esc(d.q)}</i>` : ''}</div>${md(d.text || '') || `<p class="muted">${d.step}</p>`}
    ${d.state === 'err' ? `<div class="xfoot close">${esc(d.err)} <button style="min-height:28px;margin-left:4px" onclick="retryDeep(${i})">Try again</button></div>`
      : d.state === 'run' ? `<div class="xfoot"><span class="status"><span class="run">${d.step}</span></span></div>`
      : checkFoot(d.check, `retryDeep(${i})`) + `<div class="xfoot muted">${d.tools ? `Checked ${d.tools} thing${d.tools > 1 ? 's' : ''} with the engine. ` : ''}Written by ${d.by || '?'}${d.check && d.check.by ? `; fact-checked by ${d.check.by}` : ''}.</div>`}</div>`).join('');
}
function deepFoot() {
  const x = S.explain; if (!x || x.state !== 'done' || !x.prompt) return '';
  if (x.deep.some((d) => d.state === 'run')) return `<div class="xfoot">${maxBtn('Copy data for Max effort')} <span class="muted">copies what's done so far</span></div>`;
  const again = x.deep.some((d) => d.state === 'done');
  if (x.asking) return `<div class="xfoot deepform"><textarea id="deepQ" rows="2" placeholder="${again ? 'Your follow-up question' : 'What did the explanation miss? Ask a question (optional)'}" oninput="S.explain.qDraft=this.value">${esc(x.qDraft || '')}</textarea>
    <div class="row"><button class="primary" onclick="runDeeper()">${again ? 'Ask' : 'Go deeper'}</button>${maxBtn('Copy data for Max effort')}<button onclick="S.explain.asking=false;render()">Cancel</button></div>
    <div class="muted" style="margin-top:3px">Copy data for Max effort: your question, the XGID and the engine's results so far, for a new chat in the project.</div></div>`;
  return `<div class="xfoot"><div class="row"><button onclick="deepAsk()" style="min-height:30px">${again ? 'Ask a follow-up…' : 'Go deeper…'}</button>${maxBtn('Copy data for Max effort…')}</div>
    <div class="muted" style="margin-top:3px">${again ? 'Follow-up: Claude sees the answers above and reuses the engine work.' : 'Go deeper: the project\'s full analysis (rollout, 3-ply why, your question).'} Copy: your question, the XGID and the engine's results, to paste into a new chat at Max effort.</div></div>`;
}
function retryExplain() { if (S.explain && S.explain.abort) S.explain.abort(); delete xcache[S.explain && S.explain.t.key]; openExplain(); }
function closeExplain() { if (S.explain && S.explain.abort && S.explain.state === 'run') S.explain.abort(); if (S.explain && S.explain.deep) S.explain.deep.forEach((d) => { if (d.state === 'run' && d.abort) { d.abort(); d.state = 'err'; d.err = 'Stopped when you left the explanation.'; } }); S.explain = null; render(); }
function updateExplainText() { const el = $('xtext'); if (el && S.explain) el.innerHTML = (md(S.explain.text || '') || (S.explain.state === 'run' ? `<p class="muted">${S.explain.step}</p>` : '')) + deepHtml(); }
function sideExplain() {
  const x = S.explain, t = x.t;
  let foot;
  if (S.res.kind === 'checker') foot = t.close
    ? `<div class="xfoot close">Close call (${t.cost.toFixed(3)}${t.changed ? '; the order changed between 3- and 4-ply' : ''}): a rollout could change the order. <button style="min-height:28px;margin-left:4px" onclick="S.explain=null;startRollout()">Roll out</button></div>`
    : `<div class="xfoot">Clear-cut at 4-ply (${t.cost.toFixed(3)}); a rollout is unlikely to change the order.</div>`;
  else foot = `<div class="xfoot">${S.res.rollout && S.res.rollout.done ? 'Rollout verdict.' : '4-ply verdict. A rollout would firm up the size of the error, rarely the action.'}</div>`;
  $('side').innerHTML = `<div class="bar-top"><button onclick="closeExplain()">← Results</button><div class="title">${t.title}</div>${fsBtn()}</div>
    <div class="xbody${x.checking ? ' checking' : ''}" id="xtext"></div>
    ${x.state === 'err' ? `<div class="xfoot close">${x.err} <button style="min-height:28px;margin-left:4px" onclick="retryExplain()">Try again</button> ${maxBtn('Copy data for Max effort')}</div>`
      : x.state === 'run' && x.slow ? `<div class="xfoot close">No reply from Claude yet. If a permission prompt is open, answer it. <button style="min-height:28px;margin-left:4px" onclick="retryExplain()">Try again</button></div>`
      : x.state === 'run' ? `<div class="xfoot"><span class="status"><span class="run">${x.step}</span></span></div>` : checkFoot(x.check) + (x.by ? `<div class="xfoot muted">Quick explanation by ${x.by}${x.check && x.check.by ? `; checked by ${x.check.by}` : ''}.</div>` : '') + foot + deepFoot()}`;
  updateExplainText();
}

// ------------------------------------------------------------- export and import
function resultsText() {
  if (!S.res || S.mode !== 'results') return `Position\n${toXgid()}`;
  const g = S.pos.game, lines = [];
  lines.push(`Backgammon position (${g.type === 'money' ? `money game${g.jacoby ? ', Jacoby' : ''}` : `${g.len}-point match, ${g.me}-${g.opp}${g.crawford ? ', Crawford' : ''}`})`);
  const [pm, po] = pips(S.pos.board); lines.push(`Pips: Blue (on roll) ${pm}, White ${po}`);
  if (S.res.kind === 'checker') {
    lines.push(`Blue to play ${S.pos.dice[0]}-${S.pos.dice[1]}. ${S.res.book && !S.res.plays.some((p) => p.ro) ? S.res.book.src + ' (' + S.res.book.srcNote + ')' : 'Open Sage ' + (S.res.rollout && S.res.rollout.done ? 'rollout' : S.res.done ? '4-ply' : S.res.depth + '-ply')} ranking:`);
    ranked().slice(0, 8).forEach((p, i) => lines.push(`${i + 1}. ${p.name.padEnd(22)} ${eqs(p.e)}  ${i ? '-' + Math.max(0, p.err).toFixed(3) : 'best  '}  (${lvTxt(p)})`));
  } else {
    const L = cubeLevel(), v = cubeVerdict(L, S.pos.cube, S.pos.game);
    lines.push(`Cube decision (Open Sage ${S.res.rollout && S.res.rollout.done ? 'rollout' : S.res.depth + '-ply'}): ${v.title}`);
    v.rows.forEach(([n, e]) => lines.push(`  ${n.padEnd(18)} ${eqs(e)}`));
    lines.push(`  Blue: ${v.you}${v.youCost}; White: ${v.opp}${v.oppCost}`);
    const P = L.probs; lines.push(`  Blue wins ${pct(P[0])} (gammons ${pct(P[1])}, backgammons ${pct(P[2])}); White wins ${pct(1 - P[0])} (gammons ${pct(P[3])}, backgammons ${pct(P[4])})`);
  }
  const head = nameSwap(lines.join('\n')), tail = [];   // the explanation already uses the colours on screen
  if (S.explain && S.explain.state === 'done') { tail.push('', S.explain.t.title, S.explain.text); (S.explain.deep || []).filter((d) => d.state === 'done').forEach((d) => tail.push('', `Deeper${d.q ? ': ' + d.q : ''}`, d.text)); }
  tail.push('', toXgid(S.pos));
  return head + tail.join('\n');
}
function openExport() {
  const body = resultsText(), subject = 'Backgammon position: ' + (S.res && S.mode === 'results' ? (S.res.kind === 'checker' ? `${S.pos.dice[0]}-${S.pos.dice[1]} to play` : 'cube decision') : 'setup');
  const gm = `https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const mt = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  $('menu').innerHTML = `<h3>Export</h3>
    <div class="small muted">The results and the XGID go into a new email.</div>
    <pre style="white-space:pre-wrap;font-size:11px;max-height:38vh;overflow:auto;background:var(--bg);padding:8px;border-radius:8px">${body.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
    <div class="row"><a class="btnlink primary" href="${gm}" target="_blank" rel="noopener">Open in Gmail</a><a class="btnlink" href="${mt}">Other email app</a><button onclick="copyText()">Copy text</button></div>
    <div class="small muted" style="margin-top:6px">If Gmail doesn't open, use Copy text and paste it into an email.</div>
    <div class="row" style="margin-top:10px"><button onclick="closeOv()">Close</button></div>`;
  $('ovMenu').classList.add('open');
}
async function copyText() { try { await navigator.clipboard.writeText(resultsText()); toast('Copied'); } catch (e) { toast('Copy blocked'); } }
// ------------------------------------------------------------- import from a photo or screenshot (Claude reads the image)
// Claude reports the board as seen (two rows of 12 stacks, colours A = lighter, B = darker); the page works out which
// way the board runs (where each colour's home is) and who is on roll, and the user can rotate / swap before analysing.
// Short line format: far fewer tokens for Claude to write than JSON, so the answer comes back faster.
const IMP_FORMAT = `Answer with exactly these lines and nothing else:
colors: A=<the lighter checkers' colour> B=<the darker checkers' colour>
row1: c c c c c c | c c c c c c
row2: c c c c c c | c c c c c c
bar: A=<n> B=<n>
trays: A=<n> B=<n>
cube: none | <number shown> middle | <number shown> A | <number shown> B
dice: none | <d1> <d2> <A or B or ?>
pips: none | <n> <n>
numbers: none | row1 <first>-<last> row2 <first>-<last>
unsure: none | <r1c1 ... r2c12>
colors: name each colour the way a player would, ignoring shadows and the lighting, with one word from: white, cream, beige, yellow, orange, red, pink, purple, blue, green, brown, grey, black (two different words). Each c is one point: 0 if empty, otherwise the count and colour letter, for example 3A or 5B. Count every checker in a stack, including overlapping ones; if the top checker shows a number, the stack has that many. bar = checkers on the bar strip; trays = checkers in the bear-off trays or off the board. cube: a centred cube usually shows 64; A or B = the side whose half the cube sits on. dice only if two dice show a roll still to be played. pips: pip counts printed on screen. numbers: point numbers printed at the row ends. unsure: points you could not count reliably (r = row, c = 1-12 from the left).`;
// The page straightened the photo using the four corners the user tapped: the user's home board is bottom right.
const IMP_PROMPT_RECT = `This image is a backgammon board, straightened and cropped to the playing area: two rows of 12 points (6 each side of the bar in the middle). Read the checkers on every point.
row1 = the top row, left to right; row2 = the bottom row, left to right.
${IMP_FORMAT}`;
// No corners tapped (for example a screenshot): Claude also works out how the board lies.
const IMP_PROMPT_RAW = `This image shows a backgammon board (a photo or a screenshot): two long sides of 12 points each, the bar dividing each side into two halves of 6. Read the checkers on every point.
First line: layout: vertical (the bar runs top to bottom in the image) or horizontal (the bar runs left to right).
If vertical: row1 = the top row, left to right; row2 = the bottom row, left to right.
If horizontal: row1 = the right-hand column, top to bottom; row2 = the left-hand column, top to bottom.
${IMP_FORMAT}`;

let IMP = null;   // the current import: {read, url, K (colour A's home corner), roll ('A'|'B'), warn}
const other = (x) => (x === 'A' ? 'B' : 'A');
const CORNERS = ['BR', 'BL', 'TL', 'TR'];                 // in the canonical frame (vertical bar, rows as reported)
const vNeighbour = (K) => ({ BR: 'TR', TR: 'BR', BL: 'TL', TL: 'BL' })[K];
// Point number (1-24) of a location for the side whose home board is corner K. row 't' = row1, 'b' = row2; c = 0..11 left to right.
function numFor(K, row, c) {
  if (K === 'BR') return row === 'b' ? 12 - c : 13 + c;
  if (K === 'BL') return row === 'b' ? c + 1 : 24 - c;
  if (K === 'TR') return row === 't' ? 12 - c : 13 + c;
  return row === 't' ? c + 1 : 24 - c;                     // TL
}
// Board array from the on-roll side's view, for colour A's home at corner K.
function impBoard(rd, K, roll) {
  const b = new Array(26).fill(0);
  [['t', rd.row1], ['b', rd.row2]].forEach(([row, arr]) => arr.forEach((e, c) => {
    const n = +(e && e[0]) || 0, col = e && e[1]; if (!n || (col !== 'A' && col !== 'B')) return;
    b[numFor(K, row, c)] += col === 'A' ? n : -n;            // + = colour A
  }));
  b[25] = +(rd.bar && rd.bar.A) || 0; b[0] = +(rd.bar && rd.bar.B) || 0;
  return roll === 'A' ? b : flip(b);
}
function impTotals(rd) {
  const t = { A: 0, B: 0 };
  [...rd.row1, ...rd.row2].forEach((e) => { if (e && (e[1] === 'A' || e[1] === 'B')) t[e[1]] += +e[0] || 0; });
  t.A += +(rd.bar && rd.bar.A) || 0; t.B += +(rd.bar && rd.bar.B) || 0; return t;
}
// Pick the most likely reading of the board: displayed pip counts first, then printed point numbers, then the
// orientation where both sides' checkers sit nearest their own homes (lowest total pips).
function impDefaults(rd) {
  const pipsFor = (K) => { const b = impBoard(rd, K, 'A'), [a, bb] = pips(b); return { K, a, b: bb }; };
  const all = CORNERS.map(pipsFor);
  let K = all.slice().sort((x, y) => x.a + x.b - (y.a + y.b))[0].K, roll = null, why = 'checkers nearest their homes';
  const hint = Array.isArray(rd.pip_counts) ? rd.pip_counts.map(Number).filter((x) => x > 0) : [];
  const pn = rd.point_numbers;
  if (hint.length === 2) {
    const m = all.find((x) => (x.a === hint[0] && x.b === hint[1]) || (x.a === hint[1] && x.b === hint[0]));
    if (m) { K = m.K; why = 'matches the pip counts shown'; }
  }
  if (pn && why !== 'matches the pip counts shown') {
    // the corner where point 1 is printed is the home of the side the numbers belong to
    const one = pn.row1_last == 1 ? 'TR' : pn.row1_first == 1 ? 'TL' : pn.row2_last == 1 ? 'BR' : pn.row2_first == 1 ? 'BL' : null;
    if (one) { const a = all.find((x) => x.K === one), b = all.find((x) => x.K === vNeighbour(one)); K = a.a + a.b <= b.a + b.b ? one : vNeighbour(one); why = 'matches the printed point numbers'; }
  }
  if (pn) {
    const one = pn.row1_last == 1 ? 'TR' : pn.row1_first == 1 ? 'TL' : pn.row2_last == 1 ? 'BR' : pn.row2_first == 1 ? 'BL' : null;
    if (one) roll = one === K ? 'A' : 'B';                     // screenshots number the board for the side to play
  }
  if (!roll && rd.dice && (rd.dice.color === 'A' || rd.dice.color === 'B')) roll = rd.dice.color;
  if (!roll) roll = K[0] === 'B' ? 'A' : 'B';                  // otherwise: the side whose home is in the near row
  return { K, roll, why };
}
// Where a canonical corner is in the photo itself (horizontal-bar photos were turned a quarter turn to read them).
function photoCorner(K, dir) {
  const words = { TL: 'top left', TR: 'top right', BL: 'bottom left', BR: 'bottom right' };
  if (dir !== 'horizontal') return words[K];
  return words[{ TL: 'TR', TR: 'BR', BR: 'BL', BL: 'TL' }[K]];
}
function impApply(toast_) {
  const rd = IMP.read, b = impBoard(rd, IMP.K, IMP.roll), you = IMP.roll, them = other(you);
  S.board = b; S.mode = 'setup'; S.res = null; S.explain = null; S.preview = null; S.placing = 1;
  const homeYou = you === 'A' ? IMP.K : vNeighbour(IMP.K);
  S.colorSwap = you === 'A';                                   // the bottom side shows the lighter colour when it's the lighter one
  S.mirror = homeYou[1] === 'L';
  S.palette = impPalette(rd);                                  // the photo's checker colours (Blue and White when it shows none)
  applyLook();
  // cube and dice, when the image shows them
  const cu = rd.cube;
  if (cu && cu.value) {
    const v = +cu.value === 64 ? 1 : +cu.value || 1, w = String(cu.where || 'middle');
    S.cube = /A side/.test(w) ? { value: v, owner: you === 'A' ? 1 : 2 } : /B side/.test(w) ? { value: v, owner: you === 'B' ? 1 : 2 } : { value: 1, owner: 0 };
  } else S.cube = { value: 1, owner: 0 };
  if (rd.dice && Array.isArray(rd.dice.values) && rd.dice.values.length === 2 && (!rd.dice.color || rd.dice.color === you)) {
    const [d1, d2] = rd.dice.values.map(Number); if (d1 >= 1 && d1 <= 6 && d2 >= 1 && d2 <= 6) { S.dice = [Math.max(d1, d2), Math.min(d1, d2)]; S.decision = 'checker'; }
  }
  saveState();
  IMP.homeYou = homeYou; IMP.youName = meName(); IMP.themName = oppName();
  render(); if (toast_) toast(toast_);
}
function impRotate() { IMP.K = CORNERS[(CORNERS.indexOf(IMP.K) + 1) % 4]; IMP.why = 'chosen by you'; impApply(`${IMP.youName}'s home moved`); }
function impSwapRoll() { IMP.roll = other(IMP.roll); impApply(); toast(`${meName()} is now on roll`); }
function impDone() { if (IMP && IMP.url) URL.revokeObjectURL(IMP.url); IMP = null; render(); }
function impBanner() {
  if (!IMP) return '';
  const t = impTotals(IMP.read), bad = ['A', 'B'].filter((x) => t[x] > 15), unsure = (IMP.read.unsure || []).length;
  const warn = bad.length ? `<div class="why" style="text-align:left">${bad.map((x) => `${esc(S.palette ? (x === 'A' ? S.palette.light.name : S.palette.dark.name) : (IMP.read.colors && IMP.read.colors[x]) || x)} has ${t[x]} checkers`).join('; ')}: fix the board.</div>`
    : unsure ? `<div class="muted" title="${esc(IMP.read.notes || '')}">Unsure of ${unsure} point${unsure > 1 ? 's' : ''}: compare with the photo.</div>` : '<div class="muted">Compare with the photo; tap points to fix.</div>';
  return `<div class="impbox">
    <div style="display:flex;gap:6px;align-items:flex-start"><img src="${IMP.url}" onclick="impShowPhoto()" alt="photo">
      <div class="small" style="flex:1;min-width:0"><b>On roll: ${esc(IMP.youName)}</b>, home ${IMP.rect ? { BR: 'at your corner 1', BL: 'at your corner 2', TL: 'at your corner 3', TR: 'at your corner 4' }[IMP.homeYou] : photoCorner(IMP.homeYou, IMP.read.bar_direction) + ' in the photo'} <span class="muted">· ${IMP.secs.toFixed(1)} s</span>${warn}</div></div>
    <div class="row" style="margin-top:4px"><button onclick="impRotate()">⟳ Rotate</button><button onclick="impSwapRoll()">Swap roll</button><button onclick="impDone()">✓ Done</button></div>
  </div>`;
}
function impShowPhoto() {
  $('impSheet').innerHTML = `<img src="${IMP.url}" style="max-width:100%;max-height:75vh;border-radius:8px;display:block;margin:auto"><div class="row" style="margin-top:8px"><button onclick="closeOv()">Close</button></div>`;
  $('ovImport').classList.add('open');
}
let impCtrl = null;
function impProgress(msg, cancel) {
  $('impSheet').innerHTML = `<h3>Import</h3><div class="status" style="white-space:normal"><span class="run">${msg}</span></div>${cancel ? '<div class="row" style="margin-top:10px"><button onclick="impCancel()">Cancel</button></div>' : '<div class="row" style="margin-top:10px"><button onclick="closeOv()">Close</button></div>'}`;
  $('ovImport').classList.add('open');
}
function impCancel() { try { impCtrl && impCtrl.abort(); } catch (e) {} impCtrl = null; closeOv(); }
async function shrinkImage(blob) {
  // EXIF rotation applied; long side at most 1568 px (what Claude reads at full detail); JPEG.
  let bmp; try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(blob); }
  const k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height)), w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
  return await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.88));
}
function parseRead(text) {
  const lines = {}; String(text || '').split(/\n/).forEach((l) => { const m = l.match(/^\s*[*-]?\s*([a-z0-9]+)\s*:\s*(.*)$/i); if (m) lines[m[1].toLowerCase()] = m[2].trim(); });
  if (!lines.row1 || !lines.row2) throw new Error('no board found in the reply');
  const row = (t) => {
    const cells = t.replace(/\|/g, ' ').split(/[\s,]+/).filter(Boolean).slice(0, 12).map((c) => { const m = c.match(/^(\d+)\s*([AB])?$/i); return m && +m[1] && m[2] ? [Math.min(15, +m[1]), m[2].toUpperCase()] : [0, '']; });
    while (cells.length < 12) cells.push([0, '']); return cells;
  };
  const ab = (t) => { const o = { A: 0, B: 0 }; String(t || '').replace(/([AB])\s*=\s*(\d+)/gi, (_, k, n) => { o[k.toUpperCase()] = +n; }); return o; };
  const colors = { A: 'light', B: 'dark' }, hex = {};
  String(lines.colors || '').replace(/([AB])\s*=\s*([^,;]+?)(?=\s+[AB]\s*=|[,;]|$)/gi, (_, k, n) => {
    const K = k.toUpperCase(), hx = n.match(/#?\b([0-9a-f]{6})\b/i);
    if (hx) hex[K] = '#' + hx[1].toLowerCase();
    const name = n.replace(/\(?#?\b[0-9a-f]{6}\b\)?/i, '').replace(/[()]/g, '').trim(); if (name) colors[K] = name;
  });
  const rd = { bar_direction: /horizontal/i.test(lines.layout || '') ? 'horizontal' : 'vertical', colors, hex, row1: row(lines.row1), row2: row(lines.row2), bar: ab(lines.bar), trays: ab(lines.trays) };
  const cu = (lines.cube || '').match(/(\d+)\s*(middle|A|B)?/i); rd.cube = cu ? { value: +cu[1], where: !cu[2] || /middle/i.test(cu[2]) ? 'middle' : `${cu[2].toUpperCase()} side` } : null;
  const di = (lines.dice || '').match(/([1-6])\D+([1-6])\s*([AB?])?/i); rd.dice = di ? { values: [+di[1], +di[2]], color: di[3] && di[3] !== '?' ? di[3].toUpperCase() : null } : null;
  const pp = (lines.pips || '').match(/(\d+)\D+(\d+)/); rd.pip_counts = pp ? [+pp[1], +pp[2]] : null;
  const nm = (lines.numbers || '').match(/row1\s*(\d+)\s*-\s*(\d+).*row2\s*(\d+)\s*-\s*(\d+)/i); rd.point_numbers = nm ? { row1_first: +nm[1], row1_last: +nm[2], row2_first: +nm[3], row2_last: +nm[4] } : null;
  rd.unsure = (lines.unsure || '').match(/r[12]c\d+/gi) || [];
  return rd;
}
// --- corners: the user taps the playing area's four corners, starting at the on-roll side's home corner; the page
// straightens that quadrilateral into a canonical board (home board bottom right), so Claude only has to count.
function solve8(A, b) {   // Gaussian elimination, 8x8
  const n = 8, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function homography(dst, src) {   // maps dst (x, y) -> src (u, v)
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i], [u, v] = src[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return solve8(A, b);
}
const RW = 1120, RH = 800;   // the straightened board
async function warpBoard(bmp, pts) {
  const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height)), sw = Math.round(bmp.width * k), sh = Math.round(bmp.height * k);
  const sc = document.createElement('canvas'); sc.width = sw; sc.height = sh; const sx = sc.getContext('2d'); sx.drawImage(bmp, 0, 0, sw, sh);
  const src = sx.getImageData(0, 0, sw, sh).data;
  const h = homography([[RW, RH], [0, RH], [0, 0], [RW, 0]], pts.map(([x, y]) => [x * k, y * k]));
  const dc = document.createElement('canvas'); dc.width = RW; dc.height = RH; const dx = dc.getContext('2d'), out = dx.createImageData(RW, RH), o = out.data;
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const w = h[6] * x + h[7] * y + 1, u = Math.round((h[0] * x + h[1] * y + h[2]) / w), v = Math.round((h[3] * x + h[4] * y + h[5]) / w), di = (y * RW + x) * 4;
    if (u < 0 || v < 0 || u >= sw || v >= sh) { o[di + 3] = 255; continue; }
    const si = (v * sw + u) * 4; o[di] = src[si]; o[di + 1] = src[si + 1]; o[di + 2] = src[si + 2]; o[di + 3] = 255;
  }
  dx.putImageData(out, 0, 0);
  return await new Promise((res) => dc.toBlob(res, 'image/jpeg', 0.85));
}
// The two checker colours for the screen and for the names in explanations: the colour word in the reading, else the
// family of a colour value Claude gave. Always shown as clean shades: the photo's own pixels are darker and greyer than
// the checkers look (a 2026-11-17 photo of green and white checkers came out near-black and grey).
function impPalette(rd) {
  const names = rd.colors || {}, hex = rd.hex || {};
  const key = (k) => colourKey(names[k]) || (hexRgb(hex[k]) ? rgbWord(hexRgb(hex[k])).toLowerCase() : '');
  const a = key('A'), b = key('B');
  return a && b ? canonPalette(a, b) : null;            // no colours in the image: Blue and White
}
const CORNER_STEPS = ['1 · the corner of the on-roll side\'s home board, at its outer edge (where it bears off)', '2 · the other corner on that player\'s side of the board',
  '3 · the corner straight across from 2', '4 · the last corner (across from 1)'];
function pickCorners(bmp) {
  return new Promise((resolve) => {
    const pts = [];
    $('impSheet').innerHTML = `<div id="cornerStep" class="small" style="margin-bottom:6px"></div><canvas id="cornerCv" style="touch-action:none;border-radius:8px;display:block;margin:0 auto"></canvas>
      <div class="row" style="margin-top:8px"><button id="cUndo">Undo</button><button id="cSkip">Skip (screenshot)</button><button id="cCancel">Cancel</button></div>`;
    const sheet = $('impSheet'); sheet.classList.add('cornersheet');
    $('ovImport').classList.add('open');
    const cv = $('cornerCv'), dpr = window.devicePixelRatio || 1;
    let sc = 1, g = null;
    // Fit the whole photo in the room the sheet has left after the instructions and the buttons (no scrolling);
    // recomputed when the window turns or resizes. The taps are kept in the photo's own pixels.
    const fit = () => {
      cv.style.width = '10px'; cv.style.height = '10px';
      const used = $('cornerStep').offsetHeight + sheet.querySelector('.row').offsetHeight + 8 + 20 + 6;
      const maxW = sheet.clientWidth - 20, maxH = window.innerHeight * 0.97 - used - 8;
      sc = Math.min(maxW / bmp.width, maxH / bmp.height);
      cv.style.width = bmp.width * sc + 'px'; cv.style.height = bmp.height * sc + 'px'; cv.width = Math.round(bmp.width * sc * dpr); cv.height = Math.round(bmp.height * sc * dpr);
      g = cv.getContext('2d'); draw();
    };
    const draw = () => {
      g.setTransform(dpr * sc, 0, 0, dpr * sc, 0, 0); g.drawImage(bmp, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (pts.length > 1) { g.strokeStyle = '#ff8a00'; g.lineWidth = 2.5; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x * sc, y * sc) : g.moveTo(x * sc, y * sc))); if (pts.length === 4) g.closePath(); g.stroke(); }
      pts.forEach(([x, y], i) => { g.fillStyle = i ? '#ff8a00' : '#2e7d4f'; g.beginPath(); g.arc(x * sc, y * sc, 11, 0, 7); g.fill(); g.fillStyle = '#fff'; g.font = 'bold 13px sans-serif'; g.textAlign = 'center'; g.fillText(String(i + 1), x * sc, y * sc + 4.5); });
      $('cornerStep').innerHTML = pts.length < 4 ? `Tap the playing area's corners. <b>${CORNER_STEPS[pts.length]}</b>` : 'Reading…';
    };
    $('cornerStep').innerHTML = `Tap the playing area's corners. <b>${CORNER_STEPS[0]}</b>`;
    fit(); window.addEventListener('resize', fit);
    const done = (v) => { window.removeEventListener('resize', fit); sheet.classList.remove('cornersheet'); resolve(v); };
    cv.addEventListener('pointerup', (ev) => {
      if (pts.length >= 4) return;
      const r = cv.getBoundingClientRect(); pts.push([(ev.clientX - r.left) / sc, (ev.clientY - r.top) / sc]); draw();
      if (pts.length === 4) setTimeout(() => done(pts.slice()), 250);
    });
    $('cUndo').onclick = () => { pts.pop(); draw(); };
    $('cSkip').onclick = () => done('skip');
    $('cCancel').onclick = () => { closeOv(); done(null); };
  });
}
// With corners: the on-roll side's home is bottom right of the straightened board; which colour that is, the pip count decides.
function impDefaultsRect(rd) {
  const tot = (K) => { const [a, b] = pips(impBoard(rd, K, 'A')); return a + b; };
  return tot('BR') <= tot('TR') ? { K: 'BR', roll: 'A', why: 'from your corners' } : { K: 'TR', roll: 'B', why: 'from your corners' };
}
const impTier = () => (S.impMode === 'careful' ? 'complex' : 'default');
async function importImage(file) {
  if (!sampleFn) { toast('Import needs Claude: open the analyzer in the Claude app and allow it to ask Claude'); return; }
  try { if (sampleFn.limits && !(await sampleFn.limits()).images) { toast('Claude can\'t read images in this view'); return; } } catch (e) {}
  let bmp; try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { try { bmp = await createImageBitmap(file); } catch (e2) { toast('That file isn\'t an image'); return; } }
  const pts = await pickCorners(bmp);
  if (!pts) return;
  const rect = pts !== 'skip';
  impCtrl = new AbortController();
  const my = impCtrl, t0 = performance.now();
  let tick = 0;
  const msgT = (m) => () => { if (my === impCtrl) impProgress(`${m} · ${((performance.now() - t0) / 1000).toFixed(0)} s`, true); };
  try {
    const img = rect ? await warpBoard(bmp, pts) : await shrinkImage(file);
    let say = msgT(`Claude is reading the board${S.impMode === 'careful' ? ' (careful)' : ''}`); say(); tick = setInterval(() => say(), 1000);
    const opts = () => ({ images: [img], modelTier: impTier(), signal: my.signal });
    const prompt = rect ? IMP_PROMPT_RECT : IMP_PROMPT_RAW;
    let r = await sampleFn(prompt, opts()), rd = parseRead(r.text);
    if (my !== impCtrl) return;
    // Careful mode only: if a colour doesn't come to 15, ask for a recount with the first reading in hand.
    const tot = (x) => { const t = impTotals(x); return { A: t.A + (+x.trays.A || 0), B: t.B + (+x.trays.B || 0), onA: t.A, onB: t.B }; };
    const t = tot(rd);
    if (S.impMode === 'careful' && (t.A !== 15 || t.B !== 15)) {
      say = msgT('Recounting (the totals didn\'t come to 15)');
      const again = `${prompt}\n\nA first reading of this image was:\n${r.text}\nIts totals (points + bar + trays): A ${t.A}, B ${t.B}; each should be 15 (spare checkers can lie in a tray). Look again point by point, recount the tall and overlapping stacks, and answer in the same format.`;
      try { const r2 = await sampleFn(again, opts()), rd2 = parseRead(r2.text), t2 = tot(rd2); if (Math.abs(t2.onA - 15) + Math.abs(t2.onB - 15) <= Math.abs(t.onA - 15) + Math.abs(t.onB - 15) || (t2.A === 15 && t2.B === 15)) rd = rd2; } catch (e) { if (e && e.name === 'AbortError') throw e; }
    }
    clearInterval(tick);
    if (my !== impCtrl) return;
    if (IMP && IMP.url) URL.revokeObjectURL(IMP.url);
    const d = rect ? impDefaultsRect(rd) : impDefaults(rd);
    IMP = { read: rd, rect, url: URL.createObjectURL(file), K: d.K, roll: d.roll, why: d.why, secs: (performance.now() - t0) / 1000 };
    closeOv(); if (S.mode !== 'setup') backToSetup();
    S.dice = null;                                   // a new position: its dice come from the photo or from you
    impApply(`Read in ${IMP.secs.toFixed(1)} s: check it against the photo`);
  } catch (e) {
    clearInterval(tick);
    if (my !== impCtrl) return;
    impProgress(e && e.code === 'not_granted' ? 'Permission to ask Claude was not given.' : e && e.code === 'rate_limited' ? 'Claude is busy; try again in a minute.'
      : e && e.name === 'AbortError' ? 'Cancelled.' : 'Couldn\'t read a board in that image: ' + esc((e && e.message) || String(e)), false);
  }
  impCtrl = null;
}
async function importClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) { const ty = it.types.find((x) => x.startsWith('image/')); if (ty) { importImage(await it.getType(ty)); return; } }
    toast('No image on the clipboard: copy a screenshot first');
  } catch (e) {
    // Reading the clipboard may be blocked here: fall back to a paste box.
    $('impSheet').innerHTML = `<h3>Paste a screenshot</h3><div contenteditable="true" id="pasteBox" style="min-height:90px;border:2px dashed var(--line);border-radius:9px;padding:10px;color:var(--muted)">Long-press here and choose Paste</div><div class="row" style="margin-top:10px"><button onclick="closeOv()">Cancel</button><button onclick="closeOv();$('impFile').click()">From gallery instead</button></div>`;
    $('ovImport').classList.add('open');
    const box = $('pasteBox');
    box.addEventListener('paste', (ev) => {
      const f = [...(ev.clipboardData && ev.clipboardData.files || [])].find((x) => x.type.startsWith('image/'));
      ev.preventDefault(); if (f) { closeOv(); importImage(f); } else toast('That wasn\'t an image');
    });
    box.focus();
  }
}

// ------------------------------------------------------------- full screen by default, saved state, start
// Browsers allow full screen only from a tap (the "user activation" comes on pointerup/click for touch, not
// pointerdown). The first tap anywhere enters it; after the app goes to the background and comes back, the next
// tap re-enters, unless the user left full screen with the ⤡ button.
let fsArmed = true, fsUserExit = false;
function tryFull(ev) {
  if (DESKTOP) return;
  if (ev && ev.target && ev.target.closest && ev.target.closest('[data-nofs]')) return;   // the menu's own Full screen button decides
  if (!fsArmed || fsUserExit || document.fullscreenElement || !document.fullscreenEnabled || !document.documentElement.requestFullscreen) return;
  fsArmed = false;
  let p; try { p = document.documentElement.requestFullscreen(); } catch (e) { p = Promise.reject(e); }
  Promise.resolve(p).catch((e) => { fsArmed = true; fsLastErr = (e && e.message) || String(e); });
}
// (BG Play's review: no automatic full screen inside the game's frame)
document.addEventListener('visibilitychange', () => { if (!document.hidden && !document.fullscreenElement) fsArmed = true; });
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) fsArmed = true; render(); if ($('ovMenu').classList.contains('open')) openMenu(); });   // keep the menu's Full screen label true
function saveState() { try { localStorage.setItem('bgplay-rv', JSON.stringify({ v: 2, workers: S.workersSet ? S.workers : 0, roPreset: S.roPreset })); } catch (e) {} }
// Opens on the starting position; only the settings carry over. The last analysed position is kept
// under its own key (editing the board doesn't overwrite it), offered under Clear at start-up and in the ⋯ menu.
function saveLast() {}
function savedState() {
  const ok = (s) => s && s.board && s.board.length === 26 ? s : null;
  try { return ok(JSON.parse(localStorage.getItem('bgpa-last') || 'null')) || ok(JSON.parse(localStorage.getItem('bgpa-state') || 'null')); } catch (e) { return null; }
}
function loadState() {
  let r = null; try { r = JSON.parse(localStorage.getItem('bgplay-rv') || 'null'); } catch (e) {}
  // workers: one chosen in this menu, else BG Play's choice for the review (six), else the analyzer's default
  if (r && r.v === 2 && r.workers) { S.workers = r.workers; S.workersSet = true; } else S.workers = (RVX && RVX.workers) || S.workers;
  if (r && r.roPreset) S.roPreset = r.roPreset;
  S.offerLast = false; applyLook(); return;
  let s = null; try { s = JSON.parse(localStorage.getItem('bgpa-state') || 'null'); } catch (e) {}
  if (s) { if (s.game) S.game = s.game; if (s.workers) S.workers = s.workers; if (s.roPreset) S.roPreset = s.roPreset; S.colorSwap = !!s.colorSwap; S.mirror = !!s.mirror; S.impMode = s.impMode || 'fast'; S.palette = fixPalette(s.palette); }
  applyLook();
  const last = savedState();
  S.offerLast = !!(last && JSON.stringify(last.board) !== JSON.stringify(START) && last.board.some((v) => v));
}
function restoreLast() {
  S.offerLast = false;
  const s = savedState(); if (!s) { toast('No saved position'); return; }
  S.board = s.board; S.dice = s.dice; S.decision = s.decision || 'checker'; S.cube = s.cube || { value: 1, owner: 0 };
  if (S.mode !== 'setup') backToSetup(); closeOv(); render(); toast('Last position restored');
}
// The start-up offer goes as soon as anything else is pressed (it stays in the ⋯ menu).
let offerDropped = false;
document.addEventListener('pointerdown', (e) => {
  if (!S.offerLast || (e.target.closest && e.target.closest('#offerLast'))) return;
  S.offerLast = false; offerDropped = true;
}, { capture: true });
document.addEventListener('pointerup', () => { if (offerDropped) setTimeout(() => { if (offerDropped) { offerDropped = false; render(); } }, 80); });
// ------------------------------------------------------------- desktop: hover previews, keys, paste and drop
function hoverPlay(i) {
  const l = ranked(), r = i >= 0 ? l[i] : l[S.sel];
  S.preview = r ? { after: r.b, name: r.name } : null; drawBoard();
}
let keyDie = null;
document.addEventListener('keydown', (ev) => {
  if (!DESKTOP || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const t = ev.target, typing = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
  if (typing) { if (ev.key === 'Escape') t.blur(); return; }
  const open = document.querySelector('.ov.open'), k = ev.key.toLowerCase();
  if (k === 'escape') { if (open) closeOv(); else if (S.explain) closeExplain(); else if (S.mode === 'results') backToSetup(); keyDie = null; ev.preventDefault(); return; }
  if (open) return;
  if (S.mode === 'setup') {
    if (/^[1-6]$/.test(k)) {
      if (keyDie == null) { keyDie = +k; toast(`Die ${k}: press the other die`); }
      else { S.dice = [Math.max(keyDie, +k), Math.min(keyDie, +k)]; S.decision = 'checker'; keyDie = null; render(); toast(`Dice ${S.dice[0]}-${S.dice[1]}`); }
      ev.preventDefault(); return;
    }
    if (k === 'c') { S.decision = 'cube'; render(); ev.preventDefault(); return; }
    if (k === 'enter') { const b = [...document.querySelectorAll('#side button.primary')].find((x) => /Analyze/.test(x.textContent)); if (b && !b.disabled) analyze(); ev.preventDefault(); return; }
    return;
  }
  if (S.mode !== 'results') return;
  if (S.explain) { if (k === 'd' && S.explain.state === 'done' && !S.explain.asking) { deepAsk(); ev.preventDefault(); } return; }
  const n = S.res && S.res.kind === 'checker' ? ranked().length : 0;
  if ((k === 'arrowdown' || k === 'arrowup') && n) { S.sel = Math.max(0, Math.min(n - 1, S.sel + (k === 'arrowdown' ? 1 : -1))); pickPreview(); render(); const row = document.querySelector('.list tr.sel'); if (row) row.scrollIntoView({ block: 'nearest' }); ev.preventDefault(); return; }
  if (k === 'e') { const b = [...document.querySelectorAll('#side button.primary')].find((x) => /Explain/.test(x.textContent)); if (b && !b.disabled) openExplain(); ev.preventDefault(); return; }
  if (k === 'r') { const b = [...document.querySelectorAll('#side .row button')].find((x) => /Roll out/.test(x.textContent)); if (b && !b.disabled) startRollout(); ev.preventDefault(); return; }
});
// A screenshot pasted anywhere (Ctrl+V) or an image file dropped on the page is imported (phone and desktop).
document.addEventListener('paste', (ev) => {
  if (REVIEW) return;
  const t = ev.target; if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.id === 'pasteBox')) return;
  const f = [...((ev.clipboardData && ev.clipboardData.files) || [])].find((x) => x.type.startsWith('image/'));
  if (f) { ev.preventDefault(); importImage(f); }
});
document.addEventListener('dragover', (ev) => { if ([...(ev.dataTransfer && ev.dataTransfer.types || [])].includes('Files')) { ev.preventDefault(); document.body.classList.add('dragging'); } });
document.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) document.body.classList.remove('dragging'); });
document.addEventListener('drop', (ev) => {
  if (REVIEW) return;
  document.body.classList.remove('dragging');
  const f = [...((ev.dataTransfer && ev.dataTransfer.files) || [])].find((x) => x.type.startsWith('image/'));
  if (f) { ev.preventDefault(); importImage(f); }
});

function render() {
  document.body.classList.toggle('results', S.mode === 'results'); document.body.classList.toggle('explain', !!S.explain);
  if (S.mode === 'setup') sideSetup(); else if (S.explain) sideExplain(); else sideResults();
  drawBoard();
}
const svg = $('board');
svg.addEventListener('pointerdown', onDown);
svg.addEventListener('pointermove', onMove);
svg.addEventListener('pointerup', (e) => { onUp(e); saveState(); });
svg.addEventListener('pointercancel', onUp);
window.addEventListener('resize', () => requestAnimationFrame(render));
let lastBox = '';
try { new ResizeObserver(() => { const r = $('board').getBoundingClientRect(), k = `${Math.round(r.width)}x${Math.round(r.height)}`; if (k !== lastBox) { lastBox = k; requestAnimationFrame(drawBoard); } }).observe($('boardWrap')); } catch (e) {}

// ------------------------------------------------------------- BG Play review: the game's positions, one at a time
// Items (from BG Play): {id, who: 'me'|'bot' (on roll), board (its view), dice | null, cube {value, owner 0|1|2},
// game (this page's S.game, from the side on roll), played: {after, name, by} | {action, by}, answer?: {action, by},
// cost (your decision's 4-ply cost in the game, or null), err (your error of 0.020 or more), blunder (0.080 or more),
// label, base (the label without the cost), costTxt and tier (blunder / error / small: the cost's colour)}.
const RV = { items: (RVX && RVX.items) || [], idx: 0, mode: 'all', view: 'move', follow: true, cache: new Map(), timer: 0, started: false,
  canExplain: !!(RVX && RVX.explain), bot: (RVX && RVX.botName) || 'Open Sage' };
// Three ways through the game (the user's choice, 2026-11-26): all moves, your errors (0.020 or more), your blunders only
// (0.080 or more).
const rvList = () => (RV.mode === 'errors' ? RV.items.filter((x) => x.err) : RV.mode === 'blunders' ? RV.items.filter((x) => x.blunder) : RV.items);
// Labels for the side on roll (1) and the other side (2): You and Open Sage.
const rvWho = (s) => { const it = S.rvItem; if (!it) return s === 1 ? 'You' : 'Opponent'; return (s === 1) === (it.who === 'me') ? 'You' : RV.bot; };
function rvBoot() {
  const X = RVX || {}, errs = RV.items.filter((x) => x.err);
  RV.mode = X.mode === 'all' || !errs.length ? 'all' : X.mode === 'blunders' && errs.some((x) => x.blunder) ? 'blunders' : 'errors';
  const list = rvList(), i = X.at ? list.findIndex((x) => x.id === X.at) : 0;
  RV.idx = Math.max(0, i);
  rvShow(rvList()[RV.idx]);
}
// The item's position on the board, in BG Play's colours and the way the game was played: each side keeps its colour,
// you at the bottom and Open Sage at the top whoever is on roll (the analyzer works from the side on roll, so rvFlip()
// turns its board over for Open Sage's turns). A roll has two views: the move ('move') and the cube decision before the
// roll ('cube'), switched by swiping the list sideways or by the two tabs; each position opens on the move.
function rvShow(it) {
  if (!it) return;
  const cv = !!it.dice && RV.view === 'cube';
  S.board = it.board.slice(); S.dice = it.dice && !cv ? it.dice.slice() : null; S.decision = S.dice ? 'checker' : 'cube';
  S.cube = { ...it.cube }; S.game = { ...it.game };
  const o = (RVX && RVX.opts) || {}, sw = !!o.swapColour;
  S.colorSwap = it.who === 'me' ? sw : !sw; S.mirror = !!o.mirror; applyLook();
  S.rvItem = it; S.rvPlayed = !cv && it.played && it.played.after ? it.played.after.slice() : null; RV.follow = true;
}
function rvFlip() { return !!(S.rvItem && S.rvItem.who === 'bot'); }
const rvKey = (it) => it.id + (it.dice && RV.view === 'cube' ? ':cube' : '');
const rvCubeView = () => !!(S.rvItem && S.rvItem.dice && RV.view === 'cube');
function rvView(v) {
  const it = S.rvItem; if (!it || !it.dice || v === RV.view) return;
  try { localStorage.setItem('bgplay-rv-swipe', '1'); } catch (e) {}
  rvStash(); RV.view = v; rvPreview();
}
function rvTabs() {
  const d = S.rvItem.dice, cv = rvCubeView();
  return `<span class="seg rvtabs"><button class="${cv ? '' : 'on'}" onclick="rvView('move')">To play ${d[0]}-${d[1]}</button><button class="${cv ? 'on' : ''}" onclick="rvView('cube')">Cube before the roll</button></span>`;
}
// The roll on the board, in the roller's colours: yours on the right half, Open Sage's on the left (as in the game).
function rvDice(mid) {
  const ds = Math.min(G.zh * 0.95, G.pw * 0.82, 40), gap = ds * 0.25, cx = S.rvItem.who === 'me' ? G.colX(9) : G.colX(3), y = mid - ds / 2;
  const die = (x, v) => {
    const P = { 1: [[.5, .5]], 2: [[.27, .27], [.73, .73]], 3: [[.27, .27], [.5, .5], [.73, .73]], 4: [[.27, .27], [.73, .27], [.27, .73], [.73, .73]],
      5: [[.27, .27], [.73, .27], [.5, .5], [.27, .73], [.73, .73]], 6: [[.27, .25], [.73, .25], [.27, .5], [.73, .5], [.27, .75], [.73, .75]] }[v] || [];
    return `<rect x="${x}" y="${y}" width="${ds}" height="${ds}" rx="${ds * 0.18}" fill="var(--me)" stroke="var(--me-edge)" stroke-width="1.4"/>` +
      P.map(([a, c]) => `<circle cx="${x + a * ds}" cy="${y + c * ds}" r="${ds * 0.085}" fill="var(--me-ink)"/>`).join('');
  };
  return `<g class="rvdice">${die(cx - ds - gap / 2, S.dice[0])}${die(cx + gap / 2, S.dice[1])}</g>`;
}
// The arrows' colour (the user's rule, 2026-11-25) by the shown play's cost: green the best play, grey not best but under
// 0.020, yellow an error (0.020 to 0.080), red a blunder (0.080 or more): the project's error and blunder thresholds.
function rvArrowColour() {
  if (!S.rvItem || !S.preview || !S.res || S.res.kind !== 'checker' || !S.res.plays.length) return null;
  const L = ranked(), i = L.findIndex((p) => sameB(p.b, S.preview.after)); if (i < 0) return null;
  const e = i === 0 ? 0 : Math.max(0, L[i].err);
  return e < 0.0005 ? ['#2e9e4f', '#0e3a1c'] : e < 0.020 ? ['#a4a4a4', '#3a3a3a'] : e < 0.080 ? ['#f2c230', '#5c4500'] : ['#e0413a', '#5a0f0b'];
}
function rvLoad() {
  const it = rvList()[RV.idx]; if (!it) { render(); return; }
  rvShow(it);
  const c = RV.cache.get(rvKey(it));
  if (c) { gen++; S.mode = 'results'; S.explain = null; S.pos = c.pos; S.res = c.res; S.sel = 0; pickPreview(); render(); return; }
  analyze();
}
// A finished analysis is kept, so going back to a position shows it at once.
function rvStash() { const it = S.rvItem, r = S.res; if (it && r && r.done && !r.waiting && (!r.rollout || r.rollout.done) && S.pos) RV.cache.set(rvKey(it), { pos: S.pos, res: r }); }
function rvGo(d) {
  const n = rvList().length; if (!n) return;
  const i = Math.max(0, Math.min(n - 1, RV.idx + d)); if (i === RV.idx) return;
  rvStash(); RV.idx = i; RV.view = 'move'; rvPreview();
}
// Shows the position at once and analyses it after a short pause, so a run of taps skips the positions passed.
function rvPreview() {
  const it = rvList()[RV.idx]; if (!it) { render(); return; }
  gen++; S.explain = null; clearTimeout(RV.timer); rvShow(it);
  if (RV.cache.has(rvKey(it)) || !RV.started) { if (RV.started) rvLoad(); else render(); return; }
  S.mode = 'results'; S.preview = null;
  S.pos = { board: S.board.slice(), dice: S.dice ? S.dice.slice() : null, cube: { ...S.cube }, game: { ...S.game }, g: gameG() };
  S.res = { kind: S.dice ? 'checker' : 'cube', depth: 0, t: [], plays: [], levels: {}, rollout: null, waiting: true };
  render();
  RV.timer = setTimeout(rvLoad, 260);
}
function rvMode(m) {
  if (m === RV.mode) return;
  const cur = S.rvItem; rvStash(); RV.mode = m; RV.view = 'move';
  const list = rvList(); let i = cur ? list.findIndex((x) => x.id === cur.id) : -1;
  if (i < 0 && cur) { const at = RV.items.indexOf(cur); i = list.findIndex((x) => RV.items.indexOf(x) >= at); if (i < 0) i = list.length - 1; }
  RV.idx = Math.max(0, i); rvPreview();
}
function rvReload() { gen++; S.explain = null; if (S.rvItem) RV.cache.delete(rvKey(S.rvItem)); if (engineState === 'ready') rvLoad(); }
function rvClose() { clearTimeout(RV.timer); try { if (S.explain && S.explain.abort) S.explain.abort(); } catch (e) {} try { if (pool) pool.terminate(); } catch (e) {} if (RVX && RVX.close) RVX.close(); }
function rvSync() { if (!S.rvPlayed || !S.res || S.res.kind !== 'checker') return; const i = ranked().findIndex((p) => sameB(p.b, S.rvPlayed)); if (i >= 0) S.sel = i; }
function rvForce(cands) { if (!S.rvPlayed || !S.res || !S.res.plays) return; const p = S.res.plays.find((x) => sameB(x.b, S.rvPlayed)); if (p && !cands.includes(p)) cands.push(p); }
const rvTag = (p) => (S.rvPlayed && p.b && sameB(p.b, S.rvPlayed) ? `<span class="mdl played">${S.rvItem && S.rvItem.who === 'me' ? 'you' : 'played'}</span>` : '');
function rvBar() {
  const list = rvList(), it = list[RV.idx], nE = RV.items.filter((x) => x.err).length, nB = RV.items.filter((x) => x.blunder).length, nA = RV.items.length;
  const seg = (m, text, n, title) => `<button class="${RV.mode === m ? 'on' : ''}" ${n ? '' : 'disabled'} onclick="rvMode('${m}')" title="${title}">${text}</button>`;
  return `<div class="rvbarbox"><div class="rvbar"><button class="icon" onclick="rvClose()" title="Back to the game" aria-label="Back to the game">✕</button>
    <div class="seg">${seg('all', 'All moves', nA, `${nA} positions`)}${seg('errors', `Errors ${nE}`, nE, 'Your errors: 0.020 or more')}${seg('blunders', `Blunders ${nB}`, nB, 'Your blunders: 0.080 or more')}</div>
    <button class="icon rvprev" ${RV.idx > 0 ? '' : 'disabled'} onclick="rvGo(-1)" aria-label="Previous position">‹</button><span class="rvpos">${list.length ? RV.idx + 1 : 0} / ${list.length}</span><button class="icon" ${RV.idx < list.length - 1 ? '' : 'disabled'} onclick="rvGo(1)" aria-label="Next position">›</button></div></div>
    <div class="rvlabel">${!it ? 'No positions to review.' : it.base == null ? esc(it.label) : esc(it.base) + (it.costTxt ? (it.costTxt === '(forced)' ? ' (forced)' : ` · <span class="rvcost ${it.tier || 'small'}">${esc(it.costTxt)}</span>`) : '')}</div>`;
}
function rvWait() {
  const it = rvList()[RV.idx];
  $('side').innerHTML = `${rvBar()}<div class="bar-top"><div class="title">${it ? (it.dice ? `To play ${it.dice[0]}-${it.dice[1]}` : 'Cube decision') : 'Review'}<div class="status"><span class="run">${esc(engineState === 'error' ? engineErr : engineErr || 'Starting the engine…')}</span></div></div></div>`;
}
// What was played in the game at a cube decision, and what it cost, from this analysis.
function rvCubePlayed(L) {
  const it = S.rvItem, cv = rvCubeView(); if (!it || !L || (!cv && (it.dice || !it.played))) return '';
  const g = S.pos.game, nd = L.equity_nd, dp = L.equity_dp, take = L.is_beaver ? L.equity_dt / 2 : L.equity_dt;
  const ans = { Take: take, Pass: dp }; if (g.type === 'money' && g.beaver) ans.Beaver = 2 * take;
  const doubled = Math.min(...Object.values(ans)), best = Math.max(nd, doubled), owned = S.pos.cube.owner === 1;
  const fmt = (c) => (c < 0.0005 ? 'right' : `−${c.toFixed(3)}`), who = (side) => (side === 'me' ? 'You' : RV.bot), out = [];
  const p = cv ? { action: 'No double', by: it.who } : it.played;   // before a roll: the side rolled without doubling
  if (S.pos.cube.owner === 2 || (cv && g.type === 'match' && g.crawford)) return cv ? `<div class="verdict2 rvplayed">In the game: ${who(it.who)} rolled ${it.dice[0]}-${it.dice[1]} (no cube access)</div>` : '';
  out.push(p.action === 'Double' ? `${who(p.by)} ${owned ? 'redoubled' : 'doubled'} (${fmt(best - doubled)})` : `${who(p.by)} didn't ${owned ? 'redouble' : 'double'} (${fmt(best - nd)})`);
  if (!cv && it.answer && ans[it.answer.action] != null) out.push(`${who(it.answer.by)} ${{ Take: 'took', Pass: 'passed', Beaver: 'beavered' }[it.answer.action]} (${fmt(ans[it.answer.action] - doubled)})`);
  return `<div class="verdict2 rvplayed">In the game: ${out.join('; ')}${cv ? `, then rolled ${it.dice[0]}-${it.dice[1]}` : ''}</div>`;
}
// For Explain and Go deeper: who Blue and White are, and what was played (Blue/White words; the prompt renames them).
function rvContext() {
  const it = S.rvItem; if (!it) return '';
  const eng = `${RV.bot}, the engine the user played`, blue = it.who === 'me' ? 'the user' : eng, white = it.who === 'me' ? eng : 'the user';
  let did = '';
  if (rvCubeView()) did = ` This is the cube decision before Blue's roll; in the game Blue ${S.pos && S.pos.cube.owner === 2 ? 'had no access to the cube and' : 'did not double, then'} rolled ${it.dice[0]}-${it.dice[1]} and played ${it.played.name}.`;
  else if (it.dice && it.played) did = ` In the game Blue played ${it.played.name}.`;
  else if (it.played) {
    did = ` In the game Blue ${it.played.action === 'Double' ? 'doubled' : 'did not double'}`;
    if (it.answer) did += ` and White ${{ Take: 'took', Pass: 'passed', Beaver: 'beavered' }[it.answer.action]}`;
    did += '.';
  }
  return ` This position is from a game the user played against ${RV.bot}, reviewed afterwards: Blue (on roll) is ${blue}; White is ${white}.${did}`;
}
function rvMenu() {
  $('menu').innerHTML = `<h3>Review</h3>
    <div class="mgrid"><section>
    <h4>Position</h4>
    <input type="text" id="xgidBox" value="${toXgid()}" readonly onfocus="this.select()">
    <div class="row" style="margin-top:6px"><button onclick="copyX()">Copy XGID</button><button onclick="openExport()">Export</button></div>
    </section><section>
    <h4>Engine</h4>
    <div class="field"><span>Workers (cores used)</span><div class="seg" style="width:200px">${[1, 2, 4, 6].map((n) => `<button class="${S.workers === n ? 'on' : ''}" onclick="setWorkers(${n})">${n}</button>`).join('')}</div></div>
    <div class="field"><span>Rollout</span><div class="seg" style="width:220px"><button class="${S.roPreset === 'quick' ? 'on' : ''}" onclick="S.roPreset='quick';saveState();openMenu()">Quick (1-ply)</button><button class="${S.roPreset === 'standard' ? 'on' : ''}" onclick="S.roPreset='standard';saveState();openMenu()">Standard (3-ply)</button></div></div>
    <div class="small muted">Quick: 1296 games at 1-ply. Standard: 360 games at 3-ply early and 2-ply late (≈ XG Roller++), about 30-45 s.</div>
    ${RV.canExplain ? `<h4>Explanations</h4><div class="row"><button onclick="openRules()">Explanation rules &amp; reference positions</button></div>` : ''}
    </section></div>
    <div class="row" style="margin-top:12px"><button class="primary" onclick="closeOv()">Done</button></div>`;
  $('ovMenu').classList.add('open');
}
// Swiping the list (or the cube table) sideways switches a roll between its move and the cube decision before it.
(() => {
  const el = $('side'); if (!el) return;
  let x0 = 0, y0 = 0, t0 = 0, on = false;
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
    on = e.touches.length === 1 && !S.explain && !!(S.rvItem && S.rvItem.dice) && !!(e.target.closest && e.target.closest('.list, .cubebox, .pt, .spacer, .bar-top'));
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!on) return; on = false;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) >= 45 && Math.abs(dx) > 1.5 * Math.abs(dy) && Date.now() - t0 < 1000) rvView(RV.view === 'cube' ? 'move' : 'cube');
  }, { passive: true });
})();
function rvHint() { try { if (!localStorage.getItem('bgplay-rv-swipe') && RV.items.some((x) => x.dice)) setTimeout(() => toast('Swipe the list sideways for the cube decision before the roll', 3500), 1500); } catch (e) {} }
document.addEventListener('keydown', (ev) => {
  if (document.querySelector('.ov.open') || S.explain || (ev.target && /INPUT|TEXTAREA/.test(ev.target.tagName))) return;
  if (ev.key === 'ArrowRight') { rvGo(1); ev.preventDefault(); } else if (ev.key === 'ArrowLeft') { rvGo(-1); ev.preventDefault(); } else if (ev.key === 'Escape') rvClose();
});
loadState();
rvBoot();
render();
loadEngine();
rvHint();

