import {anchoredShapeStroke, recognizeShape} from "./shape-recognition.js";

const FORMATS = {
  bold: "**",
  italic: "*",
  strike: "~~",
  highlight: "==",
  "inline-code": "`",
};

const MARKERS = {h1: "# ", h2: "## ", h3: "### ", task: "- [ ] ", bullet: "- ", numbered: "1. ", quote: "> "};
const EXAMPLES = {h1: "Title", h2: "Title", h3: "Title", task: "Task", bullet: "Item", numbered: "Item", quote: "Quote"};

export function mergeSavedAttachments(before, current, saved) {
  const currentIds = new Set(current.map(file => file.id));
  const savedIds = new Set(saved.map(file => file.id));
  return [
    ...saved.filter(file => !before.has(file.id) || currentIds.has(file.id)),
    ...current.filter(file => !before.has(file.id) && !savedIds.has(file.id)),
  ];
}

export function formatSelection(input, type, range) {
  const marker = FORMATS[type];
  const {value} = input;
  let [start, end] = range;
  const selected = value.slice(start, end);
  const content = selected.trim();
  if (!marker || !content) return false;
  start += selected.length - selected.trimStart().length;
  end = start + content.length;
  let delimiter = marker;
  if ((type === "italic" || type === "bold") && content === selected) {
    const left = value.slice(0, start).match(/\*+$/)?.[0].length || 0;
    const right = value.slice(end).match(/^\*+/)?.[0].length || 0;
    if (left === right && left > 0 && left < 4) {
      start -= left;
      end += right;
      delimiter = "*".repeat(left ^ marker.length);
    }
  } else if (value.slice(Math.max(0, start - marker.length), start) === marker &&
             value.slice(end, end + marker.length) === marker) {
    start -= marker.length;
    end += marker.length;
    delimiter = "";
  } else if (type === "inline-code" && content.includes("`")) {
    const longest = Math.max(...Array.from(content.matchAll(/`+/g), match => match[0].length));
    delimiter = "`".repeat(longest + 1) + " ";
  }
  const closing = delimiter.endsWith(" ") ? " " + delimiter.trimEnd() : delimiter;
  input.setRangeText(delimiter + content + closing, start, end, "end");
  input.focus({preventScroll: true});
  input.setSelectionRange(start + delimiter.length, start + delimiter.length + content.length);
  return true;
}

export function insertBlock(input, type) {
  const {selectionStart: start, selectionEnd: end, value} = input;
  const selection = value.slice(start, end);
  const marker = MARKERS[type];
  if (marker !== undefined) {
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const endOfLine = value.indexOf("\n", end);
    const lineEnd = endOfLine < 0 ? value.length : endOfLine;
    const existing = value.slice(lineStart, lineEnd);
    const text = existing ? existing.split("\n").map(line => marker + line.replace(/^#{1,6} +/, "")).join("\n")
      : marker + EXAMPLES[type];
    input.setRangeText(text, lineStart, lineEnd, "end");
    if (!existing) input.setSelectionRange(lineStart + marker.length, lineStart + text.length);
  } else {
    const prefix = start ? "\n\n" : "";
    const block = {
      callout: "> [!note] Note\n> " + (selection || "Text"),
      code: "```\n" + selection + "\n```",
      table: "| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |",
      divider: "---",
    }[type];
    if (block === undefined) return;
    input.setRangeText(prefix + block + "\n\n", start, end, "end");
    if (type === "code") input.setSelectionRange(start + prefix.length + 4, start + prefix.length + 4 + selection.length);
    if (type === "table") input.setSelectionRange(start + prefix.length + 2, start + prefix.length + 9);
  }
  input.focus();
}

export function resizePane(workspace, separator, pane, other, variable, direction, minimum) {
  let gesture = null;
  function setWidth(value) {
    const available = Math.max(minimum, workspace.clientWidth - other.offsetWidth - 335);
    const width = Math.round(Math.min(available, workspace.clientWidth * .52, Math.max(minimum, value)));
    workspace.style.setProperty(variable, width + "px");
    separator.setAttribute("aria-valuenow", String(width));
  }
  separator.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    separator.focus();
    separator.setPointerCapture(event.pointerId);
    gesture = {id: event.pointerId, x: event.clientX, width: pane.offsetWidth};
    workspace.classList.add("resizing");
  });
  separator.addEventListener("pointermove", event => {
    if (gesture?.id === event.pointerId) setWidth(gesture.width + direction * (event.clientX - gesture.x));
  });
  for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
    separator.addEventListener(eventName, () => {
      gesture = null;
      workspace.classList.remove("resizing");
    });
  }
  function reset() {
    workspace.style.removeProperty(variable);
    separator.setAttribute("aria-valuenow", String(pane.offsetWidth));
  }
  separator.addEventListener("focus", () => separator.setAttribute("aria-valuenow", String(pane.offsetWidth)));
  separator.addEventListener("dblclick", reset);
  separator.addEventListener("keydown", event => {
    if (event.key === "Home") reset();
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const sign = event.key === "ArrowLeft" ? -1 : 1;
      setWidth(pane.offsetWidth + sign * direction * (event.shiftKey ? 40 : 12));
    } else return;
    event.preventDefault();
  });
}

export function setupDrawing(dialog, onSave, onReload) {
  const get = key => dialog.querySelector("#draw-" + key);
  const canvas = get("surface");
  const context = canvas.getContext("2d");
  const size = get("size");
  const syncSize = () => { get("size-value").value = size.value; };
  size.addEventListener("input", syncSize);
  const paper = "#f4f3ef";
  let drawing = null;
  let base = null;
  let undo = [], redo = [];
  let beforeStroke = null, original = null, strokeRect = null;
  let strokes = [];
  let pointCount = 0;
  let activePointer = null;
  let holdTimer = 0;
  let holdPoint = null;
  let strokeStart = null;
  let strokeTool = "Pen";
  let snappable = false;
  let snapped = false;
  const drawingHint = "Draw a shape in one stroke and hold at the end.";
  let busy = false;
  const snapshot = () => ({base, strokes, pointCount});
  const changed = () => Boolean(original && (base !== original.base || strokes !== original.strokes));
  const restore = state => { ({base, strokes, pointCount} = state); };
  function record(previous) {
    undo.push(previous);
    if (undo.length > 100) undo.shift();
    redo = [];
  }

  function controls() {
    const hasContent = Boolean(base || strokes.length);
    get("undo").disabled = busy || activePointer !== null || !undo.length;
    get("redo").disabled = busy || activePointer !== null || !redo.length;
    get("clear").disabled = busy || activePointer !== null || !hasContent;
    get("save").disabled = busy || activePointer !== null || !changed();
    get("cancel").disabled = busy;
    get("reload").disabled = busy;
    for (const control of ["shape", "eraser", "snap", "color", "size"]) get(control).disabled = busy;
  }

  function paintStroke(stroke) {
    context.strokeStyle = context.fillStyle = stroke.color;
    context.lineWidth = stroke.size;
    context.lineCap = context.lineJoin = "round";
    const [first, ...remaining] = stroke.points;
    context.beginPath();
    if (!remaining.length) {
      context.arc(...first, stroke.size / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(...first);
      for (const point of remaining) context.lineTo(...point);
      context.stroke();
    }
  }

  function paint(stroke, from, to) {
    context.strokeStyle = context.fillStyle = stroke.color;
    context.lineWidth = stroke.size;
    context.lineCap = "round";
    context.beginPath();
    if (from === to) {
      context.arc(from[0], from[1], stroke.size / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(...from);
      context.lineTo(...to);
      context.stroke();
    }
  }

  function redraw() {
    context.fillStyle = paper;
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (base) {
      const scale = Math.min(canvas.width / base.naturalWidth, canvas.height / base.naturalHeight);
      const width = base.naturalWidth * scale, height = base.naturalHeight * scale;
      context.drawImage(base, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    }
    for (const stroke of strokes) paintStroke(stroke);
    controls();
  }

  function position(event) {
    const rect = strokeRect || canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width));
    const y = Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height));
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  }

  function notice(message = "") {
    get("error").textContent = message;
    get("error").hidden = !message;
    get("reload").hidden = true;
  }

  function stopStroke() {
    clearTimeout(holdTimer);
    activePointer = null;
    holdPoint = strokeStart = strokeRect = beforeStroke = null;
    snappable = snapped = false;
    controls();
  }

  function replaceStroke(stroke, points) {
    if (pointCount - stroke.points.length + points.length > 30_000) return false;
    pointCount += points.length - stroke.points.length;
    stroke.points = points.map(point => point.map((value, axis) =>
      Math.round(10 * Math.max(0, Math.min(axis === 0 ? canvas.width : canvas.height, value))) / 10));
    redraw();
    return true;
  }

  function hold(point) {
    clearTimeout(holdTimer);
    if (!snappable || snapped) return;
    holdPoint = point;
    holdTimer = setTimeout(() => {
      if (!dialog.open || activePointer === null || busy) return;
      const stroke = strokes.at(-1);
      const shape = stroke && recognizeShape(stroke.points);
      if (!shape || !replaceStroke(stroke, shape.points)) return;
      snapped = true;
      get("hint").textContent = `${shape.kind} snapped.`;
    }, 610);
  }

  canvas.addEventListener("pointerdown", event => {
    if (busy || activePointer !== null || event.button !== 0) return;
    if (pointCount >= 30_000 || strokes.length >= 4000) {
      notice("The drawing has reached its stroke or point limit.");
      return;
    }
    strokeRect = canvas.getBoundingClientRect();
    if (!strokeRect.width || !strokeRect.height) return;
    event.preventDefault();
    notice();
    activePointer = event.pointerId;
    try { canvas.setPointerCapture?.(activePointer); }
    catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }
    beforeStroke = snapshot();
    const point = position(event);
    strokeStart = point;
    const erase = get("eraser").getAttribute("aria-pressed") === "true";
    strokeTool = erase ? "Pen" : get("shape").value;
    snappable = !erase && strokeTool === "Pen" && get("snap").checked;
    const stroke = {color: erase ? paper : get("color").value, size: Number(size.value), points: [point]};
    get("hint").textContent = strokeTool === "Pen" ? drawingHint : "Drag from the starting point to size the shape.";
    strokes = [...strokes, stroke];
    pointCount++;
    if (strokeTool === "Pen") paint(stroke, point, point);
    else replaceStroke(stroke, [point, point]);
    if (snappable) hold(point);
    controls();
  });
  function shapeEndpoint(point, allowDefault = false) {
    const pixels = Math.hypot(point[0] - strokeStart[0], point[1] - strokeStart[1]);
    if (pixels >= 3 || !allowDefault) return point;
    const width = 68 * canvas.width / strokeRect.width;
    const height = 50 * canvas.height / strokeRect.height;
    return [strokeStart[0] + (strokeStart[0] + width <= canvas.width ? width : -width),
      strokeStart[1] + (strokeStart[1] + height <= canvas.height ? height : -height)];
  }
  function movePointer(event, committing = false) {
    if (event.pointerId !== activePointer || snapped) return;
    const stroke = strokes.at(-1);
    const point = position(event);
    if (strokeTool !== "Pen") {
      const target = shapeEndpoint(point, committing);
      if (Math.hypot(target[0] - strokeStart[0], target[1] - strokeStart[1]) >= 2) {
        replaceStroke(stroke, anchoredShapeStroke(strokeTool, strokeStart, target));
      }
      return;
    }
    if (pointCount >= 30_000) return;
    const last = stroke.points.at(-1);
    if (point[0] === last[0] && point[1] === last[1]) return;
    paint(stroke, last, point);
    stroke.points.push(point);
    pointCount++;
    if (snappable && Math.hypot(point[0] - holdPoint[0], point[1] - holdPoint[1]) > 6) hold(point);
  }
  canvas.addEventListener("pointermove", movePointer);
  function finishStroke(event) {
    if (activePointer !== event.pointerId) return;
    movePointer(event, true);
    record(beforeStroke);
    stopStroke();
  }
  canvas.addEventListener("pointerup", finishStroke);
  canvas.ownerDocument?.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("lostpointercapture", event => {
    if (activePointer !== event.pointerId) return;
    record(beforeStroke);
    stopStroke();
  });
  canvas.addEventListener("pointercancel", event => {
    if (activePointer !== event.pointerId) return;
    restore(beforeStroke);
    stopStroke();
    redraw();
  });

  get("eraser").addEventListener("click", () => {
    const enabled = get("eraser").getAttribute("aria-pressed") === "true";
    get("eraser").setAttribute("aria-pressed", String(!enabled));
  });
  get("shape").addEventListener("change", () => {
    get("eraser").setAttribute("aria-pressed", "false");
    get("hint").textContent = get("shape").value === "Pen" ? drawingHint : "Drag to size and place the shape.";
  });
  function navigateHistory(back) {
    if (busy || activePointer !== null) return;
    const entries = back ? undo : redo;
    if (!entries.length) return;
    (back ? redo : undo).push(snapshot());
    restore(entries.pop());
    notice();
    redraw();
  }
  get("undo").addEventListener("click", () => navigateHistory(true));
  get("redo").addEventListener("click", () => navigateHistory(false));
  dialog.addEventListener("keydown", event => {
    if (!(event.metaKey || event.ctrlKey) || !["z", "y"].includes(event.key.toLowerCase())) return;
    event.preventDefault();
    navigateHistory(event.key.toLowerCase() === "z" && !event.shiftKey);
  });
  get("clear").addEventListener("click", () => {
    if (busy || activePointer !== null || (!base && !strokes.length)) return;
    record(snapshot());
    base = null;
    strokes = [];
    pointCount = 0;
    notice();
    redraw();
  });
  get("cancel").addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    stopStroke();
    drawing = base = original = null;
    undo = [];
    redo = [];
    strokes = [];
    pointCount = 0;

    notice();
    redraw();
  });
  dialog.querySelector("form").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || activePointer !== null || !changed() || !drawing) return;
    busy = true;
    stopStroke();
    try {
      const image = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (!image) throw new Error("Could not render the drawing as a PNG.");
      await onSave(drawing, {image, strokes, keepBase: Boolean(base)});
      dialog.close();
    } catch (error) {
      notice(error.message);
      get("reload").hidden = !(error.status === 409 && drawing?.file && onReload);
    } finally {
      busy = false;
      controls();
    }
  });

  async function loadDraft(draft) {
    let image = null;
    if (draft.base) {
      image = new Image();
      image.src = "data:image/png;base64," + draft.base;
      await image.decode();
    }
    base = image;
    undo = [];
    redo = [];
    drawing = draft;
    strokes = structuredClone(draft.strokes || []);
    pointCount = strokes.reduce((total, stroke) => total + stroke.points.length, 0);
    original = snapshot();

    get("eraser").setAttribute("aria-pressed", "false");
    get("shape").value = "Pen";
    syncSize();
    get("hint").textContent = drawingHint;
    get("heading").textContent = draft.file ? "Edit drawing" : "New drawing";
    get("save").textContent = draft.file ? "Save" : "Add to note";
    notice();
    redraw();
  }

  get("reload").addEventListener("click", async () => {
    if (busy || !drawing?.file || !onReload) return;
    if (!window.confirm("Discard this drawing draft and reload the saved version?")) return;
    busy = true;
    controls();
    try {
      await loadDraft(await onReload(drawing));
    } catch (error) {
      notice(error.message);
      get("reload").hidden = false;
    } finally {
      busy = false;
      controls();
    }
  });

  return async draft => {
    if (dialog.open || busy) return;
    busy = true;
    try {
      await loadDraft(draft);
      dialog.showModal();
    } finally {
      busy = false;
      controls();
    }
  };
}
