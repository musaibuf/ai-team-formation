/*
 * AI Team Formation - backend
 * Node + Express + Socket.io
 *
 * Participants are never removed on disconnect. Only a facilitator reset clears them.
 * If the server restarts, participants re-admit themselves automatically (with their team
 * and quiz answers) from what their phone stored, unless a reset has happened since.
 *
 * Teams: gender balanced first (at least one woman per team where numbers allow),
 * sizes kept within one of each other, then people with similar quiz answers are spread apart.
 */
const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;
const FACILITATOR_PIN = (process.env.FACILITATOR_PIN || '').trim(); // optional
const MIN_TEAMS = 2;
const MAX_TEAMS = 100;
const MAX_NAME = 40;

/* ---------- quiz ---------- */

// weight = how strongly the team builder spreads people who gave the same answer
const QUESTIONS = [
  {
    id: 'q1',
    weight: 1.5,
    text: "Figuring out something new, what's your instinct?",
    options: ['Read the instructions', 'Watch someone else do it first', 'Start pressing buttons', 'Ask a person'],
  },
  {
    id: 'q2',
    weight: 1,
    text: 'First week somewhere new, which are you?',
    options: ['The one asking all the questions', 'The one watching quietly first'],
  },
  {
    id: 'q3',
    weight: 1.5,
    text: "When you're stuck, how long before you ask for help?",
    options: ['Straight away', 'About an hour', "I'll search until 2am", "I'll suffer in silence"],
  },
  {
    id: 'q4',
    weight: 2,
    text: 'Where do you call home?',
    options: ['Karachi', 'Lahore', 'Islamabad or Rawalpindi', 'Peshawar', 'Quetta', 'Somewhere smaller'],
  },
  {
    id: 'q5',
    weight: 0.5,
    text: 'Your order when you actually get to choose:',
    options: ['Chai', 'Coffee', 'Cold drink', 'Juice', 'Just water'],
  },
  {
    id: 'q6',
    weight: 1,
    text: "If this career didn't exist, what would you be doing?",
    options: ['Musician', 'Athlete', 'Chef', 'Teacher', 'Running my own thing', 'No idea yet'],
  },
  {
    id: 'q7',
    weight: 0.5,
    text: 'Your group chat personality:',
    options: ['Sends voice notes', 'Replies with stickers', 'Leaves you on seen', 'Types an essay', 'Has the group muted'],
  },
  {
    id: 'q8',
    weight: 0.25,
    text: 'Your phone battery right now:',
    options: ['100%', 'Above 50%', 'Above 15%', 'Dying, like always'],
  },
];
const PUBLIC_QUESTIONS = QUESTIONS.map(({ id, text, options }) => ({ id, text, options }));
const QUESTION_BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));

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
  epoch: uid(),
  participants: new Map(), // id -> { id, name, gender, epoch, team, seq, answers }
  teamCount: 4,
  quizStarted: false,
  formed: false,
  formedTeamCount: 0,
  shuffleVersion: 0,
};
const retiredEpochs = new Set();
let resetSinceBoot = false;
let seq = 0;

/* ---------- helpers ---------- */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

function cleanGender(v) {
  return v === 'female' || v === 'male' ? v : null;
}

function cleanAnswers(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [qid, val] of Object.entries(obj)) {
    const q = QUESTION_BY_ID.get(qid);
    const n = Number(val);
    if (q && Number.isInteger(n) && n >= 0 && n < q.options.length) out[qid] = n;
  }
  return out;
}

const answeredCount = (p) => Object.keys(p.answers || {}).length;
const isDone = (p) => answeredCount(p) >= QUESTIONS.length;

function clampTeamCount(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return state.teamCount;
  return Math.min(MAX_TEAMS, Math.max(MIN_TEAMS, n));
}

// How alike two people are (sum of weights of questions they answered the same)
function pairSim(a, b) {
  let s = 0;
  for (const q of QUESTIONS) {
    const x = a.answers[q.id];
    if (x != null && x === b.answers[q.id]) s += q.weight;
  }
  return s;
}

