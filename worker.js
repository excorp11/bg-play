// BG Play: one Open Sage engine (WebAssembly) per worker, as in the BG Position Analyzer.
// Messages in: {id, cmd, ...}; out: {id, ok, result, ms} | {id, ok:false, error}.
// Boards: 26 ints from the side on roll ([0] opponent's bar, [1..24] points, + = side on roll, [25] own bar).
// g: {cv, co, jac, bea, a1, a2, cr}: cube value; owner 0 centred / 1 side on roll / 2 opponent; Jacoby, beavers;
// away scores (0 = money); Crawford game.
// The engine: Open Sage 2.1.20261122 built for WebAssembly with the accurate hidden-layer sigmoid
// (claude/engine-update.md). engine.js and engine.wasm are one pair: the ?v= keeps a cache from mixing an old one
// with a new one. Change ENGINE_V with every new engine build.
const ENGINE_V = '2.1.20261122.1';
let M = null; const buf = { b: 0, c: 0 };
function strArg(s) { const n = M.lengthBytesUTF8(s) + 1, p = M._malloc(n); M.stringToUTF8(s, p, n); return p; }
function put(slot, b) { M.HEAP32.set(b, slot >> 2); return slot; }
function take(p) {
  if (!p) throw new Error(M.UTF8ToString(M._te_error()) || 'engine error');
  const s = M.UTF8ToString(p); M._te_free(p); return JSON.parse(s);
}
const G = (g) => [g.cv || 1, g.co || 0, g.jac ? 1 : 0, g.bea ? 1 : 0, g.a1 || 0, g.a2 || 0, g.cr ? 1 : 0];
// A finished game (one side has borne off all 15) can't be given to the engine: it throws. over(b): null while both
// sides have checkers; else the result from the side on roll's view.
function over(b, g) {
  let me = b[25], op = b[0]; for (let p = 1; p <= 24; p++) { if (b[p] > 0) me += b[p]; else if (b[p] < 0) op -= b[p]; }
  if (me && op) return null;
  const won = !me, loser = won ? -1 : 1;
  const left = won ? op : me; let inHome = false;
  for (let p = 1; p <= 6; p++) { const q = won ? p : 25 - p; if (b[q] * loser > 0) inHome = true; }
  if ((won ? b[0] : b[25]) > 0) inHome = true;
  const gam = left === 15, bg = gam && inHome;
  const money = !(g.a1 || 0), jacoby = money && g.jac && g.co === 0 && (g.cv || 1) === 1;
  const mult = jacoby ? 1 : 1 + (gam ? 1 : 0) + (bg ? 1 : 0), e = won ? mult : -mult;
  const probs = won ? [1, gam ? 1 : 0, bg ? 1 : 0, 0, 0] : [0, 0, 0, gam ? 1 : 0, bg ? 1 : 0];
  return { e, probs };
}
const finished = (o) => ({ probs: o.probs, cubeless_equity: o.e, equity_nd: o.e, equity_dt: o.e, equity_dp: o.e, should_double: false,
  should_take: true, optimal_equity: o.e, optimal_action: 'Game over', is_beaver: false, eval_level: 'final' });
const E = {
  legal: (b, d1, d2) => (over(b, {}) ? [] : take(M._te_legal(put(buf.b, b), d1, d2))),
  moves: (b, d1, d2, g) => (over(b, g) ? [] : take(M._te_moves(put(buf.b, b), d1, d2, ...G(g)))),
  // cand is the mover's board after the play: if it ends the game, the mover has won.
  evalN: (b, c, ply, g) => { const o = over(c, g); return o ? { e: o.e, p: o.probs } : take(M._te_eval(put(buf.b, b), put(buf.c, c), ply, ...G(g))); },
  cube: (b, ply, g) => { const o = over(b, g); return o ? finished(o) : take(M._te_cube(put(buf.b, b), ply, ...G(g))); },
  // For a roll's luck (the progress tracker): the best play's 1-ply equity for each of the 21 rolls (1-1, 2-1, 2-2, 3-1,
  // ... 6-6: high die 1 to 6, low die 1 to high), the position unchanged when a roll has no move.
  luck: (b, g) => {
    const out = [];
    for (let a = 1; a <= 6; a++) for (let c = 1; c <= a; c++) {
      const ms = E.moves(b, a, c, g);
      out.push(ms.length ? Math.max(...ms.map((m) => m.e)) : E.evalN(b, b, 1, g).e);
    }
    return out;
  },
};
async function init(weights, manifest) {
  const t0 = performance.now();
  importScripts('engine.js?v=' + ENGINE_V);
  M = await createEngine({ locateFile: (f) => f + '?v=' + ENGINE_V });
  const u8 = new Uint8Array(weights);
  M.FS.mkdir('/w');
  const paths = [];
  for (const n of manifest.nets) { M.FS.writeFile('/w/' + n.name, u8.subarray(n.off, n.off + n.size)); paths.push('/w/' + n.name); }
  const bo = manifest.bearoff; M.FS.writeFile('/w/' + bo.name, u8.subarray(bo.off, bo.off + bo.size));
  const a = strArg(manifest.type), b = strArg(paths.join('\n')), c = strArg(manifest.nets.map((n) => n.hidden).join(',')), d = strArg('/w/' + bo.name);
  const ok = M._te_create(a, b, c, d); [a, b, c, d].forEach((p) => M._free(p));
  if (!ok) throw new Error('engine create failed: ' + M.UTF8ToString(M._te_error()));
  buf.b = M._malloc(26 * 4); buf.c = M._malloc(26 * 4);
  return { initMs: performance.now() - t0 };
}
self.onmessage = async (ev) => {
  const m = ev.data, t0 = performance.now();
  try {
    let result;
    switch (m.cmd) {
      case 'init': result = await init(m.weights, m.manifest); break;
      case 'reset': M._te_reset_cache(); result = 1; break;
      case 'legal': result = E.legal(m.board, m.d1, m.d2); break;
      case 'moves': result = E.moves(m.board, m.d1, m.d2, m.g); break;
      case 'eval': result = E.evalN(m.board, m.cand, m.ply, m.g); break;
      case 'cube': result = E.cube(m.board, m.ply, m.g); break;
      case 'luck': result = E.luck(m.board, m.g); break;
      default: throw new Error('unknown command ' + m.cmd);
    }
    self.postMessage({ id: m.id, ok: true, result, ms: performance.now() - t0 });
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: typeof e === 'number' ? `the engine stopped on this position (${m.cmd})` : String((e && e.message) || e) });
  }
};
