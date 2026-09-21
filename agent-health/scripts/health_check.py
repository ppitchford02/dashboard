#!/usr/bin/env python3
"""Deterministic local health report for Preston's agent systems."""
from __future__ import annotations
import argparse, hashlib, json, os, re, subprocess, tempfile, urllib.error, urllib.request
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

def read_object(path: Path) -> dict:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError('Expected an object')
    return value


def age_of(value) -> float:
    stamp = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        raise ValueError('Timestamp must include timezone')
    age = (datetime.now(timezone.utc) - stamp).total_seconds() / 3600
    if age < -0.1:
        raise ValueError('Timestamp is in the future')
    return age


def sports() -> Finding:
    if HEALTH is None or not (HEALTH / 'sports-picks.json').exists():
        return Finding('Sports Picks', 'yellow', 'No local final receipt available.', 'Verify the latest expected run; do not start a duplicate pass.')
    try:
        data = read_object(HEALTH / 'sports-picks.json')
        outcome = data.get('outcome', 'unknown')
        counts = [data.get(k) for k in ('accountsChecked', 'accountsBlocked', 'picksSaved')]
        if any(type(n) is not int or n < 0 for n in counts):
            raise ValueError('Missing or invalid coverage counts')
        checked, blocked, saved = counts
        age = age_of(data.get('completedAt'))
    except (ValueError, OSError, TypeError) as exc:
        return Finding('Sports Picks', 'yellow', f'Unverified receipt: {exc}', 'Repair or retrieve the exact run receipt; do not infer successful capture.')
    evidence = f"{outcome}: {checked} checked, {blocked} blocked, {saved} saved; completed {data['completedAt']}"
    if outcome in {'failed', 'blocked', 'abandoned'}:
        return Finding('Sports Picks', 'red', evidence, 'Recover only the named blocked/failed items, preserving saved picks.')
    if outcome not in {'complete', 'no_work'} or blocked or (outcome == 'complete' and checked == 0) or (outcome == 'no_work' and saved):
        return Finding('Sports Picks', 'yellow', evidence + '; coverage/outcome is incomplete or inconsistent.', 'Reconcile the receipt against item-level readback before declaring completion.')
    if not data.get('id') and not data.get('runId'):
        return Finding('Sports Picks', 'yellow', evidence + '; no run identifier.', 'Retrieve the identified final receipt.')
    if age > float(os.environ.get('AGENT_HEALTH_SPORTS_MAX_AGE_HOURS', '24')):
        return Finding('Sports Picks', 'yellow', evidence + '; stale for the daily workflow.', 'Check the latest expected run; do not reuse old success as current proof.')
    return Finding('Sports Picks', 'green', evidence + '; run receipt only, not independent pick-accuracy verification.', 'None.')


def hours_since(path: Path) -> float:
    return (datetime.now(timezone.utc) - datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)).total_seconds()/3600


def law() -> Finding:
    if LAW is None:
        return Finding('Law School', 'yellow', 'Law School folder unavailable.', 'Restore the named mount.')
    state = LAW / 'state'
    try:
        ops = read_object(state/'operations.json')
        stages = ops.get('stages', {})
        failures = [k for k in ('doctor','diff','extract','index','reports','backup') if stages.get(k,{}).get('status') == 'failed']
        if failures:
            return Finding('Law School', 'red', 'Failed stages: '+', '.join(failures)+f"; last successful capture {ops.get('last_successful_capture','unknown')}", 'Inspect the failed stage; a delivered report does not establish fresh coursework.')
        capture_age = age_of(ops.get('last_successful_capture'))
        if capture_age > 36:
            return Finding('Law School', 'yellow', f"Capture is stale: {ops.get('last_successful_capture')}", 'Verify collection before making current coursework claims.')
        pending, acked = state/'delivery-receipt.json', state/'delivery-receipt.json.acked'
        path = pending if pending.exists() else acked
        receipt = read_object(path)
        box = read_object(state/'delivery-outbox.json')
        files, cloud = receipt.get('files'), receipt.get('cloud_files')
        if receipt.get('verified') is not True or not files or files != box.get('files') or not isinstance(cloud,list):
            raise ValueError('Delivery proof does not match the current outbox')
        expected = {(f['name'],f['sha256']) for f in files}
        actual = {(f.get('name'),f.get('sha256')) for f in cloud}
        if actual != expected or len(cloud)!=len(files) or len({f.get('id') for f in cloud})!=len(files) or any(not f.get('id') for f in cloud):
            raise ValueError('Missing or mismatched cloud IDs/hashes')
        for f in files:
            if hashlib.sha256(Path(f['source']).read_bytes()).hexdigest()!=f['sha256']:
                raise ValueError('Delivered source bytes have changed')
        ledger = state/'delivery-ledger.json'
        if hours_since(path)>36 or (path==acked and (not ledger.exists() or hours_since(ledger)>36)):
            raise ValueError('Delivery/acknowledgement proof is stale or missing')
        return Finding('Law School','green',f"Capture {ops['last_successful_capture']}; matching verified delivery ({'acknowledgement pending' if path==pending else 'acknowledged'}).",'None.')
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
        return Finding('Law School','yellow',f'Unverified collection/delivery evidence: {exc}','Read current stage and exact receipt; do not infer completion from file timestamps.')


