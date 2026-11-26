// Cloudflare Worker + D1: receives anonymous Memory map usage pings and serves a private dashboard.
// It accepts ONLY the fields listed below. Anything else is rejected, so note content can never be stored by accident.

export const FEATURES = ["home", "graph", "mindmap", "mindmap_view", "databases", "calendar", "roadmaps", "flashcards",
  "templates", "study", "daily", "search", "backup", "transfer", "import", "share", "publish_host", "attachments",
  "tasks", "clipper", "ai_agent", "ai_export"];
export const MILESTONES = ["vault_created", "first_note", "first_link", "backup_made", "shared_transfer",
  "published_local", "published_host"];
const PLATFORMS = ["windows", "macos", "linux", "ios", "android", "web"];
const LANGS = ["en", "uz", "ru", "tr", "es", "ar"];
const NOTE_BUCKETS = ["0", "1-9", "10-49", "50-199", "200+"];
const ALLOWED_KEYS = ["v", "install_id", "version", "platform", "lang", "notes", "linked", "features", "milestones", "ai_counts"];
const CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400"};

const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), {
  status, headers: {"Content-Type": "application/json", "Cache-Control": "no-store", ...extra}});

export function validatePing(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "invalid body";
  for (const key of Object.keys(data)) if (!ALLOWED_KEYS.includes(key)) return `unknown field: ${key}`;
  if (data.v !== 1) return "unsupported version";
  if (typeof data.install_id !== "string" || !/^[0-9a-f]{32}$/.test(data.install_id)) return "bad install_id";
  if (typeof data.version !== "string" || !/^[a-z0-9.\-]{1,16}$/.test(data.version)) return "bad version";
  if (!PLATFORMS.includes(data.platform)) return "bad platform";
  if (!LANGS.includes(data.lang)) return "bad lang";
  if (!NOTE_BUCKETS.includes(data.notes)) return "bad notes bucket";
  if (typeof data.linked !== "boolean") return "bad linked";
  for (const [key, allowed] of [["features", FEATURES], ["milestones", MILESTONES]]) {
    const list = data[key];
    if (!Array.isArray(list) || list.length > allowed.length || list.some(item => !allowed.includes(item))) return `bad ${key}`;
  }
  if (data.ai_counts !== undefined) {
    const counts = data.ai_counts;
    if (!counts || Object.keys(counts).sort().join(",") !== "approvals,requests"
        || ![counts.requests, counts.approvals].every(value => Number.isInteger(value) && value >= 0 && value <= 1000000)) {
      return "bad AI counts";
    }
  }
  return null;
}

const FEEDBACK_KEYS = ["v", "install_id", "kind", "message", "contact", "version", "platform", "lang", "screenshot"];
const FEEDBACK_KINDS = ["bug", "idea", "other"];
export const FEEDBACK_PER_DAY = 10;
const MAX_SCREENSHOT = 1_000_000;

function readScreenshot(value) {
  if (typeof value !== "string" || value.length > 1_333_365) return null;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  try {
    const [, type, encoded] = match;
    const bytes = atob(encoded);
    if (bytes.length > MAX_SCREENSHOT) return null;
    const valid = type === "image/png" ? bytes.startsWith("\x89PNG\r\n\x1a\n")
      : type === "image/jpeg" ? bytes.startsWith("\xff\xd8\xff")
      : bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
    return valid ? {type, bytes} : null;
  } catch {
    return null;
  }
}

