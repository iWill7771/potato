// ქალაქობანა — მრავალმოთამაშიანი სერვერი
// გაშვება: node server.js   →   http://localhost:3000
// დამოკიდებულებები არ სჭირდება (მხოლოდ Node-ის ჩაშენებული მოდულები).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ---------- თამაშის პარამეტრები (შეგიძლია შეცვალო) ----------
const DEFAULT_CATEGORIES = ['ქალაქი/სოფელი', 'ცხოველი', 'მცენარე', 'ნივთი'];
const MAX_CATEGORIES = 12;
const MAX_CAT_LEN = 24;
const LETTERS = 'ა ბ გ დ ე ვ ზ თ ი კ ლ მ ნ ო პ რ ს ტ უ ფ ქ შ ჩ ც წ ხ ჯ'.split(' ');
const COUNTDOWN_MS = 10000;   // "სტოპის" შემდეგ დარჩენილი დრო დანარჩენებისთვის
const COLLECT_MS = 3000;      // პასუხების მოლოდინის მაქსიმუმი რაუნდის ბოლოს
const POINTS_UNIQUE = 10;
const POINTS_SHARED = 5;
const MAX_PLAYERS = 12;
const MAX_LEN = 40;

const rooms = new Map();

// ---------- დამხმარე ფუნქციები ----------
const rid = (n) => crypto.randomBytes(n).toString('hex');

function newRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(c)) return c;
  }
}

function norm(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_LEN);
}

function cleanCategories(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const c of raw) {
    const t = String(c || '').trim().replace(/\s+/g, ' ').slice(0, MAX_CAT_LEN);
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_CATEGORIES) break;
  }
  return out;
}

function makeRoom(code, isPrivate) {
  return {
    code, phase: 'lobby', host: null, round: 0, totalRounds: 5, letter: null,
    categories: [...DEFAULT_CATEGORIES], challenges: new Map(),
    usedLetters: [], endsAt: null, stopper: null, lastResults: null,
    players: new Map(), timer: null, cleanup: null, isPrivate: !!isPrivate,
  };
}

function cleanAnswers(raw, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(String((raw && raw[i]) || '').trim().replace(/\s+/g, ' ').slice(0, MAX_LEN));
  }
  return out;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 20000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// ---------- ოთახის მდგომარეობა ----------
function publicState(room) {
  return {
    code: room.code,
    isPrivate: room.isPrivate,
    phase: room.phase,            // lobby | playing | countdown | collecting | results | finished
    host: room.host,
    round: room.round,
    totalRounds: room.totalRounds,
    letter: room.letter,
    categories: room.categories,
    endsAt: room.endsAt,
    stopper: room.stopper,
    serverNow: Date.now(),
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, score: p.score, connected: p.connected,
      submitted: room.phase === 'collecting' ? p.answers !== null : undefined,
    })),
    results: room.phase === 'results' || room.phase === 'finished' ? room.lastResults : null,
  };
}

function broadcast(room) {
  const payload = `data: ${JSON.stringify(publicState(room))}\n\n`;
  for (const p of room.players.values()) {
    if (p.res) { try { p.res.write(payload); } catch {} }
  }
}

function pickHost(room) {
  if (room.players.get(room.host)?.connected) return;
  const next = [...room.players.values()].find((p) => p.connected);
  if (next) room.host = next.id;
}

function startRound(room) {
  room.round += 1;
  const pool = LETTERS.filter((l) => !room.usedLetters.includes(l));
  const src = pool.length ? pool : LETTERS;
  room.letter = src[crypto.randomInt(src.length)];
  room.usedLetters.push(room.letter);
  room.phase = 'playing';
  room.stopper = null;
  room.endsAt = null;
  room.lastResults = null;
  room.challenges = new Map();
  for (const p of room.players.values()) { p.answers = null; p.scoreBefore = p.score; }
  broadcast(room);
}

function beginCollecting(room) {
  if (room.phase !== 'countdown') return;
  room.phase = 'collecting';
  room.endsAt = null;
  broadcast(room);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => finishRound(room), COLLECT_MS);
}

function maybeFinishEarly(room) {
  if (room.phase !== 'collecting') return;
  const waiting = [...room.players.values()].some((p) => p.connected && p.answers === null);
  if (!waiting) finishRound(room);
}

const isValidAnswer = (room, text) => {
  const n = norm(text);
  return n.length >= 2 && n[0] === room.letter;
};

