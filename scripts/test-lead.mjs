// Тесты обработчика заявок (без реальной отправки). Запуск: npm test
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN = "TEST_TOKEN";
process.env.TELEGRAM_CHAT_ID = "111,222";
const sent = [];
let telegramFails = 0;
globalThis.fetch = async (url, opts) => {
  sent.push({ url, body: JSON.parse(opts.body) });
  if (telegramFails-- > 0) return new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

const { default: handler } = await import("../api/lead.js");
const { validContact } = await import("../api/_lead-core.js");

let ipN = 0;
async function call(body, { method = "POST", ip } = {}) {
  const res = { headers: {}, statusCode: 200, payload: undefined,
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
    json(o) { this.payload = o; return this; }, end() { return this; } };
  await handler({ method, headers: { "x-forwarded-for": ip || `10.0.0.${++ipN}` }, body }, res);
  return res;
}
const good = { name: "Иван <b>", contact: "@ivan_petrov", consent: true, website: "", elapsed: 20000,
  answers: [{ question: "Какое направление?", answer: "Спорт & активность" }, { question: "Что именно?", answer: "Силовые" }],
  utm: { utm_source: "yandex", "bad key!": "x" }, page: "https://site.ru/?utm_source=yandex", referrer: "" };

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };

await t("валидные контакты", () => {
  for (const c of ["@ivan_petrov", "ivan_petrov", "t.me/ivan_petrov", "https://t.me/ivan_petrov", "+7 (999) 123-45-67", "89991234567", "+375291234567"]) assert.ok(validContact(c), c);
  for (const c of ["", "@ab", "123", "hello world", "+7 999", "<script>", "ivan@mail"]) assert.ok(!validContact(c), c);
});

await t("успешная заявка уходит во все чаты, HTML экранирован", async () => {
  sent.length = 0;
  const r = await call(good);
  assert.equal(r.statusCode, 200); assert.deepEqual(r.payload, { ok: true });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((s) => s.body.chat_id), ["111", "222"]);
  const text = sent[0].body.text;
  assert.match(sent[0].url, /botTEST_TOKEN\/sendMessage$/);
  assert.equal(sent[0].body.parse_mode, "HTML");
  assert.ok(text.includes("Иван &lt;b&gt;"));
  assert.ok(text.includes("Спорт &amp; активность"));
  assert.ok(text.includes('<a href="https://t.me/ivan_petrov">@ivan_petrov</a>'));
  assert.ok(text.includes("utm_source: yandex") && !text.includes("bad key"));
  console.log("\n" + text + "\n");
});

await t("телефон 8XXX → ссылка +7", async () => {
  sent.length = 0;
  await call({ ...good, contact: "8 999 123-45-67" });
  assert.ok(sent[0].body.text.includes('<a href="tel:+79991234567">+79991234567</a>'));
});

await t("honeypot и слишком быстрая отправка — 200, но без отправки", async () => {
  sent.length = 0;
  assert.equal((await call({ ...good, website: "http://spam" })).statusCode, 200);
  assert.equal((await call({ ...good, elapsed: 300 })).statusCode, 200);
  assert.equal(sent.length, 0);
});

await t("валидация: 422 с понятной ошибкой", async () => {
  assert.equal((await call({ ...good, name: "" })).statusCode, 422);
  assert.equal((await call({ ...good, contact: "123" })).statusCode, 422);
  const r = await call({ ...good, consent: false });
  assert.equal(r.statusCode, 422); assert.match(r.payload.error, /согласие/);
  assert.equal((await call(null)).statusCode, 400);
  assert.equal((await call("{not json")).statusCode, 400);
});

await t("только POST", async () => assert.equal((await call(good, { method: "GET" })).statusCode, 405));

await t("один чат упал — заявка всё равно ok; оба упали — 502", async () => {
  telegramFails = 1; assert.equal((await call(good)).statusCode, 200);
  telegramFails = 2; const r = await call(good);
  assert.equal(r.statusCode, 502); assert.equal(r.payload.ok, false);
  telegramFails = 0;
});

await t("лимит: 6-я заявка с одного IP — 429", async () => {
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call(good, { ip: "9.9.9.9" })).statusCode);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
});

await t("нет токена — 500 без утечки деталей", async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  const r = await call(good);
  assert.equal(r.statusCode, 500); assert.ok(!/token|TELEGRAM/i.test(r.payload.error));
});

console.log(`\nВсе тесты пройдены (${n}).`);
