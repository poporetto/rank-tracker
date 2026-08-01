# Rank Tracker

A free keyword rank tracker with a local web dashboard. You give it a domain and
some keywords; it records where that domain ranks, over time, and shows the trend.

Everything runs on your machine. No accounts, no API bills, no data leaving the box
except the searches themselves.

```bash
npm install
npm start
# → http://ranktracker.localhost:4173
```

Requires Node 22.5+ (uses the built-in `node:sqlite`) and Google Chrome installed.

### The address

`ranktracker.localhost` needs no setup — macOS and every major browser resolve any
`*.localhost` name to 127.0.0.1 with no `/etc/hosts` entry and no `sudo`. Plain
`http://localhost:4173` still works, as does any other `*.localhost` name you like.

Pick your own with `APP_HOST` (this only changes the address the server prints and
accepts; it is still loopback-only):

```bash
APP_HOST=rank.localhost npm start
```

To drop the `:4173` entirely you need port 80, which requires root — either
`sudo PORT=80 npm start` (runs the whole app as root, not recommended) or a `pf`
redirect. Keeping the port is the safer default.

**Don't point the Google OAuth redirect at the pretty name.** It stays
`http://localhost:4173/api/gsc/callback`, because that exact string is registered in
Google Cloud. Browsing via `ranktracker.localhost` works fine — the OAuth round trip
just lands back on `localhost`, which is the same server.

---

## What the numbers actually mean

This is the part most rank trackers are vague about, so it's stated up front.

### DuckDuckGo (works out of the box)

Live SERP positions read from a real Chrome window. Accurate for DuckDuckGo, and it
works for **any** domain — yours or a competitor's.

DuckDuckGo is not Google. Its results correlate with Google but are not identical, so
treat these as a directional signal for "is my content gaining or losing ground", not
as literal Google positions.

### Google Search Console (optional, needs setup)

Real Google data — the *average* position Google itself recorded for that query.
Official, free, and never blocked. Two inherent limits:

- **Only domains you own** and have verified in Search Console.
- It's a 28-day **average**, lagging ~2 days. A value of `7.4` means "averaged 7.4
  across every impression in the window", not "ranked 7th today".

**Keywords match by `contains`, not exact string.** This matters more than it sounds.
Real traffic arrives on longer phrases than the one you track: this project had *zero*
impressions for the exact string `line marking south coast`, while
`car park line marking south coast` pulled 9,642. Exact matching would have reported
"no impressions" and hidden all of it.

So a Search Console row aggregates every query containing your keyword, and the row's
message tells you how many matched. The position, impressions and clicks come straight
from Google's own aggregate over that filter — not recomputed here — so the number is
exactly what Search Console would show you for the same filter.

### Why not scrape Google directly?

Because it doesn't work, and the alternative is worse than a missing feature.
Google serves a CAPTCHA (`/sorry/`) and Bing an interstitial challenge to automated
browsers — verified from this machine, headless and headed, with realistic headers.
Getting past those means CAPTCHA-solving or fingerprint spoofing: a permanent
maintenance treadmill, and a line this tool doesn't cross.

So when an engine blocks a check, the tracker records **`blocked`** and says so,
rather than inventing a number.

---

## The four check statuses

Every check is stored as exactly one of these. The distinction is the single most
important design decision in the tool:

| Status | Meaning |
|---|---|
| `found` | The SERP was parsed and your domain is at this position. |
| `absent` | The SERP was parsed in full and your domain genuinely isn't in it. |
| `blocked` | A challenge/CAPTCHA page came back. **We learned nothing.** |
| `error` | Network, timeout, or auth failure. **We learned nothing.** |

`blocked` and `error` are never plotted on the chart, never used as a baseline for
the "change" column, and never presented as a rank drop. A naive tracker that stores
a blocked fetch as "not ranking" shows you a rank collapse that never happened — this
one won't.

---

## Using it

1. **Create a project** — your domain. Choose whether subdomains
   (`blog.example.com`) count as yours.
2. **Add keywords** — one per line. Every keyword is checked on **both** engines;
   you don't pick one. Each keyword carries a region, because rank is meaningless
   without a locale — tracking `us-en` and `id-id` for the same phrase gives you two
   independent rows, as it should. Depth applies to the DuckDuckGo SERP only.
3. **Check rankings** — Search Console runs first (a plain API call, no browser),
   then DuckDuckGo opens a Chrome window and works through the list with a pause
   between queries. Progress streams live into the dashboard. The window must stay
   visible; that's what makes the results real.
4. **Organise the list** — drag the ⠿ handle to reorder keywords (the order is saved
   and shared by both sections), or click any column header to sort ascending, then
   descending, then back to your manual order. Rows with no data always stay at the
   bottom. 🗑 deletes a keyword and its history immediately, with no confirmation.