export function validateFeedback(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "invalid body";
  for (const key of Object.keys(data)) if (!FEEDBACK_KEYS.includes(key)) return `unknown field: ${key}`;
  if (data.v !== 1) return "unsupported version";
  if (typeof data.install_id !== "string" || !/^[0-9a-f]{32}$/.test(data.install_id)) return "bad install_id";
  if (!FEEDBACK_KINDS.includes(data.kind)) return "bad kind";
  if (typeof data.message !== "string" || data.message.trim().length < 5 || data.message.length > 2000) return "bad message";
  if (data.contact !== undefined && (typeof data.contact !== "string" || data.contact.length > 120)) return "bad contact";
  if (data.screenshot !== undefined && !readScreenshot(data.screenshot)) return "bad screenshot";
  if (typeof data.version !== "string" || !/^[a-z0-9.\-]{1,16}$/.test(data.version)) return "bad version";
  if (!PLATFORMS.includes(data.platform)) return "bad platform";
  if (!LANGS.includes(data.lang)) return "bad lang";
  return null;
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function ingest(request, env) {
  const text = await request.text();
  if (text.length > 2048) return json({error: "too large"}, 413, CORS);
  let data;
  try { data = JSON.parse(text); } catch { return json({error: "invalid json"}, 400, CORS); }
  const problem = validatePing(data);
  if (problem) return json({error: problem}, 400, CORS);
  const day = today();
  const country = /^[A-Z]{2}$/.test(request.headers.get("CF-IPCountry") || "") ? request.headers.get("CF-IPCountry") : "";
  const statements = [
    env.DB.prepare("INSERT OR IGNORE INTO installs (install_id, first_seen, first_version, platform, country) VALUES (?, ?, ?, ?, ?)")
      .bind(data.install_id, day, data.version, data.platform, country),
    env.DB.prepare(`INSERT INTO pings (install_id, day, version, platform, lang, notes, linked, features) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(install_id, day) DO UPDATE SET version = excluded.version, platform = excluded.platform, lang = excluded.lang,
      notes = excluded.notes, linked = excluded.linked, features = excluded.features`)
      .bind(data.install_id, day, data.version, data.platform, data.lang, data.notes, data.linked ? 1 : 0, [...new Set(data.features)].join(",")),
    ...[...new Set(data.milestones)].map(name => env.DB.prepare(
      "INSERT OR IGNORE INTO milestones (install_id, name, day) VALUES (?, ?, ?)").bind(data.install_id, name, day)),
  ];
  if (data.ai_counts) {
    statements.push(env.DB.prepare(
      "INSERT INTO ai_counts VALUES (?, ?, ?, ?) ON CONFLICT (install_id, month) DO UPDATE SET requests=excluded.requests, approvals=excluded.approvals")
      .bind(data.install_id, day.slice(0, 7), data.ai_counts.requests, data.ai_counts.approvals));
  } else {
    statements.push(env.DB.prepare("DELETE FROM ai_counts WHERE install_id = ?").bind(data.install_id));
  }
  await env.DB.batch(statements);
  return json({ok: true}, 200, CORS);
}

async function feedback(request, env) {
  const limit = 1_350_000;
  if (Number(request.headers.get("Content-Length")) > limit) return json({error: "too large"}, 413, CORS);
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  if (reader) {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return json({error: "too large"}, 413, CORS);
      }
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
  }
  let data;
  try { data = JSON.parse(text); } catch { return json({error: "invalid json"}, 400, CORS); }
  const problem = validateFeedback(data);
  if (problem) return json({error: problem}, 400, CORS);
  const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE install_id = ? AND created >= ?")
    .bind(data.install_id, today()).first();
  if ((sent?.n || 0) >= FEEDBACK_PER_DAY) return json({error: "daily limit reached"}, 429, CORS);
  const columns = "created, install_id, kind, message, contact, version, platform, lang";
  const values = [new Date().toISOString(), data.install_id, data.kind, data.message.trim(), (data.contact || "").trim(),
    data.version, data.platform, data.lang];
  const suffix = data.screenshot ? ", ?" : "";
  if (data.screenshot) values.push(data.screenshot);
  await env.DB.prepare(`INSERT INTO feedback (${columns}${data.screenshot ? ", screenshot" : ""}) VALUES (?, ?, ?, ?, ?, ?, ?, ?${suffix})`)
    .bind(...values).run();
  return json({ok: true}, 200, CORS);
}

async function forget(request, env) {
  let data;
  try { data = await request.json(); } catch { return json({error: "invalid json"}, 400, CORS); }
  if (!data || typeof data.install_id !== "string" || !/^[0-9a-f]{32}$/.test(data.install_id)) return json({error: "bad install_id"}, 400, CORS);
  await env.DB.batch(["installs", "pings", "milestones", "feedback", "ai_counts"].map(table =>
    env.DB.prepare(`DELETE FROM ${table} WHERE install_id = ?`).bind(data.install_id)));
  return json({ok: true}, 200, CORS);
}

function authorized(request, env) {
  const given = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const expected = env.ADMIN_TOKEN || "";
  if (expected.length < 16 || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// Authorization lives in the identity project. Never trust email or role claims
// supplied by the app, and do not expose a shared admin credential to clients.
// Call the runtime fetch through its receiver; detached platform functions can throw.
export async function ownerAuthorized(request, env, fetcher = (...args) => globalThis.fetch(...args)) {
  const auth = request.headers.get("Authorization") || "";
  if (!/^Bearer [A-Za-z0-9_.-]{20,8192}$/.test(auth)
      || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(env.AUTH_URL || "")
      || !String(env.AUTH_KEY || "").startsWith("sb_publishable_")) return false;
  try {
    const response = await fetcher(env.AUTH_URL + "/rest/v1/rpc/owner_account_stats", {
      method: "POST", redirect: "error",
      headers: {Authorization: auth, apikey: env.AUTH_KEY, "Content-Type": "application/json"},
      body: "{}",
    });
    return response.ok && (await response.json()).owner === true;
  } catch {
    return false;
  }
}

const rows = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
const one = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).first()) || {};

