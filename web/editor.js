/**
 * Xotira Live Block Editor (Obsidian Live Preview + Notion Blocks)
 * Keeps canonical Markdown as single source of truth while rendering every block
 * as rich formatted HTML (headings, bold/italic, tables, callouts, checklists,
 * math, code, mermaid, wikilinks) with instant click-to-edit, `/` slash commands,
 * and `[[` wikilink autocomplete.
 */

import {renderMarkdown} from "./markdown.js";

export const SLASH_COMMANDS = [
  {id: "h1", icon: "H1", label: "Heading 1", desc: "Section heading", insert: "# "},
  {id: "h2", icon: "H2", label: "Heading 2", desc: "Subheading", insert: "## "},
  {id: "h3", icon: "H3", label: "Heading 3", desc: "Small heading", insert: "### "},
  {id: "task", icon: "☑", label: "Task list", desc: "Checklist", insert: "- [ ] "},
  {id: "bullet", icon: "•", label: "Bulleted list", desc: "Bulleted list", insert: "- "},
  {id: "numbered", icon: "1.", label: "Numbered list", desc: "Ordered list", insert: "1. "},
  {id: "callout-note", icon: "📝", label: "Callout — Note", desc: "Highlighted note", insert: "> [!note] Note\n> "},
  {id: "callout-tip", icon: "💡", label: "Callout — Tip", desc: "Tip callout", insert: "> [!tip] Tip\n> "},
  {id: "callout-warn", icon: "⚠️", label: "Callout — Warning", desc: "Warning callout", insert: "> [!warning] Warning\n> "},
  {id: "table", icon: "⊞", label: "Table", desc: "Markdown data table", insert: "| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Value | Value | Value |"},
  {id: "code", icon: "</>", label: "Code block", desc: "Programming snippet with copy", insert: "```\n\n```"},
  {id: "math", icon: "∑", label: "Formula (KaTeX)", desc: "Math equation", insert: "$$\nE = mc^2\n$$"},
  {id: "mermaid", icon: "⬡", label: "Diagram (Mermaid)", desc: "Flowchart", insert: "```mermaid\nflowchart LR\n  A[Start] --> B[Result]\n```"},
  {id: "quote", icon: "❝", label: "Quote", desc: "Block quote", insert: "> "},
  {id: "divider", icon: "―", label: "Divider", desc: "Horizontal rule", insert: "---"},
  {id: "date", icon: "📅", label: "Today's date", desc: "Insert date as YYYY-MM-DD", insert: () => new Date().toISOString().slice(0, 10)},
];

/**
 * Split Markdown body (without frontmatter) into editable logical blocks
 * preserving exact line structure so round-trip serialization is lossless.
 */
