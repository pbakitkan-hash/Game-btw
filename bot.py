# BrainrotFarm: Mini App (index.html) + API ленты дропов + Telegram-бот (webhook).
# Без внешних библиотек — только стандартный Python 3.9+.
import hashlib
import json
import os
import re
import threading
import time
import urllib.request
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "3000"))
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
BASE_URL = (os.environ.get("PUBLIC_URL") or os.environ.get("RENDER_EXTERNAL_URL") or "").rstrip("/")
SECRET = hashlib.sha256(BOT_TOKEN.encode()).hexdigest()[:48] if BOT_TOKEN else ""
HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "index.html")

drops = []                    # лента дропов (в памяти)
hits = defaultdict(list)      # ip -> метки времени (лимит запросов)
lock = threading.Lock()


# ---------- Telegram API ----------
def tg(method, body=None):
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{BOT_TOKEN}/{method}",
        data=json.dumps(body or {}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.load(r)
    if not data.get("ok"):
        raise RuntimeError(f"{method}: {data.get('description')}")
    return data["result"]


def on_update(u):
    m = u.get("message")
    if not m or "chat" not in m:
        return
    name = (m.get("from") or {}).get("first_name", "друже")
    tg("sendMessage", {
        "chat_id": m["chat"]["id"],
        "text": f"Привіт, {name}! 🧠🐄\nВідкривай кейси, апгрейдь брейнротів і переходь дорогу з коровою.",
        "reply_markup": {"inline_keyboard": [[{"text": "🎮 Грати", "web_app": {"url": BASE_URL}}]]},
    })


def setup_bot():
    if not BOT_TOKEN:
        return print("BOT_TOKEN не задан — бот выключен, работает только сайт", flush=True)
    if not BASE_URL:
        return print("Нет PUBLIC_URL / RENDER_EXTERNAL_URL — webhook не установлен", flush=True)
    for i in range(1, 6):
        try:
            tg("setWebhook", {"url": f"{BASE_URL}/webhook", "secret_token": SECRET,
                              "allowed_updates": ["message"]})
            tg("setChatMenuButton", {"menu_button": {"type": "web_app", "text": "Грати",
                                                     "web_app": {"url": BASE_URL}}})
            return print("Webhook установлен:", f"{BASE_URL}/webhook", flush=True)
        except Exception as e:
            print(f"setup попытка {i}: {e}", flush=True)
            time.sleep(3 * i)


# ---------- helpers ----------
def clean(v, n):
    return re.sub(r"[\x00-\x1f<>]", "", str(v if v is not None else ""))[:n]


def limited(ip):
    now = time.time()
    with lock:
        arr = [t for t in hits[ip] if now - t < 60] + [now]
        hits[ip] = arr
        if len(hits) > 5000:
            hits.clear()
        return len(arr) > 40


class Handler(BaseHTTPRequestHandler):
    server_version = "BrainrotFarm"

    def log_message(self, *a):
        pass

    def send(self, code, body=b"", ctype="application/json; charset=utf-8", cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def js(self, code, obj):
        self.send(code, json.dumps(obj, ensure_ascii=False).encode())

    def body(self, limit=4096):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError("too large")
        return self.rfile.read(n).decode("utf-8") if n else ""

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            return self.js(200, {"ok": True, "t": int(time.time() * 1000)})
        if path in ("/", "/index.html"):
            with open(INDEX, "rb") as f:
                return self.send(200, f.read(), "text/html; charset=utf-8", "no-cache")
        if path == "/api/last-drops":
            with lock:
                return self.js(200, drops)
        self.send(404, b"Not found", "text/plain")

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            if path == "/api/drop":
                ip = (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()
                if limited(ip):
                    return self.js(429, {"ok": False})
                b = json.loads(self.body() or "{}")
                item = clean(b.get("itemName"), 60)
                if not item:
                    return self.js(400, {"ok": False})
                try:
                    value = max(0, int(float(b.get("value") or 0)))
                except (TypeError, ValueError):
                    value = 0
                with lock:
                    drops.insert(0, {"username": clean(b.get("username"), 40) or "Гравець",
                                     "itemName": item, "itemIcon": clean(b.get("itemIcon"), 16),
                                     "value": value, "t": int(time.time() * 1000)})
                    del drops[20:]
                return self.js(200, {"ok": True})

            if path == "/webhook":
                if not SECRET or self.headers.get("X-Telegram-Bot-Api-Secret-Token") != SECRET:
                    return self.send(403, b"", "text/plain")
                update = json.loads(self.body(65536) or "{}")
                self.send(200, b"ok", "text/plain")
                threading.Thread(target=lambda: _safe(on_update, update), daemon=True).start()
                return
            self.send(404, b"Not found", "text/plain")
        except Exception:
            try:
                self.js(400, {"ok": False})
            except Exception:
                pass


def _safe(fn, *a):
    try:
        fn(*a)
    except Exception as e:
        print("update error:", e, flush=True)


if __name__ == "__main__":
    print("Server on", PORT, flush=True)
    threading.Thread(target=setup_bot, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
