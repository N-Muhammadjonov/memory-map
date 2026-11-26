import {setupAIPanel} from "./ai-panel.js";
import {localDateTime, reminderCalendarFile, utcReminder} from "./work-planning.js";
import {NoteGraph} from "./graph.js";
import {classifyTopics, neighborhood} from "./graph-topics.js";
import {readMindMap} from "./mind-map-model.js";
import {FileViewer, fileLabel, fileType} from "./viewer.js";
import {extractOutline, frontmatterLength, splitFrontmatter} from "./markdown.js";
import {folderPacket, folderTree} from "./folder.js";
import {mergeSavedAttachments, resizePane, setupDrawing} from "./note-tools.js";
import {renderProperties} from "./properties.js";
import {NotionEditor} from "./notion-editor.js";
import {DatabaseView, noteFields, STATUS_LIST, PRIORITY_LIST} from "./database-view.js";
import {CommandPalette} from "./command-palette.js";
import {StudyMode, extractCardsFromMarkdown} from "./study-mode.js";
import {NOTE_TEMPLATES, PROFESSION_PACKS, todayISO} from "./templates.js";
import {TrashDrop} from "./trash-drop.js";
import {renderHome} from "./home.js";
import {startGuidedTour} from "./tour.js";
import {orphanNotes, suggestNoteLinks} from "./graph-suggestions.js";
import {LANGUAGES, applyA11y, applyLanguage, getSavedLanguage, loadA11y, t} from "./i18n.js";

const $ = id => document.getElementById(id);
const apiBase = "/api";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const LEGACY_FIELDS_KEY = "xotira-v13-note-meta";
const ENTITY_LABELS = {
  note: "Note", concept: "Concept", person: "Person", project: "Project", task: "Task",
  paper: "Paper", book: "Book", meeting: "Meeting", organization: "Organization",
  document: "Document", goal: "Goal", event: "Event", client: "Client", source: "Source",
};
const RELATION_LABELS = {
  related_to: "Related to", belongs_to: "Belongs to", depends_on: "Depends on", blocks: "Blocks",
  cites: "Cites", authored_by: "Authored by", participates_in: "Participates in",
  derived_from: "Derived from", parent_of: "Parent of",
};
const MAX_ATTACHMENT = 64 * 1024 * 1024;
const setupToken = location.hash.slice(1);
let token = "";
try {
  if (tokenPattern.test(setupToken)) {
    sessionStorage.setItem("xotira-launch", setupToken);
    history.replaceState(null, "", "/");
    token = setupToken;
  } else {
    token = sessionStorage.getItem("xotira-launch") || "";
  }
} catch {
  token = setupToken;
}

const state = {
  unlocked: false, exists: false, note: null, dirty: false,
  editVersion: 0, saving: null, timer: 0, searchTimer: 0,
  refreshSequence: 0, openSequence: 0, lastTouch: 0,
  data: {nodes: [], files: [], edges: [], hits: []},
  trash: false, tag: null, focused: false, showMapFiles: true,
  graphGroup: "", graphItems: [], graphListLimit: 100,
  graphTopics: new Map(), graphData: null, graphFocusId: null, manualGraph: false,
  sourceMode: false,
  view: "home", // home | map | db | note | file
  library: "notes", tabs: [], files: [], fileSequence: 0,
  upload: null, positions: {}, positionRevision: 0, positionWrites: new Map(), imageUrls: new Map(),
  metadata: null, drawingBusy: false, reminders: {}, reminderSequence: 0,
  fieldWrites: Promise.resolve(), session: 0,
  folderImport: false, sidebar: !matchMedia("(max-width: 760px)").matches, inspector: false, split: false, zen: false,
  history: [], histIdx: -1,
  theme: (() => { try { return localStorage.getItem("xotira-theme") || "dark"; } catch { return "dark"; } })(),
  folders: new Set(), fileFolders: new Set(),
};

const trashDrag = new TrashDrop([$("trash"), $("trash-drop-zone")], () => state.unlocked && !state.trash, moveDroppedItem);

const formatTitle = text => text.normalize("NFKC").trim().toLocaleLowerCase();

const graph = new NoteGraph(
  $("graph"),
  id => void run(() => openGraphItem(id)),
  touch,
  (id, position) => void run(() => moveGraphItem(id, position)),
);

const graphChrome = new ResizeObserver(() => {
  const canvas = $("graph").getBoundingClientRect();
  if (!canvas.height || $("graph").hidden) return;
  const meta = $("graph-meta").getBoundingClientRect();
  const controls = $("graph-controls").getBoundingClientRect();
  graph.setViewportInsets(Math.max(14, meta.bottom - canvas.top + 12),
    Math.max(14, canvas.bottom - controls.top + 14));
});
graphChrome.observe($("graph-meta"));
graphChrome.observe($("graph-controls"));

$("living-toggle").setAttribute("aria-pressed", String(graph.living));

const inlineMindViews = new Map();
const mindMapActions = {
  notes: () => state.trash ? [] : state.data.nodes,
  inspectorHost: $("mind-inspector-host"),
  showInspector: () => setInspector(true),
  readLinkedNote: async (id, signal) => {
    if (state.trash || !state.data.nodes.some(note => note.id === id && !note.locked)) return "";
    const note = await request(`/notes/${id}`, {signal});
    return note.trashed || note.locked ? "" : note.body;
  },
  onTrash: (noteId, file) => void run(() => changeFileTrash({...file, noteId}, "move")),
  onSave: () => { if (state.unlocked) void run(refresh); },
};
const viewer = new FileViewer($("viewer-content"), $("viewer-tools"), $("viewer-title"), request, openCanvasReference,
  mindMapActions);

let savedViewWrites = Promise.resolve();
let savedViewSequence = 0;

function persistDatabaseView(_views, change) {
  const session = state.session;
  const sequence = ++savedViewSequence;
  savedViewWrites = savedViewWrites.then(async () => {
    if (!state.unlocked || state.session !== session) return;
    let result;
    try { result = await request("/database/views", {body: change}); }
    catch (error) {
      if (!state.unlocked || state.session !== session) return;
      status(error.message, true);
      result = await request("/database/views");
    }
    if (!state.unlocked || state.session !== session || sequence !== savedViewSequence) return;
    dbView.savedViews = result.views;
    if (state.view === "db") dbView.render();
  }).catch(error => { if (state.unlocked && state.session === session) status(error.message, true); });
}

const dbView = new DatabaseView(
  $("db-panel"),
  id => void run(() => openNote(id, false, "note")),
  (id, pinned) => void run(() => togglePin(id, pinned)),
  {
    onUpdateFields: async (id, fields) => {
      try { await updateNoteFields(id, fields); }
      catch (error) { status(error.message, true); throw error; }
    },
    onMode: syncPlanningNav,
    savedViews: [],
    onSaveViews: persistDatabaseView,
    onNewEvent: date => openCreateDialog(date),
    onNewRoadmap: () => void run(async () => {
      dbView.roadmapId = await createFromTemplate(NOTE_TEMPLATES.find(template => template.id === "roadmap"));
    }),
    onLoadTasks: () => loadAllVaultTasks(),
    onToggleTask: task => toggleVaultTask(task),
    dragNote: (control, id) => makeTrashDraggable(control, {kind: "note", id}),
  },
);

function syncEditorHistoryButtons() {
  if ($("note-undo")) $("note-undo").disabled = !notionEditor.canUndo();
  if ($("note-redo")) $("note-redo").disabled = !notionEditor.canRedo();
}

const SPELL_KEY = "memorymap-spell-en";
const spellSaved = (() => { try { return localStorage.getItem(SPELL_KEY) === "1"; } catch { return false; } })();
const notionEditor = new NotionEditor($("notion-editor"), $("slash-popover"), $("bubble-bar"), {
  spellcheck: spellSaved,
  getNotes: () => state.data.nodes,
  openAI: options => void aiPanel.open(options),
  checkCode: (language, source, signal) => request("/snippets/check", {body: {language, source}, signal}),
  runCode: (language, source) => request("/snippets/run", {body: {language, source}}),
  onOpenLink: (kind, ref) => void run(() => openInlineReference(kind, ref)),
  onHistoryChange: syncEditorHistoryButtons,
  onChange: md => {
    $("body").value = md;
    scheduleSave();
  },
  resolveImage: (src, alt) => resolveEmbeddedImage(src, alt),
  getMindMaps: () => [...inlineMindViews].filter(([, entry]) => entry.noteId === state.note?.id)
    .map(([id, entry]) => [id, entry.card]),
});
$("note-undo")?.addEventListener("click", () => notionEditor.undo());
$("note-redo")?.addEventListener("click", () => notionEditor.redo());

const cmdPalette = new CommandPalette($("cmd-dialog"), () => buildCommandItems());
const studyMode = new StudyMode($("study-dialog"));

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

function saved(message, error = false) {
  $("saved").textContent = message;
  $("saved").classList.toggle("error", error);
  $("reload-note").hidden = !error;
}

function gateError(message) {
  $("gate-error").textContent = message;
  $("gate-error").hidden = !message;
}

function showGate({exists, message = ""}) {
  state.unlocked = false;
  state.session++;
  state.saving = null;
  state.fieldWrites = Promise.resolve();
  state.history = [];
  state.histIdx = -1;
  dbView.setData([], [], false);
  $("db-panel").replaceChildren();
  state.exists = exists;
  state.openSequence += 1;
  state.refreshSequence += 1;
  state.data = {nodes: [], files: [], edges: [], hits: []};
  state.tag = null;
  state.trash = false;
  trashDrag.clear();
  state.focused = false;
  state.graphOrphans = false;
  state.lastTouch = 0;
  state.lastBackup = "";
  state.updateInfo = null;
  state.upload?.abort();
  state.upload = null;
  state.folderImport = false;
  state.folders.clear();
  state.fileFolders.clear();
  state.tabs = [];
  state.files = [];
  state.reminders = {};
  state.reminderSequence++;
  dbView.reminders = {};
  dbView.savedViews = [];
  dbView.setData([], [], false);
  dbView.applyView({id: "all"});
  $("show-reminders").hidden = true;
  $("reminder-list").replaceChildren();
  state.positions = {};
  state.positionWrites.clear();
  stopVoiceDictation();
  for (const dlg of ["draw-dialog", "create-dialog", "cmd-dialog", "template-dialog", "path-dialog", "history-dialog", "relations-dialog", "search-dialog", "agent-dialog", "study-dialog", "timer-dialog", "mind-create-dialog", "reminder-dialog", "share-dialog", "transfer-dialog", "a11y-dialog", "onboarding-dialog", "bibtex-dialog", "clipper-dialog", "feedback-dialog", "ai-panel", "recovery-dialog", "note-lock-dialog", "mirror-dialog"]) {
    if ($(dlg)?.open) $(dlg).close();
  }
  document.querySelector(".tour-card[open]")?.close();
  state.fileSequence += 1;
  viewer.close();
  setView("home");
  setLibrary("notes");
  clearTimeout(state.searchTimer);
  clearEditor();
  $("search").value = "";
  $("notes").replaceChildren();
  $("pinned-notes").replaceChildren();
  $("pinned-section").hidden = true;
  $("filters").replaceChildren();
  $("graph-count").textContent = "";
  $("mind-items").replaceChildren();
  $("mind-search").value = "";
  $("file-menu").open = false;
  $("backup-status").textContent = "";
  status("");
  state.graphItems = [];
  state.graphGroup = "";
  state.graphListLimit = 100;
  state.graphTopics.clear();
  state.graphData = null;
  state.graphFocusId = null;
  state.manualGraph = false;
  graph.manualPlacement = false;
  $("manual-graph").setAttribute("aria-pressed", "false");
  graph.clear();
  $("graph-list").replaceChildren();
  $("graph-search").value = "";
  $("search-results-status").textContent = "";
  $("graph-group").replaceChildren(new Option("All topics", ""));
  $("search-results").replaceChildren();
  $("vault-query").value = "";
  $("history-diff").replaceChildren();
  $("relation-list").replaceChildren();
  $("relation-target").replaceChildren();
  $("workspace").hidden = true;
  $("gate").hidden = false;
  $("confirmation-wrap").hidden = exists || Boolean(message);
  if ($("recover-wrap")) $("recover-wrap").hidden = true;
  if ($("recover-toggle")) {
    $("recover-toggle").hidden = !exists || Boolean(message);
    $("recover-toggle").textContent = "Use recovery key";
  }
  $("password").hidden = false;
  $("password").required = true;
  const pwLabel = document.querySelector("label[for='password']");
  if (pwLabel) pwLabel.hidden = false;
  $("password").value = "";
  $("confirmation").value = "";
  if ($("recovery-key-input")) $("recovery-key-input").value = "";
  if ($("recovery-new-pw")) $("recovery-new-pw").value = "";
  $("password").disabled = Boolean(message);
  $("confirmation").required = !exists && !message;
  $("password").autocomplete = exists ? "current-password" : "new-password";
  $("password").minLength = exists ? 1 : 12;
  $("unlock-button").disabled = Boolean(message);
  $("unlock-button").textContent = exists ? "Unlock vault" : "Create vault";
  $("gate-message").textContent = exists
    ? "Enter your password to unlock your notes."
    : "Create a password of at least 12 characters.";
  if (message) $("gate-message").textContent = message;
  gateError("");
}

async function request(path, options = {}) {
  const session = state.session;
  const headers = {Authorization: `Bearer ${token}`};
  const hasBody = options.body !== undefined || options.file !== undefined;
  if (hasBody) headers["Content-Type"] = options.file ? "application/octet-stream" : "application/json";
  const response = await fetch(apiBase + path, {
    method: hasBody ? "POST" : "GET",
    headers, cache: "no-store", signal: options.signal,
    body: options.file ?? (hasBody ? JSON.stringify(options.body) : undefined),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 423 && state.unlocked && session === state.session) showGate({exists: true});
    throw Object.assign(new Error(payload.error || `Action failed (${response.status}).`), {status: response.status});
  }
  return options.blob ? response : response.json();
}

async function run(action) {
  try { await action(); }
  catch (error) { if (state.unlocked) status(error.message, true); }
}

function touch() {
  if (!state.unlocked || Date.now() - state.lastTouch < 30_000) return;
  state.lastTouch = Date.now();
  void request("/touch", {body: {}}).catch(() => {});
}

function button(text, action, options = {}) {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = text;
  if (options.pressed !== undefined) el.setAttribute("aria-pressed", String(options.pressed));
  if (options.title) el.title = options.title;
  el.addEventListener("click", action);
  return el;
}

function emptyItem(text) {
  const el = document.createElement("li");
  el.className = "no-items";
  el.textContent = text;
  return el;
}

function clearEditor() {
  stopVoiceDictation();
  clearTimeout(state.timer);
  state.note = null;
  renderInlineMindMaps();
  state.dirty = false;
  state.editVersion += 1;
  state.metadata = null;
  $("title").value = "";
  $("body").value = "";
  notionEditor.setValue("", true);
  $("properties-source").value = "";
  $("properties-list").replaceChildren();
  $("note-properties").hidden = true;
  $("tags").value = "";
  $("files").replaceChildren();
  $("backlinks").replaceChildren();
  $("outlinks").replaceChildren();
  $("outline-list").replaceChildren();
  $("mentions-list").replaceChildren();
  $("note-stats").textContent = "";
  if ($("reading-progress-fill")) $("reading-progress-fill").style.width = "0%";
  updateWordGoalBadge();
  clearImages();
  $("editor-content").hidden = true;
  $("no-selection").hidden = false;
  saved("");
  updatePickers();
}

function updateNoteStats() {
  if (!state.note) { $("note-stats").textContent = ""; return; }
  const text = $("body").value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const mins = Math.max(1, Math.ceil(words / 200));
  $("note-stats").textContent = `${words} words · ~${mins} min`;
}

function renderOutline() {
  const target = $("outline-list");
  if (!state.note) { target.replaceChildren(); return; }
  const headings = extractOutline($("body").value);
  if (!headings.length) { target.replaceChildren(emptyItem("None")); return; }
  target.replaceChildren(...headings.map(h => {
    const li = document.createElement("li");
    li.dataset.level = String(h.level);
    li.append(button(h.text, () => jumpToHeading(h.text), {title: h.text}));
    return li;
  }));
}

async function openInlineReference(kind, ref) {
  const raw = (ref || "").trim();
  if (!raw) return;

  const unescaped = raw.replace(/\\([() ])/g, "$1");
  const fragment = unescaped.indexOf("#");
  const path = fragment < 0 ? unescaped : unescaped.slice(0, fragment);
  const heading = fragment < 0 ? "" : unescaped.slice(fragment + 1);
  if (!path && heading) { jumpToHeading(heading); return; }

  const resolvedId = state.note?.links?.[kind + ":" + raw] || state.note?.links?.[kind + ":" + unescaped] ||
    (kind === "wiki" && state.note?.links?.["wiki:" + path]);
  if (resolvedId) {
    const targetNote = state.data.nodes.find(n => n.id === resolvedId);
    if (targetNote) { await openNote(targetNote.id, false, "note", heading); return; }
    const targetFile = state.data.files.find(f => f.id === resolvedId);
    if (targetFile) { await openFile(targetFile.noteId, targetFile); return; }
  }

  // 2. Strip heading/extension and check ID, full path, suffix path, and basename stem
  const location = kind === "md" ? decodeLinkPart(path) : path;
  const noHeading = location.replace(/^xotira:/, "").replace(/^attachment:/, "").replace(/\.md$/i, "").trim();

  const byId = state.data.nodes.find(n => n.id === noHeading);
  if (byId) { await openNote(byId.id, false, "note", heading); return; }

  const norm = formatTitle(noHeading);
  const stem = formatTitle(noHeading.split("/").pop() || noHeading);

  const byPath = state.data.nodes.find(n => {
    if (!n.path) return false;
    const np = formatTitle(n.path.replace(/\.md$/i, ""));
    const full = n.source ? formatTitle(`${n.source}/${n.path}`.replace(/\.md$/i, "")) : np;
    return np === norm || full === norm || np.endsWith("/" + norm);
  });
  if (byPath) { await openNote(byPath.id, false, "note", heading); return; }

  const byTitle = state.data.nodes.find(n =>
    [n.title, ...(n.aliases || [])].some(label => {
      const l = formatTitle(label);
      return l === norm || l === stem;
    })
  );
  if (byTitle) { await openNote(byTitle.id, false, "note", heading); return; }

  const fileMatch = state.data.files.find(f =>
    f.id === noHeading || formatTitle(f.name) === norm || formatTitle(f.name) === stem ||
    (f.path && formatTitle(f.path) === norm)
  );
  if (fileMatch) { await openFile(fileMatch.noteId, fileMatch); return; }

  // 3. Only create a new note for simple non-path wikilinks (never spawn blank notes for unresolved folder paths!)
  if (kind === "wiki" && noHeading && !noHeading.includes("/")) {
    const [id] = await newNotes([{title: noHeading}]);
    await openNote(id, true, "note");
  } else {
    status(`Note not found: ${noHeading}`, true);
  }
}

function resolveEmbeddedImage(src, alt) {
  const m = (src || "").match(/^attachment:([0-9a-f]{32})$/);
  const file = m && (state.note?.attachments || []).find(f => f.id === m[1]);
  if (!file) return document.createTextNode(alt || src);
  return imageControl({...file, noteId: file.noteId || state.note.id}, alt || file.name);
}

