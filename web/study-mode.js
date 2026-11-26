/**
 * Xotira v25 — Full Flashcards Manager + FSRS Spaced Repetition Study Deck
 * Supports:
 *  - Creating custom flashcards (+ New card)
 *  - Editing any flashcard (custom or note-extracted)
 *  - Deleting / hiding any flashcard (permanently removes custom cards or hides scraped note cards)
 *  - Auto-extracting Q&A (`Question :: Answer`), bold definitions, `==cloze==`, and `<details>` toggles
 *  - FSRS stability/interval scheduling persisted in localStorage
 */

import {t} from "./i18n.js";

const FSRS_STORAGE_KEY = "xotira-fsrs-v1";
const DECK_STORAGE_KEY = "xotira-flashcards-v2";

function stripMd(s) {
  return String(s || "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/==([^=]+)==/g, "$1")
    .trim();
}

function cardHash(front, back) {
  const input = `${front.toLowerCase()}::${back.toLowerCase()}`;
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return "c_" + (h >>> 0).toString(16);
}

function loadFsrsStore() {
  try { return JSON.parse(localStorage.getItem(FSRS_STORAGE_KEY) || "{}"); }
  catch { return {}; }
}

function saveFsrsStore(store) {
  try { localStorage.setItem(FSRS_STORAGE_KEY, JSON.stringify(store)); } catch {}
}

function loadDeckStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(DECK_STORAGE_KEY) || "{}");
    return {
      custom: Array.isArray(raw.custom) ? raw.custom : [],
      overrides: raw.overrides && typeof raw.overrides === "object" ? raw.overrides : {},
      deleted: Array.isArray(raw.deleted) ? raw.deleted : [],
    };
  } catch {
    return {custom: [], overrides: {}, deleted: []};
  }
}

function saveDeckStore(deck) {
  try { localStorage.setItem(DECK_STORAGE_KEY, JSON.stringify(deck)); } catch {}
}

/** FSRS-inspired stability & interval scheduler (grade: 1=Again, 2=Hard, 3=Good, 4=Easy). */
export function scheduleFsrsCard(prev, grade, nowMs = Date.now()) {
  const state = prev || {stability: 0.4, difficulty: 5.0, reps: 0, lapses: 0, due: 0};
  const dDelta = {1: 0.9, 2: 0.35, 3: -0.1, 4: -0.55}[grade] ?? 0;
  const difficulty = Math.max(1.0, Math.min(10.0, state.difficulty + dDelta));
  let stability = state.stability;
  let reps = state.reps;
  let lapses = state.lapses;

  if (grade === 1) {
    stability = 0.25;
    reps = 0;
    lapses += 1;
  } else if (reps === 0) {
    stability = grade === 2 ? 0.8 : grade === 3 ? 1.5 : 4.0;
    reps = 1;
  } else {
    const factor = grade === 2 ? 1.2 : grade === 3 ? (2.5 - (difficulty - 1) * 0.12) : (3.2 - (difficulty - 1) * 0.14);
    stability = Math.min(365, Math.max(1, stability * Math.max(1.15, factor)));
    reps += 1;
  }

  const intervalDays = grade === 1 ? 0 : Math.max(1, Math.round(stability));
  const due = grade === 1 ? nowMs + 60_000 : nowMs + intervalDays * 86_400_000;
  return {stability: Number(stability.toFixed(2)), difficulty: Number(difficulty.toFixed(2)), reps, lapses, intervalDays, due};
}

function formatInterval(days) {
  if (days <= 0) return "1m";
  if (days === 1) return "1d";
  if (days < 30) return `${days}d`;
  return `${Math.round(days / 30)}mo`;
}

export function extractCardsFromMarkdown(body, sourceTitle = "") {
  const cards = [];
  const text = String(body || "").replace(/\r\n/g, "\n");
  const seen = new Set();
  const push = (front, back, kind) => {
    const f = front.trim();
    const b = back.trim();
    if (!f || !b || f.length < 3) return;
    const key = f.toLowerCase() + "::" + b.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    cards.push({id: cardHash(f, b), front: f, back: b, kind, source: sourceTitle, isCustom: false});
  };

  for (const m of text.matchAll(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi)) {
    push(stripMd(m[1]), stripMd(m[2]), "Toggle");
  }

  const lines = text.split("\n");
  let inCode = false;
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const line = raw.trim();
    if (!line) continue;

    const qa = line.match(/^(?:[-*]\s+)?(.{4,180}?)\s*::\s*(.{2,400})$/);
    if (qa) {
      push(stripMd(qa[1]), stripMd(qa[2]), "Q&A");
      continue;
    }

    const defM = line.match(/^[-*]\s+\*\*([^*\n]{2,80})\*\*\s*(?::|—|–|-)\s+(.{8,360})$/);
    if (defM) {
      push(stripMd(defM[1]), stripMd(defM[2]), "Definition");
      continue;
    }

    const clozes = [...line.matchAll(/==([^=\n]{2,90})==/g)];
    if (clozes.length) {
      for (const cm of clozes) {
        const answer = cm[1].trim();
        const prompt = stripMd(line.replace(cm[0], "[ ______ ]"));
        push(prompt, answer, "Cloze");
      }
    }
  }
  return cards;
}

