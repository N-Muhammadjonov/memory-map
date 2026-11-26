import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";

const web = new URL("../web/", import.meta.url);
const read = file => readFile(new URL(file, web), "utf8");
const load = async file => import("data:text/javascript;base64," + Buffer.from(await read(file)).toString("base64"));

test("every app DOM identifier resolves to one HTML element", async () => {
  const markup = await read("index.html");
  const script = await read("app.js");
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const match of script.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.includes(match[1]), match[1]);
  for (const suffix of ["status", "priority", "due", "type"]) assert.ok(ids.includes("prop-" + suffix));
});

test("structured view fields use the note and initialize legacy defaults", async () => {
  const {noteFields} = await import("../web/database-view.js");
  assert.equal(noteFields({}).status, "note");
  assert.deepEqual(noteFields({}).relationships, []);
  const fields = noteFields({entity: {fields: {status: "done", due: "2026-11-21"}}});
  assert.equal(fields.status, "done");
  assert.equal(fields.due, "2026-11-21");
});

test("graph keeps positions, opens samples on demand, and finds paths beyond the sample", async () => {
  const {NoteGraph} = await load("graph.js");
  globalThis.window = {devicePixelRatio: 1};
  globalThis.matchMedia = () => ({matches: true});
  globalThis.ResizeObserver = class { observe() {} };
  globalThis.requestAnimationFrame = () => 1;
  const noop = () => {};
  const graph = new NoteGraph({getContext: () => ({}), addEventListener: noop}, noop, noop, noop);
  assert.equal(graph.living, false);
  const nodes = Array.from({length: 1200}, (_, i) => ({id: "n" + i, title: "Note " + i}));
  const edges = [["n0", "n1100"], ["n1100", "n1199"]];
  graph.setData(nodes, edges, "n0", [], {n0: [1, 2, 3]});
  assert.equal(graph.points.length, 1100);
  assert.deepEqual(graph.points.find(node => node.id === "n0").position, [1, 2, 3]);
  assert.deepEqual(graph.findPath("n0", "n1199"), ["n0", "n1100", "n1199"]);
  assert.equal(graph.focusNode("Note 1199").id, "n1199");
  graph.width = 500;
  graph.height = 300;
  assert.notDeepEqual(graph.project({position: [1, 2, 3]}), [48, 168, 0, 1]);
  graph.setMode("2d");
  assert.deepEqual(graph.project({position: [1, 2, 3]}), [48, 168, 0, 1]);
});

test("topics use real links and metadata across imported folders and new vault notes", async () => {
  const {classifyTopics, neighborhood} = await load("graph-topics.js");
  const notes = [
    {id: "A", title: "MOC-IELTS", source: "Imported vault", path: "Everything/Main/MOC-IELTS.md"},
    {id: "B", title: "MOC-Cyber security", source: "Imported vault", path: "Everything/Main/MOC-Cyber security.md"},
    {id: "C", title: "Speaking drills", source: "Imported vault", path: "Everything/Main/Speaking drills.md"},
    {id: "D", title: "Threat modeling examples", source: "Imported vault", path: "Everything/Main/Threat modeling examples.md"},
    {id: "E", title: "HOME"},
    {id: "F", title: "Untitled", topicTerms: ["ielts", "speaking", "listening"]},
    {id: "G", title: "Photon polarization", topicTerms: ["quantum", "optics", "interferometer"]},
    {id: "H", title: "Optics lab", topicTerms: ["quantum", "polarization", "interferometer"]},
    {id: "I", title: "Bread recipe", topicTerms: ["yeast", "water", "wheat"]},
  ];
  const files = [{id: "P", title: "Screenshot 2026-11-21.png", kind: "file", noteId: "D"}];
  const edges = [["A", "C"], ["B", "D"], ["E", "A"], ["E", "B"], ["D", "P"]];
  const topics = classifyTopics(notes, files, edges);
  assert.equal(topics.get("C").key, topics.get("A").key);
  assert.equal(topics.get("F").key, topics.get("A").key);
  assert.equal(topics.get("D").key, topics.get("B").key);
  assert.equal(topics.get("P").key, topics.get("B").key);
  assert.equal(topics.get("E").key, "index");
  assert.notEqual(topics.get("G").key, "unsorted");
  assert.equal(topics.get("G").key, topics.get("H").key);
  assert.equal(topics.get("I").key, "unsorted");
  assert.deepEqual(classifyTopics([...notes].reverse(), files, [...edges].reverse()), topics);
  assert.deepEqual([...neighborhood(edges, "A", 1)].sort(), ["A", "C", "E"]);
  assert.deepEqual([...neighborhood(edges, "A", 2)].sort(), ["A", "B", "C", "E"]);
  assert.deepEqual([...neighborhood(edges, "A", 3)].sort(), ["A", "B", "C", "D", "E"]);
});