async function loadMentions(noteId) {
  const target = $("mentions-list");
  if (!state.unlocked || state.trash) { target.replaceChildren(); return; }
  try {
    const {mentions} = await request(`/notes/${noteId}/mentions`);
    if (state.note?.id !== noteId) return;
    if (!mentions.length) { target.replaceChildren(emptyItem("None")); return; }
    target.replaceChildren(...mentions.map(m => {
      const li = document.createElement("li");
      const box = document.createElement("div");
      box.className = "mention-item";
      const head = document.createElement("div");
      head.className = "mention-head";
      const openBtn = button(m.title, () => void run(() => openNote(m.id, false, "note")));
      const linkBtn = button("Link", () => void run(() => linkMention(m)));
      linkBtn.className = "ghost-btn";
      head.append(openBtn, linkBtn);
      const snip = document.createElement("span");
      snip.className = "mention-snip";
      snip.textContent = m.snippet;
      box.append(head, snip);
      li.append(box);
      return li;
    }));
  } catch { target.replaceChildren(emptyItem("None")); }
}

async function linkMention(mention) {
  if (!state.note) return;
  const other = await request(`/notes/${mention.id}`);
  const escaped = mention.matched.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`(?<!\\[)\\b${escaped}\\b(?!\\])`, "i");
  const updatedBody = other.body.replace(rx, `[[${state.note.title}]]`);
  if (updatedBody === other.body) return;
  await request(`/notes/${other.id}`, {
    body: {title: other.title, tags: other.tags, body: updatedBody, revision: other.revision},
  });
  status(`“${other.title}” was linked.`);
  await refresh();
  await loadMentions(state.note.id);
}

async function togglePin(noteId, pinned) {
  await request(`/notes/${noteId}/pin`, {body: {pinned}});
  await refresh();
  updatePinButton();
}

function updatePinButton() {
  if (!state.note) return;
  const node = state.data.nodes.find(n => n.id === state.note.id);
  const pinned = Boolean(node?.pinned);
  $("pin-note").setAttribute("aria-pressed", String(pinned));
  $("pin-note").textContent = pinned ? "★" : "☆";
}

function makeTrashDraggable(control, entry) {
  return state.trash ? control : trashDrag.bind(control, entry);
}

function draggableFile(control, file, noteId = file.noteId) {
  return makeTrashDraggable(control, {kind: "file", id: file.id, noteId});
}

function renderGraph() {
  const {nodes, files = [], edges, hits} = state.data;
  const searchOn = Boolean($("search").value.trim());
  const allTags = [...new Set(nodes.flatMap(note => note.tags))].sort((a, b) => a.localeCompare(b));
  if (state.tag && !allTags.includes(state.tag)) state.tag = null;
  $("filters").replaceChildren(...allTags.map(tag => (
    button("#" + tag, () => { state.tag = state.tag === tag ? null : tag; renderGraph(); }, {pressed: state.tag === tag})
  )));
  const hitIds = new Set(hits);
  const visible = nodes.filter(note => (
    (!state.tag || note.tags.includes(state.tag)) && (!searchOn || hitIds.has(note.id))
  ));

  const pinnedList = visible.filter(n => n.pinned);
  $("pinned-section").hidden = state.trash || !pinnedList.length;
  $("pinned-notes").replaceChildren(...pinnedList.map(note => {
    const li = document.createElement("li");
    const btn = button("", () => void run(() => openNote(note.id, false, "note")), {title: note.title});
    const span = document.createElement("span");
    span.textContent = note.title;
    btn.append(span);
    if (state.note?.id === note.id) btn.setAttribute("aria-current", "true");
    li.append(makeTrashDraggable(btn, {kind: "note", id: note.id}));
    return li;
  }));

  $("list-heading").textContent = state.trash ? t("trash") : t("list-heading");
  $("trash").setAttribute("aria-pressed", String(state.trash));
  $("trash").textContent = state.trash ? t("list-heading") : t("trash");
  $("create-note").hidden = state.trash;
  $("empty-trash").hidden = state.library === "files" || !state.trash;
  $("empty-trash").disabled = nodes.length + files.length === 0;
  $("show-files").disabled = state.trash;
  const visiblePath = state.note?.path ? `${state.note.source}/${state.note.path}` : "";
  folderTree($("notes"), visible, note => {
    const item = document.createElement("li");
    const control = button("", () => void run(() => openNote(note.id, false, "note")), {title: note.path || note.title});
    const label = document.createElement("span");
    label.textContent = note.title;
    control.append(label);
    if (state.note?.id === note.id) control.setAttribute("aria-current", "true");
    item.append(makeTrashDraggable(control, {kind: "note", id: note.id}));
    return item;
  }, visiblePath, state.folders, searchOn || Boolean(state.tag));
  const trashFiles = state.trash ? files.filter(file => !searchOn || hitIds.has(file.id)) : [];
  if (trashFiles.length) $("notes").append(...trashFiles.map(file => fileRow(file, file.noteId, file.noteTitle)));
  if (!visible.length && !trashFiles.length) {
    $("notes").append(emptyItem(nodes.length ? "No results" : state.trash ? "Trash is empty" : "No notes yet"));
  }

  if (!state.trash) dbView.setData(visible, edges, state.view === "db", nodes);
  renderReminders();

  if (state.graphData !== state.data) {
    state.graphData = state.data;
    const graphFiles = files.map(file => ({...file, title: file.mapTitle || file.name, kind: "file"}));
    state.graphTopics = classifyTopics(nodes, graphFiles, edges);
  }
  const selected = state.graphFocusId || state.note?.id;
  const validOrigin = state.graphTopics.has(selected) && !state.trash;
  if (!validOrigin) state.focused = false;
  const neighbors = state.focused && validOrigin ? neighborhood(edges, selected, Number($("depth").value)) : null;
  const foundNotes = new Set(visible.map(note => note.id));
  const fileByParents = new Set(edges.filter(([from]) => foundNotes.has(from)).map(([, to]) => to));
  const stampTopic = item => {
    const topic = state.graphTopics.get(item.id);
    return {...item, group: topic?.key, topicAnchor: topic?.anchor, topicLabel: topic?.label};
  };
  const matchingFiles = files.filter(file =>
    (!searchOn && !state.tag) || (searchOn && hitIds.has(file.id) && !state.tag) || fileByParents.has(file.id)
  ).map(file => stampTopic({id: file.id, noteId: file.noteId, title: file.mapTitle || file.name,
    kind: "file", fileType: fileType(file.name)}));
  const orphanIds = state.graphOrphans ? new Set(orphanNotes(nodes, edges).map(note => note.id)) : null;
  $("graph-orphans").setAttribute("aria-pressed", String(Boolean(orphanIds)));
  const candidates = state.trash ? [] : [...visible.map(stampTopic), ...(state.showMapFiles ? matchingFiles : [])]
    .filter(item => (!orphanIds || orphanIds.has(item.id)) && (!neighbors || neighbors.has(item.id)));
  const groups = new Map(candidates.map(item => [item.group, item.topicLabel]));
  const orderedGroups = [...groups].sort((a, b) => a[1].localeCompare(b[1], "en"));
  if (!groups.has(state.graphGroup)) state.graphGroup = "";
  $("graph-group").replaceChildren(new Option("All topics", ""),
    ...orderedGroups.map(([key, label]) => new Option(label, key)));
  $("graph-group").value = state.graphGroup;
  const shown = candidates.filter(item => !state.graphGroup || item.group === state.graphGroup || item.id === selected);
  state.graphItems = shown;
  const shownIds = new Set(shown.map(item => item.id));
  const shownEdges = edges.filter(([from, to]) => shownIds.has(from) && shownIds.has(to));
  const positions = state.manualGraph ? {
    ...state.positions, ...Object.fromEntries([...state.positionWrites].map(([id, write]) => [id, write.position])),
  } : {};
  const hadPath = Boolean(graph.pathNodes);
  graph.setData(shown, shownEdges, validOrigin ? selected : null,
    [...new Set([...state.graphTopics.values()].map(topic => topic.key))], positions);
  if (hadPath && !graph.pathNodes) $("path-result").textContent = "";

  const fileCount = shown.filter(item => item.kind === "file").length;
  const reduced = graph.visibleCount < shown.length && $("graph-mode").value !== "list";
  $("graph-count").textContent = `${shown.length - fileCount} notes · ${shownEdges.length} links`
    + (reduced ? ` · ${graph.visibleCount} visible nodes` : "");
  if ($("graph-mode").value === "list") renderGraphList();
  $("map-files").setAttribute("aria-pressed", String(state.showMapFiles));
  $("map-files").hidden = files.length === 0;
  $("focus").disabled = !validOrigin;
  $("focus").setAttribute("aria-pressed", String(state.focused && validOrigin));
  $("depth").hidden = !state.focused || !validOrigin;
  const scopeName = nodes.find(note => note.id === selected)?.title || files.find(file => file.id === selected)?.name;
  $("graph-scope-note").textContent = state.focused && validOrigin ? scopeName : "";
  $("graph-scope-note").hidden = !(state.focused && validOrigin);
  $("map-empty").hidden = shown.length > 0;
  $("map-message").textContent = state.trash
    ? (nodes.length || files.length ? "Choose an item from Trash." : "Trash is empty.")
    : (nodes.length || files.length ? "No nodes match the current view." : "Add a note or import a folder.");
  $("examples").hidden = state.trash || nodes.length + files.length > 0 || searchOn;
  $("map-import").hidden = $("examples").hidden;
  renderRelated();
  renderTabs();
  updatePinButton();
  updatePickers();
}

function renderGraphList() {
  const selected = state.graphFocusId || state.note?.id;
  const labels = new Map();
  for (const relation of state.data.relationships || []) {
    const source = relation.source === selected;
    if (source || relation.target === selected) {
      const other = source ? relation.target : relation.source;
      const entries = labels.get(other) || [];
      entries.push((source ? "→ " : "← ") + RELATION_LABELS[relation.type]);
      labels.set(other, entries);
    }
  }
  const list = $("graph-list");
  list.replaceChildren(...state.graphItems.slice(0, state.graphListLimit).map(item => {
    const li = document.createElement("li");
    const extra = labels.get(item.id);
    const control = button([item.title, item.topicLabel, extra?.join(", ")].filter(Boolean).join(" · "),
      () => void run(() => openGraphItem(item.id)));
    const file = state.data.files.find(candidate => candidate.id === item.id);
    li.append(file ? draggableFile(control, file) : makeTrashDraggable(control, {kind: "note", id: item.id}));
    return li;
  }));
  $("graph-list-more").hidden = state.graphItems.length <= state.graphListLimit;
}

$("graph-list-more").addEventListener("click", () => {
  const first = state.graphListLimit;
  state.graphListLimit += 100;
  renderGraphList();
  $("graph-list").children[first]?.querySelector("button")?.focus();
});
$("graph-group").addEventListener("change", event => {
  state.graphGroup = event.target.value;
  state.graphListLimit = 100;
  renderGraph();
});
$("graph-mode").addEventListener("change", event => {
  const list = event.target.value === "list";
  $("graph").hidden = list;
  $("graph-list-panel").hidden = !list;
  for (const id of ["fit", "snapshot-btn", "living-toggle", "labels", "graph-search", "path-btn", "manual-graph", "relayout"]) {
    $(id).hidden = list;
  }
  if (!list) {
    graph.setMode(event.target.value);
    graph.resize();
  }
  renderGraph();
});

async function openGraphItem(id) {
  state.graphFocusId = null;
  const file = state.data.files.find(item => item.id === id);
  if (file) {
    state.graphFocusId = id;
    renderGraph();
    await openFile(file.noteId, file);
  } else await openNote(id, false, "note");
}

const HOME_KEYS = {dismissed: "xotira-home-dismissed"};
function homeFlag(key) { try { return localStorage.getItem(key) === "1"; } catch { return false; } }
function setHomeFlag(key) { try { localStorage.setItem(key, "1"); } catch { /* private mode */ } }

async function loadTelemetry() {
  try { state.telemetry = await request("/telemetry"); } catch { state.telemetry = null; }
}
const needsConsent = () => Boolean(state.telemetry?.available && state.telemetry.required && state.telemetry.consent !== true);
function askConsent() {
  const dialog = $("stats-gate");
  $("stats-gate-preview").textContent = JSON.stringify(state.telemetry.preview, null, 2);
  $("stats-gate-error").hidden = true;
  return new Promise(resolve => {
    const finish = ok => { dialog.close(); resolve(ok); };
    $("stats-agree").onclick = async () => {
      try {
        state.telemetry = await request("/telemetry", {body: {consent: true}});
        finish(true);
      } catch (error) {
        $("stats-gate-error").textContent = error.message;
        $("stats-gate-error").hidden = false;
      }
    };
    $("stats-quit").onclick = () => finish(false);
    dialog.oncancel = event => event.preventDefault(); // Escape cannot skip the agreement
    dialog.showModal();
  });
}
async function requireConsent() {
  await loadTelemetry();
  if (needsConsent() && !await askConsent()) { $("lock").click(); return false; }
  return true;
}
async function setConsent(value) {
  state.telemetry = await request("/telemetry", {body: {consent: value}});
  if (!value && !await requireConsent()) return;
  renderHomeView();
}
const aiPanel = setupAIPanel($("ai-panel"), {
  request,
  currentNote: () => state.view === "note" ? state.note : null,
  flush,
  changed: async ids => {
    if (ids.includes(state.note?.id)) {
      const note = await request("/notes/" + state.note.id);
      if (state.unlocked && state.note?.id === note.id) renderEditor(note);
    }
    await refresh();
  },
});
for (const id of ["open-ai-chat", "note-ai-chat"]) {
  $(id).addEventListener("click", () => void aiPanel.open());
}
$("open-ai-providers").addEventListener("click", () => void aiPanel.open({section: "settings"}));

let fbScreenshot = "";
let fbImageRead = 0;
const fbSend = $("feedback-form").querySelector('button[type="submit"]');
function setFeedbackScreenshot(dataUrl) {
  fbImageRead++;
  fbSend.disabled = false;
  fbScreenshot = dataUrl;
  const img = $("fb-shot-img");
  if (dataUrl) img.src = dataUrl;
  else img.removeAttribute("src");
  $("fb-shot-preview").hidden = !dataUrl;
}
function openFeedback() {
  $("fb-error").hidden = true;
  setFeedbackScreenshot("");
  $("feedback-dialog").showModal();
  $("fb-message").focus();
}
$("open-feedback")?.addEventListener("click", openFeedback);
$("fb-cancel")?.addEventListener("click", () => $("feedback-dialog").close());
$("fb-capture")?.addEventListener("click", () => $("fb-file").click());
$("fb-shot-clear")?.addEventListener("click", () => setFeedbackScreenshot(""));
$("feedback-dialog")?.addEventListener("close", () => setFeedbackScreenshot(""));
$("fb-file")?.addEventListener("change", async event => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const sequence = ++fbImageRead;
  const error = $("fb-error");
  error.hidden = true;
  const preview = $("fb-shot-img");
  const fail = () => {
    error.textContent = t("fb-image-error");
    error.hidden = false;
    fbSend.disabled = false;
  };
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 1_000_000) {
    fail();
    return;
  }
  fbSend.disabled = true;
  const reader = new FileReader();
  reader.onload = async () => {
    if (sequence !== fbImageRead) return;
    const image = new Image();
    image.src = reader.result;
    try { await image.decode(); }
    catch { if (sequence === fbImageRead) fail(); return; }
    if (sequence === fbImageRead) {
      preview.alt = file.name;
      setFeedbackScreenshot(reader.result);
    }
  };
  reader.onerror = () => { if (sequence === fbImageRead) fail(); };
  reader.readAsDataURL(file);
});
$("feedback-form")?.addEventListener("submit", event => {
  event.preventDefault();
  if (fbSend.disabled) return;
  fbSend.disabled = true;
  void run(async () => {
    try {
      await request("/feedback", {body: {kind: $("fb-kind").value, message: $("fb-message").value,
        contact: $("fb-contact").value, lang: document.documentElement.lang, screenshot: fbScreenshot}});
      $("fb-message").value = "";
      setFeedbackScreenshot("");
      $("feedback-dialog").close();
      status(t("fb-thanks"));
    } catch (error) {
      $("fb-error").textContent = error.message;
      $("fb-error").hidden = false;
    } finally {
      fbSend.disabled = false;
    }
  });
});
const sentFeatures = new Set();
function track(name) {
  if (state.telemetry?.consent !== true || sentFeatures.has(name)) return;
  sentFeatures.add(name);
  request("/telemetry", {body: {feature: name, lang: document.documentElement.lang}}).catch(() => {});
}
const VIEW_FEATURES = {home: "home", map: "graph", mind: "mindmap_view", db: "databases"};

function renderHomeView() {
  renderHome($("home-panel"), {
    telemetry: state.telemetry, onConsent: value => void run(() => setConsent(value)), onFeedback: openFeedback,
    onTour: () => startGuidedTour({t}),
    updateInfo: state.updateInfo,
    nodes: state.data.nodes, edges: state.data.edges, t,
    openNote: id => void run(() => openNote(id, false, "note")),
    click: id => $(id)?.click(),
    backupDone: Boolean(state.lastBackup), lastBackup: state.lastBackup,
    dismissed: homeFlag(HOME_KEYS.dismissed),
    onDismiss: () => { setHomeFlag(HOME_KEYS.dismissed); renderHomeView(); },
  });
}
window.addEventListener("xotira-lang-change", () => { if (state.unlocked && state.view === "home") renderHomeView(); });

async function refresh() {
  const sequence = ++state.refreshSequence;
  const positionRevision = state.positionRevision;
  const query = new URLSearchParams({q: $("search").value.trim(), trash: state.trash ? "1" : "0"});
  const data = await request(`/graph?${query}`);
  if (sequence !== state.refreshSequence || !state.unlocked) return;
  state.data = data;
  viewer.active?.board?.clearUnavailablePreview?.();
  for (const {view} of inlineMindViews.values()) view.active?.board?.clearUnavailablePreview?.();
  if (state.view === "mind") renderMindMaps();
  if (state.view === "home") renderHomeView();
  if (!state.trash && state.positionRevision === positionRevision) state.positions = data.positions || {};
  renderGraph();
}

function renderRelated() {
  if (!state.note) return;
  const note = state.note;
  const notesById = new Map(state.data.nodes.map(item => [item.id, item]));
  const incoming = state.data.edges.filter(([, to]) => to === note.id).map(([from]) => notesById.get(from)).filter(Boolean);
  $("backlinks").replaceChildren(...incoming.map(other => {
    const li = document.createElement("li");
    li.append(makeTrashDraggable(button(other.title, () => void run(() => openNote(other.id, false, "note"))),
      {kind: "note", id: other.id}));
    return li;
  }));
  if (!incoming.length) $("backlinks").append(emptyItem("None"));

  const outgoing = state.data.edges.filter(([from]) => from === note.id).map(([, to]) => notesById.get(to)).filter(Boolean);
  $("outlinks").replaceChildren(...outgoing.map(other => {
    const li = document.createElement("li");
    li.append(makeTrashDraggable(button(other.title, () => void run(() => openNote(other.id, false, "note"))),
      {kind: "note", id: other.id}));
    return li;
  }));
  if (!outgoing.length) $("outlinks").append(emptyItem("None"));
  const suggestions = state.trash || note.locked ? [] : suggestNoteLinks(note.id, state.data.nodes, state.data.edges);
  $("related-suggestions").hidden = !suggestions.length;
  $("suggestions-list").replaceChildren(...suggestions.map(({item, evidence}) => {
    const row = document.createElement("li");
    const entry = document.createElement("div");
    entry.className = "mention-item";
    const head = document.createElement("div");
    head.className = "mention-head";
    head.append(button(item.title, () => void run(() => openNote(item.id, false, "note"))),
      button(t("graph-link-note"), () => void run(async () => {
        const session = state.session;
        if (!await flush() || !state.unlocked || state.session !== session || state.note?.id !== note.id) return;
        if (!suggestNoteLinks(note.id, state.data.nodes, state.data.edges).some(match => match.item.id === item.id)) return;
        const label = item.title.replace(/[\\[\]]/g, " ").trim() || t("graph-link-note");
        const updated = await request(`/notes/${note.id}/append`, {body: {text: `- [${label}](xotira:${item.id})`}});
        if (state.unlocked && state.session === session && state.note?.id === note.id) renderEditor(updated);
        if (state.unlocked && state.session === session) await refresh();
      })));
    const reason = document.createElement("span");
    reason.className = "mention-snip";
    reason.textContent = t("graph-shared").replace("{items}", evidence.join(", "));
    entry.append(head, reason);
    row.append(entry);
    return row;
  }));
}

