// Общая логика обработки заявки: валидация + отправка в Telegram.
// Файл начинается с "_", поэтому Vercel не публикует его как отдельный endpoint.

const LIMITS = { name: 80, contact: 120, answers: 5, text: 200, url: 500 };
const MIN_FILL_MS = 2500; // быстрее — почти наверняка бот

export class LeadError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function validContact(v) {
  const s = v.trim();
  if (/^(@|(https?:\/\/)?t\.me\/)[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(s)) return true;
  if (/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(s)) return true;
  const digits = s.replace(/\D/g, "");
  return /^[+\d\s()\-.]+$/.test(s) && digits.length >= 10 && digits.length <= 15;
}

/** Возвращает { spam: true } для ботов (им отвечаем 200, но ничего не шлём) или нормализованную заявку. */
export function parseLead(body) {
  if (!body || typeof body !== "object") throw new LeadError(400, "Некорректный запрос.");

  if (str(body.website, 200)) return { spam: true };                                     // honeypot
  if (typeof body.elapsed === "number" && body.elapsed < MIN_FILL_MS) return { spam: true }; // слишком быстро

  const name = str(body.name, LIMITS.name);
  const contact = str(body.contact, LIMITS.contact);
  if (name.length < 2) throw new LeadError(422, "Укажите, как к вам обращаться.");
  if (!validContact(contact)) throw new LeadError(422, "Укажите Telegram (@username) или телефон.");
  if (body.consent !== true) throw new LeadError(422, "Нужно согласие на обработку персональных данных.");

  const answers = (Array.isArray(body.answers) ? body.answers : [])
    .slice(0, LIMITS.answers)
    .map((a) => ({ question: str(a?.question, LIMITS.text), answer: str(a?.answer, LIMITS.text) }))
    .filter((a) => a.answer);

  const utm = {};
  if (body.utm && typeof body.utm === "object") {
    for (const [k, v] of Object.entries(body.utm).slice(0, 10)) {
      if (/^[a-z_]{2,20}$/.test(k)) utm[k] = str(v, LIMITS.text);
    }
  }

  return {
    name, contact, answers, utm,
    page: str(body.page, LIMITS.url),
    referrer: str(body.referrer, LIMITS.url),
  };
}

function contactLink(contact) {
  const tg = contact.match(/^(?:@|(?:https?:\/\/)?t\.me\/)?([a-zA-Z][a-zA-Z0-9_]{3,31})$/);
  if (tg && !/^[+\d]/.test(contact)) return `<a href="https://t.me/${tg[1]}">@${esc(tg[1])}</a>`;
  const digits = contact.replace(/\D/g, "");
  if (digits.length >= 10) {
    const phone = (digits.length === 11 && digits[0] === "8" ? "7" + digits.slice(1) : digits);
    return `<a href="tel:+${phone}">+${phone}</a>`;
  }
  return esc(contact);
}

export function formatMessage(lead, { ip, siteName = "PEPTIDE / SELECT" } = {}) {
  const time = new Date().toLocaleString("ru-RU", { timeZone: process.env.TIMEZONE || "Europe/Moscow" });
  const lines = [
    `🆕 <b>Новая заявка — ${esc(siteName)}</b>`,
    "",
    `👤 <b>Имя:</b> ${esc(lead.name)}`,
    `📞 <b>Контакт:</b> ${contactLink(lead.contact)}`,
  ];
  if (lead.answers.length) {
    lines.push("", "📋 <b>Ответы:</b>");
    lead.answers.forEach((a, i) => lines.push(`${i + 1}. ${esc(a.question)}\n   → <b>${esc(a.answer)}</b>`));
  }
  const utm = Object.entries(lead.utm);
  if (utm.length) {
    lines.push("", "🏷 <b>Метки:</b>");
    utm.forEach(([k, v]) => lines.push(`${esc(k)}: ${esc(v)}`));
  }
  lines.push("");
  if (lead.page) lines.push(`🌐 ${esc(lead.page)}`);
  if (lead.referrer) lines.push(`↩️ ${esc(lead.referrer)}`);
  lines.push(`🕒 ${esc(time)}${ip ? ` · ${esc(ip)}` : ""}`);
  return lines.join("\n");
}

export async function sendToTelegram(text, { token, chatIds }) {
  if (!token || !chatIds.length) throw new LeadError(500, null);
  const results = await Promise.allSettled(chatIds.map(async (chat_id) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(`Telegram ${r.status}: ${data.description || "unknown error"} (chat ${chat_id})`);
  }));
  const failed = results.filter((r) => r.status === "rejected");
  failed.forEach((f) => console.error("[lead]", f.reason?.message));
  // заявка считается доставленной, если дошла хотя бы в один чат
  if (failed.length === results.length) throw new LeadError(502, null);
}

// Простейший лимит частоты по IP (в пределах одного инстанса функции).
const hits = new Map();
export function rateLimited(ip, max = 5, windowMs = 10 * 60 * 1000) {
  if (!ip) return false;
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

export function readConfig(env = process.env) {
  return {
    token: (env.TELEGRAM_BOT_TOKEN || "").trim(),
    chatIds: (env.TELEGRAM_CHAT_ID || "").split(",").map((s) => s.trim()).filter(Boolean),
    allowedOrigins: (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
    siteName: env.SITE_NAME || "PEPTIDE / SELECT",
  };
}
