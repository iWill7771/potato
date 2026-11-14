// გაშვება: node server.js   (დამატებითი პაკეტები არ სჭირდება)
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const R = {};
const send = (res, o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
// heartbeat, რომ კავშირი არ გაწყდეს უმოქმედობისას
setInterval(() => Object.values(R).forEach(r => r.cl.forEach(c => c.write(':\n\n'))), 15000);

http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x'), p = u.searchParams, room = p.get('room'), id = p.get('id');
  if (u.pathname === '/ev') {
    s.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let r = R[room];
    if (p.get('host')) {
      if (r && r.host !== id) { send(s, { m: { t: 'err', x: 'ეს კოდი უკვე დაკავებულია' } }); return s.end(); }
      if (!r) r = R[room] = { host: id, cl: new Map() };
    }
    if (!r) { send(s, { m: { t: 'err', x: 'ოთახი ვერ მოიძებნა' } }); return s.end(); }
    r.cl.set(id, s); send(s, { m: { t: 'ok' } });
    q.on('close', () => {
      if (r.cl.get(id) !== s) return; // ახალი კავშირი უკვე ჩანაცვლებულია
      r.cl.delete(id);
      if (id === r.host) { r.cl.forEach(c => { send(c, { m: { t: 'err', x: 'ჰოსტი გავიდა' } }); c.end(); }); delete R[room]; }
      else { const h = r.cl.get(r.host); h && send(h, { from: id, m: { t: 'bye' } }); }
    });
    return;
  }
  // ღია ოთახების სია (მენიუში ავტომატურად გამოჩნდება)
  if (u.pathname === '/rooms') {
    s.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return s.end(JSON.stringify(Object.entries(R).filter(([k, r]) => r.info && !r.info.st && r.info.c < r.info.n).map(([k, r]) => ({ room: k, host: r.info.name, c: r.info.c, n: r.info.n }))));
  }
  // ჰოსტი აქ აქვეყნებს ოთახის მდგომარეობას: ვინ არის, რამდენნი არიან, დაიწყო თუ არა თამაში
  if (u.pathname === '/info' && q.method === 'POST') {
    let b = ''; q.on('data', d => { b += d; if (b.length > 1e4) q.destroy(); }).on('end', () => {
      try {
        const r = R[room];
        if (r && r.host === id) { const i = JSON.parse(b); r.info = { name: String(i.name || '').slice(0, 14), n: +i.n || 0, c: +i.c || 0, st: i.st ? 1 : 0 }; }
      } catch (e) {}
      s.end('ok');
    });
    return;
  }
  if (u.pathname === '/tx' && q.method === 'POST') {
    let b = ''; q.on('data', d => { b += d; if (b.length > 1e5) q.destroy(); }).on('end', () => {
      try {
        const r = R[room];
        if (r) {
          const { to, m } = JSON.parse(b);
          if (id === r.host) { (to === '*' ? [...r.cl.keys()].filter(k => k !== id) : [to]).forEach(k => { const c = r.cl.get(k); c && send(c, { m }); }); }
          else { const h = r.cl.get(r.host); h && send(h, { from: id, m }); }
        }
      } catch (e) {}
      s.end('ok');
    });
    return;
  }
  fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
    if (e) { s.writeHead(500); return s.end('index.html ვერ მოიძებნა'); }
    s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); s.end(d);
  });
}).listen(3000, '0.0.0.0', () => {
  console.log('ფურთი მზადაა! გახსენი:');
  Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).forEach(i => console.log('  http://' + i.address + ':3000'));
});
