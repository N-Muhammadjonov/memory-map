const ID = /^[a-f0-9]{32}$/;
export const MAX_TOPICS = 500;
export const MAX_LINKS = 500;
export const MAX_DEPTH = 40;
export const MAX_TOPIC_TITLE = 500;
export const TOPIC_HEIGHT = 52;
export const POSITION_LIMIT = 12_000;
export const TOPIC_SHAPES = ["rectangle", "circle", "pill"];
export const TOPIC_COLORS = ["lavender", "blue", "teal", "orange", "pink", "cyan", "green", "purple"];

export function topicTitle(value) {
  return Array.from(value.replace(/[\u0000-\u001f]+/g, " ").trim()).slice(0, MAX_TOPIC_TITLE).join("").trimEnd();
}

export function branches(map) {
  const children = new Map(map.topics.map(topic => [topic.id, []]));
  const entries = new Map(map.topics.map(topic => [topic.id, topic]));
  for (const topic of map.topics) {
    if (topic.parent !== null) children.get(topic.parent).push(topic);
  }
  return {entries, children, root: entries.get(map.root)};
}

export function readMindMap(source) {
  const map = JSON.parse(source);
  if (!map || map.version !== 1 || !Array.isArray(map.topics) || !Array.isArray(map.links) ||
      !map.topics.length || map.topics.length > MAX_TOPICS || map.links.length > MAX_LINKS ||
      typeof map.root !== "string" || !ID.test(map.root)) throw new Error("Invalid mind map format.");
  const ids = new Set();
  for (const topic of map.topics) {
    if (!topic || typeof topic.id !== "string" || !ID.test(topic.id) || ids.has(topic.id) ||
        (topic.id === map.root ? topic.parent !== null : typeof topic.parent !== "string" || !ID.test(topic.parent)) ||
        typeof topic.title !== "string" || !topic.title.trim() || Array.from(topic.title.trim()).length > MAX_TOPIC_TITLE ||
        /[\u0000-\u001f]/.test(topic.title) ||
        (topic.note !== undefined && (typeof topic.note !== "string" || topic.note.length > 3600)) ||
        (topic.ref != null && (typeof topic.ref !== "string" || !ID.test(topic.ref))) ||
        (topic.collapsed !== undefined && typeof topic.collapsed !== "boolean") ||
        (topic.shape !== undefined && !TOPIC_SHAPES.includes(topic.shape)) ||
        (topic.color !== undefined && !TOPIC_COLORS.includes(topic.color)) ||
        (topic.side !== undefined && (topic.parent !== map.root || !["left", "right"].includes(topic.side))) ||
        (topic.offset != null && (!Array.isArray(topic.offset) || topic.offset.length !== 2 ||
          topic.offset.some(coord => !Number.isFinite(coord) || Math.abs(coord) > POSITION_LIMIT)))) {
      throw new Error("Invalid mind map topic.");
    }
    ids.add(topic.id);
  }
  if (!ids.has(map.root) || map.topics.some(topic => topic.parent !== null && !ids.has(topic.parent))) {
    throw new Error("The mind map contains a disconnected branch.");
  }
  const {children} = branches(map);
  const queue = [[map.root, 0]];
  for (let index = 0; index < queue.length; index++) {
    const [id, depth] = queue[index];
    if (depth > MAX_DEPTH) throw new Error("Branches exceed 40 levels.");
    for (const child of children.get(id)) queue.push([child.id, depth + 1]);
  }
  if (queue.length !== ids.size) throw new Error("Every branch must connect to the main topic.");
  const unique = new Set();
  for (const link of map.links) {
    if (!link || !ids.has(link.a) || !ids.has(link.b) || link.a === link.b) throw new Error("Invalid branch connection.");
    const key = [link.a, link.b].sort().join(":");
    if (unique.has(key)) throw new Error("Duplicate branch connection.");
    unique.add(key);
  }
  return map;
}

export function descendants(children, id) {
  const result = [id];
  for (let index = 0; index < result.length; index++) {
    for (const topic of children.get(result[index])) result.push(topic.id);
  }
  return new Set(result);
}

export function canReparent(map, id, parent) {
  if (id === map.root || id === parent) return false;
  const {entries, children} = branches(map);
  if (!entries.has(id) || !entries.has(parent) || entries.get(id).parent === parent) return false;
  const subtree = descendants(children, id);
  if (subtree.has(parent)) return false;
  let parentDepth = 0;
  for (let topic = entries.get(parent); topic.parent !== null; topic = entries.get(topic.parent)) parentDepth++;
  const queue = [[id, 0]];
  for (let i = 0; i < queue.length; i++) {
    const [topic, depth] = queue[i];
    if (depth + parentDepth + 1 > MAX_DEPTH) return false;
    for (const child of children.get(topic)) queue.push([child.id, depth + 1]);
  }
  return true;
}

