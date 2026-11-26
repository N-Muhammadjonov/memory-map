import {t} from "./i18n.js";

const MAX_MARKS = 300;
const MAX_POINTS = 20_000;
const MAX_STROKE = 3000;
const REFERENCE_WIDTH = 1000;
const clamp = value => Math.max(0, Math.min(1, value));

function control(tag, label) {
  const node = document.createElement(tag);
  if (tag === "button") {
    node.type = "button";
    node.textContent = t(label);
  } else {
    node.setAttribute("aria-label", t(label));
  }
  return node;
}

export function relativePoint(x, y, bounds) {
  const normalized = (value, begin, length) => Math.round(clamp((value - begin) / Math.max(1, length)) * 100_000) / 100_000;
  return [normalized(x, bounds.left, bounds.width), normalized(y, bounds.top, bounds.height)];
}

function distanceToLine(x, y, a, b, width, height) {
  const ax = a[0] * width, ay = a[1] * height;
  const dx = b[0] * width - ax, dy = b[1] * height - ay;
  const length = dx * dx + dy * dy;
  const progress = length ? clamp(((x - ax) * dx + (y - ay) * dy) / length) : 0;
  return Math.hypot(x - ax - progress * dx, y - ay - progress * dy);
}

function fontSize(mark, width) {
  return Math.max(8, mark.size * width / REFERENCE_WIDTH);
}

function textLines(context, mark, width) {
  const size = fontSize(mark, width);
  context.font = "600 " + size + "px system-ui, sans-serif";
  const position = Math.min(mark.point[0] * width, width - size * 2);
  const available = Math.max(size * 2, width - position - 4);
  const lines = [];
  for (const line of mark.text.split("\n")) {
    let current = "";
    for (const character of line) {
      if (current && context.measureText(current + character).width > available) {
        lines.push(current);
        current = "";
      }
      current += character;
    }
    lines.push(current);
  }
  return {lines, size, position, height: lines.length * size * 1.2};
}

export function eraseMark(marks, point, width, height, context) {
  const [x, y] = [point[0] * width, point[1] * height];
  for (let index = marks.length - 1; index >= 0; index--) {
    const mark = marks[index];
    if (mark.kind === "text") {
      const layout = textLines(context, mark, width);
      const top = Math.min(mark.point[1] * height, Math.max(0, height - layout.height));
      if (y >= top - 5 && y <= top + layout.height + 5 && x >= layout.position - 5
          && x <= layout.position + 5 + Math.max(...layout.lines.map(line => context.measureText(line).width))) return index;
    } else {
      const radius = Math.max(mark.size * width / REFERENCE_WIDTH / 2 + 4, 8);
      if (mark.points.some((end, step) => distanceToLine(x, y, mark.points[step - 1] || end, end, width, height) <= radius)) return index;
    }
  }
  return -1;
}

export class AttachmentMarkup {
  constructor(viewer, session) {
    this.viewer = viewer;
    this.session = session;
    this.canEdit = session.canEdit;
    this.mode = "";
    this.preferred = "ink";
    this.sizes = {ink: 4, highlight: 24, text: 26};
    this.colors = {ink: "#dc2626", highlight: "#fde047", text: "#dc2626"};
    this.history = [];
    this.marks = [];
    this.ready = false;
    this.dirty = false;
    this.frame = 0;
    this.sequence = 0;
    this.buildControls();
  }

  buildControls() {
    this.tools = document.createElement("div");
    this.tools.className = "markup-tools";
    this.editor = document.createElement("div");
    this.editor.className = "markup-controls";
    this.editor.hidden = true;
    this.status = document.createElement("span");
    this.status.className = "markup-status";
    this.status.setAttribute("role", "status");
    this.open = control("button", "markup-open");
    this.open.setAttribute("aria-pressed", "false");
    this.open.addEventListener("click", () => this.setMode(this.mode ? "" : this.preferred));
    this.modeButtons = new Map();
    for (const mode of ["ink", "highlight", "text", "eraser"]) {
      const button = control("button", "markup-" + mode);
      button.addEventListener("click", () => this.setMode(mode));
      this.modeButtons.set(mode, button);
      this.editor.append(button);
    }
    const color = this.color = control("input", "markup-color");
    color.type = "color";
    color.addEventListener("input", () => { this.colors[this.mode] = color.value; });
    const size = this.size = control("input", "markup-size");
    size.type = "range";
    size.min = 1;
    size.max = 64;
    size.addEventListener("input", () => { this.sizes[this.mode] = Number(size.value); });
    this.text = control("textarea", "markup-text-input");
    this.text.placeholder = t("markup-text-prompt");
    this.text.maxLength = 500;
    this.text.rows = 2;
    this.text.hidden = true;
    this.undo = control("button", "markup-undo");
    this.undo.addEventListener("click", () => {
      if (!this.history.length) return;
      this.marks = this.history.pop();
      this.changed();
    });
    this.save = control("button", "markup-save");
    this.save.className = "primary";
    this.save.addEventListener("click", () => { void this.flush().catch(() => {}); });
    this.reload = control("button", "markup-reload");
    this.reload.hidden = true;
    this.reload.addEventListener("click", () => {
      if (!this.dirty || window.confirm(t("markup-discard"))) void this.load();
    });
    this.editor.append(color, size, this.undo, this.save, this.text);
    if (this.canEdit) this.tools.append(this.open, this.editor);
    this.tools.append(this.reload, this.status);
    this.viewer.tools.append(this.tools);
    this.updateControls();
  }

