#!/usr/bin/env python3
"""
build.py - renders index.html from data.json + live weather.

Standard library only. No pip install needed.

    python3 build.py            # writes index.html
    python3 build.py --check    # render to stdout, write nothing
"""

import json
import re
from news import news_block
import sys
import html
import math
import os
import urllib.request
import urllib.error
from datetime import datetime, timedelta, date
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data.json"
TEMPLATE = HERE / "template.html"
OUT = HERE / "index.html"

WEATHER_TIMEOUT = 6  # seconds; falls back to data.json on failure


# ----------------------------------------------------------------- helpers

def esc(s):
    return html.escape(str(s), quote=True)


def parse_dt(s):
    """Parse 'YYYY-MM-DDTHH:MM' local naive."""
    return datetime.strptime(s, "%Y-%m-%dT%H:%M")


def fmt_time(dt):
    return dt.strftime("%I:%M %p").lstrip("0")


def display_times(text):
    """Format clock times in display labels without changing stored data."""
    return re.sub(
        r"\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[AP]M\b)",
        lambda m: fmt_time(datetime.strptime(m.group(0), "%H:%M")),
        str(text), flags=re.IGNORECASE,
    )


def day_label(d, today):
    delta = (d - today).days
    base = d.strftime("%a %d %b").upper()
    if delta == 0:
        return base, "TODAY"
    if delta == 1:
        return base, "TOMORROW"
    return base, ""


# ----------------------------------------------------------------- weather

def fetch_weather(lat, lon):
    """Open-Meteo, no API key. Returns dict or None."""
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat}&longitude={lon}"
        "&current=temperature_2m,weather_code"
        "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max"
        "&temperature_unit=fahrenheit&timezone=auto&forecast_days=4"
    )
    try:
        with urllib.request.urlopen(url, timeout=WEATHER_TIMEOUT) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        print(f"  weather: falling back ({e.__class__.__name__})", file=sys.stderr)
        return None


WMO = {
    0: "CLEAR", 1: "MOSTLY CLEAR", 2: "PARTLY CLOUDY", 3: "CLOUDY",
    45: "FOG", 48: "FOG", 51: "DRIZZLE", 53: "DRIZZLE", 55: "DRIZZLE",
    61: "RAIN", 63: "RAIN", 65: "HEAVY RAIN", 71: "SNOW", 73: "SNOW",
    75: "HEAVY SNOW", 80: "SHOWERS", 81: "SHOWERS", 82: "HEAVY SHOWERS",
    95: "THUNDERSTORM", 96: "THUNDERSTORM", 99: "THUNDERSTORM",
}


def weather_blocks(cfg, now):
    wx = fetch_weather(cfg["location"]["lat"], cfg["location"]["lon"])
    if not wx:
        fb = cfg["weather_fallback"]
        now_s = f"{fb['now_f']}\u00b0F {fb['condition']} · SAVED WEATHER"
        badge = f"{fb['now_f']}\u00b0 \u00b7 {fb['condition']} · SAVED WEATHER"
        rows = "".join(
            f'        <div class="row"><span class="name">{esc(d["label"])}</span>'
            f'<span class="meta">{esc(d["meta"])}</span></div>\n'
            for d in fb["days"]
        )
        return now_s, badge, rows

    cur = wx["current"]
    temp = round(cur["temperature_2m"])
    cond = WMO.get(cur.get("weather_code"), "")
    now_s = f"{temp}\u00b0F {cond}".strip()

    daily = wx["daily"]
    pop_today = daily["precipitation_probability_max"][0]
    badge = f"{temp}\u00b0 \u00b7 {pop_today}% RAIN"

    rows = []
    # tonight's low
    rows.append(("Tonight", f"LOW {round(daily['temperature_2m_min'][0])}"))
    for i in (1, 2):
        d = datetime.strptime(daily["time"][i], "%Y-%m-%d")
        rows.append((
            d.strftime("%a"),
            f"{round(daily['temperature_2m_max'][i])} \u00b7 "
            f"{daily['precipitation_probability_max'][i]}% RAIN",
        ))
    rows_html = "".join(
        f'        <div class="row"><span class="name">{esc(l)}</span>'
        f'<span class="meta">{esc(m)}</span></div>\n'
        for l, m in rows
    )
    return now_s, badge, rows_html


# ----------------------------------------------------------------- sections

def agent_rows(agents):
    out = []
    for a in agents:
        cls = {"on": "on", "build": "build"}.get(a.get("status", "off"), "off")
        out.append(
            f'        <div class="row"><span class="dot {cls}"></span>'
            f'<span class="name">{esc(a["name"])}</span>'
            f'<span class="meta">{esc(display_times(a["schedule"]))}</span></div>'
        )
    return "\n".join(out)


