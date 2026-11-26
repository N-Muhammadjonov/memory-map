import {copyCode, COPY_ICON, detectLanguage, languageName} from "./code-tools.js";
import katex from "./vendor/katex.mjs";

const LANGUAGE = new Map(Object.entries({
  sh: "Shell", shell: "Shell", bash: "Shell", zsh: "Shell", js: "JavaScript",
  javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript",
  py: "Python", python: "Python", json: "JSON", yaml: "YAML", yml: "YAML", sql: "SQL",
}));
const KEYWORDS = /^(?:async|await|break|case|class|const|def|else|elif|export|false|for|from|function|if|import|in|let|None|null|return|throw|true|try|var|while|with|yield)$/i;
const SQL = /^(?:select|from|where|join|inner|left|limit|create|table|insert|update|delete|into|values|as|and|or|group|order|by|having|set|on)$/i;
const SHELL = /^(?:cd|echo|find|grep|ls|lsof|mkdir|python3?|pwd|ssh|sudo|tail|touch|uname|cat|curl|printf|whoami|ip|ss)$/;
const CODE_TOKEN = /#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/|--[ \t][^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|--?[a-zA-Z][\w-]*|\b\d+(?:\.\d+)?\b|[A-Za-z_][\w.]*/g;
const NODE = /^([\p{L}\p{N}_][\p{L}\p{N}_-]*?)(?=\s|\[|\(|\{|--|==|-\.|$)(?:\s*(?:\[\[([\s\S]*?)\]\]|\["([^"]*)"\]|\[([^\]]*)\]|\(\[([^\]]*)\]\)|\(\(([^)]*)\)\)|\("([^"]*)"\)|\(([^)]*)\)|\{"([^"]*)"\}|\{([^}]*)\}))?/u;
const ARROW = /^(-->|---|-.->|==>)(?:\s*\|([^|]*)\|)?\s*/;
const FLOW_LIMIT = 42;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function highlight(code, text, language) {
  if (!LANGUAGE.has(language) || text.length > 40_000) {
    code.textContent = text;
    return;
  }
  const shell = LANGUAGE.get(language) === "Shell";
  let offset = 0;
  for (const match of text.matchAll(CODE_TOKEN)) {
    const token = match[0];
    let type = "";
    if (token.startsWith("#") || token.startsWith("//") || token.startsWith("/*") || token.startsWith("-- ")) type = "comment";
    else if (/^["'`]/.test(token)) type = "string";
    else if (/^\d/.test(token)) type = "number";
    else if (KEYWORDS.test(token) || language === "sql" && SQL.test(token) || shell && (SHELL.test(token) || token.startsWith("-"))) {
      type = "keyword";
    }
    if (!type) continue;
    code.append(document.createTextNode(text.slice(offset, match.index)), element("span", token, "code-" + type));
    offset = match.index + token.length;
  }
  code.append(document.createTextNode(text.slice(offset)));
}

export function renderCode(text, language) {
  const block = element("div", undefined, "code-block");
  const tools = element("div", undefined, "code-tools");
  language = detectLanguage(text, language);
  tools.append(element("span", languageName(language)));
  const copy = element("button", undefined, "n-code-icon");
  const feedback = element("span", "", "sr-only");
  feedback.setAttribute("aria-live", "polite");
  copy.type = "button";
  copy.title = "Copy code";
  copy.setAttribute("aria-label", "Copy code");
  copy.innerHTML = COPY_ICON;
  copy.addEventListener("click", () => void copyCode(text, copy, feedback));
  tools.append(copy, feedback);
  const pre = element("pre");
  const code = element("code");
  highlight(code, text, language);
  pre.append(code);
  block.append(tools, pre);
  return block;
}

export function renderMath(text, display) {
  const node = element(display ? "div" : "span", undefined, display ? "math-display" : "math-inline");
  if (text.length <= 4000) {
    try {
      katex.render(text, node, {displayMode: display, output: "mathml", trust: false, maxExpand: 250, maxSize: 14});
      return node;
    } catch {
      node.classList.add("math-invalid");
      node.title = "Check the formula syntax.";
    }
  }
  node.textContent = display ? "$$ " + text + " $$" : "$" + text + "$";
  return node;
}

function parseFlow(source) {
  if (source.length > 12_000) return null;
  const statements = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("%%"));
  const first = statements.shift()?.match(/^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)\s*;?$/i);
  if (!first) return null;
  const nodes = new Map();
  const edges = [];
  function readNode(line) {
    const match = line.match(NODE);
    if (!match) return null;
    const id = match[1];
    const label = match.slice(2).find(value => value !== undefined);
    const cleaned = label?.replace(/^"|"$/g, "").replace(/<br\s*\/?\s*>/gi, "\n").replace(/\\n/g, "\n");
    if (!nodes.has(id) || cleaned) nodes.set(id, cleaned || id);
    return {id, rest: line.slice(match[0].length).trimStart()};
  }
  for (const statement of statements) {
    if (/^(?:classDef|class|linkStyle|style)\s/.test(statement)) continue;
    let current = readNode(statement.replace(/\s*;$/, ""));
    if (!current) return null;
    while (current.rest) {
      const arrow = current.rest.match(ARROW);
      if (!arrow) return null;
      const next = readNode(current.rest.slice(arrow[0].length));
      if (!next) return null;
      edges.push({from: current.id, to: next.id, arrow: arrow[1] !== "---", dashed: arrow[1] === "-.->", label: arrow[2]});
      current = next;
    }
    if (nodes.size > FLOW_LIMIT || edges.length > 90) return null;
  }
  return nodes.size ? {direction: first[1].toUpperCase(), nodes, edges} : null;
}

function placeFlow({direction, nodes, edges}) {
  const incoming = new Map([...nodes.keys()].map(id => [id, 0]));
  const outgoing = new Map([...nodes.keys()].map(id => [id, []]));
  for (const {from, to} of edges) {
    if (from === to) continue;
    incoming.set(to, incoming.get(to) + 1);
    outgoing.get(from).push(to);
  }
  const queue = [...nodes.keys()].filter(id => incoming.get(id) === 0);
  const ranks = new Map(queue.map(id => [id, 0]));
  for (const id of queue) {
    for (const next of outgoing.get(id)) {
      ranks.set(next, Math.max(ranks.get(next) || 0, ranks.get(id) + 1));
      incoming.set(next, incoming.get(next) - 1);
      if (!incoming.get(next)) queue.push(next);
    }
  }
  const layers = [];
  for (const [id, label] of nodes) {
    const rank = ranks.get(id) || 0;
    (layers[rank] ??= []).push({id, label});
  }
  const horizontal = direction === "LR" || direction === "RL";
  if (direction === "BT" || direction === "RL") layers.reverse();
  const maxParallel = Math.max(...layers.map(layer => layer.length));
  const boxWidth = 208, boxHeight = 84, margin = 19;
  const stepX = boxWidth + (horizontal ? 76 : 28);
  const stepY = boxHeight + (horizontal ? 24 : 52);
  const width = margin * 2 + stepX * ((horizontal ? layers.length : maxParallel) - 1) + boxWidth;
  const height = margin * 2 + stepY * ((horizontal ? maxParallel : layers.length) - 1) + boxHeight;
  if (width > 3600 || height > 3600) return null;
  const positions = new Map();
  layers.forEach((layer, level) => layer.forEach(({id, label}, index) => {
    const centered = index + (maxParallel - layer.length) / 2;
    positions.set(id, {label, x: margin + (horizontal ? level : centered) * stepX,
      y: margin + (horizontal ? centered : level) * stepY});
  }));
  return {width, height, boxWidth, boxHeight, positions, horizontal};
}

function renderEdge(ctx, edge, from, to, layout) {
  const {horizontal, boxWidth, boxHeight} = layout;
  const sameAxis = horizontal ? from.x === to.x : from.y === to.y;
  const across = sameAxis ? !horizontal : horizontal;
  const sign = across ? Math.sign(to.x - from.x) || 1 : Math.sign(to.y - from.y) || 1;
  const x0 = from.x + (across ? sign > 0 ? boxWidth : 0 : boxWidth / 2);
  const y0 = from.y + (across ? boxHeight / 2 : sign > 0 ? boxHeight : 0);
  const x1 = to.x + (across ? sign > 0 ? 0 : boxWidth : boxWidth / 2);
  const y1 = to.y + (across ? boxHeight / 2 : sign > 0 ? 0 : boxHeight);
  const middleX = (x0 + x1) / 2, middleY = (y0 + y1) / 2;
  ctx.setLineDash(edge.dashed ? [5, 3] : []);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  if (from === to) {
    ctx.bezierCurveTo(x0 + 22, y0 + 13, x0 + 25, y0 - 28, x0, y0 - 18);
  } else {
    ctx.bezierCurveTo(across ? middleX : x0, across ? y0 : middleY,
      across ? middleX : x1, across ? y1 : middleY, x1, y1);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  if (edge.arrow && from !== to) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 + (across ? -8 * sign : -4), y1 + (across ? -4 : -8 * sign));
    ctx.lineTo(x1 + (across ? -8 * sign : 4), y1 + (across ? 4 : -8 * sign));
    ctx.fill();
  }
  if (edge.label) {
    ctx.textAlign = "center";
    ctx.fillText(edge.label, middleX, middleY - 6, 145);
  }
}

function renderSequenceDiagram(source) {
  const lines = source.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("%%"));
  if (!/^sequenceDiagram\b/i.test(lines[0] || "")) return null;
  const participants = [];
  const messages = [];
  const addP = name => { if (name && !participants.includes(name)) participants.push(name); };
  for (const line of lines.slice(1)) {
    const pm = line.match(/^participant\s+([^\s]+)(?:\s+as\s+(.+))?$/i);
    if (pm) { addP(pm[1]); continue; }
    const mm = line.match(/^([^\s:-]+)\s*(-->>|->>|-->|->)\s*([^\s:]+)\s*:\s*(.*)$/);
    if (mm) {
      addP(mm[1]); addP(mm[3]);
      messages.push({from: mm[1], arrow: mm[2], to: mm[3], text: mm[4].trim()});
    }
  }
  if (!participants.length || !messages.length) return null;
  const colW = 156, pad = 28, rowH = 44, topY = 58;
  const width = Math.max(360, pad * 2 + (participants.length - 1) * colW + 110);
  const height = topY + messages.length * rowH + 40;
  const frame = element("figure", undefined, "diagram-frame");
  const viewport = element("div", undefined, "diagram-scroll");
  const canvas = element("canvas");
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.font = "12px system-ui";
  const xs = new Map(participants.map((p, idx) => [p, pad + 55 + idx * colW]));
  for (const [name, x] of xs) {
    ctx.strokeStyle = "#4b5563";
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, topY); ctx.lineTo(x, height - 16); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#1e222b"; ctx.strokeStyle = "#8dafbb";
    ctx.fillRect(x - 52, 12, 104, 30); ctx.strokeRect(x - 52, 12, 104, 30);
    ctx.fillStyle = "#e6e8ee"; ctx.textAlign = "center";
    ctx.fillText(name.slice(0, 14), x, 31);
  }
  messages.forEach((msg, idx) => {
    const y = topY + 24 + idx * rowH;
    const x1 = xs.get(msg.from), x2 = xs.get(msg.to);
    const dir = x2 >= x1 ? 1 : -1;
    ctx.strokeStyle = "#a78bfa"; ctx.fillStyle = "#a78bfa";
    ctx.setLineDash(msg.arrow.startsWith("--") ? [5, 3] : []);
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x2, y); ctx.lineTo(x2 - 8 * dir, y - 4); ctx.lineTo(x2 - 8 * dir, y + 4);
    ctx.fill();
    ctx.fillStyle = "#cbd5e1"; ctx.textAlign = "center";
    ctx.fillText(msg.text.slice(0, 34), (x1 + x2) / 2, y - 7);
  });
  viewport.append(canvas);
  const details = element("details", undefined, "diagram-source");
  details.append(element("summary", "Mermaid source"), renderCode(source, "mermaid"));
  frame.append(viewport, details);
  return frame;
}

