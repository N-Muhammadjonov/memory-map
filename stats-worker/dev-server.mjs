// Local stand-in for the Cloudflare Worker (Node 22+): node stats-worker/dev-server.mjs [port]
// Uses Node's built-in SQLite instead of D1. Handy to try the dashboard before deploying; data lives in memory.
import {createServer} from "node:http";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {handle} from "./worker.js";

const db = new DatabaseSync(":memory:");
db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
const prepare = sql => ({bind: (...args) => ({sql, args,
  run: async () => db.prepare(sql).run(...args),
  all: async () => ({results: db.prepare(sql).all(...args)}),
  first: async () => db.prepare(sql).get(...args) ?? null})});
const env = {DB: {prepare, batch: async list => { for (const s of list) db.prepare(s.sql).run(...s.args); }},
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "local-dev-admin-token"};

const port = Number(process.argv[2] || 8788);
createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {method: req.method, headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks)});
  const response = await handle(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`stats dev server http://127.0.0.1:${port}  token: ${env.ADMIN_TOKEN}`));
