import {buildRoadmaps, calendarEntries, dateKey, monthDays} from "./work-planning.js";
import {t} from "./i18n.js";

/**
 * Xotira v13 — True Notion Database Engine + Global Cross-Vault Task Hub
 * Views:
 *  1. Table (Inline editable Status & Priority pills, Pin, Folder, Tags, Links, Words, Updated)
 *  2. Drag-and-Drop Status Kanban (Note / Planned / In progress / Done)
 *  3. Global Task Hub (Aggregates ALL - [ ] / - [x] checkboxes across the vault with live toggle!)
 *  4. Visual Gallery Cards
 */

export const STATUS_LIST = [
  {id: "note", label: "Note", cls: "st-note"},
  {id: "todo", label: "Planned", cls: "st-todo"},
  {id: "doing", label: "In progress", cls: "st-doing"},
  {id: "done", label: "Done", cls: "st-done"},
];

export const PRIORITY_LIST = [
  {id: "", label: "—", cls: "pr-none"},
  {id: "high", label: "High", cls: "pr-high"},
  {id: "med", label: "Medium", cls: "pr-med"},
  {id: "low", label: "Low", cls: "pr-low"},
];

export function noteFields(note) {
  return {status: "note", priority: "", due: "", icon: "", cover: "", type: "note",
    relationships: [], ...note?.entity?.fields};
}

