// Chạy: node server.js  (không cần cài thêm thư viện)
// Mật khẩu admin: đặt biến môi trường ADMIN_PASSWORD (mặc định: admin123), tên đăng nhập admin: "admin"
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, ADMIN_PW = process.env.ADMIN_PASSWORD || 'admin123';
const W = 2400, H = 1600, PUB = path.join(__dirname, 'public') + path.sep, DB = path.join(__dirname, 'accounts.json');
let accounts = {}; try { accounts = JSON.parse(fs.readFileSync(DB)); } catch {}
const save = () => fs.writeFileSync(DB, JSON.stringify(accounts, null, 1));
const cl = (v, a, b) => Math.max(a, Math.min(b, v));
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(PUB, path.normalize(p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(d);
  });
});

// ---- WebSocket tối giản ----
function send(ws, o) {
  if (!ws || ws.dead) return;
  const b = Buffer.from(JSON.stringify(o)); let h;
  if (b.length < 126) h = Buffer.from([0x81, b.length]);
  else if (b.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(b.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(b.length), 2); }
  ws.sock.write(Buffer.concat([h, b]));
}
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key']; if (!key) return sock.destroy();
  sock.setNoDelay(true);
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
    crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
  const ws = { sock, dead: false, p: null }; let buf = Buffer.alloc(0);
  ws.close = () => { if (ws.dead) return; ws.dead = true; if (ws.p) { ents.delete(ws.p.id); sys(ws.p.name + ' đã thoát'); } };
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]); if (buf.length > 1 << 20) return sock.destroy();
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = buf[1] & 128; if (masked) off += 4;
      if (buf.length < off + len) return;
      const pl = Buffer.from(buf.subarray(off, off + len));
      if (masked) { const m = buf.subarray(off - 4, off); for (let i = 0; i < len; i++) pl[i] ^= m[i & 3]; }
      buf = buf.subarray(off + len);
      if (op === 8) { sock.end(); return; }
      if (op === 9) sock.write(Buffer.from([0x8A, 0]));
      if (op === 1) { try { onMsg(ws, JSON.parse(pl.toString())); } catch (e) {} }
    }
  });
  sock.on('close', ws.close); sock.on('error', ws.close);
});

// ---- Game ----
const ents = new Map(); let bullets = [], nid = 1;
const mk = o => Object.assign({ x: 1200, y: 800, hp: 100, max: 100, face: 1, dead: 0, atk: 0, fly: 0, ix: 0, iy: 0, lastChat: 0 }, o);
[['npc1', 'Quốc', 'quoc', 1000, 1], ['npc2', 'Huy', 'huy', 1400, -1]].forEach(([id, n, c, x, f]) =>
  ents.set(id, mk({ id, name: n + ' (NPC)', char: c, x, y: 800, home: { x, y: 800 }, npc: 1, hp: 150, max: 150, face: f })));
// ---- Thành phố: tòa nhà [x, y, rộng, sâu, chiều cao, màu] ----
const B = []; (function () {
  let sd = 11; const r = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  const SX = [[0, 245], [355, 2045], [2155, 2400]], SY = [[0, 245], [355, 1245], [1355, 1600]];
  for (const [x0, x1] of SX) for (const [y0, y1] of SY) {
    const nx = Math.max(1, Math.round((x1 - x0) / 230)), ny = Math.max(1, Math.round((y1 - y0) / 200)), w = (x1 - x0) / nx, d = (y1 - y0) / ny;
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const x = x0 + i * w + 12, y = y0 + j * d + 12, bw = w - 24, bd = d - 24;
      if (x < 1640 && x + bw > 760 && y < 1140 && y + bd > 460) continue; // quảng trường trung tâm
      B.push([Math.round(x), Math.round(y), Math.round(bw), Math.round(bd), Math.round(150 + r() * 280), r() * 6 | 0]);
    }
  }
})();
const blk = (x, y) => B.some(b => x > b[0] - 14 && x < b[0] + b[2] + 14 && y > b[1] + 10 && y < b[1] + b[3] + 6);
const players = () => [...ents.values()].filter(e => !e.npc);
const bc = o => players().forEach(p => send(p.ws, o));
const sys = text => bc({ t: 'sys', text });
const online = n => players().find(e => e.name === n);

function hurt(t, dmg, by, kx = 0, ky = 0) {
  if (t.dead || t.admin) return;
  t.hp = Math.max(0, t.hp - dmg); t.x = cl(t.x + kx, 30, W - 30); t.y = cl(t.y + ky, 60, H - 30);
  bc({ t: 'dmg', id: t.id, v: dmg });
  if (t.npc) { t.aggro = by; t.aggroT = Date.now() + 8000; }
  if (t.hp <= 0) { t.dead = Date.now(); sys(by.name + ' đã hạ gục ' + t.name); }
}
function attack(p, ang) {
  const now = Date.now();
  if (p.dead || now - p.atk < (p.admin ? 160 : 450)) return;
  p.atk = now; p.face = Math.cos(ang) >= 0 ? 1 : -1; bc({ t: 'atk', id: p.id, f: p.face });
  if (p.admin) { bullets.push({ x: p.x, y: p.y - 60, vx: Math.cos(ang) * 900, vy: Math.sin(ang) * 900, o: p, life: 1.1 }); return; }
  setTimeout(() => {
    if (p.dead) return;
    for (const t of ents.values()) {
      if (t === p || t.dead) continue;
      const dx = t.x - p.x, dy = t.y - p.y, d = Math.hypot(dx, dy) || 1;
      if (d < 85 && (d < 30 || (dx * Math.cos(ang) + dy * Math.sin(ang)) / d > 0.3))
        hurt(t, 8 + (Math.random() * 5 | 0), p, dx / d * 28, dy / d * 28);
    }
  }, 120);
}
function kick(e, msg) { send(e.ws, { t: 'kicked', m: msg }); e.ws.close(); e.ws.sock.end(); }
function sendList(ws) {
  send(ws, { t: 'accounts', l: Object.entries(accounts).map(([n, a]) => ({ n, c: a.char, on: !!online(n) })) });
}

