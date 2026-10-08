import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react';
import { forceSimulation, forceX, forceY, forceCollide, forceManyBody } from 'd3-force';
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  Play,
  Lock,
  Maximize2,
  Minimize2,
  Minus,
  Monitor,
  Plus,
  QrCode,
  RotateCcw,
  Shuffle,
  Sparkles,
  Users,
  WifiOff,
  X,
} from 'lucide-react';

/* =========================================================
   Config
   ========================================================= */

const BACKEND_URL =
  process.env.REACT_APP_BACKEND_URL || 'https://constellation-backend-4d88.onrender.com';
const JOIN_URL = process.env.REACT_APP_JOIN_URL || `${window.location.origin}/`;
const APP_NAME = 'AI Team Formation';
const LOGO = `${process.env.PUBLIC_URL || ''}/logo.png`;
const SESSION_KEY = 'aitf.participant.v1';
const PIN_KEY = 'aitf.facilitator.pin';
const MIN_TEAMS = 2;
const MAX_TEAMS = 100;

const socket = io(BACKEND_URL, {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 800,
  reconnectionDelayMax: 5000,
  timeout: 20000,
});

let cachedQuestions = null;

function useQuestions() {
  const [questions, setQuestions] = useState(cachedQuestions);
  useEffect(() => {
    if (questions) return undefined;
    const get = () =>
      socket.emit('quiz:get', (res) => {
        if (res && Array.isArray(res.questions)) {
          cachedQuestions = res.questions;
          setQuestions(res.questions);
        }
      });
    socket.on('connect', get);
    if (socket.connected) get();
    return () => socket.off('connect', get);
  }, [questions]);
  return questions;
}

const store = {
  get(key) {
    try {
      const v = window.localStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  },
  set(key, val) {
    try {
      window.localStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* storage unavailable */
    }
  },
  del(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  },
};

const TEAM_COLORS = [
  '#E4572E', '#29B6F6', '#FFC857', '#7BD389', '#B388FF',
  '#FF7AB6', '#4DD0C4', '#F4A259', '#8EA8FF', '#C5E063',
  '#FF8A65', '#64B5F6', '#FFD54F', '#81C784', '#BA68C8',
  '#F06292', '#4DB6AC', '#FFB74D', '#9FA8DA', '#AED581',
];
const teamColor = (i) =>
  i < TEAM_COLORS.length ? TEAM_COLORS[i] : `hsl(${Math.round((i * 137.508) % 360)}, 72%, 64%)`;

const NODE_COLOR = '#F4A27B';
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

const firstName = (name = '') => name.trim().split(/\s+/)[0] || name;
const initials = (name = '') => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '')[0] || '').concat((parts[1] || '')[0] || '').toUpperCase() || '?';
};
const shortLabel = (name = '') => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  let first = parts[0] || '';
  if (first.length > 12) first = `${first.slice(0, 11)}.`;
  return parts[1] ? `${first} ${parts[1][0].toUpperCase()}.` : first;
};

function getView() {
  const params = new URLSearchParams(window.location.search);
  const q = (params.get('view') || '').toLowerCase();
  const path = (window.location.pathname.replace(/\/+$/, '').split('/').pop() || '').toLowerCase();
  const v = q || path;
  if (['dashboard', 'screen', 'projector', 'main'].includes(v)) return 'dashboard';
  if (['facilitator', 'admin', 'host'].includes(v)) return 'facilitator';
  return 'participant';
}

function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      const p = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(() => {});
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  } catch {
    /* fullscreen not supported */
  }
}

/* =========================================================
   Shared UI
   ========================================================= */

function useConnection() {
  const [connected, setConnected] = useState(socket.connected);
  useEffect(() => {
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    const onVis = () => {
      if (document.visibilityState === 'visible' && !socket.connected) socket.connect();
    };
    socket.on('connect', on);
    socket.on('disconnect', off);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onVis);
    return () => {
      socket.off('connect', on);
      socket.off('disconnect', off);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onVis);
    };
  }, []);
  return connected;
}

function Brand({ size = 40 }) {
  const [ok, setOk] = useState(true);
  if (!ok) {
    return (
      <div className="brand-fallback" style={{ width: size, height: size }}>
        <Sparkles size={Math.round(size * 0.5)} />
      </div>
    );
  }
  return <img className="brand" src={LOGO} alt="Carnelian" style={{ height: size }} onError={() => setOk(false)} />;
}

function ConnBadge({ connected }) {
  if (connected) return null;
  return (
    <div className="conn-badge">
      <WifiOff size={15} /> Reconnecting...
    </div>
  );
}

function Avatar({ name }) {
  return <span className="avatar">{initials(name)}</span>;
}

/* =========================================================
   Participant
   ========================================================= */

