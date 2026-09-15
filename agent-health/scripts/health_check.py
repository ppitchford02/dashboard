#!/usr/bin/env python3
"""Deterministic local health report for Preston's agent systems."""
from __future__ import annotations
import argparse, json, os, re, subprocess, tempfile, urllib.error, urllib.request
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

LOCAL_ROOT = Path('/Users/prestonpitchford')

def first_existing(candidates: list[Path]) -> Path | None:
    for candidate in candidates:
        try:
            if candidate.exists():
                return candidate.resolve()
        except OSError:
            continue
    return None

def mounted_candidates(suffix: str) -> list[Path]:
    """Check only known shallow Claude mount layouts."""
    candidates: list[Path] = []
    for mount in (Path.home() / 'mnt', Path('/mnt/data'), Path('/mnt')):
        try:
            if not mount.exists():
                continue
            candidates.append(mount / suffix)
            candidates.extend(mount.glob(f'*/{suffix}'))
        except OSError:
            continue
    return candidates

def resolve_dashboard_health() -> Path | None:
    override = os.environ.get('AGENT_HEALTH_DASHBOARD_DIR')
    candidates = ([Path(override).expanduser()] if override else []) + [
        LOCAL_ROOT / 'dashboard' / 'agent-health',
        Path.cwd(),
        *mounted_candidates('dashboard/agent-health'),
        *mounted_candidates('agent-health'),
    ]
    for candidate in candidates:
        try:
            if (candidate / 'sports-picks.json').exists() or ((candidate / 'README.md').exists() and (candidate / 'CLAUDE.md').exists()):
                return candidate.resolve()
        except OSError:
            continue
    return None

HEALTH = resolve_dashboard_health()
DASH = first_existing(([Path(os.environ['AGENT_HEALTH_DASHBOARD_ROOT']).expanduser()] if os.environ.get('AGENT_HEALTH_DASHBOARD_ROOT') else []) + [
    LOCAL_ROOT / 'dashboard',
    HEALTH.parent if HEALTH and HEALTH.parent.name == 'dashboard' else Path('/nonexistent'),
    *mounted_candidates('dashboard'),
])
LAW = first_existing(([Path(os.environ['AGENT_HEALTH_LAW_ROOT']).expanduser()] if os.environ.get('AGENT_HEALTH_LAW_ROOT') else []) + [LOCAL_ROOT / 'law-school-os', *mounted_candidates('law-school-os')])
COLLECTIONS = first_existing(([Path(os.environ['AGENT_HEALTH_COLLECTIONS_ROOT']).expanduser()] if os.environ.get('AGENT_HEALTH_COLLECTIONS_ROOT') else []) + [LOCAL_ROOT / 'skiptrace-harness' / 'harness', *mounted_candidates('skiptrace-harness/harness')])
OUTBOX = HEALTH / 'outbox' / 'claude.md' if HEALTH else None

@dataclass
class Finding:
    system: str
    state: str
    evidence: str
    next_action: str

def iso_age(path: Path) -> str:
    when = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat().replace('+00:00','Z')
    return f'{path} updated {when}'

def latest(path: Path, pattern: str) -> Path | None:
    entries = list(path.glob(pattern)) if path.exists() else []
    return max(entries, key=lambda item: item.stat().st_mtime) if entries else None

def sports() -> Finding:
    if HEALTH is None:
        return Finding('Sports Picks', 'yellow', 'Dashboard agent-health folder is unavailable in this run.', 'Treat Sports Picks as unverified until its receipt folder is mounted.')
    mirror = HEALTH / 'sports-picks.json'
    if not mirror.exists():
        return Finding('Sports Picks', 'yellow', 'No local final receipt exists yet.', 'Wait for one scheduled pass; do not call it successful until it writes a receipt.')
    try: data = json.loads(mirror.read_text())
    except Exception: return Finding('Sports Picks', 'red', f'Unreadable receipt: {mirror}.', 'Repair the local Sports Picks receipt mirror before another run.')
    outcome = data.get('outcome', 'unknown')
    if outcome in {'complete','no_work'}:
        return Finding('Sports Picks', 'green', f"{outcome}: {data.get('accountsChecked',0)} accounts checked; {data.get('picksSaved',0)} picks saved.", 'None.')
    return Finding('Sports Picks', 'red', f"{outcome}: {data.get('note','No reason recorded.')}", 'Read the run receipt and repair only the named blocker.')

