#!/usr/bin/env node
/*
 * AI Team Formation - load and edge-case test
 *
 * Simulates a full event against the backend: a burst of phones joining, the quiz,
 * team formation, rapid reshuffles, late joiners, phones dropping and reconnecting,
 * facilitator overrides, bad input, and resets.
 *
 * WARNING: this RESETS the live session (start and end). Never run it during an event.
 *
 * Usage (PowerShell, from the repo root):
 *   node loadtest.js                                         # local backend, rooms of 30, 50, 100 and 200
 *   node loadtest.js --url https://YOUR-BACKEND.onrender.com --yes
 *   node loadtest.js --url https://YOUR-BACKEND.onrender.com --sizes 40,150,500 --yes
 *   node loadtest.js --url https://YOUR-BACKEND.onrender.com --users 300 --teams 25 --yes
 *
 * Room size is not capped anywhere. If --teams is left out, each room gets about one
 * team per 10 people (between 2 and 40).
 *
 * No install needed: it borrows socket.io-client from frontend/node_modules.
 */
const path = require('path');

/* ---------- setup ---------- */

function loadIo() {
  const tries = [
    'socket.io-client',
    path.join(__dirname, 'frontend', 'node_modules', 'socket.io-client'),
    path.join(__dirname, 'backend', 'node_modules', 'socket.io-client'),
  ];
  for (const t of tries) {
    try {
      return require(t).io;
    } catch (e) {
      /* try next */
    }
  }
  console.error('socket.io-client not found. Run this first:  cd frontend; npm install; cd ..');
  process.exit(1);
}
const io = loadIo();

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const URL = (arg('url', process.env.BACKEND_URL || 'http://localhost:4000') || '').replace(/\/+$/, '');
const SIZES = (arg('users', null) ? [arg('users')] : (arg('sizes', '30,50,100,200') || '').split(','))
  .map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n >= 10);
const FIXED_TEAMS = arg('teams', null) ? Math.max(2, parseInt(arg('teams'), 10) || 2) : null;
const teamsFor = (users) => FIXED_TEAMS || Math.min(40, Math.max(2, Math.round(users / 10)));
let USERS = 0;
let TEAMS = 0;
const RESHUFFLES = 10;
const BATCH = 25;
const isLocal = /localhost|127\.0\.0\.1/.test(URL);

if (!isLocal && !process.argv.includes('--yes')) {
  console.log(`\nThis will RESET the live session on ${URL}.`);
  console.log('Add --yes to confirm, e.g.:  node loadtest.js --url ' + URL + ' --yes\n');
  process.exit(1);
}

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? C.g + 'PASS' : C.r + 'FAIL'}${C.x} ${name}${detail ? C.d + '  ' + detail + C.x : ''}`);
  return ok;
}
const section = (t) => console.log(`\n${C.b}${C.c}${t}${C.x}`);
const info = (t) => console.log(`  ${C.d}${t}${C.x}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function stats(arr) {
  if (!arr.length) return 'n/a';
  const s = arr.slice().sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return `p50 ${p(0.5)}ms, p95 ${p(0.95)}ms, max ${s[s.length - 1]}ms`;
}

function connect(role) {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 20000, query: { role } });
    const t = setTimeout(() => reject(new Error('connect timeout')), 25000);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}

function once(s, ev, ms = 20000, pred = () => true) {
  return new Promise((resolve, reject) => {
    const h = (d) => {
      if (!pred(d)) return;
      clearTimeout(t);
      s.off(ev, h);
      resolve(d);
    };
    const t = setTimeout(() => { s.off(ev, h); reject(new Error(`timeout waiting for ${ev}`)); }, ms);
    s.on(ev, h);
  });
}

async function health() {
  try {
    const res = await fetch(`${URL}/health`);
    return res.ok && (await res.text()).trim() === 'ok';
  } catch (e) {
    return false;
  }
}

/* ---------- realistic answers (skewed, like a real room) ---------- */

