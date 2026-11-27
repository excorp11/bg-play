// app.js: BG Play, a game against Open Sage on the device: cash games (Jacoby, beavers) with a session tally, or
// matches with the Crawford rule; the bot plays at 1-4 ply; your decisions are analysed at 4-ply in the background
// and your ER (XG's PR formula and decision counting) is shown when the game ends; a review steps through your
// errors or every move with the BG Position Analyzer's display (review.html + review.js in a frame); games can be
// saved for the project's full analysis. Rules: rules.js. Engine: worker.js (one Open Sage WebAssembly engine per worker).
'use strict';
const TARGET = window.BGP_TARGET || 'tile';          // 'tile' (Claude app) or 'pwa' (the offline home-screen app)
const VERSION = window.BGP_VERSION || 'dev';
const TILE_URL = window.BGP_TILE_URL || '';
const TRIGGER_ID = window.BGP_TRIGGER || '';
const USER = 'q_game';
const $ = (id) => document.getElementById(id);
const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eqs = (e) => (e >= 0 ? '+' : '−') + Math.abs(e).toFixed(3);
const pct = (x) => (100 * x).toFixed(1) + '%';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function rollDie() { const a = new Uint8Array(1); for (;;) { crypto.getRandomValues(a); if (a[0] < 252) return 1 + (a[0] % 6); } }
// A roll, shown higher die first (the user's rule, 2026-11-25).
function rollPair() { const a = rollDie(), b = rollDie(); return [Math.max(a, b), Math.min(a, b)]; }
const uid = () => { const a = new Uint8Array(6); crypto.getRandomValues(a); return Date.now().toString(36) + Array.from(a, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 8); };

// ------------------------------------------------------------- settings and saved state
const DEF = { type: 'cash', jacoby: true, beavers: true, length: 7, ply: 3, showBot: true, autoBear: true, autoRoll: true,
  autoForced: true, autoDone: false, pips: true, swapColour: false, mirror: false, speed: 'normal', workers: 4 };
const S = { set: { ...DEF }, sess: null, match: null, game: null, saved: [], ui: { view: null, anim: null, menu: null, botOpen: false, toastT: 0 } };
const KEY = 'bgplay-v1';
function save() {
  try {
    const G0 = window.BQ && BQ.on ? BQ.realGame() : S.game;     // the Blunder Quiz borrows the board: its game isn't kept
    const g = G0 ? { ...G0, decisions: G0.decisions.map(stripDec), takeDec: G0.takeDec && stripDec(G0.takeDec) } : null;
    localStorage.setItem(KEY, JSON.stringify({ set: S.set, sess: S.sess, match: S.match, game: g, saved: S.saved }));
  } catch (e) { /* storage full or blocked: the game still runs */ }
}
const stripDec = (d) => { const { _p, ...rest } = d; return rest; };
function load() {
  try {
    const x = JSON.parse(localStorage.getItem(KEY) || 'null'); if (!x) return;
    S.set = { ...DEF, ...(x.set || {}) }; S.sess = x.sess || null; S.match = x.match || null; S.game = x.game || null; S.saved = x.saved || [];
  } catch (e) { /* unreadable: start fresh */ }
}

// ------------------------------------------------------------- engine: a pool of workers with two priorities
class Pool {
  constructor(n) { this.n = n; this.workers = []; this.idle = []; this.hi = []; this.lo = []; this.bg = []; this.cbs = {}; this.seq = 0; }
  async init(weights, manifest) {
    const inits = [];
    for (let i = 0; i < this.n; i++) {
      const w = new Worker('worker.js');
      w.onmessage = (ev) => {
        const m = ev.data, cb = this.cbs[m.id]; delete this.cbs[m.id];
        if (!this.idle.includes(w)) this.idle.push(w);
        this.pump(); if (cb) cb(m);
      };
      w.onerror = (e) => { console.error('worker error', e.message); };
      this.workers.push(w);
      inits.push(new Promise((res) => { const id = ++this.seq; this.cbs[id] = res; w.postMessage({ id, cmd: 'init', weights: weights.slice(0), manifest }); }));
    }
    const rs = await Promise.all(inits);
    for (const r of rs) if (!r.ok) throw new Error(r.error);
  }
  // Three queues: hi (Open Sage's moves, what you wait for), lo (your decisions' analysis while you think), bg (progress
  // tracking, only when nothing else waits).
  run(msg, prio) { return new Promise((res) => { (prio === 'lo' ? this.lo : prio === 'bg' ? this.bg : this.hi).push([msg, res]); this.pump(); }); }
  all(msg) { return Promise.all(this.workers.map((w) => new Promise((res) => { this.idle = this.idle.filter((x) => x !== w); const id = ++this.seq; this.cbs[id] = res; w.postMessage({ ...msg, id }); }))); }
  pump() {
    while (this.idle.length && (this.hi.length || this.lo.length || this.bg.length)) {
      const w = this.idle.shift(), [msg, res] = (this.hi.length ? this.hi : this.lo.length ? this.lo : this.bg).shift();
      const id = ++this.seq; this.cbs[id] = res; w.postMessage({ ...msg, id });
    }
  }
  // Stops the workers; every job queued or running ends as 'cancelled' (callers redo it after a restart).
  terminate() {
    this.workers.forEach((w) => w.terminate()); [...this.hi, ...this.lo, ...this.bg].forEach(([, res]) => res({ ok: false, error: 'cancelled' })); this.hi = []; this.lo = []; this.bg = [];
    const cbs = this.cbs; this.cbs = {}; Object.values(cbs).forEach((cb) => cb({ ok: false, error: 'cancelled' }));
  }
}
const ENG = { pool: null, state: 'loading', msg: 'Loading the engine…', weights: null, manifest: null };
async function loadEngine() {
  try {
    ENG.manifest = await (await fetch('manifest.json')).json();
    const resp = await fetch('weights-bundle.wasm'); const total = ENG.manifest.total;
    if (!resp.ok) throw new Error('weights: HTTP ' + resp.status);
    const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
    if (!reader) ENG.weights = await resp.arrayBuffer();
    else {
      const u8 = new Uint8Array(total); let got = 0, last = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; u8.set(value, got); got += value.length;
        if (performance.now() - last > 200) { last = performance.now(); ENG.msg = `Loading the engine: ${(got / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB`; renderSide(); } }
      ENG.weights = u8.buffer;
    }
    await startPool();
  } catch (e) { ENG.state = 'error'; ENG.msg = 'The engine failed to load: ' + (e.message || e); renderSide(); }
}
let poolGen = 0;
async function startPool() {
  const my = ++poolGen;
  if (ENG.pool) { ENG.pool.terminate(); ENG.pool = null; }    // jobs sent meanwhile fail as 'engine not ready' and are redone
  ENG.state = 'loading'; ENG.msg = 'Starting the engine…'; renderSide();
  const p = new Pool(S.set.workers); await p.init(ENG.weights, ENG.manifest);
  if (my !== poolGen) { p.terminate(); return; }              // a later start, or a review that opened meanwhile, wins
  ENG.pool = p; ENG.state = 'ready'; ENG.msg = '';
  const gm = window.BQ && BQ.on ? BQ.realGame() : S.game;
  if (gm) { hidden(gm, '_curDec', null); hidden(gm, '_cubePre', null); if (gm.phase !== 'over') for (const d of gm.decisions) if (!d.res) analyzeDecision(d, 'lo'); }
  if (window.BQ && BQ.on) BQ.restarted();
  renderSide(); drive();
  if (window.PG) PG.kick();                          // progress tracking carries on in the background
}
const stopped = (e) => /^(cancelled|engine not ready)$/.test(String((e && e.message) || e));
async function job(msg, prio = 'hi') {
  if (!ENG.pool) throw new Error('engine not ready');
  const r = await ENG.pool.run(msg, prio); if (!r.ok) throw new Error(r.error); return r.result;
}

// ------------------------------------------------------------- the XG opening book (turns 1-2 of your ER only)
// The BG Position Analyzer's book.json (the BG Opening Trainer's data): page OJ / ON / O<a>-<b>[C] for the opening
// roll, the 34 reply pages for turn 2; only with the cube centred at 1. The offline app keeps a copy pasted from the tile.
let BOOK = null;
async function loadBook() {
  try {
    if (TARGET === 'tile') { const r = await fetch('book.json'); if (r.ok) { const b = await r.json(); BOOK = { open: b.open, dropped: b.dropped, reply: b.reply }; } }
    else { const s = localStorage.getItem('bgplay-book'); if (s) BOOK = await unpackJson(s); }
  } catch (e) { BOOK = null; }
}
const encK = (n, up) => (n === 0 ? '-' : String.fromCharCode((up ? 64 : 96) + n));
function posKey(b) { let s = encK(b[0], false); for (let p = 1; p <= 24; p++) s += b[p] > 0 ? encK(b[p], true) : encK(-b[p], false); return s + encK(b[25], true); }
function bookApply(b, mv) {
  const a = b.slice();
  for (let tok of mv.replace(/\*/g, '').trim().split(/\s+/)) {
    if (!tok) continue; let rep = 1; const m = tok.match(/^(.+)\((\d)\)$/); if (m) { tok = m[1]; rep = +m[2]; }
    const pts = tok.split('/').map((x) => (x === 'bar' ? 25 : x === 'off' ? 0 : parseInt(x, 10)));
    for (let r = 0; r < rep; r++) for (let i = 0; i + 1 < pts.length; i++) { const fr = pts[i], to = pts[i + 1]; a[fr]--; if (to) { if (a[to] === -1) { a[to] = 0; a[0]++; } a[to]++; } }
  }
  return a;
}
function openingPage(rules, score) {
  if (rules.type !== 'match') return rules.jacoby ? 'OJ' : 'ON';
  const a = rules.length - score.me, b = rules.length - score.bot;
  if (Math.max(a, b) > 5) return 'ON';
  const craw = score.crawford && (a === 1 || b === 1) && !(a === 1 && b === 1);
  return `O${a}-${b}${craw ? 'C' : ''}`;
}
// The book's plays for your turn 1 or 2 (board: your view, you on roll), or null.
function bookFor(d) {
  if (!BOOK || d.cube.value !== 1 || d.cube.owner !== 0 || d.turn > 2) return null;
  const k = `${Math.max(...d.dice)}${Math.min(...d.dice)}`;
  let rows = null, page = null;
  if (R.same(d.board, R.START)) {
    if (d.dice[0] === d.dice[1]) return null;
    page = openingPage(d.rules, d.score);
    if ((BOOK.dropped[page] || []).includes(k)) return null;
    rows = (BOOK.open[page] || {})[k];
  } else { const e = BOOK.reply[posKey(d.board)]; if (e) { page = e[0]; rows = e[2][k]; } }
  if (!rows || !rows.length) return null;
  const plays = rows.map(([mv, e]) => ({ mv, b: bookApply(d.board, mv), eq: e / 10000, err: (rows[0][1] - e) / 10000 }));
  return { page, plays };
}

// ------------------------------------------------------------- the game's context for the engine
const other = (s) => (s === 'me' ? 'bot' : 'me');
const sideBoard = (gm, side) => (side === 'me' ? gm.board.slice() : R.flip(gm.board));
// The engine's context for `side` ('me' | 'bot'): cube value and owner (0 centred, 1 that side, 2 the other), rules, away scores.
function gOf(r, score, crawford, c, side) {
  const co = c.owner === 0 ? 0 : c.owner === side ? 1 : 2;
  if (r.type === 'cash') return { cv: c.value, co, jac: r.jacoby ? 1 : 0, bea: r.beavers ? 1 : 0, a1: 0, a2: 0, cr: 0 };
  const mine = side === 'me' ? score.me : score.bot, theirs = side === 'me' ? score.bot : score.me;
  return { cv: c.value, co, jac: 0, bea: 0, a1: r.length - mine, a2: r.length - theirs, cr: crawford ? 1 : 0 };
}
const gFor = (gm, side) => gOf(gm.rules, gm.score, gm.crawford, gm.cube, side);
const matchCtx = (gm) => ({ crawfordGame: !!gm.crawford, score: gm.score || { me: 0, bot: 0 } });
const canDbl = (gm, side) => R.canDouble(side, gm.cube, gm.rules, matchCtx(gm));
const beaversOn = (gm) => gm.rules.type === 'cash' && gm.rules.beavers;
const botName = (ply) => `OpenSage-${ply}ply`;

// ------------------------------------------------------------- analysis: ranked plays and cube decisions
const LEVELS = [{ ply: 2, keep: 16, margin: 0.20 }, { ply: 3, keep: 8, margin: 0.12 }, { ply: 4, keep: 4, margin: 0.06 }];
// All legal plays at 1-ply, then the best ones at 2, 3 and 4 ply up to `ply` (the analyzer's schedule). `extra`: boards that
// are evaluated at every depth too (the played move, the book's best). Returns {plays, top, depth}: top = the plays that
// reached the deepest depth, best first.
async function rank(board, d1, d2, g, ply, prio, extra = []) {
  const ms = await job({ cmd: 'moves', board, d1, d2, g }, prio);
  const plays = ms.map((m) => ({ b: m.b, e: { 1: m.e }, p: { 1: m.p } }));
  let cur = plays.slice(), lv = 1;
  if (plays.length > 1) for (const L of LEVELS) {
    if (L.ply > ply) break;
    const best = cur[0].e[lv];
    const cands = cur.filter((c, i) => i < 2 || best - c.e[lv] <= L.margin).slice(0, L.keep);
    for (const x of extra) { const c = plays.find((p) => R.same(p.b, x)); if (c && !cands.includes(c)) cands.push(c); }
    await Promise.all(cands.map((c) => job({ cmd: 'eval', board, cand: c.b, ply: L.ply, g }, prio).then((r) => { c.e[L.ply] = r.e; c.p[L.ply] = r.p; })));
    lv = L.ply; cur = cands.sort((a, b) => b.e[lv] - a.e[lv]);
  }
  return { plays, top: cur, depth: lv };
}
const cubeEval = (board, ply, g, prio = 'hi') => job({ cmd: 'cube', board, ply, g }, prio);
const deepest = (c) => Math.max(...Object.keys(c.e).map(Number));

// Your decisions, analysed at 4-ply in the background (book for turns 1-2); 3-ply before 2026-11-25, when the user moved
// the project's reviews to a 4-ply screen. The auto-bearoff checks stay at 3-ply so that those rolls keep moving quickly.
// Kinds: M checker play; R rolled without doubling (with access to the cube); D doubled; T took, P passed, B beavered
// (board: the doubler's view).
const ER_PLY = 4, AUTO_PLY = 3, WINDOW = 0.200, FLAT = 0.001, LOW = -0.900;
// The ranking of a roll at `ply` (shared by the decision and the auto-bearoff check; started while you think).
function hidden(o, k, v) { Object.defineProperty(o, k, { value: v, enumerable: false, writable: true, configurable: true }); return v; }
function moveRank(d, prio, ply = ER_PLY) {
  const k = '_rk' + (ply === ER_PLY ? '' : ply);
  if (!d[k]) { const bk = bookFor(d), p = rank(d.board, d.dice[0], d.dice[1], d.g, ply, prio, bk ? [bk.plays[0].b] : []); p.catch(() => {}); hidden(d, k, p); }
  return d[k];
}
async function evalAt(c, d, plies, prio) {
  await Promise.all(plies.filter((ply) => c.e[ply] == null).map((ply) => job({ cmd: 'eval', board: d.board, cand: c.b, ply, g: d.g }, prio).then((x) => { c.e[ply] = x.e; c.p[ply] = x.p; })));
}
// Best minus worst over every legal play: at `ply` where the plays reached it, else at 2-ply over all of them (er.py's
// 0.001 test: a roll whose plays all lie within 0.001 is no decision).
async function playSpread(r, d, prio, ply = ER_PLY) {
  const at3 = r.plays.filter((p) => p.e[ply] != null).map((p) => p.e[ply]);
  let spread = Math.max(...at3) - Math.min(...at3);
  if (spread < FLAT && r.plays.length > at3.length) {
    await Promise.all(r.plays.map((c) => evalAt(c, d, [2], prio)));
    const v = r.plays.map((p) => p.e[2]); spread = Math.max(...v) - Math.min(...v);
  }
  return r.plays.length > 1 ? spread : 0;
}
function analyzeDecision(d, prio = 'lo') {
  if (d.res) return Promise.resolve(d.res);
  if (d._p) return d._p;
  return hidden(d, '_p', (async () => {
    try {
      if (d.k === 'M') {
        const bk = bookFor(d), r = await moveRank(d, prio);
        const played = r.plays.find((p) => R.same(p.b, d.after));
        await evalAt(played, d, [2, ER_PLY], prio);
        const at3 = r.plays.filter((p) => p.e[ER_PLY] != null).sort((a, b) => b.e[ER_PLY] - a.e[ER_PLY]), best = at3[0];
        let cost = Math.max(0, best.e[ER_PLY] - played.e[ER_PLY]), bestB = best.b, src = ER_PLY + '-ply';
        let spread = await playSpread(r, d, prio);
        if (bk && bk.plays.every((x) => r.plays.some((p) => R.same(p.b, x.b)))) {
          const listed = bk.plays.find((x) => R.same(x.b, d.after)), worst = bk.plays[bk.plays.length - 1].err;
          const bb = r.plays.find((p) => R.same(p.b, bk.plays[0].b));
          cost = listed ? listed.err : Math.max(worst, bb.e[ER_PLY] - played.e[ER_PLY]);
          bestB = bk.plays[0].b; src = `XG book ${bk.page}`; spread = Math.max(spread, FLAT);
        }
        const cands = at3.slice(0, 5).map((c) => ({ b: c.b, e: c.e[ER_PLY], name: R.notation(d.board, c.b, d.dice[0], d.dice[1]) }));
        d.res = { cost, counted: r.plays.length > 1 && spread >= FLAT, spread, best: R.notation(d.board, bestB, d.dice[0], d.dice[1]), bestB, src, cands,
          playedE: played.e[ER_PLY], n: r.plays.length, ply: ER_PLY };
      } else if (d.k === 'R' || d.k === 'D') {
        const c = await (d._c || cubeEval(d.board, ER_PLY, d.g, prio)), nd = c.equity_nd, dt = c.equity_dt, dp = c.equity_dp;
        const doubled = Math.min(dt, dp), best = Math.max(nd, doubled);
        const cost = d.k === 'R' ? best - nd : best - doubled;
        let why = '';
        if (d.k === 'R') {
          if (Math.abs(nd - doubled) < 0.0005) why = 'optional double'; else if (nd - dt > WINDOW) why = 'obvious no double';
          else if (nd - dp > WINDOW) why = 'obvious too good'; else if (nd < LOW && dt < LOW) why = 'very negative';
        }
        const bestAct = doubled > nd + 1e-9 ? 'Double' : 'No double';
        d.res = { cost: Math.max(0, cost), counted: !why, why, nd, dt, dp, beaver: c.is_beaver, best: bestAct, probs: c.probs, ply: d._c3 ? AUTO_PLY : ER_PLY };
      } else {
        const c = await (d._c || cubeEval(d.board, ER_PLY, d.g, prio)), DT = c.is_beaver ? c.equity_dt / 2 : c.equity_dt;
        const E = { P: -c.equity_dp, T: -DT, B: d.g.bea ? -2 * DT : -Infinity };
        const best = Math.max(E.P, E.T, E.B), bestAct = best === E.B ? 'Beaver' : best === E.T ? 'Take' : 'Pass';
        d.res = { cost: Math.max(0, best - E[d.k]), counted: true, E, best: bestAct, nd: c.equity_nd, dt: c.equity_dt, dp: c.equity_dp, beaver: c.is_beaver, probs: c.probs, ply: ER_PLY };
      }
    } catch (e) {
      if (stopped(e)) { hidden(d, '_p', null); for (const k of ['_rk', '_rk' + AUTO_PLY, '_c']) if (d[k]) hidden(d, k, null); return null; }   // redone after the restart
      d.res = { cost: 0, counted: false, err: String(e.message || e) };
    }
    return d.res;
  })());
}
function computeER(decs) {
  const rows = decs.filter((d) => d.res && d.res.counted);
  const n = rows.length, total = rows.reduce((a, d) => a + d.res.cost, 0), cube = rows.filter((d) => d.k !== 'M').reduce((a, d) => a + d.res.cost, 0);
  const er = n ? (total * 500) / n : 0;
  const skipped = {}; decs.filter((d) => d.res && !d.res.counted).forEach((d) => { const w = d.k === 'M' ? (d.res.n > 1 ? 'all plays within 0.001' : 'forced') : d.res.why || 'other'; skipped[w] = (skipped[w] || 0) + 1; });
  return { er, n, total, cube, checker: total - cube, nMoves: rows.filter((d) => d.k === 'M').length, nCube: rows.filter((d) => d.k !== 'M').length, skipped,
    errors: rows.filter((d) => d.res.cost >= 0.0005).sort((a, b) => b.res.cost - a.res.cost) };
}

