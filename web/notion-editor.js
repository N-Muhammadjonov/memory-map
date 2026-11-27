import {saveBlob} from "./native-downloads.js";
import {t} from "./i18n.js";
import {applyInlineStyle, exitHighlightAtCaret, restoreEscapedInlineStyles, storedSize, storedHighlight, FONT_SIZE_POINTS} from "./inline-format.js";
/**
 * Xotira v8 Unified Rich Document Editor (True Notion + Obsidian Experience)
 * - Single unified contentEditable surface:
 *   * Select across MULTIPLE paragraphs, headings, lists, or whole document (⌘A) seamlessly!
 *   * Press Backspace at the start of ANY paragraph/heading to merge seamlessly onto the previous line!
 *   * Native Undo/Redo (⌘Z / ⌘⇧Z) and multi-block Copy/Paste!
 * - Auto-links bare URLs (https://t.me/learners_area) into real clickable links!
 * - Real text highlight (<mark>) + crisp ::selection highlight!
 * - Live markdown shortcuts (# , ## , ### , - , 1. , [] , > , ---) + floating Bubble Menu + `/` Slash Menu + `[[` Wikilinks
 * - Interactive Editable Tables (+Row/+Column), Checkboxes, Toggles, Callouts, Code, Math, Mermaid!
 */

import {renderFlowchart, renderMath} from "./note-renderers.js";
import {canRunLanguage, copyCode, COPY_ICON, detectLanguage, DOWNLOAD_ICON, languageExtension,
  languageName, pastedFence, readEditableCode, snippetStatus} from "./code-tools.js";

const SLASH_ITEMS = [
  {id: "p", icon: "T", label: "Text", desc: "Paragraph"},
  {id: "h1", icon: "H1", label: "Heading 1", desc: "Large heading"},
  {id: "h2", icon: "H2", label: "Heading 2", desc: "Medium heading"},
  {id: "h3", icon: "H3", label: "Heading 3", desc: "Small heading"},
  {id: "todo", icon: "☑", label: "To-do", desc: "Checklist item"},
  {id: "ul", icon: "•", label: "Bulleted list", desc: "Bulleted list"},
  {id: "ol", icon: "1.", label: "Numbered list", desc: "Ordered list"},
  {id: "toggle", icon: "▸", label: "Toggle block", desc: "Collapsible block"},
  {id: "callout", icon: "!", label: "Callout", desc: "Highlighted note"},
  {id: "blockquote", icon: "“", label: "Quote", desc: "Block quote"},
  {id: "table", icon: "⊞", label: "Table", desc: "Editable table"},
  {id: "code", icon: "</>", label: "Code block", desc: "Programming snippet"},
  {id: "hr", icon: "—", label: "Divider", desc: "Horizontal rule"},
];

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CODE_KEYWORDS = new Set([
  // Python / JS / TS / Go / Rust / Java / C++
  "def", "class", "import", "from", "as", "return", "yield", "async", "await", "if", "elif", "else",
  "for", "while", "break", "continue", "try", "except", "finally", "with", "lambda", "pass", "raise",
  "and", "or", "not", "in", "is", "global", "nonlocal", "del", "assert", "match", "case",
  "const", "let", "var", "function", "export", "default", "new", "throw", "catch", "switch", "typeof",
  "instanceof", "interface", "type", "enum", "extends", "implements", "public", "private", "protected",
  "static", "readonly", "void", "fn", "pub", "struct", "impl", "trait", "mod", "use", "mut", "package",
  "func", "defer", "go", "chan", "select", "include", "namespace", "template", "auto", "virtual",
  // Nginx / Config
  "server", "http", "events", "upstream", "listen", "location", "server_name", "ssl_protocols",
  "ssl_prefer_server_ciphers", "ssl_ciphers", "ssl_certificate", "ssl_certificate_key", "add_header",
  "proxy_pass", "proxy_set_header", "client_body_timeout", "client_header_timeout", "keepalive_timeout",
  "send_timeout", "client_max_body_size", "limit_req_zone", "limit_req", "root", "index", "always",
  "error_page", "access_log", "error_log", "worker_processes", "worker_connections", "gzip", "rewrite",
  // SQL
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "ALTER",
  "DROP", "TABLE", "INDEX", "VIEW", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "ORDER", "BY",
  "GROUP", "HAVING", "LIMIT", "OFFSET", "DISTINCT", "UNION", "PRIMARY", "KEY", "FOREIGN", "REFERENCES",
  "NOT", "AND", "OR", "AS", "EXISTS", "CASCADE", "DEFAULT", "UNIQUE", "CONSTRAINT", "BEGIN", "COMMIT",
  // Shell / CLI / DevOps / Security
  "sh", "bash", "zsh", "sudo", "curl", "wget", "git", "python3", "python", "pip", "pip3", "npm", "npx",
  "node", "docker", "docker-compose", "kubectl", "systemctl", "service", "cd", "ls", "ll", "cat", "grep",
  "awk", "sed", "find", "echo", "export", "source", "chmod", "chown", "mkdir", "rm", "cp", "mv", "tar",
  "zip", "unzip", "ssh", "scp", "rsync", "openssl", "nmap", "dig", "nslookup", "ss", "netstat", "ufw",
  "iptables", "tcpdump", "whois", "nc", "ncat", "hydra", "sqlmap", "gobuster", "ffuf", "nikto", "uvicorn",
  "pytest", "nginx", "certbot", "psql", "sqlite3", "redis-cli", "tail", "head", "kill", "ps", "top", "htop",
]);

const CODE_BUILTINS = new Set([
  "str", "int", "float", "bool", "list", "dict", "set", "tuple", "bytes", "object", "len", "print",
  "range", "open", "super", "isinstance", "enumerate", "zip", "map", "filter", "sorted", "min", "max",
  "sum", "any", "all", "type", "id", "dir", "vars", "getattr", "setattr", "hasattr", "Exception",
  "ValueError", "TypeError", "KeyError", "RuntimeError", "Promise", "Array", "Object", "Map", "Set",
  "Math", "JSON", "Date", "RegExp", "Error", "console", "document", "window", "fetch", "localStorage",
  "FastAPI", "APIRouter", "Request", "Response", "HTTPException", "Depends", "BaseModel", "Field",
  "Path", "Query", "Header", "Cookie", "BackgroundTasks", "CORSMiddleware", "VARCHAR", "INTEGER",
  "TEXT", "BOOLEAN", "TIMESTAMP", "SERIAL", "UUID", "JSONB", "BIGINT", "NUMERIC",
]);

const CODE_BOOLEANS = new Set([
  "True", "False", "None", "true", "false", "null", "undefined", "NaN", "Infinity", "on", "off", "yes", "no",
]);

const CODE_VARS = new Set(["self", "cls", "this", "arguments", "process", "env"]);

/** VS Code One Dark Pro / PyCharm multi-color syntax highlighter (12 vivid token classes, 100% offline). */
export function highlightCode(source, lang = "") {
  const tokenRx = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|@[A-Za-z_][A-Za-z0-9_.]*|<\/?[A-Za-z][A-Za-z0-9-]*|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|(?:^|(?<=[\s(,]))--?[A-Za-z][A-Za-z0-9_-]*|\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:ms|s|m|h|d|K|M|G|px|rem|em|%)?\b|\b[A-Za-z_][A-Za-z0-9_-]*\b|===|!==|==|!=|<=|>=|=>|->|&&|\|\||::)/g;
  let out = "";
  let last = 0;
  for (const m of source.matchAll(tokenRx)) {
    if (m.index > last) out += escapeHtml(source.slice(last, m.index));
    const tok = m[0];
    const esc = escapeHtml(tok);
    const nextChar = source[m.index + tok.length] || "";
    const prevChar = m.index > 0 ? source[m.index - 1] : "";

    if (tok.startsWith("#") || tok.startsWith("//") || tok.startsWith("/*")) {
      out += `<span class="tok-com">${esc}</span>`;
    } else if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith("`")) {
      // JSON / Object key ("key":) gets cyan property color!
      if (nextChar === ":" || /^\s*:/.test(source.slice(m.index + tok.length, m.index + tok.length + 4))) {
        out += `<span class="tok-prop">${esc}</span>`;
      } else {
        out += `<span class="tok-str">${esc}</span>`;
      }
    } else if (tok.startsWith("@") || (tok.startsWith("-") && tok.length > 1 && /[A-Za-z]/.test(tok[1]))) {
      out += `<span class="tok-dec">${esc}</span>`;
    } else if (tok.startsWith("<")) {
      out += `<span class="tok-tag">${esc}</span>`;
    } else if (tok.startsWith("$") || CODE_VARS.has(tok)) {
      out += `<span class="tok-var">${esc}</span>`;
    } else if (/^(?:===|!==|==|!=|<=|>=|=>|->|&&|\|\||::)$/.test(tok)) {
      out += `<span class="tok-op">${esc}</span>`;
    } else if (/^\d|^0x/i.test(tok)) {
      out += `<span class="tok-num">${esc}</span>`;
    } else if (CODE_BOOLEANS.has(tok)) {
      out += `<span class="tok-bool">${esc}</span>`;
    } else if (CODE_KEYWORDS.has(tok) || CODE_KEYWORDS.has(tok.toUpperCase())) {
      out += `<span class="tok-kw">${esc}</span>`;
    } else if (CODE_BUILTINS.has(tok) || (/^[A-Z][A-Za-z0-9_]+$/.test(tok) && /[a-z]/.test(tok))) {
      out += `<span class="tok-cls">${esc}</span>`;
    } else if (nextChar === "(") {
      out += `<span class="tok-fn">${esc}</span>`;
    } else if (nextChar === ":" || prevChar === ".") {
      out += `<span class="tok-prop">${esc}</span>`;
    } else {
      out += esc;
    }
    last = m.index + tok.length;
  }
  if (last < source.length) out += escapeHtml(source.slice(last));
  return out;
}

const CODE_COLLAPSE_MIN_LINES = 20;

function closeCodeSidePanel() {
  const existing = document.getElementById("xotira-code-side-panel");
  if (!existing) return;
  existing._cleanup?.();
  existing.remove();
}

