// Run: node server.js   (hosting: PORT env var is supported, start command "node server.js")
// Online multiplayer server. The server is the authority: it rolls the dice,
// validates every move, keeps the clocks and handles reconnects.
const http = require("http"),
  fs = require("fs"),
  path = require("path"),
  { randomInt } = require("crypto");
const PORT = +process.env.PORT || 3000;
const TD = +process.env.TD_MS || 10000, // time per move (ms)
  TR = +process.env.TR_MS || 60000, // reserve time per player (ms)
  GRACE = +process.env.GRACE_MS || 20000; // reconnect grace period (ms)
const MIME = {
  ".html": "text/html;charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

// ---- rules (same as the client)
const A = (p, r) => (p ? 23 - r : r);
function gen(S, p, d) {
  const c = S.c[p],
    q = S.c[1 - p],
    o = [];
  if (S.bar[p]) return q[A(p, d - 1)] < 2 ? [-1] : [];
  let mn = 24,
    home = 1;
  for (let r = 0; r < 24; r++)
    if (c[A(p, r)]) {
      mn = Math.min(mn, r);
      if (r < 18) home = 0;
    }
  for (let r = 0; r < 24; r++) {
    if (!c[A(p, r)]) continue;
    const t = r + d;
    if (t >= 24) {
      if (home && (t == 24 || r == mn)) o.push(r);
    } else if (q[A(p, t)] < 2) o.push(r);
  }
  return o;
}
function ap(S, p, r, d) {
  const c = S.c.map((x) => x.slice()),
    bar = S.bar.slice(),
    off = S.off.slice(),
    q = 1 - p;
  r < 0 ? bar[p]-- : c[p][A(p, r)]--;
  const t = r + d;
  if (t >= 24) off[p]++;
  else {
    const a = A(p, t);
    if (c[q][a]) {
      c[q][a] = 0;
      bar[q]++;
    }
    c[p][a]++;
  }
  return { c, bar, off };
}
function seqs(S, p, d) {
  let B = [],
    m = 0;
  (function go(S, rem, path) {
    let any = 0;
    for (const x of new Set(rem))
      for (const r of gen(S, p, x)) {
        any = 1;
        const z = rem.slice();
        z.splice(z.indexOf(x), 1);
        go(ap(S, p, r, x), z, path.concat([[r, x]]));
      }
    if (!any && path.length) {
      if (path.length > m) {
        m = path.length;
        B = [];
      }
      if (path.length == m) B.push(path);
    }
  })(S, d[0] == d[1] ? [d[0], d[0], d[0], d[0]] : d, []);
  if (m == 1 && d[0] != d[1]) {
    const M = Math.max(...d);
    if (B.some((s) => s[0][1] == M)) B = B.filter((s) => s[0][1] == M);
  }
  return B;
}
// ---- end rules

const die = () => randomInt(1, 7);
const P = {}, // token -> { tok, res, tid, off }
  T = {}; // id -> { id, name, h, g, G, iv }
let tid = 0;
const send = (tok, m) => {
  const p = P[tok];
  if (p && p.res) p.res.write("data:" + JSON.stringify(m) + "\n\n");
};
const seat = (t, tok) => (t.h == tok ? 0 : t.g == tok ? 1 : -1);
const other = (t, tok) => (t.h == tok ? t.g : t.h);
const both = (t, m) => {
  send(t.h, m);
  t.g && send(t.g, m);
};
const bc = () => {
  const l = Object.values(T)
    .filter((t) => !t.g)
    .map((t) => ({ id: t.id, name: t.name }));
  for (const k in P) send(k, { t: "tables", l });
};
function removeTable(t) {
  clearInterval(t.iv);
  delete T[t.id];
  [t.h, t.g].forEach((x) => P[x] && P[x].tid == t.id && (P[x].tid = 0));
  bc();
}
function leaveTable(tok) {
  const t = T[P[tok].tid];
  if (!t) return;
  const o = other(t, tok);
  if (o) {
    // leaving a running game = the opponent wins
    const lv = t.g && t.G && !t.G.over;
    if (lv) t.G.over = 1;
    send(o, lv ? { t: "dc", why: "left" } : { t: "left" });
  }
  removeTable(t);
}

function init() {
  const c = [Array(24).fill(0), Array(24).fill(0)];
  [0, 1].forEach((p) =>
    [[0, 2], [11, 5], [16, 3], [18, 5]].forEach(
      ([r, n]) => (c[p][A(p, r)] = n),
    ),
  );
  return {
    S: { c, bar: [0, 0], off: [0, 0] },
    turn: 0,
    rem: [],
    dice: [],
    legal: [],
    hist: [],
    op: 1,
    open: [0, 0],
    tm: [TR, TR],
    ds: TD,
    tl: Date.now(),
    tp: 0,
    go: 0,
    over: 0,
  };
}
const later = (t, g, ms, f) =>
  setTimeout(() => t.G === g && !g.over && f(), ms);
function startGame(t) {
  t.G = init();
  clearInterval(t.iv);
  t.iv = setInterval(() => tick(t), 250);
}
function tick(t) {
  const g = t.G,
    now = Date.now(),
    dt = now - g.tl;
  g.tl = now;
  if (g.over || !g.go || g.tp) return;
  const p = g.turn;
  if (g.ds > 0) {
    g.ds -= dt;
    if (g.ds < 0) {
      g.tm[p] += g.ds;
      g.ds = 0;
    }
  } else g.tm[p] -= dt;
  if (g.tm[p] <= 0) {
    g.tm[p] = 0;
    g.over = 1;
    both(t, { t: "to", p });
  }
}
// after the dice are set: remaining dice, legal sequences, auto-skip if none
function setup(t, g, extra) {
  const d = g.dice;
  g.rem = d[0] == d[1] ? [d[0], d[0], d[0], d[0]] : d.slice();
  g.legal = seqs(g.S, g.turn, d);
  if (!g.legal.length) {
    g.rem = [];
    g.tp = 1;
    later(t, g, extra + 1500, () => endTurn(t));
  }
}
function endTurn(t) {
  const g = t.G;
  if (g.over) return;
  g.turn = 1 - g.turn;
  g.rem = [];
  g.dice = [];
  g.legal = [];
  g.hist = [];
  g.ds = TD;
  g.tl = Date.now();
  g.tp = 0;
  const p = g.turn;
  if (
    !g.op &&
    g.S.bar[p] &&
    [1, 2, 3, 4, 5, 6].every((d) => !gen(g.S, p, d).length)
  ) {
    g.tp = 1;
    later(t, g, 1500, () => endTurn(t));
  }
}
function rollback(g) {
  if (!g.hist.length) return;
  g.S = g.hist[0].S;
  const d = g.dice;
  g.rem = d[0] == d[1] ? [d[0], d[0], d[0], d[0]] : d.slice();
  g.legal = seqs(g.S, g.turn, d);
  g.hist = [];
}
// reconnect: unconfirmed moves of the current turn are rolled back, both sides resync
function resync(t) {
  const g = t.G;
  rollback(g);
  if (g.op) g.open = [0, 0];
  g.tl = Date.now();
  const st = { S: g.S, turn: g.turn, op: g.op, dice: g.dice, tm: g.tm, ds: g.ds };
  [t.h, t.g].forEach((x) => send(x, { t: "go", seat: seat(t, x), st }));
}

const RM = ["rq", "ra", "rn"];
function handle(tok, m) {
  const p = P[tok];
  if (!p) return;
  const t = T[p.tid];
  if (m.t == "create") {
    if (t) leaveTable(tok);
    const name =
      String(m.name || "").replace(/[<>&"'`]/g, "").slice(0, 20) || "Table";
    T[++tid] = { id: tid, name, h: tok, g: null, G: null };
    p.tid = tid;
    send(tok, { t: "made" });
    return bc();
  }
  if (m.t == "join") {
    const jt = T[m.tid];
    if (!jt || jt.g || jt.h == tok) return;
    if (t) leaveTable(tok);
    jt.g = tok;
    p.tid = jt.id;
    startGame(jt);
    send(jt.h, { t: "go", seat: 0 });
    send(tok, { t: "go", seat: 1 });
    return bc();
  }
  if (m.t == "leave") return t && leaveTable(tok);
  if (!t || !t.g) return;
  const g = t.G,
    s = seat(t, tok),
    o = other(t, tok);
  if (RM.includes(m.t) != !!g.over) return;
  switch (m.t) {
    case "r": {
      if (g.op) {
        // opening: white rolls first, then black; higher die starts with both dice
        if (s != (g.open[0] ? 1 : 0) || g.open[s]) return;
        const v = die();
        g.open[s] = v;
        both(t, { t: "r", d: [v] });
        if (g.open[1]) {
          const [a, b] = g.open;
          later(t, g, 340 + 1500, () => {
            if (a == b) return (g.open = [0, 0]);
            g.op = 0;
            g.turn = a > b ? 0 : 1;
            g.dice = [a, b];
            g.go = 1;
            g.ds = TD;
            g.tl = Date.now();
            g.tp = 0;
            setup(t, g, 0);
          });
        }
        return;
      }
      if (g.turn != s || g.dice.length || g.tp) return;
      g.dice = [die(), die()];
      g.go = 1;
      both(t, { t: "r", d: g.dice });
      return setup(t, g, 340);
    }
    case "m": {
      if (g.op || g.turn != s || !g.dice.length || g.tp) return;
      const { r, d } = m;
      if (
        !Number.isInteger(r) ||
        !Number.isInteger(d) ||
        !g.rem.includes(d) ||
        !g.legal.some((q) => q[0][0] == r && q[0][1] == d)
      )
        return;
      g.hist.push({ S: g.S, rem: g.rem.slice(), legal: g.legal, c: !!m.c });
      g.S = ap(g.S, s, r, d);
      g.rem.splice(g.rem.indexOf(d), 1);
      g.legal = g.legal
        .filter((q) => q[0][0] == r && q[0][1] == d)
        .map((q) => q.slice(1))
        .filter((q) => q.length);
      send(o, { t: "m", r, d, c: !!m.c });
      if (g.S.off[s] == 15) g.over = 1;
      return;
    }
    case "u": {
      if (g.op || g.turn != s || !g.hist.length) return;
      let h;
      do h = g.hist.pop();
      while (h.c && g.hist.length);
      g.S = h.S;
      g.rem = h.rem;
      g.legal = h.legal;
      return send(o, { t: "u" });
    }
    case "c":
      if (g.op || g.turn != s || !g.hist.length || g.legal.length) return;
      send(o, { t: "c" });
      return endTurn(t);
    case "sf":
      g.over = 1;
      return send(o, { t: "sf" });
    case "rq":
    case "rn":
      return send(o, { t: m.t });
    case "ra":
      startGame(t);
      return send(o, { t: "ra" });
  }
}

// connection lost: keep the game for GRACE ms so the player can come back
function dropped(tok) {
  const p = P[tok];
  if (!p) return;
  const t = T[p.tid];
  if (!t) return void delete P[tok];
  const live = t.g && t.G && !t.G.over;
  p.off = setTimeout(
    () => {
      if (T[t.id] === t) {
        const o = other(t, tok),
          lv = t.g && t.G && !t.G.over;
        if (lv) t.G.over = 1;
        o && send(o, lv ? { t: "dc" } : { t: "left" });
        removeTable(t);
      }
      delete P[tok];
    },
    live ? GRACE : 15000,
  );
}

http
  .createServer((q, r) => {
    const u = new URL(q.url, "http://x");
    if (u.pathname == "/ev") {
      const tok = u.searchParams.get("tok") || "";
      if (!/^[\w-]{8,64}$/.test(tok)) {
        r.writeHead(400);
        return r.end();
      }
      r.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      let p = P[tok];
      if (p) {
        clearTimeout(p.off);
        p.res && p.res.end();
      } else p = P[tok] = { tok, tid: 0 };
      p.res = r;
      const t = T[p.tid],
        ing = !!(t && t.g && t.G && !t.G.over);
      send(tok, { t: "hi", ing });
      bc();
      if (ing) resync(t);
      else if (t && !t.g) send(tok, { t: "made" });
      const hb = setInterval(() => r.write(": hb\n\n"), 20000);
      q.on("close", () => {
        clearInterval(hb);
        if (p.res === r) {
          p.res = null;
          dropped(tok);
        }
      });
    } else if (u.pathname == "/api" && q.method == "POST") {
      let b = "";
      q.on("data", (d) => {
        b += d;
        if (b.length > 2000) q.destroy();
      }).on("end", () => {
        try {
          const m = JSON.parse(b);
          if (typeof m.id == "string") handle(m.id, m);
        } catch (e) {
          console.error(e);
        }
        r.writeHead(204);
        r.end();
      });
    } else if (u.pathname == "/health") {
      r.writeHead(200);
      r.end("ok");
    } else {
      let rel;
      try {
        rel = decodeURIComponent(u.pathname);
      } catch (e) {
        r.writeHead(400);
        return r.end();
      }
      const f = path.join(__dirname, rel == "/" ? "index.html" : rel),
        ct = MIME[path.extname(f).toLowerCase()];
      if (!ct || !f.startsWith(__dirname + path.sep)) {
        r.writeHead(404);
        return r.end();
      }
      fs.readFile(f, (e, d) => {
        if (e) {
          r.writeHead(404);
          return r.end();
        }
        const h = {
          "Content-Type": ct,
          "Accept-Ranges": "bytes",
          "Cache-Control": ct.startsWith("text/html")
            ? "no-cache"
            : "public, max-age=3600",
        };
        // Range support so looping background music works
        const rg = /^bytes=(\d*)-(\d*)$/.exec(q.headers.range || "");
        if (rg && (rg[1] || rg[2])) {
          const s = rg[1] ? +rg[1] : Math.max(0, d.length - +rg[2]);
          const en =
            rg[1] && rg[2] ? Math.min(+rg[2], d.length - 1) : d.length - 1;
          if (s > en) {
            r.writeHead(416, { "Content-Range": "bytes */" + d.length });
            return r.end();
          }
          h["Content-Range"] = `bytes ${s}-${en}/${d.length}`;
          h["Content-Length"] = en - s + 1;
          r.writeHead(206, h);
          return r.end(d.subarray(s, en + 1));
        }
        r.writeHead(200, h);
        r.end(d);
      });
    }
  })
  .listen(PORT, "0.0.0.0", () =>
    console.log("Backgammon server ready: http://localhost:" + PORT),
  );
process.on("uncaughtException", (e) => console.error(e));
