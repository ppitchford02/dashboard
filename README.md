# PITCHFORD OS

## Daily desk

Today centers the next useful action and a selectable weekly agenda. The page
switches to class prep in the 90 minutes before class, class notes while class
is underway, and reflection for 90 minutes afterward. Evening reset begins at
8:00 PM. Pre-class focus suggestions fit the available time. All clock labels
use 12-hour time in the configured timezone.

Quick captures, course/day study notes, prep checklists, theme preference, and
focus history are stored only in this browser. Today's list is the exception:
it syncs across devices through private D1 and never reaches the public page.
Notes can be downloaded as text. Storage failures are shown explicitly. Local
notes are never included in assistant requests or published automatically. “Add
to dashboard” opens a clear public-save form and requires the existing
passphrase. Captures remain local after publication, and completed captures can
be reopened.

Attention cards can link to schedule entries through `related_deadlines` (an
array of exact deadline titles). Relative labels derive from those dates, and
a past deadline says completion is unconfirmed. No submission is assumed.
Clear/add/restore buttons use authenticated structured Worker actions, with
an undo receipt and a GitHub commit link. Stale items and duplicate restores
are rejected; unrelated data is preserved. These buttons do not call the model.

Study includes a class kit, Brightspace link, local notes, checklists, reflection,
and a persistent focus timer. It does not claim to have fetched assigned reading.
Systems shows the actual publishing run and distinguishes configured agent
statuses from verified execution. No new background messages or notifications
are scheduled; the daily routines adapt the open page.

Front-end sources are `dashboard.css`, `dashboard-core.js`, `picks.js`,
`daily-planner.js`, and `dashboard.js`.
The renderer embeds them in the page. Run `node --test tests/*.test.mjs` and
`python3 -m unittest discover -s tests` before publication. The Worker provides
`GET /health` with its non-secret version and accepts authenticated POST actions
`add_attention`, `complete_attention`, and `restore_attention`, plus the private
`/picks` and `/planner` endpoints.

A compact personal dashboard with an assistant, attention items, schedule,
workforce, weather, personal inbox, and a morning news brief. Navy and gold,
with a responsive two-column overview. Client and firm matters stay off this page.

Live dashboard: https://ppitchford02.github.io/dashboard/

## Files

- `data.json`: existing personal content, dates, timezone, assistant endpoint.
- `template.html`: page layout and browser behavior.
- `build.py`: Python standard-library renderer.
- `news.py`: publisher RSS fetch, daily edition cache, safe headline rendering.
- `news.json`: last successfully fetched edition for each feed.
- `index.html`: generated page; edit the template instead.
- `worker.js`: separately deployed Cloudflare assistant, private picks and planner endpoints.
- `daily-planner.js`: Today's list, synced across devices through private D1.
- `picks.js`: native Sports Picks tab, evidence, filters, and record tracking.
- `schema-picks.sql`: private D1 picks tables and integrity constraints.
- `schema-planner.sql`: private D1 table behind Today's list.
- `.github/workflows/rebuild.yml`: validation, refresh, and GitHub Pages publishing.

## Build and check

```sh
python3 build.py
python3 build.py --check
python3 -m unittest discover -s tests
node --test tests/*.test.mjs
```

`--check` renders in memory and writes neither the page nor the news cache.
No Python packages are required. Python 3.12 and Node 22 run in CI.

## Morning brief

The first successful build after **06:00 America/New_York** fetches three
headlines per feed. The sports card switches between NFL, NBA, and MLB.
Each headline links directly to its publisher, with attribution and publication
date. These are publisher headlines, not invented or AI-written summaries.

Sources:
- AI: https://techcrunch.com/category/artificial-intelligence/feed/
- Akron: https://signalakron.org/feed/
- NFL: https://www.espn.com/espn/rss/nfl/news
- NBA: https://www.espn.com/espn/rss/nba/news
- MLB: https://www.espn.com/espn/rss/mlb/news

ESPN feed information and terms: https://www.espn.com/espn/news/story?page=rssinfo

The workflow checks every 15 minutes (at minutes 07, 22, 37, and 52), and also
runs on main-branch pushes or manual dispatch. GitHub may delay scheduled runs;
06:00 is the refresh threshold, not a guaranteed delivery time. Daily rollover
uses Akron's timezone, including daylight saving time. Each successful feed is
cached until the next edition; failed feeds retry on subsequent builds while
retaining their last successful headlines, explicitly labeled as a previous
edition. A missing feed has an honest unavailable state. No news API keys,
newsletter subscriptions, or email sending are needed.

GitHub Actions restores/saves the news cache. It builds and publishes directly,
without committing generated files every 15 minutes. Only `index.html`,
`data.json`, and `news.json` are included in the Pages artifact. One workflow
owns publishing; the duplicate static workflow has been removed. Pull requests
run checks and builds without deploying.

An idle browser tab refreshes every 15 minutes to receive updated content. It
will not auto-refresh while an assistant request, unsent text, or conversation
is present. The clock, date, and next-deadline countdown update in Akron time.
A conversation may be refreshed manually when ready to load the latest page.

## Assistant

