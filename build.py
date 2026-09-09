#!/usr/bin/env python3
"""
build.py - renders index.html from data.json + live weather.

Standard library only. No pip install needed.

    python3 build.py            # writes index.html
    python3 build.py --check    # render to stdout, write nothing
"""

import json
import sys
import html
import math
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
    return html.escape(str(s), quote=False)


def parse_dt(s):
    """Parse 'YYYY-MM-DDTHH:MM' local naive."""
    return datetime.strptime(s, "%Y-%m-%dT%H:%M")


def fmt_time(dt):
    h = dt.strftime("%H:%M")
    return h


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
        now_s = f"{fb['now_f']}\u00b0F {fb['condition']}"
        badge = f"{fb['now_f']}\u00b0 \u00b7 {fb['condition']}"
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
            f'<span class="meta">{esc(a["schedule"])}</span></div>'
        )
    return "\n".join(out)


def course_rows(courses):
    return "\n".join(
        f'        <div class="row"><span class="name">{esc(c["name"])}</span>'
        f'<span class="meta">{esc(c["meta"])}</span></div>'
        for c in courses
    )


def last_run_rows(runs):
    if not runs:
        return '        <p class="note">No runs recorded yet.</p>'
    return "\n".join(
        f'        <div class="row"><span class="name">{esc(r["name"])}</span>'
        f'<span class="meta">{esc(r["at"])}</span></div>'
        for r in runs
    )


def attention_items(items):
    if not items:
        return ('      <div class="body"><p class="note">Nothing is waiting on you '
                'right now.</p></div>')
    out = []
    for it in items:
        lvl = it.get("level", "low")
        bar = "" if lvl == "high" else f" {lvl}"
        out.append(
            f'      <div class="att">\n'
            f'        <span class="bar{bar}"></span>\n'
            f'        <div>\n'
            f'          <p class="ttl">{esc(it["title"])}</p>\n'
            f'          <p>{esc(it["body"])}</p>\n'
            f'          <span class="when">{esc(it.get("when",""))}</span>\n'
            f'        </div>\n'
            f'      </div>'
        )
    return "\n".join(out)


def schedule_block(deadlines, now):
    """Group upcoming items by day. Past items are dropped."""
    future = [d for d in deadlines if parse_dt(d["due"]) >= now.replace(second=0, microsecond=0)]
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
        right = tag or (f"{pts} PTS DUE" if pts else "CLASS NIGHT")
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


def terrain_svg(deadlines, now):
    """Draw today's committed time as a hill. Axis runs 06:00 to 24:00."""
    W, H, BASE, PEAK = 640, 130, 102, 26
    today = now.date()
    pts = []
    for d in deadlines:
        dt = parse_dt(d["due"])
        if dt.date() == today:
            pts.append(dt)
    if not pts:
        path = f'M0 {BASE} L{W} {BASE}'
        dots = ''
        return (f'        <svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" '
                f'role="img" aria-label="Nothing committed today.">\n'
                f'          <path d="{path}" fill="none" stroke="#C9BFA6" '
                f'stroke-width="1.5" stroke-linecap="round"/>\n        </svg>')

    def x_of(dt):
        h = dt.hour + dt.minute / 60
        h = max(6.0, min(24.0, h))
        return (h - 6) / 18 * W

    centre = sum(x_of(p) for p in pts) / len(pts)
    centre = max(W * 0.14, min(W * 0.86, centre))  # keep the peak in frame
    spread = max(70, W * 0.14)

    def y_of(x):
        return BASE - (BASE - PEAK) * math.exp(-((x - centre) ** 2) / (2 * spread ** 2))

    step = 8
    coords = [(x, y_of(x)) for x in range(0, W + step, step)]
    path = "M" + " L".join(f"{x} {y:.1f}" for x, y in coords)

    dots = []
    for p in sorted(pts):
        x = x_of(p)
        dots.append(f'          <circle cx="{x:.0f}" cy="{y_of(x):.1f}" r="5.5" fill="#A8842C"/>')
    nx = x_of(now)
    dots.append(f'          <line x1="{nx:.0f}" y1="14" x2="{nx:.0f}" y2="{BASE + 12}" '
                f'stroke="#96341F" stroke-width="1" stroke-dasharray="2 4" opacity=".7"/>')

    return (f'        <svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" '
            f'role="img" aria-label="Today\'s committed time, drawn as terrain.">\n'
            f'          <path d="{path}" fill="none" stroke="#16274A" stroke-width="1.8" '
            f'stroke-linecap="round" opacity=".9"/>\n'
            + "\n".join(dots) + "\n        </svg>")


