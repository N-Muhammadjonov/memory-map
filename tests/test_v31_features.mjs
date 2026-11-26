import test from "node:test";
import assert from "node:assert/strict";

import {DatabaseView, GROUP_BY_OPTIONS, builtinViews} from "../web/database-view.js";
import {orphanNotes, suggestNoteLinks} from "../web/graph-suggestions.js";
import {TOUR_STEPS} from "../web/tour.js";

function makeFakeElement(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    className: "",
    textContent: "",
    value: "",
    hidden: false,
    open: false,
    children: [],
    dataset: {},
    style: {},
    attributes: new Map(),
    listeners: new Map(),
    append(...nodes) {
      for (const n of nodes) if (n !== undefined && n !== null) this.children.push(n);
    },
    prepend(...nodes) {
      this.children.unshift(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
    },
    addEventListener(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(fn);
    },
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
    },
    getAttribute(k) {
      return this.attributes.get(k);
    },
    querySelector() {
      return null;
    },
  };
  return el;
}

globalThis.document = {
  createElement: makeFakeElement,
  documentElement: {lang: "en"},
};
globalThis.Option = function Option(text, value, _defaultSelected, selected) {
  return {tagName: "OPTION", textContent: text, value, selected: Boolean(selected)};
};

test("DatabaseView supports Group By and Saved Views presets", () => {
  let persisted = [];
  const host = makeFakeElement("div");
  const db = new DatabaseView(host, () => {}, () => {}, {
    savedViews: [],
    onSaveViews: views => { persisted = views; },
  });

  const nodes = [
    {id: "n1", title: "Overdue Task", tags: ["Work"], updated: "2026-01-01", words: 10, entity: {fields: {status: "todo", priority: "high", due: "2020-01-01"}}},
    {id: "n2", title: "Active Project", tags: ["AI"], updated: "2026-11-20", words: 50, entity: {fields: {status: "doing", priority: "med", due: "2099-01-01"}}},
    {id: "n3", title: "Done Note", tags: ["Work"], updated: "2026-11-19", words: 20, entity: {fields: {status: "done", priority: "low"}}},
  ];
  db.setData(nodes, [["n1", "n2"]], true, nodes);

  assert.ok(GROUP_BY_OPTIONS.some(o => o.id === "priority"));
  db.groupBy = "priority";
  const groups = db.groupNotes(db.filteredNotes(db.degreeMap()));
  assert.equal(groups.length, 3);
  assert.equal(groups[0].label, "High");

  // Apply built-in Overdue preset view
  const overdueView = builtinViews().find(v => v.id === "overdue");
  db.applyView(overdueView);
  const filtered = db.filteredNotes(db.degreeMap());
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "n1");

  // Save & delete custom view
  const saved = db.saveCurrentView("My Urgent");
  assert.equal(saved.name, "My Urgent");
  assert.equal(persisted.length, 1);
  db.deleteSavedView(saved.id);
  assert.equal(persisted.length, 0);
});

test("Guided tour includes all 4 core onboarding steps", () => {
  assert.equal(TOUR_STEPS.length, 4);
  assert.deepEqual(TOUR_STEPS.map(s => s.id), ["create-note", "wiki-links", "slash-menu", "graph-view"]);
});


test("local link suggestions explain shared terms and skip protected and already linked notes", () => {
  const nodes = [
    {id: "a", title: "First", tags: ["Research"], topicTerms: ["forest", "carbon"]},
    {id: "b", title: "Second", tags: ["research"], topicTerms: ["soil"]},
    {id: "c", title: "Third", tags: [], topicTerms: ["forest", "carbon"]},
    {id: "d", title: "Fourth", tags: ["research"], locked: true},
    {id: "e", title: "Fifth", tags: ["research"]},
  ];
  const edges = [["e", "a"], ["b", "attachment-b"]];
  assert.deepEqual(orphanNotes(nodes, edges).map(note => note.id), ["b", "c"]);
  assert.deepEqual(suggestNoteLinks("a", nodes, edges).map(({item, evidence}) => [item.id, evidence]),
    [["b", ["#Research"]], ["c", ["forest", "carbon"]]]);
});

test("grouping places a note under every tag and a task view restores its status", () => {
  const db = new DatabaseView(makeFakeElement("div"), () => {}, () => {}, {savedViews: []});
  db.groupBy = "tag";
  const note = {id: "a", title: "First", tags: ["one", "two", "one"]};
  assert.deepEqual(db.groupNotes([note]).map(group => [group.label, group.notes.length]), [["#one", 1], ["#two", 1]]);
  db.applyView({id: "view_done", mode: "tasks", taskFilter: "done"});
  assert.equal(db.taskFilter, "done");
});
