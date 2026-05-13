# twitch-bot

Twitch-бот на Node.js + TypeScript:

1. **Логирует Channel Points награды.** Когда зритель активирует выбранную награду — бот записывает ник, текст комментария и метаданные награды в SQLite и в `data/redemptions.csv` (открывается в Excel/Google Sheets). Опционально — отправка в Discord-вебхук.
2. **Музыкальный бот для OBS.** Команда `!sr <название>` или специальная награда находит трек на YouTube и играет его через веб-оверлей, который добавляется в OBS как Browser Source — звук идёт прямо в стрим, ничего настраивать не нужно.

## Команды чата

| Команда | Кто | Описание |
| --- | --- | --- |
| `!sr <запрос>` | все (настраивается) | Заказать песню по названию / автору / ссылке YouTube |
| `!queue` (`!q`) | все | Показать текущий трек и очередь |
| `!skip` | модератор | Пропустить трек |
| `!clearqueue` | модератор | Очистить очередь |
| `!pause` / `!resume` | модератор | Пауза / продолжить |
| `!volume 0-100` | модератор | Громкость |
| `!help` | все | Список команд |

## Что нужно для запуска

1. Аккаунт Twitch и приложение в [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
   - **OAuth Redirect URLs**: `http://localhost:4489/callback`
   - **Category**: Chat Bot
   - Получи `Client ID` и `Client Secret`
2. Node.js 22+
3. (Опционально) Docker

## Установка

```bash
git clone <repo-url> twitch-bot
cd twitch-bot
cp .env.example .env
# Заполни TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_CHANNEL в .env
npm install
```

## Авторизация бота

Выполни OAuth-flow (откроется страница Twitch, нажми Authorize):

```bash
npm run auth
```

Если бот будет писать в чат от **отдельного аккаунта-бота**, повтори `npm run auth` ещё раз, залогинившись под бот-аккаунтом, и пропиши его логин в `TWITCH_BOT_LOGIN`. Если хочешь, чтобы бот писал от твоего основного канала — оставь `TWITCH_BOT_LOGIN` пустым.

Токены и refresh-токены сохраняются в `data/tokens.json` и автоматически обновляются.

## Настройка Channel Points наград

1. Создай нужные награды в Twitch Creator Dashboard (Channel Points → Manage Rewards & Challenges).
2. Найди ID каждой награды. Самый простой способ:
   - Запусти бота (`npm run dev`)
   - Сделай тестовый ввод награды на своём канале
   - ID будет в логе и в `data/redemptions.csv`
3. Скопируй нужные ID в `.env`:
   - `LOG_REWARD_IDS=id1,id2,id3` — какие награды записывать (пусто = все custom-награды)
   - `MUSIC_REWARD_ID=...` — ID награды "Заказать песню" (текст в комментарии будет использован как запрос)

## Запуск

```bash
# dev (auto-reload)
npm run dev

# prod
npm run build
npm start

# docker
docker compose up -d --build
```

## Настройка OBS

1. Запусти бота — в логе будет строка `OBS Browser Source URL: http://localhost:4488/overlay?token=...`
2. В OBS добавь источник **Browser Source**:
   - URL — вставь ссылку из лога
   - Width × Height: 1920 × 1080 (или под твою сцену)
   - **Поставь галочку**: *Control audio via OBS* — звук пойдёт через OBS-аудио и попадёт на стрим
3. Готово. Когда зритель закажет песню — на оверлее появится карточка "Now playing" с обложкой.

> Токен `OVERLAY_TOKEN` нужен, чтобы случайный человек не открыл твой оверлей. Можешь задать свой в `.env` или дать боту сгенерировать случайный при первом запуске.

## Структура файлов

```
src/
  index.ts              # entrypoint
  config.ts             # zod-валидация .env
  db.ts                 # SQLite (better-sqlite3)
  logger.ts             # logger
  twitch/auth.ts        # RefreshingAuthProvider + tokens.json
  features/redemptions.ts  # запись наград в CSV + DB + Discord
  features/music.ts     # очередь треков + поиск YouTube (yt-search)
  overlay/server.ts     # Express + WebSocket для OBS
  overlay/public/index.html  # OBS Browser Source
  commands/registry.ts  # диспетчер команд чата
  commands/builtin.ts   # !sr, !queue, !skip, !volume и т.д.
scripts/auth.ts         # one-time OAuth helper
data/                   # tokens.json, bot.db, redemptions.csv (gitignored)
```

## Где живут данные

| Файл | Что |
| --- | --- |
| `data/tokens.json` | OAuth токены (auto-refreshed). Не коммить. |
| `data/bot.db` | SQLite — все награды и метаданные |
| `data/redemptions.csv` | CSV для Excel/Google Sheets |

## Google Sheets (опционально)

Бот может писать каждую активацию награды напрямую в Google-таблицу через бесплатный Google Apps Script Web App. Без Google Cloud project, без JSON-ключей.

### Настройка (2 минуты)

1. Открой **новую** или существующую Google-таблицу. Запомни/переименуй лист, в который будут писаться данные (по умолчанию — `Sheet1` / `Лист1`).
2. В таблице: **Extensions → Apps Script** (Расширения → Apps Script).
3. Удали весь шаблонный код, вставь следующий:

   ```javascript
   // ============================================================
   // Twitch bot → Google Sheets sink
   // ============================================================
   const SHEET_NAME = 'Sheet1';   // если у тебя называется иначе — поменяй

   function doPost(e) {
     try {
       const data = JSON.parse(e.postData.contents);
       const ss = SpreadsheetApp.getActiveSpreadsheet();
       const sheet = ss.getSheetByName(SHEET_NAME) || ss.getActiveSheet();

       // Заголовки добавляем один раз, если лист пустой.
       if (sheet.getLastRow() === 0) {
         sheet.appendRow(['Дата', 'Награда', 'Ник', 'Комментарий']);
         sheet.getRange('A1:D1').setFontWeight('bold');
       }

       const date = data.redeemed_at ? new Date(data.redeemed_at) : new Date();
       sheet.appendRow([
         date,
         data.reward_title || '',
         data.user_display || data.user_login || '',
         data.user_input || '',
       ]);

       return ContentService
         .createTextOutput(JSON.stringify({ ok: true }))
         .setMimeType(ContentService.MimeType.JSON);
     } catch (err) {
       return ContentService
         .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
         .setMimeType(ContentService.MimeType.JSON);
     }
   }
   ```

4. Сохрани проект (Ctrl/Cmd+S), назови как хочешь.
5. Нажми **Deploy → New deployment**:
   - **Select type** (шестерёнка слева вверху) → **Web app**
   - **Description**: любое
   - **Execute as**: *Me*
   - **Who has access**: ⚠ **Anyone** (без этого бот не сможет POST-ить — Apps Script всегда требует Anyone для приёма webhook-ов без логина)
   - Жми **Deploy**
6. При первом деплое Google попросит авторизовать скрипт:
   - **Authorize access** → выбери свой Google-аккаунт
   - Появится экран "Google hasn't verified this app" → **Advanced → Go to <имя проекта> (unsafe)** → **Allow**
   - Это нормально: ты разрешаешь свой собственный скрипт писать в свою же таблицу.
7. Скопируй **Web app URL** — он выглядит как `https://script.google.com/macros/s/AKfycb.../exec`.
8. В `.env` пропиши:
   ```
   GOOGLE_SHEETS_WEBHOOK=https://script.google.com/macros/s/AKfycb.../exec
   ```
9. Перезапусти бота.

Теперь каждая активация награды добавляет строку: **Дата | Награда | Ник | Комментарий**.

### Если что-то не пишется

- В Apps Script: **View → Executions** (или левое меню "Executions") — там видно каждый запрос и ошибки.
- В логах бота ищи строки `[sheets]` — там warning, если webhook вернул не-2xx.
- Самая частая ошибка: при деплое выбрал **Only myself** вместо **Anyone** → бот получает 401. Открой Deployments → Edit → поменяй на Anyone.

### Если меняешь скрипт после деплоя

Apps Script деплоит **версию**. После правок кода нужно: **Deploy → Manage deployments → ✏ (Edit) → Version: New version → Deploy**. URL при этом не меняется.

### Несколько листов на разные награды

В скрипте замени строку `const sheet = ...` на:
```javascript
const sheet =
  ss.getSheetByName(data.reward_title) ||
  ss.insertSheet(data.reward_title);
```
Каждая награда автоматически получит свой лист с тем же названием. Заголовки придётся добавить вручную или продублировать блок `if (sheet.getLastRow() === 0)`.

## Скоупы OAuth

Бот запрашивает: `chat:read`, `chat:edit`, `channel:read:redemptions`, `channel:manage:redemptions`, `moderator:read:followers`.

## Лицензия

MIT
