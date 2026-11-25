// rules.js: backgammon rules for BG Play, with no engine: legal plays, partial moves, results, the cube,
// match scores and the Crawford rule, move notation, XGIDs and .mat game files.
// Boards are 26 ints from the side on roll: [0] the opponent's bar (a count), [1..24] the points in the side on
// roll's numbering (+ its checkers, - the opponent's), [25] its own bar. It moves 24 -> 1 and bears off below 1.
(function (root) {
  'use strict';
  const START = [0, -2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2, 0];
  const ROLLS = []; for (let a = 1; a <= 6; a++) for (let b = a; b <= 6; b++) ROLLS.push([a, b]);

  const flip = (b) => { const r = new Array(26).fill(0); r[0] = b[25]; r[25] = b[0]; for (let p = 1; p <= 24; p++) r[p] = -b[25 - p]; return r; };
  const key = (b) => b.join(',');
  const same = (a, b) => a.every((v, i) => v === b[i]);
  function counts(b) { let me = b[25], op = b[0]; for (let p = 1; p <= 24; p++) { if (b[p] > 0) me += b[p]; else op -= b[p]; } return { me, op }; }
  function pips(b) { let me = 25 * b[25], op = 25 * b[0]; for (let p = 1; p <= 24; p++) { if (b[p] > 0) me += p * b[p]; else if (b[p] < 0) op += (25 - p) * -b[p]; } return [me, op]; }
  function noContact(b) { let hi = 0, lo = 25; for (let p = 1; p <= 24; p++) { if (b[p] > 0) hi = Math.max(hi, p); if (b[p] < 0) lo = Math.min(lo, p); } return !b[0] && !b[25] && hi < lo; }
  function allHome(b) { if (b[25]) return false; for (let p = 7; p <= 24; p++) if (b[p] > 0) return false; return true; }

  // ---------------------------------------------------------------- moves
  // Every single-checker move with one die: {from, to (0 = off), hit, board}.
  function singleMoves(b, die) {
    const out = [];
    const go = (from, to) => {
      if (to >= 1 && b[to] < -1) return;
      const nb = b.slice(); nb[from]--; let hit = false;
      if (to >= 1) { if (nb[to] === -1) { nb[to] = 0; nb[0]++; hit = true; } nb[to]++; }
      out.push({ from, to: Math.max(to, 0), hit, board: nb });
    };
    if (b[25] > 0) { go(25, 25 - die); return out; }
    const home = allHome(b);
    for (let p = 24; p >= 1; p--) {
      if (b[p] <= 0) continue;
      const to = p - die;
      if (to >= 1) go(p, to);
      else if (home) {
        if (to === 0) go(p, 0);
        else { let higher = false; for (let q = p + 1; q <= 6; q++) if (b[q] > 0) { higher = true; break; } if (!higher) go(p, 0); }
      }
    }
    return out;
  }
  // The legal plays of a roll: the distinct boards they lead to (all dice that can be played, the larger die when only
  // one of two can be), how many dice they use, and one sequence of single moves for each board.
  function legalPlays(b, d1, d2) {
    const dice = d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
    const ends = [], seen = new Set();
    const rec = (bd, rem, seq) => {
      const k = key(bd) + '|' + rem.join('');
      if (seen.has(k)) return; seen.add(k);
      let any = false; const tried = new Set();
      for (let i = 0; i < rem.length; i++) {
        const d = rem[i]; if (tried.has(d)) continue; tried.add(d);
        const rest = rem.slice(0, i).concat(rem.slice(i + 1));
        for (const m of singleMoves(bd, d)) { any = true; rec(m.board, rest, seq.concat([{ from: m.from, to: m.to, hit: m.hit, die: d }])); }
      }
      if (!any) ends.push({ board: bd, seq });
    };
    rec(b.slice(), dice, []);
    let max = 0; for (const e of ends) max = Math.max(max, e.seq.length);
    let keep = ends.filter((e) => e.seq.length === max);
    if (max === 1 && d1 !== d2) {
      const big = Math.max(d1, d2), withBig = keep.filter((e) => e.seq[0].die === big);
      if (withBig.length) keep = withBig;
    }
    const L = new Map();
    for (const e of keep) if (!L.has(key(e.board))) L.set(key(e.board), e);
    return { max, plays: L, dice };
  }
  // A turn being entered checker by checker. remaining() keeps the dice in their display order.
  class Turn {
    constructor(board, d1, d2) {
      this.start = board.slice(); this.board = board.slice(); this.order = [d1, d2]; this.steps = [];
      const lp = legalPlays(board, d1, d2); this.max = lp.max; this.L = lp.plays; this.memo = new Map();
    }
    get doubles() { return this.order[0] === this.order[1]; }
    remaining() {
      if (this.doubles) return new Array(Math.max(0, this.max === 0 ? 0 : 4 - this.steps.length)).fill(this.order[0]);
      const used = this.steps.map((s) => s.die), out = [];
      for (const d of this.order) { const i = used.indexOf(d); if (i >= 0) used.splice(i, 1); else out.push(d); }
      return out;
    }
    get done() { return this.steps.length >= this.max; }
    swap() { if (!this.doubles) this.order.reverse(); }
    can(bd, rem, need) {
      if (need === 0) return this.L.has(key(bd));
      const mk = key(bd) + '|' + rem.slice().sort().join('') + '|' + need;
      if (this.memo.has(mk)) return this.memo.get(mk);
      let ok = false; const tried = new Set();
      for (let i = 0; i < rem.length && !ok; i++) {
        const d = rem[i]; if (tried.has(d)) continue; tried.add(d);
        const rest = rem.slice(0, i).concat(rem.slice(i + 1));
        for (const m of singleMoves(bd, d)) if (this.can(m.board, rest, need - 1)) { ok = true; break; }
      }
      this.memo.set(mk, ok); return ok;
    }
    // The single move of the checker on `from` by `die`, if it keeps the turn legal.
    allowed(from, die) {
      if (this.done) return null;
      const rem = this.remaining(), i = rem.indexOf(die); if (i < 0) return null;
      const rest = rem.slice(0, i).concat(rem.slice(i + 1));
      const m = singleMoves(this.board, die).find((x) => x.from === from);
      if (!m || !this.can(m.board, rest, this.max - this.steps.length - 1)) return null;
      return { ...m, die };
    }
    // Tap: the first die in display order, else the other one.
    tapMove(from) {
      const seen = new Set();
      for (const d of this.remaining()) { if (seen.has(d)) continue; seen.add(d); const m = this.allowed(from, d); if (m) return m; }
      return null;
    }
    // Drag: the steps that take the checker on `from` to `to` (0 = off). One die if possible (display order first),
    // else two or more dice, preferring a path that doesn't hit on the way.
    dragPath(from, to) {
      const rem = this.remaining(); if (!rem.length) return null;
      const tryPath = (dice) => {
        let bd = this.board, at = from, steps = [], left = rem.slice();
        for (const d of dice) {
          const i = left.indexOf(d); if (i < 0) return null; left.splice(i, 1);
          const m = singleMoves(bd, d).find((x) => x.from === at);
          if (!m || !this.can(m.board, left, this.max - this.steps.length - steps.length - 1)) return null;
          steps.push({ ...m, die: d }); bd = m.board; at = m.to;
          if (at === 0 && steps.length < dice.length) return null;
        }
        return at === to ? steps : null;
      };
      const singles = [...new Set(rem)];
      for (const d of singles) { const s = tryPath([d]); if (s) return s; }
      const combos = [];
      if (this.doubles) for (let n = 2; n <= rem.length; n++) combos.push(new Array(n).fill(rem[0]));
      else if (rem.length === 2) combos.push([rem[0], rem[1]], [rem[1], rem[0]]);
      const found = combos.map(tryPath).filter(Boolean);
      if (!found.length) return null;
      found.sort((a, b) => a.length - b.length || a.slice(0, -1).filter((s) => s.hit).length - b.slice(0, -1).filter((s) => s.hit).length);
      return found[0];
    }
    apply(m) { this.steps.push({ ...m, before: this.board }); this.board = m.board; }
    undo() { const s = this.steps.pop(); if (s) this.board = s.before; return s; }
    // Destinations for a checker that is being dragged (for highlighting).
    targets(from) {
      const out = new Set(), rem = this.remaining(); if (!rem.length) return out;
      for (let to = 0; to <= 24; to++) if (to !== from && this.dragPath(from, to)) out.add(to);
      return out;
    }
  }

  // ---------------------------------------------------------------- notation
  // "13/7 8/5", "bar/20 6/3*", "13/8(2) 6/1*(2)", "6/off 5/off", in the mover's numbering.
  function notation(before, after, d1, d2) {
    const search = (b, dice) => {
      const tried = new Set();
      for (let i = 0; i < dice.length; i++) {
        if (tried.has(dice[i])) continue; tried.add(dice[i]);
        const rest = dice.slice(0, i).concat(dice.slice(i + 1));
        for (const m of singleMoves(b, dice[i])) {
          if (b[m.from] <= after[m.from]) continue;
          if (same(m.board, after)) return [[m.from, m.to, m.hit]];
          if (!rest.length) continue;
          const tail = search(m.board, rest); if (tail) return [[m.from, m.to, m.hit]].concat(tail);
        }
      }
      return null;
    };
    if (same(before, after)) return 'no move';
    const plays = search(before, d1 === d2 ? [d1, d1, d1, d1] : [d1, d2]);
    if (!plays) return '?';
    return stepsText(plays.map(([f, t, h]) => ({ from: f, to: t, hit: h })));
  }
  function stepsText(stepList) {
    const steps = [];
    for (const s of stepList) {
      let j = steps.length - 1;
      for (; j >= 0; j--) if (steps[j][1] === s.from && !steps[j][2]) { steps[j] = [steps[j][0], s.to, s.hit]; break; }
      if (j < 0) steps.push([s.from, s.to, s.hit]);
    }
    steps.sort((a, b) => b[0] - a[0] || b[1] - a[1] || (b[2] - a[2]));
    const parts = [];
    for (const s of steps) { const last = parts[parts.length - 1]; if (last && last.s[0] === s[0] && last.s[1] === s[1] && last.s[2] === s[2]) last.n++; else parts.push({ s, n: 1 }); }
    return parts.map(({ s, n }) => `${s[0] === 25 ? 'bar' : s[0]}/${s[1] === 0 ? 'off' : s[1]}${s[2] ? '*' : ''}${n > 1 ? `(${n})` : ''}`).join(' ') || 'no move';
  }

  // ---------------------------------------------------------------- results, cube, match
  // The finished game on board b (side on roll's view), or null: who won (+1 side on roll, -1 opponent) and the
  // kind (1 single, 2 gammon, 3 backgammon) before the cube and the Jacoby rule.
  function finished(b) {
    const c = counts(b);
    if (c.me && c.op) return null;
    const won = c.me === 0 ? 1 : -1;
    const loserLeft = won > 0 ? c.op : c.me;
    if (loserLeft < 15) return { won, kind: 1 };
    let back = won > 0 ? b[0] > 0 : b[25] > 0;            // the loser still on the bar or in the winner's home board
    for (let p = 1; p <= 6 && !back; p++) back = won > 0 ? b[p] < 0 : b[25 - p] > 0;
    return { won, kind: back ? 3 : 2 };
  }
  // Points a result is worth: kind x cube, except that in money play with the Jacoby rule an unturned cube makes
  // every win a single.
  function pointsFor(kind, cube, rules) {
    const k = rules.type === 'cash' && rules.jacoby && cube.value === 1 && cube.owner === 0 ? 1 : kind;
    return k * cube.value;
  }
  // May `side` ('me' | 'bot') double now? cube.owner: 0 centred, 'me' or 'bot'.
  function canDouble(side, cube, rules, match) {
    if (cube.owner && cube.owner !== side) return false;
    if (rules.type === 'cash') return cube.value < 32768;
    if (match.crawfordGame) return false;
    const away = rules.length - (side === 'me' ? match.score.me : match.score.bot);
    return away > cube.value;
  }

  // ---------------------------------------------------------------- XGID (side on roll as X; bottom player)
  const enc = (n, up) => (n ? String.fromCharCode((up ? 64 : 96) + n) : '-');
  // b: the side on roll's board; cubeOwner: 0 centred, 1 the side on roll, 2 the opponent.
  function xgid(b, cube, dice, rules, score) {
    let s = enc(b[0], false);
    for (let p = 1; p <= 24; p++) s += b[p] > 0 ? enc(b[p], true) : enc(-b[p], false);
    s += enc(b[25], true);
    const owner = cube.owner === 0 ? 0 : cube.owner === 1 ? 1 : -1;
    const d = dice ? `${Math.max(...dice)}${Math.min(...dice)}` : '00';
    const match = rules.type === 'match';
    const flag = match ? (score.crawford ? 1 : 0) : (rules.jacoby ? 1 : 0) | (rules.beavers ? 2 : 0);
    return `XGID=${s}:${Math.round(Math.log2(cube.value))}:${owner}:1:${d}:${match ? score.mine : 0}:${match ? score.theirs : 0}:${flag}:${match ? rules.length : 0}:10`;
  }

  // ---------------------------------------------------------------- .mat game files (Jellyfish / Galaxy layout)
  // games: [{score: [p1, p2], events: [{side: 1|2, type: 'roll', dice: [a, b], steps: [[from, to], ...]} |
  //   {side, type: 'double'|'beaver', value} | {side, type: 'take'|'drop'} | {side, type: 'win', points}]}].
  // Steps are in the mover's own numbering (25 = bar, 0 = off), one per die, as bgkit replays them.
  function matText(meta, games) {
    const pad2 = (n) => String(n).padStart(2, '0'), d = meta.date || new Date();
    const head = [
      `; [Site "${meta.site || 'BG Play vs Open Sage'}"]`, `; [Match ID "${meta.id}"]`,
      `; [Player 1 "${meta.p1}"]`, `; [Player 2 "${meta.p2}"]`,
      `; [EventDate "${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}"]`,
      `; [EventTime "${pad2(d.getHours())}.${pad2(d.getMinutes())}"]`, '; [Variation "Backgammon"]',
      `; [Jacoby "${meta.length ? 'Off' : meta.jacoby ? 'On' : 'Off'}"]`, `; [Beavers "${meta.length ? 'Off' : meta.beavers ? 'On' : 'Off'}"]`,
      `; [Crawford "${meta.length ? 'On' : 'Off'}"]`, `; [Engine "Open Sage ${meta.ply}-ply (on-device WebAssembly)"]`, '',
      ` ${meta.length || 0} point match`, ''];
    const out = head.slice();
    const tok = (e) => e.type === 'roll' ? `${Math.max(...e.dice)}${Math.min(...e.dice)}: ${e.steps.map(([f, t]) => `${f}/${t}`).join(' ')}`.trimEnd()
      : e.type === 'double' ? `Doubles => ${e.value}` : e.type === 'beaver' ? `Beavers => ${e.value}`
      : e.type === 'take' ? 'Takes' : e.type === 'drop' ? 'Drops' : `Wins ${e.points} point${e.points === 1 ? '' : 's'}`;
    games.forEach((g, gi) => {
      out.push(` Game ${gi + 1}`);
      out.push(` ${`${meta.p1} : ${g.score[0]}`.padEnd(33)}${meta.p2} : ${g.score[1]}`);
      const lines = []; let cur = null;
      for (const e of g.events) {
        if (e.type === 'win') { lines.push({ n: null, l: e.side === 1 ? tok(e) : '', r: e.side === 2 ? tok(e) : '' }); cur = null; continue; }
        if (e.side === 1) { cur = { l: tok(e), r: '' }; lines.push(cur); }
        else if (cur && !cur.r) cur.r = tok(e);
        else { cur = { l: '', r: tok(e) }; lines.push(cur); }
      }
      let n = 0;
      for (const L of lines) {
        const num = L.n === null ? '     ' : `${String(++n).padStart(3)}) `;
        out.push((num + L.l.padEnd(28) + (L.r ? ' ' + L.r : '')).trimEnd());
      }
      out.push('');
    });
    return out.join('\n') + '\n';
  }

  const api = { START, ROLLS, flip, key, same, counts, pips, noContact, allHome, singleMoves, legalPlays, Turn, notation, stepsText,
    finished, pointsFor, canDouble, xgid, matText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.R = api;
})(typeof self !== 'undefined' ? self : this);
