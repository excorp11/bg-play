// progress.js: progress tracking for BG Play (the user's request, 2026-11-27).
// Every finished game is scored on the device and kept as one record in the tile's database (progress/<id>):
//  - your decisions at 4-ply with XG's counting rules and the XG opening book for turns 1-2 (the end-of-game ER's
//    numbers), each with its XGID, the play or action and the best one, the cost, the gap to the second-best choice,
//    the position type and, for a cube error, its kind;
//  - Open Sage's decisions at 4-ply, for its PR;
//  - every roll's luck at 1-ply (XG: the equity after the roll with the best play, minus the equity before it; a joker
//    is luck above +0.300, an anti-joker below -0.300; the opening roll is left out).
// The Progress tab charts the records: PR over time (each game, and the last 500 decisions with a 95% range), monthly
// totals, splits, position types, cube errors, luck. Games come from the tile (each game as it ends), from Saved games
// (the back-fill, and games sent for review) and from the offline app (pasted, marked for review or for progress only).
// The offline app scores nothing for progress: it keeps every finished game and sends it to the tile.
// Loaded before app.js; it uses app.js's functions (job, analyzeDecision, decisionsOf, gOf, ...) when it runs, and
// exposes only window.PG.
(function () {
  'use strict';
  const CRIT = 0.020, JOKER = 0.300, WIN_N = 500, Z95 = 1.96, SD0 = 19, KEY = 'bgplay-track', V = 1;
  // The band colours of the arrows and lists (the user's rule, 2026-11-27): best green, close grey, error yellow,
  // blunder red.
  const COL = { best: '#2e9e4f', close: '#a4a4a4', error: '#f2c230', blunder: '#e0413a' };
  const BAND_NAMES = { best: 'Best', close: 'Close (under 0.020)', error: 'Error (0.020 to 0.080)', blunder: 'Blunder (0.080 or more)' };
  // XG's rating bands for PR (eXtreme Gammon 2 manual).
  const RATINGS = [[0, 2.5, 'World Champ'], [2.5, 5, 'World Class'], [5, 7.5, 'Expert'], [7.5, 12.5, 'Advanced'], [12.5, 17.5, 'Intermediate'],
    [17.5, 22.5, 'Casual Player'], [22.5, 30, 'Beginner'], [30, Infinity, 'Distracted']];
  const rating = (pr) => (pr == null ? '' : (RATINGS.find(([a, b]) => pr >= a && pr < b) || RATINGS[7])[2]);
  // XG's labels for the average luck per roll (normalized equity).
  const LUCKL = [[-0.040, 'Not your day'], [-0.030, 'Very unlucky'], [-0.020, 'Unlucky'], [-0.010, 'Quite unlucky'], [-0.002, 'Average'], [0.002, 'Insignificant'],
    [0.010, 'Average'], [0.020, 'Quite lucky'], [0.030, 'Lucky'], [0.040, 'Very lucky'], [Infinity, 'It\'s in the wrist']];
  const luckLabel = (x) => (x == null ? '' : LUCKL.find(([hi]) => x < hi)[1]);
  // Position types (agreed 2026-11-27), from your side: the first that fits, in this order.
  const TYPES = [['opening', 'Opening (turns 1-4)'], ['blitz', 'Blitz: you attack'], ['vs-blitz', 'Blitz: you are attacked'], ['primevprime', 'Prime vs prime'],
    ['priming', 'Priming: your prime'], ['vs-priming', 'Primed: their prime'], ['bearin', 'Bearing in or off against contact'], ['backgame', 'Back game: yours'],
    ['holding', 'Holding game: your anchor'], ['vs-bearin', 'They bear in or off against you'], ['vs-backgame', 'Against a back game'],
    ['vs-holding', 'Against a holding game'], ['middle', 'Other middle game'], ['race', 'Race'], ['bearoff', 'Bear-off']];
  const TYPE_NAME = Object.fromEntries(TYPES);
  // Cube errors by kind: missed and wrong doubles near the doubling point or near too good (GNU Backgammon's split, at an
  // equity of 0.95), wrong takes and passes.
  const KINDS = [['missed-DP', 'Missed double, near the doubling point'], ['missed-TG', 'Missed double, near too good (a cash)'],
    ['wrong-DP', 'Wrong double, too early'], ['wrong-TG', 'Wrong double, too good to double'], ['wrong-take', 'Wrong take'], ['wrong-pass', 'Wrong pass'],
    ['wrong-beaver', 'Wrong beaver'], ['missed-beaver', 'Missed beaver']];
  const r3 = (x) => Math.round(x * 1000) / 1000, r4 = (x) => Math.round(x * 10000) / 10000;
  const bandOf = (c) => { const v = r3(Math.max(0, c)); return v >= 0.08 ? 'blunder' : v >= 0.02 ? 'error' : v > 0 ? 'close' : 'best'; };
  const TR = { q: [], out: [], docs: new Map(), db: null, loaded: false, busy: false, cur: null, err: '', dbErr: '', view: { type: 'all', len: 0, metric: 'pr', vals: false }, hover: -1 };
  try { TR.view.metric = localStorage.getItem('bgplay-pgmetric') || 'pr'; } catch (e) { /* the default */ }

  // ------------------------------------------------------------- position types
  // b: one side's view (positive = that side's checkers, [25] its bar, [0] the other side's bar).
  function feats(b) {
    const made = (p) => b[p] >= 2;
    let homePts = 0, blotsIn = 0, ptsIn = 0;
    for (let p = 1; p <= 6; p++) { if (made(p)) homePts++; if (b[p] === -1) blotsIn++; if (b[p] <= -2) ptsIn++; }
    // attacking: 3+ home points, the other side on the bar or with 2+ blots in this home board, and no anchor there
    // (one blot deep behind your points is a prime or a bear-in, not a blitz)
    const blitz = homePts >= 3 && (b[0] > 0 || blotsIn >= 2) && ptsIn === 0;
    // a prime: 4+ made points in a row with an opposing checker behind it (lower points, or on the bar)
    let prime = false, run = 0;
    for (let p = 1; p <= 24 && !prime; p++) {
      run = made(p) ? run + 1 : 0;
      if (run >= 4) { const lo = p - run + 1; if (b[0] > 0) prime = true; for (let q = 1; q < lo && !prime; q++) if (b[q] < 0) prime = true; }
    }
    let back = 0; for (let p = 19; p <= 24; p++) if (made(p)) back++;          // points held in the other side's home board
    const holding = made(18) || made(19) || made(20) || made(21);           // an anchor on their bar, 6, 5 or 4 point
    let rear = b[25] > 0 ? 25 : 0; for (let p = 24; p >= 1 && !rear; p--) if (b[p] > 0) rear = p;
    return { blitz, prime, back, holding, in12: rear <= 12, pips: R.pips(b)[0] };
  }
  // b: your view. Back game: 2+ points in their home board and 30+ pips behind; holding game: an anchor on their 4, 5,
  // 6 or bar point and behind in the race; bearing in: none of your checkers beyond your 12 point, with contact.
  // The game plan decides, in this order: a blitz, a back game, a bear-in, primes, a holding game (each yours, then
  // theirs). So bearing in against a back game counts as against a back game, a bear-in with your board in front of
  // their ace anchor is a bear-in, and your anchor behind their prime is being primed.
  function posType(b, turn) {
    if (turn <= 4) return 'opening';
    if (R.noContact(b)) return R.allHome(b) ? 'bearoff' : 'race';
    const me = feats(b), op = feats(R.flip(b));
    if (me.blitz) return 'blitz';
    if (op.blitz) return 'vs-blitz';
    if (me.back >= 2 && me.pips >= op.pips + 30) return 'backgame';
    if (op.back >= 2 && op.pips >= me.pips + 30) return 'vs-backgame';
    if (me.in12) return 'bearin';
    if (op.in12) return 'vs-bearin';
    if (me.prime && op.prime) return 'primevprime';
    if (me.prime) return 'priming';
    if (op.prime) return 'vs-priming';
    if (me.holding && me.pips > op.pips) return 'holding';
    if (op.holding && op.pips > me.pips) return 'vs-holding';
    return 'middle';
  }

  // ------------------------------------------------------------- the queue
  function load() { try { const x = JSON.parse(localStorage.getItem(KEY) || 'null'); if (x) { TR.q = x.q || []; TR.out = x.out || []; } } catch (e) { /* start empty */ } for (const r of TR.out) TR.docs.set(r.id, r); }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify({ q: TR.q, out: TR.out })); } catch (e) { /* full: the queue lives on in memory */ } }
  const tracked = (id) => TR.docs.has(id) || TR.out.some((r) => r.id === id);
  const queued = (id) => TR.q.some((x) => x.id === id || (x.ids && x.ids.includes(id))) || (TR.cur && TR.cur.id === id);
  // The games in a BG Play game file: [{id, ...}] with their own ids (a match: <file id>-g<n>).
  function fileGames(e) {
    const chk = R.checkBgPlayMat(e.mat), h = chk.parsed.head;
    const d = (h.EventDate || '').split('.').map(Number), t = (h.EventTime || '').split('.').map(Number);
    const at0 = d.length === 3 && d.every(Number.isFinite) ? new Date(d[0], d[1] - 1, d[2], t[0] || 0, t[1] || 0).getTime() : (+e.at || Date.now());
    return chk.games.map((G, i) => ({ id: chk.kind === 'match' ? `${e.id}-g${G.n}` : e.id, src: e.src || 'tile', at: at0 + i, rules: chk.rules, ply: chk.ply,
      matchId: chk.kind === 'match' ? e.id : null, G, events: chk.parsed.games[i].events }));
  }
  // A game file (a saved game, or one pasted from the offline app): queued unless all its games are tracked already.
  function enqueueFile(e) {
    if (TARGET !== 'tile' || !e || typeof e.mat !== 'string') return;
    let ids; try { ids = fileGames(e).map((x) => x.id); } catch (err) { return; }
    if (ids.every((id) => tracked(id) || queued(id))) return;
    TR.q.push({ file: true, id: 'file:' + e.id, fid: e.id, ids, src: e.src || 'tile', at: +e.at || Date.now(), mat: e.mat, ply: e.ply });
    persist(); kick();
  }
  // The game that just ended in the tile (called by app.js once its ER is done). Your decisions' results come along,
  // so they aren't worked out twice. The offline app keeps the game to send to the tile instead.
  function gameOver(gm, M0) {
    const M = M0 || S.match;                         // the game's own match (a new one may have started since)
    if (TARGET === 'pwa') return keepForTile(gm, M);
    const isMatch = gm.rules.type === 'match';
    if (isMatch && !M) return;
    const id = isMatch ? `${M.id}-g${gm.n}` : gm.id;
    if (tracked(id) || queued(id)) return;
    const pre = {}; for (const d of gm.decisions) if (d.res && !d.res.err) pre[d.turn + ':' + d.k] = d.res;
    TR.q.push({ id, src: 'tile', at: gm.started, rules: gm.rules, ply: gm.ply, matchId: isMatch ? M.id : null,
      g: { n: gm.n, score: [gm.score.me, gm.score.bot], crawford: !!gm.crawford, events: gm.events }, pre });
    persist(); kick();
  }
  // Offline app: every finished game (a match once it ends) is kept to go to the tile with Send to the tile, for
  // progress; Save for full analysis marks it for review as well.
  function keepForTile(gm, M) {
    const isMatch = gm.rules.type === 'match';
    if (isMatch && !(M && M.over)) return;
    keep(isMatch ? buildMat('match', gm, M) : buildMat('cash', gm, M));
  }
  // A match left unfinished (a new cash game or match started): the games played in it, for your progress.
  function keepMatch(M) { if (TARGET === 'pwa' && M && M.games.length) keep(buildMat('match', null, M)); }
  function keep(e) {
    if (S.saved.find((x) => x.id === e.id)) return;
    S.saved.unshift({ ...e, created: Date.now(), status: 'local', want: 'track' });
    save(); prepareBundle(); renderAll();
  }
  // A game file Claude was given in the chat to track (Galaxy, XG): Claude writes it to progress/<id> as
  // {pending: 1, src, at, opp, rules, games: JSON text of [{n, score: [you, them], crawford, events}]} (BG Play's own
  // event format, converted by src/track_mat.js), and the tile scores it here like any other game. A cash game's
  // record then takes that document's place; a match's games get <id>-g<n> and the pending document is deleted.
  function enqueueExt(did, x) {
    if (TARGET !== 'tile' || queued('ext:' + did)) return;
    let list; try { list = JSON.parse(x.games); } catch (e) { return; }
    if (!Array.isArray(list) || !list.length || !x.rules || !['cash', 'match'].includes(x.rules.type)) return;
    const match = x.rules.type === 'match', ids = list.map((g) => (match ? `${did}-g${g.n}` : did));
    if (ids.every((id) => tracked(id))) { if (match) dropPending(did); return; }
    TR.q.push({ ext: true, id: 'ext:' + did, did, ids, src: String(x.src || 'file').slice(0, 20), at: Date.parse(x.at) || Date.now(), opp: String(x.opp || 'Opponent').slice(0, 40),
      rules: match ? { type: 'match', length: +x.rules.length } : { type: 'cash', jacoby: !!x.rules.jacoby, beavers: !!x.rules.beavers }, games: x.games });
    persist(); kick();
  }
  function dropPending(did) { if (TR.db) try { Promise.resolve(TR.db.doc('progress/' + did).delete()).catch(() => {}); } catch (e) { /* left for next time */ } }
  // Back-fill: every saved game (the tile's Saved games mirror its database) gets a record once.
  function scan() {
    if (TARGET !== 'tile' || !TR.loaded) return;
    for (const e of S.saved) if (e.mat) enqueueFile({ id: e.id, src: e.source || 'tile', at: e.created, mat: e.mat, ply: e.ply });
  }
  function expand(it) {
    if (it.file) return fileGames({ id: it.fid, src: it.src, at: it.at, mat: it.mat, ply: it.ply });
    if (it.ext) {
      const list = JSON.parse(it.games), match = it.rules.type === 'match';
      const Gs = R.replayGames({ games: list.map((g) => ({ n: g.n, score: g.score, crawford: !!g.crawford, events: g.events })) }, it.rules, { botNoDoubles: true });
      return Gs.map((G, i) => ({ id: match ? `${it.did}-g${G.n}` : it.did, src: it.src, at: it.at + i, rules: it.rules, ply: null, opp: it.opp, matchId: match ? it.did : null, G, events: list[i].events }));
    }
    const G = R.replayGames({ games: [{ n: it.g.n, score: it.g.score, crawford: it.g.crawford, events: it.g.events }] }, it.rules, { botNoDoubles: true })[0];
    return [{ ...it, G, events: it.g.events }];
  }
  // Works through the queue in the engine's background priority (after Open Sage's moves and your ER).
  async function kick() {
    if (TARGET !== 'tile' || TR.busy) return;
    if (!TR.q.length) return roKick();
    if (ENG.state !== 'ready' || !ENG.pool) return;
    TR.busy = true; paint();
    try {
      while (TR.q.length && ENG.state === 'ready' && ENG.pool) {
        const it = TR.q[0];
        let games; try { games = expand(it); } catch (e) { TR.q.shift(); TR.err = `A game couldn't be read: ${e.message || e}`; persist(); continue; }
        let stop = false;
        for (const x of games) {
          if (tracked(x.id)) continue;
          if (it.file) x.G = R.replayGames({ games: [{ n: x.G.n, score: [x.G.score.me, x.G.score.bot], crawford: x.G.crawford, events: x.events }] }, x.rules, { botNoDoubles: true })[0];
          TR.cur = { id: x.id, at: x.at }; paint();
          const rec = await scoreGame(x);
          if (!rec) { stop = true; break; }                // the engine stopped (a review opened): carried on after the restart
          await store(rec); paint();
        }
        TR.cur = null;
        if (stop) break;
        if (it.ext && it.rules.type === 'match') dropPending(it.did);
        TR.q.shift(); persist();
      }
    } finally { TR.busy = false; TR.cur = null; paint(); }
    if (!TR.q.length) roKick();
  }

  // ------------------------------------------------------------- scoring a game
  // Open Sage's decisions, as analyzeDecision takes them (its view, its score first).
  function botDecisions(G) {
    const out = [], base = { rules: G.rules, score: { me: G.score.bot, bot: G.score.me, crawford: G.crawford }, game: G.n };
    for (const P of G.pos) {
      const g = (side) => gOf(G.rules, G.score, G.crawford, P.cube, side);
      if (P.type === 'roll' && P.side === 'bot' && P.n > 1) out.push({ ...base, k: 'M', turn: P.turn, board: P.before, dice: P.dice, after: P.after, played: P.name, g: g('bot'), cube: { ...P.cube } });
      else if (P.type === 'nodouble' && P.side === 'bot') out.push({ ...base, k: 'R', turn: P.turn, board: P.board, g: g('bot'), cube: { ...P.cube } });
      else if (P.type === 'double' && P.side === 'bot') out.push({ ...base, k: 'D', turn: P.turn, board: P.board, g: g('bot'), cube: { ...P.cube } });
      else if (P.type === 'double') out.push({ ...base, k: { take: 'T', drop: 'P', beaver: 'B' }[P.answer], turn: P.turn, board: P.board, g: g('me'), cube: { ...P.cube } });
    }
    return out;
  }
  // A roll's luck: its best play's 1-ply equity minus the average over all 36 rolls (the equity before the roll).
  async function luckOf(P, G) {
    try {
      const v = await job({ cmd: 'luck', board: P.before, g: gOf(G.rules, G.score, G.crawford, P.cube, P.side) }, 'bg');
      let sum = 0, i = 0, got = 0; const [hi, lo] = P.dice;
      for (let a = 1; a <= 6; a++) for (let b = 1; b <= a; b++, i++) { sum += v[i] * (a === b ? 1 : 2); if (a === hi && b === lo) got = v[i]; }
      return { side: P.side, luck: got - sum / 36, cube: P.cube.value };
    } catch (e) { if (stopped(e)) return null; return { side: P.side, luck: 0, cube: P.cube.value, err: 1 }; }
  }
  async function scoreGame(x) {
    const G = x.G, mine = decisionsOf(G), theirs = botDecisions(G);
    if (x.pre) for (const d of mine) { const r = x.pre[d.turn + ':' + d.k]; if (r && !r.err) d.res = r; }
    const rolls = G.pos.filter((P) => P.type === 'roll' && P.turn > 1), lucks = [];
    await Promise.all([...mine, ...theirs].map((d) => analyzeDecision(d, 'bg')).concat(rolls.map((P) => luckOf(P, G).then((l) => { if (l) lucks.push(l); }))));
    if ([...mine, ...theirs].some((d) => !d.res) || lucks.length !== rolls.length) return null;
    return record(x, G, mine, theirs, lucks);
  }
  // The gap between the best choice and the next one (book plays from the book).
  function gapOf(d) {
    const r = d.res; if (!r || r.err) return null;
    if (d.k === 'M') {
      if (String(r.src || '').startsWith('XG book')) { const bk = bookFor(d); return bk && bk.plays.length > 1 ? bk.plays[1].err - bk.plays[0].err : null; }
      return r.cands && r.cands.length > 1 ? r.cands[0].e - r.cands[1].e : null;
    }
    if (d.k === 'R' || d.k === 'D') return Math.abs(r.nd - Math.min(r.dt, r.dp));
    const v = r.E ? [r.E.T, r.E.P, r.E.B].filter(Number.isFinite).sort((a, b) => b - a) : [];
    return v.length > 1 ? v[0] - v[1] : null;
  }
  function cubeKind(d) {
    const r = d.res; if (d.k === 'M' || !r || !(r.cost >= 0.0005)) return '';
    if (d.k === 'R') return r.best === 'Double' ? (Math.min(r.dt, r.dp) < 0.95 ? 'missed-DP' : 'missed-TG') : '';
    if (d.k === 'D') return r.best === 'No double' ? (r.nd >= 0.95 ? 'wrong-TG' : 'wrong-DP') : '';
    if (d.k === 'T') return r.best === 'Pass' ? 'wrong-take' : r.best === 'Beaver' ? 'missed-beaver' : '';
    return d.k === 'P' ? 'wrong-pass' : 'wrong-beaver';
  }
  // Your decision's XGID: the side on roll is you, or the doubler for a take decision (dice "D", as XG writes it).
  function xgidOf(d) {
    const take = 'TPB'.includes(d.k), xs = take ? 'bot' : 'me', sc = d.score || { me: 0, bot: 0 };
    const own = d.cube.owner === 0 ? 0 : d.cube.owner === xs ? 1 : 2;
    const x = R.xgid(d.board, { value: d.cube.value, owner: own }, d.k === 'M' ? d.dice : null, d.rules, { mine: take ? sc.bot : sc.me, theirs: take ? sc.me : sc.bot, crawford: !!sc.crawford });
    return take ? x.replace(/^(XGID=[^:]*:[^:]*:[^:]*:[^:]*:)00:/, '$1D:') : x;
  }
  function decRec(d) {
    const r = d.res; if (!r || r.err) return null;
    const take = 'TPB'.includes(d.k), owned = !!d.cube.owner, gap = gapOf(d), ck = cubeKind(d);
    const why = d.k === 'M' ? (r.counted ? '' : r.n > 1 ? 'flat' : 'forced') : d.k === 'R' ? ({ 'optional double': 'opt', 'obvious no double': 'nd', 'obvious too good': 'tg', 'very negative': 'low' }[r.why] || '') : '';
    const o = { t: d.turn, k: d.k, x: xgidOf(d), p: d.k === 'M' ? d.played : { R: owned ? 'No redouble' : 'No double', D: owned ? 'Redouble' : 'Double', T: 'Take', P: 'Pass', B: 'Beaver' }[d.k],
      b: String(r.best || ''), c: r4(+r.cost || 0), n: r.counted ? 1 : 0, pt: posType(take ? R.flip(d.board) : d.board, d.turn) };
    if (why) o.w = why;
    if (gap != null && Number.isFinite(gap)) o.g = r4(gap);
    if (ck) o.ck = ck;
    // errors keep their alternatives (for a quiz or a later look): the top plays with their costs, or the cube equities
    if (r.counted && r3(+r.cost || 0) >= CRIT) {
      if (d.k === 'M') {
        const bk = String(r.src || '').startsWith('XG book') ? bookFor(d) : null;
        o.top = bk ? bk.plays.slice(0, 5).map((p) => ({ m: R.notation(d.board, p.b, d.dice[0], d.dice[1]), c: r4(p.err) }))
          : (r.cands || []).slice(0, 5).map((p) => ({ m: p.name, c: r4(r.cands[0].e - p.e) }));
      } else o.eq = { nd: r4(r.nd), dt: r4(r.dt), dp: r4(r.dp), bv: r.beaver ? 1 : 0 };
    }
    return o;
  }
  // Totals over counted decisions (XG's PR counting).
  function sums(decs) {
    const s = { n: 0, nM: 0, nC: 0, lost: 0, lostM: 0, lostC: 0, err: 0, blun: 0, best: 0, crit: 0, critBest: 0 };
    for (const d of decs) {
      const r = d.res; if (!r || r.err || !r.counted) continue;
      const c = Math.max(0, +r.cost || 0), band = bandOf(c), g = gapOf(d);
      s.n++; s.lost += c; if (d.k === 'M') { s.nM++; s.lostM += c; } else { s.nC++; s.lostC += c; }
      if (band === 'blunder') s.blun++; else if (band === 'error') s.err++; else if (band === 'best') s.best++;
      if (g != null && r3(g) >= CRIT) { s.crit++; if (band === 'best') s.critBest++; }
    }
    for (const k of ['lost', 'lostM', 'lostC']) s[k] = r4(s[k]);
    return s;
  }
  function record(x, G, mine, theirs, lucks) {
    const rules = G.rules, cash = rules.type !== 'match', res = G.result || {};
    const pts = res.points ? (res.winner === 'me' ? res.points : -res.points) : 0;
    const L = { you: 0, them: 0, youPts: 0, themPts: 0, jokers: [0, 0], anti: [0, 0], rolls: [0, 0] };
    for (const l of lucks) {
      const i = l.side === 'me' ? 0 : 1; if (l.err) continue;
      L.rolls[i]++; L[i ? 'them' : 'you'] += l.luck; L[i ? 'themPts' : 'youPts'] += l.luck * l.cube;
      if (l.luck > JOKER) L.jokers[i]++; else if (l.luck < -JOKER) L.anti[i]++;
    }
    for (const k of ['you', 'them', 'youPts', 'themPts']) L[k] = r4(L[k]);
    return { v: V, id: x.id, src: x.src || 'tile', at: new Date(x.at).toISOString(), added: new Date().toISOString(), type: cash ? 'cash' : 'match', len: cash ? 0 : rules.length,
      rules: cash ? { type: 'cash', jacoby: !!rules.jacoby, beavers: !!rules.beavers } : { type: 'match', length: rules.length },
      opp: x.opp || botName(x.ply), ply: x.ply || null, match: cash ? null : { id: x.matchId, n: G.n, score: [G.score.me, G.score.bot], crawford: !!G.crawford },
      res: { pts, kind: res.kind || 0, how: res.how || '' }, eng: `Open Sage ${ER_PLY}-ply`,
      you: sums(mine), them: sums(theirs), luck: L, lar: cash ? r4(pts - (L.youPts - L.themPts)) : null,
      // the game itself, for its review (as a JSON string: the database takes no arrays inside arrays)
      ev: { n: G.n, score: [G.score.me, G.score.bot], crawford: !!G.crawford, events: JSON.stringify(x.events) },
      decs: mine.map(decRec).filter(Boolean) };
  }

  // ------------------------------------------------------------- rollout level (the user's request, 2026-11-28)
  // Your decisions only. Once a game has its 4-ply record, the decisions where a rollout can change the cost (your play
  // wasn't the 4-ply best, or another play came within 0.08; every counted cube decision) are rolled out: your play, the
  // best and every play within 0.08 at truncated3 (360 games each, about XG Roller++; one seed for all, so the plays meet
  // the same dice), a cube decision in 4 parts of 108 games. Turns 1-2 keep the XG book (XG's own rollouts), races and
  // bear-offs 4-ply. When a game is done, its record takes the rolled-out costs (the 4-ply cost stays as c4, not shown) and
  // lvl 'ro'; until then Progress shows its 4-ply figures. Newest games first; only while the tile is open; a game cut
  // short carries on from its last decision (kept in the browser).
  const RO = { busy: false, cur: null, left: 0, n: +window.BGP_RO_N || 360, cubeN: +window.BGP_RO_CUBEN || 432, preset: 3, cache: {} };   // (tests set fewer games)
  const RO_KEY = 'bgplay-ro', WIDE = 0.08, RO_MAX = 6, NOCONTACT = new Set(['race', 'bearoff']);
  try { RO.cache = JSON.parse(localStorage.getItem(RO_KEY) || '{}') || {}; } catch (e) { RO.cache = {}; }
  const roSave = () => { try { localStorage.setItem(RO_KEY, JSON.stringify(RO.cache)); } catch (e) { /* redone next time */ } };
  const roWants = (d) => !!(d.n && d.t > 2 && !NOCONTACT.has(d.pt) && (d.k !== 'M' || d.c >= 0.0005 || (d.g != null && d.g < WIDE)));
  const roPending = (r) => !!(r && r.v === V && r.lvl !== 'ro' && r.ev && Array.isArray(r.decs));
  const roList = () => [...TR.docs.values()].filter(roPending).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  async function roKick() {
    if (TARGET !== 'tile' || RO.busy || TR.busy || TR.q.length || !TR.loaded || ENG.state !== 'ready' || !ENG.pool || RO.off || window.BGP_NO_ROLLOUT) return;
    let list = roList(); if (!list.length) return;
    RO.busy = true; RO.left = list.length; paint();
    try {
      while (list.length && ENG.state === 'ready' && ENG.pool && !TR.q.length) {
        RO.cur = { id: list[0].id, done: 0, n: 0 }; paint();
        const rec = await roRecord(list[0]);
        if (!rec) break;                                   // the engine stopped (a review opened): carried on after the restart
        await store(rec);
        list = roList(); RO.left = list.length; paint();
      }
    } finally { RO.busy = false; RO.cur = null; paint(); }
  }
  async function roRecord(r) {
    const want = r.decs.filter(roWants), done = RO.cache[r.id] || (RO.cache[r.id] = {}), now = () => new Date().toISOString();
    let mine = [];
    if (want.length) {
      try {
        const ev = typeof r.ev.events === 'string' ? JSON.parse(r.ev.events) : r.ev.events;
        mine = decisionsOf(R.replayGames({ games: [{ n: r.ev.n || 1, score: r.ev.score, crawford: !!r.ev.crawford, events: ev }] }, r.rules, { botNoDoubles: true })[0]);
      } catch (e) { delete RO.cache[r.id]; roSave(); return { ...r, lvl: 'ro', ro: { at: now(), n: 0, err: String(e.message || e).slice(0, 120) } }; }
    }
    RO.cur.n = want.length; RO.cur.done = want.filter((x) => done[x.t + ':' + x.k]).length; paint();
    for (const old of want) {
      const key = old.t + ':' + old.k; if (done[key]) continue;
      const d = mine.find((x) => x.turn === old.t && x.k === old.k);
      let res = null;
      if (d) { try { res = d.k === 'M' ? await roPlay(d) : await roCube(d); } catch (e) { if (stopped(e)) return null; res = 'keep'; } }
      if (!res) { if (!ENG.pool || ENG.state !== 'ready') return null; res = 'keep'; }
      let o = null;
      if (res !== 'keep') { d.res = res; o = decRec(d); }
      done[key] = o ? { ...o, n: 1, ...(old.w ? { w: old.w } : {}), c4: old.c, ro: 1 } : { ...old };   // a decision that can't be rolled out keeps 4-ply
      roSave(); RO.cur.done++; paint();
    }
    const decs = r.decs.map((x) => done[x.t + ':' + x.k] || x);
    delete RO.cache[r.id]; roSave();
    return { ...r, decs, you: sumsRec(decs), lvl: 'ro', ro: { at: now(), n: want.length, games: RO.n, cube: RO.cubeN } };
  }
  // A checker play: the 4-ply ranking again (the record keeps only the costs), then the plays that matter rolled out.
  async function roPlay(d) {
    const rk = await moveRank(d, 'ro');
    if (!rk || rk.plays.length < 2) return null;
    const top = rk.top, best = top[0], at3 = rk.plays.filter((p) => p.e[3] != null).sort((a, b) => b.e[3] - a.e[3]), pick = [];
    const add = (p) => { if (p && !pick.includes(p)) pick.push(p); };
    add(best); add(rk.plays.find((p) => R.same(p.b, d.after)));
    for (const p of top) if (best.e[rk.depth] - p.e[rk.depth] <= WIDE && pick.length < RO_MAX) add(p);
    for (const p of at3) if (at3[0].e[3] - p.e[3] <= WIDE && pick.length < RO_MAX) add(p);
    const out = await Promise.all(pick.map((p) => job({ cmd: 'rollPlay', post: p.b, preset: RO.preset, n: RO.n, seed: 1, g: d.g }, 'ro')));
    const rows = pick.map((p, i) => ({ b: p.b, e: out[i].e, se: out[i].se, name: R.notation(d.board, p.b, d.dice[0], d.dice[1]) })).sort((a, b) => b.e - a.e);
    const played = rows.find((x) => R.same(x.b, d.after));
    return { cost: Math.max(0, rows[0].e - played.e), counted: true, best: rows[0].name, bestB: rows[0].b, src: 'rollout', cands: rows, playedE: played.e, n: rk.plays.length, ply: 'ro' };
  }
  // A cube decision (the doubler's board, as at 4-ply): no double and double/take rolled out; double/pass is +1.
  async function roCube(d) {
    const parts = 4, per = Math.max(36, Math.round(RO.cubeN / parts / 36) * 36);
    const out = await Promise.all(Array.from({ length: parts }, (_, i) => job({ cmd: 'rollCube', board: d.board, preset: RO.preset, n: per, seed: 1 + i * 7919, g: d.g }, 'ro')));
    const mean = (k) => out.reduce((a, o) => a + o[k], 0) / out.length, nd = mean('nd'), dt = mean('dt');
    const probs = [0, 1, 2, 3, 4].map((i) => out.reduce((a, o) => a + o.p[i], 0) / out.length);
    const beav = !d.g.a1 && !!d.g.bea && d.g.co !== 2 && dt < 0;          // as the analyzer: a beaver doubles the take's value
    const res = cubeRes(d, { equity_nd: nd, equity_dt: beav ? 2 * dt : dt, equity_dp: 1, is_beaver: beav, probs }, 'ro');
    res.counted = true; res.why = '';                       // counted at 4-ply, so it stays counted
    return res;
  }
  // A record's totals from its decisions (as sums, from the stored costs).
  function sumsRec(decs) {
    const s = { n: 0, nM: 0, nC: 0, lost: 0, lostM: 0, lostC: 0, err: 0, blun: 0, best: 0, crit: 0, critBest: 0 };
    for (const d of decs) {
      if (!d.n) continue;
      const c = Math.max(0, +d.c || 0), band = bandOf(c);
      s.n++; s.lost += c; if (d.k === 'M') { s.nM++; s.lostM += c; } else { s.nC++; s.lostC += c; }
      if (band === 'blunder') s.blun++; else if (band === 'error') s.err++; else if (band === 'best') s.best++;
      if (d.g != null && r3(d.g) >= CRIT) { s.crit++; if (band === 'best') s.critBest++; }
    }
    for (const k of ['lost', 'lostM', 'lostC']) s[k] = r4(s[k]);
    return s;
  }
  // For the end panel, the review and the Full reviews list: a game's record, its costs once rolled out, a saved game's ER.
  const recIdOf = (gm, M) => (gm.rules.type === 'match' && M ? `${M.id}-g${gm.n}` : gm.id);
  const recOf = (gm, M) => TR.docs.get(recIdOf(gm, M)) || null;
  function costsFor(pairs) {
    const recs = pairs.map(([, id]) => TR.docs.get(id));
    if (!recs.length || recs.some((r) => !r || r.lvl !== 'ro')) return null;
    return pairs.flatMap(([g], i) => recs[i].decs.map((d) => ({ g, t: d.t, k: d.k, c: d.c, n: d.n, b: d.b })));
  }
  const nGames = new Map();
  function erOf(e) {
    if (!e || !e.id) return null;
    let ids = [e.id];
    if (e.kind === 'match') {
      let n = nGames.get(e.id); if (n == null) { try { n = R.checkBgPlayMat(e.mat).games.length; } catch (err) { n = 0; } nGames.set(e.id, n); }
      ids = Array.from({ length: n }, (_, i) => `${e.id}-g${i + 1}`);
    }
    const recs = ids.map((id) => TR.docs.get(id));
    if (!recs.length || recs.some((r) => !r || r.lvl !== 'ro')) return null;
    const n = recs.reduce((a, r) => a + r.you.n, 0), lost = recs.reduce((a, r) => a + r.you.lost, 0);
    return { er: n ? (lost * 500) / n : 0, n, total: lost };
  }

  // ------------------------------------------------------------- the database
  async function store(rec) {
    rec = JSON.parse(JSON.stringify(rec));              // plain data only (no undefined)
    TR.docs.set(rec.id, rec); if (window.BQ) BQ.refresh();
    if (TR.db) { try { await TR.db.doc('progress/' + rec.id).set(rec); TR.out = TR.out.filter((r) => r.id !== rec.id); persist(); return; } catch (e) { TR.err = 'Saving progress: ' + (e.code || e.message || e); } }
    if (!TR.out.some((r) => r.id === rec.id)) TR.out.push(rec);
    persist();
  }
  async function flush() {
    if (!TR.db || !TR.out.length) return;
    for (const rec of TR.out.slice()) {
      try { await TR.db.doc('progress/' + rec.id).set(rec); TR.out = TR.out.filter((r) => r.id !== rec.id); persist(); } catch (e) { TR.err = 'Saving progress: ' + (e.code || e.message || e); break; }
    }
  }
  function setDb(db) {
    if (!db || TR.db) return; TR.db = db;
    try {
      db.collection('progress').onSnapshot((snap) => {
        const m = new Map(), pend = [];
        for (const d of snap.docs) { const x = d.data(); if (x && x.v === V) m.set(d.id, x); else if (x && x.pending === 1 && typeof x.games === 'string') pend.push([d.id, x]); }
        for (const r of TR.out) m.set(r.id, r);
        TR.docs = m; TR.loaded = true; TR.dbErr = '';
        for (const [id, x] of pend) enqueueExt(id, x);
        flush(); scan(); paint(); roKick();
        if (window.BQ) BQ.refresh();               // the Blunder Quiz takes the new blunders
      }, (err) => { TR.dbErr = String((err && (err.code || err.message)) || err); paint(); });
    } catch (e) { TR.dbErr = String(e.message || e); }
  }

  // ------------------------------------------------------------- figures
  // Counted decisions -> totals: PR overall, per checker play and per cube decision (XG's separate levels), the PR
  // that blunders, errors and smaller misses make up, errors and blunders per 100 decisions, best moves, critical ones.
  function agg(list) {
    const a = { n: 0, nM: 0, nC: 0, lost: 0, lostM: 0, lostC: 0, band: { best: 0, close: 0, error: 0, blunder: 0 }, part: { close: 0, error: 0, blunder: 0 }, crit: 0, critBest: 0, sq: 0 };
    for (const d of list) {
      const c = Math.max(0, d.c), band = bandOf(c);
      a.n++; a.lost += c; a.sq += (c * 500) ** 2;
      if (d.k === 'M') { a.nM++; a.lostM += c; } else { a.nC++; a.lostC += c; }
      a.band[band]++; if (band !== 'best') a.part[band] += c;
      if (d.g != null && r3(d.g) >= CRIT) { a.crit++; if (band === 'best') a.critBest++; }
    }
    const per = (x, n) => (n ? (x * 500) / n : null);
    a.pr = per(a.lost, a.n); a.prM = per(a.lostM, a.nM); a.prC = per(a.lostC, a.nC);
    return a;
  }
  const counted = (recs) => recs.flatMap((r) => (r.decs || []).filter((d) => d.n));
  // The spread of one decision's error in PR units, from your own data once there are 100 decisions (19 before:
  // Lasse Madsen's figure for online matches); the 95% range of a PR over n decisions is 1.96 x sd / sqrt(n).
  function sdOf(list) {
    if (list.length < 100) return SD0;
    const xs = list.map((d) => Math.max(0, d.c) * 500), m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  }
  // The figures the trend chart can draw: each headline figure (the user's request, 2026-11-27). Each one per game,
  // over a rolling window of its own decisions with its 95% range, and over all games so far. Cube and critical
  // decisions are rarer than the rest, so their window is 100. xg: XG's rating bands are shaded (they rate a PR over
  // all decisions, so not the checker-only or cube-only one).
  const isBand = (b) => (d) => bandOf(d.c) === b, every = () => true;
  const METRICS = [
    { k: 'pr', name: 'PR', chip: 'PR', unit: 'pr', win: WIN_N, one: 'decision', pick: every, xg: true },
    { k: 'prM', name: 'Checker play PR', chip: 'Checker PR', unit: 'pr', win: WIN_N, one: 'checker play', pick: (d) => d.k === 'M' },
    { k: 'prC', name: 'Cube PR', chip: 'Cube PR', unit: 'pr', win: 100, one: 'cube decision', pick: (d) => d.k !== 'M' },
    { k: 'best', name: 'Best moves', chip: 'Best moves', unit: 'pct', win: WIN_N, one: 'decision', pick: every, hit: isBand('best') },
    { k: 'crit', name: 'Critical decisions: best found', chip: 'Critical best', unit: 'pct', win: 100, one: 'critical decision', pick: (d) => d.g != null && r3(d.g) >= CRIT, hit: isBand('best') },
    { k: 'err', name: 'Errors per 100 decisions', chip: 'Errors /100', unit: 'per', win: WIN_N, one: 'decision', pick: every, hit: isBand('error') },
    { k: 'blu', name: 'Blunders per 100 decisions', chip: 'Blunders /100', unit: 'per', win: WIN_N, one: 'decision', pick: every, hit: isBand('blunder') },
    { k: 'opp', name: 'Opponent PR', chip: 'Opponent PR', unit: 'pr', win: WIN_N, one: 'decision', opp: true, xg: true },
  ];
  const metricOf = (k) => METRICS.find((m) => m.k === k) || METRICS[0];
  const fmtOf = (m) => (m.unit === 'pr' ? f2 : m.unit === 'pct' ? (x) => (x == null || !Number.isFinite(x) ? '–' : `${Math.round(x)}%`) : f1);
  // The 95% range of a share: Wilson's interval (it stays within 0-100% and still works at none or all).
  function wilson(h, n) {
    const p = h / n, z2 = Z95 * Z95, d = 1 + z2 / n, c = (p + z2 / (2 * n)) / d, w = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
    return [Math.max(0, c - w), Math.min(1, c + w)];
  }
  // One point per game: g this game (gn decisions of the kind, gh of them hits), roll over the window (rn decisions,
  // lo-hi its 95% range), cum over all so far (cn). PR in PR units; shares and rates per 100.
  function seriesOf(m, recs) {
    const out = [];
    if (m.opp) {      // only the opponent's game totals are kept: whole games make the window, and there's no range
      const win = []; let n = 0, lost = 0, cn = 0, cl = 0;
      recs.forEach((r, i) => {
        const t = r.them && r.them.n ? r.them : null;
        if (t) { win.push(t); n += t.n; lost += t.lost; cn += t.n; cl += t.lost; while (win.length > 1 && n - win[0].n >= m.win) { const o = win.shift(); n -= o.n; lost -= o.lost; } }
        out.push({ i, r, g: t ? (t.lost * 500) / t.n : null, gn: t ? t.n : 0, roll: n ? (lost * 500) / n : null, rn: n, lo: null, hi: null, cum: cn ? (cl * 500) / cn : null, cn });
      });
      return out;
    }
    const sd = m.hit ? 0 : sdOf(counted(recs).filter(m.pick)), sc = m.hit ? 100 : 500;
    const win = []; let sum = 0, cn = 0, cs = 0;
    recs.forEach((r, i) => {
      const ds = (r.decs || []).filter((d) => d.n && m.pick(d)); let gs = 0;
      for (const d of ds) { const v = m.hit ? (m.hit(d) ? 1 : 0) : Math.max(0, d.c); gs += v; cs += v; cn++; win.push(v); sum += v; if (win.length > m.win) sum -= win.shift(); }
      const n = win.length, p = n ? sum / n : null; let lo = null, hi = null;
      if (n) {
        if (m.hit) { const w = wilson(Math.round(sum), n); lo = w[0] * sc; hi = w[1] * sc; }
        else { const ci = (Z95 * sd) / Math.sqrt(n); lo = Math.max(0, p * sc - ci); hi = p * sc + ci; }
      }
      out.push({ i, r, g: ds.length ? (gs / ds.length) * sc : null, gn: ds.length, gh: m.hit ? gs : null, roll: p == null ? null : p * sc, rn: n, lo, hi, cum: cn ? (cs / cn) * sc : null, cn });
    });
    return out;
  }
  const rangeText = (m, p) => (m.opp || p.roll == null ? '' : m.unit === 'pr' ? `± ${f1(p.hi - p.roll)}` : `(95%: ${fmtOf(m)(p.lo)}–${fmtOf(m)(p.hi)})`);
  const oppName = (o) => { const m = /^OpenSage-(\d)ply$/.exec(o || ''); return m ? `Open Sage ${m[1]}-ply` : o || ''; };
  const gameName = (r, long) => (r.type === 'cash' ? (long ? 'cash game' : 'Cash') : long ? `${r.len}-point match, game ${r.match ? r.match.n : ''}` : `${r.len}-pt, game ${r.match ? r.match.n : ''}`);
  // Chooses the chart's figure: from a headline figure (scrolls to the chart) or the chips over it.
  function metric(k, fromTile) {
    TR.view.metric = metricOf(k).k; TR.hover = -1; try { localStorage.setItem('bgplay-pgmetric', TR.view.metric); } catch (e) { /* only for now */ }
    paint();
    if (fromTile) { const h2 = $('pgChartH'); if (h2) h2.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
  }

  // ------------------------------------------------------------- the Progress tab
  const f1 = (x) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(1)), f2 = (x) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(2));
  const pc = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
  const per100 = (a, n) => (n ? ((100 * a) / n).toFixed(1) : '–');
  const sgn = (x, d = 1) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(d);
  const day = (iso, opt) => new Date(iso).toLocaleDateString(undefined, opt || { month: 'short', day: 'numeric' });
  const when = (iso) => { const d = new Date(iso); return `${day(iso)} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`; };
  function all() {
    return [...TR.docs.values()].filter((r) => r && r.v === V).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }
  function filtered() {
    const v = TR.view;
    return all().filter((r) => (v.type === 'all' || r.type === v.type) && (!v.len || r.len === v.len));
  }
  function statusLine() {
    const n = TR.q.reduce((a, x) => a + (x.ids ? x.ids.filter((id) => !tracked(id)).length : 1), 0);
    if (TR.dbErr) return `<span class="bad">The progress records can't be read here: ${esc(TR.dbErr)}</span>`;
    if (n) return `<span class="run">Adding ${plural(n, 'game')} to your progress${ENG.state === 'ready' ? '' : ' (when the engine is free)'}…</span>`;
    const left = all().filter(roPending).length;
    if (left) return `<span class="run">Rolling out your close decisions: ${plural(left, 'game')} to go${RO.cur && RO.cur.n ? ` (this one ${RO.cur.done} of ${RO.cur.n})` : ''}${ENG.state === 'ready' ? '' : ', when the engine is free'}…</span>`;
    if (TR.err) return `<span class="bad">${esc(TR.err)}</span>`;
    return '';
  }
  function open() {
    if (TARGET !== 'tile') return;
    css();
    let ov = $('progOv'); if (!ov) { ov = document.createElement('div'); ov.id = 'progOv'; ov.className = 'pgov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Progress'); document.body.appendChild(ov); }
    ov.classList.add('open'); closeMenu(); paint(); kick();
  }
  function close() { const ov = $('progOv'); if (ov) ov.classList.remove('open'); renderAll(); }
  function setView(k, v) { TR.view[k] = v; if (k === 'type' && v !== 'match') TR.view.len = 0; TR.hover = -1; paint(); }
  const isOpen = () => { const ov = $('progOv'); return !!(ov && ov.classList.contains('open')); };
  // Redraws the tab when it's open (keeping its scroll), else the end-of-game panel's progress line.
  function paint() {
    if (S.ui.menu === 'imported' && typeof renderMenu === 'function') renderMenu();     // a paste's summary: games added
    if (!isOpen()) { if (typeof renderSide === 'function' && S.game && S.game.phase === 'over') renderSide(); return; }
    const ov = $('progOv'), body = ov.querySelector('.pgbody'), top = body ? body.scrollTop : 0;
    ov.innerHTML = page();
    const nb = ov.querySelector('.pgbody'); if (nb) nb.scrollTop = top;
    hookChart();
  }
  function page() {
    const recs = filtered(), v = TR.view, lens = [...new Set(all().filter((r) => r.type === 'match').map((r) => r.len))].sort((a, b) => a - b);
    let h = `<div class="pghead"><div class="title">Progress</div>${btn('✕', 'PG.close()', 'icon', false, 'Close')}</div>`;
    h += '<div class="pgbody"><div class="pgwrap">';
    const st = statusLine(); if (st) h += `<div class="small">${st}</div>`;
    h += `<div class="pgfilters"><div class="seg">${[['all', 'All games'], ['cash', 'Cash'], ['match', 'Match']].map(([k, l]) => `<button class="${v.type === k ? 'on' : ''}" onclick="PG.setView('type','${k}')">${l}</button>`).join('')}</div>`;
    if (v.type === 'match' && lens.length) h += `<div class="seg">${[0, ...lens].map((L) => `<button class="${v.len === L ? 'on' : ''}" onclick="PG.setView('len',${L})">${L ? `${L}-point` : 'All lengths'}</button>`).join('')}</div>`;
    h += '</div>';
    if (!recs.length) {
      h += `<div class="card"><p>${all().length ? 'No games in this selection yet.' : 'No games tracked yet. Every game you finish in BG Play is added here: your PR, the plays you found, the cube, the luck.'}</p></div>`;
      return h + '</div></div>';
    }
    const list = counted(recs), A = agg(list), m = metricOf(v.metric), P = seriesOf(METRICS[0], recs), last = P[P.length - 1];
    const lastCi = last.roll == null ? null : last.hi - last.roll;
    // headline figures: each one is drawn over time below when tapped
    const them = recs.reduce((a, r) => { a.n += (r.them && r.them.n) || 0; a.lost += (r.them && r.them.lost) || 0; return a; }, { n: 0, lost: 0 });
    const tile = (k, cls, lab, val, sub) => `<button class="tile${cls ? ' ' + cls : ''}${m.k === k ? ' sel' : ''}" aria-pressed="${m.k === k}" onclick="PG.metric('${k}', 1)"><span class="lab">${lab}</span><span class="val">${val}</span><span class="sub">${sub}</span></button>`;
    h += '<div class="tiles">';
    h += tile('pr', 'hero', `PR, last ${Math.min(WIN_N, last.rn)} decisions`, f2(last.roll), `± ${f1(lastCi)} (95%) · ${esc(rating(last.roll))}`);
    h += tile('pr', '', `PR, all ${plural(A.n, 'decision')}`, f2(A.pr), `${plural(recs.length, 'game')} · ${esc(rating(A.pr))}`);
    h += tile('prM', '', 'Checker play PR', f2(A.prM), plural(A.nM, 'checker play'));
    h += tile('prC', '', 'Cube PR', f2(A.prC), plural(A.nC, 'cube decision'));
    h += tile('best', '', 'Best moves', pc(A.band.best, A.n), `of ${plural(A.n, 'decision')}`);
    h += tile('crit', '', 'Critical: best found', pc(A.critBest, A.crit), plural(A.crit, 'critical decision'));
    h += tile('err', '', 'Errors per 100', per100(A.band.error, A.n), '0.020 to 0.080');
    h += tile('blu', '', 'Blunders per 100', per100(A.band.blunder, A.n), '0.080 or more');
    h += tile('opp', '', 'Opponent PR', f2(them.n ? (them.lost * 500) / them.n : null), plural(them.n, 'decision'));
    h += '</div>';
    // the chosen figure over time, with its values as a table
    const S2 = seriesOf(m, recs), fmt = fmtOf(m), many = `${m.one}s`;
    const lineName = m.opp ? `Last ${WIN_N} or so decisions (whole games)` : `Last ${m.win} ${many}`;
    h += `<h2 id="pgChartH">${esc(m.name)} over time</h2>`;
    h += `<div class="mchips" role="group" aria-label="The figure to chart">${METRICS.map((x) => `<button class="${x.k === m.k ? 'on' : ''}" aria-pressed="${x.k === m.k}" onclick="PG.metric('${x.k}')">${esc(x.chip)}</button>`).join('')}</div>`;
    h += `<div class="legend"><span><svg class="key" width="12" height="12"><circle cx="6" cy="6" r="4" fill="var(--muted)"/></svg>Each game</span><span><svg class="key" width="18" height="12"><line x1="1" y1="6" x2="17" y2="6" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/></svg>${esc(lineName)}</span>${m.opp ? '' : '<span><svg class="key" width="14" height="12"><rect x="1" y="2" width="12" height="8" rx="2" fill="var(--accent)" opacity=".16"/></svg>95% range</span>'}<span><svg class="key" width="20" height="12"><line x1="1" y1="6" x2="19" y2="6" stroke="var(--ink)" stroke-opacity=".6" stroke-width="1.5" stroke-dasharray="5 3"/></svg>All so far</span>${m.xg ? '<span class="muted">Shading: XG\'s rating bands</span>' : ''}</div>`;
    h += `<div class="chart" id="pgChart" tabindex="0" aria-label="${esc(m.name)} over time: each game, the ${esc(lineName.toLowerCase())} and all games so far. The chart's values are in the table under it."></div>`;
    h += `<details class="vals"${v.vals ? ' open' : ''} ontoggle="PG.vals(this.open)"><summary>The chart's values</summary><div class="tscroll"><table class="pt"><tr><th>Date</th><th>Game</th><th>This game</th><th class="w">${esc(many[0].toUpperCase() + many.slice(1))}</th><th>${esc(m.opp ? 'Last ~500' : `Last ${m.win}`)}</th><th class="w">95% range</th><th>All so far</th></tr>`;
    for (const p of S2.slice().reverse()) h += `<tr><td>${esc(day(p.r.at))}<span class="w"> ${esc(when(p.r.at).split(' ').pop())}</span></td><td>${esc(gameName(p.r))}</td><td>${fmt(p.g)}</td><td class="w">${m.hit && p.gn ? `${p.gh} of ${p.gn}` : p.gn}</td><td>${fmt(p.roll)}</td><td class="w">${esc(rangeText(m, p).replace(/^\(95%: |\)$/g, '')) || '–'}</td><td>${fmt(p.cum)}</td></tr>`;
    h += '</table></div></details>';
    const sdM = m.hit || m.opp ? 0 : sdOf(list.filter(m.pick));
    const notes = {
      pr: `PR = equity lost × 500 / decisions, counted as XG counts them (forced and obvious decisions left out). The 95% range uses the spread of your own errors (${f1(sdM)} per decision).`,
      prM: `Checker play PR: PR over your checker plays alone (XG's level). The 95% range uses the spread of your checker-play errors (${f1(sdM)} per play). XG's rating bands rate a PR over all decisions, so they aren't shaded here.`,
      prC: `Cube PR: PR over your counted cube decisions alone (XG's level); they're rarer, so the line takes your last 100. The 95% range uses the spread of your cube errors (${f1(sdM)} per decision). No rating bands: XG's rate a PR over all decisions.`,
      best: 'Best moves: the share of your counted decisions where you chose the engine\'s best (or shown as 0.000). The 95% range is Wilson\'s interval for a share.',
      crit: 'Critical decisions: those where the second-best choice cost 0.020 or more, so only the best avoided an error; the line takes your last 100. The 95% range is Wilson\'s interval for a share.',
      err: 'Errors: decisions that cost 0.020 to 0.080, per 100 counted decisions. The 95% range is Wilson\'s interval for a share.',
      blu: 'Blunders: decisions that cost 0.080 or more, per 100 counted decisions. The 95% range is Wilson\'s interval for a share.',
      opp: 'Opponent PR: your opponent\'s decisions, counted and scored the same way. Only each game\'s totals are kept for the opponent, so the line takes whole games (about 500 decisions) and has no 95% range.',
    };
    h += `<p class="muted small">${notes[m.k]}</p>`;
    const nRo = recs.filter((r) => r.lvl === 'ro').length;
    h += `<p class="muted small">Your costs: rolled out (Open Sage truncated rollouts, 360 games a play, about XG Roller++) where the decision was close or your play wasn't the best, once a game's rollout is done (${nRo} of ${plural(recs.length, 'game')} so far); otherwise ${ER_PLY}-ply, and turns 1-2 from the XG opening book. The opponent's stay at ${ER_PLY}-ply.</p>`;
    // monthly
    const months = new Map(); for (const r of recs) { const k = r.at.slice(0, 7); if (!months.has(k)) months.set(k, []); months.get(k).push(r); }
    h += `<h2>By month</h2><div class="tscroll"><table class="pt"><tr><th>Month</th><th class="w">Games</th><th class="w">Decisions</th><th>PR</th><th>Checker</th><th>Cube</th><th>Errors /100</th><th>Blunders /100</th><th>Best</th></tr>`;
    for (const [k, rs] of [...months.entries()].reverse()) {
      const a = agg(counted(rs)), d = new Date(k + '-15');
      h += `<tr><td>${esc(d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }))}</td><td class="w">${rs.length}</td><td class="w">${a.n}</td><td>${f2(a.pr)}</td><td>${f2(a.prM)}</td><td>${f2(a.prC)}</td><td>${per100(a.band.error, a.n)}</td><td>${per100(a.band.blunder, a.n)}</td><td>${pc(a.band.best, a.n)}</td></tr>`;
    }
    h += '</table></div>';
    // splits
    const rows = [['All', list], ['Checker plays', list.filter((d) => d.k === 'M')], ['Cube decisions', list.filter((d) => d.k !== 'M')]];
    if (v.type === 'all') rows.push(['Cash games', counted(recs.filter((r) => r.type === 'cash'))], ['Matches', counted(recs.filter((r) => r.type === 'match'))]);
    if (v.type !== 'cash' && !v.len) for (const L of [...new Set(recs.filter((r) => r.type === 'match').map((r) => r.len))].sort((a, b) => a - b)) rows.push([`${L}-point matches`, counted(recs.filter((r) => r.type === 'match' && r.len === L))]);
    h += `<h2>Splits</h2><div class="tscroll"><table class="pt"><tr><th></th><th class="w">Decisions</th><th>PR</th><th>from blunders</th><th>from errors</th><th>from smaller</th><th class="w">Errors /100</th><th class="w">Blunders /100</th><th>Best</th><th class="w">Critical best</th></tr>`;
    for (const [name, ds] of rows) {
      const a = agg(ds), pp = (x) => (a.n ? f2((x * 500) / a.n) : '–');
      h += `<tr><td>${esc(name)}</td><td class="w">${a.n}</td><td>${f2(a.pr)}</td><td>${pp(a.part.blunder)}</td><td>${pp(a.part.error)}</td><td>${pp(a.part.close)}</td><td class="w">${per100(a.band.error, a.n)}</td><td class="w">${per100(a.band.blunder, a.n)}</td><td>${pc(a.band.best, a.n)}</td><td class="w">${a.crit ? `${pc(a.critBest, a.crit)} of ${a.crit}` : '–'}</td></tr>`;
    }
    h += `</table></div><p class="muted small">Checker and cube PR are each over their own decisions (XG's levels); the three \"from\" columns add up to the row's PR. Critical: the decisions where the second-best choice cost 0.020 or more, so only the best one avoided an error.</p>`;
    // position types
    const byType = new Map(); for (const d of list) { const k = d.pt || 'middle'; if (!byType.has(k)) byType.set(k, []); byType.get(k).push(d); }
    h += `<h2>By position type</h2><div class="legend">${['best', 'close', 'error', 'blunder'].map((b) => `<span><svg class="key" width="12" height="12"><rect x="1" y="1" width="10" height="10" rx="2" fill="${COL[b]}"/></svg>${BAND_NAMES[b]}</span>`).join('')}</div>`;
    h += `<div class="tscroll"><table class="pt types"><tr><th>Position type · decisions</th><th>PR</th><th>Best</th><th>Critical best</th></tr>`;
    for (const [k, name] of TYPES) {
      const ds = byType.get(k); if (!ds || !ds.length) continue;
      const a = agg(ds), seg = ['best', 'close', 'error', 'blunder'].filter((b) => a.band[b]).map((b) => `<i style="flex:${a.band[b]};background:${COL[b]}" title="${BAND_NAMES[b]}: ${a.band[b]} (${pc(a.band[b], a.n)})"></i>`).join('');
      h += `<tr><td class="tname"><div>${esc(name)} <span class="muted">· ${a.n}</span></div><span class="seg8" role="img" aria-label="best ${a.band.best}, close ${a.band.close}, errors ${a.band.error}, blunders ${a.band.blunder}">${seg}</span></td><td>${f2(a.pr)}</td><td>${pc(a.band.best, a.n)}</td><td>${a.crit ? `${pc(a.critBest, a.crit)}<span class="w"> of ${a.crit}</span>` : '–'}</td></tr>`;
    }
    h += `</table></div><p class="muted small">Each position gets the first type that fits, in this order (each yours, then theirs): opening (turns 1-4); race and bear-off (no contact); blitz (3+ home points against a checker on the bar or 2+ blots in that board, with no anchor there); back game (2+ points in the other home board and 30+ pips behind); bearing in (no checker beyond the 12 point, with contact); prime vs prime, then a prime (4+ points in a row with a checker behind it); holding game (an anchor on the other side's 4, 5, 6 or bar point, behind in the race); else other middle game.</p>`;
    // cube errors
    const cube = list.filter((d) => d.k !== 'M'), kinds = new Map();
    for (const d of counted(recs).filter((x) => x.ck)) { const e = kinds.get(d.ck) || { n: 0, err: 0, lost: 0 }; e.n++; if (r3(d.c) >= CRIT) e.err++; e.lost += d.c; kinds.set(d.ck, e); }
    h += `<h2>Cube</h2>`;
    if (!cube.length) h += '<p class="muted">No counted cube decisions in this selection.</p>';
    else {
      h += `<div class="tscroll"><table class="pt"><tr><th>Kind</th><th>Times</th><th>0.020 or more</th><th class="w">Equity lost</th><th>PR points</th></tr>`;
      for (const [k, name] of KINDS) { const e = kinds.get(k); if (!e) continue; h += `<tr><td class="wrap">${esc(name)}</td><td>${e.n}</td><td>${e.err}</td><td class="w">${e.lost.toFixed(3)}</td><td>${f2((e.lost * 500) / A.n)}</td></tr>`; }
      if (!kinds.size) h += `<tr><td colspan="5" class="muted" style="text-align:left">No cube errors: ${plural(cube.length, 'counted cube decision')}, all right.</td></tr>`;
      h += `</table></div><p class="muted small">Near the doubling point: the best action's equity under 0.95; near too good: 0.95 or more (GNU Backgammon's split). PR points: each kind's share of the PR above (over all ${A.n} decisions).</p>`;
    }
    // luck
    const lk = recs.reduce((a, r) => { const L = r.luck || {}; a.you += L.you || 0; a.them += L.them || 0; a.ry += (L.rolls || [0])[0] || 0; a.rt += (L.rolls || [0, 0])[1] || 0;
      a.jy += (L.jokers || [0])[0] || 0; a.jt += (L.jokers || [0, 0])[1] || 0; a.ay += (L.anti || [0])[0] || 0; a.at += (L.anti || [0, 0])[1] || 0; return a; }, { you: 0, them: 0, ry: 0, rt: 0, jy: 0, jt: 0, ay: 0, at: 0 });
    const cashR = recs.filter((r) => r.type === 'cash' && r.lar != null), won = cashR.reduce((a, r) => a + r.res.pts, 0), lar = cashR.reduce((a, r) => a + r.lar, 0);
    h += `<h2>Luck</h2><div class="tscroll"><table class="pt"><tr><th></th><th class="w">Rolls</th><th>Luck per roll</th><th>XG's word for it</th><th>Jokers</th><th>Anti-jokers</th></tr>`;
    h += `<tr><td>You</td><td class="w">${lk.ry}</td><td>${lk.ry ? sgn(lk.you / lk.ry, 3) : '–'}</td><td>${esc(luckLabel(lk.ry ? lk.you / lk.ry : null))}</td><td>${lk.jy}</td><td>${lk.ay}</td></tr>`;
    h += `<tr><td>Opponents</td><td class="w">${lk.rt}</td><td>${lk.rt ? sgn(lk.them / lk.rt, 3) : '–'}</td><td>${esc(luckLabel(lk.rt ? lk.them / lk.rt : null))}</td><td>${lk.jt}</td><td>${lk.at}</td></tr></table></div>`;
    if (cashR.length) h += `<p class="small">Cash games: ${sgn(won, 0)} ${Math.abs(won) === 1 ? 'point' : 'points'} in ${plural(cashR.length, 'game')}; luck-adjusted, ${sgn(lar, 1)}. The luck-adjusted result takes the dice out: the points won minus the net luck in points (your luck minus your opponent's, at each roll's cube).</p>`;
    h += `<p class="muted small">Luck of a roll: the equity after it with the best play minus the equity before it, at 1-ply (XG's definition); a joker gains more than 0.300, an anti-joker loses more than 0.300. Opening rolls are left out.</p>`;
    // games: the chart's table
    h += `<h2>Games</h2><div class="tscroll"><table class="pt games"><tr><th>Date</th><th class="w">Opponent</th><th>Game</th><th>Result</th><th>PR</th><th class="w">Last 500</th><th class="w">Opponent PR</th><th class="w">Luck</th><th class="w">Decisions</th><th></th></tr>`;
    for (const s of S2.slice().reverse()) {
      const r = s.r, L = r.luck || {}, net = (L.youPts || 0) - (L.themPts || 0);
      const game = r.type === 'cash' ? 'Cash' : `${r.len}-pt, game ${r.match ? r.match.n : ''}`;
      h += `<tr><td>${esc(day(r.at))}<span class="w"> ${esc(when(r.at).split(' ').pop())}</span></td><td class="w">${esc(oppName(r.opp))}</td><td>${esc(game)}</td><td>${sgn(r.res ? r.res.pts : 0, 0)}</td><td>${f2(s.pr)}</td><td class="w">${f2(s.roll)}</td><td class="w">${f2(r.them && r.them.n ? (r.them.lost * 500) / r.them.n : null)}</td><td class="w">${sgn(net, 2)}</td><td class="w">${s.gn}</td><td>${btn('Review', `PG.review(${esc(JSON.stringify(r.id))})`, 'small')}</td></tr>`;
    }
    h += `</table></div><p class="muted small">Luck: your net luck in the game, in points (your luck minus your opponent's, at each roll's cube). Turn the phone sideways for every column.</p>`;
    return h + '</div></div>';
  }
  // The trend chart of the chosen figure: a dot per game, the rolling window as a line with its 95% range, all games
  // so far dashed, and for PR XG's rating bands shaded behind. Crosshair and tooltip; arrow keys step through games.
  function hookChart() {
    const el = $('pgChart'); if (!el) return;
    const m = metricOf(TR.view.metric), recs = filtered(), S2 = seriesOf(m, recs), fmt = fmtOf(m);
    if (!S2.some((p) => p.g != null || p.roll != null)) { el.innerHTML = `<p class="muted small" style="margin:8px">No counted ${esc(m.one)}s in this selection yet.</p>`; el.onkeydown = el.onfocus = el.onblur = null; return; }
    const W = Math.max(280, el.clientWidth - 12), H = Math.max(190, Math.min(300, Math.round(W * 0.42)));
    const ml = 34, mr = m.xg ? 82 : 14, mt = 10, mb = 24, pw = W - ml - mr, ph = H - mt - mb;
    const qt = (xs, f) => { const a = xs.filter((z) => z != null && Number.isFinite(z)).sort((p, q) => p - q); return a.length ? a[Math.floor(f * (a.length - 1))] : null; };
    // the scale: PR and rates from 0 to a round top over 90% of what's drawn; shares up to 100% from a round floor
    let bot = 0, top, ticks = [];
    if (m.unit === 'pct') {
      top = 100; const low = qt(S2.flatMap((p) => [p.g, p.lo]), 0.1);
      bot = Math.max(0, Math.min(60, Math.floor(((low == null ? 0 : low) - 2) / 10) * 10));
      let step = 10; if (top - bot > 50) { step = 20; bot = Math.floor(bot / 20) * 20; }
      for (let t = bot; t <= top; t += step) ticks.push(t);
    } else {
      const want = qt(S2.flatMap((p) => [p.g, p.hi != null ? p.hi : p.roll]), 0.9) || 0;
      const ladder = m.xg ? [7.5, 12.5, 17.5, 22.5, 30, 40, 60] : m.unit === 'per' ? [2, 5, 10, 15, 20, 30, 40, 60, 100] : [5, 10, 15, 20, 30, 40, 60];
      top = ladder.find((t) => t >= want) || ladder[ladder.length - 1];
      if (!m.xg) { const step = top <= 2 ? 0.5 : top <= 5 ? 1 : top <= 10 ? 2 : top <= 20 ? 5 : top <= 40 ? 10 : 20; for (let t = 0; t <= top + 1e-9; t += step) ticks.push(Math.round(t * 10) / 10); }
    }
    const x = (i) => ml + (S2.length === 1 ? pw / 2 : (i / (S2.length - 1)) * pw), y = (v) => mt + ph - ((Math.min(Math.max(v, bot), top) - bot) / (top - bot)) * ph;
    const lab = (t) => (m.unit === 'pct' ? `${t}%` : String(t));
    let s = '';
    if (m.xg) {
      RATINGS.forEach(([a, b, name], i) => {
        if (a >= top) return; const b2 = Math.min(b, top);
        if (i % 2) s += `<rect x="${ml}" y="${y(b2)}" width="${pw}" height="${y(a) - y(b2)}" fill="var(--pgband)"/>`;
        s += `<text x="${ml + pw + 6}" y="${(y(a) + y(b2)) / 2 + 3.5}" font-size="10.5" fill="var(--muted)">${esc(name)}</text>`;
        s += `<line x1="${ml}" x2="${ml + pw}" y1="${y(a)}" y2="${y(a)}" stroke="var(--line)" stroke-width="1"/><text x="${ml - 5}" y="${y(a) + 3.5}" font-size="10.5" text-anchor="end" fill="var(--muted)">${a}</text>`;
      });
      s += `<text x="${ml - 5}" y="${y(top) + 3.5}" font-size="10.5" text-anchor="end" fill="var(--muted)">${top}</text>`;
    } else for (const t of ticks) s += `<line x1="${ml}" x2="${ml + pw}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" stroke-width="1"/><text x="${ml - 5}" y="${y(t) + 3.5}" font-size="10.5" text-anchor="end" fill="var(--muted)">${lab(t)}</text>`;
    const R2 = S2.filter((p) => p.roll != null), C2 = S2.filter((p) => p.cum != null);
    if (R2.length && !m.opp) {
      const up = R2.map((p) => `${x(p.i)},${y(p.hi)}`), dn = R2.slice().reverse().map((p) => `${x(p.i)},${y(p.lo)}`);
      s += `<polygon points="${up.concat(dn).join(' ')}" fill="var(--accent)" opacity=".14"/>`;
    }
    if (C2.length > 1) s += `<polyline points="${C2.map((p) => `${x(p.i)},${y(p.cum)}`).join(' ')}" fill="none" stroke="var(--ink)" stroke-opacity=".6" stroke-width="1.5" stroke-dasharray="5 4" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (R2.length) s += R2.length > 1 ? `<polyline points="${R2.map((p) => `${x(p.i)},${y(p.roll)}`).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : `<circle cx="${x(R2[0].i)}" cy="${y(R2[0].roll)}" r="3" fill="var(--accent)"/>`;
    for (const p of S2) if (p.g != null) {     // off the scale: a triangle at the edge, pointing the way it went
      const X = x(p.i);
      if (p.g > top) s += `<path d="M${X - 4},${y(top) + 6} L${X + 4},${y(top) + 6} L${X},${y(top)} z" fill="var(--muted)" stroke="var(--panel)" stroke-width="1.5"/>`;
      else if (p.g < bot) s += `<path d="M${X - 4},${y(bot) - 6} L${X + 4},${y(bot) - 6} L${X},${y(bot)} z" fill="var(--muted)" stroke="var(--panel)" stroke-width="1.5"/>`;
      else s += `<circle cx="${X}" cy="${y(p.g)}" r="4" fill="var(--muted)" stroke="var(--panel)" stroke-width="2"/>`;
    }
    // dates along the bottom: up to 5, evenly spread
    const nL = Math.min(5, S2.length), idx = [...new Set(Array.from({ length: nL }, (_, k) => Math.round((k * (S2.length - 1)) / Math.max(1, nL - 1))))];
    for (const i of idx) s += `<text x="${x(i)}" y="${H - 6}" font-size="10.5" text-anchor="${i === 0 && S2.length > 1 ? 'start' : i === S2.length - 1 && S2.length > 1 ? 'end' : 'middle'}" fill="var(--muted)">${esc(day(S2[i].r.at))}</text>`;
    s += `<g id="pgHov"></g><rect id="pgHit" x="${ml}" y="${mt}" width="${pw}" height="${ph}" fill="transparent"/>`;
    el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-hidden="true">${s}</svg><div class="tip" id="pgTip"></div>`;
    const svg = el.querySelector('svg'), hov = el.querySelector('#pgHov'), tip = el.querySelector('#pgTip');
    const inR = (v) => v != null && v >= bot && v <= top;
    const show = (i) => {
      TR.hover = i; if (i < 0 || !S2[i]) { hov.innerHTML = ''; tip.style.display = 'none'; return; }
      const p = S2[i], r = p.r, X = x(i);
      hov.innerHTML = `<line x1="${X}" x2="${X}" y1="${mt}" y2="${mt + ph}" stroke="var(--muted)" stroke-width="1"/>${inR(p.cum) ? `<circle cx="${X}" cy="${y(p.cum)}" r="3.5" fill="var(--panel)" stroke="var(--ink)" stroke-width="1.5"/>` : ''}${p.roll != null ? `<circle cx="${X}" cy="${y(p.roll)}" r="4.5" fill="var(--accent)" stroke="var(--panel)" stroke-width="2"/>` : ''}${inR(p.g) ? `<circle cx="${X}" cy="${y(p.g)}" r="5.5" fill="var(--ink)" stroke="var(--panel)" stroke-width="2"/>` : ''}`;
      const cnt = !p.gn ? `no ${m.one}s` : m.hit ? `${p.gh} of ${plural(p.gn, m.one)}` : plural(p.gn, m.one);
      tip.innerHTML = `<div class="muted">${esc(when(r.at))} · ${esc(gameName(r, true))} vs ${esc(oppName(r.opp))} · ${sgn(r.res ? r.res.pts : 0, 0)}</div>`
        + `<div><b>${fmt(p.g)}</b> this game <span class="muted">(${esc(cnt)})</span></div>`
        + `<div><b>${fmt(p.roll)}</b> ${esc(rangeText(m, p))} last ${p.rn}${m.opp ? ' (whole games)' : ''} <span class="muted">${m.xg ? esc(rating(p.roll)) : ''}</span></div>`
        + `<div><b>${fmt(p.cum)}</b> all so far <span class="muted">(${plural(p.cn, m.one)})</span></div>`;
      tip.style.display = 'block';
      const tw = tip.offsetWidth, left = Math.min(Math.max(6, X + 12), el.clientWidth - tw - 6);
      tip.style.left = `${X + 12 + tw > el.clientWidth - 6 ? Math.max(6, X - tw - 12) : left}px`; tip.style.top = '8px';
    };
    const near = (ev) => { const b = svg.getBoundingClientRect(), px = ev.clientX - b.left; let best = 0, bd = Infinity; S2.forEach((p) => { const d = Math.abs(x(p.i) - px); if (d < bd) { bd = d; best = p.i; } }); return best; };
    svg.addEventListener('pointermove', (ev) => show(near(ev)));
    svg.addEventListener('pointerdown', (ev) => show(near(ev)));
    svg.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') show(-1); });
    el.onkeydown = (ev) => {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); const i = TR.hover < 0 ? S2.length - 1 : Math.max(0, Math.min(S2.length - 1, TR.hover + (ev.key === 'ArrowRight' ? 1 : -1))); show(i); }
      else if (ev.key === 'Escape') show(-1);
    };
    el.onfocus = () => { if (TR.hover < 0) show(S2.length - 1); };
    el.onblur = () => show(-1);
    if (TR.hover >= 0) show(Math.min(TR.hover, S2.length - 1));
  }
  // A tracked game in the review (the analyzer's display), from its record: the game replayed, your costs as scored.
  async function review(id) {
    const r = TR.docs.get(id); if (!r || !r.ev) return;
    if (!ENG.weights || !ENG.pool) return toast('The engine is still loading');
    let games; try { const ev = typeof r.ev.events === 'string' ? JSON.parse(r.ev.events) : r.ev.events; games = R.replayGames({ games: [{ n: r.ev.n || 1, score: r.ev.score, crawford: r.ev.crawford, events: ev }] }, r.rules); } catch (e) { return toast('This game can\'t be reviewed: ' + (e.message || e), 4000); }
    const n = games[0].n, costs = costMap((r.decs || []).map((d) => ({ g: n, t: d.t, k: d.k, c: d.c, n: d.n, b: d.b })));
    const opp = r.opp && !/^OpenSage-/.test(r.opp) ? r.opp : 'Open Sage';
    const items = reviewItems(games, costs, opp); if (!items.length) return toast('Nothing to review in this game');
    await showReview(items, `Review: ${r.type === 'cash' ? 'cash game' : `${r.len}-point match, game ${n}`} vs ${opp}, ${when(r.at)}`, undefined, opp);
  }
  // The end-of-game panel's words on this game's progress record (tile).
  function endState(gm, M0) {
    if (TARGET !== 'tile') return '';
    const M = M0 || S.match, id = recIdOf(gm, M), r = TR.docs.get(id);
    if (r && r.lvl === 'ro') return 'Added to your progress, rolled out.';
    return tracked(id) ? 'Added to your progress at 4-ply; rolled out next.' : gm.er ? 'Adding to your progress…' : 'Added to your progress once your ER is ready.';
  }
  let cssDone = false;
  function css() {
    if (cssDone) return; cssDone = true;
    const st = document.createElement('style');
    st.textContent = `
  .pgov { position: fixed; inset: 0; z-index: 20; background: var(--bg); color: var(--ink); display: none; flex-direction: column; --pgband: rgba(127,127,127,.08); }
  .pgov.open { display: flex; }
  .pgov .pghead { display: flex; align-items: center; gap: 8px; padding: max(6px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) 6px max(10px, env(safe-area-inset-left)); border-bottom: 1px solid var(--line); }
  .pgov .pghead .title { flex: 1; font-size: 17px; font-weight: 650; }
  .pgov .pgbody { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 10px max(10px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left)); }
  .pgov .pgwrap { max-width: 1000px; margin: 0 auto; display: flex; flex-direction: column; gap: 10px; }
  .pgov h2 { font-size: 15px; margin: 10px 0 0; }
  .pgov .pgfilters { display: flex; flex-wrap: wrap; gap: 8px; }
  .pgov .pgfilters .seg button { flex: 0 0 auto; white-space: nowrap; min-height: 34px; padding: 0 12px; font-size: 13.5px; }
  .pgov .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .pgov .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; align-items: flex-start; text-align: left; min-height: 0; white-space: normal; font: inherit; color: var(--ink); cursor: pointer; }
  .pgov .tile.sel { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .pgov .tile .lab { font-size: 12px; color: var(--muted); }
  .pgov .tile .val { font-size: 24px; font-weight: 650; line-height: 1.25; }
  .pgov .tile.hero .val { font-size: 48px; line-height: 1.1; }
  .pgov .tile .sub { font-size: 12px; color: var(--muted); }
  .pgov .mchips { display: flex; flex-wrap: wrap; gap: 6px; }
  .pgov .mchips button { min-height: 34px; padding: 0 11px; font-size: 13px; border-radius: 17px; }
  .pgov details.vals summary { cursor: pointer; font-size: 13px; color: var(--accent); padding: 2px 0; }
  .pgov details.vals[open] summary { margin-bottom: 6px; }
  .pgov details.vals .tscroll { max-height: 340px; overflow-y: auto; }
  .pgov .tscroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .pgov table.pt { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
  .pgov table.pt th { text-align: right; font-weight: 600; color: var(--muted); font-size: 11.5px; padding: 4px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  .pgov table.pt td { text-align: right; padding: 5px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  .pgov table.pt td:first-child, .pgov table.pt th:first-child { text-align: left; }
  .pgov table.pt td.tname { white-space: normal; width: 60%; }
  .pgov table.pt td.tname .seg8 { margin-top: 5px; max-width: 360px; }
  .pgov table.pt td.wrap { white-space: normal; }
  @media (max-width: 560px) { .pgov .w { display: none; } .pgov table.pt th { white-space: normal; vertical-align: bottom; } .pgov table.pt td, .pgov table.pt th { padding-left: 4px; padding-right: 4px; } }
  .pgov table.games button { min-height: 28px; padding: 0 8px; font-size: 12.5px; }
  .pgov .seg8 { display: flex; gap: 2px; height: 8px; border-radius: 4px; overflow: hidden; }
  .pgov .seg8 i { display: block; min-width: 2px; }
  .pgov .chart { position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 6px; outline-offset: 2px; touch-action: pan-y; }
  .pgov .chart svg { display: block; }
  .pgov .tip { position: absolute; pointer-events: none; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; font-size: 12px; line-height: 1.45; box-shadow: 0 2px 10px rgba(0,0,0,.18); display: none; white-space: nowrap; z-index: 2; }
  .pgov .tip b { font-size: 13px; }
  .pgov .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--ink); align-items: center; }
  .pgov .legend .key { vertical-align: -1px; margin-right: 5px; }
  .pgov .card p { margin: 4px 0; }
  .pgov .run { color: var(--accent); }`;
    document.head.appendChild(st);
  }
  function init() {
    load();
    if (TARGET !== 'tile') return;
    setInterval(() => { if (!TR.busy && TR.q.length) kick(); else roKick(); if (TR.out.length) flush(); if (ENG.pool) ENG.pool.pump(); }, 15000);
    let rz = 0; window.addEventListener('resize', () => { if (!isOpen()) return; cancelAnimationFrame(rz); rz = requestAnimationFrame(hookChart); });   // turning the phone: the chart takes the new width
  }
  window.PG = { init, setDb, kick, gameOver, keepMatch, enqueueFile, scan, open, close, setView, metric, vals: (o) => { TR.view.vals = !!o; }, review, endState, isTracked: tracked, posType, TYPES, KINDS, COL, METRICS,
    recOf, costsFor, erOf, _state: TR, _ro: RO, _roWants: roWants, _roKick: roKick, _agg: agg, _series: seriesOf, _metricOf: metricOf, _record: record, _fileGames: fileGames };
})();
