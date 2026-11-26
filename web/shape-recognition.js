const TAU = 2 * Math.PI;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function bounds(points) {
  return points.reduce(([left, top, right, bottom], [x, y]) =>
    [Math.min(left, x), Math.min(top, y), Math.max(right, x), Math.max(bottom, y)],
  [Infinity, Infinity, -Infinity, -Infinity]);
}

function segmentDistance(point, start, end) {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const width = dx * dx + dy * dy;
  if (!width) return distance(point, start);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / width));
  return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dy);
}

function uniformSamples(points, count = 64) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative.at(-1) + distance(points[i - 1], points[i]));
  const length = cumulative.at(-1);
  if (!length) return {samples: [points[0]], length};
  let right = 1;
  const samples = Array.from({length: count}, (_, index) => {
    const position = length * index / (count - 1);
    while (right + 1 < cumulative.length && cumulative[right] < position) right++;
    const step = cumulative[right] - cumulative[right - 1];
    const t = step ? (position - cumulative[right - 1]) / step : 0;
    return points[right - 1].map((value, axis) => value + t * (points[right][axis] - value));
  });
  return {samples, length};
}

function errors(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return {average: values.reduce((sum, value) => sum + value, 0) / values.length,
          high: ordered[Math.floor((ordered.length - 1) * 0.9)]};
}

function simplify(points, epsilon) {
  if (points.length <= 2) return points;
  let furthest = 0, split = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const dist = segmentDistance(points[i], points[0], points.at(-1));
    if (dist > furthest) { furthest = dist; split = i; }
  }
  if (split < 0 || furthest < epsilon) return [points[0], points.at(-1)];
  return [...simplify(points.slice(0, split + 1), epsilon).slice(0, -1),
          ...simplify(points.slice(split), epsilon)];
}

function corners(points, epsilon) {
  const split = points.reduce((max, point, index) =>
    distance(point, points[0]) > distance(points[max], points[0]) ? index : max, 0);
  if (!split) return [];
  const first = simplify(points.slice(0, split + 1), epsilon);
  const second = simplify([...points.slice(split), points[0]], epsilon).slice(1, -1);
  const vertices = first.concat(second);
  return vertices.filter((point, index) =>
    segmentDistance(point, vertices[(index + vertices.length - 1) % vertices.length],
      vertices[(index + 1) % vertices.length]) > epsilon * 0.5);
}

function ellipsePoints(cx, cy, major, minor, angle = 0) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return Array.from({length: 73}, (_, i) => {
    const t = i * TAU / 72, x = major * Math.cos(t), y = minor * Math.sin(t);
    return [cx + x * c - y * s, cy + x * s + y * c];
  });
}

function ellipseFit(points, scale) {
  const [left, top, right, bottom] = bounds(points);
  let cx = (left + right) / 2, cy = (top + bottom) / 2;
  let xx = 0, yy = 0, xy = 0;
  for (const [x, y] of points) {
    xx += (x - cx) ** 2;
    yy += (y - cy) ** 2;
    xy += (x - cx) * (y - cy);
  }
  const angle = Math.atan2(2 * xy, xx - yy) / 2;
  const c = Math.cos(angle), s = Math.sin(angle);
  const local = points.map(([x, y]) => [x * c + y * s, -x * s + y * c]);
  const [minX, minY, maxX, maxY] = bounds(local);
  const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
  let major = (maxX - minX) / 2, minor = (maxY - minY) / 2;
  if (Math.min(major, minor) < scale * 0.12) return null;
  const residual = errors(local.map(([x, y]) => Math.abs(Math.hypot((x - midX) / major, (y - midY) / minor) - 1)));
  if (residual.average > 0.085 || residual.high > 0.18) return null;
  const bins = new Set(local.map(([x, y]) =>
    Math.floor((Math.atan2((y - midY) / minor, (x - midX) / major) + Math.PI) * 16 / TAU) % 16));
  if (bins.size < 14) return null;
  cx = midX * c - midY * s;
  cy = midX * s + midY * c;
  const circle = Math.min(major, minor) / Math.max(major, minor) >= 0.88;
  if (circle) major = minor = (major + minor) / 2;
  return {kind: circle ? "Circle" : "Ellipse", points: ellipsePoints(cx, cy, major, minor, angle), error: residual.average};
}