// How alike a person is to the members of a team, ignoring themselves and `skip`
function similarity(p, members, skip = null) {
  let score = 0;
  for (const m of members) {
    if (m === p || m === skip) continue;
    score += pairSim(p, m);
  }
  return score;
}

// Total "alikeness" inside teams. Lower = more mixed teams.
function totalSimilarity(teams) {
  let s = 0;
  for (const t of teams) {
    for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) s += pairSim(t[i], t[j]);
  }
  return s;
}

// Swap same-gender people between teams whenever it makes both teams less alike.
// Same-gender swaps keep team sizes and the gender balance exactly as they are.
function optimiseTeams(teams) {
  const k = teams.length;
  if (k < 2) return;
  const total = teams.reduce((n, t) => n + t.length, 0);
  const iters = Math.min(40000, 120 * total);
  for (let it = 0; it < iters; it++) {
    const ta = Math.floor(Math.random() * k);
    let tb = Math.floor(Math.random() * (k - 1));
    if (tb >= ta) tb++;
    const A = teams[ta];
    const B = teams[tb];
    if (!A.length || !B.length) continue;
    const ia = Math.floor(Math.random() * A.length);
    const a = A[ia];
    let ib = -1;
    for (let tries = 0; tries < 6; tries++) {
      const c = Math.floor(Math.random() * B.length);
      if (B[c].gender === a.gender) {
        ib = c;
        break;
      }
    }
    if (ib === -1) continue;
    const b = B[ib];
    const delta =
      similarity(b, A, a) - similarity(a, A) + (similarity(a, B, b) - similarity(b, B));
    if (delta < -1e-9) {
      A[ia] = b;
      B[ib] = a;
    }
  }
}

function teamStats() {
  const stats = Array.from({ length: state.formedTeamCount }, () => ({ members: [], women: 0 }));
  for (const p of state.participants.values()) {
    if (p.team != null && stats[p.team]) {
      stats[p.team].members.push(p);
      if (p.gender === 'female') stats[p.team].women++;
    }
  }
  return stats;
}

// 1) women go to teams without a woman first
// 2) only the smallest teams are candidates (sizes stay within one)
// 3) among those, the team least like this person wins (random tie break)
function pickTeam(stats, p) {
  let pool = stats.map((_, i) => i);

  if (p.gender === 'female') {
    const noWoman = pool.filter((i) => stats[i].women === 0);
    if (noWoman.length) pool = noWoman;
  }

  const minSize = Math.min(...pool.map((i) => stats[i].members.length));
  pool = pool.filter((i) => stats[i].members.length === minSize);

  let best = [];
  let bestScore = Infinity;
  for (const i of pool) {
    const s = similarity(p, stats[i].members);
    if (s < bestScore - 1e-9) {
      bestScore = s;
      best = [i];
    } else if (Math.abs(s - bestScore) < 1e-9) {
      best.push(i);
    }
  }
  return best[Math.floor(Math.random() * best.length)];
}

function formTeams(requested) {
  const people = [...state.participants.values()];
  if (people.length < 2) return { ok: false, error: 'At least 2 participants are needed to form teams.' };

  const k = Math.min(requested, people.length);
  const stats = Array.from({ length: k }, () => ({ members: [], women: 0 }));
  const women = shuffle(people.filter((p) => p.gender === 'female'));
  const rest = shuffle(people.filter((p) => p.gender !== 'female'));

  for (const p of [...women, ...rest]) {
    const t = pickTeam(stats, p);
    stats[t].members.push(p);
    if (p.gender === 'female') stats[t].women++;
  }

  const teams = stats.map((s) => s.members);
  optimiseTeams(teams);
  teams.forEach((members, t) => members.forEach((p) => (p.team = t)));

  state.formed = true;
  state.formedTeamCount = k;
  state.shuffleVersion++;
  return { ok: true, teams: k };
}

function assignLate(p) {
  if (!state.formed || state.formedTeamCount < 1) {
    p.team = null;
    return;
  }
  p.team = pickTeam(teamStats(), p);
}

