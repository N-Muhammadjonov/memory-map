import assert from "node:assert/strict";
import {test} from "node:test";
import {MindMapBoard} from "../web/mind-map.js";
import {FileViewer} from "../web/viewer.js";

class Element {
  constructor(tag) {
    this.tag = tag;
    this.value = "";
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.scrollTop = this.scrollLeft = 0;
    this.attrs = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      add: value => this.classes.add(value),
      remove: value => this.classes.delete(value),
    };
    this.clientWidth = 800;
    this.clientHeight = 600;
  }
  get options() { return this.children; }
  get childNodes() { return this.children; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  append(...items) { this.children.push(...items); }
  add(item) { this.append(item); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  trigger(type, props = {}) { return this.listeners.get(type)?.({target: this, ...props}); }
  getBoundingClientRect() { return {left: 0, top: 0, width: this.clientWidth, height: this.clientHeight}; }
  setPointerCapture() {}
  focus() {}
  select() {}
  scrollIntoView() {}
}

test("editor creates, renames, moves, folds, undoes and saves mind-map branches", async () => {
  const elements = {createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag)};
  globalThis.document = elements;
  globalThis.matchMedia = () => ({matches: false});
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.Option = class Option { constructor(text, value) { this.text = text; this.value = value; } };
  const root = "a".repeat(32);
  const ref = "b".repeat(32);
  const saved = [];
  const content = JSON.stringify({
    version: 1, root, topics: [{id: root, parent: null, title: "Study map"}], links: [],
  });
  const viewer = new Element("section");
  const tools = new Element("div");
  const board = new MindMapBoard(viewer, tools, content, {
    editable: true, notes: () => [{id: ref, title: "Reference"}], openNote: () => {},
    save: async map => saved.push(map),
  });
  try {
    board.add(false);
    const first = board.selected;
    board.titleInput.value = "Theory";
    board.titleInput.trigger("change");
    board.add(true);
    const second = board.selected;
    board.reparent(second, first);
    board.fold(first);
    assert.equal(board.map.topics[1].collapsed, true);
    assert.equal(board.cards.has(second), false);
    board.undo(false);
    assert.equal(board.cards.has(second), true);
    board.select(second);
    const controls = board.panel.children;
    const noteList = controls.find(field => field.children[0]?.textContent === "Link a note").children[1];
    noteList.value = ref;
    noteList.trigger("change");
    const cross = board.panel.children.find(field => field.children[0]?.textContent === "Connect to another topic").children[1];
    cross.value = root;
    cross.trigger("change");
    await board.flush();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].topics[1].title, "Theory");
    assert.equal(saved[0].topics[2].parent, first);
    assert.equal(saved[0].topics[2].ref, ref);
    assert.deepEqual(saved[0].links, [{a: second, b: root}]);
    assert.equal(board.saveStatus.textContent, "Saved");
  } finally { board.close(); }
});

