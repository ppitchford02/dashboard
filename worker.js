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
 *   PICKS_DB            D1 database, private Sports Picks records
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
    // Picks authenticate independently and never enter the assistant/GitHub path.
    if (new URL(request.url).pathname === "/picks") return handlePicksRequest(request, env);
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return json({ ok: true, version: "daily-desk-1", actions: true }, 200, origin);
    }

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
    const action = body.action;

    if (!question && !action) return json({ error: "empty question" }, 400, origin);
    if (question.length > MAX_QUESTION) return json({ error: "too long" }, 400, origin);

    if (!env.DASH_PASSPHRASE || pass !== env.DASH_PASSPHRASE) {
      return json({ error: "unauthorized" }, 401, origin);
    }

    // ---- spend caps ----------------------------------------------------
    const capErr = await enforceCaps(request, env);
    if (capErr) return json({ error: capErr.msg }, capErr.status, origin);

    // ---- current dashboard data ---------------------------------------
    const gh = new Repo(env);
    if (action) {
      try {
        return json(await runDashboardAction(action, gh), 200, origin);
      } catch (error) {
        const known = error instanceof ActionError;
        return json({ error: known ? error.message : "Could not save the change. Refresh and retry.", changed: false }, known ? error.status : 502, origin);
      }
    }
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
      return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0,16) === value;
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
    const saved = await r.json();
    return { commit_url: saved.commit?.html_url || null, commit_sha: saved.commit?.sha || null };
  }
}

class ActionError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

function sameItem(a, b) { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }

function validateAttention(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new ActionError("Choose an attention item.");
  if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 160) throw new ActionError("Use a title between 1 and 160 characters.");
  if (typeof item.body !== "string" || item.body.length > 2000) throw new ActionError("Keep the details under 2,000 characters.");
  if (item.when !== undefined && (typeof item.when !== "string" || item.when.length > 200)) throw new ActionError("Invalid time label.");
  if (item.level !== undefined && !["low", "med", "high"].includes(item.level)) throw new ActionError("Invalid attention level.");
  if (item.id !== undefined && (typeof item.id !== "string" || item.id.length > 80)) throw new ActionError("Invalid item identifier.");
  if (item.related_deadlines !== undefined && (!Array.isArray(item.related_deadlines) || item.related_deadlines.length > 20 || item.related_deadlines.some(x => typeof x !== "string" || x.length > 200))) throw new ActionError("Invalid linked deadlines.");
  if (item.due !== undefined && (typeof item.due !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(item.due) || isNaN(Date.parse(item.due)))) throw new ActionError("Invalid due date.");
  const allowed = new Set(["id", "title", "body", "when", "level", "related_deadlines", "due"]);
  if (Object.keys(item).some(key => !allowed.has(key))) throw new ActionError("Unsupported attention item fields.");
}

