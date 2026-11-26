const TYPES = new Set(["text", "file", "link", "group"]);
const COLORS = ["#ef8584", "#eab181", "#e7ca7b", "#8bd8af", "#7cbde2", "#b8a1e6"];
const SIDES = {top: [.5, 0], right: [1, .5], bottom: [.5, 1], left: [0, .5]};
const MAX_ITEMS = 4000;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function control(label, fn, title = label) {
  const button = element("button", label);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", fn);
  return button;
}

function color(value, fallback) {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : COLORS[Number(value) - 1] || fallback;
}

function readCanvas(source) {
  let data;
  try {
    data = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Could not read the Canvas JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid Canvas file format.");
  const nodes = data.nodes ?? [];
  const edges = data.edges ?? [];
  if (!Array.isArray(nodes) || !Array.isArray(edges) || nodes.length + edges.length > MAX_ITEMS) {
    throw new Error("Invalid Canvas format or more than 4,000 items.");
  }
  const ids = new Set();
  for (const item of nodes) {
    if (!item || typeof item.id !== "string" || ids.has(item.id) || !TYPES.has(item.type)
        || ![item.x, item.y, item.width, item.height].every(Number.isFinite)
        || Math.abs(item.x) > 1_000_000 || Math.abs(item.y) > 1_000_000
        || item.width <= 0 || item.height <= 0 || item.width > 100_000 || item.height > 100_000) {
      throw new Error("The canvas contains an invalid node.");
    }
    ids.add(item.id);
  }
  for (const edge of edges) {
    if (!edge || typeof edge.id !== "string" || typeof edge.fromNode !== "string" || typeof edge.toNode !== "string") {
      throw new Error("The canvas contains an invalid connection.");
    }
  }
  return {...data, nodes, edges};
}

function edgeEnd(node, side, other) {
  if (!Object.hasOwn(SIDES, side)) {
    const dx = other.x + other.width / 2 - node.x - node.width / 2;
    const dy = other.y + other.height / 2 - node.y - node.height / 2;
    side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "bottom" : "top");
  }
  const [x, y] = SIDES[side];
  return [node.x + x * node.width, node.y + y * node.height, 2 * x - 1, 2 * y - 1];
}

