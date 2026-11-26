import assert from "node:assert/strict";
import {test} from "node:test";
import {NoteGraph} from "../web/graph.js";

globalThis.window = {devicePixelRatio: 1};
globalThis.matchMedia = () => ({matches: false});
globalThis.ResizeObserver = class { observe() {} };
globalThis.requestAnimationFrame = () => 1;

function makeGraph(width = 820, height = 530) {
  const moves = [];
  const canvas = {
    clientWidth: width, clientHeight: height,
    getContext: () => ({}), addEventListener() {}, setPointerCapture() {},
    getBoundingClientRect: () => ({left: 0, top: 0}),
    classList: {toggle() {}, remove() {}},
  };
  const graph = new NoteGraph(canvas, () => {}, () => {}, (id, point) => moves.push({id, point}));
  graph.resize();
  return {graph, moves};
}

function screen(graph, point) {
  const [x, y] = graph.project(point);
  return [graph.width / 2 + graph.pan[0] + x * graph.scale, graph.height / 2 + graph.pan[1] + y * graph.scale];
}

test("Fit keeps even a single distant pinned node inside visible graph controls in all modes", () => {
  for (const [width, height] of [[320, 480], [830, 255], [1440, 900]]) {
    const {graph} = makeGraph(width, height);
    graph.setViewportInsets(42, 130);
    graph.setData([{id: "only", title: "First note"}], [], null, [], {only: [97, 65, 21]});
    for (const mode of ["3d", "2d", "layered"]) {
      graph.setMode(mode);
      const [x, y] = screen(graph, graph.points[0]);
      assert.ok(Math.abs(x - width / 2) < 0.000001, mode);
      assert.ok(y > Math.min(42, height * 0.24) && y < height - Math.min(130, height * 0.52), mode);
    }
  }
});

test("large layouts stay stable when the same notes and edges arrive in a different order", () => {
  const {graph} = makeGraph();
  const notes = Array.from({length: 1300}, (_, i) => ({
    id: "n" + i, title: "Note " + i, group: "Group " + i % 9, ...(i >= 1291 ? {topicAnchor: true} : {}),
  }));
  const edges = notes.slice(1, 31).map(note => ["n0", note.id]);
  graph.setData(notes, edges, "n0");
  const positions = new Map(graph.points.map(point => [point.id, point.home]));
  graph.setData(notes.toReversed(), edges.toReversed().map(edge => edge.toReversed()), "n0");
  assert.deepEqual(new Map(graph.points.map(point => [point.id, point.home])), positions);
  assert.equal(graph.points.length, 1100);
  for (const note of notes.slice(1291)) assert.ok(positions.has(note.id), note.id);
});

test("duplicate links do not change placement and removing a link clears an invalid highlighted path", () => {
  const {graph} = makeGraph();
  const note = id => ({id, title: id, group: "Group"});
  const entries = ["a", "b", "c"].map(note);
  const edges = [["a", "b"], ["b", "c"]];
  graph.setData(entries, edges, null);
  const original = graph.points.map(point => point.home);
  graph.setData(entries, [["b", "a"], ...edges, ["a", "b"], ["c", "c"]], null);
  assert.deepEqual(graph.points.map(point => point.home), original);
  assert.equal(graph.links.length, 2);
  assert.deepEqual(graph.findPath("a", "c"), ["a", "b", "c"]);
  graph.setData(entries, [["a", "b"]], null);
  assert.equal(graph.pathNodes, null);
});

test("the highlighted route keeps its own links even in a graph above the edge budget", () => {
  const {graph} = makeGraph();
  const dense = Array.from({length: 130}, (_, i) => ({id: "dense" + i, title: "Dense", group: "Group"}));
  const route = ["x", "y", "z"].map(id => ({id, title: id, group: "Route"}));
  const edges = dense.flatMap((first, i) => dense.slice(i + 1).map(second => [first.id, second.id]));
  graph.setData([...dense, ...route], [...edges, ["x", "y"], ["y", "z"]], null);
  assert.deepEqual(graph.findPath("x", "z"), ["x", "y", "z"]);
  assert.equal(graph.links.length, 6000);
  const shown = new Set(graph.links.map(([a, b]) => [a.id, b.id].sort().join(":")));
  assert.ok(shown.has("x:y") && shown.has("y:z"));
});

test("Auto arrange exits search and path highlighting and restores the layout after rotation and zoom", () => {
  const {graph} = makeGraph();
  const notes = ["a", "b", "c"].map(id => ({id, title: id, group: "Topic"}));
  graph.setData(notes, [["a", "b"], ["b", "c"]], null);
  graph.focusNode("c");
  assert.ok(graph.flyAnim);
  graph.findPath("a", "c");
  assert.equal(graph.focusedNode, null);
  graph.orbit(0.7, 1.1);
  graph.zoom(2);
  graph.relayout();
  assert.equal(graph.flyAnim, null);
  assert.equal(graph.pathNodes, null);
  assert.equal(graph.focusedNode, null);
  assert.equal(graph.scale, graph.fitScale);
  assert.ok(graph.points.every(point => point.home.every((value, index) => value === point.position[index])));
  graph.focusNode("b");
  graph.relayout();
  assert.equal(graph.focusedNode, null);
});

test("interrupted node drags put the point back, regular release saves the new coordinates", () => {
  const {graph, moves} = makeGraph();
  graph.setData([{id: "a", title: "New note"}], [], null);
  graph.manualPlacement = true;
  const point = graph.points[0];
  const [clientX, clientY] = screen(graph, point);
  graph.projected = [{id: "a", x: clientX, y: clientY, radius: 6, perspective: 1}];
  const down = {pointerId: 1, clientX, clientY, button: 0};
  const moved = {...down, clientX: clientX + 60, clientY: clientY + 20};
  graph.pointerDown(down);
  graph.pointerMove(moved);
  assert.notDeepEqual(point.position, point.home);
  graph.pointerUp(moved, false);
  assert.deepEqual(point.position, point.home);
  assert.equal(point.pinned, false);
  assert.equal(moves.length, 0);
  graph.pointerDown(down);
  graph.pointerMove(moved);
  graph.pointerUp(moved, true);
  assert.equal(point.pinned, true);
  assert.equal(moves[0].id, "a");
  assert.deepEqual(moves[0].point, point.position);
});

test("a new file stays by its owning note even when another note links to the file", async () => {
  const {classifyTopics} = await import("../web/graph-topics.js");
  const notes = [
    {id: "owner", title: "First note"},
    {id: "index", title: "Home"},
    {id: "topic", title: "MOC Astronomy"},
    ...Array.from({length: 120}, (_, i) => ({id: "d" + i, title: "Draft " + i})),
  ];
  const files = [{id: "photo", noteId: "owner", title: "Image.png", kind: "file"},
    {id: "logo", noteId: "index", title: "Astronomy.png", kind: "file"}];
  const edges = [["owner", "photo"], ["topic", "photo"], ["index", "logo"], ["topic", "logo"]];
  const groups = classifyTopics(notes, files, edges);
  assert.equal(groups.get("photo").key, groups.get("owner").key);
  assert.equal(groups.get("logo").key, "index");
  const {graph} = makeGraph();
  graph.setData([...notes, ...files].map(item => ({...item, group: groups.get(item.id).key})), edges, null);
  const photo = graph.points.find(point => point.id === "photo");
  const owner = graph.points.find(point => point.id === "owner");
  assert.ok(Math.hypot(...photo.home.map((value, axis) => value - owner.home[axis])) < 0.6);
});