// ------------------------------------------------------------- the game
let driveToken = 0, busy = false;
function newGameObj(n) {
  const rules = S.set.type === 'match' && S.match ? { type: 'match', length: S.match.length } : { type: 'cash', jacoby: S.set.jacoby, beavers: S.set.beavers };
  const ply = S.set.type === 'match' && S.match ? S.match.ply : S.set.ply;
  return { id: uid(), n, rules, ply, score: S.match && rules.type === 'match' ? { ...S.match.score } : { me: 0, bot: 0 },
    crawford: !!(S.match && rules.type === 'match' && S.match.crawfordNext), board: R.START.slice(), cube: { value: 1, owner: 0 },
    phase: 'opening', onRoll: null, dice: null, opening: null, turnNo: 0, turnSt: null, events: [], decisions: [], botLog: [], last: null,
    offer: null, resign: null, declined: {}, result: null, er: null, started: Date.now() };
}
function startCash(fresh) {
  if (fresh || !S.sess || S.sess.rules.jacoby !== S.set.jacoby || S.sess.rules.beavers !== S.set.beavers) S.sess = { id: uid(), started: Date.now(), rules: { jacoby: S.set.jacoby, beavers: S.set.beavers }, games: [], tally: 0 };
  leaveMatch(); S.match = null; S.set.type = 'cash';
  S.game = newGameObj(S.sess.games.length + 1); S.ui.view = null; S.ui.home = false; save(); resetCaches(); drive();
}
function startMatch() {
  leaveMatch();
  S.match = { id: uid(), started: Date.now(), length: S.set.length, ply: S.set.ply, score: { me: 0, bot: 0 }, crawfordNext: false, crawfordUsed: false, games: [], over: false };
  S.set.type = 'match'; S.game = newGameObj(1); S.ui.view = null; S.ui.home = false; save(); resetCaches(); drive();
}
function nextGame() {
  if (S.set.type === 'match' && S.match && !S.match.over) { S.game = newGameObj(S.match.games.length + 1); }
  else if (S.set.type === 'cash') { startCash(false); return; }
  else { startMatch(); return; }
  S.ui.view = null; S.ui.home = false; save(); resetCaches(); drive();
}
// The start screen's Continue the match, whatever the menu's game type says by now.
function continueMatch() { if (S.match && !S.match.over) { S.set.type = 'match'; nextGame(); } }
// A match left unfinished for a new cash game or match. The tile has each game's progress record from when it ended;
// the offline app keeps a match for the tile when it ends, so it keeps the games played in this one now.
function leaveMatch() {
  const M = S.match; if (!M || M.over || !M.games.length) return;
  if (TARGET === 'pwa' && window.PG && PG.keepMatch) PG.keepMatch(M);
}
// Home: the start screen from the end of a game (the user's request, 2026-11-27: a way back to pick a cash game, a
// match or the Blunder Quiz). The finished game stays S.game behind it, so its ER and its progress record finish as
// they would on the end panel, and Back returns to that panel; the board shows the starting position. Not kept
// across a reload.
const atHome = () => !!(S.ui.home && !(S.game && S.game.quiz));
function goHome(on = true) { S.ui.home = !!(on && S.game && S.game.phase === 'over'); S.ui.view = null; renderAll(); }
async function resetCaches() { if (ENG.pool) try { await ENG.pool.all({ cmd: 'reset' }); } catch (e) { /* ignore */ } }
function getTurn() {
  const gm = S.game, ts = gm.turnSt;
  if (!ts) return null;
  if (!ts.obj) {
    const t = new R.Turn(gm.board, gm.dice[0], gm.dice[1]); t.order = ts.order.slice();
    for (const s of ts.steps) { const m = t.allowed(s.from, s.die); if (!m) break; t.apply(m); }
    Object.defineProperty(ts, 'obj', { value: t, enumerable: false, writable: true });
  }
  return ts.obj;
}
const syncTurn = (t) => { const ts = S.game.turnSt; ts.order = t.order.slice(); ts.steps = t.steps.map((s) => ({ from: s.from, to: s.to, die: s.die, hit: s.hit })); };
function addDec(d) {
  const gm = S.game;
  const dec = { ...d, rules: gm.rules, score: { me: gm.score.me, bot: gm.score.bot, crawford: gm.crawford }, cube: { ...gm.cube } };
  if (d._c) hidden(dec, '_c', d._c);
  if (d._rk) hidden(dec, '_rk', d._rk);
  gm.decisions.push(dec); analyzeDecision(dec, 'lo').then(() => { save(); if (gm.phase === 'over') finishER(); });
  return dec;
}
function drive() {
  const gm = S.game; renderAll();
  if (!gm || gm.quiz || ENG.state !== 'ready' || busy) return;      // the quiz's positions wait for you
  const token = ++driveToken;
  if (gm.phase === 'over') { finishER(); return; }
  if (gm.phase === 'opening') return openingRoll(token);
  if (gm.phase === 'offer') return gm.offer.by === 'me' ? botAnswerDouble(token) : null;
  if (gm.phase === 'resign') return gm.resign.by === 'me' ? botAnswerResign(token) : null;
  if (gm.onRoll === 'bot') return gm.phase === 'preroll' ? botPreroll(token) : botMove(token);
  return gm.phase === 'preroll' ? userPreroll(token) : userMoveStart(token);
}
const live = (token) => token === driveToken;
const delay = () => ({ normal: 1, fast: 0.45, off: 0 })[S.set.speed] ?? 1;

async function openingRoll(token) {
  const gm = S.game;
  for (;;) {
    gm.opening = { me: rollDie(), bot: rollDie() }; renderAll(); await sleep(900 * delay() + 150); if (!live(token)) return;
    if (gm.opening.me !== gm.opening.bot) break;
    toast(`Both rolled ${gm.opening.me}: rolling again`); await sleep(700 * delay() + 100); if (!live(token)) return;
  }
  const { me, bot } = gm.opening;
  gm.onRoll = me > bot ? 'me' : 'bot'; gm.dice = me > bot ? [me, bot] : [bot, me]; gm.turnNo = 1; gm.phase = 'move';
  if (gm.onRoll === 'me') gm.turnSt = { order: gm.dice.slice(), steps: [] };
  gm.opening.done = true; save(); drive();
}
// ---------------- your turn
// The 3-ply cube analysis of the position before your roll (started as soon as it's your turn).
function cubePre(gm) {
  const k = gm.id + ':' + gm.turnNo;
  if (!gm._cubePre || gm._cubePre.k !== k) { const p = cubeEval(gm.board.slice(), ER_PLY, gFor(gm, 'me'), 'lo'); p.catch(() => {}); hidden(gm, '_cubePre', { k, p }); }
  return gm._cubePre.p;
}
async function userPreroll(token) {
  const gm = S.game;
  if (gm.autoRollOn) return userRoll(true);         // the Auto-roll switch: every turn rolled for you, no doubling
  // "Roll for me when I can't double" rolls only when doubling isn't possible: Open Sage owns the cube, the Crawford
  // game, or a match cube already worth the match. With the cube in reach the turn waits for Roll or Double, even when
  // doubling would be a mistake (the user's rule, 2026-11-26; auto-bearoff used to roll then).
  if (!canDbl(gm, 'me')) { if (S.set.autoRoll) userRoll(); else renderAll(); return; }
  cubePre(gm);                                       // the 4-ply analysis of this cube decision (for the ER) starts now
  renderAll();
}
function userRoll(auto) {
  const gm = S.game; if (!gm || gm.phase !== 'preroll' || gm.onRoll !== 'me') return;
  if (canDbl(gm, 'me')) { const d = { k: 'R', turn: gm.turnNo + 1, board: gm.board.slice(), g: gFor(gm, 'me'), auto: !!auto }; hidden(d, '_c', cubePre(gm)); addDec(d); }
  gm.dice = rollPair(); gm.turnNo++; gm.phase = 'move'; gm.turnSt = { order: gm.dice.slice(), steps: [] }; save(); drive();
}
async function playSeq(t, seq) {
  busy = true;
  try { for (const s of seq) { const m = t.allowed(s.from, s.die); if (!m) break; await animateUser(m); t.apply(m); syncTurn(t); renderAll(); } }
  finally { busy = false; }
}
async function userMoveStart(token) {
  const gm = S.game, t = getTurn(); if (!t) return;
  if (t.max === 0) {
    status(`You rolled ${gm.dice[0]}-${gm.dice[1]}: no legal move`); renderAll(); await sleep(1300 * delay() + 300); if (!live(token)) return;
    return finishUserMove(t);
  }
  if (t.L.size === 1 && S.set.autoForced && !t.steps.length) {
    await sleep(350 * delay()); if (!live(token)) return;
    await playSeq(t, [...t.L.values()][0].seq); if (!live(token)) return;
    return finishUserMove(t);
  }
  const dec = curMoveDec(), rk = moveRank(dec, 'lo');
  if (S.set.autoBear && R.noContact(gm.board) && R.allHome(gm.board) && !t.steps.length) {
    const gp = greedyPlay(t);
    if (gp) {
      renderAll(); await sleep(350 * delay()); if (!live(token) || gm.phase !== 'move' || t.steps.length) return;
      await playSeq(t, gp.seq); if (!live(token)) return;
      if (t.done) return finishUserMove(t, true);
      return renderAll();
    }
    renderAll();
    let r, spread; try { r = await moveRank(dec, 'hi', AUTO_PLY); spread = await playSpread(r, dec, 'hi', AUTO_PLY); } catch (e) { r = null; }
    if (!live(token) || gm.phase !== 'move' || t.steps.length) return;
    if (r && spread < FLAT) {
      const best = r.plays.filter((p) => p.e[AUTO_PLY] != null).sort((a, b) => b.e[AUTO_PLY] - a.e[AUTO_PLY])[0] || r.plays[0];
      const play = t.L.get(R.key(best.b)) || [...t.L.values()][0];
      await playSeq(t, play.seq); if (!live(token)) return;
      return finishUserMove(t, true);
    }
  }
  renderAll();
}
// Greedy bear-off (the auto-bearoff setting, 2026-11-25): with no contact and all your checkers home, the play that
// takes off two checkers (four with doubles, or every one that's left) when the roll can and only one board does;
// else null and the roll waits for you, unless every play is within 0.001 at 3-ply (the earlier rule, kept). In 800
// bear-off rolls from races Open Sage played out, the greedy play was its 4-ply best every time.
function greedyPlay(t) {
  const left = R.counts(t.start).me, want = Math.min(t.doubles ? 4 : 2, left);
  const hits = [...t.L.values()].filter((e) => left - R.counts(e.board).me === want);
  return hits.length === 1 ? hits[0] : null;
}
// The decision record for the roll you're playing (its ranking starts while you think).
function curMoveDec() {
  const gm = S.game, k = gm.id + ':' + gm.turnNo;
  if (!gm._curDec || gm._curDec.key !== k) {
    hidden(gm, '_curDec', { key: k, d: { k: 'M', turn: gm.turnNo, board: gm.board.slice(), dice: gm.dice.slice(), g: gFor(gm, 'me'), rules: gm.rules,
      score: { me: gm.score.me, bot: gm.score.bot, crawford: gm.crawford }, cube: { ...gm.cube } } });
  }
  return gm._curDec.d;
}
function finishUserMove(t, auto) {
  if (S.game && S.game.quiz) return window.BQ && BQ.moveDone(t);     // a quiz answer, not a game move
  const gm = S.game, before = gm.board.slice(), after = t.board.slice();
  gm.events.push({ side: 1, type: 'roll', dice: gm.dice.slice(), steps: t.steps.map((s) => [s.from, s.to]) });
  const name = R.notation(before, after, gm.dice[0], gm.dice[1]);
  if (t.L.size > 1) {
    const base = curMoveDec(), dec = { ...base, after, played: name, auto: !!auto };
    if (base._rk) hidden(dec, '_rk', base._rk);
    gm.decisions.push(dec);
    analyzeDecision(dec, 'lo').then(() => { save(); if (gm.phase === 'over') finishER(); });
  }
  gm.last = { who: 'me', before, after, dice: gm.dice.slice(), steps: t.steps.map((s) => [s.from, s.to, s.hit]), name };
  gm.board = after; gm.dice = null; gm.turnSt = null;
  const fin = R.finished(gm.board);
  if (fin) return endGame(fin.won > 0 ? 'me' : 'bot', R.pointsFor(fin.kind, gm.cube, gm.rules), 'played', fin.kind);
  gm.onRoll = 'bot'; gm.phase = 'preroll'; save(); drive();
}
function userDouble() {
  const gm = S.game; if (!gm || gm.phase !== 'preroll' || gm.onRoll !== 'me' || !canDbl(gm, 'me')) return;
  addDec({ k: 'D', turn: gm.turnNo + 1, board: gm.board.slice(), g: gFor(gm, 'me') });
  gm.offer = { by: 'me', value: gm.cube.value * 2 }; gm.phase = 'offer';
  gm.events.push({ side: 1, type: 'double', value: gm.offer.value }); save(); drive();
}
function userAnswer(ans) {      // 'T' take, 'P' pass, 'B' beaver
  const gm = S.game; if (!gm || gm.phase !== 'offer' || gm.offer.by !== 'bot') return;
  if (ans === 'B' && !beaversOn(gm)) return;
  const td = { ...gm.takeDec, k: ans }; if (gm.takeDec._c) hidden(td, '_c', gm.takeDec._c); addDec(td);
  gm.takeDec = null;
  const v = gm.cube.value;
  if (ans === 'P') { gm.events.push({ side: 1, type: 'drop' }); gm.offer = null; return endGame('bot', v, 'drop', 1); }
  if (ans === 'T') { gm.cube = { value: v * 2, owner: 'me' }; gm.events.push({ side: 1, type: 'take' }); }
  else { gm.cube = { value: v * 4, owner: 'me' }; gm.events.push({ side: 1, type: 'beaver', value: v * 4 }); }
  gm.offer = null; gm.phase = 'preroll'; gm.onRoll = 'bot'; gm.skipCube = true; save(); drive();
}
function userResign(kind) {
  const gm = S.game; if (!gm || gm.onRoll !== 'me' || !(gm.phase === 'preroll' || gm.phase === 'move')) return;
  gm.resign = { by: 'me', kind, back: gm.phase }; gm.phase = 'resign'; closeMenu(); save(); drive();
}
function userAnswerResign(accept) {
  const gm = S.game; if (!gm || gm.phase !== 'resign' || gm.resign.by !== 'bot') return;
  const k = gm.resign.kind;
  if (accept) { gm.resign = null; return endGame('me', R.pointsFor(k, gm.cube, gm.rules), 'resign', k); }
  gm.declined[k] = true; gm.resign = null; gm.phase = 'preroll'; gm.skipResign = true; save(); drive();
}
// ---------------- Open Sage's turn
async function botPreroll(token) {
  const gm = S.game, bb = sideBoard(gm, 'bot'), g = gFor(gm, 'bot'), can = canDbl(gm, 'bot') && !gm.skipCube;
  status('Open Sage is thinking…'); renderAll();
  let c;
  try { c = await cubeEval(bb, can ? gm.ply : Math.min(2, gm.ply), g); } catch (e) { return engineFail(e); }
  if (!live(token)) return;
  const skipR = gm.skipResign; gm.skipResign = false; gm.skipCube = false;
  if (!skipR) {
    const kind = botResignKind(c.probs, gm);
    if (kind && !gm.declined[kind]) { gm.resign = { by: 'bot', kind }; gm.phase = 'resign'; save(); renderAll(); return; }
  }
  if (can) {
    gm.botLog.push({ kind: 'cube', turn: gm.turnNo + 1, ply: gm.ply, c: slimCube(c) });
    if (c.should_double) {
      gm.offer = { by: 'bot', value: gm.cube.value * 2 }; gm.phase = 'offer';
      gm.events.push({ side: 2, type: 'double', value: gm.offer.value });
      gm.takeDec = { turn: gm.turnNo + 1, board: bb, g };
      { const p = cubeEval(bb, ER_PLY, g, 'lo'); p.catch(() => {}); hidden(gm.takeDec, '_c', p); }   // your take decision, analysed while you think
      save(); renderAll(); return;
    }
  }
  botRoll();
}
const slimCube = (c) => ({ nd: c.equity_nd, dt: c.equity_dt, dp: c.equity_dp, action: c.optimal_action, beaver: c.is_beaver, double: c.should_double, take: c.should_take, probs: c.probs });
// Open Sage resigns when it has no chance to win: a single when it can't lose a gammon that counts, else a gammon or a
// backgammon when that is certain.
function botResignKind(p, gm) {
  if (!p || p[0] > 0.0005) return null;
  const jac = gm.rules.type === 'cash' && gm.rules.jacoby && gm.cube.owner === 0 && gm.cube.value === 1;
  const matchOver = gm.rules.type === 'match' && gm.score.me + gm.cube.value >= gm.rules.length;
  if (jac || matchOver || p[3] < 0.0005) return 1;
  if (p[4] < 0.0005 && p[3] > 0.9995) return 2;
  if (p[4] > 0.9995) return 3;
  return null;
}
function botRoll() {
  const gm = S.game; gm.dice = rollPair(); gm.turnNo++; gm.phase = 'move'; save(); drive();
}
async function botMove(token) {
  const gm = S.game, bb = sideBoard(gm, 'bot'), [d1, d2] = gm.dice, g = gFor(gm, 'bot');
  const lp = R.legalPlays(bb, d1, d2);
  let chosen = bb, seq = [];
  status(`Open Sage rolled ${Math.max(d1, d2)}-${Math.min(d1, d2)}`); renderAll();
  const t0 = performance.now();
  if (lp.max > 0) {
    if (lp.plays.size === 1) { const only = [...lp.plays.values()][0]; chosen = only.board; seq = only.seq; }
    else {
      let r; try { r = await rank(bb, d1, d2, g, gm.ply, 'hi'); } catch (e) { return engineFail(e); }
      if (!live(token)) return;
      chosen = r.top[0].b; seq = lp.plays.get(R.key(chosen)).seq;
      gm.botLog.push({ kind: 'move', turn: gm.turnNo, dice: [d1, d2], ply: gm.ply, depth: r.depth, n: r.plays.length, ms: Math.round(performance.now() - t0),
        list: r.top.slice(0, 8).map((c) => ({ name: R.notation(bb, c.b, d1, d2), e: c.e[deepest(c)], lv: deepest(c), p: c.p[deepest(c)] })) });
    }
  }
  const wait = Math.max(0, 450 * delay() - (performance.now() - t0)); if (wait) await sleep(wait); if (!live(token)) return;
  busy = true;
  try { await animateBot(bb, seq); } finally { busy = false; }
  if (!live(token)) return;
  gm.events.push({ side: 2, type: 'roll', dice: [d1, d2], steps: seq.map((s) => [s.from, s.to]) });
  gm.last = { who: 'bot', before: bb, after: chosen, dice: [d1, d2], steps: seq.map((s) => [s.from, s.to, s.hit]), name: lp.max ? R.notation(bb, chosen, d1, d2) : 'no move' };
  gm.board = R.flip(chosen); gm.dice = null;
  const fin = R.finished(gm.board);
  if (fin) return endGame(fin.won > 0 ? 'me' : 'bot', R.pointsFor(fin.kind, gm.cube, gm.rules), 'played', fin.kind);
  gm.onRoll = 'me'; gm.phase = 'preroll'; save(); drive();
}
async function botAnswerDouble(token) {
  const gm = S.game, ub = sideBoard(gm, 'me'), g = gFor(gm, 'me');
  status('Open Sage is thinking about your double…'); renderAll();
  let c; try { c = await cubeEval(ub, gm.ply, g); } catch (e) { return engineFail(e); }
  if (!live(token)) return;
  const ans = !c.should_take ? 'drop' : beaversOn(gm) && c.is_beaver ? 'beaver' : 'take';
  gm.botLog.push({ kind: 'answer', turn: gm.turnNo + 1, ply: gm.ply, ans, c: slimCube(c) });
  await sleep(500 * delay()); if (!live(token)) return;
  const v = gm.cube.value;
  if (ans === 'drop') { gm.events.push({ side: 2, type: 'drop' }); gm.offer = null; toast('Open Sage passes'); return endGame('me', v, 'drop', 1); }
  if (ans === 'take') { gm.cube = { value: v * 2, owner: 'bot' }; gm.events.push({ side: 2, type: 'take' }); toast(`Open Sage takes: the cube is at ${v * 2}`); }
  else { gm.cube = { value: v * 4, owner: 'bot' }; gm.events.push({ side: 2, type: 'beaver', value: v * 4 }); toast(`Open Sage beavers: the cube is at ${v * 4}, Open Sage owns it`); }
  gm.offer = null; gm.phase = 'preroll'; gm.onRoll = 'me';
  gm.dice = rollPair(); gm.turnNo++; gm.phase = 'move'; gm.turnSt = { order: gm.dice.slice(), steps: [] };   // the doubler rolls
  save(); drive();
}
async function botAnswerResign(token) {
  const gm = S.game, k = gm.resign.kind, ub = sideBoard(gm, 'me'), g = gFor(gm, 'me');
  status('Open Sage is considering your resignation…'); renderAll();
  let c; try { c = await cubeEval(ub, gm.ply, g); } catch (e) { return engineFail(e); }
  if (!live(token)) return;
  const mine = canDbl(gm, 'me') ? c.optimal_equity : c.equity_nd;      // your equity, normalized to the cube
  const botE = -mine, p = c.probs;                                       // p: your chances (you on roll)
  let accept;
  if (gm.rules.type === 'cash') {
    const jac = gm.rules.jacoby && gm.cube.owner === 0 && gm.cube.value === 1;
    accept = (jac ? 1 : k) >= botE - 1e-9;
  } else {
    accept = botE <= 1 + 1e-9 || (p[0] < 0.0005 && (k === 3 || p[4] < 0.0005) && (k >= 2 || p[3] < 0.0005));
  }
  gm.botLog.push({ kind: 'resign', turn: gm.turnNo, ply: gm.ply, k, accept, botE });
  await sleep(400 * delay()); if (!live(token)) return;
  if (accept) { gm.resign = null; return endGame('bot', R.pointsFor(k, gm.cube, gm.rules), 'resign', k); }
  toast('Open Sage declines your resignation'); gm.phase = gm.resign.back; gm.resign = null; save(); drive();
}
function engineFail(e) { if (stopped(e)) return; status('The engine stopped: ' + (e.message || e)); renderAll(); toast('Engine error: tap Retry'); S.ui.retry = true; }
function endGame(winner, points, how, kind) {
  const gm = S.game;
  gm.result = { winner, points, how, kind }; gm.phase = 'over'; gm.dice = null; gm.turnSt = null; gm.offer = null; gm.resign = null;
  gm.events.push({ side: winner === 'me' ? 1 : 2, type: 'win', points });
  gm.ended = Date.now();
  const rec = { id: gm.id, n: gm.n, rules: gm.rules, ply: gm.ply, score: { ...gm.score }, crawford: gm.crawford, events: gm.events, result: gm.result, ended: gm.ended, er: null };
  if (gm.rules.type === 'cash') { S.sess.tally += winner === 'me' ? points : -points; S.sess.games.push(rec); }
  else {
    const M = S.match; M.score[winner] += points; M.games.push(rec);
    if (M.score.me >= M.length || M.score.bot >= M.length) { M.over = true; M.crawfordNext = false; }
    else if (!M.crawfordUsed && (M.score.me === M.length - 1 || M.score.bot === M.length - 1)) { M.crawfordNext = true; M.crawfordUsed = true; }
    else M.crawfordNext = false;
  }
  save(); renderAll(); finishER();
}
let erBusy = false;
async function finishER() {
  // the game's own match and session: a new one may start (Next game, Home) before the ER is done
  const gm = S.game, M = S.match, sess = S.sess; if (!gm || gm.phase !== 'over' || erBusy) return;
  erBusy = true;
  try {
    await Promise.all(gm.decisions.map((d) => analyzeDecision(d, 'hi')));
    if (gm.decisions.some((d) => !d.res)) return;          // the engine was stopped (a review opened): done after the restart
    gm.er = computeER(gm.decisions);
    const rec = ((gm.rules.type === 'cash' ? sess && sess.games : M && M.games) || []).find((x) => x.id === gm.id);
    if (rec) { rec.er = { er: gm.er.er, n: gm.er.n, total: gm.er.total }; rec.decs = compactDecs(gm.decisions, 1); }
    save(); renderAll();
    if (window.PG) PG.gameOver(gm, M);               // progress: the tile scores it; the offline app keeps it for the tile
  } finally {
    erBusy = false;
    if (S.game && S.game !== gm && S.game.phase === 'over' && !S.game.er && !S.game.quiz) finishER();   // a later game ended meanwhile
  }
}

