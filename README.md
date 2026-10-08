# DETECTIVE 404 — multiplayer detective quiz platform

A multiplayer detective quiz platform delivered as **two separate sites that share one
backend**:

| site | entry | dev port | prod port |
| ---- | ----- | -------- | --------- |
| **Detective site** (players) | `index.html` | 5173 | `PORT` (5175) |
| **Game master site** (admin) | `admin.html` | 5174 | `ADMIN_PORT` (5176) |

Each site has its own URL, its own HTML entry and its own bundle — the game-master console
is not downloaded by players, and the admin session key never exists on the player origin.
Both talk to the same API, the same Server-Sent Events stream and the same database — a
local SQLite file while developing, **MongoDB Atlas** when `MONGODB_URI` is set (the
production source of truth), PostgreSQL when `DATABASE_URL` is set — so rooms, scores
and the countdown stay in lock step across the two origins.

**Nothing about the game content is hard-coded.** The old built-in case file
(`src/cases.js` and `public/images/case*.jpg`) has been removed. Every game, case,
question, image, clue, answer and point value is written by the game master in the
*Game Builder* and stored in the database.

- **Game master** signs in on the separate admin site, presses `+ CREATE NEW GAME`, builds
  cases in the Game Editor (title, image upload, question, type, answer, clue, points),
  publishes the game, assigns it to a room and manages the clock
  (pause / resume / end / reset). The game master **cannot start** a game.
- **Players** join with a name + room code, see a cinematic waiting screen, and press
  **START GAME** themselves — each detective begins their own session, with as few as one
  player started (capacity 50 is a ceiling, not a waiting list). They then play the
  game assigned to their room: one question at a time, exactly two attempts each, against
  their own server-authoritative clock.
- **Live dashboard** updates over Server-Sent Events — no refresh, ever.

---

## Quick start

```bash
npm install
npm run dev
```

`npm run dev` starts **both** sites from one process and prints the URLs it actually bound
(if a port is taken it walks up and tells you where it landed):

```
  ┌───────────────────────────────────────────────────┐
  │  DETECTIVE 404 — TWO SITES, ONE BACKEND           │
  └───────────────────────────────────────────────────┘
   Detective site   : http://localhost:5173/
   Game master site : http://localhost:5174/
   Shared           : API · realtime stream · database
```

Run one site only, if you prefer:

```bash
npm run dev:player   # detective site only   (vite)
npm run dev:admin    # game master site only (vite --config vite.admin.config.js)
```

```bash
npm test             # server/smoke.js — 227 assertions on a throw-away SQLite database
npm run test:pg      # the same suite over the PostgreSQL SQL (in-process test engine)
npm run build        # builds BOTH sites: dist/ (players) + dist-admin/ (game master)
npm start            # serves both sites + API + SSE from one process
```

`npm start` prints:

```
   Detective entrance : http://localhost:5175/
   Game master console: http://localhost:5176/
```

### Game master login

Sign in on the **game master site** — `http://localhost:5174/` in dev,
`http://localhost:5176/` with `npm start` (`D404_ADMIN_SITE` overrides).

| field    | default value     |
| -------- | ----------------- |
| user     | `admin`           |
| password | `midnight-hotel`  |

**Change it before deploying** (setting the variable rotates the stored hash at boot):

```bash
D404_ADMIN_USER=chief D404_ADMIN_PASSWORD=a-long-random-secret npm start
```

Credentials live only in `server/config.js` → they are read server-side and are never
shipped to the browser. The admin password is stored as a scrypt hash in the `admins` table.

---

## Environment variables

### Sites & ports

