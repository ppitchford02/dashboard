import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
import build
import pathlib
import news

HERE = Path(__file__).resolve().parent.parent

RSS = b'''<rss><channel><item><title>A &amp; B</title><link>https://example.com/a</link><pubDate>Thu, 10 Sep 2026 10:00:00 GMT</pubDate></item><item><title>Unsafe</title><link>javascript:alert(1)</link><pubDate>Thu, 10 Sep 2026 11:00:00 GMT</pubDate></item></channel></rss>'''

class DashboardTests(unittest.TestCase):
    def test_feed_keeps_safe_dated_links(self):
        rows = news.parse_feed(RSS, 'Publisher')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['title'], 'A & B')
        rendered = news.render_feed({'items':rows,'edition':'2026-09-10','fetched_at':'2026-09-10T06:00'}, '2026-09-10')
        self.assertIn('A &amp; B', rendered)
        self.assertNotIn('javascript:', rendered)

    def test_daily_rollover_retry_and_last_good_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)/'news.json'
            with patch.object(news, 'CACHE', cache), patch.object(news, 'fetch_feed', return_value=news.parse_feed(RSS,'Publisher')) as fetch:
                first, edition = news.load_news(datetime(2026,9,10,6,7))
                self.assertEqual(fetch.call_count,5)
                news.load_news(datetime(2026,9,11,5,59))
                self.assertEqual(fetch.call_count,5)
                fetch.side_effect = OSError('offline')
                failed, next_edition = news.load_news(datetime(2026,9,11,6,7))
                self.assertEqual(first,failed)
                self.assertIn('Previous edition',news.render_feed(failed['ai'],next_edition))
                fetch.side_effect = None
                refreshed,_ = news.load_news(datetime(2026,9,11,6,22))
                self.assertEqual(refreshed['ai']['edition'],'2026-09-11')
                self.assertEqual(fetch.call_count,15)

    def test_check_does_not_write_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)/'news.json'
            with patch.object(news,'CACHE',cache), patch.object(news,'fetch_feed',return_value=news.parse_feed(RSS,'Publisher')):
                news.load_news(datetime(2026,9,10,6,7),write=False)
                self.assertFalse(cache.exists())

    def test_schedule_expiry_and_escaping(self):
        deadlines=[{'due':'2026-09-10T10:00','title':'Expired'}, {'due':'2026-09-10T12:00','title':'<script>alert(1)</script>'}]
        result,_,_ = build.schedule_block(deadlines,datetime(2026,9,10,10,0,1))
        self.assertNotIn('Expired',result)
        self.assertNotIn('<script>',result)
        self.assertIn('&lt;script&gt;',result)

    def test_render_preserves_literal_tokens_and_blocks_script_breakout(self):
        with tempfile.TemporaryDirectory() as directory:
            config = json.loads(build.DATA.read_text())
            config['deadlines']=[{'due':'2099-01-01T12:00','title':'</script><script>alert(1)</script> {{NEWS}}'}]
            config['attention']=[]
            data=Path(directory)/'data.json';data.write_text(json.dumps(config))
            out=Path(directory)/'index.html'
            with patch.object(build,'DATA',data), patch.object(build,'OUT',out), patch.object(build,'weather_blocks',return_value=('Weather unavailable','','')), patch.object(build,'news_block',return_value='NEWS_CONTENT'), patch('sys.argv',['build.py']):
                build.main()
            rendered=out.read_text()
            script=rendered.split('<script>',1)[1]
            self.assertNotIn('</script><script>alert',script)
            self.assertIn('\\u003c/script>',script)
            self.assertIn('{{NEWS}}',script)
            self.assertNotIn('Course load',rendered)
            self.assertNotIn('Last run',rendered)