function publicState() {
  const list = [...state.participants.values()].sort((a, b) => a.seq - b.seq);
  const participants = list.map((p) => ({
    id: p.id,
    name: p.name,
    gender: p.gender,
    team: p.team,
    answered: answeredCount(p),
    done: isDone(p),
  }));
  return {
    participants,
    total: participants.length,
    doneCount: participants.filter((p) => p.done).length,
    questionCount: QUESTIONS.length,
    quizStarted: state.quizStarted,
    teamCount: state.teamCount,
    formed: state.formed,
    formedTeamCount: state.formedTeamCount,
    shuffleVersion: state.shuffleVersion,
  };
}

function groupByTeam() {
  const byTeam = new Map();
  for (const p of state.participants.values()) {
    if (p.team == null) continue;
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team).push(p);
  }
  return byTeam;
}

function meFor(p, byTeam = groupByTeam()) {
  const mates = p.team != null ? byTeam.get(p.team) || [] : [];
  return {
    id: p.id,
    name: p.name,
    team: p.team,
    teamNumber: p.team != null ? p.team + 1 : null,
    teammates: mates
      .filter((m) => m.id !== p.id)
      .sort((a, b) => a.seq - b.seq)
      .map((m) => m.name),
    answers: p.answers,
    quizStarted: state.quizStarted,
    formed: state.formed,
    formedTeamCount: state.formedTeamCount,
    shuffleVersion: state.shuffleVersion,
    total: state.participants.size,
  };
}

function broadcastNow() {
  io.to('dashboard').to('facilitator').emit('state', publicState());
  const byTeam = groupByTeam();
  for (const p of state.participants.values()) {
    io.to(`p:${p.id}`).emit('me', meFor(p, byTeam));
  }
}

let pending = null;
function scheduleBroadcast() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    broadcastNow();
  }, 60);
}

/* ---------- sockets ---------- */

