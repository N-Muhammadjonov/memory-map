function noteMeta(note) {
  return note.entity?.fields || {};
}

export function dateKey(date) {
  return [String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")].join("-");
}

export function localDateTime(utc) {
  if (!utc) return "";
  const date = new Date(utc);
  return dateKey(date) + "T" + [date.getHours(), date.getMinutes()]
    .map(value => String(value).padStart(2, "0")).join(":");
}

export function utcReminder(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || localDateTime(date.toISOString()) !== value) {
    throw new Error("Choose a valid time in your current time zone.");
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function monthDays(month) {
  const first = new Date(month);
  first.setDate(1);
  const mondayIndex = (first.getDay() + 6) % 7;
  first.setDate(1 - mondayIndex);
  return Array.from({length: 42}, (_, index) => {
    const day = new Date(first);
    day.setDate(first.getDate() + index);
    return {key: dateKey(day), day: day.getDate(), inMonth: day.getMonth() === month.getMonth()};
  });
}

export function calendarEntries(notes, reminders) {
  const days = new Map();
  for (const note of notes) {
    const due = noteMeta(note).due;
    const at = reminders[note.id] || "";
    const reminderDay = at ? dateKey(new Date(at)) : "";
    for (const day of new Set([due, reminderDay].filter(Boolean))) {
      if (!days.has(day)) days.set(day, []);
      days.get(day).push({note, due: due === day, at: reminderDay === day ? at : ""});
    }
  }
  return days;
}

export function progress(tasks) {
  const total = tasks.length;
  const done = tasks.filter(task => task.done).length;
  return {done, total, percent: total ? Math.round(100 * done / total) : null};
}

export function buildRoadmaps(notes, tasks) {
  const byNote = new Map();
  const parents = new Map();
  const notesById = new Map(notes.map(note => [note.id, note]));
  const link = (parent, child) => {
    if (!parents.has(parent)) parents.set(parent, new Set());
    parents.get(parent).add(child);
  };
  for (const note of notes) {
    for (const relation of noteMeta(note).relationships || []) {
      if (relation.type === "belongs_to") link(relation.target, note.id);
      if (relation.type === "parent_of") link(note.id, relation.target);
    }
  }
  for (const task of tasks) {
    if (!byNote.has(task.noteId)) byNote.set(task.noteId, []);
    byNote.get(task.noteId).push(task);
  }
  return notes.filter(note => (note.tags || []).some(tag => tag.toLowerCase() === "roadmap") ||
    ["project", "goal"].includes(noteMeta(note).type)).map(note => {
    const phases = new Map();
    for (const task of byNote.get(note.id) || []) {
      const phase = task.phaseOffset ?? -1;
      if (!phases.has(phase)) phases.set(phase, {name: task.phase || "Checklist", tasks: []});
      phases.get(phase).tasks.push(task);
    }
    for (const id of parents.get(note.id) || []) {
      const related = notesById.get(id);
      if (!related || id === note.id) continue;
      const items = byNote.get(id);
      const tasks = items?.length ? items : noteMeta(related).type === "task"
        ? [{noteId: id, text: related.title, done: noteMeta(related).status === "done", linkedNote: true}] : [];
      if (tasks.length) phases.set(id, {name: related.title, noteId: id, tasks});
    }
    const rows = [...phases.values()].map(phase => ({...phase, ...progress(phase.tasks)}));
    return {note, phases: rows, ...progress(rows.flatMap(phase => phase.tasks))};
  });
}

export function reminderCalendarFile(id, title, instant, now = new Date()) {
  const escape = value => value.replaceAll("\\", "\\\\").replace(/\r?\n|\r/g, "\\n")
    .replaceAll(",", "\\,").replaceAll(";", "\\;");
  const stamp = value => value.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Xotira//Reminder//EN", "BEGIN:VEVENT",
    `UID:${id}@xotira.local`, `DTSTAMP:${stamp(now.toISOString())}`,
    `DTSTART:${stamp(instant)}`, `SUMMARY:${escape(title)}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:PT0M", "DESCRIPTION:Reminder",
    "END:VALARM", "END:VEVENT", "END:VCALENDAR"];
  // RFC 5545 folds long UTF-8 lines at 75 octets without splitting a character.
  const codec = new TextEncoder();
  return lines.map(line => {
    let result = "", width = 0;
    for (const char of line) {
      const size = codec.encode(char).length;
      if (width + size > 75) { result += "\r\n "; width = 1; }
      result += char;
      width += size;
    }
    return result;
  }).join("\r\n") + "\r\n";
}