export class StudyMode {
  constructor(dialog) {
    this.dialog = dialog;
    this.noteCards = [];
    this.cards = [];
    this.index = 0;
    this.revealed = false;
    this.reviewed = 0;
    this.againQueue = [];
    this.tab = "study"; // "study" | "manage"
    this.editingId = null;
    this.store = loadFsrsStore();
    this.deck = loadDeckStore();
    this.includeCustom = true;

    this.dialog.addEventListener("keydown", e => {
      if (!this.dialog.open || this.tab !== "study") return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        this.flip();
      } else if (this.revealed && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        this.rate(Number(e.key));
      }
    });
  }

  rebuildDeck(resetIndex = false) {
    this.store = loadFsrsStore();
    this.deck = loadDeckStore();
    const deletedSet = new Set(this.deck.deleted);
    const merged = [];
    const seenIds = new Set();

    if (this.includeCustom) {
      for (const c of this.deck.custom) {
        if (deletedSet.has(c.id)) continue;
        seenIds.add(c.id);
        merged.push({...c, isCustom: true});
      }
    }

    for (const c of this.noteCards) {
      if (deletedSet.has(c.id) || seenIds.has(c.id)) continue;
      seenIds.add(c.id);
      const ov = this.deck.overrides[c.id];
      merged.push(ov ? {...c, front: ov.front, back: ov.back} : c);
    }

    const now = Date.now();
    this.cards = merged.sort((a, b) => (this.store[a.id]?.due || 0) - (this.store[b.id]?.due || 0));
    this.dueCount = this.cards.filter(c => (this.store[c.id]?.due || 0) <= now).length;
    if (resetIndex || this.index >= this.cards.length) {
      this.index = 0;
      this.revealed = false;
    }
  }

  open(noteCards = [], title = "", {includeCustom = true} = {}) {
    this.title = title;
    this.noteCards = noteCards || [];
    this.includeCustom = includeCustom;
    this.reviewed = 0;
    this.againQueue = [];
    this.editingId = null;
    this.rebuildDeck(true);
    this.tab = this.cards.length ? "study" : "manage";
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  addCustomCard(front, back) {
    const f = front.trim();
    const b = back.trim();
    if (!f || !b) return;
    const id = "custom_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
    this.deck.custom.unshift({id, front: f, back: b, kind: t("fc-custom"), source: "", isCustom: true});
    saveDeckStore(this.deck);
    this.rebuildDeck(false);
    this.render();
  }

  updateCard(id, front, back) {
    const f = front.trim();
    const b = back.trim();
    if (!f || !b) return;
    const customIdx = this.deck.custom.findIndex(c => c.id === id);
    if (customIdx >= 0) {
      this.deck.custom[customIdx] = {...this.deck.custom[customIdx], front: f, back: b};
    } else {
      this.deck.overrides[id] = {front: f, back: b};
    }
    saveDeckStore(this.deck);
    this.editingId = null;
    this.rebuildDeck(false);
    this.render();
  }

  deleteCard(id) {
    const customIdx = this.deck.custom.findIndex(c => c.id === id);
    if (customIdx >= 0) {
      this.deck.custom.splice(customIdx, 1);
    } else if (!this.deck.deleted.includes(id)) {
      this.deck.deleted.push(id);
    }
    delete this.deck.overrides[id];
    saveDeckStore(this.deck);
    this.editingId = null;
    this.rebuildDeck(false);
    this.render();
  }

  flip() {
    if (!this.cards.length || this.index >= this.cards.length) return;
    this.revealed = !this.revealed;
    this.render();
  }

  rate(grade) {
    const card = this.cards[this.index];
    if (!card) return;
    const nextState = scheduleFsrsCard(this.store[card.id], grade);
    this.store[card.id] = nextState;
    saveFsrsStore(this.store);
    this.reviewed += 1;
    if (grade === 1) this.againQueue.push(card);
    this.index += 1;
    this.revealed = false;
    if (this.index >= this.cards.length && this.againQueue.length) {
      this.cards = [...this.againQueue];
      this.againQueue = [];
      this.index = 0;
    }
    this.render();
  }

  render() {
    const root = this.dialog.querySelector("#study-body");
    const headTitle = this.dialog.querySelector("#study-heading");
    if (headTitle) headTitle.textContent = this.title || t("fc-title");
    if (!root) return;

    const nav = document.createElement("div");
    nav.className = "study-tabs";
    const tabStudy = document.createElement("button");
    tabStudy.type = "button";
    tabStudy.className = "compact";
    tabStudy.textContent = `${t("fc-tab-study")} (${this.cards.length})`;
    tabStudy.setAttribute("aria-pressed", String(this.tab === "study"));
    tabStudy.addEventListener("click", () => { this.tab = "study"; this.editingId = null; this.render(); });

    const tabManage = document.createElement("button");
    tabManage.type = "button";
    tabManage.className = "compact";
    tabManage.textContent = t("fc-tab-manage");
    tabManage.setAttribute("aria-pressed", String(this.tab === "manage"));
    tabManage.addEventListener("click", () => { this.tab = "manage"; this.render(); });
    nav.append(tabStudy, tabManage);

    const content = document.createElement("div");
    if (this.tab === "manage") this.renderManage(content);
    else this.renderStudy(content);

    root.replaceChildren(nav, content);
  }

  renderManage(host) {
    const form = document.createElement("form");
    form.className = "fc-create-form";
    const qInput = document.createElement("input");
    qInput.type = "text";
    qInput.required = true;
    qInput.maxLength = 300;
    qInput.placeholder = t("fc-new-q");
    const aInput = document.createElement("textarea");
    aInput.rows = 2;
    aInput.required = true;
    aInput.maxLength = 1000;
    aInput.placeholder = t("fc-new-a");
    const addBtn = document.createElement("button");
    addBtn.type = "submit";
    addBtn.className = "primary";
    addBtn.textContent = t("fc-add");
    form.append(qInput, aInput, addBtn);
    form.addEventListener("submit", e => {
      e.preventDefault();
      this.addCustomCard(qInput.value, aInput.value);
    });

    const list = document.createElement("ul");
    list.className = "fc-manage-list";
    if (!this.cards.length) {
      const li = document.createElement("li");
      li.className = "study-empty";
      li.textContent = t("fc-empty");
      list.append(li);
    } else {
      for (const card of this.cards) {
        const li = document.createElement("li");
        li.className = "fc-manage-item";
        if (this.editingId === card.id) {
          const ef = document.createElement("form");
          ef.className = "fc-edit-form";
          const eq = document.createElement("input");
          eq.type = "text";
          eq.required = true;
          eq.value = card.front;
          const ea = document.createElement("textarea");
          ea.rows = 2;
          ea.required = true;
          ea.value = card.back;
          const row = document.createElement("div");
          row.className = "fc-item-actions";
          const save = document.createElement("button");
          save.type = "submit";
          save.className = "primary compact";
          save.textContent = t("fc-save");
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "ghost-btn compact";
          cancel.textContent = t("fc-cancel");
          cancel.addEventListener("click", () => { this.editingId = null; this.render(); });
          row.append(cancel, save);
          ef.append(eq, ea, row);
          ef.addEventListener("submit", e => {
            e.preventDefault();
            this.updateCard(card.id, eq.value, ea.value);
          });
          li.append(ef);
        } else {
          const copy = document.createElement("div");
          copy.className = "fc-item-copy";
          const badge = document.createElement("span");
          badge.className = "fc-badge";
          badge.textContent = card.isCustom ? t("fc-custom") : `${t("fc-from-note")}: ${card.source || card.kind}`;
          const q = document.createElement("strong");
          q.textContent = card.front;
          const a = document.createElement("small");
          a.textContent = card.back;
          copy.append(badge, q, a);

          const actions = document.createElement("div");
          actions.className = "fc-item-actions";
          const editBtn = document.createElement("button");
          editBtn.type = "button";
          editBtn.className = "ghost-btn compact";
          editBtn.textContent = t("fc-edit");
          editBtn.addEventListener("click", () => { this.editingId = card.id; this.render(); });
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "ghost-btn danger compact";
          delBtn.textContent = t("fc-delete");
          delBtn.addEventListener("click", () => this.deleteCard(card.id));
          actions.append(editBtn, delBtn);
          li.append(copy, actions);
        }
        list.append(li);
      }
    }

    host.append(form, list);
  }

  renderStudy(host) {
    if (!this.cards.length) {
      const empty = document.createElement("div");
      empty.className = "study-empty";
      const p = document.createElement("p");
      p.textContent = t("fc-empty");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "primary";
      btn.textContent = t("fc-add");
      btn.addEventListener("click", () => { this.tab = "manage"; this.render(); });
      empty.append(p, btn);
      host.append(empty);
      return;
    }

    if (this.index >= this.cards.length) {
      const done = document.createElement("div");
      done.className = "study-done";
      const h3 = document.createElement("h3");
      h3.textContent = t("fc-done-title");
      const p = document.createElement("p");
      p.textContent = `${this.reviewed} ${t("fc-done-sub")}`;
      const row = document.createElement("div");
      row.className = "study-actions";
      const restart = document.createElement("button");
      restart.type = "button";
      restart.className = "ghost-btn";
      restart.textContent = t("fc-restart");
      restart.addEventListener("click", () => { this.index = 0; this.revealed = false; this.render(); });
      const close = document.createElement("button");
      close.type = "button";
      close.className = "primary";
      close.textContent = t("fc-close");
      close.addEventListener("click", () => this.dialog.close());
      row.append(restart, close);
      done.append(h3, p, row);
      host.append(done);
      return;
    }

    const card = this.cards[this.index];
    const prev = this.store[card.id];
    const pct = Math.round((this.index / this.cards.length) * 100);
    const previews = [1, 2, 3, 4].map(g => formatInterval(scheduleFsrsCard(prev, g).intervalDays));

    host.innerHTML = `
      <div class="study-progress">
        <div class="study-bar"><div class="study-fill"></div></div>
        <span>${this.index + 1} / ${this.cards.length}</span>
      </div>
      <div class="study-card${this.revealed ? " is-revealed" : ""}" data-sact="flip" tabindex="0">
        <div class="study-meta">
          <span class="fc-card-origin"></span>
          <span class="fc-card-tools">
            <button type="button" class="ghost-btn compact" data-sact="edit">${t("fc-edit")}</button>
            <button type="button" class="ghost-btn danger compact" data-sact="delete">${t("fc-delete")}</button>
          </span>
        </div>
        <div class="study-front"></div>
        ${this.revealed ? `<div class="study-divider"></div><div class="study-back"></div>` : `<div class="study-hint"></div>`}
      </div>
      <div class="study-actions">
        ${this.revealed
          ? `<button type="button" class="ghost-btn danger" data-grade="1">${t("fc-again")} (${previews[0]}) [1]</button>
             <button type="button" class="ghost-btn" data-grade="2">${t("fc-hard")} (${previews[1]}) [2]</button>
             <button type="button" class="primary" data-grade="3">${t("fc-good")} (${previews[2]}) [3]</button>
             <button type="button" class="ghost-btn" data-grade="4">${t("fc-easy")} (${previews[3]}) [4]</button>`
          : `<button type="button" class="primary" data-sact="flip">${t("fc-show")}</button>`}
      </div>`;

    const fill = host.querySelector(".study-fill");
    if (fill) fill.style.width = `${pct}%`;
    const origin = host.querySelector(".fc-card-origin");
    if (origin) origin.textContent = card.isCustom ? t("fc-custom") : `${t("fc-from-note")}: ${card.source || card.kind}`;
    host.querySelector(".study-front").textContent = card.front;
    const backEl = host.querySelector(".study-back");
    if (backEl) backEl.textContent = card.back;
    const hintEl = host.querySelector(".study-hint");
    if (hintEl) hintEl.textContent = t("fc-click-hint");

    host.querySelector('[data-sact="edit"]')?.addEventListener("click", e => {
      e.stopPropagation();
      this.editingId = card.id;
      this.tab = "manage";
      this.render();
    });
    host.querySelector('[data-sact="delete"]')?.addEventListener("click", e => {
      e.stopPropagation();
      this.deleteCard(card.id);
    });
    host.querySelectorAll('[data-sact="flip"]').forEach(el =>
      el.addEventListener("click", () => this.flip())
    );
    host.querySelectorAll("[data-grade]").forEach(btn =>
      btn.addEventListener("click", () => this.rate(Number(btn.dataset.grade)))
    );
  }
}
