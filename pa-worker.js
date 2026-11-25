// BG Position Analyzer: one Open Sage engine (WebAssembly) per worker.
// Messages in: {id, cmd, ...}; out: {id, ok, result, ms} | {id, ok:false, error} | {id, progress:[done,total]}.
// Boards: 26 ints from the side on roll ([0] opponent's bar, [1..24] points, + = side on roll, [25] own bar).
// g (game/cube): {cv, co, jac, bea, a1, a2, cr}: cube value; owner 0 centred / 1 side on roll / 2 opponent;
// Jacoby, beavers; away scores (0 = money); Crawford.
let M = null, buf = { b: 0, c: 0 }, curId = 0;
const ROLLS = []; for (let a = 1; a <= 6; a++) for (let b = a; b <= 6; b++) ROLLS.push([a, b]);

function strArg(s) { const n = M.lengthBytesUTF8(s) + 1, p = M._malloc(n); M.stringToUTF8(s, p, n); return p; }
function put(slot, b) { M.HEAP32.set(b, slot >> 2); return slot; }
function take(p) {
  if (!p) throw new Error(M.UTF8ToString(M._te_error()) || 'engine error');
  const s = M.UTF8ToString(p); M._te_free(p); return JSON.parse(s);
}
const G = (g) => [g.cv, g.co, g.jac ? 1 : 0, g.bea ? 1 : 0, g.a1 || 0, g.a2 || 0, g.cr ? 1 : 0];
// A finished game (one side has borne off all 15) can't be given to the engine: it throws.
// over(b): null while both sides have checkers; else the result from the side on roll's view.
function over(b, g) {
  let me = b[25], op = b[0]; for (let p = 1; p <= 24; p++) { if (b[p] > 0) me += b[p]; else if (b[p] < 0) op -= b[p]; }
  if (me && op) return null;
  const won = !me, loser = won ? -1 : 1;                       // loser's sign on this board
  let left = won ? op : me, inHome = false;
  for (let p = 1; p <= 24; p++) {
    const q = won ? p : 25 - p;                                  // winner's home = 1..6 in the winner's numbering
    if (p <= 6 && b[q] * loser > 0) inHome = true;
  }
  if ((won ? b[0] : b[25]) > 0) inHome = true;
  const gam = left === 15, bg = gam && inHome;
  const money = !(g.a1 || 0), jacoby = money && g.jac && g.co === 0;
  const mult = jacoby ? 1 : 1 + (gam ? 1 : 0) + (bg ? 1 : 0), e = won ? mult : -mult;
  const probs = won ? [1, gam ? 1 : 0, bg ? 1 : 0, 0, 0] : [0, 0, 0, gam ? 1 : 0, bg ? 1 : 0];
  return { e, probs };
}
const finished = (o) => ({ probs: o.probs, cubeless_equity: o.e, equity_nd: o.e, equity_dt: o.e, equity_dp: o.e, should_double: false, should_take: true,
  optimal_equity: o.e, optimal_action: 'Game over', is_beaver: false, eval_level: 'final' });
const E = {
  legal: (b, d1, d2) => over(b, {}) ? [] : take(M._te_legal(put(buf.b, b), d1, d2)),
  moves: (b, d1, d2, g) => over(b, g) ? [] : take(M._te_moves(put(buf.b, b), d1, d2, ...G(g))),
  // cand is the mover's board after the play: if it ends the game, the mover has won.
  evalN: (b, c, ply, g) => { const o = over(c, g); return o ? { e: o.e, p: o.probs } : take(M._te_eval(put(buf.b, b), put(buf.c, c), ply, ...G(g))); },
  cube: (b, ply, g) => { const o = over(b, g); return o ? finished(o) : take(M._te_cube(put(buf.b, b), ply, ...G(g))); },
  rollPlay: (post, preset, n, seed, g) => { const o = over(post, g); return o ? { e: o.e, se: 0, p: o.probs } : take(M._te_rollout_play(put(buf.b, post), preset, n, seed, ...G(g))); },
  rollCube: (b, preset, n, seed, g) => take(M._te_rollout_cube(put(buf.b, b), preset, n, seed, ...G(g))),
};

