const TAU = Math.PI * 2;
const CAMERA_DEPTH = 20;
const ORBIT_SPEED = 0.0062;
const MIN_RELATIVE_ZOOM = 0.08;
const MAX_RELATIVE_ZOOM = 14;

const CLUSTER_PALETTE = [
  {hub: "#a793ff", sat: "#759bf2"},
  {hub: "#5ad4a8", sat: "#67cbb3"},
  {hub: "#f0b567", sat: "#d9a570"},
  {hub: "#e984af", sat: "#c88ba8"},
  {hub: "#63c8f5", sat: "#65b6d8"},
  {hub: "#e28b68", sat: "#c29183"},
  {hub: "#a9bffd", sat: "#9caac5"},
  {hub: "#a0cc77", sat: "#91bb80"},
];

// Keep cluster identities stable while selecting legible colors at draw time.
const PAPER_COLORS = [
  ["#5935a3", "#365aa2"],
  ["#17664b", "#206b62"],
  ["#85500d", "#80571f"],
  ["#9b315f", "#93436b"],
  ["#155e85", "#236c7e"],
  ["#9d4023", "#905444"],
  ["#3d58a3", "#536783"],
  ["#4c7029", "#426c36"],
];
const PAPER_NODE_COLORS = new Map(CLUSTER_PALETTE.flatMap((color, index) => [
  [color.hub, PAPER_COLORS[index][0]], [color.sat, PAPER_COLORS[index][1]],
]));

function clusterColors(groupKeys) {
  const colors = new Map();
  const used = new Set();
  for (const group of groupKeys) {
    if (group === "unsorted") continue;
    if (used.size === CLUSTER_PALETTE.length) used.clear();
    let index = seed(group) % CLUSTER_PALETTE.length;
    while (used.has(index)) index = (index + 1) % CLUSTER_PALETTE.length;
    used.add(index);
    colors.set(group, CLUSTER_PALETTE[index]);
  }
  return colors;
}

function getThemeColors() {
  const theme = document.documentElement.dataset.theme || "dark";
  if (theme === "light") {
    return {
      bg: "#f5f3ee",
      edgeIntra: "rgba(30, 41, 59, 0.28)",
      edgeCross: "rgba(30, 41, 59, 0.19)",
      pointColors: PAPER_NODE_COLORS,
      pathColor: "#85500d",
      nodeOpacity: 0.9,
      clusterEdgeOpacity: 0.32,
      labelPrimary: "#111827",
      labelSecondary: "#475569",
      focusRing: "#111827",
      fileColor: "#526075",
    };
  }
  if (theme === "slate") {
    return {
      bg: "#0e1520",
      edgeIntra: "rgba(148, 179, 214, 0.22)",
      edgeCross: "rgba(148, 179, 214, 0.14)",
      labelPrimary: "#f1f5f9",
      labelSecondary: "#94a3b8",
      focusRing: "#ffffff",
      fileColor: "#9cafc9",
    };
  }
  return {
    bg: "#090b10",
    edgeIntra: "rgba(148, 163, 184, 0.20)",
    edgeCross: "rgba(148, 163, 184, 0.13)",
    labelPrimary: "#f4f4f5",
    labelSecondary: "#9ca3af",
    focusRing: "#ffffff",
    fileColor: "#98a4b8",
  };
}

function orientation() {
  return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function seed(value) {
  let hash = 2166136261;
  for (const ch of value) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619);
  return hash >>> 0;
}

