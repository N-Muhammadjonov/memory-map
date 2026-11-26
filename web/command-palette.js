/**
 * Obsidian + Notion style Command Palette (⌘K / ⌘P)
 * Fuzzy search across Notes, Files, Templates, and Workspace Actions.
 */

export class CommandPalette {
  constructor(dialog, getItems) {
    this.dialog = dialog;
    this.input = dialog.querySelector("#cmd-input");
    this.list = dialog.querySelector("#cmd-list");
    this.getItems = getItems;
    this.items = [];
    this.selected = 0;

    this.input.addEventListener("input", () => this.refresh());
    this.input.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (this.items.length) this.selected = (this.selected + 1) % this.items.length;
        this.render();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (this.items.length) this.selected = (this.selected - 1 + this.items.length) % this.items.length;
        this.render();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = this.items[this.selected];
        if (item) this.run(item);
      } else if (e.key === "Escape") {
        this.close();
      }
    });

    this.dialog.addEventListener("click", e => {
      if (e.target === this.dialog) this.close();
    });
  }

  open(initial = "") {
    if (this.dialog.open) return;
    this.input.value = initial;
    this.selected = 0;
    this.refresh();
    this.dialog.showModal();
    this.input.focus();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  refresh() {
    const q = this.input.value.trim().toLowerCase();
    const all = this.getItems();
    this.items = all
      .filter(item => {
        if (!q) return true;
        const hay = `${item.title} ${item.subtitle || ""} ${item.group || ""}`.toLowerCase();
        return q.split(/\s+/).every(part => hay.includes(part));
      })
      .slice(0, 24);
    this.selected = 0;
    this.render();
  }

  render() {
    const frag = document.createDocumentFragment();
    if (!this.items.length) {
      const empty = document.createElement("p");
      empty.className = "cmd-empty";
      empty.textContent = "No results.";
      frag.append(empty);
    } else {
      this.items.forEach((item, idx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cmd-item" + (idx === this.selected ? " is-active" : "");
        const icon = document.createElement("span");
        icon.className = "cmd-icon";
        icon.textContent = item.icon || "•";
        const body = document.createElement("span");
        body.className = "cmd-copy";
        const t = document.createElement("strong");
        t.textContent = item.title;
        const sub = document.createElement("small");
        sub.textContent = item.subtitle || item.group || "";
        body.append(t, sub);
        const badge = document.createElement("span");
        badge.className = "cmd-badge";
        badge.textContent = item.shortcut || item.group || "";
        btn.append(icon, body, badge);
        btn.addEventListener("click", () => this.run(item));
        frag.append(btn);
      });
    }
    this.list.replaceChildren(frag);
  }

  run(item) {
    this.close();
    item.action();
  }
}
