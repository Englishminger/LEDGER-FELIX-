# Ledger — Gmail invoice, refund & recurring-bill tracker

A installable web app (PWA) that reads your Gmail, pulls out invoices,
refunds, and bills, and flags the ones that repeat monthly. It runs
entirely in your browser — there's no server, and your email data and
Google token never leave your device.

## How detection works (and its limits)

- **Invoices/purchases**: emails matching words like *invoice, receipt,
  order confirmation, payment confirmation*.
- **Refunds**: emails matching *refund, reimbursement, money back*.
- **Bills**: emails matching *bill, statement, subscription, auto-pay,
  payment due, renewal*.
- **Amount**: the app looks for `$` amounts near words like "total" or
  "amount due"; if none of those are found it falls back to the largest
  dollar amount in the email. This is a heuristic and will occasionally
  misread an email — treat totals as close estimates, not accounting-grade
  numbers.
- **Recurring**: a sender (by domain) + amount combination that shows up
  in 2 or more different calendar months is flagged recurring, per your
  instruction to detect by matching sender and amount. The "next expected"
  date is just last charge + 30 days, not a real billing calendar.

## Important limitation: background sync

This is a plain web app with no server, so it **cannot silently sync itself
while your phone is asleep or the app is closed** — that requires either a
native Android app with a background service, or a backend server that
polls Gmail on a schedule and pushes to your phone. What it *does* do:
- Syncs automatically every time you open it.
- Keeps syncing on a timer (15/30/60 min, your choice in Settings) for as
  long as the app stays open on screen.
- Has a manual "Sync now" button any time.

If true background/scheduled syncing turns out to matter to you, that's a
step up in complexity (a small backend, e.g. a free-tier Cloud Function on
a cron schedule) — worth a separate conversation once you've tried this
version.

## Step 1 — Create a Google Cloud OAuth Client ID

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and
   create a new project (top left project dropdown → New Project). Any
   name is fine, e.g. "Ledger".
2. In the left sidebar: **APIs & Services → Library**. Search for
   **Gmail API** and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen**.
   - User type: **External**.
   - Fill in app name ("Ledger"), your email as support email and
     developer contact.
   - On the Scopes step, add `.../auth/gmail.readonly`.
   - On the Test users step, add your own Gmail address.
   - Leave it in **Testing** status — you don't need to publish it. Test
     apps work fine for personal use; Google just requires you click
     through an "unverified app" warning each time you sign in, since it
     hasn't gone through their review process for public apps.
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth
   client ID**.
   - Application type: **Web application**.
   - Name: anything.
   - Under **Authorized JavaScript origins**, add the exact URL you'll be
     opening this app from (see Step 2 for what that looks like). You can
     add more than one and edit this list later.
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) — you'll
   paste it into the app in Step 3.

## Step 2 — Host the app somewhere with a real URL

Google's sign-in won't work from a `file://` path — it needs `http://` or
`https://`. Pick whichever is easiest for you:

**Option A — GitHub Pages (free, works from any phone, recommended)**
1. Create a new GitHub repo, upload all the files in this folder
   (`index.html`, `styles.css`, `app.js`, `manifest.json`, `sw.js`,
   `icons/`).
2. Repo Settings → Pages → Deploy from branch → `main` / root.
3. Your URL will be `https://<yourusername>.github.io/<reponame>/` —
   add that exact URL to the Authorized JavaScript origins in Step 1.4
   (use the origin only, e.g. `https://yourusername.github.io`, no
   trailing path).

**Option B — Run it locally on your computer, open from your phone**
1. From this folder, run: `python3 -m http.server 8080`
2. Add `http://localhost:8080` to Authorized JavaScript origins if
   testing on the same computer's browser. For your phone, both devices
   need to be on the same network and you'd use your computer's LAN IP
   instead of `localhost` — GitHub Pages is simpler for phone use.

**Option C — Netlify / Vercel drag-and-drop**
Drag this folder onto [app.netlify.com/drop](https://app.netlify.com/drop)
for an instant HTTPS URL, then add that URL to your OAuth origins.

## Step 3 — Open the app and finish setup

1. Visit your hosted URL on your phone.
2. Paste the Client ID from Step 1.5 when prompted.
3. Tap **Sign in with Google**, click through the "unverified app"
   screen (Advanced → Go to Ledger), and approve read-only Gmail access.
4. Tap **Add to Home Screen** from your browser's menu so it opens like a
   normal app icon.

## Files

- `index.html` / `styles.css` — layout and styling
- `app.js` — Google sign-in, Gmail fetching/parsing, on-device storage
  (IndexedDB), recurring-bill detection, all UI rendering
- `manifest.json` / `sw.js` — makes it installable and gives it an
  offline app shell (the data itself always needs a live connection to
  sync, but the app opens instantly even offline)
- `icons/` — app icon