test("shared Details host, circle layout, free dragging, inline branch text and viewport gestures", async () => {
  const root = "9".repeat(32);
  const ref = "8".repeat(32);
  const host = new Element("aside");
  const used = [];
  const saved = [];
  const content = JSON.stringify({version: 1, root, topics: [
    {id: root, parent: null, title: "Fieldwork", note: "Observations", ref},
  ], links: []});
  const board = new MindMapBoard(new Element("section"), new Element("div"), content, {
    editable: true, inspectorHost: host, notes: () => [],
    readLinkedNote: async id => { used.push(id); return "Observations\n\nPast field notes"; },
    save: async map => { saved.push(map); },
  });
  try {
    assert.equal(host.children[0], board.inspector);
    assert.ok(!board.main.children.includes(board.inspector));
    board.shape.value = "circle";
    board.shape.trigger("change");
    assert.equal(board.layout.nodes[0].height, board.layout.nodes[0].width);
    const card = board.cards.get(root);
    card.trigger("pointerdown", {pointerId: 1, clientX: 400, clientY: 300, isPrimary: true, button: 0});
    board.scroll.trigger("pointermove", {pointerId: 1, clientX: 520, clientY: 380});
    board.scroll.trigger("pointerup", {pointerId: 1, type: "pointerup"});
    assert.deepEqual(board.map.topics[0].offset, [120, 80]);
    const node = board.layout.nodes[0];
    assert.equal(node.x - board.layout.originX, 120);
    const topicCard = board.cards.get(root);
    topicCard.trigger("pointerdown", {pointerId: 2, clientX: 400, clientY: 300, isPrimary: true, button: 0});
    topicCard.trigger("click", {detail: 1});
    await board.flush();
    assert.deepEqual(used, [ref]);
    assert.equal(topicCard.children[1].textContent, "Observations\n\nPast field notes");
    board.clearUnavailablePreview();
    assert.equal(topicCard.children[1].textContent, "Observations");
    topicCard.trigger("click", {detail: 1});
    assert.equal(topicCard.children[1].hidden, true);
    assert.equal(saved[0].topics[0].shape, "circle");
    assert.deepEqual(saved[0].topics[0].offset, [120, 80]);
    assert.equal(board.map.topics[0].ref, ref);
    board.undo(false);
    assert.equal(board.map.topics[0].ref, ref);
    let cancelled = false;
    const preventDefault = () => { cancelled = true; };
    board.scroll.trigger("wheel", {clientX: 400, clientY: 300, deltaX: 0, deltaY: -95, deltaMode: 0, preventDefault});
    assert.ok(cancelled);
    assert.ok(board.zoom > 1);
    const initial = board.zoom;
    board.scroll.trigger("touchstart", {touches: [{clientX: 360, clientY: 290}, {clientX: 440, clientY: 290}], preventDefault});
    board.scroll.trigger("touchmove", {touches: [{clientX: 348, clientY: 290}, {clientX: 452, clientY: 290}], preventDefault});
    assert.ok(board.zoom > initial);
    assert.ok(board.zoom <= 2);
  } finally { board.close(); }
});

test("branch insertion keeps the selected side and deletion removes only its subtree", async () => {
  const root = "1".repeat(32), right = "2".repeat(32), left = "3".repeat(32);
  const initial = {version: 1, root, topics: [{id: root, parent: null, title: "Map"},
    {id: right, parent: root, title: "Right topic"}, {id: left, parent: root, title: "Left topic"}], links: []};
  const board = new MindMapBoard(new Element("section"), new Element("div"), JSON.stringify(initial), {
    editable: true, notes: () => [], save: async () => {},
  });
  const topic = id => board.map.topics.find(item => item.id === id);
  const side = id => board.layout.nodes.find(item => item.topic.id === id).side;
  try {
    board.select(left);
    board.add(true);
    const sibling = board.selected;
    assert.equal(topic(sibling).parent, root);
    assert.equal(side(sibling), -1);
    board.add(false);
    const child = board.selected;
    assert.equal(topic(child).parent, sibling);
    assert.equal(side(child), -1);
    assert.equal(side(right), 1);
    board.edit(map => map.links.push({a: child, b: right}));
    board.removeBranch(sibling);
    assert.ok(topic(right) && topic(left));
    assert.equal(topic(child), undefined);
    assert.equal(topic(sibling), undefined);
    assert.deepEqual(board.map.links, []);
    board.undo(false);
    assert.deepEqual(board.map.links, [{a: child, b: right}]);
    assert.equal(side(right), 1);
    assert.equal(side(sibling), -1);
  } finally { board.close(); }
});

