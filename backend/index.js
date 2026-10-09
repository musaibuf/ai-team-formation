/*
 * AI Team Formation - backend
 * Node + Express + Socket.io (Constellation protocol, puzzle removed)
 *
 * - Participants are never removed on disconnect. Only a facilitator reset (or an explicit
 *   facilitator "Remove") takes someone out.
 * - If the server restarts, phones re-admit themselves (name, answers, team) from what they
 *   stored locally, unless a reset has happened since.
 * - Teams: gender balanced first (a woman in every team where numbers allow), sizes within
 *   one of each other, then people with similar quiz answers are spread across teams.
 */
const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;
const MIN_TEAMS = 2;
const MAX_TEAMS = 40;
const MAX_NAME = 20;

/* ---------- quiz ---------- */

// weight = how strongly the team builder spreads apart people who gave the same answer
const QUESTIONS = [
  {
    weight: 1.5,
    text: "Figuring out something new, what's your instinct?",
    options: ['Read the instructions', 'Watch someone else do it first', 'Start pressing buttons', 'Ask a person'],
  },
  {
    weight: 1,
    text: 'First week somewhere new, which are you?',
    options: ['The one asking all the questions', 'The one watching quietly first'],
  },
  {
    weight: 1.5,
    text: "When you're stuck, how long before you ask for help?",
    options: ['Straight away', 'About an hour', "I'll search until 2am", "I'll suffer in silence"],
  },
  {
    weight: 2,
    text: 'Where do you call home?',
    options: ['Karachi', 'Lahore', 'Islamabad or Rawalpindi', 'Peshawar', 'Quetta', 'Somewhere smaller'],
  },
  {
    weight: 0.5,
    text: 'Your order when you actually get to choose:',
    options: ['Chai', 'Coffee', 'Cold drink', 'Juice', 'Just water'],
  },
  {
    weight: 1,
    text: "If this career didn't exist, what would you be doing?",
    options: ['Musician', 'Athlete', 'Chef', 'Teacher', 'Running my own thing', 'No idea yet'],
  },
  {
    weight: 0.5,
    text: 'Your group chat personality:',
    options: ['Sends voice notes', 'Replies with stickers', 'Leaves you on seen', 'Types an essay', 'Has the group muted'],
  },
  {
    weight: 0.25,
    text: 'Your phone battery right now:',
    options: ['100%', 'Above 50%', 'Above 15%', 'Dying, like always'],
  },
];
const PUBLIC_QUESTIONS = QUESTIONS.map(({ text, options }) => ({ text, options }));

/* ---------- team colours (6-digit hex, the screens append alpha) ---------- */

const TEAM_COLOURS = [
  '#ff6b35', '#3ec7ff', '#ffd23f', '#5ee08a', '#b388ff',
  '#ff5fa2', '#2ee6d6', '#ffa24c', '#7f9cff', '#c6f04a',
  '#ff8577', '#4fa8ff', '#f4e04d', '#7be0b0', '#d17bff',
  '#ff7ac6', '#46d9b0', '#ffb86b', '#9aa9ff', '#a6e35c',
];

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

const teamColour = (i) => (i < TEAM_COLOURS.length ? TEAM_COLOURS[i] : hslToHex((i * 137.508) % 360, 80, 64));

/* ---------- server ---------- */

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 20000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e5,
});

const uid = () => crypto.randomUUID();

const state = {
  sessionId: uid(),
  phase: 'idle', // idle | quiz_open | teams_formed
  teamCount: 10,
  participants: new Map(), // id -> { id, name, gender, teamId, joinedAt, sessionId }
  answers: new Map(), // id -> Map(questionIndex -> optionIndex)
  teams: [], // [{ id, number, colour, memberIds }]
};
const retiredSessions = new Set();
const deletedIds = new Set();
const onlineSockets = new Map(); // participantId -> Set(socket.id)
let resetSinceBoot = false;

/* ---------- helpers ---------- */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const cleanName = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '');
const cleanGender = (v) => (v === 'female' || v === 'male' ? v : null);
const clampTeams = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(MAX_TEAMS, Math.max(MIN_TEAMS, n)) : fallback;
};
const validAnswer = (q, o) =>
  Number.isInteger(q) && q >= 0 && q < QUESTIONS.length && Number.isInteger(o) && o >= 0 && o < QUESTIONS[q].options.length;

function answersOf(id) {
  if (!state.answers.has(id)) state.answers.set(id, new Map());
  return state.answers.get(id);
}

const isSubmitted = (id) => (state.answers.get(id) || new Map()).size >= QUESTIONS.length;
const submittedCount = () => [...state.participants.keys()].filter(isSubmitted).length;

function makeEmptyTeams(k) {
  return Array.from({ length: k }, (_, i) => ({ id: `t${i + 1}`, number: i + 1, colour: teamColour(i), memberIds: [] }));
}