const OPTION_COUNTS = [4, 2, 4, 6, 5, 6, 5, 4];
const WEIGHTS = [1.5, 1, 1.5, 2, 0.5, 1, 0.5, 0.25];
const SKEW = [
  [0.3, 0.3, 0.25, 0.15], [0.4, 0.6], [0.15, 0.35, 0.35, 0.15], [0.55, 0.2, 0.12, 0.05, 0.03, 0.05],
  [0.55, 0.15, 0.15, 0.05, 0.1], [0.15, 0.1, 0.1, 0.1, 0.35, 0.2], [0.3, 0.2, 0.2, 0.1, 0.2], [0.1, 0.4, 0.3, 0.2],
];
const pickSkewed = (w) => { let r = Math.random(), c = 0; for (let i = 0; i < w.length; i++) { c += w[i]; if (r < c) return i; } return w.length - 1; };
const FIRST = ['Ayesha', 'Bilal', 'Sara', 'Hamza', 'Zainab', 'Usman', 'Fatima', 'Ali', 'Hira', 'Omar', 'Mahnoor', 'Saad', 'Areeba', 'Danish', 'Maryam', 'Hassan'];

function pairSim(a, b) {
  let s = 0;
  for (let q = 0; q < 8; q++) if (a[q] === b[q]) s += WEIGHTS[q];
  return s;
}
function withinTeamSim(groups) {
  let s = 0;
  for (const g of groups) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) s += pairSim(g[i], g[j]);
  return s;
}

/* ---------- invariants on a team state ---------- */

