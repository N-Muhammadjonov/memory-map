import assert from "node:assert/strict";
import test from "node:test";
import {detectLanguage, pastedFence, readEditableCode, snippetStatus} from "../web/code-tools.js";
import {buildCodeCardHtml, NotionEditor} from "../web/notion-editor.js";
import {setupDrawing} from "../web/note-tools.js";
import {anchoredShapeStroke, recognizeShape, shapeStroke} from "../web/shape-recognition.js";

test("code detection uses the body and recognizes common programming and markup languages", () => {
  const cases = {
    python: 'print("olma")',
    javascript: 'console.log("olma")',
    typescript: "const size: number = 8",
    bash: '#!/usr/bin/env bash\necho "olma"',
    sql: "SELECT COUNT(*) FROM produce",
    css: ".card { color: white; }",
    json: '{"count":3}',
    yaml: "name: project\nmodules:\n  - reader",
    html: "<section>One</section>",
    xml: '<?xml version="1.0"?>\n<document/>',
    nginx: "server {\nserver_name localhost;\n}",
    go: 'package main\nfunc main() { fmt.Println("olma") }',
    rust: 'fn main() { println!("olma"); }',
    cpp: "#include <iostream>\nint main() {}",
    c: "#include <stdio.h>\nint main() {}",
    java: "public class Example {}",
    text: "A plain sentence.",
  };
  for (const [language, source] of Object.entries(cases)) assert.equal(detectLanguage(source), language, source);
  assert.equal(detectLanguage(cases.python, "javascript"), "python");
  assert.equal(detectLanguage("custom_command()", "sh"), "bash");
  assert.equal(detectLanguage("import math"), "python");
  assert.equal(detectLanguage("import pandas as pd"), "python");
  assert.equal(detectLanguage('print("<div> => SELECT</div>")'), "python");
  assert.equal(detectLanguage('fun main() { print("hi") }'), "kotlin");
  assert.equal(detectLanguage('using System;\nConsole.WriteLine("hi");'), "csharp");
  assert.equal(detectLanguage('#!/usr/bin/env python3\nprint("html")'), "python");
});

test("fenced paste keeps Run hidden until inspected and removes the delete X", () => {
  const fence = String.fromCharCode(96).repeat(3);
  const source = 'print("olma")';
  assert.deepEqual(pastedFence(fence + source + fence), {language: "", source});
  assert.deepEqual(pastedFence(fence + "python\r\n" + source + "\r\n" + fence),
    {language: "python", source});
  assert.equal(pastedFence("An ordinary note"), null);
  const card = buildCodeCardHtml("javascript", source);
  assert.match(card, /data-detected-lang="python"/);
  assert.match(card, /data-cact="run" hidden title="Run code">Run/);
  assert.match(card, /aria-label="Copy code"><svg/);
  assert.doesNotMatch(card, /<select|data-cact="delete"/);
  const htmlCard = buildCodeCardHtml("", "<section>Example</section>");
  assert.match(htmlCard, /data-cact="run" hidden/);
  assert.doesNotMatch(htmlCard, /<section>/);
  assert.match(buildCodeCardHtml("", ""), /<code><br><\/code>/);
  assert.equal(readEditableCode({childNodes: [1], firstChild: {nodeName: "BR"}}), "");
  assert.equal(snippetStatus({output: "olma \n", error: ""}), "olma ");
});

test("runs print below the code block and ignores output from an edited snippet", async () => {
  const output = {
    hidden: true, textContent: "",
    classList: {remove() {}, toggle() {}, add() {}},
  };
  const box = {isConnected: true, querySelector: () => output};
  const button = {disabled: false, textContent: "Run"};
  const editor = {
    codeRuns: new WeakMap(),
    runCode: async (language, source) => {
      assert.equal(language, "python");
      assert.equal(source, 'print("olma")');
      return {output: "olma\n", error: ""};
    },
  };
  await NotionEditor.prototype.runSnippet.call(editor, box, button, 'print("olma")', "python");
  assert.equal(output.textContent, "olma");
  assert.equal(output.hidden, false);
  assert.equal(button.disabled, false);
  const running = NotionEditor.prototype.runSnippet.call(editor, box, button, 'print("olma")', "python");
  editor.codeRuns.delete(box);
  output.hidden = true;
  await running;
  assert.equal(output.hidden, true);
  assert.notEqual(output.textContent, "olma");
});