function planElement(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function planButton(label, activate, className) {
  const button = planElement("button", label, className);
  button.type = "button";
  button.addEventListener("click", activate);
  return button;
}

function progressBar(done, total, percent) {
  const group = planElement("div", undefined, "progress-group");
  if (total) {
    const meter = document.createElement("progress");
    meter.max = total;
    meter.value = done;
    meter.setAttribute("aria-label", `${done} of ${total} tasks done`);
    group.append(meter);
  }
  group.append(planElement("span", total ? `${percent}% · ${done}/${total}` : "No tasks", "plan-meta"));
  return group;
}

export const GROUP_BY_OPTIONS = [
  {id: "", labelKey: "db-group-none", fallback: "No grouping"},
  {id: "status", labelKey: "db-group-status", fallback: "Group: Status"},
  {id: "priority", labelKey: "db-group-priority", fallback: "Group: Priority"},
  {id: "type", labelKey: "db-group-type", fallback: "Group: Type"},
  {id: "folder", labelKey: "db-group-folder", fallback: "Group: Folder"},
  {id: "tag", labelKey: "db-group-tag", fallback: "Group: Tag"},
];

const DB_VIEWS_KEY = "xotira-db-views";

export function builtinViews(translate = t) {
  return [
    {id: "all", name: translate("db-view-all") || "All notes", builtin: true, mode: "table", groupBy: "", sortBy: "updated", sortDir: -1, filterText: "", filterPreset: ""},
    {id: "overdue", name: translate("db-view-overdue") || "Overdue", builtin: true, mode: "table", groupBy: "priority", sortBy: "updated", sortDir: -1, filterText: "", filterPreset: "overdue"},
    {id: "my-tasks", name: translate("db-view-tasks") || "My tasks", builtin: true, mode: "tasks", groupBy: "", sortBy: "updated", sortDir: -1, filterText: "", filterPreset: ""},
    {id: "active", name: translate("db-view-active") || "In progress", builtin: true, mode: "table", groupBy: "priority", sortBy: "updated", sortDir: -1, filterText: "", filterPreset: "doing"},
  ];
}

function loadSavedViewsFromStorage() {
  try {
    const raw = localStorage.getItem(DB_VIEWS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(v => v && typeof v.id === "string" && typeof v.name === "string") : [];
  } catch { return []; }
}

function persistSavedViewsToStorage(views) {
  try { localStorage.setItem(DB_VIEWS_KEY, JSON.stringify(views)); } catch {}
}

export class DatabaseView {
  constructor(container, onOpenNote, onTogglePin, options = {}) {
    this.container = container;
    this.onOpenNote = onOpenNote;
    this.dragNote = options.dragNote;
    this.onMode = options.onMode;
    this.onNewEvent = options.onNewEvent;
    this.onNewRoadmap = options.onNewRoadmap;
    this.reminders = {};
    this.calendarDay = dateKey(new Date());
    this.roadmapId = "";
    this.onTogglePin = onTogglePin;
    this.onUpdateFields = options.onUpdateFields;
    this.month = new Date();
    this.month.setDate(1);
    this.month.setHours(12, 0, 0, 0);
    this.onLoadTasks = options.onLoadTasks || null;
    this.onToggleTask = options.onToggleTask || null;
    this.mode = "table"; // table | kanban | gantt | tasks | gallery | calendar | roadmaps
    this.groupBy = ""; // "" | status | priority | type | folder | tag
    this.sortBy = "updated";
    this.sortDir = -1;
    this.filterText = "";
    this.filterPreset = ""; // "" | overdue | due-soon | high | doing | favorites
    this.activeViewId = "all";
    this.savedViews = Array.isArray(options.savedViews) ? [...options.savedViews] : loadSavedViewsFromStorage();
    this.onSaveViews = options.onSaveViews || persistSavedViewsToStorage;
    this.savingViewOpen = false;
    this.taskFilter = "open"; // all | open | done
    this.data = {nodes: [], edges: [], all: []};
    this.cachedTasks = null;
    this.loadingTasks = false;
    this.taskSequence = 0;
  }

  setData(nodes, edges, display = true, all = nodes) {
    this.data = {nodes: nodes || [], edges: edges || [], all: all || []};
    this.cachedTasks = null;
    this.loadingTasks = false;
    this.taskSequence++;
    if (display) this.render();
  }

  degreeMap() {
    const map = new Map();
    for (const [a, b] of this.data.edges) {
      map.set(a, (map.get(a) || 0) + 1);
      map.set(b, (map.get(b) || 0) + 1);
    }
    return map;
  }

  matchesPreset(note, meta, todayStr) {
    if (!this.filterPreset) return true;
    if (this.filterPreset === "overdue") return Boolean(meta.due && meta.due < todayStr && meta.status !== "done");
    if (this.filterPreset === "due-soon") {
      if (!meta.due || meta.status === "done") return false;
      const upcoming = new Date();
      upcoming.setDate(upcoming.getDate() + 7);
      return meta.due >= todayStr && meta.due <= dateKey(upcoming);
    }
    if (this.filterPreset === "high") return meta.priority === "high";
    if (this.filterPreset === "doing") return meta.status === "doing";
    if (this.filterPreset === "favorites") return Boolean(note.pinned);
    return true;
  }

  filteredNotes(deg) {
    const q = this.filterText.trim().toLowerCase();
    const todayStr = dateKey(new Date());
    const list = this.data.nodes.filter(n => {
      const meta = noteFields(n);
      if (!this.matchesPreset(n, meta, todayStr)) return false;
      if (!q) return true;
      const hay = `${n.title} ${n.path || ""} ${(n.tags || []).join(" ")} ${n.preview || ""} ${meta.status} ${meta.priority} ${meta.type}`.toLowerCase();
      return hay.includes(q);
    });
    list.sort((a, b) => {
      if (Boolean(b.pinned) !== Boolean(a.pinned)) return Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
      let cmp = 0;
      if (this.sortBy === "title") cmp = a.title.localeCompare(b.title);
      else if (this.sortBy === "words") cmp = (a.words || 0) - (b.words || 0);
      else if (this.sortBy === "links") cmp = (deg.get(a.id) || 0) - (deg.get(b.id) || 0);
      else cmp = (a.updated || "").localeCompare(b.updated || "");
      return cmp * this.sortDir;
    });
    return list;
  }

  groupNotes(notes) {
    if (!this.groupBy) return [{key: "", label: "", notes}];
    const buckets = new Map();
    const add = (key, label, note) => {
      if (!buckets.has(key)) buckets.set(key, {key, label, notes: []});
      buckets.get(key).notes.push(note);
    };
    if (this.groupBy === "status") {
      for (const st of STATUS_LIST) buckets.set(st.id, {key: st.id, label: st.label, notes: []});
      for (const n of notes) {
        const stId = noteFields(n).status || "note";
        const stObj = STATUS_LIST.find(s => s.id === stId) || STATUS_LIST[0];
        add(stObj.id, stObj.label, n);
      }
      return [...buckets.values()].filter(g => g.notes.length > 0);
    }
    if (this.groupBy === "priority") {
      for (const pr of [PRIORITY_LIST[1], PRIORITY_LIST[2], PRIORITY_LIST[3], PRIORITY_LIST[0]]) {
        buckets.set(pr.id, {key: pr.id, label: pr.id ? pr.label : "No priority", notes: []});
      }
      for (const n of notes) {
        const prId = noteFields(n).priority || "";
        const prObj = PRIORITY_LIST.find(p => p.id === prId) || PRIORITY_LIST[0];
        add(prObj.id, prObj.id ? prObj.label : "No priority", n);
      }
      return [...buckets.values()].filter(g => g.notes.length > 0);
    }
    if (this.groupBy === "type") {
      for (const n of notes) {
        const tp = noteFields(n).type || "note";
        add(tp, tp.charAt(0).toUpperCase() + tp.slice(1), n);
      }
      return [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label));
    }
    if (this.groupBy === "folder") {
      for (const n of notes) {
        const folder = n.path ? n.path.split("/").slice(0, -1).join("/") || n.source || "General" : (n.source || "Notes");
        add(folder, folder, n);
      }
      return [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label));
    }
    if (this.groupBy === "tag") {
      for (const n of notes) {
        const tags = new Set(n.tags?.length ? n.tags.map(tag => `#${tag}`) : ["Untagged"]);
        for (const tag of tags) add(tag, tag, n);
      }
      return [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label));
    }
    return [{key: "", label: "", notes}];
  }

  allViews() {
    return [...builtinViews(), ...this.savedViews];
  }

  applyView(view) {
    this.activeViewId = view.id;
    this.mode = view.mode || "table";
    this.groupBy = view.groupBy || "";
    this.sortBy = view.sortBy || "updated";
    this.sortDir = view.sortDir ?? -1;
    this.filterText = view.filterText || "";
    this.filterPreset = view.filterPreset || "";
    this.taskFilter = view.taskFilter || "open";
    this.savingViewOpen = false;
    this.onMode?.();
    this.render();
  }

  saveCurrentView(rawName) {
    const name = String(rawName || "").trim().slice(0, 40);
    if (!name) return null;
    const view = {
      id: "view_" + crypto.randomUUID(),
      name,
      builtin: false,
      mode: this.mode,
      groupBy: this.groupBy,
      sortBy: this.sortBy,
      sortDir: this.sortDir,
      filterText: this.filterText,
      filterPreset: this.filterPreset,
      taskFilter: this.taskFilter,
    };
    this.savedViews = [...this.savedViews, view];
    this.onSaveViews(this.savedViews, {action: "save", view});
    this.activeViewId = view.id;
    this.savingViewOpen = false;
    this.render();
    return view;
  }

  deleteSavedView(id) {
    this.savedViews = this.savedViews.filter(v => v.id !== id);
    this.onSaveViews(this.savedViews, {action: "remove", id});
    if (this.activeViewId === id) {
      this.applyView(builtinViews()[0]);
    } else {
      this.render();
    }
  }

  clearActiveView() {
    this.activeViewId = "";
    this.container.querySelectorAll?.('.db-view-chip [aria-pressed="true"]')
      .forEach(button => button.setAttribute("aria-pressed", "false"));
  }

  render() {
    const deg = this.degreeMap();
    const notes = this.filteredNotes(deg);

    const wrap = document.createElement("div");
    wrap.className = "db-shell";

    // Summary Metrics Strip
    const pinnedCount = this.data.nodes.filter(n => n.pinned).length;
    const totalWords = this.data.nodes.reduce((s, n) => s + (n.words || 0), 0);
    const activeProjects = this.data.nodes.filter(n => noteFields(n).status === "doing").length;

    const stats = document.createElement("div");
    stats.className = "db-stats";
    stats.innerHTML = `
      <div class="db-stat"><strong>${this.data.nodes.length}</strong><span>Notes</span></div>
      <div class="db-stat"><strong>${this.data.edges.length}</strong><span>Relationships</span></div>
      <div class="db-stat"><strong>${activeProjects}</strong><span>In progress</span></div>
      <div class="db-stat"><strong>${pinnedCount}</strong><span>Favorites</span></div>
      <div class="db-stat"><strong>${totalWords.toLocaleString("en")}</strong><span>Total words</span></div>`;

    // Saved Views Bar
    const viewsBar = document.createElement("div");
    viewsBar.className = "db-views-bar";
    viewsBar.setAttribute("aria-label", t("db-saved-views") || "Saved views");
    for (const view of this.allViews()) {
      const chip = document.createElement("div");
      chip.className = "db-view-chip";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "compact";
      btn.textContent = view.name;
      btn.setAttribute("aria-pressed", String(this.activeViewId === view.id));
      btn.addEventListener("click", () => this.applyView(view));
      chip.append(btn);
      if (!view.builtin) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "db-view-del";
        del.textContent = "×";
        del.setAttribute("aria-label", `Delete view ${view.name}`);
        del.addEventListener("click", e => { e.stopPropagation(); this.deleteSavedView(view.id); });
        chip.append(del);
      }
      viewsBar.append(chip);
    }
    if (this.savingViewOpen) {
      const form = document.createElement("form");
      form.className = "db-save-view-form";
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 40;
      nameInput.placeholder = t("db-view-name-ph") || "View name…";
      nameInput.className = "compact";
      const confirmBtn = document.createElement("button");
      confirmBtn.type = "submit";
      confirmBtn.className = "compact primary";
      confirmBtn.textContent = t("fc-save") || "Save";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "compact";
      cancelBtn.textContent = "×";
      cancelBtn.addEventListener("click", () => { this.savingViewOpen = false; this.render(); });
      form.addEventListener("submit", e => {
        e.preventDefault();
        if (!this.saveCurrentView(nameInput.value)) nameInput.focus();
      });
      form.append(nameInput, confirmBtn, cancelBtn);
      viewsBar.append(form);
      queueMicrotask(() => nameInput.focus());
    } else {
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "compact db-save-view-btn";
      saveBtn.textContent = "+ " + (t("db-save-view") || "Save view");
      saveBtn.addEventListener("click", () => { this.savingViewOpen = true; this.render(); });
      viewsBar.append(saveBtn);
    }

    // Toolbar
    const bar = document.createElement("div");
    bar.className = "db-toolbar";

    const modes = document.createElement("div");
    modes.className = "db-modes";
    for (const [id, label] of [
      ["table", "⊞ " + t("db-table")],
      ["kanban", "▥ " + t("db-kanban")],
      ["gantt", "▬ " + t("db-gantt")],
      ["tasks", "☑ " + t("db-tasks")],
      ["gallery", "▦ " + t("db-gallery")],
      ["calendar", t("db-calendar")],
      ["roadmaps", t("db-roadmaps")],
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "compact";
      btn.textContent = label;
      btn.setAttribute("aria-pressed", String(this.mode === id));
      btn.addEventListener("click", () => { this.mode = id; this.activeViewId = ""; this.onMode?.(); this.render(); });
      modes.append(btn);
    }

    const search = document.createElement("input");
    search.type = "search";
    search.maxLength = 200;
    search.className = "db-search";
    search.placeholder = this.mode === "tasks" ? "Find a task…" : "Search database…";
    search.value = this.filterText;
    search.addEventListener("input", () => {
      this.filterText = search.value;
      this.clearActiveView();
      this.renderBody(bodyHost, deg);
    });

    const groupSel = document.createElement("select");
    groupSel.className = "compact db-group-select";
    groupSel.setAttribute("aria-label", t("db-group-label"));
    groupSel.hidden = !["table", "gallery"].includes(this.mode);
    for (const opt of GROUP_BY_OPTIONS) {
      groupSel.append(new Option(t(opt.labelKey) || opt.fallback, opt.id, false, this.groupBy === opt.id));
    }
    groupSel.addEventListener("change", () => {
      this.groupBy = groupSel.value;
      this.clearActiveView();
      this.renderBody(bodyHost, deg);
    });

    const sortSel = document.createElement("select");
    sortSel.className = "compact";
    sortSel.hidden = ["tasks", "calendar", "roadmaps"].includes(this.mode);
    for (const [val, label] of [["updated", "By date"], ["title", "Alphabetical"], ["links", "Relationships"], ["words", "Word count"]]) {
      sortSel.append(new Option(label, val, false, this.sortBy === val));
    }
    sortSel.addEventListener("change", () => {
      this.sortBy = sortSel.value;
      this.clearActiveView();
      this.renderBody(bodyHost, deg);
    });

    const preset = document.createElement("select");
    preset.className = "compact";
    preset.setAttribute("aria-label", t("db-filter-label"));
    preset.hidden = this.mode === "tasks";
    for (const id of ["", "overdue", "due-soon", "high", "doing", "favorites"]) {
      preset.append(new Option(t(`db-filter-${id || "any"}`), id, false, this.filterPreset === id));
    }
    preset.addEventListener("change", () => {
      this.filterPreset = preset.value;
      this.clearActiveView();
      this.renderBody(bodyHost, deg);
    });
    bar.append(modes, search, preset, groupSel, sortSel);

    const bodyHost = document.createElement("div");
    bodyHost.className = "db-body";
    this.renderBody(bodyHost, deg, notes);

    wrap.append(stats, viewsBar, bar, bodyHost);
    this.container.replaceChildren(wrap);
  }

  renderBody(host, deg, prefiltered = null) {
    if (this.mode === "tasks" || this.mode === "roadmaps") {
      if (!this.loadPlanningTasks(host)) return;
      if (this.mode === "tasks") this.renderTasks(host);
      else this.renderRoadmaps(host, prefiltered || this.filteredNotes(deg));
      return;
    }
    const notes = prefiltered || this.filteredNotes(deg);
    if (this.mode === "calendar") {
      this.renderCalendar(host, notes);
      return;
    }
    if (!notes.length) {
      const empty = document.createElement("p");
      empty.className = "db-empty";
      empty.textContent = "No notes to display.";
      host.replaceChildren(empty);
      return;
    }
    if (this.mode === "table") this.renderTable(host, notes, deg);
    else if (this.mode === "gantt") this.renderGantt(host, notes);
    else if (this.mode === "gallery") this.renderGallery(host, notes, deg);
    else this.renderKanban(host, notes, deg);
  }

  buildTableElement(notes, deg) {
    const table = document.createElement("table");
    table.className = "db-table";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const h of ["★", "Title", "Status", "Priority", "Folder", "Tags", "Links", "Updated"]) {
      const th = document.createElement("th");
      th.textContent = h;
      hr.append(th);
    }
    thead.append(hr);

    const tbody = document.createElement("tbody");
    for (const n of notes) {
      const meta = noteFields(n);
      const tr = document.createElement("tr");

      const tdPin = document.createElement("td");
      const pinBtn = document.createElement("button");
      pinBtn.type = "button";
      pinBtn.className = "pin-star" + (n.pinned ? " is-pinned" : "");
      pinBtn.textContent = n.pinned ? "★" : "☆";
      pinBtn.addEventListener("click", e => { e.stopPropagation(); this.onTogglePin(n.id, !n.pinned); });
      tdPin.append(pinBtn);

      const tdTitle = document.createElement("td");
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "db-link";
      openBtn.textContent = (meta.icon ? meta.icon + " " : "") + n.title;
      openBtn.addEventListener("click", () => this.onOpenNote(n.id));
      this.dragNote?.(openBtn, n.id);
      tdTitle.append(openBtn);

      const tdStatus = document.createElement("td");
      const stSel = document.createElement("select");
      const stObj = STATUS_LIST.find(s => s.id === meta.status) || STATUS_LIST[0];
      stSel.className = `db-status-pick ${stObj.cls}`;
      for (const s of STATUS_LIST) stSel.append(new Option(s.label, s.id, false, s.id === meta.status));
      stSel.setAttribute("aria-label", n.title + " · Status");
      stSel.addEventListener("change", () => {
        const value = stSel.value;
        stSel.value = meta.status;
        void this.onUpdateFields(n.id, {status: value}).catch(() => {});
      });
      tdStatus.append(stSel);

      const tdPrio = document.createElement("td");
      const prSel = document.createElement("select");
      const prObj = PRIORITY_LIST.find(p => p.id === meta.priority) || PRIORITY_LIST[0];
      prSel.className = `db-prio-pick ${prObj.cls}`;
      for (const p of PRIORITY_LIST) prSel.append(new Option(p.label, p.id, false, p.id === meta.priority));
      prSel.setAttribute("aria-label", n.title + " · Priority");
      prSel.addEventListener("change", () => {
        const value = prSel.value;
        prSel.value = meta.priority;
        void this.onUpdateFields(n.id, {priority: value}).catch(() => {});
      });
      tdPrio.append(prSel);

      const tdFolder = document.createElement("td");
      tdFolder.className = "db-muted";
      tdFolder.textContent = n.path ? n.path.split("/").slice(0, -1).join("/") || n.source || "General" : (n.source || "Notes");

      const tdTags = document.createElement("td");
      const pills = document.createElement("div");
      pills.className = "db-pills";
      for (const tag of (n.tags || []).slice(0, 3)) {
        const chip = document.createElement("span");
        chip.className = "db-pill";
        chip.textContent = "#" + tag;
        pills.append(chip);
      }
      tdTags.append(pills);

      const tdDeg = document.createElement("td");
      tdDeg.className = "db-num";
      tdDeg.textContent = String(deg.get(n.id) || 0);

      const tdDate = document.createElement("td");
      tdDate.className = "db-muted";
      tdDate.textContent = meta.due || (n.updated || "").slice(0, 10);

      tr.append(tdPin, tdTitle, tdStatus, tdPrio, tdFolder, tdTags, tdDeg, tdDate);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    return table;
  }

  renderTable(host, notes, deg) {
    const groups = this.groupNotes(notes);
    const nodes = [];
    if (this.groupBy) {
      for (const group of groups) {
        const details = document.createElement("details");
        details.className = "db-group";
        details.open = true;
        const summary = document.createElement("summary");
        summary.className = "db-group-head";
        summary.append(planElement("span", group.label), planElement("span", String(group.notes.length), "db-group-count"));
        details.append(summary, this.buildTableElement(group.notes, deg));
        nodes.push(details);
      }
    } else {
      nodes.push(this.buildTableElement(notes, deg));
    }
    const totalWords = notes.reduce((sum, n) => sum + (n.words || 0), 0);
    const avgWords = notes.length ? Math.round(totalWords / notes.length) : 0;
    const doneCount = notes.filter(n => noteFields(n).status === "done").length;
    const donePct = notes.length ? Math.round((doneCount / notes.length) * 100) : 0;
    const formulaBar = document.createElement("div");
    formulaBar.className = "db-formula-bar";
    formulaBar.innerHTML = `<span>COUNT: <strong>${notes.length}</strong></span><span>SUM(words): <strong>${totalWords.toLocaleString("en")}</strong></span><span>AVG(words): <strong>${avgWords.toLocaleString("en")}</strong></span><span>DONE: <strong>${donePct}%</strong> (${doneCount}/${notes.length})</span>`;
    nodes.push(formulaBar);
    host.replaceChildren(...nodes);
  }

  renderGantt(host, notes) {
    const dated = notes
      .map(n => ({note: n, meta: noteFields(n)}))
      .filter(item => item.meta.due || item.note.updated)
      .map(item => {
        const endStr = item.meta.due || (item.note.updated || "").slice(0, 10);
        const endMs = Date.parse(endStr + "T12:00:00Z") || Date.now();
        const startStr = (item.note.updated || endStr).slice(0, 10);
        const rawStart = Date.parse(startStr + "T12:00:00Z") || endMs - 3 * 86_400_000;
        const startMs = Math.min(rawStart, endMs - 86_400_000);
        return {...item, startMs, endMs, endStr};
      })
      .sort((a, b) => a.endMs - b.endMs);
    if (!dated.length) {
      host.replaceChildren(planElement("p", "Add a due date to notes to visualize them on the Gantt timeline.", "db-empty"));
      return;
    }
    const minMs = Math.min(...dated.map(d => d.startMs));
    const maxMs = Math.max(...dated.map(d => d.endMs), minMs + 7 * 86_400_000);
    const span = Math.max(1, maxMs - minMs);
    const shell = planElement("section", undefined, "gantt-shell");
    const header = planElement("div", undefined, "gantt-scale");
    header.innerHTML = `<span>${new Date(minMs).toISOString().slice(0, 10)}</span><span>Timeline / Gantt (${dated.length} items)</span><span>${new Date(maxMs).toISOString().slice(0, 10)}</span>`;
    shell.append(header);
    for (const item of dated.slice(0, 60)) {
      const row = planElement("div", undefined, "gantt-row");
      const label = planButton(item.note.title, () => this.onOpenNote(item.note.id), "gantt-label");
      const track = planElement("div", undefined, "gantt-track");
      const leftPct = Math.max(0, Math.min(92, ((item.startMs - minMs) / span) * 100));
      const widthPct = Math.max(6, Math.min(100 - leftPct, ((item.endMs - item.startMs) / span) * 100));
      const stObj = STATUS_LIST.find(s => s.id === item.meta.status) || STATUS_LIST[0];
      const bar = planElement("span", item.endStr, `gantt-bar ${stObj.cls}`);
      bar.style.left = `${leftPct}%`;
      bar.style.width = `${widthPct}%`;
      track.append(bar);
      row.append(label, track);
      shell.append(row);
    }
    host.replaceChildren(shell);
  }

  renderKanban(host, notes, deg) {
    const board = document.createElement("div");
    board.className = "db-kanban";

    for (const st of STATUS_LIST) {
      const items = notes.filter(n => noteFields(n).status === st.id);
      const col = document.createElement("section");
      col.className = "db-kanban-col";
      col.dataset.status = st.id;

      col.addEventListener("dragover", e => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        col.classList.add("drag-over");
      });
      col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
      col.addEventListener("drop", e => {
        e.preventDefault();
        col.classList.remove("drag-over");
        const noteId = e.dataTransfer?.getData("text/plain");
        if (noteId) {
          if (this.data.nodes.some(note => note.id === noteId)) {
            void this.onUpdateFields(noteId, {status: st.id}).catch(() => {});
          }
        }
      });

      const h = document.createElement("header");
      h.className = "db-kanban-head";
      const badge = document.createElement("span");
      badge.className = `status-badge ${st.cls}`;
      badge.textContent = st.label;
      const c = document.createElement("span");
      c.textContent = String(items.length);
      h.append(badge, c);

      const list = document.createElement("div");
      list.className = "db-kanban-cards";
      for (const n of items) {
        const meta = noteFields(n);
        const card = document.createElement("div");
        card.className = "db-kanban-card";
        card.draggable = true;
        this.dragNote?.(card, n.id);
        card.tabIndex = 0;
        card.addEventListener("dragstart", e => {
          e.dataTransfer?.setData("text/plain", n.id);
          card.classList.add("is-dragging-card");
        });
        card.addEventListener("dragend", () => card.classList.remove("is-dragging-card"));
        card.addEventListener("click", () => this.onOpenNote(n.id));
        card.addEventListener("keydown", event => {
          if (event.key === "Enter") this.onOpenNote(n.id);
        });

        const ct = document.createElement("strong");
        ct.textContent = (meta.icon ? meta.icon + " " : "") + (n.pinned ? "★ " : "") + n.title;
        const cp = document.createElement("small");
        cp.textContent = n.preview || `${deg.get(n.id) || 0} links`;
        card.append(ct, cp);
        if (meta.priority || meta.due) {
          const foot = document.createElement("div");
          foot.className = "db-card-foot";
          if (meta.priority) {
            const pObj = PRIORITY_LIST.find(p => p.id === meta.priority);
            if (pObj) foot.innerHTML += `<span class="prio-dot ${pObj.cls}">${pObj.label}</span>`;
          }
          if (meta.due) {
            const due = document.createElement("span");
            due.className = "due-pill";
            due.textContent = meta.due;
            foot.append(due);
          }
          card.append(foot);
        }
        list.append(card);
      }
      col.append(h, list);
      board.append(col);
    }
    host.replaceChildren(board);
  }

  renderCalendar(host, notes) {
    const shell = planElement("section", undefined, "planning-shell");
    const heading = planElement("header", undefined, "planning-heading");
    const monthTitle = new Intl.DateTimeFormat("en", {month: "long", year: "numeric"}).format(this.month);
    const buttons = planElement("div", undefined, "planning-actions");
    const changeMonth = step => {
      this.month.setMonth(this.month.getMonth() + step);
      this.calendarDay = dateKey(this.month);
      this.renderCalendar(host, notes);
      host.querySelector(step < 0 ? "[data-prev-month]" : "[data-next-month]")?.focus();
    };
    const prev = planButton("‹", () => changeMonth(-1));
    const next = planButton("›", () => changeMonth(1));
    prev.setAttribute("aria-label", "Previous month");
    next.setAttribute("aria-label", "Next month");
    prev.dataset.prevMonth = next.dataset.nextMonth = "";
    buttons.append(prev, planButton("Today", () => {
      this.month = new Date();
      this.month.setDate(1);
      this.calendarDay = dateKey(new Date());
      this.renderCalendar(host, notes);
      host.querySelector("[aria-current='date']")?.focus();
    }), next);
    heading.append(planElement("h2", monthTitle), buttons);
    const entries = calendarEntries(notes, this.reminders);
    const grid = planElement("div", undefined, "calendar-month");
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) grid.append(planElement("span", day));
    const today = dateKey(new Date());
    for (const day of monthDays(this.month)) {
      const events = entries.get(day.key) || [];
      const select = planButton(String(day.day), () => {
        this.calendarDay = day.key;
        this.renderCalendar(host, notes);
        host.querySelector("[data-calendar-day='" + day.key + "']")?.focus();
      });
      select.dataset.calendarDay = day.key;
      select.dataset.outside = String(!day.inMonth);
      select.setAttribute("aria-pressed", String(day.key === this.calendarDay));
      select.setAttribute("aria-label", `${day.key}, ${events.length} scheduled`);
      if (day.key === today) select.setAttribute("aria-current", "date");
      if (events.length) select.append(planElement("small", String(events.length)));
      grid.append(select);
    }
    const agenda = planElement("section", undefined, "calendar-agenda");
    const agendaHead = planElement("header", undefined, "planning-heading");
    const dayTitle = new Intl.DateTimeFormat("en", {dateStyle: "full"}).format(new Date(this.calendarDay + "T12:00:00"));
    agendaHead.append(planElement("h3", dayTitle));
    if (this.onNewEvent) agendaHead.append(planButton("New event", () => this.onNewEvent(this.calendarDay), "primary"));
    agenda.append(agendaHead);
    const events = entries.get(this.calendarDay) || [];
    if (!events.length) agenda.append(planElement("p", "No events for this day.", "plan-meta"));
    for (const event of events) {
      const row = planElement("div", undefined, "agenda-row");
      const open = planButton(event.note.title, () => this.onOpenNote(event.note.id), "ghost-btn");
      this.dragNote?.(open, event.note.id);
      const time = event.at ? new Intl.DateTimeFormat("en", {timeStyle: "short"}).format(new Date(event.at)) : "";
      row.append(open, planElement("span", [event.due ? "Due" : "", time ? "Reminder · " + time : ""].filter(Boolean).join(" · "), "plan-meta"));
      agenda.append(row);
    }
    shell.append(heading, grid, agenda);
    host.replaceChildren(shell);
  }

  loadPlanningTasks(host) {
    if (!this.onLoadTasks) {
      host.textContent = "Could not load tasks.";
      return false;
    }
    if (this.cachedTasks !== null) return true;
    host.replaceChildren(planElement("p", "Loading tasks…", "db-empty"));
    if (this.loadingTasks) return false;
    this.loadingTasks = true;
    const sequence = ++this.taskSequence;
    void this.onLoadTasks().then(tasks => {
      if (sequence !== this.taskSequence) return;
      this.cachedTasks = tasks || [];
      this.loadingTasks = false;
      const body = this.container.querySelector(".db-body") || host;
      this.renderBody(body, this.degreeMap());
    }).catch(error => {
      if (sequence !== this.taskSequence) return;
      this.loadingTasks = false;
      if (!["tasks", "roadmaps"].includes(this.mode)) return;
      const body = this.container.querySelector(".db-body") || host;
      const retry = planButton("Retry", () => this.renderBody(body, this.degreeMap()));
      body.replaceChildren(planElement("p", error.message, "error"), retry);
    });
    return false;
  }

  renderRoadmaps(host, visible) {
    const shell = planElement("section", undefined, "planning-shell");
    const heading = planElement("header", undefined, "planning-heading");
    heading.append(planElement("h2", "Roadmaps"));
    if (this.onNewRoadmap) heading.append(planButton("New roadmap", this.onNewRoadmap, "primary"));
    shell.append(heading);
    const visibleIds = new Set(visible.map(note => note.id));
    const plans = buildRoadmaps(this.data.all, this.cachedTasks).filter(plan => visibleIds.has(plan.note.id));
    if (!plans.length) {
      shell.append(planElement("p", "Create a roadmap or set an existing note’s type to Project or Goal.", "plan-meta"));
      host.replaceChildren(shell);
      return;
    }
    const active = plans.find(plan => plan.note.id === this.roadmapId) || plans[0];
    this.roadmapId = active.note.id;
    const selector = planElement("select");
    selector.setAttribute("aria-label", "Select a roadmap");
    selector.append(...plans.map(plan => new Option(plan.note.title, plan.note.id)));
    selector.value = active.note.id;
    selector.addEventListener("change", () => {
      this.roadmapId = selector.value;
      this.renderRoadmaps(host, visible);
      host.querySelector("select")?.focus();
    });
    const summary = planElement("div", undefined, "roadmap-summary");
    summary.append(selector, progressBar(active.done, active.total, active.percent),
      planButton("Open note", () => this.onOpenNote(active.note.id), "ghost-btn"));
    shell.append(summary);
    const phases = planElement("div", undefined, "roadmap-phases");
    for (const phase of active.phases) {
      const card = planElement("section", undefined, "roadmap-phase");
      const title = planElement("header", undefined, "planning-heading");
      title.append(planElement("h3", phase.name), progressBar(phase.done, phase.total, phase.percent));
      card.append(title);
      for (const task of phase.tasks) {
        const label = planElement("label", undefined, "roadmap-task");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = task.done;
        input.addEventListener("change", async () => {
          const done = input.checked;
          input.checked = task.done;
          input.disabled = true;
          const sequence = this.taskSequence;
          try {
            if (task.linkedNote) {
              await this.onUpdateFields(task.noteId, {status: done ? "done" : "todo"});
              return;
            }
            const tasks = await this.onToggleTask({...task, done});
            if (sequence !== this.taskSequence) return;
            this.cachedTasks = tasks;
            if (this.mode === "roadmaps" && host.isConnected) this.renderRoadmaps(host, visible);
          } catch (error) {
            label.append(planElement("span", error.message, "error"));
          } finally { input.disabled = false; }
        });
        label.append(input, planElement("span", task.text));
        card.append(label);
      }
      phases.append(card);
    }
    if (!active.phases.length) phases.append(planElement("p", "Add checkboxes under a heading or link task notes with a relationship.", "plan-meta"));
    shell.append(phases);
    host.replaceChildren(shell);
  }

  renderTasks(host) {
    const q = this.filterText.trim().toLowerCase();
    const all = this.cachedTasks.filter(t => !q || `${t.text} ${t.noteTitle}`.toLowerCase().includes(q));
    const doneCount = all.filter(t => t.done).length;
    const pct = all.length ? Math.round((doneCount / all.length) * 100) : 0;
    const shown = all.filter(t => this.taskFilter === "all" || (this.taskFilter === "open" ? !t.done : t.done));

    const box = document.createElement("div");
    box.className = "task-hub";

    const head = document.createElement("div");
    head.className = "task-hub-head";
    const tabs = document.createElement("div");
    tabs.className = "db-modes";
    for (const [id, label] of [["open", `Open (${all.length - doneCount})`], ["done", `Done (${doneCount})`], ["all", `All (${all.length})`]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "compact";
      b.textContent = label;
      b.setAttribute("aria-pressed", String(this.taskFilter === id));
      b.addEventListener("click", () => { this.taskFilter = id; this.clearActiveView(); this.renderTasks(host); });
      tabs.append(b);
    }
    const prog = document.createElement("div");
    prog.className = "task-prog";
    prog.innerHTML = `<div class="study-bar"><div class="study-fill"></div></div><span>${pct}%</span>`;
    const progFill = prog.querySelector(".study-fill");
    if (progFill) progFill.style.width = `${pct}%`;
    head.append(tabs, prog);

    const list = document.createElement("ul");
    list.className = "task-hub-list";
    if (!shown.length) {
      list.innerHTML = `<li class="db-empty">No tasks found. Add <code>- [ ] Task</code> to any note.</li>`;
    } else {
      for (const task of shown) {
        const li = document.createElement("li");
        li.className = "task-row" + (task.done ? " is-done" : "");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = task.done;
        cb.setAttribute("aria-label", task.text);
        cb.addEventListener("change", async () => {
          const done = cb.checked;
          cb.checked = task.done;
          cb.disabled = true;
          try {
            if (this.onToggleTask) this.cachedTasks = await this.onToggleTask({...task, done});
            if (host.isConnected) this.renderTasks(host);
          } catch (error) {
            const message = document.createElement("span");
            message.setAttribute("role", "alert");
            message.textContent = error.message;
            li.append(message);
          } finally { cb.disabled = false; }
        });
        const span = document.createElement("span");
        span.className = "task-text";
        span.textContent = task.text;
        const src = document.createElement("button");
        src.type = "button";
        src.className = "task-src";
        src.textContent = task.noteTitle;
        src.addEventListener("click", () => this.onOpenNote(task.noteId));
        this.dragNote?.(src, task.noteId);
        li.append(cb, span, src);
        list.append(li);
      }
    }

    box.append(head, list);
    host.replaceChildren(box);
  }

  buildGalleryGrid(notes) {
    const grid = document.createElement("div");
    grid.className = "db-gallery";
    for (const n of notes) {
      const meta = noteFields(n);
      const stObj = STATUS_LIST.find(s => s.id === meta.status) || STATUS_LIST[0];
      const card = document.createElement("article");
      card.className = "db-card";
      this.dragNote?.(card, n.id);
      card.addEventListener("click", () => this.onOpenNote(n.id));

      const head = document.createElement("div");
      head.className = "db-card-head";
      const title = document.createElement("h3");
      title.textContent = (meta.icon ? meta.icon + " " : "") + (n.pinned ? "★ " : "") + n.title;
      const badge = document.createElement("span");
      badge.className = `status-badge ${stObj.cls}`;
      badge.textContent = stObj.label;
      head.append(title, badge);

      const excerpt = document.createElement("p");
      excerpt.className = "db-card-preview";
      excerpt.textContent = n.preview || "Empty note…";

      const footer = document.createElement("div");
      footer.className = "db-pills";
      for (const tag of (n.tags || []).slice(0, 3)) {
        const chip = document.createElement("span");
        chip.className = "db-pill";
        chip.textContent = "#" + tag;
        footer.append(chip);
      }
      card.append(head, excerpt, footer);
      grid.append(card);
    }
    return grid;
  }

  renderGallery(host, notes, deg) {
    if (!this.groupBy) {
      host.replaceChildren(this.buildGalleryGrid(notes));
      return;
    }
    const nodes = [];
    for (const group of this.groupNotes(notes)) {
      const details = document.createElement("details");
      details.className = "db-group";
      details.open = true;
      const summary = document.createElement("summary");
      summary.className = "db-group-head";
      summary.append(planElement("span", group.label), planElement("span", String(group.notes.length), "db-group-count"));
      details.append(summary, this.buildGalleryGrid(group.notes));
      nodes.push(details);
    }
    host.replaceChildren(...nodes);
  }
}
