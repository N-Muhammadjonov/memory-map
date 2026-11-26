const LANGUAGES = {
  python: ["Python", "py"], javascript: ["JavaScript", "js"], typescript: ["TypeScript", "ts"],
  bash: ["Bash", "sh"], sql: ["SQL", "sql"], json: ["JSON", "json"], yaml: ["YAML", "yaml"],
  html: ["HTML", "html"], xml: ["XML", "xml"], css: ["CSS", "css"], nginx: ["Nginx", "conf"],
  go: ["Go", "go"], rust: ["Rust", "rs"], cpp: ["C++", "cpp"], c: ["C", "c"],
  java: ["Java", "java"], csharp: ["C#", "cs"], kotlin: ["Kotlin", "kt"], swift: ["Swift", "swift"],
  php: ["PHP", "php"], ruby: ["Ruby", "rb"], md: ["Markdown", "md"],
  mermaid: ["Mermaid", "mmd"], text: ["Plain text", "txt"],
};
const ALIASES = {
  py: "python", python3: "python", js: "javascript", jsx: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript", sh: "bash", zsh: "bash", shell: "bash", shellscript: "bash",
  yml: "yaml", markdown: "md", rs: "rust", kt: "kotlin", rb: "ruby", "c++": "cpp", cs: "csharp", "c#": "csharp",
  plaintext: "text", txt: "text", sqlite: "sql", postgres: "sql", postgresql: "sql",
};
const RULES = [
  ["php", /^(?:\s*)<\?(?:php|=)/i],
  ["xml", /^<\?xml\b/i],
  ["html", /^(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html\b|<(?:html|div|span|main|article|section|head|body|h[1-6]|p|script|style|input|table|form|svg)(?:\s|>|\/))/i],
  ["mermaid", /^(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b|^(?:sequenceDiagram|classDiagram|stateDiagram|erDiagram)\b/i],
  ["nginx", /(?:^|\n)\s*(?:(?:server|events|upstream\s+[\w-]+|location\s+[^\n{}]+)\s*\{|(?:proxy_pass|worker_processes|server_name)\s+[^;]+;)/],
  ["sql", /(?:^|\n)\s*(?:select\s+[\w\"'(*+\d$-]|with\s+(?:recursive\s+)?[\w"]+(?:\s*\([^\n]*?\))?\s+as\s*\(|create\s+(?:temp\s+)?(?:table|index|view)\b|insert\s+into\b|update\s+[\w".]+\s+set\b|delete\s+from\b)/i],
  ["rust", /\b(?:fn\s+\w+\s*\(|let\s+mut\s+\w+|use\s+std::|println!\s*\(|impl\s+\w+\s*(?:for\s+\w+)?\s*\{)/],
  ["go", /(?:^|\n)\s*package\s+\w+\s*(?:\n|$)|\bfunc\s+(?:\([^\n]+\)\s*)?\w+\s*\([^\n]*\)\s*(?:[\w.]+\s*)?\{|\bfmt\.(?:Println|Printf)\(/],
  ["cpp", /#\s*include\s*<(?:iostream|vector|string|algorithm|map)>|\bstd::|\busing\s+namespace\b/],
  ["c", /(?:^|\n)\s*#\s*include\s*<[^>]+\.h>|\bint\s+main\s*\(/],
  ["csharp", /(?:^|\n)\s*using\s+(?:System|Microsoft)(?:\.[\w.]+)?\s*;|\bConsole\.(?:WriteLine|Write)\s*\(/],
  ["java", /\bimport\s+java\.|\bpublic\s+(?:final\s+)?class\s+\w+|\bSystem\.out\.print(?:ln)?\(/],
  ["kotlin", /\bfun\s+\w+\s*\(|\bdata\s+class\s+\w+|\bprintln\s*\([^\n]*\)\s*(?:\n|$)/],
  ["swift", /\bimport\s+(?:SwiftUI|Foundation|UIKit)\b|\b(?:let|var)\s+\w+\s*:\s*(?:String|Int|Bool)\b|\bstruct\s+\w+\s*:\s*View\b/],
  ["typescript", /\b(?:export\s+)?interface\s+\w+[^{\n]*\{|\btype\s+\w+\s*=|\b(?:const|let|var)\s+\w+\s*:\s*[\w<{[]|\bfunction\s+\w+\([^\n]*\)\s*:\s*\w+/],
  ["javascript", /^#!.*\bnode\b|(?:^|\n)\s*(?:import\s+[^\n]+\sfrom|export\s+(?:default|const|function)|(?:const|let|var)\s+\w+[\w\s,]*=|(?:async\s+)?function\s+\w+\s*\()|\b(?:console\.(?:log|error|warn)|window\.alert|document\.querySelector)\s*\(|=>|===|!==/],
  ["python", /^#!.*\bpython[\d.]*\b|(?:^|\n)\s*(?:(?:async\s+)?def\s+\w+\s*\([^\n]*\)\s*(?:->[^\n:]+)?:|from\s+[.\w]+\s+import\b|import\s+(?:math|random|sys|os|json|time|datetime|typing|collections|statistics|pathlib|hashlib)\b(?!\s+from\b)|print\s*\(|(?:if|elif|for|while|with|class)\s+[^\n]+:\s*(?:#.*)?(?:\n|$)|(?:try|else|except\s*[^\n:]*|finally):\s*(?:\n|$))|^\s*@\w+[.\w]*(?:\([^\n]*\))?\s*\n\s*(?:async\s+)?def\b/m],
  ["css", /(?:^|\n)\s*(?:[#.:@][\w-]+|[\w-]+\s*,\s*[^\n{]+|body|html|button)\s*[^\n{}]*\{\s*(?:--[\w-]+|[a-z-]+)\s*:[^{};]+[;}]/i],
  ["ruby", /^#!.*\bruby\b|(?:^|\n)\s*(?:puts|require_relative)\s+["']|(?:^|\n)\s*def\s+\w+[^\n:]*\n[\s\S]*?^\s*end\b/m],
  ["bash", /^#!.*\b(?:bash|sh|zsh)\b|(?:^|\n)\s*\$\s*(?:\w+)|(?:^|\n)\s*(?:echo|cd|ls|printf|export|sudo|chmod|mkdir|git|npm|pip\d?|docker|kubectl)\s+\S/],
  ["yaml", /(?:^|\n)\s*[\w.\-/]+:\s*(?:\n\s+\S|[^\n]+\n\s*[\w.\-/]+:\s*\S)|^---\s*\n\s*\w+\s*:|^\s*\w[\w.\-/]*:\s+[^\n]+$/],
  ["md", /(?:^|\n)\s*(?:#{1,6}[ \t]+\S|[-*+]\s+\[[ xX]\]\s+\S)/],
];

export const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="4" y="8" width="12" height="12" rx="2.4"></rect><path d="M8 8V6.4A2.4 2.4 0 0 1 10.4 4h7.2A2.4 2.4 0 0 1 20 6.4v7.2a2.4 2.4 0 0 1-2.4 2.4H16"></path></svg>';
export const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4"></path></svg>';
export const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>';

export function normalizeLanguage(language = "") {
  const key = String(language || "").trim().toLowerCase();
  return Object.hasOwn(ALIASES, key) ? ALIASES[key] : Object.hasOwn(LANGUAGES, key) ? key : "";
}

export function detectLanguage(source, declared = "") {
  const text = String(source || "").replace(/^\uFEFF/, "").trim().slice(0, 16_384);
  const fallback = normalizeLanguage(declared);
  if (!text) return fallback || "text";
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const json = JSON.parse(text);
      if (json && typeof json === "object") return "json";
    } catch {}
  }
  const shebang = /^#![^\n]*?\b(python(?:\d+(?:\.\d+)*)?|node(?:js)?|deno|bun|bash|sh|zsh|ruby|php)\b/.exec(text)?.[1];
  if (shebang) {
    const runtime = /^python/.test(shebang) ? "python" : shebang;
    if (["node", "nodejs", "deno", "bun"].includes(runtime)) return fallback === "typescript" ? "typescript" : "javascript";
    return normalizeLanguage(runtime);
  }
  const codeTokens = text.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60(?:[^\x60\\]|\\[\s\S])*\x60)/g, value => '""' + (value.match(/\n/g) || []).join(""));
  for (const [language, pattern] of RULES) {
    const source = ["javascript", "typescript", "python", "java", "csharp", "kotlin", "swift", "sql"].includes(language)
      ? codeTokens : text;
    if (pattern.test(source)) return language === "swift" && fallback === "typescript" ? fallback : language;
  }
  if (/(?:^|\n)\s*import\s+[a-zA-Z_][\w.]*(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*\s*(?:#.*)?(?:\n|$)/.test(text)) {
    return "python";
  }
  if (/^\s*(?:\w+\s*=(?!=)|(?:len|sum|range|str|int)\s*\()|(?:^|[^\w])(?:True|False|None)\b/.test(codeTokens)) {
    return fallback || "python";
  }
  return fallback || "text";
}

export function languageName(language) {
  return LANGUAGES[language]?.[0] || LANGUAGES.text[0];
}

export function languageExtension(language) {
  return LANGUAGES[language]?.[1] || LANGUAGES.text[1];
}

export function canRunLanguage(language) {
  return language === "python" || language === "sql";
}

export function readEditableCode(node) {
  if (node?.childNodes.length === 1 && node.firstChild.nodeName === "BR") return "";
  return node?.querySelector("br,div,p") ? node.innerText : node?.textContent || "";
}

export function pastedFence(text) {
  const multiline = text.trim().match(/^(`{3,}|~{3,})([^\n\r]*)\r?\n([\s\S]*?)\r?\n\1$/);
  if (multiline) return {language: multiline[2].trim().split(/\s+/)[0] || "", source: multiline[3]};
  const compact = text.trim().match(/^`{3}([^`\r\n]+)`{3}$/);
  return compact ? {language: "", source: compact[1]} : null;
}

export function snippetStatus(result) {
  const output = result.output?.replace(/\n$/, "");
  return [output, result.error].filter(Boolean).join("\n") || "Finished with no output.";
}

export async function copyCode(text, button, feedback) {
  try {
    await navigator.clipboard.writeText(text);
    button.innerHTML = CHECK_ICON;
    button.title = "Copied";
    feedback.textContent = "Code copied.";
    setTimeout(() => {
      button.innerHTML = COPY_ICON;
      button.title = "Copy code";
      feedback.textContent = "";
    }, 1400);
  } catch {
    feedback.textContent = "Could not copy code.";
    button.title = "Could not copy code";
  }
}