function shorten(text, limit = 24) {
  const chars = Array.from(text || "");
  return chars.length > limit ? chars.slice(0, limit).join("") + "…" : (text || "");
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function placeClusters(groups, members, assignments, edges) {
  const radii = new Map(groups.map(key => [key, 0.52 + Math.sqrt(members.get(key).length) * 0.29]));
  const connections = new Map(groups.map(key => [key, new Map()]));
  for (const [a, b] of edges) {
    const first = assignments.get(a);
    const second = assignments.get(b);
    if (!first || !second || first === second || first === "index" || second === "index" ||
        first === "unsorted" || second === "unsorted") continue;
    const firstLinks = connections.get(first);
    const secondLinks = connections.get(second);
    firstLinks.set(second, (firstLinks.get(second) || 0) + 1);
    secondLinks.set(first, (secondLinks.get(first) || 0) + 1);
  }
  const placed = new Map();
  const occupancy = new Map();
  const cellSize = Math.max(4, ...radii.values()) * 2 + 2.4;
  const cell = (x, y) => [Math.floor(x / cellSize), Math.floor(y / cellSize)];

  for (const group of groups) {
    const radius = radii.get(group);
    const nearby = [...connections.get(group)].filter(([key]) => placed.has(key))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2);
    const attractor = nearby[0] ? placed.get(nearby[0][0]) : [0, 0, 0];
    const [, , , attractorRadius = 0] = attractor;
    let best = null;
    let bestCost = Infinity;
    let ring = placed.size ? radius + attractorRadius + 1.7 : 0;
    // A cell is wider than the greatest possible minimum separation.
    while (!best || ring < radius + attractorRadius + 7) {
      const angles = ring ? 20 : 1;
      const start = seed(group) / 4294967296 * TAU;
      for (let i = 0; i < angles; i++) {
        const angle = start + i * TAU / angles;
        const x = attractor[0] + Math.cos(angle) * ring;
        const y = attractor[1] + Math.sin(angle) * ring;
        const [cx, cy] = cell(x, y);
        let blocked = false;
        for (let col = cx - 1; col <= cx + 1 && !blocked; col++) {
          for (let row = cy - 1; row <= cy + 1 && !blocked; row++) {
            blocked = (occupancy.get(`${col}:${row}`) || []).some(other =>
              Math.hypot(x - other[0], y - other[1]) < radius + other[3] + 1.5);
          }
        }
        if (blocked) continue;
        const secondary = nearby[1] ? placed.get(nearby[1][0]) : null;
        const cost = ring * 0.58 + Math.hypot(x, y) * (nearby.length ? 0.25 : 0.72) +
          (secondary ? 0.17 * Math.hypot(x - secondary[0], y - secondary[1]) : 0);
        if (cost >= bestCost) continue;
        bestCost = cost;
        best = [x, y, 0, radius];
      }
      if (!placed.size) break;
      ring += Math.max(0.75, radius * 0.30);
    }
    const key = cell(best[0], best[1]).join(":");
    if (!occupancy.has(key)) occupancy.set(key, []);
    occupancy.get(key).push(best);
    placed.set(group, best);
  }
  // Keep the front-view spacing. Spread clusters along an independent depth axis.
  const ranked = groups.slice().sort((a, b) => seed("depth:" + a) - seed("depth:" + b) || a.localeCompare(b));
  const values = [...placed.values()];
  const spreads = [0, 1].map(axis => {
    const mean = values.reduce((sum, point) => sum + point[axis], 0) / (values.length || 1);
    return Math.sqrt(values.reduce((sum, point) => sum + (point[axis] - mean) ** 2, 0) / (values.length || 1));
  });
  if (ranked.length < 2) return placed;
  let depths = ranked.map((_, index) => 2 * index / (ranked.length - 1) - 1);
  if (ranked.length >= 4) {
    // Orthogonalize the spread against the front view so a sideways orbit stays full.
    const centered = axis => {
      const values = ranked.map(group => placed.get(group)[axis]);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return values.map(value => value - mean);
    };
    const subtractProjection = (vector, axis) => {
      const dot = axis.reduce((sum, value, index) => sum + value * vector[index], 0);
      const length = axis.reduce((sum, value) => sum + value * value, 0);
      return length > 1e-8 ? vector.map((value, index) => value - axis[index] * dot / length) : vector;
    };
    const x = centered(0);
    const y = subtractProjection(centered(1), x);
    const independent = subtractProjection(subtractProjection(depths, x), y);
    if (Math.max(...independent.map(Math.abs)) > 0.1) depths = independent;
  }
  const rms = Math.sqrt(depths.reduce((sum, depth) => sum + depth * depth, 0) / depths.length);
  const extent = Math.max(1, (spreads[0] + spreads[1]) * 0.34);
  for (const [index, group] of ranked.entries()) {
    placed.get(group)[2] = Math.max(-2.5, Math.min(2.5, depths[index] / rms)) * extent;
  }
  return placed;
}

const NODE_BUDGET = 1100;
const EDGE_BUDGET = 6000;

function edgeKey(a, b) {
  return a < b ? a + ":" + b : b + ":" + a;
}

function graphSample(nodes, edges, required, pathEdges) {
  const priority = new Set(required);
  if (nodes.length > NODE_BUDGET) {
    const neighbors = new Set();
    for (const [a, b] of edges) {
      if (priority.has(a)) neighbors.add(b);
      if (priority.has(b)) neighbors.add(a);
    }
    const groupKeys = new Set();
    const selected = [];
    const representatives = [];
    const connected = [];
    const remainder = [];
    const ranks = Array.from({length: 16}, () => []);
    for (const node of nodes) {
      const rank = 8 * priority.has(node.id) + 4 * Boolean(node.topicAnchor) +
        2 * Boolean(node.pinned) + Number(node.kind !== "file");
      ranks[rank].push(node);
    }
    const stable = ranks.reverse().flatMap(items => items.sort((a, b) => a.id < b.id ? -1 : Number(a.id > b.id)));
    for (const node of stable) {
      const group = node.group || "unsorted";
      if (priority.has(node.id)) {
        selected.push(node);
      } else if (!groupKeys.has(group)) {
        representatives.push(node);
      } else if (neighbors.has(node.id) || node.pinned) {
        connected.push(node);
      } else {
        remainder.push(node);
      }
      groupKeys.add(group);
    }
    nodes = selected.concat(representatives, connected, remainder).slice(0, NODE_BUDGET);
  }
  const shown = new Set(nodes.map(node => node.id));
  const unique = new Map();
  for (const [a, b] of edges) {
    if (a !== b && shown.has(a) && shown.has(b)) unique.set(edgeKey(a, b), a < b ? [a, b] : [b, a]);
  }
  const filtered = [...unique.values()].sort(([a, b], [c, d]) => a.localeCompare(c) || b.localeCompare(d));
  if (filtered.length <= EDGE_BUDGET) return [nodes, filtered];
  const route = [];
  const relevant = [];
  const rest = [];
  for (const edge of filtered) {
    const [a, b] = edge;
    if (pathEdges?.has(edgeKey(a, b))) route.push(edge);
    else if (priority.has(a) || priority.has(b)) relevant.push(edge);
    else rest.push(edge);
  }
  return [nodes, route.concat(relevant, rest).slice(0, EDGE_BUDGET)];
}

export class NoteGraph {
  constructor(canvas, onOpen, onActivity, onMove, onZoom = () => {}) {
    this.canvas = canvas;
    this.onOpen = onOpen;
    this.onActivity = onActivity;
    this.onMove = onMove;
    this.onZoom = onZoom;
    this.context = canvas.getContext("2d", {alpha: false});

    this.points = [];
    this.links = [];
    this.neighbors = new Map();
    this.projected = [];
    this.labelHits = [];
    this.pathNodes = null;
    this.pathEdges = null;
    this.dataKey = "";

    this.pan = [0, 0];
    this.basis = orientation();
    this.orbit(-0.14, -0.10);
    this.showLabels = false;
    this.autoFit = true;
    this.scale = 1;
    this.fitScale = 1;
    this.viewportInsets = null;
    this.hover = null;
    this.selected = null;
    this.focusedNode = null;

    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.living = false;
    this.manualPlacement = false;
    this.mode = "3d";
    this.source = {nodes: [], edges: [], selection: null, groups: [], positions: {}};
    this.visibleCount = 0;
    this.alpha = 0.35;
    this.flyAnim = null;
    this.lastFrameTime = 0;

    this.frame = 0;
    this.pointers = new Map();
    this.gesture = null;
    this.width = 0;
    this.height = 0;
    this.ratio = Math.min(window.devicePixelRatio || 1, 2);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);

