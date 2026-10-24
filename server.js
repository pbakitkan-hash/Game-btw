// server.js — сервер для Telegram-гри (без залежностей, тільки Node 18+)
// Віддає index.html і API: /api/live, /api/drop, /api/me, /api/ack, /api/promo/*, /api/admin/*
//
// Змінні оточення на Render:
//   BOT_TOKEN   — токен твого бота (ОБОВ'ЯЗКОВО, для перевірки гравців)
//   ADMIN_CODE  — секретний код адміна (за замовчуванням administered9000140809)
//   ADMIN_IDS   — (необов'язково) Telegram ID / @username адмінів через кому
//   DATA_DIR    — (необов'язково) де зберігати data.json

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_CODE = (process.env.ADMIN_CODE || 'administered9000140809').toLowerCase();
const ENV_ADMINS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');

// ---------- збереження ----------
let db = { users: {}, promos: {}, drops: [], admins: [], closed: false, epoch: 0, iepoch: 0, pepoch: 0, cmdSeq: 0 };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) {}
let saveTimer = null;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error('save error', e.message); } }, 400); };

// ---------- Telegram initData ----------
function verifyInitData(raw) {
  if (!raw || !BOT_TOKEN) return null;
  try {
    const p = new URLSearchParams(raw);
    const hash = p.get('hash'); if (!hash) return null;
    p.delete('hash');
    const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
    if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
    if (Date.now() / 1000 - (+p.get('auth_date') || 0) > 7 * 86400) return null;
    const u = JSON.parse(p.get('user') || 'null');
    return u && u.id ? u : null;
  } catch (e) { return null; }
}
const isAdminUser = u => !!u && (db.admins.includes(String(u.id)) || ENV_ADMINS.includes(String(u.id)) || (u.username && ENV_ADMINS.includes(u.username.toLowerCase())));
const nickOf = u => u.username ? '@' + u.username : [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Гравець';

function touchUser(u) {
  const id = String(u.id);
  const r = db.users[id] || (db.users[id] = { id, cmds: [] });
  r.username = u.username || ''; r.name = nickOf(u); r.seen = Date.now();
  return r;
}

// ---------- утиліти ----------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
function send(res, code, obj) { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS)); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise(resolve => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 100000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
const tries = {};
function throttled(key) {
  const now = Date.now(); const a = (tries[key] = (tries[key] || []).filter(t => now - t < 600000));
  if (a.length >= 15) return true; a.push(now); return false;
}
const validCode = c => /^[a-z0-9_]{3,16}$/.test(c || '');

// ---------- API ----------
async function api(req, res, route) {
  const body = req.method === 'POST' ? await readBody(req) : {};
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const initRaw = req.headers['x-init-data'] || '';
  const tgUser = verifyInitData(initRaw);
  const me = tgUser ? touchUser(tgUser) : null;
  const admin = isAdminUser(tgUser);

  // --- LIVE ---
  if (route === '/live' && req.method === 'GET') return send(res, 200, { drops: db.drops.slice(0, 30) });
  if (route === '/drop' && req.method === 'POST') {
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 10).map(i => ({ n: String(i.name || '').slice(0, 40), v: Math.max(0, +i.val || 0), r: Math.max(0, Math.min(9, Math.floor(+i.r) || 0)) })).filter(i => i.n);
    if (!items.length) return send(res, 400, { error: 'bad' });
    db.drops.unshift({ u: tgUser ? nickOf(tgUser) : 'Гравець', c: String(body.case || '').slice(0, 40), items, t: Date.now() });
    db.drops.length = Math.min(db.drops.length, 60); save();
    return send(res, 200, { ok: true });
  }

  // --- ПОВНИЙ СТАН ГРАВЦЯ ---
  if (route === '/me' && req.method === 'GET') {
    return send(res, 200, {
      closed: db.closed && !admin, serverClosed: admin ? db.closed : undefined,
      epoch: db.epoch, iepoch: db.iepoch, pepoch: db.pepoch,
      infinite: admin, cmds: me ? me.cmds : []
    });
  }
  if (route === '/ack' && req.method === 'POST') {
    if (me && Array.isArray(body.ids)) { const s = new Set(body.ids); me.cmds = me.cmds.filter(c => !s.has(c.id)); save(); }
    return send(res, 200, { ok: true });
  }

  // --- ПРОМОКОДИ ---
  if (route === '/promo/create' && req.method === 'POST') {
    const code = String(body.code || '').toLowerCase(), amount = Math.floor(+body.amount), uses = Math.floor(+body.uses);
    if (!validCode(code) || !(amount > 0) || !(uses > 0) || uses > 1000) return send(res, 400, { error: 'bad' });
    if (db.promos[code]) return send(res, 409, { error: 'exists' });
    db.promos[code] = { amount, uses, left: uses, used: [] }; save();
    return send(res, 200, { ok: true });
  }
  if (route === '/promo/redeem' && req.method === 'POST') {
    const code = String(body.code || '').toLowerCase();
    const p = db.promos[code]; if (!p) return send(res, 404, { error: 'none' });
    const who = tgUser ? String(tgUser.id) : String(body.user || ip);
    if (p.used.includes(who)) return send(res, 409, { error: 'used' });
    if (p.left <= 0) return send(res, 410, { error: 'empty' });
    p.left--; p.used.push(who); save();
    return send(res, 200, { amount: p.amount });
  }

  // --- АДМІНКА ---
  if (route === '/admin/login' && req.method === 'POST') {
    if (!BOT_TOKEN) return send(res, 401, { error: 'no BOT_TOKEN' });
    if (!tgUser) return send(res, 401, { error: 'bad initData' });
    if (throttled('login:' + ip)) return send(res, 429, { error: 'slow down' });
    const code = String(body.code || '').toLowerCase();
    if (!admin && code !== ADMIN_CODE) return send(res, 403, { error: 'wrong code' });
    if (!db.admins.includes(String(tgUser.id))) { db.admins.push(String(tgUser.id)); save(); }
    return send(res, 200, { ok: true });
  }
  if (route.startsWith('/admin/')) {
    if (!admin) return send(res, 403, { error: 'not admin' });
    if (route === '/admin/closed') { db.closed = !!body.closed; save(); return send(res, 200, { ok: true, closed: db.closed }); }
    if (route === '/admin/clearinv') { db.iepoch++; save(); return send(res, 200, { ok: true }); }
    if (route === '/admin/resetall') { db.epoch++; save(); return send(res, 200, { ok: true }); }
    if (route === '/admin/promo') {
      const code = String(body.code || '').toLowerCase(), amount = Math.floor(+body.amount), uses = Math.floor(+body.uses);
      if (!validCode(code) || !(amount > 0) || !(uses > 0)) return send(res, 400, { error: 'bad' });
      db.promos[code] = { amount, uses, left: uses, used: [] }; save(); return send(res, 200, { ok: true });
    }
    if (route === '/admin/promoreset') {
      const code = String(body.code || '').toLowerCase(), amount = Math.floor(+body.amount), uses = Math.floor(+body.uses);
      if (!validCode(code) || !(amount > 0) || !(uses > 0)) return send(res, 400, { error: 'bad' });
      db.promos = { [code]: { amount, uses, left: uses, used: [] } }; db.pepoch++; save(); return send(res, 200, { ok: true });
    }
    if (route === '/admin/cmd') {
      const t = String(body.target || '').replace(/^@/, '').toLowerCase();
      const target = Object.values(db.users).find(u => u.id === t || (u.username && u.username.toLowerCase() === t));
      if (!target) return send(res, 404, { error: 'player not found' });
      const type = String(body.type || '');
      if (!['coins', 'reset', 'clearinv', 'give'].includes(type)) return send(res, 400, { error: 'bad type' });
      target.cmds.push({ id: 'c' + (++db.cmdSeq), type, amount: Math.max(0, Math.floor(+body.amount) || 0), item: String(body.item || '').slice(0, 60), qty: Math.max(1, Math.min(100, Math.floor(+body.qty) || 1)) });
      if (target.cmds.length > 50) target.cmds.shift();
      save(); return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'not found' });
}

// ---------- статика ----------
const INDEX = path.join(__dirname, 'index.html');
function serveIndex(res) {
  fs.readFile(INDEX, (err, data) => {
    if (err) { res.writeHead(404); return res.end('index.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(data);
  });
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url.startsWith('/api/')) return api(req, res, url.slice(4)).catch(e => { console.error(e); send(res, 500, { error: 'server' }); });
  if (url === '/health') return send(res, 200, { ok: true });
  serveIndex(res);
}).listen(PORT, () => console.log('Server on :' + PORT + (BOT_TOKEN ? '' : '  ⚠️ BOT_TOKEN не заданий')));