function fileRow(file, noteId, displayNote = "") {
  const item = document.createElement("li");
  const control = button("", () => void run(() => openFile(noteId, file)), {title: file.name});
  const kind = document.createElement("span");
  kind.className = "file-type";
  kind.textContent = fileLabel(file.name);
  const copy = document.createElement("span");
  copy.className = "file-copy";
  const name = document.createElement("span");
  name.textContent = file.mapTitle || file.name;
  copy.append(name);
  if (displayNote) {
    const n = document.createElement("small");
    n.textContent = displayNote;
    copy.append(n);
  }
  control.className = "file-entry";
  control.append(kind, copy);
  item.append(draggableFile(control, file, noteId));
  if (file.trashed && state.trash) {
    const actions = document.createElement("div");
    actions.className = "trash-file-actions";
    actions.append(button("Restore", () => void run(() => changeFileTrash({...file, noteId}, "restore"))),
      button("Delete", () => void run(() => changeFileTrash({...file, noteId}, "delete"))));
    item.append(actions);
  }
  return item;
}

function renderFiles() {
  const files = state.note?.attachments || [];
  $("files").replaceChildren(...files.map(file => fileRow(file, file.noteId || state.note.id)));
  if (!files.length) $("files").append(emptyItem("None"));
  $("note-attachments").textContent = files.length ? `Attachments · ${files.length}` : "Attachments";
  renderInlineMindMaps();
}

function createInlineMindView(file, noteId) {
  const card = document.createElement("article");
  card.className = "inline-mind-card";
  const header = document.createElement("header");
  const heading = document.createElement("h3");
  const title = document.createElement("span");
  heading.append(title);
  const expand = button("⤢", () => void run(() => openFile(noteId, file, noteId)));
  expand.className = "icon-btn";
  expand.setAttribute("aria-label", "Expand mind map");
  expand.title = "Expand mind map";
  const details = document.createElement("details");
  const detailsLabel = document.createElement("summary");
  detailsLabel.textContent = "Topic details";
  const inspectorHost = document.createElement("div");
  details.append(detailsLabel, inspectorHost);
  const tools = document.createElement("div");
  tools.className = "viewer-tools";
  const body = document.createElement("div");
  body.className = "inline-mind-surface";
  header.append(draggableFile(heading, file, noteId), expand);
  card.append(header, tools, body, details);
  const view = new FileViewer(body, tools, title, request, openCanvasReference, {
    ...mindMapActions, inspectorHost, inline: true,
    showInspector: () => { details.open = true; },
  });
  const expanded = viewer.active?.noteId === noteId && viewer.active.file.id === file.id;
  if (expanded && !viewer.active.board) viewer.close();
  const loading = expanded && viewer.active ? Promise.resolve() : view.open(noteId, file);
  return {card, expand, view, loading, noteId};
}

function renderInlineMindMaps() {
  const note = state.note;
  const files = !note || note.trashed || note.locked || state.trash ? [] : note.attachments.filter(file =>
    !file.trashed && (!file.noteId || file.noteId === note.id) && fileType(file.name) === "mindmap");
  const desired = new Set(files.map(file => file.id));
  for (const [id, entry] of inlineMindViews) {
    if (!desired.has(id)) {
      entry.view.close();
      entry.card.remove();
      inlineMindViews.delete(id);
    }
  }
  for (const file of files) {
    if (inlineMindViews.has(file.id)) continue;
    const entry = createInlineMindView(file, note.id);
    inlineMindViews.set(file.id, entry);
  }
  notionEditor.hydrateMindMaps();
}

function renderFileLibrary() {
  const query = formatTitle($("file-search").value);
  const files = state.files.filter(file => formatTitle(file.name + " " + file.noteTitle).includes(query));
  folderTree($("all-files"), files, file => fileRow(file, file.noteId, file.managed ? "" : file.noteTitle),
    "", state.fileFolders, Boolean(query));
  if (!files.length) $("all-files").append(emptyItem(query ? "No results" : "No files yet"));
}

async function refreshFiles() {
  const sequence = ++state.fileSequence;
  const {files} = await request("/files");
  if (!state.unlocked || sequence !== state.fileSequence) return;
  state.files = files;
  renderFileLibrary();
}

function setLibrary(mode) {
  state.library = mode;
  const files = mode === "files";
  $("notes-pane").hidden = files;
  $("file-library").hidden = !files;
  $("show-files").setAttribute("aria-pressed", String(files));
  $("empty-trash").hidden = files || !state.trash;
  updatePickers();
  if (files && state.unlocked) void run(refreshFiles);
}

function updatePickers() {
  $("attachment-file").disabled = !state.note || state.note.trashed || Boolean(state.upload);

  $("library-file-input").disabled = Boolean(state.upload);
  $("folder-input").disabled = Boolean(state.upload);
  $("menu-folder").disabled = Boolean(state.upload);
  $("map-import").disabled = Boolean(state.upload);
  $("library-picker-context").textContent = state.note && !state.note.trashed
    ? `“${state.note.title}” as the parent note` : "To a new note";
}

function setView(view) {
  ++state.openSequence;
  state.view = view;
  if (VIEW_FEATURES[view]) track(VIEW_FEATURES[view]);
  if (view === "note" && state.note) restoreInlineMindMap(state.note.id);
  if (["note", "file", "mind", "db"].includes(view) && state.sidebar && matchMedia("(max-width: 760px)").matches) {
    state.sidebar = false;
    $("workspace").classList.add("sidebar-closed");
    $("toggle-sidebar").setAttribute("aria-pressed", "false");
  }
  const splitActive = state.split && (view === "map" || view === "note") && Boolean(state.note);
  document.querySelector(".stage")?.classList.toggle("is-split", splitActive);
  $("toggle-split")?.setAttribute("aria-pressed", String(state.split));
  $("home-panel").hidden = view !== "home";
  $("nav-home").setAttribute("aria-pressed", String(view === "home"));
  $("map-panel").hidden = !splitActive && view !== "map";
  $("db-panel").hidden = view !== "db";
  $("mind-library").hidden = view !== "mind";
  $("reading-panel").hidden = !splitActive && view !== "note";
  $("viewer-panel").hidden = view !== "file";
  $("tab-map").setAttribute("aria-pressed", String(view === "map" || splitActive));
  $("nav-map").setAttribute("aria-pressed", String(view === "map" || splitActive));
  $("tab-mind").setAttribute("aria-pressed", String(view === "mind"));
  $("nav-mind").setAttribute("aria-pressed", String(view === "mind"));
  $("tab-db").setAttribute("aria-pressed", String(view === "db"));
  syncPlanningNav();
  if (view === "map" || splitActive) { graph.resize(); graph.startLoop(); }
  if (view === "home") renderHomeView();
  if (view === "db") dbView.render();
  if (view === "mind") renderMindMaps();
  if (view === "file") viewer.active?.board?.schedule();
  syncDetails();
  renderTabs();
}

function renderTabs() {
  const fileTab = $("file-tab");
  const fileTitle = viewer.active?.file.mapTitle || viewer.active?.file.name || "File";
  const tab = $("tab-file");
  fileTab.hidden = !viewer.active;
  tab.setAttribute("aria-pressed", String(state.view === "file"));
  tab.textContent = tab.title = fileTitle;
  const closeLabel = t("file-tab-close");
  $("tab-file-close").setAttribute("aria-label", closeLabel);
  $("tab-file-close").title = closeLabel;
  const mapFile = viewer.active && fileType(viewer.active.file.name) === "mindmap";
  const returnNote = Boolean(viewer.active?.returnNoteId);
  $("viewer-close").setAttribute("aria-label", returnNote ? "Back to note" : mapFile ? "Back to mind maps" : "Close");
  $("viewer-close").textContent = returnNote ? "‹ Note" : "×";
  $("viewer-note").hidden = returnNote || Boolean(viewer.active?.file.managed);
  $("note-mind-new").disabled = !state.note || state.note.trashed || Boolean(state.note.locked);
  $("viewer-download").hidden = Boolean(mapFile && viewer.active.board);
  $("viewer-trash").hidden = !viewer.active || Boolean(mapFile) || state.trash || viewer.active.file.trashed === true;
  const hasDrawing = Boolean(viewer.active?.file.drawing) && !state.trash;
  const editDrawing = $("viewer-draw-edit"), deleteDrawing = $("viewer-draw-delete");
  editDrawing.hidden = deleteDrawing.hidden = !hasDrawing;
  editDrawing.disabled = deleteDrawing.disabled = state.drawingBusy;
  $("note-tabs").replaceChildren(...state.tabs.map(item => {
    const group = document.createElement("div");
    group.className = "note-tab";
    const node = state.data.nodes.find(note => note.id === item.id);
    const title = state.note?.id === item.id ? state.note.title : node?.title || item.title;
    const selected = state.view === "note" && state.note?.id === item.id;
    group.append(
      button(title, () => void run(() => openNote(item.id, false, "note")), {title, pressed: selected}),
      button("×", () => void run(() => closeTab(item.id)), {title: "Close"}),
    );
    return group;
  }));
  if (viewer.active && state.view === "file") {
    fileTab.scrollIntoView({block: "nearest", inline: "nearest"});
  }
}

async function closeTab(id) {
  if (state.note?.id === id && !await flush()) return;
  const index = state.tabs.findIndex(tab => tab.id === id);
  state.tabs = state.tabs.filter(tab => tab.id !== id);
  if (state.note?.id === id) {
    const next = state.tabs[Math.max(index - 1, 0)];
    clearEditor();
    if (state.view === "note") {
      if (next) await openNote(next.id, false, "note");
      else setView("home");
    }
    renderGraph();
  }
  renderTabs();
}

function renderMindMaps() {
  const maps = state.data.files.filter(file => fileType(file.name) === "mindmap");
  const query = formatTitle($("mind-search").value);
  const found = maps.filter(file => formatTitle(file.mapTitle || file.name).includes(query));
  $("mind-search").hidden = !maps.length;
  $("mind-items").replaceChildren(...found.map(file => {
    const card = button("", () => void run(() => openFile(file.noteId, file)));
    card.className = "mind-map-card";
    const title = document.createElement("strong");
    title.textContent = file.mapTitle || file.name.replace(/\.mindmap$/i, "");
    const context = document.createElement("small");
    context.textContent = file.noteTitle || "";
    card.append(title);
    if (context.textContent && context.textContent !== title.textContent) card.append(context);
    return draggableFile(card, file);
  }));
  $("mind-empty").hidden = Boolean(found.length);
  $("mind-empty").textContent = maps.length ? "No matching mind maps." : "Your mind maps appear here.";
}

async function openMindMaps() {
  await viewer.flush();
  setLibrary("notes");
  if (state.trash) {
    state.trash = false;
    await refresh();
  }
  setView("mind");
}

let mapOwner = null;
function openMindCreate(attach = false) {
  if (!state.unlocked) return;
  mapOwner = state.note && !state.note.trashed && !state.note.locked ? state.note.id : null;
  $("mind-title").value = "";
  $("mind-attach").checked = Boolean(attach && mapOwner);
  $("mind-attach-label").hidden = !mapOwner;
  $("mind-attach-text").textContent = state.note ? `“${state.note.title}” as the parent note` : "";
  $("mind-create-error").hidden = true;
  $("mind-create-dialog").showModal();
  $("mind-title").focus();
}

async function createMindMap(payload) {
  if (!await flush()) throw new Error("Save the open note first.");
  await viewer.flush();
  const file = await request("/mind-maps", {body: payload});
  if (payload.noteId && state.note?.id === file.noteId) {
    state.note.attachments.push(file);
    if (state.sourceMode) setSourceMode(false);
    renderFiles();
    notionEditor.emit();
    setView("note");
    inlineMindViews.get(file.id)?.expand.scrollIntoView({block: "nearest"});
    void run(refresh);
  } else {
    await refresh();
    await openFile(file.noteId, file);
  }
}

$("mind-new").addEventListener("click", () => openMindCreate());
$("note-mind-new").addEventListener("click", () => openMindCreate(true));
$("mind-search").addEventListener("input", renderMindMaps);
$("mind-cancel").addEventListener("click", () => $("mind-create-dialog").close());
$("mind-create-form").addEventListener("submit", event => {
  event.preventDefault();
  const submit = $("mind-create-submit");
  submit.disabled = true;
  void (async () => {
    try {
      await createMindMap({title: $("mind-title").value,
        noteId: $("mind-attach").checked ? mapOwner : null});
      $("mind-create-dialog").close();
    } catch (error) {
      $("mind-create-error").textContent = error.message;
      $("mind-create-error").hidden = false;
    } finally { submit.disabled = false; }
  })();
});
$("mind-import").addEventListener("change", event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  void run(async () => {
    if (file.size > 2 * 1024 * 1024) throw new Error("Mind maps must be 2 MiB or smaller.");
    const map = readMindMap(await file.text());
    await createMindMap({map});
  });
});

async function openFile(noteId, file, returnNoteId = null) {
  if (!state.unlocked) return;
  const sequence = ++state.openSequence;
  if (viewer.active?.noteId === noteId && viewer.active.file.id === file.id) {
    if (returnNoteId) viewer.active.returnNoteId = returnNoteId;
    setView("file");
    return;
  }
  if (!await flush()) return;
  await viewer.flush();
  if (!state.unlocked || sequence !== state.openSequence) return;
  $("viewer-drawing-error").hidden = true;
  if (state.note) restoreInlineMindMap(state.note.id);
  const inline = inlineMindViews.get(file.id);
  if (inline) {
    await inline.loading;
    if (!state.unlocked || sequence !== state.openSequence) return;
    viewer.close();
    if (inline.view.moveMindMapTo(viewer)) {
      viewer.active.returnNoteId = noteId;
      if (state.inspector && matchMedia("(max-width: 760px)").matches) setInspector(false);
      setView("file");
      return;
    }
  }
  const opening = viewer.open(noteId, file, !state.trash && !file.trashed);
  const opened = viewer.active;
  if (returnNoteId) opened.returnNoteId = returnNoteId;
  setView("file");
  await opening;
  if (viewer.active === opened && state.view === "file") renderTabs();
}

function restoreInlineMindMap(noteId) {
  const session = viewer.active;
  if (!session || session.noteId !== noteId) return null;
  const entry = inlineMindViews.get(session.file.id);
  if (entry && viewer.moveMindMapTo(entry.view)) return entry;
  return null;
}