  mount(surface, element, style = "") {
    this.resize?.disconnect();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.stroke = null;
    this.pointerId = null;
    this.surface = surface;
    this.marks = [];
    this.ready = this.dirty = false;
    const stage = document.createElement("div");
    stage.className = "markup-stage" + (style ? " " + style : "");
    this.stage = stage;
    const layer = this.layer = document.createElement("canvas");
    layer.className = "markup-layer";
    layer.setAttribute("aria-label", t("markup-layer"));
    this.context = layer.getContext("2d");
    this.textReader = document.createElement("span");
    this.textReader.className = "sr-only";
    stage.append(element, layer, this.textReader);
    this.viewer.container.replaceChildren(stage);
    this.viewer.container.scrollTop = 0;
    layer.addEventListener("pointerdown", event => this.pointerDown(event));
    layer.addEventListener("pointermove", event => this.pointerMove(event));
    layer.addEventListener("pointerup", event => this.finishStroke(event, true));
    layer.addEventListener("pointercancel", event => this.finishStroke(event, false));
    layer.addEventListener("lostpointercapture", event => this.finishStroke(event, false));
    layer.addEventListener("keydown", event => {
      if (event.key === "Enter" && this.mode === "text") {
        event.preventDefault();
        this.placeText([0.12, 0.12]);
      }
    });
    this.resize = new ResizeObserver(() => this.repaint());
    this.resize.observe(stage);
    this.setMode(this.mode);
    this.repaint();
    return this.load();
  }

  url() {
    return this.session.path + "?view=markup&surface=" + this.surface;
  }

  async load() {
    const seq = ++this.sequence;
    this.ready = false;
    this.reload.hidden = true;
    this.status.textContent = "";
    this.updateControls();
    try {
      const data = await this.viewer.request(this.url(), {signal: this.session.abort.signal});
      if (seq !== this.sequence) return;
      this.revision = data.revision;
      this.marks = data.marks;
      this.history = [];
      this.dirty = false;
      this.ready = true;
      this.status.textContent = "";
      this.updateTextReader();
      this.repaint();
    } catch (error) {
      if (seq !== this.sequence || error.name === "AbortError") return;
      this.status.textContent = error.message;
      this.reload.hidden = false;
    } finally {
      if (seq === this.sequence) this.updateControls();
    }
  }

  setMode(mode) {
    this.mode = mode;
    if (mode) this.preferred = mode;
    this.open.setAttribute("aria-pressed", String(Boolean(mode)));
    this.editor.hidden = !mode;
    this.text.hidden = mode !== "text";
    if (mode && mode !== "eraser") {
      this.color.value = this.colors[mode];
      this.size.value = this.sizes[mode];
    }
    for (const [name, button] of this.modeButtons) button.setAttribute("aria-pressed", String(name === mode));
    this.updateControls();
    if (mode === "text" && this.ready) this.text.focus({preventScroll: true});
  }

  updateControls() {
    this.open.disabled = !this.ready || !this.context || Boolean(this.saving);
    this.save.disabled = !this.ready || !this.dirty || Boolean(this.saving);
    this.undo.disabled = !this.ready || !this.history.length || Boolean(this.saving);
    for (const button of this.modeButtons.values()) button.disabled = !this.ready || Boolean(this.saving);
    this.text.disabled = this.color.disabled = this.size.disabled = !this.ready || this.mode === "eraser" || Boolean(this.saving);
    if (this.layer) {
      const enabled = this.canEdit && this.ready && this.mode && !this.saving;
      this.layer.classList.toggle("is-editing", Boolean(enabled));
      this.layer.tabIndex = enabled && this.mode === "text" ? 0 : -1;
    }
  }

  addMarks(marks) {
    const points = marks.reduce((count, mark) => count + (mark.points?.length || 0), 0);
    if (marks.length > MAX_MARKS || points > MAX_POINTS) {
      this.status.textContent = t("markup-limit");
      return;
    }
    this.history.push(this.marks);
    if (this.history.length > 40) this.history.shift();
    this.marks = marks;
    this.changed();
  }

  changed() {
    this.dirty = true;
    this.status.textContent = t("markup-unsaved");
    this.updateControls();
    this.updateTextReader();
    this.repaint();
  }

  updateTextReader() {
    if (this.textReader) this.textReader.textContent = this.marks.filter(mark => mark.kind === "text").map(mark => mark.text).join("\n");
  }