// ------------------------------------------------------------- helpers (all in the side-on-roll's numbering)
function flip(b) { const r = new Array(26).fill(0); r[0] = b[25]; r[25] = b[0]; for (let p = 1; p <= 24; p++) r[p] = -b[25 - p]; return r; }
const W = (r) => (r[0] === r[1] ? 1 : 2);
const rollStr = (r) => `${Math.max(r[0], r[1])}-${Math.min(r[0], r[1])}`;
// The other side's view of the game settings.
function swapG(g) { return { ...g, co: g.co === 1 ? 2 : g.co === 2 ? 1 : 0, a1: g.a2, a2: g.a1 }; }
function pips(b) {
  let me = 25 * b[25], op = 25 * b[0];
  for (let p = 1; p <= 24; p++) { if (b[p] > 0) me += p * b[p]; else if (b[p] < 0) op += (25 - p) * -b[p]; }
  return [me, op];
}
// Rolls (of 36) on which the opponent can hit at least one of the mover's blots, after the mover's play.
function shots(after) {
  const opp = flip(after), blots = [];
  for (let q = 1; q <= 24; q++) if (opp[q] === -1) blots.push(q);
  const per = {}, perRolls = {}; blots.forEach((q) => { per[25 - q] = 0; perRolls[25 - q] = []; });
  let n = 0; const rolls = [];
  if (!blots.length) return { n, rolls, per, perRolls, duplicated: 0 };
  for (const r of ROLLS) {
    const res = E.legal(opp, r[0], r[1]); let any = false;
    for (const q of blots) if (res.some((x) => x[q] > 0)) { per[25 - q] += W(r); perRolls[25 - q].push(rollStr(r)); any = true; }
    if (any) { n += W(r); rolls.push(rollStr(r)); }
  }
  // Duplication: rolls that hit more than one blot are counted once in n.
  const duplicated = Object.values(per).reduce((a, b) => a + b, 0) - n;
  return { n, rolls, per, perRolls, duplicated };
}
function longestPrime(points) {
  let best = 0, run = 0, prev = null;
  for (const p of points.slice().sort((a, b) => a - b)) { run = prev !== null && p === prev + 1 ? run + 1 : 1; best = Math.max(best, run); prev = p; }
  return best;
}
function structure(b) {
  const made = [], blots = [], oppMade = [], oppBlots = [];
  for (let p = 1; p <= 24; p++) { if (b[p] >= 2) made.push(p); if (b[p] === 1) blots.push(p); if (b[p] <= -2) oppMade.push(p); if (b[p] === -1) oppBlots.push(p); }
  const [pm, po] = pips(b);
  let low = 0; for (let p = 1; p <= 3; p++) if (b[p] > 0) low += b[p];
  return { blots, points: made, home_points: made.filter((p) => p <= 6), prime: longestPrime(made), anchors: made.filter((p) => p >= 18),
    checkers_on_1to3: low, back_checkers: (() => { let n = b[25]; for (let p = 19; p <= 24; p++) if (b[p] > 0) n += b[p]; return n; })(),
    on_bar: b[25], opp_blots: oppBlots, opp_points: oppMade, opp_home_points: oppMade.filter((p) => p >= 19), opp_prime: longestPrime(oppMade),
    opp_anchors: oppMade.filter((p) => p <= 7), opp_on_bar: b[0], pips: pm, opp_pips: po };
}
// White's checkers on the bar after Blue's play: rolls of 36 that bring them all in, leave some out, or dance completely.
// White enters on the board's points 1-6 (die d -> point d); a point Blue has made (2+ checkers) is closed.
function entering(after) {
  const n = after[0]; if (!n) return null;
  const open = (d) => after[d] < 2;
  let all = 0, some = 0, none = 0;
  for (const [a, b] of ROLLS) {
    const w = W([a, b]), k = a === b ? (open(a) ? 4 : 0) : (open(a) ? 1 : 0) + (open(b) ? 1 : 0);
    if (k >= n) all += w; else if (k > 0) some += w; else none += w;
  }
  return { white_checkers_on_the_bar: n, rolls_bringing_all_in: all, rolls_leaving_some_on_the_bar: some, rolls_dancing_completely: none };
}
function facts(after) {
  const s = shots(after), en = entering(after);
  return { ...structure(after), shots: s.n, shot_rolls: s.rolls, shots_per_blot: s.per, hitting_rolls_per_blot: s.perRolls,
    shots_saved_by_duplication: s.duplicated, ...(en ? { white_entering: en } : {}) };
}
// White's best reply (chosen at 1-ply, as in replyRows) to each of its 21 rolls after one play: shots are not hits,
// so count the rolls on which that reply really hits a Blue blot (and hits two), and the rolls on which White dances.
function replyHits(after, g) {
  const blots = []; for (let p = 1; p <= 24; p++) if (after[p] === 1) blots.push(p);
  if (!blots.length && !after[0]) return null;
  const opp = flip(after), go = swapG(g), rolls = [];
  let one = 0, two = 0, dance = 0;
  for (const r of ROLLS) {
    const ms = E.moves(opp, r[0], r[1], go), w = W(r);
    if (!ms.length) { if (opp[25] > 0) dance += w; continue; }
    const nb = ms[0].b; let h = 0;
    for (const p of blots) if (nb[25 - p] >= 0) h++;
    if (h) { one += w; rolls.push(rollStr(r)); }
    if (h >= 2) two += w;
  }
  return { rolls_of_36_where_it_hits: one, rolls_of_36_where_it_hits_two_blots: two, rolls_of_36_where_white_dances: dance, hitting_rolls: rolls };
}
// What the play itself changed: Blue's points made and given up, White checkers sent to the bar.
function changes(b0, b1) {
  const made = [], broken = [];
  for (let p = 1; p <= 24; p++) { if (b1[p] >= 2 && b0[p] < 2) made.push(p); if (b0[p] >= 2 && b1[p] < 2) broken.push(p); }
  return { points_made: made, points_given_up: broken, white_checkers_hit: Math.max(0, b1[0] - b0[0]) };
}
// The opponent's best reply to each of its 21 rolls after the mover's play, and the mover's equity after it.
function replyRows(after, g, ply = 2, rolls = ROLLS) {
  const opp = flip(after), go = swapG(g), rows = {};
  const mineBefore = []; for (let p = 1; p <= 24; p++) if (after[p] === 1) mineBefore.push(p);
  for (const r of rolls) {
    const ms = E.moves(opp, r[0], r[1], go);
    let eq, nb, dance = false, move = '(no move)';
    // The reply is chosen at 1-ply; the position after it is valued at `ply` (2 for the quick pass, 3 for the deep pass).
    if (!ms.length) { nb = opp; dance = opp[25] > 0; eq = E.cube(after, ply, g).equity_nd; }
    else { nb = ms[0].b; eq = -E.evalN(opp, nb, ply, go).e; }
    const hits = [], pointed = [], lands = [];
    for (const p of mineBefore) if (nb[25 - p] >= 0) { hits.push(p); if (nb[25 - p] >= 2) pointed.push(p); }
    for (let q = 13; q <= 24; q++) if (nb[q] > Math.max(opp[q], 0)) lands.push(25 - q);
    if (ms.length) move = mirror(notation(opp, nb, r[0], r[1]));
    const ours = flip(nb);
    rows[rollStr(r)] = { w: W(r), eq, move, hits, pointed, lands, dance, blue_shots_next: shotsAt(ours) };
  }
  return rows;
}
// Rolls of 36 on which the side on roll (board b) can hit an opposing blot.
function shotsAt(b) {
  const blots = []; for (let p = 1; p <= 24; p++) if (b[p] === -1) blots.push(p);
  if (!blots.length) return 0;
  let n = 0;
  for (const r of ROLLS) { const res = E.legal(b, r[0], r[1]); if (res.some((x) => x[0] > b[0])) n += W(r); }
  return n;
}
const groupOf = (row) => row.dance ? 'White dances' : row.hits.length ? (row.pointed.length ? 'White points on Blue\'s blot on ' : 'White hits Blue\'s blot on ') + row.hits.join(' and ') : 'no hit';
// A White move written in White's numbering, rewritten in Blue's (the board's) numbering.
const mirror = (m) => m.replace(/\b(\d+)\b(?!\))/g, (x) => String(25 - +x));
// White's rolls after one play, from Blue's side: jokers (the rolls that hurt Blue most), awkward rolls (the rolls
// that help Blue most), and the rolls after which White leaves Blue a shot.
function whiteRolls(rows) {
  const list = ROLLS.map((r) => ({ k: rollStr(r), ...rows[rollStr(r)] }));
  const mean = list.reduce((a, x) => a + x.eq * x.w, 0) / 36;
  const jokers = list.filter((x) => x.eq <= mean - 0.2).sort((a, b) => a.eq - b.eq);
  const awkward = list.filter((x) => x.eq >= mean + 0.12).sort((a, b) => b.eq - a.eq);
  const shot = list.filter((x) => x.blue_shots_next > 0);
  const n = (xs) => xs.reduce((a, x) => a + x.w, 0);
  return { white_jokers: { rolls_of_36: n(jokers), rolls: jokers.map((x) => `${x.k} ${x.move}`).slice(0, 8) },
    white_awkward_rolls: { rolls_of_36: n(awkward), rolls: awkward.map((x) => `${x.k} ${x.move}`).slice(0, 8) },
    white_rolls_that_leave_blue_a_shot: { rolls_of_36: n(shot), rolls: shot.map((x) => x.k) } };
}
function whyCompare(best, other, g) { return whyGroup(replyRows(best, g), replyRows(other, g), 2); }
// Group White's 21 replies after two plays (rows from replyRows), largest share of the gap first (bgkit's Why section).
function whyGroup(A, B, ply) {
  const groups = {};
  let gap = 0;
  for (const r of ROLLS) {
    const k = rollStr(r), a = A[k], b = B[k], key = `${groupOf(a)} | ${groupOf(b)}`;
    const share = (b.eq - a.eq) * a.w / 36; gap += share;
    const gr = groups[key] || (groups[key] = { group: key, rolls_of_36: 0, share: 0, rolls: [] });
    gr.rolls_of_36 += a.w; gr.share += share; gr.rolls.push({ k, s: Math.abs((b.eq - a.eq) * a.w) });
  }
  const out = Object.values(groups).sort((x, y) => Math.abs(y.share) - Math.abs(x.share)).slice(0, 5).map((gr) => {
    gr.rolls.sort((x, y) => y.s - x.s);
    return { group: gr.group, rolls_of_36: gr.rolls_of_36, share: +gr.share.toFixed(3),
      favours: gr.share < 0 ? 'the best play' : 'the other play', part_of_gap: Math.abs(gap) >= 0.002 ? +(gr.share / gap).toFixed(2) : null, rolls: gr.rolls.map((x) => x.k),
      examples: gr.rolls.slice(0, 2).map(({ k }) => ({ roll: k,
        after_best: { white_reply: A[k].move, hits: A[k].hits, blue_shots_next: A[k].blue_shots_next },
        after_other: { white_reply: B[k].move, hits: B[k].hits, blue_shots_next: B[k].blue_shots_next } })) };
  });
  return { [`gap_${ply}ply`]: +gap.toFixed(3), groups: out, white_rolls_after_best: whiteRolls(A), white_rolls_after_other: whiteRolls(B) };
}
// The mover's next roll if the opponent stands still: rolls of 36 that make a new point, by point.
function nextRoll(after, g) {
  let any = 0; const by = {};
  for (const r of ROLLS) {
    const ms = E.moves(after, r[0], r[1], g); if (!ms.length) continue;
    const nb = ms[0].b, made = [];
    for (let p = 1; p <= 24; p++) if (nb[p] >= 2 && after[p] < 2) made.push(p);
    if (made.length) { any += W(r); made.forEach((p) => { by[p] = (by[p] || 0) + W(r); }); }
  }
  return { rolls_that_make_a_new_point: any, by_point: by };
}
// What the side on roll's best play does with a roll (cube tables).
function rollTags(before, after) {
  if (after.every((v, i) => v === before[i])) return before[25] ? 'dances' : 'no move';
  const tags = [];
  const hits = after[0] - before[0];
  if (hits > 0) tags.push(hits === 1 ? 'hits' : `hits ${hits}`);
  if (before[25] && after[25] < before[25] && hits <= 0) tags.push('enters');
  const s = shots(after).n; if (s) tags.push(`leaves ${s} shots`);
  if (after[0] > 0 && [1, 2, 3, 4, 5, 6].every((p) => after[p] >= 2)) tags.push('closes out');
  const made = []; for (let p = 24; p >= 1; p--) if (after[p] >= 2 && before[p] < 2) made.push(p);
  if (made.length) tags.push('makes ' + made.join(','));
  const on = (x) => { let n = x[25]; for (let p = 1; p <= 24; p++) if (x[p] > 0) n += x[p]; return n; };
  if (on(before) > on(after)) tags.push(`bears off ${on(before) - on(after)}`);
  return tags.length ? tags.join(', ') : 'quiet';
}
function cubeRows(board, rolls, g) {
  const out = [], gr = swapG(g), rOwner = g.co === 0 ? 0 : g.co === 1 ? 2 : 1;
  for (const r of rolls) {
    const ms = E.moves(board, r[0], r[1], g), nb = ms.length ? ms[0].b : board, opp = flip(nb);
    const nd = E.cube(opp, 2, { ...gr, co: rOwner }), dt = E.cube(opp, 2, { ...gr, cv: g.cv * 2, co: 1 });
    // Market: after each White reply (1-ply), would White pass a double from Blue next turn?
    // Also: White's rolls that bear off White's last checker (and the ones that miss), and White's shots at Blue.
    let passes = 0, whiteEnds = 0; const whiteMisses = [], done = !!over(nb, g);
    if (!done) for (const q of ROLLS) {
      const rep = E.moves(opp, q[0], q[1], gr), after = rep.length ? rep[0].b : opp, back = flip(after);
      if (over(after, gr)) { whiteEnds += W(q); continue; } else whiteMisses.push(rollStr(q));
      if (g.co === 2) continue;
      const c = E.cube(back, 1, g);
      if (c.equity_dt > c.equity_dp + 1e-9) passes += W(q);
    }
    out.push({ roll: rollStr(r), w: W(r), play: ms.length ? notation(board, nb, r[0], r[1]) : '(no move)', tags: rollTags(board, nb),
      nd: -nd.optimal_equity, dt: -2 * dt.optimal_equity, win: 1 - nd.probs[0], gammon: nd.probs[3], opp_gammon: nd.probs[1],
      white_replies_leaving_a_pass: passes, ends_game: done,
      white_rolls_ending_the_game: done ? null : whiteEnds, white_rolls_not_ending_it: done || !whiteEnds ? null : whiteMisses,
      white_shots: done ? 0 : shots(nb).n,
      // White's cube turn after this roll: does White double and Blue have to pass? (cube as now; and with White owning it at 2 after a take)
      white_cashes: !!(nd.should_double && !nd.should_take), white_cashes_after_take: !!(dt.should_double && !dt.should_take) });
  }
  return out;
}