io.on('connection', (socket) => {
  const isFacilitator = () => socket.data.facilitator === true;

  const attachParticipant = (p) => {
    socket.data.pid = p.id;
    socket.join('participants');
    socket.join(`p:${p.id}`);
  };

  socket.on('quiz:get', (ack) => {
    if (typeof ack === 'function') ack({ questions: PUBLIC_QUESTIONS });
  });

  socket.on('participant:join', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const name = cleanName(data && data.name);
    const gender = cleanGender(data && data.gender);
    if (!name) return reply({ ok: false, error: 'Please enter your name.' });
    if (!gender) return reply({ ok: false, error: 'Please select your gender.' });

    const p = { id: uid(), name, gender, epoch: state.epoch, team: null, seq: ++seq, answers: {} };
    state.participants.set(p.id, p);
    assignLate(p);
    attachParticipant(p);

    reply({ ok: true, id: p.id, epoch: p.epoch, me: meFor(p) });
    scheduleBroadcast();
  });

  socket.on('participant:rejoin', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const id = data && typeof data.id === 'string' ? data.id : null;
    const epoch = data && typeof data.epoch === 'string' ? data.epoch : null;

    if (!id || !epoch || retiredEpochs.has(epoch)) return reply({ ok: false, reason: 'reset' });

    let p = state.participants.get(id);

    if (p) {
      // fill in any answers the server missed while the phone was offline (server wins on conflict)
      p.answers = { ...cleanAnswers(data.answers), ...p.answers };
    } else {
      // Unknown id: the server restarted. Re-admit unless a reset happened since boot.
      if (resetSinceBoot && epoch !== state.epoch) return reply({ ok: false, reason: 'reset' });
      const name = cleanName(data.name);
      const gender = cleanGender(data.gender);
      if (!name || !gender) return reply({ ok: false, reason: 'invalid' });

      p = { id, name, gender, epoch, team: null, seq: ++seq, answers: cleanAnswers(data.answers) };
      state.participants.set(id, p);

      if (!resetSinceBoot && (data.quizStarted === true || answeredCount(p) > 0)) state.quizStarted = true;

      const team = Number.isInteger(data.team) && data.team >= 0 ? data.team : null;
      const tc = Number.isInteger(data.teamCount) ? data.teamCount : 0;

      if (team != null && !resetSinceBoot) {
        if (!state.formed) {
          state.formed = true;
          state.formedTeamCount = Math.min(MAX_TEAMS, Math.max(tc, team + 1));
          state.teamCount = Math.max(MIN_TEAMS, state.formedTeamCount);
          state.shuffleVersion = Math.max(state.shuffleVersion, 1);
        }
        if (team < state.formedTeamCount) p.team = team;
        else assignLate(p);
      } else {
        assignLate(p);
      }
    }

    attachParticipant(p);
    reply({ ok: true, epoch: p.epoch, me: meFor(p) });
    scheduleBroadcast();
  });

  socket.on('participant:answer', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const id = data && typeof data.id === 'string' ? data.id : null;
    const epoch = data && typeof data.epoch === 'string' ? data.epoch : null;
    if (epoch && retiredEpochs.has(epoch)) return reply({ ok: false, reason: 'reset' });

    const p = id ? state.participants.get(id) : null;
    if (!p) return reply({ ok: false, reason: 'unknown' }); // rejoin will sync answers

    const q = QUESTION_BY_ID.get(data.qid);
    const opt = Number(data.option);
    if (!q || !Number.isInteger(opt) || opt < 0 || opt >= q.options.length) {
      return reply({ ok: false, error: 'Invalid answer.' });
    }

    p.answers[q.id] = opt;
    reply({ ok: true });
    scheduleBroadcast();
  });

  socket.on('dashboard:subscribe', (ack) => {
    socket.join('dashboard');
    if (typeof ack === 'function') ack(publicState());
  });

  socket.on('facilitator:auth', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const pin = data && typeof data.pin === 'string' ? data.pin.trim() : '';
    if (FACILITATOR_PIN && pin !== FACILITATOR_PIN) {
      return reply({ ok: false, pinRequired: true });
    }
    socket.data.facilitator = true;
    socket.join('facilitator');
    reply({ ok: true, pinRequired: !!FACILITATOR_PIN, state: publicState() });
  });

  socket.on('facilitator:startQuiz', (_data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!isFacilitator()) return reply({ ok: false, error: 'Not authorised.' });
    state.quizStarted = true;
    broadcastNow();
    reply({ ok: true });
  });

  socket.on('facilitator:setTeamCount', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!isFacilitator()) return reply({ ok: false, error: 'Not authorised.' });
    state.teamCount = clampTeamCount(data && data.count);
    reply({ ok: true, teamCount: state.teamCount });
    scheduleBroadcast();
  });

  // Used for both "Create teams" and "Reshuffle"
  socket.on('facilitator:form', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!isFacilitator()) return reply({ ok: false, error: 'Not authorised.' });
    state.teamCount = clampTeamCount(data && data.count);
    const result = formTeams(state.teamCount);
    reply(result);
    if (result.ok) broadcastNow();
  });

  socket.on('facilitator:reset', (_data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!isFacilitator()) return reply({ ok: false, error: 'Not authorised.' });

    for (const p of state.participants.values()) retiredEpochs.add(p.epoch);
    retiredEpochs.add(state.epoch);

    state.epoch = uid();
    state.participants.clear();
    state.quizStarted = false;
    state.formed = false;
    state.formedTeamCount = 0;
    state.shuffleVersion = 0;
    resetSinceBoot = true;

    io.to('participants').emit('session:reset');
    io.in('participants').socketsLeave('participants');

    broadcastNow();
    reply({ ok: true });
  });
});

/* ---------- http ---------- */

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    app: 'AI Team Formation',
    participants: state.participants.size,
    quizStarted: state.quizStarted,
    formed: state.formed,
    teams: state.formedTeamCount,
  });
});

app.get('/health', (_req, res) => res.send('ok'));

server.listen(PORT, () => {
  console.log(`AI Team Formation backend running on port ${PORT}`);
});