test("topic layout separates hubs and resets against generated positions", async () => {
  const {NoteGraph} = await load("graph.js");
  const noop = () => {};
  const graph = new NoteGraph({getContext: () => ({}), addEventListener: noop}, noop, noop, noop);
  const nodes = [];
  const edges = [];
  for (let cluster = 0; cluster < 7; cluster++) {
    for (let index = 0; index < 18; index++) {
      const id = `${cluster}-${index}`;
      nodes.push({id, title: id, group: "Group " + cluster, topicAnchor: index === 0});
      if (index) edges.push([`${cluster}-0`, id]);
    }
    if (cluster) edges.push(["0-0", `${cluster}-0`]);
  }
  graph.setData(nodes, edges, null, [], {"0-0": [0, 0, 0]});
  assert.deepEqual(graph.points.find(point => point.id === "0-0").position, [0, 0, 0]);
  graph.setData(nodes, edges, null);
  graph.relayout();
  const hubs = graph.points.filter(point => point.isHub);
  assert.equal(hubs.length, 7);
  for (let i = 0; i < hubs.length; i++) {
    for (const other of hubs.slice(i + 1)) {
      assert.ok(Math.hypot(hubs[i].home[0] - other.home[0], hubs[i].home[1] - other.home[1]) > 3);
    }
  }
  assert.ok(graph.points.every(point => point.position.every(Number.isFinite)));
});

test("mind-map tree supports readable branches, folding, cross links and portable Markdown", async () => {
  const {mindLayout, readMindMap, canReparent, markdownOutline} = await load("mind-map-model.js");
  const [root, a, b, c, d] = Array.from({length: 5}, (_, i) => String(i).repeat(32));
  const doc = {version: 1, root, topics: [
    {id: root, parent: null, title: "Study plan"},
    {id: a, parent: root, title: "Theory"},
    {id: b, parent: a, title: "Sources", note: "Review these", ref: d},
    {id: c, parent: root, title: "Practice"},
    {id: d, parent: a, title: "Revision"},
  ], links: [{a: b, b: c}]};
  const validated = readMindMap(JSON.stringify(doc));
  const all = mindLayout(validated);
  const right = all.nodes.find(node => node.topic.id === a);
  const left = all.nodes.find(node => node.topic.id === c);
  assert.notEqual(right.side, left.side);
  const centers = all.nodes.filter(node => node.topic.parent === a).map(node => node.y);
  assert.ok(Math.abs(centers[0] - centers[1]) >= 52);
  assert.equal(canReparent(doc, a, b), false);
  assert.equal(canReparent(doc, b, c), true);
  doc.topics[1].collapsed = true;
  const folded = mindLayout(doc);
  assert.deepEqual(new Set(folded.nodes.map(item => item.topic.id)), new Set([root, a, c]));
  const outline = markdownOutline(doc);
  assert.match(outline, /Sources \[Note\]/);
  assert.match(outline, /Sources ↔ Practice/);
  doc.topics[1].parent = b;
  assert.throws(() => readMindMap(JSON.stringify(doc)));
});

test("volumetric 3D projection keeps its spread at quarter turns", async () => {
  const {NoteGraph} = await load("graph.js");
  const noop = () => {};
  const graph = new NoteGraph({getContext: () => ({}), addEventListener: noop}, noop, noop, noop);
  graph.width = 1000;
  graph.height = 700;
  const nodes = [];
  const edges = [];
  for (let cluster = 0; cluster < 10; cluster++) {
    for (let index = 0; index < 12; index++) {
      const id = `${cluster}-${index}`;
      nodes.push({id, title: id, group: "Topic " + cluster, topicAnchor: index === 0});
      if (index) edges.push([id, `${cluster}-0`]);
    }
    if (cluster) edges.push([`${cluster}-0`, `${Math.floor(cluster / 3)}-0`]);
  }
  graph.setData(nodes, edges, null);
  const hubs = graph.points.filter(point => point.isHub);
  function spread() {
    const positions = hubs.map(point => graph.project(point));
    const centers = [0, 1].map(index => positions.reduce((sum, point) => sum + point[index], 0) / positions.length);
    let xx = 0, xy = 0, yy = 0;
    for (const [x, y] of positions) {
      xx += (x - centers[0]) ** 2;
      xy += (x - centers[0]) * (y - centers[1]);
      yy += (y - centers[1]) ** 2;
    }
    const gap = Math.hypot(xx - yy, 2 * xy);
    return Math.sqrt((xx + yy - gap) / (xx + yy + gap));
  }
  for (const [x, y] of [[0, 0], [Math.PI / 2, 0], [0, Math.PI / 2], [-0.61, 1.1], [1.7, 2.4]]) {
    graph.basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    graph.orbit(y, x);
    assert.ok(spread() > 0.35, `Collapsed at ${x}, ${y}`);
  }
  graph.mode = "2d";
  assert.deepEqual(graph.project(hubs[0]).slice(0, 2), hubs[0].position.slice(0, 2).map(value => value * 112));
});