export async function stats(env, days = 30) {
  days = Math.min(Math.max(Number(days) || 30, 1), 180);
  const since = daysAgo(days - 1), d7 = daysAgo(6), d30 = daysAgo(29), now = today();
  const active = async from => (await one(env, "SELECT COUNT(DISTINCT install_id) AS n FROM pings WHERE day >= ?", from)).n || 0;
  const latest = "(SELECT p.* FROM pings p JOIN (SELECT install_id, MAX(day) AS day FROM pings WHERE day >= ? GROUP BY install_id) m ON p.install_id = m.install_id AND p.day = m.day)";
  const split = async column => rows(env, `SELECT ${column} AS name, COUNT(*) AS installs FROM ${latest} GROUP BY ${column} ORDER BY installs DESC`, d30);
  const featureCounts = {};
  for (const row of await rows(env, `SELECT features FROM ${latest}`, d30)) {
    for (const name of row.features ? row.features.split(",") : []) featureCounts[name] = (featureCounts[name] || 0) + 1;
  }
  const returning = await one(env, `SELECT COUNT(*) AS total, SUM(CASE WHEN days >= 2 THEN 1 ELSE 0 END) AS returned
    FROM (SELECT i.install_id, (SELECT COUNT(DISTINCT day) FROM pings p WHERE p.install_id = i.install_id) AS days
          FROM installs i WHERE i.first_seen <= ?)`, daysAgo(7));
  return {
    generated: now,
    aiCounts: await one(env, "SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(approvals), 0) AS approvals FROM ai_counts WHERE month = ?", now.slice(0, 7)),
    installs: (await one(env, "SELECT COUNT(*) AS n FROM installs")).n || 0,
    feedbackCount: (await one(env, "SELECT COUNT(*) AS n FROM feedback")).n || 0,
    active: {today: await active(now), last7: await active(d7), last30: await active(d30)},
    newInstallsByDay: await rows(env, "SELECT first_seen AS day, COUNT(*) AS installs FROM installs WHERE first_seen >= ? GROUP BY first_seen ORDER BY day", since),
    activeByDay: await rows(env, "SELECT day, COUNT(DISTINCT install_id) AS active FROM pings WHERE day >= ? GROUP BY day ORDER BY day", since),
    platforms: await split("platform"), versions: await split("version"), languages: await split("lang"),
    noteSizes: await split("notes"),
    countries: await rows(env, "SELECT country AS name, COUNT(*) AS installs FROM installs WHERE country != '' GROUP BY country ORDER BY installs DESC LIMIT 20"),
    features: Object.entries(featureCounts).map(([name, installs]) => ({name, installs})).sort((a, b) => b.installs - a.installs),
    funnelCounts: await rows(env, "SELECT name, COUNT(*) AS installs FROM milestones GROUP BY name"),
    retention: {installsOlderThan7Days: returning.total || 0, cameBackAtLeastOnce: returning.returned || 0},
  };
}