The ask box uses the configured `ask_endpoint`. Authentication uses the existing
passphrase. The Worker answers from dashboard data and can add or remove
deadlines/attention items and update agent status. It can also use web search.

Cloudflare secrets:
- `ANTHROPIC_API_KEY`
- `DASH_PASSPHRASE`
- `GITHUB_TOKEN`: fine-grained, this repo only, Contents read/write

Variables:
- `ALLOWED_ORIGIN`: `https://ppitchford02.github.io`
- `GITHUB_REPO`: `ppitchford02/dashboard`
- `GITHUB_BRANCH`: `main`
- `ANTHROPIC_MODEL`: optional override of the existing default model

KV binding: `LIMITS`. Existing limits: 60 messages/day, 10 per IP per ten
minutes, three web searches per message. KV counters are best-effort rate limits,
not atomic hard spending limits under concurrent requests.

Dates are validated before writes. Empty or ambiguous removal/status matches
are rejected instead of modifying multiple records. GitHub SHA checks prevent
silently overwriting concurrent edits; conflicts return a tool error.

**Worker changes require a separate Cloudflare deployment.** The Pages workflow
does not deploy `worker.js`. Existing secrets and bindings must be retained.
Live model calls and production mutations are not exercised by the local tests.

## Sports Picks

Sports Picks switches within the same page as Today, Study, Systems, and Later.
The browser loads private picks after the existing dashboard passphrase is
entered. Picks, original evidence, results, and source checks stay in private
D1 storage and are never written into `data.json`, the public page, or GitHub.
The tab keeps captured source wording and correction history, supports review,
filters, archive/restore, and evidence-backed result entry. Its unit returns
include only complete picks captured before the event with known valid odds;
voids are excluded and pushes return zero. Records are tracking, not forecasts.

Deploy the database and Worker before publishing the tab:

1. Create the private D1 database `pitchford-picks` and apply `schema-picks.sql`.
2. Bind it as `PICKS_DB` on the existing `pitchford-os-ask` Worker.
3. Deploy `worker.js`, retaining `LIMITS`, all secrets, and existing settings.
4. Unlock the live dashboard and import the existing desk through the scoped
   `dashboard_picks_import` browser tool. Preserve IDs, timestamps, and history.
5. Verify the migrated records before pointing scheduled captures at the
   dashboard's `dashboard_picks_capture` and `dashboard_picks_source_check` tools.

`POST /picks` requires `DASH_PASSPHRASE`, uses the dashboard origin for CORS, and
sends `Cache-Control: no-store`. It does not invoke the assistant or write
public repository content. Database updates reject duplicate picks and stale
versions, and preserve original evidence. The browser registers only scoped
picks tools for reading, capture, checks, and the authorized migration.
Source checks are scheduled separately in Codex at 11 AM, 3 PM, and 6 PM Eastern;
the dashboard itself does not fetch social media or place bets. The open Picks
tab is excluded from automatic page refresh so an unfinished entry is retained.

## Today's list

Today's list is stored server-side in the private D1 database and follows
Preston between his phone and his Mac. It is **not** written into `data.json`,
the published page, or the GitHub repository: the list is personal, it changes
many times a day, and a repository write would publish it, spend a commit and a
Pages rebuild per checkbox, and consume the assistant's shared rate limit. The
assistant therefore cannot see or edit Today's list.

`POST /planner` requires `DASH_PASSPHRASE`, uses the dashboard origin for CORS,
and sends `Cache-Control: private, no-store`. It does not invoke the model, call
GitHub, or count against the KV message caps. Actions are `read`, `save`,
`toggle`, and `prompted`.

`localStorage` under `pitchford-daily-planner:YYYY-MM-DD` is kept only as an
offline cache, so the list paints immediately on load and still works when the
Worker is unreachable. A failed sync keeps the local copy and says so explicitly
rather than dropping the edit.

Replacing the day's plan is guarded by a revision: if the same day changed on
another device first, the save is refused and the newer list is shown instead of
being overwritten. Ticking a checkbox sends a scoped toggle for that one task
and retries a lost race, so two devices working the same list do not collide.
The 9 AM Eastern check-in is recorded for the day rather than per browser, so
planning on one device does not prompt again on another. A browser that has not
been unlocked shows its own cached list and offers an explicit sync.

Deploy before publishing the tab:

1. Apply `schema-planner.sql` to the D1 database already bound as `PICKS_DB`.
   Bind `PLANNER_DB` instead only to keep the list in a separate database.
2. Deploy `worker.js`, retaining `LIMITS`, `PICKS_DB`, and all secrets.
3. Confirm `GET /health` reports `"planner": true`.

## Content upkeep

Deadlines use `YYYY-MM-DDTHH:MM` in the configured timezone. Expired deadlines
are dropped at build time; the live countdown advances to the next item without
getting stuck on an expired one. Attention items still need manual completion
or assistant removal; prose such as “tomorrow” does not update itself.

The Course Load, The Day graph, and Last Run panels have been removed. Their
historical data is preserved in `data.json` for compatibility with existing
adapters. Pending panels remain accessible in their own view.