class PreviewIsSeparateFromThePublishedArtifact(unittest.TestCase):
    """GitHub Pages serves the workflow's own build. A laptop preview must never be
    mistakable for it, and must not touch the artifacts the workflow owns."""
    def test_preview_writes_only_to_preview_and_leaves_index_and_news_alone(self):
        import tempfile, pathlib
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            data = root/'data.json'; data.write_text(build.DATA.read_text())
            out = root/'index.html'; out.write_text('SENTINEL')
            prev = root/'preview'/'index.html'
            with patch.object(build,'DATA',data), patch.object(build,'OUT',out), \
                 patch.object(build,'PREVIEW',prev), \
                 patch.object(build,'weather_blocks',return_value=('Weather unavailable','','')), \
                 patch.object(build,'news_block',return_value='NEWS_CONTENT') as news, \
                 patch('sys.argv',['build.py','--preview']):
                build.main()
            self.assertTrue(prev.exists(), 'the preview is written')
            self.assertEqual(out.read_text(), 'SENTINEL', 'the published artifact is untouched')
            self.assertFalse(news.call_args.kwargs['write'], 'a preview never rewrites news.json')

    def test_deploy_never_stages_the_workflow_owned_artifacts(self):
        text = (pathlib.Path(build.HERE)/'deploy.sh').read_text()
        self.assertIn("':(exclude)index.html'", text)
        self.assertIn("':(exclude)news.json'", text)
        self.assertNotIn('git add index.html', text)
        self.assertIn('git rev-parse HEAD', text)   # the verify step pins the published commit

if __name__=='__main__': unittest.main()

class PrivateRosterTests(unittest.TestCase):
    """The roster is a deployment secret. These tests read no secret file: they check
    that nothing shaped like a creator account reaches the repository or the page."""

    HOSTS = ["instagram.com", "tiktok.com", "discord.com/channels", "x.com/", "twitter.com/"]

    # This file necessarily names the hosts it forbids, so it is the one exclusion.
    SELF = "tests/test_dashboard.py"

    def tracked_files(self):
        listed = subprocess.run(["git", "ls-files"], cwd=HERE, capture_output=True, text=True)
        self.assertEqual(listed.returncode, 0, listed.stderr)
        return [name for name in listed.stdout.split() if (HERE / name).is_file()]

    def build_preview(self):
        built = subprocess.run([sys.executable, str(HERE / "build.py"), "--preview"], cwd=HERE, capture_output=True, text=True)
        self.assertEqual(built.returncode, 0, built.stderr)
        return (HERE / "preview" / "index.html").read_text(encoding="utf-8")

    def test_no_source_host_reaches_the_built_page(self):
        page = self.build_preview()
        for host in self.HOSTS:
            self.assertNotIn(host, page, f"{host} is inlined in the built page")
        # The tab and its lists stay public; only the roster is private.
        self.assertIn('id="view-picks"', page)
        self.assertIn('id="picks-clean-list"', page)
        self.assertIn('id="picks-leans-list"', page)

    def test_no_tracked_file_carries_a_creator_account(self):
        leaked = []
        for name in self.tracked_files():
            if name == self.SELF:
                continue
            try:
                text = (HERE / name).read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for host in self.HOSTS:
                if host in text:
                    leaked.append(f"{name}: {host}")
        self.assertEqual(leaked, [], "creator account links are committed to this repository")

    def test_the_worker_carries_no_roster_of_its_own(self):
        worker = (HERE / "worker.js").read_text(encoding="utf-8")
        self.assertIn("env.PICKS_ROSTER", worker)
        self.assertNotIn("PICK_ROSTER = [{", worker.replace(" ", ""))
        for host in self.HOSTS:
            self.assertNotIn(host, worker)

    def test_the_secret_file_is_ignored_and_never_tracked(self):
        # Checked by path, so this passes whether or not the local file is present.
        ignored = subprocess.run(["git", "check-ignore", "picks-roster.json"], cwd=HERE, capture_output=True, text=True)
        self.assertEqual(ignored.returncode, 0, "picks-roster.json must be gitignored")
        self.assertNotIn("picks-roster.json", self.tracked_files())

    def test_the_roster_fixture_is_synthetic(self):
        roster = json.loads((HERE / "tests" / "fixtures" / "roster.json").read_text(encoding="utf-8"))
        self.assertTrue(roster)
        for creator in roster:
            self.assertTrue(creator["accounts"])
            for account in creator["accounts"]:
                self.assertTrue(account["url"].startswith("https://example.com/"), account["url"])