const DASHBOARD = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Memory map stats</title>
<style>body{font:15px/1.5 system-ui;margin:0;background:#111;color:#eee}main{max-width:980px;margin:0 auto;padding:24px}
h1{margin:0 0 16px}h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:#9aa;margin:26px 0 8px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.card{background:#1b1b1d;border:1px solid #2c2c30;border-radius:10px;padding:12px}
.card b{display:block;font-size:1.7rem}.bar{display:flex;align-items:center;gap:8px;margin:3px 0}.bar i{display:block;height:10px;background:#8b7cf6;border-radius:3px}
.bar span{min-width:96px;color:#bbb}input,button{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid #333;background:#1b1b1d;color:#eee}</style>
<main><h1>Memory map stats</h1><form id="f"><input id="t" type="password" placeholder="Admin token" autocomplete="off"> <button>Open</button></form><div id="out"></div></main>
<script>
const out=document.getElementById('out'),el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e};
function bars(title,list,key='installs'){const h=el('h2','',title);const box=el('div');const max=Math.max(1,...list.map(r=>r[key]));
 for(const r of list){const row=el('div','bar');const bar=el('i');bar.style.width=Math.max(2,r[key]/max*320)+'px';row.append(el('span','',r.name||r.day),bar,el('b','',r[key]));box.append(row)}
 if(!list.length)box.append(el('span','','no data yet'));out.append(h,box)}
async function load(token){const r=await fetch('/admin/stats',{headers:{Authorization:'Bearer '+token}});if(!r.ok){out.textContent='Wrong token';return}
 const s=await r.json();out.replaceChildren();const cards=el('div','cards');
 for(const [k,v] of [['Installs',s.installs],['Active today',s.active.today],['Active 7 days',s.active.last7],['Active 30 days',s.active.last30],['AI requests this month',s.aiCounts.requests],['AI approvals this month',s.aiCounts.approvals],
  ['Came back (older than 7 days)',s.retention.installsOlderThan7Days?Math.round(100*s.retention.cameBackAtLeastOnce/s.retention.installsOlderThan7Days)+'%':'–']]){
  const c=el('div','card');c.append(el('b','',v),el('span','',k));cards.append(c)}
 out.append(cards);bars('Active per day',s.activeByDay,'active');bars('New installs per day',s.newInstallsByDay);
 bars('Platforms',s.platforms);bars('Versions',s.versions);bars('Languages',s.languages);bars('Countries',s.countries);
 bars('Notes per install',s.noteSizes);bars('Features used (30 days)',s.features);bars('Milestones reached',s.funnelCounts);
 const fr=await fetch('/admin/feedback',{headers:{Authorization:'Bearer '+token}});if(fr.ok){const f=await fr.json();out.append(el('h2','','Feedback ('+f.items.length+')'));
  for(const i of f.items){const b=el('div','card');b.append(el('b','',i.kind+' · '+i.version+' · '+i.platform+' · '+i.created.slice(0,10)),el('span','',i.message));if(i.contact)b.append(el('small','','contact: '+i.contact));
   if(i.hasScreenshot){const button=el('button','','Show screenshot');button.onclick=async()=>{
    button.disabled=true;
    try{const attachment=await fetch('/admin/feedback/'+i.id+'/screenshot',{headers:{Authorization:'Bearer '+token}});
     if(!attachment.ok)throw Error();const image=el('img');image.alt='Feedback screenshot';
     const src=URL.createObjectURL(await attachment.blob());image.onload=image.onerror=()=>URL.revokeObjectURL(src);
     image.style.cssText='display:block;max-width:100%;max-height:75vh';image.src=src;button.replaceWith(image)}
    catch{button.textContent='Retry screenshot';button.disabled=false}};b.append(button)}b.style.margin='8px 0';out.append(b)}}}
document.getElementById('f').onsubmit=e=>{e.preventDefault();sessionStorage.setItem('t',t.value);load(t.value)};
if(sessionStorage.getItem('t'))load(sessionStorage.getItem('t'));
</script>`;

export async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, {status: 204, headers: CORS});
  if (url.pathname === "/v1/ping" && request.method === "POST") return ingest(request, env);
  if (url.pathname === "/v1/forget" && request.method === "POST") return forget(request, env);
  if (url.pathname === "/v1/feedback" && request.method === "POST") return feedback(request, env);
  if (url.pathname === "/admin/feedback" && request.method === "GET") {
    if (!authorized(request, env)) return json({error: "unauthorized"}, 401);
    const fields = "id, created, kind, message, contact, version, platform, lang";
    return json({items: await rows(env, `SELECT ${fields}, screenshot IS NOT NULL AS hasScreenshot FROM feedback ORDER BY id DESC LIMIT 200`)});
  }
  const screenshot = /^\/admin\/feedback\/(\d+)\/screenshot$/.exec(url.pathname);
  if (screenshot && request.method === "GET") {
    if (!authorized(request, env)) return json({error: "unauthorized"}, 401);
    const item = await env.DB.prepare("SELECT screenshot FROM feedback WHERE id = ?").bind(screenshot[1]).first();
    const image = readScreenshot(item?.screenshot);
    if (!image) return json({error: "not found"}, 404);
    return new Response(Uint8Array.from(image.bytes, char => char.charCodeAt(0)), {headers: {
      "Content-Type": image.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    }});
  }
  if (url.pathname === "/admin" && request.method === "GET") {
    return new Response(DASHBOARD, {headers: {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'"}});
  }
  if (url.pathname === "/owner/stats" && request.method === "GET") {
    if (!await ownerAuthorized(request, env)) return json({error: "owner access required"}, 403);
    return json(await stats(env, url.searchParams.get("days")));
  }
  if (url.pathname === "/admin/stats" && request.method === "GET") {
    if (!authorized(request, env)) return json({error: "unauthorized"}, 401);
    return json(await stats(env, url.searchParams.get("days")));
  }
  return json({error: "not found"}, 404);
}

export default {fetch: (request, env) => handle(request, env)};
