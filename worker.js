/**
 * PITCHFORD OS — ask endpoint, v2
 *
 * Sits between the public dashboard and the Anthropic API so no key ever
 * touches the browser. Answers from the dashboard data, can search the web,
 * and can edit data.json in the repo when told to, which triggers a rebuild.
 *
 * Secrets (Settings → Variables and secrets, type Secret):
 *   ANTHROPIC_API_KEY   Anthropic key
 *   DASH_PASSPHRASE     the phrase the page asks for
 *   GITHUB_TOKEN        fine-grained token, Contents: read+write, this repo only
 *
 * Plain variables:
 *   ALLOWED_ORIGIN      https://ppitchford02.github.io   (no trailing slash)
 *   GITHUB_REPO         ppitchford02/dashboard
 *   GITHUB_BRANCH       main
 *
 * Bindings:
 *   LIMITS              KV namespace, for the spend caps
 */

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1600;
const DAILY_CAP = 60;       // messages per day, total
const BURST_CAP = 10;       // per IP per 10 minutes
const MAX_QUESTION = 2000;
const MAX_TOOL_ROUNDS = 5;
const WEB_SEARCH_MAX_USES = 3;

// --------------------------------------------------------------- tools

const TOOLS = [
  {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: WEB_SEARCH_MAX_USES,
  },
  {
    name: "add_deadline",
    description:
      "Add a deadline or class session to the dashboard schedule. Use when Preston " +
      "asks to add, schedule, or remind him about something with a date and time.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title, e.g. 'Civ Pro memo'" },
        due: {
          type: "string",
          description: "Local date-time as YYYY-MM-DDTHH:MM, e.g. 2026-09-12T23:59",
        },
        end: { type: "string", description: "Optional end time, same format, for classes" },
        points: { type: "integer", description: "Points, if graded. Omit if unknown." },
        course: { type: "string", description: "Course code, e.g. LAWX 730" },
        note: { type: "string", description: "One short line shown under the title" },
        kind: { type: "string", enum: ["deadline", "class"] },
      },
      required: ["title", "due"],
    },
  },
  {
    name: "remove_deadline",
    description:
      "Remove a deadline from the schedule by matching its title. Use when something " +
      "is done, cancelled, or was added by mistake.",
    input_schema: {
      type: "object",
      properties: {
        title_contains: {
          type: "string",
          description: "Case-insensitive fragment of the title to remove",
        },
      },
      required: ["title_contains"],
    },
  },
  {
    name: "add_attention",
    description:
      "Add an item to the Needs Attention panel. For things that need Preston's action " +
      "but aren't a single dated deadline.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "One or two sentences" },
        when: { type: "string", description: "Short tag like 'WED 23:59 · LAWX 730'" },
        level: { type: "string", enum: ["high", "med", "low"] },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "remove_attention",
    description: "Remove a Needs Attention item by title fragment.",
    input_schema: {
      type: "object",
      properties: { title_contains: { type: "string" } },
      required: ["title_contains"],
    },
  },
  {
    name: "set_agent_status",
    description: "Update an agent's status in the Workforce panel.",
    input_schema: {
      type: "object",
      properties: {
        name_contains: { type: "string" },
        status: { type: "string", enum: ["on", "build", "off"] },
        schedule: { type: "string", description: "Optional new schedule text" },
      },
      required: ["name_contains", "status"],
    },
  },
];