async function openCanvasReference(canvas, reference, subpath) {
  if (!reference) return false;
  const path = reference.replace(/\\/g, "/");
  const normalizePath = value => {
    const parts = [];
    for (const piece of value.split("/")) {
      if (piece === "..") { if (!parts.length) return ""; parts.pop(); }
      else if (piece && piece !== ".") parts.push(piece);
    }
    return formatTitle(parts.join("/"));
  };
  const directory = canvas.path?.split("/").slice(0, -1).join("/") || "";
  const root = normalizePath(path);
  const relative = normalizePath(directory + "/" + path);
  const pool = [...state.data.nodes, ...state.data.files].filter(item => !canvas.source || item.source === canvas.source);
  const exact = value => pool.find(item => item.path && normalizePath(item.path) === value);
  let item = exact(root) || exact(relative);
  if (!item && !path.includes("/")) {
    const options = pool.filter(entry => formatTitle(entry.name || (entry.title + ".md")) === root);
    if (options.length === 1) [item] = options;
  }
  if (!item) return false;
  if (item.noteId) await openFile(item.noteId, item);
  else await openNote(item.id, false, "note", typeof subpath === "string" ? subpath.replace(/^#/, "") : "");
  return true;
}

async function moveGraphItem(id, position) {
  const session = state.session;
  const previous = state.positionWrites.get(id);
  const write = {position, promise: null};
  write.promise = (previous?.promise.catch(() => {}) || Promise.resolve()).then(async () => {
    if (!state.unlocked || session !== state.session) return;
    await request("/graph/position", {body: {id, position}});
    if (state.unlocked && session === state.session) {
      state.positions[id] = position;
      state.positionRevision++;
    }
  });
  state.positionWrites.set(id, write);
  try { await write.promise; }
  catch (error) {
    if (state.positionWrites.get(id) === write) {
      state.positionWrites.delete(id);
      graph.restorePosition(id, state.positions[id]);
      renderGraph();
    }
    throw error;
  }
  finally { if (state.positionWrites.get(id) === write) state.positionWrites.delete(id); }
}

function setSourceMode(source) {
  state.sourceMode = source;
  $("toggle-source").setAttribute("aria-pressed", String(source));
  $("notion-editor").hidden = source;
  $("body").hidden = !source;
  if (!source) notionEditor.setValue($("body").value, Boolean(state.note?.trashed || state.note?.locked));
}

function notePrefix() {
  if (!state.metadata) return "";
  const {prefix, start, raw, end} = state.metadata;
  const current = $("properties-source").value;
  const separator = !end.endsWith("\n") && $("body").value ? "\n" : "";
  if (current === raw.replace(/\r\n/g, "\n")) return prefix + separator;
  return start + current + (current && !current.endsWith("\n") ? "\n" : "") + end + separator;
}

function showProperties() {
  const raw = state.metadata ? $("properties-source").value : splitFrontmatter($("body").value)?.raw;
  $("note-properties").hidden = raw === undefined;
  if (raw !== undefined) renderProperties($("properties-list"), raw);
}

function clearImages() {
  for (const entry of state.imageUrls.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  state.imageUrls.clear();
}

function invalidateImage(id) {
  const entry = state.imageUrls.get(id);
  if (entry?.url) URL.revokeObjectURL(entry.url);
  state.imageUrls.delete(id);
}

function imageControl(file, label) {
  const control = button("", () => void run(() => openFile(file.noteId, file)));
  const content = document.createElement("span");
  content.textContent = label;
  control.append(content);
  draggableFile(control, file);
  if (!/\.(?:png|jpe?g|gif|webp|avif|bmp)$/i.test(file.name)) return control;
  control.className = "embedded-image";
  const image = document.createElement("img");
  image.alt = label;
  image.draggable = false;
  let entry = state.imageUrls.get(file.id);
  if (!entry) {
    entry = {url: "", promise: null};
    const savedEntry = entry;
    entry.promise = request(`/notes/${file.noteId}/files/${file.id}`, {blob: true})
      .then(r => r.blob()).then(blob => {
        if (state.imageUrls.get(file.id) !== savedEntry) return "";
        const suffix = file.name.split(".").pop().toLowerCase();
        savedEntry.url = URL.createObjectURL(new Blob([blob], {type: "image/" + (suffix === "jpg" ? "jpeg" : suffix)}));
        return savedEntry.url;
      }).catch(() => "");
    state.imageUrls.set(file.id, entry);
  }
  const setImg = url => { if (url) { image.src = url; content.replaceChildren(image); } };
  if (entry.url) setImg(entry.url);
  else void entry.promise.then(setImg);
  return control;
}

function syncPageProps() {
  const meta = noteFields(state.note);
  const disabled = Boolean(state.note?.trashed);
  for (const id of ["prop-status", "prop-priority", "prop-due", "prop-type", "cycle-cover", "prop-reminder"]) {
    $(id).disabled = disabled;
  }
  $("prop-type").value = meta.type;
  const st = $("prop-status");
  const pr = $("prop-priority");
  const due = $("prop-due");
  const cov = $("note-cover");
  if (st) {
    st.value = meta.status || "note";
    const cls = (STATUS_LIST.find(s => s.id === st.value) || STATUS_LIST[0]).cls;
    st.className = `db-status-pick ${cls}`;
  }
  if (pr) {
    pr.value = meta.priority || "";
    const cls = (PRIORITY_LIST.find(p => p.id === pr.value) || PRIORITY_LIST[0]).cls;
    pr.className = `db-prio-pick ${cls}`;
  }
  if (due) due.value = meta.due || "";
  syncReminderInput();
  if (cov) {
    cov.className = "note-cover" + (meta.cover ? " " + meta.cover : "");
    cov.hidden = !meta.cover;
  }
}

function syncReminderInput() {
  const input = $("prop-reminder");
  const at = state.reminders[state.note?.id] || "";
  if (document.activeElement !== input) input.value = localDateTime(at);
  $("export-reminder").hidden = !at || Boolean(state.note?.trashed);
}

function dueReminders() {
  if (!state.unlocked || state.trash) return [];
  const now = Date.now();
  return state.data.nodes.map(note => ({note, at: state.reminders[note.id]}))
    .filter(item => item.at && Date.parse(item.at) <= now).sort((a, b) => a.at.localeCompare(b.at));
}

function renderReminders() {
  const due = dueReminders();
  const trigger = $("show-reminders");
  trigger.hidden = !due.length;
  trigger.textContent = due.length === 1 ? "1 due reminder" : `${due.length} due reminders`;
  const dialog = $("reminder-dialog");
  if (!dialog.open) return;
  const content = due.map(({note, at}) => {
    const item = document.createElement("li");
    item.className = "reminder-row";
    const view = button(note.title, () => {
      dialog.close();
      void run(() => openNote(note.id, false, "note"));
    });
    const when = document.createElement("time");
    when.dateTime = at;
    when.textContent = new Date(at).toLocaleString();
    const dismiss = button("Dismiss", () => void run(() => changeReminder(note.id, "")));
    item.append(view, when, dismiss);
    return item;
  });
  $("reminder-list").replaceChildren(...(due.length ? content : [emptyItem("You're up to date.")]));
}

function syncReminders(next) {
  const changed = Object.keys(next).length !== Object.keys(state.reminders).length ||
    Object.entries(next).some(([id, at]) => state.reminders[id] !== at);
  state.reminders = next;
  dbView.reminders = next;
  syncReminderInput();
  renderReminders();
  if (changed && state.view === "db" && dbView.mode === "calendar") dbView.render();
}

async function refreshReminders() {
  const sequence = ++state.reminderSequence;
  const {reminders} = await request("/reminders");
  if (state.unlocked && sequence === state.reminderSequence) syncReminders(reminders);
}

async function changeReminder(id, at) {
  const session = state.session;
  try {
    await request("/reminders", {body: {noteId: id, at, expected: state.reminders[id] || ""}});
  } finally {
    if (state.unlocked && session === state.session) await refreshReminders();
  }
}

$("prop-reminder").addEventListener("change", event => void run(async () => {
  const note = state.note;
  if (!note || note.trashed) return;
  const input = event.target;
  try { await changeReminder(note.id, utcReminder(input.value)); }
  finally { if (state.note?.id === note.id) input.value = localDateTime(state.reminders[note.id] || ""); }
}));
$("show-reminders").addEventListener("click", () => {
  $("reminder-dialog").showModal();
  renderReminders();
});
$("reminder-close").addEventListener("click", () => $("reminder-dialog").close());
$("export-reminder").addEventListener("click", () => {
  const note = state.note;
  const at = state.reminders[note?.id];
  if (!at) return;
  const file = new Blob([reminderCalendarFile(note.id, note.title, at)], {type: "text/calendar;charset=utf-8"});
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url; link.download = "xotira-reminder.ics"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
});

function updateNavButtons() {
  if ($("nav-back")) $("nav-back").disabled = state.histIdx <= 0;
  if ($("nav-forward")) $("nav-forward").disabled = state.histIdx >= state.history.length - 1;
}

function forgetNotes(ids) {
  const before = state.history.slice(0, state.histIdx + 1);
  state.history = state.history.filter(id => !ids.has(id));
  state.histIdx = before.filter(id => !ids.has(id)).length - 1;
  updateNavButtons();
}

async function loadAllVaultTasks() {
  const {tasks} = await request("/tasks");
  return tasks;
}

async function toggleVaultTask(task) {
  if (!await flush()) throw new Error("Save the open note first.");
  const note = await request("/tasks", {body: task});
  if (state.note?.id === task.noteId) renderEditor(note);
  return loadAllVaultTasks();
}

function renderEditor(note, historyIndex = null) {
  stopVoiceDictation();
  clearImages();
  if (state.note?.id !== note.id) state.graphFocusId = null;
  state.note = note;
  if (historyIndex !== null) state.histIdx = historyIndex;
  else if (!note.trashed && state.history[state.histIdx] !== note.id) {
    state.history = state.history.slice(0, state.histIdx + 1);
    state.history.push(note.id);
    state.histIdx = state.history.length - 1;
  }
  updateNavButtons();
  syncPageProps();
  if (!state.tabs.some(tab => tab.id === note.id)) state.tabs.push({id: note.id, title: note.title});
  state.dirty = false;
  state.editVersion += 1;
  clearTimeout(state.timer);
  $("no-selection").hidden = true;
  $("editor-content").hidden = false;
  $("title").value = note.title;
  $("tags").value = note.tags.join(", ");
  state.metadata = splitFrontmatter(note.body);
  $("properties-source").value = state.metadata?.raw || "";
  $("properties-source").readOnly = note.trashed;
  $("body").value = note.body.slice(state.metadata?.prefix.length || 0);
  $("title").readOnly = $("tags").readOnly = $("body").readOnly = note.trashed || Boolean(note.locked);
  $("draw-note").disabled = $("note-mind-new").disabled = note.trashed || Boolean(note.locked);
  if ($("lock-note-btn")) {
    $("lock-note-btn").textContent = note.locked ? "🔒 Locked" : (note.hasPassword ? "🔐" : "🔒");
    $("lock-note-btn").disabled = Boolean(note.trashed);
  }
  $("remove").hidden = note.trashed;
  $("restore").hidden = !note.trashed;
  $("purge-note").hidden = !note.trashed;
  $("reader-path").textContent = note.path ? [note.source, ...note.path.split("/").slice(0, -1)].join(" / ") : "Notes";
  showProperties();
  setSourceMode(false);
  updateNoteStats();
  updateWordGoalBadge();
  if ($("reading-progress-fill")) $("reading-progress-fill").style.width = "0%";
  renderOutline();
  renderFiles();
  renderGraph();
  void loadMentions(note.id);
  saved(note.trashed ? "In Trash" : "Saved");
}

function scheduleSave() {
  if (!state.note || state.note.trashed) return;
  state.dirty = true;
  state.editVersion += 1;
  saved("Saving…");
  clearTimeout(state.timer);
  state.timer = setTimeout(() => void flushNote(), 450);
  updateNoteStats();
  renderOutline();
  showProperties();
  touch();
}

async function saveDraft() {
  const note = state.note;
  if (!note || !state.unlocked) return false;
  const session = state.session;
  const editVersion = state.editVersion;
  const attachmentsBeforeSave = new Set(note.attachments.map(file => file.id));
  const content = {
    title: $("title").value,
    tags: $("tags").value.split(",").map(tag => tag.trim()).filter(Boolean),
    body: notePrefix() + $("body").value, revision: note.revision,
  };
  try {
    const updated = await request(`/notes/${note.id}`, {body: content});
    if (state.note?.id !== note.id || !state.unlocked || session !== state.session) return false;
    const attachments = mergeSavedAttachments(attachmentsBeforeSave, state.note.attachments, updated.attachments);
    const entity = state.note.entity?.revision > updated.entity?.revision ? state.note.entity : updated.entity;
    state.note = {...updated, entity, attachments};
    renderFiles();
    if (state.editVersion === editVersion) {
      state.dirty = false;
      $("title").value = updated.title;
      saved("Saved");
    }
    void run(refresh);
    return true;
  } catch (error) {
    if (state.unlocked && session === state.session) saved(error.message, true);
    return false;
  }
}

async function flushNote() {
  clearTimeout(state.timer);
  while (state.dirty) {
    if (!state.saving) {
      const saving = saveDraft().finally(() => {
        if (state.saving === saving) state.saving = null;
      });
      state.saving = saving;
    }
    if (!await state.saving) return false;
  }
  return true;
}

async function flush() {
  if (!await flushNote()) return false;
  try {
    await Promise.all([viewer.active?.markup?.flush(), ...[...inlineMindViews.values()].map(entry => entry.view.flush())]);
    return true;
  } catch (error) {
    if (state.unlocked) status(error.message, true);
    return false;
  }
}

async function openNote(id, focus = false, view = "note", heading = "", historyIndex = null) {
  if (!state.unlocked) return;
  const sequence = ++state.openSequence;
  if (id === state.note?.id) {
    if (view === "note" && viewer.active?.returnNoteId === id) {
      await viewer.flush();
      if (!state.unlocked || sequence !== state.openSequence) return;
      restoreInlineMindMap(id);
    }
    if (historyIndex !== null) {
      state.histIdx = historyIndex;
      updateNavButtons();
    }
    setView(view);
    if (heading) jumpToHeading(heading);
    return;
  }
  if (!await flush() || !state.unlocked || sequence !== state.openSequence) return;
  const note = await request(`/notes/${id}`);
  if (!state.unlocked || sequence !== state.openSequence) return;
  renderEditor(note, historyIndex);
  if (view === "note") $("reading-panel").querySelector(".note-page").scrollTop = 0;
  setView(view);
  if (heading) jumpToHeading(heading);
  if (focus) notionEditor.focusBlock(0);
}

function decodeLinkPart(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function jumpToHeading(heading) {
  if (!heading) return;
  const candidates = [...$("notion-editor").querySelectorAll("h1, h2, h3, h4, h5, h6")];
  const decoded = formatTitle(decodeLinkPart(heading));
  const plain = formatTitle(heading);
  const slug = text => text.replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "").replace(/\s+/g, "-");
  const target = candidates.find(el => formatTitle(el.textContent) === plain) ||
    candidates.find(el => formatTitle(el.textContent) === decoded) ||
    candidates.find(el => slug(formatTitle(el.textContent)) === decoded);
  target?.scrollIntoView({behavior: "smooth", block: "start"});
}

async function newNotes(notes) {
  if (!await flush()) throw new Error("Save the open note first.");
  const result = await request("/notes", {body: {notes}});
  state.trash = false;
  state.tag = null;
  state.focused = false;
  state.graphFocusId = null;
  $("search").value = "";
  await refresh();
  return result.ids;
}

async function openDailyNote() {
  const date = todayISO();
  const title = `Daily note — ${date}`;
  const titles = new Set([title, `Kundalik — ${date}`].map(formatTitle));
  const existing = state.data.nodes.find(note => titles.has(formatTitle(note.title)));
  if (existing) { await openNote(existing.id, false, "note"); return; }
  const tpl = NOTE_TEMPLATES[0];
  const [id] = await newNotes([{title, body: tpl.body(), tags: tpl.tags}]);
  await openNote(id, true, "note");
}

async function createFromTemplate(tpl) {
  const [id] = await newNotes([{title: tpl.title(), body: tpl.body(), tags: tpl.tags, useAvailableTitle: true}]);
  $("template-dialog").close();
  await openNote(id, true, "note");
  return id;
}

let newEventDate = "";
function openCreateDialog(eventDate = "") {
  newEventDate = eventDate;
  $("create-heading").textContent = eventDate ? "New calendar event" : "New note";
  $("create-context").hidden = !eventDate;
  $("create-context").textContent = eventDate;
  $("new-title").value = "";
  $("create-error").hidden = true;
  $("create-dialog").showModal();
  $("new-title").focus();
}

function buildCommandItems() {
  const actions = [
    {icon: "⌕", title: "Search vault", group: "Search", shortcut: "⌘⇧K", action: openVaultSearch},
    {icon: "+", title: "New note", group: "Action", action: () => openCreateDialog()},
    {icon: "•", title: "Daily note", group: "Action", shortcut: "⌘D", action: () => void run(openDailyNote)},
    {icon: "○", title: "3D graph", group: "View", action: () => setView("map")},
    {icon: "⊞", title: "Databases (Table / Gallery / Kanban)", group: "View", action: () => setView("db")},
    {icon: "○", title: "Local agent", group: "Action", action: () => void run(openAgentModal)},
    {icon: "✦", title: "Templates", group: "Template", action: () => openTemplateModal()},
    {icon: "↓", title: "Import vault or folder", group: "Import", action: () => $("folder-input").click()},
  ];
  const notes = state.data.nodes.map(n => ({
    icon: n.pinned ? "★" : "—",
    title: n.title,
    subtitle: n.path || (n.tags || []).map(t => "#" + t).join(" "),
    group: "Note",
    action: () => void run(() => openNote(n.id, false, "note")),
  }));
  const files = state.data.files.map(f => ({
    icon: "▫",
    title: f.name,
    subtitle: f.path || f.noteTitle || "File",
    group: "File",
    action: () => void run(() => openFile(f.noteId, f)),
  }));
  return [...actions, ...notes, ...files];
}

const searchDialog = $("search-dialog");
let lookupAbort;
let lookupTimer;
function openVaultSearch() {
  if (!state.unlocked) return;
  searchDialog.showModal();
  $("vault-query").focus();
  queryVault();
}
function queryVault() {
  clearTimeout(lookupTimer);
  lookupAbort?.abort();
  const value = $("vault-query").value.trim();
  const results = $("search-results");
  results.replaceChildren();
  const message = $("search-results-status");
  message.textContent = value ? "Searching…" : "";
  if (!value) return;
  const controller = new AbortController();
  lookupAbort = controller;
  lookupTimer = setTimeout(() => void (async () => {
    try {
      const params = new URLSearchParams({q: value});
      if ($("search-semantic")?.checked) params.set("mode", "semantic");
      const data = await request(`/search?${params}`, {signal: controller.signal});
      if (!searchDialog.open || controller.signal.aborted) return;
      message.textContent = data.results.length || data.files.length ? "" : "No results.";
      const entries = [
        ...data.results.map(item => ({id: item.id, title: item.title, details: item.snippet})),
        ...data.files.map(item => ({...item, title: item.name, details: item.path})),
      ];
      for (const item of entries) {
        const row = document.createElement("li");
        row.append(button(item.title, () => {
          searchDialog.close();
          void run(async () => {
            if (!item.noteId) return openNote(item.id);
            const note = await request(`/notes/${item.noteId}`);
            const file = note.attachments.find(attachment => attachment.id === item.id);
            if (file) await openFile(item.noteId, file);
          });
        }));
        if (item.details) {
          const detail = document.createElement("p");
          detail.textContent = item.details;
          row.append(detail);
        }
        results.append(row);
      }
    } catch (error) {
      if (searchDialog.open && !controller.signal.aborted) message.textContent = error.message;
    }
  })(), 120);
}
$("vault-query").addEventListener("input", queryVault);
$("search-dialog-close").addEventListener("click", () => searchDialog.close());
searchDialog.addEventListener("close", () => {
  clearTimeout(lookupTimer);
  lookupAbort?.abort();
  $("search-results").replaceChildren();
});

async function openAgentModal() {
  const cfg = await request("/agent/config");
  updateAgentModalUI(cfg);
  $("agent-dialog").showModal();
  await refreshAgentProposals();
}

function updateAgentModalUI(cfg) {
  $("agent-enabled").checked = Boolean(cfg.enabled);
  $("agent-proposals").checked = Boolean(cfg.proposals);
  $("agent-proposals").disabled = !cfg.enabled;
  $("agent-credentials").hidden = !cfg.enabled;
  if (!cfg.enabled) $("agent-credentials").open = false;
  $("agent-key").type = "password";
  $("agent-key-show").textContent = "Show key";
  $("agent-url").value = cfg.url;
  $("agent-key").value = cfg.key;
  $("agent-python-snippet").textContent =
`import urllib.request, urllib.parse, json

BRAIN_URL = "${cfg.url}"
BRAIN_KEY = "${cfg.key}"

def get_brain_context(query: str, max_chars: int = 10000) -> str:
    qs = urllib.parse.urlencode({"q": query, "max_chars": max_chars, "hops": 1})
    req = urllib.request.Request(f"{BRAIN_URL}/api/agent/context?{qs}", headers={"X-Brain-Key": BRAIN_KEY})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())["context"]`;

  $("agent-mcp-snippet").textContent = JSON.stringify({
    mcpServers: {
      "xotira-brain": {
        command: "python3",
        args: [cfg.bridgePath],
        env: {XOTIRA_BRAIN_URL: cfg.url, XOTIRA_BRAIN_KEY: cfg.key},
      },
    },
  }, null, 2);
}

async function refreshAgentProposals() {
  const panel = $("agent-review");
  const message = $("agent-review-status");
  const {proposals} = await request("/review-agent");
  if (!$("agent-dialog").open) return;
  panel.replaceChildren();
  message.textContent = proposals.length ? "" : "No proposals awaiting review.";
  for (const proposal of proposals) {
    const section = document.createElement("section");
    const title = document.createElement("h3");
    title.textContent = (proposal.action === "append" ? "Append content · " : "Create note · ") + proposal.title;
    const content = document.createElement("pre");
    content.textContent = (proposal.tags?.length ? proposal.tags.map(tag => "#" + tag).join(" ") + "\n\n" : "")
      + proposal.text;
    const process = async decision => {
      if (!await flush()) return;
      const result = await request("/review-agent", {body: {id: proposal.id, decision}});
      if (result.note?.id === state.note?.id && state.note) {
        renderEditor(await request(`/notes/${result.note.id}`));
      }
      if (result.note) await refresh();
      await refreshAgentProposals();
    };
    for (const [label, decision] of [["Reject", "reject"], ["Approve", "approve"]]) {
      const control = button(label, () => void (async () => {
        control.disabled = true;
        try { await process(decision); }
        catch (error) { message.textContent = error.message; }
        finally { control.disabled = false; }
      })());
      section.append(control);
    }
    section.prepend(title, content);
    panel.append(section);
  }
}

for (const [id, field] of [["agent-enabled", "enabled"], ["agent-proposals", "proposals"]]) {
  $(id).addEventListener("change", () => void run(async () => {
    updateAgentModalUI(await request("/agent/config", {body: {[field]: $(id).checked}}));
    await refreshAgentProposals();
  }));
}
$("agent-close").addEventListener("click", () => $("agent-dialog").close());
$("agent-refresh").addEventListener("click", () => void run(refreshAgentProposals));
$("agent-key-show").addEventListener("click", () => {
  const key = $("agent-key");
  key.type = key.type === "password" ? "text" : "password";
  $("agent-key-show").textContent = key.type === "password" ? "Show key" : "Hide key";
});
$("agent-rotate").addEventListener("click", () => void run(async () => {
  updateAgentModalUI(await request("/agent/config", {body: {rotate: true}}));
  await refreshAgentProposals();
}));
$("agent-dialog").addEventListener("close", () => {
  $("agent-key").type = "password";
  $("agent-key").value = "";
  $("agent-key-show").textContent = "Show key";
  $("agent-python-snippet").textContent = "";
  $("agent-mcp-snippet").textContent = "";
  $("agent-review").replaceChildren();
});

function openTemplateModal() {
  const grid = $("template-grid");
  grid.replaceChildren(...NOTE_TEMPLATES.map(tpl => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "template-card";
    const t = document.createElement("strong");
    t.textContent = tpl.name;
    const s = document.createElement("small");
    s.style.color = "var(--subtle)";
    s.textContent = tpl.tags.map(x => "#" + x).join(" ");
    btn.append(t, s);
    btn.addEventListener("click", () => void run(() => createFromTemplate(tpl)));
    return btn;
  }));
  $("template-dialog").showModal();
}

function openPathModal() {
  const opts = [...state.data.nodes].sort((a, b) => a.title.localeCompare(b.title));
  $("path-start").replaceChildren(...opts.map(n => new Option(n.title, n.id)));
  $("path-end").replaceChildren(...opts.map(n => new Option(n.title, n.id)));
  if (state.note) $("path-start").value = state.note.id;
  if (opts.length > 1 && $("path-end").value === $("path-start").value) $("path-end").selectedIndex = 1;
  $("path-result").textContent = "";
  $("path-dialog").showModal();
}

async function moveToTrash(trashed, id = state.note?.id) {
  if (!id || !await flush()) return;
  await viewer.flush();
  const note = id === state.note?.id ? state.note : await request(`/notes/${id}`);
  if (note.trashed === trashed) return;
  await request(`/notes/${id}`, {body: {revision: note.revision, trashed}});
  if (trashed) forgetNotes(new Set([id]));
  state.tabs = state.tabs.filter(tab => tab.id !== id);
  if (state.note?.id === id) {
    clearEditor();
    if (state.view === "note") setView("home");
  }
  if (viewer.active?.noteId === id) {
    viewer.close();
    if (state.view === "file") setView("home");
  }
  state.focused = false;
  if (!trashed) state.trash = false;
  await refresh();
  if (state.library === "files") await refreshFiles();
  if (!trashed) await openNote(id, false, "note");
  else status("Note moved to Trash.");
}

async function changeFileTrash(file, action) {
  if (action === "delete" && !window.confirm(`“${file.mapTitle || file.name}” will be permanently deleted. Continue?`)) return;
  if (!await flush()) return;
  await viewer.flush();
  await request("/trash", {body: {action, file: {noteId: file.noteId, id: file.id}}});
  if (viewer.active?.file.id === file.id) {
    const returnNote = viewer.active.returnNoteId;
    const type = fileType(viewer.active.file.name);
    viewer.close();
    if (state.view === "file") setView(
      !state.trash && !returnNote && type === "mindmap" ? "mind" : state.note ? "note" : "map");
  }
  invalidateImage(file.id);
  if (state.note) {
    const current = state.note;
    if (action !== "restore") {
      current.attachments = current.attachments.filter(attachment => attachment.id !== file.id);
      renderFiles();
      notionEditor.hydrateImages("attachment:" + file.id);
    }
    const fresh = await request(`/notes/${current.id}`);
    if (state.note === current && !state.dirty) {
      current.attachments = fresh.attachments;
      renderFiles();
      notionEditor.hydrateImages("attachment:" + file.id);
    }
  }
  await refresh();
  if (state.library === "files") await refreshFiles();
  renderTabs();
  status(action === "move" ? "File moved to Trash." : action === "restore" ? "File restored." : "File deleted.");
}

async function deleteTrashed(all) {
  if (!state.trash || (!all && !state.note?.trashed) || !await flush()) return;
  await viewer.flush();
  const note = state.note && {id: state.note.id, revision: state.note.revision};
  if (!window.confirm(all ? "Empty Trash permanently?" : `“${state.note.title}” will be permanently deleted. Continue?`)) return;
  const {ids} = await request("/trash", {body: all ? {action: "empty"} : {action: "delete", note}});
  const deleted = new Set(ids);
  forgetNotes(deleted);
  state.tabs = state.tabs.filter(tab => !deleted.has(tab.id));
  if (deleted.has(state.note?.id)) clearEditor();
  if (viewer.active?.file.trashed || deleted.has(viewer.active?.noteId)) viewer.close();
  setView("home");
  await refresh();
}

async function download(path, fallback, saveFirst = true) {
  if (saveFirst && !await flush()) return;
  if (saveFirst) {
    await viewer.flush();
    await state.fieldWrites;
    if (!state.unlocked) return;
  }
  const response = await request(path, {blob: true});
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''(.+)$/)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : fallback;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function updateStatus() {
  const metadata = await request("/status");
  if (!state.unlocked) return metadata;
  if (!metadata.unlocked) { showGate({exists: metadata.exists}); return metadata; }
  const changed = state.lastBackup !== metadata.lastBackup;
  state.lastBackup = metadata.lastBackup;
  const backupTime = state.lastBackup ? new Date(state.lastBackup).toLocaleString() : "";
  $("backup-status").textContent = metadata.backupError || (backupTime ? `${t("backup-status")} · ${backupTime}` : "");
  if (changed && state.view === "home") renderHomeView();
  return metadata;
}

async function importLegacyFields(raw) {
  const records = JSON.parse(raw);
  if (!records || Array.isArray(records) || typeof records !== "object") {
    throw new Error("The legacy properties JSON file is invalid.");
  }
  if (!Object.keys(records).length) return;
  await state.fieldWrites;
  const result = await request("/entities/migrate", {body: {records}});
  if (state.note) {
    state.note.entity = await request(`/notes/${state.note.id}/entity`);
    syncPageProps();
  }
  await refresh();
  status(`Migrated: ${result.updated}. Already present: ${result.unchanged}. Conflicts: ${result.conflicts}. Invalid: ${result.invalid}. Missing note: ${result.missing}.`,
    Boolean(result.invalid || result.conflicts || result.missing));
}

$("import-properties").addEventListener("click", () => $("legacy-properties-file").click());
$("legacy-properties-file").addEventListener("change", event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  void run(async () => {
    if (file.size > 16 * 1024 * 1024) throw new Error("The JSON file can be up to 16 MB.");
    await importLegacyFields(await file.text());
  });
});

async function showWorkspace() {
  state.unlocked = true;
  state.exists = true;
  $("password").value = $("confirmation").value = "";
  $("gate").hidden = true;
  $("workspace").hidden = false;
  $("workspace").classList.toggle("sidebar-closed", !state.sidebar);
  $("toggle-sidebar").setAttribute("aria-pressed", String(state.sidebar));
  graph.resize();
  if (!await requireConsent()) return;
  const currentSession = state.session;
  const currentSavedViewSequence = savedViewSequence;
  void run(async () => {
    const {views} = await request("/database/views");
    if (!state.unlocked || state.session !== currentSession || currentSavedViewSequence !== savedViewSequence) return;
    dbView.savedViews = views;
    if (state.view === "db") dbView.render();
  });
  void request("/updates").then(info => {
    if (state.unlocked && state.session === currentSession) {
      state.updateInfo = info;
      if (state.view === "home") renderHomeView();
    }
  }).catch(() => {});
  await refresh();
  setView("home");
  await Promise.all([refreshReminders(), updateStatus()]);
  await run(async () => {
    const legacy = localStorage.getItem(LEGACY_FIELDS_KEY);
    if (legacy) await importLegacyFields(legacy);
  });
}

// Drawing commands operate on the viewer's captured attachment session.
function drawingPath(noteId, file) {
  return `/notes/${noteId}/files${file ? "/" + file.id : ""}?view=drawing`;
}

async function loadDrawingDraft(session) {
  if (!session || viewer.active !== session || !state.unlocked || state.trash || !session.file.drawing) {
    throw new Error("Reopen the drawing first.");
  }
  const {noteId, file} = session;
  const saved = await request(drawingPath(noteId, file), {signal: session.abort.signal});
  if (viewer.active !== session) throw new Error("Reopen the drawing first.");
  return {...saved, noteId, file, session};
}

async function withViewerDrawing(action) {
  const session = viewer.active;
  if (!session?.file.drawing || state.drawingBusy || state.trash || $("draw-dialog").open) return;
  state.drawingBusy = true;
  const message = $("viewer-drawing-error");
  message.hidden = true;
  renderTabs();
  try {
    await action(session);
  } catch (error) {
    if (viewer.active !== session) throw error;
    message.textContent = error.message;
    message.hidden = false;
  } finally {
    state.drawingBusy = false;
    renderTabs();
  }
}

const showDrawing = setupDrawing($("draw-dialog"), async (draft, imageData) => {
  if (!state.unlocked || !await flush()) throw new Error("Save the note first.");
  const reader = new FileReader();
  const base64 = await new Promise((res, rej) => {
    reader.onload = () => res(reader.result.split(",", 2)[1]);
    reader.onerror = () => rej(new Error("Could not read the image."));
    reader.readAsDataURL(imageData.image);
  });
  const data = {strokes: imageData.strokes, keepBase: imageData.keepBase, image: base64};
  if (draft.file) {
    if (viewer.active !== draft.session) throw new Error("Reopen the drawing first.");
    await request(drawingPath(draft.noteId, draft.file), {
      body: {...data, revision: draft.revision},
    });
    if (!state.unlocked) return;
    invalidateImage(draft.file.id);
    notionEditor.hydrateImages(`attachment:${draft.file.id}`);
    if (viewer.active === draft.session) {
      const opening = viewer.open(draft.noteId, draft.file);
      renderTabs();
      void opening.then(renderTabs);
    }
  } else {
    const note = state.note;
    if (!note || note.id !== draft.noteId) throw new Error("Reopen the note first.");
    const result = await request(drawingPath(draft.noteId), {
      body: {...data, revision: note.revision, offset: Array.from(note.body).length},
    });
    if (state.unlocked && state.note?.id === draft.noteId) renderEditor(result.note);
  }
  void run(refresh);
}, draft => loadDrawingDraft(draft.session));

async function deleteViewerDrawing(session) {
  const {noteId, file} = session;
  const owner = state.data.nodes.find(note => note.id === noteId)?.title || "its note";
  if (!window.confirm(`Permanently delete “${file.name}” from “${owner}”?`)) return;
  if (!await flush() || viewer.active !== session) return;
  const note = state.note?.id === noteId ? state.note : await request(`/notes/${noteId}`);
  if (!state.unlocked || viewer.active !== session) return;
  const updated = await request(drawingPath(noteId, file), {
    body: {delete: true, revision: note.revision},
  });
  if (!state.unlocked) return;
  invalidateImage(file.id);
  if (state.note?.id === noteId) renderEditor(updated);
  if (viewer.active === session) {
    viewer.close();
    if (state.view === "file") setView(state.note ? "note" : "map");
  }
  status("Drawing deleted.");
  await refresh();
  if (state.library === "files") await refreshFiles();
}

$("viewer-draw-edit").addEventListener("click", () => void run(() =>
  withViewerDrawing(async session => showDrawing(await loadDrawingDraft(session)))));
$("viewer-draw-delete").addEventListener("click", () => void run(() => withViewerDrawing(deleteViewerDrawing)));

async function importFolder(files) {
  if (!files.length || state.upload || !state.unlocked) return;
  const packet = folderPacket(files);
  const controller = new AbortController();
  state.upload = controller;
  state.folderImport = true;
  updatePickers();
  try {
    if (!await flush()) throw new Error("Save the open note first.");
    status(`Importing ${packet.count} files…`);
    const counts = await request("/import/folder", {file: packet.body, signal: controller.signal});
    state.trash = false; state.tag = null; state.focused = false;
    state.folders.add(packet.source);
    setLibrary("notes");
    await refresh();
    setView("map");
    graph.reheat();
    graph.fit();
    status(`${counts.notes} notes · ${counts.files} files imported.`
      + (counts.frontmatterWarnings ? ` Original YAML kept in ${counts.frontmatterWarnings} notes.` : ""));
  } finally {
    if (state.upload === controller) { state.upload = null; state.folderImport = false; }
    updatePickers();
  }
}

async function attachFiles(files, {embedImages = false} = {}) {
  if (!files.length || state.upload || !state.unlocked) return;
  const large = files.find(file => file.size > MAX_ATTACHMENT);
  if (large) throw new Error(`“${large.name}” exceeds the 64 MiB attachment limit.`);
  const controller = new AbortController();
  const session = state.session;
  let attached = 0;
  const embeddedLines = [];
  state.upload = controller;
  updatePickers();
  try {
    let target = state.note?.trashed ? null : state.note?.id;
    if (!target) {
      const base = files[0].name.replace(/\.[^.]+$/, "").slice(0, 80).trim() || "Files";
      [target] = await newNotes([{title: base, useAvailableTitle: true}]);
      await openNote(target, false, "note");
    }
    for (const file of files) {
      const res = await request(`/notes/${target}/files?${new URLSearchParams({name: file.name})}`, {file, signal: controller.signal});
      if (!state.unlocked || state.session !== session) return;
      attached++;
      if (state.note?.id === target && !state.note.attachments.some(item => item.id === res.id)) {
        state.note.attachments.push(res);
      }
      if (embedImages && /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i.test(res.name)) {
        const alt = res.name.replace(/[\[\]]/g, "");
        embeddedLines.push(`![${alt}](attachment:${res.id})`);
      }
    }
    if (embeddedLines.length && state.note?.id === target && !state.note.trashed) {
      const current = $("body").value;
      const next = current ? `${current.trimEnd()}\n\n${embeddedLines.join("\n\n")}` : embeddedLines.join("\n\n");
      $("body").value = next;
      if (!state.sourceMode) notionEditor.setValue(next, false);
      scheduleSave();
    }
    status(embeddedLines.length ? "Image inserted into note." : "Files attached.");
  } catch (error) {
    if (attached && state.session === session) {
      throw new Error(`${attached} of ${files.length} files attached. ${error.message}`);
    }
    throw error;
  } finally {
    if (state.upload === controller) state.upload = null;
    updatePickers();
    if (attached && state.unlocked && state.session === session) {
      renderFiles();
      await run(refresh);
      if (state.library === "files") await run(refreshFiles);
    }
  }
}

// Prevent browser from navigating away when dropping OS files anywhere on the window
if (typeof window !== "undefined" && typeof document !== "undefined") {
  const isOsFileDrag = e => Array.from(e.dataTransfer?.types || []).includes("Files");
  window.addEventListener("dragover", e => { if (isOsFileDrag(e)) e.preventDefault(); });
  window.addEventListener("drop", e => { if (isOsFileDrag(e)) e.preventDefault(); });

  const bindFileDropZone = (element, {embedImages = false} = {}) => {
    if (!element) return;
    let depth = 0;
    element.addEventListener("dragenter", e => {
      if (!state.unlocked || !isOsFileDrag(e)) return;
      e.preventDefault();
      depth++;
      element.classList.add("drop-active");
    });
    element.addEventListener("dragover", e => {
      if (!state.unlocked || !isOsFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    element.addEventListener("dragleave", e => {
      if (!isOsFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) element.classList.remove("drop-active");
    });
    element.addEventListener("drop", e => {
      if (!state.unlocked || !isOsFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      element.classList.remove("drop-active");
      const dropped = Array.from(e.dataTransfer?.files || []);
      if (dropped.length) void run(() => attachFiles(dropped, {embedImages}));
    });
  };
  bindFileDropZone($("reading-panel"), {embedImages: true});
  bindFileDropZone(document.querySelector("aside.editor"), {embedImages: false});
  $("reading-panel")?.addEventListener("paste", e => {
    if (!state.unlocked || !state.note || state.note.trashed) return;
    const imgFiles = Array.from(e.clipboardData?.files || []).filter(f => /^image\//i.test(f.type));
    if (!imgFiles.length) return;
    e.preventDefault();
    void run(() => attachFiles(imgFiles, {embedImages: true}));
  });
}

// Event bindings
$("recover-toggle")?.addEventListener("click", () => {
  const recovering = $("recover-wrap").hidden;
  $("recover-wrap").hidden = !recovering;
  $("password").hidden = recovering;
  $("password").required = !recovering;
  const pwLabel = document.querySelector("label[for='password']");
  if (pwLabel) pwLabel.hidden = recovering;
  if ($("recovery-key-input")) $("recovery-key-input").required = recovering;
  if ($("recovery-new-pw")) $("recovery-new-pw").required = recovering;
  $("unlock-button").textContent = recovering ? "Recover & set new password" : "Unlock vault";
  $("recover-toggle").textContent = recovering ? "Back to password" : "Use recovery key";
  gateError("");
});

$("unlock").addEventListener("submit", async e => {
  e.preventDefault();
  const recovering = Boolean($("recover-wrap") && !$("recover-wrap").hidden);
  const password = $("password").value;
  if (!recovering && !state.exists && password !== $("confirmation").value) { gateError("Passwords do not match."); return; }
  $("unlock-button").disabled = true; gateError("");
  try {
    if (recovering) {
      await request("/recover", {
        body: {recoveryKey: $("recovery-key-input").value.trim(), newPassword: $("recovery-new-pw").value},
      });
    } else {
      await request(state.exists ? "/unlock" : "/create", {body: {password}});
    }
    await showWorkspace();
  } catch (err) { gateError(err.message); }
  finally { $("unlock-button").disabled = false; }
});

function emergencyLockNow() {
  void run(async () => {
    await request("/lock", {body: {}});
    showGate({exists: true});
    $("password").focus();
  });
}
$("emergency-lock")?.addEventListener("click", emergencyLockNow);

$("lock").addEventListener("click", () => void run(async () => {
  if (!await flush()) return;
  await viewer.flush();
  await state.fieldWrites;
  await request("/lock", {body: {}});
  showGate({exists: true});
  $("password").focus();
}));

$("toggle-sidebar").addEventListener("click", () => {
  state.sidebar = !state.sidebar;
  $("workspace").classList.toggle("sidebar-closed", !state.sidebar);
  $("toggle-sidebar").setAttribute("aria-pressed", String(state.sidebar));
  graph.resize();
});
const THEMES = [["dark", "Dark"], ["slate", "Slate"], ["light", "Paper"]];
function applyTheme(name) {
  state.theme = THEMES.some(([k]) => k === name) ? name : "dark";
  document.documentElement.dataset.theme = state.theme;
  try { localStorage.setItem("xotira-theme", state.theme); } catch {}
  const label = THEMES.find(([k]) => k === state.theme)?.[1] || "Theme";
  if ($("cycle-theme")) $("cycle-theme").textContent = label;
  graph.startLoop();
}
applyTheme(state.theme);
$("cycle-theme")?.addEventListener("click", () => {
  const idx = THEMES.findIndex(([k]) => k === state.theme);
  applyTheme(THEMES[(idx + 1) % THEMES.length][0]);
});

$("toggle-split")?.addEventListener("click", () => {
  state.split = !state.split;
  if (state.split && !state.note && state.data.nodes.length) {
    void run(() => openNote(state.data.nodes[0].id, false, "note"));
  } else {
    setView(state.view);
  }
});

function toggleZen() {
  state.zen = !state.zen;
  $("workspace").classList.toggle("is-zen", state.zen);
  $("toggle-zen")?.setAttribute("aria-pressed", String(state.zen));
  graph.resize();
}
$("toggle-zen")?.addEventListener("click", toggleZen);

// Built-in Focus Timer with clear dialog, presets, Start/Pause & Reset
let timerDuration = 25 * 60;
let timerLeft = 25 * 60;
let timerHandle = 0;
function renderTimer() {
  const m = String(Math.floor(timerLeft / 60)).padStart(2, "0");
  const s = String(timerLeft % 60).padStart(2, "0");
  const formatted = `${m}:${s}`;
  const icon = timerHandle ? "▶" : (timerLeft < timerDuration && timerLeft > 0 ? "⏸" : "⏱");
  if ($("focus-timer")) {
    $("focus-timer").textContent = `${icon} ${formatted}`;
    $("focus-timer").classList.toggle("is-running", Boolean(timerHandle));
  }
  if ($("timer-display")) $("timer-display").textContent = formatted;
  if ($("timer-toggle")) $("timer-toggle").textContent = timerHandle ? t("timer-pause") : t("timer-start");
  if ($("timer-state")) {
    $("timer-state").textContent = timerLeft === 0 ? t("timer-done") : timerHandle ? t("timer-running") : (timerLeft < timerDuration ? t("timer-paused") : t("timer-ready"));
  }
}
function setTimerMinutes(mins) {
  const clean = Math.max(1, Math.min(180, Number.parseInt(mins, 10) || 25));
  clearInterval(timerHandle);
  timerHandle = 0;
  timerDuration = clean * 60;
  timerLeft = timerDuration;
  if ($("timer-custom-mins")) $("timer-custom-mins").value = String(clean);
  renderTimer();
}
function toggleTimerRunning() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = 0;
  } else {
    if (timerLeft <= 0) timerLeft = timerDuration;
    timerHandle = setInterval(() => {
      timerLeft = Math.max(0, timerLeft - 1);
      renderTimer();
      if (timerLeft === 0) {
        clearInterval(timerHandle);
        timerHandle = 0;
        renderTimer();
        status(t("timer-done"));
      }
    }, 1000);
  }
  renderTimer();
}
$("focus-timer")?.addEventListener("click", () => {
  renderTimer();
  $("timer-dialog")?.showModal();
});
$("timer-close")?.addEventListener("click", () => $("timer-dialog")?.close());
$("timer-toggle")?.addEventListener("click", toggleTimerRunning);
$("timer-reset")?.addEventListener("click", () => setTimerMinutes(Math.round(timerDuration / 60)));
$("timer-set-custom")?.addEventListener("click", () => setTimerMinutes($("timer-custom-mins")?.value));
$("timer-dialog")?.querySelectorAll("[data-mins]").forEach(btn =>
  btn.addEventListener("click", () => setTimerMinutes(btn.dataset.mins))
);
renderTimer();

// Active Recall Flashcards Study Mode & Deck Manager (works even with 0 notes!)
$("study-close")?.addEventListener("click", () => $("study-dialog").close());
$("study-note")?.addEventListener("click", () => {
  if (!state.note) return;
  const cards = extractCardsFromMarkdown($("body").value, state.note.title);
  studyMode.open(cards, `${t("fc-title")} · ${state.note.title}`, {includeCustom: true});
});
$("study-vault")?.addEventListener("click", () => void run(async () => {
  const targets = state.data.nodes.slice(0, 30);
  const all = [];
  if (targets.length) {
    status("Preparing flashcards…");
    for (const n of targets) {
      try {
        const full = await request(`/notes/${n.id}`);
        all.push(...extractCardsFromMarkdown(full.body || "", full.title));
      } catch {}
      if (all.length >= 40) break;
    }
    status("");
  }
  studyMode.open(all, t("fc-title"), {includeCustom: true});
}));

$("nav-back")?.addEventListener("click", () => void run(async () => {
  if (state.histIdx <= 0) return;
  const index = state.histIdx - 1;
  await openNote(state.history[index], false, "note", "", index);
}));
$("nav-forward")?.addEventListener("click", () => void run(async () => {
  if (state.histIdx >= state.history.length - 1) return;
  const index = state.histIdx + 1;
  await openNote(state.history[index], false, "note", "", index);
}));
$("print-note")?.addEventListener("click", () => window.print());
async function updateNoteFields(noteId, patch) {
  const session = state.session;
  const update = state.fieldWrites.then(async () => {
    if (!state.unlocked || session !== state.session) return;
    const current = state.note?.id === noteId ? state.note.entity :
      state.data.nodes.find(note => note.id === noteId)?.entity;
    const starting = current || await request(`/notes/${noteId}/entity`);
    if (!state.unlocked || session !== state.session) return;
    try {
      const entity = await request(`/notes/${noteId}/entity`, {body: {revision: starting.revision, fields: patch}});
      if (!state.unlocked || session !== state.session) return;
      if (state.note?.id === noteId) {
        state.note.entity = entity;
        syncPageProps();
      }
      await refresh();
      status("");
    } catch (error) {
      if (state.unlocked && session === state.session) {
        if (state.note?.id === noteId) {
          state.note.entity = await request(`/notes/${noteId}/entity`);
          syncPageProps();
        }
        await refresh();
      }
      throw error;
    }
  });
  state.fieldWrites = update.catch(() => {});
  return update;
}

for (const [value, label] of Object.entries(ENTITY_LABELS)) $("prop-type").append(new Option(label, value));
for (const [value, label] of Object.entries(RELATION_LABELS)) $("relation-type").append(new Option(label, value));
for (const field of ["status", "priority", "due", "type"]) {
  const input = $(`prop-${field}`);
  input.addEventListener("change", () => {
    if (!state.note) return;
    const value = input.value;
    syncPageProps();
    void run(() => updateNoteFields(state.note.id, {[field]: value}));
  });
}
const COVERS = ["", "cov-1", "cov-2", "cov-3", "cov-4", "cov-5"];
$("cycle-cover").addEventListener("click", () => {
  if (!state.note) return;
  const next = COVERS[(COVERS.indexOf(noteFields(state.note).cover) + 1) % COVERS.length];
  void run(() => updateNoteFields(state.note.id, {cover: next}));
});

function renderRelations() {
  const note = state.note;
  if (!note) return;
  const choices = state.data.nodes.filter(item => item.id !== note.id && !state.trash);
  const names = new Map(choices.map(item => [item.id, item.title]));
  const current = noteFields(note).relationships;
  const items = current.map(relation => {
    const item = document.createElement("li");
    const label = `${RELATION_LABELS[relation.type]} · ${names.get(relation.target) || "Unavailable or deleted note"}`;
    const open = button(label, () => {
      $("relations-dialog").close();
      void run(() => openNote(relation.target));
    });
    open.disabled = !names.has(relation.target);
    const remove = button("Remove", () => void editRelations(
      current.filter(entry => entry !== relation)));
    remove.disabled = note.trashed;
    item.append(open, remove);
    return item;
  });
  $("relation-list").replaceChildren(...items);
  $("relation-target").replaceChildren(...choices.map(item => new Option(item.title, item.id)));
  $("relation-add").disabled = note.trashed || !choices.length;
}

async function editRelations(relationships) {
  $("relation-message").textContent = "";
  $("relation-add").disabled = true;
  try {
    await updateNoteFields(state.note.id, {relationships});
  } catch (error) {
    if (state.unlocked) $("relation-message").textContent = error.message;
  } finally {
    if ($("relations-dialog").open) renderRelations();
  }
}
$("note-relations").addEventListener("click", () => {
  if (!state.note) return;
  $("relation-message").textContent = "";
  renderRelations();
  $("relations-dialog").showModal();
});
$("relations-close").addEventListener("click", () => $("relations-dialog").close());
$("relation-add").addEventListener("click", () => {
  if (!state.note || !$("relation-target").value) return;
  void editRelations([...noteFields(state.note).relationships,
    {type: $("relation-type").value, target: $("relation-target").value}]);
});

const historyDialog = $("history-dialog");
let historyRequest = 0;
let historySelection;
function historyPath(id, kind, revision) {
  const query = new URLSearchParams({kind});
  if (revision !== undefined) query.set("revision", revision);
  return `/notes/${id}/history?${query}`;
}

function historyText(kind, value) {
  return kind === "entity" ? JSON.stringify(value.fields || {}, null, 2) :
    [value.title, value.tags.join(", "), value.trashed ? "In Trash" : "", "", value.body].join("\n");
}
function renderHistoryDiff(before, after) {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let start = 0, end = 0;
  const shared = Math.min(oldLines.length, newLines.length);
  while (start < shared && oldLines[start] === newLines[start]) start++;
  while (end < shared - start && oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]) end++;
  const sections = [["Earlier", oldLines], ["Current", newLines]].map(([label, lines]) => {
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = label;
    const text = document.createElement("pre");
    const mark = document.createElement("mark");
    mark.textContent = lines.slice(start, lines.length - end).join("\n") || "—";
    text.append((start ? lines.slice(Math.max(0, start - 2), start).join("\n") + "\n" : ""),
      mark, end ? "\n" + lines.slice(lines.length - end, lines.length - end + 2).join("\n") : "");
    section.append(heading, text);
    return section;
  });
  $("history-diff").replaceChildren(...sections);
}
async function loadHistory(reload) {
  const sequence = ++historyRequest;
  const note = state.note;
  if (!note) return;
  const kind = $("history-kind").value;
  $("history-restore").disabled = true;
  $("history-message").textContent = "Loading…";
  $("history-diff").replaceChildren();
  const versions = $("history-version");
  try {
    if (reload) {
      versions.replaceChildren();
      const list = await request(historyPath(note.id, kind));
      if (sequence !== historyRequest || !historyDialog.open) return;
      historySelection = {id: note.id, kind, current: list.current};
      versions.replaceChildren(...list.revisions.map(value => new Option(`Version ${value}`, value)));
    }
    if (!versions.value) {
      $("history-message").textContent = "Previous version unavailable.";
      return;
    }
    const data = await request(historyPath(note.id, kind, versions.value));
    if (sequence !== historyRequest || !historyDialog.open) return;
    renderHistoryDiff(historyText(kind, data), historyText(kind, kind === "entity" ? note.entity : note));
    $("history-message").textContent = "";
    $("history-restore").disabled = kind === "entity" && note.trashed;
  } catch (error) {
    if (sequence === historyRequest && historyDialog.open) $("history-message").textContent = error.message;
  }
}
$("note-history").addEventListener("click", () => void run(async () => {
  const id = state.note?.id;
  const sequence = state.openSequence;
  if (!id || !await flush()) return;
  await state.fieldWrites;
  if (!state.unlocked || sequence !== state.openSequence || state.note?.id !== id || state.dirty) return;
  const version = state.editVersion;
  const note = await request(`/notes/${id}`);
  if (!state.unlocked || sequence !== state.openSequence || state.note?.id !== id || version !== state.editVersion) return;
  renderEditor(note);
  historyDialog.showModal();
  await loadHistory(true);
}));
$("history-kind").addEventListener("change", () => void loadHistory(true));
$("history-version").addEventListener("change", () => void loadHistory(false));
$("history-close").addEventListener("click", () => historyDialog.close());
historyDialog.addEventListener("close", () => {
  historyRequest++;
  $("history-diff").replaceChildren();
});
$("history-restore").addEventListener("click", () => void run(async () => {
  const {id, kind, current} = historySelection;
  $("history-restore").disabled = true;
  try {
    await request(historyPath(id, kind, $("history-version").value), {body: {expected: current}});
    const note = await request(`/notes/${id}`);
    historyDialog.close();
    state.trash = note.trashed;
    renderEditor(note);
    await refresh();
  } catch (error) {
    if (historyDialog.open) $("history-message").textContent = error.message;
  }
}));

function syncPlanningNav() {
  const active = state.view === "db";
  $("nav-db").setAttribute("aria-pressed", String(active && !["calendar", "roadmaps"].includes(dbView.mode)));
  $("nav-calendar").setAttribute("aria-pressed", String(active && dbView.mode === "calendar"));
  $("nav-roadmaps").setAttribute("aria-pressed", String(active && dbView.mode === "roadmaps"));
}
function openPlanning(mode) {
  dbView.mode = mode;
  setLibrary("notes");
  if (state.trash) {
    state.trash = false;
    void run(refresh);
  }
  setView("db");
}

function syncDetails() {
  const map = state.view === "file" && viewer.active && fileType(viewer.active.file.name) === "mindmap";
  $("workspace").classList.toggle("mind-board-active", Boolean(map));
  $("mind-inspector-host").hidden = !map;
}

function setInspector(visible) {
  state.inspector = visible;
  $("workspace").classList.toggle("inspector-closed", !visible);
  $("toggle-inspector").setAttribute("aria-pressed", String(visible));
  graph.resize();
  viewer.active?.board?.schedule?.();
}

$("toggle-inspector").addEventListener("click", () => setInspector(!state.inspector));

$("open-cmd").addEventListener("click", () => cmdPalette.open());
$("nav-calendar").addEventListener("click", () => openPlanning("calendar"));
$("nav-roadmaps").addEventListener("click", () => openPlanning("roadmaps"));
$("nav-home").addEventListener("click", () => { setLibrary("notes"); setView("home"); });
$("graph-orphans").addEventListener("click", () => {
  state.graphOrphans = !state.graphOrphans;
  if (state.graphOrphans) {
    state.focused = false;
    state.graphGroup = "";
  }
  renderGraph();
});
$("nav-map").addEventListener("click", () => { setLibrary("notes"); setView("map"); });
$("tab-map").addEventListener("click", () => setView("map"));
$("nav-mind").addEventListener("click", () => void run(openMindMaps));
$("tab-mind").addEventListener("click", () => void run(openMindMaps));
$("nav-db").addEventListener("click", () => openPlanning("table"));


$("tab-db").addEventListener("click", () => setView("db"));
$("tab-file").addEventListener("click", () => { if (viewer.active) setView("file"); });
$("daily-note").addEventListener("click", () => void run(openDailyNote));
$("open-templates").addEventListener("click", () => openTemplateModal());
$("template-close").addEventListener("click", () => $("template-dialog").close());
$("show-files").addEventListener("click", () => setLibrary(state.library === "files" ? "notes" : "files"));

$("living-toggle").addEventListener("click", () => {
  $("living-toggle").setAttribute("aria-pressed", String(graph.toggleLiving()));
});
function setGraphControlsOpen(open) {
  const pill = $("graph-controls");
  const body = $("graph-controls-body");
  const toggle = $("graph-controls-toggle");
  if (!pill || !body || !toggle) return;
  pill.classList.toggle("is-collapsed", !open);
  body.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  try { localStorage.setItem("xotira-graph-pill", open ? "open" : "closed"); } catch {}
}
$("graph-controls-toggle")?.addEventListener("click", () => {
  const open = $("graph-controls-body")?.hidden === true;
  setGraphControlsOpen(open);
});
setGraphControlsOpen((() => { try { return localStorage.getItem("xotira-graph-pill") === "open"; } catch { return false; } })());
$("relayout").addEventListener("click", () => {
  state.manualGraph = false;
  graph.manualPlacement = false;
  $("manual-graph").setAttribute("aria-pressed", "false");
  if (!state.focused) state.graphFocusId = null;
  $("graph-search").value = "";
  $("path-result").textContent = "";
  renderGraph();
  graph.relayout();
});
$("manual-graph").addEventListener("click", () => {
  state.manualGraph = !state.manualGraph;
  graph.manualPlacement = state.manualGraph;
  $("manual-graph").setAttribute("aria-pressed", String(state.manualGraph));
  renderGraph();
});
$("fit").addEventListener("click", () => graph.fit());
$("snapshot-btn").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = graph.exportPNG();
  a.download = `MemoryMap-Graph-${todayISO()}.png`;
  a.click();
});
$("labels").addEventListener("click", () => {
  graph.showLabels = !graph.showLabels;
  $("labels").setAttribute("aria-pressed", String(graph.showLabels));
  graph.startLoop();
});
$("focus").addEventListener("click", () => { state.focused = !state.focused; renderGraph(); graph.fit(); });
$("depth").addEventListener("change", () => { renderGraph(); graph.fit(); });
$("map-files").addEventListener("click", () => { state.showMapFiles = !state.showMapFiles; renderGraph(); });
$("graph-search").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const query = formatTitle(e.target.value);
  const candidates = [...state.data.nodes, ...state.data.files];
  const match = candidates.find(item => formatTitle(item.title || item.mapTitle || item.name) === query) ||
    candidates.find(item => formatTitle(item.title || item.mapTitle || item.name).includes(query));
  if (!query || !match) {
    if (query) status("Node not found.", true);
    return;
  }
  if (state.tag || $("search").value) {
    state.tag = null;
    $("search").value = "";
  }
  state.graphFocusId = match.id;
  state.graphGroup = "";
  if (match.name) state.showMapFiles = true;
  status("");
  renderGraph();
  graph.focusNode(match.id);
});
$("graph-search").addEventListener("input", () => {
  if ($("graph-search").value.trim()) return;
  state.graphFocusId = null;
  graph.focusNode("");
  renderGraph();
});
$("path-btn").addEventListener("click", () => openPathModal());
$("path-cancel").addEventListener("click", () => $("path-dialog").close());
$("path-clear").addEventListener("click", () => { graph.clearPath(); $("path-result").textContent = ""; });
$("path-form").addEventListener("submit", e => {
  e.preventDefault();
  const path = graph.findPath($("path-start").value, $("path-end").value);
  $("path-result").textContent = path?.length
    ? path.map(id => state.data.nodes.find(n => n.id === id)?.title || id).join(" → ")
    : "No path found.";
  if (path?.length) setView("map");
});

