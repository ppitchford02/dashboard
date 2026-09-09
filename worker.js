/**
 * PITCHFORD OS — ask endpoint
 *
 * Sits between the public dashboard and the Anthropic API so the API key
 * never touches the browser.
 *
 * Secrets (set in the Cloudflare dashboard, never in this file):
 *   ANTHROPIC_API_KEY   your Anthropic API key
 *   DASH_PASSPHRASE     the phrase the page asks you for
 *
 * Bindings:
 *   LIMITS              a KV namespace, used for the daily spend cap
 *
 * Vars (safe to keep here):
 *   ALLOWED_ORIGIN      the dashboard URL
 *   DATA_URL            raw data.json, so answers know today's page
 */

const MODEL = "claude-haiku-4-5-20251001"; // cheap. swap to claude-sonnet-5 for harder questions
const MAX_TOKENS = 900;
const DAILY_CAP = 50;      // messages per day, total
const BURST_CAP = 8;       // messages per IP per 10 minutes
const MAX_QUESTION = 1200; // characters

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";

    // ---- CORS preflight ----------------------------------------------
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, origin);
    }

    // ---- parse -------------------------------------------------------
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad request" }, 400, origin);
    }

    const question = String(body.question || "").trim();
    const pass = String(body.pass || "");
    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];

    if (!question) return json({ error: "empty question" }, 400, origin);
    if (question.length > MAX_QUESTION) {
      return json({ error: "question too long" }, 400, origin);
    }

    // ---- gate --------------------------------------------------------
    if (!env.DASH_PASSPHRASE || pass !== env.DASH_PASSPHRASE) {
      return json({ error: "unauthorized" }, 401, origin);
    }

    // ---- caps --------------------------------------------------------
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const today = new Date().toISOString().slice(0, 10);
    const burstKey = `burst:${ip}:${Math.floor(Date.now() / 600000)}`;
    const dayKey = `day:${today}`;

    try {
      const [burstRaw, dayRaw] = await Promise.all([
        env.LIMITS.get(burstKey),
        env.LIMITS.get(dayKey),
      ]);
      const burst = Number(burstRaw || 0);
      const day = Number(dayRaw || 0);

      if (burst >= BURST_CAP) {
        return json({ error: "slow down, try again in a few minutes" }, 429, origin);
      }
      if (day >= DAILY_CAP) {
        return json({ error: `daily cap of ${DAILY_CAP} reached` }, 429, origin);
      }

      await Promise.all([
        env.LIMITS.put(burstKey, String(burst + 1), { expirationTtl: 900 }),
        env.LIMITS.put(dayKey, String(day + 1), { expirationTtl: 172800 }),
      ]);
    } catch (e) {
      // never fail open on the money guard
      return json({ error: "rate limiter unavailable" }, 503, origin);
    }

    // ---- context -----------------------------------------------------
    let dash = null;
    if (env.DATA_URL) {
      try {
        const r = await fetch(env.DATA_URL, { cf: { cacheTtl: 120 } });
        if (r.ok) dash = await r.json();
      } catch {
        /* answer without it */
      }
    }

    const now = new Date().toLocaleString("en-US", {
      timeZone: (dash && dash.timezone) || "America/New_York",
      dateStyle: "full",
      timeStyle: "short",
    });

    const system = [
      "You are the assistant built into Preston's personal dashboard, PITCHFORD OS.",
      `The current date and time is ${now} (America/New_York).`,
      "",
      "Answer from the dashboard data below when the question is about his day,",
      "deadlines, courses, agents, or schedule. Do the arithmetic yourself —",
      "days remaining, points open, what is next — rather than telling him to",
      "look at the page he is already looking at.",
      "",
      "If the data does not cover the question, say so plainly and answer from",
      "general knowledge instead. Never invent a deadline, a grade, a time, or a",
      "point total that is not in the data.",
      "",
      "He is a part-time law student at Akron and a law clerk. Keep answers short",
      "and direct, plain paragraphs, no bullet points, no bold, no headers. Do not",
      "open with pleasantries.",
      "",
      "Client and firm matters are deliberately not on this dashboard. If asked",
      "about work files, say they are kept off this page on purpose.",
      "",
      "DASHBOARD DATA:",
      dash ? JSON.stringify(dash, null, 1) : "(unavailable this request)",
    ].join("\n");

    const messages = [];
    for (const m of history) {
      if (m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
        messages.push({ role: m.role, content: m.content.slice(0, 4000) });
      }
    }
    messages.push({ role: "user", content: question });

    // ---- call --------------------------------------------------------
    let out;
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages,
        }),
      });

      if (!r.ok) {
        const detail = await r.text();
        console.log("anthropic error", r.status, detail.slice(0, 300));
        return json({ error: `upstream error ${r.status}` }, 502, origin);
      }
      out = await r.json();
    } catch (e) {
      return json({ error: "could not reach the model" }, 502, origin);
    }

    const text = (out.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return json(
      { answer: text || "(empty response)", usage: out.usage || null },
      200,
      origin
    );
  },
};

// ---------------------------------------------------------------- utils

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors(origin) },
  });
}
