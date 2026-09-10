"""Daily publisher headlines. Standard library only; no browser RSS proxy or API key."""
import html
import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlparse

CACHE = Path(__file__).with_name('news.json')
FEEDS = {
    'ai': ('AI', 'TechCrunch', 'https://techcrunch.com/category/artificial-intelligence/feed/'),
    'akron': ('Akron, Ohio', 'Signal Akron', 'https://signalakron.org/feed/'),
    **{league: (league.upper(), 'ESPN', f'https://www.espn.com/espn/rss/{league}/news') for league in ('nfl', 'nba', 'mlb')},
}

def parse_feed(raw, source):
    root = ET.fromstring(raw)
    items, seen = [], set()
    for item in root.findall('./channel/item'):
        title = (item.findtext('title') or '').strip()
        link = (item.findtext('link') or '').strip()
        if not title or urlparse(link).scheme not in ('http', 'https') or not urlparse(link).netloc or link in seen:
            continue
        try:
            published = parsedate_to_datetime(item.findtext('pubDate') or '')
            if published.tzinfo is None:
                published = published.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
        items.append(dict(title=title, url=link, source=source, published=published.isoformat()))
        seen.add(link)
    items.sort(key=lambda i: i['published'], reverse=True)
    if not items:
        raise ValueError('Feed contains no dated headlines')
    return items[:3]

def fetch_feed(key):
    _, source, url = FEEDS[key]
    req = urllib.request.Request(url, headers={'User-Agent': 'PitchfordOS/1.0 RSS reader'})
    with urllib.request.urlopen(req, timeout=12) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError('Feed too large')
    return parse_feed(raw, source)

def load_news(now, write=True):
    try:
        cache = json.loads(CACHE.read_text())
        if not isinstance(cache, dict): cache = {}
    except (OSError, ValueError):
        cache = {}
    # Keep the previous edition before 06:00 local; refresh on the first build after it.
    edition = (now - timedelta(hours=6)).date().isoformat()
    keys = [k for k in FEEDS if not isinstance(cache.get(k), dict) or cache[k].get('edition') != edition]
    def refresh(key):
        try:
            return key, {'edition': edition, 'fetched_at': now.isoformat(), 'items': fetch_feed(key)}
        except Exception as exc:
            print(f'  news {key}: keeping previous edition ({type(exc).__name__})', file=sys.stderr)
            return key, None
    with ThreadPoolExecutor(max_workers=5) as pool:
        for key, result in pool.map(refresh, keys):
            if result: cache[key] = result
    if write:
        temporary = CACHE.with_suffix('.tmp')
        temporary.write_text(json.dumps(cache, ensure_ascii=False, indent=2)+'\n')
        temporary.replace(CACHE)
    return cache, edition

def render_feed(entry, edition):
    esc = lambda s: html.escape(str(s), quote=True)
    if not entry or not entry.get('items'):
        return '<p class="note">Headlines temporarily unavailable. We’ll retry on the next refresh.</p>'
    stamp = entry.get('fetched_at', '')
    try: stamp = datetime.fromisoformat(stamp).strftime('%b %d · %H:%M')
    except ValueError: stamp = 'Unknown'
    prefix = 'Updated ' if entry.get('edition') == edition else 'Previous edition · '
    out = [f'<p class="edition">{prefix}{esc(stamp)}</p>']
    for item in entry['items']:
        if urlparse(item.get('url','')).scheme not in ('http','https'): continue
        pub = datetime.fromisoformat(item['published']).strftime('%b %d')
        out.append(f'<article class="story"><a href="{esc(item["url"])}" target="_blank" rel="noopener noreferrer">{esc(item["title"])}</a><small>{esc(item["source"])} · {esc(pub)}</small></article>')
    return ''.join(out)

def news_block(now, write=True):
    cache, edition = load_news(now, write)
    out = []
    for key in ('ai','akron'):
        out.append(f'<section class="news-card"><h3>{FEEDS[key][0]}</h3>{render_feed(cache.get(key),edition)}</section>')
    sports = '<section class="news-card"><h3>Sports</h3><div class="leagues" aria-label="Sports league">'
    for key in ('nfl','nba','mlb'):
        active = key == 'nfl'
        sports += f'<button class="league{" sel" if active else ""}" data-league="{key}" aria-pressed="{str(active).lower()}" onclick="pickLeague(\'{key}\')">{key.upper()}</button>'
    sports += '</div>'
    for key in ('nfl','nba','mlb'):
        sports += f'<div data-news-league="{key}"{ " hidden" if key != "nfl" else ""}>{render_feed(cache.get(key),edition)}</div>'
    return ''.join(out)+sports+'</section>'
