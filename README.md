# ProgressBuddy

Friend-based goal, study and coding accountability. *Compete with your friend, not against your friend.*

Web app (installable PWA, works on phones) + REST API + Chrome extension that records progress on YouTube lectures.
No npm dependencies. Needs Node 22.13+ (built-in SQLite for local use; Turso over HTTP on Vercel).

## Run locally
```
node server.js        # http://localhost:3000
node test.js          # end-to-end API tests
```

## Deploy on Vercel (free) with a Turso database (free)
Vercel has no persistent disk, so on Vercel the data lives in Turso (an online SQLite database with a free plan). The same code still runs with a local SQLite file everywhere else.

1. **Turso:** sign up at turso.tech, create a database (pick the region closest to your users, e.g. Mumbai), then copy the **database URL** (`libsql://...turso.io`) and create an **auth token**.
2. **GitHub:** push this folder to a GitHub repository.
3. **Vercel:** *Add New > Project*, import the repository. Leave the framework as **Other**; no build command is needed.
4. **Environment Variables** (Settings > Environment Variables), then redeploy:
   - `TURSO_DATABASE_URL` = your `libsql://...` URL
   - `TURSO_AUTH_TOKEN` = your token
   - `JWT_SECRET` = any long random string (required on Vercel)
   - optional: `GMAIL_USER`, `GMAIL_APP_PASSWORD` (email codes), `YOUTUBE_API_KEY` (lecture search), `PUBLIC_URL` (your final https address)
5. Tables are created automatically on the first request. Open your `*.vercel.app` address and sign up.

Tip: in Vercel *Settings > Functions*, set the function region near your Turso region (for example Mumbai `bom1`) so database calls stay fast.
Notes: rate limiting is kept in memory per server instance, so on Vercel it is a soft limit. Back up from the Turso dashboard or with the `turso db shell` command.

## Deploy elsewhere (local SQLite file)
Your data lives in one SQLite file in `DATA_DIR`, so the host must give you a **persistent disk/volume**.

**Render:** push this folder to GitHub, create a Blueprint from `render.yaml` (needs a paid plan for the disk).
**Railway / Fly.io / any Docker host:** build the `Dockerfile`, mount a volume at `/data`, expose port 3000.
**VPS:** `docker build -t progressbuddy . && docker run -d -p 3000:3000 -v pbdata:/data --restart unless-stopped progressbuddy`, then put nginx or Caddy in front for HTTPS.

Use HTTPS in production (passwords and tokens travel over it). Behind a proxy keep `TRUST_PROXY=1` so rate limiting sees real client IPs.
Back up by copying `progressbuddy.db` (and `.secret` if you did not set `JWT_SECRET`).

## Watching lectures (no setup on phones)
**Everyone, including phones:** open **Watch**, add a YouTube link, press **Watch here**. The lecture plays inside ProgressBuddy using YouTube's
official embedded player, and progress is saved automatically. It works in any phone browser and in the installed app.
If a video's owner blocks embedding, use **Log manually** (enter the minute you reached).

**Computer, watching on youtube.com itself (optional):**
1. In the app: **Watch** → **Download extension**. The file is built for your site, so the address is already inside it.
2. Unzip it, open `chrome://extensions`, turn on Developer mode, press **Load unpacked**, choose the extracted folder that directly contains `manifest.json`. (One time only.) Always use the file downloaded from your own site; it contains your site's address.
3. Reload the app's Watch page and press **Connect extension**. Done. Nothing to copy or paste.

Behind a proxy, set `PUBLIC_URL=https://your-domain` so the downloaded extension points at the right address.
Only lectures you added are read, only on youtube.com/watch, ads are skipped, seeking does not count, and data goes only to your own server.
Watch time is also capped on the server at real elapsed time.
To remove the "Developer mode" step for your users, publish the extension in the Chrome Web Store (one-time developer fee).

## Lecture search (optional, needs a free YouTube API key)
The Watch tab has a search box that finds lectures inside the app. Results only include videos that can be played in the embedded player, show length and channel, and each has **Watch** (adds it and starts playing) and **+ Add**.
Without a key the app still works: Search opens YouTube in a new tab and users paste the link they pick.

To switch it on (about 5 minutes, free):
1. Go to console.cloud.google.com, create a project, and enable **YouTube Data API v3**.
2. **Credentials → Create credentials → API key**. Restrict the key to the YouTube Data API.
3. Set `YOUTUBE_API_KEY` on your host (Render: Environment tab) and restart.

The key stays on the server and is never sent to browsers. Google's free quota is 10,000 units a day and each new search costs about 101, so roughly 100 fresh searches a day.
Repeat searches are cached for 10 minutes, and each user is limited to 20 searches a minute. If the daily limit is reached, users see a friendly message and can still paste links.
If you outgrow it, you can request more quota from Google.

## What is included
Accounts (scrypt hashes, signed tokens, rate limiting, strict CSP) · profile and circumstances · friends (request, accept, block, remove, report) ·
goals with milestones · challenges with mutually accepted reward and safe penalties · live comparison with gentle wording · catch-up plans ·
help-your-friend (accept/decline, XP for helpers) · chat · XP, levels, badges, streaks, private leaderboard · privacy controls ·
rule-based insights from real stored data · notifications · lecture search + in-app player + extension tracking · account deletion.

## Not included yet (honest list)
Email verification and password reset (needs an email provider) · web push / mobile push · LLM assistant (insights are rule-based) ·
study-together timer · accountability audio · GitHub/LeetCode/Calendar integrations · native Android/iOS packaging
(install the PWA from the browser menu, or wrap with Capacitor) · Chrome Web Store listing for the extension.

## Email code (OTP) sign-in — optional

Set `RESEND_API_KEY` and `MAIL_FROM` (see `.env.example`) to require a 6-digit code emailed at sign-up and sign-in.
If either is empty, sign-in is password-only exactly as before. Codes expire after 10 minutes, allow 5 tries, and can be resent every 30 seconds.

Forgot password uses the same email setup: the sign-in page shows a "Forgot password?" link only when `RESEND_API_KEY` and `MAIL_FROM` are set. A 6-digit code is emailed, and entering it with a new password updates the account.

**Free option without a domain:** set `GMAIL_USER` and `GMAIL_APP_PASSWORD` (a Gmail App Password) instead of the Resend settings. If both are set, Resend is used.
