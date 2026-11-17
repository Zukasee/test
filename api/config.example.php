<?php
// Скопируйте этот файл в config.php (рядом) и заполните значения.
// config.php закрыт от прямого доступа через .htaccess и не должен попадать в git.
return [
    'TELEGRAM_BOT_TOKEN' => '123456789:AA...your-token...',
    'TELEGRAM_CHAT_ID'   => '-1001234567890',   // несколько чатов — через запятую
    'ALLOWED_ORIGINS'    => '',                  // напр. 'https://example.ru,https://www.example.ru'
    'SITE_NAME'          => 'PEPTIDE / SELECT',
    'TIMEZONE'           => 'Europe/Moscow',
];