function jitterStroke(points) {
  const result = [];
  for (let i = 1; i < points.length; i++) {
    const subdivisions = Math.max(1, Math.ceil(Math.hypot(
      points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]) / 5));
    for (let step = 0; step < subdivisions; step++) {
      const t = step / subdivisions;
      const phase = result.length * 1.19;
      result.push([
        points[i - 1][0] * (1 - t) + points[i][0] * t + Math.sin(phase) * 1.1,
        points[i - 1][1] * (1 - t) + points[i][1] * t + Math.cos(phase) * 1.2,
      ]);
    }
  }
  return [...result, points.at(-1)];
}

test("realistic jitter stays within the line, polygon, circle, and cube recognizers", () => {
  for (const kind of ["Line", "Triangle", "Rectangle", "Square", "Circle",
    "Ellipse", "Pentagon", "Hexagon", "Cube"]) {
    const end = kind === "Square" || kind === "Circle" ? [220, 220] : [270, 220];
    const points = shapeStroke(kind, [20, 20], end);
    const result = recognizeShape(jitterStroke(points));
    assert.equal(result?.kind, kind);
    assert.ok(result.points.flat().every(Number.isFinite));
  }
  const scribble = [[15, 22], [40, 51], [109, 35], [87, 119], [50, 70], [150, 98], [125, 5]];
  assert.equal(recognizeShape(jitterStroke(scribble)), null);
});

class Control {
  handlers = new Map();
  attributes = new Map();
  addEventListener(event, handler) { this.handlers.set(event, handler); }
  getAttribute(name) { return this.attributes.get(name); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  fire(event, data = {}) { return this.handlers.get(event)({preventDefault() {}, ...data}); }
}

test("the drawing editor previews during hold, keeps strokes without hold, and saves snapped shapes", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  const controls = new Map();
  const dialog = new Control();
  dialog.querySelector = id => {
    if (!controls.has(id)) controls.set(id, new Control());
    return controls.get(id);
  };
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.fire("close"); };
  const canvas = dialog.querySelector("#draw-surface");
  canvas.width = 320;
  canvas.height = 300;
  canvas.getBoundingClientRect = () => ({width: 320, height: 300, left: 0, top: 0});
  canvas.setPointerCapture = () => {};
  const context = Object.fromEntries(["beginPath", "fillRect", "moveTo", "lineTo", "stroke", "arc", "fill"]
    .map(name => [name, () => {}]));
  canvas.getContext = () => context;
  canvas.toBlob = resolve => resolve(new Blob(["image"], {type: "image/png"}));
  dialog.querySelector("#draw-snap").checked = true;
  dialog.querySelector("#draw-color").value = "#08090a";
  dialog.querySelector("#draw-size").value = "4";
  let saved;
  const open = setupDrawing(dialog, async (_draft, drawing) => { saved = drawing; });
  await open({strokes: []});
  const emit = (event, [clientX, clientY]) => canvas.fire(event,
    {clientX, clientY, button: 0, pointerId: 1});
  for (const [index, point] of jitterStroke([[15, 30], [145, 145]]).entries()) {
    emit(index ? "pointermove" : "pointerdown", point);
  }
  t.mock.timers.tick(640);
  assert.equal(dialog.querySelector("#draw-hint").textContent, "Line snapped.");
  emit("pointerup", [145, 145]);
  emit("pointerdown", [200, 40]);
  emit("pointermove", [240, 60]);
  emit("pointerup", [280, 85]);
  t.mock.timers.tick(640);
  assert.doesNotMatch(dialog.querySelector("#draw-hint").textContent, /snapped/);
  await dialog.querySelector("form").fire("submit");
  assert.deepEqual(saved.strokes.map(stroke => stroke.points.length), [2, 3]);
  assert.equal(saved.image.type, "image/png");
});

