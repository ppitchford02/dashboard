#!/usr/bin/env python3
"""Local-only failure evidence when the MCP transport is unavailable. No tokens/network."""
import json, pathlib, datetime, sys, os
root = pathlib.Path(__file__).resolve().parents[1] / 'agent-health'
reason = sys.argv[1] if len(sys.argv) == 2 else 'Local Sports Picks tools unavailable; run stopped after one reconnect attempt.'
state_path = root / 'sports-picks-active-run.json'
state = json.loads(state_path.read_text()) if state_path.exists() else {}
if state.get('closed'):
    raise SystemExit('Run already closed; refusing to overwrite its receipt.')
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
inventory = state.get('inventory', {})
receipt = {'outcome':'blocked','startedAt':state.get('startedAt',now),'completedAt':now,
 'accountsChecked':sum(v.get('status')=='checked' for v in inventory.values()),
 'accountsBlocked':sum(v.get('status')=='blocked' for v in inventory.values()),
 'picksSaved':None,'checksSaved':None,'remoteReceiptVerified':False,
 'note':reason+' Counts of saves are unverified; this is local failure evidence, not a successful Worker receipt.'}
root.mkdir(parents=True,exist_ok=True)
target=root/'sports-picks.json'; tmp=root/('sports-picks.json.'+str(os.getpid())+'.tmp')
with open(tmp,'w') as f:
    os.chmod(tmp,0o600);json.dump(receipt,f)
os.replace(tmp,target)
print('Local BLOCKED evidence saved; inventory retained. No remote receipt or source action performed.')