| variable            | default        | purpose                                            |
| ------------------- | -------------- | -------------------------------------------------- |
| `PORT`              | `5175`         | Detective (player) site — production               |
| `ADMIN_PORT`        | `PORT + 1`     | Game master site — production                      |
| `HOST`              | `0.0.0.0`      | Bind address for both sites                        |
| `PLAYER_DEV_PORT`   | `5173`         | Preferred dev port (walks up if taken)             |
| `ADMIN_DEV_PORT`    | `5174`         | Preferred dev port (walks up if taken)             |
| `D404_PLAYER_SITE`  | `http://localhost:<port>` | Public URL of the player site — used for cross-site links |
| `D404_ADMIN_SITE`   | `http://localhost:<port>` | Public URL of the admin site — used for cross-site links |

Set both `*_SITE` variables when deploying behind real domains, e.g.
`D404_PLAYER_SITE=https://play.example.com D404_ADMIN_SITE=https://gm.example.com` — they
control the **ADMIN ACCESS →** link on the login screen and **← BACK TO PLAYER ENTRANCE**
on the game-master terminal.

### Server & credentials

| variable                | default                | purpose                                   |
| ----------------------- | ---------------------- | ----------------------------------------- |
| `MONGODB_URI`           | *(unset)*              | **MongoDB Atlas connection string — every game, room, answer and timer lives in MongoDB** (see [RENDER.md](RENDER.md) §4A). Wins over `DATABASE_URL`; never sent to the browser and never logged (see `.env.example`) |
| `D404_MONGODB_DB`       | URI path or `deductive404` | Database name inside the Atlas cluster |
| `D404_ADMIN_USER`       | `admin`                | Game master username                       |
| `D404_ADMIN_PASSWORD`   | `midnight-hotel`       | Game master password                       |
| `D404_DATA_DIR`         | `./data`               | Directory for the SQLite DB + HMAC secret  |
| `D404_DB_FILE`          | `<data>/deductive404.db`| Explicit database path                     |
| `DATABASE_URL`          | *(unset)*              | PostgreSQL connection string — moves the whole store to PostgreSQL (see [RENDER.md](RENDER.md)) |
| `D404_SECRET`           | auto-generated         | HMAC signing key (falls back to `data/secret.key`) |

Engine selection, in order: `MONGODB_URI` set → MongoDB; else `DATABASE_URL` set →
PostgreSQL; else the local SQLite file. Only one is used per process, and when a remote
engine is unreachable the server **fails fast** with a clear error instead of pretending
saves succeeded.

### Room capacity

| variable                     | default | purpose                                          |
| ---------------------------- | ------- | ------------------------------------------------ |
| `D404_MAX_PLAYERS_PER_ROOM`  | `50`    | Seats in ONE room — raise to `100`, `200`, …     |
| `D404_NAME_GRACE_MS`         | `15000` | How long a departed detective keeps their name   |