def hours_since(path: Path) -> float:
    age = datetime.now(timezone.utc) - datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    return age.total_seconds() / 3600

def law() -> Finding:
    """Delivery writes state/delivery-receipt.json; the next morning run acknowledges
    it and renames it to .acked, recording the Drive file ids in delivery-ledger.json.
    The acknowledged receipt plus a current ledger IS the success state, so the absence
    of delivery-receipt.json is not evidence that delivery failed."""
    if LAW is None:
        return Finding('Law School', 'yellow', 'Law School folder is unavailable in this run.', 'Treat delivery as unverified until its receipt folder is mounted.')
    state = LAW / 'state'
    pending = state / 'delivery-receipt.json'
    acked = state / 'delivery-receipt.json.acked'
    ledger = state / 'delivery-ledger.json'
    STALE_HOURS = 36.0
    if pending.exists():
        if hours_since(pending) <= STALE_HOURS:
            return Finding('Law School', 'green', f'{iso_age(pending)} (delivered; acknowledgement due on the next morning run)', 'None.')
        return Finding('Law School', 'yellow', f'{iso_age(pending)} (delivered but not acknowledged for over {int(STALE_HOURS)}h)', 'Check that the morning run is still acknowledging receipts; the delivery itself completed.')
    if acked.exists() and ledger.exists():
        if hours_since(ledger) <= STALE_HOURS:
            return Finding('Law School', 'green', f'{iso_age(acked)}; {iso_age(ledger)}', 'None.')
        return Finding('Law School', 'yellow', f'Last acknowledged delivery is over {int(STALE_HOURS)}h old: {iso_age(ledger)}', 'Check the delivery task\u2019s next run; the previous delivery completed and was acknowledged.')
    if acked.exists():
        return Finding('Law School', 'yellow', f'{iso_age(acked)} but no delivery ledger is present.', 'Check the delivery task\u2019s next run; do not claim delivery completed without its ledger.')
    return Finding('Law School', 'yellow', 'No local Drive-delivery receipt found, acknowledged or pending.', 'Check the delivery task\u2019s next run; do not claim delivery completed without its receipt.')

def collections() -> Finding:
    if COLLECTIONS is None:
        return Finding('Collections', 'yellow', 'Collections folder is unavailable in this run.', 'Treat Collections as unverified; do not start a paid case.')
    runs = latest(COLLECTIONS / 'runs', '*.json')
    if runs: return Finding('Collections', 'green', iso_age(runs), 'None.')
    return Finding('Collections', 'yellow', 'No local Collections run-state file found.', 'Run only when Preston supplies a case; preserve the paid-run checkpoint and resume guard.')

# The health check runs in the device shell, whose egress proxy allow-lists by host.
# ppitchford02.github.io is not allow-listed, so fetching the published receipt there
# fails with "Tunnel connection failed: 403 Forbidden". api.github.com IS allow-listed
# and serves this public repo's Pages deployments without a token, so deployment state
# is verified from there. The published receipt is read only as an optional extra.
API = os.environ.get('AGENT_HEALTH_GITHUB_API', 'https://api.github.com').rstrip('/')
RECEIPT_URL = os.environ.get('AGENT_HEALTH_DASHBOARD_RECEIPT_URL', 'https://ppitchford02.github.io/dashboard/dashboard.json')

def repo_slug(repo: Path) -> str | None:
    override = os.environ.get('AGENT_HEALTH_DASHBOARD_REPO')
    if override:
        return override.strip()
    try:
        done = subprocess.run(['git', '-C', str(repo), 'remote', 'get-url', 'origin'],
                              capture_output=True, text=True, timeout=10,
                              env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    match = re.search(r'github\.com[:/]+([^/]+/[^/\s]+?)(?:\.git)?$', done.stdout.strip())
    return match.group(1) if match else None

def local_origin_sha(repo: Path) -> str | None:
    """Last-known origin/main, read without fetching. No network, no ref changes."""
    try:
        done = subprocess.run(['git', '-C', str(repo), 'rev-parse', 'origin/main'],
                              capture_output=True, text=True, timeout=10,
                              env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
    except (OSError, subprocess.SubprocessError):
        return None
    sha = done.stdout.strip()
    return sha if done.returncode == 0 and len(sha) == 40 else None

def get_json(url: str):
    request = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'agent-health'})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode('utf-8'))

