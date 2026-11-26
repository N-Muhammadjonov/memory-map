import assert from "node:assert/strict";
import test from "node:test";
import {TrashDrop} from "../web/trash-drop.js";

class Element {
  children = [];
  listeners = new Map();
  classes = new Set();
  classList = {
    add: value => this.classes.add(value),
    remove: (...values) => values.forEach(value => this.classes.delete(value)),
    toggle: (value, enabled) => enabled ? this.classes.add(value) : this.classes.delete(value),
  };
  append(child) { this.children.push(child); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  setAttribute() {}
  setPointerCapture() {}
  contains(node) { return node === this || this.children.includes(node); }
  fire(type, props) {
    const event = {type, preventDefault() { this.cancelled = true; }, ...props};
    this.listeners.get(type)?.(event);
    return event;
  }
}

test("Trash becomes ready when a note or attachment starts moving and only moves on drop", () => {
  const targets = [new Element(), new Element()];
  const moved = [];
  let underPointer = null;
  globalThis.document = Object.assign(new Element(), {
    createElement: () => new Element(),
    elementFromPoint: () => underPointer,
  });
  globalThis.Node = Element;
  const trash = new TrashDrop(targets, () => true, entry => moved.push(entry));
  const note = {kind: "note", id: "note"};
  const noteControl = trash.bind(new Element(), note);
  const dataTransfer = {setData(format, value) { assert.deepEqual([format, value], ["text/plain", "note"]); }};
  noteControl.fire("dragstart", {dataTransfer});
  assert.ok(targets.every(node => node.classes.has("is-drop-ready") && !node.classes.has("is-drop-target")));
  assert.deepEqual(moved, []);
  targets[0].fire("dragover", {dataTransfer});
  assert.equal(dataTransfer.dropEffect, "move");
  assert.equal(targets[0].fire("drop", {dataTransfer}).cancelled, true);
  assert.deepEqual(moved, [note]);
  targets[0].fire("drop", {dataTransfer});
  assert.deepEqual(moved, [note]);

  const attachment = {kind: "file", id: "image", noteId: note.id};
  const grip = trash.bind(new Element(), attachment).children[0];
  const start = {pointerType: "touch", isPrimary: true, pointerId: 1, clientX: 0, clientY: 0};
  grip.fire("pointerdown", start);
  grip.fire("pointermove", {...start, clientX: 8});
  assert.ok(targets.every(node => node.classes.has("is-drop-ready")));
  grip.fire("pointerup", {...start, clientX: 8});
  assert.deepEqual(moved, [note]);
  assert.ok(targets.every(node => !node.classes.has("is-drop-ready")));

  grip.fire("pointerdown", start);
  underPointer = targets[1];
  grip.fire("pointermove", {...start, clientX: 19});
  assert.ok(targets[1].classes.has("is-drop-target"));
  grip.fire("pointerup", {...start, clientX: 19});
  assert.deepEqual(moved, [note, attachment]);
  assert.ok(targets.every(node => !node.classes.has("is-drop-ready")));
});

test("dropping a vault item onto a text field does not insert its internal ID", () => {
  const sidebarTrash = new Element();
  globalThis.document = Object.assign(new Element(), {createElement: () => new Element()});
  const moved = [];
  const drag = new TrashDrop([sidebarTrash], () => true, entry => moved.push(entry));
  assert.equal(drag.take({kind: "file", id: "attachment"}), true);
  const sourceMode = new Element();
  assert.equal(document.fire("drop", {target: sourceMode}).cancelled, true);
  assert.deepEqual(moved, []);
  assert.equal(sidebarTrash.classes.has("is-drop-ready"), false);
  assert.equal(document.fire("drop", {target: sourceMode}).cancelled, undefined);
});