// ანგარიშობს რაუნდის შედეგს (გასაჩივრებების გათვალისწინებით) და განაახლებს ქულებს
function computeResults(room) {
  const cats = room.categories;
  const players = [...room.players.values()];

  // გასაჩივრებული პასუხები: ყველა დანარჩენმა (ვინც ახლა ოთახშია) გაასაჩივრა
  const rejected = new Set();
  const needFor = (tid) => players.filter((p) => p.id !== tid && p.connected);
  for (const [key, set] of room.challenges) {
    const tid = key.split(':')[0];
    const others = needFor(tid);
    if (others.length && others.every((p) => set.has(p.id))) rejected.add(key);
  }

  const perCat = cats.map((_, ci) => {
    const counts = new Map();
    for (const p of players) {
      if (isValidAnswer(room, p.answers[ci]) && !rejected.has(p.id + ':' + ci)) {
        const n = norm(p.answers[ci]);
        counts.set(n, (counts.get(n) || 0) + 1);
      }
    }
    return counts;
  });

  const rows = players.map((p) => {
    let total = 0;
    const need = needFor(p.id).length;
    const cells = cats.map((_, ci) => {
      const text = p.answers[ci];
      const key = p.id + ':' + ci;
      let status, pts = 0;
      if (!text) status = 'empty';
      else if (!isValidAnswer(room, text)) status = 'invalid';
      else if (rejected.has(key)) status = 'rejected';
      else if (perCat[ci].get(norm(text)) > 1) { status = 'shared'; pts = POINTS_SHARED; }
      else { status = 'unique'; pts = POINTS_UNIQUE; }
      total += pts;
      const canCh = status === 'unique' || status === 'shared' || status === 'rejected';
      return { text, status, pts, canCh, ch: canCh ? [...(room.challenges.get(key) || [])] : [], need };
    });
    p.score = (p.scoreBefore || 0) + total;
    return { id: p.id, name: p.name, cells, total, score: p.score };
  });

  room.lastResults = { letter: room.letter, rows };
}

function refreshResults(room) {
  if ((room.phase === 'results' || room.phase === 'finished') && room.lastResults) computeResults(room);
}

function finishRound(room) {
  if (room.phase !== 'collecting') return;
  clearTimeout(room.timer);

  const empty = room.categories.map(() => '');
  for (const p of room.players.values()) if (p.answers === null) p.answers = empty;

  computeResults(room);
  room.phase = room.round >= room.totalRounds ? 'finished' : 'results';
  room.endsAt = null;
  broadcast(room);
}

// ---------- მოთხოვნების დამუშავება ----------
function getRoomAndPlayer(body) {
  const room = rooms.get(String(body.room || '').toUpperCase());
  const player = room && room.players.get(body.pid);
  return { room, player };
}