def collections() -> Finding:
    if COLLECTIONS is None:
        return Finding('Collections','yellow','Collections folder unavailable.','Restore the named mount; do not start a paid matter.')
    path = latest(COLLECTIONS/'runs','*.json')
    if path is None:
        return Finding('Collections','yellow','Manual workflow idle; no run evidence.','No automatic run required. Verify only when a matter is assigned.')
    try:
        data = read_object(path)
    except (ValueError,OSError) as exc:
        return Finding('Collections','yellow',f'Unreadable run state: {exc}','Inspect that state without restarting paid research.')
    status = str(data.get('status','unknown')).upper()
    if status in {'FAILED','ERROR','ABANDONED','INTERRUPTED'}:
        return Finding('Collections','red',f'Latest saved run status {status}; {iso_age(path)}','Use checkpoint/resume for the named failure only when authorized.')
    if status != 'DONE' or not data.get('packet') or not data.get('receipts'):
        return Finding('Collections','yellow',f'Manual workflow: {status}; completion not proven; {iso_age(path)}','Review pending handoffs on the next assigned matter; do not launch a scheduled catch-up.')
    return Finding('Collections','green',f'Last manual run DONE with packet/receipts; {iso_age(path)}. Not a current live-source audit.','None; manual workflow has no automatic freshness deadline.')

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
    try:
        remote = get_json(f'{API}/repos/{slug}/git/ref/heads/main')
        expected = str(remote.get('object', {}).get('sha', ''))
        if not re.fullmatch(r'[0-9a-f]{40}', expected):
            raise ValueError('Missing remote main revision')
    except Exception as error:
        return Finding('Dashboard', 'yellow', f'Current main revision unverified: {error}', 'Verify remote main before comparing deployment.')
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
    if state != 'success':
        return Finding('Dashboard', 'red' if state in {'failure','error'} else 'yellow', f'Pages deployment for {published[:7]} reports state "{state}" (deployed {created}).', 'Check the Actions run for that commit before treating the public page as current.')
    receipt = published_commit()
    if receipt and receipt != expected:
        return Finding('Dashboard', 'yellow', f'Published receipt {receipt[:7]} disagrees with successful deployment {expected[:7]}.', 'Reconcile served artifact and deployment before declaring current.')
    extra = f'; published receipt agrees ({receipt[:7]})' if receipt == expected else ''
    shown = state if state != 'unknown' else 'state unread'
    return Finding('Dashboard', 'green', f'Pages deployed {published[:7]} (current remote main), {shown}, at {created}{extra}.', 'None.')

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

def incident_packets(findings: list[Finding]) -> list[dict]:
    """Add actionable context without a model call, recovery attempt, or new IO."""
    owners = {'Sports Picks': 'Sports Picks maintainer', 'Law School': 'Law School maintainer',
              'Collections': 'Collections maintainer', 'Dashboard': 'Dashboard maintainer'}
    packets = []
    for finding in findings:
        if finding.state not in {'yellow', 'red'}:
            continue
        packets.append({
            'system': finding.system, 'state': finding.state,
            'suggested_owner': owners.get(finding.system, 'Manager'),
            'owner_assigned': False,
            'evidence': finding.evidence,
            'root_cause': 'Unverified; the finding establishes evidence/status, not root cause.',
            'run_id': None,
            'execution_host': None,
            'context_note': 'Read the original run receipt for its ID and host; do not substitute the checker host.',
            'recovery_attempts': [],
            'recovery_note': 'This checker performs observation only; prior agent attempts are unknown.',
            'next_action': finding.next_action,
            'completion_test': 'Verify the named condition using fresh original evidence; a green check alone does not prove content accuracy.',
            'stop_condition': 'Stop when the named condition is resolved or one bounded recovery establishes an exact blocker; no duplicate full run.',
            'changes_made': False,
        })
    return packets

def run(write: bool = True) -> dict:
    findings = [sports(), law(), collections(), dashboard()]
    if write:
        write_outbox(findings)
    return {'findings':[asdict(finding) for finding in findings],
            'checked_at': datetime.now(timezone.utc).isoformat(),
            'incidents': incident_packets(findings),
            'claude_outbox': str(OUTBOX) if OUTBOX and OUTBOX.exists() else None}

def self_test() -> None:
    with tempfile.TemporaryDirectory() as temp:
        path = Path(temp) / 'state.json'; path.write_text('{"outcome":"blocked","note":"test"}')
        assert json.loads(path.read_text())['outcome'] == 'blocked'
    assert Finding('x','green','e','n').state == 'green'

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--read-only', action='store_true', help='Never create or remove handoffs')
    args = parser.parse_args()
    if args.self_test: self_test()
    else: print(json.dumps(run(write=not args.read_only), indent=2))