// ------------------------------------------------------------- bear-off counts (exact, for the side on roll in board b)
// Only when that side has all its checkers home, no contact remains, and few checkers are left.
function noContact(b) { let hiMe = 0, loOp = 25; for (let p = 1; p <= 24; p++) { if (b[p] > 0) hiMe = Math.max(hiMe, p); if (b[p] < 0) loOp = Math.min(loOp, p); } return !b[0] && !b[25] && hiMe < loOp; }
function left(b) { let n = 0; for (let p = 1; p <= 24; p++) if (b[p] > 0) n += b[p]; return n; }
function allHome(b) { for (let p = 7; p <= 24; p++) if (b[p] > 0) return false; return !b[25]; }
const finishMemo = new Map();
function finishRolls(b) {            // rolls of 36 that bear off every checker this turn, and the rolls that don't
  const key = b.join(','); if (finishMemo.has(key)) return finishMemo.get(key);
  let n = 0; const miss = [];
  for (const r of ROLLS) { if (E.legal(b, r[0], r[1]).some((x) => left(x) === 0)) n += W(r); else miss.push(rollStr(r)); }
  const out = { n, miss }; if (finishMemo.size > 5000) finishMemo.clear(); finishMemo.set(key, out); return out;
}
function bearCounts(b) {
  if (!noContact(b) || !allHome(b)) return null;
  const k = left(b); if (!k || k > 8) return null;
  // Name the shorter list: the missing rolls, or (when most rolls miss) the finishing rolls, with the count of 36 either way.
  const now = finishRolls(b), fin = ROLLS.map(rollStr).filter((x) => !now.miss.includes(x));
  const out = { checkers_left: k, bears_off_this_turn_of_36: now.n, ...(now.miss.length <= 12 || fin.length > now.miss.length ? { missing_rolls: now.miss } : { finishing_rolls: fin, misses_with_rolls_of_36: 36 - now.n }) };
  if (now.n < 36 && k <= 8) {          // two turns in a row (the other side's roll doesn't change this side's position): best play for the second roll
    let seq = 0;
    for (const r of ROLLS) {
      const res = E.legal(b, r[0], r[1]); let best = 0;
      for (const x of res) { if (left(x) === 0) { best = 36; break; } best = Math.max(best, finishRolls(x).n); }
      seq += W(r) * best;
    }
    out.bears_off_within_two_turns_of_1296 = seq;
  }
  return out;
}