test("scaled drawing coordinates and native range extremes reach the saved strokes", async () => {
  const nodes = new Map();
  const dialog = new Control();
  dialog.querySelector = id => {
    if (!nodes.has(id)) nodes.set(id, new Control());
    return nodes.get(id);
  };
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.fire("close"); };
  const canvas = dialog.querySelector("#draw-surface");
  canvas.width = 1200;
  canvas.height = 720;
  let rect = {left: 40, top: 20, width: 600, height: 360};
  canvas.getBoundingClientRect = () => rect;
  canvas.setPointerCapture = () => {};
  const calls = [];
  const context = Object.fromEntries(["beginPath", "fillRect", "moveTo", "lineTo", "stroke", "arc", "fill", "drawImage"]
    .map(name => [name, (...args) => calls.push([name, ...args])]));
  canvas.getContext = () => context;
  canvas.toBlob = resolve => resolve(new Blob(["fixture"], {type: "image/png"}));
  dialog.querySelector("#draw-color").value = "#08090a";
  const slider = dialog.querySelector("#draw-size");
  slider.value = "4";
  globalThis.Image = class {
    naturalWidth = 720;
    naturalHeight = 720;
    async decode() {}
  };
  let saved;
  const open = setupDrawing(dialog, async (_draft, drawing) => { saved = drawing; });
  await open({file: {id: "legacy"}, base: "fixture", strokes: []});
  assert.deepEqual(calls.find(call => call[0] === "drawImage").slice(2), [240, 0, 720, 720]);
  for (const [width, point] of [[1, [40, 20]], [10, [340, 200]], [20, [340, 200]]]) {
    if (width === 20) rect = {left: 40, top: 20, width: 300, height: 180};
    slider.value = String(width);
    slider.fire("input");
    assert.equal(dialog.querySelector("#draw-size-value").value, String(width));
    for (const kind of ["pointerdown", "pointerup"]) {
      canvas.fire(kind, {button: 0, pointerId: 1, clientX: point[0], clientY: point[1]});
    }
  }
  const shape = dialog.querySelector("#draw-shape");
  shape.value = "Diamond";
  shape.fire("change");
  calls.length = 0;
  canvas.fire("pointerdown", {button: 0, pointerId: 1, clientX: 100, clientY: 100});
  assert.ok(calls.some(call => call[0] === "moveTo" && call[1] === 240 && call[2] === 320));
  canvas.fire("pointerup", {pointerId: 1, clientX: 180, clientY: 150});
  dialog.querySelector("#draw-undo").fire("click");
  assert.equal(dialog.querySelector("#draw-redo").disabled, false);
  dialog.querySelector("#draw-redo").fire("click");
  dialog.querySelector("#draw-clear").fire("click");
  assert.equal(dialog.querySelector("#draw-save").disabled, false);
  dialog.querySelector("#draw-undo").fire("click");
  await dialog.querySelector("form").fire("submit");
  assert.deepEqual(saved.strokes.map(stroke => [stroke.size, stroke.points[0]]),
    [[1, [0, 0]], [10, [600, 360]], [20, [1200, 720]], [20, [240, 320]]]);
  assert.ok(saved.strokes.at(-1).points.length > 3);
  assert.equal(saved.keepBase, true);
});

test("every shape tool starts on the pointer contact even when dragged backwards", () => {
  for (const kind of ["Line", "Rectangle", "Square", "Circle", "Ellipse",
    "Triangle", "Diamond", "Pentagon", "Hexagon", "Cube"]) {
    const start = [175, 140];
    const trace = anchoredShapeStroke(kind, start, [110, 80]);
    assert.deepEqual(trace[0], start, kind);
    assert.ok(trace.every(pair => pair.every(Number.isFinite)));
  }
});