function teamInvariants(state, label, { expectTeams, strictSizes = true } = {}) {
  const ids = Object.keys(state.participants);
  const seen = new Map();
  for (const t of state.teams) for (const id of t.memberIds) seen.set(id, (seen.get(id) || 0) + 1);
  const everyoneOnce = ids.every((id) => seen.get(id) === 1) && seen.size === ids.length;
  const idsMatch = ids.every((id) => {
    const t = state.teams.find((tt) => tt.id === state.participants[id].teamId);
    return t && t.memberIds.includes(id);
  });
  const sizes = state.teams.map((t) => t.memberIds.length);
  const spread = Math.max(...sizes) - Math.min(...sizes);
  const women = ids.filter((id) => state.participants[id].gender === 'female').length;
  const womenPerTeam = state.teams.map((t) => t.memberIds.filter((id) => state.participants[id]?.gender === 'female').length);
  const womenOk = women >= state.teams.length ? womenPerTeam.every((w) => w >= 1) : womenPerTeam.every((w) => w <= 1);
  const coloursOk = state.teams.every((t) => /^#[0-9a-f]{6}$/i.test(t.colour));

  let ok = true;
  if (expectTeams != null) ok = check(`${label}: ${expectTeams} teams created`, state.teams.length === expectTeams, `got ${state.teams.length}`) && ok;
  ok = check(`${label}: every person is in exactly one team`, everyoneOnce && idsMatch) && ok;
  if (strictSizes) ok = check(`${label}: team sizes within 1 of each other`, spread <= 1, `sizes ${Math.min(...sizes)}-${Math.max(...sizes)}`) && ok;
  ok = check(`${label}: women spread across teams`, womenOk, `women per team ${womenPerTeam.join(',')}`) && ok;
  ok = check(`${label}: team colours are valid hex`, coloursOk) && ok;
  return ok;
}

// Phones receive messages in order, so a slow connection only delays them.
// Wait until every phone shows the team the server has, and report how long it took.
async function phonesCatchUp(list, state, timeoutMs = 30000) {
  const start = Date.now();
  const matches = () => list.filter((p) => p.sock && p.sock.connected && state.participants[p.id])
    .every((p) => p.teamId === state.participants[p.id].teamId);
  while (!matches() && Date.now() - start < timeoutMs) await wait(100);
  const ok = matches();
  const behind = list.filter((p) => state.participants[p.id] && p.teamId !== state.participants[p.id].teamId).length;
  return { ok, detail: ok ? `caught up in ${Date.now() - start}ms` : `${behind} phones still behind after ${timeoutMs / 1000}s` };
}

/* ---------- main ---------- */

async function runSuite() {
  console.log(`\n${C.b}=== Room of ${USERS} people, ${TEAMS} teams ===${C.x}`);
  console.log(`${C.d}Backend ${URL} | ${USERS} phones | ${TEAMS} teams | ${RESHUFFLES} reshuffles${C.x}`);
  const t0 = Date.now();
  const startCount = results.length;

  section('1. Server reachable');
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    up = await health();
    if (!up) { if (i === 0) info('Waiting for the server to wake up...'); await wait(2000); }
  }
  if (!check('GET /health responds ok', up)) {
    console.log(`\n${C.r}Cannot reach ${URL}. Check the URL and that the backend is deployed.${C.x}`);
    process.exit(1);
  }

  const fac = await connect('facilitator');
  fac.emit('hello', { role: 'facilitator' });
  await once(fac, 'state_sync');
  const getState = async () => { const p = once(fac, 'state_sync'); fac.emit('request_sync'); return p; };
  const resetAll = async () => { const p = once(fac, 'state_sync', 20000, (s) => Object.keys(s.participants).length === 0); fac.emit('facilitator_reset'); return p; };
  await resetAll();
  check('Starting from a clean reset', true);

  /* ----- bad input ----- */
  section('2. Bad input is rejected, server survives garbage');
  {
    const s = await connect('phone');
    const expectError = async (payload, label) => {
      const p = once(s, 'join_error', 8000).then(() => true).catch(() => false);
      s.emit('join', payload);
      check(label, await p);
    };
    await expectError({ id: 'bad_1', name: '', gender: 'male' }, 'Empty name rejected');
    await expectError({ id: 'bad_2', name: '     ', gender: 'male' }, 'Whitespace-only name rejected');
    await expectError({ id: 'bad_3', name: 'Ali K' }, 'Missing gender rejected');
    await expectError({ id: 'bad_4', name: 'Ali K', gender: 'other' }, 'Invalid gender rejected');
    await expectError({ name: 'Ali K', gender: 'male' }, 'Missing participant id rejected');
    await expectError(null, 'Null join payload rejected');

    const longJoin = once(s, 'joined', 8000);
    s.emit('join', { id: 'long_1', name: 'A'.repeat(60), gender: 'male' });
    const j = await longJoin.catch(() => null);
    check('Very long name is trimmed to 20 characters', !!j && j.name.length === 20, j ? `${j.name.length} chars` : 'no reply');

    // garbage that must not crash the server
    for (const ev of ['identify', 'submit_answer', 'facilitator_move_participant', 'facilitator_delete_participant', 'facilitator_set_team_count', 'facilitator_make_teams']) {
      s.emit(ev, null); s.emit(ev, 'x'); s.emit(ev, { participantId: { $ne: 1 }, questionIndex: 'a', optionIndex: [], count: 'abc' });
    }
    s.emit('submit_answer', { participantId: 'long_1', questionIndex: 99, optionIndex: 0 });
    s.emit('submit_answer', { participantId: 'long_1', questionIndex: 0, optionIndex: 99 });
    s.emit('submit_answer', { participantId: 'long_1', questionIndex: -1, optionIndex: 0 });
    s.emit('submit_answer', { participantId: 'nobody', questionIndex: 0, optionIndex: 0 });
    await wait(800);
    check('Server still healthy after garbage payloads', await health());
    const st = await getState();
    check('Invalid answers were ignored', st.answers.length === 0, `${st.answers.length} stored`);
    s.close();
    await resetAll();
  }

  /* ----- burst join ----- */
  section(`3. ${USERS} phones join in a burst`);
  const phones = [];
  const joinLatency = [];
  for (let i = 0; i < USERS; i++) {
    phones.push({
      id: `lt_${i}_${Math.random().toString(36).slice(2, 8)}`,
      name: i < 2 ? 'Ahmed K' : `${FIRST[i % FIRST.length]} ${String.fromCharCode(65 + ((i * 7) % 26))}`,
      gender: i % 10 < 3 ? 'female' : 'male',
      answers: OPTION_COUNTS.map((_, q) => pickSkewed(SKEW[q])),
      teamId: null,
    });
  }
  let connectFails = 0;
  for (let b = 0; b < phones.length; b += BATCH) {
    await Promise.all(phones.slice(b, b + BATCH).map(async (p) => {
      try {
        p.sock = await connect('phone');
        p.sock.on('teams_formed', (d) => { if (d.participants[p.id]) p.teamId = d.participants[p.id].teamId; p.lastTeamsAt = Date.now(); p.lastReshuffled = d.reshuffled; });
        p.sock.on('teams_update', (d) => { if (d.participants[p.id]) p.teamId = d.participants[p.id].teamId; });
        const start = Date.now();
        const joined = once(p.sock, 'joined', 20000);
        p.sock.emit('join', { id: p.id, name: p.name, gender: p.gender });
        await joined;
        joinLatency.push(Date.now() - start);
      } catch (e) {
        connectFails++;
      }
    }));
  }
  check(`All ${USERS} phones connected and joined`, connectFails === 0, `${connectFails} failed | join ${stats(joinLatency)}`);
  await wait(600);
  let st = await getState();
  check(`Server shows exactly ${USERS} participants`, Object.keys(st.participants).length === USERS, `${Object.keys(st.participants).length}`);
  check('Two people with the same name stay separate', Object.values(st.participants).filter((p) => p.name === 'Ahmed K').length === 2);

  phones[5].sock.emit('join', { id: phones[5].id, name: phones[5].name, gender: phones[5].gender });
  await wait(500);
  st = await getState();
  check('Joining twice with the same phone does not duplicate', Object.keys(st.participants).length === USERS);

  /* ----- quiz ----- */
  section('4. Quiz: everyone answers at once');
  const quizSeen = phones.map((p) => once(p.sock, 'session_update', 15000, (s) => s.state === 'quiz_open').then(() => 1).catch(() => 0));
  fac.emit('facilitator_start_quiz');
  const quizReached = (await Promise.all(quizSeen)).reduce((a, b) => a + b, 0);
  check('Every phone was told the quiz started', quizReached === USERS, `${quizReached}/${USERS}`);

  const answerStart = Date.now();
  const doneAll = once(fac, 'submitted_update', 60000, (d) => d.submitted === USERS).then(() => true).catch(() => false);
  for (let q = 0; q < 8; q++) {
    for (const p of phones) p.sock.emit('submit_answer', { participantId: p.id, questionIndex: q, optionIndex: p.answers[q] });
    await wait(40);
  }
  // half the room changes their mind on question 1
  for (const p of phones.slice(0, Math.floor(USERS / 2))) {
    p.answers[0] = (p.answers[0] + 1) % OPTION_COUNTS[0];
    p.sock.emit('submit_answer', { participantId: p.id, questionIndex: 0, optionIndex: p.answers[0] });
  }
  check(`Submitted counter reached ${USERS}`, await doneAll, `${USERS * 8 + Math.floor(USERS / 2)} answers in ${Date.now() - answerStart}ms`);
  await wait(500);
  st = await getState();
  check('Exactly 8 answers stored per person (changed answers overwrite)', st.answers.length === USERS * 8, `${st.answers.length}`);
  const changed = phones.slice(0, Math.floor(USERS / 2)).every((p) => st.answers.find((a) => a.participantId === p.id && a.questionIndex === 0)?.optionIndex === p.answers[0]);
  check('Changed answers kept the latest choice', changed);

  /* ----- team count limits ----- */
  section('5. Team count limits');
  const tc = async (count) => { const p = once(fac, 'session_update', 8000); fac.emit('facilitator_set_team_count', { count }); return (await p).teamCount; };
  check('1 team is raised to the minimum of 2', (await tc(1)) === 2);
  check('999 teams is capped at 40', (await tc(999)) === 40);
  check('Non-number is ignored', (await tc('abc')) === 40);
  check(`Set to ${TEAMS}`, (await tc(TEAMS)) === TEAMS);

  /* ----- make teams ----- */
  section(`6. Make ${TEAMS} teams`);
  const expectTeams = Math.min(TEAMS, USERS);
  phones.forEach((p) => { p.teamId = null; });
  const fanStart = Date.now();
  const allGot = phones.map((p) => once(p.sock, 'teams_formed', 30000).then(() => Date.now() - fanStart).catch(() => null));
  fac.emit('facilitator_make_teams', { count: TEAMS });
  const fan = await Promise.all(allGot);
  const fanOk = fan.filter((x) => x != null);
  check('Every phone received its team', fanOk.length === USERS, `${fanOk.length}/${USERS} | ${stats(fanOk)}`);
  check('First formation is not flagged as a reshuffle', phones.every((p) => p.lastReshuffled === false));
  st = await getState();
  teamInvariants(st, 'Make teams', { expectTeams });
  check('Each phone shows the same team the server has', phones.every((p) => p.teamId && p.teamId === st.participants[p.id].teamId));

  // diversity vs random teams of the same sizes
  const byId = new Map(phones.map((p) => [p.id, p.answers]));
  const ours = withinTeamSim(st.teams.map((t) => t.memberIds.map((id) => byId.get(id))));
  let rnd = 0;
  const sizes = st.teams.map((t) => t.memberIds.length);
  for (let r = 0; r < 100; r++) {
    const pool = phones.map((p) => p.answers).sort(() => Math.random() - 0.5);
    let k = 0;
    rnd += withinTeamSim(sizes.map((n) => pool.slice(k, (k += n))));
  }
  rnd /= 100;
  const reduction = (100 * (1 - ours / rnd)).toFixed(1);
  check('Teams are at least as mixed as random teams', ours <= rnd + 1e-6, rnd > 0 ? `${reduction}% less alike than random` : 'teams too small to compare');

  /* ----- rapid reshuffles ----- */
  section(`7. ${RESHUFFLES} rapid reshuffles`);
  let reshuffleOk = true;
  const reshuffleTimes = [];
  for (let r = 0; r < RESHUFFLES; r++) {
    const start = Date.now();
    const got = once(fac, 'teams_formed', 20000);
    fac.emit('facilitator_make_teams', { count: TEAMS });
    const d = await got.catch(() => null);
    reshuffleTimes.push(Date.now() - start);
    if (!d || d.reshuffled !== true) reshuffleOk = false;
  }
  check('Every reshuffle answered and flagged as reshuffle', reshuffleOk, stats(reshuffleTimes));
  st = await getState();
  teamInvariants(st, 'After reshuffles', { expectTeams });
  const caughtUp = await phonesCatchUp(phones, st);
  check('Every phone ends up on its latest team after reshuffles', caughtUp.ok, caughtUp.detail);

  /* ----- other team counts ----- */
  section('7b. Different team counts');
  for (const count of [2, 5, 8, 10, 13, 40, TEAMS]) {
    const got = once(fac, 'teams_formed', 20000);
    fac.emit('facilitator_make_teams', { count });
    await got.catch(() => null);
    st = await getState();
    teamInvariants(st, `${count} teams`, { expectTeams: Math.min(count, USERS) });
    const c = await phonesCatchUp(phones, st);
    check(`${count} teams: every phone shows the right team`, c.ok, c.detail);
  }

  /* ----- late joiners ----- */
  section('8. Late joiners after teams are formed');
  const late = [];
  for (const [i, g] of ['female', 'female', 'male'].entries()) {
    const p = { id: `late_${i}_${Date.now()}`, name: `Late ${i}`, gender: g };
    p.sock = await connect('phone');
    const sync = once(p.sock, 'state_sync', 15000, (s) => !!s.participants[p.id]);
    p.sock.emit('join', { id: p.id, name: p.name, gender: p.gender });
    const s = await sync.catch(() => null);
    p.teamId = s && s.participants[p.id].teamId;
    late.push(p);
  }
  check('Late joiners are placed in a team straight away', late.every((p) => !!p.teamId));
  st = await getState();
  teamInvariants(st, 'With late joiners', { expectTeams });

  /* ----- drop and reconnect ----- */
  section('9. Phones lose connection and come back');
  const dropCount = Math.max(1, Math.min(50, Math.floor(USERS / 4)));
  const dropped = phones.slice(5, 5 + dropCount);
  dropped.forEach((p) => p.sock.close());
  await wait(2500);
  st = await getState();
  check(`${dropCount} disconnected phones are NOT removed`, Object.keys(st.participants).length === USERS + late.length);
  let back = 0;
  await Promise.all(dropped.map(async (p) => {
    try {
      p.sock = await connect('phone');
      const sync = once(p.sock, 'state_sync', 15000);
      p.sock.emit('identify', { id: p.id });
      const s = await sync;
      if (s.participants[p.id] && s.participants[p.id].teamId === st.participants[p.id].teamId) back++;
      p.sock.on('teams_formed', (d) => { if (d.participants[p.id]) p.teamId = d.participants[p.id].teamId; });
      p.sock.on('teams_update', (d) => { if (d.participants[p.id]) p.teamId = d.participants[p.id].teamId; });
    } catch (e) { /* counted as failure */ }
  }));
  check('Reconnected phones get the same team back', back === dropCount, `${back}/${dropCount}`);

  /* ----- facilitator overrides ----- */
  section('10. Facilitator move and remove');
  {
    const mover = phones[0];
    const target = st.teams.find((t) => t.id !== st.participants[mover.id].teamId);
    const upd = once(mover.sock, 'teams_update', 10000);
    fac.emit('facilitator_move_participant', { participantId: mover.id, teamId: target.id });
    const d = await upd.catch(() => null);
    check('Moved person is told their new team', !!d && d.participants[mover.id].teamId === target.id);

    const victim = phones[1];
    const removed = once(victim.sock, 'removed', 10000).then(() => true).catch(() => false);
    fac.emit('facilitator_delete_participant', { participantId: victim.id });
    check('Removed person is told they were removed', await removed);
    await wait(400);
    st = await getState();
    check('Removed person is gone from the room and teams', !st.participants[victim.id] && st.teams.every((t) => !t.memberIds.includes(victim.id)));

    const sync = once(victim.sock, 'state_sync', 10000);
    victim.sock.emit('identify', { id: victim.id, profile: { sessionId: st.session.sessionId, name: victim.name, gender: victim.gender } });
    const s = await sync;
    check('Removed person cannot silently re-enter from their phone', !s.participants[victim.id]);

    const sync2 = once(victim.sock, 'state_sync', 10000, (x) => !!x.participants[victim.id]);
    victim.sock.emit('join', { id: victim.id, name: victim.name, gender: victim.gender });
    const s2 = await sync2.catch(() => null);
    check('Removed person can rejoin by joining again', !!s2 && !!s2.participants[victim.id].teamId);
  }

  /* ----- stale phone ----- */
  section('11. Stale phones from an old session');
  {
    const s = await connect('phone');
    const sync = once(s, 'state_sync', 10000);
    s.emit('identify', { id: 'ghost_1', profile: { sessionId: 'old-session', name: 'Ghost G', gender: 'male', teamNumber: 3, teamCount: 20 } });
    const d = await sync;
    check('Phone with a profile from another session is not let in', !d.participants.ghost_1);
    s.close();
  }

  /* ----- reset ----- */
  section('12. Reset');
  const everyone = [...phones, ...late].filter((p) => p.sock && p.sock.connected);
  const resetStart = Date.now();
  const resets = everyone.map((p) => once(p.sock, 'reset', 20000).then(() => Date.now() - resetStart).catch(() => null));
  const sid = st.session.sessionId;
  await resetAll();
  const resetGot = (await Promise.all(resets)).filter((x) => x != null);
  check('Every connected phone is sent back to the join screen', resetGot.length === everyone.length, `${resetGot.length}/${everyone.length} | ${stats(resetGot)}`);
  st = await getState();
  check('Room is empty after reset', Object.keys(st.participants).length === 0 && st.teams.length === 0 && st.session.state === 'idle');
  {
    const p = phones[phones.length - 1];
    const sync = once(p.sock, 'state_sync', 10000);
    p.sock.emit('identify', { id: p.id, profile: { sessionId: sid, name: p.name, gender: p.gender, teamNumber: 1, teamCount: TEAMS } });
    const d = await sync;
    check('Phones from before the reset cannot sneak back in', !d.participants[p.id]);
  }

  /* ----- tiny rooms ----- */
  section('13. Tiny rooms');
  {
    const a = phones[2], b = phones[3], c = phones[4];
    const join = async (p) => { const j = once(p.sock, 'joined', 10000); p.sock.emit('join', { id: p.id, name: p.name, gender: p.gender }); await j; };
    await join(a);
    const err = once(fac, 'facilitator_error', 8000).then(() => true).catch(() => false);
    fac.emit('facilitator_make_teams', { count: 5 });
    check('Making teams with only 1 person shows an error', await err);
    await join(b); await join(c);
    const formed = once(fac, 'teams_formed', 10000);
    fac.emit('facilitator_make_teams', { count: 10 });
    const d = await formed.catch(() => null);
    check('Asking for 10 teams with 3 people makes 3 teams of 1', !!d && d.teams.length === 3 && d.teams.every((t) => t.memberIds.length === 1));
  }

  /* ----- cleanup ----- */
  section('14. Cleanup');
  await resetAll();
  [...phones, ...late].forEach((p) => p.sock && p.sock.close());
  fac.close();
  check('Server healthy at the end', await health());
  check('Session left clean (reset)', true);

  const mine = results.slice(startCount);
  const failed = mine.filter((r) => !r.ok);
  console.log(`\n${C.b}${failed.length ? C.r : C.g}Room of ${USERS}: ${mine.length - failed.length}/${mine.length} checks passed${C.x}  ${C.d}in ${((Date.now() - t0) / 1000).toFixed(1)}s${C.x}`);
  return { users: USERS, teams: TEAMS, passed: mine.length - failed.length, total: mine.length, failed: failed.map((f) => f.name) };
}

async function main() {
  if (!SIZES.length) { console.error('No valid room size. Use --users 30 or --sizes 30,50,100'); process.exit(1); }
  console.log(`${C.b}AI Team Formation load test${C.x}  ${C.d}rooms: ${SIZES.join(', ')}${C.x}`);
  const summary = [];
  for (const size of SIZES) {
    USERS = size;
    TEAMS = teamsFor(size);
    summary.push(await runSuite());
  }
  console.log(`\n${C.b}Summary${C.x}`);
  for (const r of summary) {
    const ok = r.passed === r.total;
    console.log(`  ${ok ? C.g + 'PASS' : C.r + 'FAIL'}${C.x} ${String(r.users).padStart(4)} people, ${String(r.teams).padStart(2)} teams  ${r.passed}/${r.total}`);
    r.failed.forEach((f) => console.log(`       ${C.r}- ${f}${C.x}`));
  }
  const allOk = summary.every((r) => r.passed === r.total);
  console.log(`\n${C.b}${allOk ? C.g + 'All rooms passed' : C.r + 'Some checks failed'}${C.x}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n${C.r}Test crashed: ${e.message}${C.x}`);
  process.exit(1);
});