function fourSides(vertices) {
  const vectors = vertices.map((point, i) => vertices[(i + 1) % 4].map((x, axis) => x - point[axis]));
  const lengths = vectors.map(vector => Math.hypot(...vector));
  const rightAngles = vectors.every(([x, y], i) => {
    const j = (i + 1) % 4;
    return Math.abs(x * vectors[j][0] + y * vectors[j][1]) < 0.28 * lengths[i] * lengths[j];
  });
  const opposed = Math.max(Math.abs(lengths[0] - lengths[2]) / (lengths[0] + lengths[2]),
    Math.abs(lengths[1] - lengths[3]) / (lengths[1] + lengths[3]));
  if (!rightAngles || opposed > 0.18) return {kind: "Quadrilateral", points: [...vertices, vertices[0]]};
  const cx = vertices.reduce((sum, point) => sum + point[0], 0) / 4;
  const cy = vertices.reduce((sum, point) => sum + point[1], 0) / 4;
  const angle = Math.atan2(vectors[0][1] - vectors[2][1], vectors[0][0] - vectors[2][0]);
  const winding = Math.sign(vectors[0][0] * vectors[1][1] - vectors[0][1] * vectors[1][0]);
  let width = (lengths[0] + lengths[2]) / 4, height = (lengths[1] + lengths[3]) / 4;
  const square = Math.min(width, height) / Math.max(width, height) > 0.87;
  if (square) width = height = (width + height) / 2;
  const c = Math.cos(angle), s = Math.sin(angle);
  const clean = [[-width, -height], [width, -height], [width, height], [-width, height]].map(([x, y]) =>
    [cx + x * c - y * winding * s, cy + x * s + y * winding * c]);
  return {kind: square ? "Square" : "Rectangle", points: [...clean, clean[0]]};
}

const CUBE_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 5], [2, 6], [4, 5], [5, 6]];

function cubeCorners(box, dx, dy, mirrored) {
  const [left, top, right, bottom] = box;
  const w = (right - left) * (1 - dx), h = (bottom - top) * (1 - dy);
  const sx = (right - left) * dx, sy = (bottom - top) * dy;
  const corners = [[0, sy], [w, sy], [w, sy + h], [0, sy + h],
                   [sx, 0], [w + sx, 0], [w + sx, h]];
  return corners.map(([x, y]) => [mirrored ? right - x : left + x, top + y]);
}

function traceCube(vertices) {
  // This path retraces some edges so the drawing remains one undoable stroke.
  return [0, 3, 2, 1, 0, 4, 5, 1, 2, 6, 5].map(index => vertices[index]);
}

function cubeFit(points, box, scale) {
  const segments = points.slice(1).map((point, i) => [points[i], point]);
  let best = null, bestError = Infinity;
  for (const mirrored of [false, true]) {
    for (const x of [0.18, 0.24, 0.30, 0.36]) {
      for (const y of [0.18, 0.24, 0.30, 0.36]) {
        const vertices = cubeCorners(box, x, y, mirrored);
        const edges = CUBE_EDGES.map(([a, b]) => [vertices[a], vertices[b]]);
        const residual = errors(points.map(point => Math.min(...edges.map(([a, b]) => segmentDistance(point, a, b)))));
        if (residual.average > scale * 0.032 || residual.high > scale * 0.067 || residual.average >= bestError) continue;
        const covered = edges.filter(([a, b]) => [0.30, 0.55, 0.76].every(t => {
          const point = a.map((value, i) => value + (b[i] - value) * t);
          return segments.some(([start, end]) => segmentDistance(point, start, end) < scale * 0.055);
        })).length;
        if (covered < 8) continue;
        bestError = residual.average;
        best = vertices;
      }
    }
  }
  return best ? {kind: "Cube", points: traceCube(best)} : null;
}

export function recognizeShape(points) {
  if (points.length < 3) return null;
  const [x0, y0, x1, y1] = bounds(points);
  const tolerance = Math.max(1.6, Math.hypot(x1 - x0, y1 - y0) * 0.018);
  const filtered = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    if (distance(filtered.at(-1), points[i]) >= tolerance) filtered.push(points[i]);
  }
  filtered.push(points.at(-1));
  const {samples, length} = uniformSamples(filtered, 80);
  const box = bounds(samples);
  const scale = Math.hypot(box[2] - box[0], box[3] - box[1]);
  if (scale < 34 || samples.length < 5) return null;
  const first = samples[0], last = samples.at(-1), direct = distance(first, last);
  if (direct / length >= 0.86) {
    const deviation = errors(samples.map(point => segmentDistance(point, first, last)));
    if (deviation.average <= Math.max(2.5, direct * 0.047) && deviation.high < direct * 0.082) {
      return {kind: "Line", points: [first, last]};
    }
  }
  if (length > scale * 3.5) {
    const cube = cubeFit(samples, box, scale);
    if (cube) return cube;
  }
  if (direct > scale * 0.24 || length < scale * 1.6 || length > scale * 3.9) return null;

  const ellipse = ellipseFit(samples, scale);
  const vertices = corners(samples, scale * 0.055);
  if (vertices.length >= 3 && vertices.length <= 6) {
    const closed = [...vertices, vertices[0]];
    const deviation = errors(samples.map(point => Math.min(...vertices.map((v, i) => segmentDistance(point, v, closed[i + 1])))));
    const lengths = vertices.map((p, i) => distance(p, closed[i + 1]));
    const uniform = Math.min(...lengths) > scale * 0.14;
    if (ellipse && ellipse.error < 0.055 && ellipse.error * scale * 0.45 + scale * 0.004 < deviation.average) return ellipse;
    if (uniform && deviation.average < scale * (ellipse ? 0.024 : 0.032)
        && deviation.high < scale * (ellipse ? 0.048 : 0.065)) {
      if (vertices.length === 4) return fourSides(vertices);
      const labels = {3: "Triangle", 5: "Pentagon", 6: "Hexagon"};
      return {kind: labels[vertices.length], points: closed};
    }
  }
  return ellipse;
}

