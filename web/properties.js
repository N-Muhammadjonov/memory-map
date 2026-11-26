function scalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value.replace(/[ \t]+#.*$/, "");
}

function entries(source) {
  const fields = [];
  let active = null;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const field = line.match(/^([^\s:[\]{}][^:]*):(?:[ \t]+(.*)|[ \t]*)$/);
    const item = line.match(/^\s+-[ \t]+(.*)$/);
    if (field) {
      const raw = field[2] || "";
      const grouped = raw.match(/^\[(.*)\]\s*(?:#.*)?$/);
      const values = grouped ? (grouped[1].match(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+/g) || []) : [raw];
      active = {key: scalar(field[1]), values: values.map(scalar).filter(Boolean), list: Boolean(grouped), block: /^[|>][-+]?$/.test(raw)};
      if (active.block) active.values.length = 0;
      fields.push(active);
    } else if (active && item) {
      active.list = true;
      active.values.push(scalar(item[1]));
    } else if (active?.block && /^\s/.test(line)) {
      active.values.push(line.trim());
    }
  }
  return fields;
}

export function renderProperties(target, source) {
  const fragment = document.createDocumentFragment();
  for (const {key, values, list, block} of entries(source)) {
    const name = document.createElement("dt");
    name.textContent = key;
    const value = document.createElement("dd");
    if ((key === "tags" || list) && values.length) {
      value.className = "property-values";
      for (const text of values) {
        const chip = document.createElement("span");
        chip.textContent = text;
        value.append(chip);
      }
    } else if (values.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(values[0])) {
      const date = document.createElement("time");
      date.dateTime = values[0];
      const [year, month, day] = values[0].split("-");
      date.textContent = [day, month, year].join("/");
      value.append(date);
    } else {
      value.textContent = values.join(block ? "\n" : " ") || "—";
    }
    fragment.append(name, value);
  }
  target.replaceChildren(fragment);
}
