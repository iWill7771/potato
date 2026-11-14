/* სიტყვობანა — სტატიკური სერვერი + WebSocket რელე (მასპინძელი განსაზღვრავს თამაშს) */
const http = require('http'), fs = require('fs'), path = require('path');
const crypto = require('crypto');
const PORT = process.env.PORT || 3000, ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };

const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(ROOT, path.normalize(p));
    if (!f.startsWith(ROOT) || !['index.html', 'words.txt', 'common.txt'].includes(path.basename(f))) { res.writeHead(404); return res.end('Not found'); }
    fs.readFile(f, (e, d) => {
        if (e) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
        res.end(d);
    });
});

const rooms = new Map();   // code -> { host, members: [{id, name, ws}] }
let nextId = 1;
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const lobby = r => r.members.map(m => ({ id: m.id, name: m.name }));
const broadcastLobby = r => r.members.forEach(m => send(m.ws, { t: 'lobby', members: lobby(r) }));
const cleanName = n => String(n || 'მოთამაშე').replace(/[<>&"'`]/g, '').trim().slice(0, 16) || 'მოთამაშე';
const watchers = new Set();   // კლიენტები, რომლებიც ღია მაგიდების სიას ხედავენ
const roomsList = () => [...rooms.entries()].filter(([, r]) => !r.started && r.members.length < 4).map(([code, r]) => ({ code, host: r.members[0].name, n: r.members.length }));
const broadcastRooms = () => { const l = roomsList(); watchers.forEach(w => { if (!w.room) send(w, { t: 'rooms', rooms: l }); }); };

/* ---- მინიმალური WebSocket (დამოკიდებულებების გარეშე) ---- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', MAX = 1 << 20;
class Conn {
    constructor(socket) { this.socket = socket; this.readyState = 1; this.buf = Buffer.alloc(0); this.frag = null; this.room = null; this.id = 0; }
    send(str) {
        if (this.readyState !== 1) return;
        const p = Buffer.from(str), n = p.length;
        const h = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const x = Buffer.alloc(10); x[0] = 0x81; x[1] = 127; x.writeBigUInt64BE(BigInt(n), 2); return x; })();
        this.socket.write(Buffer.concat([h, p]));
    }
    frame(op, payload) { const h = Buffer.from([0x80 | op, payload.length]); this.socket.write(Buffer.concat([h, payload])); }
    close() { if (this.readyState === 1) { this.readyState = 3; try { this.frame(8, Buffer.alloc(0)); this.socket.end(); } catch { } onClose(this); } }
    feed(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        for (;;) {
            const b = this.buf; if (b.length < 2) return;
            const op = b[0] & 15, fin = b[0] & 128, masked = b[1] & 128; let len = b[1] & 127, off = 2;
            if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
            if (len > MAX) return this.close();
            if (b.length < off + (masked ? 4 : 0) + len) return;
            let data = b.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len);
            if (masked) { const m = b.subarray(off, off + 4); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= m[i & 3]; }
            this.buf = b.subarray(off + (masked ? 4 : 0) + len);
            if (op === 8) return this.close();
            if (op === 9) { this.frame(10, data); continue; }
            if (op === 10) continue;
            if (op === 1 || op === 2) this.frag = [data]; else if (op === 0 && this.frag) this.frag.push(data); else continue;
            if (fin) { const msg = Buffer.concat(this.frag).toString('utf8'); this.frag = null; onMessage(this, msg); }
        }
    }
}

server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) return socket.destroy();
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
    socket.setNoDelay(true);
    const ws = new Conn(socket);
    socket.on('data', d => { try { ws.feed(d); } catch { ws.close(); } });
    socket.on('close', () => { if (ws.readyState === 1) { ws.readyState = 3; onClose(ws); } });
    socket.on('error', () => socket.destroy());
});

function onMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const room = ws.room && rooms.get(ws.room);

    if (m.t === 'watch') {
        if (ws.room) return;
        watchers.add(ws); send(ws, { t: 'rooms', rooms: roomsList() });
    } else if (m.t === 'create' && !ws.room) {
        let code; do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(code));
        ws.id = nextId++; ws.room = code;
        rooms.set(code, { members: [{ id: ws.id, name: cleanName(m.name), ws }] });
        send(ws, { t: 'created', code }); broadcastLobby(rooms.get(code)); broadcastRooms();
    } else if (m.t === 'join' && !ws.room) {
        const r = rooms.get(String(m.code));
        if (!r) return send(ws, { t: 'error', msg: 'ოთახი ვერ მოიძებნა' });
        if (r.started) return send(ws, { t: 'error', msg: 'თამაში უკვე დაწყებულია' });
        if (r.members.length >= 4) return send(ws, { t: 'error', msg: 'ოთახი სავსეა' });
        ws.id = nextId++; ws.room = String(m.code);
        r.members.push({ id: ws.id, name: cleanName(m.name), ws });
        send(ws, { t: 'joined', code: ws.room }); broadcastLobby(r); broadcastRooms();
    } else if (m.t === 'toHost' && room) {
        send(room.members[0].ws, { t: 'fromGuest', id: ws.id, data: m.data });
    } else if (m.t === 'toClient' && room && room.members[0].ws === ws) {
        if (!room.started) { room.started = true; broadcastRooms(); }
        const g = room.members.find(x => x.id === m.to);
        if (g) send(g.ws, { t: 'fromHost', data: m.data });
    }
}

function onClose(ws) {
    watchers.delete(ws);
    const r = ws.room && rooms.get(ws.room);
    if (!r) return;
    if (r.members[0].ws === ws) {
        r.members.slice(1).forEach(x => { send(x.ws, { t: 'closed' }); x.ws.room = null; });
        rooms.delete(ws.room);
        broadcastRooms();
    } else {
        r.members = r.members.filter(x => x.ws !== ws);
        send(r.members[0].ws, { t: 'left', id: ws.id });
        broadcastLobby(r);
        broadcastRooms();
    }
}

server.listen(PORT, '0.0.0.0', () => console.log(`http://localhost:${PORT}  (LAN: გახსენით ამ კომპიუტერის IP:${PORT})`));
