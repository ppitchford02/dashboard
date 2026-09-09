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

The box under the greeting talks to a Cloudflare Worker (`worker.js`). The
Worker holds the API key, checks your passphrase, caps spend, reads the live
data.json from the repo, and can **write** to it when you tell it to.

It runs on Sonnet, can search the web, and has five tools: add_deadline,
remove_deadline, add_attention, remove_attention, set_agent_status. Say
"add a civ pro memo due friday at noon" and it edits data.json in the repo,
which triggers the rebuild workflow, which republishes the page. The box shows
a countdown and reloads itself when that lands.

Worker settings (Settings → Variables and secrets):

Secrets:
- `ANTHROPIC_API_KEY`
- `DASH_PASSPHRASE`
- `GITHUB_TOKEN` — fine-grained, this repo only, Contents: read and write

Plain variables:
- `ALLOWED_ORIGIN` = `https://ppitchford02.github.io` (no trailing slash)
- `GITHUB_REPO` = `ppitchford02/dashboard`
- `GITHUB_BRANCH` = `main`

Binding: KV namespace named `LIMITS`.

Caps at the top of worker.js: 60 messages a day, 10 per IP per ten minutes,
3 web searches per message. Raise once you know the cost.

## Automatic updates

`.github/workflows/rebuild.yml` runs on GitHub every 15 minutes, on any push,
and on demand from the Actions tab. It rebuilds index.html, commits it if it
changed, and publishes to Pages. Your Mac is not involved, so it keeps running
with the laptop shut.

The clock and the deadline countdown in the header tick live in the browser.
The BUILT line at the bottom is when the data was last pulled.

The older `static.yml` workflow is now redundant; delete it from
`.github/workflows` or leave it, it does no harm.

## If a push fails

The repo uses a fine-grained token scoped to `dashboard` only, stored in the
macOS keychain. If it 403s, the token has expired and needs regenerating at
github.com/settings/personal-access-tokens with Contents set to read and write.