def attention_items(items):
    if not items:
        return ('      <div class="body"><p class="note">Nothing is waiting on you '
                'right now.</p></div>')
    out = []
    for it in items:
        lvl = it.get("level", "low")
        if lvl not in ("high", "med", "low"): lvl = "low"
        bar = "" if lvl == "high" else f" {lvl}"
        out.append(
            f'      <div class="att">\n'
            f'        <span class="bar{bar}"></span>\n'
            f'        <div>\n'
            f'          <p class="ttl">{esc(it["title"])}</p>\n'
            f'          <p>{esc(it["body"])}</p>\n'
            f'          <span class="when">{esc(display_times(it.get("when","")))}</span>\n'
            f'        </div>\n'
            f'      </div>'
        )
    return "\n".join(out)


def schedule_block(deadlines, now):
    """Group upcoming items by day. Past items are dropped."""
    future = [d for d in deadlines if parse_dt(d["due"]) >= now]
    future.sort(key=lambda d: d["due"])
    if not future:
        return '        <p class="note">Nothing scheduled ahead.</p>', "CLEAR", "mute"

    by_day = {}
    for d in future:
        k = parse_dt(d["due"]).date()
        by_day.setdefault(k, []).append(d)

    today = now.date()
    out = []
    for day in sorted(by_day)[:4]:
        items = by_day[day]
        base, tag = day_label(day, today)
        pts = sum(i.get("points", 0) for i in items)
        right = tag or (f"{pts} PTS DUE" if pts else "SCHEDULED")
        out.append(f'        <div class="daysep">{esc(base)}'
                   f'<span class="r">{esc(right)}</span></div>')
        for i in items:
            dt = parse_dt(i["due"])
            if i.get("end"):
                tm = f'{fmt_time(dt)}&ndash;{fmt_time(parse_dt(i["end"]))}'
            else:
                tm = fmt_time(dt)
            out.append(
                f'        <div class="sch"><span class="tm">{tm}</span>'
                f'<span class="ev">{esc(i["title"])}'
                f'<small>{esc(i.get("note",""))}</small></span></div>'
            )

    nxt = parse_dt(future[0]["due"])
    delta = nxt - now
    badge, cls = countdown(delta)
    return "\n".join(out), badge, cls


