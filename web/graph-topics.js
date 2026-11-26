const COMMON = new Set((
  "about and the for with that this from are was were have has into use used not can all more will " +
  "one new some your you their when here which what there other then also each how over than such " +
  "bir bu shu uchun va ham bilan yoki orqali kerak qilib haqida narsa boshqa kabi sifatida bor edi " +
  "moc home main index vault mundarija asosiy umumiy notes note qayd qaydlar file fayl fayllar knowledge " +
  "concepts tushunchalar inbox misc general attachment attachments assets media screenshot img image pdf " +
  "png jpg jpeg jpeg doc docx txt md mdm mindmap zip chapter page section untitled import new sample"
).split(" "));

const LANDING = /^(?:home|index|vault[\s_-]+mundarijasi|mundarija|index[\s_-]+of[\s_-]+notes)$/i;
const DIRECTORY = /^(?:\d+[ ._-]*)?(?:documents?|obsidian|knowledge|notes?|concepts?|learning|main|projects?|qaydlar|fayllar|asosiy|general|assets|attachments?)$/i;
const ANCHOR = /^(?:moc|00)[\s_.-]+(.+)$/i;
export const UNCLASSIFIED = "Unclassified";
const ORDER = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function topicWords(value) {
  return (String(value || "").normalize("NFKC").toLowerCase().replace(/['’‘ʻʼ]/g, "")
    .match(/[\p{L}][\p{L}\p{N}]*/gu) || []).filter(word => word.length > 1 && !COMMON.has(word));
}

function topicKey(label) {
  return topicWords(label).join(" ");
}

function folderTopic(item) {
  const dirs = (item.path || "").split("/").slice(0, -1).filter(Boolean);
  const label = dirs.reverse().find(name => !DIRECTORY.test(name) && topicKey(name));
  return label || "";
}

function tagTopics(item) {
  return (item.tags || []).filter(tag => !DIRECTORY.test(tag) && topicKey(tag));
}

function addFeatures(weights, values, weight) {
  for (const word of new Set(values)) weights.set(word, Math.max(weight, weights.get(word) || 0));
}

export function neighborhood(edges, origin, depth) {
  const seen = new Set();
  if (!origin || depth < 0) return seen;
  seen.add(origin);
  const neighbors = new Map();
  for (const [a, b] of edges) {
    if (!neighbors.has(a)) neighbors.set(a, []);
    if (!neighbors.has(b)) neighbors.set(b, []);
    neighbors.get(a).push(b);
    neighbors.get(b).push(a);
  }
  let frontier = [origin];
  for (let step = 0; step < depth && frontier.length; step++) {
    const next = [];
    for (const node of frontier) {
      for (const item of neighbors.get(node) || []) {
        if (seen.has(item)) continue;
        seen.add(item);
        next.push(item);
      }
    }
    frontier = next;
  }
  return seen;
}

/** Assign vault-wide topics before search, focus, file toggles and render sampling. */
export function classifyTopics(notes, files, edges) {
  const entries = [...notes, ...files].sort((a, b) => ORDER(a.id, b.id));
  const items = new Map(entries.map(item => [item.id, item]));
  const neighbors = new Map(entries.map(item => [item.id, new Set()]));
  const anchors = new Map();
  const assignments = new Map();
  const landing = new Set(notes.filter(item => LANDING.test(item.title.trim())).map(item => item.id));
  const titleAnchors = new Map();
  const suggestions = new Map();
  const features = new Map();
  const documentFreq = new Map();

  for (const [a, b] of edges) {
    if (!items.has(a) || !items.has(b) || a === b || landing.has(a) || landing.has(b)) continue;
    neighbors.get(a).add(b);
    neighbors.get(b).add(a);
  }
  for (const item of files) {
    if (!items.has(item.noteId) || landing.has(item.noteId)) continue;
    neighbors.get(item.id).add(item.noteId);
    neighbors.get(item.noteId).add(item.id);
  }
  for (const item of entries) {
    const folder = folderTopic(item);
    const tags = tagTopics(item);
    const title = item.kind === "file" ? item.title.replace(/\.[^.]+$/, "") : item.title;
    const marker = item.kind !== "file" && ANCHOR.exec(title);
    if (marker && topicKey(marker[1])) titleAnchors.set(item.id, marker[1].trim());
    for (const label of new Set([...tags, folder].filter(Boolean))) {
      const key = topicKey(label);
      if (!key) continue;
      if (!suggestions.has(key)) suggestions.set(key, {label, ids: new Set()});
      if (item.kind !== "file") suggestions.get(key).ids.add(item.id);
    }
    const weights = new Map();
    addFeatures(weights, topicWords(title), 5);
    addFeatures(weights, tags.flatMap(topicWords), 6);
    addFeatures(weights, topicWords(folder), 3);
    addFeatures(weights, (item.topicTerms || []).flatMap(topicWords), 2);
    addFeatures(weights, topicWords(item.preview).slice(0, 24), 1);
    features.set(item.id, weights);
    for (const word of weights.keys()) documentFreq.set(word, (documentFreq.get(word) || 0) + 1);
  }

  function register(label, isAnchor) {
    const key = topicKey(label);
    if (!anchors.has(key) || isAnchor && !anchors.get(key).isAnchor) anchors.set(key, {label, isAnchor});
    return key;
  }
  for (const [id, label] of titleAnchors) assignments.set(id, register(label, true));
  for (const {label, ids} of suggestions.values()) {
    if (ids.size >= 2) register(label, false);
  }
  const termsToGroups = new Map();
  for (const key of anchors.keys()) {
    for (const term of key.split(" ")) {
      if (!termsToGroups.has(term)) termsToGroups.set(term, []);
      termsToGroups.get(term).push(key);
    }
  }
  const countNotes = notes.length;
  const content = new Map();
  for (const item of entries) {
    if (landing.has(item.id) || assignments.has(item.id)) continue;
    const scores = new Map();
    for (const [word, value] of features.get(item.id)) {
      const options = termsToGroups.get(word) || [];
      if (options.length > 16) continue;
      for (const key of options) {
        const exactAnchor = key === word && anchors.get(key).isAnchor;
        const weight = value * (exactAnchor ? 2 : 1) / Math.sqrt(Math.max(1, options.length));
        scores.set(key, (scores.get(key) || 0) + weight);
      }
    }
    for (const label of tagTopics(item)) {
      const key = topicKey(label);
      if (anchors.has(key)) scores.set(key, (scores.get(key) || 0) + 8);
    }
    const folder = topicKey(folderTopic(item));
    if (anchors.has(folder)) scores.set(folder, (scores.get(folder) || 0) + 2);
    content.set(item.id, scores);
  }

  for (let pass = 0; pass < 4; pass++) {
    const next = new Map(assignments);
    for (const item of entries) {
      if (landing.has(item.id) || titleAnchors.has(item.id)) continue;
      const scores = new Map(content.get(item.id));
      for (const id of neighbors.get(item.id)) {
        const group = assignments.get(id);
        if (!group) continue;
        const degree = neighbors.get(id).size;
        const weight = titleAnchors.has(id) ? 18 : item.noteId === id ? 16 :
          Math.max(0.4, 4 / Math.sqrt(Math.max(1, degree) / 3));
        scores.set(group, (scores.get(group) || 0) + weight);
      }
      const ranked = [...scores].sort((a, b) => b[1] - a[1] || ORDER(a[0], b[0]));
      if (ranked[0]?.[1] >= 3.9) next.set(item.id, ranked[0][0]);
    }
    for (const [id, key] of next) assignments.set(id, key);
  }

  const candidates = entries.filter(item => !landing.has(item.id));
  const signatures = new Map();
  const postings = new Map();
  const maxFrequency = Math.min(48, Math.max(5, Math.ceil(countNotes * 0.32)));
  for (const item of candidates) {
    const terms = [...features.get(item.id)].filter(([word]) => {
      const freq = documentFreq.get(word);
      return freq >= 2 && freq <= maxFrequency;
    }).sort((a, b) => b[1] - a[1] || documentFreq.get(a[0]) - documentFreq.get(b[0]) || ORDER(a[0], b[0])).slice(0, 12);
    signatures.set(item.id, new Map(terms));
    for (const [term] of terms) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push(item.id);
    }
  }

  function similarNotes(item) {
    const related = new Map();
    for (const [word, value] of signatures.get(item.id)) {
      for (const id of postings.get(word)) {
        if (id === item.id) continue;
        const match = related.get(id) || {score: 0, shared: 0};
        match.score += Math.min(value, signatures.get(id).get(word));
        match.shared++;
        related.set(id, match);
      }
    }
    return [...related].filter(([, evidence]) => (evidence.score >= 4 && evidence.shared >= 2) || evidence.score >= 5);
  }

  const pending = candidates.filter(item => !assignments.has(item.id));
  const similar = new Map(pending.map(item => [item.id, similarNotes(item)]));
  for (let pass = 0; pass < 2; pass++) {
    const inferred = new Map();
    for (const item of pending) {
      if (assignments.has(item.id)) continue;
      const scores = new Map();
      for (const [id, evidence] of similar.get(item.id)) {
        const key = assignments.get(id);
        if (!key) continue;
        scores.set(key, (scores.get(key) || 0) + evidence.score);
      }
      const top = [...scores].sort((a, b) => b[1] - a[1] || ORDER(a[0], b[0]));
      if (top[0] && (!top[1] || top[0][1] > top[1][1] * 1.12)) inferred.set(item.id, top[0][0]);
    }
    for (const [id, key] of inferred) assignments.set(id, key);
    if (!inferred.size) break;
  }

  const ungrouped = pending.filter(item => item.kind !== "file")
    .sort((a, b) => neighbors.get(b.id).size - neighbors.get(a.id).size || ORDER(a.id, b.id));
  for (const item of ungrouped) {
    if (assignments.has(item.id)) continue;
    const matching = new Set(similar.get(item.id).map(([id]) => id));
    for (const id of neighbors.get(item.id)) matching.add(id);
    for (const id of matching) {
      if (assignments.has(id) || items.get(id).kind === "file") matching.delete(id);
    }
    if (!matching.size) continue;
    const preferred = [...[...matching].map(id => items.get(id)), item]
      .sort((a, b) => neighbors.get(b.id).size - neighbors.get(a.id).size || a.title.length - b.title.length || ORDER(a.id, b.id))[0];
    const key = "cluster:" + preferred.id;
    anchors.set(key, {label: preferred.title});
    assignments.set(item.id, key);
    for (const id of matching) assignments.set(id, key);
  }
  for (const item of files) {
    if (landing.has(item.noteId)) {
      assignments.delete(item.id);
      continue;
    }
    const owner = assignments.get(item.noteId);
    if (items.has(item.noteId)) {
      if (owner) assignments.set(item.id, owner);
      else assignments.delete(item.id);
      continue;
    }
    if (assignments.has(item.id)) continue;
    const related = [...neighbors.get(item.id)].map(id => assignments.get(id)).filter(Boolean);
    if (related.length) assignments.set(item.id, related.sort(ORDER)[0]);
  }

  const result = new Map();
  for (const item of entries) {
    const key = assignments.get(item.id);
    if (key) result.set(item.id, {key, label: anchors.get(key).label, anchor: titleAnchors.has(item.id)});
    else if (landing.has(item.id) || (item.kind === "file" && landing.has(item.noteId))) {
      result.set(item.id, {key: "index", label: "Index", anchor: landing.has(item.id)});
    }
    else result.set(item.id, {key: "unsorted", label: UNCLASSIFIED, anchor: false});
  }
  return result;
}