def acts_block(deadlines, now):
    today = now.date()
    buckets = {"MORNING": [], "AFTERNOON": [], "EVENING": []}
    for d in deadlines:
        dt = parse_dt(d["due"])
        if dt.date() != today:
            continue
        if dt.hour < 12:
            buckets["MORNING"].append(dt)
        elif dt.hour < 17:
            buckets["AFTERNOON"].append(dt)
        else:
            buckets["EVENING"].append(dt)

    out = []
    for label, items in buckets.items():
        if not items:
            txt = "Nothing committed."
        elif len(items) == 1:
            txt = f"One item, at {fmt_time(items[0])}."
        else:
            txt = (f"{len(items)} items, {fmt_time(min(items))} "
                   f"to {fmt_time(max(items))}.")
        out.append(f'        <div class="act"><span class="t">{label}</span>{txt}</div>')
    return "\n".join(out)


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

    # dial arc reflects how much of the day is gone
    frac = min(1.0, max(0.0, (now.hour * 60 + now.minute) / (24 * 60)))
    circ = 2 * math.pi * 52
    dash = f"{circ * frac:.0f} {circ * (1 - frac):.0f}"

    repl = {
        "{{TOPBAR_DATE}}": now.strftime("%a %d %b %Y").upper(),
        "{{TOPBAR_TIME}}": now.strftime("%H:%M"),
        "{{LOC}}": cfg["location"]["name"].upper(),
        "{{WX_NOW}}": wx_now,
        "{{WX_BADGE}}": wx_badge,
        "{{WX_ROWS}}": wx_rows.rstrip("\n"),
        "{{COUNTDOWN}}": sch_badge,
        "{{COUNTDOWN_CLASS}}": sch_cls,
        "{{ATT_COUNT}}": str(len(att)),
        "{{ATT_BADGE_CLASS}}": "hot" if any(a.get("level") == "high" for a in att) else "warn",
        "{{AGENTS_ONLINE}}": f"{online}/{total}",
        "{{AGENTS_ONLINE_LONG}}": f"{online} ONLINE",
        "{{LIVE_COUNT}}": "9",
        "{{PEND_COUNT}}": str(len(cfg["pending"])),
        "{{AGENT_ROWS}}": agent_rows(cfg["agents"]),
        "{{PTS_OPEN}}": f"{future_pts} PTS OPEN" if future_pts else "CLEAR",
        "{{COURSE_ROWS}}": course_rows(cfg["courses"]),
        "{{DIAL_DASH}}": dash,
        "{{GREETING}}": greeting(now, cfg["name"], deadlines),
        "{{SUBLINE}}": subline(deadlines, now),
        "{{DAY_BADGE}}": (f"{len(today_items)} TODAY" if today_items else "CLEAR"),
        "{{TERRAIN}}": terrain_svg(deadlines, now),
        "{{ACTS}}": acts_block(deadlines, now),
        "{{ATT_ITEMS}}": attention_items(att),
        "{{SCHEDULE}}": sched,
        "{{SCH_BADGE}}": sch_badge,
        "{{SCH_BADGE_CLASS}}": sch_cls,
        "{{INBOX_NOTE}}": esc(cfg.get("inbox_note", "")),
        "{{LAST_RUNS}}": last_run_rows(cfg.get("last_runs", [])),
        "{{LAST_RUN_AT}}": (cfg["last_runs"][0]["at"] if cfg.get("last_runs") else "\u2014"),
        "{{PENDING}}": pending_block(cfg["pending"]),
        "{{BUILT_AT}}": now.strftime("%d %b %Y %H:%M").upper(),
        "{{TZ}}": cfg.get("timezone", "America/New_York"),
        "{{NEXT_DUE_ISO}}": next_due_iso,
    }

    out = tpl
    for k, v in repl.items():
        out = out.replace(k, v)

    leftover = [t for t in ("{{",) if t in out]
    if leftover:
        import re
        names = set(re.findall(r"\{\{[A-Z_]+\}\}", out))
        print(f"  WARNING unfilled tokens: {', '.join(sorted(names))}", file=sys.stderr)

    if check:
        print(f"  ok, {len(out)} bytes (not written)")
        return

    OUT.write_text(out)
    print(f"  wrote {OUT} ({len(out)} bytes)")


if __name__ == "__main__":
    main()
