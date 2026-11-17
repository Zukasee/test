// Vercel Serverless Function: POST /api/lead → сообщение в Telegram.
// Переменные окружения: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (можно несколько через запятую),
// ALLOWED_ORIGINS (необязательно, через запятую), SITE_NAME, TIMEZONE.
import { parseLead, formatMessage, sendToTelegram, rateLimited, readConfig, LeadError } from "./_lead-core.js";

const GENERIC_ERROR = "Не удалось отправить заявку. Попробуйте ещё раз или напишите нам напрямую.";

export default async function handler(req, res) {
  const cfg = readConfig();
  const origin = (req.headers.origin || "").replace(/\/$/, "");

  res.setHeader("Cache-Control", "no-store");
  if (cfg.allowedOrigins.length && origin) {
    if (!cfg.allowedOrigins.includes(origin)) return res.status(403).json({ ok: false, error: "Forbidden" });
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: "Слишком много заявок. Попробуйте позже." });

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);
    const lead = parseLead(body);
    if (lead.spam) return res.status(200).json({ ok: true });

    await sendToTelegram(formatMessage(lead, { ip, siteName: cfg.siteName }), cfg);
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof SyntaxError) return res.status(400).json({ ok: false, error: "Некорректный запрос." });
    if (err instanceof LeadError) {
      if (err.status >= 500) console.error("[lead] delivery failed / misconfigured (check TELEGRAM_* env vars)");
      return res.status(err.status).json({ ok: false, error: err.message || GENERIC_ERROR });
    }
    console.error("[lead]", err);
    return res.status(500).json({ ok: false, error: GENERIC_ERROR });
  }
}
