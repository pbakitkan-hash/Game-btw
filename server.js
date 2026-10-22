// Brainrot Farm server: API + Telegram bot (live-таблиця дропів) + admin. Node 18+, без залежностей.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_CODE = process.env.ADMIN_CODE || 'adminpanel200093pro';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean); // твій Telegram ID
const WEBAPP_URL = process.env.WEBAPP_URL || '';
const DB_FILE = path.join(__dirname, 'data.json');
const RN = ['Common','Rare','Epic','Legendary','Mythic','Brainrot God','Secret','OG'];

let db = { closed: false, iepoch: 0, pepoch: 0, epoch: 0, names: {}, promos: {}, admins: [], inf: [], cmds: {}, drops: [], live: null, seq: 1 };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch (e) {}
let saveT; const save = () => { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(db), () => {}), 500); };
let dirty = true;

function verify(init) {
  if (!init) return null;
  if (!BOT_TOKEN) { try { return JSON.parse(new URLSearchParams(init).get('user')); } catch (e) { return null; } } // без токена: без перевірки підпису (простіше, але менш безпечно)
  const p = new URLSearchParams(init), hash = p.get('hash'); p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const h = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (h !== hash) return null;
  try { return JSON.parse(p.get('user')); } catch (e) { return null; }
}
const isAdmin = id => ADMIN_IDS.includes(String(id)) || db.admins.includes(String(id));
const attempts = {};
const tooMany = id => { const n = attempts[id] = (attempts[id] || []).filter(t => Date.now() - t < 6e4); n.push(Date.now()); return n.length > 8; };

const routes = {
  'GET /me': (u) => ({ closed: db.closed && !isAdmin(u.id), serverClosed: isAdmin(u.id) ? db.closed : undefined, iepoch: db.iepoch, pepoch: db.pepoch, epoch: db.epoch, cmds: (db.cmds[u.id] || []).slice(0, 50) }),
  'POST /ack': (u, b) => { db.cmds[u.id] = (db.cmds[u.id] || []).filter(c => !(b.ids || []).includes(c.id)); save(); return {}; },
  'POST /drop': (u, b) => {
    const items = (b.items || []).slice(0, 20).map(i => ({ n: String(i.name).slice(0, 40), v: Math.floor(+i.val) || 0, r: Math.max(0, Math.min(7, +i.r | 0)) }));
    if (!items.length) return {};
    db.drops.unshift({ t: Date.now(), u: u.username ? '@' + u.username : (u.first_name || 'ID' + u.id), id: u.id, c: String(b.case || '').slice(0, 30), items });
    db.drops.length = Math.min(db.drops.length, 40); dirty = true; save(); return {};
  },
  'POST /promo/create': (u, b) => {
    const code = String(b.code || '').toLowerCase(), amount = Math.floor(+b.amount), uses = Math.floor(+b.uses);
    if (!/^[a-z0-9_]{3,16}$/.test(code) || !(amount > 0) || !(uses > 0) || uses > 1000) return [400, { error: 'bad' }];
    if (db.promos[code]) return [409, { error: 'exists' }];
    db.promos[code] = { amount, left: uses, by: String(u.id), used: [] }; save(); return {};
  },
  'POST /promo/redeem': (u, b) => {
    const code = String(b.code || '').toLowerCase();
    const p = db.promos[code]; if (!p) return [404, { error: 'notfound' }];
    if (p.used.includes(String(u.id))) return [400, { error: 'used' }];
    if (p.left <= 0) return [400, { error: 'empty' }];
    p.left--; p.used.push(String(u.id)); save(); return { amount: p.amount };
  },
  'POST /admin/login': (u, b) => {
    if (tooMany(u.id)) return [429, { error: 'slow' }];
    if (String(b.code || '').trim().toLowerCase() !== ADMIN_CODE.toLowerCase()) return [403, { error: 'no' }];
    if (!db.admins.includes(String(u.id))) { db.admins.push(String(u.id)); save(); } return { ok: true };
  },
  'POST /admin/resetall': (u) => {
    if (!isAdmin(u.id)) return [403, { error: 'no' }];
    db.epoch++; db.inf = []; save(); return { ok: true, epoch: db.epoch };
  },
  'POST /admin/promoreset': (u, b) => {
    if (!isAdmin(u.id)) return [403, { error: 'no' }];
    const code = String(b.code || '').toLowerCase(), amount = Math.floor(+b.amount), uses = Math.floor(+b.uses);
    if (!/^[a-z0-9_]{3,16}$/.test(code) || !(amount > 0) || !(uses > 0) || uses > 100000 ) return [400, { error: 'bad' }];
    db.promos = { [code]: { amount, left: uses, by: 'admin', used: [] } }; db.pepoch++; save(); return { ok: true };
  },
  'POST /admin/promo': (u, b) => {
    if (!isAdmin(u.id)) return [403, { error: 'no' }];
    const code = String(b.code || '').toLowerCase(), amount = Math.floor(+b.amount), uses = Math.floor(+b.uses);
    if (!/^[a-z0-9_]{3,16}$/.test(code) || !(amount > 0) || !(uses > 0) || uses > 100000 ) return [400, { error: 'bad' }];
    db.promos[code] = { amount, left: uses, by: 'admin', used: [] }; save(); return { ok: true };
  },
  'POST /admin/closed': (u, b) => {
    if (!isAdmin(u.id)) return [403, { error: 'no' }];
    db.closed = !!b.closed; save(); return { ok: true, closed: db.closed };
  },
  'POST /admin/clearinv': (u) => {
    if (!isAdmin(u.id)) return [403, { error: 'no' }];
    db.iepoch++; save(); return { ok: true };
  },
  'POST /admin/cmd': (u, b) => {
    if (!isAdmin(u.id)) return [403, { error: 'no' }];
    let target = String(b.target || '').trim(); if (/^@?[A-Za-z0-9_]{3,32}$/.test(target) && !/^\d+$/.test(target)) { target = db.names[target.replace('@', '').toLowerCase()]; if (!target) return [404, { error: 'nouser' }]; }
    if (!/^\d{5,15}$/.test(target) || !['reset', 'coins', 'give', 'clearinv'].includes(b.type)) return [400, { error: 'bad' }];
    const cmd = { id: 'c' + db.seq++, type: b.type, amount: Math.min(1e12, Math.max(0, Math.floor(+b.amount) || 0)), item: String(b.item || '').slice(0, 60), qty: Math.max(1, Math.min(100, Math.floor(+b.qty) || 1)) };
    (db.cmds[target] = db.cmds[target] || []).push(cmd); save(); return { ok: true };
  },
};