export function shapeStroke(kind, start, end) {
  if (kind === "Line") return [start, end];
  const box = bounds([start, end]);
  const [left, top, right, bottom] = box;
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  let rx = (right - left) / 2, ry = (bottom - top) / 2;
  if (rx < 2 || ry < 2) return [start, end];
  if (kind === "Circle" || kind === "Square") rx = ry = Math.min(rx, ry);
  if (kind === "Circle" || kind === "Ellipse") return ellipsePoints(cx, cy, rx, ry);
  if (kind === "Cube") return traceCube(cubeCorners(box, 0.26, 0.26, false));
  if (kind === "Rectangle" || kind === "Square") {
    return [[cx - rx, cy - ry], [cx + rx, cy - ry], [cx + rx, cy + ry],
            [cx - rx, cy + ry], [cx - rx, cy - ry]];
  }
  const sides = {Triangle: 3, Diamond: 4, Pentagon: 5, Hexagon: 6}[kind];
  if (!sides) return [start, end];
  return Array.from({length: sides + 1}, (_, i) => {
    const t = i * TAU / sides - Math.PI / 2;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  });
}

// Upright shapes anchored cleanly at the exact press point without sideways drift.
export function anchoredShapeStroke(kind, start, end) {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (kind === "Line") return [start, end];
  if (length < 1) return [start, end];
  const sx = Math.sign(dx || 1), sy = Math.sign(dy || 1);
  if (kind === "Rectangle" || kind === "Square") {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    const tx = kind === "Square" ? start[0] + sx * side : end[0];
    const ty = kind === "Square" ? start[1] + sy * side : end[1];
    return [start, [tx, start[1]], [tx, ty], [start[0], ty], start];
  }
  if (kind === "Cube") {
    const w = dx * 0.74, h = dy * 0.74;
    const ox = dx * 0.26, oy = dy * 0.26;
    const verts = [
      [start[0], start[1]],
      [start[0] + w, start[1]],
      [start[0] + w, start[1] + h],
      [start[0], start[1] + h],
      [start[0] + ox, start[1] + oy],
      [start[0] + w + ox, start[1] + oy],
      [start[0] + w + ox, start[1] + h + oy],
    ];
    return traceCube(verts);
  }
  if (kind === "Triangle") {
    return [start, [start[0] + dx, start[1] + dy], [start[0] - dx, start[1] + dy], start];
  }
  if (kind === "Diamond") {
    const midY = start[1] + dy / 2;
    return [start, [start[0] + dx, midY], [start[0], start[1] + dy], [start[0] - dx, midY], start];
  }
  if (kind === "Pentagon" || kind === "Hexagon") {
    const sides = kind === "Pentagon" ? 5 : 6;
    const r = length / 2;
    const cy = start[1] + sy * r;
    const baseAngle = sy >= 0 ? -Math.PI / 2 : Math.PI / 2;
    return Array.from({length: sides + 1}, (_, i) => {
      if (i === 0 || i === sides) return start;
      const a = baseAngle + i * TAU / sides;
      return [start[0] + r * Math.cos(a), cy + r * Math.sin(a)];
    });
  }
  // Circle & upright Ellipse passing cleanly through both start and end
  const cx = (start[0] + end[0]) / 2, cy = (start[1] + end[1]) / 2;
  if (kind === "Circle") {
    const r = length / 2;
    const a0 = Math.atan2(start[1] - cy, start[0] - cx);
    return Array.from({length: 65}, (_, i) => {
      if (i === 0 || i === 64) return start;
      const a = a0 + i * TAU / 64;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });
  }
  const rx = Math.max(Math.abs(dx), 4) / Math.SQRT2;
  const ry = Math.max(Math.abs(dy), 4) / Math.SQRT2;
  const a0 = Math.atan2((start[1] - cy) / ry, (start[0] - cx) / rx);
  return Array.from({length: 65}, (_, i) => {
    if (i === 0 || i === 64) return start;
    const a = a0 + i * TAU / 64;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}