test("the same map board, checksum and Undo history move between note and full viewer", async () => {
  const root = "1".repeat(32), fileId = "2".repeat(32), noteId = "3".repeat(32);
  const map = {version: 1, root, topics: [{id: root, parent: null, title: "Map"}], links: []};
  const saved = [];
  const request = async (_path, options) => {
    if (options.body) {
      saved.push(options.body);
      return {checksum: "saved-" + saved.length, mapTitle: "Map"};
    }
    return new Response(JSON.stringify(map));
  };
  function makeViewer(inline) {
    const el = () => new Element("div");
    return new FileViewer(el(), el(), el(), request, () => {}, {
      inline, notes: () => [], openNote() {}, inspectorHost: el(), showInspector() {}, onSave() {},
    });
  }
  const withinNote = makeViewer(true), expanded = makeViewer(false);
  try {
    await withinNote.open(noteId, {id: fileId, name: "Map.mindmap"});
    const board = withinNote.active.board;
    board.add(false);
    const child = board.selected;
    assert.equal(withinNote.moveMindMapTo(expanded), true);
    assert.equal(withinNote.active, null);
    assert.equal(expanded.active.board, board);
    assert.equal(expanded.active.board.selected, child);
    assert.equal(expanded.tools, board.tools);
    assert.equal(expanded.mindMapOptions.inspectorHost.children[0], board.inspector);
    await expanded.flush();
    assert.match(saved[0].checksum, /^[a-f0-9]{64}$/);
    board.removeBranch(child);
    assert.equal(expanded.moveMindMapTo(withinNote), true);
    board.undo(false);
    await withinNote.flush();
    assert.equal(saved[1].checksum, "saved-1");
    assert.ok(saved[1].map.topics.some(item => item.id === child));
  } finally {
    expanded.close();
    withinNote.close();
  }
});

test("an attachment conflict can reload the saved map and then write using the new checksum", async () => {
  const root = "a".repeat(32);
  const file = {id: "b".repeat(32), name: "Map.mindmap"};
  const original = {version: 1, root, topics: [{id: root, parent: null, title: "Original"}], links: []};
  const otherWindow = structuredClone(original);
  otherWindow.topics[0].title = "Other window";
  const digest = async map => Buffer.from(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(map)))).toString("hex");
  const oldChecksum = await digest(original), currentChecksum = await digest(otherWindow);
  const saved = [];
  let latest = original;
  let failRead = false;
  const request = async (_path, options) => {
    if (!options.body) {
      if (failRead) throw new Error("File unavailable");
      return new Response(JSON.stringify(latest));
    }
    saved.push(options.body);
    if (options.body.checksum !== currentChecksum) {
      throw Object.assign(new Error("The mind map changed in another window."), {status: 409});
    }
    return {checksum: await digest(options.body.map), mapTitle: options.body.map.topics[0].title};
  };
  const el = () => new Element("div");
  const viewer = new FileViewer(el(), el(), el(), request, () => {}, {
    notes: () => [], openNote() {}, inspectorHost: el(), showInspector() {}, onSave() {},
  });
  try {
    await viewer.open("c".repeat(32), file);
    const board = viewer.active.board;
    board.titleInput.value = "My draft";
    latest = otherWindow;
    // A toolbar click or view switch can flush before the browser emits change.
    await assert.rejects(board.flush(), {status: 409});
    assert.equal(saved[0].map.topics[0].title, "My draft");
    assert.equal(saved[0].checksum, oldChecksum);
    assert.equal(board.reload.hidden, false);
    failRead = true;
    await board.reloadSavedCopy();
    assert.equal(board.map.topics[0].title, "My draft");
    assert.equal(board.reload.hidden, false);

    failRead = false;
    await board.reloadSavedCopy();
    assert.equal(board.map.topics[0].title, "Other window");
    assert.equal(viewer.heading.textContent, "Other window");
    assert.equal(board.reload.hidden, true);
    assert.deepEqual(board.history, []);
    board.add(false);
    await board.flush();
    assert.equal(saved[1].checksum, currentChecksum);
    assert.equal(saved[1].map.topics.length, 2);
  } finally { viewer.close(); }
});
