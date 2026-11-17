// Локальный сервер: статика + /api/lead (как на Vercel).
// Запуск: npm run dev  →  http://localhost:3000
// Если в .env нет TELEGRAM_BOT_TOKEN — сообщение не отправляется, а печатается в консоль.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.log("⚠️  TELEGRAM_BOT_TOKEN не задан — режим заглушки, заявки печатаются в консоль.\n");
  process.env.TELEGRAM_BOT_TOKEN = "mock";
  process.env.TELEGRAM_CHAT_ID ||= "mock";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      console.log("──── сообщение в Telegram ────\n" + JSON.parse(opts.body).text + "\n──────────────────────────────");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return realFetch(url, opts);
  };
}

const { default: handler } = await import("../api/lead.js");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp", ".png": "image/png", ".json": "application/json" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/lead") {
    let raw = "";
    for await (const c of req) raw += c;
    try { req.body = raw ? JSON.parse(raw) : undefined; } catch { req.body = raw; }
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(o)); return res; };
    return handler(req, res);
  }
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (p.endsWith("/")) p += "index.html";
  if (!extname(p) && existsSync(join(root, p + ".html"))) p += ".html";
  if (p.startsWith("/api/") || p.startsWith("/_design") || p.includes("/.")) { res.statusCode = 404; return res.end("Not found"); }
  try {
    const data = await readFile(join(root, p));
    res.setHeader("Content-Type", types[extname(p)] || "application/octet-stream");
    res.end(data);
  } catch { res.statusCode = 404; res.end("Not found"); }
}).listen(process.env.PORT || 3000, () => console.log(`→ http://localhost:${process.env.PORT || 3000}`));