// ------------------------------------------------------------- board drawing
let GEO = null;
// Portrait (the user's request, 2026-11-27): the trays leave the side of the board and run along its bottom (yours) and
// its top (Open Sage's), so the points get the side tray's width and your tray is a bigger target. Landscape keeps the
// side tray.
const portrait = () => !!(window.matchMedia && matchMedia('(orientation: portrait)').matches);
function geometry(W, H) {
  const port = portrait(), m = 3, th = port ? Math.max(24, Math.min(34, H * 0.075)) : 0, lh = Math.max(14, Math.min(20, (H - 2 * th) * 0.055));
  const pw = (W - 2 * m) / (12 + 0.85 + (port ? 0 : 0.95)), bw = pw * 0.85, tw = port ? 0 : pw * 0.95;
  const zt = (H - 2 * lh - 2 * m - 2 * th) / 10.6, r = Math.max(6, Math.min(pw * 0.47, zt * 0.5));
  const zh = Math.min(zt, 2 * r + 0.6), ph = zt * 5;
  const x0 = S.set.mirror && !port ? m + tw : m, colX = (c) => x0 + (c < 6 ? c * pw : bw + c * pw);
  const barX = x0 + 6 * pw, trayX = port ? null : S.set.mirror ? m - 2 : x0 + 12 * pw + bw, top = m + th + lh, bot = H - m - th - lh;
  // portrait trays: the strip's rows (Open Sage's at the top, yours at the bottom); the slabs stack from the home side
  const xL = x0, xR = x0 + 12 * pw + bw, sw = Math.min(13, (xR - xL - 60) / 15);
  return { W, H, m, x0, lh, pw, bw, tw, zh, ph, r, colX, barX, trayX, top, bot, mid: H / 2, port, th, xL, xR, sw,
    trayY: { bot: m, me: H - m - th } };
}
// Portrait trays: the x of the k-th borne-off slab, counted from the home side.
const slabX = (k) => (S.set.mirror ? GEO.xL + 4 + k * GEO.sw : GEO.xR - 4 - (k + 1) * GEO.sw);
const pointCol = (p) => { const r = p >= 13 ? { c: p - 13, top: true } : { c: 12 - p, top: false }; if (S.set.mirror) r.c = 11 - r.c; return r; };
const colPoint = (c, isTop) => { if (S.set.mirror) c = 11 - c; return isTop ? 13 + c : 12 - c; };
// Where the k-th checker of a stack sits. where: 1..24 a point, 'mybar' / 'botbar', 'mytray' / 'bottray'.
function spot(where, k) {
  const G = GEO, kk = Math.max(0, Math.min(4, k));
  if (where === 'mybar') return [G.barX + G.bw / 2, G.mid + barOff() + kk * G.zh * 0.55];
  if (where === 'botbar') return [G.barX + G.bw / 2, G.mid - barOff() - kk * G.zh * 0.55];
  if (G.port && (where === 'mytray' || where === 'bottray')) return [slabX(Math.min(14, k)) + G.sw / 2, G.trayY[where === 'mytray' ? 'me' : 'bot'] + G.th / 2];
  if (where === 'mytray') return [G.trayX + 2 + (G.tw - 2) / 2, G.bot - 2 - (k + 0.5) * trSlab()];
  if (where === 'bottray') return [G.trayX + 2 + (G.tw - 2) / 2, G.top + 2 + (k + 0.5) * trSlab()];
  const { c, top } = pointCol(where);
  return [G.colX(c) + G.pw / 2, top ? G.top + G.zh * (kk + 0.5) : G.bot - G.zh * (kk + 0.5)];
}
const trSlab = () => Math.min(6, (GEO.ph - 4) / 15);
const barOff = () => { const G = GEO, cs = Math.min(G.bw - 4, 24), fs = Math.min(13, G.bw * 0.4), ch = fs * 1.45; return Math.max(G.zh * 1.9, cs / 2 + 3 + ch + G.r + 2); };
function chk(cx, cy, mine, label, extra = '') {
  const G = GEO;
  let t = `<circle cx="${cx}" cy="${cy}" r="${G.r - 0.8}" fill="${mine ? 'var(--me)' : 'var(--opp)'}" stroke="${mine ? 'var(--me-edge)' : 'var(--opp-edge)'}" stroke-width="1.3" ${extra}/>`;
  if (label) t += `<text x="${cx}" y="${cy + G.r * 0.36}" font-size="${G.r * 1.05}" font-weight="700" text-anchor="middle" fill="${mine ? 'var(--me-ink)' : 'var(--opp-ink)'}">${label}</text>`;
  return t;
}
// A die in the colours of the side that rolled it (who: 'me' | 'bot').
function dieSvg(x, y, s, v, dim, who) {
  const P = { 1: [[.5, .5]], 2: [[.27, .27], [.73, .73]], 3: [[.27, .27], [.5, .5], [.73, .73]], 4: [[.27, .27], [.73, .27], [.27, .73], [.73, .73]],
    5: [[.27, .27], [.73, .27], [.5, .5], [.27, .73], [.73, .73]], 6: [[.27, .25], [.73, .25], [.27, .5], [.73, .5], [.27, .75], [.73, .75]] }[v];
  const me = who !== 'bot', fill = me ? 'var(--me)' : 'var(--opp)', edge = me ? 'var(--me-edge)' : 'var(--opp-edge)', pip = me ? 'var(--me-ink)' : 'var(--opp-ink)';
  return `<g opacity="${dim ? 0.38 : 1}"><rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * 0.18}" fill="${fill}" stroke="${edge}" stroke-width="1.4"/>` +
    P.map(([a, c]) => `<circle cx="${x + a * s}" cy="${y + c * s}" r="${s * 0.085}" fill="${pip}"/>`).join('') + '</g>';
}
// The board to draw: the game's, or a preview (a reviewed decision), with the dragged checker lifted.
function viewBoard() {
  const gm = S.game, v = S.ui.view;
  if (S.ui.anim) return S.ui.anim.slice();
  if (v && v.board) return v.board.slice();
  if (!gm || atHome()) return R.START.slice();
  const t = gm.phase === 'move' && gm.onRoll === 'me' ? getTurn() : null;
  return t ? t.board.slice() : gm.board.slice();
}
function drawBoard() {
  const svg = $('board'), Rc = svg.getBoundingClientRect(); if (!Rc.width) return;
  GEO = geometry(Rc.width, Rc.height); const G = GEO;
  svg.setAttribute('viewBox', `0 0 ${G.W} ${G.H}`);
  const gm = atHome() ? null : S.game, b = viewBoard();
  if (drag && drag.lifted) { if (drag.from === 25) b[25]--; else b[drag.from]--; }
  let s = `<rect x="0" y="0" width="${G.W}" height="${G.H}" rx="8" fill="var(--frame)"/>`;
  s += `<rect x="${G.x0}" y="${G.top - 2}" width="${12 * G.pw + G.bw}" height="${G.bot - G.top + 4}" fill="var(--felt)"/>`;
  s += `<rect x="${G.barX}" y="${G.top - 2}" width="${G.bw}" height="${G.bot - G.top + 4}" fill="var(--frame)" opacity=".85"/>`;
  if (G.port) for (const y of [G.trayY.bot, G.trayY.me]) s += `<rect x="${G.xL}" y="${y + 2}" width="${G.xR - G.xL}" height="${G.th - 4}" rx="5" fill="#000" opacity=".18"/>`;
  else s += `<rect x="${G.trayX + 2}" y="${G.top - 2}" width="${G.tw - 2}" height="${G.bot - G.top + 4}" fill="var(--frame)" opacity=".6"/>`;
  for (let p = 1; p <= 24; p++) {
    const { c, top } = pointCol(p), x = G.colX(c), y1 = top ? G.top : G.bot, y2 = top ? G.top + G.ph : G.bot - G.ph;
    s += `<polygon points="${x + 1},${y1} ${x + G.pw - 1},${y1} ${x + G.pw / 2},${y2}" fill="${p % 2 ? 'var(--pt1)' : 'var(--pt2)'}"/>`;
    const ly = top ? G.m + G.th + G.lh * 0.72 : G.H - G.m - G.th - G.lh * 0.22;
    s += `<text x="${x + G.pw / 2}" y="${ly}" font-size="${Math.min(12, G.lh * 0.7)}" font-weight="600" text-anchor="middle" fill="#efe6d2">${p}</text>`;
  }
  if (drag && drag.targets) for (const p of drag.targets) {
    if (p === 0) { s += G.port ? `<rect x="${G.xL + 2}" y="${G.trayY.me + 3}" width="${G.xR - G.xL - 4}" height="${G.th - 6}" rx="5" fill="none" stroke="var(--hint)" stroke-width="2.5" stroke-dasharray="5 4"/>`
      : `<rect x="${G.trayX + 3}" y="${G.mid + 4}" width="${G.tw - 4}" height="${G.bot - G.mid - 6}" rx="4" fill="none" stroke="var(--hint)" stroke-width="2.5" stroke-dasharray="5 4"/>`; continue; }
    const { c, top } = pointCol(p), x = G.colX(c), y1 = top ? G.top : G.bot, y2 = top ? G.top + G.ph : G.bot - G.ph;
    s += `<polygon points="${x + 2},${y1} ${x + G.pw - 2},${y1} ${x + G.pw / 2},${y2}" fill="var(--hint)" opacity=".38"/>`;
  }
  for (let p = 1; p <= 24; p++) {
    const n = b[p]; if (!n) continue;
    const cnt = Math.abs(n), show = Math.min(cnt, 5);
    for (let k = 0; k < show; k++) { const [cx, cy] = spot(p, k); s += chk(cx, cy, n > 0, k === show - 1 && cnt > 5 ? cnt : ''); }
  }
  // bar: Open Sage's checkers above the middle, yours below; the centred cube and the pip counts in the middle
  const bcx = G.barX + G.bw / 2, mid = G.mid;
  if (b[0]) s += chk(...spot('botbar', 0), false, b[0] > 1 ? b[0] : '');
  if (b[25]) s += chk(...spot('mybar', 0), true, b[25] > 1 ? b[25] : '');
  const cube = gm ? gm.cube : { value: 1, owner: 0 };
  const cs = Math.min(G.bw - 4, 24), fs = Math.min(13, G.bw * 0.4), cw = Math.min(G.bw - 4, fs * 2.3), ch = fs * 1.45;
  const cubeAt = (y, v, x = bcx, size = cs, pulse) => `<g${pulse ? ' class="pulse"' : ''}><rect x="${x - size / 2}" y="${y}" width="${size}" height="${size}" rx="4" fill="#f4efe2" stroke="#222" stroke-width="${pulse ? 2.5 : 1}"/>` +
    `<text x="${x}" y="${y + size * 0.68}" font-size="${size * 0.48}" font-weight="700" text-anchor="middle" fill="#222">${v}</text></g>`;
  if (!cube.owner) s += cubeAt(mid - cs / 2, cube.value === 1 ? 64 : cube.value);
  if (S.set.pips) {
    const [pm, po] = R.pips(b), half = cube.owner ? 4 : cs / 2 + 3;
    s += `<rect x="${bcx - cw / 2}" y="${mid - half - ch}" width="${cw}" height="${ch}" rx="4" fill="var(--opp)" stroke="var(--opp-edge)"/>`;
    s += `<text x="${bcx}" y="${mid - half - ch * 0.27}" font-size="${fs}" font-weight="700" text-anchor="middle" fill="var(--opp-ink)">${po}</text>`;
    s += `<rect x="${bcx - cw / 2}" y="${mid + half}" width="${cw}" height="${ch}" rx="4" fill="var(--me)" stroke="var(--me-edge)"/>`;
    s += `<text x="${bcx}" y="${mid + half + ch * 0.73}" font-size="${fs}" font-weight="700" text-anchor="middle" fill="var(--me-ink)">${pm}</text>`;
  }
  if (cube.owner) s += cubeAt(cube.owner === 'me' ? G.bot - cs - 4 : G.top + 4, cube.value);
  // trays
  const c = R.counts(b), offMe = Math.max(0, 15 - c.me - (drag && drag.lifted ? 1 : 0)), offBot = Math.max(0, 15 - c.op), tx = G.trayX + 2 + (G.tw - 2) / 2, sl = trSlab();
  const tray = (n, isTop, mine) => {
    let t = '';
    if (G.port) {                         // a row of slabs from the home side, the count beyond the last one
      const y = G.trayY[isTop ? 'bot' : 'me'] + 5, hh = G.th - 10;
      for (let i = 0; i < n; i++) t += `<rect x="${slabX(i) + 0.5}" y="${y}" width="${G.sw - 1}" height="${hh}" rx="2" fill="${mine ? 'var(--me)' : 'var(--opp)'}" stroke="${mine ? 'var(--me-edge)' : 'var(--opp-edge)'}" stroke-width=".7"/>`;
      if (n) t += `<text x="${S.set.mirror ? slabX(n) + 4 : slabX(n - 1) - 4}" y="${y + hh / 2 + 4}" font-size="11" font-weight="700" text-anchor="${S.set.mirror ? 'start' : 'end'}" fill="#efe6d2">${n}</text>`;
      return t;
    }
    for (let i = 0; i < n; i++) { const y = isTop ? G.top + 2 + i * sl : G.bot - 2 - (i + 1) * sl;
      t += `<rect x="${tx - G.tw * 0.34}" y="${y}" width="${G.tw * 0.68}" height="${sl - 1}" rx="1.5" fill="${mine ? 'var(--me)' : 'var(--opp)'}" stroke="${mine ? 'var(--me-edge)' : 'var(--opp-edge)'}" stroke-width=".6"/>`; }
    if (n) t += `<text x="${tx}" y="${isTop ? G.top + 2 + n * sl + 11 : G.bot - 2 - n * sl - 4}" font-size="10" font-weight="700" text-anchor="middle" fill="#efe6d2">${n}</text>`;
    return t;
  };
  s += tray(offBot, true, false) + tray(offMe, false, true);
  // arrows: Open Sage's last move (or a reviewed decision's plays)
  const v = S.ui.view;
  if (v && v.arrows) for (const a of v.arrows) s += arrowsSvg(a.steps, a.mine, a.colour, a.before);
  // Open Sage's last move: its arrows show until you roll or double (the user's rule, 2026-11-25), and when the game ends
  else if (gm && gm.last && gm.last.who === 'bot' && ((gm.phase === 'preroll' && gm.onRoll === 'me') || gm.phase === 'over')) s += arrowsSvg(gm.last.steps, false, 'var(--arrow)', gm.last.before);
  // dice and the cube being offered
  G.diceBox = null;
  const ds = Math.min(G.zh * 0.95, G.pw * 0.82, 40);
  if (gm && !v) {
    // your dice always on the right half of the board, Open Sage's on the left, whatever side the home boards are on
    // (the user's rule, 2026-11-25); a cube being offered sits on the offerer's half
    const rightX = G.colX(9), leftX = G.colX(3);
    if (gm.phase === 'opening' && gm.opening) {
      const ry = mid - ds / 2;
      s += dieSvg(leftX - ds / 2, ry, ds, gm.opening.bot, false, 'bot') + dieSvg(rightX - ds / 2, ry, ds, gm.opening.me, false, 'me');
    } else if (gm.dice && gm.phase === 'move') {
      const mine = gm.onRoll === 'me', who = mine ? 'me' : 'bot', t = mine ? getTurn() : null, order = t ? t.order : gm.dice;
      const gap = ds * 0.25, cx = mine ? rightX : leftX, y = mid - ds / 2, x1 = cx - ds - gap / 2, x2 = cx + gap / 2;
      if (t && doubles(order)) {
        const left = t.remaining().length;
        s += dieSvg(x1, y, ds, order[0], left === 0, who) + dieSvg(x2, y, ds, order[1], left === 0, who);
        s += `<text x="${cx}" y="${y + ds + 13}" font-size="11" font-weight="700" text-anchor="middle" fill="var(--ink)" opacity=".75">${left ? `${left} to play` : 'done'}</text>`;
      } else {
        const rem = t ? t.remaining() : order;
        s += dieSvg(x1, y, ds, order[0], !!t && !rem.includes(order[0]), who) + dieSvg(x2, y, ds, order[1], !!t && !rem.includes(order[1]), who);
      }
      if (mine) G.diceBox = [x1 - 6, y - 6, x2 + ds + 6, y + ds + 18];
    }
    if (gm.phase === 'offer' && gm.offer) {
      const x = gm.offer.by === 'me' ? rightX : leftX, size = Math.min(ds * 1.15, 44);
      s += cubeAt(mid - size / 2, gm.offer.value, x, size, true);
    }
  }
  if (drag && drag.lifted && drag.xy) s += chk(drag.xy[0], drag.xy[1], true, '', 'opacity=".92"');
  s += '<g id="fx"></g>';
  svg.innerHTML = s;
}
const doubles = (o) => o && o[0] === o[1];
// Arrows for steps [[from, to, hit], ...] in the mover's numbering; mine = you moved.
function arrowsSvg(steps, mine, colour, before) {
  if (!steps || !steps.length) return '';
  const G = GEO, conv = (p, isFrom) => (mine ? (p === 25 ? 'mybar' : p === 0 ? 'mytray' : p) : (p === 25 ? 'botbar' : p === 0 ? 'bottray' : 25 - p));
  const mk = 'ah' + colour.replace(/[^a-z0-9]/gi, '');     // a marker per colour (the quiz shows the best and your play together)
  let t = `<defs><marker id="${mk}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${colour}" stroke="#3a2a10" stroke-width="1"/></marker></defs>`;
  // stack heights as the steps are played, so each arrow starts and ends on a checker
  const bd = (mine ? before : before) ? before.slice() : null;
  for (const [f, to] of steps) {
    const F = conv(f, true), T = conv(to, false);
    const hF = bd ? (f === 25 ? bd[25] : f === 0 ? 0 : Math.max(0, bd[f])) : 1;
    let hT = bd ? (to === 0 ? 0 : Math.max(0, bd[to])) : 0;
    if (bd) { bd[f]--; if (to) { if (bd[to] === -1) { bd[to] = 0; hT = 0; } bd[to]++; } }
    const [x1, y1] = typeof F === 'number' ? spot(F, Math.max(0, hF - 1)) : spot(F, 0);
    const [x2, y2] = typeof T === 'number' ? spot(T, hT) : spot(T, 0);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const sx = x1 + (dx / len) * G.r * 0.6, sy = y1 + (dy / len) * G.r * 0.6, ex = x2 - (dx / len) * G.r * 0.95, ey = y2 - (dy / len) * G.r * 0.95;
    const bend = Math.min(40, len * 0.18), mx = (sx + ex) / 2 - (dy / len) * bend, my = (sy + ey) / 2 + (dx / len) * bend;
    const d = `M${sx},${sy} Q${mx},${my} ${ex},${ey}`;
    t += `<path d="${d}" fill="none" stroke="#3a2a10" stroke-width="5" stroke-linecap="round" opacity=".5"/>`;
    t += `<path d="${d}" fill="none" stroke="${colour}" stroke-width="3" stroke-linecap="round" marker-end="url(#${mk})"/>`;
  }
  return t;
}
// ---------------- animation
function animTo(fromXY, toXY, mine, ms) {
  return new Promise((res) => {
    if (!ms) return res();
    const fx = document.querySelector('#board #fx'); if (!fx) return res();
    fx.innerHTML = chk(fromXY[0], fromXY[1], mine, '', 'id="ghost"');
    const g = fx.querySelector('#ghost'), t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      g.setAttribute('cx', fromXY[0] + (toXY[0] - fromXY[0]) * e); g.setAttribute('cy', fromXY[1] + (toXY[1] - fromXY[1]) * e);
      if (k < 1) requestAnimationFrame(step); else { fx.innerHTML = ''; res(); }
    };
    requestAnimationFrame(step);
  });
}
const stepMs = () => ({ normal: 260, fast: 110, off: 0 })[S.set.speed] ?? 260;
// One of your single moves (m: {from, to, hit, board}) from the turn's current board.
async function animateUser(m) {
  const t = getTurn(), b = t.board, ms = Math.round(stepMs() * 0.6); if (!ms || !GEO) return;
  const fromW = m.from === 25 ? 'mybar' : m.from, toW = m.to === 0 ? 'mytray' : m.to;
  const fromXY = spot(fromW, m.from === 25 ? 0 : Math.max(0, b[m.from] - 1));
  const toXY = spot(toW, m.to === 0 ? 15 - R.counts(b).me : Math.max(0, b[m.to]));
  const lifted = b.slice(); lifted[m.from]--; S.ui.anim = lifted; drawBoard(); S.ui.anim = null;
  await animTo(fromXY, toXY, true, ms);
}
// Open Sage's play (seq in its numbering, from its board bb), one checker at a time.
async function animateBot(bb, seq) {
  const ms = stepMs(); if (!seq.length) return;
  let b = bb.slice();
  for (const s of seq) {
    const ub = R.flip(b);
    if (ms && GEO) {
      const fromW = s.from === 25 ? 'botbar' : 25 - s.from, toW = s.to === 0 ? 'bottray' : 25 - s.to;
      const fromXY = spot(fromW, s.from === 25 ? 0 : Math.max(0, b[s.from] - 1));
      const toXY = spot(toW, s.to === 0 ? 15 - R.counts(b).me : Math.max(0, b[s.to]));
      const lifted = ub.slice(); if (s.from === 25) lifted[0]--; else lifted[25 - s.from]++;
      S.ui.anim = lifted; drawBoard(); S.ui.anim = null;
      await animTo(fromXY, toXY, false, ms);
    }
    const nb = b.slice(); nb[s.from]--; if (s.to >= 1) { if (nb[s.to] === -1) { nb[s.to] = 0; nb[0]++; } nb[s.to]++; } b = nb;
    S.ui.anim = R.flip(b); drawBoard(); S.ui.anim = null;
  }
}