def countdown(delta):
    mins = int(delta.total_seconds() // 60)
    if mins < 0:
        return "NOW", "hot"
    if mins < 60:
        return f"{mins:02d} MIN", "hot"
    hours = mins / 60
    if hours < 24:
        return f"{int(hours)}H {mins % 60:02d}M", "warn"
    days = int(hours // 24)
    return f"{days}D {int(hours % 24)}H", ""


def pending_block(items):
    half = math.ceil(len(items) / 2)
    cols = [items[:half], items[half:]]
    out = []
    for col in cols:
        out.append('  <div class="col">')
        for p in col:
            badge_cls = "mute"
            out.append(
                f'    <div class="panel">\n'
                f'      <h2>{esc(p["title"]).upper()} '
                f'<span class="badge {badge_cls}">{esc(p["badge"])}</span></h2>\n'
                f'      <div class="body"><p class="note">{esc(p["summary"])}\n'
                f'        <span class="blocker">NEEDS &mdash; '
                f'{esc(p["needs"]).upper()}</span></p></div>\n'
                f'    </div>'
            )
        out.append('  </div>')
    return "\n".join(out)


def greeting(now, name, deadlines):
    h = now.hour
    if h < 12:
        part = "Good morning"
    elif h < 17:
        part = "Good afternoon"
    else:
        part = "Good evening"
    return f'{part}, <b>{esc(name)}</b>.'


def subline(deadlines, now):
    future = sorted((d for d in deadlines if parse_dt(d["due"]) >= now),
                    key=lambda d: d["due"])
    if not future:
        return "Nothing ahead on the calendar."
    nxt = future[0]
    dt = parse_dt(nxt["due"])
    delta = dt - now
    hrs = delta.total_seconds() / 3600
    if hrs < 1:
        when = f"in {int(delta.total_seconds() // 60)} minutes"
    elif hrs < 24:
        when = f"in {int(hrs)} hours"
    elif hrs < 48:
        when = "tomorrow"
    else:
        when = dt.strftime("on %A")
    return f'Next up: {esc(nxt["title"])}, {when}.'


# ----------------------------------------------------------------- main

def main():
    check = "--check" in sys.argv
    cfg = json.loads(DATA.read_text())
    tpl = TEMPLATE.read_text()

    # "now" in the dashboard's own timezone, wherever this runs.
    # GitHub's runners are UTC; without this, evenings roll into tomorrow.
    try:
        from zoneinfo import ZoneInfo
        now = datetime.now(ZoneInfo(cfg.get("timezone", "America/New_York"))).replace(tzinfo=None)
    except Exception:
        now = datetime.now()

    print("building dashboard...")

    deadlines = cfg["deadlines"]
    wx_now, wx_badge, wx_rows = weather_blocks(cfg, now)
    sched, sch_badge, sch_cls = schedule_block(deadlines, now)

    online = sum(1 for a in cfg["agents"] if a.get("status") == "on")
    total = len(cfg["agents"])

    future_pts = sum(d.get("points", 0) for d in deadlines
                     if parse_dt(d["due"]) >= now)
    today_items = [d for d in deadlines if parse_dt(d["due"]).date() == now.date()]

    att = cfg.get("attention", [])

    # next deadline, as an offset-aware ISO string for the live countdown
    upcoming = sorted((d for d in deadlines if parse_dt(d["due"]) >= now),
                      key=lambda d: d["due"])
    if upcoming:
        _dt = parse_dt(upcoming[0]["due"])
        try:
            from zoneinfo import ZoneInfo
            _tz = ZoneInfo(cfg.get("timezone", "America/New_York"))
            next_due_iso = _dt.replace(tzinfo=_tz).isoformat()
        except Exception:
            next_due_iso = _dt.isoformat()
    else:
        next_due_iso = ""

    def js(value):
        return json.dumps(value, ensure_ascii=True).replace('<', '\\u003c')

    from zoneinfo import ZoneInfo
    tz = ZoneInfo(cfg.get('timezone', 'America/New_York'))
    live_deadlines = [dict(d, due=parse_dt(d['due']).replace(tzinfo=tz).isoformat(),
                          end=parse_dt(d['end']).replace(tzinfo=tz).isoformat() if d.get('end') else None)
                      for d in sorted(deadlines, key=lambda d:d['due'])]
    dashboard = {key: cfg.get(key, []) for key in ('courses', 'agents', 'attention', 'pending')}
    dashboard.update(name=cfg['name'], timezone=cfg.get('timezone', 'America/New_York'),
                     deadlines=live_deadlines, inbox_note=cfg.get('inbox_note', ''),
                     built_at=now.replace(tzinfo=tz).isoformat(),
                     build_url=('https://github.com/ppitchford02/dashboard/actions/runs/' + os.environ['GITHUB_RUN_ID'])
                         if os.environ.get('GITHUB_RUN_ID') else '',
                     commit=os.environ.get('GITHUB_SHA', ''))
    repl = {
        "{{DASHBOARD_JSON}}": js(dashboard),
        "{{STYLES}}": (HERE / 'dashboard.css').read_text(),
        "{{CORE_JS}}": (HERE / 'dashboard-core.js').read_text(),
        "{{DASHBOARD_JS}}": (HERE / 'dashboard.js').read_text(),
        "{{PLANNER_JS}}": (HERE / "daily-planner.js").read_text(),
        "{{PICKS_JS}}": (HERE / 'picks.js').read_text(),
        "{{NEWS}}": news_block(now, write=not check),
        "{{TZ_JSON}}": js(cfg.get('timezone', 'America/New_York')),
        "{{ASK_ENDPOINT_JSON}}": js(cfg.get('ask_endpoint', '')),
        "{{DEADLINES_JSON}}": js(live_deadlines),
        "{{TOPBAR_DATE}}": now.strftime("%a %d %b %Y").upper(),
        "{{TOPBAR_TIME}}": fmt_time(now),
        "{{LOC}}": esc(cfg["location"]["name"].upper()),
        "{{WX_NOW}}": esc(wx_now),
        "{{WX_BADGE}}": esc(wx_badge),
        "{{WX_ROWS}}": wx_rows.rstrip("\n"),
        "{{COUNTDOWN}}": sch_badge,
        "{{COUNTDOWN_CLASS}}": sch_cls,
        "{{ATT_COUNT}}": str(len(att)),
        "{{ATT_BADGE_CLASS}}": "hot" if any(a.get("level") == "high" for a in att) else "warn",
        "{{AGENTS_ONLINE}}": f"{online}/{total}",
        "{{AGENTS_ONLINE_LONG}}": f"{online} ONLINE",
        "{{PEND_COUNT}}": str(len(cfg["pending"])),
        "{{AGENT_ROWS}}": agent_rows(cfg["agents"]),
        "{{GREETING}}": greeting(now, cfg["name"], deadlines),
        "{{SUBLINE}}": subline(deadlines, now),
        "{{ATT_ITEMS}}": attention_items(att),
        "{{SCHEDULE}}": sched,
        "{{SCH_BADGE}}": sch_badge,
        "{{SCH_BADGE_CLASS}}": sch_cls,
        "{{INBOX_NOTE}}": esc(cfg.get("inbox_note", "")),
        "{{PENDING}}": pending_block(cfg["pending"]),
        "{{BUILT_AT}}": now.strftime("%d %b %Y").upper() + " " + fmt_time(now),
        "{{TZ}}": cfg.get("timezone", "America/New_York"),
        "{{ASK_ENDPOINT}}": cfg.get("ask_endpoint", ""),
        "{{ASK_DISABLED}}": "" if cfg.get("ask_endpoint") else "disabled",
        "{{ASK_STATE}}": "Idle" if cfg.get("ask_endpoint") else "Offline",
        "{{NEXT_DUE_ISO}}": next_due_iso,
    }

    out = re.sub(r"\{\{[A-Z_]+\}\}", lambda m: repl[m.group(0)], tpl)

    if check:
        print(f"  ok, {len(out)} bytes (not written)")
        return

    OUT.write_text(out)
    print(f"  wrote {OUT} ({len(out)} bytes)")


if __name__ == "__main__":
    main()