export async function runDashboardAction(action, gh) {
  if (!action || typeof action !== "object" || Array.isArray(action) || !["add_attention", "complete_attention", "restore_attention"].includes(action.name)) throw new ActionError("Unsupported dashboard action.");
  validateAttention(action.item);
  const file = await gh.read("data.json");
  const data = file.data;
  if (!Array.isArray(data.attention)) throw new ActionError("Attention data needs repair before editing.", 409);
  let undo, message;
  if (action.name === "add_attention") {
    if (data.attention.some(x => String(x.title).trim().toLowerCase() === action.item.title.trim().toLowerCase())) throw new ActionError("An item with that title already exists.", 409);
    const item = { id: crypto.randomUUID(), title: action.item.title.trim(), body: action.item.body.trim(), when: action.item.when || "", level: action.item.level || "low" };
    if (action.item.related_deadlines) item.related_deadlines = action.item.related_deadlines;
    if (action.item.due) item.due = action.item.due;
    data.attention.unshift(item);
    undo = { name: "complete_attention", item };
    message = `Added “${item.title}” to the dashboard.`;
  } else if (action.name === "complete_attention") {
    const index = data.attention.findIndex(x => sameItem(x, action.item));
    if (index < 0) throw new ActionError("This item changed or was already cleared. Refresh before trying again.", 409);
    const [item] = data.attention.splice(index, 1);
    undo = { name: "restore_attention", item, index };
    message = `Cleared “${item.title}”.`;
  } else {
    if (!Number.isInteger(action.index) || action.index < 0) throw new ActionError("Invalid restore position.");
    if (data.attention.some(x => sameItem(x, action.item) || (action.item.id && x.id === action.item.id) || x.title === action.item.title)) throw new ActionError("An item with that title already exists. Refresh to see it.", 409);
    const item = structuredClone(action.item);
    data.attention.splice(Math.min(action.index, data.attention.length), 0, item);
    undo = { name: "complete_attention", item };
    message = `Restored “${item.title}”.`;
  }
  const saved = await gh.write("data.json", data, file.sha, message);
  return { ok: true, changed: true, message, undo, attention: data.attention, commit_url: saved?.commit_url || null };
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

// --------------------------------------------------------------- private picks

const PICKS_ORIGIN = "https://ppitchford02.github.io";
const PICKS_OWNER = "dashboard-owner";
const PICK_SOURCES = new Set(["sbd", "bat", "stunad", "danny", "nick", "cru"]);
const PICK_MARKETS = new Set(["Home run", "Moneyline", "Spread", "Total", "Player prop", "Other"]);
const PICK_STATUSES = new Set(["pending", "review", "win", "loss", "push", "void"]);
const PICK_RESULTS = new Set(["win", "loss", "push", "void"]);
const CHECK_STATUSES = new Set(["Checked", "No new posts", "Sign-in needed", "Access blocked", "Needs review"]);
const PICK_ACTIONS = new Set(["read", "save", "check", "edit", "settle", "archive", "import"]);

class PickError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function picksHeaders() {
  return {
    "content-type": "application/json",
    "Cache-Control": "private, no-store",
    "Access-Control-Allow-Origin": PICKS_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  };
}

function picksReply(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: picksHeaders() });
}

function pickObject(value, label = "entry") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PickError(`Invalid ${label}.`);
  return value;
}

function pickText(value, label, max, min = 0) {
  if (typeof value !== "string") throw new PickError(`Enter ${label}.`);
  const text = value.trim();
  if (text.length < min || text.length > max) throw new PickError(`Keep ${label} between ${min} and ${max.toLocaleString("en-US")} characters.`);
  return text;
}

function pickChoice(value, choices, label) {
  if (!choices.has(value)) throw new PickError(`Choose ${label}.`);
  return value;
}

function pickBoolean(value, label) {
  if (typeof value !== "boolean") throw new PickError(`Confirm ${label}.`);
  return value;
}

function pickId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(value)) throw new PickError("Invalid record identifier.");
  return value;
}

function pickRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new PickError("Refresh to load the current record version.");
  return value;
}

function pickDate(value) {
  if (value === "") return value;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PickError("Enter a valid event date.");
  const date = new Date(value + "T12:00:00Z");
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new PickError("Enter a valid event date.");
  return value;
}

function pickTime(value, label, optional = false) {
  if (optional && value === "") return value;
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value) || Number.isNaN(Date.parse(value))) throw new PickError(`Enter a valid ${label}.`);
  pickDate(value.slice(0, 10));
  return value;
}

function pickUrl(value) {
  const text = pickText(value, "link", 2000);
  if (!text) return text;
  let url;
  try { url = new URL(text); } catch { throw new PickError("Use a complete https:// link."); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || /[\u0000-\u001f\u007f]/.test(text)) throw new PickError("Use a complete https:// link without embedded credentials.");
  return text;
}

