import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime,timezone

spec=importlib.util.spec_from_file_location('agent_health_test',Path(__file__).resolve().parents[1]/'agent-health/scripts/health_check.py')
h=importlib.util.module_from_spec(spec);sys.modules[spec.name]=h;spec.loader.exec_module(h)

class HealthEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
    def put(self,name,data):
        p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(data));return p
    def sports(self,**overrides):
        d=dict(id='synthetic-run',outcome='complete',accountsChecked=11,accountsBlocked=0,picksSaved=2,completedAt=datetime.now(timezone.utc).isoformat());d.update(overrides)
        self.put('sports-picks.json',d)
        with patch.object(h,'HEALTH',self.root):return h.sports()
    def test_valid_current_sports_receipt(self):self.assertEqual(self.sports().state,'green')
    def test_old_receipt(self):self.assertEqual(self.sports(completedAt='2000-01-01T00:00:00Z').state,'yellow')
    def test_inconsistent_receipt(self):self.assertEqual(self.sports(accountsChecked=0,accountsBlocked=11).state,'yellow')
    def test_unknown_outcome(self):self.assertEqual(self.sports(outcome='mystery').state,'yellow')
    def test_blocked_run(self):self.assertEqual(self.sports(outcome='blocked',accountsBlocked=3).state,'red')
    def test_failed_collections_file(self):
        self.put('runs/test.json',{'status':'failed'})
        with patch.object(h,'COLLECTIONS',self.root):self.assertEqual(h.collections().state,'red')
    def test_collections_pending_is_not_done(self):
        self.put('runs/test.json',{'status':'PENDING_HUMAN'})
        with patch.object(h,'COLLECTIONS',self.root):self.assertEqual(h.collections().state,'yellow')
    def test_fresh_delivery_cannot_hide_failed_capture(self):
        self.put('state/operations.json',{'stages':{'doctor':{'status':'failed'}}});self.put('state/delivery-receipt.json',{'verified':True})
        with patch.object(h,'LAW',self.root):self.assertEqual(h.law().state,'red')
    def test_malformed_delivery_is_not_green(self):
        self.put('state/operations.json',{'last_successful_capture':datetime.now(timezone.utc).isoformat()});self.put('state/delivery-receipt.json',{})
        with patch.object(h,'LAW',self.root):self.assertEqual(h.law().state,'yellow')
    def dashboard(self,status='success',receipt='',remote='a'*40):
        (self.root/'.git').mkdir(exist_ok=True)
        def get(url):
            if '/git/ref/' in url:return {'object':{'sha':remote}}
            if '/deployments?' in url:return [{'sha':'a'*40,'created_at':'now','statuses_url':'https://example.invalid/status'}]
            return [] if status is None else [{'state':status}]
        with patch.object(h,'DASH',self.root),patch.object(h,'local_origin_sha',return_value='b'*40),patch.object(h,'repo_slug',return_value='example/repo'),patch.object(h,'get_json',side_effect=get),patch.object(h,'published_commit',return_value=receipt):return h.dashboard()
    def test_unread_status_not_green(self):self.assertEqual(self.dashboard(status=None).state,'yellow')
    def test_explicit_failure_not_green(self):self.assertEqual(self.dashboard(status='failure').state,'red')
    def test_conflicting_published_receipt(self):self.assertEqual(self.dashboard(receipt='b'*40).state,'yellow')
    def test_remote_revision_overrides_stale_local_tracking(self):self.assertEqual(self.dashboard().state,'green')
    def test_read_only_does_not_write_handoff(self):
        f=h.Finding('example','red','failure','fix')
        with patch.object(h,'sports',return_value=f),patch.object(h,'law',return_value=f),patch.object(h,'collections',return_value=f),patch.object(h,'dashboard',return_value=f),patch.object(h,'write_outbox') as w:
            h.run(write=False);w.assert_not_called()

    def test_current_matching_law_delivery_is_green(self):
        import hashlib
        stamp=datetime.now(timezone.utc).isoformat()
        source=self.root/'report.txt';source.write_text('synthetic report')
        item={'source':str(source),'name':'report.txt','sha256':hashlib.sha256(source.read_bytes()).hexdigest()}
        self.put('state/operations.json',{'last_successful_capture':stamp})
        self.put('state/delivery-outbox.json',{'files':[item]})
        self.put('state/delivery-receipt.json',{'verified':True,'files':[item],'cloud_files':[{'name':item['name'],'sha256':item['sha256'],'id':'synthetic-id'}]})
        with patch.object(h,'LAW',self.root):self.assertEqual(h.law().state,'green')
