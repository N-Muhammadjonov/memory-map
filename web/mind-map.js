import {saveBlob} from "./native-downloads.js";
import {branches, canReparent, descendants, markdownOutline, MAX_DEPTH, MAX_LINKS, MAX_TOPICS,
  MAX_TOPIC_TITLE, mindLayout, POSITION_LIMIT, readMindMap, TOPIC_COLORS, TOPIC_HEIGHT, TOPIC_SHAPES,
  topicTitle} from "./mind-map-model.js";

function el(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function button(text, action) {
  const item = el("button", text);
  item.type = "button";
  item.addEventListener("click", action);
  return item;
}

function field(text, control) {
  const label = el("label");
  label.append(el("span", text), control);
  return label;
}

function svg(tag) {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function safeFileName(title) {
  const clean = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return Array.from(clean).slice(0, 120).join("").trimEnd() || "Xotira";
}

const MIN_ZOOM = 0.28;
const MAX_ZOOM = 2;

export class MindMapBoard {
  constructor(container, tools, source, options) {
    this.map = typeof source === "string" ? readMindMap(source) : source;
    this.options = options;
    this.selected = this.map.root;
    this.editVersion = 0;
    this.savedVersion = 0;
    this.history = [];
    this.future = [];
    this.saving = null;
    this.reloading = null;
    this.timer = 0;
    this.closed = false;
    this.zoom = 1;
    this.drag = null;
    this.suppressClick = false;
    this.tools = tools;
    this.cards = new Map();
    this.measurements = new Map();
    this.outlineCards = new Map();
    this.outlineMode = false;

    this.saveStatus = el("span", options.editable ? "Saved" : "Read-only", "mind-status");
    this.saveStatus.setAttribute("role", "status");
    this.retry = button("Save", () => {
      this.finishRename(true);
      void this.flush().catch(() => {});
    });
    this.retry.hidden = true;
    this.reload = button("Reload saved map", () => {
      if (window.confirm("Replace your unsaved changes with the saved map? Use Export mind map to keep a copy first.")) {
        void this.reloadSavedCopy();
      }
    });
    this.reload.hidden = true;
    this.addChild = button("+ Branch", () => this.add(false));
    this.addChild.title = "Child branch · Alt+Enter";
    this.addSibling = button("+ Sibling", () => this.add(true));
    this.addSibling.title = "Sibling branch · Enter";
    this.deleteBranch = button("Delete branch", () => this.removeBranch(this.selected));
    this.deleteBranch.classList.add("danger");
    this.forward = button("Redo", () => this.undo(true));
    this.back = button("Undo", () => this.undo(false));
    const switchView = button("Outline", () => {
      this.finishRename(true);
      this.outlineMode = !this.outlineMode;
      const outline = this.outlineMode;
      switchView.textContent = outline ? "Map" : "Outline";
      switchView.setAttribute("aria-pressed", String(outline));
      this.scroll.hidden = outline;
      this.outline.hidden = !outline;
      for (const control of this.zoomControls) control.hidden = outline;
      if (!outline) this.schedule();
      else this.renderOutline();
    });
    switchView.setAttribute("aria-pressed", "false");
    const zoomOut = button("−", () => this.setZoom(this.zoom / 1.18));
    zoomOut.setAttribute("aria-label", "Zoom out");
    const zoomIn = button("+", () => this.setZoom(this.zoom * 1.18));
    zoomIn.setAttribute("aria-label", "Zoom in");
    this.zoomControls = [zoomOut, zoomIn, button("Fit", () => this.fit())];
    this.shape = el("select");
    this.shape.setAttribute("aria-label", "Topic shape");
    this.shape.title = "Topic shape";
    this.shape.append(...TOPIC_SHAPES.map(shape => new Option(shape[0].toUpperCase() + shape.slice(1), shape)));
    this.shape.addEventListener("change", () => this.edit(map => {
      map.topics.find(topic => topic.id === this.selected).shape = this.shape.value;
    }));
    this.color = el("select");
    this.color.setAttribute("aria-label", "Topic color");
    this.color.title = "Topic color";
    this.color.append(new Option("Auto color", ""),
      ...TOPIC_COLORS.map(color => new Option(color[0].toUpperCase() + color.slice(1), color)));
    this.color.addEventListener("change", () => this.edit(map => {
      const topic = map.topics.find(item => item.id === this.selected);
      if (this.color.value) topic.color = this.color.value;
      else delete topic.color;
    }));
    tools.replaceChildren(this.shape, this.color, this.addChild, this.addSibling, this.deleteBranch, this.back, this.forward, switchView, ...this.zoomControls,
      button("Markdown", () => this.export(false)),
      button("Export mind map", () => this.export(true)), this.saveStatus, this.retry, this.reload);

    this.main = el("div", undefined, "mind-workspace");
    this.scroll = el("section", undefined, "mind-scroll");
    this.scroll.setAttribute("aria-label", "Mind map branches");
    this.world = el("div", undefined, "mind-world");
    this.plane = el("div", undefined, "mind-plane");
    this.world.append(this.plane);
    this.scroll.append(this.world);
    this.scroll.addEventListener("keydown", event => this.keyDown(event));
    this.bindViewport();
    this.outline = el("section", undefined, "mind-outline");
    this.outline.hidden = true;
    this.outline.setAttribute("aria-label", "Mind map outline");
    this.outline.addEventListener("keydown", event => this.keyDown(event));
    this.inspector = el("section", undefined, "mind-inspector");
    this.panel = el("div", undefined, "mind-fields");
    this.inspector.append(el("h2", "Topic details"), this.panel);
    this.measureHost = el("div", undefined, "mind-measurements");
    this.measureHost.setAttribute("aria-hidden", "true");
    this.main.append(this.scroll, this.outline, this.measureHost);
    if (options.inspectorHost) options.inspectorHost.replaceChildren(this.inspector);
    container.replaceChildren(this.main);
    this.render();
    if (typeof ResizeObserver === "function") {
      this.viewportObserver = new ResizeObserver(() => this.schedule());
      this.viewportObserver.observe(this.scroll);
    }
    this.frame = requestAnimationFrame(() => { if (!this.closed) this.schedule(); });
  }

  close() {
    this.closed = true;
    this.rename = null;
    this.linkedPreview?.abort.abort();
    this.inspector.remove?.();
    this.viewportObserver?.disconnect();
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
  }

  persist() {
    this.editVersion++;
    this.saveStatus.textContent = "Saving…";
    this.saveStatus.classList.remove("error");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush().catch(() => {}), 360);
  }

  async flush() {
    if (this.reloading) await this.reloading;
    this.commitDetails();
    clearTimeout(this.timer);
    while (!this.closed && this.savedVersion !== this.editVersion) {
      if (!this.saving) {
        const version = this.editVersion;
        const snapshot = structuredClone(this.map);
        this.saving = this.options.save(snapshot).then(() => {
          this.savedVersion = version;
          if (this.editVersion === version) {
            this.retry.hidden = true;
            this.reload.hidden = true;
            this.saveStatus.classList.remove("error");
            this.saveStatus.textContent = "Saved";
          }
        }).catch(error => {
          const conflict = error.status === 409 && this.options.reload;
          this.saveStatus.textContent = conflict
            ? "Another window saved this map. Export your draft or reload the saved map."
            : error.message || "Could not save the mind map.";
          this.saveStatus.classList.add("error");
          this.reload.hidden = !conflict;
          this.retry.hidden = Boolean(conflict);
          throw error;
        }).finally(() => { this.saving = null; });
      }
      await this.saving;
    }
  }

  async reloadSavedCopy() {
    if (!this.options.reload || this.closed || this.reloading || this.saving) return;
    this.finishRename(false);
    clearTimeout(this.timer);
    this.main.inert = this.tools.inert = this.inspector.inert = true;
    this.reloading = this.options.reload().then(map => {
      if (this.closed) return;
      this.map = map;
      this.expandedTopic = null;
      this.updateLinkedPreview();
      if (!map.topics.some(topic => topic.id === this.selected)) this.selected = map.root;
      this.savedVersion = this.editVersion;
      this.history = [];
      this.future = [];
      this.retry.hidden = this.reload.hidden = true;
      this.saveStatus.classList.remove("error");
      this.saveStatus.textContent = "Saved";
      this.render();
    }).catch(error => {
      this.saveStatus.textContent = error.message || "Could not reload the mind map.";
      this.saveStatus.classList.add("error");
    }).finally(() => {
      this.reloading = null;
      if (!this.closed) this.main.inert = this.tools.inert = this.inspector.inert = false;
    });
    await this.reloading;
  }

  edit(change, selected = this.selected, rerender = true) {
    if (!this.options.editable) return;
    this.finishRename(true);
    this.history.push({map: structuredClone(this.map), selected: this.selected});
    if (this.history.length > 32) this.history.shift();
    this.future = [];
    for (const {topic, side} of this.layout.nodes) {
      if (topic.parent === this.map.root) topic.side ??= side < 0 ? "left" : "right";
    }
    change(this.map);
    if (selected !== this.selected) this.expandedTopic = null;
    this.selected = selected;
    this.persist();
    if (rerender) this.render();
    else this.updateButtons();
  }

  undo(redo) {
    if (!this.options.editable) return;
    this.finishRename(true);
    const from = redo ? this.future : this.history;
    const to = redo ? this.history : this.future;
    if (!from.length) return;
    to.push({map: structuredClone(this.map), selected: this.selected});
    const state = from.pop();
    this.map = state.map;
    this.selected = state.selected;
    this.expandedTopic = null;
    this.persist();
    this.render();
    this.focusCard(this.selected);
  }

  select(id, focus = false, expand = false) {
    if (!this.tree.entries.has(id)) return;
    this.finishRename(true);
    this.commitDetails();
    this.selected = id;
    const expandedTopic = expand ? id : null;
    if (expandedTopic !== this.expandedTopic) {
      this.expandedTopic = expandedTopic;
      this.updateLinkedPreview();
      this.refreshLayout();
      if (expandedTopic) this.revealTopic(expandedTopic);
    }
    this.updateCards();
    this.renderInspector();
    this.updateButtons();
    if (focus) this.focusCard(id);
  }

  add(sibling) {
    if (!this.options.editable || this.map.topics.length >= MAX_TOPICS) return;
    const selected = this.tree.entries.get(this.selected);
    const parent = sibling ? selected.parent : selected.id;
    if (!parent) return;
    let depth = 0;
    for (let node = this.tree.entries.get(parent); node.parent !== null; node = this.tree.entries.get(node.parent)) depth++;
    if (depth >= MAX_DEPTH) {
      this.saveStatus.textContent = "Branches can be up to 40 levels deep.";
      return;
    }
    const id = crypto.randomUUID().replaceAll("-", "");
    this.edit(map => {
      const node = {id, parent, title: "New topic", note: "", ref: null, collapsed: false};
      if (parent === map.root) node.side = sibling ? selected.side : "right";
      map.topics.find(topic => topic.id === parent).collapsed = false;
      if (sibling) map.topics.splice(map.topics.findIndex(topic => topic.id === selected.id) + 1, 0, node);
      else map.topics.push(node);
    }, id);
    this.focusCard(id);
  }

  fold(id = this.selected) {
    if (!this.options.editable || id === this.map.root || !this.tree.children.get(id)?.length) return;
    this.edit(map => {
      const topic = map.topics.find(node => node.id === id);
      topic.collapsed = !topic.collapsed;
    }, id);
    this.focusCard(id);
  }

  reparent(id, parent) {
    if (!this.options.editable || !canReparent(this.map, id, parent)) return;
    this.edit(map => {
      const index = map.topics.findIndex(topic => topic.id === id);
      const [topic] = map.topics.splice(index, 1);
      topic.parent = parent;
      const original = this.layout.nodes.find(pos => pos.topic.id === id);
      if (parent === map.root) topic.side = original?.side < 0 ? "left" : "right";
      else delete topic.side;
      delete topic.offset;
      map.topics.find(node => node.id === parent).collapsed = false;
      map.topics.push(topic);
    }, id);
    this.focusCard(id);
  }

  reorder(id, delta) {
    const node = this.tree.entries.get(id);
    const siblings = this.tree.children.get(node.parent) || [];
    const sibling = siblings[siblings.findIndex(topic => topic.id === id) + delta];
    if (!sibling) return;
    this.edit(map => {
      const first = map.topics.findIndex(topic => topic.id === id);
      const second = map.topics.findIndex(topic => topic.id === sibling.id);
      [map.topics[first], map.topics[second]] = [map.topics[second], map.topics[first]];
    });
    this.focusCard(id);
  }

  removeBranch(id) {
    const topic = this.tree.entries.get(id);
    if (!this.options.editable || !topic?.parent) return;
    const removed = descendants(this.tree.children, topic.id);
    this.edit(map => {
      map.topics = map.topics.filter(node => !removed.has(node.id));
      map.links = map.links.filter(link => !removed.has(link.a) && !removed.has(link.b));
    }, topic.parent);
    this.focusCard(topic.parent);
  }

  focusCard(id) {
    const card = (this.outlineMode ? this.outlineCards : this.cards).get(id);
    if (!card) return;
    card.focus({preventScroll: true});
    card.scrollIntoView({block: "nearest", inline: "nearest"});
  }

  updateButtons() {
    const locked = !this.options.editable;
    this.addChild.hidden = this.addSibling.hidden = this.back.hidden = this.forward.hidden = locked;
    this.deleteBranch.hidden = locked || this.selected === this.map.root;
    this.addChild.disabled = this.map.topics.length >= MAX_TOPICS;
    this.addSibling.disabled = this.addChild.disabled || this.selected === this.map.root;
    this.back.disabled = !this.history.length;
    this.forward.disabled = !this.future.length;
    const topic = this.tree.entries.get(this.selected);
    this.shape.disabled = locked;
    this.shape.value = topic.shape || "rectangle";
    this.color.disabled = locked;
    this.color.value = topic.color || "";
  }

  updateCards() {
    for (const [id, card] of this.cards) {
      card.setAttribute("aria-pressed", String(id === this.selected));
      card.tabIndex = id === this.selected ? 0 : -1;
    }
    for (const [id, card] of this.outlineCards) {
      card.setAttribute("aria-current", String(id === this.selected));
    }
  }

  render() {
    this.tree = branches(this.map);
    this.updateLinkedPreview();
    for (const id of this.measurements.keys()) {
      if (!this.tree.entries.has(id)) this.measurements.delete(id);
    }
    const layout = this.measureLayout();
    this.cards.clear();
    this.plane.replaceChildren();
    this.linkLayer = svg("svg");
    this.linkLayer.classList.add("mind-edges");
    this.linkLayer.setAttribute("aria-hidden", "true");
    this.plane.append(this.linkLayer);

    for (const {topic, color, side} of layout.nodes) {
      const branch = el("div", undefined, `mind-topic mind-tone-${topic.color || color}`);
      if (topic.id === this.map.root) branch.dataset.root = "";
      branch.dataset.shape = topic.shape || "rectangle";
      const card = button(undefined, event => {
        if (event.detail > 1 || (event.detail && this.suppressClick)) return;
        this.select(topic.id, false, this.expandedTopic !== topic.id);
      });
      const description = el("span", undefined, "mind-description");
      description.hidden = true;
      card.append(el("span", topic.title, "mind-label"), description);
      card.setAttribute("aria-label", topic.title);
      card.title = topic.title;
      card.addEventListener("dblclick", () => {
        if (!this.suppressClick && this.options.editable) this.beginRename(topic.id);
      });
      if (this.options.editable) {
        card.classList.add("mind-movable");
        card.addEventListener("pointerdown", event => this.beginDrag(event, this.positions.get(topic.id), branch));
      }
      this.cards.set(topic.id, card);
      branch.append(card);
      const childCount = this.tree.children.get(topic.id).length;
      if (topic.parent !== null && childCount && this.options.editable) {
        const fold = button(topic.collapsed ? "+" + childCount : "−", () => this.fold(topic.id));
        fold.className = `mind-fold mind-fold-${side < 0 ? "left" : "right"}`;
        fold.title = topic.collapsed ? "Expand branch" : "Collapse branch";
        fold.setAttribute("aria-expanded", String(!topic.collapsed));
        fold.setAttribute("aria-label", fold.title + " · " + topic.title);
        branch.append(fold);
      }
      this.plane.append(branch);
    }
    if (this.outlineMode) this.renderOutline();
    this.updateCards();
    this.refreshLayout(layout);
    this.renderInspector();
    this.updateButtons();
  }

  measureLayout() {
    const probes = [];
    for (const topic of this.map.topics) {
      const root = topic.id === this.map.root;
      const text = this.rename?.id === topic.id ? topicTitle(this.rename.input.value) || topic.title : topic.title;
      if (this.measurements.get(topic.id)?.text === text) continue;
      const probe = el("span", text, "mind-label");
      if (root) probe.dataset.root = "";
      probe.style.maxWidth = ((root ? 208 : 172) * 2 - 24) + "px";
      probes.push({id: topic.id, text, probe});
    }
    this.measureHost.replaceChildren(...probes.map(({probe}) => probe));
    this.needsMeasurement = false;
    for (const {id, text, probe} of probes) {
      if (!probe.offsetHeight) {
        this.measurements.delete(id);
        this.needsMeasurement = true;
      } else {
        this.measurements.set(id, {text, width: probe.offsetWidth + 24, height: probe.offsetHeight + 12});
      }
    }
    const layout = mindLayout(this.map, (topic, baseWidth, baseHeight) => {
      const measured = this.measurements.get(topic.id);
      const rectangle = !topic.shape || topic.shape === "rectangle";
      const width = rectangle ? Math.max(baseWidth, measured?.width || 0) : baseWidth;
      const height = rectangle ? Math.max(baseHeight, measured?.height || 0) : baseHeight;
      const clipped = height > baseHeight * 2 || (!rectangle && measured?.width > baseWidth);
      const expanded = this.expandedTopic === topic.id && this.rename?.id !== topic.id;
      const description = expanded ? this.topicDescription(topic) : "";
      if (expanded && (description || clipped)) {
        const fullWidth = description ? (topic.parent === null ? 416 : 344) : Math.max(width, measured?.width || 0);
        const probe = el("div");
        probe.style.width = (fullWidth - 24) + "px";
        const label = el("span", topic.title, "mind-label");
        label.style.width = "auto";
        if (topic.id === this.map.root) label.dataset.root = "";
        probe.append(label);
        if (description) probe.append(el("span", description, "mind-description"));
        this.measureHost.replaceChildren(probe);
        const fullHeight = probe.offsetHeight;
        if (!fullHeight) this.needsMeasurement = true;
        return {width: fullWidth, height: Math.max(baseHeight, fullHeight + 12), clipped, expanded, description};
      }
      const editing = this.rename?.id === topic.id;
      return {width, height: editing ? height : Math.min(height, baseHeight * 2), clipped, expanded};
    });
    this.measureHost.replaceChildren();
    return layout;
  }

  topicDescription(topic) {
    const description = (topic.note || "").trimEnd();
    const linked = this.linkedPreview?.id === topic.id ? this.linkedPreview.text : "";
    if (!linked || linked === description) return description;
    if (description && linked.startsWith(description + "\n")) return linked;
    return [description, linked].filter(Boolean).join("\n\n");
  }

  updateLinkedPreview() {
    const id = this.expandedTopic;
    const ref = this.tree?.entries.get(id)?.ref;
    if (this.linkedPreview?.id === id && this.linkedPreview?.ref === ref) return;
    this.linkedPreview?.abort.abort();
    this.linkedPreview = null;
    if (!ref || !this.options.readLinkedNote) return;
    const preview = {id, ref, text: "", abort: new AbortController()};
    this.linkedPreview = preview;
    void this.options.readLinkedNote(ref, preview.abort.signal).then(text => {
      if (this.closed || this.linkedPreview !== preview || !text) return;
      preview.text = text.trimEnd();
      this.refreshLayout();
      this.revealTopic(id);
    }).catch(() => {});
  }

  clearUnavailablePreview() {
    const preview = this.linkedPreview;
    if (!preview || this.options.notes().some(note => note.id === preview.ref && !note.locked)) return;
    this.linkedPreview = null;
    preview.abort.abort();
    this.refreshLayout();
  }

  revealTopic(id) {
    const position = this.positions.get(id);
    if (!position) return;
    const top = this.planeY + (position.y - position.height / 2) * this.zoom;
    const bottom = top + Math.min(position.height * this.zoom, this.scroll.clientHeight);
    if (top < this.scroll.scrollTop || bottom > this.scroll.scrollTop + this.scroll.clientHeight) {
      this.scroll.scrollTop = Math.max(0, top - 8);
    }
  }

  refreshLayout(layout = this.measureLayout()) {
    const previous = this.layout;
    const oldX = this.planeX || 0, oldY = this.planeY || 0;
    const oldLeft = this.scroll.scrollLeft, oldTop = this.scroll.scrollTop;
    this.layout = layout;
    this.positions = new Map(layout.nodes.map(pos => [pos.topic.id, pos]));
    for (const {topic, x, y, width, height, clipped, expanded, description} of layout.nodes) {
      const card = this.cards.get(topic.id);
      const content = card.children[1];
      content.hidden = !description;
      if (content.textContent !== (description || "")) content.textContent = description || "";
      if (clipped || topic.note?.trim() || topic.ref) card.setAttribute("aria-expanded", String(Boolean(expanded)));
      else card.removeAttribute?.("aria-expanded");
      const branch = card.parentElement;
      if (!branch) continue;
      branch.style.left = (x - width / 2) + "px";
      branch.style.top = (y - height / 2) + "px";
      branch.style.width = width + "px";
      branch.style.height = height + "px";
      branch.dataset.clipped = String(Boolean(clipped && !expanded));
      branch.dataset.expanded = String(Boolean(expanded && (description || clipped)));
    }
    this.linkLayer.setAttribute("width", layout.width);
    this.linkLayer.setAttribute("height", layout.height);
    this.drawEdges();
    this.updateSize();
    if (previous && this.scroll.clientWidth) {
      this.scroll.scrollLeft = oldLeft + this.planeX - oldX + (this.layout.originX - previous.originX) * this.zoom;
      this.scroll.scrollTop = oldTop + this.planeY - oldY + (this.layout.originY - previous.originY) * this.zoom;
    }
  }

  beginRename(id) {
    if (this.rename || !this.options.editable) return;
    this.select(id);
    const card = this.cards.get(id);
    const input = el("textarea", undefined, "mind-rename");
    input.rows = 1;
    input.maxLength = MAX_TOPIC_TITLE * 2;
    input.value = this.tree.entries.get(id).title;
    input.setAttribute("aria-label", "Topic name");
    input.addEventListener("input", event => {
      if (!event.isComposing) {
        const characters = Array.from(input.value);
        if (characters.length > MAX_TOPIC_TITLE) input.value = characters.slice(0, MAX_TOPIC_TITLE).join("");
      }
      this.refreshLayout();
    });
    input.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.finishRename(event.key === "Enter", true);
      }
    });
    input.addEventListener("blur", () => this.finishRename(true));
    this.rename = {id, card, input};
    card.after(input);
    card.hidden = true;
    this.refreshLayout();
    input.focus({preventScroll: true});
    input.select();
  }

  finishRename(commit, focus = false) {
    const rename = this.rename;
    if (!rename) return;
    this.rename = null;
    const {id, card, input} = rename;
    const topic = this.tree.entries.get(id);
    const title = topicTitle(input.value);
    if (commit && title && title !== topic.title) {
      this.edit(() => { topic.title = title; }, id, false);
      this.titleInput.value = title;
      this.updateTopicTitle(topic);
    }
    input.remove();
    card.hidden = false;
    this.expandedTopic = null;
    this.refreshLayout();
    if (focus) this.focusCard(id);
  }

  updateTopicTitle(topic) {
    const card = this.cards.get(topic.id);
    if (card) {
      card.children[0].textContent = topic.title;
      card.setAttribute("aria-label", topic.title);
      card.title = topic.title;
      const fold = card.parentElement?.querySelector(".mind-fold");
      if (fold) fold.setAttribute("aria-label", fold.title + " · " + topic.title);
    }
    const outline = this.outlineCards.get(topic.id);
    if (outline) outline.textContent = topic.title;
  }

  renderOutline() {
    this.outlineCards.clear();
    const listFor = topic => {
      const row = el("li");
      const control = button(topic.title, () => this.select(topic.id));
      control.addEventListener("dblclick", () => {
        if (this.options.editable) {
          this.options.showInspector?.();
          this.titleInput.focus();
          this.titleInput.select();
        }
      });
      this.outlineCards.set(topic.id, control);
      row.append(control);
      const descendants = this.tree.children.get(topic.id);
      if (descendants.length) {
        const list = el("ul");
        for (const item of descendants) list.append(listFor(item));
        row.append(list);
      }
      return row;
    };
    const list = el("ul");
    list.append(listFor(this.tree.root));
    this.outline.replaceChildren(list);
    this.updateCards();
  }

  renderInspector() {
    const topic = this.tree.entries.get(this.selected);
    const editable = this.options.editable;
    const title = el("input");
    title.value = topic.title;
    title.maxLength = MAX_TOPIC_TITLE * 2;
    title.readOnly = !editable;
    const note = el("textarea");
    note.value = topic.note || "";
    note.maxLength = 1800;
    note.rows = 4;
    note.readOnly = !editable;
    this.commitDetails = () => {
      if (!editable || this.closed || this.reloading) return;
      const value = topicTitle(title.value) || topic.title;
      title.value = value;
      const renamed = value !== topic.title;
      if (!renamed && note.value === (topic.note || "")) return;
      this.edit(() => {
        topic.title = value;
        topic.note = note.value;
      }, topic.id, false);
      if (renamed) this.updateTopicTitle(topic);
      this.refreshLayout();
    };
    title.addEventListener("change", this.commitDetails);
    note.addEventListener("change", this.commitDetails);
    this.titleInput = title;
    const search = el("input");
    search.type = "search";
    search.placeholder = "Find a note…";
    search.setAttribute("aria-label", "Find a note to link");
    const noteList = el("select");
    const loadNotes = () => {
      const filter = search.value.trim().toLocaleLowerCase();
      const all = this.options.notes();
      const active = all.find(item => item.id === topic.ref);
      const shown = all.filter(item => item.id !== topic.ref && item.title.toLocaleLowerCase().includes(filter)).slice(0, 80);
      const activeOption = active && new Option(active.title, active.id);
      noteList.replaceChildren(new Option("No note selected", ""), ...(activeOption ? [activeOption] : []),
        ...shown.map(item => new Option(item.title, item.id)));
      noteList.value = active?.id || "";
    };
    search.addEventListener("input", loadNotes);
    noteList.addEventListener("change", () => {
      this.edit(() => { topic.ref = noteList.value || null; }, topic.id, false);
      this.updateLinkedPreview();
      this.refreshLayout();
      loadNotes();
    });
    loadNotes();
    this.panel.replaceChildren(field("Topic name", title), field("Description", note));
    if (editable) this.panel.append(search, field("Link a note", noteList));
    if (!editable) return;

    if (topic.offset) this.panel.append(button("Reset topic position", () => this.edit(() => { delete topic.offset; })));
    if (this.options.trash) {
      const trash = button("Move mind map to Trash", () => this.options.trash());
      trash.classList.add("danger");
      this.panel.append(trash);
    }
    if (topic.parent) {
      const move = el("select");
      move.append(new Option("Choose a parent branch", ""));
      const excluded = descendants(this.tree.children, topic.id);
      for (const entry of this.map.topics) {
        if (!excluded.has(entry.id) && entry.id !== topic.parent) move.add(new Option(entry.title, entry.id));
      }
      move.addEventListener("change", () => {
        if (move.value && !canReparent(this.map, topic.id, move.value)) {
          move.value = "";
          this.saveStatus.textContent = "That branch cannot move to the selected topic.";
        } else if (move.value) this.reparent(topic.id, move.value);
      });
      this.panel.append(field("Move branch", move));
      const order = el("div", undefined, "mind-row");
      const peers = this.tree.children.get(topic.parent);
      const index = peers.findIndex(node => node.id === topic.id);
      const up = button("Move up", () => this.reorder(topic.id, -1));
      const down = button("Move down", () => this.reorder(topic.id, 1));
      up.disabled = index === 0;
      down.disabled = index === peers.length - 1;
      order.append(up, down);
      this.panel.append(order);
    }

    const other = el("select");
    other.append(new Option("Choose a topic", ""));
    const links = this.map.links.filter(link => link.a === topic.id || link.b === topic.id);
    const linked = new Set(links.map(link => link.a === topic.id ? link.b : link.a));
    for (const target of this.map.topics) {
      if (target.id !== topic.id && !linked.has(target.id)) other.add(new Option(target.title, target.id));
    }
    other.disabled = this.map.links.length >= MAX_LINKS || other.options.length < 2;
    other.addEventListener("change", () => {
      if (other.value) this.edit(map => map.links.push({a: topic.id, b: other.value}));
    });
    this.panel.append(field("Connect to another topic", other));
    for (const id of linked) {
      const row = el("div", undefined, "mind-row mind-link-row");
      row.append(el("span", this.tree.entries.get(id).title), button("Remove", () => this.edit(map => {
        map.links = map.links.filter(link => !((link.a === topic.id && link.b === id) || (link.a === id && link.b === topic.id)));
      })));
      this.panel.append(row);
    }
    if (topic.parent) {
      const remove = button("Delete branch", () => this.removeBranch(topic.id));
      remove.classList.add("danger");
      this.panel.append(remove);
    }
  }

  keyDown(event) {
    const cards = this.outlineMode ? this.outlineCards : this.cards;
    if (event.target !== cards.get(this.selected)) return;
    const key = event.key;
    if ((key === "Delete" || key === "Backspace") && this.options.editable && this.selected !== this.map.root) {
      event.preventDefault();
      if (!event.repeat) this.removeBranch(this.selected);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === "z") {
      event.preventDefault();
      this.undo(event.shiftKey);
      return;
    }
    if (key === "Enter" && event.altKey) {
      event.preventDefault();
      if (!event.repeat) this.add(false);
      return;
    }
    if (key === "Enter" && this.options.editable) {
      event.preventDefault();
      if (!event.repeat) this.add(this.selected !== this.map.root);
      return;
    }
    if (key === "F2" && this.options.editable) {
      event.preventDefault();
      if (this.outlineMode) {
        this.options.showInspector?.();
        this.titleInput.focus();
        this.titleInput.select();
      } else this.beginRename(this.selected);
      return;
    }
    const topic = this.tree.entries.get(this.selected);
    let target;
    if (key === "ArrowLeft") target = topic.parent;
    else if (key === "ArrowRight") target = !topic.collapsed && this.tree.children.get(topic.id)[0]?.id;
    else if (key === "ArrowUp" || key === "ArrowDown") {
      const peers = this.tree.children.get(topic.parent) || [];
      const offset = key === "ArrowUp" ? -1 : 1;
      target = peers[peers.findIndex(node => node.id === topic.id) + offset]?.id;
    }
    if (target) { event.preventDefault(); this.select(target, true); }
  }

  drawEdges() {
    const nodes = new Map(this.layout.nodes.map(pos => {
      const preview = this.drag?.active && this.drag.pos === pos;
      return [pos.topic.id, preview ? {...pos, x: pos.x + this.drag.dx, y: pos.y + this.drag.dy} : pos];
    }));
    const paths = [];
    const draw = (a, b, cross = false) => {
      if (!a || !b) return;
      const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) * 0.6;
      const sign = Math.sign(horizontal ? b.x - a.x : b.y - a.y);
      const sx = a.x + (horizontal ? a.width / 2 * sign : 0);
      const ex = b.x - (horizontal ? b.width / 2 * sign : 0);
      const sy = a.y + (horizontal ? 0 : a.height / 2 * sign);
      const ey = b.y - (horizontal ? 0 : b.height / 2 * sign);
      const mid = horizontal ? (sx + ex) / 2 : (sy + ey) / 2;
      const edge = svg("path");
      const curve = horizontal ? `${mid} ${sy}, ${mid} ${ey}` : `${sx} ${mid}, ${ex} ${mid}`;
      edge.setAttribute("d", `M ${sx} ${sy} C ${curve}, ${ex} ${ey}`);
      edge.setAttribute("class", cross ? "mind-cross-link" : `mind-tone-${b.topic.color || b.color}`);
      paths.push(edge);
    };
    for (const node of nodes.values()) draw(nodes.get(node.topic.parent), node);
    for (const {a, b} of this.map.links) draw(nodes.get(a), nodes.get(b), true);
    this.linkLayer.replaceChildren(...paths);
  }

  beginDrag(event, pos, branch) {
    if (event.button !== 0 || !event.isPrimary) return;
    this.suppressClick = false;
    this.drag = {id: event.pointerId, pos, branch, x: event.clientX, y: event.clientY,
      dx: 0, dy: 0, active: false};
  }

  bindViewport() {
    const point = (x, y) => {
      const rect = this.scroll.getBoundingClientRect();
      return [Number.isFinite(x) ? x - rect.left : rect.width / 2,
        Number.isFinite(y) ? y - rect.top : rect.height / 2];
    };
    let pan;
    this.scroll.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !event.isPrimary || event.target.closest("button, textarea")) return;
      pan = {id: event.pointerId, x: event.clientX + this.scroll.scrollLeft, y: event.clientY + this.scroll.scrollTop};
      this.scroll.setPointerCapture(event.pointerId);
    });
    this.scroll.addEventListener("pointermove", event => {
      if (pan?.id === event.pointerId) {
        this.scroll.scrollLeft = pan.x - event.clientX;
        this.scroll.scrollTop = pan.y - event.clientY;
      }
      const drag = this.drag;
      if (drag?.id !== event.pointerId) return;
      const x = event.clientX - drag.x, y = event.clientY - drag.y;
      if (!drag.active && Math.hypot(x, y) < 5) return;
      if (!drag.active) {
        drag.active = true;
        this.scroll.setPointerCapture(event.pointerId);
        drag.branch.classList.add("mind-moving");
      }
      drag.dx = x / this.zoom;
      drag.dy = y / this.zoom;
      drag.branch.style.transform = `translate(${drag.dx}px, ${drag.dy}px)`;
      this.drawEdges();
    });
    const finish = event => {
      if (pan?.id === event.pointerId) pan = null;
      const drag = this.drag;
      if (drag?.id !== event.pointerId) return;
      this.drag = null;
      if (!drag.active) return;
      drag.branch.classList.remove("mind-moving");
      drag.branch.style.transform = "";
      this.suppressClick = true;
      if (event.type !== "pointerup") { this.drawEdges(); return; }
      this.select(drag.pos.topic.id);
      const clamp = coord => Math.round(Math.max(-POSITION_LIMIT, Math.min(POSITION_LIMIT, coord)));
      const [x, y] = drag.pos.topic.offset || [0, 0];
      this.edit(() => { drag.pos.topic.offset = [clamp(x + drag.dx), clamp(y + drag.dy)]; });
    };
    for (const kind of ["pointerup", "pointercancel", "lostpointercapture"]) this.scroll.addEventListener(kind, finish);
    this.scroll.addEventListener("wheel", event => {
      if (this.options.inline?.() && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.scroll.clientHeight : 1;
      if (event.shiftKey && !event.ctrlKey) {
        this.scroll.scrollLeft += (event.deltaX || event.deltaY) * units;
        return;
      }
      const delta = (event.deltaY || event.deltaX) * units;
      const factor = Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.0028);
      this.setZoom(this.zoom * factor, ...point(event.clientX, event.clientY));
    }, {passive: false});
    let pinch;
    const distance = touches => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    this.scroll.addEventListener("touchstart", event => {
      if (event.touches.length !== 2) return;
      event.preventDefault();
      if (this.drag) finish({pointerId: this.drag.id, type: "pointercancel"});
      pan = null;
      pinch = {distance: Math.max(1, distance(event.touches)), zoom: this.zoom};
    }, {passive: false});
    this.scroll.addEventListener("touchmove", event => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const [a, b] = event.touches;
      const center = point((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      this.setZoom(pinch.zoom * distance(event.touches) / pinch.distance, ...center);
    }, {passive: false});
    for (const kind of ["touchend", "touchcancel"]) this.scroll.addEventListener(kind, () => { pinch = null; });
    let gestureZoom;
    this.scroll.addEventListener("gesturestart", event => {
      event.preventDefault();
      gestureZoom = this.zoom;
    });
    this.scroll.addEventListener("gesturechange", event => {
      event.preventDefault();
      if (!pinch && gestureZoom !== undefined) this.setZoom(gestureZoom * event.scale, ...point(event.clientX, event.clientY));
    });
    this.scroll.addEventListener("gestureend", () => { gestureZoom = undefined; });
  }

  updateSize() {
    const contentWidth = Math.ceil(this.layout.width * this.zoom);
    const contentHeight = Math.ceil(this.layout.height * this.zoom);
    const width = Math.max(this.scroll.clientWidth || 0, contentWidth);
    const height = Math.max(this.scroll.clientHeight || 0, contentHeight);
    this.planeX = (width - contentWidth) / 2;
    this.planeY = (height - contentHeight) / 2;
    this.plane.style.left = this.planeX + "px";
    this.plane.style.top = this.planeY + "px";
    this.plane.style.width = this.layout.width + "px";
    this.plane.style.height = this.layout.height + "px";
    this.plane.style.transform = `scale(${this.zoom})`;
    this.world.style.width = width + "px";
    this.world.style.height = height + "px";
  }

  setZoom(value, px = this.scroll.clientWidth / 2, py = this.scroll.clientHeight / 2) {
    const x = (this.scroll.scrollLeft + px - this.planeX) / this.zoom;
    const y = (this.scroll.scrollTop + py - this.planeY) / this.zoom;
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    this.updateSize();
    this.scroll.scrollLeft = x * this.zoom + this.planeX - px;
    this.scroll.scrollTop = y * this.zoom + this.planeY - py;
  }

  fit() {
    if (!this.scroll.clientWidth || !this.scroll.clientHeight) return;
    const width = this.scroll.clientWidth, height = this.scroll.clientHeight;
    this.setZoom(Math.min(1, width / this.layout.width, height / this.layout.height));
    this.scroll.scrollLeft = (this.layout.width * this.zoom - width) / 2 + this.planeX;
    this.scroll.scrollTop = (this.layout.height * this.zoom - height) / 2 + this.planeY;
  }

  schedule() {
    if (!this.scroll.clientWidth) return;
    if (this.needsMeasurement) this.refreshLayout();
    if (!this.firstVisible) {
      this.firstVisible = true;
      this.fit();
    } else this.updateSize();
  }

  export(native) {
    this.finishRename(true);
    const title = safeFileName(this.tree.root.title);
    const data = native ? JSON.stringify(this.map, null, 2) + "\n" : markdownOutline(this.map);
    void saveBlob(new Blob([data], {type: native ? "application/json" : "text/markdown"}),
      title + (native ? ".mindmap" : ".md")).catch(error => {
      this.saveStatus.textContent = error.message;
      this.saveStatus.classList.add("error");
    });
  }
}