// ------------------------------------------------------------- input: tap a checker, drag it, tap the dice
let drag = null;
function hitTest(x, y) {
  const G = GEO; if (!G) return null;
  if (G.diceBox && x >= G.diceBox[0] && x <= G.diceBox[2] && y >= G.diceBox[1] && y <= G.diceBox[3]) return { kind: 'dice' };
  if (G.port) {                            // the trays' strips run the board's whole width, across the bar too
    if (y >= G.trayY.me) return { kind: 'tray', mine: true };
    if (y <= G.trayY.bot + G.th) return { kind: 'tray', mine: false };
  }
  if (x >= G.barX && x < G.barX + G.bw) return { kind: 'bar', mine: y > G.mid };
  if (!G.port) {
    const trayL = S.set.mirror ? 0 : G.trayX, trayR = S.set.mirror ? G.x0 : G.W;
    if (x >= trayL && x <= trayR) return { kind: 'tray', mine: y > G.mid };
  }
  let c = -1;
  if (x >= G.x0 && x < G.barX) c = Math.floor((x - G.x0) / G.pw);
  else if (x >= G.barX + G.bw && x < G.barX + G.bw + 6 * G.pw) c = 6 + Math.floor((x - G.barX - G.bw) / G.pw);
  if (c < 0 || c > 11) return null;
  return { kind: 'point', p: colPoint(c, y < G.mid) };
}
function svgXY(ev) { const r = $('board').getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }
function myTurnToMove() { const gm = S.game; return gm && gm.phase === 'move' && gm.onRoll === 'me' && !busy && !S.ui.view; }
function onDown(ev) {
  if (!GEO) return;
  const [x, y] = svgXY(ev), h = hitTest(x, y); if (!h) return;
  if (h.kind === 'dice') { ev.preventDefault(); return; }
  if (!myTurnToMove()) return;
  const t = getTurn(), b = t.board;
  let from = null;
  if (h.kind === 'bar' && h.mine && b[25] > 0) from = 25;
  else if (h.kind === 'point' && b[h.p] > 0) from = h.p;
  if (from === null) return;
  ev.preventDefault();
  $('board').setPointerCapture(ev.pointerId);
  drag = { id: ev.pointerId, from, x0: x, y0: y, t0: performance.now(), lifted: false, xy: [x, y], targets: null };
}
function onMove(ev) {
  if (!drag || ev.pointerId !== drag.id) return;
  const [x, y] = svgXY(ev);
  if (!drag.lifted && Math.hypot(x - drag.x0, y - drag.y0) > 9) {
    const t = getTurn(); drag.lifted = true; drag.targets = t.targets(drag.from);
  }
  if (drag.lifted) { drag.xy = [x, y]; drawBoard(); }
}
async function onUp(ev) {
  const [x, y] = GEO ? svgXY(ev) : [0, 0];
  if (!drag || ev.pointerId !== drag.id) {
    const h = GEO ? hitTest(x, y) : null;
    if (h && h.kind === 'dice') tapDice();
    else if (h && h.kind === 'point') await tapMake(h.p);
    else if (h && h.kind === 'tray' && h.mine) await tapBearOff();
    return;
  }
  const d = drag; drag = null;
  const t = getTurn(); if (!t || !myTurnToMove()) { drawBoard(); return; }
  if (!d.lifted) {                         // a tap: move by the first die (or the other one)
    const m = t.tapMove(d.from);
    if (!m) { shake(d.from); drawBoard(); return; }
    busy = true; try { await animateUser(m); } finally { busy = false; }
    t.apply(m); syncTurn(t); save(); afterStep(); return;
  }
  const h = hitTest(x, y);
  let to = null;
  if (h && h.kind === 'point') to = h.p; else if (h && h.kind === 'tray' && h.mine) to = 0;
  const path = to !== null && to !== d.from ? t.dragPath(d.from, to) : null;
  if (!path) { if (to !== null && to !== d.from) shake(d.from); drawBoard(); return; }
  for (const m of path) t.apply(m);
  syncTurn(t); save(); afterStep();
}
// A tap on a point with none of your checkers: the two single-die moves that make it, played as two taps (the
// user's request, 2026-11-25: 4-2 at the start, tap the 4 point = 8/4 6/4). Your own checkers there: a tap moves them.
async function tapMake(p) {
  if (!myTurnToMove()) return;
  const t = getTurn(); if (!t || t.done || t.board[p] > 0) return;
  const ms = t.makePoint(p);
  if (!ms) { if (t.board[p] >= -1) toast(`No two checkers can make your ${p} point with ${t.order[0]}-${t.order[1]}`, 1600); return; }
  busy = true;
  try { for (const m of ms) { const mm = t.allowed(m.from, m.die); if (!mm) break; await animateUser(mm); t.apply(mm); syncTurn(t); drawBoard(); } }
  finally { busy = false; }
  save(); afterStep();
}
// A tap on your tray (the user's request, 2026-11-27): every checker the dice left can bear off goes off, as if each
// had been tapped; nothing else moves.
async function tapBearOff() {
  if (!myTurnToMove()) return;
  const t = getTurn(); if (!t || t.done) return;
  const ms = t.bearOffAll();
  if (!ms.length) { toast(R.allHome(t.board) ? `No checker can come off with ${t.remaining().join('-')}` : 'Bring all your checkers home first', 1600); return; }
  busy = true;
  try { for (const m of ms) { const mm = t.allowed(m.from, m.die); if (!mm || mm.to !== 0) break; await animateUser(mm); t.apply(mm); syncTurn(t); drawBoard(); } }
  finally { busy = false; }
  save(); afterStep();
}
function afterStep() {
  const t = getTurn(); renderAll();
  if (t && t.done && S.set.autoDone) userDone();
}
function tapDice() {
  if (!myTurnToMove()) return;
  const t = getTurn(); if (!t) return;
  if (t.done) return userDone();
  t.swap(); syncTurn(t); save(); renderAll();
}
function userUndo() { if (!myTurnToMove()) return; const t = getTurn(); if (t && t.steps.length) { t.undo(); syncTurn(t); save(); renderAll(); } }
function userDone() { if (!myTurnToMove()) return; const t = getTurn(); if (t && t.done) finishUserMove(t); }
function shake(from) {
  const el = $('board'); el.classList.remove('shake'); void el.getBoundingClientRect(); el.classList.add('shake');
  const t = getTurn(); if (t && t.remaining().length) toast(from === 25 ? 'That checker can\'t come in with these dice' : `No legal move for that checker with ${t.remaining().join(' or ')}`, 1400);
}
function onKey(ev) {
  if (S.ui.menu || ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'INPUT') return;
  if (window.BQ && BQ.on) return BQ.key(ev);
  const gm = atHome() ? null : S.game; if (!gm) return;
  const k = ev.key.toLowerCase();
  if (k === ' ' || k === 'enter') { ev.preventDefault(); if (gm.phase === 'preroll' && gm.onRoll === 'me') userRoll(); else if (gm.phase === 'move') userDone(); else if (gm.phase === 'over') nextGame(); }
  else if (k === 'backspace' || k === 'u') userUndo();
  else if (k === 's') tapDice();
  else if (k === 'd' && gm.phase === 'preroll') userDouble();
  else if (gm.phase === 'offer' && gm.offer && gm.offer.by === 'bot' && 'tpb'.includes(k)) userAnswer(k.toUpperCase());
}