$("toggle-source").addEventListener("click", () => setSourceMode(!state.sourceMode));
$("pin-note").addEventListener("click", () => {
  if (!state.note) return;
  const node = state.data.nodes.find(n => n.id === state.note.id);
  void run(() => togglePin(state.note.id, !node?.pinned));
});
$("draw-note").addEventListener("click", () => {
  if (state.note && !state.note.trashed) void run(() => showDrawing({noteId: state.note.id}));
});
$("create-note").addEventListener("click", () => openCreateDialog());
$("cancel-create").addEventListener("click", () => $("create-dialog").close());
$("create-form").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const eventDate = newEventDate;
    const submit = e.submitter;
    if (submit) submit.disabled = true;
    try {
      const draft = {title: $("new-title").value};
      if (eventDate) draft.eventDate = eventDate;
      const [id] = await newNotes([draft]);
      $("create-dialog").close();
      await openNote(id, !eventDate, "note");
      if (eventDate && state.note?.id === id) $("prop-reminder").focus();
    } finally { if (submit) submit.disabled = false; }
  } catch (err) { $("create-error").textContent = err.message; $("create-error").hidden = false; }
});

["title", "tags", "body", "properties-source"].forEach(id => $(id).addEventListener("input", scheduleSave));
$("search").addEventListener("input", () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => void run(refresh), 150);
});
$("file-search").addEventListener("input", renderFileLibrary);
$("remove").addEventListener("click", () => void run(() => moveToTrash(true)));
$("restore").addEventListener("click", () => void run(() => moveToTrash(false)));
$("purge-note").addEventListener("click", () => void run(() => deleteTrashed(false)));
$("empty-trash").addEventListener("click", () => void run(() => deleteTrashed(true)));
$("trash").addEventListener("click", () => void run(async () => {
  if (!await flush()) return;
  await viewer.flush();
  viewer.close();
  clearEditor(); setView("map");
  state.trash = !state.trash;
  setLibrary("notes"); state.tag = null; state.focused = false;
  await refresh();
}));
function moveDroppedItem(entry) {
  if (entry.kind === "note") {
    void run(() => moveToTrash(true, entry.id));
  } else if (entry.kind === "file") {
    void run(() => changeFileTrash({id: entry.id, noteId: entry.noteId}, "move"));
  }
}
$("reload-note").addEventListener("click", () => void run(async () => {
  const id = state.note?.id;
  if (!id || (state.dirty && !window.confirm("Discard the unsaved edits and reload this note?"))) return;
  const version = state.editVersion;
  const full = await request(`/notes/${id}`);
  if (state.note?.id === id && state.editVersion === version) renderEditor(full);
}));

