import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('health_incidents_test', Path(__file__).resolve().parents[1] / 'agent-health/scripts/health_check.py')
h = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = h
spec.loader.exec_module(h)


class IncidentTests(unittest.TestCase):
    def test_missing_evidence_stays_yellow_with_no_invented_context(self):
        result = h.incident_packets([h.Finding('Sports Picks', 'yellow', 'Missing receipt', 'Read exact receipt')])[0]
        self.assertEqual(result['state'], 'yellow')
        self.assertIsNone(result['run_id'])
        self.assertIsNone(result['execution_host'])
        self.assertFalse(result['owner_assigned'])
        self.assertFalse(result['changes_made'])
        self.assertEqual(result['recovery_attempts'], [])

    def test_only_problems_generate_packets(self):
        findings = [h.Finding('Dashboard', 'green', 'current', 'None'), h.Finding('Law School', 'red', 'extract failed', 'Inspect extraction')]
        packets = h.incident_packets(findings)
        self.assertEqual(len(packets), 1)
        self.assertEqual(packets[0]['evidence'], 'extract failed')
        self.assertEqual(packets[0]['next_action'], 'Inspect extraction')

    def test_read_only_report_preserves_findings_and_performs_no_recovery(self):
        f = h.Finding('Dashboard', 'yellow', 'unverified', 'Read receipt')
        with patch.object(h, 'sports', return_value=f), patch.object(h, 'law', return_value=f), patch.object(h, 'collections', return_value=f), patch.object(h, 'dashboard', return_value=f), patch.object(h, 'write_outbox') as writer, patch.object(h, 'get_json') as network:
            result = h.run(write=False)
        writer.assert_not_called()
        network.assert_not_called()
        self.assertEqual(result['findings'], [h.asdict(f)] * 4)
        self.assertEqual(len(result['incidents']), 4)
        self.assertIn('checked_at', result)