function openCodeSidePanel({language, lineCount, codeHtml, source}) {
  closeCodeSidePanel();
  const root = document.createElement("div");
  root.id = "xotira-code-side-panel";
  root.className = "code-side-panel-root";
  const backdrop = document.createElement("button");
  backdrop.type = "button";
  backdrop.className = "code-side-panel-backdrop";
  backdrop.setAttribute("aria-label", "Close code side panel");
  backdrop.addEventListener("click", closeCodeSidePanel);
  const drawer = document.createElement("aside");
  drawer.className = "code-side-panel-drawer";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-label", "Code side panel");
  const head = document.createElement("div");
  head.className = "code-side-panel-header";
  const title = document.createElement("div");
  title.innerHTML = `<strong>${escapeHtml(languageName(language))}</strong><span class="code-side-panel-meta">${lineCount} lines</span>`;
  const actions = document.createElement("div");
  actions.className = "code-side-panel-actions";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "n-code-btn";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(source); copyBtn.textContent = "Copied"; }
    catch { copyBtn.textContent = "Failed"; }
    setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = "Copy"; }, 1200);
  });
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "n-code-btn";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeCodeSidePanel);
  actions.append(copyBtn, closeBtn);
  head.append(title, actions);
  const pre = document.createElement("pre");
  pre.className = "n-code code-side-panel-code";
  const code = document.createElement("code");
  code.innerHTML = codeHtml;
  pre.append(code);
  drawer.append(head, pre);
  root.append(backdrop, drawer);
  const onKey = event => { if (event.key === "Escape") closeCodeSidePanel(); };
  document.addEventListener("keydown", onKey);
  root._cleanup = () => document.removeEventListener("keydown", onKey);
  document.body.append(root);
  closeBtn.focus();
}

export function buildCodeCardHtml(declared, rawCode) {
  const safe = /^[a-z0-9_+.-]{1,32}$/i.test(declared) ? declared : "";
  const language = detectLanguage(rawCode, safe);
  const lineCount = rawCode ? rawCode.split("\n").length : 1;
  const foldable = lineCount >= CODE_COLLAPSE_MIN_LINES;
  return `<div class="n-code-box${foldable ? " is-foldable" : ""}" data-lang="${escapeHtml(safe)}" data-detected-lang="${language}">
  <div class="n-code-bar" contenteditable="false">
    <div class="n-code-left"><span class="n-code-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="n-code-title">${languageName(language)}</span><span class="n-code-lines">${lineCount} lines</span></div>
    <div class="n-code-btns">
      <button type="button" class="n-code-btn" data-cact="fold"${foldable ? "" : " hidden"} title="Collapse or expand code">Collapse</button>
      <button type="button" class="n-code-btn" data-cact="sidepanel"${foldable ? "" : " hidden"} title="View code in side panel">Side panel</button>
      <button type="button" class="n-code-btn n-code-run" data-cact="run" hidden title="Run code">Run</button>
      <button type="button" class="n-code-btn n-code-icon" data-cact="download" title="Download code" aria-label="Download code">${DOWNLOAD_ICON}</button>
      <button type="button" class="n-code-btn n-code-icon" data-cact="copy" title="Copy code" aria-label="Copy code">${COPY_ICON}</button>
      <span class="sr-only" aria-live="polite" data-code-feedback></span>
    </div>
  </div><pre class="n-code"><code>${highlightCode(rawCode, language) || "<br>"}</code></pre><pre class="n-code-output" contenteditable="false" aria-live="polite" hidden></pre></div>`;
}

function syncCodeCard(box, rehighlight = false) {
  const element = box.querySelector(".n-code code");
  const source = readEditableCode(element);
  const language = detectLanguage(source, box.dataset.lang);
  const lineCount = source ? source.split("\n").length : 1;
  const foldable = lineCount >= CODE_COLLAPSE_MIN_LINES;
  box.dataset.detectedLang = language;
  box.classList.toggle("is-foldable", foldable);
  if (!foldable) box.classList.remove("is-collapsed");
  box.querySelector(".n-code-title").textContent = languageName(language);
  const linesBadge = box.querySelector(".n-code-lines");
  if (linesBadge) linesBadge.textContent = `${lineCount} lines`;
  const foldBtn = box.querySelector('[data-cact="fold"]');
  if (foldBtn) {
    foldBtn.hidden = !foldable;
    foldBtn.textContent = box.classList.contains("is-collapsed") ? "Expand" : "Collapse";
  }
  const sideBtn = box.querySelector('[data-cact="sidepanel"]');
  if (sideBtn) sideBtn.hidden = !foldable;
  if (rehighlight) element.innerHTML = highlightCode(source, language) || "<br>";
  return {source, language, lineCount};
}

function markdownFence(language, codeText) {
  const runs = codeText.match(/`+/g) || [];
  const length = runs.reduce((max, run) => Math.max(max, run.length + 1), 3);
  const fence = "`".repeat(length);
  return `${fence}${language}
${codeText.replace(/\n$/, "")}
${fence}`;
}

/** Inline Markdown -> Rich HTML with auto-linked bare URLs, wikilinks, bold, italic, mark, code. */
export function inlineMdToHtml(md) {
  let s = escapeHtml(md);
  const slots = [];
  const stash = html => {
    const idx = slots.push(html) - 1;
    return `\u0000S${idx}\u0000`;
  };

  // 1. Inline code
  s = s.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${code}</code>`));

  s = restoreEscapedInlineStyles(s, stash);

  // 2. Wikilinks [[Target|Label]] or [[Target]]
  s = s.replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
    const display = label || target;
    return stash(`<span class="wiki-chip" contenteditable="false" data-wiki="${target}">${display}</span>`);
  });

  // 3. Explicit Markdown links [text](url)
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (markup, label, href) => {
    if (/^https?:\/\//i.test(href)) {
      return stash(`<a href="${href}" data-href="${href}" class="notion-link" target="_blank" rel="noopener noreferrer">${label}</a>`);
    }
    if (/^(?:xotira:|attachment:)/i.test(href) || (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//"))) {
      return stash(`<a href="#" data-href="${href}" class="notion-link">${label}</a>`);
    }
    return stash(markup);
  });

  // 4. Bare URLs (e.g., https://t.me/learners_area) -> real clickable links!
  s = s.replace(/\b(https?:\/\/[^\s<>"'`]+?)([.,;:!?)]*)(?=\s|$)/gi, (_, url, trail) => {
    return stash(`<a href="${url}" data-href="${url}" class="notion-link" target="_blank" rel="noopener noreferrer">${url}</a>`) + trail;
  });

  // 5. Formatting
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  s = s.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");

  // Restore stashed tokens
  const restore = (value, limit) => value.replace(/\u0000S(\d+)\u0000/g, (_, i) => Number(i) < limit ? restore(slots[Number(i)] || "", Number(i)) : "");
  return restore(s, slots.length);
}

const MIND_MAP_LINK = /^\[Mind map\]\(attachment:([0-9a-f]{32}) "Mind map"\)\s*$/;
const CONTINUATION_BLOCK = ".n-code-box, .n-mermaid, .n-math, .n-table-wrap, details.n-toggle, hr, .n-mind-slot:not([hidden])";
const SYMBOL_SHORTCUTS = {
  "<=>": "⇔", "<->": "↔", "==>": "⇒", "<==": "⇐",
  "=>": "⇒", "->": "→", "<-": "←",
  "<=": "≤", ">=": "≥", "!=": "≠", "+/-": "±",
  "(tm)": "™", "(c)": "©", "(r)": "®", "(p)": "℗",
  "1/2": "½", "1/4": "¼", "3/4": "¾",
  "...": "…", "---": "—", "--": "–",
};

function emptyParagraph(document) {
  const paragraph = document.createElement("p");
  paragraph.append(document.createElement("br"));
  return paragraph;
}

function addContinuation(block) {
  let paragraph = block.nextElementSibling;
  if (paragraph?.tagName !== "P") {
    paragraph = emptyParagraph(block.ownerDocument);
    block.after(paragraph);
  }
  paragraph.classList.add("n-block-continuation");
  paragraph.classList.toggle("is-continuation-empty", !paragraph.textContent);
  return paragraph;
}

