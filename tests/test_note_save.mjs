import assert from "node:assert/strict";
import {test} from "node:test";
import {mergeSavedAttachments} from "../web/note-tools.js";

test("saving text does not resurrect attachments or undo simultaneous uploads", () => {
  const kept = {id: "kept"};
  const trashedLocally = {id: "trashed-locally"};
  const trashedInOtherTab = {id: "trashed-externally"};
  const uploaded = {id: "new-upload"};
  const resolvedFromText = {id: "new-link", noteId: "another-note"};
  const before = new Set([kept, trashedLocally, trashedInOtherTab].map(file => file.id));
  const current = [kept, trashedInOtherTab, uploaded];
  const server = [kept, trashedLocally, resolvedFromText];
  assert.deepEqual(mergeSavedAttachments(before, current, server), [kept, resolvedFromText, uploaded]);
  assert.deepEqual(mergeSavedAttachments(before, current, [...server, uploaded]), [kept, resolvedFromText, uploaded]);
});