// --------------------------------------------------------------- entry

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad request" }, 400, origin);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad request" }, 400, origin);
    const question = String(body.question || "").trim();
    const pass = String(body.pass || "");
    const history = Array.isArray(body.history) ? body.history.slice(-10) : [];

    if (!question) return json({ error: "empty question" }, 400, origin);
    if (question.length > MAX_QUESTION) return json({ error: "too long" }, 400, origin);

    if (!env.DASH_PASSPHRASE || pass !== env.DASH_PASSPHRASE) {
      return json({ error: "unauthorized" }, 401, origin);
    }

    // ---- spend caps ----------------------------------------------------
    const capErr = await enforceCaps(request, env);
    if (capErr) return json({ error: capErr.msg }, capErr.status, origin);

    // ---- current dashboard data ---------------------------------------
    const gh = new Repo(env);
    let dashFile = null;
    try {
      dashFile = await gh.read("data.json");
    } catch (e) {
      console.log("data.json read failed", String(e));
    }
    const dash = dashFile ? dashFile.data : null;
    const tz = (dash && dash.timezone) || "America/New_York";

    const now = new Date();
    const nowLocal = now.toLocaleString("en-US", {
      timeZone: tz, dateStyle: "full", timeStyle: "short",
    });
    const todayIso = now.toLocaleDateString("en-CA", { timeZone: tz });

    const system = buildSystem(nowLocal, todayIso, tz, dash);

    // ---- conversation -------------------------------------------------
    const messages = [];
    for (const m of history) {
      if (m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
        messages.push({ role: m.role, content: m.content.slice(0, 4000) });
      }
    }
    messages.push({ role: "user", content: question });

    // ---- tool loop ----------------------------------------------------
    let changed = false;
    let finalText = "";
    let usage = null;
    let useWebSearch = env.DISABLE_WEB_SEARCH !== "1";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const tools = useWebSearch ? TOOLS : TOOLS.filter((t) => t.name !== "web_search");

      let resp;
      try { resp = await callModel(env, { system, messages, tools }); }
      catch { return json({ error: 'Assistant request failed. Please retry.', changed }, 502, origin); }

      // If web search is the problem (unsupported / disabled), retry once without it
      if (!resp.ok && resp.status === 400 && useWebSearch) {
        console.log("retrying without web search", resp.detail.slice(0, 200));
        useWebSearch = false;
        try {
          resp = await callModel(env, { system, messages, tools: TOOLS.filter((t) => t.name !== "web_search") });
        } catch { return json({ error: 'Assistant request failed. Please retry.', changed }, 502, origin); }
      }
      if (!resp.ok) {
        console.log("anthropic error", resp.status, resp.detail.slice(0, 300));
        return json({ error: `model error ${resp.status}`, changed }, 502, origin);
      }

      const out = resp.data;
      usage = out.usage || usage;

      const textBlocks = (out.content || []).filter((b) => b.type === "text");
      const toolCalls = (out.content || []).filter((b) => b.type === "tool_use");

      if (out.stop_reason !== "tool_use" || toolCalls.length === 0) {
        finalText = textBlocks.map((b) => b.text).join("\n").trim();
        break;
      }

      // execute our own tools; web_search is handled server-side by the API
      messages.push({ role: "assistant", content: out.content });
      const results = [];
      for (const call of toolCalls) {
        let result;
        try {
          result = await runTool(call.name, call.input, gh);
          if (result.changed) changed = true;
        } catch (e) {
          result = { ok: false, error: String(e).slice(0, 300) };
        }
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: "user", content: results });
    }

    if (!finalText) finalText = changed ? "Done." : "(no answer)";

    return json({ answer: finalText, changed, usage }, 200, origin);
  },
};

// --------------------------------------------------------------- system

function buildSystem(nowLocal, todayIso, tz, dash) {
  return [
    "You are the assistant built into PITCHFORD OS, Preston's personal dashboard.",
    `Right now it is ${nowLocal} (${tz}). Today's date in ISO form is ${todayIso}.`,
    "",
    "Preston is a first-year part-time law student at the University of Akron and a",
    "law clerk at his father's firm. He is direct and wants direct answers.",
    "",
    "WHAT YOU CAN SEE: the dashboard data below (deadlines, courses, agents,",
    "attention items). Answer from it when the question is about his day, school,",
    "schedule, or agents. Do the arithmetic yourself: days remaining, points open,",
    "what is next. Never invent a deadline, grade, time, or point total.",
    "",
    "WHAT YOU CAN DO: search the web for anything outside the data (news, law,",
    "weather elsewhere, how something works). And edit the dashboard with the tools:",
    "add or remove deadlines, add or remove attention items, update agent status.",
    "When he tells you to add, schedule, remove, clear, or mark something, DO IT",
    "with a tool rather than describing how he could. Convert natural dates to",
    "YYYY-MM-DDTHH:MM using today's date; 'Friday' means the coming Friday; a",
    "deadline with no time given is 23:59; a class with no time is 18:30 to 20:00.",
    "After a tool succeeds, confirm in one short sentence what changed and note",
    "the page will update within a couple of minutes.",
    "",
    "If asked to remove something and several items match, ask which one rather",
    "than guessing. If a tool fails, say so plainly.",
    "",
    "STYLE: short, plain paragraphs. No bullet points, no bold, no headers, no",
    "pleasantries, no 'great question'. If you don't know, say so.",
    "",
    "Client and firm matters are deliberately kept off this dashboard. If asked",
    "about work files, say they are kept off this page on purpose.",
    "",
    "DASHBOARD DATA:",
    dash ? JSON.stringify(dash, null, 1) : "(could not load data.json this request)",
  ].join("\n");
}

// --------------------------------------------------------------- model

async function callModel(env, { system, messages, tools }) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: env.ANTHROPIC_MODEL || MODEL, max_tokens: MAX_TOKENS, system, messages, tools }),
  });
  if (!r.ok) return { ok: false, status: r.status, detail: await r.text() };
  return { ok: true, data: await r.json() };
}

// --------------------------------------------------------------- tools impl

