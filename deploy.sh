#!/usr/bin/env bash
# deploy.sh - rebuild index.html and publish it to GitHub Pages.
#
#   ./deploy.sh
#
# Safe to run repeatedly. If nothing changed, it says so and stops.

set -euo pipefail
cd "$(dirname "$0")"

python3 build.py

if git diff --quiet -- index.html; then
  echo "no change, nothing to publish"
  exit 0
fi

git add index.html
git commit -q -m "Dashboard $(date '+%Y-%m-%d %H:%M')"
git push -q origin main
echo "published. live in a minute or two at:"
echo "  https://ppitchford02.github.io/dashboard"
