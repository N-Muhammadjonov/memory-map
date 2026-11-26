function noteAdjacency(nodes, edges) {
  const links = new Map(nodes.map(note => [note.id, new Set()]));
  for (const [a, b] of edges) {
    if (a !== b && links.has(a) && links.has(b)) {
      links.get(a).add(b);
      links.get(b).add(a);
    }
  }
  return links;
}

export function orphanNotes(nodes, edges) {
  const links = noteAdjacency(nodes, edges);
  return nodes.filter(note => !note.locked && links.get(note.id).size === 0);
}

export function suggestNoteLinks(id, nodes, edges, limit = 5) {
  const current = nodes.find(note => note.id === id && !note.locked);
  if (!current) return [];
  const linked = noteAdjacency(nodes, edges).get(id);
  const mapText = values => new Map((values || []).map(value => [value.toLocaleLowerCase(), value]));
  const tags = mapText(current.tags);
  const terms = mapText(current.topicTerms);
  return nodes.flatMap(item => {
    if (item.id === id || item.locked || linked.has(item.id)) return [];
    const tagMatches = [...mapText(item.tags).keys()].filter(key => tags.has(key)).map(key => "#" + tags.get(key));
    const termMatches = [...mapText(item.topicTerms).keys()].filter(key => terms.has(key) && !tags.has(key))
      .map(key => terms.get(key));
    if (!tagMatches.length && termMatches.length < 2) return [];
    return [{item, evidence: [...tagMatches, ...termMatches].slice(0, 4),
      score: tagMatches.length * 3 + termMatches.length}];
  }).sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title)).slice(0, limit);
}
