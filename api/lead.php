<?php
// Обработчик заявок для обычного PHP-хостинга (PHP 7.4+ с curl).
// Настройки: скопируйте config.example.php → config.php и впишите токен/чат
// (или задайте переменные окружения TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).
// В index.html поменяйте CONFIG.endpoint на "/api/lead.php".

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$cfg = file_exists(__DIR__ . '/config.php') ? require __DIR__ . '/config.php' : [];
$token    = trim($cfg['TELEGRAM_BOT_TOKEN'] ?? getenv('TELEGRAM_BOT_TOKEN') ?: '');
$chatIds  = array_filter(array_map('trim', explode(',', $cfg['TELEGRAM_CHAT_ID'] ?? getenv('TELEGRAM_CHAT_ID') ?: '')));
$origins  = array_filter(array_map(fn($o) => rtrim(trim($o), '/'), explode(',', $cfg['ALLOWED_ORIGINS'] ?? getenv('ALLOWED_ORIGINS') ?: '')));
$siteName = $cfg['SITE_NAME'] ?? 'PEPTIDE / SELECT';
$tz       = $cfg['TIMEZONE'] ?? 'Europe/Moscow';

function respond(int $status, array $data) {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}
function fail(int $status, string $msg) { respond($status, ['ok' => false, 'error' => $msg]); }
function s($v, int $max): string { return is_string($v) ? mb_substr(trim($v), 0, $max) : ''; }
function e(string $v): string { return htmlspecialchars($v, ENT_NOQUOTES, 'UTF-8'); }

$generic = 'Не удалось отправить заявку. Попробуйте ещё раз или напишите нам напрямую.';

$origin = rtrim($_SERVER['HTTP_ORIGIN'] ?? '', '/');
if ($origins && $origin && !in_array($origin, $origins, true)) fail(403, 'Forbidden');
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { header('Allow: POST'); fail(405, 'Method Not Allowed'); }

// --- лимит частоты: не более 5 заявок с IP за 10 минут ---
$ip = $_SERVER['REMOTE_ADDR'] ?? '';
$rlFile = sys_get_temp_dir() . '/lead_rl_' . md5($ip);
$now = time();
$hits = array_filter((array)json_decode(@file_get_contents($rlFile) ?: '[]', true), fn($t) => $now - $t < 600);
$hits[] = $now;
@file_put_contents($rlFile, json_encode(array_values($hits)), LOCK_EX);
if (count($hits) > 5) fail(429, 'Слишком много заявок. Попробуйте позже.');

// --- разбор и валидация ---
$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) fail(400, 'Некорректный запрос.');

if (s($body['website'] ?? '', 200) !== '') respond(200, ['ok' => true]);                      // honeypot
if (is_numeric($body['elapsed'] ?? null) && $body['elapsed'] < 2500) respond(200, ['ok' => true]); // бот

$name = s($body['name'] ?? '', 80);
$contact = s($body['contact'] ?? '', 120);
if (mb_strlen($name) < 2) fail(422, 'Укажите, как к вам обращаться.');

$digits = preg_replace('/\D/', '', $contact);
$isTg = preg_match('~^(?:@|(?:https?://)?t\.me/)([a-zA-Z][a-zA-Z0-9_]{3,31})$~', $contact, $m)
        || preg_match('~^([a-zA-Z][a-zA-Z0-9_]{4,31})$~', $contact, $m);
$isPhone = preg_match('/^[+\d\s()\-.]+$/', $contact) && strlen($digits) >= 10 && strlen($digits) <= 15;
if (!$isTg && !$isPhone) fail(422, 'Укажите Telegram (@username) или телефон.');
if (($body['consent'] ?? null) !== true) fail(422, 'Нужно согласие на обработку персональных данных.');

if ($isTg) {
    $contactHtml = '<a href="https://t.me/' . $m[1] . '">@' . e($m[1]) . '</a>';
} else {
    $phone = (strlen($digits) === 11 && $digits[0] === '8') ? '7' . substr($digits, 1) : $digits;
    $contactHtml = '<a href="tel:+' . $phone . '">+' . $phone . '</a>';
}

// --- сообщение ---
$date = new DateTime('now', new DateTimeZone($tz));
$lines = ["🆕 <b>Новая заявка — " . e($siteName) . "</b>", '', '👤 <b>Имя:</b> ' . e($name), '📞 <b>Контакт:</b> ' . $contactHtml];

$answers = array_slice(is_array($body['answers'] ?? null) ? $body['answers'] : [], 0, 5);
if ($answers) {
    $lines[] = ''; $lines[] = '📋 <b>Ответы:</b>';
    foreach (array_values($answers) as $i => $a) {
        $lines[] = ($i + 1) . '. ' . e(s($a['question'] ?? '', 200)) . "\n   → <b>" . e(s($a['answer'] ?? '', 200)) . '</b>';
    }
}
$utm = is_array($body['utm'] ?? null) ? array_slice($body['utm'], 0, 10, true) : [];
if ($utm) {
    $lines[] = ''; $lines[] = '🏷 <b>Метки:</b>';
    foreach ($utm as $k => $v) if (preg_match('/^[a-z_]{2,20}$/', $k)) $lines[] = e($k) . ': ' . e(s($v, 200));
}
$lines[] = '';
if ($p = s($body['page'] ?? '', 500)) $lines[] = '🌐 ' . e($p);
if ($r = s($body['referrer'] ?? '', 500)) $lines[] = '↩️ ' . e($r);
$lines[] = '🕒 ' . $date->format('d.m.Y, H:i:s') . ($ip ? ' · ' . e($ip) : '');
$text = implode("\n", $lines);

// --- отправка ---
if (!$token || !$chatIds) { error_log('[lead] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured'); fail(500, $generic); }

$sent = 0;
foreach ($chatIds as $chatId) {
    $ch = curl_init("https://api.telegram.org/bot{$token}/sendMessage");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode(['chat_id' => $chatId, 'text' => $text, 'parse_mode' => 'HTML', 'disable_web_page_preview' => true], JSON_UNESCAPED_UNICODE),
    ]);
    $res = json_decode((string)curl_exec($ch), true);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code === 200 && !empty($res['ok'])) $sent++;
    else error_log("[lead] Telegram {$code}: " . ($res['description'] ?? 'no response') . " (chat {$chatId})");
}

$sent > 0 ? respond(200, ['ok' => true]) : fail(502, $generic);