export function parseBlocks(markdown) {
  if (!markdown) return [""];
  const lines = markdown.split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip extra blank lines between blocks
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block (``` or ~~~)
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1];
      const buf = [line];
      i++;
      while (i < lines.length) {
        buf.push(lines[i]);
        if (lines[i].match(new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`))) {
          i++;
          break;
        }
        i++;
      }
      blocks.push(buf.join("\n"));
      continue;
    }

    // Display math block $$ ... $$
    if (/^ {0,3}\$\$/.test(line)) {
      const buf = [line];
      const closedSameLine = /^ {0,3}\$\$.+\$\$\s*$/.test(line);
      i++;
      if (!closedSameLine) {
        while (i < lines.length) {
          buf.push(lines[i]);
          if (/^ {0,3}\$\$\s*$/.test(lines[i])) {
            i++;
            break;
          }
          i++;
        }
      }
      blocks.push(buf.join("\n"));
      continue;
    }

    // Heading (# .. ######)
    if (/^ {0,3}#{1,6}\s/.test(line)) {
      blocks.push(line);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^ {0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push(line);
      i++;
      continue;
    }

    // GFM Table (header + separator row)
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      const buf = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push(buf.join("\n"));
      continue;
    }

    // Blockquote / Callout
    if (/^ {0,3}>/.test(line)) {
      const buf = [line];
      i++;
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push(buf.join("\n"));
      continue;
    }

    // List (bullet, ordered, or task)
    if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line)) {
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== "" && (/^\s*(?:[-+*]|\d+[.)])\s+/.test(lines[i]) || /^\s{2,}/.test(lines[i]))) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push(buf.join("\n"));
      continue;
    }

    // Paragraph (until blank line or new block starter)
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^ {0,3}(?:`{3,}|~{3,}|\$\$|#{1,6}\s|>|---+|\*\*\*+|___+)/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) &&
      !/^\s*(?:[-+*]|\d+[.)])\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(buf.join("\n"));
  }

  return blocks.length ? blocks : [""];
}

export function serializeBlocks(blocks) {
  return blocks.join("\n\n");
}

function autoResizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.max(36, el.scrollHeight) + "px";
}

export class LiveBlockEditor {
  constructor(container, popover, options) {
    this.container = container;
    this.popover = popover;
    this.getLinks = options.getLinks;
    this.getNotes = options.getNotes;
    this.onChange = options.onChange;
    this.onDraw = options.onDraw;

    this.blocks = [""];
    this.activeIndex = -1;
    this.readOnly = false;
    this.activeTextarea = null;
    this.menuState = null; // {type: 'slash' | 'wiki', triggerPos, items, selectedIdx}

    this.container.addEventListener("click", e => {
      if (e.target === this.container && !this.readOnly) {
        const lastIdx = this.blocks.length - 1;
        if (this.blocks[lastIdx] !== "") {
          this.blocks.push("");
          this.emit();
        }
        this.activate(this.blocks.length - 1);
      }
    });

    document.addEventListener("click", e => {
      if (this.menuState && !this.popover.contains(e.target) && e.target !== this.activeTextarea) {
        this.closeMenu();
      }
    });
  }

  setValue(markdown, readOnly = false) {
    this.readOnly = readOnly;
    const nextBlocks = parseBlocks(markdown);
    this.blocks = nextBlocks;
    this.activeIndex = -1;
    this.activeTextarea = null;
    this.closeMenu();
    this.render();
  }

  getValue() {
    return serializeBlocks(this.blocks);
  }

  emit() {
    this.onChange(this.getValue());
  }

  insertAtActive(text) {
    if (this.readOnly) return;
    const idx = this.activeIndex >= 0 ? this.activeIndex : this.blocks.length - 1;
    if (this.activeTextarea && this.activeIndex === idx) {
      const ta = this.activeTextarea;
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
      this.blocks[idx] = ta.value;
      autoResizeTextarea(ta);
      this.emit();
      ta.focus();
    } else {
      if (this.blocks[idx] === "") this.blocks[idx] = text;
      else this.blocks.splice(idx + 1, 0, text);
      this.emit();
      this.activate(this.blocks[idx] === text ? idx : idx + 1);
    }
  }

  activate(index, caretPos = null) {
    if (this.readOnly) return;
    if (index < 0 || index >= this.blocks.length) return;
    if (this.activeIndex === index && this.activeTextarea) {
      this.activeTextarea.focus();
      return;
    }
    this.activeIndex = index;
    this.closeMenu();
    this.render();
    if (this.activeTextarea) {
      this.activeTextarea.focus();
      const pos = caretPos === null ? this.activeTextarea.value.length : Math.min(caretPos, this.activeTextarea.value.length);
      this.activeTextarea.setSelectionRange(pos, pos);
    }
  }

  deactivate() {
    if (this.activeIndex < 0) return;
    this.activeIndex = -1;
    this.activeTextarea = null;
    this.closeMenu();
    this.render();
  }

  moveBlock(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= this.blocks.length) return;
    const [item] = this.blocks.splice(index, 1);
    this.blocks.splice(target, 0, item);
    if (this.activeIndex === index) this.activeIndex = target;
    this.emit();
    this.render();
  }

  deleteBlock(index) {
    if (this.blocks.length === 1) {
      this.blocks[0] = "";
    } else {
      this.blocks.splice(index, 1);
    }
    this.activeIndex = -1;
    this.activeTextarea = null;
    this.emit();
    this.render();
  }

  addBlockBelow(index) {
    this.blocks.splice(index + 1, 0, "");
    this.emit();
    this.activate(index + 1, 0);
  }

  render() {
    const frag = document.createDocumentFragment();
    const baseLinks = this.getLinks();

    this.blocks.forEach((raw, idx) => {
      const row = document.createElement("div");
      row.className = "live-block" + (idx === this.activeIndex ? " is-editing" : "");
      row.dataset.index = String(idx);

      // Notion-style left gutter controls
      if (!this.readOnly) {
        const gutter = document.createElement("div");
        gutter.className = "block-gutter";
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "gutter-btn";
        addBtn.title = "Add a block below";
        addBtn.textContent = "+";
        addBtn.addEventListener("click", e => { e.stopPropagation(); this.addBlockBelow(idx); });

        const upBtn = document.createElement("button");
        upBtn.type = "button";
        upBtn.className = "gutter-btn";
        upBtn.title = "Move up surish";
        upBtn.textContent = "↑";
        upBtn.disabled = idx === 0;
        upBtn.addEventListener("click", e => { e.stopPropagation(); this.moveBlock(idx, -1); });

        const downBtn = document.createElement("button");
        downBtn.type = "button";
        downBtn.className = "gutter-btn";
        downBtn.title = "Move down surish";
        downBtn.textContent = "↓";
        downBtn.disabled = idx === this.blocks.length - 1;
        downBtn.addEventListener("click", e => { e.stopPropagation(); this.moveBlock(idx, 1); });

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "gutter-btn danger-dot";
        delBtn.title = "Delete block";
        delBtn.textContent = "×";
        delBtn.addEventListener("click", e => { e.stopPropagation(); this.deleteBlock(idx); });

        gutter.append(addBtn, upBtn, downBtn, delBtn);
        row.append(gutter);
      }

      const content = document.createElement("div");
      content.className = "block-content";

      if (idx === this.activeIndex && !this.readOnly) {
        const ta = document.createElement("textarea");
        ta.className = "block-input";
        ta.value = raw;
        ta.rows = 1;
        ta.placeholder = "Type text, “/” for blocks, or “[[” to link…";
        ta.spellcheck = false;
        this.activeTextarea = ta;

        ta.addEventListener("input", () => {
          this.blocks[idx] = ta.value;
          autoResizeTextarea(ta);
          this.emit();
          this.checkTriggers(ta);
        });

        ta.addEventListener("keydown", e => this.handleKeyDown(e, ta, idx));
        ta.addEventListener("blur", () => {
          // Delay blur slightly so clicks on popover or toolbar buttons work
          setTimeout(() => {
            if (this.menuState) return;
            if (document.activeElement === ta) return;
            if (this.activeIndex === idx) this.deactivate();
          }, 140);
        });

        content.append(ta);
        requestAnimationFrame(() => autoResizeTextarea(ta));
      } else {
        const rendered = document.createElement("div");
        rendered.className = "markdown block-rendered";
        if (!raw.trim()) {
          const ph = document.createElement("p");
          ph.className = "block-placeholder";
          ph.textContent = this.readOnly ? "" : "Click to write or type “/” for commands…";
          rendered.append(ph);
        } else {
          const blockLinks = {
            ...baseLinks,
            toggleTask: this.readOnly ? null : (offset, checked) => {
              const updated = raw.slice(0, offset) + (checked ? "x" : " ") + raw.slice(offset + 1);
              this.blocks[idx] = updated;
              this.emit();
              this.render();
            },
          };
          rendered.append(renderMarkdown(raw, blockLinks));
        }

        if (!this.readOnly) {
          rendered.addEventListener("click", e => {
            if (e.target.closest("a, button, input, summary")) return;
            this.activate(idx);
          });
        }
        content.append(rendered);
      }

      row.append(content);
      frag.append(row);
    });

    this.container.replaceChildren(frag);
  }

  handleKeyDown(e, ta, idx) {
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
        this.applyMenuItem(this.menuState.items[this.menuState.selectedIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeMenu();
        return;
      }
    }

    if (e.key === "Escape") {
      e.preventDefault();
      this.deactivate();
      return;
    }

    // Inline formatting shortcuts inside live block
    if (e.metaKey || e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === "b" || k === "i" || k === "e") {
        e.preventDefault();
        const marker = k === "b" ? "**" : k === "i" ? "*" : "`";
        const s = ta.selectionStart, end = ta.selectionEnd;
        const sel = ta.value.slice(s, end);
        ta.setRangeText(marker + (sel || "matn") + marker, s, end, "end");
        ta.setSelectionRange(s + marker.length, s + marker.length + (sel || "matn").length);
        this.blocks[idx] = ta.value;
        this.emit();
        return;
      }
    }

    // Enter without Shift splits into a new block (except inside code/table/list/callout/math)
    const val = ta.value;
    const isMultiline = /^ {0,3}(?:```|~~~|\$\$|>|\|)|^\s*(?:[-+*]|\d+[.)])\s/.test(val);
    if (e.key === "Enter" && !e.shiftKey && !isMultiline) {
      e.preventDefault();
      const pos = ta.selectionStart;
      const before = val.slice(0, pos);
      const after = val.slice(ta.selectionEnd);
      this.blocks[idx] = before;
      this.blocks.splice(idx + 1, 0, after);
      this.emit();
      this.activate(idx + 1, 0);
      return;
    }

    // Backspace at start of empty block removes it and focuses previous
    if (e.key === "Backspace" && ta.selectionStart === 0 && ta.selectionEnd === 0 && idx > 0) {
      if (val === "") {
        e.preventDefault();
        this.blocks.splice(idx, 1);
        this.emit();
        this.activate(idx - 1);
        return;
      }
    }

    // ArrowUp on first line moves to previous block
    if (e.key === "ArrowUp" && idx > 0 && !val.slice(0, ta.selectionStart).includes("\n")) {
      e.preventDefault();
      this.activate(idx - 1);
      return;
    }

    // ArrowDown on last line moves to next block
    if (e.key === "ArrowDown" && idx < this.blocks.length - 1 && !val.slice(ta.selectionEnd).includes("\n")) {
      e.preventDefault();
      this.activate(idx + 1, 0);
    }
  }

  checkTriggers(ta) {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);

    // Check `[[` wikilink autocomplete
    const wikiMatch = before.match(/\[\[([^\[\]\n]*)$/);
    if (wikiMatch) {
      const q = wikiMatch[1].toLowerCase();
      const notes = this.getNotes()
        .filter(n => !q || n.title.toLowerCase().includes(q))
        .slice(0, 10)
        .map(n => ({kind: "wiki", label: n.title, desc: n.path || (n.tags || []).join(", ") || "Note", value: n.title}));
      if (notes.length) {
        this.menuState = {type: "wiki", triggerStart: pos - wikiMatch[0].length, items: notes, selectedIdx: 0};
        this.positionPopover(ta);
        this.renderMenu();
        return;
      }
    }

    // Check `/` slash command
    const slashMatch = before.match(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/);
    if (slashMatch) {
      const q = slashMatch[1].toLowerCase();
      const cmds = SLASH_COMMANDS.filter(c =>
        !q || c.id.includes(q) || c.label.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)
      );
      if (cmds.length) {
        this.menuState = {
          type: "slash",
          triggerStart: pos - slashMatch[1].length - 1,
          items: cmds,
          selectedIdx: 0,
        };
        this.positionPopover(ta);
        this.renderMenu();
        return;
      }
    }

    this.closeMenu();
  }

  positionPopover(ta) {
    const rect = ta.getBoundingClientRect();
    this.popover.hidden = false;
    const top = Math.min(window.innerHeight - 280, rect.bottom + 6);
    const left = Math.min(window.innerWidth - 310, Math.max(12, rect.left));
    this.popover.style.top = `${Math.max(56, top)}px`;
    this.popover.style.left = `${left}px`;
  }

  renderMenu() {
    if (!this.menuState) return;
    const {type, items, selectedIdx} = this.menuState;
    const header = document.createElement("div");
    header.className = "popover-head";
    header.textContent = type === "wiki" ? "Link a note ([[…]])" : "Add block (/)";

    const list = document.createElement("div");
    list.className = "popover-list";
    items.forEach((item, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "popover-item" + (i === selectedIdx ? " is-active" : "");
      const icon = document.createElement("span");
      icon.className = "popover-icon";
      icon.textContent = item.icon || "🔗";
      const copy = document.createElement("span");
      copy.className = "popover-copy";
      const title = document.createElement("strong");
      title.textContent = item.label;
      const desc = document.createElement("small");
      desc.textContent = item.desc || "";
      copy.append(title, desc);
      btn.append(icon, copy);
      btn.addEventListener("mousedown", e => {
        e.preventDefault();
        this.applyMenuItem(item);
      });
      list.append(btn);
    });
    this.popover.replaceChildren(header, list);
  }

  applyMenuItem(item) {
    if (!item || !this.activeTextarea || !this.menuState) return;
    const ta = this.activeTextarea;
    const start = this.menuState.triggerStart;
    const end = ta.selectionStart;
    const text = this.menuState.type === "wiki"
      ? `[[${item.value}]]`
      : (typeof item.insert === "function" ? item.insert() : item.insert);
    ta.setRangeText(text, start, end, "end");
    this.blocks[this.activeIndex] = ta.value;
    autoResizeTextarea(ta);
    this.closeMenu();
    this.emit();
    ta.focus();
  }

  closeMenu() {
    this.menuState = null;
    this.popover.hidden = true;
    this.popover.replaceChildren();
  }
}
