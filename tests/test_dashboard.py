import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
import build
import news

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

if __name__=='__main__': unittest.main()
