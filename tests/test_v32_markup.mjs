import assert from "node:assert/strict";
import {test} from "node:test";
import {eraseMark, relativePoint} from "../web/attachment-markup.js";
import {FileViewer, previewKind, textPreviewPages} from "../web/viewer.js";
import {NotionEditor} from "../web/notion-editor.js";

const encoder = new TextEncoder();

class Element {
  constructor(tag) {
    this.tag = tag;
    this.value = "";
    this.children = [];
    this.style = {};
    this.attrs = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      add: value => this.classes.add(value),
      remove: value => this.classes.delete(value),
      contains: value => this.classes.has(value),
      toggle: (value, force = !this.classes.has(value)) => force ? this.classes.add(value) : this.classes.delete(value),
    };
    this.ctx = {
      measureText: text => ({width: text.length * 10}),
      fillText: () => {}, setTransform: () => {}, clearRect: () => {},
      beginPath: () => {}, arc: () => {}, fill: () => {}, stroke: () => {}, moveTo: () => {}, lineTo: () => {},
    };
  }
  setAttribute(key, value) { this.attrs.set(key, value); }
  removeAttribute(key) { this.attrs.delete(key); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  fire(type, fields = {}) { return this.listeners.get(type)?.({preventDefault() {}, ...fields}); }
  getBoundingClientRect() { return {left: 10, top: 20, width: 800, height: 600}; }
  focus() {}
  decode() { return Promise.resolve(); }
  setPointerCapture() {}
  getContext() { return this.ctx; }
}

