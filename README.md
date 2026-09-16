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

Front-end sources are `dashboard.css`, `dashboard-core.js`, `picks.js`, `parlay-builder.js`,
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
  It holds no creator roster; the roster arrives from the Worker after unlock.
- `picks-roster.json`: local, gitignored, never committed. Its contents are the
  value of the `PICKS_ROSTER` Worker secret. Keep a copy somewhere safe.
- `picks-agent-token.txt`: local, gitignored, never committed. One line holding the
  same value as the `PICKS_AGENT_TOKEN` Worker secret. The scheduled Sports Picks
  task reads it at fire time so the token never appears in a prompt or a
  transcript. Delete it to stop automation on this machine.
- `tests/fixtures/roster.json`: synthetic roster used by the tests. No real
  creator name, account identifier, or account link appears in this repository.
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
- `PICKS_ROSTER`: the private creator-account roster as JSON, set from the local
  `picks-roster.json`. Required by `/picks`; see Sports Picks below.
- `PICKS_AGENT_TOKEN`: optional. A separate, revocable secret the scheduled
  Sports Picks task authenticates with instead of the passphrase. At least 32
  characters. Unset means automation simply cannot authenticate at all.

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

### The publishing path stays ordinary software

Checked 16 Sept 2026 and unchanged: the dashboard builds, tests, publishes and
verifies itself with no model in the path. The workflow runs the two regression
suites, then `build.py`, then copies `index.html`, `data.json` and `news.json`
into the Pages artifact along with `dashboard.json`, the deployment receipt
carrying `$GITHUB_SHA`. `secrets.GITHUB_TOKEN` is the only secret it uses, and
`build.py` needs no API key.

`tests/test_publishing_stays_deterministic.py` is the guard. It fails if the
build path or the workflow ever acquires a model call, an API key or an MCP
dependency, if the suites stop running before the build, or if the deployment
receipt disappears. It asserts about files only and changes no behaviour. The
agent-status panel on the page is display data from `data.json`, not a
dependency; nothing about publishing waits on an agent run.

## Sports Picks

Sports Picks switches within the same page as Today, Study, Systems, and Later.
The browser loads private picks after the existing dashboard passphrase is
entered. Picks, original evidence, results, and source checks stay in private
D1 storage and are never written into `data.json`, the public page, or GitHub.
The tab keeps captured source wording and correction history, supports review,
filters, archive/restore, and evidence-backed result entry. Its unit returns
include only complete picks captured before the event with known valid odds;
voids are excluded and pushes return zero. Records are tracking, not forecasts.

### Creators and accounts

A creator may post the same pick from several accounts. Each creator keeps one
id, so stored rows, source records, and deduplication are unchanged, and the
account a pick came from is recorded privately alongside it. An account is
required on every new capture from a creator with more than one account;
historical picks with no recorded account stay editable and unchanged.

The roster, every account link, and the creator-to-account mapping live only in
the `PICKS_ROSTER` Worker secret. They are served on an authenticated read and
are never inlined into the published page, `data.json`, or any static output.
The page holds no roster until the passphrase unlocks the desk, at which point
the creator tabs, source records, and account dropdown are built from the read.
Without the secret, or with a malformed one, `/picks` fails closed: every action
returns 503 naming the problem rather than running with an unvalidated roster.
Tests assert that no tracked file and no built page contains an account link.

### Eligible picks and Leans

**Eligible picks** lists confirmed selections only, one per line in plain form,
with no captions, post times, platform details, source-check notes, or
uncertainty reasons. A pick is shown only after it passes a check against the
evidence stored with it: known creator and account, captured before the event,
selection, event, date and original evidence present, an https source link, and
wording that states a pick. Unclear wording gets one further pass; if it still
does not hold, the pick is omitted and its reason is kept in the private record.
This checks stored evidence. The live post is not reopened.

**Leans** is a separate labelled list for qualified wording such as "lean",
"would have to lean", or "maybe". Leans are visible but never counted as
confirmed picks, never included in source records, and never used as Parlay
Builder input.

### Capturing a new pick

Every **new** capture must show that its own source link was reopened once,
immediately before saving. The save carries the exact link that was reopened and
the time; a save without it, or with a link that does not match the pick's own
source link, is refused. Nothing about this applies to existing records: imports
and corrections carry no recheck and are accepted unchanged, so historical picks
are never touched by the rule.

The reopened post decides the record. Nobody classifies a pick by hand, not
Preston and not an agent: the captured wording is read with the same cues used
for reels, and a direct call saves ready to count, qualified wording saves as a
Lean, and wording that states neither saves for review with the reason. An
incomplete pick stays in review whatever the wording showed. On the capture form
the class is shown but not editable, and it updates as the evidence is pasted.

### Automation access

The scheduled source check cannot type the dashboard passphrase, so it
authenticates with `PICKS_AGENT_TOKEN`, a separate secret that is rotated or
deleted on its own without affecting the passphrase. The passphrase flow is
untouched: the token is consulted only when a passphrase was not supplied or did
not match, and a passphrase request behaves exactly as it always has.