/* ---------- team building ---------- */

// While teams are being built, every pair's alikeness is precomputed once into a
// flat matrix, so the thousands of swap checks below are simple lookups.
let simCache = null;

function buildSimCache(people) {
  const n = people.length;
  const qn = QUESTIONS.length;
  const W = QUESTIONS.map((q) => q.weight);
  const vec = new Int8Array(n * qn).fill(-1);
  people.forEach((p, i) => {
    p._si = i;
    const m = state.answers.get(p.id);
    if (m) for (const [q, o] of m) vec[i * qn + q] = o;
  });
  const S = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let v = 0;
      for (let q = 0; q < qn; q++) {
        const x = vec[i * qn + q];
        if (x >= 0 && x === vec[j * qn + q]) v += W[q];
      }
      S[i * n + j] = v;
      S[j * n + i] = v;
    }
  }
  simCache = { S, n };
}

function pairSim(a, b) {
  if (simCache) return simCache.S[a._si * simCache.n + b._si];
  const A = state.answers.get(a.id);
  const B = state.answers.get(b.id);
  if (!A || !B) return 0;
  let s = 0;
  for (const [q, opt] of A) if (B.get(q) === opt) s += QUESTIONS[q].weight;
  return s;
}

function similarity(p, members, skip = null) {
  let s = 0;
  for (const m of members) if (m !== p && m !== skip) s += pairSim(p, m);
  return s;
}

// 1) women go to teams without a woman first  2) only the smallest teams qualify
// 3) among those, the team least like this person wins (random tie break)
function pickTeam(groups, p) {
  let pool = groups.map((_, i) => i);
  if (p.gender === 'female') {
    const noWoman = pool.filter((i) => !groups[i].some((m) => m.gender === 'female'));
    if (noWoman.length) pool = noWoman;
  }
  const min = Math.min(...pool.map((i) => groups[i].length));
  pool = pool.filter((i) => groups[i].length === min);
  let best = [];
  let bestScore = Infinity;
  for (const i of pool) {
    const s = similarity(p, groups[i]);
    if (s < bestScore - 1e-9) {
      bestScore = s;
      best = [i];
    } else if (Math.abs(s - bestScore) < 1e-9) best.push(i);
  }
  return best[Math.floor(Math.random() * best.length)];
}

// Same-gender swaps between teams whenever both teams get less alike.
// Sizes and gender balance never change.
function optimise(groups) {
  const k = groups.length;
  const total = groups.reduce((n, g) => n + g.length, 0);
  const iters = Math.min(40000, 120 * total);
  for (let it = 0; it < iters; it++) {
    const ta = Math.floor(Math.random() * k);
    let tb = Math.floor(Math.random() * (k - 1));
    if (tb >= ta) tb++;
    const A = groups[ta];
    const B = groups[tb];
    if (!A.length || !B.length) continue;
    const ia = Math.floor(Math.random() * A.length);
    const a = A[ia];
    let ib = -1;
    for (let t = 0; t < 6; t++) {
      const c = Math.floor(Math.random() * B.length);
      if (B[c].gender === a.gender) {
        ib = c;
        break;
      }
    }
    if (ib === -1) continue;
    const b = B[ib];
    const delta = similarity(b, A, a) - similarity(a, A) + (similarity(a, B, b) - similarity(b, B));
    if (delta < -1e-9) {
      A[ia] = b;
      B[ib] = a;
    }
  }
}

function formTeams(requested) {
  const people = [...state.participants.values()];
  if (people.length < 2) return { ok: false, error: 'At least 2 people are needed to make teams.' };
  const k = Math.min(requested, people.length);
  const groups = Array.from({ length: k }, () => []);
  const women = shuffle(people.filter((p) => p.gender === 'female'));
  const rest = shuffle(people.filter((p) => p.gender !== 'female'));
  buildSimCache(people);
  try {
    for (const p of [...women, ...rest]) groups[pickTeam(groups, p)].push(p);
    optimise(groups);
  } finally {
    simCache = null;
  }

  state.teams = makeEmptyTeams(k);
  groups.forEach((g, i) => {
    for (const p of g) {
      p.teamId = state.teams[i].id;
      state.teams[i].memberIds.push(p.id);
    }
  });
  state.phase = 'teams_formed';
  return { ok: true, teams: k };
}

function membersOf(team) {
  return team.memberIds.map((id) => state.participants.get(id)).filter(Boolean);
}

function assignLate(p) {
  if (state.phase !== 'teams_formed' || !state.teams.length) return;
  const groups = state.teams.map(membersOf);
  const t = state.teams[pickTeam(groups, p)];
  t.memberIds.push(p.id);
  p.teamId = t.id;
}

function removeFromTeams(id) {
  for (const t of state.teams) t.memberIds = t.memberIds.filter((m) => m !== id);
}