function onMsg(ws, m) {
  const p = ws.p;
  if (m.t === 'login') {
    if (p) return;
    const name = String(m.name || '').trim().slice(0, 16), key = name.toLowerCase(), isAd = key === 'admin';
    if (name.length < 2) return send(ws, { t: 'err', m: 'Tên phải từ 2 ký tự' });
    if (isAd && m.pw !== ADMIN_PW) return send(ws, { t: 'err', m: 'Sai mật khẩu admin' });
    if (players().some(e => e.name.toLowerCase() === key)) return send(ws, { t: 'err', m: 'Tên này đang có người dùng' });
    const char = m.char === 'huy' ? 'huy' : 'quoc', real = isAd ? 'admin' : name;
    accounts[real] = Object.assign(accounts[real] || { created: Date.now() }, { char }); save();
    const e = mk({ id: 'p' + nid++, name: real, char, admin: isAd, ws, x: 1200 + (Math.random() * 300 - 150), y: 950 + Math.random() * 100, hp: isAd ? 9999 : 100, max: isAd ? 9999 : 100 });
    ents.set(e.id, e); ws.p = e; send(ws, { t: 'init', id: e.id, admin: isAd, W, H, b: B }); sys(real + ' đã vào game'); return;
  }
  if (!p) return;
  if (m.t === 'input') { p.ix = cl(+m.x || 0, -1, 1); p.iy = cl(+m.y || 0, -1, 1); }
  else if (m.t === 'attack') attack(p, +m.a || 0);
  else if (m.t === 'chat') {
    const text = String(m.text || '').trim().slice(0, 200), now = Date.now();
    if (text && now - p.lastChat > 400) { p.lastChat = now; bc({ t: 'chat', name: p.name, text, ad: p.admin ? 1 : 0 }); }
  } else if (m.t === 'respawn') {
    if (p.dead && Date.now() - p.dead > 2500) { p.dead = 0; p.hp = p.max; p.x = 1200 + (Math.random() * 300 - 150); p.y = 950; }
  } else if (m.t === 'fly') { if (p.admin) p.fly ^= 1; }
  else if (m.t === 'admin' && p.admin) {
    if (m.cmd === 'list') return sendList(ws);
    const tn = String(m.name || ''), t = online(tn);
    if (tn.toLowerCase() === 'admin') return;
    if (m.cmd === 'heal' && t) { t.hp = t.max; t.dead = 0; }
    if (m.cmd === 'kill' && t && !t.dead) { t.hp = 0; t.dead = Date.now(); bc({ t: 'dmg', id: t.id, v: 999 }); sys('Admin đã hạ ' + t.name); }
    if (m.cmd === 'kick' && t) kick(t, 'Bạn đã bị admin kick');
    if (m.cmd === 'del') { delete accounts[tn]; save(); if (t) kick(t, 'Tài khoản của bạn đã bị admin xóa'); }
    sendList(ws);
  }
}

setInterval(() => {
  const now = Date.now(), dt = 0.033;
  for (const e of ents.values()) {
    if (e.dead) {
      if (e.npc && now - e.dead > 20000) { e.dead = 0; e.hp = e.max; e.x = e.home.x; e.y = e.home.y; }
      continue;
    }
    if (e.npc) {
      let tx = e.home.x, ty = e.home.y, stop = 8; const a = e.aggro;
      if (a && !a.dead && now < e.aggroT && ents.has(a.id)) {
        tx = a.x; ty = a.y; stop = 55;
        if (Math.hypot(a.x - e.x, a.y - e.y) < 75 && now - e.atk > 1100) attack(e, Math.atan2(a.y - e.y, a.x - e.x));
      } else e.aggro = null;
      const dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy);
      e.ix = d > stop ? dx / d * .55 : 0; e.iy = d > stop ? dy / d * .55 : 0;
    }
    const l = Math.hypot(e.ix, e.iy), k = l > 1 ? 1 / l : 1, sp = e.admin ? (e.fly ? 420 : 260) : 220;
    const nx = cl(e.x + e.ix * k * sp * dt, 30, W - 30), ny = cl(e.y + e.iy * k * sp * dt, 60, H - 30), free = e.fly || blk(e.x, e.y);
    if (free || !blk(nx, e.y)) e.x = nx; if (free || !blk(e.x, ny)) e.y = ny;
    if (Math.abs(e.ix) > .15) e.face = e.ix > 0 ? 1 : -1;
  }
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i]; b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    let hit = b.life <= 0 || b.x < 0 || b.y < 0 || b.x > W || b.y > H;
    if (!hit) for (const t of ents.values()) {
      if (t === b.o || t.dead) continue;
      if (Math.hypot(t.x - b.x, t.y - 60 - b.y) < 42) { hurt(t, 25, b.o, Math.sign(b.vx) * 30, 0); hit = true; break; }
    }
    if (hit) bullets.splice(i, 1);
  }
  const snap = { t: 's', e: [...ents.values()].map(e => ({ i: e.id, n: e.name, c: e.char, x: Math.round(e.x), y: Math.round(e.y), h: e.hp, m: e.max, f: e.face, d: e.dead ? 1 : 0, fl: e.fly, ad: e.admin ? 1 : 0, np: e.npc ? 1 : 0 })), b: bullets.map(b => [Math.round(b.x), Math.round(b.y)]) };
  bc(snap);
}, 33);

server.listen(PORT, () => console.log('Game chạy tại http://localhost:' + PORT));