function Participant() {
  const connected = useConnection();
  const questions = useQuestions();
  const [session, setSession] = useState(() => store.get(SESSION_KEY));
  const [me, setMe] = useState(null);
  const [answers, setAnswers] = useState(() => {
    const s = store.get(SESSION_KEY);
    return (s && s.answers) || {};
  });
  const [reviewIdx, setReviewIdx] = useState(null);
  const [name, setName] = useState('');
  const [gender, setGender] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(false);

  const sessionRef = useRef(session);
  const lastShuffle = useRef(null);
  const flashTimer = useRef(null);
  const advanceTimer = useRef(null);
  const picking = useRef(false);


  const persist = useCallback((next) => {
    sessionRef.current = next;
    if (next) store.set(SESSION_KEY, next);
    else store.del(SESSION_KEY);
    setSession(next);
  }, []);

  const applyMe = useCallback(
    (m) => {
      if (!m) return;
      if (m.formed) {
        if (lastShuffle.current !== null && lastShuffle.current !== m.shuffleVersion) {
          setFlash(true);
          clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setFlash(false), 2600);
        }
        lastShuffle.current = m.shuffleVersion;
      } else {
        lastShuffle.current = null;
      }
      setMe(m);
      const merged = { ...(m.answers || {}), ...((sessionRef.current && sessionRef.current.answers) || {}) };
      setAnswers(merged);
      const s = sessionRef.current;
      if (
        s &&
        (s.team !== m.team ||
          s.teamCount !== m.formedTeamCount ||
          s.quizStarted !== m.quizStarted ||
          JSON.stringify(s.answers || {}) !== JSON.stringify(merged))
      ) {
        persist({ ...s, team: m.team, teamCount: m.formedTeamCount, quizStarted: m.quizStarted, answers: merged });
      }
    },
    [persist]
  );

  const kick = useCallback(() => {
    const prev = sessionRef.current;
    if (prev && prev.name) setName(prev.name);
    lastShuffle.current = null;
    clearTimeout(advanceTimer.current);
    picking.current = false;
    setMe(null);
    setFlash(false);
    setAnswers({});
    setReviewIdx(null);
    persist(null);
  }, [persist]);

  useEffect(() => {
    const rejoin = () => {
      const s = sessionRef.current;
      if (!s) return;
      socket.emit('participant:rejoin', s, (res) => {
        if (res && res.ok) applyMe(res.me);
        else if (res && res.ok === false) kick();
      });
    };
    const onMe = (m) => {
      const s = sessionRef.current;
      if (s && m && m.id === s.id) applyMe(m);
    };
    const onReset = () => {
      if (sessionRef.current) kick();
    };
    socket.on('connect', rejoin);
    socket.on('me', onMe);
    socket.on('session:reset', onReset);
    if (socket.connected) rejoin();
    return () => {
      socket.off('connect', rejoin);
      socket.off('me', onMe);
      socket.off('session:reset', onReset);
    };
  }, [applyMe, kick]);

  useEffect(
    () => () => {
      clearTimeout(flashTimer.current);
      clearTimeout(advanceTimer.current);
    },
    []
  );

  const join = (e) => {
    e.preventDefault();
    const n = name.replace(/\s+/g, ' ').trim();
    if (!n) return setError('Please enter your name.');
    if (!gender) return setError('Please select your gender.');
    if (!connected) return setError('Connecting to the server. Try again in a moment.');
    setError('');
    setJoining(true);
    socket.timeout(10000).emit('participant:join', { name: n, gender }, (err, res) => {
      setJoining(false);
      if (err) return setError('The server did not respond. Please try again.');
      if (!res || !res.ok) return setError((res && res.error) || 'Could not join. Please try again.');
      persist({
        id: res.id,
        epoch: res.epoch,
        name: n,
        gender,
        team: res.me ? res.me.team : null,
        teamCount: res.me ? res.me.formedTeamCount : 0,
        quizStarted: res.me ? res.me.quizStarted : false,
        answers: {},
      });
      applyMe(res.me);
    });
  };

  const pick = (idx, option) => {
    const s = sessionRef.current;
    if (!s || !questions || picking.current) return;
    const q = questions[idx];
    const next = { ...answers, [q.id]: option };
    picking.current = true;
    setAnswers(next);
    persist({ ...s, answers: next });
    socket.emit('participant:answer', { id: s.id, epoch: s.epoch, qid: q.id, option }, (res) => {
      if (res && res.reason === 'reset') kick();
    });
    clearTimeout(advanceTimer.current);
    advanceTimer.current = setTimeout(() => {
      picking.current = false;
      const n = idx + 1;
      setReviewIdx(n < questions.length && next[questions[n].id] != null ? n : null);
    }, 320);
  };

  if (!session) {
    return (
      <div className="screen center">
        <div className="card join-card">
          <Brand size={44} />
          <div className="eyebrow">Live session</div>
          <h1 className="title">{APP_NAME}</h1>
          <p className="muted">Enter your details to appear on the main screen.</p>
          <form className="form" onSubmit={join} noValidate>
            <label className="field">
              <span>Your name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Sara Ahmed"
                maxLength={40}
                autoComplete="name"
                autoCapitalize="words"
              />
            </label>
            <div className="field">
              <span>Gender</span>
              <div className="seg">
                <button type="button" className={gender === 'male' ? 'on' : ''} onClick={() => setGender('male')}>
                  Male
                </button>
                <button type="button" className={gender === 'female' ? 'on' : ''} onClick={() => setGender('female')}>
                  Female
                </button>
              </div>
            </div>
            {error && <div className="error">{error}</div>}
            <button className="btn primary block lg" type="submit" disabled={joining}>
              {joining ? (
                <span className="spinner" />
              ) : (
                <>
                  Join <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
        </div>
        <ConnBadge connected={connected} />
      </div>
    );
  }

  const hasTeam = me && me.formed && me.team != null;

  if (hasTeam) {
    const color = teamColor(me.team);
    return (
      <div className="screen center team-screen" style={{ '--team': color }}>
        {flash && (
          <div className="toast ok">
            <Shuffle size={16} /> Teams reshuffled
          </div>
        )}
        <div className="card team-card" key={me.shuffleVersion}>
          <Brand size={32} />
          <div className="eyebrow">Your team</div>
          <div className="team-swatch" />
          <div className="team-badge">Team {me.teamNumber}</div>
          <div className="team-meta">{me.teammates.length + 1} members</div>
          <div className="mates">
            <div className="mate self">
              <Avatar name={session.name} />
              <span className="mate-name">{session.name}</span>
              <em>You</em>
            </div>
            {me.teammates.map((n, i) => (
              <div className="mate" key={`${n}-${i}`}>
                <Avatar name={n} />
                <span className="mate-name">{n}</span>
              </div>
            ))}
          </div>
          <p className="muted small">Find your teammates in the room. This screen updates automatically.</p>
        </div>
        <ConnBadge connected={connected} />
      </div>
    );
  }

  const quizStarted = me ? me.quizStarted : !!session.quizStarted;
  const firstUnanswered = questions ? questions.findIndex((q) => answers[q.id] == null) : -1;
  const answeredTotal = questions ? questions.filter((q) => answers[q.id] != null).length : 0;
  const idx = reviewIdx != null ? reviewIdx : firstUnanswered;

  if (quizStarted && questions && idx !== -1) {
    const q = questions[idx];
    return (
      <div className="screen center">
        <div className="card quiz-card" key={q.id}>
          <div className="quiz-top">
            {idx > 0 ? (
              <button type="button" className="link-btn" onClick={() => setReviewIdx(idx - 1)}>
                <ChevronLeft size={16} /> Back
              </button>
            ) : (
              <span />
            )}
            <span className="quiz-count">
              {idx + 1} of {questions.length}
            </span>
          </div>
          <div className="progress">
            <i style={{ width: `${(answeredTotal / questions.length) * 100}%` }} />
          </div>
          <h2 className="quiz-q">{q.text}</h2>
          <div className="opts">
            {q.options.map((o, i) => {
              const on = answers[q.id] === i;
              return (
                <button type="button" key={o} className={`opt ${on ? 'on' : ''}`} onClick={() => pick(idx, i)}>
                  <span className="opt-key">{String.fromCharCode(65 + i)}</span>
                  <span className="opt-text">{o}</span>
                  {on && <Check size={18} className="opt-check" />}
                </button>
              );
            })}
          </div>
        </div>
        <ConnBadge connected={connected} />
      </div>
    );
  }

  const quizDone = quizStarted && questions && firstUnanswered === -1;

  return (
    <div className="screen center">
      <div className="card wait-card">
        <Brand size={36} />
        <div className="orbit">
          <span className="ring r1" />
          <span className="ring r2" />
          <span className="core" />
        </div>
        <h2 className="title sm">{quizDone ? 'All done' : `You're in, ${firstName(session.name)}`}</h2>
        <p className="muted">
          {quizDone
            ? 'Your answers are in. Watch the main screen, your team will appear here shortly.'
            : 'Your node is live on the main screen. A few quick questions will appear here soon.'}
        </p>
        {quizDone && (
          <button type="button" className="link-btn" onClick={() => setReviewIdx(0)}>
            <ChevronLeft size={16} /> Review my answers
          </button>
        )}
        <div className="stat-pill">
          <Users size={16} /> {me ? me.total : '...'} joined
        </div>
      </div>
      <ConnBadge connected={connected} />
    </div>
  );
}

/* =========================================================
   Facilitator
   ========================================================= */

function Facilitator() {
  const connected = useConnection();
  const [authed, setAuthed] = useState(false);
  const [needPin, setNeedPin] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [st, setSt] = useState(null);
  const [count, setCount] = useState(4);
  const [countText, setCountText] = useState('4');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const countInit = useRef(false);
  const toastTimer = useRef(null);


  const showToast = useCallback((type, text) => {
    setToast({ type, text });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const auth = useCallback((p, manual) => {
    socket.emit('facilitator:auth', { pin: p || '' }, (res) => {
      if (res && res.ok) {
        setAuthed(true);
        setNeedPin(false);
        setPinError('');
        if (p) store.set(PIN_KEY, p);
        setSt(res.state);
        if (!countInit.current && res.state) {
          countInit.current = true;
          setCount(res.state.teamCount);
          setCountText(String(res.state.teamCount));
        }
      } else {
        setAuthed(false);
        setNeedPin(true);
        if (manual) setPinError('Incorrect PIN');
        else store.del(PIN_KEY);
      }
    });
  }, []);

  useEffect(() => {
    const onConnect = () => auth(store.get(PIN_KEY), false);
    const onState = (s) => setSt(s);
    socket.on('connect', onConnect);
    socket.on('state', onState);
    if (socket.connected) onConnect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('state', onState);
    };
  }, [auth]);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const setTeams = (v) => {
    const parsed = parseInt(v, 10);
    const n = clamp(Number.isFinite(parsed) ? parsed : count, MIN_TEAMS, MAX_TEAMS);
    setCount(n);
    setCountText(String(n));
    if (authed) socket.emit('facilitator:setTeamCount', { count: n });
  };

  const participants = st ? st.participants : [];
  const total = participants.length;
  const women = participants.filter((p) => p.gender === 'female').length;
  const doneCount = st ? st.doneCount || 0 : 0;
  const questionCount = st ? st.questionCount || 0 : 0;
  const quizStarted = !!(st && st.quizStarted);
  const effective = total >= 2 ? Math.min(count, total) : count;
  const formed = !!(st && st.formed);

  const startQuiz = () => {
    socket.timeout(10000).emit('facilitator:startQuiz', {}, (err, res) => {
      if (err || !res || !res.ok) return showToast('error', 'Could not start the quiz. Try again.');
      showToast('ok', 'Quiz started');
    });
  };

  const sizeHint = (() => {
    if (total < 2) return 'Waiting for participants to join';
    const lo = Math.floor(total / effective);
    const hi = Math.ceil(total / effective);
    return lo === hi ? `${lo} people per team` : `${lo} to ${hi} people per team`;
  })();

  const teams = useMemo(() => {
    if (!st || !st.formed) return [];
    const arr = Array.from({ length: st.formedTeamCount }, (_, i) => ({ index: i, members: [] }));
    for (const p of st.participants) if (p.team != null && arr[p.team]) arr[p.team].members.push(p);
    return arr;
  }, [st]);

  const form = () => {
    if (busy) return;
    if (total < 2) return showToast('error', 'At least 2 participants are needed.');
    setBusy(true);
    const wasFormed = formed;
    socket.timeout(10000).emit('facilitator:form', { count }, (err, res) => {
      setBusy(false);
      if (err) return showToast('error', 'The server did not respond. Try again.');
      if (!res || !res.ok) return showToast('error', (res && res.error) || 'Could not form teams.');
      showToast('ok', wasFormed ? 'Teams reshuffled' : `${res.teams} teams created`);
    });
  };

  const doReset = () => {
    setConfirmReset(false);
    socket.timeout(10000).emit('facilitator:reset', {}, (err, res) => {
      if (err || !res || !res.ok) return showToast('error', 'Reset failed. Try again.');
      showToast('ok', 'Session reset');
    });
  };

  const dashboardUrl = `${window.location.origin}/?view=dashboard`;

  if (!authed) {
    return (
      <div className="screen center">
        <div className="card join-card">
          <Brand size={40} />
          <div className="eyebrow">Facilitator</div>
          <h1 className="title sm">{APP_NAME}</h1>
          {needPin ? (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                auth(pin.trim(), true);
              }}
            >
              <label className="field">
                <span>Facilitator PIN</span>
                <input
                  type="password"
                  inputMode="numeric"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  autoFocus
                />
              </label>
              {pinError && <div className="error">{pinError}</div>}
              <button className="btn primary block lg" type="submit" disabled={!connected}>
                <Lock size={18} /> Unlock
              </button>
            </form>
          ) : (
            <div className="loading-row">
              <span className="spinner" /> Connecting to server
            </div>
          )}
        </div>
        <ConnBadge connected={connected} />
      </div>
    );
  }

  return (
    <div className="fac">
      <header className="fac-head">
        <div className="fac-brand">
          <Brand size={34} />
          <div>
            <div className="fac-title">{APP_NAME}</div>
            <div className="fac-sub">Facilitator</div>
          </div>
        </div>
        <span className={`live ${connected ? '' : 'off'}`}>
          <i /> {connected ? 'Live' : 'Offline'}
        </span>
      </header>

      <section className="stats">
        <div className="stat">
          <b>{total}</b>
          <span>Joined</span>
        </div>
        <div className="stat">
          <b>{women}</b>
          <span>Women</span>
        </div>
        <div className="stat">
          <b>{quizStarted ? doneCount : '-'}</b>
          <span>Quiz done</span>
        </div>
        <div className="stat">
          <b>{formed ? st.formedTeamCount : '-'}</b>
          <span>Teams</span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title row">
          <span>Quiz</span>
          <span className={`count-chip ${quizStarted ? 'live-chip' : ''}`}>
            {quizStarted ? 'Live' : `${questionCount} questions`}
          </span>
        </div>
        {quizStarted ? (
          <>
            <div className="progress lg">
              <i style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }} />
            </div>
            <div className="hint">
              {doneCount} of {total} finished. Late joiners go straight into the quiz.
            </div>
          </>
        ) : (
          <button className="btn outline block lg" type="button" onClick={startQuiz} disabled={!connected}>
            <Play size={18} /> Start quiz
          </button>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">How many teams?</div>
        <div className="stepper">
          <button type="button" onClick={() => setTeams(count - 1)} disabled={count <= MIN_TEAMS} aria-label="Fewer teams">
            <Minus size={22} />
          </button>
          <input
            type="number"
            inputMode="numeric"
            min={MIN_TEAMS}
            max={MAX_TEAMS}
            value={countText}
            onChange={(e) => setCountText(e.target.value)}
            onBlur={() => setTeams(countText)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <button type="button" onClick={() => setTeams(count + 1)} disabled={count >= MAX_TEAMS} aria-label="More teams">
            <Plus size={22} />
          </button>
        </div>
        <div className="hint">{sizeHint}</div>
        {total >= 2 && count > total && (
          <div className="note">Only {total} participants have joined, so {total} teams will be created.</div>
        )}
        {women > 0 && total >= 2 && women < effective && (
          <div className="note">
            {women} {women === 1 ? 'woman' : 'women'} for {effective} teams. Some teams will not include a woman.
          </div>
        )}
        {formed && count !== st.formedTeamCount && (
          <div className="note accent">Tap Reshuffle to rebuild as {effective} teams.</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title row">
          <span>{formed ? 'Teams' : 'Joined so far'}</span>
          <span className="count-chip">{formed ? `${teams.length} teams` : `${total} people`}</span>
        </div>
        {formed ? (
          <div className="team-list">
            {teams.map((t) => {
              const tw = t.members.filter((m) => m.gender === 'female').length;
              return (
                <div className="team-item" key={t.index} style={{ '--team': teamColor(t.index) }}>
                  <div className="team-item-head">
                    <span className="dot" />
                    <b>Team {t.index + 1}</b>
                    <span className="team-item-meta">
                      {t.members.length} members, {tw} {tw === 1 ? 'woman' : 'women'}
                    </span>
                  </div>
                  <div className="chips">
                    {t.members.map((m) => (
                      <span className="chip" key={m.id}>
                        {m.name}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : total === 0 ? (
          <div className="empty">
            <QrCode size={22} />
            <span>Open the main screen. Participants join by scanning its QR code.</span>
          </div>
        ) : (
          <div className="chips scroll">
            {participants
              .slice()
              .reverse()
              .map((p) => (
                <span className="chip" key={p.id}>
                  {p.name}
                </span>
              ))}
          </div>
        )}
      </section>

      <section className="panel quiet">
        <a className="btn ghost block" href={dashboardUrl} target="_blank" rel="noreferrer">
          <Monitor size={18} /> Open main screen
        </a>
        <button className="btn danger block" type="button" onClick={() => setConfirmReset(true)}>
          <RotateCcw size={18} /> Reset session
        </button>
      </section>

      <div className="action-bar">
        <button className="btn primary block lg" type="button" onClick={form} disabled={busy || total < 2 || !connected}>
          {busy ? (
            <span className="spinner" />
          ) : formed ? (
            <>
              <Shuffle size={20} /> Reshuffle teams
            </>
          ) : (
            <>
              <Sparkles size={20} /> {total >= 2 ? `Create ${effective} teams` : 'Create teams'}
            </>
          )}
        </button>
      </div>

      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.type === 'ok' ? <Sparkles size={16} /> : <X size={16} />} {toast.text}
        </div>
      )}

      {confirmReset && (
        <div className="modal" onClick={() => setConfirmReset(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-icon">
              <RotateCcw size={22} />
            </div>
            <h3>Reset the session?</h3>
            <p className="muted">
              This removes all {total} participants and every team. Everyone is sent back to the join screen.
            </p>
            <div className="modal-actions">
              <button className="btn ghost" type="button" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
              <button className="btn danger solid" type="button" onClick={doReset}>
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* =========================================================
   Dashboard engine (canvas + d3-force)
   ========================================================= */

function createEngine(canvas, container) {
  const ctx = canvas.getContext('2d');
  const nodes = [];
  const byId = new Map();
  let W = 1;
  let H = 1;
  let dpr = 1;
  let formed = false;
  let teamCount = 0;
  let cells = [];
  let teams = [];
  let radius = 12;
  let labelSize = 12;
  let first = true;
  let raf = 0;

  const PAD_X = 40;
  const TOP = 132;
  const BOTTOM = 40;
  const CELL_HEAD = 34;

  const stars = Array.from({ length: 150 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: Math.random() * 1.2 + 0.3,
    p: Math.random() * TAU,
    s: 0.4 + Math.random() * 1.2,
  }));

  const area = () => ({
    x: PAD_X,
    y: TOP,
    w: Math.max(120, W - PAD_X * 2),
    h: Math.max(120, H - TOP - BOTTOM),
  });

  const cellOf = (n) => (formed && n.team != null ? cells[n.team] : null);

  function wander() {
    const s = formed ? 0.035 : 0.2;
    for (const n of nodes) {
      n.theta += (Math.random() - 0.5) * 0.3;
      n.vx += Math.cos(n.theta) * s;
      n.vy += Math.sin(n.theta) * s;
    }
  }

  function bounds() {
    const a = area();
    for (const n of nodes) {
      const c = cellOf(n);
      let x0;
      let x1;
      let y0;
      let y1;
      if (c) {
        x0 = c.x + radius + 10;
        x1 = c.x + c.w - radius - 10;
        y0 = c.y + CELL_HEAD + radius;
        y1 = c.y + c.h - radius - 10;
      } else {
        x0 = a.x + radius;
        x1 = a.x + a.w - radius;
        y0 = a.y + radius;
        y1 = a.y + a.h - radius;
      }
      if (x1 < x0) x0 = x1 = (x0 + x1) / 2;
      if (y1 < y0) y0 = y1 = (y0 + y1) / 2;
      const k = c ? 0.04 : 0.12;
      const cap = c ? 0.6 : 2;
      if (n.x < x0) {
        n.vx += Math.min((x0 - n.x) * k, cap);
        if (!c) n.theta = rand(-0.8, 0.8);
      } else if (n.x > x1) {
        n.vx -= Math.min((n.x - x1) * k, cap);
        if (!c) n.theta = Math.PI + rand(-0.8, 0.8);
      }
      if (n.y < y0) {
        n.vy += Math.min((y0 - n.y) * k, cap);
        if (!c) n.theta = Math.PI / 2 + rand(-0.8, 0.8);
      } else if (n.y > y1) {
        n.vy -= Math.min((n.y - y1) * k, cap);
        if (!c) n.theta = -Math.PI / 2 + rand(-0.8, 0.8);
      }
    }
  }

  const sim = forceSimulation(nodes)
    .alpha(0.3)
    .alphaDecay(0)
    .velocityDecay(0.22)
    .force('charge', forceManyBody().strength(-8).distanceMax(120))
    .force('collide', forceCollide().radius(() => radius + 6).strength(0.8).iterations(2))
    .force('x', forceX())
    .force('y', forceY())
    .force('wander', wander)
    .force('bounds', bounds)
    .stop();

  function applyForces() {
    sim
      .force('x')
      .x((n) => (cellOf(n) ? cellOf(n).cx : n.x))
      .strength((n) => (cellOf(n) ? 0.055 : 0));
    sim
      .force('y')
      .y((n) => (cellOf(n) ? cellOf(n).cy : n.y))
      .strength((n) => (cellOf(n) ? 0.055 : 0));
    sim.force('collide').radius(() => radius + (formed ? 4 : 6));
    sim.force('charge').strength(formed ? -14 : -8);
    sim.velocityDecay(formed ? 0.3 : 0.22);
  }

  function layout() {
    const a = area();
    const N = Math.max(1, nodes.length);
    radius = clamp(Math.sqrt((a.w * a.h) / N) * 0.1, 5, 15);
    cells = [];
    if (formed && teamCount > 0) {
      let best = null;
      for (let cols = 1; cols <= teamCount; cols++) {
        const rows = Math.ceil(teamCount / cols);
        const cw = a.w / cols;
        const ch = a.h / rows;
        const score = Math.min(cw / 1.35, ch);
        if (!best || score > best.score) best = { cols, rows, cw, ch, score };
      }
      const { cols, rows, cw, ch } = best;
      const gap = clamp(Math.min(cw, ch) * 0.06, 8, 22);
      for (let i = 0; i < teamCount; i++) {
        const row = Math.floor(i / cols);
        const col = i % cols;
        const inRow = row === rows - 1 ? teamCount - row * cols : cols;
        const off = ((cols - inRow) * cw) / 2;
        const x = a.x + off + col * cw + gap / 2;
        const y = a.y + row * ch + gap / 2;
        const w = cw - gap;
        const h = ch - gap;
        cells.push({ x, y, w, h, cx: x + w / 2, cy: y + CELL_HEAD + (h - CELL_HEAD) / 2 });
      }
      const maxTeam = Math.max(1, ...teams.map((t) => t.length));
      const c0 = cells[0];
      const per = Math.sqrt((c0.w * Math.max(20, c0.h - CELL_HEAD)) / maxTeam);
      radius = clamp(Math.min(radius, per * 0.17), 4, 15);
    }
    labelSize = clamp(radius * 1.05, 9, 15);
  }

  function resize() {
    const r = container.getBoundingClientRect();
    W = Math.max(1, r.width);
    H = Math.max(1, r.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    layout();
    applyForces();
  }

  function update(st) {
    const now = performance.now();
    const seen = new Set();
    const a = area();
    for (const p of st.participants) {
      seen.add(p.id);
      let n = byId.get(p.id);
      if (!n) {
        n = {
          id: p.id,
          x: a.x + Math.random() * a.w,
          y: a.y + Math.random() * a.h,
          vx: 0,
          vy: 0,
          theta: Math.random() * TAU,
          born: first ? now - 5000 : now,
        };
        byId.set(p.id, n);
        nodes.push(n);
      }
      n.name = p.name;
      n.label = shortLabel(p.name);
      n.team = p.team;
      n.done = !!p.done;
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (!seen.has(nodes[i].id)) {
        byId.delete(nodes[i].id);
        nodes.splice(i, 1);
      }
    }
    formed = !!st.formed && st.formedTeamCount > 0;
    teamCount = formed ? st.formedTeamCount : 0;
    teams = Array.from({ length: teamCount }, () => []);
    if (formed) for (const n of nodes) if (n.team != null && teams[n.team]) teams[n.team].push(n);
    layout();
    sim.nodes(nodes);
    applyForces();
    first = false;
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  const easeOutBack = (x) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  };

  function draw(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // stars
    ctx.fillStyle = '#CFD8FF';
    for (const s of stars) {
      ctx.globalAlpha = 0.12 + 0.3 * (0.5 + 0.5 * Math.sin(t * 0.001 * s.s + s.p));
      ctx.beginPath();
      ctx.arc(s.x * W, s.y * H, s.r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // team blocks
    if (formed) {
      cells.forEach((c, i) => {
        const col = teamColor(i);
        const fs = clamp(Math.min(c.w, c.h) * 0.085, 12, 18);
        ctx.globalAlpha = 0.07;
        ctx.fillStyle = col;
        roundRect(c.x, c.y, c.w, c.h, 16);
        ctx.fill();
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        roundRect(c.x, c.y, c.w, c.h, 16);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillStyle = col;
        ctx.font = `600 ${fs}px "Space Grotesk", Inter, sans-serif`;
        ctx.fillText(`Team ${i + 1}`, c.x + 14, c.y + CELL_HEAD / 2 + 2);
        ctx.textAlign = 'right';
        ctx.globalAlpha = 0.65;
        ctx.fillStyle = '#E8ECF6';
        ctx.font = `500 ${fs - 2}px Inter, sans-serif`;
        ctx.fillText(`${teams[i] ? teams[i].length : 0}`, c.x + c.w - 14, c.y + CELL_HEAD / 2 + 2);
      });
      ctx.globalAlpha = 1;
    }

    // links
    ctx.lineWidth = 1;
    if (formed) {
      for (let ti = 0; ti < teams.length; ti++) {
        const m = teams[ti];
        const c = cells[ti];
        if (!c) continue;
        const diag = Math.hypot(c.w, c.h);
        ctx.strokeStyle = teamColor(ti);
        for (let i = 0; i < m.length; i++) {
          for (let j = i + 1; j < m.length; j++) {
            const a = m[i];
            const b = m[j];
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            if (m.length > 14 && d > radius * 9) continue;
            ctx.globalAlpha = 0.34 * clamp(1 - d / (diag * 1.4), 0.1, 1);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
    } else {
      const D = radius * 11;
      const D2 = D * D;
      ctx.strokeStyle = NODE_COLOR;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          if (dx > D || dx < -D) continue;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > D2) continue;
          ctx.globalAlpha = (1 - Math.sqrt(d2) / D) * 0.38;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;

    // nodes
    for (const n of nodes) {
      const col = cellOf(n) ? teamColor(n.team) : NODE_COLOR;
      const age = t - n.born;
      const grow = age < 650 ? easeOutBack(clamp(age / 650, 0, 1)) : 1;
      const r = Math.max(0.5, radius * grow);

      if (age > 0 && age < 1700) {
        const p = clamp(age / 1700, 0, 1);
        ctx.globalAlpha = (1 - p) * 0.7;
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius + p * radius * 6, 0, TAU);
        ctx.stroke();
      }

      ctx.fillStyle = col;
      ctx.globalAlpha = 0.16;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r * 2.3, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, TAU);
      ctx.fill();
      if (n.done && !cellOf(n)) {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = '#7BD389';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 3.5, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(n.x - r * 0.3, n.y - r * 0.3, r * 0.28, 0, TAU);
      ctx.fill();
    }

    // labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const n of nodes) {
      const age = t - n.born;
      const fresh = age < 3000;
      const fs = fresh ? labelSize * 1.2 : labelSize;
      ctx.font = `${fresh ? 700 : 500} ${fs}px Inter, sans-serif`;
      const y = n.y + radius + fs * 0.95;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(7,10,20,0.85)';
      ctx.strokeText(n.label, n.x, y);
      ctx.globalAlpha = fresh ? 1 : 0.86;
      ctx.fillStyle = '#EEF1F8';
      ctx.fillText(n.label, n.x, y);
    }
    ctx.globalAlpha = 1;
  }

  function frame(t) {
    raf = requestAnimationFrame(frame); // schedule first so one bad frame never stops the screen
    try {
      sim.tick();
      for (const n of nodes) {
        n.x = clamp(n.x, 0, W);
        n.y = clamp(n.y, 0, H);
      }
      draw(t);
    } catch (err) {
      ctx.globalAlpha = 1;
    }
  }

  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  raf = requestAnimationFrame(frame);

  return {
    update,
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      sim.stop();
    },
  };
}

/* =========================================================
   Dashboard
   ========================================================= */

function Dashboard() {
  const connected = useConnection();
  const [st, setSt] = useState(null);
  const [qrOpen, setQrOpen] = useState(true);
  const [full, setFull] = useState(false);
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const latest = useRef(null);

  useEffect(() => {
    const eng = createEngine(canvasRef.current, stageRef.current);
    engineRef.current = eng;
    if (latest.current) eng.update(latest.current);
    return () => {
      eng.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const sub = () =>
      socket.emit('dashboard:subscribe', (s) => {
        if (s) setSt(s);
      });
    const onState = (s) => setSt(s);
    socket.on('connect', sub);
    socket.on('state', onState);
    if (socket.connected) sub();
    return () => {
      socket.off('connect', sub);
      socket.off('state', onState);
    };
  }, []);

  useEffect(() => {
    if (!st) return;
    latest.current = st;
    if (engineRef.current) engineRef.current.update(st);
  }, [st]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'q' || e.key === 'Q') setQrOpen((o) => !o);
      if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    };
    const onFs = () => setFull(!!document.fullscreenElement);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, []);

  const total = st ? st.total : 0;
  const formed = !!(st && st.formed);
  const quizLive = !!(st && st.quizStarted) && !formed;
  const subtitle = formed
    ? `${st.formedTeamCount} teams formed from ${total} participants`
    : quizLive
    ? 'Answer the questions on your phone. A green ring means you are done.'
    : 'Scan the QR code to join the formation';

  return (
    <div className="dash">
      <div className="dash-stage" ref={stageRef}>
        <canvas ref={canvasRef} className="dash-canvas" />
        <div className="dash-head">
          <Brand size={46} />
          <div>
            <h1>{APP_NAME}</h1>
            <p>{subtitle}</p>
          </div>
        </div>
        <div className="dash-tools">
          <div className="live-count">
            <span className="pulse-dot" />
            <b>{total}</b> joined
          </div>
          {quizLive && (
            <div className="live-count">
              <ListChecks size={18} />
              <b>{st.doneCount}</b> done
            </div>
          )}
          {!qrOpen && (
            <button className="tool-btn" type="button" onClick={() => setQrOpen(true)}>
              <QrCode size={18} /> Show QR
            </button>
          )}
          <button className="tool-btn icon" type="button" onClick={toggleFullscreen} aria-label="Toggle fullscreen">
            {full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
        </div>
        {!connected && (
          <div className="dash-conn">
            <WifiOff size={16} /> Reconnecting to server
          </div>
        )}
      </div>

      <aside className={`qr-panel ${qrOpen ? 'open' : ''}`} aria-hidden={!qrOpen}>
        <div className="qr-inner">
          <button className="qr-close" type="button" onClick={() => setQrOpen(false)} aria-label="Hide QR code">
            <ChevronRight size={20} />
          </button>
          <div className="eyebrow">Join live</div>
          <h2>Scan to enter the formation</h2>
          <div className="qr-box">
            <QRCodeSVG value={JOIN_URL} size={240} level="M" bgColor="#FFFFFF" fgColor="#0B1020" />
          </div>
          <div className="qr-url">{JOIN_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')}</div>
          <div className="qr-steps">
            <div>
              <span>1</span> Open your phone camera
            </div>
            <div>
              <span>2</span> Scan and enter your name
            </div>
            <div>
              <span>3</span> Find your node on screen
            </div>
          </div>
          <div className="qr-count">
            <span className="pulse-dot" /> <b>{total}</b> {total === 1 ? 'person' : 'people'} in the room
          </div>
        </div>
      </aside>
    </div>
  );
}

/* =========================================================
   App
   ========================================================= */

export default function App() {
  const view = useMemo(getView, []);
  useEffect(() => {
    document.title =
      view === 'dashboard' ? `${APP_NAME} | Main Screen` : view === 'facilitator' ? `${APP_NAME} | Facilitator` : APP_NAME;
  }, [view]);

  return (
    <>
      <style>{CSS}</style>
      {view === 'dashboard' ? <Dashboard /> : view === 'facilitator' ? <Facilitator /> : <Participant />}
    </>
  );
}

/* =========================================================
   Styles
   ========================================================= */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap');

:root{
  --bg:#070A14;
  --panel:rgba(255,255,255,0.045);
  --panel-b:rgba(255,255,255,0.09);
  --text:#EEF1F8;
  --muted:#9AA3B8;
  --accent:#E4572E;
  --accent2:#F4A27B;
  --ok:#4ADE80;
  --danger:#F87171;
  --team:#E4572E;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body,#root{height:100%;margin:0}
body{
  background:
    radial-gradient(1100px 760px at 12% -10%, #1A1F3D 0%, transparent 60%),
    radial-gradient(900px 700px at 110% 110%, #2B1220 0%, transparent 55%),
    var(--bg);
  color:var(--text);
  font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;
}
button{font-family:inherit}
h1,h2,h3{font-family:'Space Grotesk',Inter,sans-serif;margin:0}

/* ---------- generic ---------- */
.screen{min-height:100%;padding:24px 16px 40px;display:flex;flex-direction:column}
.screen.center{align-items:center;justify-content:center}
.card{
  width:100%;max-width:440px;background:var(--panel);border:1px solid var(--panel-b);
  border-radius:22px;padding:28px 22px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  box-shadow:0 30px 80px rgba(0,0,0,0.35);
  display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;
  animation:rise .45s ease both;
}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.brand{width:auto;object-fit:contain;display:block}
.brand-fallback{border-radius:12px;display:grid;place-items:center;background:rgba(228,87,46,0.15);color:var(--accent2)}
.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent2);font-weight:600;margin-top:6px}
.title{font-size:30px;line-height:1.1;font-weight:700;letter-spacing:-0.01em}
.title.sm{font-size:24px}
.muted{color:var(--muted);margin:0;line-height:1.5;font-size:15px}
.muted.small{font-size:13px}
.form{width:100%;display:flex;flex-direction:column;gap:16px;margin-top:12px;text-align:left}
.field{display:flex;flex-direction:column;gap:8px}
.field>span{font-size:13px;color:var(--muted);font-weight:500}
.field input{
  width:100%;height:52px;border-radius:14px;border:1px solid var(--panel-b);background:rgba(0,0,0,0.25);
  color:var(--text);padding:0 16px;font-size:16px;outline:none;transition:border-color .2s, box-shadow .2s;
}
.field input:focus{border-color:var(--accent2);box-shadow:0 0 0 4px rgba(244,162,123,0.15)}
.seg{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.seg button{
  height:50px;border-radius:14px;border:1px solid var(--panel-b);background:rgba(0,0,0,0.2);
  color:var(--text);font-size:15px;font-weight:500;cursor:pointer;transition:all .2s;
}
.seg button.on{border-color:var(--accent);background:rgba(228,87,46,0.18);color:#fff;box-shadow:inset 0 0 0 1px var(--accent)}
.error{background:rgba(248,113,113,0.12);border:1px solid rgba(248,113,113,0.35);color:#FECACA;padding:10px 12px;border-radius:12px;font-size:14px}

.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;height:48px;padding:0 18px;
  border-radius:14px;border:1px solid transparent;font-size:15px;font-weight:600;cursor:pointer;
  text-decoration:none;color:var(--text);transition:transform .15s, opacity .2s, background .2s;
}
.btn:active{transform:scale(0.98)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.block{width:100%}
.btn.lg{height:56px;font-size:16px;border-radius:16px}
.btn.primary{background:linear-gradient(135deg,#E4572E,#C2410C);color:#fff;box-shadow:0 12px 30px rgba(228,87,46,0.35)}
.btn.ghost{background:rgba(255,255,255,0.05);border-color:var(--panel-b)}
.btn.danger{background:transparent;border-color:rgba(248,113,113,0.4);color:#FCA5A5}
.btn.danger.solid{background:#DC2626;border-color:#DC2626;color:#fff}

.spinner{width:20px;height:20px;border-radius:50%;border:2.5px solid rgba(255,255,255,0.35);border-top-color:#fff;animation:spin .8s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-row{display:flex;align-items:center;gap:10px;color:var(--muted);margin-top:14px}

.conn-badge{
  position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;
  background:rgba(30,20,20,0.9);border:1px solid rgba(248,113,113,0.35);color:#FECACA;
  padding:8px 14px;border-radius:999px;font-size:13px;z-index:50;
}
.toast{
  position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:8px;
  padding:10px 16px;border-radius:999px;font-size:14px;font-weight:600;animation:drop .3s ease both;
  background:rgba(20,26,44,0.95);border:1px solid var(--panel-b);box-shadow:0 12px 30px rgba(0,0,0,0.4);
}
.toast.ok{color:#BBF7D0;border-color:rgba(74,222,128,0.35)}
.toast.error{color:#FECACA;border-color:rgba(248,113,113,0.4)}
@keyframes drop{from{opacity:0;transform:translate(-50%,-10px)}to{opacity:1;transform:translate(-50%,0)}}

/* ---------- participant ---------- */
.orbit{position:relative;width:150px;height:150px;margin:14px 0 6px}
.orbit .core{position:absolute;inset:58px;border-radius:50%;background:var(--accent2);box-shadow:0 0 30px 8px rgba(244,162,123,0.45);animation:breathe 2.4s ease-in-out infinite}
.orbit .ring{position:absolute;border-radius:50%;border:1px solid rgba(244,162,123,0.35)}
.orbit .r1{inset:30px;animation:ping 2.4s ease-out infinite}
.orbit .r2{inset:0;animation:ping 2.4s ease-out .8s infinite}
@keyframes breathe{50%{transform:scale(1.12)}}
@keyframes ping{0%{transform:scale(.6);opacity:1}100%{transform:scale(1.15);opacity:0}}
.stat-pill{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:rgba(255,255,255,0.06);border:1px solid var(--panel-b);font-size:14px;margin-top:8px}

.team-screen{background:radial-gradient(600px 420px at 50% 18%, rgba(255,255,255,0.05), transparent 70%)}
.team-screen{background:radial-gradient(600px 420px at 50% 18%, color-mix(in srgb, var(--team) 22%, transparent), transparent 70%)}
.team-card{
  border-color:var(--team);background:rgba(255,255,255,0.045);background:color-mix(in srgb, var(--team) 9%, rgba(255,255,255,0.03));
  box-shadow:0 0 0 1px var(--team), 0 0 40px -6px var(--team), 0 30px 80px rgba(0,0,0,0.45);
  animation:pop .7s cubic-bezier(.2,1.4,.4,1) both;
}
@keyframes pop{0%{opacity:0;transform:scale(.85);filter:brightness(2.2)}60%{filter:brightness(1.3)}100%{opacity:1;transform:none;filter:none}}
.team-swatch{width:64px;height:64px;border-radius:50%;margin:6px 0 2px;background:var(--team);
  box-shadow:0 0 0 6px rgba(255,255,255,0.06), 0 0 28px 6px var(--team), 0 0 70px 14px var(--team);animation:swatch 2.6s ease-in-out infinite}
@keyframes swatch{50%{transform:scale(1.07);box-shadow:0 0 0 8px rgba(255,255,255,0.08), 0 0 36px 10px var(--team), 0 0 90px 20px var(--team)}}
.team-badge{font-family:'Space Grotesk',Inter,sans-serif;font-size:52px;font-weight:700;line-height:1;color:var(--team);letter-spacing:-0.02em;margin-top:6px;text-shadow:0 0 18px var(--team), 0 0 42px var(--team)}
.team-meta{color:var(--muted);font-size:14px}
.mates{width:100%;display:flex;flex-direction:column;gap:8px;margin:14px 0 6px;text-align:left}
.mate{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:14px;background:rgba(0,0,0,0.22);border:1px solid var(--panel-b)}
.mate.self{border-color:var(--team)}
.mate em{margin-left:auto;font-style:normal;font-size:12px;font-weight:600;color:var(--team);text-transform:uppercase;letter-spacing:.08em}
.mate-name{font-size:15px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.avatar{width:34px;height:34px;flex:0 0 34px;border-radius:50%;display:grid;place-items:center;font-size:13px;font-weight:700;color:#0B1020;background:var(--team)}

.quiz-card{gap:14px;align-items:stretch;text-align:left}
.quiz-top{display:flex;align-items:center;justify-content:space-between;min-height:28px}
.quiz-count{font-size:13px;font-weight:600;color:var(--muted);letter-spacing:.04em}
.link-btn{display:inline-flex;align-items:center;gap:4px;background:none;border:none;color:var(--accent2);font-size:14px;font-weight:600;cursor:pointer;padding:4px 0}
.progress{height:6px;border-radius:999px;background:rgba(255,255,255,0.08);overflow:hidden}
.progress.lg{height:10px}
.progress i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#E4572E,#F4A27B);transition:width .4s ease}
.quiz-q{font-size:23px;line-height:1.25;font-weight:700;margin:6px 0 4px}
.opts{display:flex;flex-direction:column;gap:10px}
.opt{
  display:flex;align-items:center;gap:12px;width:100%;min-height:56px;padding:12px 14px;border-radius:16px;
  border:1px solid var(--panel-b);background:rgba(0,0,0,0.22);color:var(--text);font-size:16px;font-weight:500;
  text-align:left;cursor:pointer;transition:border-color .15s, background .15s, transform .1s;
}
.opt:active{transform:scale(.985)}
.opt.on{border-color:var(--accent);background:rgba(228,87,46,0.16);box-shadow:inset 0 0 0 1px var(--accent)}
.opt-key{width:28px;height:28px;flex:0 0 28px;border-radius:9px;display:grid;place-items:center;font-size:13px;font-weight:700;background:rgba(255,255,255,0.08);color:var(--muted)}
.opt.on .opt-key{background:var(--accent);color:#fff}
.opt-text{flex:1}
.opt-check{color:var(--accent2);flex:0 0 auto}

/* ---------- facilitator ---------- */
.btn.outline{background:rgba(228,87,46,0.08);border-color:rgba(228,87,46,0.55);color:#FED7AA}
.live-chip{color:#BBF7D0;background:rgba(74,222,128,0.12)}
.fac{max-width:640px;margin:0 auto;padding:16px 16px 120px}
.fac-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 2px 16px}
.fac-brand{display:flex;align-items:center;gap:12px;min-width:0}
.fac-title{font-family:'Space Grotesk',Inter,sans-serif;font-weight:700;font-size:18px;white-space:nowrap}
.fac-sub{color:var(--muted);font-size:13px}
.live{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:#BBF7D0;padding:6px 12px;border-radius:999px;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3)}
.live i{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 0 rgba(74,222,128,0.6);animation:livepulse 1.8s infinite}
.live.off{color:#FECACA;background:rgba(248,113,113,0.1);border-color:rgba(248,113,113,0.3)}
.live.off i{background:var(--danger);animation:none}
@keyframes livepulse{70%{box-shadow:0 0 0 8px rgba(74,222,128,0)}100%{box-shadow:0 0 0 0 rgba(74,222,128,0)}}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.stat{background:var(--panel);border:1px solid var(--panel-b);border-radius:16px;padding:12px 6px;text-align:center}
.stat b{display:block;font-family:'Space Grotesk',Inter,sans-serif;font-size:24px;line-height:1.1}
.stat span{font-size:12px;color:var(--muted)}
.panel{background:var(--panel);border:1px solid var(--panel-b);border-radius:20px;padding:16px;margin-bottom:12px;display:flex;flex-direction:column;gap:12px}
.panel.quiet{background:transparent;border:none;padding:4px 0}
.panel-title{font-weight:600;font-size:15px}
.panel-title.row{display:flex;align-items:center;justify-content:space-between}
.count-chip{font-size:12px;font-weight:500;color:var(--muted);padding:4px 10px;border-radius:999px;background:rgba(255,255,255,0.06)}
.stepper{display:grid;grid-template-columns:64px 1fr 64px;gap:10px}
.stepper button{height:64px;border-radius:16px;border:1px solid var(--panel-b);background:rgba(255,255,255,0.06);color:var(--text);display:grid;place-items:center;cursor:pointer}
.stepper button:disabled{opacity:.35}
.stepper button:active{transform:scale(.96)}
.stepper input{
  height:64px;width:100%;text-align:center;border-radius:16px;border:1px solid var(--panel-b);background:rgba(0,0,0,0.25);
  color:var(--text);font-family:'Space Grotesk',Inter,sans-serif;font-size:32px;font-weight:700;outline:none;-moz-appearance:textfield;
}
.stepper input::-webkit-outer-spin-button,.stepper input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.stepper input:focus{border-color:var(--accent2)}
.hint{text-align:center;color:var(--muted);font-size:14px}
.note{font-size:13px;color:#FDE68A;background:rgba(253,230,138,0.08);border:1px solid rgba(253,230,138,0.25);padding:8px 12px;border-radius:12px}
.note.accent{color:#FED7AA;background:rgba(228,87,46,0.1);border-color:rgba(228,87,46,0.35)}
.team-list{display:grid;grid-template-columns:1fr;gap:10px}
@media (min-width:600px){.team-list{grid-template-columns:1fr 1fr}}
.team-item{border:1px solid var(--panel-b);border-left:3px solid var(--team);border-radius:14px;padding:12px;background:rgba(0,0,0,0.18)}
.team-item-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.team-item-head .dot{width:10px;height:10px;border-radius:50%;background:var(--team)}
.team-item-head b{color:var(--team);font-family:'Space Grotesk',Inter,sans-serif}
.team-item-meta{margin-left:auto;font-size:12px;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chips.scroll{max-height:240px;overflow:auto}
.chip{font-size:13px;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,0.07);border:1px solid var(--panel-b)}
.empty{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:14px;padding:6px 2px}
.action-bar{
  position:fixed;left:0;right:0;bottom:0;z-index:40;padding:12px 16px calc(12px + env(safe-area-inset-bottom));
  background:linear-gradient(to top, rgba(7,10,20,0.98) 60%, rgba(7,10,20,0));
}
.action-bar .btn{max-width:608px;margin:0 auto;display:flex}
.modal{position:fixed;inset:0;z-index:70;background:rgba(3,5,12,0.7);backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;padding:16px}
@media (min-width:600px){.modal{align-items:center}}
.modal-card{width:100%;max-width:420px;background:#121829;border:1px solid var(--panel-b);border-radius:22px;padding:22px;text-align:center;display:flex;flex-direction:column;gap:10px;animation:rise .25s ease both}
.modal-icon{width:48px;height:48px;border-radius:14px;display:grid;place-items:center;margin:0 auto 4px;background:rgba(248,113,113,0.12);color:#FCA5A5}
.modal-card h3{font-size:20px}
.modal-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px}

/* ---------- dashboard ---------- */
.dash{position:fixed;inset:0;display:flex;overflow:hidden}
.dash-stage{position:relative;flex:1;min-width:0;height:100%}
.dash-canvas{position:absolute;inset:0;display:block}
.dash-head{position:absolute;top:28px;left:40px;display:flex;align-items:center;gap:18px;pointer-events:none}
.dash-head h1{font-size:34px;font-weight:700;letter-spacing:-0.01em}
.dash-head p{margin:4px 0 0;color:var(--muted);font-size:16px}
.dash-tools{position:absolute;top:32px;right:28px;display:flex;align-items:center;gap:10px}
.live-count{display:flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;background:rgba(255,255,255,0.06);border:1px solid var(--panel-b);font-size:15px}
.live-count b{font-family:'Space Grotesk',Inter,sans-serif;font-size:18px}
.pulse-dot{width:9px;height:9px;border-radius:50%;background:var(--ok);display:inline-block;animation:livepulse 1.8s infinite}
.tool-btn{display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 14px;border-radius:999px;border:1px solid var(--panel-b);background:rgba(255,255,255,0.06);color:var(--text);font-size:14px;font-weight:500;cursor:pointer;opacity:.75;transition:opacity .2s}
.tool-btn:hover{opacity:1}
.tool-btn.icon{width:42px;padding:0;justify-content:center}
.dash-conn{position:absolute;left:40px;bottom:20px;display:flex;align-items:center;gap:8px;color:#FECACA;font-size:14px;background:rgba(30,20,20,0.85);border:1px solid rgba(248,113,113,0.35);padding:8px 14px;border-radius:999px}

.qr-panel{width:0;flex:0 0 auto;height:100%;overflow:hidden;transition:width .45s cubic-bezier(.4,0,.2,1);border-left:1px solid transparent}
.qr-panel.open{width:340px;border-left-color:var(--panel-b)}
.qr-inner{
  position:relative;width:340px;height:100%;padding:36px 30px;display:flex;flex-direction:column;justify-content:center;gap:14px;
  background:linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02));backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
}
.qr-inner h2{font-size:24px;line-height:1.2}
.qr-inner .eyebrow{margin-top:0}
.qr-close{position:absolute;top:24px;right:20px;width:38px;height:38px;border-radius:50%;border:1px solid var(--panel-b);background:rgba(255,255,255,0.05);color:var(--muted);display:grid;place-items:center;cursor:pointer}
.qr-close:hover{color:var(--text)}
.qr-box{background:#fff;border-radius:20px;padding:16px;box-shadow:0 20px 50px rgba(0,0,0,0.45), 0 0 0 6px rgba(244,162,123,0.15)}
.qr-box svg{width:100%;height:auto;display:block}
.qr-url{font-family:'Space Grotesk',Inter,sans-serif;font-size:15px;color:var(--accent2);text-align:center;word-break:break-all}
.qr-steps{display:flex;flex-direction:column;gap:8px;margin-top:4px}
.qr-steps div{display:flex;align-items:center;gap:10px;font-size:14px;color:var(--muted)}
.qr-steps span{width:22px;height:22px;flex:0 0 22px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;color:#0B1020;background:var(--accent2)}
.qr-count{display:flex;align-items:center;gap:8px;margin-top:6px;padding-top:14px;border-top:1px solid var(--panel-b);font-size:15px}
.qr-count b{font-family:'Space Grotesk',Inter,sans-serif;font-size:20px}

@media (max-width:900px){
  .dash-head{left:20px;top:20px}
  .dash-head h1{font-size:24px}
  .dash-tools{top:22px;right:16px}
  .qr-panel.open{width:280px}
  .qr-inner{width:280px;padding:28px 20px}
}
`;