  point(event) {
    return relativePoint(event.clientX, event.clientY, this.layer.getBoundingClientRect());
  }

  pointerDown(event) {
    if (!this.canEdit || !this.ready || this.saving || !this.mode || event.button !== 0 || this.pointerId != null) return;
    event.preventDefault();
    const point = this.point(event);
    if (this.mode === "text") {
      this.placeText(point);
      return;
    }
    if (this.mode === "eraser") {
      const bounds = this.layer.getBoundingClientRect();
      const index = eraseMark(this.marks, point, bounds.width, bounds.height, this.context);
      if (index !== -1) this.addMarks(this.marks.filter((_, position) => position !== index));
      return;
    }
    this.pointerId = event.pointerId;
    this.layer.setPointerCapture(event.pointerId);
    this.stroke = {kind: this.mode, color: this.color.value, size: Number(this.size.value), points: [point]};
    this.repaint();
  }

  pointerMove(event) {
    if (event.pointerId !== this.pointerId || !this.stroke) return;
    const point = this.point(event);
    const bounds = this.layer.getBoundingClientRect();
    const points = this.stroke.points;
    const last = points.at(-1);
    if (points.length < MAX_STROKE && Math.hypot((point[0] - last[0]) * bounds.width, (point[1] - last[1]) * bounds.height) >= 1.2) {
      points.push(point);
      this.repaint();
    }
  }

  finishStroke(event, commit) {
    if (event.pointerId !== this.pointerId) return;
    if (commit) this.pointerMove(event);
    const stroke = this.stroke;
    this.stroke = this.pointerId = null;
    if (commit && stroke) this.addMarks([...this.marks, stroke]);
    this.repaint();
  }

  placeText(point) {
    if (!this.ready || this.saving) return;
    const text = this.text.value.trim();
    if (!text) {
      this.status.textContent = t("markup-text-prompt");
      this.text.focus();
      return;
    }
    this.addMarks([...this.marks, {kind: "text", color: this.color.value, size: Number(this.size.value), point, text}]);
    this.text.value = "";
  }

  repaint() {
    if (this.frame || !this.context) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const {width, height} = this.stage.getBoundingClientRect();
      if (!width || !height) return;
      const scale = Math.min(devicePixelRatio || 1, 2, 4096 / Math.max(width, height));
      const pixelsWide = Math.max(1, Math.ceil(width * scale));
      const pixelsHigh = Math.max(1, Math.ceil(height * scale));
      if (this.layer.width !== pixelsWide) this.layer.width = pixelsWide;
      if (this.layer.height !== pixelsHigh) this.layer.height = pixelsHigh;
      const context = this.context;
      context.setTransform(pixelsWide / width, 0, 0, pixelsHigh / height, 0, 0);
      context.clearRect(0, 0, width, height);
      for (const item of this.marks) this.paint(item, width, height);
      if (this.stroke) this.paint(this.stroke, width, height);
    });
  }

  paint(mark, width, height) {
    const context = this.context;
    context.globalAlpha = mark.kind === "highlight" ? 0.35 : 1;
    context.fillStyle = context.strokeStyle = mark.color;
    if (mark.kind === "text") {
      const layout = textLines(context, mark, width);
      const top = Math.min(mark.point[1] * height, Math.max(0, height - layout.height));
      context.textBaseline = "top";
      layout.lines.forEach((line, index) => context.fillText(line, layout.position, top + index * layout.size * 1.2));
      return;
    }
    context.lineWidth = Math.max(1, mark.size * width / REFERENCE_WIDTH);
    context.lineCap = context.lineJoin = "round";
    const first = mark.points[0];
    context.beginPath();
    if (mark.points.length === 1) {
      context.arc(first[0] * width, first[1] * height, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
      return;
    }
    context.moveTo(first[0] * width, first[1] * height);
    for (const point of mark.points.slice(1)) context.lineTo(point[0] * width, point[1] * height);
    context.stroke();
  }

  async flush() {
    if (this.saving) return this.saving;
    if (!this.dirty) return;
    if (!this.ready) throw new Error(t("markup-reload"));
    this.status.textContent = t("markup-saving");
    this.saving = this.viewer.request(this.url(), {
      signal: this.session.abort.signal,
      body: {revision: this.revision, marks: this.marks},
    });
    this.updateControls();
    try {
      const result = await this.saving;
      this.revision = result.revision;
      this.dirty = false;
      this.reload.hidden = true;
      this.status.textContent = t("markup-saved");
    } catch (error) {
      this.status.textContent = error.message;
      this.reload.hidden = error.status !== 409;
      throw error;
    } finally {
      this.saving = null;
      this.updateControls();
    }
  }

  suspend() {
    this.ready = false;
    this.updateControls();
  }

  close() {
    this.sequence++;
    this.resize?.disconnect();
    cancelAnimationFrame(this.frame);
  }
}