// ------------------------------------------------------------- the side panel
let statusText = '';
function status(t) { statusText = t; }
function toast(t, ms = 2000) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(S.ui.toastT); S.ui.toastT = setTimeout(() => el.classList.remove('show'), ms); }
function renderAll() { drawBoard(); renderSide(); }
function scoreLine() {
  const gm = atHome() ? null : S.game;
  if (S.set.type === 'match' && S.match) {
    const M = S.match, craw = gm && gm.rules.type === 'match' && gm.crawford ? ' · Crawford game' : M.crawfordUsed ? ' · post-Crawford' : '';
    return `Match to ${M.length} · You ${M.score.me} – ${M.score.bot} Open Sage${craw}`;
  }
  if (S.sess) { const t = S.sess.tally; return `Cash · ${S.sess.rules.jacoby ? 'Jacoby' : 'no Jacoby'}${S.sess.rules.beavers ? ', beavers' : ''} · session ${t > 0 ? '+' : ''}${t} after ${plural(S.sess.games.length, 'game')}`; }
  return S.set.type === 'match' ? `Match to ${S.set.length}` : `Cash game · ${S.set.jacoby ? 'Jacoby' : 'no Jacoby'}${S.set.beavers ? ', beavers' : ''}`;
}
function btn(label, fn, cls = '', dis = false, title = '') { return `<button class="${cls}" onclick="${fn}" ${dis ? 'disabled' : ''} ${title ? `title="${esc(title)}"` : ''}>${label}</button>`; }
let sideLater = false;
function renderSide() {
  const el = $('side'); if (!el) return;
  const z = $('pasteZone'); if (z && document.activeElement === z) { sideLater = true; return; }   // don't pull the box from under the finger
  if (S.game && S.game.quiz && window.BQ) { el.innerHTML = BQ.side(); return; }
  const gm = atHome() ? null : S.game, v = S.ui.view;
  let h = `<div class="bar-top"><div class="title">BG Play <span class="muted">vs Open Sage ${gm ? gm.ply : S.set.ply}-ply</span></div>${gm && gm.phase !== 'over' && !S.ui.view ? autoRollSwitch(gm) : ''}${btn('⋯', 'openMenu()', 'icon', false, 'Menu')}</div>`;
  h += `<div class="score">${esc(scoreLine())}</div>`;
  if (ENG.state !== 'ready') {
    h += `<div class="card"><div class="${ENG.state === 'error' ? 'bad' : 'muted'}">${esc(ENG.msg || 'Loading…')}</div>${ENG.state === 'error' ? btn('Retry', 'location.reload()') : ''}</div>`;
  }
  if (v && v.panel) { el.innerHTML = h + v.panel; return; }
  if (!gm) h += startScreen();
  else h += gamePanel(gm);
  el.innerHTML = h;
}
// The start screen: the first thing shown, and Home from the end of a game.
function startScreen() {
  const dis = ENG.state !== 'ready', M = S.match, open = !!(M && !M.over), last = atHome() ? S.game : null;
  let h = '<div class="card">';
  h += last ? `<p>Last game: ${esc(resultText(last))}${last.er ? ` · ER ${last.er.er.toFixed(2)}` : ''}.</p>` : '<p>Play Open Sage on this device: no connection needed.</p>';
  if (open) h += `<div class="row big">${btn(`Continue the ${M.length}-point match (${M.score.me}–${M.score.bot})`, 'continueMatch()', 'primary', dis)}</div>`;
  // a cash game after a cash game carries on the session's tally (Menu → New session starts a new one)
  h += `<div class="row${open ? '' : ' big'}">${btn('New cash game', `startCash(${S.set.type === 'cash' && S.sess ? 'false' : 'true'})`, open ? '' : 'primary', dis)}${btn('New match', 'openMenu(\'match\')', '', dis)}</div>`;
  if (open) h += '<p class="muted small">A new cash game or match leaves this match unfinished; the games played in it still go to your progress.</p>';
  if (TARGET === 'tile') h += `<div class="row">${btn('Progress', 'PG.open()')}${btn('Blunder Quiz', 'BQ.open()')}</div>`;
  if (last) h += `<div class="row">${btn('Back to the last game', 'goHome(false)')}</div>`;
  h += '</div>';
  if (TARGET === 'pwa' && unsent().length) h += `<div class="row">${sendLink(sendLabel())}</div>`;
  return h + pasteZone();
}
function gamePanel(gm) {
  let h = '';
  const me = gm.onRoll === 'me';
  if (gm.phase === 'opening') h += `<div class="status">${gm.opening ? `Opening roll: you ${gm.opening.me}, Open Sage ${gm.opening.bot}` : 'Rolling for the start…'}</div>`;
  else if (gm.phase === 'preroll' && me) {
    const can = canDbl(gm, 'me');
    h += `<div class="status">Your turn${can ? ': roll or double' : ''}</div><div class="row big">`;
    if (can) h += btn(`Double to ${gm.cube.value * 2}`, 'userDouble()', 'dbl');
    h += btn('Roll', 'userRoll()', 'primary') + '</div>';
  } else if (gm.phase === 'move' && me) {
    const t = getTurn(), done = t && t.done;
    h += `<div class="status">You rolled ${Math.max(...gm.dice)}-${Math.min(...gm.dice)}${t && t.max === 0 ? ': no legal move' : done ? ': tap Done' : ''}</div>`;
    h += `<div class="row big">${btn('↶ Undo', 'userUndo()', '', !(t && t.steps.length))}${btn('✓ Done', 'userDone()', 'primary', !done)}</div>`;
    h += `<div class="hint">Tap a checker to move it by the first die; drag it to use another number or both. Tap the dice to swap them.</div>`;
  } else if (gm.phase === 'offer' && gm.offer.by === 'bot') {
    h += `<div class="status">Open Sage doubles to ${gm.offer.value}</div><div class="row big">${btn('Pass', 'userAnswer(\'P\')')}${btn('Take', 'userAnswer(\'T\')', 'primary')}${beaversOn(gm) ? btn(`Beaver (${gm.cube.value * 4})`, 'userAnswer(\'B\')', 'dbl') : ''}</div>`;
  } else if (gm.phase === 'resign' && gm.resign.by === 'bot') {
    const k = gm.resign.kind, pts = R.pointsFor(k, gm.cube, gm.rules);
    h += `<div class="status">Open Sage resigns ${['', 'a single game', 'a gammon', 'a backgammon'][k]}: ${plural(pts, 'point')} to you</div><div class="row big">${btn('Decline', 'userAnswerResign(false)')}${btn('Accept', 'userAnswerResign(true)', 'primary')}</div>`;
  } else if (gm.phase === 'over') h += overPanel(gm);
  else h += `<div class="status run">${esc(statusText || 'Open Sage is thinking…')}</div>`;
  if (S.ui.retry && gm.phase !== 'over') h += btn('Retry', 'S.ui.retry=false; drive()');
  if (gm.phase !== 'over' && S.set.showBot) h += botPanel(gm);
  return h;
}
// Auto-roll (the user's request, 2026-11-26: closed out, or a race he won't double in): while it's on, every turn of
// yours is rolled for you, even with the cube in reach, so you can't double until you switch it off. It belongs to the
// game, so each new game starts with it off. It sits in the panel's top bar, which stays put through the game (the
// user's request, 2026-11-27: under the turn's buttons it moved with every roll).
function autoRollSwitch(gm) {
  return `<label class="tog autoroll${gm.autoRollOn ? ' on' : ''}" title="${gm.autoRollOn ? 'On: every turn rolled for you, no doubling' : 'Roll every turn for me (no doubling while on)'}"><input type="checkbox" ${gm.autoRollOn ? 'checked' : ''} onchange="setAutoRoll(this.checked)"> Auto-roll</label>`;
}
function setAutoRoll(on) {
  const gm = S.game; if (!gm || gm.phase === 'over') return;
  gm.autoRollOn = !!on; save();
  if (on && gm.phase === 'preroll' && gm.onRoll === 'me') userRoll(true); else renderAll();
}
function botPanel(gm) {
  const L = gm.botLog[gm.botLog.length - 1]; if (!L) return '';
  let h = `<details class="botbox" ${S.ui.botOpen ? 'open' : ''} ontoggle="S.ui.botOpen=this.open"><summary>`;
  if (L.kind === 'move') {
    h += `Open Sage's ${L.dice[0]}-${L.dice[1]} (turn ${L.turn}): <b>${esc(L.list[0].name)}</b> · ${L.ply}-ply${L.ms != null ? ` · ${(L.ms / 1000).toFixed(1)} s` : ''}</summary><table class="mini"><tr><th>Play</th><th>Equity</th><th>Diff</th><th>Depth</th></tr>`;
    const top = L.list[0];
    for (const x of L.list) h += `<tr><td>${esc(x.name)}</td><td>${eqs(x.e)}</td><td>${x === top ? '' : (x.lv === top.lv ? '−' + (top.e - x.e).toFixed(3) : '')}</td><td>${x.lv}-ply</td></tr>`;
    h += `</table><div class="muted small">${plural(L.n, 'legal play')}; ${L.list.length < L.n ? `the best ${L.list.length} shown; ` : ''}win ${pct(top.p[0])}, gammon ${pct(top.p[1])}, lose a gammon ${pct(top.p[3])}.</div>`;
  } else if (L.kind === 'cube') {
    const c = L.c;
    h += `Open Sage's cube (turn ${L.turn}): <b>${c.double ? 'double' : 'no double'}</b> · ${L.ply}-ply</summary>${cubeTable(c, 'bot')}`;
  } else if (L.kind === 'answer') {
    h += `Open Sage's answer to your double: <b>${L.ans}</b> · ${L.ply}-ply</summary>${cubeTable(L.c, 'me')}`;
  } else if (L.kind === 'resign') {
    h += `Open Sage ${L.accept ? 'accepted' : 'declined'} your resignation</summary><div class="small">Its equity playing on: ${eqs(L.botE)} per cube.</div>`;
  }
  return h + '</details>';
}
// The doubler's cube table; whose: 'me' when you're the side on roll (your chances), 'bot' when Open Sage is.
function cubeTable(c, whose) {
  const r = (l, v) => `<tr><td>${l}</td><td>${eqs(v)}</td></tr>`, who = whose === 'me' ? 'You win' : 'Open Sage wins';
  return `<table class="mini">${r('No double', c.nd)}${r(c.beaver ? 'Double/Beaver' : 'Double/Take', c.dt)}${r('Double/Pass', c.dp)}</table>` +
    `<div class="muted small">From ${whose === 'me' ? 'your' : 'Open Sage\'s'} side as the doubler, per cube.${c.probs ? ` ${who} ${pct(c.probs[0])} (gammons ${pct(c.probs[1])}).` : ''}</div>`;
}
function resultText(gm) {
  const r = gm.result, k = ['', 'a single game', 'a gammon', 'a backgammon'][r.kind] || 'the game';
  const who = r.winner === 'me' ? 'You win' : 'Open Sage wins';
  if (r.how === 'drop') return `${who} ${plural(r.points, 'point')}: ${r.winner === 'me' ? 'Open Sage passed' : 'you passed'} the double`;
  if (r.how === 'resign') return `${who} ${plural(r.points, 'point')}: ${r.winner === 'me' ? 'Open Sage resigned' : 'you resigned'} ${k}`;
  return `${who} ${k}: ${plural(r.points, 'point')}`;
}
function overPanel(gm) {
  let h = `<div class="status ${gm.result.winner === 'me' ? 'good' : ''}">${esc(resultText(gm))}</div>`;
  const pending = gm.decisions.filter((d) => !d.res).length;
  if (!gm.er) h += `<div class="card"><div class="run">Working out your ER at ${ER_PLY}-ply: ${plural(pending, 'decision')} left…</div></div>`;
  else {
    const E = gm.er;
    h += `<div class="card er"><div class="erbig">ER ${E.er.toFixed(2)}</div><div class="small">${E.total.toFixed(3)} equity lost × 500 / ${plural(E.n, 'decision')} (${E.nMoves} checker plays, ${E.nCube} cube). Checker ${E.n ? (E.checker * 500 / E.n).toFixed(2) : '0.00'}, cube ${E.n ? (E.cube * 500 / E.n).toFixed(2) : '0.00'}.</div>`;
    const sk = Object.entries(E.skipped).map(([k, n]) => `${n} ${k}`).join(', ');
    if (sk) h += `<div class="muted small">Not counted: ${esc(sk)}.</div>`;
    const errs = E.errors.filter((d) => d.res.cost >= ERR_MIN), nb = errs.filter((d) => d.res.cost >= BLUNDER_MIN).length;
    h += `<div class="row" style="margin:8px 0 4px">${btn(errs.length ? `Review: your ${plural(errs.length, 'error')}${nb ? ` (${plural(nb, 'blunder')})` : ''} or every move` : 'Review every move', "openReview('current')", 'primary')}</div>`;
    if (errs.length) {
      h += `<table class="mini errs"><tr><th>Turn</th><th>You</th><th>Best</th><th>Cost</th></tr>`;
      for (const d of errs) h += `<tr onclick="openReview('current', '${decKey(1, d.turn, d.k)}')"><td>${d.turn}</td><td>${esc(decPlayed(d))}</td><td>${esc(d.res.best)}</td><td class="cost ${tierCls(tierOf(d.res.cost, true))}">${d.res.cost.toFixed(3)}</td></tr>`;
      h += `</table><div class="muted small">Tap a row to open it in the review. Costs at ${ER_PLY}-ply${gm.decisions.some((d) => d.res && d.res.src && d.res.src.startsWith('XG')) ? '; turns 1–2 from the XG opening book' : ''}.</div>`;
    } else h += `<div class="small good">No errors of 0.020 or more.</div>`;
    h += '</div>';
  }
  const M = S.match, isMatch = gm.rules.type === 'match';
  if (isMatch) h += `<div class="score">${M.over ? `Match over: ${M.score.me >= M.length ? 'you win' : 'Open Sage wins'} ${M.score.me}–${M.score.bot}` : `Match to ${M.length}: you ${M.score.me} – ${M.score.bot} Open Sage${M.crawfordNext ? ' · next game is the Crawford game' : ''}`}</div>`;
  h += `<div class="row big">${btn('Home', 'goHome()')}${btn(isMatch ? (M.over ? 'New match' : 'Next game') : 'Next game', 'nextGame()', 'primary')}</div>`;
  h += fateCard(gm);
  if (!isMatch || M.over) h += `<div class="row">${btn('Download .mat', 'downloadMat()')}</div>`;
  return h + pasteZone();
}
// Where this game goes: your progress always, Claude's full review only when you ask for it (the user's request,
// 2026-11-27: make it clear which games go for analysis and which only for tracking).
function fateCard(gm) {
  const M = S.match, isMatch = gm.rules.type === 'match', canSave = !isMatch || !!(M && M.over);
  const sv = S.saved.find((x) => x.id === (isMatch && M ? M.id : gm.id)), forReview = !!(sv && sv.want !== 'track');
  let prog, rev, act = '';
  if (TARGET === 'tile') prog = window.PG ? PG.endState(gm, M) : '';
  else if (!canSave) prog = 'The match goes to your progress in the tile when it ends.';
  else if (sv && sv.status === 'copied') prog = 'Copied for the tile: once it\'s pasted there, it\'s in your progress.';
  else prog = sv ? 'Goes to your progress when you send it to the tile.' : 'Goes to your progress when you send it to the tile (ready once your ER is).';
  if (!canSave) rev = 'You can ask for it when the match ends.';
  else if (!forReview) { rev = 'Only when you ask for it.'; act = btn('Save for full analysis', 'saveForAnalysis()', '', !gm.er); }
  else if (TARGET === 'pwa') rev = 'Saved: Claude reviews every move once it reaches the tile.';
  else if (sv.review) { rev = 'Review ready.'; act = `<a class="btnlink primary" href="${esc(sv.review)}" target="_blank" rel="noopener">Open the review</a>`; }
  else { rev = `${savedLabel(sv)}: Claude reviews every move in your project, and the link appears in Full reviews when it's ready.`; act = btn('Full reviews', 'openMenu(\'saved\')'); }
  let h = `<div class="card fate"><div class="fl"><b>Progress</b><span>${esc(prog)}</span>${TARGET === 'tile' ? `<div class="acts">${btn('Progress', 'PG.open()')}</div>` : ''}</div>`;
  h += `<div class="fl"><b>Full review</b><span>${esc(rev)}</span>${act ? `<div class="acts">${act}</div>` : ''}</div></div>`;
  if (TARGET === 'pwa' && unsent().length) h += `<div class="row">${sendLink(sendLabel())}</div>`;
  return h;
}
const decPlayed = (d) => (d.k === 'M' ? `${d.dice[0]}-${d.dice[1]} ${d.played}` : { R: 'No double', D: 'Double', T: 'Take', P: 'Pass', B: 'Beaver' }[d.k]);
function viewDecision(i) {
  const gm = S.game, d = gm.decisions[i]; if (!d) return;
  const board = d.k === 'T' || d.k === 'P' || d.k === 'B' ? R.flip(d.board) : d.board.slice();
  const arrows = [];
  if (d.k === 'M') {
    const lpP = R.legalPlays(d.board, d.dice[0], d.dice[1]), pl = lpP.plays.get(R.key(d.after)), bs = d.res.bestB && lpP.plays.get(R.key(d.res.bestB));
    if (bs && pl !== bs) arrows.push({ steps: bs.seq.map((s) => [s.from, s.to, s.hit]), mine: true, colour: 'var(--good)', before: d.board });
    if (pl) arrows.push({ steps: pl.seq.map((s) => [s.from, s.to, s.hit]), mine: true, colour: 'var(--bad)', before: d.board });
  }
  const cubeOwner = d.cube.owner === 0 ? 0 : (d.k === 'T' || d.k === 'P' || d.k === 'B') ? (d.cube.owner === 'bot' ? 1 : 2) : (d.cube.owner === 'me' ? 1 : 2);
  const xg = R.xgid(d.k === 'T' || d.k === 'P' || d.k === 'B' ? d.board : d.board, { value: d.cube.value, owner: cubeOwner }, d.dice || null, d.rules,
    { mine: d.k === 'T' || d.k === 'P' || d.k === 'B' ? d.score.bot : d.score.me, theirs: d.k === 'T' || d.k === 'P' || d.k === 'B' ? d.score.me : d.score.bot, crawford: d.score.crawford });
  let p = `<div class="card"><div class="status">Turn ${d.turn}: ${esc(decPlayed(d))}${d.k === 'M' ? '' : ''}</div>`;
  if (d.k === 'M') {
    p += `<div class="small"><span class="key bad">■</span> your play ${esc(d.played)} · <span class="key good">■</span> best ${esc(d.res.best)} · cost ${d.res.cost.toFixed(3)} (${esc(d.res.src)})</div><table class="mini"><tr><th>Play</th><th>Equity</th><th>Cost</th></tr>`;
    const top = d.res.cands[0].e;
    for (const c of d.res.cands) p += `<tr${R.same(c.b, d.after) ? ' class="sel"' : ''}><td>${esc(c.name)}</td><td>${eqs(c.e)}</td><td>${(top - c.e).toFixed(3)}</td></tr>`;
    if (!d.res.cands.some((c) => R.same(c.b, d.after))) p += `<tr class="sel"><td>${esc(d.played)}</td><td>${eqs(d.res.playedE)}</td><td>${(top - d.res.playedE).toFixed(3)}</td></tr>`;
    p += '</table>';
  } else if (d.k === 'R' || d.k === 'D') {
    p += `<div class="small">You ${d.k === 'D' ? 'doubled' : 'rolled without doubling'}; best: ${esc(d.res.best)} · cost ${d.res.cost.toFixed(3)}</div>${cubeTable(d.res, 'me')}`;
  } else {
    p += `<div class="small">Open Sage doubled; you ${{ T: 'took', P: 'passed', B: 'beavered' }[d.k]}. Best: ${esc(d.res.best)} · cost ${d.res.cost.toFixed(3)}</div>`;
    p += `<table class="mini"><tr><td>Take</td><td>${eqs(d.res.E.T)}</td></tr><tr><td>Pass</td><td>${eqs(d.res.E.P)}</td></tr>${isFinite(d.res.E.B) ? `<tr><td>Beaver</td><td>${eqs(d.res.E.B)}</td></tr>` : ''}</table><div class="muted small">Your equity, per cube before the double, at 3-ply.</div>`;
  }
  p += `<div class="xgid"><code>${esc(xg)}</code></div><div class="row">${btn('Copy XGID', `copyText(${esc(JSON.stringify(xg))})`)}${btn('Back', 'closeView()', 'primary')}</div></div>`;
  S.ui.view = { board, arrows, panel: p }; renderAll();
}
function closeView() { S.ui.view = null; renderAll(); }
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('Copied'); } catch (e) { toast('Copy blocked: select the text and copy it'); } }