export async function runTool(name, input, gh) {
  if (!input || typeof input !== 'object') throw new Error('Missing tool input');
  const requireText = (key) => {
    if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`Missing ${key}`);
  };
  if (['add_deadline', 'add_attention'].includes(name)) requireText('title');
  if (name === 'add_attention') {
    requireText('body');
    if (input.level && !['high','med','low'].includes(input.level)) throw new Error('Invalid attention level');
  }
  if (name === 'add_deadline') {
    const validDate = (value) => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
      const dt = new Date(value + 'Z');
      return !isNaN(dt) && dt.toISOString().slice(0,16) === value;
    };
    if (!validDate(input.due)) throw new Error('Invalid due date; use YYYY-MM-DDTHH:MM');
    if (input.end && (!validDate(input.end) || input.end <= input.due)) throw new Error('End must be after start');
    if (input.points !== undefined && (!Number.isInteger(input.points) || input.points < 0)) throw new Error('Invalid points');
  }
  if (name.startsWith('remove_')) requireText('title_contains');
  if (name === 'set_agent_status') {
    requireText('name_contains');
    if (!['on','build','off'].includes(input.status)) throw new Error('Invalid agent status');
  }
  const uniqueMatch = (items, key, query) => {
    const matches = items.filter(x => String(x[key]).toLowerCase().includes(query.trim().toLowerCase()));
    if (matches.length > 1) throw new Error('Several items match. Ask which one before changing anything.');
    return matches[0];
  };
  const mutate = async (fn) => {
    const file = await gh.read("data.json");
    const d = file.data;
    const msg = fn(d);
    if (!msg) return { ok: false, error: "nothing matched" };
    await gh.write("data.json", d, file.sha, msg);
    return { ok: true, changed: true, message: msg };
  };

  switch (name) {
    case "add_deadline":
      return mutate((d) => {
        d.deadlines = d.deadlines || [];
        const item = {
          title: input.title,
          due: input.due,
          kind: input.kind || "deadline",
        };
        if (input.end) item.end = input.end;
        if (Number.isInteger(input.points)) item.points = input.points;
        if (input.course) item.course = input.course;
        item.note = input.note || [
          Number.isInteger(input.points) ? `${input.points} pts` : null,
          input.course || null,
        ].filter(Boolean).join(" · ");
        d.deadlines.push(item);
        d.deadlines.sort((a, b) => (a.due < b.due ? -1 : 1));
        return `Add deadline: ${input.title} (${input.due})`;
      });

    case "remove_deadline":
      return mutate((d) => {
        const hit = uniqueMatch(d.deadlines || [], 'title', input.title_contains);
        if (!hit) return null;
        d.deadlines = d.deadlines.filter(x => x !== hit);
        return `Remove deadline: ${hit.title}`;
      });

    case "add_attention":
      return mutate((d) => {
        d.attention = d.attention || [];
        d.attention.unshift({
          title: input.title,
          body: input.body,
          when: input.when || "",
          level: input.level || "med",
        });
        return `Add attention: ${input.title}`;
      });

    case "remove_attention":
      return mutate((d) => {
        const hit = uniqueMatch(d.attention || [], 'title', input.title_contains);
        if (!hit) return null;
        d.attention = d.attention.filter(x => x !== hit);
        return `Remove attention: ${hit.title}`;
      });

    case "set_agent_status":
      return mutate((d) => {
        const hit = uniqueMatch(d.agents || [], 'name', input.name_contains);
        if (!hit) return null;
        hit.status = input.status;
        if (input.schedule) hit.schedule = input.schedule;
        return `Update agent: ${hit.name}`;
      });

    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

// --------------------------------------------------------------- github

class Repo {
  constructor(env) {
    this.token = env.GITHUB_TOKEN;
    this.repo = env.GITHUB_REPO || "ppitchford02/dashboard";
    this.branch = env.GITHUB_BRANCH || "main";
  }
  headers() {
    return {
      "authorization": `Bearer ${this.token}`,
      "accept": "application/vnd.github+json",
      "user-agent": "pitchford-os-worker",
      "x-github-api-version": "2022-11-28",
    };
  }
  async read(path) {
    const url = `https://api.github.com/repos/${this.repo}/contents/${path}?ref=${encodeURIComponent(this.branch)}`;
    const r = await fetch(url, { headers: this.headers() });
    if (!r.ok) throw new Error(`github read ${r.status}`);
    const j = await r.json();
    const text = decodeB64(j.content);
    return { sha: j.sha, data: JSON.parse(text) };
  }
  async write(path, data, sha, message) {
    const url = `https://api.github.com/repos/${this.repo}/contents/${path}`;
    const content = encodeB64(JSON.stringify(data, null, 2) + "\n");
    const r = await fetch(url, {
      method: "PUT",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ message, content, sha, branch: this.branch }),
    });
    if (!r.ok) throw new Error(`github write ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return true;
  }
}

function decodeB64(s) {
  const bin = atob(String(s).replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function encodeB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// --------------------------------------------------------------- caps

async function enforceCaps(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  const burstKey = `burst:${ip}:${Math.floor(Date.now() / 600000)}`;
  const dayKey = `day:${today}`;
  try {
    const [b, d] = await Promise.all([env.LIMITS.get(burstKey), env.LIMITS.get(dayKey)]);
    const burst = Number(b || 0), day = Number(d || 0);
    if (burst >= BURST_CAP) return { status: 429, msg: "slow down, try again in a few minutes" };
    if (day >= DAILY_CAP) return { status: 429, msg: `daily cap of ${DAILY_CAP} reached` };
    await Promise.all([
      env.LIMITS.put(burstKey, String(burst + 1), { expirationTtl: 900 }),
      env.LIMITS.put(dayKey, String(day + 1), { expirationTtl: 172800 }),
    ]);
    return null;
  } catch {
    return { status: 503, msg: "rate limiter unavailable" };
  }
}

// --------------------------------------------------------------- utils

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