One room holds up to `D404_MAX_PLAYERS_PER_ROOM` **simultaneous** players. The limit is
counted and enforced inside the same database transaction that inserts the player, so N
players joining in the same instant can never push a room past the limit — the next player
gets `409 ROOM_FULL`. See [Room capacity & concurrency](#room-capacity--concurrency).

`data/` is git-ignored. It is a **live database directory** — keep it out of any file-sync
tool that watches it (OneDrive, Dropbox, …), because those tools can hold partial writes
against an open database. Deleting it resets rooms, players and the admin password hash;
nothing outside `data/` is ever touched.

---

## How a round works

1. Game master signs in on the **game master site** → **+ CREATE NEW GAME** → names the
   game and adds cases (image, question, type, answer, clue, points) in the Game Editor →
   **PUBLISH GAME**.
2. **CREATE NEW CASE ROOM** → gets a 6-letter code → pick the published game in the
   **GAME** setting → **ASSIGN**.
3. Players open the **detective site**, type their name + code → **JOIN GAME** → waiting
   screen (`YOU ARE IN`, room code, game name, live player count, `[ WAITING ]`).
4. Each detective presses **START GAME** on the waiting screen: the server stamps
   *their* `started_at`, stores *their* expiry (`started_at + duration`) and pushes the
   game into *their own* session only — no other player's timer or screen is touched and
   the start is never broadcast room-wide. It works with as few as **1** player started;
   **50** is only the ceiling on how many may join. The game master has no start control
   (the API answers `403 ADMIN_START_DISABLED`).
5. Each player works through the questions at their own pace. Future questions are
   locked — the server refuses answers for them, so no UI trick or URL can skip ahead.
   With **AUTO** on, the room's current case follows the leading detective.
6. When a detective's clock hits `00:00` the server locks only *that* player: they see
   `TIME'S UP` and the final ranking while the room — and every other detective with time
   left — keeps playing. The room itself ends when the game master presses END, or
   automatically once every seat has finished or run out of time.
7. **FINAL DETECTIVE RANKING** ranks by score → questions solved → time taken.

Each timer is computed as `their started_at + duration − now` **on the server**, per
player. Refresh, close the tab, or rejoin later and that detective continues from their
own original start — never a fresh full timer. One detective's START never resets,
pauses or shortens another's clock, and nothing about the clock lives in `localStorage`.

---

## Architecture

```
deductive404/
├─ index.html               # DETECTIVE SITE entry  -> dist/
├─ admin.html               # GAME MASTER SITE entry -> dist-admin/
├─ vite.config.js           # siteConfig() factory + player config (default)
├─ vite.admin.config.js     # admin config
├─ src/
│  ├─ main.jsx              # player bootstrap      -> App.jsx
│  ├─ main-admin.jsx        # game master bootstrap -> AdminApp.jsx
│  ├─ App.jsx               # detective site screens (no admin code)
│  ├─ AdminApp.jsx          # game master site screens (no player code)
│  ├─ game/logic.js         # answer normalisation, matching, attempts, point rules
│  ├─ net/client.js         # fetch wrapper + SSE subscription
│  ├─ net/sites.js          # cross-site URLs injected at build time
│  ├─ net/session.js        # player/admin token storage (separate keys)
│  ├─ net/time.js           # shared clock formatting
│  ├─ net/useGame.js        # single state hook used by both roles
│  ├─ screens/              # Login, Waiting, Game, Leaderboard,
│  │                        # AdminLogin, AdminDashboard, GamesScreen (Game Builder)
│  └─ ui/                   # Logo, Splash, Confirm dialog, CopyButton
├─ server/
│  ├─ config.js             # env, ports, limits, upload rules
│  ├─ dev.js                # npm run dev — boots both Vite servers in one process
│  ├─ auth.js               # HMAC tokens (players & admins), scrypt password hashing
│  ├─ db.js                 # async store — schema + queries, engine chosen by DATABASE_URL
│  ├─ driver-sqlite.js       # local engine: WAL + checkpoints + backups + signal flush
│  ├─ driver-pg.js           # PostgreSQL engine (pg pool in prod, pglite for tests)
│  ├─ game.js               # ★ server-side answer check, scoring, timer, ranking
│  ├─ hub.js                # SSE hub (rooms, heartbeats)
│  ├─ api.js                # router, auth guards, admin actions, game CRUD, ticker
│  ├─ index.js              # production server — both sites + API + SSE + uploads
│  ├─ vite-plugin.js        # mounts the same API inside the Vite dev servers
│  └─ smoke.js              # npm test
└─ data/                    # git-ignored: SQLite DB + backups, secret, uploaded case images
```

### Why one backend, two sites

`server/api.js`, the SSE hub and the database engine are loaded **once**. `server/dev.js`
creates both Vite servers with `configFile: false` and hands them the same plugin, so the
two dev origins share one live game rather than two disconnected ones. In production a
single `node server/index.js` binds both ports.

Each site also refuses the other's HTML entry (`/admin.html` on the player port and
`/index.html` on the admin port return 404), so the split holds even inside the shared
dev root.

### Lean backend, own server

The local engine is pure Node built-ins — `node:sqlite`, `node:http` and SSE — so everyday
development needs no database install, no third-party service to sign up for and no API keys
to leak. One small runtime dependency, `pg`, is only touched in production when
`DATABASE_URL` points at PostgreSQL. `npm start` runs anywhere Node ≥ 22.13 runs.

