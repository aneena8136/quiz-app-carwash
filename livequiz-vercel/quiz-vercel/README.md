# LiveQuiz - Vercel edition

A live, host-paced image quiz (Kahoot style) built to run on Vercel.

- **Player site** `/` - players enter the 6-digit PIN and a name on their phone.
- **Quiz master site** `/host` - password protected. Build quizzes (image per question, 2-4 options, time limit), host a live game, see the leaderboard, download results as CSV.
- Scoring: 500 points for a correct answer + up to 500 speed bonus.

## How it is built for Vercel

| Piece | Where it lives |
|---|---|
| Pages (`public/`) | Vercel CDN |
| API + live connections (`api/server.js`, Express + Socket.IO over WebSocket) | one Vercel Function (Fluid compute) |
| Games, scores, saved quizzes | Redis (Vercel Marketplace) - shared by all function instances |
| Uploaded images | Vercel Blob (public store) |

## Deploy (about 15 minutes)

1. **GitHub** - create a new **private** repository and upload everything in this folder
   (not `node_modules`). On github.com: *Add file > Upload files*, drag the files and folders in, *Commit*.
2. **Vercel** - *Add New > Project*, import the repository. Framework preset: **Other**. Leave build settings empty. Click *Deploy*.
3. **Redis** - in the project: *Storage > Create Database >* pick a Redis provider (e.g. Redis or Upstash), create it and connect it to the project.
   The app reads `REDIS_URL` (or `KV_URL`). If the provider used another name, add a variable called `REDIS_URL` holding its `redis://` / `rediss://` connection string.
4. **Blob** - *Storage > Create Database > Blob*, access **Public**, connect it to the project.
5. **Password** - *Settings > Environment Variables*: add `HOST_PASSWORD` (8+ characters, mark it *Sensitive*).
   Never put the password in the code or in GitHub.
6. **Redeploy** - *Deployments > ... > Redeploy* so the new settings are picked up.
7. Open `https://<your-project>.vercel.app/host` (quiz master) and share `https://<your-project>.vercel.app/` with players.
   Use the production address - preview deployments are login-protected by Vercel.

Optional settings: `MAX_PLAYERS` (default 500), `SESSION_SECRET` (signs the quiz master login cookie; defaults to a value derived from the password).

## Before the event - do a trial run

This edition was tested locally with two server instances sharing one Redis and 400 simulated players,
but **not on Vercel itself**. After deploying, run a short quiz with 2-3 phones, then a load test:

```
npm install
HOST_PASSWORD="<your password>" npm run loadtest -- 150 https://<your-project>.vercel.app
```

It should finish with `ALL CHECKS PASSED`.

## Good to know

- Vercel closes a live connection when the function reaches its maximum duration (5 minutes on Hobby, up to 800 s on Pro).
  Phones reconnect by themselves within a second and keep their score.
- Images: JPG / PNG / WEBP / GIF, max 4 MB (Vercel's request limit is 4.5 MB). Photos are shrunk in the browser before upload.
- A game is kept for 4 hours (30 minutes after it ends). Saved quizzes are kept until you delete them.
- Fluid compute must be on (default for new Vercel projects).
- Redis and Blob have their own usage limits and pricing on Vercel - check them for your plan.

## If something does not work

| Symptom | Check |
|---|---|
| Login says "Set the HOST_PASSWORD..." | Add the variable, then redeploy |
| "REDIS_URL is not set" | Connect Redis (step 3), then redeploy |
| Image upload fails | Connect a **public** Blob store (step 4), then redeploy |
| Stuck on "Reconnecting..." | Project > Logs, filter `/api/server`; confirm Fluid compute is enabled |

## Run locally (optional)

Needs Node 20+ and a Redis server. `REDIS_URL=redis://localhost:6379 HOST_PASSWORD=... npm start`, then open http://localhost:3000/host.
Without Blob settings, images are stored in `./data/uploads`.

## Security notes

- No secrets in code; password, Redis and Blob credentials come from Vercel environment variables.
- Login is rate limited; the session cookie is signed, HttpOnly, Secure and SameSite=Strict.
- Uploads: quiz master only, image types only (content checked), random file names.
- Correct answers and answer timing stay on the server until the reveal.
- Uploaded images are publicly readable by URL (needed so players can see them) - do not upload confidential pictures.
- Stored data: display names and scores (4 hours), quizzes and images (until deleted).
