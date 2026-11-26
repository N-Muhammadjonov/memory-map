import assert from "node:assert/strict";
import test from "node:test";
import {buildRoadmaps, calendarEntries, localDateTime, monthDays, reminderCalendarFile, utcReminder} from "../web/work-planning.js";

test("the calendar renders leap day and combines a note's due date and reminder", () => {
  const days = monthDays(new Date(2028, 1, 1, 12));
  assert.equal(days[0].key, "2028-01-31");
  assert.equal(days.filter(day => day.inMonth).length, 29);
  const at = utcReminder("2028-02-29T08:45");
  assert.equal(localDateTime(at), "2028-02-29T08:45");
  assert.throws(() => utcReminder("2027-02-29T08:45"), /valid time/);
  const note = {id: "note", entity: {fields: {due: "2028-02-29"}}};
  assert.deepEqual(calendarEntries([note], {[note.id]: at}).get("2028-02-29"), [{note, due: true, at}]);
});

test("roadmap progress uses note checkboxes and counts each linked task once", () => {
  const note = (id, fields) => ({id, title: id, entity: {fields}});
  const project = note("Course", {type: "project", relationships: [{type: "parent_of", target: "Exam"}]});
  const exam = note("Exam", {type: "task", status: "done", relationships: [{type: "belongs_to", target: "Course"}]});
  const tasks = [
    {noteId: "Course", phase: "Basics", phaseOffset: 0, text: "Read", done: true},
    {noteId: "Course", phase: "Basics", phaseOffset: 0, text: "Practice", done: false},
  ];
  const [plan] = buildRoadmaps([project, exam], tasks);
  assert.deepEqual(plan.phases.map(phase => [phase.name, phase.percent]), [["Basics", 50], ["Exam", 100]]);
  assert.deepEqual([plan.done, plan.total, plan.percent], [2, 3, 67]);
  assert.equal(buildRoadmaps([note("New goal", {type: "goal"})], [])[0].percent, null);
});

test("calendar export includes its alarm and safely folds multilingual titles", () => {
  const title = "Bir, ikki; uch\n" + "é".repeat(72);
  const ics = reminderCalendarFile("note", title, "2028-02-29T08:45:00Z", new Date("2028-01-01T12:00:00Z"));
  assert.match(ics, /DTSTART:20280229T084500Z/);
  assert.match(ics, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:PT0M/);
  assert.ok(ics.replaceAll("\r\n ", "").includes("SUMMARY:Bir\\, ikki\\; uch\\n" + "é".repeat(72)));
  assert.ok(ics.split("\r\n").every(line => Buffer.byteLength(line, "utf8") <= 75));
});
