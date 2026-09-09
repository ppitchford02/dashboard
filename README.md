# PITCHFORD OS — dashboard generator

Builds `index.html` from `data.json` plus live weather, then publishes it to
GitHub Pages.

Live at: https://ppitchford02.github.io/dashboard

## Files

| file | what it is |
|---|---|
| `data.json` | everything the page says. **This is the file you edit.** |
| `template.html` | the design, with `{{TOKENS}}` where values go. Rarely touched. |
| `build.py` | fills the template from `data.json`, writes `index.html` |
| `deploy.sh` | runs build.py, commits, pushes |
| `index.html` | generated output. Never edit by hand, it gets overwritten. |

## Running it

```
cd ~/dashboard
./deploy.sh
```

That's the whole loop. Build only, no publish:

```
python3 build.py
```

Render without writing anything, to check for errors:

```
python3 build.py --check
```

No pip installs. Standard library only.

## What's computed vs what you write

**Computed automatically** — don't put these in data.json, they're derived:

- current date, time, and the BUILT stamp at the bottom
- weather, from Open-Meteo (no API key). Falls back to `weather_fallback`
  in data.json if the request fails
- the countdown to your next deadline, and its colour
- points still open (sums `points` on deadlines that haven't passed)
- the schedule panel, grouped by day, with past items dropped
- TODAY / TOMORROW labels
- the day-shape curve and the morning/afternoon/evening lines
- greeting wording, from the hour
- the dial arc, showing how much of the day is gone

**You write** — in `data.json`:

- deadlines, with `due` as `YYYY-MM-DDTHH:MM` local time
- attention items, with `level` set to `high`, `med`, or `low`
- agents, courses, pending panels, inbox note

## The catch worth knowing

Deadlines expire on their own, because the schedule drops anything in the past.
Attention items do **not**. If one says "tomorrow night" it will still say that
next week. Clear finished ones out of `data.json` when you add new ones.

That's the seam where this should eventually read from law-school-os instead of
a hand-kept file. `build.py` only needs `data["deadlines"]` to be a list of
dicts with `title`, `due`, and optionally `points` / `note` — so an adapter that
converts a sweep into that shape is all that's missing.

## Scheduling it

Once you're happy running it by hand, a launchd job can call `deploy.sh` on a
timer, the same way law-school-os already runs `bin/morning.sh`. Not set up yet
on purpose — worth confirming the manual loop first.

## The ask box

The box under the greeting is off until `ask_endpoint` in data.json points at a
Cloudflare Worker. Until then it renders greyed out and says OFFLINE, which is
honest rather than decorative.

`worker.js` is the code that goes in the Worker. It holds the API key so the
browser never sees it, checks a passphrase, enforces a daily cap and a per-IP
burst limit, then fetches your live data.json so answers know today's page.

Setup, once:

1. Make a free account at cloudflare.com.
2. Compute → Workers → Create → paste `worker.js` in, deploy.
3. Storage → KV → create a namespace called `LIMITS`.
4. In the Worker's Settings → Bindings, add a KV binding named `LIMITS`
   pointing at that namespace.
5. In Settings → Variables, add two **secrets**:
   `ANTHROPIC_API_KEY` and `DASH_PASSPHRASE` (the phrase is yours to pick).
6. In the same place, add two plain **variables**:
   `ALLOWED_ORIGIN` = `https://ppitchford02.github.io`
   `DATA_URL` = the raw GitHub URL of data.json
7. Copy the Worker's URL into `ask_endpoint` in data.json, then `./deploy.sh`.

The caps live at the top of worker.js: 50 messages a day, 8 per IP per ten
minutes, and the cheap model. Raise them once you know what it actually costs.

If the rate limiter can't be reached the Worker returns an error rather than
letting the request through, so a KV outage can't run up a bill.

## What it can and can't do

It answers about your day from data.json. It cannot change anything — no adding
deadlines, no editing the page. That's deliberate for a first version: a public
endpoint that can write to your repo is a different risk conversation.

The shape is ready for it though. Adding write actions means giving the Worker a
GitHub token and a tools array, and the passphrase gate and caps already built
are the parts that make that safe to consider.

## If a push fails

The repo uses a fine-grained token scoped to `dashboard` only, stored in the
macOS keychain. If it 403s, the token has expired and needs regenerating at
github.com/settings/personal-access-tokens with Contents set to read and write.