**Why not Firestore/Supabase?** They are excellent choices, but they require credentials in
the frontend bundle, bill per connection, and still need Cloud Functions/RLS to enforce the
rules below. Keeping the authoritative game state on our own server makes the timer, the
scoring and the permissions trivially enforceable and the app deployable with a single
command. The schema is deliberately shaped like a Firestore/Supabase schema (`rooms`,
`players`, `answers`, `game_sessions`), so porting later is a mechanical swap of `db.js`.

---

## Room capacity & concurrency

**One room = many players.** `players.room_id` repeats — there is no uniqueness on it —
so a room is a container for up to `D404_MAX_PLAYERS_PER_ROOM` (default **50**) separate
detectives. Identity is always `players.id` (a UUID minted per join), never the room code:
every row carries its own name, score, case, attempts, progress, `joined_at` and
`last_active` heartbeat, and no code path writes "the current player" into a shared
variable.

```
ROOM ABC123
├── player 8f3a…  Arun     case 5  score 400  online
├── player 1c07…  Kumar    case 5  score 350  online
└── player 9b42…  Priya    case 4  score 300  online
```

* **Joining** — `POST /api/join` counts the seats and inserts the row inside one
  `BEGIN IMMEDIATE … COMMIT` transaction (`joinRoomAtomic`), so 50 simultaneous joins
  produce 50 distinct ids and player 51 is refused with `409 ROOM_FULL`. Two joins using
  the same display name resolve to `409 NAME_TAKEN` rather than a database error.
