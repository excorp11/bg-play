// quiz.js: the Blunder Quiz inside the BG Play tile (the user's request, 2026-11-27). The positions where you
// blundered (0.080 or more; errors from 0.020 when chosen) in the games Progress tracks and in the earlier reviews,
// played again on BG Play's own board: you move as in a game (or Double / No double, Take / Pass). Within 0.020 of
// the best: the right answer and the top plays' ranking; otherwise "a mistake", with Retry or Show answer. A position
// leaves the quiz once it has been answered right at the first attempt on 3 different days. Filters: checker or cube,
// position type, cube error kind, theme, only last missed, and On Demand (a description Claude turns into a filter),
// as in the Opening Quiz. Rounds go through the chosen positions without repeats. Exposes window.BQ.
(function () {
  'use strict';
  const V = 1, OK = 0.020, BLUN = 0.080, DAYS = 3, KF = 'bq-focus', KS = 'bq-sess', KT = 'bq-th', KC = 'bq-st';
  const THEMES = [['hitting', 'Hitting'], ['attack', 'Attacking without a board'], ['blocking', 'Blocking and priming'], ['anchoring', 'Anchoring'],
    ['entering', 'Entering from the bar'], ['safety', 'Safety'], ['unhittable', 'Blots nothing can hit'], ['holding', 'Holding game'],
    ['backgame', 'Back games'], ['bearin', 'Bear-in, bear-off and races'], ['closing', 'Closing out'], ['gammon', 'Saving the gammon'], ['cube', 'Cube'], ['other', 'Other']];
  const DEF = { errors: false, kind: [], types: [], kinds: [], themes: [], wrong: false, od: false, odq: null, odh: [] };
  const Q = { db: null, docs: new Map(), static: [], loaded: false, err: '', open: false, stash: null, cur: null, F: null, sess: {}, th: {}, stc: {}, qcache: null, od: null };
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const band = (c) => { const v = r3(Math.max(0, c)); return v >= BLUN ? 'blunder' : v >= OK ? 'error' : v > 0 ? 'close' : 'best'; };
  const BANDCLS = { best: 'bq-best', close: 'bq-close', error: 'bq-error', blunder: 'bq-blunder' };
  const ARROW = { best: 'var(--good)', close: 'var(--muted)', error: 'var(--yel)', blunder: 'var(--bad)' };
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const jget = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
  const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full: kept in memory */ } };
  const typeName = (k) => ((window.PG && PG.TYPES) || []).find((t) => t[0] === k)?.[1] || k || '';
  const kindName = (k) => ((window.PG && PG.KINDS) || []).find((t) => t[0] === k)?.[1] || k || '';
  const themeName = (k) => (THEMES.find((t) => t[0] === k) || [k, k])[1];
  const costTxt = (c) => (r3(c) < 0.0005 ? 'best' : `−${Math.max(0, c).toFixed(3)}`);

  // ------------------------------------------------------------- positions
  // An XGID (BG Play's: you on roll, or the doubler on roll with dice "D" for a take decision) -> board and context.
  function parseX(x) {
    const f = String(x).replace(/^XGID=/, '').split(':'), pos = f[0] || '';
    if (pos.length !== 26) throw new Error('not an XGID');
    const n = (ch) => (ch === '-' ? 0 : ch >= 'a' ? ch.charCodeAt(0) - 96 : ch.charCodeAt(0) - 64);
    const b = new Array(26).fill(0);
    b[0] = n(pos[0]); b[25] = n(pos[25]);
    for (let p = 1; p <= 24; p++) { const ch = pos[p]; b[p] = ch === '-' ? 0 : ch >= 'a' ? -n(ch) : n(ch); }
    const d = f[4] || '00';
    return { b, cv: 2 ** (+f[1] || 0), co: +f[2] || 0, dice: /^[1-6][1-6]$/.test(d) ? [Math.max(+d[0], +d[1]), Math.min(+d[0], +d[1])] : null,
      s1: +f[5] || 0, s2: +f[6] || 0, flag: +f[7] || 0, len: +f[8] || 0 };
  }
  // The position as you face it: your view of the board, the cube from your side, the score as {me, bot}.
  function setup(q) {
    if (q._P) return q._P;
    const X = parseX(q.x), take = 'TPB'.includes(q.k);
    const rules = q.rules && q.rules.type ? q.rules : X.len ? { type: 'match', length: X.len } : { type: 'cash', jacoby: !!(X.flag & 1), beavers: !!(X.flag & 2) };
    const roller = take ? 'bot' : 'me', other = take ? 'me' : 'bot';
    const cube = { value: X.cv, owner: X.co === 0 ? 0 : X.co > 0 ? roller : other };
    const score = rules.type === 'match' ? (take ? { me: X.s2, bot: X.s1 } : { me: X.s1, bot: X.s2 }) : { me: 0, bot: 0 };
    const P = { board: take ? R.flip(X.b) : X.b.slice(), doubler: X.b.slice(), dice: X.dice, rules, cube, score, crawford: rules.type === 'match' && X.flag === 1, take };
    Object.defineProperty(q, '_P', { value: P, enumerable: false, writable: true, configurable: true });
    return P;
  }
  // A play by its name (or board) -> the legal play {board, seq}.
  function playOf(P, name) {
    const [d1, d2] = P.dice, lp = R.legalPlays(P.board, d1, d2);
    for (const e of lp.plays.values()) if (R.notation(P.board, e.board, d1, d2) === name) return e;
    return null;
  }
  const stepsOf = (e) => (e ? e.seq.map((s) => [s.from, s.to, s.hit]) : []);

  // Every question: your counted decisions of 0.020 or more in the Progress records, and the earlier reviews' errors
  // (quiz documents with pos, written by Claude, rescored at 4-ply). Cached until either collection changes.
  function questions() {
    const pdocs = window.PG && PG._state ? PG._state.docs : new Map();
    if (Q.qcache && Q.qcache.p === pdocs && Q.qcache.q === Q.docs && Q.qcache.s === Q.static) return Q.qcache.list;
    const out = [];
    for (const r of pdocs.values()) {
      if (!r || r.v !== 1 || !Array.isArray(r.decs)) continue;
      for (const d of r.decs) {
        if (!d.n || !(d.c >= OK - 1e-9) || !d.x) continue;
        out.push({ id: `p-${r.id}-${d.t}${d.k}`, src: r.src || 'tile', rec: r.id, at: r.at, opp: r.opp || '', type: r.type, len: r.len || 0, rules: r.rules,
          g: r.match ? r.match.n : 1, t: d.t, k: d.k, x: d.x, p: d.p, b: d.b, c: d.c, pt: d.pt || '', ck: d.ck || '', top: d.top || null, eq: d.eq || null });
      }
    }
    // the earlier reviews' errors: the tile's quiz-reviews.json (rescored at 4-ply), and any written to the database
    const seen = new Set(), revs = Q.static.map((r) => [r.id, r]).concat([...Q.docs].filter(([, x]) => x && x.pos));
    for (const [id, x] of revs) {
      const p = x && x.pos; if (!p || !p.x || !(p.c >= OK - 1e-9) || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, src: 'review', rec: null, at: p.at, opp: p.opp || '', type: p.type, len: p.len || 0, rules: p.rules, g: p.g || 1, t: p.t, k: p.k, x: p.x,
        p: p.p, b: p.b, c: p.c, pt: p.pt || '', ck: p.ck || '', th: p.th || '', ls: p.ls || '', rev: p.rev || '', top: p.top || null, eq: p.eq || null });
    }
    out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.t - b.t));
    Q.qcache = { p: pdocs, q: Q.docs, s: Q.static, list: out };
    return out;
  }

  // ------------------------------------------------------------- themes
  // The earlier reviews' errors carry Claude's theme; for the rest, a rough one from what the best play does that
  // yours didn't (a hit, a home or prime point, an anchor, fewer shots), else from the position's type.
  function shots(a) {        // the opponent's rolls (of 36) that hit one of your blots, counting by distance only
    const blots = [], from = [];
    for (let p = 1; p <= 24; p++) { if (a[p] === 1) blots.push(p); if (a[p] < 0) from.push(p); }
    if (a[0] > 0) from.push(0);
    if (!blots.length || !from.length) return 0;
    const ds = new Set(); for (const p of blots) for (const s of from) if (p > s) ds.add(p - s);
    let n = 0;
    for (let d1 = 1; d1 <= 6; d1++) for (let d2 = 1; d2 <= 6; d2++) {
      const reach = d1 === d2 ? [d1, 2 * d1, 3 * d1, 4 * d1] : [d1, d2, d1 + d2];
      if (reach.some((d) => ds.has(d))) n++;
    }
    return n;
  }
  const blotsOf = (a) => { let n = 0; for (let p = 1; p <= 24; p++) if (a[p] === 1) n++; return n; };
  const made = (b, a, lo, hi) => { let n = 0; for (let p = lo; p <= hi; p++) if (a[p] >= 2 && b[p] < 2) n++; return n; };
  const homePts = (a) => { let n = 0; for (let p = 1; p <= 6; p++) if (a[p] >= 2) n++; return n; };
  const anchors = (a) => { let n = 0; for (let p = 18; p <= 24; p++) if (a[p] >= 2) n++; return n; };
  // blocking: the longest run of points from your 2 to 11 point, plus half the points made from 3 to 8
  const block = (a) => { let run = 0, best = 0, n = 0; for (let p = 2; p <= 11; p++) { run = a[p] >= 2 ? run + 1 : 0; best = Math.max(best, run); if (p >= 3 && p <= 8 && a[p] >= 2) n++; } return best + n / 2; };
  const far = (a) => { const s = []; for (let p = 19; p <= 24; p++) if (a[p] > 0) s.push(p + ':' + a[p]); return s.join(','); };   // your checkers in their home board
  const BYTYPE = { holding: 'holding', 'vs-holding': 'holding', backgame: 'backgame', 'vs-backgame': 'backgame', bearin: 'bearin', 'vs-bearin': 'bearin', bearoff: 'bearin',
    race: 'bearin', priming: 'blocking', 'vs-priming': 'blocking', primevprime: 'blocking', blitz: 'hitting', 'vs-blitz': 'entering' };
  function themeOf(q) {
    if (q.th) return q.th;
    if (Q.th[q.id]) return Q.th[q.id];
    let th = 'other';
    try {
      if (q.k !== 'M') th = 'cube';
      else {
        const P = setup(q), b = P.board;
        const rear = (() => { if (b[25] > 0) return 25; for (let p = 24; p >= 1; p--) if (b[p] > 0) return p; return 0; })();
        if (R.noContact(b) || rear <= 12) th = 'bearin';      // bearing in (against a back game too) or racing
        else {
          const be = q.top && q.top[0] ? playOf(P, q.top[0].m) : null, me = playOf(P, q.p);
          if (!be || !me) th = b[25] > 0 ? 'entering' : BYTYPE[q.pt] || 'other';
          else {
            const best = be.board, mine = me.board, hb = best[0] - b[0], hm = mine[0] - b[0];
            const theirBack = (() => { let n = 0; for (let p = 1; p <= 6; p++) if (b[p] <= -2) n++; return n; })();
            const sb = shots(best), sm = shots(mine);
            if (b[0] > 0 && made(b, best, 1, 6) > made(b, mine, 1, 6)) th = 'closing';
            else if (hb > hm) th = 'hitting';
            else if (hm > hb) th = theirBack >= 2 ? 'backgame' : homePts(b) <= 2 ? 'attack' : 'hitting';
            else if (b[25] > 0 && far(best) !== far(mine)) th = 'entering';
            else if (block(best) > block(mine) + 0.4) th = 'blocking';
            else if (anchors(best) > anchors(mine)) th = 'anchoring';
            else if (blotsOf(best) > blotsOf(mine) && sb <= sm) th = 'unhittable';
            else if (sm > sb + 1) th = 'safety';
            else th = BYTYPE[q.pt] || (sm > sb ? 'safety' : 'other');
          }
        }
      }
    } catch (e) { th = 'other'; }
    Q.th[q.id] = th; jset(KT, Q.th);
    return th;
  }

  // ------------------------------------------------------------- state: the 3 days, the rounds, the focus
  const stOf = (id) => { const d = Q.docs.get(id), a = d && d.st, b = Q.stc[id]; if (a && b) return (a.last || '') >= (b.last || '') ? a : b; return a || b || null; };
  const retired = (id) => { const s = stOf(id); return !!(s && s.days && s.days.length >= DAYS); };
  function saveSt(q, st) {
    st = JSON.parse(JSON.stringify(st)); Q.stc[q.id] = st; jset(KC, Q.stc);
    const cur = Q.docs.get(q.id) || {};
    const doc = cur.pos ? { ...cur, st } : { v: V, ref: q.rec || 'review', st };
    const m = new Map(Q.docs); m.set(q.id, doc); Q.docs = m;
    if (Q.db) Promise.resolve().then(() => Q.db.doc('quiz/' + q.id).set(JSON.parse(JSON.stringify(doc)))).catch((e) => { Q.err = 'Saving your answers: ' + (e.code || e.message || e); });
  }
  function loadLocal() { Q.F = { ...DEF, ...jget(KF, {}) }; Q.sess = jget(KS, {}); Q.th = jget(KT, {}); Q.stc = jget(KC, {}); }
  const saveF = () => jset(KF, Q.F);
  function focusKey(F = Q.F) {
    const s = (a) => (a || []).slice().sort().join(',');
    return JSON.stringify([F.errors ? 1 : 0, s(F.kind), s(F.types), s(F.kinds), s(F.themes), F.wrong ? 1 : 0, F.od && F.odq ? F.odq.key : '']);
  }
  function sess() {
    const k = focusKey(); let s = Q.sess[k];
    if (!s) { s = Q.sess[k] = { shown: [], right: 0, wrong: 0, cur: null, used: Date.now() }; }
    s.used = Date.now();
    const keys = Object.keys(Q.sess).sort((a, b) => Q.sess[b].used - Q.sess[a].used); for (const x of keys.slice(8)) delete Q.sess[x];
    return s;
  }
  const saveSess = () => jset(KS, Q.sess);
  // Questions that pass the focus (retired ones out). skip: a filter to leave out, for the chips' counts.
  function pool(F = Q.F, skip = '') {
    return questions().filter((q) => {
      if (retired(q.id)) return false;
      if (!F.errors && !(q.c >= BLUN - 1e-9)) return false;
      if (skip !== 'kind' && F.kind.length && !F.kind.includes(q.k === 'M' ? 'checker' : 'cube')) return false;
      if (skip !== 'types' && F.types.length && !F.types.includes(q.pt)) return false;
      if (skip !== 'kinds' && F.kinds.length && !F.kinds.includes(q.ck)) return false;
      if (skip !== 'themes' && F.themes.length && !F.themes.includes(themeOf(q))) return false;
      if (skip !== 'wrong' && F.wrong) { const s = stOf(q.id); if (!s || s.lastOk !== false) return false; }
      if (skip !== 'od' && F.od && F.odq) { if (!Q.od || Q.od.key !== F.odq.key) odCompute(F.odq); if (!Q.od.set.has(q.id)) return false; }
      return true;
    });
  }

  // ------------------------------------------------------------- the quiz on BG Play's board
  // The quiz takes BG Play's board by putting its own game in S.game (the real one waits in Q.stash and is what
  // save() keeps); drive() and finishUserMove() hand quiz turns back here.
  const realGame = () => (Q.open ? Q.stash : S.game);
  function open() {
    if (TARGET !== 'tile') return;
    if (typeof busy !== 'undefined' && busy) return toast('One moment: Open Sage is moving');
    if (!Q.F) loadLocal();
    css();
    if (window.PG && PG.close) try { PG.close(); } catch (e) { /* not open */ }
    if (!Q.open) { Q.stash = S.game; Q.open = true; driveToken++; }
    S.ui.view = null; closeMenu();
    const s = sess(), all = pool();
    const resume = s.cur && all.find((q) => q.id === s.cur);
    if (resume) show(resume); else next(true);
  }
  function exit() {
    if (!Q.open) return;
    Q.open = false; S.game = Q.stash; Q.stash = null; Q.cur = null; S.ui.view = null;
    const ov = $('bqOv'); if (ov) ov.classList.remove('open');
    save(); renderAll(); drive();
  }
  // The next question of the round: one not yet shown in it, at random; the round is over when every one has been.
  function next(fromOpen) {
    const s = sess(), all = pool(), left = all.filter((q) => !s.shown.includes(q.id));
    if (!all.length) { Q.cur = { empty: true }; setBoard(null); return paint(); }
    if (!left.length) { Q.cur = { done: true, n: s.shown.filter((id) => all.some((q) => q.id === id)).length }; setBoard(null); return paint(); }
    const avoid = !fromOpen && Q.cur && Q.cur.q ? Q.cur.q.id : null;
    const pick = left.length > 1 ? left.filter((q) => q.id !== avoid) : left;
    show(pick[Math.floor(Math.random() * pick.length)]);
  }
  function newRound() { const k = focusKey(); delete Q.sess[k]; saveSess(); next(true); }
  function show(q, retryOf) {
    let P; try { P = setup(q); } catch (e) { toast('This position can\'t be read'); const s = sess(); s.shown.push(q.id); saveSess(); return next(); }
    const s = sess(); if (!retryOf) { s.cur = q.id; saveSess(); }
    const g = gOf(P.rules, P.score, P.crawford, P.cube, P.take ? 'bot' : 'me');
    const base = { k: q.k === 'M' ? 'M' : q.k, turn: q.t, board: P.take ? P.doubler.slice() : P.board.slice(), dice: P.dice ? P.dice.slice() : null, g, rules: P.rules,
      score: { me: P.score.me, bot: P.score.bot, crawford: P.crawford }, cube: { ...P.cube } };
    Q.cur = { q, P, base, tries: [], state: 'ask', busy: false, sel: null };
    warm(Q.cur);
    setBoard(q, P); paint();
  }
  // The engine starts on the position while you think: the ranking at 4-ply, or the cube. After an engine restart (a
  // review opened and closed) the cancelled work starts again.
  function warm(C) {
    if (!C || !C.base || ENG.state !== 'ready') return;
    const base = C.base;
    if (C.q.k === 'M') { hidden(base, '_rk', null); hidden(base, '_rk', moveRank(base, 'hi')); }
    else { const c = cubeEval(base.board, ER_PLY, base.g, 'hi'); c.catch(() => {}); hidden(base, '_c', c); }
  }
  function restarted() { const C = Q.cur; if (C && C.q) { warm(C); if (C.busy) { C.busy = false; C.pending = null; } paint(); } }
  // The quiz's game in S.game: your move with the dice, your turn before rolling, or their double to answer.
  function setBoard(q, P) {
    if (!Q.open) return;
    if (!q) { S.game = quizShell(); S.ui.view = null; return renderAll(); }      // no question: the starting position, no dice
    const M = q.k === 'M';
    S.game = { ...quizShell(), id: 'quiz-' + q.id, rules: P.rules, score: { ...P.score }, crawford: P.crawford, board: P.board.slice(), cube: { ...P.cube },
      phase: M ? 'move' : P.take ? 'offer' : 'preroll', onRoll: P.take ? 'bot' : 'me', dice: M ? P.dice.slice() : null, turnNo: q.t,
      turnSt: M ? { order: P.dice.slice(), steps: [] } : null, offer: P.take ? { by: 'bot', value: P.cube.value * 2 } : null };
    S.ui.view = null; renderAll();
  }
  const quizShell = () => ({ id: 'quiz', quiz: true, n: 1, rules: { type: 'cash', jacoby: true, beavers: false }, ply: 4, score: { me: 0, bot: 0 }, crawford: false,
    board: R.START.slice(), cube: { value: 1, owner: 0 }, phase: 'quiz', onRoll: null, dice: null, opening: null, turnNo: 0, turnSt: null, events: [], decisions: [],
    botLog: [], last: null, offer: null, resign: null, declined: {}, result: null, er: null, started: Date.now() });

  // ------------------------------------------------------------- answers
  // Your move, from BG Play's turn (Check, Enter, or Done).
  async function moveDone(t) {
    const C = Q.cur; if (!C || !C.q || C.busy || C.state !== 'ask' || C.q.k !== 'M') return;
    if (!t || !t.done) return;
    const P = C.P, after = t.board.slice(), name = R.notation(P.board, after, P.dice[0], P.dice[1]);
    const dec = { ...C.base, after, played: name }; hidden(dec, '_rk', C.base._rk);
    C.busy = true; C.pending = { name, after, steps: t.steps.map((s) => [s.from, s.to, s.hit]) }; paint();
    let r; try { r = await analyzeDecision(dec, 'hi'); } catch (e) { r = null; }
    if (Q.cur !== C) return;
    C.busy = false;
    if (!r || r.err) { C.pending = null; warm(C); paint(); return toast('The engine was busy: check again'); }
    judge({ name, cost: r.cost, res: r, after, steps: C.pending.steps });
  }
  // Double / No double (your turn before rolling), Take / Pass / Beaver (their double).
  async function cube(k) {
    const C = Q.cur; if (!C || !C.q || C.busy || C.state !== 'ask' || C.q.k === 'M') return;
    if (C.P.take ? !'TPB'.includes(k) : !'RD'.includes(k)) return;
    const dec = { ...C.base, k }; hidden(dec, '_c', C.base._c);
    C.busy = true; paint();
    let r; try { r = await analyzeDecision(dec, 'hi'); } catch (e) { r = null; }
    if (Q.cur !== C) return;
    C.busy = false;
    if (!r || r.err) { warm(C); paint(); return toast('The engine was busy: answer again'); }
    judge({ name: actName(C, k), k, cost: r.cost, res: r });
  }
  const actName = (C, k) => {
    const owned = !!C.P.cube.owner;
    return { R: owned ? 'No redouble' : 'No double', D: owned ? 'Redouble' : 'Double', T: 'Take', P: 'Pass', B: 'Beaver' }[k];
  };
  function judge(a) {
    const C = Q.cur, q = C.q, ok = r3(a.cost) < OK;
    C.tries.push(a); C.res = a.res;
    if (C.tries.length === 1 && !C.revealed) record(q, ok);
    C.state = ok ? 'right' : 'missed';
    showPlays(C.tries.length - 1);
    paint();
  }
  // The first attempt at a position each day counts toward the 3 days; the round counts each position once.
  function record(q, ok) {
    const st = { days: [], n: 0, w: 0, ...(stOf(q.id) || {}) }, day = today();
    st.days = (st.days || []).slice();
    if (st.lastDay !== day) { st.lastDay = day; st.n++; if (ok) { if (!st.days.includes(day)) st.days.push(day); } else st.w++; }
    st.lastOk = ok; st.last = new Date().toISOString();
    saveSt(q, st);
    const s = sess(); if (!s.shown.includes(q.id)) { s.shown.push(q.id); if (ok) s.right++; else s.wrong++; } s.cur = null; saveSess();
    Q.cur.st = st; Q.cur.mastered = st.days.length >= DAYS;
  }
  function retry() {
    const C = Q.cur; if (!C || C.state !== 'missed') return;
    C.state = 'ask'; C.pending = null; C.sel = null;
    if (C.q.k === 'M') { S.game.turnSt = { order: C.P.dice.slice(), steps: [] }; S.game.phase = 'move'; }
    S.ui.view = null; paint(); renderAll();
  }
  // Show answer: after a miss, or instead of answering (which counts as a miss for the day).
  async function reveal() {
    const C = Q.cur; if (!C || !C.q || C.busy || C.state === 'right' || C.state === 'shown') return;
    if (!C.tries.length && !C.revealed) record(C.q, false);
    C.revealed = true;
    if (!C.res) {        // nothing answered yet: the analysis of the game's own decision gives the ranking or the cube
      const pl = C.q.k === 'M' ? playOf(C.P, C.q.p) : null;
      const dec = C.q.k === 'M' ? { ...C.base, after: pl ? pl.board : C.P.board, played: C.q.p } : { ...C.base, k: C.q.k };
      if (C.q.k === 'M') hidden(dec, '_rk', C.base._rk); else hidden(dec, '_c', C.base._c);
      C.busy = true; paint();
      let r; try { r = await analyzeDecision(dec, 'hi'); } catch (e) { r = null; }
      if (Q.cur !== C) return;
      C.busy = false;
      if (!r || r.err) { warm(C); paint(); return toast('The engine was busy: try again'); }
      C.res = r;
    }
    C.state = 'shown'; showPlays(C.tries.length ? C.tries.length - 1 : null); paint();
  }
  // The board after an answer: the start position with the best play in green and the play picked (yours by default)
  // in its band's colour.
  function showPlays(i) {
    const C = Q.cur; if (!C || C.q.k !== 'M') return;
    const P = C.P, rows = rankRows(C), best = rows[0], arrows = [];
    let sel = C.sel != null ? rows.find((r) => r.name === C.sel) : i != null && C.tries[i] ? rows.find((r) => r.name === C.tries[i].name) : null;
    if (C.state === 'shown' || C.state === 'right') { if (best && (!sel || sel.name !== best.name)) arrows.push({ steps: best.steps, mine: true, colour: ARROW.best, before: P.board }); }
    if (sel) arrows.push({ steps: sel.steps, mine: true, colour: ARROW[band(sel.cost)], before: P.board });
    S.ui.view = { board: P.board.slice(), arrows };
    renderAll();
  }
  function pick(name) { const C = Q.cur; if (!C) return; C.sel = name; showPlays(null); paint(); }
  // The top plays at 4-ply with every play you tried and the game's play: [{name, cost, steps, tags}]
  function rankRows(C) {
    const P = C.P, r = C.res, rows = [];
    if (!r || !r.cands) return rows;
    const top = r.cands[0].e;
    const add = (name, cost, b) => {
      let row = rows.find((x) => x.name === name);
      if (!row) { const e = b ? R.legalPlays(P.board, P.dice[0], P.dice[1]).plays.get(R.key(b)) : playOf(P, name); row = { name, cost: Math.max(0, cost), steps: stepsOf(e), tags: [] }; rows.push(row); }
      return row;
    };
    // the book's ranking for an opening position (its costs are the book's), else the 4-ply candidates
    if (String(r.src || '').startsWith('XG book') && C.q.top) for (const t of C.q.top) add(t.m, t.c);
    else for (const c of r.cands) add(c.name, top - c.e, c.b);
    for (const a of C.tries) add(a.name, a.cost).tags.push('yours');
    if (C.q.p) add(C.q.p, C.q.c).tags.push('in the game');
    rows.sort((a, b) => a.cost - b.cost);
    return rows;
  }

  // ------------------------------------------------------------- the panel
  function paint() { if (Q.open) renderSide(); const ov = $('bqOv'); if (ov && ov.classList.contains('open')) ov.innerHTML = focusHtml(); }
  const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); } catch (e) { return ''; } };
  function gameLine(q, P) {
    const opp = q.opp && !/^OpenSage-/.test(q.opp) ? q.opp : 'Open Sage';
    const g = P.rules.type === 'match' ? `${P.rules.length}-point match, game ${q.g} (you ${P.score.me}, ${esc(opp)} ${P.score.bot}${P.crawford ? ', Crawford' : ''})` : `Cash game vs ${esc(opp)}`;
    return `${g} · turn ${q.t} · ${esc(fmtDate(q.at))}${q.src === 'review' ? ' · from a review' : ''}`;
  }
  function side() {
    const C = Q.cur, s = Q.F ? sess() : null, all = Q.F ? pool() : [];
    let h = `<div class="bar-top"><div class="title">Blunder Quiz</div>${btn('Focus', 'BQ.focus()', '', false, 'Choose the positions')}${btn('✕', 'BQ.exit()', 'icon', false, 'Back to BG Play')}</div>`;
    const inRound = s ? s.shown.filter((id) => all.some((q) => q.id === id)).length : 0;
    h += `<div class="score">${all.length ? `${inRound + (C && C.q && !s.shown.includes(C.q.id) ? 1 : 0)} of ${all.length} this round · ${s.right} right, ${s.wrong} wrong` : 'No positions in this focus'}</div>`;
    if (ENG.state !== 'ready') h += `<div class="card"><div class="muted">${esc(ENG.msg || 'Loading the engine…')}</div></div>`;
    if (!C) return h;
    if (C.empty) {
      const any = questions().length, loading = !Q.loaded || (window.PG && PG._state && !PG._state.loaded);
      return h + `<div class="card"><p>${loading ? 'Loading your positions…' : any ? 'No positions match this focus.' : 'No blunders yet. The blunders in your games appear here once they are in Progress, which scores every game as it ends.'}</p><div class="row">${btn('Focus', 'BQ.focus()')}${btn('Back to BG Play', 'BQ.exit()', 'primary')}</div></div>`;
    }
    if (C.done) {
      return h + `<div class="card"><div class="status good">Round complete</div><p class="small">${plural(C.n, 'position')} shown: ${s.right} right first time, ${s.wrong} missed${C.n ? ` (${Math.round((100 * s.right) / Math.max(1, s.right + s.wrong))}% right)` : ''}.</p><div class="row">${btn('Start a new round', 'BQ.newRound()', 'primary')}${btn('Focus', 'BQ.focus()')}</div></div>`;
    }
    const q = C.q, P = C.P, M = q.k === 'M';
    const opp = q.opp && !/^OpenSage-/.test(q.opp) ? q.opp : 'Open Sage';
    let prompt;
    if (M) prompt = `You rolled ${P.dice[0]}-${P.dice[1]}: your play`;
    else if (P.take) prompt = `${esc(opp)} ${P.cube.owner ? 'redoubles' : 'doubles'} to ${P.cube.value * 2}: take or pass?`;
    else prompt = `Your turn: ${P.cube.owner ? 'redouble' : 'double'} or roll?`;
    h += `<div class="card bq"><div class="status">${prompt}</div><div class="small muted">${gameLine(q, P)}</div>`;
    if (C.state === 'ask') {
      if (C.busy) h += `<div class="status run">Checking…</div>`;
      else if (M) {
        const t = S.game.phase === 'move' ? getTurn() : null, done = t && t.done;
        h += `<div class="row big">${btn('↶ Undo', 'userUndo()', '', !(t && t.steps.length))}${btn('✓ Check', 'BQ.check()', 'primary', !done)}</div>`;
        h += `<div class="hint">Make your play as in a game, then Check.</div>`;
      } else if (P.take) {
        const bv = P.rules.type === 'cash' && P.rules.beavers && !P.cube.owner;
        h += `<div class="row big">${btn('Pass', 'BQ.cube(\'P\')')}${btn('Take', 'BQ.cube(\'T\')', 'primary')}${bv ? btn(`Beaver (${P.cube.value * 4})`, 'BQ.cube(\'B\')', 'dbl') : ''}</div>`;
      } else {
        h += `<div class="row big">${btn(`${P.cube.owner ? 'Redouble' : 'Double'} to ${P.cube.value * 2}`, 'BQ.cube(\'D\')', 'dbl')}${btn('Roll', 'BQ.cube(\'R\')', 'primary')}</div>`;
      }
      if (!C.busy) h += `<div class="row">${btn('Show answer', 'BQ.reveal()')}${C.tries.length ? '' : btn('Skip', 'BQ.skip()')}</div>`;
      return h + '</div>';
    }
    const last = C.tries[C.tries.length - 1];
    if (C.state === 'missed') {
      const bd = band(last.cost);
      h += `<div class="verdict ${BANDCLS[bd]}"><b>✗ That's a mistake</b>: ${esc(last.name)} is ${bd === 'blunder' ? 'a blunder' : 'an error'} (${costTxt(last.cost)}).</div>`;
      h += `<div class="row big">${btn('Retry', 'BQ.retry()', 'primary')}${btn('Show answer', 'BQ.reveal()')}</div>`;
      return h + '</div>';
    }
    if (C.busy) return h + `<div class="status run">Working out the answer…</div></div>`;
    // right, or the answer shown
    if (C.state === 'right') {
      const first = C.tries.length === 1 && !C.revealed;
      h += `<div class="verdict ${r3(last.cost) < 0.0005 ? 'bq-best' : 'bq-close'}"><b>✓ Right</b>${r3(last.cost) < 0.0005 ? ': the best play' : `: within 0.020 of the best (${costTxt(last.cost)})`}${first ? '' : ' (not the first attempt, so it doesn\'t count today)'}.</div>`;
    } else h += `<div class="verdict"><b>The answer</b>${last ? `: your ${esc(last.name)} cost ${costTxt(last.cost)}` : ''}.</div>`;
    h += M ? ranking(C) : cubeTable(C);
    // the game and what counts
    const st = C.st || stOf(q.id);
    const days = st && st.days ? st.days.length : 0;
    h += `<div class="small">In the game: ${esc(q.p)} (${costTxt(q.c)}). ${q.pt ? `Position: ${esc(typeName(q.pt))}. ` : ''}Theme: ${esc(themeName(themeOf(q)))}${q.ls ? ` (${esc(q.ls)})` : ''}.</div>`;
    h += `<div class="small muted">${C.mastered ? '<b>Mastered</b>: right first time on 3 different days, so this one leaves the quiz.' : `Right first time on ${days} of ${DAYS} days so far.`}</div>`;
    h += `<div class="row big">${btn('Next ›', 'BQ.next()', 'primary')}</div><div class="row">`;
    if (q.rec && window.PG && PG.review) h += btn('Review the game', `BQ.reviewGame(${esc(JSON.stringify(q.rec))})`);
    if (q.rev && /^https:\/\//.test(q.rev)) h += `<a class="btnlink" href="${esc(q.rev)}" target="_blank" rel="noopener">Open the review</a>`;
    return h + '</div></div>';
  }
  function ranking(C) {
    const rows = rankRows(C); if (!rows.length) return '';
    let h = '<table class="mini bqrank"><tr><th>Play</th><th>Cost</th><th></th></tr>';
    for (const r of rows.slice(0, 7)) {
      const sel = C.sel ? C.sel === r.name : r.tags.includes('yours') && r.name === C.tries[C.tries.length - 1]?.name;
      h += `<tr class="${sel ? 'sel' : ''}" onclick='BQ.pick(${esc(JSON.stringify(r.name))})'><td>${esc(r.name)}</td><td class="${BANDCLS[band(r.cost)]}">${costTxt(r.cost)}</td><td class="muted small">${esc(r.tags.join(', '))}</td></tr>`;
    }
    return h + `</table><div class="muted small">Tap a play to see it on the board (the best in green). ${String(C.res && C.res.src || '').startsWith('XG book') ? 'Costs from the XG opening book.' : 'Open Sage 4-ply.'}</div>`;
  }
  function cubeTable(C) {
    const r = C.res; if (!r) return '';
    const P = C.P, f = (x) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(3);
    let h = '<table class="mini bqrank">';
    if (!P.take) {
      const owned = !!P.cube.owner, rows = [[owned ? 'No redouble' : 'No double', r.nd], [`${owned ? 'Redouble' : 'Double'}/take`, r.dt], [`${owned ? 'Redouble' : 'Double'}/pass`, r.dp]];
      for (const [l, v] of rows) h += `<tr><td>${esc(l)}</td><td>${f(v)}</td></tr>`;
      h += `</table><div class="small">Best: <b>${esc(r.best === 'Double' ? (owned ? 'Redouble' : 'Double') : owned ? 'No redouble' : 'No double')}</b>. Your equity at 4-ply, per cube before the double.</div>`;
    } else {
      const E = r.E || {};
      for (const [l, v] of [['Take', E.T], ['Pass', E.P], ['Beaver', E.B]]) if (Number.isFinite(v)) h += `<tr><td>${l}</td><td>${f(v)}</td></tr>`;
      h += `</table><div class="small">Best: <b>${esc(r.best)}</b>. Your equity at 4-ply, per cube before the double.</div>`;
    }
    const tried = C.tries.map((a) => `${a.name} ${costTxt(a.cost)}`).join(', ');
    return h + (tried ? `<div class="small muted">Your answer${C.tries.length > 1 ? 's' : ''}: ${esc(tried)}.</div>` : '');
  }

  // ------------------------------------------------------------- the focus panel
  function focus() { css(); let ov = $('bqOv'); if (!ov) { ov = document.createElement('div'); ov.id = 'bqOv'; ov.className = 'bqov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Blunder Quiz focus'); document.body.appendChild(ov); } ov.innerHTML = focusHtml(); ov.classList.add('open'); }
  function focusClose() { const ov = $('bqOv'); if (ov) ov.classList.remove('open'); if (Q.open) { const C = Q.cur, all = pool(); if (!C || C.empty || C.done || (C.q && C.state === 'ask' && !all.some((q) => q.id === C.q.id))) next(true); else paint(); } }
  function chips(key, list, counts) {
    const F = Q.F; let h = '<div class="bqchips">';
    for (const [k, name] of list) {
      const n = counts[k] || 0, on = F[key].includes(k); if (!n && !on) continue;
      h += `<button class="${on ? 'on' : ''}" onclick='BQ.toggle(${esc(JSON.stringify(key))}, ${esc(JSON.stringify(k))})'>${esc(name)} <span class="n">${n}</span></button>`;
    }
    return h + '</div>';
  }
  const countBy = (list, f) => { const m = {}; for (const q of list) { const k = f(q); m[k] = (m[k] || 0) + 1; } return m; };
  function focusHtml() {
    const F = Q.F, all = pool(), s = sess();
    const qs = questions(), mastered = qs.filter((q) => retired(q.id)).length;
    let h = `<div class="bqhead"><div class="title">Blunder Quiz: focus</div>${btn('Done', 'BQ.focusClose()', 'primary')}</div><div class="bqbody">`;
    h += `<p class="small"><b>${plural(all.length, 'position')}</b> in this focus${mastered ? ` · ${mastered} mastered (right first time on 3 days)` : ''}. This round: ${s.shown.filter((id) => all.some((q) => q.id === id)).length} of ${all.length} shown, ${s.right} right, ${s.wrong} wrong. ${btn('Start over', 'BQ.newRound()', 'small')}</p>`;
    h += `<h4>Mistakes</h4><div class="seg">${[[false, 'Blunders (0.080+)'], [true, 'Errors too (0.020+)']].map(([v, l]) => `<button class="${F.errors === v ? 'on' : ''}" onclick="BQ.set('errors', ${v})">${l}</button>`).join('')}</div>`;
    h += `<h4>Decisions</h4>${chips('kind', [['checker', 'Checker plays'], ['cube', 'Cube decisions']], countBy(pool(F, 'kind'), (q) => (q.k === 'M' ? 'checker' : 'cube')))}`;
    h += `<h4>Position type</h4>${chips('types', (window.PG && PG.TYPES) || [], countBy(pool(F, 'types'), (q) => q.pt))}`;
    h += `<h4>Theme</h4>${chips('themes', THEMES, countBy(pool(F, 'themes'), themeOf))}`;
    const ck = countBy(pool(F, 'kinds').filter((q) => q.ck), (q) => q.ck);
    if (Object.keys(ck).length || F.kinds.length) h += `<h4>Cube error kind</h4>${chips('kinds', (window.PG && PG.KINDS) || [], ck)}`;
    const nw = pool(F, 'wrong').filter((q) => { const st = stOf(q.id); return st && st.lastOk === false; }).length;
    h += `<h4>More</h4><div class="bqchips"><button class="${F.wrong ? 'on' : ''}" onclick="BQ.set('wrong', ${!F.wrong})">Only ones I missed last time <span class="n">${nw}</span></button>`;
    h += `<button class="${F.od ? 'on' : ''}" onclick="BQ.odOpen()">On Demand${F.od && F.odq ? `: “${esc(F.odq.text.slice(0, 40))}${F.odq.text.length > 40 ? '…' : ''}”` : ''}</button></div>`;
    h += `<p class="muted small">Chips show how many positions each adds with the rest of the focus. None picked in a row = any. Themes for your BG Play games are worked out from what the best play does that yours didn't (a hit, a point, an anchor, fewer shots); the earlier reviews' positions carry their review's theme.</p>`;
    return h + '</div>';
  }
  function toggle(key, k) { const a = Q.F[key], i = a.indexOf(k); if (i >= 0) a.splice(i, 1); else a.push(k); saveF(); const ov = $('bqOv'); if (ov) ov.innerHTML = focusHtml(); }
  function set(key, v) { Q.F[key] = v; saveF(); const ov = $('bqOv'); if (ov) ov.innerHTML = focusHtml(); }

  // ------------------------------------------------------------- On Demand: a description -> a filter, by Claude
  const OD_LANG = `A JSON filter over backgammon positions, as nested arrays. The position is the one faced before the decision, seen from "me" (the player deciding); "opp" is the opponent. Points are in each side's own numbering (1-6 its home board, 25 its bar).
Numbers: ["at",side,point] checkers of that side on its point; ["count",side,lo,hi] its checkers on points lo..hi; ["blots",side,lo,hi]; ["points",side,lo,hi] points it holds (2+ checkers) in lo..hi; ["bar",side]; ["off",side] checkers borne off; ["pips",side]; ["cost"] what the game's decision cost; ["cube"] the cube value; ["turn"]; ["len"] match length (0 cash); ["away",side] points still needed in a match; ["+",a,b,...]; ["-",a,b]; plain numbers.
Tests: ["==",a,b] ["!=",a,b] ["<",a,b] ["<=",a,b] [">",a,b] [">=",a,b]; ["and",t,...] ["or",t,...] ["not",t]; ["is",field,[values]] with field one of kind (checker|cube), decision (M checker play, R no double, D double, T take, P pass, B beaver), type (opening, blitz, vs-blitz, primevprime, priming, vs-priming, bearin, backgame, holding, vs-bearin, vs-backgame, vs-holding, middle, race, bearoff), theme (hitting, attack, blocking, anchoring, entering, safety, unhittable, holding, backgame, bearin, closing, gammon, cube, other), cubeKind (missed-DP, missed-TG, wrong-DP, wrong-TG, wrong-take, wrong-pass, wrong-beaver, missed-beaver), game (cash|match), source (bgplay|galaxy|review), roll ("6-4", higher first; "6-6"), opp (opponent name).
Plays (checker plays only): ["best",t] the best play satisfies t; ["played",t] the play made in the game satisfies t. Inside them numbers describe the position after that play, and ["hits"] (checkers it hit), ["made",lo,hi] (points it newly made in lo..hi of my side), ["slots",lo,hi] (points where it left a new lone checker) also work.`;
  const OD_EX = `Examples: "their 5 point slotted" -> ["==",["at","opp",5],1]. "I'm on the bar" -> [">=",["bar","me"],1]. "best play hits" -> ["best",[">=",["hits"],1]]. "I made my 5 point in the game but shouldn't have" -> ["played",[">=",["made",5,5],1]]. "races where I'm behind" -> ["and",["is","type",["race"]],[">",["pips","me"],["pips","opp"]]]. "cube decisions in matches" -> ["and",["is","kind",["cube"]],["is","game",["match"]]].`;
  const NUMS = new Set(['at', 'count', 'blots', 'points', 'bar', 'off', 'pips', 'cost', 'cube', 'turn', 'len', 'away', '+', '-', 'hits', 'made', 'slots']);
  const TESTS = new Set(['==', '!=', '<', '<=', '>', '>=', 'and', 'or', 'not', 'is', 'best', 'played']);
  const FIELDS = new Set(['kind', 'decision', 'type', 'theme', 'cubeKind', 'game', 'source', 'roll', 'opp']);
  function odCheck(e, inPlay = false, want = 'test') {
    const bad = (m) => { throw new Error(m); };
    if (typeof e === 'number') { if (want !== 'num') bad('a number where a test belongs'); return; }
    if (!Array.isArray(e) || typeof e[0] !== 'string') bad('every part must be ["op", ...] or a number');
    const op = e[0];
    if (want === 'num' && !NUMS.has(op)) bad(`"${op}" isn't a number`);
    if (want === 'test' && !TESTS.has(op)) bad(`"${op}" isn't a test`);
    const side = (s) => { if (s !== 'me' && s !== 'opp') bad(`side must be "me" or "opp", not ${JSON.stringify(s)}`); };
    const pt = (p) => { if (!Number.isInteger(p) || p < 0 || p > 25) bad(`point ${JSON.stringify(p)} out of 0-25`); };
    switch (op) {
      case 'at': side(e[1]); pt(e[2]); break;
      case 'count': case 'blots': case 'points': side(e[1]); pt(e[2]); pt(e[3]); break;
      case 'bar': case 'off': case 'pips': case 'away': side(e[1]); break;
      case 'cost': case 'cube': case 'turn': case 'len': break;
      case 'hits': if (!inPlay) bad('"hits" works only inside "best" or "played"'); break;
      case 'made': case 'slots': if (!inPlay) bad(`"${op}" works only inside "best" or "played"`); pt(e[1]); pt(e[2]); break;
      case '+': if (e.length < 3) bad('"+" needs two numbers'); e.slice(1).forEach((x) => odCheck(x, inPlay, 'num')); break;
      case '-': if (e.length !== 3) bad('"-" needs two numbers'); odCheck(e[1], inPlay, 'num'); odCheck(e[2], inPlay, 'num'); break;
      case '==': case '!=': case '<': case '<=': case '>': case '>=': if (e.length !== 3) bad(`"${op}" needs two numbers`); odCheck(e[1], inPlay, 'num'); odCheck(e[2], inPlay, 'num'); break;
      case 'and': case 'or': if (e.length < 2) bad(`"${op}" needs tests`); e.slice(1).forEach((x) => odCheck(x, inPlay, 'test')); break;
      case 'not': if (e.length !== 2) bad('"not" takes one test'); odCheck(e[1], inPlay, 'test'); break;
      case 'is': if (!FIELDS.has(e[1])) bad(`unknown field "${e[1]}"`); if (!Array.isArray(e[2]) || !e[2].length || !e[2].every((v) => typeof v === 'string')) bad('"is" needs a list of values'); break;
      case 'best': case 'played': if (inPlay) bad('a play inside a play'); if (e.length !== 2) bad(`"${op}" takes one test`); odCheck(e[1], true, 'test'); break;
      default: bad(`unknown "${op}"`);
    }
  }
  function odEval(e, x) {      // x: {q, b (the position or the board after a play), before (inside a play), after}
    if (typeof e === 'number') return e;
    const [op] = e, b = x.b, q = x.q;
    const at = (s, p) => (p === 25 ? (s === 'me' ? b[25] : b[0]) : s === 'me' ? Math.max(0, b[p] || 0) : Math.max(0, -(b[25 - p] || 0)));
    const range = (s, lo, hi, f) => { let n = 0; for (let p = Math.min(lo, hi); p <= Math.max(lo, hi); p++) if (p >= 1 && p <= 24) n += f(at(s, p)); return n; };
    switch (op) {
      case 'at': return at(e[1], e[2]);
      case 'count': return range(e[1], e[2], e[3], (n) => n);
      case 'blots': return range(e[1], e[2], e[3], (n) => (n === 1 ? 1 : 0));
      case 'points': return range(e[1], e[2], e[3], (n) => (n >= 2 ? 1 : 0));
      case 'bar': return e[1] === 'me' ? b[25] : b[0];
      case 'off': { const c = R.counts(b); return 15 - (e[1] === 'me' ? c.me : c.op); }
      case 'pips': { const p = R.pips(b); return e[1] === 'me' ? p[0] : p[1]; }
      case 'cost': return q.c;
      case 'cube': return setup(q).cube.value;
      case 'turn': return q.t;
      case 'len': return setup(q).rules.type === 'match' ? setup(q).rules.length : 0;
      case 'away': { const P = setup(q); return P.rules.type === 'match' ? P.rules.length - (e[1] === 'me' ? P.score.me : P.score.bot) : 0; }
      case '+': return e.slice(1).reduce((s, y) => s + odEval(y, x), 0);
      case '-': return odEval(e[1], x) - odEval(e[2], x);
      case 'hits': return Math.max(0, x.after[0] - x.before[0]);
      case 'made': { let n = 0; for (let p = Math.min(e[1], e[2]); p <= Math.max(e[1], e[2]); p++) if (p >= 1 && p <= 24 && x.after[p] >= 2 && x.before[p] < 2) n++; return n; }
      case 'slots': { let n = 0; for (let p = Math.min(e[1], e[2]); p <= Math.max(e[1], e[2]); p++) if (p >= 1 && p <= 24 && x.after[p] === 1 && x.before[p] <= 0) n++; return n; }
      case '==': return odEval(e[1], x) === odEval(e[2], x);
      case '!=': return odEval(e[1], x) !== odEval(e[2], x);
      case '<': return odEval(e[1], x) < odEval(e[2], x);
      case '<=': return odEval(e[1], x) <= odEval(e[2], x);
      case '>': return odEval(e[1], x) > odEval(e[2], x);
      case '>=': return odEval(e[1], x) >= odEval(e[2], x);
      case 'and': return e.slice(1).every((y) => odEval(y, x));
      case 'or': return e.slice(1).some((y) => odEval(y, x));
      case 'not': return !odEval(e[1], x);
      case 'is': {
        const P = setup(q), v = { kind: q.k === 'M' ? 'checker' : 'cube', decision: q.k, type: q.pt, theme: themeOf(q), cubeKind: q.ck, game: P.rules.type,
          source: q.src === 'review' ? 'review' : q.src === 'galaxy' || q.src === 'xg' ? 'galaxy' : 'bgplay', roll: P.dice ? `${P.dice[0]}-${P.dice[1]}` : '', opp: q.opp }[e[1]];
        return e[2].some((w) => String(w).toLowerCase() === String(v || '').toLowerCase());
      }
      case 'best': case 'played': {
        if (q.k !== 'M') return false;
        const P = setup(q), name = op === 'best' ? (q.top && q.top[0] ? q.top[0].m : q.b) : q.p, pl = playOf(P, name);
        if (!pl) return false;
        return !!odEval(e[1], { q, b: pl.board, before: P.board, after: pl.board });
      }
      default: return false;
    }
  }
  function odCompute(odq) {
    const set = new Set();
    for (const q of questions()) { try { const P = setup(q); if (odEval(odq.expr, { q, b: P.board })) set.add(q.id); } catch (e) { /* not this one */ } }
    Q.od = { key: odq.key, set };
    return set;
  }
  // The box: a description, the recent ones, Find / Use / Turn off.
  function odOpen() {
    css();
    let el = $('bqOd'); if (!el) { el = document.createElement('div'); el.id = 'bqOd'; el.className = 'bqod'; el.setAttribute('role', 'dialog'); document.body.appendChild(el); }
    Q.odTry = Q.F.od && Q.F.odq ? { ...Q.F.odq } : null; Q.odMsg = Q.F.od ? 'On now.' : '';
    el.classList.add('open'); odPaint(); setTimeout(() => { const t = $('bqOdText'); if (t) t.focus(); }, 50);
  }
  function odClose() { const el = $('bqOd'); if (el) el.classList.remove('open'); const ov = $('bqOv'); if (ov && ov.classList.contains('open')) ov.innerHTML = focusHtml(); }
  function odPaint() {
    const el = $('bqOd'); if (!el) return;
    const T = Q.odTry, F = Q.F, txt = $('bqOdText') ? $('bqOdText').value : T ? T.text : '';
    let h = `<div class="bqodbox"><h3>On Demand</h3><p class="small">Describe the positions you want, in your own words: Claude turns it into a filter.</p>`;
    h += `<textarea id="bqOdText" rows="3" placeholder="e.g. positions where I'm on the bar against a 4-point board">${esc(txt)}</textarea>`;
    if ((F.odh || []).length) h += `<div class="bqchips">${F.odh.map((r, i) => `<button onclick="BQ.odRecent(${i})">${esc(r.text.slice(0, 40))}${r.text.length > 40 ? '…' : ''}</button>`).join('')}</div>`;
    if (Q.odBusy) h += `<p class="status run">Asking Claude…</p>`;
    if (Q.odMsg) h += `<p class="small ${Q.odBad ? 'bad' : 'muted'}">${esc(Q.odMsg)}</p>`;
    if (T && T.expr) {
      const set = odCompute(T), withF = pool({ ...F, od: true, odq: T }).length;
      const ex = questions().filter((q) => set.has(q.id)).slice(0, 3).map((q) => `${q.k === 'M' ? `${setup(q).dice.join('-')}: ${q.p}` : q.p} (${typeName(q.pt)})`);
      h += `<div class="card"><div><b>Claude's reading:</b> ${esc(T.sum || '')}</div>${T.cav ? `<div class="small muted">${esc(T.cav)}</div>` : ''}<div class="small">${plural(set.size, 'position')} match; ${withF} with the rest of your focus.</div>${ex.length ? `<div class="small muted">For example: ${esc(ex.join('; '))}</div>` : ''}<details><summary class="small">The filter</summary><code class="small">${esc(JSON.stringify(T.expr))}</code></details></div>`;
    }
    h += `<div class="row">${btn('Find positions', 'BQ.odFind()', 'primary', Q.odBusy)}${btn('Use this filter', 'BQ.odUse()', '', !(T && T.expr))}${F.od ? btn('Turn off', 'BQ.odOff()') : ''}${btn('Cancel', 'BQ.odClose()')}</div></div>`;
    el.innerHTML = h;
    const t = $('bqOdText'); if (t) t.onkeydown = (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); odFind(); } else if (ev.key === 'Escape') odClose(); ev.stopPropagation(); };
  }
  async function odFind() {
    const text = ($('bqOdText') ? $('bqOdText').value : '').trim();
    if (!text) { Q.odMsg = 'Write what you want first.'; Q.odBad = true; return odPaint(); }
    let sample = null; try { sample = window.claude && (await window.claude.use('sample')); } catch (e) { sample = null; }
    if (!sample) { Q.odMsg = 'Claude can\'t be reached from here.'; Q.odBad = true; return odPaint(); }
    Q.odBusy = true; Q.odMsg = ''; Q.odBad = false; Q.odTry = { text }; odPaint();
    const ask = (extra) => `You turn a backgammon player's description of quiz positions into a filter.\n\n${OD_LANG}\n\n${OD_EX}\n\nThe player's description: ${JSON.stringify(text)}\n${extra || ''}\nAnswer with JSON only: {"filter": <the filter>, "summary": "<one sentence: what the filter selects, in plain words>", "caveat": "<anything you couldn't express or had to interpret; empty if none>"}`;
    try {
      let out = await sample.json(ask(), { modelTier: 'default' }), why = '';
      try { odCheck(out && out.filter); } catch (e) { why = e.message; }
      if (why) { out = await sample.json(ask(`Your last filter was ${JSON.stringify(out && out.filter)}, which is wrong: ${why}. Correct it.`), { modelTier: 'default' }); odCheck(out && out.filter); }
      const T = { text, expr: out.filter, sum: String(out.summary || ''), cav: String(out.caveat || ''), key: JSON.stringify(out.filter) };
      Q.odTry = T; Q.odMsg = '';
    } catch (e) {
      Q.odMsg = e && e.code === 'not_granted' ? 'Claude isn\'t allowed here.' : `Claude's filter didn't work: ${(e && e.message) || e}`; Q.odBad = true;
    } finally { Q.odBusy = false; odPaint(); }
  }
  function odUse() {
    const T = Q.odTry; if (!T || !T.expr) return;
    Q.F.od = true; Q.F.odq = T; Q.F.odh = [T, ...(Q.F.odh || []).filter((r) => r.text !== T.text)].slice(0, 6); saveF();
    odClose(); if (Q.open && !$('bqOv')?.classList.contains('open')) next(true);
  }
  function odOff() { Q.F.od = false; saveF(); Q.odTry = null; Q.odMsg = ''; odClose(); if (Q.open && !$('bqOv')?.classList.contains('open')) next(true); }
  function odRecent(i) { const r = (Q.F.odh || [])[i]; if (!r) return; Q.odTry = { ...r }; Q.odMsg = ''; const t = $('bqOdText'); if (t) t.value = r.text; odPaint(); }

  // ------------------------------------------------------------- the database
  function setDb(db) {
    if (!db || Q.db) return; Q.db = db;
    try {
      db.collection('quiz').onSnapshot((snap) => {
        const m = new Map(); for (const d of snap.docs) { const x = d.data(); if (x) m.set(d.id, x); }
        Q.docs = m; Q.loaded = true; Q.err = '';
        // answers given while the database was out of reach go in now
        for (const [id, st] of Object.entries(Q.stc)) {
          const d = m.get(id); if (d && d.st && (d.st.last || '') >= (st.last || '')) continue;
          if (!d && !id.startsWith('p-')) continue;
          const doc = d ? { ...d, st } : { v: V, ref: id.replace(/^p-/, '').replace(/-\d+[MRDTPB]$/, ''), st };
          Promise.resolve().then(() => db.doc('quiz/' + id).set(JSON.parse(JSON.stringify(doc)))).catch(() => {});
        }
        if (Q.open && Q.cur && Q.cur.empty) next(true); else paint();
      }, (err) => { Q.err = String((err && (err.code || err.message)) || err); paint(); });
    } catch (e) { Q.err = String(e.message || e); }
  }
  // Called by Progress when its records change, so a newly tracked game's blunders join.
  function refresh() { Q.qcache = null; if (Q.open && Q.cur && Q.cur.empty) next(true); }
  function reviewGame(id) { if (window.PG && PG.review) PG.review(id); }
  function key(ev) {
    const C = Q.cur, k = ev.key.toLowerCase();
    if ($('bqOd') && $('bqOd').classList.contains('open')) return;
    if (!C || !C.q) { if (k === 'escape') exit(); return; }
    if (k === 'escape') { ev.preventDefault(); return exit(); }
    if (C.state === 'ask') {
      if (C.q.k === 'M') {
        if (k === 'enter' || k === ' ') { ev.preventDefault(); check(); } else if (k === 'backspace' || k === 'u') userUndo(); else if (k === 's') tapDice();
      } else if (C.P.take && 'tpb'.includes(k)) cube(k.toUpperCase());
      else if (!C.P.take && (k === 'd' || k === 'r')) cube(k.toUpperCase());
    } else if (C.state === 'missed') { if (k === 'r') retry(); else if (k === 'a') reveal(); }
    else if (k === 'enter' || k === ' ' || k === 'n') { ev.preventDefault(); next(); }
  }
  function check() { const t = S.game && S.game.quiz && S.game.phase === 'move' ? getTurn() : null; if (t && t.done) moveDone(t); }
  function skip() { const s = sess(), C = Q.cur; if (C && C.q && !s.shown.includes(C.q.id)) { s.shown.push(C.q.id); s.cur = null; saveSess(); } next(); }

  let cssDone = false;
  function css() {
    if (cssDone) return; cssDone = true;
    const st = document.createElement('style');
    st.textContent = `
  .bq .verdict { margin: 8px 0; padding: 8px 10px; border-radius: 8px; background: var(--bg); border: 1px solid var(--line); font-size: 14px; }
  .bq-best { color: var(--good); } .bq-close { color: var(--muted); } .bq-error { color: var(--yel); } .bq-blunder { color: var(--bad); }
  .verdict.bq-best, .verdict.bq-close, .verdict.bq-error, .verdict.bq-blunder { border-color: currentColor; }
  table.bqrank { width: 100%; margin-top: 6px; } table.bqrank tr { cursor: pointer; } table.bqrank tr.sel td { background: var(--bg); font-weight: 650; }
  table.bqrank td:nth-child(2) { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bqov { position: fixed; inset: 0; z-index: 22; background: var(--bg); color: var(--ink); display: none; flex-direction: column; }
  .bqov.open { display: flex; }
  .bqov .bqhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px max(10px, env(safe-area-inset-right)) 8px max(10px, env(safe-area-inset-left)); border-bottom: 1px solid var(--line); background: var(--panel); }
  .bqov .bqhead .title { font-weight: 700; font-size: 16px; }
  .bqov .bqbody { flex: 1; min-height: 0; overflow-y: auto; padding: 8px max(12px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left)); max-width: 900px; width: 100%; margin: 0 auto; box-sizing: border-box; }
  .bqov h4 { margin: 14px 0 6px; font-size: 13px; color: var(--muted); font-weight: 650; }
  .bqov .seg { display: inline-flex; } .bqov .seg button { flex: 0 0 auto; padding: 0 12px; min-height: 36px; white-space: nowrap; }
  .bqchips { display: flex; flex-wrap: wrap; gap: 6px; }
  .bqchips button { min-height: 34px; padding: 0 10px; border-radius: 17px; font-size: 13.5px; }
  .bqchips button .n { color: var(--muted); font-size: 12px; margin-left: 2px; } .bqchips button.on .n { color: inherit; opacity: .8; }
  .bqod { position: fixed; inset: 0; z-index: 30; background: rgba(0,0,0,.45); display: none; align-items: flex-start; justify-content: center; padding: 6vh 10px; box-sizing: border-box; overflow-y: auto; }
  .bqod.open { display: flex; }
  .bqodbox { background: var(--panel); color: var(--ink); border-radius: 12px; padding: 14px; width: min(560px, 100%); box-shadow: 0 8px 30px rgba(0,0,0,.3); }
  .bqodbox h3 { margin: 0 0 6px; } .bqodbox textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
  .bqodbox .card { margin: 8px 0; } .bqodbox code { word-break: break-all; }
`;
    document.head.appendChild(st);
  }

  function init() {
    loadLocal();
    if (TARGET !== 'tile') return;
    fetch('quiz-reviews.json').then((r) => (r.ok ? r.json() : null)).then((x) => { if (x && Array.isArray(x.list)) { Q.static = x.list; refresh(); } }).catch(() => {});
  }
  window.BQ = { init, setDb, refresh, restarted, open, exit, next, newRound, moveDone, check, cube, retry, reveal, skip, pick, focus, focusClose, toggle, set, side, key,
    realGame, reviewGame, odOpen, odClose, odFind, odUse, odOff, odRecent,
    get on() { return Q.open; }, _Q: Q, _show: (id) => { const q = questions().find((x) => x.id === id); if (q) show(q); }, _questions: questions, _pool: pool, _themeOf: themeOf, _parseX: parseX, _setup: setup, _odCheck: odCheck, _odCompute: odCompute, _shots: shots };
})();
