// Run: node --test stats-worker/worker.test.mjs   (uses Node's built-in SQLite in place of Cloudflare D1)
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {crc32} from "node:zlib";
import {handle, stats, validatePing, FEATURES, FEEDBACK_PER_DAY, ownerAccessStatus} from "./worker.js";

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  const prepare = sql => ({
    bind: (...args) => ({
      sql, args,
      run: async () => db.prepare(sql).run(...args),
      all: async () => ({results: db.prepare(sql).all(...args)}),
      first: async () => db.prepare(sql).get(...args) ?? null,
    }),
  });
  return {db, DB: {prepare, batch: async statements => { for (const s of statements) db.prepare(s.sql).run(...s.args); }}, ADMIN_TOKEN: "admin-token-0123456789"};
}
const ping = (extra = {}) => ({v: 1, install_id: "a".repeat(32), version: "v27", platform: "windows", lang: "uz", notes: "1-9",
  linked: true, features: ["graph", "share"], milestones: ["vault_created", "first_note"], ...extra});
const post = (path, body, headers = {}) => new Request("https://s.example" + path, {method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body)});

test("a valid ping is stored once per install per day and updates in place", async () => {
  const env = makeEnv();
  assert.equal((await handle(post("/v1/ping", ping(), {"CF-IPCountry": "UZ"}), env)).status, 200);
  assert.equal((await handle(post("/v1/ping", ping({notes: "10-49"})), env)).status, 200);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM pings").get().n, 1);
  assert.equal(env.db.prepare("SELECT notes FROM pings").get().notes, "10-49");
  assert.equal(env.db.prepare("SELECT country FROM installs").get().country, "UZ");
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM milestones").get().n, 2);
});

