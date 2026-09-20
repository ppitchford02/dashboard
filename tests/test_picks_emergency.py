import unittest, tempfile, pathlib, shutil, subprocess, json
class EmergencyReceiptTests(unittest.TestCase):
 def test_local_failure_keeps_inventory_and_unknown_counts(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);(root/'bin').mkdir();(root/'agent-health').mkdir()
   script=root/'bin/picks-emergency-receipt.py'
   shutil.copy(pathlib.Path(__file__).resolve().parents[1]/'bin/picks-emergency-receipt.py',script)
   state={'startedAt':'2026-09-20T17:00:00Z','closed':False,'inventory':{'a':{'status':'checked','candidates':[]}}}
   journal=root/'agent-health/sports-picks-active-run.json';journal.write_text(json.dumps(state))
   subprocess.run(['python3',str(script),'MCP disconnected'],check=True,capture_output=True)
   receipt=json.loads((root/'agent-health/sports-picks.json').read_text())
   self.assertEqual(receipt['outcome'],'blocked');self.assertIsNone(receipt['picksSaved'])
   self.assertFalse(receipt['remoteReceiptVerified']);self.assertEqual(json.loads(journal.read_text()),state)
   state['closed']=True;journal.write_text(json.dumps(state))
   self.assertNotEqual(subprocess.run(['python3',str(script)],capture_output=True).returncode,0)