The token is deliberately weaker than the passphrase. It permits `read`, `save`,
`check` and `transcript` only. `edit`, `settle`, `archive` and `import` are
refused with 403, so automation cannot correct, settle, archive, re-classify or
overwrite an existing record — historical picks are out of reach at the
authentication layer, not merely by instruction. New captures still have to carry
a reopened source link like any other.

A secret shorter than 32 characters, or an unset one, never matches, so a weak or
missing token fails closed. Comparison is length-checked and constant-time. In
the browser the token is supplied per page by the `dashboard_picks_automation_token`
tool, held in memory for that page only, and never written to localStorage,
sessionStorage, or anywhere else. To revoke automation, delete or rotate the
secret in Cloudflare; nothing else changes.

### Reel intake

`reel_transcripts` holds reel evidence privately: the transcript, transcription
time, creator, account, reel link, engine, and medium. Medium is constrained to
audio at both the schema and the API, so a caption or a viewer comment can never
be stored as a source, and a trigger makes a stored transcript immutable. A pick
that claims a transcript must match one from the same account and its selection
must appear in the creator's spoken words, or the save is refused.

Extraction reads the creator's spoken sentences only and classifies each as a
firm pick or a lean. Sentences relaying someone else are dropped with a reason.
Intake stores the transcript and returns candidates; it never saves a pick by
itself. Transcription is pluggable through an adapter interface. No local
transcription runtime is installed, so that adapter reports itself unavailable
and names the missing dependency rather than downloading anything.

### Freshness gate (added 16 Sept 2026)

The scheduled pass calls `sports_picks_freshness` first, before it reads,
transcribes, classifies or captures anything. It hands the gate the source
identifiers, exact post links, posted timestamps and content hashes it can see
without interpreting them. The gate compares those against what the last
successful aggregate receipt already covered, in `picks-freshness.js`, which
calls no model, opens no network connection and checks no source.

When nothing is new the gate writes the required aggregate receipt itself with
`outcome: "no_work"` and zero picks, mirrors it to `agent-health/`, and returns
`stop: true`; the pass is over and no model interpretation runs. When something
is new it returns only that material, as the caller's own objects, so the exact
post link survives for reopening. The same post arriving twice in one batch is
released once.

The index of what has been covered lives in
`agent-health/sports-picks-seen.json`. It holds hashes, an account id and a
posted timestamp, never a creator link or handle, and it is gitignored. It
advances only when a successful aggregate receipt is written, so a pass that is
abandoned or fails releases the same material again on the next run.

The **Record a source check** form in the Sports Picks sidebar saves a source,
status and observation note through the same private API used by the agent.
Failed saves retain the note for correction or retry. A locked new device waits
to load the shared daily planner before showing a morning planning prompt.

### Deployment order

Order matters. The read queries `reel_transcripts` in the same batch as picks,
so a missing table breaks every read, not only transcript work; and the page
build expects a Worker that returns the roster. Deploy in this order:

1. **Schema first.** Apply `schema-picks.sql` to the private D1 database bound
   as `PICKS_DB`. Every statement is `IF NOT EXISTS`, so re-running the whole
   file is safe and changes no existing row. Additive, and ignored by the
   currently deployed Worker, so it can be done ahead of everything else.
2. **Secret second.** Add the encrypted variable `PICKS_ROSTER` to the
   `pitchford-os-ask` Worker with the contents of `picks-roster.json`. A Worker
   that does not yet read it ignores it, so setting it early is harmless;
   deploying the new code first would leave `/picks` returning 503.
3. **Worker third.** Deploy `worker.js`, retaining `LIMITS`, `PICKS_DB`, all
   secrets, and existing settings. Check `/health`, then unlock the live
   dashboard and confirm picks still load.
4. **Pages push fourth.** Push the commit. The workflow runs the checks, builds
   the page, and publishes it. Pushing before step 3 would leave the new page
   asking an old Worker for a roster it does not return, so the creator list
   would be empty and capture would refuse to open.

First-time setup only: create the private D1 database `pitchford-picks`, bind it
as `PICKS_DB`, then after step 4 import the existing desk through the scoped
`dashboard_picks_import` browser tool, preserving IDs, timestamps, and history,
and verify the migrated records before pointing scheduled captures at
`dashboard_picks_capture` and `dashboard_picks_source_check`.

`POST /picks` requires `DASH_PASSPHRASE`, uses the dashboard origin for CORS, and
sends `Cache-Control: no-store`. It does not invoke the assistant or write
public repository content. Database updates reject duplicate picks and stale
versions, and preserve original evidence. The browser registers only scoped
picks tools for reading, capture, checks, and the authorized migration.
Source checks are scheduled separately in Codex at 11 AM and 5 PM Eastern;
the dashboard itself does not fetch social media or place bets. The open Picks
tab is excluded from automatic page refresh so an unfinished entry is retained.

The **Parlay Builder** button opens inside Sports Picks. For an Eastern game
date, it reads the private picks desk and compares only confirmed, dated NFL
anytime-touchdown selections with research from the existing web-enabled
dashboard assistant. It sends the assistant short selection labels and source
names, never original evidence, source URLs, or other private records. The result
displays direct research links and labels the run incomplete if it lacks an
official NFL link plus another source domain. Research runs on demand under the
assistant's existing usage limits. The dashboard never submits a wager.

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