export function mindLayout(map, measure = (_, width, height) => ({width, height})) {
  const {children, root} = branches(map);
  const visibleChildren = topic => topic.collapsed && topic.id !== root.id ? [] : children.get(topic.id);
  const sizes = new Map(), spans = new Map(), leafCounts = new Map();
  const size = topic => topic.shape === "circle" ? measure(topic, 96, 96) :
    measure(topic, topic.id === root.id ? 208 : 172, TOPIC_HEIGHT);
  const span = topic => {
    const dimensions = size(topic);
    sizes.set(topic.id, dimensions);
    const items = visibleChildren(topic);
    const height = Math.max(dimensions.height + 16, items.reduce((sum, child) => sum + span(child), 0));
    spans.set(topic.id, height);
    leafCounts.set(topic.id, items.reduce((sum, child) => sum + leafCounts.get(child.id), 0) || 1);
    return height;
  };
  span(root);
  const columns = [[], []];
  const counts = [0, 0];
  for (const [index, topic] of visibleChildren(root).entries()) {
    const side = topic.side === "left" ? 1 : topic.side === "right" ? 0 : counts[0] <= counts[1] ? 0 : 1;
    columns[side].push({topic, color: index % 7});
    counts[side] += leafCounts.get(topic.id);
  }

  const positioned = [{topic: root, x: 0, y: 0, ...sizes.get(root.id), side: 0, color: -1}];
  function place(topic, depth, start, side, color, widths) {
    const height = spans.get(topic.id);
    const node = {topic, depth, x: 0, y: start + height / 2, ...sizes.get(topic.id), side, color};
    positioned.push(node);
    widths[depth] = Math.max(widths[depth] || 0, node.width);
    start += (height - visibleChildren(topic).reduce((sum, child) => sum + spans.get(child.id), 0)) / 2;
    for (const child of visibleChildren(topic)) {
      place(child, depth + 1, start, side, color, widths);
      start += spans.get(child.id);
    }
  }
  for (const [column, items] of columns.entries()) {
    const side = column ? -1 : 1;
    const widths = [sizes.get(root.id).width];
    const first = positioned.length;
    let start = -items.reduce((sum, {topic}) => sum + spans.get(topic.id), 0) / 2;
    for (const {topic, color} of items) {
      place(topic, 1, start, side, color, widths);
      start += spans.get(topic.id);
    }
    const centers = [0];
    for (let depth = 1; depth < widths.length; depth++) {
      centers[depth] = centers[depth - 1] + (widths[depth - 1] + widths[depth]) / 2 + 52;
    }
    for (const node of positioned.slice(first)) {
      node.x = centers[node.depth] * side;
    }
  }
  for (const node of positioned) {
    const [dx, dy] = node.topic.offset || [0, 0];
    node.x += dx;
    node.y += dy;
  }
  // An unmoved origin keeps a single dragged topic from snapping back to screen center.
  const maxX = Math.max(...positioned.map(node => Math.abs(node.x) + node.width / 2));
  const maxY = Math.max(...positioned.map(node => Math.abs(node.y) + node.height / 2));
  const minX = -maxX, minY = -maxY;
  const padding = 44;
  return {
    originX: padding - minX,
    originY: padding - minY,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
    nodes: positioned.map(node => ({...node, x: node.x - minX + padding, y: node.y - minY + padding})),
  };
}

function plainMarkdown(value) {
  return value.replaceAll("\\", "\\\\").replace(/([\[\]<>*_#`])/g, "\\$1");
}

export function markdownOutline(map) {
  const {children, entries, root} = branches(map);
  const lines = ["# " + plainMarkdown(root.title), ""];
  if (root.note) lines.push(...root.note.split(/\r?\n/).map(line => "> " + plainMarkdown(line)), "");
  function render(topic, depth) {
    const pad = "  ".repeat(depth);
    const ref = topic.ref ? ` [Note](xotira:${topic.ref})` : "";
    lines.push(pad + "- " + plainMarkdown(topic.title) + ref);
    if (topic.note) {
      for (const line of topic.note.split(/\r?\n/)) lines.push(pad + "  " + plainMarkdown(line));
    }
    for (const child of children.get(topic.id)) render(child, depth + 1);
  }
  for (const topic of children.get(map.root)) render(topic, 0);
  if (map.links.length) {
    lines.push("", "## Connections between branches", "");
    for (const {a, b} of map.links) {
      lines.push("- " + plainMarkdown(entries.get(a).title) + " ↔ " + plainMarkdown(entries.get(b).title));
    }
  }
  return lines.join("\n") + "\n";
}
