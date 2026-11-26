import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
const modulePath = resolve(process.argv[2], "graph.js");
const source = await readFile(modulePath, "utf8");
const {NoteGraph} = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
globalThis.window = {devicePixelRatio: 1};
globalThis.document = {documentElement: {dataset: {theme: "dark"}}};
globalThis.matchMedia = () => ({matches: false});
globalThis.ResizeObserver = class { observe() {} };
globalThis.requestAnimationFrame = () => 1;
const noop = () => {};
const context = new Proxy({}, {get: (target, key) => target[key] ?? (
  key === "measureText" ? text => ({width: text.length * 6}) :
  key === "createRadialGradient" ? () => ({addColorStop: noop}) : noop
)});
const results = [];
for (const count of [100, 1000, 10000, 50000]) {
  const groupCount = Math.min(50, Math.max(10, Math.ceil(count / 50)));
  const canvas = {clientWidth: 1100, clientHeight: 620, style: {},
    getContext: () => context, addEventListener: noop};
  const graph = new NoteGraph(canvas, noop, noop, noop);
  graph.resize();
  const nodes = Array.from({length: count}, (_, i) => ({
    id: "n" + i, title: "Knowledge note " + i, group: "Group " + (i % groupCount),
  }));
  const edges = nodes.flatMap((node, i) => [1, 7].map(j => [node.id, nodes[(i + j) % count].id]));
  const start = performance.now();
  graph.setData(nodes, edges, null);
  const layoutMs = performance.now() - start;
  const frames = [];
  for (let step = 0; step < 15; step++) {
    graph.orbit(0.02, 0.01);
    const now = performance.now();
    graph.tick(now);
    frames.push(performance.now() - now);
  }
  frames.sort((a, b) => a - b);
  results.push({nodes: count, edges: edges.length, renderedNodes: graph.points.length,
    layoutMs: +layoutMs.toFixed(2), medianFrameCpuMs: +frames[7].toFixed(2),
    p95FrameCpuMs: +frames[14].toFixed(2)});
}
console.log(JSON.stringify(results, null, 2));
