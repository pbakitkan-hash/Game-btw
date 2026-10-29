// Brainrot Aura server — Node 18+, без зависимостей.
// ENV: BOT_TOKEN (обязательно), ADMIN_CODE (код админки), OWNER_IDS (tg id владельцев — всегда админы),
//      ADMIN_IDS (необязательно: id, которые всегда админы), APP_VER (версия: смени при обновлении — все админ-сессии сбросятся),
//      DB_FILE (путь к db.json; на Render подключи Disk), PORT
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const BOT = process.env.BOT_TOKEN || '', ADMIN_CODE = process.env.ADMIN_CODE || '', APP_VER = process.env.APP_VER || '1';
const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const OWNERS = list(process.env.OWNER_IDS), ADMIN_IDS = [...OWNERS, ...list(process.env.ADMIN_IDS)];
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');

let db = {users: {}, promos: {}, drops: [], paid: {}, admins: {}, mods: {}, closed: false, epoch: 0, iepoch: 0, pepoch: 0};
try { Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
let dirty = false; const save = () => { dirty = true; };
setInterval(() => { if (dirty) { dirty = false; try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { console.error('save', e.message); } } }, 3000);

const tgApi = (m, b) => fetch(`https://api.telegram.org/bot${BOT}/${m}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(b)}).then(r => r.json());
const INDEX = path.join(__dirname, 'index.html');
const ITEMV = {}; try { const m = fs.readFileSync(INDEX, 'utf8').match(/const POOL = (\[[\s\S]*?\])\.map\(/); for (const a of require('vm').runInNewContext(m[1])) ITEMV[a[0]] = a[2]; } catch (e) { console.error('POOL parse failed', e.message); }
const WHEEL = [['nothing', 45], ['gold', 30], ['diamond', 14], ['rainbow', 6], ['bloodroot', 3.5], ['crystal', 1.2], ['eclipsing', .3]];
const WH_CD = 3 * 864e5, UN_CD = 864e5, BOT_NAME = '@brainrotaura_bot';
const esc = s => String(s).replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
const rid = () => crypto.randomBytes(6).toString('hex');

function auth(req) { // перевірка підпису Telegram initData
  const raw = req.headers['x-init-data'] || ''; if (!BOT || !raw) return null;
  const p = new URLSearchParams(raw), h = p.get('hash'); p.delete('hash');
  const s = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  if (!h || crypto.createHmac('sha256', key).update(s).digest('hex') !== h) return null;
  if (Date.now() / 1e3 - (+p.get('auth_date') || 0) > 7 * 86400) return null;
  try { const u = JSON.parse(p.get('user')); return u && u.id ? u : null; } catch (e) { return null; }
}
function upsert(u) {
  const x = db.users[u.id] || (db.users[u.id] = {id: String(u.id), cmds: []});
  x.un = (u.username || '').toLowerCase(); x.name = u.username ? '@' + u.username : [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.id); save(); return x;
}
const isAdm = u => ADMIN_IDS.includes(String(u.id)) || db.admins[u.id] === APP_VER;
const isMod = u => !!db.mods[u.id];
const push = (x, c) => { x.cmds.push({id: rid(), t: Date.now(), ...c}); save(); };
const findUser = t => { t = String(t).replace('@', '').toLowerCase(); return db.users[t] || Object.values(db.users).find(x => x.un === t); };

const hits = {}; // ліміт спроб адмін-коду
const tooMany = ip => { const n = Date.now(), a = (hits[ip] = (hits[ip] || []).filter(t => n - t < 6e4)); a.push(n); return a.length > 8; };

async function api(req, res, p, b) {
  const J = (code, o) => { res.writeHead(code, {'Content-Type': 'application/json'}); res.end(JSON.stringify(o || {})); };
  const u = auth(req); if (!u) return J(401, {error: 'auth'});
  const me = upsert(u), adm = isAdm(u);
  if (db.closed && !adm && p !== '/me') return J(423, {error: 'closed'});

  if (p === '/me') return J(200, {closed: db.closed && !adm, serverClosed: adm ? db.closed : undefined, epoch: db.epoch, iepoch: db.iepoch, pepoch: db.pepoch, infinite: false, isAdmin: adm, isMod: isMod(u), wheelAt: me.wheelAt || 0, cmds: me.cmds});
  if (p === '/ack') { const ids = new Set(b.ids || []); me.cmds = me.cmds.filter(c => !ids.has(c.id)); save(); return J(200); }
  if (p === '/live') return J(200, {drops: db.drops.slice(0, 30)});
  if (p === '/drop') {
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 5).map(i => ({n: String(i.name).slice(0, 40), r: Math.max(0, Math.min(7, +i.r || 0)), v: +i.val || 0}));
    if (items.length) { db.drops.unshift({u: me.name, c: String(b.case || '').slice(0, 30), items, t: Date.now()}); db.drops.length = Math.min(db.drops.length, 60); save(); }
    return J(200);
  }
  // ---- промокоди ----
  if (p === '/promo/create') {
    const code = String(b.code || '').toLowerCase(), amount = Math.floor(+b.amount), uses = Math.floor(+b.uses);
    if (!/^[a-z0-9_]{3,16}$/.test(code) || !(amount > 0) || !(uses > 0) || uses > 1000) return J(400);
    if (db.promos[code]) return J(409); db.promos[code] = {amount, left: uses, by: [], owner: String(u.id)}; save(); return J(200);
  }
  if (p === '/promo/redeem') {
    const pr = db.promos[String(b.code || '').toLowerCase()]; if (!pr) return J(404, {error: 'none'});
    if (pr.by.includes(String(u.id))) return J(409, {error: 'used'}); if (pr.left <= 0) return J(409, {error: 'empty'});
    pr.left--; pr.by.push(String(u.id)); save(); return J(200, {amount: pr.amount});
  }
  // ---- колесо фортуни: раз на 3 дні, результат визначає сервер ----
  if (p === '/wheel/spin') {
    const left = (me.wheelAt || 0) + WH_CD - Date.now(); if (!adm && left > 0) return J(429, {left});
    let x = Math.random() * WHEEL.reduce((a, w) => a + w[1], 0), mut = 'nothing'; for (const [k, w] of WHEEL) { if ((x -= w) <= 0) { mut = k; break; } }
    me.wheelAt = Date.now(); save(); return J(200, {mut});
  }
  // ---- кейс за юзернейм: перевірка імені профілю через Bot API ----
  if (p === '/case/uname') {
    const left = (me.unAt || 0) + UN_CD - Date.now(); if (!adm && left > 0) return J(429, {error: 'cooldown', left});
    let ok = false; try { const r = await tgApi('getChat', {chat_id: u.id}); if (r.ok) ok = [r.result.first_name, r.result.last_name, r.result.bio].join(' ').toLowerCase().includes(BOT_NAME); } catch (e) {}
    if (!ok) return J(403, {error: 'nick'});
    me.unAt = Date.now(); save(); return J(200);
  }
  // ---- модератори: монети ≤ 10 000, 1 брейнрот ≤ 20 000 раз на годину ----
  if (p === '/admin/cmd' && !adm) {
    if (!isMod(u)) return J(403);
    const t = findUser(b.target); if (!t) return J(404);
    if (b.type === 'coins') { const a = Math.floor(+b.amount); if (!(a >= 1 && a <= 10000)) return J(403, {error: 'limit'}); push(t, {type: 'coins', amount: a}); return J(200); }
    if (b.type === 'give') {
      const v = ITEMV[b.item]; if (v == null || v > 20000) return J(403, {error: 'limit'});
      const left = (me.modGiveAt || 0) + 36e5 - Date.now(); if (left > 0) return J(429, {error: 'cooldown', left});
      me.modGiveAt = Date.now(); push(t, {type: 'give', item: String(b.item), qty: 1}); return J(200);
    }
    return J(403);
  }
  // ---- адмінка (залишається назавжди, доки не змінено APP_VER) ----
  if (p === '/admin/login') {
    if (adm && !b.code) return J(200);
    if (tooMany(req.socket.remoteAddress)) return J(429);
    if (ADMIN_CODE && b.code && String(b.code).toLowerCase() === ADMIN_CODE.toLowerCase()) { db.admins[u.id] = APP_VER; save(); return J(200); }
    return J(403);
  }
  if (!adm) return J(403);
  if (p === '/admin/mod') { const id = String(b.id || '').trim(); if (!/^\d{5,15}$/.test(id)) return J(400); if (b.on) db.mods[id] = true; else delete db.mods[id]; save(); return J(200); }
  if (p === '/admin/closed') { db.closed = !!b.closed; save(); return J(200); }
  if (p === '/admin/clearinv') { db.iepoch = Date.now(); save(); return J(200); }
  if (p === '/admin/resetall') { db.epoch = Date.now(); save(); return J(200); }
  if (p === '/admin/promo') { const code = String(b.code || '').toLowerCase(); db.promos[code] = {amount: Math.floor(+b.amount), left: Math.floor(+b.uses), by: [], owner: 'admin'}; save(); return J(200); }
  if (p === '/admin/promoreset') { const code = String(b.code || '').toLowerCase(); db.promos = {[code]: {amount: Math.floor(+b.amount), left: Math.floor(+b.uses), by: [], owner: 'admin'}}; db.pepoch = Date.now(); save(); return J(200); }
  if (p === '/admin/cmd') {
    const t = findUser(b.target); if (!t) return J(404);
    const type = ['coins', 'reset', 'give', 'clearinv'].includes(b.type) ? b.type : null; if (!type) return J(400);
    push(t, {type, amount: Math.floor(+b.amount) || 0, item: String(b.item || ''), qty: Math.max(1, Math.min(100, +b.qty || 1))}); return J(200);
  }
  return J(404);
}

http.createServer((req, res) => {
  const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'};
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const p = req.url.split('?')[0];
  if (p.startsWith('/api/')) {
    let raw = ''; req.on('data', d => { raw += d; if (raw.length > 2e5) req.destroy(); });
    return req.on('end', () => { let b = {}; try { b = raw ? JSON.parse(raw) : {}; } catch (e) {} api(req, res, p.slice(4), b).catch(e => { console.error(e); res.writeHead(500); res.end('{}'); }); });
  }
  fs.readFile(INDEX, (e, d) => { if (e) { res.writeHead(404); return res.end('no index.html'); } res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end(d); });
}).listen(process.env.PORT || 3000, () => console.log('server up'));
