# DearBot

Twitch-бот на Node.js + TypeScript для **стримера**:

1. **Логирует Channel Points награды** в Google Sheets / CSV / SQLite. Ник, награда, текст комментария, дата.
2. **Музыкальный бот для OBS.** `!sr <название>` или специальная награда находит трек на YouTube и проигрывает в OBS Browser Source — звук идёт прямо в стрим, ничего настраивать не нужно.

> **Стример, который хочет просто запустить бота**, открывает **[SETUP_GUIDE.md](SETUP_GUIDE.md)** — это пошаговая инструкция от форка репозитория до работающего бота на Railway. Никакого кода писать не надо, всё через визард.
>
> Этот README — для разработчика, который хочет запустить бота локально и понять, как он устроен.

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

## Архитектура

```
┌──────────────┐   EventSub WS    ┌────────────┐
│  Twitch      │ ────────────────►│            │
│  (chat, CP)  │ ◄──────tmi/api───│  DearBot   │
└──────────────┘                  │            │     ┌──────────────────┐
                                  │  Express   │◄────│  Browser (OBS)   │ ── audio ──► stream
                                  │  + WS      │     │  /overlay        │
                                  │  + setup   │     └──────────────────┘
                                  └────┬───────┘
                          ┌────────────┼────────────┐
                          ▼            ▼            ▼
                    data/bot.db   data/*.csv  Google Sheets
```

Бот всегда поднимает один Express-сервер на `$PORT` (Railway/Fly/Render) или `OVERLAY_PORT` (локально), на нём живут три вещи:

- `/setup` — пошаговый веб-визард для streamer'а (Client ID/Secret, OAuth, выбор наград, Google Sheets, OBS URL).
- `/overlay` — OBS Browser Source с YouTube IFrame Player + WebSocket для синхронизации очереди.
- `/healthz` — health-check для платформы хостинга.

Если визард ещё не пройден (`data/config.json` пустой), Twitch-сервисы (чат, EventSub) не стартуют — работает только web-сервер с визардом. После сохранения конфига бот сам поднимает Twitch-runtime в том же процессе.

## Локальная разработка

```bash
git clone https://github.com/Almaz161/DearBot.git
cd DearBot
cp .env.example .env       # опционально: можно вообще ничего не править
npm install
npm run dev                # стартует с пустым конфигом → открой http://localhost:4488/setup
```

Линт / типы / билд / smoke-тест:

```bash
npm run lint
npm run typecheck
npm run build
npx tsx scripts/smoke.ts
```

Smoke-тест запускает только overlay-сервер с фиктивной MusicService — не требует Twitch-кредов.

## Структура файлов

```
src/
  index.ts                 # точка входа — стартует web + опционально runtime
  config.ts                # zod + слияние .env с data/config.json
  configStore.ts           # data/config.json
  db.ts                    # SQLite (better-sqlite3)
  logger.ts                # logger
  twitch/auth.ts           # RefreshingAuthProvider + tokens.json
  features/redemptions.ts  # CSV + DB + Discord + Google Sheets
  features/music.ts        # очередь + поиск YouTube (yt-search)
  features/googleSheets.ts # POST в Apps Script webhook
  overlay/server.ts        # Express + WebSocket + setup роутер
  overlay/public/index.html# OBS Browser Source
  setup/router.ts          # /setup, /setup/oauth/*, /setup/api/*
  setup/public/setup.html  # SPA-визард
  commands/registry.ts     # диспетчер команд чата
  commands/builtin.ts      # !sr, !queue, !skip, !volume и т.д.
scripts/
  auth.ts                  # legacy CLI OAuth helper (визард — основной путь)
  smoke.ts                 # smoke-тест без Twitch
data/                      # tokens.json, bot.db, redemptions.csv, config.json (gitignored)
```

## Где живут данные

| Файл | Что |
| --- | --- |
| `data/tokens.json` | OAuth токены (auto-refreshed). |
| `data/config.json` | Настройки из визарда: Client ID/Secret, награды, Google Sheets URL. |
| `data/bot.db` | SQLite — лог наград |
| `data/redemptions.csv` | CSV для Excel/Google Sheets |

На Railway/Render/Fly смонтируй `/app/data` как persistent volume — иначе всё пропадёт при ре-деплое.

## Google Sheets (опционально)

Бот может писать каждую активацию награды напрямую в Google-таблицу через бесплатный Google Apps Script Web App. Без Google Cloud project, без JSON-ключей. URL вставляется в шаге 4 визарда.

Apps Script для копирования — в [SETUP_GUIDE.md](SETUP_GUIDE.md#шаг-6-google-sheets-опционально).

### Apps Script: расширенная версия для разработчика

Если хочешь больше столбцов или несколько листов, замени тело `doPost` на:

```javascript
const SHEET_NAME = 'Sheet1';
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME) || ss.getActiveSheet();
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Дата', 'Награда', 'Ник', 'Комментарий']);
      sheet.getRange('A1:D1').setFontWeight('bold');
    }
    const date = data.redeemed_at ? new Date(data.redeemed_at) : new Date();
    sheet.appendRow([date, data.reward_title || '', data.user_display || data.user_login || '', data.user_input || '']);
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) })).setMimeType(ContentService.MimeType.JSON);
  }
}
```

Разные листы на разные награды:

```javascript
const sheet = ss.getSheetByName(data.reward_title) || ss.insertSheet(data.reward_title);
```

### Где видно ошибки

- Apps Script → **Executions** (левое меню) — каждый запрос с логами.
- Логи бота — строки `[sheets]`.
- Самая частая ошибка: при деплое выбран **Only myself** вместо **Anyone**. Поменяй: **Deploy → Manage deployments → ✏ Edit → Anyone**.

## Docker

```bash
docker compose up -d --build
```

Visit `http://localhost:4488/setup`. Volume `./data` маунтится автоматически, токены сохраняются.

## Лицензия

MIT
