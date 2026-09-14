#!/usr/bin/env bash
# deploy.sh - publish the dashboard by pushing its SOURCES, then confirm that the
# page GitHub Pages is serving was built by the workflow from exactly that commit.
#
#   ./deploy.sh              commit source changes, push, and verify the published build
#   ./deploy.sh --verify     verify only; push nothing
#   ./deploy.sh --preview    build a local preview into preview/ and stop
#
# There is ONE authoritative build and it is not this script's. GitHub Pages serves the
# artifact that .github/workflows/rebuild.yml uploads from its own public/ directory,
# which the workflow fills by running build.py itself after checking out the pushed
# commit. A laptop-built index.html is therefore never served, and committing one only
# adds churn and an illusion: until 14 Sept 2026 this script rebuilt index.html and
# news.json on every run and pushed them, so a "published" message proved nothing about
# what visitors saw. Sources are what matter. Build artifacts are the workflow's.

set -euo pipefail
cd "$(dirname "$0")"

SITE="https://ppitchford02.github.io/dashboard"
ARTIFACTS=(index.html news.json)      # produced by the workflow; never pushed from here

mode="deploy"
case "${1:-}" in
  --verify)  mode="verify" ;;
  --preview) mode="preview" ;;
  "")        ;;
  *) echo "usage: ./deploy.sh [--verify|--preview]" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------- local preview
if [ "$mode" = "preview" ]; then
  python3 build.py --preview
  echo "open it with:  open preview/index.html"
  exit 0
fi

# ---------------------------------------------------------------- publish sources
if [ "$mode" = "deploy" ]; then
  # A local `python3 build.py` leaves artifacts dirty. They are not publishable input,
  # so say so plainly rather than sweeping them into the commit.
  dirty_artifacts=()
  for f in "${ARTIFACTS[@]}"; do
    git diff --quiet -- "$f" || dirty_artifacts+=("$f")
  done
  if [ ${#dirty_artifacts[@]} -gt 0 ]; then
    echo "these are build artifacts and are not pushed from here: ${dirty_artifacts[*]}"
    echo "the workflow rebuilds them from your sources on its own runner."
    echo "discard the local churn with:  git checkout -- ${dirty_artifacts[*]}"
    echo "for a local look instead, use: ./deploy.sh --preview"
  fi

  # Stage every tracked source change, never an artifact.
  git add -A -- . ':(exclude)index.html' ':(exclude)news.json'
  if git diff --cached --quiet; then
    echo "no source changes to publish"
  else
    git commit -q -m "Dashboard sources $(date '+%Y-%m-%d %H:%M')"
    git push -q origin main
    echo "sources pushed. the workflow builds and publishes; verifying..."
  fi
fi

# ---------------------------------------------------------------- verify what is live
# The page carries the commit it was built from (build.py stamps GITHUB_SHA into the
# embedded dashboard JSON). If the live page reports this commit, the workflow built and
# published this source. Anything else means the run has not finished, or failed.
want="$(git rev-parse HEAD)"
echo "expecting the live page to report commit ${want:0:7}"

for attempt in $(seq 1 20); do
  live="$(curl -fsS --max-time 20 "$SITE/index.html?cachebust=$(date +%s)" 2>/dev/null \
          | grep -o '"commit": *"[0-9a-f]*"' | head -1 | grep -o '[0-9a-f]\{7,\}' || true)"
  if [ -n "$live" ] && [ "$live" = "$want" ]; then
    echo "VERIFIED: $SITE is serving the workflow's build of ${want:0:7}"
    exit 0
  fi
  [ -n "$live" ] && echo "  attempt $attempt: live page is still ${live:0:7}" \
                 || echo "  attempt $attempt: could not read a commit from the live page"
  sleep 30
done

echo "NOT VERIFIED: after ten minutes the live page does not report ${want:0:7}." >&2
echo "The push succeeded; the publish did not, or has not finished. Check the run at" >&2
echo "  https://github.com/ppitchford02/dashboard/actions" >&2
exit 1
