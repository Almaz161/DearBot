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

## Скоупы OAuth

Бот запрашивает: `chat:read`, `chat:edit`, `channel:read:redemptions`, `channel:manage:redemptions`, `moderator:read:followers`.

## Лицензия

MIT
