import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {runInNewContext} from "node:vm";

const workspace = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

function runWorkspaceFlow(handlers = {}) {
  const state = {
    unlocked: true, openSequence: 0, note: null, view: "map", history: ["A", "B", "A", "C"], histIdx: 2,
  };
  const between = (start, end) => {
    const from = workspace.indexOf(start);
    const to = workspace.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return workspace.slice(from, to);
  };
  const element = {setAttribute() {}, querySelector: () => ({})};
  const viewFunctions = between("function setView(view)", "function renderTabs()");
  const fileFunctions = between("async function openFile(", "async function openCanvasReference(");
  const noteFunctions = between("async function openNote(", "function jumpToHeading(");
  const historyFunctions = between("function updateNavButtons()", "async function loadAllVaultTasks()");
  const viewer = {
    active: null, close() { this.active = null; }, async flush() {},
    async open(noteId, file) { this.active = {noteId, file}; },
  };
  return runInNewContext(viewFunctions + fileFunctions + noteFunctions + historyFunctions +
    "({state, viewer, setView, openFile, openNote, forgetNotes})", {
    state, viewer, $: () => element, document: {querySelector: () => null}, inlineMindViews: new Map(),
    dbView: {render() {}}, graph: {resize() {}, startLoop() {}},
    syncPlanningNav() {}, renderTabs() {}, renderHomeView() {}, track() {}, VIEW_FEATURES: {}, syncDetails() {}, renderMindMaps() {},
    stopVoiceDictation() {},
    async flush() { return true; }, async request() { throw new Error("Unexpected request"); },
    renderEditor(note, historyIndex) { state.note = note; if (historyIndex !== null) state.histIdx = historyIndex; },
    ...handlers,
  });
}

test("a delayed note cannot replace a file opened after it", async () => {
  let finish;
  let started;
  const startedRequest = new Promise(resolve => { started = resolve; });
  const delayed = new Promise(resolve => { finish = resolve; });
  let voiceStopped = 0;
  const flow = runWorkspaceFlow({request: () => { started(); return delayed; }, stopVoiceDictation: () => { voiceStopped++; }});
  const open = flow.openNote("A");
  await startedRequest;
  await flow.openFile("B", {id: "file"});
  finish({id: "A"});
  await open;
  assert.equal(flow.state.view, "file");
  assert.equal(flow.viewer.active.file.id, "file");
  assert.equal(flow.state.note, null);
  assert.equal(voiceStopped, 1);
});

test("failed history loads preserve the active position and Trash removes every entry for a deleted note", async () => {
  const flow = runWorkspaceFlow({request: async () => { throw new Error("Note unavailable"); }});
  await assert.rejects(flow.openNote("B", false, "note", "", 1), /unavailable/);
  assert.equal(flow.state.histIdx, 2);
  flow.forgetNotes(new Set(["A"]));
  assert.equal(Array.from(flow.state.history).join(","), "B,C");
  assert.equal(flow.state.histIdx, 0);
});

test("heading links keep their fragment when vault path matching succeeds", async () => {
  const start = workspace.indexOf("async function openInlineReference(");
  const end = workspace.indexOf("function resolveEmbeddedImage(", start);
  const headingStart = workspace.indexOf("function decodeLinkPart(");
  const headingEnd = workspace.indexOf("async function newNotes(", headingStart);
  assert.ok(start >= 0 && end > start && headingStart >= 0 && headingEnd > headingStart);
  const opened = [], scrolled = [];
  const headings = ["100% Done", "Course Plan"].map(textContent => ({
    textContent,
    scrollIntoView: () => scrolled.push(textContent),
  }));
  const links = runInNewContext(workspace.slice(start, end) + workspace.slice(headingStart, headingEnd) +
    "({openInlineReference})", {
    state: {note: {links: {"md:course.md#Lesson%201": "course"}}, data: {nodes: [{id: "course"}], files: []}},
    formatTitle: value => value.trim().toLowerCase(),
    $: () => ({querySelectorAll: () => headings}),
    openNote: (...args) => opened.push(args),
  });
  await links.openInlineReference("md", "course.md#Lesson%201");
  await links.openInlineReference("md", "#100% Done");
  await links.openInlineReference("md", "#course-plan");
  assert.deepEqual(opened, [["course", false, "note", "Lesson%201"]]);
  assert.deepEqual(scrolled, ["100% Done", "Course Plan"]);
});