5. **Read the two sections** — Search Console on top, DuckDuckGo below. They are
   deliberately never merged into one number: an average position of 7.4 and a live
   SERP position of 2 are different measurements, and subtracting them would be
   meaningless. Each section has its own columns, its own history, and its own trend.
6. **Details** — per-keyword chart and full check history *for that section's engine*,
   plus the SERP snapshot (DuckDuckGo) or your ranking pages (Search Console).
7. **Export CSV** — every check ever recorded, engine and status included.

If Search Console isn't connected, its section says so and is skipped entirely rather
than filling up with error rows.

### Settings (⚙)

- **Delay between queries** — default 8s. Lower is faster and more likely to get you
  challenged. Don't set it to 0 and then complain about `blocked` rows.
- **Google Search Console** — step-by-step OAuth setup. You create an OAuth client in
  Google Cloud (free), paste the ID and secret, and click Connect. The redirect URI is
  shown in the dialog and must be pasted into Google Cloud exactly.

---

## Daily automatic checks

Turn it on under **⚙ Settings → Daily automatic check**: pick a time, and every keyword
in every project is checked on both engines once a day. Search Console runs first
(no browser), then DuckDuckGo.

Two deliberate behaviours:

- **It fires at most once per calendar day.** Restarting the server won't re-trigger a
  run that already happened.
- **Catch-up (on by default).** If the machine was asleep or the server was off at the
  scheduled minute, the run happens the next time the server is up that day — rather
  than silently skipping a day.

The scheduler lives inside the dashboard server rather than in `cron`, because
DuckDuckGo checks need a visible Chrome window. A cron job firing into a logged-out
session would just record `blocked` rows.

### Keeping the server running

The schedule only fires while `npm start` is running. To start it automatically at
login, a ready-made launch agent is included:

```bash
npm run install-agent
```

That generates the plist with the right absolute paths for your machine and loads it.
The generated file is gitignored, because it contains your home directory path.

To stop it running at login:

```bash
launchctl unload ~/Library/LaunchAgents/com.ranktracker.server.plist
```

Logs go to `data/server.log`. You can still trigger a run by hand at any time, from
the dashboard buttons or the API:

```bash
curl -s -XPOST localhost:4173/api/projects/1/run -H 'content-type: application/json' -d '{"engines":["gsc"]}'
```

---

## The run queue

Only one check runs at a time — DuckDuckGo drives a single shared Chrome profile, and
two concurrent runs would fight over it. So a second request while one is going gets
**queued**, not rejected: it appears under the progress bar and starts automatically
the moment the current run finishes.

Identical requests are de-duplicated, so an impatient double-click won't stack up two
copies. You can remove a single queued item with ✕ or drop them all with *clear all*.

---

## Publishing a read-only snapshot

Checking has to happen locally, but the *results* can be published anywhere:

```bash
npm run export          # -> docs/index.html
```

That writes one self-contained HTML file — no server, no database, no external
requests. Point GitHub Pages at the `docs/` folder and it just works.

```bash
npm run export -- --no-metrics       # omit impressions / clicks / CTR
npm run export -- --project 1        # a single project
npm run export -- --out ~/rank.html  # somewhere else
```

**What is never exported:** OAuth client id, client secret, refresh token, or anything
else from the settings table. Only keywords and their check history.

**What is exported, and worth thinking about before publishing:** your keywords, your
positions, and — unless you pass `--no-metrics` — your Search Console impressions,
clicks and CTR. That is commercially sensitive competitive information. If the repo is
public, so is that data.

---

## Layout

```
server.mjs                  HTTP server, JSON API, OAuth callback, CSV export
src/db.mjs                  SQLite schema and queries (node:sqlite, no ORM)
src/domain.mjs              Domain normalisation and matching
src/tracker.mjs             Run orchestration, engine registry, delta logic, run queue
src/providers/duckduckgo.mjs  Playwright SERP reader
src/providers/gsc.mjs         Search Console API client
src/scheduler.mjs           Daily automatic checks
scripts/export.mjs          Static read-only snapshot generator
scripts/launch-agent.mjs    Generates the macOS launch agent
public/                     Dashboard (vanilla JS, no build step)
docs/index.html             Generated snapshot (npm run export)
data/rank-tracker.db        Your data
```

`data/` holds everything — projects, keywords, their order, every check ever recorded,
and your Search Console tokens. It persists across restarts automatically; there is
nothing to enable. Copy that folder to back it up, delete it to start over. It is
gitignored, so your data is local-only and **not** backed up anywhere by default.

## Notes

- A keyword no longer belongs to one engine — it is checked on every engine, and the
  engine is recorded on each check. A database created before that change can't be
  migrated automatically; the server will say so and ask you to `rm -rf data/`.
- The server binds to `127.0.0.1` and rejects non-localhost `Host` headers.
- Your Google OAuth client secret and refresh token live in the local SQLite file.
  Don't commit `data/`.
- Three consecutive `blocked` responses abort the run rather than hammering the engine.