/** Convert Markdown document into clean semantic HTML inside one unified editable surface. */
export function markdownToDocHtml(markdown) {
  if (!markdown || !markdown.trim()) return "<p><br></p>";
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Code fence -> VS Code / PyCharm colored card with Copy & Download
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2].trim().split(/\s+/)[0] || "";
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].match(new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`))) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const rawBlock = buf.join("\n");
      if (lang.toLowerCase() === "mermaid") {
        html.push(`<div class="n-mermaid" contenteditable="false" data-mermaid="${escapeHtml(rawBlock)}"></div>`);
        continue;
      }
      html.push(buildCodeCardHtml(lang, rawBlock));
      continue;
    }

    // Math block $$ ... $$
    if (/^ {0,3}\$\$/.test(line)) {
      const same = line.match(/^ {0,3}\$\$(.+)\$\$\s*$/);
      let expr = "";
      if (same) { expr = same[1].trim(); i++; }
      else {
        const buf = [];
        i++;
        while (i < lines.length && !/^ {0,3}\$\$\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) i++;
        expr = buf.join("\n").trim();
      }
      const holder = document.createElement("div");
      holder.append(renderMath(expr, true));
      html.push(`<div class="n-math" contenteditable="false" data-math="${escapeHtml(expr)}">${holder.innerHTML}</div>`);
      continue;
    }

    // <details> Toggle block
    if (/^<details/i.test(line.trim())) {
      const buf = [line];
      i++;
      while (i < lines.length && !/<\/details>/i.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) { buf.push(lines[i]); i++; }
      const joined = buf.join("\n");
      const sumM = joined.match(/<summary>([\s\S]*?)<\/summary>/i);
      const summary = sumM ? sumM[1].trim() : "Toggle block";
      const inner = joined.replace(/^<details[^>]*>/i, "").replace(/<\/details>\s*$/i, "").replace(/<summary>[\s\S]*?<\/summary>/i, "").trim();
      html.push(`<details class="n-toggle" open><summary>${inlineMdToHtml(summary)}</summary><button type="button" class="n-block-del" data-bact="delete" contenteditable="false" title="Delete block" aria-label="Delete block">×</button><div class="n-toggle-inner">${inlineMdToHtml(inner) || "<br>"}</div></details>`);
      continue;
    }

    // Headings
    const hMatch = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/);
    if (hMatch) {
      const lvl = hMatch[1].length;
      html.push(`<h${lvl}>${inlineMdToHtml(hMatch[2].replace(/[ \t]+#+$/, ""))}</h${lvl}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^ {0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      html.push(`<hr>`);
      i++;
      continue;
    }

    // GFM Table
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      const parseRow = r => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
      const rows = [parseRow(line)];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) { rows.push(parseRow(lines[i])); i++; }
      const cols = Math.max(...rows.map(r => r.length), 2);
      const trs = rows.map((r, rIdx) => {
        const tag = rIdx === 0 ? "th" : "td";
        const tds = Array.from({length: cols}, (_, c) => `<${tag}>${inlineMdToHtml(r[c] || "")}</${tag}>`).join("");
        return `<tr>${tds}</tr>`;
      }).join("");
      html.push(`<div class="n-table-wrap"><table class="n-table"><tbody>${trs}</tbody></table><div class="n-table-actions" contenteditable="false"><button type="button" class="n-mini-btn" data-tact="row">+ Row</button><button type="button" class="n-mini-btn" data-tact="del-row">- Row</button><button type="button" class="n-mini-btn" data-tact="col">+ Column</button><button type="button" class="n-mini-btn" data-tact="del-col">- Column</button><button type="button" class="n-mini-btn danger" data-tact="del-table">× Delete</button></div></div>`);
      continue;
    }

    // Callout / Blockquote
    if (/^ {0,3}>/.test(line)) {
      const qLines = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        qLines.push(lines[i].replace(/^ {0,3}>\s?/, ""));
        i++;
      }
      const cm = qLines[0].match(/^\[!([a-zA-Z]+)\][+-]?\s*(.*)$/);
      if (cm) {
        const text = [cm[2].trim(), ...qLines.slice(1)].filter(Boolean).join("<br>");
        html.push(`<blockquote class="n-callout" data-callout="${escapeHtml(cm[1].toLowerCase())}">${inlineMdToHtml(text.replace(/<br>/g, "\n")).replace(/\n/g, "<br>")}</blockquote>`);
      } else {
        html.push(`<blockquote>${qLines.map(inlineMdToHtml).join("<br>")}</blockquote>`);
      }
      continue;
    }

    // Task list
    if (/^\s*[-+*]\s+\[([ xX])\]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-+*]\s+\[([ xX])\]\s+/.test(lines[i])) {
        const m = lines[i].match(/^\s*[-+*]\s+\[([ xX])\]\s+(.*)$/);
        const checked = m[1] !== " ";
        items.push(`<li class="n-todo${checked ? " is-done" : ""}"><input type="checkbox"${checked ? " checked" : ""} contenteditable="false"><span>${inlineMdToHtml(m[2])}</span></li>`);
        i++;
      }
      html.push(`<ul class="n-todo-list">${items.join("")}</ul>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-+*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-+*]\s+/.test(lines[i]) && !/^\s*[-+*]\s+\[[ xX]\]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMdToHtml(lines[i].replace(/^\s*[-+*]\s+/, ""))}</li>`);
        i++;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMdToHtml(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
        i++;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Standalone attachment image
    const imgMatch = line.match(/^!\[([^\]]*)\]\((attachment:[0-9a-f]{32})\)\s*$/);
    if (imgMatch) {
      html.push(`<div class="n-img-slot" contenteditable="false" data-img-src="${escapeHtml(imgMatch[2])}" data-img-alt="${escapeHtml(imgMatch[1])}"></div>`);
      i++;
      continue;
    }

    const mindMap = line.match(MIND_MAP_LINK);
    if (mindMap) {
      html.push(`<div class="n-mind-slot" contenteditable="false" data-map-id="${mindMap[1]}" hidden></div>`);
      i++;
      continue;
    }

    // Paragraph
    const pLines = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !MIND_MAP_LINK.test(lines[i]) &&
      !/^!\[[^\]]*\]\(attachment:[0-9a-f]{32}\)\s*$/.test(lines[i]) &&
      !/^(?:`{3,}|~{3,}|\$\$| {0,3}#{1,6}\s|>|---+|\*\*\*+|___+|<details|\s*[-+*]\s+|\s*\d+[.)]\s+)/i.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1]))
    ) {
      pLines.push(lines[i]);
      i++;
    }
    html.push(`<p>${pLines.map(inlineMdToHtml).join("<br>")}</p>`);
  }

  return html.join("") || "<p><br></p>";
}

/** Serialize inline DOM nodes back to clean Markdown. */
function inlineDomToMd(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\u00a0/g, " ");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "input") return "";
  if (node.classList?.contains("wiki-chip")) {
    const target = node.dataset.wiki || node.textContent;
    const label = node.textContent;
    return label && label !== target ? `[[${target}|${label}]]` : `[[${target}]]`;
  }
  const inner = Array.from(node.childNodes).map(inlineDomToMd).join("");
  if (tag === "strong" || tag === "b") return inner ? `**${inner}**` : "";
  if (tag === "em" || tag === "i") return inner ? `*${inner}*` : "";
  if (tag === "s" || tag === "del" || tag === "strike") return inner ? `~~${inner}~~` : "";
  if (tag === "mark") return storedHighlight(node.dataset.hl, inner);
  if (tag === "span" && node.dataset.mmSize) return storedSize(node.dataset.mmSize, inner);
  if (tag === "code") return inner ? `\`${inner}\`` : "";
  if (tag === "a") {
    const href = node.dataset.href || node.getAttribute("href") || "";
    if (!href) return inner;
    // Keep bare URLs clean if label === href
    if (/^https?:\/\//i.test(href) && inner.trim() === href.trim()) return href;
    return `[${inner}](${href})`;
  }
  return inner;
}

/** Serialize the unified contentEditable document back to Obsidian-compatible Markdown. */
export function docDomToMarkdown(root) {
  const blocks = [];
  for (const child of root.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = child.textContent.trim();
      if (t) blocks.push(t);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName.toLowerCase();

    if (/^h[1-6]$/.test(tag)) blocks.push(`${"#".repeat(Number(tag[1]))} ${inlineDomToMd(child).trim()}`);
    else if (tag === "hr") blocks.push("---");
    else if (child.classList.contains("n-mermaid")) {
      blocks.push(markdownFence("mermaid", child.dataset.mermaid || ""));
    } else if (child.classList.contains("n-code-box")) {
      const codeText = readEditableCode(child.querySelector(".n-code code"));
      blocks.push(markdownFence(child.dataset.lang || "", codeText));
    } else if (tag === "pre") {
      blocks.push(markdownFence(child.dataset.lang || "", child.textContent));
    } else if (child.classList.contains("n-math")) {
      blocks.push(`$$\n${child.dataset.math || ""}\n$$`);
    } else if (child.classList.contains("n-mind-slot")) {
      blocks.push(`[Mind map](attachment:${child.dataset.mapId} "Mind map")`);
    } else if (child.classList.contains("n-img-slot")) {
      blocks.push(`![${child.dataset.imgAlt ?? "Image"}](${child.dataset.imgSrc || ""})`);
    } else if (tag === "details") {
      const sum = child.querySelector("summary");
      const inner = child.querySelector(".n-toggle-inner");
      blocks.push(`<details>\n<summary>${sum ? inlineDomToMd(sum).trim() : "Section"}</summary>\n\n${inner ? inlineDomToMd(inner).trim() : ""}\n</details>`);
    } else if (child.classList.contains("n-table-wrap") || tag === "table") {
      const table = tag === "table" ? child : child.querySelector("table");
      if (table) {
        const trs = Array.from(table.querySelectorAll("tr"));
        const rows = trs.map(tr => Array.from(tr.children).map(cell => inlineDomToMd(cell).replace(/\n/g, " ").trim()));
        if (rows.length) {
          const cols = Math.max(...rows.map(r => r.length), 1);
          const pad = r => Array.from({length: cols}, (_, i) => r[i] || "");
          const h = "| " + pad(rows[0]).join(" | ") + " |";
          const sep = "| " + Array(cols).fill("---").join(" | ") + " |";
          const body = rows.slice(1).map(r => "| " + pad(r).join(" | ") + " |");
          blocks.push([h, sep, ...body].join("\n"));
        }
      }
    } else if (tag === "blockquote") {
      const lines = inlineDomToMd(child).split("\n");
      const kind = child.dataset.callout;
      if (kind) {
        const first = `> [!${kind}] ${lines[0] || ""}`.trimEnd();
        const rest = lines.slice(1).map(l => `> ${l}`);
        blocks.push([first, ...rest].join("\n"));
      } else {
        blocks.push(lines.map(l => `> ${l}`).join("\n"));
      }
    } else if (tag === "ul" || tag === "ol") {
      const lines = [];
      let num = 1;
      for (const li of child.querySelectorAll(":scope > li")) {
        const cb = li.querySelector('input[type="checkbox"]');
        if (cb) {
          const span = li.querySelector("span") || li;
          lines.push(`- [${cb.checked ? "x" : " "}] ${inlineDomToMd(span).trim()}`);
        } else if (tag === "ol") {
          lines.push(`${num++}. ${inlineDomToMd(li).trim()}`);
        } else {
          lines.push(`- ${inlineDomToMd(li).trim()}`);
        }
      }
      if (lines.length) blocks.push(lines.join("\n"));
    } else {
      const text = inlineDomToMd(child).replace(/\n+$/, "");
      if (text.trim()) blocks.push(text);
    }
  }
  return blocks.join("\n\n");
}

function isImageSlot(node) {
  return node?.classList?.contains("n-img-slot") === true;
}

export function ensureImageBoundaries(root) {
  for (const slot of root.querySelectorAll(":scope > .n-img-slot")) {
    for (const [sibling, insert] of [["previousElementSibling", "before"], ["nextElementSibling", "after"]]) {
      let paragraph = slot[sibling];
      if (paragraph?.tagName !== "P") {
        paragraph = root.ownerDocument.createElement("p");
        const placeholder = root.ownerDocument.createElement("br");
        placeholder.dataset.imagePlaceholder = "";
        paragraph.append(placeholder);
        slot[insert](paragraph);
      }
      paragraph.classList.add("n-image-boundary");
      const empty = !paragraph.textContent.trim();
      paragraph.classList.toggle("is-empty", empty);
      if (!empty) paragraph.querySelector(":scope > br[data-image-placeholder]")?.remove();
    }
  }
  for (const paragraph of root.querySelectorAll(":scope > .n-image-boundary")) {
    if (!isImageSlot(paragraph.previousElementSibling) && !isImageSlot(paragraph.nextElementSibling)) {
      paragraph.classList.remove("n-image-boundary", "is-empty");
    }
  }
}

function closestBlock(node, root) {
  let cur = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (cur && cur.parentElement && cur.parentElement !== root) cur = cur.parentElement;
  return cur && cur.parentElement === root ? cur : null;
}

export class NotionEditor {
  constructor(container, slashPopover, bubbleBar, options) {
    this.container = container;
    this.popover = slashPopover;
    this.bubble = bubbleBar;
    this.bubbleRange = null;
    this.lastHighlightSpace = null;
    this.getNotes = options.getNotes;
    this.onOpenLink = options.onOpenLink;
    this.onChange = options.onChange;
    this.onHistoryChange = options.onHistoryChange || null;
    this.resolveImage = options.resolveImage;
    this.getMindMaps = options.getMindMaps;
    this.openAI = options.openAI;
    this.runCode = options.runCode;
    this.checkCode = options.checkCode;
    this.codeRuns = new WeakMap();
    this.codeChecks = new WeakMap();
    this.undoStack = [];
    this.redoStack = [];
    this.lastMarkdown = "";

    this.readOnly = false;
    this.menuState = null;

    this.doc = document.createElement("div");
    this.doc.className = "notion-doc";
    this.doc.contentEditable = "true";
    this.doc.spellcheck = Boolean(options.spellcheck);
    if (options.spellcheck) this.doc.lang = "en";
    this.doc.dataset.placeholder = "Start writing or type “/” for blocks…";

    // Notion-style floating block gutter (+ insert below, ⋮⋮ drag/move/duplicate/delete)
    this.hoveredBlock = null;
    this.gutter = document.createElement("div");
    this.gutter.className = "block-gutter";
    this.gutter.hidden = true;
    this.gutter.innerHTML = `<button type="button" class="gutter-btn" data-gact="add" title="Add a block below">+</button><button type="button" class="gutter-btn" data-gact="menu" draggable="true" title="Move or manage block">⋮⋮</button>`;
    this.gutterMenu = document.createElement("div");
    this.gutterMenu.className = "gutter-menu";
    this.gutterMenu.hidden = true;
    this.gutterMenu.innerHTML = `
      <button type="button" data-bm="up">↑ Move up</button>
      <button type="button" data-bm="down">↓ Move down</button>
      <button type="button" data-bm="dup">⧉ Duplicate</button>
      <button type="button" data-bm="del" class="danger">× Delete</button>`;

    this.container.replaceChildren(this.gutter, this.gutterMenu, this.doc);
    this.setupBlockGutter();
    this.setupBubbleBar();

    this.doc.addEventListener("input", e => {
      if (this.readOnly || e.isComposing || e.target.closest(".n-mind-slot")) return;
      this.syncEmptyCaret();
      const anchor = window.getSelection()?.anchorNode;
      const element = anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
      const box = element?.closest?.(".n-code-box") || e.target.closest?.(".n-code-box");
      if (box) {
        this.codeRuns.delete(box);
        box.querySelector(".n-code-output").hidden = true;
        const run = box.querySelector('[data-cact="run"]');
        run.disabled = false;
        run.textContent = "Run";
        syncCodeCard(box);
        this.emit();
        return;
      }
      this.tryLiveShortcuts();
      this.checkInlineTriggers();
      this.emit();
    });

    this.doc.addEventListener("compositionstart", e => {
      if (e.target !== this.doc) return;
      this.composing = true;
      this.syncEmptyCaret();
    });
    this.doc.addEventListener("compositionend", e => {
      if (e.target !== this.doc) return;
      this.composing = false;
      this.syncEmptyCaret();
      if (!this.readOnly) this.emit();
    });
    this.doc.addEventListener("keydown", e => this.handleKeyDown(e));
    this.doc.addEventListener("click", event => {
      if (this.readOnly || event.target.closest("button")) return;
      const slot = event.target.closest(".n-img-slot");
      if (!slot || slot.parentElement !== this.doc) return;
      const rect = slot.getBoundingClientRect();
      this.doc.focus({preventScroll: true});
      if (event.clientY < rect.top + rect.height / 2) this.placeCaretAtEnd(slot.previousElementSibling);
      else this.placeCaretAtStart(slot.nextElementSibling);
    });

    this.doc.addEventListener("focus", () => this.syncEmptyCaret());
    this.doc.addEventListener("blur", () => this.setEmptyCaret(null));
    this.doc.addEventListener("focusout", e => {
      if (this.readOnly || this.doc.contains(e.relatedTarget)) return;
      for (const box of this.doc.querySelectorAll(".n-code-box")) syncCodeCard(box, true);
    });

    // Clean paste: plain text in code blocks; auto-link bare URLs in normal text
    this.doc.addEventListener("paste", e => {
      if (this.readOnly || e.target.closest(".n-mind-slot")) return;
      const text = e.clipboardData?.getData("text/plain");
      if (text == null) return;
      const sel = window.getSelection();
      const anchorEl = sel?.anchorNode?.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel?.anchorNode;
      if (anchorEl?.closest?.(".n-code-box pre")) {
        e.preventDefault();
        document.execCommand("insertText", false, text);
        this.emit();
        return;
      }
      const pasted = pastedFence(text);
      if (pasted && this.doc.contains(anchorEl)) {
        e.preventDefault();
        const selectedBlock = closestBlock(anchorEl, this.doc);
        const holder = document.createElement("template");
        holder.innerHTML = buildCodeCardHtml(pasted.language, pasted.source);
        const card = holder.content.firstElementChild;
        if (selectedBlock?.tagName === "P" && !selectedBlock.textContent.trim()) selectedBlock.replaceWith(card);
        else if (selectedBlock) selectedBlock.after(card);
        else this.doc.append(card);
        this.placeCaretAtEnd(card.querySelector("code"));
        this.emit();
        return;
      }
      if (/^https?:\/\/\S+$/i.test(text.trim())) {
        e.preventDefault();
        const url = text.trim();
        const safe = escapeHtml(url);
        document.execCommand("insertHTML", false, `<a href="${safe}" data-href="${safe}" class="notion-link" target="_blank" rel="noopener noreferrer">${safe}</a>&nbsp;`);
        this.emit();
      }
    });

    // Click handlers for links, wikilinks, checkboxes, table +Row/+Col
    this.doc.addEventListener("click", e => {
      if (e.target.closest(".n-mind-slot")) return;
      const chip = e.target.closest(".wiki-chip");
      if (chip) {
        e.preventDefault();
        this.onOpenLink("wiki", chip.dataset.wiki || chip.textContent);
        return;
      }
      const link = e.target.closest("a.notion-link");
      if (link) {
        e.preventDefault();
        const href = link.dataset.href || link.getAttribute("href") || "";
        if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
        else this.onOpenLink("md", href);
        return;
      }
      const cb = e.target.closest('li.n-todo input[type="checkbox"]');
      if (cb) {
        cb.closest("li")?.classList.toggle("is-done", cb.checked);
        this.emit();
        return;
      }
      const bact = e.target.closest("[data-bact='delete']");
      if (bact && !this.readOnly) {
        e.preventDefault();
        e.stopPropagation();
        const blk = closestBlock(bact, this.doc);
        if (blk) this.deleteBlock(blk);
        return;
      }
      const cact = e.target.closest("[data-cact]");
      if (cact) {
        e.preventDefault();
        const box = cact.closest(".n-code-box");
        if (!box) return;
        const {source, language, lineCount} = syncCodeCard(box);
        if (cact.dataset.cact === "fold") {
          const collapsed = box.classList.toggle("is-collapsed");
          cact.textContent = collapsed ? "Expand" : "Collapse";
        } else if (cact.dataset.cact === "sidepanel") {
          openCodeSidePanel({
            language,
            lineCount,
            codeHtml: highlightCode(source, language),
            source,
          });
        } else if (cact.dataset.cact === "copy") {
          void copyCode(source, cact, box.querySelector("[data-code-feedback]"));
        } else if (cact.dataset.cact === "run" && this.runCode && this.codeIsReady(box, source, language)) {
          void this.runSnippet(box, cact, source, language);
        } else if (cact.dataset.cact === "download") {
          const blob = new Blob([source], {type: "text/plain;charset=utf-8"});
          void saveBlob(blob, `snippet.${languageExtension(language)}`).catch(error => {
            const feedback = box.querySelector("[data-code-feedback]");
            if (feedback) feedback.textContent = error.message;
          });
        }
        return;
      }
      const tact = e.target.closest("[data-tact]");
      if (tact && !this.readOnly) {
        e.preventDefault();
        const wrap = tact.closest(".n-table-wrap");
        const table = wrap?.querySelector("table");
        if (!table) return;
        const rows = table.querySelectorAll("tr");
        const act = tact.dataset.tact;
        if (act === "row") {
          const cols = rows[0]?.children.length || 2;
          const tr = document.createElement("tr");
          for (let c = 0; c < cols; c++) tr.append(document.createElement("td"));
          (table.querySelector("tbody") || table).append(tr);
        } else if (act === "del-row") {
          if (rows.length > 1) rows[rows.length - 1].remove();
          else { this.deleteBlock(wrap); return; }
        } else if (act === "col") {
          rows.forEach((tr, rIdx) => {
            const cell = document.createElement(rIdx === 0 ? "th" : "td");
            if (rIdx === 0) cell.textContent = `Column ${tr.children.length + 1}`;
            tr.append(cell);
          });
        } else if (act === "del-col") {
          const cols = rows[0]?.children.length || 0;
          if (cols > 1) rows.forEach(tr => tr.lastElementChild?.remove());
          else { this.deleteBlock(wrap); return; }
        } else if (act === "del-table") {
          this.deleteBlock(wrap);
          return;
        }
        this.emit();
      }
    });

    this.isMouseSelecting = false;
    this.bubbleTimer = 0;

    this.doc.addEventListener("mousedown", e => {
      this.lastHighlightSpace = null;
      if (e.target.closest(".n-mind-slot")) return;
      this.isMouseSelecting = true;
      this.bubble.hidden = true;
    });
    document.addEventListener("mouseup", () => {
      if (!this.isMouseSelecting) return;
      this.isMouseSelecting = false;
      clearTimeout(this.bubbleTimer);
      this.bubbleTimer = setTimeout(() => this.updateBubble(), 25);
    });
    document.addEventListener("selectionchange", () => {
      this.syncEmptyCaret();
      if (this.isMouseSelecting) {
        this.bubble.hidden = true;
        return;
      }
      clearTimeout(this.bubbleTimer);
      this.bubbleTimer = setTimeout(() => this.updateBubble(), 140);
    });
    document.addEventListener("click", e => {
      if (this.menuState && !this.popover.contains(e.target)) this.closeMenu();
      if (!this.bubble.hidden && !this.bubble.contains(e.target) && !this.doc.contains(e.target)) {
        this.bubble.hidden = true;
      }
    });
  }

  deleteBlock(blk) {
    if (!blk || this.readOnly) return;
    if (blk.classList.contains("n-mind-slot")) return;
    if (this.doc.children.length > 1) blk.remove();
    else {
      const p = document.createElement("p");
      p.innerHTML = "<br>";
      blk.replaceWith(p);
    }
    this.hoveredBlock = null;
    this.gutter.hidden = true;
    this.emit();
  }

  setupBlockGutter() {
    let draggedBlock = null;
    let hideTimer = 0;
    const trashTargets = [document.getElementById("trash"), document.getElementById("trash-drop-zone")].filter(Boolean);
    const clearHide = () => { clearTimeout(hideTimer); hideTimer = 0; };
    const scheduleHide = () => {
      clearHide();
      hideTimer = setTimeout(() => {
        if (this.gutterMenu.hidden && !draggedBlock) this.gutter.hidden = true;
      }, 180);
    };
    const setTrashReady = on => {
      for (const el of trashTargets) {
        el.classList.toggle("is-drop-ready", on);
        if (!on) el.classList.remove("is-drop-target");
      }
    };

    this.doc.addEventListener("mousemove", e => {
      if (this.readOnly) { this.gutter.hidden = true; return; }
      clearHide();
      const blk = closestBlock(e.target, this.doc);
      if (!blk) return;
      this.hoveredBlock = blk;
      const hostRect = this.container.getBoundingClientRect();
      const blkRect = blk.getBoundingClientRect();
      this.gutter.hidden = false;
      this.gutter.style.top = `${blkRect.top - hostRect.top + 2}px`;
    });

    this.gutter.addEventListener("mouseenter", clearHide);
    this.gutterMenu.addEventListener("mouseenter", clearHide);
    this.gutter.addEventListener("mouseleave", scheduleHide);
    this.container.addEventListener("mouseleave", scheduleHide);

    // A press just outside the text (top/side padding of the editor) must still put the caret in the note
    // and start a selection there, instead of silently dropping focus.
    this.container.addEventListener("mousedown", event => {
      if (this.readOnly || event.button !== 0 || this.doc.contains(event.target)) return;
      if (event.target.closest?.(".block-gutter, .gutter-menu, .bubble-bar, .slash-popover, button, a, input, textarea, select")) return;
      const blocks = [...this.doc.children];
      if (!blocks.length) return;
      event.preventDefault();
      this.doc.focus({preventScroll: true});
      const y = event.clientY;
      const hit = blocks.find(block => { const r = block.getBoundingClientRect(); return y >= r.top && y <= r.bottom; });
      if (hit) {
        if (event.clientX < this.doc.getBoundingClientRect().left + 12) this.placeCaretAtStart(hit);
        else this.placeCaretAtEnd(hit);
      } else if (y < blocks[0].getBoundingClientRect().top) this.placeCaretAtStart(blocks[0]);
      else this.placeCaretAtEnd(blocks[blocks.length - 1]);
    });

    this.gutter.addEventListener("mousedown", e => {
      if (e.target.closest('[data-gact="add"]')) e.preventDefault();
    });

    this.gutter.addEventListener("click", e => {
      if (this.readOnly || !this.hoveredBlock) return;
      const btn = e.target.closest("[data-gact]");
      if (!btn) return;
      if (btn.dataset.gact === "add") {
        const p = document.createElement("p");
        p.textContent = "/";
        this.hoveredBlock.after(p);
        this.placeCaretAtEnd(p);
        this.checkInlineTriggers();
        this.emit();
      } else if (btn.dataset.gact === "menu") {
        const map = this.hoveredBlock.classList.contains("n-mind-slot");
        for (const item of this.gutterMenu.querySelectorAll('[data-bm="dup"], [data-bm="del"]')) item.hidden = map;
        const rect = this.gutter.getBoundingClientRect();
        const hostRect = this.container.getBoundingClientRect();
        this.gutterMenu.style.top = `${rect.bottom - hostRect.top + 4}px`;
        this.gutterMenu.style.left = `${rect.left - hostRect.left}px`;
        this.gutterMenu.hidden = !this.gutterMenu.hidden;
      }
    });

    this.gutter.addEventListener("dragstart", e => {
      if (this.readOnly || !this.hoveredBlock) { e.preventDefault(); return; }
      clearHide();
      draggedBlock = this.hoveredBlock;
      draggedBlock.classList.add("is-dragging-blk");
      e.dataTransfer?.setData("text/x-xotira-block", "1");
      e.dataTransfer?.setData("text/plain", "xotira-block");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      setTrashReady(true);
    });

    this.gutter.addEventListener("dragend", () => {
      draggedBlock?.classList.remove("is-dragging-blk");
      draggedBlock = null;
      setTrashReady(false);
      this.doc.querySelectorAll(".blk-drop-target").forEach(el => el.classList.remove("blk-drop-target"));
    });

    for (const target of trashTargets) {
      target.addEventListener("dragover", e => {
        if (!draggedBlock) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        target.classList.add("is-drop-target");
      });
      target.addEventListener("dragleave", () => {
        if (draggedBlock) target.classList.remove("is-drop-target");
      });
      target.addEventListener("drop", e => {
        if (!draggedBlock) return;
        e.preventDefault();
        e.stopPropagation();
        const toDelete = draggedBlock;
        draggedBlock = null;
        setTrashReady(false);
        this.deleteBlock(toDelete);
      });
    }

    this.doc.addEventListener("dragover", e => {
      if (!draggedBlock) return;
      e.preventDefault();
      const target = closestBlock(e.target, this.doc);
      this.doc.querySelectorAll(".blk-drop-target").forEach(el => el.classList.remove("blk-drop-target"));
      if (target && target !== draggedBlock) target.classList.add("blk-drop-target");
    });

    this.doc.addEventListener("drop", e => {
      if (!draggedBlock) return;
      e.preventDefault();
      const target = closestBlock(e.target, this.doc);
      this.doc.querySelectorAll(".blk-drop-target").forEach(el => el.classList.remove("blk-drop-target"));
      if (target && target !== draggedBlock) {
        const rect = target.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) target.before(draggedBlock);
        else target.after(draggedBlock);
        this.emit();
      }
      draggedBlock.classList.remove("is-dragging-blk");
      draggedBlock = null;
      setTrashReady(false);
    });

    this.gutterMenu.addEventListener("click", e => {
      const act = e.target.closest("[data-bm]")?.dataset.bm;
      const blk = this.hoveredBlock;
      this.gutterMenu.hidden = true;
      if (!act || !blk || this.readOnly) return;
      if (act === "up" && blk.previousElementSibling) blk.previousElementSibling.before(blk);
      else if (act === "down" && blk.nextElementSibling) blk.nextElementSibling.after(blk);
      else if (act === "dup" && !blk.classList.contains("n-mind-slot")) blk.after(blk.cloneNode(true));
      else if (act === "del") { this.deleteBlock(blk); return; }
      this.emit();
    });

    document.addEventListener("click", e => {
      if (!this.gutterMenu.hidden && !this.gutterMenu.contains(e.target) && !this.gutter.contains(e.target)) {
        this.gutterMenu.hidden = true;
      }
    });
  }

  setupBubbleBar() {
    this.bubble.addEventListener("mousedown", e => {
      if (e.target.closest("select")) { this.rememberBubbleSelection(); return; }
      e.preventDefault();
    });
    this.bubble.addEventListener("click", e => {
      const btn = e.target.closest("[data-cmd]");
      if (!btn || this.readOnly) return;
      const cmd = btn.dataset.cmd;
      if (cmd === "bold") document.execCommand("bold");
      else if (cmd === "italic") document.execCommand("italic");
      else if (cmd === "underline") document.execCommand("underline");
      else if (cmd === "strike") document.execCommand("strikeThrough");
      else if (cmd === "ai" && this.openAI) {
        const selection = window.getSelection();
        const anchor = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
        this.openAI({action: "rewrite", selection: selection?.toString() || "", anchor});
      }
      else if (cmd === "code") { if (!this.selectionToCodeBlock()) this.toggleInlineWrap("code"); }
      else if (cmd === "inline-code") this.toggleInlineWrap("code");
      else if (cmd === "mark") this.toggleInlineWrap("mark", {hl: "yellow"});
      else if (cmd === "mark-green") this.toggleInlineWrap("mark", {hl: "green"});
      else if (cmd === "mark-blue") this.toggleInlineWrap("mark", {hl: "blue"});
      else if (cmd === "mark-pink") this.toggleInlineWrap("mark", {hl: "pink"});
      else if (cmd === "link") this.wrapSelectionAsLink();
      else if (cmd === "wiki") this.wrapSelectionAsWiki();
      this.emit();
      this.updateBubble();
    });
    const fontPick = this.bubble.querySelector(".bubble-font-size");
    fontPick?.addEventListener("change", () => {
      if (this.readOnly || !fontPick.value) return;
      const value = fontPick.value === "default" ? null : fontPick.value;
      if (value === null || FONT_SIZE_POINTS.includes(Number(value))) {
        this.restoreBubbleSelection();
        if (applyInlineStyle(this.doc, window.getSelection(), "size", value)) this.emit();
      }
      fontPick.value = "";
      this.updateBubble();
    });
    const blockPick = this.bubble.querySelector(".bubble-block-pick");
    blockPick?.addEventListener("change", () => {
      if (this.readOnly || !blockPick.value) return;
      this.restoreBubbleSelection();
      this.toggleBlockTag(blockPick.value);
      blockPick.value = "";
      this.emit();
      this.bubble.hidden = true;
    });
  }

  rememberBubbleSelection() {
    const sel = window.getSelection();
    if (sel?.rangeCount && !sel.isCollapsed && this.doc.contains(sel.getRangeAt(0).startContainer) && this.doc.contains(sel.getRangeAt(0).endContainer)) {
      this.bubbleRange = sel.getRangeAt(0).cloneRange();
    }
  }

  restoreBubbleSelection() {
    const range = this.bubbleRange;
    if (!range || !this.doc.contains(range.startContainer) || !this.doc.contains(range.endContainer)) return;
    this.doc.focus({preventScroll: true});
    const sel = window.getSelection();sel.removeAllRanges();sel.addRange(range);
  }

  // </> in the bubble bar: turn the selected text into a real code block (like the slash menu does),
  // keeping any text before/after the selection as normal paragraphs. Returns false when the selection
  // sits somewhere a block cannot replace (lists, tables, existing code), so the caller can fall back.
  setSpellcheck(on) {
    this.doc.spellcheck = on;
    if (on) this.doc.lang = "en";
    else this.doc.removeAttribute("lang");
  }

  selectionToCodeBlock() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const first = closestBlock(range.startContainer, this.doc);
    const last = closestBlock(range.endContainer, this.doc);
    const plain = /^(P|H[1-6]|BLOCKQUOTE|DIV)$/;
    if (!first || !last || !plain.test(first.tagName) || !plain.test(last.tagName)) return false;
    for (let node = first; ; node = node.nextElementSibling) {
      if (!node || node.classList.contains("n-code-box") || !plain.test(node.tagName)) return false;
      if (node === last) break;
    }
    const fragment = range.cloneContents();
    fragment.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
    const lines = [...fragment.querySelectorAll("p, h1, h2, h3, h4, h5, h6, blockquote, div")]
      .filter(element => !element.querySelector("p, h1, h2, h3, h4, h5, h6, blockquote, div"));
    const text = (lines.length > 1 ? lines.map(element => element.textContent).join("\n") : fragment.textContent)
      .replace(/\u00a0/g, " ").replace(/^\n+|\n+$/g, "");
    if (!text.trim()) return false;
    const leftover = (from, to, source) => {
      const part = document.createRange();
      part.setStart(from[0], from[1]);
      part.setEnd(to[0], to[1]);
      const element = document.createElement(source.tagName.toLowerCase() === "div" ? "p" : source.tagName.toLowerCase());
      element.append(part.cloneContents());
      return element.textContent.trim() ? element : null;
    };
    const beforeEl = leftover([first, 0], [range.startContainer, range.startOffset], first);
    const afterEl = leftover([range.endContainer, range.endOffset], [last, last.childNodes.length], last);
    const holder = document.createElement("template");
    holder.innerHTML = buildCodeCardHtml("", text);
    const card = holder.content.firstElementChild;
    const replaced = [];
    for (let node = first; ; node = node.nextElementSibling) {
      replaced.push(node);
      if (node === last) break;
    }
    first.before(...[beforeEl, card, afterEl].filter(Boolean));
    replaced.forEach(node => node.remove());
    sel.removeAllRanges();
    this.placeCaretAtEnd(card.querySelector("code"));
    return true;
  }

  wrapSelectionAsLink() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;
    const range = sel.getRangeAt(0).cloneRange();
    const url = window.prompt("Enter a link address (https://…)", /^https?:\/\//i.test(text) ? text : "https://");
    if (!url || !/^https?:\/\//i.test(url.trim())) return;
    const a = document.createElement("a");
    a.href = url.trim();
    a.dataset.href = url.trim();
    a.className = "notion-link";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = text;
    range.deleteContents();
    range.insertNode(a);
    sel.removeAllRanges();
  }

  wrapSelectionAsWiki() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;
    const range = sel.getRangeAt(0);
    const chip = document.createElement("span");
    chip.className = "wiki-chip";
    chip.contentEditable = "false";
    chip.dataset.wiki = text;
    chip.textContent = text;
    range.deleteContents();
    range.insertNode(chip);
    const sp = document.createTextNode(" ");
    chip.after(sp);
    sel.removeAllRanges();
  }

  toggleInlineWrap(tagName, dataset = {}) {
    const sel = window.getSelection();
    if (tagName === "mark") { applyInlineStyle(this.doc, sel, "highlight", dataset.hl || "yellow"); return; }
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const parentTag = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;
    const existing = parentTag?.closest?.(tagName);
    if (existing && this.doc.contains(existing)) {
      const sameTone = !dataset.hl || existing.dataset.hl === dataset.hl;
      if (sameTone) {
        const text = document.createTextNode(existing.textContent);
        existing.replaceWith(text);
        const r = document.createRange();
        r.selectNodeContents(text);
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
      Object.assign(existing.dataset, dataset);
      return;
    }
    const el = document.createElement(tagName);
    Object.assign(el.dataset, dataset);
    el.textContent = sel.toString();
    range.deleteContents();
    range.insertNode(el);
    const r = document.createRange();
    r.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  toggleBlockTag(targetTag) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const blk = closestBlock(sel.anchorNode, this.doc);
    if (!blk) return;
    const currentTag = blk.tagName.toLowerCase();
    const nextTag = currentTag === targetTag ? "p" : targetTag;
    const replacement = document.createElement(nextTag);
    replacement.innerHTML = blk.innerHTML || "<br>";
    blk.replaceWith(replacement);
    const r = document.createRange();
    r.selectNodeContents(replacement);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  updateBubble() {
    if (this.bubble.contains(document.activeElement) && document.activeElement?.tagName === "SELECT") return;
    if (this.readOnly || this.isMouseSelecting) { this.bubble.hidden = true; return; }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !this.doc.contains(sel.anchorNode)) {
      this.bubble.hidden = true;
      return;
    }
    if (!sel.toString().trim()) { this.bubble.hidden = true; return; }
    this.rememberBubbleSelection();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.width) { this.bubble.hidden = true; return; }
    this.bubble.hidden = false;
    const barW = this.bubble.offsetWidth || 360;
    const left = Math.max(12, Math.min(window.innerWidth - barW - 12, rect.left + rect.width / 2 - barW / 2));
    const top = Math.max(12, rect.top - (this.bubble.offsetHeight || 38) - 8);
    this.bubble.style.left = `${left}px`;
    this.bubble.style.top = `${top}px`;
  }

  codeIsReady(box, source, language) {
    const check = this.codeChecks.get(box);
    return Boolean(check?.runnable && check.source === source && check.language === language);
  }

  refreshCodeChecks() {
    for (const box of this.doc.querySelectorAll(".n-code-box")) {
      const source = readEditableCode(box.querySelector(".n-code code"));
      const language = detectLanguage(source, box.dataset.lang);
      const previous = this.codeChecks.get(box);
      if (previous?.source === source && previous.language === language) continue;
      clearTimeout(previous?.timer);
      previous?.controller?.abort();

      const run = box.querySelector('[data-cact="run"]');
      const title = box.querySelector(".n-code-title");
      run.hidden = true;
      title.removeAttribute("title");
      const entry = {source, language, runnable: false};
      this.codeChecks.set(box, entry);
      if (!this.runCode || !this.checkCode || !canRunLanguage(language) || !source.trim()
          || new TextEncoder().encode(source).length > 16_384) continue;

      entry.timer = setTimeout(async () => {
        if (!box.isConnected || this.codeChecks.get(box) !== entry) return;
        entry.controller = new AbortController();
        try {
          const result = await this.checkCode(language, source, entry.controller.signal);
          if (!box.isConnected || this.codeChecks.get(box) !== entry) return;
          entry.runnable = result.runnable === true;
          run.hidden = !entry.runnable;
          if (result.reason) title.title = result.reason;
        } catch (error) {
          if (box.isConnected && this.codeChecks.get(box) === entry && error.name !== "AbortError") {
            title.title = "Could not check this code.";
          }
        }
      }, 175);
    }
  }

  async runSnippet(box, button, source, language) {
    if (this.codeRuns.has(box) || !source.trim()) return;
    const token = {};
    this.codeRuns.set(box, token);
    const output = box.querySelector(".n-code-output");
    button.disabled = true;
    button.textContent = "Running…";
    output.hidden = false;
    output.classList.remove("is-error");
    output.textContent = "Running…";
    try {
      const result = await this.runCode(language, source);
      if (!box.isConnected || this.codeRuns.get(box) !== token) return;
      output.textContent = snippetStatus(result);
      output.classList.toggle("is-error", Boolean(result.error));
    } catch (error) {
      if (!box.isConnected || this.codeRuns.get(box) !== token) return;
      output.textContent = error.message || "Could not run the snippet.";
      output.classList.add("is-error");
    } finally {
      if (this.codeRuns.get(box) === token) {
        this.codeRuns.delete(box);
        button.disabled = false;
        button.textContent = "Run";
      }
    }
  }

  setValue(markdown, readOnly = false, {preserveHistory = false} = {}) {
    this.setEmptyCaret(null);
    this.composing = false;
    this.readOnly = readOnly;
    this.doc.contentEditable = String(!readOnly);
    this.bubbleRange = null;
    this.lastHighlightSpace = null;
    this.doc.innerHTML = markdownToDocHtml(markdown);
    this.hydrateImages();
    this.hydrateMermaid();
    this.hydrateMindMaps();
    this.refreshCodeChecks();
    this.closeMenu();
    this.bubble.hidden = true;
    const normalized = this.getValue();
    if (!preserveHistory) {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.lastMarkdown = normalized;
    this.syncEmptyCaret();
    this.onHistoryChange?.();
  }

  canUndo() { return !this.readOnly && this.undoStack.length > 0; }
  canRedo() { return !this.readOnly && this.redoStack.length > 0; }

  undo() {
    if (!this.canUndo()) return;
    const prev = this.undoStack.pop();
    this.redoStack.push(this.lastMarkdown);
    this.setValue(prev, false, {preserveHistory: true});
    this.onChange(prev);
  }

  redo() {
    if (!this.canRedo()) return;
    const next = this.redoStack.pop();
    this.undoStack.push(this.lastMarkdown);
    this.setValue(next, false, {preserveHistory: true});
    this.onChange(next);
  }

  hydrateMermaid() {
    for (const slot of this.doc.querySelectorAll(".n-mermaid")) {
      const source = slot.dataset.mermaid || "";
      const diagram = renderFlowchart(source);
      if (diagram) {
        slot.replaceChildren(diagram);
      } else {
        const holder = document.createElement("div");
        holder.innerHTML = buildCodeCardHtml("mermaid", source);
        const card = holder.firstElementChild;
        if (card) slot.replaceWith(card);
      }
    }
  }

  hydrateImages(source) {
    if (!this.resolveImage) return;
    for (const slot of this.doc.querySelectorAll(".n-img-slot")) {
      if (source && slot.dataset.imgSrc !== source) continue;
      const node = this.resolveImage(slot.dataset.imgSrc, slot.dataset.imgAlt);
      if (node) slot.replaceChildren(node);
    }
  }

  hydrateMindMaps() {
    const maps = new Map(this.getMindMaps?.() || []);
    for (const slot of this.doc.querySelectorAll(":scope > .n-mind-slot")) {
      const card = maps.get(slot.dataset.mapId);
      slot.hidden = !card;
      if (card) {
        if (card.parentElement !== slot) slot.replaceChildren(card);
        maps.delete(slot.dataset.mapId);
      } else if (slot.firstChild) slot.replaceChildren();
    }
    for (const [id, card] of maps) {
      const slot = this.doc.ownerDocument.createElement("div");
      slot.className = "n-mind-slot";
      slot.contentEditable = "false";
      slot.dataset.mapId = id;
      slot.append(card);
      this.doc.append(slot);
    }
    this.ensureBoundaries();
  }

  ensureBoundaries() {
    if (this.readOnly) return;
    ensureImageBoundaries(this.doc);
    for (const block of this.doc.children) {
      if (block.matches(CONTINUATION_BLOCK)) addContinuation(block);
      if (block.classList.contains("n-block-continuation") && !block.previousElementSibling?.matches(CONTINUATION_BLOCK)) {
        block.classList.remove("n-block-continuation", "is-continuation-empty");
      }
    }
  }

  getValue() {
    return docDomToMarkdown(this.doc);
  }

  emit() {
    this.ensureBoundaries();
    this.refreshCodeChecks();
    const next = this.getValue();
    if (next !== this.lastMarkdown) {
      this.undoStack.push(this.lastMarkdown);
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
      this.lastMarkdown = next;
      this.onHistoryChange?.();
    }
    this.onChange(next);
  }

  focusBlock() {
    if (this.readOnly) return;
    this.doc.focus();
    const block = [...this.doc.children].find(item => !item.hidden && item.contentEditable !== "false");
    if (block) this.placeCaretAtStart(block.querySelector(".n-code code") || block);
    this.syncEmptyCaret();
  }

  setEmptyCaret(block) {
    if (this.emptyCaret === block) return;
    this.emptyCaret?.removeAttribute("data-empty-caret");
    this.emptyCaret = block;
    block?.setAttribute("data-empty-caret", "");
  }

  syncEmptyCaret() {
    if (this.readOnly || this.composing || document.activeElement !== this.doc) {
      this.setEmptyCaret(null);
      return;
    }
    const selection = window.getSelection();
    const block = selection?.isCollapsed ? closestBlock(selection.anchorNode, this.doc) : null;
    this.setEmptyCaret(block?.tagName === "P" && !block.textContent ? block : null);
  }

  replaceSymbolShortcut(event, selection) {
    if (this.readOnly || !selection?.isCollapsed || (event.key !== " " && event.key !== "Enter") ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const node = selection.anchorNode;
    if (node?.nodeType !== Node.TEXT_NODE || node.parentElement.closest("a, code, pre, [contenteditable='false']")) return;
    const before = node.textContent.slice(0, selection.anchorOffset);
    if (/(?:^|\s)(?:https?:\/\/|www\.)\S*$/i.test(before)) return;
    const prefix = before.toLowerCase();
    const shortcut = Object.keys(SYMBOL_SHORTCUTS).find(item => prefix.endsWith(item));
    if (!shortcut) return;
    const start = before.length - shortcut.length;
    if (/^[\d(]/.test(shortcut) && /[\p{L}\p{N}/]$/u.test(before.slice(0, start))) return;
    const replacement = document.createRange();
    replacement.setStart(node, start);
    replacement.setEnd(node, before.length);
    selection.removeAllRanges();
    selection.addRange(replacement);
    const symbol = SYMBOL_SHORTCUTS[shortcut];
    if (document.execCommand("insertText", false, symbol)) return;
    replacement.deleteContents();
    replacement.insertNode(document.createTextNode(symbol));
    replacement.collapse(false);
    this.emit();
  }

  tryLiveShortcuts() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const blk = closestBlock(sel.anchorNode, this.doc);
    if (!blk || blk.tagName.toLowerCase() !== "p") return;
    const text = blk.textContent || "";

    const headingMap = [[/^#\s/, "h1"], [/^##\s/, "h2"], [/^###\s/, "h3"], [/^>\s/, "blockquote"]];
    for (const [rx, tag] of headingMap) {
      if (rx.test(text)) {
        const el = document.createElement(tag);
        el.textContent = text.replace(rx, "");
        if (!el.textContent) el.innerHTML = "<br>";
        blk.replaceWith(el);
        this.placeCaretAtStart(el);
        return;
      }
    }
    if (/^[-*]\s/.test(text)) {
      const ul = document.createElement("ul");
      const li = document.createElement("li");
      li.textContent = text.replace(/^[-*]\s/, "");
      if (!li.textContent) li.innerHTML = "<br>";
      ul.append(li);
      blk.replaceWith(ul);
      this.placeCaretAtStart(li);
      return;
    }
    if (/^1\.\s/.test(text)) {
      const ol = document.createElement("ol");
      const li = document.createElement("li");
      li.textContent = text.replace(/^1\.\s/, "");
      if (!li.textContent) li.innerHTML = "<br>";
      ol.append(li);
      blk.replaceWith(ol);
      this.placeCaretAtStart(li);
      return;
    }
    if (/^(?:\[\]|- \[ \])\s/.test(text)) {
      const ul = document.createElement("ul");
      ul.className = "n-todo-list";
      const li = document.createElement("li");
      li.className = "n-todo";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.contentEditable = "false";
      const span = document.createElement("span");
      span.textContent = text.replace(/^(?:\[\]|- \[ \])\s/, "") || "Task";
      li.append(cb, span);
      ul.append(li);
      blk.replaceWith(ul);
      this.placeCaretAtEnd(span);
      return;
    }
    if (/^---\s*$/.test(text)) {
      const hr = document.createElement("hr");
      const next = document.createElement("p");
      next.innerHTML = "<br>";
      blk.replaceWith(hr, next);
      this.placeCaretAtStart(next);
    }
  }

  placeCaretAtStart(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  placeCaretAtEnd(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  handleImageBoundaryKey(event, selection) {
    if (!selection?.isCollapsed || !selection.rangeCount || event.ctrlKey || event.metaKey ||
        event.altKey || event.shiftKey) return false;
    const backwards = ["ArrowUp", "ArrowLeft", "Backspace"].includes(event.key);
    const forward = ["ArrowDown", "ArrowRight", "Delete"].includes(event.key);
    if (!backwards && !forward) return false;
    const block = closestBlock(selection.anchorNode, this.doc);
    if (!block?.classList.contains("n-image-boundary")) return false;
    const image = backwards ? block.previousElementSibling : block.nextElementSibling;
    if (!isImageSlot(image)) return false;
    const edge = selection.getRangeAt(0).cloneRange();
    if (backwards) edge.setStart(block, 0);
    else edge.setEnd(block, block.childNodes.length);
    if (edge.toString()) return false;
    event.preventDefault();
    if (["Backspace", "Delete"].includes(event.key)) {
      const remove = document.createRange();
      remove.selectNode(image);
      selection.removeAllRanges();
      selection.addRange(remove);
      // Native editing records the deletion in the browser's Undo history.
      if (!document.execCommand("delete")) {
        if (backwards) this.placeCaretAtStart(block);
        else this.placeCaretAtEnd(block);
      }
    } else if (backwards) {
      this.placeCaretAtEnd(image.previousElementSibling);
    } else {
      this.placeCaretAtStart(image.nextElementSibling);
    }
    return true;
  }

  handleKeyDown(e) {
    if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) this.lastHighlightSpace = null;
    if (e.isComposing || e.keyCode === 229 || e.target.closest(".n-mind-slot")) return;
    if (this.menuState) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.menuState.selectedIdx = (this.menuState.selectedIdx + 1) % this.menuState.items.length;
        this.renderMenu();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.menuState.selectedIdx = (this.menuState.selectedIdx - 1 + this.menuState.items.length) % this.menuState.items.length;
        this.renderMenu();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        this.applyMenuChoice(this.menuState.items[this.menuState.selectedIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeMenu();
        return;
      }
    }

    const sel = window.getSelection();
    this.replaceSymbolShortcut(e, sel);
    const anchorNode = sel?.anchorNode;
    const anchorEl = anchorNode?.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode;

    if (!this.readOnly && this.handleImageBoundaryKey(e, sel)) return;

    if (e.key === " " && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && sel?.isCollapsed && !this.readOnly) {
      const mark = anchorEl?.closest?.("mark");
      if (mark && this.doc.contains(mark)) {
        const preceding = sel.getRangeAt(0).cloneRange();
        preceding.setStart(mark, 0);
        if (this.lastHighlightSpace === mark && /[ \u00a0]$/.test(preceding.toString())) {
          e.preventDefault();this.lastHighlightSpace = null;
          if (exitHighlightAtCaret(this.doc, sel)) this.emit();
          return;
        }
        this.lastHighlightSpace = mark;
      } else this.lastHighlightSpace = null;
    }

    // Inside code block: Enter inserts newline (Shift/Cmd+Enter exits), Tab inserts 2 spaces
    const codeBox = anchorEl?.closest?.(".n-code-box");
    const code = anchorEl?.closest?.(".n-code code");
    if (codeBox && code) {
      if (e.key === "Tab") {
        e.preventDefault();
        document.execCommand("insertText", false, "  ");
        this.emit();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          const p = addContinuation(codeBox);
          syncCodeCard(codeBox, true);
          this.placeCaretAtStart(p);
          return;
        } else {
          document.execCommand("insertText", false, "\n");
        }
        this.emit();
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && sel?.isCollapsed) {
      const block = closestBlock(anchorNode, this.doc);
      if (block?.tagName === "P") {
        const text = block.textContent.trim();
        const fence = text.match(/^(?:`{3,}|~{3,})([a-z0-9_+.-]{0,32})$/i);
        const snippet = pastedFence(text);
        if (fence || snippet) {
          e.preventDefault();
          const holder = document.createElement("template");
          holder.innerHTML = buildCodeCardHtml(snippet?.language ?? fence[1], snippet?.source ?? "");
          const card = holder.content.firstElementChild;
          block.replaceWith(card);
          this.placeCaretAtEnd(card.querySelector("code"));
          this.emit();
          return;
        }
      }
    }

    // Enter at the end of H1/H2/H3 creates a clean paragraph below instead of another heading
    if (e.key === "Enter" && !e.shiftKey && sel && sel.isCollapsed && anchorNode) {
      const blk = closestBlock(anchorNode, this.doc);
      if (blk && /^H[1-3]$/.test(blk.tagName)) {
        const r = sel.getRangeAt(0).cloneRange();
        r.selectNodeContents(blk);
        r.setStart(sel.anchorNode, sel.anchorOffset);
        if (r.toString().length === 0) {
          e.preventDefault();
          const p = document.createElement("p");
          p.innerHTML = "<br>";
          blk.after(p);
          this.placeCaretAtStart(p);
          this.emit();
          return;
        }
      }
    }

    // Auto-link bare URL when pressing Space after typing https://...
    if (e.key === " " && sel && sel.isCollapsed && anchorNode?.nodeType === Node.TEXT_NODE && !anchorEl?.closest?.("a, code, pre")) {
      const before = anchorNode.textContent.slice(0, sel.anchorOffset);
      const m = before.match(/(https?:\/\/[^\s<>"'`]+)$/);
      if (m) {
        e.preventDefault();
        const url = m[1];
        const start = sel.anchorOffset - url.length;
        const after = anchorNode.textContent.slice(sel.anchorOffset);
        anchorNode.textContent = before.slice(0, start);
        const a = document.createElement("a");
        a.href = url;
        a.dataset.href = url;
        a.className = "notion-link";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = url;
        const space = document.createTextNode(" " + after);
        anchorNode.after(a, space);
        const r = document.createRange();
        r.setStart(space, 1);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        this.emit();
        return;
      }
    }

    if ((e.metaKey || e.ctrlKey)) {
      const k = e.key.toLowerCase();
      if (k === "b") { e.preventDefault(); document.execCommand("bold"); this.emit(); return; }
      if (k === "i") { e.preventDefault(); document.execCommand("italic"); this.emit(); return; }
      if (k === "e") { e.preventDefault(); this.toggleInlineWrap("code"); this.emit(); return; }
      if (k === "h" && e.shiftKey) { e.preventDefault(); this.toggleInlineWrap("mark"); this.emit(); return; }
    }
  }

  checkInlineTriggers() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) { this.closeMenu(); return; }
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) { this.closeMenu(); return; }
    const before = node.textContent.slice(0, sel.anchorOffset);

    const wiki = before.match(/\[\[([^\[\]\n]*)$/);
    if (wiki) {
      const q = wiki[1].toLowerCase();
      const items = this.getNotes()
        .filter(n => !q || n.title.toLowerCase().includes(q))
        .slice(0, 8)
        .map(n => ({kind: "wiki", icon: "↗", label: n.title, desc: n.path || "Note", value: n.title}));
      if (items.length) {
        this.menuState = {type: "wiki", node, offset: sel.anchorOffset, matchLen: wiki[0].length, items, selectedIdx: 0};
        this.showPopoverAtCaret(sel);
        this.renderMenu();
        return;
      }
    }

    const blk = closestBlock(node, this.doc);
    const slash = blk && blk.tagName.toLowerCase() === "p" && (blk.textContent || "").match(/^\/([a-zA-Z0-9_-]*)$/);
    if (slash) {
      const q = slash[1].toLowerCase();
      const candidates = this.openAI
        ? [{id: "ai", label: t("ai-title"), desc: t("ai-preview-button"), icon: "AI"}, ...SLASH_ITEMS]
        : SLASH_ITEMS;
      const items = candidates.filter(c => !q || c.id.includes(q) || c.label.toLowerCase().includes(q));
      if (items.length) {
        this.menuState = {type: "slash", blk, items, selectedIdx: 0};
        this.showPopoverAtCaret(sel);
        this.renderMenu();
        return;
      }
    }
    this.closeMenu();
  }

  showPopoverAtCaret(sel) {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    this.popover.hidden = false;
    this.popover.style.top = `${Math.min(window.innerHeight - 290, Math.max(50, (rect.bottom || 120) + 6))}px`;
    this.popover.style.left = `${Math.min(window.innerWidth - 280, Math.max(12, rect.left || 80))}px`;
  }

  renderMenu() {
    if (!this.menuState) return;
    const {type, items, selectedIdx} = this.menuState;
    const head = document.createElement("div");
    head.className = "popover-head";
    head.textContent = type === "wiki" ? "Link a note" : "Add block";
    const list = document.createElement("div");
    items.forEach((item, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "popover-item" + (i === selectedIdx ? " is-active" : "");
      const ic = document.createElement("span");
      ic.className = "popover-icon";
      ic.textContent = item.icon;
      const copy = document.createElement("span");
      copy.className = "popover-copy";
      const st = document.createElement("strong");
      st.textContent = item.label;
      const sm = document.createElement("small");
      sm.textContent = item.desc;
      copy.append(st, sm);
      btn.append(ic, copy);
      btn.addEventListener("mousedown", e => { e.preventDefault(); this.applyMenuChoice(item); });
      list.append(btn);
    });
    this.popover.replaceChildren(head, list);
  }

  applyMenuChoice(item) {
    if (!item || !this.menuState) return;
    const state = this.menuState;
    this.closeMenu();

    if (state.type === "wiki") {
      const {node, offset, matchLen} = state;
      const start = offset - matchLen;
      const before = node.textContent.slice(0, start);
      const after = node.textContent.slice(offset);
      const chip = document.createElement("span");
      chip.className = "wiki-chip";
      chip.contentEditable = "false";
      chip.dataset.wiki = item.value;
      chip.textContent = item.value;
      const space = document.createTextNode(" " + after);
      node.textContent = before;
      node.after(chip, space);
      const r = document.createRange();
      r.setStart(space, 1);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      this.emit();
      return;
    }

    const blk = state.blk;
    if (!blk) return;
    if (item.id === "ai" && this.openAI) {
      const anchor = blk.getBoundingClientRect();
      blk.replaceChildren(document.createElement("br"));
      this.placeCaretAtStart(blk);
      this.emit();
      this.openAI({anchor});
      return;
    }
    if (["p", "h1", "h2", "h3", "blockquote"].includes(item.id)) {
      const el = document.createElement(item.id);
      el.innerHTML = "<br>";
      blk.replaceWith(el);
      this.placeCaretAtStart(el);
    } else if (item.id === "ul" || item.id === "ol") {
      const list = document.createElement(item.id);
      const li = document.createElement("li");
      li.innerHTML = "<br>";
      list.append(li);
      blk.replaceWith(list);
      this.placeCaretAtStart(li);
    } else if (item.id === "todo") {
      const ul = document.createElement("ul");
      ul.className = "n-todo-list";
      ul.innerHTML = `<li class="n-todo"><input type="checkbox" contenteditable="false"><span>Task</span></li>`;
      blk.replaceWith(ul);
      this.placeCaretAtEnd(ul.querySelector("span"));
    } else if (item.id === "callout") {
      const bq = document.createElement("blockquote");
      bq.className = "n-callout";
      bq.dataset.callout = "note";
      bq.textContent = "Note text";
      blk.replaceWith(bq);
      this.placeCaretAtEnd(bq);
    } else if (item.id === "toggle") {
      const det = document.createElement("details");
      det.className = "n-toggle";
      det.open = true;
      det.innerHTML = `<summary>Collapsible section</summary><button type="button" class="n-block-del" data-bact="delete" contenteditable="false" title="Delete block" aria-label="Delete block">×</button><div class="n-toggle-inner">Details…</div>`;
      blk.replaceWith(det);
      this.placeCaretAtEnd(det.querySelector(".n-toggle-inner"));
    } else if (item.id === "table") {
      const wrap = document.createElement("div");
      wrap.className = "n-table-wrap";
      wrap.innerHTML = `<table class="n-table"><tbody><tr><th>Column 1</th><th>Column 2</th></tr><tr><td></td><td></td></tr></tbody></table><div class="n-table-actions" contenteditable="false"><button type="button" class="n-mini-btn" data-tact="row">+ Row</button><button type="button" class="n-mini-btn" data-tact="del-row">- Row</button><button type="button" class="n-mini-btn" data-tact="col">+ Column</button><button type="button" class="n-mini-btn" data-tact="del-col">- Column</button><button type="button" class="n-mini-btn danger" data-tact="del-table">× Delete</button></div>`;
      blk.replaceWith(wrap);
      this.placeCaretAtStart(wrap.querySelector("td"));
    } else if (item.id === "code") {
      const holder = document.createElement("div");
      holder.innerHTML = buildCodeCardHtml("", "");
      const card = holder.firstElementChild;
      blk.replaceWith(card);
      this.placeCaretAtEnd(card.querySelector("code"));
    } else if (item.id === "hr") {
      const hr = document.createElement("hr");
      const next = document.createElement("p");
      next.innerHTML = "<br>";
      blk.replaceWith(hr, next);
      this.placeCaretAtStart(next);
    }
    this.emit();
  }

  closeMenu() {
    this.menuState = null;
    this.popover.hidden = true;
    this.popover.replaceChildren();
  }
}