/* ---------- payloads ---------- */

function participantsObj() {
  const out = {};
  for (const p of state.participants.values()) {
    out[p.id] = { id: p.id, name: p.name, gender: p.gender, teamId: p.teamId };
  }
  return out;
}

function answersList() {
  const out = [];
  for (const [pid, m] of state.answers) {
    if (!state.participants.has(pid)) continue;
    for (const [q, o] of m) out.push({ participantId: pid, questionIndex: q, optionIndex: o });
  }
  return out;
}

const sessionObj = () => ({
  state: state.phase,
  activity: 'constellation',
  teamCount: state.teamCount,
  sessionId: state.sessionId,
});

const fullState = () => ({
  participants: participantsObj(),
  answers: answersList(),
  questions: PUBLIC_QUESTIONS,
  session: sessionObj(),
  teams: state.teams,
  submitted: submittedCount(),
});

/* ---------- batched broadcasts (keeps a 200-person join burst cheap) ---------- */

const dirty = { participants: false, submitted: false };
let flushTimer = null;
function schedule(kind) {
  dirty[kind] = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (dirty.participants) {
      io.to('screens').emit('participants_update', participantsObj());
      io.to('phones').emit('room_count', { count: state.participants.size });
    }
    if (dirty.participants || dirty.submitted) {
      io.to('screens').emit('submitted_update', { submitted: submittedCount() });
    }
    dirty.participants = false;
    dirty.submitted = false;
  }, 120);
}

const emitSession = () => io.emit('session_update', sessionObj());
// Screens get the whole room. Each phone only gets its own team (about 1KB instead of
// the full 200-person list), sent as one broadcast per team.
function emitTeams(event, extra = {}) {
  io.to('screens').emit(event, { teams: state.teams, participants: participantsObj(), ...extra });
  for (const t of state.teams) {
    if (!t.memberIds.length) continue;
    const participants = {};
    for (const id of t.memberIds) {
      const p = state.participants.get(id);
      if (p) participants[id] = { id, name: p.name, gender: p.gender, teamId: p.teamId };
    }
    io.to(t.memberIds.map((id) => `p:${id}`)).emit(event, { teams: [t], participants, teamCount: state.teams.length, ...extra });
  }
}

/* ---------- re-admission after a server restart ---------- */

function tryReadmit(id, profile) {
  if (!profile || typeof profile !== 'object' || deletedIds.has(id)) return false;
  const sid = typeof profile.sessionId === 'string' ? profile.sessionId : null;
  if (!sid || retiredSessions.has(sid) || resetSinceBoot) return false;
  const name = cleanName(profile.name);
  const gender = cleanGender(profile.gender);
  if (!name || !gender) return false;

  const p = { id, name, gender, teamId: null, joinedAt: Date.now(), sessionId: sid };
  state.participants.set(id, p);
  const mine = answersOf(id);
  if (profile.answers && typeof profile.answers === 'object') {
    for (const [q, o] of Object.entries(profile.answers)) {
      const qi = Number(q);
      const oi = Number(o);
      if (validAnswer(qi, oi)) mine.set(qi, oi);
    }
  }

  let teamsChanged = false;
  if (state.phase === 'idle' && (profile.sessionState === 'quiz_open' || profile.sessionState === 'teams_formed' || mine.size)) {
    state.phase = 'quiz_open';
  }
  const num = Number(profile.teamNumber);
  if (Number.isInteger(num) && num >= 1) {
    if (state.phase !== 'teams_formed' || !state.teams.length) {
      const k = clampTeams(Math.max(Number(profile.teamCount) || 0, num), num);
      state.teams = makeEmptyTeams(k);
      state.teamCount = k;
      state.phase = 'teams_formed';
    }
    const t = state.teams[num - 1];
    if (t) {
      t.memberIds.push(id);
      p.teamId = t.id;
    } else assignLate(p);
    teamsChanged = true;
  } else if (state.phase === 'teams_formed') {
    assignLate(p);
    teamsChanged = true;
  }
  return { teamsChanged };
}

/* ---------- sockets ---------- */