// ------------------------------------------------------------- the review: your errors, or every move, in the analyzer's display
// The review is the BG Position Analyzer's page (review.html + review.js, built from the analyzer by mkreview.py) in a
// frame over the game: each position as the analyzer shows it, 2-, 3-, then 4-ply, Roll out, and in the tile Explain
// and Go deeper. It gets the positions, the engine's weights, the opening book and (tile) Claude through
// window.BGP_RV. The game's own workers stop while it is open; the review runs its own.
const ERR_MIN = 0.020, BLUNDER_MIN = 0.080;
// How big a decision's error was (the user's colours, 2026-11-26): red a blunder (0.080 or more), yellow an error (0.020 to
// 0.080), grey anything smaller, the same bands as the review's arrows. Only counted decisions are errors.
const tierOf = (c, counted) => (!counted || c == null ? 'small' : c >= BLUNDER_MIN ? 'blunder' : c >= ERR_MIN ? 'error' : 'small');
const tierCls = (t) => ({ blunder: 'bad', error: 'yel', small: 'muted', best: 'good' }[t]);
// Your decisions' results in a small form kept with a game: {g: game, t: turn, k, c: cost, n: counted 1/0, b: best}.
const compactDecs = (decs, g) => decs.filter((d) => d.res && !d.res.err).map((d) => ({ g, t: d.turn, k: d.k, c: +(+d.res.cost).toFixed(4), n: d.res.counted ? 1 : 0, b: String(d.res.best || '') }));
const relCube = (c, side) => ({ value: c.value, owner: c.owner === 0 ? 0 : c.owner === side ? 1 : 2 });
// The analyzer's game context, from `side`'s view.
function ctxOf(G, side) {
  const r = G.rules;
  if (r.type === 'cash') return { type: 'money', jacoby: !!r.jacoby, beaver: !!r.beavers, len: 7, me: 0, opp: 0, crawford: false };
  const mine = side === 'me' ? G.score.me : G.score.bot, theirs = side === 'me' ? G.score.bot : G.score.me;
  return { type: 'match', jacoby: false, beaver: false, len: r.length, me: mine, opp: theirs, crawford: !!G.crawford };
}
// Your decisions in a replayed game, as analyzeDecision takes them (for games saved without their results).
function decisionsOf(G) {
  const out = [], base = { rules: G.rules, score: { me: G.score.me, bot: G.score.bot, crawford: G.crawford }, game: G.n };
  for (const P of G.pos) {
    const g = (side) => gOf(G.rules, G.score, G.crawford, P.cube, side);
    if (P.type === 'roll' && P.side === 'me' && P.n > 1) out.push({ ...base, k: 'M', turn: P.turn, board: P.before, dice: P.dice, after: P.after, played: P.name, g: g('me'), cube: { ...P.cube } });
    else if (P.type === 'nodouble' && P.side === 'me') out.push({ ...base, k: 'R', turn: P.turn, board: P.board, g: g('me'), cube: { ...P.cube } });
    else if (P.type === 'double' && P.side === 'me') out.push({ ...base, k: 'D', turn: P.turn, board: P.board, g: g('me'), cube: { ...P.cube } });
    else if (P.type === 'double') out.push({ ...base, k: { take: 'T', drop: 'P', beaver: 'B' }[P.answer], turn: P.turn, board: P.board, g: g('bot'), cube: { ...P.cube } });
  }
  return out;
}
// The review's positions: every roll that had a move (both sides), every double with its answer, and your no-doubles
// that were errors. costs: decKey -> {c, n, b} (your decisions).
const decKey = (g, t, k) => `${g}:${t}:${k}`;
function reviewItems(games, costs, opp = 'Open Sage') {
  const items = [], multi = games.length > 1, txt = (c) => (c.c < 0.0005 ? 'best' : `−${c.c.toFixed(3)}`);
  // base: the label without the cost; costTxt and tier: the cost and its band (blunder / error / small), coloured by the review
  const mark = (it, c, forced) => {
    it.err = !!(c && c.n && c.c >= ERR_MIN); it.blunder = !!(c && c.n && c.c >= BLUNDER_MIN);
    it.costTxt = forced ? '(forced)' : c ? txt(c) : null; it.tier = c && !forced ? (c.c < 0.0005 ? 'best' : tierOf(c.c, !!c.n)) : null;   // the best move green (the user's rule, 2026-11-27)
    it.label = it.base + (forced ? ' (forced)' : c ? ` · ${txt(c)}` : '');
    return it;
  };
  for (const G of games) for (const P of G.pos) {
    const pre = multi ? `Game ${G.n}, turn ${P.turn}` : `Turn ${P.turn}`;
    if (P.type === 'roll') {
      if (!P.n || !P.steps.length) continue;                  // no checker could move
      const mine = P.side === 'me', c = mine ? costs[decKey(G.n, P.turn, 'M')] : null;
      items.push(mark({ id: decKey(G.n, P.turn, 'M'), who: P.side, board: P.before, dice: P.dice, cube: relCube(P.cube, P.side), game: ctxOf(G, P.side),
        played: { after: P.after, name: P.name, by: P.side }, cost: c ? c.c : null,
        base: `${pre} · ${mine ? 'You' : opp} rolled ${P.dice[0]}-${P.dice[1]}: ${P.name}` }, c, P.n === 1));
    } else if (P.type === 'nodouble' && P.side === 'me') {
      const c = costs[decKey(G.n, P.turn, 'R')]; if (!c || !c.n || c.c < ERR_MIN) continue;
      items.push(mark({ id: decKey(G.n, P.turn, 'R'), who: 'me', board: P.board, dice: null, cube: relCube(P.cube, 'me'), game: ctxOf(G, 'me'),
        played: { action: 'No double', by: 'me' }, cost: c.c, base: `${pre} · You didn't ${P.cube.owner ? 'redouble' : 'double'}` }, c, false));
    } else if (P.type === 'double') {
      const mineD = P.side === 'me', k = mineD ? 'D' : { take: 'T', drop: 'P', beaver: 'B' }[P.answer], c = costs[decKey(G.n, P.turn, k)];
      items.push(mark({ id: decKey(G.n, P.turn, k), who: P.side, board: P.board, dice: null, cube: relCube(P.cube, P.side), game: ctxOf(G, P.side),
        played: { action: 'Double', by: P.side }, answer: { action: { take: 'Take', drop: 'Pass', beaver: 'Beaver' }[P.answer], by: other(P.side) },
        cost: c ? c.c : null,
        base: `${pre} · ${mineD ? 'You' : opp} ${P.cube.owner ? 'redoubled' : 'doubled'} to ${P.value}, ${mineD ? opp : 'you'} ${{ take: 'took', drop: 'passed', beaver: 'beavered' }[P.answer]}` }, c, false));
    }
  }
  return items;
}
const costMap = (list) => { const m = {}; for (const x of list) m[decKey(x.g, x.t, x.k)] = x; return m; };
let RVJOB = null;
// src: 'current' (the game just played) or a saved game's id; at: the item to open on.
async function openReview(src, at) {
  if ($('rvFrame') || RVJOB) return;
  if (!ENG.weights || !ENG.pool) return toast('The engine is still loading');
  let games, costs, title;
  try {
    if (src === 'current') {
      const gm = S.game; if (!gm || gm.phase !== 'over') return;
      if (gm.decisions.some((d) => !d.res)) { toast('Finishing your ER first…'); await Promise.all(gm.decisions.map((d) => analyzeDecision(d, 'hi'))); }
      games = R.replayGames({ games: [{ n: 1, score: [gm.score.me, gm.score.bot], crawford: gm.crawford, events: gm.events }] }, gm.rules);
      costs = costMap(compactDecs(gm.decisions, 1)); title = `Review: ${resultText(gm)}`;
    } else {
      const e = S.saved.find((x) => x.id === src); if (!e) return;
      const chk = R.checkBgPlayMat(e.mat); games = chk.games; title = `Review: ${e.title}`;
      if (!(e.decs && e.decsPly === ER_PLY)) { const decs = await scoreSaved(e, games); if (!decs) return; e.decs = decs; e.decsPly = ER_PLY; save(); }
      costs = costMap(e.decs);
    }
  } catch (err) { RVJOB = null; renderMenu(); toast(`This game can't be reviewed: ${err.message || err}`, 4000); return; }
  const items = reviewItems(games, costs);
  if (!items.length) return toast('Nothing to review in this game');
  await showReview(items, title, at);
}
// Your decisions in a saved game, scored at 4-ply now (games saved before the review kept no results).
async function scoreSaved(e, games) {
  const decs = games.flatMap((G) => decisionsOf(G).map((d) => ({ d, g: G.n })));
  RVJOB = { done: 0, n: decs.length, cancel: false, title: e.title }; openMenu('scoring');
  const out = [];
  await Promise.all(decs.map(({ d, g }) => analyzeDecision(d, 'hi').then((res) => {
    if (RVJOB && !RVJOB.cancel) { RVJOB.done++; if (S.ui.menu === 'scoring') renderMenu(); }
    if (res && !res.err) out.push({ g, t: d.turn, k: d.k, c: +(+res.cost).toFixed(4), n: res.counted ? 1 : 0, b: String(res.best || '') });
  })));
  const ok = RVJOB && !RVJOB.cancel && out.length === decs.length; RVJOB = null;
  if (S.ui.menu === 'scoring') closeMenu();
  return ok ? out : null;
}
function cancelScoring() { closeMenu(); }
let RVW = [];   // the review's engine workers (made here, see showReview)
// The review runs six engine workers (the user's choice, 2026-11-25; fewer on a device with fewer cores): a rollout covers
// the top four plays plus your move, and with four workers the fifth waited for the others, doubling the time. A number
// chosen in the review's own menu wins. BG Play's engine is stopped while the review is open, so the two never add up.
const RV_WORKERS = Math.max(2, Math.min(6, navigator.hardwareConcurrency || 6));
// Claude for the review's Explain and Go deeper. The frame's objects (the options, its AbortSignal, Go deeper's tools,
// images) belong to another JavaScript realm, and the platform's sample() refuses them ("options must be a plain
// object"), so each call is rebuilt here, in this page's realm, before it goes on.
function rvClaude() {
  if (!window.claude || !window.claude.use) return null;
  let real = null;
  const get = async () => real || (real = await window.claude.use('sample'));
  const plain = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const sample = async (input, opts) => {
    const f = await get();
    if (!f) throw Object.assign(new Error('Claude is not available to this tile'), { code: 'not_granted' });
    const o = {};
    for (const k of Object.keys(opts || {})) {
      const v = opts[k];
      if (k === 'signal') {
        if (v) { const ac = new AbortController(); if (v.aborted) ac.abort(); else v.addEventListener('abort', () => ac.abort(), { once: true }); o.signal = ac.signal; }
      } else if (k === 'onText') { if (typeof v === 'function') o.onText = (u) => v({ text: u && u.text, delta: u && u.delta }); }
      else if (k === 'tools') {
        o.tools = (v || []).map((t) => {
          const x = { name: String(t.name), description: String(t.description || ''), execute: async (input) => { const r = await t.execute(plain(input)); return typeof r === 'string' ? r : plain(r); } };
          if (t.inputSchema) x.inputSchema = plain(t.inputSchema);
          return x;
        });
      } else if (k === 'images') o.images = (v || []).map((b) => new Blob([b], { type: b.type }));
      else if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) o[k] = v;
      else o[k] = plain(v);
    }
    return f(typeof input === 'string' ? input : plain(input), o);
  };
  sample.limits = async () => { const f = await get(); return f && f.limits ? plain(await f.limits()) : { images: false }; };
  return { use: async (name) => (name === 'sample' && (await get()) ? sample : null) };
}
async function showReview(items, title, at, opp) {
  // The review's script goes into the frame inline, and its engine workers are made by this page (BGP_RV.worker): a frame
  // written with document.write isn't served by the offline app's service worker, so anything it fetched itself (its
  // script, a worker, the engine a worker loads) would fail offline. Fetched from here, they come from the device.
  let html;
  try {
    const [h, j] = await Promise.all(['review.html', 'review.js'].map(async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.text(); }));
    const tag = '<script src="review.js"></script>';
    if (!h.includes(tag)) throw new Error('review.html has no script tag');
    html = h.replace(tag, () => '<script>' + j.replace(/<\/(script)/gi, '<\\/$1') + '</script>');
  } catch (err) { toast('The review page didn\'t load: ' + (err.message || err), 4000); return; }
  closeMenu(); driveToken++; poolGen++;
  const pool = ENG.pool; ENG.pool = null; ENG.state = 'review'; if (pool) pool.terminate();
  window.BGP_RV = { items, title, at: at || null, target: TARGET, explain: TARGET === 'tile', claude: TARGET === 'tile' ? rvClaude() : null,
    weights: ENG.weights, manifest: ENG.manifest, book: BOOK, workers: RV_WORKERS, opts: { swapColour: !!S.set.swapColour, mirror: !!S.set.mirror },
    botName: opp || 'Open Sage', close: closeReview, worker: () => { const w = new Worker('pa-worker.js'); RVW.push(w); return w; } };
  const f = document.createElement('iframe'); f.id = 'rvFrame'; f.title = title; f.setAttribute('allow', 'clipboard-write');
  document.body.appendChild(f);
  const d = f.contentDocument; d.open(); d.write(html); d.close();
  const th = document.documentElement.getAttribute('data-theme'); if (th) d.documentElement.setAttribute('data-theme', th);
}
function closeReview() {
  const f = $('rvFrame'); if (f) f.remove();
  for (const w of RVW) { try { w.terminate(); } catch (e) {} }
  RVW = [];
  window.BGP_RV = null;
  restartPool();
}
function restartPool() { if (ENG.weights) startPool().catch((err) => { ENG.state = 'error'; ENG.msg = 'The engine failed to restart: ' + (err.message || err); renderSide(); }); }