// ------------------------------------------------------------- move notation (shared with the page)
function singleMoves(b, die) {
  const out = [];
  const tryMove = (frm, to) => {
    if (to >= 1 && b[to] < -1) return;
    const nb = b.slice(); nb[frm]--; let hit = false;
    if (to >= 1) { if (nb[to] === -1) { nb[to] = 0; nb[0]++; hit = true; } nb[to]++; }
    out.push([frm, Math.max(to, 0), hit, nb]);
  };
  if (b[25] > 0) { tryMove(25, 25 - die); return out; }
  let outside = 0; for (let p = 7; p <= 24; p++) if (b[p] > 0) outside += b[p];
  for (let p = 24; p >= 1; p--) {
    if (b[p] <= 0) continue;
    const to = p - die;
    if (to >= 1) tryMove(p, to);
    else if (outside === 0) {
      if (to === 0) tryMove(p, 0);
      else { let higher = false; for (let q = p + 1; q <= 6; q++) if (b[q] > 0) higher = true; if (!higher) tryMove(p, 0); }
    }
  }
  return out;
}
function notation(before, after, d1, d2) {
  const same = (x, y) => x.every((v, i) => v === y[i]);
  const search = (b, dice) => {
    const tried = new Set();
    for (let i = 0; i < dice.length; i++) {
      if (tried.has(dice[i])) continue; tried.add(dice[i]);
      const rest = dice.slice(0, i).concat(dice.slice(i + 1));
      for (const [f, t, h, nb] of singleMoves(b, dice[i])) {
        if (b[f] <= after[f]) continue;
        if (same(nb, after)) return [[f, t, h]];
        if (!rest.length) continue;
        const tail = search(nb, rest); if (tail) return [[f, t, h]].concat(tail);
      }
    }
    return null;
  };
  const plays = search(before, d1 === d2 ? [d1, d1, d1, d1] : [d1, d2]);
  if (!plays) return '?';
  const steps = [];
  for (const [f, t, h] of plays) {
    let j = steps.length - 1;
    for (; j >= 0; j--) if (steps[j][1] === f && !steps[j][2]) { steps[j] = [steps[j][0], t, h]; break; }
    if (j < 0) steps.push([f, t, h]);
  }
  steps.sort((a, b) => b[0] - a[0] || b[1] - a[1] || (b[2] - a[2]));
  const parts = [];
  for (const s of steps) { const last = parts[parts.length - 1]; if (last && last.s[0] === s[0] && last.s[1] === s[1] && last.s[2] === s[2]) last.n++; else parts.push({ s, n: 1 }); }
  return parts.map(({ s, n }) => `${s[0] === 25 ? 'bar' : s[0]}/${s[1] === 0 ? 'off' : s[1]}${s[2] ? '*' : ''}${n > 1 ? `(${n})` : ''}`).join(' ') || 'no move';
}