    canvas.addEventListener("pointerdown", e => this.pointerDown(e));
    canvas.addEventListener("pointermove", e => this.pointerMove(e));
    canvas.addEventListener("pointerup", e => this.pointerUp(e, true));
    canvas.addEventListener("pointercancel", e => this.pointerUp(e, false));
    canvas.addEventListener("lostpointercapture", e => this.pointerUp(e, false));
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    canvas.addEventListener("dblclick", e => {
      const hit = this.hit(e);
      if (!hit) this.fit();
    });
    canvas.addEventListener("pointerleave", () => this.pointAt(null));
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      this.flyAnim = null;
      const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
      const delta = Math.max(-400, Math.min(400, -e.deltaY * factor));
      this.zoom(Math.exp(delta * (e.ctrlKey ? 0.006 : 0.0017)), [e.clientX, e.clientY]);
    }, {passive: false});

    let pinchScale = 1;
    canvas.addEventListener("gesturestart", e => { e.preventDefault(); pinchScale = 1; });
    canvas.addEventListener("gesturechange", e => {
      e.preventDefault();
      if (e.scale > 0) this.zoom(e.scale / pinchScale, [e.clientX, e.clientY]);
      pinchScale = e.scale || 1;
    });
    canvas.addEventListener("gestureend", e => e.preventDefault());
    canvas.addEventListener("keydown", e => this.keyDown(e));
  }

  resize() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (width === this.width && height === this.height && ratio === this.ratio) return;
    this.width = width;
    this.height = height;
    this.ratio = ratio;
    this.canvas.width = Math.max(1, Math.floor(width * ratio));
    this.canvas.height = Math.max(1, Math.floor(height * ratio));
    if (this.autoFit) this.fit();
    else this.startLoop();
  }

  setViewportInsets(top, bottom) {
    if (top === this.viewportInsets?.top && bottom === this.viewportInsets?.bottom) return;
    this.viewportInsets = {top, bottom};
    if (this.autoFit) this.fit();
  }

  setData(nodes, edges, selection, allGroups = [], positions = {}) {
    this.source = {nodes, edges, selection, groups: allGroups, positions};
    if (this.focusedNode && !nodes.some(node => node.id === this.focusedNode)) {
      this.focusedNode = null;
      this.flyAnim = null;
    }
    if (this.pathNodes) {
      const remaining = new Set(this.pathEdges);
      for (const [a, b] of edges) remaining.delete(edgeKey(a, b));
      if (remaining.size || nodes.filter(node => this.pathNodes.has(node.id)).length !== this.pathNodes.size) {
        this.pathNodes = this.pathEdges = null;
      }
    }
    const required = [...(this.pathNodes || []), selection, this.focusedNode];
    [nodes, edges] = graphSample(nodes, edges, required, this.pathEdges);
    this.selected = selection;
    this.visibleCount = nodes.length;
    const entries = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
    const orderedEdges = edges;
    const paletteGroups = [...new Set(allGroups)].sort();
    const key = JSON.stringify([
      entries.map(item => [item.id, item.title, item.group, item.kind, item.topicAnchor, item.topicLabel, item.noteId]),
      orderedEdges,
      paletteGroups,
      entries.map(item => positions[item.id] || null),
    ]);
    if (key === this.dataKey) {
      this.startLoop();
      return;
    }
    this.dataKey = key;
    this.cancelMove();
    this.gesture = null;
    this.projected = [];
    this.labelHits = [];
    this.pointAt(null);
    const hadPoints = this.points.length > 0;
    const assignments = new Map(entries.map(item => [item.id, item.group || "unsorted"]));
    const degree = new Map();
    const adjacent = new Map();
    for (const [a, b] of orderedEdges) {
      for (const [id, other] of [[a, b], [b, a]]) {
        degree.set(id, (degree.get(id) || 0) + 1);
        if (!adjacent.has(id)) adjacent.set(id, new Set());
        adjacent.get(id).add(other);
      }
    }
    const byGroup = new Map();
    for (const item of entries) {
      const grp = assignments.get(item.id);
      if (!byGroup.has(grp)) byGroup.set(grp, []);
      byGroup.get(grp).push(item);
    }
    const groups = [...byGroup.keys()].sort((a, b) => {
      const neutral = key => Number(key === "index" || key === "unsorted");
      return neutral(a) - neutral(b) || byGroup.get(b).length - byGroup.get(a).length || a.localeCompare(b);
    });
    const centers = placeClusters(groups, byGroup, assignments, orderedEdges);
    const colors = clusterColors([...new Set([...paletteGroups, ...groups])].sort());
    const points = [];
    for (const group of groups) {
      const [cx, cy, cz, radius] = centers.get(group);
      const neutral = group === "unsorted";
      const members = byGroup.get(group);
      const strength = note => (note.topicAnchor ? 1_000_000 : 0) + (degree.get(note.id) || 0);
      const hub = [...members].filter(note => note.kind !== "file")
        .sort((a, b) => strength(b) - strength(a) || a.id.localeCompare(b.id))[0];
      const hubNeighbors = adjacent.get(hub?.id) || new Set();
      const sorted = members.sort((a, b) => Number(b.id === hub?.id) - Number(a.id === hub?.id) ||
        Number(hubNeighbors.has(b.id)) - Number(hubNeighbors.has(a.id)) ||
        Number(a.kind === "file") - Number(b.kind === "file") || strength(b) - strength(a) || a.id.localeCompare(b.id));
      const theme = colors.get(group);
      const offset = seed(group) / 4294967296 * TAU;
      for (let index = 0; index < sorted.length; index++) {
        const note = sorted[index];
        const isHub = Boolean(hub && note.id === hub.id && !neutral);
        const distance = isHub ? 0 : Math.max(0.46, radius * Math.sqrt((index + 0.5) / sorted.length));
        const angle = offset + index * GOLDEN_ANGLE;
        const depth = Math.sin(offset + index * Math.PI * (Math.sqrt(2) - 1));
        const home = [cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance,
          cz + (isHub ? 0 : depth * radius * 0.83)];
        const pinned = positions[note.id];
        points.push({
          ...note, group, isHub, home, position: [...(pinned || home)], pinned: Boolean(pinned),
          velocity: [0, 0, 0], shell: distance > radius * 0.73 ? 1 : 0, degree: 0,
          color: neutral || note.kind === "file" ? null : (isHub ? theme.hub : theme.sat),
        });
      }
    }

    const lookup = new Map(points.map(p => [p.id, p]));
    const attachmentsByOwner = new Map();
    for (const file of points) {
      const owner = file.kind === "file" && lookup.get(file.noteId);
      if (!owner || owner.kind === "file" || owner.group !== file.group) continue;
      const index = attachmentsByOwner.get(owner.id) || 0;
      attachmentsByOwner.set(owner.id, index + 1);
      const spacing = 0.38 + Math.sqrt(index) * 0.19;
      const angle = seed(owner.id) / 4294967296 * TAU + index * GOLDEN_ANGLE;
      file.home = [owner.home[0] + Math.cos(angle) * spacing, owner.home[1] + Math.sin(angle) * spacing,
        owner.home[2] + Math.sin(angle * 0.5) * spacing * 0.55];
      if (!file.pinned) file.position = [...file.home];
    }
    const links = [];
    const neighbors = new Map(points.map(p => [p.id, new Set()]));
    for (const [first, second] of orderedEdges) {
      const a = lookup.get(first);
      const b = lookup.get(second);
      if (!a || !b) continue;
      a.degree += 1;
      b.degree += 1;
      neighbors.get(a.id).add(b.id);
      neighbors.get(b.id).add(a.id);
      links.push([a, b]);
    }

    this.points = points;
    this.cameraDepth = Math.max(CAMERA_DEPTH, 2.65 * points.reduce((max, point) =>
      Math.max(max, Math.hypot(...point.home), Math.hypot(...point.position)), 0));
    this.links = links;
    this.overviewLinks = new Set();
    const crossCounts = new Map();
    for (const link of [...links].sort(([a, b], [c, d]) =>
      Number(c.isHub) + Number(d.isHub) - Number(a.isHub) - Number(b.isHub))) {
      const [a, b] = link;
      if (a.group === b.group) {
        this.overviewLinks.add(link);
        continue;
      }
      const pair = [a.group, b.group].sort().join("\u0000");
      const count = crossCounts.get(pair) || 0;
      if (count < 4) this.overviewLinks.add(link);
      crossCounts.set(pair, count + 1);
    }
    this.neighbors = neighbors;
    this.alpha = 0;

    if (this.autoFit || !hadPoints) this.fit();
    this.startLoop();
  }

  relayout() {
    const resample = Boolean(this.focusedNode || this.pathNodes);
    this.cancelMove();
    this.pointers.clear();
    this.gesture = null;
    this.projected = [];
    this.labelHits = [];
    this.canvas.classList?.remove("is-dragging");
    this.pointAt(null);
    this.focusedNode = null;
    this.pathNodes = this.pathEdges = null;
    if (resample) {
      const {nodes, edges, selection, groups, positions} = this.source;
      this.setData(nodes, edges, selection, groups, positions);
    }
    for (const p of this.points) {
      p.pinned = Boolean(this.source.positions[p.id]);
      p.position = [...(this.source.positions[p.id] || p.home)];
      p.velocity = [0, 0, 0];
    }
    this.basis = orientation();
    this.orbit(-0.14, -0.10);
    this.alpha = 0;
    this.fit();
    this.startLoop();
  }

  toggleLiving() {
    this.living = !this.living;
    if (this.living) {
      this.alpha = Math.max(this.alpha, 0.1);
      this.startLoop();
    }
    return this.living;
  }

  reheat() {
    this.alpha = 0.4;
    this.startLoop();
  }

  focusNode(queryOrId) {
    const q = (queryOrId || "").trim().toLowerCase();
    if (!q) {
      this.focusedNode = null;
      this.flyAnim = null;
      this.startLoop();
      return null;
    }
    const {nodes, edges, selection, groups, positions} = this.source;
    const match = nodes.find(p => p.id === queryOrId) ||
      nodes.find(p => p.title.toLowerCase() === q) ||
      nodes.find(p => p.title.toLowerCase().includes(q));
    if (!match) return null;
    this.focusedNode = match.id;
    if (this.pathNodes) this.clearPath();
    else if (!this.points.some(p => p.id === match.id)) this.setData(nodes, edges, selection, groups, positions);
    const target = this.points.find(p => p.id === match.id);
    if (!target) return null;
    const [px, py] = this.project(target);
    const targetScale = Math.max(this.scale, this.fitScale * 2.1);
    this.flyAnim = {
      startPan: [...this.pan],
      endPan: [-px * targetScale, -py * targetScale],
      startScale: this.scale,
      endScale: targetScale,
      startTime: performance.now(),
      duration: this.reducedMotion ? 1 : 460,
    };
    this.autoFit = false;
    this.startLoop();
    return target;
  }

  findPath(startId, endId) {
    if (!startId || !endId || startId === endId) {
      this.clearPath();
      return null;
    }
    const {nodes, edges, selection, groups, positions} = this.source;
    const neighbors = new Map(nodes.map(node => [node.id, []]));
    for (const [first, second] of edges) {
      if (!neighbors.has(first) || !neighbors.has(second)) continue;
      neighbors.get(first).push(second);
      neighbors.get(second).push(first);
    }
    const queue = [startId];
    const previous = new Map([[startId, null]]);
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      if (current === endId) {
        const path = [];
        for (let id = current; id !== null; id = previous.get(id)) path.push(id);
        path.reverse();
        this.focusedNode = null;
        this.flyAnim = null;
        this.pointAt(null);
        this.pathNodes = new Set(path);
        this.pathEdges = new Set();
        for (let i = 0; i < path.length - 1; i++) {
          this.pathEdges.add(edgeKey(path[i], path[i + 1]));
        }
        this.setData(nodes, edges, selection, groups, positions);
        return path;
      }
      for (const next of (neighbors.get(current) || []).sort()) {
        if (previous.has(next)) continue;
        previous.set(next, current);
        queue.push(next);
      }
    }
    this.clearPath();
    return [];
  }

  clearPath() {
    if (!this.pathNodes) { this.startLoop(); return; }
    this.pathNodes = this.pathEdges = null;
    const {nodes, edges, selection, groups, positions} = this.source;
    this.setData(nodes, edges, selection, groups, positions);
  }

  exportPNG() {
    this.draw();
    return this.canvas.toDataURL("image/png");
  }

  stepPhysics(alphaOverride = null) {
    const pts = this.points;
    const n = pts.length;
    if (n <= 1) return;
    const alpha = alphaOverride ?? this.alpha;
    if (alpha <= 0.001) return;

    const hubPull = 0.16 * alpha;
    const satPull = 0.10 * alpha;
    const intraSpring = 0.010 * alpha;

    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (p.pinned) continue;
      const pull = p.isHub ? hubPull : satPull;
      for (let a = 0; a < 3; a++) {
        p.velocity[a] += (p.home[a] - p.position[a]) * pull;
      }
    }

    const stride = n > 300 ? Math.ceil(n / 300) : 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      for (let j = i + stride; j < n; j += stride) {
        const b = pts[j];
        const dx = b.position[0] - a.position[0];
        const dy = b.position[1] - a.position[1];
        const dz = b.position[2] - a.position[2];
        const distSq = dx * dx + dy * dy + dz * dz + 0.01;
        if (distSq > 1.2) continue;
        const dist = Math.sqrt(distSq);
        const minDist = a.group === b.group ? 0.38 : 0.78;
        if (dist >= minDist) continue;
        const f = (minDist - dist) * 0.16 * alpha;
        const fx = (dx / dist) * f, fy = (dy / dist) * f, fz = (dz / dist) * f;
        if (!a.pinned) { a.velocity[0] -= fx; a.velocity[1] -= fy; a.velocity[2] -= fz; }
        if (!b.pinned) { b.velocity[0] += fx; b.velocity[1] += fy; b.velocity[2] += fz; }
      }
    }

    // Intra-cluster springs ONLY — cross-cluster links never collapse separate 3D constellations!
    for (const [a, b] of this.links) {
      if (a.group !== b.group) continue;
      const dx = b.position[0] - a.position[0];
      const dy = b.position[1] - a.position[1];
      const dz = b.position[2] - a.position[2];
      const dist = Math.max(0.001, Math.hypot(dx, dy, dz));
      const desired = Math.hypot(...a.home.map((value, axis) => value - b.home[axis]));
      const force = (dist - desired) * intraSpring / dist;
      if (!a.pinned) { a.velocity[0] += dx * force; a.velocity[1] += dy * force; a.velocity[2] += dz * force; }
      if (!b.pinned) { b.velocity[0] -= dx * force; b.velocity[1] -= dy * force; b.velocity[2] -= dz * force; }
    }

    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (p.pinned) { p.velocity[0] = p.velocity[1] = p.velocity[2] = 0; continue; }
      p.velocity[0] *= 0.76;
      p.velocity[1] *= 0.76;
      p.velocity[2] *= 0.76;
      p.position[0] += p.velocity[0];
      p.position[1] += p.velocity[1];
      p.position[2] += p.velocity[2];
    }

    if (alphaOverride === null) {
      const floor = this.living ? 0.003 : 0;
      this.alpha = Math.max(floor, this.alpha * 0.94);
    }
  }

  startLoop() {
    if (this.frame) return;
    this.lastFrameTime = performance.now();
    this.frame = requestAnimationFrame(now => this.tick(now));
  }

  schedule() {
    this.startLoop();
  }

  tick(now) {
    this.frame = 0;
    const dt = Math.min(50, Math.max(1, now - (this.lastFrameTime || now)));
    this.lastFrameTime = now;
    if (this.canvas.clientWidth <= 0 || this.canvas.clientHeight <= 0) return;

    const interacting = this.pointers.size > 0 || Boolean(this.hover) || Boolean(this.flyAnim);

    if (this.living && this.points.length > 0) {
      if (!interacting && this.mode === "3d") {
        const step = dt / 16.67;
        this.orbit(0.0011 * step, 0.00022 * Math.sin(now * 0.00028) * step);
      }
      this.stepPhysics();
    } else if (!this.reducedMotion && this.alpha > 0.003) {
      this.stepPhysics();
    }

    if (this.flyAnim) {
      const t = Math.min(1, (now - this.flyAnim.startTime) / this.flyAnim.duration);
      const ease = 1 - Math.pow(1 - t, 3);
      this.pan[0] = this.flyAnim.startPan[0] + (this.flyAnim.endPan[0] - this.flyAnim.startPan[0]) * ease;
      this.pan[1] = this.flyAnim.startPan[1] + (this.flyAnim.endPan[1] - this.flyAnim.startPan[1]) * ease;
      this.scale = this.flyAnim.startScale + (this.flyAnim.endScale - this.flyAnim.startScale) * ease;
      this.onZoom(this.scale / this.fitScale);
      if (t >= 1) this.flyAnim = null;
    }

    this.draw();

    const shouldContinue = (this.living && this.points.length > 0) ||
      (!this.reducedMotion && this.alpha > 0.003) || Boolean(this.flyAnim);
    if (shouldContinue) this.frame = requestAnimationFrame(next => this.tick(next));
  }

  orbit(horizontal, vertical) {
    const sx = Math.sin(vertical), cx = Math.cos(vertical);
    const sy = Math.sin(horizontal), cy = Math.cos(horizontal);
    const [right, down, forward] = this.basis;
    const x = right.map((v, i) => v * cy + forward[i] * sy);
    const z = forward.map((v, i) => v * cy - right[i] * sy);
    this.basis = [
      x,
      down.map((v, i) => v * cx - z[i] * sx),
      z.map((v, i) => v * cx + down[i] * sx),
    ];
  }

  setMode(mode) {
    this.mode = mode;
    this.fit();
  }

  project(point) {
    const [x, y, z] = point.position;
    const base = Math.min(this.width, this.height) * 0.16;
    if (this.mode === "2d") {
      const y2d = point.pinned || !point.home ? y + z * 0.5 : y;
      return [x * base, y2d * base, 0, 1];
    }
    if (this.mode === "layered") return [(x + z * 0.32) * base, (y - z * 0.32) * base, z, 1];
    const [h, v, depth] = this.basis.map(axis => axis[0] * x + axis[1] * y + axis[2] * z);
    const camera = this.cameraDepth || CAMERA_DEPTH;
    const perspective = camera / Math.max(camera * 0.28, camera - depth);
    return [h * base * perspective, v * base * perspective, depth, perspective];
  }

  draw() {
    const {context: ctx, width, height, ratio} = this;
    if (width <= 0 || height <= 0) return;

    const palette = getThemeColors();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, width, height);

    const centerX = width / 2;
    const centerY = height / 2;
    const mag = this.scale / Math.max(0.01, this.fitScale);
    const growth = Math.min(1.4, Math.pow(mag, 0.3));

    const lookup = new Map();
    this.projected = this.points.map(point => {
      const [x, y, depth, perspective] = this.project(point);
      const baseR = point.kind === "file" ? 2.65 : point.isHub
        ? Math.min(8.3, 5.1 + Math.sqrt(point.degree) * 0.49)
        : Math.min(4.1, (point.shell === 0 ? 3.15 : 2.8) + Math.sqrt(point.degree) * 0.16);
      const radius = Math.max(2, baseR * Math.min(1.25, perspective) * growth);
      const proj = {
        ...point,
        drawColor: palette.pointColors?.get(point.color) || point.color || palette.fileColor,
        radius,
        depth,
        perspective,
        x: centerX + this.pan[0] + x * this.scale,
        y: centerY + this.pan[1] + y * this.scale,
      };
      lookup.set(point.id, proj);
      return proj;
    }).sort((a, b) => a.depth - b.depth);

    const highlighted = this.hover?.id ?? this.focusedNode ?? this.selected ?? null;
    const isHoverActive = Boolean(this.hover?.id || this.focusedNode);
    const neighbors = new Set(highlighted ? [highlighted] : []);
    if (highlighted && this.neighbors.has(highlighted)) {
      for (const n of this.neighbors.get(highlighted)) neighbors.add(n);
    }

    ctx.lineCap = "round";
    for (const link of this.links) {
      const [a, b] = link;
      const from = lookup.get(a.id);
      const to = lookup.get(b.id);
      if (!from || !to) continue;
      const onPath = this.pathEdges?.has(edgeKey(a.id, b.id));
      const activeEdge = onPath || (isHoverActive && (a.id === highlighted || b.id === highlighted));
      const sameGroup = a.group === b.group;
      if (!activeEdge && !this.overviewLinks.has(link)) continue;

      if (activeEdge) {
        ctx.strokeStyle = onPath ? (palette.pathColor || "#eab308") : (a.id === highlighted ? from.drawColor : to.drawColor);
        ctx.globalAlpha = onPath ? 0.95 : 0.82;
        ctx.lineWidth = onPath ? 1.4 : 0.95;
      } else {
        ctx.strokeStyle = sameGroup ? (from.color ? from.drawColor : palette.edgeIntra) : palette.edgeCross;
        const alpha = sameGroup && from.color ? (palette.clusterEdgeOpacity ?? 0.21) : 1;
        ctx.globalAlpha = (isHoverActive || this.pathNodes) ? alpha * 0.25 : alpha;
        ctx.lineWidth = sameGroup ? 0.6 : 0.38;
      }
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }

    for (const point of this.projected) {
      const isFocus = isHoverActive && point.id === highlighted;
      const isSelected = point.id === this.selected;
      const isNeighbor = isHoverActive && neighbors.has(point.id) && !isFocus;
      const onPath = this.pathNodes?.has(point.id);
      const dimmed = (this.pathNodes && !onPath) || (isHoverActive && !neighbors.has(point.id));

      const depthAlpha = Math.max(palette.nodeOpacity ?? 0.50, Math.min(1, 0.73 + (point.perspective - 0.76) * 0.52));
      ctx.globalAlpha = dimmed ? 0.12 : (isFocus || isNeighbor || onPath || isSelected ? 1 : depthAlpha);

      const r = isFocus ? point.radius * 1.25 : point.radius;
      ctx.fillStyle = point.drawColor;
      ctx.beginPath();
      ctx.arc(point.x, point.y, r, 0, TAU);
      ctx.fill();

      if (point.isHub && !dimmed) {
        ctx.strokeStyle = point.drawColor;
        ctx.globalAlpha = isFocus ? 0.85 : Math.min(0.45, depthAlpha * 0.45);
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.arc(point.x, point.y, r + 2.6, 0, TAU);
        ctx.stroke();
      }

      if (isFocus || onPath || isSelected) {
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = onPath ? (palette.pathColor || "#eab308") : palette.focusRing;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(point.x, point.y, r + (point.isHub ? 4.4 : 2.2), 0, TAU);
        ctx.stroke();
      }
    }

    this.drawLabels(isHoverActive ? highlighted : null, neighbors, palette);
    ctx.globalAlpha = 1;
  }

  drawLabels(highlighted, neighbors, palette) {
    const {context: ctx, width, height} = this;
    this.labelHits = [];
    if (!this.projected.length) return;

    const zoomedIn = this.scale >= this.fitScale * 1.65;
    let candidates = [];

    if (highlighted) {
      const focusNode = this.projected.find(p => p.id === highlighted);
      if (focusNode) candidates.push({point: focusNode, primary: true});
      if (this.showLabels || zoomedIn) {
        for (const p of this.projected) {
          if (p.id !== highlighted && neighbors.has(p.id)) candidates.push({point: p, primary: false});
        }
      }
    } else if (this.pathNodes) {
      for (const p of this.projected) {
        if (this.pathNodes.has(p.id)) candidates.push({point: p, primary: true});
      }
    } else if (this.showLabels || zoomedIn) {
      const sorted = [...this.projected].sort((a, b) => Number(b.isHub) - Number(a.isHub) || b.degree - a.degree);
      for (const p of sorted.slice(0, this.showLabels ? 80 : 26)) {
        candidates.push({point: p, primary: p.isHub});
      }
    } else {
      const hubs = this.projected.filter(p => p.isHub).sort((a, b) => b.degree - a.degree);
      for (const p of hubs) candidates.push({point: p, primary: false});
    }

    if (!candidates.length) return;

    const occupied = [];
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";

    for (const {point, primary} of candidates) {
      const fontSize = primary ? 13 : point.isHub ? 12 : 10;
      ctx.font = `${primary || point.isHub ? 550 : 400} ${fontSize}px -apple-system, BlinkMacSystemFont, "Inter", sans-serif`;
      const title = point.isHub && !highlighted && !this.pathNodes ? point.topicLabel || point.title : point.title;
      const text = shorten(title, primary ? 36 : 26);
      const tw = ctx.measureText(text).width;
      const x = point.x;
      const y = point.y - point.radius - (point.isHub ? 8 : 6);
      const box = {left: x - tw / 2 - 8, right: x + tw / 2 + 8, top: y - fontSize - 5, bottom: y + 3};

      if (!primary && (box.left < 6 || box.right > width - 6 || box.top < 12 || box.bottom > height - 48 ||
          occupied.some(o => overlaps(box, o)))) {
        continue;
      }
      occupied.push(box);
      this.labelHits.push({point, ...box});

      ctx.globalAlpha = primary || point.isHub ? 0.96 : 0.82;
      ctx.fillStyle = primary || point.isHub ? palette.labelPrimary : palette.labelSecondary;
      ctx.fillText(text, x, y);
    }
  }

  hit(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let nearest = null;
    let distance = Infinity;
    for (let i = this.projected.length - 1; i >= 0; i--) {
      const p = this.projected[i];
      const gap = Math.hypot(p.x - x, p.y - y);
      const hitRadius = Math.max(8, p.radius + 4);
      if (gap <= hitRadius && gap < distance) {
        nearest = p;
        distance = gap;
      }
    }
    if (nearest) return nearest;
    const label = this.labelHits.find(box => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
    return label?.point ?? null;
  }

  pointAt(point) {
    if (this.hover?.id === point?.id) return;
    this.hover = point;
    this.canvas.classList.toggle("can-open", Boolean(point));
    this.startLoop();
  }

  pointerDown(event) {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    this.flyAnim = null;
    this.canvas.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, [event.clientX, event.clientY]);
    const moved = this.pointers.size > 1;
    if (moved) this.cancelMove();
    const pan = event.shiftKey || event.button !== 0;
    const hit = !pan && !moved ? this.hit(event) : null;
    const node = hit && this.points.find(p => p.id === hit.id);
    this.gesture = {
      moved, pan, start: [event.clientX, event.clientY], node,
      position: node?.position.slice(), pinned: node?.pinned,
      autoFit: this.autoFit,
      moveNode: this.manualPlacement && Boolean(node),
      units: Math.min(this.width, this.height) * 0.16 * this.scale * (hit?.perspective || 1),
    };
    if (moved) this.canvas.classList.toggle("is-dragging", true);
    this.onActivity();
  }

  pointerMove(event) {
    const prev = this.pointers.get(event.pointerId);
    if (!prev) {
      if (this.pointers.size === 0) this.pointAt(this.hit(event));
      return;
    }
    const next = [event.clientX, event.clientY];
    this.pointers.set(event.pointerId, next);
    if (this.pointers.size === 2) {
      const other = [...this.pointers.entries()].find(([id]) => id !== event.pointerId)[1];
      const before = Math.hypot(other[0] - prev[0], other[1] - prev[1]);
      const after = Math.hypot(other[0] - next[0], other[1] - next[1]);
      if (before > 0) this.zoom(after / before, [(other[0] + next[0]) / 2, (other[1] + next[1]) / 2]);
      return;
    }
    if (this.pointers.size !== 1) return;
    const dx = next[0] - prev[0], dy = next[1] - prev[1];
    if (!this.gesture) return;
    const [sx, sy] = this.gesture.start;
    const ox = next[0] - sx, oy = next[1] - sy;
    if (Math.hypot(ox, oy) > 4) this.gesture.moved = true;
    if (!this.gesture.moved) return;
    this.canvas.classList.toggle("is-dragging", true);
    this.autoFit = false;
    if (this.gesture.moveNode) {
      const {node, position, units} = this.gesture;
      const [right, down] = this.mode === "3d" ? this.basis : orientation();
      node.pinned = true;
      node.position = position.map((val, axis) => Math.max(-100, Math.min(100,
        val + (right[axis] * ox + down[axis] * oy) / units)));
      node.velocity = [0, 0, 0];
      this.alpha = Math.max(this.alpha, 0.1);
    } else if (this.gesture.pan || this.mode !== "3d") {
      this.pan[0] += dx;
      this.pan[1] += dy;
    } else {
      this.orbit(dx * ORBIT_SPEED, -dy * ORBIT_SPEED);
    }
    if (!this.gesture.moveNode) this.pointAt(null);
    this.startLoop();
    this.onActivity();
  }

  pointerUp(event, activate) {
    if (!this.pointers.delete(event.pointerId)) return;
    if (this.pointers.size > 0) {
      this.gesture = {moved: true, pan: true, start: this.pointers.values().next().value};
      return;
    }
    this.canvas.classList.toggle("is-dragging", false);
    const point = activate ? this.hit(event) : null;
    if (point && this.gesture && !this.gesture.moved && point.id === this.gesture.node?.id) {
      this.onOpen(point.id);
    } else if (activate && !point && this.gesture && !this.gesture.moved) {
      this.focusedNode = null;
      this.clearPath();
    }
    if (activate) this.commitMove();
    else this.cancelMove();
    this.pointAt(point);
    this.gesture = null;
  }

  cancelMove() {
    if (!this.gesture?.moved || !this.gesture.moveNode) return;
    const {node, position, pinned, autoFit} = this.gesture;
    node.position = position;
    node.pinned = pinned;
    node.velocity = [0, 0, 0];
    this.autoFit = autoFit;
    this.startLoop();
  }

  restorePosition(id, position) {
    const point = this.points.find(item => item.id === id);
    if (!point) return;
    point.position = [...(position || point.home)];
    point.pinned = Boolean(position);
    point.velocity = [0, 0, 0];
    this.startLoop();
  }

  commitMove() {
    if (!this.gesture?.moved || !this.gesture.moveNode) return;
    const {node} = this.gesture;
    node.pinned = true;
    node.velocity = [0, 0, 0];
    this.onMove(node.id, node.position.slice());
  }

  keyDown(event) {
    if (event.key === "Escape") {
      this.focusedNode = null;
      this.flyAnim = null;
      this.clearPath();
      return;
    }
    if (["+", "=", "-", "_"].includes(event.key)) {
      event.preventDefault();
      this.zoom(event.key === "+" || event.key === "=" ? 1.18 : 1 / 1.18);
      return;
    }
    const angles = {ArrowLeft: [-0.15, 0], ArrowRight: [0.15, 0], ArrowUp: [0, 0.15], ArrowDown: [0, -0.15]};
    if (!Object.hasOwn(angles, event.key)) return;
    event.preventDefault();
    this.autoFit = false;
    if (this.mode === "3d") this.orbit(...angles[event.key]);
    else {
      this.pan[0] += angles[event.key][0] * 100;
      this.pan[1] -= angles[event.key][1] * 100;
    }
    this.startLoop();
    this.onActivity();
  }

  zoom(factor, pointer) {
    const next = Math.max(this.fitScale * MIN_RELATIVE_ZOOM, Math.min(this.fitScale * MAX_RELATIVE_ZOOM, this.scale * factor));
    const rect = this.canvas.getBoundingClientRect();
    const ratio = next / this.scale;
    const x = pointer ? pointer[0] - rect.left - this.width / 2 : 0;
    const y = pointer ? pointer[1] - rect.top - this.height / 2 : 0;
    this.pan[0] = x + (this.pan[0] - x) * ratio;
    this.pan[1] = y + (this.pan[1] - y) * ratio;
    this.autoFit = false;
    this.scale = next;
    this.onZoom(next / this.fitScale);
    this.startLoop();
    this.onActivity();
  }

  fit() {
    this.autoFit = true;
    this.flyAnim = null;
    this.pan = [0, 0];
    this.scale = 1;
    if (this.width > 0 && this.height > 0 && this.points.length) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const point of this.points) {
        const [x, y] = this.project(point);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      const horizontalInset = Math.min(72, this.width * 0.12);
      const top = Math.min(this.viewportInsets?.top ?? 30, this.height * 0.24);
      const bottom = Math.min(this.viewportInsets?.bottom ?? 92, this.height * 0.52);
      if (this.points.length > 1) {
        this.scale = Math.min(2.2,
          (this.width - horizontalInset) / Math.max(maxX - minX, 1),
          (this.height - top - bottom) / Math.max(maxY - minY, 1));
      }
      this.pan = [-(minX + maxX) / 2 * this.scale, (top - bottom) / 2 - (minY + maxY) / 2 * this.scale];
    }
    this.fitScale = this.scale;
    this.onZoom(1);
    this.startLoop();
  }

  reset() {
    this.basis = orientation();
    this.orbit(-0.14, -0.10);
    this.focusedNode = null;
    this.clearPath();
    this.fit();
  }

  clear() {
    this.focusedNode = null;
    this.clearPath();
    this.setData([], [], null);
    this.projected = [];
    this.labelHits = [];
    this.reset();
    this.context.fillStyle = getThemeColors().bg;
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
