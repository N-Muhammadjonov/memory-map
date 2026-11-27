import {Marked} from "./vendor/marked.mjs";
import {renderCode, renderFlowchart, renderMath} from "./note-renderers.js";
import {readStoredInlineStyle} from "./inline-format.js";

const WIKI = /^(!?)\[\[([^\[\]\n|#]*?)(?:#([^\[\]\n|]*?))?(?:\\?\|([^\[\]\n]*))?\]\]/;
const FRONTMATTER = /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)^((?:---|\.\.\.)[ \t]*(?:\r?\n|$))/m;
const CALLOUT_TYPES = {
  note: {label: "Note", icon: "📝", cls: "callout-note"},
  info: {label: "Info", icon: "ℹ️", cls: "callout-info"},
  tip: {label: "Tip", icon: "💡", cls: "callout-tip"},
  success: {label: "Success", icon: "✅", cls: "callout-tip"},
  warning: {label: "Warning", icon: "⚠️", cls: "callout-warning"},
  caution: {label: "Caution", icon: "⚠️", cls: "callout-warning"},
  danger: {label: "Important", icon: "🔥", cls: "callout-danger"},
  bug: {label: "Bug", icon: "🐞", cls: "callout-danger"},
  example: {label: "Example", icon: "📌", cls: "callout-example"},
  quote: {label: "Quote", icon: "💬", cls: "callout-quote"},
};

const parser = new Marked({gfm: true, extensions: [{
  name: "xotiraLink",
  level: "inline",
  start(source) { return source.search(/!?\[\[/); },
  tokenizer(source) {
    const match = source.match(WIKI);
    if (!match || (!match[2] && !match[3])) return undefined;
    return {type: "xotiraLink", raw: match[0], name: match[2].trim(), heading: match[3], label: match[4]};
  },
  renderer(token) { return token.raw; },
}, {
  name: "highlight",
  level: "inline",
  start(source) { return source.indexOf("=="); },
  tokenizer(source) {
    const match = source.match(/^==([^\n=][^=\n]*?)==/);
    if (match) return {type: "highlight", raw: match[0], text: match[1]};
    return undefined;
  },
  renderer(token) { return token.raw; },
}, {
  name: "mmInlineStyle",
  level: "inline",
  start(source) { return source.search(/<(?:span data-mm-size=|mark data-mm-hl=)/); },
  tokenizer(source) {
    const style = readStoredInlineStyle(source);
    if (!style) return undefined;
    return {type:"mmInlineStyle",raw:style.raw,style:style.type,value:style.value,tokens:this.lexer.inlineTokens(style.inner)};
  },
  renderer(token) { return token.raw; },
}, {
  name: "inlineTag",
  level: "inline",
  start(source) { return source.search(/(?:^|\s)#[\p{L}\p{N}_/-]{2,36}/u); },
  tokenizer(source) {
    const match = source.match(/^#([\p{L}\p{N}_/-]{2,36})(?![\p{L}\p{N}_/-])/u);
    if (match) return {type: "inlineTag", raw: match[0], tag: match[1]};
    return undefined;
  },
  renderer(token) { return token.raw; },
}, {
  name: "mathBlock",
  level: "block",
  start(source) { return source.search(/^ {0,3}\$\$/m); },
  tokenizer(source) {
    const match = source.match(/^ {0,3}\$\$[ \t]*([\s\S]*?)\$\$[ \t]*(?:\n|$)/);
    if (match) return {type: "mathBlock", raw: match[0], text: match[1].trim()};
    return undefined;
  },
  renderer(token) { return token.raw; },
}, {
  name: "mathInline",
  level: "inline",
  start(source) { return source.indexOf("$"); },
  tokenizer(source) {
    const match = source.match(/^\$(?![$\s])((?:\\[^\n]|[^$\n])+?)\$(?![$\d])/);
    if (match && !/\s$/.test(match[1])) return {type: "mathInline", raw: match[0], text: match[1]};
    return undefined;
  },
  renderer(token) { return token.raw; },
}]});

function make(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

function action(label, run, className = "inline-link") {
  const control = make("button", label);
  control.type = "button";
  control.className = className;
  control.addEventListener("click", run);
  return control;
}

function taskOffsets(source, tokens, offset) {
  const result = new Map();
  let cursor = 0;
  for (const token of tokens) {
    const start = source.indexOf(token.raw, cursor);
    if (start < 0) continue;
    cursor = start + token.raw.length;
    if (token.type !== "list" && token.type !== "blockquote") continue;
    const tasks = [];
    const visit = value => {
      if (value.type === "list_item" && value.task) tasks.push(value);
      for (const child of value.items || value.tokens || []) visit(child);
    };
    visit(token);
    const matches = [...token.raw.matchAll(/^(?:[ \t]*>[ \t]?)*[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/gm)];
    if (matches.length !== tasks.length || !tasks.every((task, index) => task.checked === (matches[index][1] !== " "))) continue;
    tasks.forEach((item, index) => {
      const match = matches[index];
      result.set(item, offset + start + match.index + match[0].lastIndexOf("[") + 1);
    });
  }
  return result;
}

export function splitFrontmatter(source) {
  const metadata = source.match(FRONTMATTER);
  if (metadata?.index !== 0) return null;
  const first = metadata[2].split(/\r?\n/).find(line => line.trim() && !/^\s*#/.test(line));
  if (first && !/^[^\s:[\]{}][^:\n]*:(?:\s|$)/.test(first)) return null;
  return {prefix: metadata[0], start: metadata[1], raw: metadata[2], end: metadata[3]};
}

export function frontmatterLength(source) {
  return splitFrontmatter(source)?.prefix.length || 0;
}

export function extractOutline(source) {
  const offset = frontmatterLength(source);
  const body = source.slice(offset);
  const headings = [];
  let fence = "";
  for (const line of body.split(/\r?\n/)) {
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      if (!fence) fence = open[1];
      else if (open[1].startsWith(fence)) fence = "";
      continue;
    }
    if (fence) continue;
    const m = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/);
    if (m) headings.push({level: m[1].length, text: m[2].replace(/[ \t]+#+$/, "").replace(/[*_`~]/g, "").trim()});
  }
  return headings;
}

export function renderMarkdown(source, links) {
  const offset = frontmatterLength(source);
  const body = source.slice(offset);
  const tokens = parser.lexer(body);
  let mathCount = 0;
  const tasks = links.toggleTask ? taskOffsets(body, tokens, offset) : new Map();
  const target = document.createDocumentFragment();
  const append = (parent, tokens = []) => {
    for (const token of tokens) {
      const node = create(token);
      if (node) parent.append(node);
    }
    return parent;
  };

  function internalLink(kind, reference, label, heading = "") {
    if (!reference && heading) return action(label || heading, () => links.jump(heading));
    const match = links.resolve(kind, reference);
    if (match?.file) return action(label || match.file.name, () => links.openFile(match.file));
    if (match?.note) return action(label || match.note.title, () => links.openNote(match.note, heading));
    return null;
  }

  function renderCallout(token) {
    const first = token.tokens?.[0];
    if (!first || first.type !== "paragraph") return null;
    const rawText = first.text || "";
    const m = rawText.match(/^\[!([a-zA-Z]+)\]([+-])?[ \t]*([^\n]*)(?:\n([\s\S]*))?$/);
    if (!m) return null;
    const typeKey = m[1].toLowerCase();
    const spec = CALLOUT_TYPES[typeKey] || CALLOUT_TYPES.note;
    const foldable = m[2];
    const titleText = (m[3] || "").trim() || spec.label;
    const restFirst = (m[4] || "").trim();

    const wrapper = make(foldable ? "details" : "aside");
    wrapper.className = `callout ${spec.cls}`;
    if (foldable === "+") wrapper.open = true;

    const head = make(foldable ? "summary" : "div");
    head.className = "callout-title";
    const icon = make("span", spec.icon);
    icon.className = "callout-icon";
    head.append(icon, document.createTextNode(" " + titleText));
    wrapper.append(head);

    const content = make("div");
    content.className = "callout-body";
    if (restFirst) content.append(renderMarkdown(restFirst, links));
    for (const child of token.tokens.slice(1)) {
      const node = create(child);
      if (node) content.append(node);
    }
    wrapper.append(content);
    return wrapper;
  }

  function create(token) {
    if (links.untrusted) {
      if (["xotiraLink", "image", "link"].includes(token.type)) return make("span", token.label || token.text || token.raw);
      if (token.type === "code") return make("pre", token.text);
      if (["mathInline", "mathBlock"].includes(token.type)) return make("span", token.raw);
    }
    switch (token.type) {
      case "space":
      case "checkbox": return null;
      case "paragraph": return append(make("p"), token.tokens);
      case "heading": return append(make(`h${token.depth}`), token.tokens);
      case "strong": return append(make("strong"), token.tokens);
      case "em": return append(make("em"), token.tokens);
      case "del": return append(make("del"), token.tokens);
      case "highlight": return make("mark", token.text);
      case "mmInlineStyle": {
        const node = make(token.style === "size" ? "span" : "mark");
        if (token.style === "size") node.dataset.mmSize = token.value;
        else node.dataset.hl = token.value;
        return append(node, token.tokens);
      }
      case "inlineTag": {
        const chip = make("span", "#" + token.tag);
        chip.className = "md-tag";
        if (links.filterTag) {
          chip.tabIndex = 0;
          chip.role = "button";
          chip.addEventListener("click", () => links.filterTag(token.tag));
        }
        return chip;
      }
      case "blockquote": return renderCallout(token) || append(make("blockquote"), token.tokens);
      case "codespan": return make("code", token.text);
      case "mathInline":
      case "mathBlock": return mathCount++ < 100 ? renderMath(token.text, token.type === "mathBlock") : make("span", token.raw);
      case "code": {
        const language = (token.lang || "").trim().split(/\s+/, 1)[0].toLowerCase();
        return (language === "mermaid" && renderFlowchart(token.text)) || renderCode(token.text, language);
      }
      case "hr": return make("hr");
      case "br": return make("br");
      case "escape":
      case "html": return document.createTextNode(token.text);
      case "text": {
        return token.tokens?.length
          ? append(document.createDocumentFragment(), token.tokens)
          : document.createTextNode(token.text);
      }
      case "xotiraLink": {
        const file = token.raw.startsWith("!") && links.resolve("wiki", token.name)?.file;
        if (file && links.embedImage) return links.embedImage(file, token.label || file.name);
        const resolved = internalLink("wiki", token.name, token.label, token.heading);
        if (resolved) {
          resolved.classList.add("wiki-pill");
          return resolved;
        }
        const ghost = make("span", token.label || token.name || token.raw);
        ghost.className = "wiki-unresolved";
        ghost.title = `Missing note: ${token.name}`;
        if (links.createNote) {
          ghost.style.cursor = "pointer";
          ghost.addEventListener("click", () => links.createNote(token.name));
        }
        return ghost;
      }
      case "link":
      case "image": {
        const file = token.type === "image" && links.resolve("md", token.href)?.file;
        if (file && links.embedImage) return links.embedImage(file, token.text || file.name);
        const fragment = token.href.indexOf("#");
        const heading = fragment < 0 ? "" : token.href.slice(fragment + 1);
        const match = internalLink("md", token.href, token.text, heading);
        if (match) return match;
        if (token.type === "link" && /^https?:\/\//i.test(token.href)) {
          const anchor = make("a", token.text || token.href);
          anchor.href = token.href;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          return anchor;
        }
        return make("span", token.text || token.href);
      }
      case "list": {
        const list = make(token.ordered ? "ol" : "ul");
        if (token.ordered && token.start > 1) list.start = token.start;
        for (const item of token.items) {
          const row = make("li");
          if (item.task) {
            row.className = item.checked ? "task-item is-done" : "task-item";
            const check = make("input");
            check.type = "checkbox";
            check.checked = item.checked;
            const position = tasks.get(item);
            check.disabled = position === undefined;
            if (position !== undefined) check.dataset.offset = String(position);
            check.setAttribute("aria-label", item.checked ? "Completed task" : "Open task");
            check.addEventListener("change", () => links.toggleTask(position, check.checked));
            row.append(check);
          }
          append(row, item.tokens);
          list.append(row);
        }
        return list;
      }
      case "table": {
        const scroll = make("div");
        scroll.className = "markdown-table-scroll";
        const table = make("table");
        const head = make("thead");
        const header = make("tr");
        for (const [index, item] of token.header.entries()) {
          const cell = append(make("th"), item.tokens);
          if (token.align[index]) cell.dataset.align = token.align[index];
          header.append(cell);
        }
        head.append(header);
        const bodyEl = make("tbody");
        for (const items of token.rows) {
          const row = make("tr");
          for (const [index, item] of items.entries()) {
            const cell = append(make("td"), item.tokens);
            if (token.align[index]) cell.dataset.align = token.align[index];
            row.append(cell);
          }
          bodyEl.append(row);
        }
        table.append(head, bodyEl);
        scroll.append(table);
        return scroll;
      }
      default: return document.createTextNode(token.raw || "");
    }
  }

  return append(target, tokens);
}
