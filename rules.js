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
    // Tap on a point that holds none of your checkers (empty, or an opposing blot): two checkers made to land there, as
    // if each had been tapped (4-2 at the start: tap the 4 point = 8/4 6/4). Other rolls: one die each, the die shown
    // first tried first. Doubles: each checker by one or more of the dice left, fewest dice first (4-4, tap the 5
    // point: 9/5(2), else 9/5 13/5, else 13/5(2)). null when no pair keeps the turn legal.
    makePoint(p) {
      if (!(p >= 1 && p <= 24) || this.board[p] > 0 || this.board[p] < -1) return null;
      const rem = this.remaining(); if (rem.length < 2) return null;
      if (this.doubles) return this.makeWithDoubles(p, rem[0], rem.length);
      for (const [a, b] of [[rem[0], rem[1]], [rem[1], rem[0]]]) {
        const src = (d) => (this.board[25] > 0 ? 25 : p + d);
        const m1 = src(a) <= 25 ? this.allowed(src(a), a) : null; if (!m1 || m1.to !== p) continue;
        this.apply(m1);
        const m2 = src(b) <= 25 ? this.allowed(src(b), b) : null;
        this.undo();
        if (m2 && m2.to === p) return [m1, m2];
      }
      return null;
    }
    // Doubles: one checker from p + ka*d in ka steps, the other from p + kb*d in kb steps (25 = the bar); your other
    // checkers on the bar enter first (they must, and with doubles there's one entry point). The fewest dice first,
    // then the shorter of the longer paths (13/5(2) before 9/5 17/5 with 4-4).
    makeWithDoubles(p, d, n) {
      const onBar = this.board[25], pairs = [];
      for (let ka = 1; ka < n; ka++) for (let kb = ka; ka + kb <= n; kb++) {
        const sa = p + ka * d, sb = p + kb * d; if (sb > 25) continue;
        const ent = (sa === 25 ? 1 : 0) + (sb === 25 ? 1 : 0), e = ka === 1 && kb === 1 && ent === 2 ? 0 : Math.max(0, onBar - ent);
        if (e + ka + kb <= n) pairs.push([ka, kb, e]);
      }
      pairs.sort((x, y) => x[0] + x[1] + x[2] - (y[0] + y[1] + y[2]) || x[1] - y[1]);
      for (const [ka, kb, e] of pairs) {
        // the order of the steps: one checker then the other, the other way round, or turn about (two checkers on the
        // bar both enter before either moves on); entries of the other checkers on the bar come first
        const E = new Array(e).fill(2), A = new Array(ka).fill(0), B = new Array(kb).fill(1), alt = [];
        for (let i = 0; i < kb; i++) { if (i < ka) alt.push(0); alt.push(1); }
        for (const plan of [A.concat(B), B.concat(A), alt].map((q) => E.concat(q))) {
          const at = [p + ka * d, p + kb * d, 25], steps = [];
          for (const w of plan) { const m = this.allowed(at[w], d); if (!m) break; this.apply(m); steps.push(m); if (w < 2) at[w] = m.to; }
          for (let i = 0; i < steps.length; i++) this.undo();
          if (steps.length === plan.length && at[0] === p && at[1] === p) return steps;
        }
      }
      return null;
    }
    // Tap on your tray: every checker the dice left can bear off, as if each had been tapped; no move that doesn't bear
    // off. Each die takes off the checker on its own point, or the highest when none is higher (the only bear-off a die
    // allows). Other rolls try the dice in the order shown, then the other way round, and keep the order that takes off
    // more (the first on a tie). [] when none can come off.
    bearOffAll() {
      const rem = this.remaining(); if (!rem.length || this.done) return [];
      const orders = rem.length > 1 && rem[0] !== rem[1] ? [rem, rem.slice().reverse()] : [rem];
      let best = [];
      for (const order of orders) {
        const steps = [], left = order.slice();
        for (let progress = true; progress && left.length;) {
          progress = false;
          for (let i = 0; i < left.length; i++) {
            let m = null;
            for (let f = Math.min(6, left[i]); f >= 1 && !m; f--) { const x = this.board[f] > 0 ? this.allowed(f, left[i]) : null; if (x && x.to === 0) m = x; }
            if (!m) continue;
            this.apply(m); steps.push(m); left.splice(i, 1); progress = true; break;
          }
        }
        for (let i = 0; i < steps.length; i++) this.undo();
        if (steps.length > best.length) best = steps;
      }
      return best;
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

  // Reads back exactly the layout matText writes, and nothing else (the tile's paste check, and the reviews of saved
  // games). Throws an Error naming the first thing that doesn't fit. Returns {head, length, games: [{n, players,
  // score: [p1, p2], events}]}, events as matText takes them.
  const HEAD_KEYS = ['Site', 'Match ID', 'Player 1', 'Player 2', 'EventDate', 'EventTime', 'Variation', 'Jacoby', 'Beavers', 'Crawford', 'Engine'];
  function parseMat(text) {
    if (typeof text !== 'string') throw new Error('not text');
    if (text.length > 200000) throw new Error('too long for a BG Play game');
    if (/[^\x20-\x7e\n]/.test(text)) throw new Error('characters a BG Play game file never has');
    const head = {}, games = []; let length = null, cur = null, lineNo = 0;
    const fail = (why) => { throw new Error(`line ${lineNo}: ${why}`); };
    const tok = (s, side) => {
      let m;
      if ((m = /^([1-6])([1-6]):((?: (?:25|1[0-9]|2[0-4]|[1-9])\/(?:2[0-4]|1[0-9]|[0-9]))*)$/.exec(s))) {
        const steps = m[3].trim() ? m[3].trim().split(' ').map((x) => x.split('/').map(Number)) : [];
        if (steps.length > 4) fail('more than four steps');
        return { side, type: 'roll', dice: [+m[1], +m[2]], steps };
      }
      if ((m = /^Doubles => (\d{1,5})$/.exec(s))) return { side, type: 'double', value: +m[1] };
      if ((m = /^Beavers => (\d{1,5})$/.exec(s))) return { side, type: 'beaver', value: +m[1] };
      if (s === 'Takes') return { side, type: 'take' };
      if (s === 'Drops') return { side, type: 'drop' };
      if ((m = /^Wins (\d{1,5}) points?$/.exec(s))) return { side, type: 'win', points: +m[1] };
      return fail(`not a BG Play move: "${s.slice(0, 30)}"`);
    };
    for (const line of text.split('\n')) {
      lineNo++;
      if (!line.trim()) continue;
      let m;
      if (line.startsWith(';')) {
        if (games.length || length !== null) fail('a header after the moves');
        if (!(m = /^; \[([A-Za-z0-9 ]{1,20}) "([^"\[\]]{0,80})"\]$/.exec(line))) fail('not a header line');
        if (!HEAD_KEYS.includes(m[1]) || m[1] in head) fail(`unexpected header ${m[1]}`);
        head[m[1]] = m[2]; continue;
      }
      if ((m = /^ (\d{1,2}) point match$/.exec(line))) { if (length !== null || games.length) fail('a second match line'); length = +m[1]; continue; }
      if ((m = /^ Game (\d{1,3})$/.exec(line))) {
        if (length === null) fail('a game before the match line');
        if (+m[1] !== games.length + 1) fail('games out of order');
        cur = { n: +m[1], players: null, score: null, events: [] }; games.push(cur); continue;
      }
      if (!cur) fail('moves before the first game');
      if (!cur.players) {
        if (!(m = /^ (\S{1,20}) : (\d{1,2}) +(\S{1,20}) : (\d{1,2})$/.exec(line))) fail('not a score line');
        cur.players = [m[1], m[3]]; cur.score = [+m[2], +m[4]]; continue;
      }
      if (!(m = /^( {0,2}\d{1,3}\) | {5})(.*)$/.exec(line))) fail('not a move line');
      const body = m[2], left = body.slice(0, 28).trim(), right = body.length > 28 ? body.slice(28).trim() : '';
      if (body.length > 28 && body[28] !== ' ') fail('columns out of place');
      if (left) cur.events.push(tok(left, 1));
      if (right) cur.events.push(tok(right, 2));
      if (!left && !right) fail('an empty move line');
    }
    if (length === null || !games.length) throw new Error('no games in it');
    return { head, length, games };
  }
  // Plays the games of parseMat's result through the rules, checking every step. Side 1 is 'me' (q_game), side 2
  // 'bot'. rules: {type: 'cash', jacoby, beavers} | {type: 'match', length}. Returns per game {n, rules, score: {me, bot},
  // crawford, pos: [...], result}, pos in game order:
  //   {type: 'roll', side, turn, before (the roller's view), dice [high, low], steps, after, name, n (legal plays), cube}
  //   {type: 'nodouble', side: 'me', turn, board, cube}    your turns with cube access on which you rolled (and, with
  //     opts.botNoDoubles, Open Sage's too: side 'bot', board from its view; the progress tracker scores them)
  //   {type: 'double', side, turn, board (the doubler's view), cube (before), value, answer: 'take'|'drop'|'beaver', beaver}
  // cube: {value, owner: 0 | 'me' | 'bot'}. Turn numbers count every roll from the opening roll (turn 1).
  function replayGames(parsed, rules, opts) {
    const botND = !!(opts && opts.botNoDoubles);
    const out = []; let crawUsed = false;
    const sideName = (s) => (s === 1 ? 'me' : 'bot');
    parsed.games.forEach((G) => {
      const score = { me: G.score[0], bot: G.score[1] }, len = rules.type === 'match' ? rules.length : 0;
      let crawford = false;
      if (G.crawford != null) { crawford = !!G.crawford; crawUsed = crawUsed || crawford; }   // a single game whose Crawford flag is known
      else if (len && !crawUsed && (score.me === len - 1 || score.bot === len - 1) && !(score.me === len - 1 && score.bot === len - 1)) { crawford = true; crawUsed = true; }
      const ctx = { crawfordGame: crawford, score };
      let B = START.slice(), cube = { value: 1, owner: 0 }, turn = 0, pending = null, doubledThisTurn = 0, over = null;
      const pos = [], fail = (why) => { throw new Error(`game ${G.n}: ${why}`); };
      G.events.forEach((e, i) => {
        if (over && e.type !== 'win') fail('moves after the end of the game');
        const s = sideName(e.side), o = s === 'me' ? 'bot' : 'me';
        if (pending && !['take', 'drop', 'beaver'].includes(e.type)) fail('a double with no answer');
        if (e.type === 'roll') {
          if (turn === 0 && e.dice[0] === e.dice[1]) fail('a double on the opening roll');
          if (turn > 0 && pos.length && pos[pos.length - 1].type === 'roll' && pos[pos.length - 1].side === s) fail('the same side rolled twice');
          turn++;
          if (s === 'me' && turn > 1 && doubledThisTurn !== 1 && R_canDouble('me', cube, rules, ctx)) pos.push({ type: 'nodouble', side: 'me', turn, board: B.slice(), cube: { ...cube } });
          else if (botND && s === 'bot' && turn > 1 && doubledThisTurn !== 2 && R_canDouble('bot', cube, rules, ctx)) pos.push({ type: 'nodouble', side: 'bot', turn, board: flip(B), cube: { ...cube } });
          doubledThisTurn = 0;
          const before = s === 'me' ? B.slice() : flip(B), [d1, d2] = e.dice;
          const lp = legalPlays(before, d1, d2);
          // The steps are one checker and one die each; the board they lead to must be one of the roll's legal plays.
          let bd = before.slice();
          for (const [f, t] of e.steps) {
            if (!(f >= 1 && f <= 25) || !(t >= 0 && t <= 24) || f <= t || f - t > 6 || bd[f] <= 0) fail(`turn ${turn}: an impossible step ${f}/${t}`);
            bd[f]--;
            if (t) { if (bd[t] < -1) fail(`turn ${turn}: a step onto a made point`); if (bd[t] === -1) { bd[t] = 0; bd[0]++; } bd[t]++; }
          }
          if (lp.max === 0 ? e.steps.length : !lp.plays.has(key(bd)) || e.steps.length !== lp.max) fail(`turn ${turn}: not a legal play for ${d1}-${d2}`);
          pos.push({ type: 'roll', side: s, turn, before, dice: [Math.max(d1, d2), Math.min(d1, d2)], steps: e.steps, after: bd,
            name: notation(before, bd, d1, d2), n: lp.plays.size, cube: { ...cube } });
          B = s === 'me' ? bd : flip(bd);
          const fin = finished(B); if (fin) over = { winner: fin.won > 0 ? 'me' : 'bot', kind: fin.kind, how: 'played', at: i };
        } else if (e.type === 'double') {
          if (turn === 0) fail('a double before the opening roll');
          if (!R_canDouble(s, cube, rules, ctx)) fail(`turn ${turn + 1}: a double without access to the cube`);
          if (e.value !== cube.value * 2) fail(`turn ${turn + 1}: the cube went to ${e.value}`);
          if (pos.length && pos[pos.length - 1].type === 'roll' && pos[pos.length - 1].side === s) fail('a double after the same side rolled');
          pending = { type: 'double', side: s, turn: turn + 1, board: s === 'me' ? B.slice() : flip(B), cube: { ...cube }, value: e.value };
          pos.push(pending);
        } else if (e.type === 'take' || e.type === 'drop' || e.type === 'beaver') {
          if (!pending || pending.side === s) fail('an answer with no double');
          if (e.type === 'drop') { pending.answer = 'drop'; over = { winner: pending.side, kind: 1, how: 'drop', at: i, value: pending.value / 2 }; pending = null; return; }
          if (e.type === 'beaver') {
            if (rules.type !== 'cash' || !rules.beavers) fail('a beaver where beavers are off');
            if (e.value !== pending.value * 2) fail('a beaver to the wrong value');
            pending.answer = 'beaver'; pending.beaver = e.value; cube = { value: e.value, owner: s };
          } else { pending.answer = 'take'; cube = { value: pending.value, owner: s }; }
          doubledThisTurn = pending.side === 'me' ? 1 : 2; pending = null;
        } else if (e.type === 'win') {
          if (i !== G.events.length - 1) fail('a win before the last move');
          const w = s, pts = e.points;
          if (over && over.winner !== w) fail('the wrong side wins');
          if (over && over.how === 'played' && pts !== pointsFor(over.kind, cube, rules)) fail('the points don\'t match the result');
          if (over && over.how === 'drop' && pts !== over.value) fail('the points don\'t match the pass');
          if (!over) {   // a resignation
            const ks = [1, 2, 3].map((k) => pointsFor(k, cube, rules)); if (!ks.includes(pts)) fail('the points of the resignation don\'t fit the cube');
            over = { winner: w, kind: ks.indexOf(pts) + 1, how: 'resign', at: i };
          }
          over.points = pts;
        }
      });
      if (pending) fail('a double with no answer');
      out.push({ n: G.n, rules, score, crawford, pos, result: over && over.points ? over : null });
    });
    return out;
  }
  const R_canDouble = (side, cube, rules, ctx) => canDouble(side, cube, rules, { crawfordGame: ctx.crawfordGame, score: ctx.score });
  // A pasted or saved BG Play game file, checked line by line and move by move. Returns {kind, ply, rules, parsed,
  // games, id}, or throws. Only the layout BG Play writes passes: its site, player names, engine line and headers.
  function checkBgPlayMat(text) {
    const P = parseMat(text), h = P.head;
    const want = (k, re) => { if (!re.test(h[k] || '')) throw new Error(`header ${k} isn't BG Play's`); };
    want('Site', /^BG Play vs Open Sage$/); want('Match ID', /^bgp-[A-Za-z0-9_-]{4,40}$/); want('Player 1', /^q_game$/);
    want('Player 2', /^OpenSage-[1-4]ply$/); want('EventDate', /^\d{4}\.\d{2}\.\d{2}$/); want('EventTime', /^\d{2}\.\d{2}$/);
    want('Variation', /^Backgammon$/); want('Jacoby', /^(On|Off)$/); want('Beavers', /^(On|Off)$/); want('Crawford', /^(On|Off)$/);
    want('Engine', /^Open Sage [1-4]-ply \(on-device WebAssembly\)$/);
    const ply = +h['Player 2'].match(/(\d)ply/)[1];
    if (+h.Engine.match(/(\d)-ply/)[1] !== ply) throw new Error('the engine line and Player 2 disagree');
    for (const g of P.games) if (g.players[0] !== h['Player 1'] || g.players[1] !== h['Player 2']) throw new Error(`game ${g.n}: other player names`);
    const rules = P.length ? { type: 'match', length: P.length } : { type: 'cash', jacoby: h.Jacoby === 'On', beavers: h.Beavers === 'On' };
    if (!P.length && P.games.length !== 1) throw new Error('a cash game file holds one game');
    if (P.length > 25 || P.games.length > 60) throw new Error('more games than a match holds');
    const games = replayGames(P, rules);
    games.forEach((g, i) => {
      if (!g.result) throw new Error(`game ${g.n} has no result`);
      if (P.length) {     // match scores carry from game to game
        const nx = P.games[i + 1];
        if (nx) { const s = { ...g.score }; s[g.result.winner] += g.result.points; if (nx.score[0] !== s.me || nx.score[1] !== s.bot) throw new Error(`game ${nx.n}: the score doesn't follow`); }
        if (i === 0 && (g.score.me || g.score.bot)) throw new Error('the match doesn\'t start at 0-0');
      }
    });
    return { kind: P.length ? 'match' : 'cash', ply, rules, parsed: P, games, id: h['Match ID'].slice(4) };
  }

  const api = { START, ROLLS, flip, key, same, counts, pips, noContact, allHome, singleMoves, legalPlays, Turn, notation, stepsText,
    finished, pointsFor, canDouble, xgid, matText, parseMat, replayGames, checkBgPlayMat };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.R = api;
})(typeof self !== 'undefined' ? self : this);
