// Home: the first screen. Pure DOM rendering from data the app already holds; actions proxy existing buttons.
const DAY = 86400000;
export const VERSION = "v38";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function greetingKey(hour) {
  return hour < 5 ? "greet-evening" : hour < 12 ? "greet-morning" : hour < 18 ? "greet-day" : "greet-evening";
}

function dueInfo(note, now) {
  const fields = note.entity?.fields ?? {};
  if (!fields.due || fields.status === "done") return null;
  const when = new Date(`${fields.due}T23:59:59`).getTime();
  if (Number.isNaN(when) || when - now > 7 * DAY) return null;
  return {note, when, overdue: when < now, due: fields.due};
}

export function homeModel(nodes, edges, now = Date.now()) {
  const sorted = [...nodes].sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const due = sorted.map(note => dueInfo(note, now)).filter(Boolean).sort((a, b) => a.when - b.when).slice(0, 5);
  return {
    pinned: sorted.filter(note => note.pinned).slice(0, 6),
    recent: sorted.slice(0, 6),
    due,
    steps: {note: nodes.length >= 1, link: edges.length >= 1},
  };
}

export function renderHome(panel, {nodes, edges, t, openNote, click, backupDone, dismissed, onDismiss, telemetry, onConsent, onFeedback, onTour, updateInfo, lastBackup, now = new Date()}) {
  const model = homeModel(nodes, edges, now.getTime());
  const page = el("div", "home-page");
  const head = el("header", "home-head");
  head.append(el("h2", "home-greeting", t(greetingKey(now.getHours()))),
    el("p", "home-date", now.toLocaleDateString(document.documentElement.lang || undefined,
      {weekday: "long", day: "numeric", month: "long"})));
  page.append(head);

  if (updateInfo?.available && updateInfo.latest) {
    const banner = el("section", "home-card home-update");
    const row = el("div", "home-card-head");
    const msg = el("span", "", `${t("update-available") || "Update available"}: ${updateInfo.latest}`);
    const link = el("a", "home-link", t("update-download") || "View release ↗");
    link.href = updateInfo.url || "#";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    row.append(msg, link);
    banner.append(row);
    page.append(banner);
  }

  const actions = el("div", "home-actions");
  const action = (label, target, primary = false) => {
    const button = el("button", primary ? "home-action primary" : "home-action", label);
    button.type = "button";
    button.addEventListener("click", () => click(target));
    return button;
  };
  actions.append(action(t("home-new"), "create-note", true), action(t("home-today"), "daily-note"),
    action(t("home-template"), "open-templates"), action(t("home-import"), "menu-folder"));
  if (lastBackup && now.getTime() - Date.parse(lastBackup) >= 14 * DAY) {
    const card = el("section", "home-card home-update");
    const row = el("div", "home-card-head");
    const days = Math.floor((now.getTime() - Date.parse(lastBackup)) / DAY);
    row.append(el("span", "", t("backup-reminder").replace("{days}", days)), action(t("home-step-backup"), "backup"));
    card.append(row);
    page.append(card);
  }
  if (onTour) {
    const tourBtn = el("button", "home-action", t("tour-start") || "Guided tour");
    tourBtn.type = "button";
    tourBtn.addEventListener("click", onTour);
    actions.append(tourBtn);
  }
  page.append(actions);

  const done = [model.steps.note, model.steps.link, backupDone];
  if (!dismissed && !done.every(Boolean)) {
    const card = el("section", "home-card home-start");
    const title = el("div", "home-card-head");
    const hide = el("button", "home-link", t("home-dismiss"));
    hide.type = "button";
    hide.addEventListener("click", onDismiss);
    title.append(el("h3", "", `${t("home-start")} · ${done.filter(Boolean).length}/3`), hide);
    const list = el("ol", "home-steps");
    const step = (text, isDone, run) => {
      const item = el("li", isDone ? "is-done" : "");
      const mark = el("span", "home-check", isDone ? "✓" : "");
      mark.setAttribute("aria-hidden", "true");
      const label = run && !isDone ? el("button", "home-link", text) : el("span", "", text);
      if (label.tagName === "BUTTON") { label.type = "button"; label.addEventListener("click", run); }
      item.append(mark, label);
      return item;
    };
    list.append(step(t("home-step-note"), model.steps.note, () => click("create-note")),
      step(t("home-step-link"), model.steps.link, null),
      step(t("home-step-backup"), backupDone, () => click("backup")));
    card.append(title, list);
    if (!nodes.length) {
      const row = el("div", "home-actions");
      const samples = el("button", "home-action", t("home-samples"));
      samples.type = "button";
      samples.addEventListener("click", () => click("examples"));
      row.append(samples);
      card.append(el("p", "home-note", t("home-welcome")), row);
    }
    page.append(card);
  }

  const noteList = (items, extra) => {
    const list = el("ul", "home-list");
    for (const item of items) {
      const note = extra ? item.note : item;
      const row = el("li");
      const open = el("button", "home-note-row");
      open.type = "button";
      open.append(el("span", "home-note-title", note.title));
      if (extra) open.append(el("span", item.overdue ? "home-badge is-overdue" : "home-badge",
        item.overdue ? `${item.due} · ${t("home-overdue")}` : item.due));
      open.addEventListener("click", () => openNote(note.id));
      row.append(open);
      list.append(row);
    }
    return list;
  };
  const section = (title, body) => {
    const block = el("section", "home-card");
    block.append(el("h3", "", title), body);
    page.append(block);
  };
  if (model.due.length) section(t("home-due"), noteList(model.due, true));
  if (model.pinned.length) section(t("favorites"), noteList(model.pinned));
  if (model.recent.length) section(t("home-recent"), noteList(model.recent));
  else if (dismissed || done.every(Boolean)) section(t("home-start"), el("p", "home-note", t("home-empty")));

  const foot = el("p", "home-foot");
  const graphLink = el("button", "home-link", t("home-open-graph"));
  graphLink.type = "button";
  graphLink.addEventListener("click", () => click("nav-map"));
  foot.append(graphLink);
  if (telemetry?.available) {
    const feedback = el("button", "home-link", t("fb-open"));
    feedback.type = "button";
    feedback.addEventListener("click", onFeedback);
    foot.append(feedback);
  }
  if (telemetry?.available && telemetry.consent !== null) {
    const toggle = el("button", "home-link", t(telemetry.consent ? "stats-on" : "stats-off"));
    toggle.type = "button";
    toggle.addEventListener("click", () => onConsent(!telemetry.consent));
    foot.append(toggle);
  }
  foot.append(el("span", "home-version", `Memory map ${VERSION}`));
  page.append(foot);
  panel.replaceChildren(page);
}