$("menu-folder").addEventListener("click", () => $("folder-input").click());
$("map-import").addEventListener("click", () => $("folder-input").click());
$("folder-input").addEventListener("change", () => {
  const files = Array.from($("folder-input").files); $("folder-input").value = "";
  void run(() => importFolder(files));
});
const fileMenu = $("file-menu");
const stageBar = fileMenu.closest(".stage-bar");
const compactActions = $("compact-actions");
const workspaceActions = ["focus-timer", "toggle-split", "toggle-zen", "cycle-theme", "open-a11y", "lang-select", "spell-toggle", "toggle-inspector"].map($).filter(Boolean);
let compactMode;
function placeWorkspaceActions() {
  const width = stageBar.clientWidth;
  if (!width) return;
  const compact = width <= 680;
  if (compactMode === compact) return;
  compactMode = compact;
  const focused = document.activeElement;
  if (compact) compactActions.append(...workspaceActions);
  else fileMenu.before(...workspaceActions);
  compactActions.hidden = !compact;
  if (compact && workspaceActions.includes(focused)) {
    fileMenu.open = true;
    focused.focus();
  } else if (workspaceActions.includes(focused)) focused.focus();
}
new ResizeObserver(placeWorkspaceActions).observe(stageBar);
placeWorkspaceActions();

