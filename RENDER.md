# Hosting DETECTIVE 404 on Render

Locally the app runs as **two ports in one process** (`5175` players, `5176` game
master). Render publishes **exactly one port** per web service, so the server has a
built-in **single-port mode**: both sites are served from the same listener and
reached by path.

| Site | Local | On Render |
| --- | --- | --- |
| Player entrance | `http://localhost:5175/` | `https://<your-service>.onrender.com/` |
| Game master console | `http://localhost:5176/` | `https://<your-service>.onrender.com/admin` |

Single-port mode is opt-in with `D404_SINGLE_PORT=1`. Without it nothing changes:
both listeners, both ports, exactly as before.

---

## 1. Push the code

```bash
cd deductive404
git add -A
git commit -m "single-port mode for Render"
git push origin main
```

The repository root is already the app root (the folder with `package.json`), so
Render needs no sub-directory.

## 2. Create the service

Render dashboard → **New → Web Service** → connect `github.com/jeevanesh13/detective_404`.

| Setting | Value |
| --- | --- |
| Name | anything URL-safe, e.g. `detective-404` (this *is* your domain) |
| Region | closest to your players |
| Runtime | Node |
| Root Directory | *(leave empty)* |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |

## 3. Environment variables (set these *before* the first deploy)

| Key | Value | Why |
| --- | --- | --- |
| `NODE_VERSION` | `24` | the backend uses `node:sqlite` for the local/disk engine (needs Node ≥ 22.13, unflagged from 24) |
| `D404_SINGLE_PORT` | `1` | player at `/`, game master console at `/admin`, one port |
| `D404_ADMIN_PASSWORD` | a long random string | game master passphrase — it is re-applied on **every** boot while set |
| `DATABASE_URL` | *(see §4)* | when set, the app stores everything in **PostgreSQL** instead of the SQLite file |
| `D404_MAX_PLAYERS_PER_ROOM` | `50` *(optional)* | seats per room — set `100`, `200`, … to raise the limit |

Env vars are also visible to the build, which is what makes the console's
"← BACK TO PLAYER ENTRANCE" link resolve to `/` instead of a hard-coded
`localhost` address.

> Never hard-code a connection string or password in the code — Render injects
> `DATABASE_URL` as an environment variable (use Render's **Secrets** for it).

## 4. Give the database a home (recommended)

Everything the product remembers — rooms, room codes, games, cases, questions,
answers, scores, durations, settings and the admin account — lives in the
database. Pick one of the two engines:

### Option A — PostgreSQL via `DATABASE_URL` *(recommended)*

The production-grade choice: the data survives deploys, restarts and redeploys
without a disk, and the database service backs it up on its own.

1. Render dashboard → **New → PostgreSQL** (same region as the web service),
   or use an external provider (Neon, Supabase, …).
2. Copy the connection string — Render shows **Internal URL** (same-region,
   use this) / **External URL** (other providers).
3. Add it to the web service as the environment variable **`DATABASE_URL`** and
   redeploy.

On first boot the server creates its schema in that database, and later boots
only ever run **additive** column checks — it never drops, resets or deletes
anything, and it refuses to start if `DATABASE_URL` is set but unreachable
(it will **not** silently fall back to an empty local file).

A connection string containing `sslmode=require` (Render's default) connects
over TLS.

> **You still want a Disk for Option A too** — `secret.key` (session signing)
> and `data/uploads/` (case images) are files, not rows: mount `/var/data`,
> set `D404_DATA_DIR=/var/data`. Database rows are unaffected by the disk.

### Option B — SQLite on a Render Disk (no database service)

SQLite lives on disk, and Render wipes the filesystem on every deploy unless you
attach a **Disk**.

1. Service → **Disks → New Disk**
2. Mount path: `/var/data` · size: 1 GB is plenty
3. Add `D404_DATA_DIR=/var/data` to the environment and redeploy

That disk now holds everything that matters: `deductive404.db` (rooms, players,
answers, scores), `secret.key` and `data/uploads/` (case images).

The file engine is durability-hardened: WAL mode with `synchronous=FULL`, a
checkpoint that folds the WAL into the main file every 30 seconds **and** on
shutdown, plus rolling backups in `data/backups/` (the five most recent are
kept).

> **Without a disk** (free plan, no `DATABASE_URL`) the app still runs, but
> rooms, scores and uploaded images are reset on every deploy/restart. Fine
> for a demo, not for a real event.

## 5. Deploy and check it

Press **Deploy** and watch the build log (`npm ci` → two Vite builds → start).
When it goes live:

1. `https://<name>.onrender.com/` → player entrance
2. `https://<name>.onrender.com/admin` → game master terminal → `admin` + your
   `D404_ADMIN_PASSWORD`
3. **+ CREATE NEW ROOM** → copy the code → join from the player entrance with
   that code
4. Each detective presses **START GAME** on the player side → only they enter the case, with their own timer (full configured duration) — the game master's console updates live over SSE

## 6. Multiplayer at scale (50 in one room)

Room membership and the live stream are held **in the running process** (an in-memory
connection map); every durable row lives in the configured database (PostgreSQL via
`DATABASE_URL`, or the SQLite file on the mounted disk). That is exactly what makes 50 players in
one room work — and what limits the deployment to **one instance**:

| Do | Don't |
| --- | --- |
| Keep **1 instance** (Render's default) | Enable autoscaling / multiple instances |
| Leave the disk mounted (`D404_DATA_DIR`) | Point two services at one database |
| Raise capacity with `D404_MAX_PLAYERS_PER_ROOM` | Let the browser decide the player count |

With one instance the flow is: `POST /api/join` counts the seats and inserts the player in
one transaction → the socket joins that room's connection list → every player and the game
master get the same `state` push. Player 51 receives `409 ROOM_FULL`.

**Check the numbers on the live dashboard:** the roster header reads `37/50`, the
**PLAYERS ONLINE** card reads `37 / 50 in room`, and both update in real time as players
arrive (no reload).

Render's proxy streams SSE fine — the server pings every 15 s, so the connection is never
idle long enough to be cut.

## 7. Day-to-day

- **Ship an update:** `git push origin main` → Render auto-deploys. Data survives.
- **Change the game master password:** edit `D404_ADMIN_PASSWORD` → redeploy.
- **Sleeping:** the free plan sleeps after ~7 days idle (≈50 s cold start). A paid
  instance (Starter) stays awake — use one for a live session.
- **Existing local content:** `data/` is gitignored, so your local rooms and games
  are **not** on Render. Re-create them in the Game Builder after the first deploy
  (takes a minute). With Option B you can instead copy `data/deductive404.db` onto
  the disk; with Option A the database starts empty by design.
- **Local development is untouched:** `npm run dev` → 5173/5174, `npm start` →
  5175/5176.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "no available port" / process exits instantly | `D404_SINGLE_PORT=1` is missing |
| Process exits at boot right after setting `DATABASE_URL` | the database is unreachable or the URL/`sslmode` is wrong — the app fails fast instead of silently running on an empty local file |
| Game master link points at localhost | the env var was added *after* a build → redeploy so it is inlined |
| Rooms vanish on deploy | SQLite mode: the disk is missing or `D404_DATA_DIR` doesn't match its mount path — or no `DATABASE_URL` and no disk at all (see §4) |
| Login refused after a redeploy | `D404_ADMIN_PASSWORD` was changed — it rotates on every boot |
| 404 on the console assets | you're on `/admin.html` of an old build → open `/admin` |