function addPlayer(room, name) {
  const p = {
    id: rid(8), name: String(name || '').trim().slice(0, 16) || 'მოთამაშე',
    score: 0, connected: false, res: null, answers: null,
  };
  room.players.set(p.id, p);
  return p;
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
    const player = room && room.players.get(url.searchParams.get('pid'));
    if (!player) { res.writeHead(404); return res.end(); }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    if (player.res) { try { player.res.end(); } catch {} }
    player.res = res;
    player.connected = true;
    clearTimeout(room.cleanup);
    pickHost(room);
    broadcast(room);

    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => {
      clearInterval(ping);
      if (player.res !== res) return;
      player.res = null;
      player.connected = false;
      pickHost(room);
      if (room.phase === 'playing' && ![...room.players.values()].some((p) => p.connected)) {
        // ყველა გავიდა — ოთახს ცოტა ხანში წავშლით
      }
      maybeFinishEarly(room);
      refreshResults(room);
      broadcast(room);
      if (![...room.players.values()].some((p) => p.connected)) {
        clearTimeout(room.cleanup);
        room.cleanup = setTimeout(() => {
          clearTimeout(room.timer);
          rooms.delete(room.code);
        }, 5 * 60 * 1000);
      }
    });
    return;
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method' });
  const body = await readBody(req);

  switch (url.pathname) {
    case '/api/create': {
      const code = newRoomCode();
      const room = makeRoom(code, !!body.private);
      const p = addPlayer(room, body.name);
      room.host = p.id;
      rooms.set(code, room);
      return json(res, 200, { room: code, pid: p.id });
    }

    case '/api/quick': {
      // კოდის გარეშე შესვლა: ვპოულობთ ღია საჯარო ლობის, თუ არა — ვქმნით ახალს
      let room = [...rooms.values()].find((r) =>
        !r.isPrivate && r.phase === 'lobby' && r.players.size < MAX_PLAYERS &&
        [...r.players.values()].some((p) => p.connected));
      if (!room) {
        const code = newRoomCode();
        room = makeRoom(code, false);
        rooms.set(code, room);
        const p = addPlayer(room, body.name);
        room.host = p.id;
        room.cleanup = setTimeout(() => { rooms.delete(code); }, 5 * 60 * 1000);
        return json(res, 200, { room: code, pid: p.id });
      }
      const p = addPlayer(room, body.name);
      broadcast(room);
      return json(res, 200, { room: room.code, pid: p.id });
    }

    case '/api/join': {
      const room = rooms.get(String(body.room || '').toUpperCase());
      if (!room) return json(res, 404, { error: 'ოთახი ვერ მოიძებნა' });
      if (room.phase !== 'lobby') return json(res, 400, { error: 'თამაში უკვე დაწყებულია' });
      if (room.players.size >= MAX_PLAYERS) return json(res, 400, { error: 'ოთახი სავსეა' });
      const p = addPlayer(room, body.name);
      broadcast(room);
      return json(res, 200, { room: room.code, pid: p.id });
    }

    case '/api/start': {
      const { room, player } = getRoomAndPlayer(body);
      if (!player || room.host !== player.id) return json(res, 403, { error: 'მხოლოდ მასპინძელს შეუძლია' });
      if (room.phase !== 'lobby' && room.phase !== 'finished') return json(res, 400, { error: 'უკვე მიმდინარეობს' });
      if (room.phase === 'finished') {
        room.round = 0; room.usedLetters = [];
        for (const p of room.players.values()) p.score = 0;
      }
      if (Array.isArray(body.categories)) {
        const cats = cleanCategories(body.categories);
        if (!cats.length) return json(res, 400, { error: 'დაამატე ერთი კატეგორია მაინც' });
        room.categories = cats;
      }
      const n = Math.max(1, Math.min(15, parseInt(body.rounds, 10) || 5));
      room.totalRounds = n;
      startRound(room);
      return json(res, 200, { ok: true });
    }

    case '/api/config': {
      const { room, player } = getRoomAndPlayer(body);
      if (!player || room.host !== player.id) return json(res, 403, { error: 'მხოლოდ მასპინძელს შეუძლია' });
      if (room.phase !== 'lobby' && room.phase !== 'finished') return json(res, 400, { error: 'ახლა შეუძლებელია' });
      const cats = cleanCategories(body.categories);
      if (cats.length) { room.categories = cats; broadcast(room); }
      return json(res, 200, { ok: true });
    }

    case '/api/challenge': {
      const { room, player } = getRoomAndPlayer(body);
      if (!player) return json(res, 404, { error: 'მოთამაშე ვერ მოიძებნა' });
      if (room.phase !== 'results' && room.phase !== 'finished') return json(res, 400, { error: 'ახლა გასაჩივრება შეუძლებელია' });
      const tid = String(body.target || '');
      const ci = parseInt(body.cat, 10);
      const target = room.players.get(tid);
      if (!target || tid === player.id || !(ci >= 0 && ci < room.categories.length) || !target.answers) {
        return json(res, 400, { error: 'არასწორი მოთხოვნა' });
      }
      if (!isValidAnswer(room, target.answers[ci])) return json(res, 400, { error: 'ამ პასუხის გასაჩივრება საჭირო არ არის' });
      const key = tid + ':' + ci;
      const set = room.challenges.get(key) || new Set();
      if (set.has(player.id)) set.delete(player.id); else set.add(player.id);
      if (set.size) room.challenges.set(key, set); else room.challenges.delete(key);
      computeResults(room);
      broadcast(room);
      return json(res, 200, { ok: true });
    }

    case '/api/next': {
      const { room, player } = getRoomAndPlayer(body);
      if (!player || room.host !== player.id) return json(res, 403, { error: 'მხოლოდ მასპინძელს შეუძლია' });
      if (room.phase !== 'results') return json(res, 400, { error: 'ახლა შეუძლებელია' });
      startRound(room);
      return json(res, 200, { ok: true });
    }

    case '/api/stop': {
      const { room, player } = getRoomAndPlayer(body);
      if (!player) return json(res, 404, { error: 'მოთამაშე ვერ მოიძებნა' });
      if (room.phase !== 'playing') return json(res, 400, { error: 'ახლა სტოპი შეუძლებელია' });
      const answers = cleanAnswers(body.answers, room.categories.length);
      if (answers.some((a) => !a)) return json(res, 400, { error: 'ჯერ ყველა გრაფა შეავსე' });
      player.answers = answers;
      room.stopper = player.id;
      room.phase = 'countdown';
      room.endsAt = Date.now() + COUNTDOWN_MS;
      clearTimeout(room.timer);
      room.timer = setTimeout(() => beginCollecting(room), COUNTDOWN_MS);
      broadcast(room);
      return json(res, 200, { ok: true });
    }

    case '/api/submit': {
      const { room, player } = getRoomAndPlayer(body);
      if (!player) return json(res, 404, { error: 'მოთამაშე ვერ მოიძებნა' });
      if (room.phase === 'collecting' && player.answers === null) {
        player.answers = cleanAnswers(body.answers, room.categories.length);
        broadcast(room);
        maybeFinishEarly(room);
      }
      return json(res, 200, { ok: true });
    }

    default:
      return json(res, 404, { error: 'not found' });
  }
}

// ---------- სტატიკური ფაილები ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('index.html ვერ მოიძებნა'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`ქალაქობანა მზადაა: http://localhost:${PORT}`);
});
