import {t} from "./i18n.js";
import {renderMarkdown} from "./markdown.js";

const SETTINGS = ["enabled", "provider", "model", "baseUrl", "requestCap", "monthlyCap", "linkedDefault", "shareCounts"];
const PROVIDERS = [
  ["none", "ai-none"], ["cloud_api", "ai-cloud"], ["local_model", "ai-local"], ["openai", "OpenAI"],
  ["anthropic", "Claude"], ["gemini", "Gemini"], ["xai", "Grok"], ["groq", "Groq"], ["qwen", "Qwen"],
  ["deepseek", "DeepSeek"], ["mistral", "Mistral"],
];

function node(tag, content, className) {
  const element = document.createElement(tag);
  if (content != null) element.textContent = content;
  if (className) element.className = className;
  return element;
}

function button(key, click, className) {
  const element = node("button", t(key), className);
  element.type = "button";
  element.addEventListener("click", click);
  return element;
}

export async function readAIStream(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const line = value => { if (value.trim()) onEvent(JSON.parse(value)); };
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      pending += decoder.decode(value, {stream: true});
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
      if (pending.length > 1_500_000) throw new Error(t("ai-provider_error"));
    }
    line(pending + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

export function setupAIPanel(dialog, {request, currentNote, flush, changed}) {
  const find = selector => dialog.querySelector(selector);
  const settings = find("[data-ai-settings]");
  const chat = find("[data-ai-chat]");
  const message = find("[data-ai-status]");
  const form = find("[data-ai-request]");
  const payload = find("[data-ai-preview]");
  const send = find("[data-ai-send]");
  const stop = find("[data-ai-stop]");
  const output = find("[data-ai-output]");
  const proposals = find("[data-ai-proposals]");
  const review = find("[data-ai-review]");
  const audit = find("[data-ai-audit]");
  const panel = {config: null, preview: null, running: null, generation: 0, selection: "", noteId: "", response: ""};
  const getField = name => settings.elements.namedItem(name);
  const report = error => { message.textContent = error?.message || t("ai-provider_error"); };

  function show(section) {
    chat.hidden = section !== "chat";
    settings.hidden = section !== "settings";
    review.hidden = section !== "review";
    audit.hidden = section !== "audit";
    message.textContent = "";
  }

  function invalidate() {
    panel.preview = null;
    payload.hidden = true;
    send.disabled = true;
  }

  async function getConfig() {
    const latest = await request("/ai/settings");
    panel.config = latest;
    form.querySelector("fieldset").disabled = !latest.connected || Boolean(panel.running);
    find("[data-ai-off]").hidden = latest.connected;
    const selected = getField("provider");
    const options = latest.developerMode ? [["mock", "ai-mock"], ...PROVIDERS] : PROVIDERS;
    selected.replaceChildren(...options.map(([id, name]) => new Option(t(name), id)));
    for (const key of SETTINGS) {
      const field = getField(key);
      if (field.type === "checkbox") field.checked = latest.settings[key];
      else field.value = latest.settings[key];
    }
    getField("apiKey").value = "";
    const keyState = find("[data-ai-key-status]");
    keyState.textContent = latest.credentialError ? t("ai-provider_error")
      : latest.credentialProviders?.includes(latest.settings.provider) ? t("ai-key-stored") : "";
    find("[data-ai-developer]").hidden = !latest.developerMode;
    const usage = find("[data-ai-usage]");
    usage.textContent = t("ai-usage").replace("{used}", latest.usage.tokens).replace("{cap}", latest.settings.monthlyCap);
    return latest;
  }

  async function open({action = "chat", selection = "", section = "chat", anchor = null} = {}) {
    if (!dialog.open) {
      dialog.classList.toggle("ai-flyout", Boolean(anchor));
      if (anchor) {
        dialog.style.left = Math.max(8, Math.min(innerWidth - 440, anchor.left)) + "px";
        dialog.style.top = Math.max(8, Math.min(innerHeight - 440, anchor.bottom + 8)) + "px";
      }
      dialog.showModal();
    }
    const note = currentNote();
    if (panel.noteId !== (note?.id || "")) {
      panel.response = "";
      output.replaceChildren();
    }
    panel.noteId = note?.id || "";
    panel.selection = selection;
    form.elements.action.value = action;
    form.elements.prompt.value = selection && action !== "chat" ? t("ai-act-" + action) : "";
    invalidate();
    show(section);
    form.querySelector("fieldset").disabled = true;
    try {
      const latest = await getConfig();
      if (!dialog.open) return;
      form.elements.includeLinked.checked = latest.settings.linkedDefault;
      const privacy = find("[data-ai-privacy]");
      const checkbox = find("[data-ai-never]");
      privacy.hidden = !note || note.locked || note.trashed;
      if (!privacy.hidden) {
        const state = await request("/ai/visibility?" + new URLSearchParams({noteId: note.id}));
        if (dialog.open && panel.noteId === note.id) checkbox.checked = state.value === "never";
      }
      if (section === "chat" && latest.connected) form.elements.prompt.focus();
      if (section === "review") await renderReview(proposals);
      if (section === "audit") await renderAudit();
    } catch (error) { if (dialog.open) report(error); }
  }

  const labelError = code => t("ai-" + code);
  async function prepare(event) {
    event.preventDefault();
    const serial = ++panel.generation;
    invalidate();
    message.textContent = "";
    if (!await flush()) return;
    const draft = {
      action: form.elements.action.value, prompt: form.elements.prompt.value, noteId: panel.noteId,
      selection: panel.selection, includeLinked: form.elements.includeLinked.checked,
      search: form.elements.search.value, language: document.documentElement.lang,
    };
    try {
      const response = await request("/ai/preview", {body: draft});
      if (serial !== panel.generation || !dialog.open) return;
      if (!response.previewId) {
        message.textContent = labelError(response.errorCode);
        return;
      }
      panel.preview = response.previewId;
      payload.hidden = false;
      payload.querySelector("pre").textContent = response.payload;
      payload.querySelector("small").textContent = t("ai-size")
        .replace("{chars}", response.chars).replace("{tokens}", response.estimatedTokens);
      payload.querySelector("[data-ai-cuts]").textContent = response.cuts.map(cut => t("ai-cut-" + cut)).join(" ");
      send.disabled = false;
      send.focus();
    } catch (error) { if (serial === panel.generation && dialog.open) report(error); }
  }

  function renderAnswer() {
    output.replaceChildren(renderMarkdown(panel.response, {untrusted: true}));
  }

  async function sendPreview() {
    if (!panel.preview || panel.running) return;
    const run = {controller: new AbortController(), identity: ""};
    const previewId = panel.preview;
    panel.running = run;
    form.querySelector("fieldset").disabled = true;
    stop.disabled = false;
    invalidate();
    panel.response = "";
    output.replaceChildren();
    const inline = find("[data-ai-inline]");
    inline.replaceChildren();
    message.textContent = t("ai-running");
    try {
      const response = await request("/ai/send", {blob: true, body: {previewId}, signal: run.controller.signal});
      await readAIStream(response.body, event => {
        if (panel.running !== run || !dialog.open) return;
        if (event.type === "started") run.identity = event.requestId;
        if (event.type === "text_delta") {
          panel.response += event.text;
          output.textContent = panel.response;
        }
        if (event.type === "proposal") inline.append(proposalCard(event.proposal));
        if (event.type === "error") message.textContent = labelError(event.code);
        if (event.type === "done") message.textContent = "";
      });
      if (panel.running === run && dialog.open) renderAnswer();
    } catch (error) {
      if (panel.running === run && dialog.open && error.name !== "AbortError") report(error);
    } finally {
      if (panel.running === run) {
        panel.running = null;
        stop.disabled = true;
        form.querySelector("fieldset").disabled = !panel.config?.connected;
      }
    }
  }

  function cancel() {
    const run = panel.running;
    if (!run) return;
    panel.running = null;
    if (run.identity) void request("/ai/cancel", {body: {requestId: run.identity}}).catch(() => {});
    run.controller.abort();
    stop.disabled = true;
    form.querySelector("fieldset").disabled = !panel.config?.connected;
    message.textContent = t("ai-cancelled");
    if (panel.response) renderAnswer();
  }

  async function decide(action, ids, source) {
    if (!await flush()) return;
    try {
      const result = await request("/ai/proposals", {body: {action, ids}});
      await changed(result.changed);
      if (!dialog.open) return;
      if (source?.isConnected) source.replaceChildren(node("p", t("ai-result-" + action)));
      if (!review.hidden) await renderReview(proposals);
      message.textContent = t("ai-result-" + action);
    } catch (error) { report(error); }
  }

  function proposalCard(item) {
    const card = node("article", null, "ai-proposal");
    card.append(node("h3", item.after.title), node("p", t("ai-proposal-" + item.status)));
    const diff = node("details");
    diff.open = item.status === "pending";
    const before = node("pre", item.before ? [item.before.body, ...item.before.tags].join("\n") : t("ai-new-note"), "ai-diff-old");
    const after = node("pre", [item.after.body, ...item.after.tags].join("\n"), "ai-diff-new");
    diff.append(node("summary", t("ai-diff")), node("strong", t("ai-before")), before, node("strong", t("ai-after")), after);
    card.append(diff);
    const actions = node("div", null, "dialog-actions");
    if (item.status === "pending") {
      actions.append(button("ai-reject", () => void decide("reject", [item.id], card)),
        button("ai-approve", () => void decide("approve", [item.id], card), "primary"));
    } else if (item.status === "approved" && !item.undoneAt) {
      actions.append(button("ai-undo", () => void decide("undo", [item.id], card)));
    } else if (item.undoneAt) actions.append(node("p", t("ai-result-undo")));
    card.append(actions);
    return card;
  }

  async function renderReview(container) {
    const result = await request("/ai/proposals");
    if (!dialog.open) return;
    container.replaceChildren();
    if (!result.proposals.length) container.append(node("p", t("ai-no-proposals")));
    const eligible = result.proposals.filter(item => item.status === "pending" && item.tool === "create_note").slice(0, 12);
    if (eligible.length > 1) {
      const batch = node("fieldset");
      batch.append(node("legend", t("ai-batch")));
      const choices = new Map();
      const approve = button("ai-approve-batch", () => {
        const list = [...choices].filter(([, input]) => input.checked).map(([id]) => id);
        if (list.length) void decide("approve", list);
      });
      approve.disabled = true;
      for (const item of eligible) {
        const input = node("input");
        input.type = "checkbox";
        input.addEventListener("change", () => { approve.disabled = ![...choices.values()].some(choice => choice.checked); });
        choices.set(item.id, input);
        const label = node("label");
        label.append(input, document.createTextNode(" " + item.after.title));
        batch.append(label);
      }
      batch.append(approve);
      container.append(batch);
    }
    container.append(...result.proposals.map(proposalCard));
  }

  async function renderAudit() {
    const {events} = await request("/ai/audit");
    if (!dialog.open) return;
    const list = find("[data-ai-audit-events]");
    list.replaceChildren(...[...events].reverse().map(row => node("li",
      [row.time, row.provider, row.event, row.tool, row.inputTokens + " / " + row.outputTokens].filter(Boolean).join(" · "))));
    if (!events.length) list.append(node("li", t("ai-no-audit")));
  }

  async function saveSettings(event) {
    event.preventDefault();
    try {
      const data = Object.fromEntries(SETTINGS.map(key => {
        const field = getField(key);
        return [key, field.type === "checkbox" ? field.checked : field.type === "number" ? field.valueAsNumber : field.value];
      }));
      const key = getField("apiKey").value;
      if (key) {
        await request("/ai/credentials", {body: {provider: data.provider, apiKey: key}});
        getField("apiKey").value = "";
      }
      await request("/ai/settings", {body: data});
      await getConfig();
      message.textContent = t("ai-settings-saved");
    } catch (error) { report(error); }
  }

  getField("provider").addEventListener("change", () => {
    getField("apiKey").value = "";
    find("[data-ai-key-status]").textContent = panel.config?.credentialProviders?.includes(getField("provider").value)
      ? t("ai-key-stored") : "";
  });
  for (const control of dialog.querySelectorAll(".ai-upcoming button")) control.title = t("ai-coming");
  settings.addEventListener("submit", saveSettings);
  form.addEventListener("input", () => { panel.generation++; invalidate(); });
  form.addEventListener("submit", event => { void prepare(event); });
  send.addEventListener("click", () => { void sendPreview(); });
  stop.addEventListener("click", cancel);
  find("[data-ai-close]").addEventListener("click", () => dialog.close());
  find("[data-ai-copy]").addEventListener("click", () => void navigator.clipboard.writeText(panel.response).catch(report));
  find("[data-ai-visibility-label]").addEventListener("change", async event => {
    const box = event.target;
    const previous = !box.checked;
    try {
      await request("/ai/visibility", {body: {noteId: panel.noteId, value: box.checked ? "never" : "allowed"}});
      panel.generation++;
      invalidate();
      find("[data-ai-inline]").replaceChildren();
    } catch (error) { box.checked = previous; report(error); }
  });
  for (const control of dialog.querySelectorAll("[data-ai-nav]")) {
    control.addEventListener("click", async () => {
      const section = control.dataset.aiNav;
      show(section);
      try {
        if (section === "review") await renderReview(proposals);
        if (section === "audit") await renderAudit();
      } catch (error) { report(error); }
    });
  }
  find("[data-ai-test]").addEventListener("click", async () => {
    try {
      const result = await request("/ai/test", {body: {provider: getField("provider").value}});
      message.textContent = result.ok ? t("ai-mock-ok") : t("ai-not_connected");
    } catch (error) { report(error); }
  });
  find("[data-ai-remove-key]").addEventListener("click", async () => {
    try {
      await request("/ai/credentials", {body: {provider: getField("provider").value, remove: true}});
      await getConfig();
    } catch (error) { report(error); }
  });
  find("[data-ai-clear-audit]").addEventListener("click", async () => {
    try {
      await request("/ai/audit", {body: {action: "clear"}});
      await renderAudit();
    } catch (error) { report(error); }
  });
  dialog.addEventListener("close", () => {
    cancel();
    panel.generation++;
    invalidate();
    payload.querySelector("pre").textContent = "";
    proposals.replaceChildren();
    audit.querySelector("ul").replaceChildren();
    find("[data-ai-inline]").replaceChildren();
    getField("apiKey").value = "";
    form.reset();
    panel.response = "";
    panel.selection = "";
    output.replaceChildren();
  });
  return {open};
}