// ------------------------------------------------------------- init and dispatch
async function init(weights, manifest) {
  const t0 = performance.now();
  importScripts('engine.js');
  M = await createEngine({ locateFile: (f) => f });
  const u8 = new Uint8Array(weights);
  M.FS.mkdir('/w');
  const paths = [];
  for (const n of manifest.nets) { M.FS.writeFile('/w/' + n.name, u8.subarray(n.off, n.off + n.size)); paths.push('/w/' + n.name); }
  const bo = manifest.bearoff; M.FS.writeFile('/w/' + bo.name, u8.subarray(bo.off, bo.off + bo.size));
  const a = strArg(manifest.type), b = strArg(paths.join('\n')), c = strArg(manifest.nets.map((n) => n.hidden).join(',')), d = strArg('/w/' + bo.name);
  const ok = M._te_create(a, b, c, d); [a, b, c, d].forEach((p) => M._free(p));
  if (!ok) throw new Error('engine create failed: ' + M.UTF8ToString(M._te_error()));
  buf.b = M._malloc(26 * 4); buf.c = M._malloc(26 * 4);
  let last = 0;
  self.__teProgress = (done, total) => { const now = performance.now(); if (now - last > 250 || done === total) { last = now; self.postMessage({ id: curId, progress: [done, total] }); } };
  return { initMs: performance.now() - t0 };
}
self.onmessage = async (ev) => {
  const m = ev.data, t0 = performance.now(); curId = m.id;
  try {
    let result;
    switch (m.cmd) {
      case 'init': result = await init(m.weights, m.manifest); break;
      case 'reset': M._te_reset_cache(); result = 1; break;
      case 'moves': result = E.moves(m.board, m.d1, m.d2, m.g).map((x) => ({ ...x, name: notation(m.board, x.b, m.d1, m.d2) })); break;
      case 'eval': result = E.evalN(m.board, m.cand, m.ply, m.g); break;
      case 'cube': result = E.cube(m.board, m.ply, m.g); break;
      case 'rollPlay': result = E.rollPlay(m.post, m.preset, m.n, m.seed, m.g); break;
      case 'rollCube': result = E.rollCube(m.board, m.preset, m.n, m.seed, m.g); break;
      case 'facts': result = m.afters.map((a) => {
        let f;
        if (noContact(a)) {      // a race or bear-off: no blots, shots or point-making, only what matters there
          const st = structure(a);
          f = { no_contact: true, pips: st.pips, opp_pips: st.opp_pips, checkers_on_1to3: st.checkers_on_1to3, gaps_on_points_4_to_6: [4, 5, 6].filter((q) => a[q] <= 0), checkers_left: left(a) };
        } else {
          f = { ...(m.before ? { play_changes: changes(m.before, a) } : {}), ...facts(a), next_roll: nextRoll(a, m.g) };
          const rh = replyHits(a, m.g); if (rh) f.white_best_reply = rh;
        }
        // Bear-offs: Blue's next turn from this position, and White's turn that comes first.
        const bo = bearCounts(a), wo = bearCounts(flip(a));
        if (bo || wo) f.bear_off = { blue_next_turn: bo, white_turn_first: wo };
        return f;
      }); break;
      case 'bear': result = m.boards.map((x) => bearCounts(x)); break;
      case 'why': result = whyCompare(m.best, m.other, m.g); break;
      // Deep pass: White's replies for some of the rolls at a given depth (split across workers), then grouped.
      case 'replyRows': result = replyRows(m.after, m.g, m.ply, m.rolls); break;
      case 'whyGroup': result = whyGroup(m.A, m.B, m.ply); break;
      case 'cubeRows': result = cubeRows(m.board, m.rolls, m.g); break;
      default: throw new Error('unknown command ' + m.cmd);
    }
    self.postMessage({ id: m.id, ok: true, result, ms: performance.now() - t0 });
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: typeof e === 'number' ? `the engine stopped on this position (${m.cmd})` : String((e && e.message) || e) });
  }
};