fileMenu.addEventListener("click", event => {
  const action = event.target.closest(".dropdown button");
  if (!action) return;
  fileMenu.open = false;
  if (compactActions.contains(action) && document.activeElement === action) fileMenu.querySelector("summary").focus();
});
document.addEventListener("pointerdown", event => {
  if (fileMenu.open && !fileMenu.contains(event.target)) fileMenu.open = false;
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && fileMenu.open) {
    fileMenu.open = false;
    fileMenu.querySelector("summary").focus();
  }
});
$("backup").addEventListener("click", () => void run(async () => {
  await download("/backup", "MemoryMap.xotira");
  await updateStatus();
}));
async function exportUnencrypted(path, filename) {
  if (window.confirm("This export includes unencrypted note contents. Continue?")) await download(path, filename);
}
$("export").addEventListener("click", () => void run(() => exportUnencrypted("/export", "MemoryMap-Markdown.zip")));
$("export-portable").addEventListener("click", () => void run(() => exportUnencrypted("/export/portable", "MemoryMap-Portable.zip")));
let importFormat = "markdown";
for (const format of ["markdown", "web"]) {
  $(`import-${format}-zip`).addEventListener("click", () => {
    importFormat = format;
    $("import-zip-file").click();
  });
}
$("import-zip-file").addEventListener("change", event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || state.upload) return;
  const format = importFormat;
  void run(async () => {
    if (!await flush() || !state.unlocked) return;
    const controller = new AbortController();
    state.upload = controller;
    state.folderImport = true;
    updatePickers();
    const source = file.name.replace(/\.zip$/i, "").slice(0, 255);
    const query = new URLSearchParams({source, format});
    status("Importing ZIP…");
    try {
      const counts = await request(`/import/zip?${query}`, {file, signal: controller.signal});
      state.trash = false;
      state.tag = null;
      state.focused = false;
      state.folders.add(source);
      await refresh();
      setLibrary("notes");
      setView("map");
      status(`${counts.notes} notes · ${counts.files} files · ${counts.existing} already imported. `
        + `Converted ${counts.converted} HTML notes and ${counts.csvRows || 0} CSV rows. `
        + `Original files kept: ${counts.unconverted}. Skipped: ${counts.skipped}.`
        + (counts.frontmatterWarnings ? ` Original YAML kept in ${counts.frontmatterWarnings} notes.` : ""));
    } finally {
      if (state.upload === controller) {
        state.upload = null;
        state.folderImport = false;
      }
      updatePickers();
    }
  });
});
$("export-brain").addEventListener("click", () => void run(() => exportUnencrypted("/export/brain", "MemoryMap-Brain.json")));
$("import").addEventListener("click", () => $("import-files").click());
$("import-files").addEventListener("change", () => {
  const files = Array.from($("import-files").files); $("import-files").value = "";
  if (!files.length) return;
  void run(async () => {
    const notes = await Promise.all(files.map(async f => ({title: f.name.replace(/\.(md|markdown|txt)$/i, ""), body: await f.text()})));
    const ids = await newNotes(notes);
    await openNote(ids[0], false, "note");
  });
});

for (const id of ["attachment-file", "library-file-input"]) {
  $(id).addEventListener("change", () => {
    const files = Array.from($(id).files); $(id).value = "";
    void run(() => attachFiles(files));
  });
}

// Both close controls flush the captured viewer before releasing its resources.
async function closeFileTab() {
  const session = viewer.active;
  if (!session) return;
  const mind = fileType(session.file.name) === "mindmap";
  await viewer.flush();
  if (!state.unlocked || viewer.active !== session) return;
  const focusTab = document.activeElement === $("tab-file-close");
  if (state.view !== "file") {
    if (!restoreInlineMindMap(session.noteId)) viewer.close();
    renderTabs();
  } else if (session.returnNoteId) {
    const entry = restoreInlineMindMap(session.returnNoteId);
    if (!entry) viewer.close();
    await openNote(session.returnNoteId, false, "note");
    if (entry) {
      entry.expand.focus({preventScroll: true});
      return;
    }
    renderTabs();
  } else {
    viewer.close();
    setView(mind ? "mind" : (state.note ? "note" : "map"));
  }
  if (focusTab && !viewer.active) {
    const navigation = document.querySelector('.stage-tabs button[aria-pressed="true"]') || $("tab-map");
    navigation.focus({preventScroll: true});
  }
}
$("viewer-close").addEventListener("click", () => void run(closeFileTab));
$("tab-file-close").addEventListener("click", () => void run(closeFileTab));
$("note-attachments").addEventListener("click", () => {
  setInspector(true);
  $("files").focus({preventScroll: true});
  $("files").scrollIntoView({block: "nearest"});
});
$("viewer-trash").addEventListener("click", () => {
  if (viewer.active) {
    const {file, noteId} = viewer.active;
    void run(() => changeFileTrash({...file, noteId}, "move"));
  }
});
$("viewer-note").addEventListener("click", () => { if (viewer.active) void run(() => openNote(viewer.active.noteId, false, "note")); });
$("viewer-download").addEventListener("click", () => void run(async () => {
  const session = viewer.active;
  if (!session) return;
  await viewer.flush();
  if (viewer.active === session) await download(session.path, session.file.name, false);
}));

const examples = [
  {title: "HOME", tags: ["Portal"], body: "# HOME\n\nExplore [[Language Immersion]] · [[Research assistant]] · [[IELTS]] · [[AI Engineering]]"},
  {title: "Language Immersion", tags: ["Study"], body: "# Language Immersion\n\n**Immersion** means using a language throughout your day for reading, listening, and thinking.\n\n## Practice modes\n| Mode | Activity | Goal |\n| --- | --- | --- |\n| Passive | Listen in the background | Notice rhythm |\n| Active | Listen and repeat aloud | Build active vocabulary |\n\n> [!note] Related notes\n> [[IELTS]] · [[HOME]]"},
  {title: "IELTS", tags: ["Study"], body: "[[Language Immersion]] · [[HOME]]"},
  {title: "AI Engineering", tags: ["AI"], body: "- [ ] Study transformers\n- [ ] Connect [[Research assistant]] to a knowledge graph"},
  {title: "Research assistant", tags: ["AI", "Project"], body: "A local AI assistant. See [[HOME]] and [[AI Engineering]]."},
];
$("examples").addEventListener("click", () => void run(async () => {
  await newNotes(examples);
  graph.reheat();
  graph.fit();
}));

const ws = $("workspace");
resizePane(ws, $("library-splitter"), ws.querySelector(".library"), ws.querySelector(".editor"), "--library-width", 1, 180);
resizePane(ws, $("inspector-splitter"), ws.querySelector(".editor"), ws.querySelector(".library"), "--inspector-width", -1, 200);

document.addEventListener("keydown", e => {
  if (!state.unlocked || !(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === "k" && e.shiftKey) { e.preventDefault(); openVaultSearch(); }
  else if (k === "k" || k === "p") { e.preventDefault(); cmdPalette.open(); }
  else if (k === "d") { e.preventDefault(); void run(openDailyNote); }
  else if (k === "f" && e.shiftKey) { e.preventDefault(); toggleZen(); }
  else if (k === "l" && e.shiftKey) { e.preventDefault(); emergencyLockNow(); }
  else if (k === "\\") { e.preventDefault(); $("toggle-sidebar").click(); }
  else if (k === "s") { e.preventDefault(); void flush(); }
});
document.addEventListener("pointerdown", touch, {passive: true});
document.addEventListener("keydown", touch);

async function initialize() {
  if (!tokenPattern.test(token)) { showGate({exists: true, message: "Start Memory map with its launcher."}); return; }
  try {
    const metadata = await updateStatus();
    if (metadata.unlocked) await showWorkspace();
    else showGate(metadata);
  } catch (err) { showGate({exists: true, message: err.message}); }
  setInterval(() => { if (state.unlocked && !state.folderImport) void run(updateStatus); }, 3_000);
  setInterval(() => { if (state.unlocked && !document.hidden && !state.folderImport) void run(refreshReminders); }, 15_000);
  document.addEventListener("visibilitychange", () => {
    if (state.unlocked && !document.hidden) void run(refreshReminders);
  });
}

// v24: Reading Progress Bar + Scroll-Spy Active TOC (inspired by NotionNext GitBook Progress & Catalog)
const notePageEl = $("reading-panel")?.querySelector(".note-page");
let scrollRaf = 0;
function updateReadingProgressAndToc() {
  scrollRaf = 0;
  if (!notePageEl) return;
  const maxScroll = Math.max(0, notePageEl.scrollHeight - notePageEl.clientHeight);
  const pct = maxScroll > 0 ? Math.min(100, Math.max(0, Math.round((notePageEl.scrollTop / maxScroll) * 100))) : 0;
  const fill = $("reading-progress-fill");
  if (fill) fill.style.width = `${pct}%`;

  const headings = [...$("notion-editor").querySelectorAll("h1, h2, h3, h4, h5, h6")];
  const tocButtons = [...$("outline-list").querySelectorAll("li button")];
  if (!headings.length || !tocButtons.length) return;
  const pageTop = notePageEl.getBoundingClientRect().top;
  let activeIdx = 0;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].getBoundingClientRect().top - pageTop <= 140) activeIdx = i;
    else break;
  }
  tocButtons.forEach((btn, idx) => btn.classList.toggle("is-toc-active", idx === activeIdx));
}
notePageEl?.addEventListener("scroll", () => {
  if (!scrollRaf) scrollRaf = requestAnimationFrame(updateReadingProgressAndToc);
}, {passive: true});