export function renderFlowchart(source) {
  const seq = renderSequenceDiagram(source);
  if (seq) return seq;
  const graph = parseFlow(source);
  const layout = graph && placeFlow(graph);
  if (!layout) return null;
  const {width, height, boxWidth, boxHeight, positions} = layout;
  const frame = element("figure", undefined, "diagram-frame");
  const viewport = element("div", undefined, "diagram-scroll");
  const surface = element("div", undefined, "diagram-surface");
  surface.style.width = width + "px";
  surface.style.height = height + "px";
  const canvas = element("canvas");
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.fillStyle = ctx.strokeStyle = "#8dafbb";
  ctx.font = "12px system-ui";
  for (const edge of graph.edges) renderEdge(ctx, edge, positions.get(edge.from), positions.get(edge.to), layout);
  surface.append(canvas);
  for (const {label, x, y} of positions.values()) {
    const node = element("span", label, "diagram-node");
    node.style.left = x + "px";
    node.style.top = y + "px";
    node.style.width = boxWidth + "px";
    node.style.height = boxHeight + "px";
    surface.append(node);
  }
  viewport.append(surface);
  const details = element("details", undefined, "diagram-source");
  details.append(element("summary", "Mermaid source"), renderCode(source, "mermaid"));
  frame.append(viewport, details);
  return frame;
}