http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const url = req.url.split('?')[0];
  if (url === '/api/health') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, v: 2, token: !!BOT_TOKEN, admins: ADMIN_IDS.length })); }
  if (url.startsWith('/api/')) {
    let body = ''; req.on('data', d => { body += d; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      const send = (code, o) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const h = routes[req.method + ' ' + url.slice(4)]; if (!h) return send(404, { error: 'nf' });
      const u = verify(req.headers['x-init-data']); if (!u) return send(401, { error: 'auth' });
      if (u.username) { const k = u.username.toLowerCase(); if (db.names[k] !== String(u.id)) { db.names[k] = String(u.id); save(); } }
      if (db.closed && !isAdmin(u.id) && !['GET /me', 'POST /admin/login'].includes(req.method + ' ' + url.slice(4))) return send(503, { error: 'closed' });
      let b = {}; try { b = body ? JSON.parse(body) : {}; } catch (e) {}
      let r; try { r = h(u, b); } catch (e) { return send(500, { error: 'srv' }); }
      Array.isArray(r) ? send(r[0], r[1]) : send(200, r);
    });
    return;
  }
  if (url === '/' || url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res); }
  res.writeHead(404); res.end();
}).listen(process.env.PORT || 3000);

// ---------- TELEGRAM BOT ----------
const tg = (m, p) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(r => r.json()).catch(() => ({}));
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const liveText = () => {
  const rows = db.drops.slice(0, 20).map(d => {
    const tm = new Date(d.t).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Kyiv' });
    const it = d.items.map(i => `${esc(i.n)} (${RN[i.r]}) 💰${i.v}`).join(', ');
    return `<code>${tm}</code> <b>${esc(d.u)}</b> · <code>${d.id}</code>\n   🎁 ${it} · <i>${esc(d.c)}</i>`;
  });
  return '📡 <b>LIVE · що випадає гравцям</b>\n\n' + (rows.join('\n') || 'Поки порожньо…');
};
async function poll(off) {
  const r = await tg('getUpdates', { offset: off, timeout: 25, allowed_updates: ['message'] });
  for (const up of r.result || []) {
    off = up.update_id + 1; const m = up.message; if (!m || !m.text) continue;
    if (m.text.startsWith('/live') && isAdmin(m.from.id)) {
      const s = await tg('sendMessage', { chat_id: m.chat.id, text: liveText(), parse_mode: 'HTML' });
      if (s.ok) { db.live = { chat: m.chat.id, msg: s.result.message_id }; save(); }
    } else if (m.text.startsWith('/start')) {
      await tg('sendMessage', { chat_id: m.chat.id, text: '🧠 Brainrot Farm', reply_markup: WEBAPP_URL ? { inline_keyboard: [[{ text: '🎮 Грати', web_app: { url: WEBAPP_URL } }]] } : undefined });
    }
  }
  setTimeout(() => poll(off), 100);
}
if (BOT_TOKEN) {
  poll(0);
  let last = '';
  setInterval(async () => {
    if (!db.live || !dirty) return; const text = liveText(); if (text === last) return; dirty = false; last = text;
    await tg('editMessageText', { chat_id: db.live.chat, message_id: db.live.msg, text, parse_mode: 'HTML' });
  }, 4000);
}