export class CanvasBoard {
  constructor(container, tools, data, openReference, save, canEdit) {
    this.data = readCanvas(data);
    this.nodes = new Map(this.data.nodes.map(node => [node.id, node]));
    this.offset = [0, 0];
    this.zoom = 1;
    this.changed = 0;
    this.saved = 0;
    this.saving = null;
    this.gesture = null;
    this.frame = 0;
    this.board = element("div", undefined, "canvas-board");
    this.board.tabIndex = 0;
    this.board.setAttribute("aria-label", "Canvas maydoni");
    this.layers = {
      groups: element("div", undefined, "canvas-layer"),
      edges: element("canvas", undefined, "canvas-edges"),
      nodes: element("div", undefined, "canvas-layer"),
    };
    this.layers.edges.setAttribute("aria-hidden", "true");
    this.board.append(this.layers.groups, this.layers.edges, this.layers.nodes);
    this.openReference = openReference;
    this.save = save;
    this.canEdit = canEdit;
    this.info = element("span", "", "canvas-info");
    this.info.setAttribute("aria-live", "polite");
    const add = control("+ Text", () => this.addText());
    const saveButton = control("Save", () => void this.flush().catch(() => {}));
    add.hidden = saveButton.hidden = !canEdit;
    this.saveButton = saveButton;
    tools.replaceChildren(
      control("−", () => this.scale(1 / 1.25), "Canvasni uzoqlashtirish"),
      control("+", () => this.scale(1.25), "Canvasni yaqinlashtirish"),
      control("Fit", () => this.fit()), add, saveButton, this.info,
    );
    container.replaceChildren(this.board);
    for (const node of this.nodes.values()) this.addCard(node);
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(this.board);
    this.board.addEventListener("pointerdown", event => this.start(event));
    this.board.addEventListener("pointermove", event => this.move(event));
    for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
      this.board.addEventListener(eventName, () => {
        this.gesture = null;
        this.board.classList.remove("moving");
      });
    }
    this.board.addEventListener("wheel", event => {
      if (event.target.closest(".canvas-card-text")?.matches(":focus")) return;
      event.preventDefault();
      const rect = this.board.getBoundingClientRect();
      this.scale(Math.exp(Math.max(-.44, Math.min(.44, -event.deltaY * .002))), event.clientX - rect.left, event.clientY - rect.top);
    }, {passive: false});
    this.board.addEventListener("keydown", event => {
      if (event.target !== this.board) return;
      const delta = {ArrowLeft: [-35, 0], ArrowRight: [35, 0], ArrowUp: [0, -35], ArrowDown: [0, 35]}[event.key];
      if (!delta) return;
      event.preventDefault();
      this.offset[0] += delta[0];
      this.offset[1] += delta[1];
      this.schedule();
    });
    this.cards = new Map([...this.board.querySelectorAll("[data-card]")].map(card => [card.dataset.card, card]));
    this.paintStatus();
    this.fit();
  }

  addCard(node) {
    const card = element("article", undefined, `canvas-card canvas-${node.type}`);
    card.dataset.card = node.id;
    card.style.setProperty("--card-color", color(node.color, "#5d787e"));
    const name = {text: "Text", file: "File", link: "Link", group: "Group"}[node.type];
    const handle = element("header", node.type === "group" ? node.label || name : name, "canvas-handle");
    card.append(handle);
    if (node.type === "text") {
      const input = element("textarea", undefined, "canvas-card-text");
      input.value = typeof node.text === "string" ? node.text : "";
      input.readOnly = !this.canEdit;
      input.maxLength = 200000;
      input.setAttribute("aria-label", "Canvas matni");
      input.addEventListener("input", () => {
        node.text = input.value;
        this.markChanged();
      });
      card.append(input);
    } else if (node.type === "file") {
      const file = typeof node.file === "string" ? node.file : "";
      card.append(control(file || "File", async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          if (!await this.openReference(file, node.subpath)) this.paintStatus("The linked file was not found in the vault.");
        } catch (error) {
          this.paintStatus(error.message);
        } finally {
          button.disabled = false;
        }
      }));
    } else if (node.type === "link" && typeof node.url === "string") {
      const link = element(/^https?:\/\//i.test(node.url) ? "a" : "span", node.url);
      if (link.tagName === "A") {
        link.href = node.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      card.append(link);
    }
    if (node.type === "group") this.layers.groups.append(card);
    else this.layers.nodes.append(card);
    return card;
  }

  addText() {
    if (this.nodes.size + this.data.edges.length >= MAX_ITEMS) {
      this.paintStatus("Canvas 4 000 ta element chegarasiga yetdi.");
      return;
    }
    const id = crypto.randomUUID();
    const node = {
      id, type: "text", text: "", width: 260, height: 160,
      x: Math.round((this.board.clientWidth / 2 - this.offset[0]) / this.zoom - 130),
      y: Math.round((this.board.clientHeight / 2 - this.offset[1]) / this.zoom - 80),
    };
    this.data.nodes.push(node);
    this.nodes.set(id, node);
    const card = this.addCard(node);
    this.cards.set(id, card);
    this.markChanged();
    this.schedule();
    card.querySelector("textarea").focus({preventScroll: true});
  }

  get dirty() { return this.changed !== this.saved; }

  paintStatus(message) {
    this.info.textContent = message || (this.saving ? "Saving…" : this.dirty ? "Unsaved" : `${this.nodes.size} nodes`);
    this.saveButton.disabled = Boolean(this.saving) || !this.dirty;
  }

  markChanged() {
    this.changed++;
    this.paintStatus();
  }

  async flush() {
    while (this.dirty) {
      if (!this.saving) {
        const version = this.changed;
        this.saving = this.save(this.data).then(() => { this.saved = version; })
          .finally(() => { this.saving = null; });
        this.paintStatus();
      }
      try {
        await this.saving;
        this.paintStatus();
      } catch (error) {
        this.paintStatus(error.message);
        throw error;
      }
    }
  }

  start(event) {
    if (event.button !== 0 || event.target.closest("textarea, button, a")) return;
    const handle = event.target.closest(".canvas-handle");
    const node = this.canEdit && handle ? this.nodes.get(handle.closest("[data-card]").dataset.card) : null;
    this.gesture = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      node, origin: node ? [node.x, node.y] : this.offset.slice(),
    };
    this.board.setPointerCapture(event.pointerId);
    this.board.classList.add("moving");
  }

  move(event) {
    const gesture = this.gesture;
    if (gesture?.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    const [x, y] = gesture.origin;
    if (gesture.node) {
      const nextX = Math.max(-1_000_000, Math.min(1_000_000, Math.round(x + dx / this.zoom)));
      const nextY = Math.max(-1_000_000, Math.min(1_000_000, Math.round(y + dy / this.zoom)));
      if (nextX === gesture.node.x && nextY === gesture.node.y) return;
      gesture.node.x = nextX;
      gesture.node.y = nextY;
      this.markChanged();
    } else this.offset = [x + dx, y + dy];
    this.schedule();
  }

  scale(factor, x = this.board.clientWidth / 2, y = this.board.clientHeight / 2) {
    const next = Math.max(.001, Math.min(3.5, this.zoom * factor));
    this.offset = [x + (this.offset[0] - x) * next / this.zoom, y + (this.offset[1] - y) * next / this.zoom];
    this.zoom = next;
    this.schedule();
  }

  fit() {
    const nodes = this.data.nodes;
    const {clientWidth: width, clientHeight: height} = this.board;
    if (!nodes.length) {
      this.offset = [width / 2, height / 2];
      this.zoom = 1;
    } else {
      const left = Math.min(...nodes.map(node => node.x)), right = Math.max(...nodes.map(node => node.x + node.width));
      const top = Math.min(...nodes.map(node => node.y)), bottom = Math.max(...nodes.map(node => node.y + node.height));
      this.zoom = Math.max(.001, Math.min(1.25, (width - 40) / (right - left), (height - 40) / (bottom - top)));
      this.offset = [(width - (left + right) * this.zoom) / 2, (height - (top + bottom) * this.zoom) / 2];
    }
    this.schedule();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  draw() {
    const {zoom, offset} = this;
    const {clientWidth: width, clientHeight: height} = this.board;
    if (!width || !height) return;
    const transform = `translate(${offset[0]}px, ${offset[1]}px) scale(${zoom})`;
    this.layers.groups.style.transform = this.layers.nodes.style.transform = transform;
    for (const node of this.nodes.values()) {
      const card = this.cards.get(node.id);
      card.style.width = node.width + "px";
      card.style.height = node.height + "px";
      card.style.transform = `translate(${node.x}px, ${node.y}px)`;
    }
    const canvas = this.layers.edges;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    for (const edge of this.data.edges) {
      const from = this.nodes.get(edge.fromNode), to = this.nodes.get(edge.toNode);
      if (!from || !to) continue;
      this.drawEdge(ctx, edge, from, to);
    }
  }

  drawEdge(ctx, edge, from, to) {
    const [x, y] = this.offset, z = this.zoom;
    const [a, b, vx, vy] = edgeEnd(from, edge.fromSide, to);
    const [c, d, wx, wy] = edgeEnd(to, edge.toSide, from);
    const start = [x + a * z, y + b * z], end = [x + c * z, y + d * z];
    const bend = Math.max(12, Math.min(110, Math.hypot(end[0] - start[0], end[1] - start[1]) * .34));
    const initial = [start[0] + vx * bend, start[1] + vy * bend];
    const final = [end[0] + wx * bend, end[1] + wy * bend];
    ctx.strokeStyle = ctx.fillStyle = color(edge.color, "#84a4ae");
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(...start);
    ctx.bezierCurveTo(...initial, ...final, ...end);
    ctx.stroke();
    const arrow = ([px, py], dx, dy) => {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + dx * 9 - dy * 4, py + dy * 9 + dx * 4);
      ctx.lineTo(px + dx * 9 + dy * 4, py + dy * 9 - dx * 4);
      ctx.closePath();
      ctx.fill();
    };
    if (edge.fromEnd === "arrow") arrow(start, vx, vy);
    if (edge.toEnd !== "none") arrow(end, wx, wy);
    if (typeof edge.label === "string" && z > .32) {
      ctx.font = "12px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(edge.label.slice(0, 100), (start[0] + end[0] + 3 * (initial[0] + final[0])) / 8,
        (start[1] + end[1] + 3 * (initial[1] + final[1])) / 8 - 5, 220);
    }
  }

  close() {
    this.observer.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
  }
}
