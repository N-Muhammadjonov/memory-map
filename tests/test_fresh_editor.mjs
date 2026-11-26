import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {runInNewContext} from "node:vm";

test("the first successful upload stays visible if the second file fails", async () => {
  const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const start = app.indexOf("async function attachFiles(");
  const end = app.indexOf("// Event bindings", start);
  assert.ok(start >= 0 && end > start);
  const state = {unlocked: true, session: 1, note: null, upload: null, library: "files"};
  const rendered = [];
  const refreshes = [];
  const attachFiles = runInNewContext(app.slice(start, end) + "attachFiles", {
    state, AbortController, URLSearchParams, MAX_ATTACHMENT: 16,
    updatePickers() {}, status() {},
    async newNotes([draft]) {
      assert.equal(draft.title, "Scene #1");
      assert.equal(draft.useAvailableTitle, true);
      return ["note"];
    },
    async openNote(id) { state.note = {id, attachments: []}; },
    async request(_path, {file}) {
      if (file.name === "Broken.txt") throw new Error("Transfer interrupted");
      return {id: "first", name: file.name};
    },
    renderFiles() { rendered.push(...state.note.attachments); },
    async refresh() { refreshes.push("graph"); },
    async refreshFiles() { refreshes.push("files"); },
    async run(fn) { await fn(); },
  });
  await assert.rejects(attachFiles([{name: "Scene #1.png", size: 8}, {name: "Broken.txt", size: 4}]),
    /1 of 2 files attached\. Transfer interrupted/);
  assert.deepEqual(rendered, [{id: "first", name: "Scene #1.png"}]);
  assert.deepEqual(refreshes, ["graph", "files"]);
  assert.equal(state.upload, null);
});