test("anything that could carry content is rejected", async () => {
  const env = makeEnv();
  for (const bad of [ping({title: "My secret diary"}), ping({features: ["note: my passwords"]}), ping({notes: "37"}),
      ping({install_id: "not-hex"}), ping({platform: "toaster"}), ping({milestones: ["x"]}), ping({v: 2}), []]) {
    assert.equal((await handle(post("/v1/ping", bad), env)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await handle(post("/v1/ping", "x".repeat(3000)), env)).status, 413);
  assert.equal((await handle(post("/v1/ping", "{nope"), env)).status, 400);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM pings").get().n, 0);
});

test("no column can hold text, ip or identity", () => {
  const env = makeEnv();
  const columns = env.db.prepare("SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name != 'feedback'").all();
  assert.deepEqual(columns.filter(c => /ip|email|title|body|text|name_|user/i.test(c.col) && c.col !== "name"), []);
});

test("forget deletes everything for that install", async () => {
  const env = makeEnv();
  await handle(post("/v1/ping", ping()), env);
  await handle(post("/v1/ping", ping({install_id: "b".repeat(32)})), env);
  assert.equal((await handle(post("/v1/forget", {install_id: "a".repeat(32)}), env)).status, 200);
  for (const table of ["installs", "pings", "milestones"]) {
    assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE install_id = ?`).get("a".repeat(32)).n, 0);
  }
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM installs").get().n, 1);
});

test("the dashboard needs the admin token and reports real numbers", async () => {
  const env = makeEnv();
  await handle(post("/v1/ping", ping()), env);
  await handle(post("/v1/ping", ping({install_id: "c".repeat(32), platform: "macos", features: ["graph"]})), env);
  const url = "https://s.example/admin/stats";
  assert.equal((await handle(new Request(url), env)).status, 401);
  assert.equal((await handle(new Request(url, {headers: {Authorization: "Bearer wrong-token-0123456789"}}), env)).status, 401);
  const res = await handle(new Request(url, {headers: {Authorization: "Bearer admin-token-0123456789"}}), env);
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.installs, 2);
  assert.equal(s.active.today, 2);
  assert.deepEqual(s.platforms.map(p => p.name).sort(), ["macos", "windows"]);
  assert.equal(s.features.find(f => f.name === "graph").installs, 2);
  assert.equal(s.funnelCounts.find(f => f.name === "first_note").installs, 2);
  env.ADMIN_TOKEN = "";
  assert.equal((await handle(new Request(url, {headers: {Authorization: "Bearer "}}), env)).status, 401);
});

test("browser preflight and the dashboard page are served", async () => {
  const env = makeEnv();
  assert.equal((await handle(new Request("https://s.example/v1/ping", {method: "OPTIONS"}), env)).status, 204);
  const page = await handle(new Request("https://s.example/admin"), env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(validatePing(ping()), null);
  assert.ok(FEATURES.includes("publish_host"));
});

const fb = (extra = {}) => ({v: 1, install_id: "a".repeat(32), kind: "bug", message: "The graph does not open on my phone", contact: "@someone",
  version: "v28", platform: "windows", lang: "uz", ...extra});

test("feedback is stored, listed for the admin only, rate limited and removed with the install", async () => {
  const env = makeEnv();
  assert.equal((await handle(post("/v1/feedback", fb()), env)).status, 200);
  const url = "https://s.example/admin/feedback";
  assert.equal((await handle(new Request(url), env)).status, 401);
  const list = await (await handle(new Request(url, {headers: {Authorization: "Bearer admin-token-0123456789"}}), env)).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].message, "The graph does not open on my phone");
  for (let i = 1; i < FEEDBACK_PER_DAY; i++) await handle(post("/v1/feedback", fb()), env);
  assert.equal((await handle(post("/v1/feedback", fb()), env)).status, 429);
  await handle(post("/v1/forget", {install_id: "a".repeat(32)}), env);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM feedback").get().n, 0);
});

test("feedback rejects anything outside the form", async () => {
  const env = makeEnv();
  for (const bad of [fb({note_title: "secret"}), fb({kind: "rant"}), fb({message: "no"}), fb({message: "x".repeat(2001)}),
      fb({contact: "c".repeat(121)}), fb({install_id: "zz"}), fb({platform: "toaster"})]) {
    assert.equal((await handle(post("/v1/feedback", bad), env)).status, 400, JSON.stringify(bad).slice(0, 50));
  }
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM feedback").get().n, 0);
});


test("screenshots larger than 4 KB survive submission and require admin access", async () => {
  const env = makeEnv();
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jmtkAAAAASUVORK5CYII=", "base64");
  const chunk = Buffer.from("tEXtDescription\0" + "x".repeat(6_000));
  const size = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  size.writeUInt32BE(chunk.length - 4);
  crc.writeUInt32BE(crc32(chunk));
  const image = Buffer.concat([pixel.subarray(0, 33), size, chunk, crc, pixel.subarray(33)]);
  const screenshot = "data:image/png;base64," + image.toString("base64");

  assert.equal((await handle(post("/v1/feedback", fb({screenshot})), env)).status, 200);
  const headers = {Authorization: "Bearer admin-token-0123456789"};
  const base = "https://s.example/admin/feedback";
  const {items} = await (await handle(new Request(base, {headers}), env)).json();
  assert.equal(items[0].hasScreenshot, 1);
  assert.equal(items[0].screenshot, undefined);

  const url = base + "/" + items[0].id + "/screenshot";
  assert.equal((await handle(new Request(url), env)).status, 401);
  const attachment = await handle(new Request(url, {headers}), env);
  assert.equal(attachment.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), image);
  await handle(post("/v1/forget", {install_id: "a".repeat(32)}), env);
  assert.equal((await handle(new Request(url, {headers}), env)).status, 404);

  const malformed = "data:image/jpeg;base64," + Buffer.from("wrong header").toString("base64");
  assert.equal((await handle(post("/v1/feedback", fb({screenshot: malformed})), env)).status, 400);
});

test("AI statistics accept only opted-in numeric totals and clear on withdrawal", async () => {
  const env = makeEnv();
  const submit = body => handle(new Request("https://worker.local/v1/ping", {
    method: "POST", body: JSON.stringify(body),
  }), env);
  const received = await submit(ping({ai_counts: {requests: 9, approvals: 4}}));
  assert.equal(received.status, 200);
  assert.deepEqual({...(await stats(env)).aiCounts}, {requests: 9, approvals: 4});
  assert.equal((await submit(ping({ai_counts: {requests: 9, approvals: 4, text: "CANARY_12345"}}))).status, 400);
  assert.equal((await submit(ping())).status, 200);
  assert.deepEqual({...(await stats(env)).aiCounts}, {requests: 0, approvals: 0});
});

test("owner statistics require a verified owner at the identity service", async () => {
  const env = makeEnv();
  env.AUTH_URL = "https://fixture.supabase.co";
  env.AUTH_KEY = "sb_publishable_fixture";
  const url = "https://s.example/owner/stats";
  const req = new Request(url, {headers: {Authorization: "Bearer test.header.signature12345"}});
  const answer = (owner, status = 200) => async (endpoint, options) => {
    assert.equal(endpoint, env.AUTH_URL + "/rest/v1/rpc/owner_account_stats");
    assert.equal(options.headers.Authorization, req.headers.get("Authorization"));
    assert.equal(options.redirect, "manual");
    return new Response(JSON.stringify({owner}), {status});
  };
  assert.equal(await ownerAccessStatus(req, env, answer(true)), 200);
  assert.equal(await ownerAccessStatus(req, env, answer(false)), 403);
  assert.equal(await ownerAccessStatus(req, env, answer(true, 401)), 403);
  assert.equal(await ownerAccessStatus(new Request(url), env, answer(true)), 403);
  assert.equal(await ownerAccessStatus(req, env, answer(true, 307)), 503);
  assert.equal(await ownerAccessStatus(req, env, answer(true, 500)), 503);
  assert.equal(await ownerAccessStatus(req, env, async () => { throw new TypeError("unreachable"); }), 502);
  assert.equal((await handle(new Request(url), env)).status, 403);
  env.AUTH_URL = "https://untrusted.example";
  const unreachable = () => assert.fail("must not send credentials to an untrusted origin");
  assert.equal(await ownerAccessStatus(req, env, unreachable), 503);
});

test("the production owner lookup preserves the Workers fetch receiver", async () => {
  const env = makeEnv();
  env.AUTH_URL = "https://fixture.supabase.co";
  env.AUTH_KEY = "sb_publishable_fixture";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (endpoint, options) {
    assert.equal(this, globalThis);
    assert.equal(endpoint, env.AUTH_URL + "/rest/v1/rpc/owner_account_stats");
    assert.equal(options.headers.apikey, env.AUTH_KEY);
    return new Response(JSON.stringify({owner: true}));
  };
  try {
    const req = new Request("https://s.example/owner/stats", {
      headers: {Authorization: "Bearer test.header.signature12345"},
    });
    const result = await handle(req, env);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).installs, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