export function validatePickInput(input) {
  const value = pickObject(input, "pick");
  const pick = {
    sourceId: pickChoice(value.sourceId, PICK_SOURCES, "a configured source"),
    sport: pickChoice(value.sport, new Set(["MLB", "NFL"]), "MLB or NFL"),
    market: pickChoice(value.market, PICK_MARKETS, "a market"),
    selection: pickText(value.selection, "selection", 500),
    event: pickText(value.event, "event", 500),
    eventDate: pickDate(value.eventDate),
    odds: value.odds,
    postedAt: pickTime(value.postedAt, "post time", true),
    sourceUrl: pickUrl(value.sourceUrl),
    originalText: pickText(value.originalText, "original post text or transcript", 15000, 1),
    capturedBeforeStart: pickBoolean(value.capturedBeforeStart, "whether this was captured before the event"),
  };
  if (pick.odds !== null && (!Number.isInteger(pick.odds) || Math.abs(pick.odds) < 100 || Math.abs(pick.odds) > 100000)) throw new PickError("American odds must be +100 or greater, or -100 or lower, up to 100,000.");
  if (pick.market === "Home run" && pick.sport !== "MLB") throw new PickError("Home-run picks must use MLB.");
  return pick;
}

export function validateSettlementInput(input) {
  const value = pickObject(input, "result");
  const result = {
    status: pickChoice(value.status, PICK_STATUSES, "a result"),
    resultEvidence: pickText(value.resultEvidence, "result evidence", 4000),
    resultUrl: pickUrl(value.resultUrl),
  };
  if (PICK_RESULTS.has(result.status) && !result.resultEvidence) throw new PickError("Add a result note or source before settling.");
  return result;
}

function pickComplete(pick) { return !!(pick.selection && pick.event && pick.eventDate); }

function validateStoredPick(input) {
  const value = pickObject(input, "imported pick"), base = validatePickInput(value);
  const settlement = validateSettlementInput(value);
  if (PICK_RESULTS.has(settlement.status) && !pickComplete(base)) throw new PickError("Confirm selection, event, and event date before importing a settled result.");
  const result = {
    ...base, id: pickId(value.id), ...settlement,
    createdAt: pickTime(value.createdAt, "creation time"),
    updatedAt: pickTime(value.updatedAt, "update time"),
    archived: pickBoolean(value.archived, "archive state"),
    revision: pickRevision(value.revision),
  };
  if (Date.parse(result.updatedAt) < Date.parse(result.createdAt)) throw new PickError("Update time cannot precede creation time.");
  return result;
}

export function pickIdentityText(value) {
  let link = value.sourceUrl;
  if (link) { const url = new URL(link); url.hash = ""; url.search = ""; link = url.toString(); }
  return JSON.stringify([value.sourceId, link || value.originalText.trim().toLowerCase(), value.selection.trim().toLowerCase(), value.eventDate, value.event.trim().toLowerCase(), value.market, value.sport]);
}