// v24: Single-Note Public Link Dialog (isolated per-note publishing + optional ArticleLock)
const shareDialog = $("share-dialog");
function syncShareFormVisibility(info = null) {
  const enabled = $("share-enabled").checked;
  $("share-options").hidden = !enabled;
  if (info) {
    $("share-theme").value = info.theme || "gitbook";
    $("share-slug").value = info.slug || "";
    $("share-password").value = "";
    $("share-clear-pw").checked = false;
    $("share-clear-pw-wrap").hidden = !info.hasPassword;
    $("share-link-box").hidden = !info.enabled || !info.url;
    $("share-url").value = info.url || "";
    $("share-open").href = info.url || "#";
    $("share-status").textContent = info.enabled
      ? (info.hasPassword ? "Published on this computer (password protected)." : "Published on this computer. Use “Link for everyone” to share it with others.")
      : "Private — not published.";
    renderHosting(info.hosting);
  }
}
function renderHosting(host) {
  if (!host) return;
  $("host-setup").hidden = host.configured;
  $("host-ready").hidden = !host.configured;
  $("host-server").textContent = host.configured ? `Publish server: ${host.server}` : "";
  $("host-link").hidden = !host.hosted;
  $("host-link-url").value = host.hostedUrl || "";
  $("host-open").href = host.hostedUrl || "#";
  $("host-remove").hidden = !host.hosted;
  $("host-publish").textContent = host.hosted ? "Update hosted page" : "Publish to host";
  $("host-pending").hidden = !host.pendingRemovals;
  $("host-pending").textContent = host.pendingRemovals
    ? `${host.pendingRemovals} hosted page(s) could not be removed yet and are still online. Check the publish server connection, then press “Remove from host” or reopen Share.` : "";
}
async function hostCall(path, body) {
  try {
    $("share-error").hidden = true;
    return await request(path, {body});
  } catch (error) {
    $("share-error").textContent = error.message;
    $("share-error").hidden = false;
    return null;
  }
}
$("host-save")?.addEventListener("click", () => void run(async () => {
  const host = await hostCall("/hosting/config", {url: $("host-url").value.trim(), key: $("host-key").value});
  if (!host) return;
  $("host-key").value = "";
  renderHosting({...(await request(`/notes/${state.note.id}/share`)).hosting});
}));
$("host-change")?.addEventListener("click", () => void run(async () => {
  await hostCall("/hosting/config", {clear: true});
  renderHosting((await request(`/notes/${state.note.id}/share`)).hosting);
}));
$("host-publish")?.addEventListener("click", () => void run(async () => {
  const button = $("host-publish");
  button.disabled = true;
  try {
    const host = await hostCall(`/notes/${state.note.id}/host`, {action: "publish", password: $("host-password").value});
    if (host) { $("host-password").value = ""; renderHosting(host); status("Page published to your host."); }
  } finally { button.disabled = false; }
}));
$("host-remove")?.addEventListener("click", () => void run(async () => {
  const host = await hostCall(`/notes/${state.note.id}/host`, {action: "remove"});
  if (host) { renderHosting(host); status("Hosted copy removed."); }
}));
$("host-copy")?.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("host-link-url").value); $("host-copy").textContent = "Copied"; setTimeout(() => { $("host-copy").textContent = "Copy"; }, 1400); } catch {}
});
for (const id of ["host-url", "host-key", "host-password"]) {
  $(id)?.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    $(id === "host-password" ? "host-publish" : "host-save").click();
  });
}
$("share-enabled")?.addEventListener("change", () => syncShareFormVisibility());
$("share-note")?.addEventListener("click", () => void run(async () => {
  if (!state.note || state.note.trashed) return;
  if (!await flush()) return;
  $("share-error").hidden = true;
  const info = await request(`/notes/${state.note.id}/share`);
  $("share-enabled").checked = Boolean(info.enabled);
  syncShareFormVisibility(info);
  shareDialog.showModal();
}));
$("share-copy")?.addEventListener("click", async () => {
  const url = $("share-url").value;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    $("share-copy").textContent = "Copied";
    setTimeout(() => { $("share-copy").textContent = "Copy"; }, 1400);
  } catch {}
});
$("share-export-html")?.addEventListener("click", () => void run(async () => {
  if (!state.note) return;
  const password = $("share-password").value;
  const response = await request(`/notes/${state.note.id}/share?export=html`, {body: {password}, blob: true});
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''(.+)$/)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : "public-note.html";
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  status(password ? `Encrypted static HTML exported (${name}).` : `Static HTML exported (${name}).`);
}));
$("share-export-site")?.addEventListener("click", () => void run(() =>
  download("/shares/static-bundle", "MemoryMap-Public-Site.zip", false)
));
for (const id of ["share-close", "share-cancel"]) $(id)?.addEventListener("click", () => shareDialog.close());
$("share-form")?.addEventListener("submit", event => {
  event.preventDefault();
  if (!state.note) return;
  const saveBtn = $("share-save");
  saveBtn.disabled = true;
  $("share-error").hidden = true;
  void (async () => {
    try {
      const payload = {
        enabled: $("share-enabled").checked,
        theme: $("share-theme").value,
        slug: $("share-slug").value.trim(),
      };
      if ($("share-clear-pw").checked) payload.password = "";
      else if ($("share-password").value) payload.password = $("share-password").value;
      const info = await request(`/notes/${state.note.id}/share`, {body: payload});
      $("share-enabled").checked = Boolean(info.enabled);
      syncShareFormVisibility(info);
      status(info.enabled ? `Public link ready: ${info.url}` : "Note returned to private.");
    } catch (error) {
      $("share-error").textContent = error.message;
      $("share-error").hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  })();
});

// v24: Encrypted Account-to-Account ZIP Transfer Dialog
const transferDialog = $("transfer-dialog");
let transferMode = "export";
function openTransferDialog(mode) {
  transferMode = mode;
  $("transfer-error").hidden = true;
  $("transfer-passphrase").value = "";
  $("transfer-file").value = "";
  const isExport = mode === "export";
  $("transfer-heading").textContent = isExport ? "Send encrypted ZIP to another account" : "Import encrypted account ZIP";
  $("transfer-desc").textContent = isExport
    ? "Creates an AES-256-GCM + Argon2id encrypted ZIP with zero plaintext. Share the ZIP and passphrase separately with the receiving account."
    : "Decrypts and imports an encrypted Memory map Transfer ZIP into your current vault.";
  $("transfer-file-wrap").hidden = isExport;
  $("transfer-file").required = !isExport;
  $("transfer-scope-wrap").hidden = !isExport;
  $("transfer-conflict-wrap").hidden = isExport;
  const currentOpt = $("transfer-scope")?.querySelector('option[value="current"]');
  if (currentOpt) {
    currentOpt.disabled = !state.note || state.note.trashed;
    if (currentOpt.disabled) $("transfer-scope").value = "all";
  }
  $("transfer-submit").textContent = isExport ? "Create encrypted ZIP" : "Decrypt & import";
  transferDialog.showModal();
  $("transfer-passphrase").focus();
}
$("export-encrypted-zip")?.addEventListener("click", () => openTransferDialog("export"));
$("import-encrypted-zip")?.addEventListener("click", () => openTransferDialog("import"));
for (const id of ["transfer-close", "transfer-cancel"]) $(id)?.addEventListener("click", () => transferDialog.close());
$("transfer-form")?.addEventListener("submit", event => {
  event.preventDefault();
  const submitBtn = $("transfer-submit");
  submitBtn.disabled = true;
  $("transfer-error").hidden = true;
  void (async () => {
    try {
      if (!await flush()) throw new Error("Save the open note first.");
      const passphrase = $("transfer-passphrase").value;
      if (transferMode === "export") {
        const body = {passphrase};
        if ($("transfer-scope").value === "current" && state.note) body.noteIds = [state.note.id];
        const response = await request("/transfer/export", {body, blob: true});
        const disposition = response.headers.get("content-disposition") || "";
        const encoded = disposition.match(/filename\*=UTF-8''(.+)$/)?.[1];
        const name = encoded ? decodeURIComponent(encoded) : "MemoryMap-Transfer.zip";
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        transferDialog.close();
        status("Encrypted account transfer ZIP created.");
      } else {
        const file = $("transfer-file").files[0];
        if (!file) throw new Error("Choose an encrypted transfer ZIP file.");
        const conflict = $("transfer-conflict").value;
        const passBytes = new TextEncoder().encode(passphrase);
        let bin = "";
        for (const b of passBytes) bin += String.fromCharCode(b);
        const passB64 = btoa(bin);
        const response = await fetch(`${apiBase}/transfer/import?${new URLSearchParams({conflict})}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
            "X-Transfer-Passphrase-B64": passB64,
          },
          cache: "no-store",
          body: file,
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `Import failed (${response.status}).`);
        transferDialog.close();
        await refresh();
        status(`Imported ${result.notes} notes · ${result.attachments} attachments (${result.renamed} renamed, ${result.skipped} skipped).`);
      }
    } catch (error) {
      $("transfer-error").textContent = error.message;
      $("transfer-error").hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  })();
});

// v25: Multi-language (i18n + RTL) & Accessibility (Aa)
const langSelect = $("lang-select");
if (langSelect) {
  for (const item of LANGUAGES) langSelect.append(new Option(item.label, item.code));
  const initialLang = applyLanguage(getSavedLanguage());
  langSelect.value = initialLang;
  langSelect.addEventListener("change", () => applyLanguage(langSelect.value));
  window.addEventListener("xotira-lang-change", () => {
    renderTimer();
    updateWordGoalBadge();
    if (state.unlocked) {
      renderGraph();
      renderTabs();
      if (state.view === "db") dbView.render();
      if ($("study-dialog")?.open) studyMode.render();
    }
  });
}

const a11yDialog = $("a11y-dialog");
let a11yState = applyA11y(loadA11y());
function syncA11yInputs() {
  $("a11y-font-scale").value = a11yState.fontScale;
  $("a11y-line-height").value = a11yState.lineHeight;
  $("a11y-dyslexia").checked = a11yState.dyslexia;
  $("a11y-contrast").checked = a11yState.highContrast;
}
$("open-a11y")?.addEventListener("click", () => { syncA11yInputs(); a11yDialog.showModal(); });
for (const id of ["a11y-close", "a11y-done"]) $(id)?.addEventListener("click", () => a11yDialog.close());
for (const id of ["a11y-font-scale", "a11y-line-height", "a11y-dyslexia", "a11y-contrast"]) {
  $(id)?.addEventListener("change", () => {
    a11yState = applyA11y({
      fontScale: $("a11y-font-scale").value,
      lineHeight: $("a11y-line-height").value,
      dyslexia: $("a11y-dyslexia").checked,
      highContrast: $("a11y-contrast").checked,
    });
  });
}

$("search-semantic")?.addEventListener("change", queryVault);

const onboardingDialog = $("onboarding-dialog");
function openOnboardingModal() {
  const grid = $("onboarding-grid");
  grid.replaceChildren(...PROFESSION_PACKS.map(pack => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "template-card";
    const strong = document.createElement("strong");
    strong.textContent = pack.name;
    const small = document.createElement("small");
    small.style.color = "var(--subtle)";
    small.textContent = pack.desc;
    btn.append(strong, small);
    btn.addEventListener("click", () => void run(async () => {
      const ids = await newNotes(pack.notes());
      onboardingDialog.close();
      await openNote(ids[0], false, "note");
      status(`${pack.name} workspace notes created.`);
    }));
    return btn;
  }));
  onboardingDialog.showModal();
}
$("open-onboarding")?.addEventListener("click", openOnboardingModal);
$("onboarding-close")?.addEventListener("click", () => onboardingDialog.close());

const bibtexDialog = $("bibtex-dialog");
$("open-bibtex")?.addEventListener("click", () => {
  $("bibtex-input").value = "";
  $("bibtex-error").hidden = true;
  bibtexDialog.showModal();
  $("bibtex-input").focus();
});
for (const id of ["bibtex-close", "bibtex-cancel"]) $(id)?.addEventListener("click", () => bibtexDialog.close());
$("bibtex-form")?.addEventListener("submit", event => {
  event.preventDefault();
  $("bibtex-error").hidden = true;
  void (async () => {
    try {
      const created = await request("/tools/bibtex", {body: {bibtex: $("bibtex-input").value}});
      bibtexDialog.close();
      await refresh();
      await openNote(created.id, false, "note");
      status(`Imported paper: ${created.title}`);
    } catch (error) {
      $("bibtex-error").textContent = error.message;
      $("bibtex-error").hidden = false;
    }
  })();
});

const clipperDialog = $("clipper-dialog");
$("open-clipper")?.addEventListener("click", () => {
  $("clip-title").value = "";
  $("clip-url").value = "";
  $("clip-quote").value = "";
  $("clip-tags").value = "WebClip";
  $("clip-error").hidden = true;
  clipperDialog.showModal();
  $("clip-title").focus();
});
for (const id of ["clipper-close", "clip-cancel"]) $(id)?.addEventListener("click", () => clipperDialog.close());

const mirrorDialog = $("mirror-dialog");
function renderMirrorStatus(cfg) {
  $("mirror-dir").value = cfg.dir || "";
  $("mirror-enabled").checked = Boolean(cfg.enabled);
  $("mirror-status").textContent = cfg.lastSync
    ? `Last synced: ${cfg.lastSync.replace("T", " ")} (${cfg.files || 0} files)`
    : "Not synced yet.";
}
$("open-mirror")?.addEventListener("click", () => void run(async () => {
  $("mirror-error").hidden = true;
  const cfg = await request("/mirror/config");
  renderMirrorStatus(cfg);
  mirrorDialog.showModal();
  $("mirror-dir").focus();
}));
for (const id of ["mirror-close", "mirror-cancel"]) $(id)?.addEventListener("click", () => mirrorDialog.close());
$("mirror-form")?.addEventListener("submit", event => {
  event.preventDefault();
  $("mirror-error").hidden = true;
  void (async () => {
    try {
      const cfg = await request("/mirror/config", {
        body: {dir: $("mirror-dir").value.trim(), enabled: $("mirror-enabled").checked},
      });
      renderMirrorStatus(cfg);
      status(cfg.enabled ? `Markdown mirror enabled (${cfg.files} files).` : "Markdown mirror saved.");
    } catch (error) {
      $("mirror-error").textContent = error.message;
      $("mirror-error").hidden = false;
    }
  })();
});
$("mirror-sync-now")?.addEventListener("click", () => void (async () => {
  $("mirror-error").hidden = true;
  try {
    await request("/mirror/config", {
      body: {dir: $("mirror-dir").value.trim(), enabled: $("mirror-enabled").checked},
    });
    const cfg = await request("/mirror/sync", {body: {}});
    renderMirrorStatus(cfg);
    status(`Mirrored ${cfg.files} files to ${cfg.dir}.`);
  } catch (error) {
    $("mirror-error").textContent = error.message;
    $("mirror-error").hidden = false;
  }
})());
$("clipper-form")?.addEventListener("submit", event => {
  event.preventDefault();
  $("clip-error").hidden = true;
  void (async () => {
    try {
      const tags = $("clip-tags").value.split(",").map(t => t.trim()).filter(Boolean);
      const created = await request("/clip", {
        body: {
          title: $("clip-title").value.trim(),
          url: $("clip-url").value.trim(),
          quote: $("clip-quote").value.trim(),
          tags,
        },
      });
      clipperDialog.close();
      await refresh();
      await openNote(created.id, false, "note");
      status(`Web clip saved: ${created.title}`);
    } catch (error) {
      $("clip-error").textContent = error.message;
      $("clip-error").hidden = false;
    }
  })();
});

$("export-note-docx")?.addEventListener("click", () => void run(async () => {
  if (!state.note) throw new Error("Open a note first to export as Word (.docx).");
  await download(`/notes/${state.note.id}/export?format=docx`, `${state.note.title}.docx`);
}));
$("export-note-epub")?.addEventListener("click", () => void run(async () => {
  if (!state.note) throw new Error("Open a note first to export as eBook (.epub).");
  await download(`/notes/${state.note.id}/export?format=epub`, `${state.note.title}.epub`);
}));

let dailyWordGoal = (() => { try { return Number(localStorage.getItem("xotira-word-goal") || "0") || 0; } catch { return 0; } })();
function updateWordGoalBadge() {
  const btn = $("word-goal-btn");
  if (!btn) return;
  const lbl = t("word-goal");
  if (!dailyWordGoal || !state.note) { btn.textContent = lbl; return; }
  const text = $("body").value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const pct = Math.min(100, Math.round((words / dailyWordGoal) * 100));
  btn.textContent = `${lbl} ${pct}%`;
}
$("word-goal-btn")?.addEventListener("click", () => {
  const entered = window.prompt("Daily word goal for this note (0 to clear):", String(dailyWordGoal || 500));
  if (entered === null) return;
  dailyWordGoal = Math.max(0, Math.min(50000, Number.parseInt(entered, 10) || 0));
  try { localStorage.setItem("xotira-word-goal", String(dailyWordGoal)); } catch {}
  updateWordGoalBadge();
});
$("body")?.addEventListener("input", updateWordGoalBadge);
$("notion-editor")?.addEventListener("input", updateWordGoalBadge);

let speechRec = null;
function stopVoiceDictation() {
  if (!speechRec) return;
  try { speechRec.stop(); } catch {}
  speechRec = null;
  $("voice-note")?.setAttribute("aria-pressed", "false");
}
$("voice-note")?.addEventListener("click", () => {
  const btn = $("voice-note");
  if (speechRec) {
    stopVoiceDictation();
    status("Voice dictation stopped.");
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    status("Voice dictation requires Chrome, Edge, or Safari SpeechRecognition support.", true);
    return;
  }
  if (!state.note || state.note.trashed) {
    status("Open an active note before starting voice dictation.", true);
    return;
  }
  speechRec = new SR();
  speechRec.continuous = true;
  speechRec.interimResults = false;
  speechRec.lang = document.documentElement.lang === "uz" ? "uz-UZ" : (document.documentElement.lang || "en-US");
  speechRec.onresult = event => {
    const transcript = Array.from(event.results).slice(event.resultIndex).map(r => r[0].transcript).join(" ").trim();
    if (!transcript || !state.note) return;
    const current = $("body").value;
    const next = current ? `${current}\n\n${transcript}` : transcript;
    $("body").value = next;
    if (!state.sourceMode) notionEditor.setValue(next, false);
    scheduleSave();
    updateWordGoalBadge();
  };
  speechRec.onerror = () => { speechRec = null; btn.setAttribute("aria-pressed", "false"); };
  speechRec.onend = () => { speechRec = null; btn.setAttribute("aria-pressed", "false"); };
  speechRec.start();
  btn.setAttribute("aria-pressed", "true");
  status("Listening… speak to dictate into this note.");
});

void initialize();

for (const [id, feature] of [["nav-calendar", "calendar"], ["nav-roadmaps", "roadmaps"], ["study-vault", "flashcards"],
    ["open-templates", "templates"], ["daily-note", "daily"]]) {
  $(id)?.addEventListener("click", () => track(feature));
}

// English spell check: the browser underlines misspelled words; right-click shows its suggestions.
function applySpellcheck(on) {
  notionEditor.setSpellcheck(on);
  for (const id of ["title", "body"]) {
    const field = $(id);
    field.spellcheck = on;
    if (on) field.lang = "en"; else field.removeAttribute("lang");
  }
  const button = $("spell-toggle");
  button.setAttribute("aria-pressed", String(on));
  button.textContent = on ? "Spell ✓" : "Spell";
  try { localStorage.setItem(SPELL_KEY, on ? "1" : "0"); } catch { /* private mode */ }
}
$("spell-toggle").addEventListener("click", () => applySpellcheck($("spell-toggle").getAttribute("aria-pressed") !== "true"));
applySpellcheck(spellSaved);

// v31: One-Time Recovery Key & Per-Note Password Lock
const recoveryDialog = $("recovery-dialog");
$("open-recovery")?.addEventListener("click", () => void run(async () => {
  $("recovery-error").hidden = true;
  $("recovery-output-box").hidden = true;
  $("recovery-output").value = "";
  const info = await request("/recovery-key");
  $("recovery-status").textContent = info.configured
    ? "A recovery key is active. Generating a new one replaces the previous key."
    : "No recovery key generated yet.";
  recoveryDialog.showModal();
}));
for (const id of ["recovery-close", "recovery-cancel"]) $(id)?.addEventListener("click", () => recoveryDialog.close());
recoveryDialog.addEventListener("close", () => {
  $("recovery-output").value = "";
  $("recovery-output-box").hidden = true;
});
$("recovery-generate")?.addEventListener("click", () => void (async () => {
  const generate = $("recovery-generate");
  const session = state.session;
  generate.disabled = true;
  $("recovery-error").hidden = true;
  try {
    const res = await request("/recovery-key", {body: {}});
    if (!state.unlocked || session !== state.session || !recoveryDialog.open) return;
    $("recovery-output").value = res.recoveryKey;
    $("recovery-output-box").hidden = false;
    $("recovery-status").textContent = "Recovery key active. Save or print it now.";
  } catch (error) {
    $("recovery-error").textContent = error.message;
    $("recovery-error").hidden = false;
  } finally {
    generate.disabled = false;
  }
})());
$("recovery-copy")?.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("recovery-output").value); $("recovery-copy").textContent = "Copied"; setTimeout(() => { $("recovery-copy").textContent = "Copy"; }, 1400); } catch {}
});

const noteLockDialog = $("note-lock-dialog");
let noteLockMode = "set"; // unlock | set
function openNoteLockDialog() {
  if (!state.note || state.note.trashed) return;
  $("note-lock-error").hidden = true;
  $("note-lock-current").value = "";
  $("note-lock-new").value = "";
  if (state.note.locked) {
    noteLockMode = "unlock";
    $("note-lock-desc").textContent = "This note is password-protected. Enter its password to view and edit it.";
    $("note-lock-current-wrap").hidden = false;
    $("note-lock-new-wrap").hidden = true;
    $("note-lock-relock").hidden = true;
    $("note-lock-submit").textContent = "Unlock note";
    noteLockDialog.showModal();
    $("note-lock-current").focus();
  } else {
    noteLockMode = "set";
    $("note-lock-desc").textContent = state.note.hasPassword
      ? "Change or remove the password for this note."
      : "Require a separate password when opening this note. This also unpublishes its shared page.";
    $("note-lock-current-wrap").hidden = !state.note.hasPassword;
    $("note-lock-new-wrap").hidden = false;
    $("note-lock-relock").hidden = !state.note.hasPassword;
    $("note-lock-submit").textContent = "Save";
    noteLockDialog.showModal();
    $((state.note.hasPassword ? "note-lock-current" : "note-lock-new")).focus();
  }
}
$("lock-note-btn")?.addEventListener("click", openNoteLockDialog);
noteLockDialog.addEventListener("close", () => {
  $("note-lock-current").value = "";
  $("note-lock-new").value = "";
});
for (const id of ["note-lock-close", "note-lock-cancel"]) $(id)?.addEventListener("click", () => noteLockDialog.close());
$("note-lock-relock")?.addEventListener("click", () => void run(async () => {
  if (!state.note || !await flush()) return;
  const id = state.note.id;
  if (viewer.active?.noteId === id) {
    await viewer.flush();
    viewer.close();
  }
  await request(`/notes/${id}/lock`, {body: {action: "lock"}});
  noteLockDialog.close();
  clearImages();
  const locked = await request(`/notes/${id}`);
  if (state.unlocked && state.note?.id === id) renderEditor(locked);
  await refresh();
}));
$("note-lock-form")?.addEventListener("submit", event => {
  event.preventDefault();
  if (!state.note) return;
  $("note-lock-error").hidden = true;
  void (async () => {
    try {
      if (noteLockMode === "unlock") {
        const unlocked = await request(`/notes/${state.note.id}/lock`, {
          body: {action: "unlock", password: $("note-lock-current").value},
        });
        noteLockDialog.close();
        renderEditor(unlocked);
        await refresh();
      } else {
        await request(`/notes/${state.note.id}/lock`, {
          body: {action: "set", password: $("note-lock-new").value, currentPassword: $("note-lock-current").value},
        });
        noteLockDialog.close();
        renderEditor(await request(`/notes/${state.note.id}`));
        await refresh();
        status("Note password updated.");
      }
    } catch (error) {
      $("note-lock-error").textContent = error.message;
      $("note-lock-error").hidden = false;
    }
  })();
});

// Online identity is separate from the encrypted vault.
function showAccount(data) {
  $("account-status").textContent = !data.configured ? "Online accounts are not configured yet."
    : data.user?.email ? "Signed in as " + data.user.email : data.message || "Sign in or create an account.";
  $("account-form").hidden = !data.configured || Boolean(data.user?.email);
  $("account-signout").hidden = !data.user?.email;
  $("account-refresh").hidden = !data.configured;
  if (data.user?.email) $("account-google-link").hidden = true;
}
async function refreshAccount() { showAccount(await request("/account")); }
$("open-account").addEventListener("click", () => void run(async () => {
  $("file-menu").open = false;
  $("account-google-link").hidden = true;
  await refreshAccount();
  $("account-dialog").showModal();
}));
$("account-close").addEventListener("click", () => $("account-dialog").close());
$("account-dialog").addEventListener("close", () => {
  $("account-password").value = "";
  $("account-google-link").hidden = true;
});
$("account-refresh").addEventListener("click", () => void run(refreshAccount));
$("account-form").addEventListener("submit", event => {
  event.preventDefault();
  const action = event.submitter?.value;
  const email = $("account-email").value;
  const password = $("account-password").value;
  $("account-password").value = "";
  void run(async () => {
    try { showAccount(await request("/account", {body: {action, email, password}})); }
    catch (error) { $("account-status").textContent = error.message; }
  });
});
$("account-google").addEventListener("click", () => void run(async () => {
  const data = await request("/account", {body: {action: "google"}});
  const link = $("account-google-link");
  link.href = data.url;
  link.hidden = false;
  $("account-status").textContent = "Open the Google sign-in page, then return here and refresh the account status.";
}));
$("account-signout").addEventListener("click", () => void run(async () =>
  showAccount(await request("/account", {body:{action:"sign-out"}}))));

function showUpdates(data) {
  $("updates-auto").checked = data.enabled;
  $("updates-auto").disabled = !data.supported;
  $("updates-status").textContent = !data.supported ? "Automatic updates are available in installed desktop builds."
    : data.busy ? "Checking and verifying updates…" : data.staged ? data.staged + " will open on your next launch."
    : data.message || "Current version: " + data.current;
}
async function refreshUpdates() { showUpdates(await request("/update-settings")); }
$("open-update-settings").addEventListener("click", () => void run(async () => {
  $("file-menu").open = false;
  await refreshUpdates();
  $("updates-dialog").showModal();
}));
$("updates-close").addEventListener("click", () => $("updates-dialog").close());
$("updates-refresh").addEventListener("click", () => void run(refreshUpdates));
$("updates-auto").addEventListener("change", event => {
  void run(async () => showUpdates(await request("/update-settings", {body:{enabled:event.target.checked}})));
});