// ------------------------------------------------------------- the menu
function openMenu(sec) { S.ui.menu = sec || 'main'; renderMenu(); $('ovMenu').classList.add('open'); }
function closeMenu() {
  if (S.ui.menu === 'scoring' && RVJOB && !RVJOB.cancel) { RVJOB.cancel = true; driveToken++; restartPool(); }   // closing stops the scoring
  S.ui.menu = null; $('ovMenu').classList.remove('open'); clearHash();
}
function setOpt(k, v) { S.set[k] = v; save(); renderMenu(); renderAll(); if (k === 'swapColour') document.body.classList.toggle('swapc', !!v); }
function seg(k, opts) { return `<div class="seg">${opts.map(([v, l]) => `<button class="${S.set[k] === v ? 'on' : ''}" onclick='setOpt(${JSON.stringify(k)}, ${JSON.stringify(v)})'>${l}</button>`).join('')}</div>`; }
function tog(k, label) { return `<label class="tog"><input type="checkbox" ${S.set[k] ? 'checked' : ''} onchange='setOpt(${JSON.stringify(k)}, this.checked)'> ${label}</label>`; }
function renderMenu() {
  const gm = S.game, inGame = gm && gm.phase !== 'over', sec = S.ui.menu;
  if (sec === 'paste' || !sec) return;
  const head = { saved: TARGET === 'pwa' ? 'Games for the tile' : 'Full reviews', imported: 'Games from the offline app', match: 'New match' }[sec] || 'Menu';
  let h = `<div class="mhead"><h3>${head}</h3>${btn('✕', 'closeMenu()', 'icon')}</div>`;
  if (sec === 'saved') { $('menu').innerHTML = h + savedSection(); return; }
  if (sec === 'imported') { $('menu').innerHTML = h + importedSection(); return; }
  if (sec === 'scoring') {
    const J = RVJOB, f = J && J.n ? Math.round((100 * J.done) / J.n) : 0;
    $('menu').innerHTML = `<div class="mhead"><h3>Getting the review ready</h3>${btn('✕', 'closeMenu()', 'icon')}</div><p class="small">${J ? `${esc(J.title)}: scoring your moves at ${ER_PLY}-ply on this device, ${J.done} of ${J.n}. Games saved before the review kept no move-by-move results; this happens once.` : ''}</p><div style="height:8px;border-radius:4px;background:var(--line);overflow:hidden"><div style="height:100%;width:${f}%;background:var(--accent)"></div></div><div class="row" style="margin-top:10px">${btn('Cancel', 'cancelScoring()')}</div>`;
    return;
  }
  if (sec === 'match') {
    h += `<div class="field">Match length <span class="stepper">${btn('−', `setOpt('length', Math.max(1, S.set.length - 2))`)}<b>${S.set.length}</b>${btn('+', `setOpt('length', Math.min(25, S.set.length + 2))`)}</span></div>`;
    h += `<h4>Open Sage plays at</h4>${seg('ply', [[1, '1-ply'], [2, '2-ply'], [3, '3-ply'], [4, '4-ply']])}`;
    h += `<p class="muted small">Crawford rule on. The depth is fixed for the whole match.${inGame ? ' The game in progress is abandoned (not scored).' : ''}</p>`;
    h += `<div class="row">${btn('Cancel', 'closeMenu()')}${btn(`Start a ${S.set.length}-point match`, 'closeMenu(); startMatch()', 'primary', ENG.state !== 'ready')}</div>`;
    $('menu').innerHTML = h; return;
  }
  h += '<div class="mgrid"><section>';
  h += `<h4>Game</h4>${seg('type', [['cash', 'Cash'], ['match', 'Match']])}`;
  if (S.set.type === 'cash') h += `<div class="tograw">${tog('jacoby', 'Jacoby rule')}${tog('beavers', 'Beavers')}</div>`;
  else h += `<div class="field">Match length <span class="stepper">${btn('−', `setOpt('length', Math.max(1, S.set.length - 2))`)}<b>${S.set.length}</b>${btn('+', `setOpt('length', Math.min(25, S.set.length + 2))`)}</span></div>`;
  h += `<div class="row">${S.set.type === 'cash' ? btn(S.sess ? 'New game' : 'Start', 'closeMenu(); startCash(false)', '', ENG.state !== 'ready') + btn('New session', 'closeMenu(); startCash(true)', '', ENG.state !== 'ready') : btn('New match', 'closeMenu(); startMatch()', '', ENG.state !== 'ready')}</div>`;
  if (inGame) h += `<p class="muted small">Starting a new game abandons the one in progress; it isn't scored.</p>`;
  h += `<h4>Open Sage plays at</h4>${seg('ply', [[1, '1-ply'], [2, '2-ply'], [3, '3-ply'], [4, '4-ply']])}`;
  h += `<p class="muted small">From the next ${S.set.type === 'match' ? 'match' : 'game'}. Your ER is always ${ER_PLY}-ply.</p>${tog('showBot', 'Show the plays Open Sage compared')}`;
  if (inGame && gm.onRoll === 'me' && (gm.phase === 'preroll' || gm.phase === 'move')) {
    const jac = gm.rules.type === 'cash' && gm.rules.jacoby && gm.cube.owner === 0 && gm.cube.value === 1;
    h += `<h4>Resign</h4><div class="row">${btn(`Single (${R.pointsFor(1, gm.cube, gm.rules)})`, 'userResign(1)')}${jac ? '' : btn(`Gammon (${R.pointsFor(2, gm.cube, gm.rules)})`, 'userResign(2)') + btn(`Backgammon (${R.pointsFor(3, gm.cube, gm.rules)})`, 'userResign(3)')}</div>`;
  }
  h += '</section><section>';
  h += `<h4>Play</h4><div class="tograw">${tog('autoBear', 'Auto-bearoff (no contact: take off 2, or 4 on doubles)')}${tog('autoRoll', 'Roll for me when I can\'t double (Open Sage owns the cube)')}${tog('autoForced', 'Play forced moves for me')}${tog('autoDone', 'Finish the turn without Done')}</div>`;
  h += `<h4>Board</h4><div class="tograw">${tog('pips', 'Pip counts')}${tog('swapColour', 'Swap colours')}${tog('mirror', 'Home board on the left')}</div>${seg('speed', [['normal', 'Normal'], ['fast', 'Fast'], ['off', 'No animation']])}`;
  if (TARGET === 'pwa') { const nU = unsent().length; h += `<h4>Games for the tile</h4><div class="row">${btn(`Games for the tile (${S.saved.length})`, 'openMenu(\'saved\')')}</div>${nU ? `<div class="row" style="margin-top:6px">${sendLink(sendLabel())}</div>` : ''}`; }
  else h += `<h4>Full reviews</h4>${btn(`Full reviews (${S.saved.length})`, 'openMenu(\'saved\')')}`;
  if (TARGET === 'tile') h += `<h4>Progress</h4><div class="row">${btn('Progress', 'PG.open()')}${btn('Blunder Quiz', 'BQ.open()', '', !!(gm && gm.phase !== 'over' && (gm.onRoll !== 'me' || busy)))}</div>`;
  else { const nU = unsent().length; h += `<h4>Progress</h4><p class="small muted">Your progress is in the BG Play tile: every game you finish here goes there with Send to the tile${nU ? ` (${plural(nU, 'game')} waiting)` : ''}.</p>`; }
  h += `<h4>Engine</h4><div class="field">Workers ${['1', '2', '4', '6'].map((n) => btn(n, `setWorkers(${n})`, S.set.workers === +n ? 'on' : '')).join('')}</div>`;
  if (TARGET === 'tile') h += `<div class="row">${btn('Copy the opening book for the offline app', 'copyBook()')}</div>`;
  else h += `<div class="small">${BOOK ? 'Opening book loaded (XG book for your turns 1–2).' : `No opening book: your turns 1–2 are scored at ${ER_PLY}-ply.`}</div><div class="row">${btn(BOOK ? 'Replace the opening book' : 'Paste the opening book', 'openPaste(\'book\')')}</div>${installBtn()}`;
  h += `<p class="muted small">BG Play ${esc(VERSION)} · Open Sage (MPL-2.0, github.com/markbgsage/bgsage) · all analysis runs on this device.</p>`;
  h += '</section></div>';
  $('menu').innerHTML = h;
}
async function setWorkers(n) { if (n === S.set.workers) return; S.set.workers = n; save(); renderMenu(); if (ENG.weights) { driveToken++; await startPool(); toast(`Engine restarted with ${plural(n, 'worker')}`); } }

// ------------------------------------------------------------- saving games for the project's full analysis
function gameTitle(kind, rec, when) {
  const d = new Date(when), ds = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return kind === 'match' ? `${rec.length}-point match vs Open Sage, ${ds}` : `Cash game vs Open Sage, ${ds}`;
}
// The game file of a cash game or a match: the one given, else the current one (a new game may have started since).
function buildMat(kind, gm = S.game, M = S.match) {
  if (kind === 'match') {
    return { id: M.id, kind, ply: M.ply, length: M.length, title: gameTitle('match', M, M.started),
      mat: R.matText({ id: 'bgp-' + M.id, p1: USER, p2: botName(M.ply), length: M.length, ply: M.ply, date: new Date(M.started) }, M.games.map((g) => ({ score: [g.score.me, g.score.bot], events: g.events }))),
      result: `${M.score.me}–${M.score.bot}${M.over ? '' : ' (unfinished)'}`, er: matchER(M), decsPly: M.games.every((g) => g.decs) ? ER_PLY : 0,
      decs: M.games.flatMap((g, i) => (g.decs || []).map((x) => ({ ...x, g: i + 1 }))) };
  }
  return { id: gm.id, kind: 'cash', ply: gm.ply, title: gameTitle('cash', gm, gm.started),
    mat: R.matText({ id: 'bgp-' + gm.id, p1: USER, p2: botName(gm.ply), length: 0, ply: gm.ply, jacoby: gm.rules.jacoby, beavers: gm.rules.beavers, date: new Date(gm.started) }, [{ score: [0, 0], events: gm.events }]),
    result: resultText(gm), er: gm.er ? { er: gm.er.er, n: gm.er.n, total: gm.er.total } : null, decs: compactDecs(gm.decisions, 1), decsPly: gm.er ? ER_PLY : 0 };
}
function matchER(M = S.match) {
  const gs = M.games.filter((g) => g.er); if (!gs.length) return null;
  const n = gs.reduce((a, g) => a + g.er.n, 0), total = gs.reduce((a, g) => a + g.er.total, 0);
  return { er: n ? total * 500 / n : 0, n, total };
}
// The result of a checked game file, in the saved list's words.
function matResult(chk) {
  if (chk.kind === 'cash') { const r = chk.games[0].result; return `${r.winner === 'me' ? 'You win' : 'Open Sage wins'} ${plural(r.points, 'point')}`; }
  const last = chk.games[chk.games.length - 1], sc = { ...last.score }; sc[last.result.winner] += last.result.points;
  return `${sc.me}–${sc.bot}${Math.max(sc.me, sc.bot) >= chk.rules.length ? '' : ' (unfinished)'}`;
}
function savedLabel(x) {
  // the offline app: whether it has gone to the tile yet (the lists' headings say what each game is for)
  if (TARGET === 'pwa') return x.status === 'copied' ? `Copied for the tile ${new Date(x.copied || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: paste it there if you haven't` : 'Not sent to the tile yet';
  return { local: 'Saved on this device', queued: 'Queued: sends when online', sending: 'Sending…', sent: 'Sent to Claude', copied: 'Copied for the tile', reviewing: 'Claude is reviewing it', done: 'Review ready', error: 'Not sent: tap Retry sending' }[x.status] || x.status; }