async function pickFingerprint(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pickIdentityText(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function pickFromRow(row) {
  return { ...JSON.parse(row.data), archived: !!row.archived, revision: Number(row.revision) };
}

function originalPickMatches(a, b) {
  return a.sourceId === b.sourceId && a.sourceUrl === b.sourceUrl && a.originalText === b.originalText;
}

function checkedResult(result) {
  if (!result || result.success === false) throw new Error("PICKS_DATABASE_OPERATION_FAILED");
  return result;
}

function validateSourceCheck(input, importing = false) {
  const value = pickObject(input, "source check");
  return {
    id: importing ? pickId(value.id) : crypto.randomUUID(),
    sourceId: pickChoice(value.sourceId, PICK_SOURCES, "a configured source"),
    status: pickChoice(value.status, CHECK_STATUSES, "a source-check status"),
    note: pickText(value.note, "source-check note", 2000, 1),
    checkedAt: importing ? pickTime(value.checkedAt, "check time") : new Date().toISOString(),
  };
}

function insertPick(db, pick, fingerprint, originalFingerprint) {
  return db.prepare("INSERT INTO picks(id,owner,source_id,fingerprint,original_fingerprint,data,archived,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(pick.id, PICKS_OWNER, pick.sourceId, fingerprint, originalFingerprint, JSON.stringify(pick), Number(pick.archived), pick.revision, pick.createdAt, pick.updatedAt);
}

function insertCheck(db, check) {
  return db.prepare("INSERT INTO source_checks(id,owner,source_id,status,note,checked_at) VALUES(?,?,?,?,?,?)")
    .bind(check.id, PICKS_OWNER, check.sourceId, check.status, check.note, check.checkedAt);
}

async function importPicks(db, body) {
  const desk = pickObject(body.desk, "desk import");
  for (const [key, max] of [["picks", 100], ["checks", 100], ["revisions", 300]]) {
    if (!Array.isArray(desk[key]) || desk[key].length > max) throw new PickError(`Import at most ${max} ${key} per request.`);
  }
  const picks = desk.picks.map(validateStoredPick), checks = desk.checks.map(value => validateSourceCheck(value, true));
  const known = new Map(picks.map(pick => [pick.id, pick]));
  if (known.size !== picks.length) throw new PickError("The import contains duplicate pick identifiers.");
  const revisions = desk.revisions.map(raw => {
    const value = pickObject(raw, "revision");
    let snapshot;
    try { snapshot = typeof value.snapshot === "string" ? JSON.parse(value.snapshot) : value.snapshot; }
    catch { throw new PickError("A revision snapshot is invalid."); }
    const normalized = validateStoredPick(snapshot), id = pickId(value.pickId);
    if (normalized.id !== id) throw new PickError("A revision belongs to a different pick.");
    return { id: pickId(value.id), pickId: id, reason: pickText(value.reason, "revision reason", 4000, 1), snapshot: normalized, changedAt: pickTime(value.changedAt, "revision time") };
  });
  for (const revision of revisions) {
    let current = known.get(revision.pickId);
    if (!current) {
      const row = await db.prepare("SELECT * FROM picks WHERE id=? AND owner=?").bind(revision.pickId, PICKS_OWNER).first();
      if (!row) throw new PickError("Import the pick together with its revision history.");
      current = pickFromRow(row); known.set(current.id, current);
    }
    if (revision.snapshot.revision >= current.revision || !originalPickMatches(revision.snapshot, current)) throw new PickError("Revision history does not match the pick's version or original evidence.");
  }
  const statements = [], imported = { picks: 0, checks: 0, revisions: 0 }, skipped = { picks: 0, checks: 0, revisions: 0 };
  for (let index = 0; index < picks.length; index++) {
    const pick = picks[index], fingerprint = await pickFingerprint(pick);
    const first = revisions.find(revision => revision.pickId === pick.id && revision.snapshot.revision === 1)?.snapshot;
    const supplied = desk.picks[index].originalFingerprint;
    if (supplied !== undefined && (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied))) throw new PickError("Invalid original fingerprint.");
    if (pick.revision > 1 && !first && !supplied) throw new PickError("Include the first revision snapshot or originalFingerprint for a previously edited pick.");
    const derived = first ? await pickFingerprint(first) : pick.revision === 1 ? fingerprint : null;
    if (supplied && derived && supplied !== derived) throw new PickError("The original fingerprint does not match the original record.");
    const originalFingerprint = derived || supplied;
    const row = await db.prepare("SELECT * FROM picks WHERE id=? AND owner=?").bind(pick.id, PICKS_OWNER).first();
    if (row) {
      if (!sameItem(pickFromRow(row), pick) || row.original_fingerprint !== originalFingerprint) throw new PickError("An imported pick already exists with different content. Existing records were kept.", 409);
      skipped.picks++; continue;
    }
    statements.push(insertPick(db, pick, fingerprint, originalFingerprint)); imported.picks++;
  }
  for (const check of checks) {
    const row = await db.prepare("SELECT * FROM source_checks WHERE id=? AND owner=?").bind(check.id, PICKS_OWNER).first();
    if (row) {
      const existing = { id: row.id, sourceId: row.source_id, status: row.status, note: row.note, checkedAt: row.checked_at };
      if (!sameItem(existing, check)) throw new PickError("An imported source check already exists with different content.", 409);
      skipped.checks++; continue;
    }
    statements.push(insertCheck(db, check)); imported.checks++;
  }
  for (const revision of revisions) {
    const row = await db.prepare("SELECT * FROM pick_revisions WHERE id=? AND owner=?").bind(revision.id, PICKS_OWNER).first();
    if (row) {
      const existing = { id: row.id, pickId: row.pick_id, reason: row.reason, snapshot: JSON.parse(row.snapshot), changedAt: row.changed_at };
      if (!sameItem(existing, revision)) throw new PickError("An imported revision already exists with different content.", 409);
      skipped.revisions++; continue;
    }
    statements.push(db.prepare("INSERT INTO pick_revisions(id,owner,pick_id,reason,snapshot,changed_at) VALUES(?,?,?,?,?,?)")
      .bind(revision.id, PICKS_OWNER, revision.pickId, revision.reason, JSON.stringify(revision.snapshot), revision.changedAt));
    imported.revisions++;
  }
  if (statements.length) (await db.batch(statements)).forEach(checkedResult);
  return picksReply({ saved: true, imported, skipped });
}

async function runPicksAction(body, db) {
  const action = pickChoice(body.action, PICK_ACTIONS, "a supported picks action");
  if (action === "read") {
    const [picks, checks, revisions] = await Promise.all([
      db.prepare("SELECT * FROM picks WHERE owner=? ORDER BY created_at DESC, id DESC").bind(PICKS_OWNER).all(),
      db.prepare("SELECT * FROM source_checks WHERE owner=? ORDER BY checked_at DESC, id DESC LIMIT 60").bind(PICKS_OWNER).all(),
      db.prepare("SELECT * FROM pick_revisions WHERE owner=? ORDER BY changed_at DESC, id DESC LIMIT 300").bind(PICKS_OWNER).all(),
    ]);
    [picks, checks, revisions].forEach(checkedResult);
    return picksReply({
      picks: picks.results.map(pickFromRow),
      checks: checks.results.map(row => ({ id: row.id, sourceId: row.source_id, status: row.status, note: row.note, checkedAt: row.checked_at })),
      revisions: revisions.results.map(row => ({ id: row.id, pickId: row.pick_id, reason: row.reason, snapshot: row.snapshot, changedAt: row.changed_at })),
    });
  }
  if (action === "import") return importPicks(db, body);
  const now = new Date().toISOString();
  if (action === "save") {
    const value = validatePickInput(body.pick), fingerprint = await pickFingerprint(value);
    const duplicate = await db.prepare("SELECT id FROM picks WHERE owner=? AND (fingerprint=? OR original_fingerprint=?)").bind(PICKS_OWNER, fingerprint, fingerprint).first();
    if (duplicate) return picksReply({ error: "This pick is already in your desk.", duplicateId: duplicate.id }, 409);
    const pick = { ...value, id: crypto.randomUUID(), status: pickComplete(value) ? "pending" : "review", resultEvidence: "", resultUrl: "", createdAt: now, updatedAt: now, archived: false, revision: 1 };
    checkedResult(await insertPick(db, pick, fingerprint, fingerprint).run());
    return picksReply({ pick }, 201);
  }
  if (action === "check") {
    const check = validateSourceCheck(body);
    checkedResult(await insertCheck(db, check).run());
    return picksReply({ saved: true, check });
  }
  const id = pickId(body.id), revision = pickRevision(body.revision);
  const row = await db.prepare("SELECT * FROM picks WHERE id=? AND owner=?").bind(id, PICKS_OWNER).first();
  if (!row) throw new PickError("That pick was not found.", 404);
  const previous = pickFromRow(row);
  if (previous.revision !== revision) throw new PickError("This pick changed in another session. Refresh before editing.", 409);
  let next = { ...previous, updatedAt: now, revision: revision + 1 }, reason, fingerprint = row.fingerprint;
  if (action === "settle") {
    const value = validateSettlementInput(body);
    if (PICK_RESULTS.has(value.status) && !pickComplete(previous)) throw new PickError("Confirm the exact selection, event, and event date before adding a result.");
    next = { ...next, ...value };
    reason = `Result set to ${value.status}: ${value.resultEvidence || "Reopened for review"}`;
  } else if (action === "edit") {
    const value = validatePickInput(body.pick);
    reason = pickText(body.reason, "correction reason", 2000, 3);
    if (!originalPickMatches(value, previous)) throw new PickError("Original evidence stays unchanged. Archive this entry and capture a new source if needed.");
    next = { ...next, ...value, status: pickComplete(value) ? "pending" : "review", resultEvidence: "", resultUrl: "" };
    fingerprint = await pickFingerprint(value);
    const duplicate = await db.prepare("SELECT id FROM picks WHERE owner=? AND (fingerprint=? OR original_fingerprint=?) AND id<>?").bind(PICKS_OWNER, fingerprint, fingerprint, id).first();
    if (duplicate) throw new PickError("This correction matches another saved pick.", 409);
  } else if (action === "archive") {
    next.archived = pickBoolean(body.archived, "archive state");
    reason = next.archived ? "Archived from active record" : "Restored to active record";
  }
  // D1 batch is transactional. The revision snapshot is written only when this
  // exact version was updated; an insert failure rolls the update back as well.
  const results = await db.batch([
    db.prepare("UPDATE picks SET data=?,archived=?,revision=?,fingerprint=?,updated_at=? WHERE id=? AND owner=? AND revision=?")
      .bind(JSON.stringify(next), Number(next.archived), next.revision, fingerprint, now, id, PICKS_OWNER, revision),
    db.prepare("INSERT INTO pick_revisions(id,owner,pick_id,reason,snapshot,changed_at) SELECT ?,?,?,?,?,? WHERE changes()=1")
      .bind(crypto.randomUUID(), PICKS_OWNER, id, reason, JSON.stringify(previous), now),
  ]);
  results.forEach(checkedResult);
  if (Number(results[0]?.meta?.changes) !== 1) throw new PickError("This pick changed in another session. Refresh before editing.", 409);
  return picksReply({ pick: next });
}

export async function handlePicksRequest(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: picksHeaders() });
  if (request.method !== "POST") return picksReply({ error: "POST only" }, 405);
  try {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return picksReply({ error: "Send JSON data." }, 415);
    if (Number(request.headers.get("content-length") || 0) > 2000000) return picksReply({ error: "Split this import into smaller requests." }, 413);
    const raw = await request.text();
    if (raw.length > 2000000) return picksReply({ error: "Split this import into smaller requests." }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return picksReply({ error: "Invalid request." }, 400); }
    pickObject(body, "request");
    if (typeof body.pass !== "string" || !env.DASH_PASSPHRASE || body.pass !== env.DASH_PASSPHRASE) return picksReply({ error: "Unlock Sports Picks with your dashboard passphrase." }, 401);
    const origin = request.headers.get("origin");
    if (origin && origin !== PICKS_ORIGIN) return picksReply({ error: "Open Sports Picks from your dashboard." }, 403);
    if (body.action !== "import" && raw.length > 25000) return picksReply({ error: "Keep each request under 25,000 characters." }, 413);
    if (!env.PICKS_DB) throw new Error("PICKS_DATABASE_UNAVAILABLE");
    return await runPicksAction(body, env.PICKS_DB);
  } catch (error) {
    if (error instanceof PickError) return picksReply({ error: error.message }, error.status);
    if (/UNIQUE constraint|duplicate pick fingerprint/i.test(String(error))) return picksReply({ error: "This record is already in your desk or matches another pick. Refresh before retrying." }, 409);
    return picksReply({ error: "Your picks are temporarily unavailable. Your input has been kept; please retry." }, 503);
  }
}