def published_commit() -> str:
    """Optional. Never decides the finding; the egress proxy usually blocks it."""
    try:
        return str(get_json(RECEIPT_URL).get('commit', '')).strip()
    except Exception:
        return ''

def dashboard() -> Finding:
    if DASH is None:
        return Finding('Dashboard', 'yellow', 'Dashboard repository root is unavailable in this run.', 'Treat deployment state as unverified until a receipt or repository root is mounted.')
    if not (DASH / '.git').exists():
        return Finding('Dashboard', 'yellow', 'Dashboard folder is mounted without repository metadata.', 'Treat deployment state as unverified until a deployment receipt is available.')
    expected = local_origin_sha(DASH)
    if expected is None:
        return Finding('Dashboard', 'yellow', 'Could not read origin/main from the local repository.', 'Treat deployment state as unverified until origin/main resolves.')
    slug = repo_slug(DASH)
    if slug is None:
        return Finding('Dashboard', 'yellow', 'Could not determine the GitHub repository from the origin remote.', 'Treat deployment state as unverified until the origin remote resolves.')
    url = os.environ.get('AGENT_HEALTH_DEPLOYMENTS_URL', f'{API}/repos/{slug}/deployments?environment=github-pages&per_page=1')
    try:
        deployments = get_json(url)
    except Exception as error:
        return Finding('Dashboard', 'yellow', f'GitHub deployments API unreachable ({error}).', 'Treat the published page as unverified; do not claim it is current without its deployment record.')
    if not isinstance(deployments, list) or not deployments:
        return Finding('Dashboard', 'yellow', f'No github-pages deployment is recorded for {slug}.', 'Treat the published page as unverified until a Pages deployment is recorded.')
    latest = deployments[0]
    published = str(latest.get('sha', '')).strip()
    created = latest.get('created_at', 'unknown time')
    state = 'unknown'
    statuses = latest.get('statuses_url')
    if statuses:
        try:
            target = str(statuses)
            if target.startswith(('http://', 'https://')) and '?' not in target:
                target += '?per_page=1'
            rows = get_json(target)
            if isinstance(rows, list) and rows:
                state = str(rows[0].get('state', 'unknown'))
        except Exception:
            state = 'unknown'
    if published != expected:
        return Finding('Dashboard', 'yellow', f'Pages last deployed {published[:7] or "?"} but origin/main is {expected[:7]} (deployed {created}).', 'A deploy may still be in flight; re-check before treating the public page as current.')
    if state not in {'success', 'unknown'}:
        return Finding('Dashboard', 'yellow', f'Pages deployment for {published[:7]} reports state "{state}" (deployed {created}).', 'Check the Actions run for that commit before treating the public page as current.')
    receipt = published_commit()
    extra = f'; published receipt agrees ({receipt[:7]})' if receipt == expected else ''
    shown = state if state != 'unknown' else 'state unread'
    return Finding('Dashboard', 'green', f'Pages deployed {published[:7]} (origin/main), {shown}, at {created}{extra}.', 'None.')

def write_outbox(findings: list[Finding]) -> None:
    if OUTBOX is None:
        return
    problems = [f for f in findings if f.state == 'red']
    if not problems:
        if OUTBOX.exists() and OUTBOX.read_text().startswith('# Claude health follow-up'):
            OUTBOX.unlink()
        return
    text = ['# Claude health follow-up', '', 'Act only on the items below. Do not run broad audits, browse sources, deploy, change schedules, or edit unrelated systems.', '']
    for item in problems:
        text += [f'## {item.system}', f'Evidence: {item.evidence}', f'Next action: {item.next_action}', 'Stop after confirming the named condition or recording the blocker.', '']
    OUTBOX.parent.mkdir(parents=True, exist_ok=True)
    OUTBOX.write_text('\n'.join(text))

def run() -> dict:
    findings = [sports(), law(), collections(), dashboard()]
    write_outbox(findings)
    return {'findings':[asdict(finding) for finding in findings], 'claude_outbox': str(OUTBOX) if OUTBOX and OUTBOX.exists() else None}

def self_test() -> None:
    with tempfile.TemporaryDirectory() as temp:
        path = Path(temp) / 'state.json'; path.write_text('{"outcome":"blocked","note":"test"}')
        assert json.loads(path.read_text())['outcome'] == 'blocked'
    assert Finding('x','green','e','n').state == 'green'

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test: self_test()
    else: print(json.dumps(run(), indent=2))