io.on('connection', (socket) => {
  const role = socket.handshake.query && socket.handshake.query.role;
  socket.join(role === 'projector' || role === 'facilitator' ? 'screens' : 'phones');

  const track = (pid) => {
    if (socket.data.pid === pid) return;
    socket.data.pid = pid;
    socket.join(`p:${pid}`);
    if (!onlineSockets.has(pid)) onlineSockets.set(pid, new Set());
    onlineSockets.get(pid).add(socket.id);
  };

  socket.on('disconnect', () => {
    const pid = socket.data.pid;
    if (pid && onlineSockets.has(pid)) {
      onlineSockets.get(pid).delete(socket.id);
      if (!onlineSockets.get(pid).size) onlineSockets.delete(pid);
    }
    // Participants stay in the session. Only a reset removes them.
  });

  socket.on('hello', () => {
    socket.join('screens');
    socket.emit('state_sync', fullState());
  });

  socket.on('request_sync', () => socket.emit('state_sync', fullState()));

  socket.on('identify', (data) => {
    const id = data && typeof data.id === 'string' ? data.id.slice(0, 80) : null;
    if (!id) return;
    track(id);
    if (!state.participants.has(id)) {
      const res = tryReadmit(id, data.profile);
      if (res) {
        schedule('participants');
        if (state.phase !== 'idle') emitSession();
        if (res.teamsChanged) emitTeams('teams_update');
      }
    }
    socket.emit('state_sync', fullState());
  });

  socket.on('join', (data) => {
    const id = data && typeof data.id === 'string' ? data.id.slice(0, 80) : null;
    const name = cleanName(data && data.name);
    const gender = cleanGender(data && data.gender);
    if (!id) return socket.emit('join_error', { message: 'Something went wrong. Refresh and try again.' });
    if (!name) return socket.emit('join_error', { message: 'Enter 1-20 characters.' });
    if (!gender) return socket.emit('join_error', { message: 'Please select your gender.' });

    track(id);
    deletedIds.delete(id);
    let p = state.participants.get(id);
    let teamsChanged = false;
    if (p) {
      p.name = name;
      p.gender = gender;
    } else {
      p = { id, name, gender, teamId: null, joinedAt: Date.now(), sessionId: state.sessionId };
      state.participants.set(id, p);
      if (state.phase === 'teams_formed') {
        assignLate(p);
        teamsChanged = true;
      }
    }
    socket.emit('joined', { id: p.id, name: p.name, sessionId: state.sessionId });
    socket.emit('state_sync', fullState());
    schedule('participants');
    if (teamsChanged) emitTeams('teams_update');
  });

  socket.on('submit_answer', (data) => {
    const pid = data && data.participantId;
    const q = Number(data && data.questionIndex);
    const o = Number(data && data.optionIndex);
    if (!state.participants.has(pid) || !validAnswer(q, o)) return;
    answersOf(pid).set(q, o);
    socket.emit('answer_confirmed', { questionIndex: q });
    io.to('screens').emit('answer_received', { participantId: pid, questionIndex: q, optionIndex: o });
    schedule('submitted');
  });

  /* ----- facilitator ----- */

  socket.on('facilitator_start_quiz', () => {
    if (state.phase === 'idle') state.phase = 'quiz_open';
    emitSession();
  });

  socket.on('facilitator_set_team_count', (data) => {
    state.teamCount = clampTeams(data && data.count, state.teamCount);
    emitSession();
  });

  // First press makes teams (with the "Forming" moment on the main screen).
  // Every press after that is a plain reshuffle.
  socket.on('facilitator_make_teams', (data) => {
    if (data && data.count != null) state.teamCount = clampTeams(data.count, state.teamCount);
    const reshuffled = state.phase === 'teams_formed';
    const res = formTeams(state.teamCount);
    if (!res.ok) return socket.emit('facilitator_error', { message: res.error });
    emitSession();
    emitTeams('teams_formed', { reshuffled });
  });

  socket.on('facilitator_move_participant', (data) => {
    const p = state.participants.get(data && data.participantId);
    const t = state.teams.find((tt) => tt.id === (data && data.teamId));
    if (!p || !t || p.teamId === t.id) return;
    removeFromTeams(p.id);
    t.memberIds.push(p.id);
    p.teamId = t.id;
    emitTeams('teams_update');
    schedule('participants');
  });

  socket.on('facilitator_delete_participant', (data) => {
    const id = data && data.participantId;
    if (!state.participants.has(id)) return;
    state.participants.delete(id);
    state.answers.delete(id);
    removeFromTeams(id);
    deletedIds.add(id);
    io.to(`p:${id}`).emit('removed');
    if (state.phase === 'teams_formed') emitTeams('teams_update');
    schedule('participants');
  });

  socket.on('facilitator_reset', () => {
    retiredSessions.add(state.sessionId);
    for (const p of state.participants.values()) retiredSessions.add(p.sessionId);
    state.sessionId = uid();
    state.phase = 'idle';
    state.participants.clear();
    state.answers.clear();
    state.teams = [];
    deletedIds.clear();
    resetSinceBoot = true;
    io.emit('reset');
    io.to('screens').emit('state_sync', fullState());
  });
});

/* ---------- http ---------- */

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    app: 'AI Team Formation',
    phase: state.phase,
    participants: state.participants.size,
    submitted: submittedCount(),
    teams: state.teams.length,
  });
});

app.get('/health', (_req, res) => res.send('ok'));

server.listen(PORT, () => {
  console.log(`AI Team Formation backend running on port ${PORT}`);
});