// Offline app: a game kept for your progress only, now for Claude's full review as well (sent with the next Send).
function wantReview(id) {
  const e = S.saved.find((x) => x.id === id); if (!e || TARGET !== 'pwa') return;
  e.want = 'review'; e.status = 'local'; e.copied = 0; save(); prepareBundle(); renderAll(); if (S.ui.menu) renderMenu();
  toast('Marked for Claude\'s full review: it goes with your next Send to the tile.', 3500);
}
// Offline app: what Send to the tile will carry.
function sendLabel() {
  const u = unsent(), r = u.filter((x) => x.want !== 'track').length, t = u.length - r;
  return `Send to the tile: ${[r ? `${r} for full review` : '', t ? `${t} for progress only` : ''].filter(Boolean).join(', ')}`;
}
async function saveForAnalysis() {
  const gm = S.game; if (!gm || gm.phase !== 'over') return;
  const kind = gm.rules.type === 'match' ? 'match' : 'cash';
  const e = { ...buildMat(kind), created: Date.now(), status: 'local', want: 'review' };
  const ex = S.saved.find((x) => x.id === e.id);
  if (ex && TARGET === 'pwa' && ex.want === 'track') return wantReview(ex.id);     // kept for progress already: now for review too
  if (ex) return openMenu('saved');
  S.saved.unshift(e); save(); renderAll();
  if (TARGET === 'tile') await sendOne(e);
  else { e.status = 'local'; save(); prepareBundle(); toast('Saved for Claude\'s full review: it goes with your next Send to the tile.', 3500); }
}
// Tile: write the game to the page's database, then start the scheduled analysis. Offline or no database: queue it.
let CAP = { db: null, mcp: null, dl: null };
async function sendOne(e, note = '') {
  if (TARGET !== 'tile') return;
  if (!navigator.onLine || !CAP.db) { e.status = 'queued'; save(); renderAll(); if (S.ui.menu) renderMenu(); if (note !== null) toast((navigator.onLine ? 'Saved; it will be sent when the tile can reach Claude' : 'Saved; it will be sent when you\'re online') + note); return; }
  e.status = 'sending'; save(); renderAll();
  try {
    await CAP.db.doc('games/' + e.id).set({ id: e.id, kind: e.kind, title: e.title, mat: e.mat, ply: e.ply, result: e.result, er: e.er, created: new Date(e.created).toISOString(),
      status: 'open', user: USER, source: e.source || TARGET });
  } catch (err) { e.status = navigator.onLine ? 'error' : 'queued'; e.err = String(err.code || err.message || err); save(); renderAll(); if (S.ui.menu) renderMenu(); return; }
  e.status = 'sent'; save();
  await fireTask(e, note);
  renderAll(); if (S.ui.menu) renderMenu();
}
// note null: the paste's summary is showing, so no toasts (it shows each game's state)
async function fireTask(e, note = '') {
  const say = (t, ms) => { if (note !== null) toast(t + (note || ''), ms); };
  if (!CAP.mcp || !TRIGGER_ID) { say('Saved. The analysis starts with the next run of the scheduled task.'); return; }
  try { await CAP.mcp.callTool('Claude Code Remote', 'fire_trigger', { trigger_id: TRIGGER_ID }); say('Sent: the review will appear in your project'); e.fired = Date.now(); save(); }
  catch (err) {
    const c = err && err.code;
    const why = { needs_reauth: 'Reconnect Claude Code Remote in claude.ai Settings → Connectors', server_not_connected: 'Add Claude Code Remote in claude.ai Settings → Connectors',
      not_in_manifest: 'Allow Claude Code Remote for this tile to start reviews', approval_required: 'Allow the tile to start the review when Claude asks' }[c];
    e.fireErr = why || ('Couldn\'t start the review: ' + (c || err)); save(); if (note !== null) toast(e.fireErr + '. The game is saved; Start the review in Full reviews' + (note || '.'), 4000);
  }
}
async function flushQueue() {
  if (TARGET !== 'tile' || !navigator.onLine || !CAP.db) return;
  for (const e of S.saved.filter((x) => x.status === 'queued' || x.status === 'error')) await sendOne(e);
}
function watchReviews() {
  if (!CAP.db || watchReviews.on) return; watchReviews.on = true;
  try {
    CAP.db.collection('games').onSnapshot((snap) => {
      let changed = false;
      for (const d of snap.docs) {
        const x = d.data() || {}, e = S.saved.find((s) => s.id === d.id);
        if (!e) { S.saved.push({ id: d.id, kind: x.kind, title: x.title, mat: x.mat, ply: x.ply, result: x.result, er: x.er, created: Date.parse(x.created) || Date.now(), status: 'sent' }); changed = true; continue; }
        const st = x.status === 'done' ? 'done' : x.status === 'running' ? 'reviewing' : x.status === 'error' ? 'error' : e.status === 'sending' ? 'sent' : e.status;
        if (st !== e.status || x.review !== e.review) { e.status = st; e.review = typeof x.review === 'string' && x.review.startsWith('https://') ? x.review : e.review; e.reviewEr = x.review_er; e.err = x.error; changed = true; }
      }
      if (changed) { S.saved.sort((a, b) => b.created - a.created); save(); renderAll(); if (S.ui.menu) renderMenu(); if (window.PG) PG.scan(); }
    }, () => { watchReviews.on = false; });
  } catch (e) { watchReviews.on = false; }
}
// Saved games. The offline app: every game waiting for the tile, in two lists, for Claude's full review and for
// progress only. The tile: the games sent to Claude for review, with their reviews.
function savedSection() {
  if (TARGET === 'pwa') return pwaSaved();
  let h = `<p class="small">Games saved for full analysis go to Claude, who reviews every move in your Backgammon Analysis project; each one's link appears here when it's ready. Every game you finish goes to Progress as well, saved or not.</p>`;
  h += `<div class="row">${btn('Paste games from the offline app', 'openPaste(\'games\')', 'primary')}</div>`;
  if (S.saved.some((x) => x.status === 'queued' || x.status === 'error')) h += `<div class="row" style="margin-top:6px">${btn('Retry sending', 'flushQueue()')}</div>`;
  if (!S.saved.length) return h + '<p class="muted">None yet. At the end of a game, tap Save for full analysis.</p>';
  return h + savedList(S.saved);
}
const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function savedList(list, opts = {}) {
  let h = '<div class="saved">';
  for (const e of list) {
    const id = esc(JSON.stringify(e.id));
    h += `<div class="sv"><div><b>${esc(e.title)}${e.created ? ' ' + hhmm(e.created) : ''}</b> · ${esc(e.result || '')}${e.er ? ` · ER ${(+e.er.er).toFixed(2)}` : ''}</div><div class="small ${e.status === 'error' ? 'bad' : 'muted'}">${esc(savedLabel(e))}${e.fireErr && e.status === 'sent' ? ' · ' + esc(e.fireErr) : ''}${e.err && e.status === 'error' ? ' · ' + esc(e.err) : ''}</div>`;
    let row = '';
    if (e.review) row += `<a class="btnlink primary" href="${esc(e.review)}" target="_blank" rel="noopener">Open the review</a>`;
    if (TARGET === 'tile' && e.status === 'sent' && e.fireErr) row += btn('Start the review', `retryFire(${id})`);
    if (row) h += `<div class="row">${row}</div>`;
    if (opts.wantReview) h += `<div class="row">${btn('Ask for a full review', `wantReview(${id})`)}</div>`;
    if (!opts.short) h += `<div class="row">${btn('Review', `openReview(${id})`)}${btn('Download .mat', `downloadMat(${id})`)}${btn('Remove', `removeSaved(${id})`)}</div>`;
    h += '</div>';
  }
  return h + '</div>';
}
function pwaSaved() {
  const n = unsent().length; if (n && !BUNDLE) prepareBundle();
  const rv = S.saved.filter((x) => x.want !== 'track'), tr = S.saved.filter((x) => x.want === 'track');
  let h = `<p class="small">Games go to the BG Play tile in Claude by copy and paste. ${n ? 'Send to the tile copies them and opens the tile (you need a connection): tap its box and Paste.' : 'Every game you finish waits here until you send it.'}</p>`;
  if (n) h += `<div class="row">${sendLink(sendLabel(), 'primary')}</div>`;
  h += `<h4>For Claude's full review (${rv.length})</h4><p class="small muted">Claude reviews every move of these in your Backgammon Analysis project; they go to your progress too.</p>`;
  h += rv.length ? savedList(rv) : '<p class="small muted">None. At the end of a game tap Save for full analysis, or Ask for a full review below.</p>';
  h += `<h4>For your progress only (${tr.length})</h4><p class="small muted">The tile scores these for its Progress tab; Claude doesn't review them. Once sent they drop off this list after a month.</p>`;
  h += tr.length ? savedList(tr, { wantReview: true }) : '<p class="small muted">None.</p>';
  return h;
}
// Tile: what a paste from the offline app brought, in place of the toast (the user's request, 2026-11-27: which games
// went for analysis and which only for tracking). Kept until the next paste or a reload.
function importedSection() {
  const I = S.ui.imp || { review: [], track: [], refused: 0 };
  const rv = I.review.map((id) => S.saved.find((e) => e.id === id)).filter(Boolean);
  let h = `<p class="small">${plural(rv.length + I.track.length, 'game')} from the offline app.</p>`;
  h += `<h4>For Claude's full review (${rv.length})</h4>`;
  if (rv.length) h += `<p class="small muted">Claude reviews every move of these in your Backgammon Analysis project; each one's link appears in Full reviews when it's ready. They go to your progress too.</p>${savedList(rv, { short: true })}`;
  else h += '<p class="small muted">None this time. In the offline app, Save for full analysis (or Ask for a full review in its list) marks a game for review.</p>';
  h += `<h4>For your progress only (${I.track.length})</h4>`;
  if (I.track.length) {
    h += '<p class="small muted">Scored on this device for the Progress tab; not sent to Claude.</p><div class="saved">';
    for (const t of I.track) {
      const done = !!(window.PG && t.ids.length && t.ids.every((id) => PG.isTracked(id)));
      h += `<div class="sv"><div><b>${esc(t.title)} ${hhmm(t.at)}</b> · ${esc(t.result)}</div><div class="small ${done ? 'good' : 'run'}">${done ? 'In your progress' : 'Adding to your progress…'}</div></div>`;
    }
    h += '</div>';
  } else h += '<p class="small muted">None this time.</p>';
  if (I.refused) h += `<p class="small bad">${plural(I.refused, 'pasted game')} ${I.refused === 1 ? 'wasn\'t a BG Play game file and was' : 'weren\'t BG Play game files and were'} left out.</p>`;
  h += `<div class="row" style="margin-top:10px">${btn('Progress', 'PG.open()')}${btn('Full reviews', 'openMenu(\'saved\')')}${btn('Done', 'closeMenu()', 'primary')}</div>`;
  return h;
}
async function retryFire(id) { const e = S.saved.find((x) => x.id === id); if (e) { e.fireErr = null; await fireTask(e); renderMenu(); } }
function removeSaved(id) { S.saved = S.saved.filter((x) => x.id !== id); save(); renderMenu(); renderAll(); }
async function downloadMat(id) {
  let e = id ? S.saved.find((x) => x.id === id) : null;
  if (!e) { const gm = S.game; if (!gm || gm.phase !== 'over') return; e = buildMat(gm.rules.type === 'match' ? 'match' : 'cash'); }
  const name = `bgplay-${e.kind}-${new Date(e.created || Date.now()).toISOString().slice(0, 10)}-${e.id.slice(-4)}.mat`;
  if (TARGET === 'tile') {
    if (!CAP.dl) { copyText(e.mat); toast('Downloads aren\'t available here: the game file was copied instead'); return; }
    try { await CAP.dl.save({ filename: name, data: e.mat }); } catch (err) { toast('Download declined or blocked'); }
    return;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([e.mat], { type: 'text/plain' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
// ---------------- moving games and the book between the offline app and the tile (copy and paste)
async function packJson(obj) {
  const data = new TextEncoder().encode(JSON.stringify(obj));
  let bytes = data;
  if (typeof CompressionStream !== 'undefined') bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return (bytes === data ? 'J' : 'Z') + btoa(s);
}
async function unpackJson(s) {
  const kind = s[0], bin = atob(s.slice(1)), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const bytes = kind === 'Z' ? new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()) : u8;
  return JSON.parse(new TextDecoder().decode(bytes));
}
const sum = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; };
// The games waiting to go to the tile (offline app), packed ahead of the tap so that the copy and the opening of the
// tile both happen inside the tap (browsers allow both only during a user gesture).
let BUNDLE = null;
// Not sent yet, or copied in the last three days (the tile may not have had them pasted; it ignores games it has).
const unsent = () => S.saved.filter((x) => x.status === 'local' || (x.status === 'copied' && Date.now() - (x.copied || 0) < 3 * 864e5));
async function prepareBundle() {
  if (TARGET !== 'pwa') return null;
  // games kept only for progress drop off the list a month after they were sent
  const old = S.saved.filter((x) => x.want === 'track' && x.status === 'copied' && Date.now() - (x.copied || 0) > 30 * 864e5);
  if (old.length) { S.saved = S.saved.filter((x) => !old.includes(x)); save(); }
  const list = unsent().map(({ id, kind, title, mat, ply, result, er, created, want }) => ({ id, kind, title, mat, ply, result, er, created, source: 'pwa', want: want === 'track' ? 'track' : 'review' }));
  const key = list.map((x) => x.id + ':' + x.want).join(',');
  if (!list.length) { BUNDLE = null; return null; }
  if (BUNDLE && BUNDLE.key === key) return BUNDLE;
  const body = await packJson(list);
  BUNDLE = { key, ids: list.map((x) => x.id), text: `BGPLAY-GAMES ${list.length} ${sum(body)} ${body}` };
  renderAll(); if (S.ui.menu === 'saved') renderMenu();
  return BUNDLE;
}
// Offline app: a link that opens the tile on its paste screen (#paste); the tap also copies the games.
// With no connection the tap only copies.
function sendLink(label, cls = '') {
  const go = navigator.onLine && TILE_URL;
  return `<a class="btnlink ${cls}" href="${esc(go ? TILE_URL + '#paste' : '#')}" target="_blank" rel="noopener" onclick="return sendToTile()">${esc(go ? label : label.replace(/^Send to the tile/, 'Copy for the tile'))}</a>`;
}
function sendToTile() {
  const B = BUNDLE; if (!B) { prepareBundle(); toast('Getting the games ready: tap again'); return false; }
  const go = !!(navigator.onLine && TILE_URL);
  let p; try { p = navigator.clipboard.writeText(B.text); } catch (e) { p = Promise.reject(e); }
  p.then(() => {
    B.ids.forEach((id) => { const e = S.saved.find((x) => x.id === id); if (e) { e.status = 'copied'; e.copied = Date.now(); } }); save(); renderAll(); if (S.ui.menu === 'saved') renderMenu();
    toast(go ? `Copied ${plural(B.ids.length, 'game')}. In the tile: tap the box and Paste.` : `Copied ${plural(B.ids.length, 'game')}. When you're online, open the BG Play tile in Claude and paste.`, 5000);
  }).catch(() => showPasteOut(B.text));
  return go;
}
async function copyBook() {
  if (!BOOK) return toast('The opening book isn\'t loaded yet');
  const body = await packJson(BOOK), text = `BGPLAY-BOOK ${sum(body)} ${body}`;
  try { await navigator.clipboard.writeText(text); toast('Copied. In the offline app: Menu → Paste the opening book.', 4000); } catch (e) { showPasteOut(text); }
}
function showPasteOut(text) { S.ui.menu = 'paste'; $('ovMenu').classList.add('open'); $('menu').innerHTML = `<div class="mhead"><h3>Copy this text</h3>${btn('✕', 'closeMenu()', 'icon')}</div><p class="small">The clipboard is blocked here: select all of it and copy.</p><textarea class="paste" readonly>${esc(text)}</textarea>`; }
// The paste screen: the text is taken as soon as it lands (a paste, or the keyboard's clipboard suggestion).
function openPaste(what) {
  S.ui.menu = 'paste'; $('ovMenu').classList.add('open');
  const book = what === 'book';
  $('menu').innerHTML = `<div class="mhead"><h3>${book ? 'Paste the opening book' : 'Paste games from the offline app'}</h3>${btn('✕', 'closeMenu()', 'icon')}</div>
    <p class="small">${book ? 'In the tile: Menu → Copy the opening book for the offline app. Then come back here.' : 'Tap the box, then Paste (the keyboard\'s clipboard suggestion works too). The games are added as soon as they land: every game goes to your progress, and the ones saved for full analysis go off for review. Nothing copied yet? In the offline app: Saved games → Send to the tile.'}</p>
    <textarea id="pasteBox" class="paste" placeholder="Tap here, then Paste" oninput="pasteInput(this)"></textarea>
    <div class="row">${TARGET === 'pwa' && navigator.clipboard && navigator.clipboard.readText ? btn('Paste from the clipboard', 'readClip()', 'primary') : ''}${btn('Cancel', 'closeMenu()')}</div><div id="pasteMsg" class="small bad"></div>`;
}
function pasteInput(el) {
  const v = el.value;
  if (/BGPLAY-(GAMES|BOOK) /.test(v)) { el.value = ''; importText(v); }
  else if (v.length > 40) { el.value = ''; pasteMsg(notOurs()); }     // something else was pasted
}
const notOurs = () => TARGET === 'tile' ? 'That isn\'t a game from the offline app. In the app: Saved games → Send to the tile, then paste here.' : 'That isn\'t the opening book: in the tile, Menu → Copy the opening book for the offline app.';
async function readClip() { try { importText(await navigator.clipboard.readText()); } catch (e) { pasteMsg('The browser didn\'t allow reading the clipboard: tap the box and Paste instead.'); } }
const pasteMsg = (t) => { const m = $('pasteMsg'); if (m && S.ui.menu === 'paste') m.textContent = t; else toast(t, 4000); };
// Any text copied from BG Play, from wherever it was pasted: games (into the tile) or the opening book (into the app).
async function importText(raw) {
  raw = String(raw || '');
  const mg = raw.match(/BGPLAY-GAMES (\d+) (\d+) ([A-Za-z0-9+/=]+)/), mb = raw.match(/BGPLAY-BOOK (\d+) ([A-Za-z0-9+/=]+)/);
  try {
    if (mb) {
      if (TARGET === 'tile') throw new Error('That\'s the opening book: paste it into the offline app.');
      if (sum(mb[2]) !== +mb[1]) throw new Error('That isn\'t the whole book: copy it again from the tile.');
      const b = await unpackJson(mb[2]); if (!b.open || !b.reply) throw new Error('Not an opening book');
      localStorage.setItem('bgplay-book', mb[2]); BOOK = b; closeMenu(); toast('Opening book loaded: your turns 1–2 are now scored from the XG book'); return;
    }
    if (!mg) throw new Error('That isn\'t text copied from BG Play.');
    if (TARGET !== 'tile') throw new Error('Paste these games into the BG Play tile in Claude: it starts the reviews.');
    if (sum(mg[3]) !== +mg[2]) throw new Error('That isn\'t the whole text: copy it again in the offline app.');
    const list = await unpackJson(mg[3]); const added = [], forProgress = [], review = []; let refused = 0;
    if (!Array.isArray(list)) throw new Error('That isn\'t a list of games.');
    // Only BG Play's own game files get in, checked line by line and replayed move by move (rules.js
    // checkBgPlayMat): its headers and player names, its move lines, legal moves and cube actions, a result that fits.
    // The title and result shown are rebuilt from the game itself; nothing else pasted is kept. These files go on to
    // Claude for review, so nothing else may ride along with them (the user's request, 2026-11-25).
    for (const x of list.slice(0, 200)) {
      if (!x || typeof x.mat !== 'string' || typeof x.id !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(x.id)) { refused++; continue; }
      let chk; try { chk = R.checkBgPlayMat(x.mat); } catch (err) { refused++; continue; }
      if (chk.id !== x.id) { refused++; continue; }
      const created = Number.isFinite(+x.created) ? Math.min(Math.max(+x.created, 1.5e12), Date.now() + 864e5) : Date.now();
      // marked for progress only (the offline app keeps every finished game): scored here for the Progress tab, not sent to Claude
      if (x.want === 'track') {
        if (window.PG) PG.enqueueFile({ id: x.id, src: 'pwa', at: created, mat: x.mat, ply: chk.ply });
        forProgress.push({ id: x.id, title: gameTitle(chk.kind, { length: chk.rules.length }, created), at: created, result: matResult(chk), ids: chk.kind === 'match' ? chk.games.map((G) => `${x.id}-g${G.n}`) : [x.id] });
        continue;
      }
      review.push(x.id);
      if (S.saved.find((e) => e.id === x.id)) continue;      // sent before: shown with its review's state
      const er = x.er && [x.er.er, x.er.n, x.er.total].every((v) => Number.isFinite(+v)) ? { er: +x.er.er, n: +x.er.n, total: +x.er.total } : null;
      const e = { id: x.id, kind: chk.kind, title: gameTitle(chk.kind, { length: chk.rules.length }, created), mat: x.mat, ply: chk.ply, result: matResult(chk), er, created, status: 'local', source: 'pwa' };
      S.saved.unshift(e); added.push(e);
    }
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();   // close the keyboard
    S.ui.imp = { review: [...new Set(review)], track: forProgress, refused };
    save(); clearHash(); openMenu('imported');
    for (const e of added) await sendOne(e, null);   // the summary shows each one's state: no toasts
    if (window.PG) PG.scan();                        // the games for review go to your progress too
  } catch (e) { pasteMsg(e.message || String(e)); }
}
// The tile's paste box on the start and end screens.
function pasteZone() {
  return TARGET === 'tile' ? `<label class="zonewrap"><span class="small muted">Games from the offline app</span><textarea id="pasteZone" class="paste zone" rows="1" placeholder="Tap here, then Paste" oninput="pasteInput(this)" onblur="zoneBlur()"></textarea></label>` : '';
}
function zoneBlur() { if (sideLater) { sideLater = false; setTimeout(renderSide, 300); } }
function clearHash() {
  if (location.hash !== '#paste') return;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { try { location.hash = ''; } catch (e2) { /* keep it */ } }
}
// ---------------- the offline app: service worker, install
let installEvt = null;
function installBtn() { return installEvt ? `<div class="row">${btn('Install the app on this device', 'doInstall()', 'primary')}</div>` : ''; }
async function doInstall() { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch (e) { /* ignore */ } installEvt = null; renderMenu(); }
function setupPwa() {
  if (TARGET !== 'pwa' || !('serviceWorker' in navigator)) return;
  const ready = (w) => { $('update').classList.add('show'); $('update').onclick = () => w.postMessage('skipWaiting'); };
  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) ready(reg.waiting);
    reg.addEventListener('updatefound', () => { const w = reg.installing; if (!w) return; w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) ready(w); }); });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (S.game && S.game.phase !== 'over') save(); if (!reloading && $('update').classList.contains('show')) { reloading = true; location.reload(); } });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

// ------------------------------------------------------------- start
function boot() {
  load();
  if (window.PG) PG.init();
  if (window.BQ) BQ.init();
  document.body.classList.toggle('swapc', !!S.set.swapColour);
  if (S.game && S.game.phase !== 'over') {      // resume: results from before the 4-ply ER are redone when the engine starts
    for (const d of S.game.decisions) if (d.res && d.res.ply !== ER_PLY) delete d.res;
  }
  const svg = $('board');
  svg.addEventListener('pointerdown', onDown); svg.addEventListener('pointermove', onMove); svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', () => { drag = null; drawBoard(); });
  document.addEventListener('keydown', onKey);
  new ResizeObserver(() => drawBoard()).observe($('boardWrap'));
  window.addEventListener('online', () => { flushQueue(); renderAll(); });
  window.addEventListener('offline', () => renderAll());
  renderAll();
  loadBook(); loadEngine(); setupPwa();
  document.addEventListener('paste', (ev) => {      // a paste anywhere (Ctrl+V on a computer, or into a box)
    const t = ev.clipboardData && ev.clipboardData.getData('text');
    const box = ev.target && (ev.target.id === 'pasteZone' || ev.target.id === 'pasteBox');
    if (t && /BGPLAY-(GAMES|BOOK) /.test(t)) { ev.preventDefault(); importText(t); }
    else if (box && t) { ev.preventDefault(); pasteMsg(notOurs()); }
  });
  // #paste: the paste screen (from the offline app); #quiz: straight into the Blunder Quiz
  const route = () => { if (TARGET === 'tile' && location.hash === '#paste' && S.ui.menu !== 'paste') openPaste('games'); else if (TARGET === 'tile' && location.hash === '#quiz' && window.BQ && !BQ.on) BQ.open(); };
  window.addEventListener('hashchange', route); route();
  if (TARGET === 'pwa' && unsent().length) prepareBundle();
  if (TARGET === 'tile' && window.claude && typeof window.claude.use === 'function') {
    window.claude.use('db').then((x) => { CAP.db = x; if (x) { flushQueue(); watchReviews(); if (window.PG) PG.setDb(x); if (window.BQ) BQ.setDb(x); } }).catch(() => {});
    window.claude.use('mcp').then((x) => { CAP.mcp = x; }).catch(() => {});
    window.claude.use('downloads').then((x) => { CAP.dl = x; }).catch(() => {});
  }
}
boot();