test("file previews use content signatures, accept common files, and fall back on unknown binary", () => {
  assert.deepEqual(previewKind("no extension", encoder.encode("%PDF-1.7\n")), {kind: "pdf"});
  assert.deepEqual(previewKind("photo.bin", new Uint8Array([137,80,78,71,13,10,26,10])), {kind: "image", mime: "image/png"});
  assert.deepEqual(previewKind("drawing", encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    {kind: "image", mime: "image/svg+xml"});
  assert.deepEqual(previewKind("letter.TXT", new Uint8Array([255,254,73,0,74,0])), {kind: "text", encoding: "utf-16le"});
  assert.deepEqual(previewKind("README", encoder.encode("O‘qing\n")), {kind: "text", encoding: "utf-8"});
  assert.deepEqual(previewKind("Xonanda.WAV", encoder.encode("RIFF1234WAVE")), {kind: "audio", mime: "audio/wav"});
  assert.deepEqual(previewKind("recording.MP4", new Uint8Array()), {kind: "video", mime: "video/mp4"});
  assert.deepEqual(previewKind("jadval.ods", encoder.encode("PK")), {kind: "office"});
  assert.deepEqual(previewKind("legacy.doc", new Uint8Array([208,207,17,224,161,177,26,225])), {kind: "download"});
  assert.deepEqual(previewKind("data.zip", new Uint8Array([80,75,3,4,0,0,13])), {kind: "download"});
  const text = Array.from({length: 120}, (_, n) => "Line " + n).join("\n");
  assert.equal(textPreviewPages(text).length, 3);
  assert.equal(textPreviewPages(text).join("\n"), text);
});

test("pointer coordinates and hit tests remain tied to the page", () => {
  assert.deepEqual(relativePoint(310, 280, {left: 10, top: 30, width: 600, height: 500}), [0.5, 0.5]);
  assert.deepEqual(relativePoint(910, -10, {left: 10, top: 30, width: 600, height: 500}), [1, 0]);
  const stroke = {kind: "ink", size: 3, points: [[0.1, 0.1], [0.9, 0.9]]};
  assert.equal(eraseMark([stroke], [0.5, 0.5], 800, 600, null), 0);
  assert.equal(eraseMark([stroke], [0.9, 0.2], 800, 600, null), -1);
});

test("draw, type, erase, undo, and reopen a file view without changing the original", async () => {
  globalThis.document = {createElement: tag => new Element(tag)};
  globalThis.ResizeObserver = class {observe() {} disconnect() {}};
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const original = new Uint8Array([137,80,78,71,13,10,26,10,0,0]);
  const annotation = new Map();
  const request = async (path, options) => {
    const page = path.match(/surface=(\d+)/)?.[1];
    if (page) {
      const current = annotation.get(page) || {revision: 0, marks: []};
      if (options.body) {
        assert.equal(options.body.revision, current.revision);
        annotation.set(page, {revision: current.revision + 1, marks: structuredClone(options.body.marks)});
        return {revision: current.revision + 1};
      }
      return current;
    }
    assert.equal(options.blob, true);
    return new Response(original);
  };
  const viewer = new FileViewer(new Element("div"), new Element("div"), new Element("h2"), request);
  const file = {name: "snapshot", id: "img"};
  await viewer.open("note", file);
  const board = viewer.active.markup;
  assert.equal(board.open.disabled, false);
  board.open.fire("click");
  board.layer.fire("pointerdown", {button: 0, pointerId: 1, clientX: 90, clientY: 80});
  board.layer.fire("pointermove", {pointerId: 1, clientX: 170, clientY: 140});
  board.layer.fire("pointerup", {pointerId: 1, clientX: 250, clientY: 200});
  board.modeButtons.get("text").fire("click");
  board.text.value = "Fikr";
  board.layer.fire("pointerdown", {button: 0, pointerId: 1, clientX: 410, clientY: 320});
  assert.deepEqual(board.marks.map(mark => mark.kind), ["ink", "text"]);
  board.modeButtons.get("eraser").fire("click");
  board.layer.fire("pointerdown", {button: 0, pointerId: 1, clientX: 170, clientY: 140});
  assert.equal(board.marks.length, 1);
  board.undo.fire("click");
  await viewer.flush();
  assert.deepEqual(annotation.get("1").marks[0].points, [[0.1,0.1], [0.2,0.2], [0.3,0.3]]);
  assert.equal(annotation.get("1").marks[1].text, "Fikr");
  viewer.close();
  await viewer.open("note", file, false);
  assert.equal(viewer.active.markup.marks.length, 2);
  assert.equal(viewer.active.markup.tools.children.includes(viewer.active.markup.open), false);
  assert.deepEqual([...original], [137,80,78,71,13,10,26,10,0,0]);
  viewer.close();
});

test("Office page navigation saves marks against the page or sheet that owns them", async () => {
  globalThis.document = {createElement: tag => new Element(tag)};
  globalThis.ResizeObserver = class {observe() {} disconnect() {}};
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const saved = [];
  const request = async (path, options) => {
    if (path.endsWith("?view=document")) return {sections: [{title: "First", rows: [["1"]]}, {title: "Second", rows: [["2"]]}]};
    if (options.body) {
      saved.push(path);
      return {revision: 1};
    }
    return {revision: 0, marks: []};
  };
  const viewer = new FileViewer(new Element("div"), new Element("div"), new Element("h2"), request);
  await viewer.open("note", {id: "file", name: "Sheet.xlsx"});
  const markup = viewer.active.markup;
  markup.addMarks([{kind: "text", size: 20, color: "#333333", point: [0.5,0.5], text: "One"}]);
  await viewer.tools.children[0].children[2].fire("click");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(viewer.active.pageNumber, 2);
  assert.equal(markup.surface, 2);
  assert.equal(markup.marks.length, 0);
  assert.deepEqual(saved, ["/notes/note/files/file?view=markup&surface=1"]);
  viewer.close();
});

test("Run appears after validation and stale or unsupported results leave it hidden", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  const deferred = [];
  const button = new Element("button");
  const title = new Element("span");
  const code = {childNodes: [], textContent: 'print("original")', querySelector: () => null};
  const box = {dataset: {lang: ""}, isConnected: true, querySelector(selector) {
    return selector === ".n-code code" ? code : selector === ".n-code-title" ? title : button;
  }};
  const editor = Object.assign(Object.create(NotionEditor.prototype), {
    doc: {querySelectorAll: () => [box]}, codeChecks: new WeakMap(),
    runCode: () => {}, checkCode(language, source, signal) {
      return new Promise(resolve => deferred.push({language, source, signal, resolve}));
    },
  });
  editor.refreshCodeChecks();
  assert.equal(button.hidden, true);
  t.mock.timers.tick(175);
  assert.equal(deferred[0].source, 'print("original")');
  code.textContent = "import numpy";
  editor.refreshCodeChecks();
  assert.equal(deferred[0].signal.aborted, true);
  deferred[0].resolve({runnable: true});
  await Promise.resolve();
  assert.equal(button.hidden, true);
  t.mock.timers.tick(175);
  deferred[1].resolve({runnable: false, reason: "Imports unavailable"});
  await Promise.resolve();
  assert.equal(button.hidden, true);
  assert.equal(title.title, "Imports unavailable");
  code.textContent = "SELECT 42";
  editor.refreshCodeChecks();
  t.mock.timers.tick(175);
  deferred[2].resolve({runnable: true});
  await Promise.resolve();
  assert.equal(button.hidden, false);
  assert.equal(editor.codeIsReady(box, "SELECT 42", "sql"), true);
  code.textContent = 'console.log("hi")';
  editor.refreshCodeChecks();
  t.mock.timers.tick(175);
  assert.equal(button.hidden, true);
  assert.equal(deferred.length, 3);
});
