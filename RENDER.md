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
| `NODE_VERSION` | `24` | the backend uses `node:sqlite` (needs Node ≥ 22.13, unflagged from 24) |
| `D404_SINGLE_PORT` | `1` | player at `/`, game master console at `/admin`, one port |
| `D404_ADMIN_PASSWORD` | a long random string | game master passphrase — it is re-applied on **every** boot while set |

Env vars are also visible to the build, which is what makes the console's
"← BACK TO PLAYER ENTRANCE" link resolve to `/` instead of a hard-coded
`localhost` address.

## 4. Give the database a home (recommended)

SQLite lives on disk, and Render wipes the filesystem on every deploy unless you
attach a **Disk**.

1. Service → **Disks → New Disk**
2. Mount path: `/var/data` · size: 1 GB is plenty
3. Add `D404_DATA_DIR=/var/data` to the environment and redeploy

That disk now holds everything that matters: `deductive404.db` (rooms, players,
answers, scores), `secret.key` and `data/uploads/` (case images).

> **Without a disk** (free plan) the app still runs, but rooms, scores and
> uploaded images are reset on every deploy/restart. Fine for a demo, not for a
> real event.

## 5. Deploy and check it

Press **Deploy** and watch the build log (`npm ci` → two Vite builds → start).
When it goes live:

1. `https://<name>.onrender.com/` → player entrance
2. `https://<name>.onrender.com/admin` → game master terminal → `admin` + your
   `D404_ADMIN_PASSWORD`
3. **+ CREATE NEW ROOM** → copy the code → join from the player entrance with
   that code
4. **START GAME** → the player screen updates live (SSE) with no refresh

## 6. Day-to-day

- **Ship an update:** `git push origin main` → Render auto-deploys. Data survives.
- **Change the game master password:** edit `D404_ADMIN_PASSWORD` → redeploy.
- **Sleeping:** the free plan sleeps after ~7 days idle (≈50 s cold start). A paid
  instance (Starter) stays awake — use one for a live session.
- **Existing local content:** `data/` is gitignored, so your local rooms and games
  are **not** on Render. Re-create them in the Game Builder after the first deploy
  (takes a minute), or copy `data/deductive404.db` onto the disk.
- **Local development is untouched:** `npm run dev` → 5173/5174, `npm start` →
  5175/5176.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "no available port" / process exits instantly | `D404_SINGLE_PORT=1` is missing |
| Game master link points at localhost | the env var was added *after* a build → redeploy so it is inlined |
| Rooms vanish on deploy | the disk is missing or `D404_DATA_DIR` doesn't match its mount path |
| Login refused after a redeploy | `D404_ADMIN_PASSWORD` was changed — it rotates on every boot |
| 404 on the console assets | you're on `/admin.html` of an old build → open `/admin` |