* **Real time** — the hub keeps `roomId → Map(connectionId → client)`, i.e. a *list* of
  sockets per room. A new connection is added, never substituted; an event is written to
  every socket in the room; a disconnect deletes exactly that one socket (and that
  player's presence), leaving the room and everyone else untouched.
* **Writes** — submissions run answer + progress + score + case pointer as a single
  transaction, and every statement is keyed by `player.id`, so one detective's answer can
  never touch another's row.
* **Presence** — clients heartbeat every 20 s (`last_active`), the hub pings every 15 s,
  and the game master sees `online` plus `last-seen` per player.
* **Errors** — specific codes with human messages: `ROOM_NOT_FOUND`, `INVALID_ROOM_CODE`,
  `ROOM_FULL`, `NAME_TAKEN`, `SESSION_EXPIRED`, `DATABASE_ERROR`, … never a bare
  "Request failed".

### One instance only

Room membership and the live stream live in the process (in-memory hub); durable rows live
in the configured database (SQLite on local disk, or PostgreSQL via `DATABASE_URL`).
**Deploy exactly one instance** of the service (Render's default) and do not enable
autoscaling — two processes would each hold their own connection list. Capacity is a
server-side number; the browser cannot raise it.

---

## Database schema

```sql
admins       (id, username UNIQUE, password_hash, created_at)
games        (id, admin_id, game_name, description, status, created_at, updated_at)
game_cases   (id, game_id, case_number, case_title, image_url, question,
              question_type, options(JSON), correct_answer, clue,
              points_first, points_second, created_at, updated_at,
              UNIQUE(game_id, case_number))
rooms        (id, room_code UNIQUE, room_name, admin_id, game_id, status, duration,
              started_at, paused_since, paused_total, ended_at,
              current_case, case_auto, created_at)
players      (id, room_id, player_name, name_key, joined_at, current_case,
              completed_cases, awaiting_next, correct_count, wrong_count,
              score, status, timed_out, finished_at, time_taken,
              case_started_at, last_active, UNIQUE(room_id, name_key))
answers      (id, player_id, room_id, case_id, answer, correct, points,
              timestamp, time_taken)
player_progress (id, player_id, game_id, case_number, attempts, points,
                 completed, answered_correct, last_answer, created_at, updated_at,
                 UNIQUE(player_id, case_number))
meta         (key, value)     # one-time migrations, e.g. legacy content cleared
uploads are stored as files under <data>/uploads/
```

With `MONGODB_URI` set (MongoDB Atlas) the same records live as documents with the
**same field names**, in these collections — cases embed inside their game document and
the room's session embeds inside the room document, so a game and all of its cases save
as one atomic write:

| collection      | holds                                                                 |
| --------------- | --------------------------------------------------------------------- |
| `admins`        | game master accounts (same password hashing)                          |
| `games`         | game metadata + embedded `cases[]` (question, options, correct answer, clue, image URL, points, order, status, timestamps) |
| `rooms`         | room code, configuration, duration + embedded `session{}` (start/end/status) |
| `players`       | one document per seat: score, case position, own `started_at`/`ends_at` |
| `answers`       | every submission (activity feed + audit trail)                        |
| `gameProgress`  | per-player, per-question attempts and points                          |
| `meta`          | one-time flags (legacy cleanup, migration markers)                    |

Indexes mirror the SQL unique constraints (`rooms.room_code`,
`players(room_id,name_key)`, `gameProgress(player_id,case_number)`, `admins.username`),
are created idempotently at boot, and startup never drops or resets a collection.
If a local `data/deductive404.db` exists while the Atlas database is still empty, boot
imports it **once** (flag-guarded, upsert-by-id, resumable) so existing games are not
lost.

`rooms.game_id`, `players.started_at` and `players.ends_at` are added to older databases by
guarded boot migrations (`IF NOT EXISTS` schema + `ALTER TABLE` / `information_schema`
checks, one additive step at a time) — existing users, logins, rooms, admin accounts and
settings are never touched, dropped or re-created.

`players.room_id` is **not** unique: many player rows share one room (see
[Room capacity & concurrency](#room-capacity--concurrency)). Only
`UNIQUE(room_id, name_key)` prevents two *different* people from claiming one detective
name in the same room.

`status` on rooms: `waiting → live ⇄ paused → ended`.
`status` on games: `draft → published`.
Player progress (`current_case`, `score`, attempt counts, `awaiting_next`) is written on
every submission, so a refresh restores the exact screen — including the post-solve
"✅ Correct!" state and the second-miss answer reveal.

### Sequential locking

A player's active question is `players.current_case`; a question is unlocked while
`case_number <= completed_count + 1`. `/api/answer` rejects anything above that with
`LOCKED`, and `/api/next` only advances when the current question is `awaiting_next`.
The client never receives the text, clue or answer of a question it has not reached, so
locking is enforced by the database, not by the UI.

---

## Persistence — create once, reopen tomorrow

Rooms, games, cases, questions, answers, clues, point values, durations, settings and the
admin account are stored **only** in the database — never solely in `localStorage` /
`sessionStorage`, which vanish when the tab closes. Every create and every edit writes
through to the database immediately.

| Guarantee | How |
| --- | --- |
| Close tonight, reopen tomorrow | data lives in the engine, not in memory — `npm test` closes the database, reopens it and asserts every room, duration, row count, game and account is identical |
| Survives Ctrl+C, crashes and redeploys | writes commit (`synchronous=FULL`, WAL) before the HTTP response is sent; SIGINT/SIGTERM/`exit` flush and checkpoint the WAL, and rolling `VACUUM INTO` backups are kept in `data/backups/` (five most recent) |
| Never re-initialised on startup | `CREATE TABLE IF NOT EXISTS` plus additive, guarded column migrations only — boot never runs `DROP` / `DELETE` / re-create over an existing database (MongoDB: index creation only) |
| Rooms are never auto-deleted | only the explicit **DELETE ROOM** button (with confirmation) removes a room — creating or preparing one just saves it |
| Saving ≠ starting | creating a room leaves it `waiting`; the game starts only when a detective presses their own **START** |
| Production durability | set `MONGODB_URI` and every game, room, answer and timer lives in **MongoDB Atlas** (see [RENDER.md](RENDER.md) §4A) — save → restart → load returns the same data; with a remote engine unreachable the server fails fast instead of silently running on an empty local file |

`npm run test:all` runs the complete suite against all three engines (SQLite, the
PostgreSQL dialect and MongoDB — including a replica set, so the production transaction
path is exercised), including the close-and-reopen and killed-process restart checks.

---

## API

| method | route                         | auth  | purpose                                   |
| ------ | ----------------------------- | ----- | ----------------------------------------- |
| GET    | `/api/health`                 | —     | liveness                                   |
| POST   | `/api/join`                   | —     | name + room code → player session          |
| GET    | `/api/session`                | token | restore state after refresh (question + question list) |
| POST   | `/api/heartbeat`              | token | presence / online marker                   |
| POST   | `/api/answer`                 | token | submit answer (**server checks & scores**) |
| POST   | `/api/next`                   | token | advance once the current question is closed |
| POST   | `/api/game/start`             | token | **a detective starts their OWN session** (per-player start + clock) |
| GET    | `/api/leaderboard`            | token | final ranking (only after the room ends)   |
| GET    | `/uploads/<file>`             | —     | case images uploaded by the game master    |
| POST   | `/api/admin/login`            | —     | game master credentials → admin token      |
| GET    | `/api/admin/rooms`            | admin | this admin's rooms + live stats + games    |
| POST   | `/api/admin/rooms`            | admin | create a room (auto 6-letter code)         |
| GET    | `/api/admin/room`             | admin | full room state (players, feed, standings) |
| POST   | `/api/admin/room/:action`     | admin | `pause` `resume` `end` `reset` `case` `duration` `game` (`start` → 403 `ADMIN_START_DISABLED`) |
| GET    | `/api/admin/games`            | admin | game library                               |
| POST   | `/api/admin/games`            | admin | create a game (optional pre-created cases) |
| GET    | `/api/admin/game?id=`         | admin | one game with its ordered cases            |
| POST   | `/api/admin/game/save`        | admin | rename / re-describe a game                |
| POST   | `/api/admin/game/publish`     | admin | publish / unpublish (requires complete cases) |
| POST   | `/api/admin/game/delete`      | admin | delete an unassigned game                  |
| POST   | `/api/admin/game/case`        | admin | create or update one case                  |
| POST   | `/api/admin/game/case/delete` | admin | delete a case (renumbers the rest)         |
| POST   | `/api/admin/game/case/move`   | admin | reorder cases                              |
| POST   | `/api/admin/upload`           | admin | case image upload (base64, 6 MB cap)       |
| GET    | `/events`                     | token | Server-Sent Events stream                  |

### Attempts & scoring

Exactly **two attempts** per question:

| outcome                              | points |
| ------------------------------------ | ------ |
| Correct on the first attempt         | 100    |
| Correct on the second attempt        | 50     |
| Wrong twice                          | 0 — the correct answer is revealed |

A first wrong attempt shows only the configured clue (`💡 CLUE:` → `TRY AGAIN`) and the
same question is shown again. Both values are per-case, so each game sets its own rewards
(`points_first` / `points_second`).

Answer matching lives in `src/game/logic.js` and is imported by the server:

- **text** — case/spacing/punctuation-insensitive, small typos allowed, **max 3 words**
- **multiple choice** — exact match against the listed options
- **true/false** — accepts `true/false`, `yes/no`, `y/n`, `1/0`

The matching layer is intentionally generic — adding a new question type means adding a
branch in `matchesAnswer` and a case in the editor.

---

## Security model

- **Players** hold an HMAC-signed token bound to `playerId + roomId`. Every mutating route
  re-reads the player from the DB and can only touch *their own* row — a player cannot
  submit for someone else, edit scores, move the clock, or read another room.
- **Game master** routes require a separate admin token issued only after a server-side
  credential check. Admin and player sessions use different `localStorage` keys *and* live
  on different origins, so one can never unlock the other.
- Rooms are fully isolated: every admin query filters by `admin_id`, every player query by
  `room_id`.
- Answer checking, scoring, attempt counting, the timer and question progression are all
  computed **server-side**; the client only renders what it is told.
- **Answers are never sent to a live question.** `correct_answer` and `clue` are stripped
  from the payload until the question is completed (or permanently hidden while locked), so
  nothing can be read out of the page source or the network tab.
- **Locking is a server rule.** Answering a question above the player's own position returns
  `LOCKED`; advancing requires `awaiting_next`. The question list sent to a player carries
  only a `state` for locked questions — no text, image, clue or answer.
- Case images are uploaded through an admin-only route (6 MB cap, image types only, SVG
  refused) and stored outside the web root under `data/uploads/`.
- **Sites are split by origin.** The player bundle contains no admin screen, no admin route
  and no admin session key; the admin bundle contains no player game screen. Each site
  returns 404 for the other's entry page.
- No admin credential, database path or secret is present in either built frontend
  (`npm run build` ships `dist/` + `dist-admin/` only).
- Request bodies are capped at 64 KB; names/codes are normalised and length-limited.

---

## Building a game (no code changes)

Everything lives in the **GAME BUILDER** on the game master site:

1. **+ CREATE NEW GAME** → *Game Name*, optional *Description*, optional *Number of cases*
   (you can always add them one by one).
2. For each **CASE N**: *Case Title*, *Case Image / Puzzle Image* (upload from computer or
   phone), *Question*, *Question Type*, *Correct Answer*, *First Attempt Clue*,
   *Points (1st attempt)* / *Points (2nd attempt)*.
3. Question types available today: **Text Answer**, **Multiple Choice** (build the options
   and pick the correct one), **True/False**.
4. **SAVE CASE** / **SAVE GAME**, then **PREVIEW** to see exactly what a detective sees,
   and **PUBLISH GAME** so a room can use it.
5. Reorder with ↑ / ↓, edit or delete any case at any time, replace the image, change a
   clue or an answer — nothing is permanent. Deleting or reordering a case renumbers it and
   resets progress for rooms using that game.

Multiple games can exist at once; each room points at exactly one of them, and each player's
progress is stored per game.

Keep answers short (three words at most) — the editor's helper text reminds you, and the
server rejects anything longer.

---

## Responsive & visual

- **Player UI** is mobile-first (tested at 390 px): stacked HUD, full-width case file,
  thumb-sized answer controls.
- **Game master console** is a desktop/tablet command center that collapses to a single
  column on phones.
- Dark charcoal + gold case-file aesthetic, glow/scan-line animations and typography
  (Cinzel / JetBrains Mono) loaded from both HTML entries.
- The Game Builder and its editor are responsive too: cards stack on phones and the image
  upload uses the native file picker (camera capture included on mobile).

---

## Deployment

```bash
npm ci
npm run build                       # -> dist/ (players) + dist-admin/ (game master)
D404_ADMIN_USER=chief \
D404_ADMIN_PASSWORD=<secret> \
PORT=8080 ADMIN_PORT=8081 \
D404_PLAYER_SITE=https://play.example.com \
D404_ADMIN_SITE=https://gm.example.com \
npm start
```

- **One process, two ports.** Both listeners share the API, the SSE hub and the database,
  so there is no separate realtime service to provision.
- Point each port at its own hostname in the reverse proxy (or serve them under different
  server names). Setting `D404_PLAYER_SITE` / `D404_ADMIN_SITE` makes the cross-site links
  absolute, which is required once the sites are on real domains.
- SSE needs no special proxy config beyond disabling response buffering for `/events`.
- Back up `data/` to preserve rooms and progress.
- To host the sites on *one* domain instead, serve `dist/` at `/` and `dist-admin/` at
  `/admin` (the entry files are plain HTML) and set both `*_SITE` vars accordingly.
#   d e t e c t i v e _ 4 0 4  
 