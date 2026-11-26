export class TrashDrop {
  constructor(targets, canDrag, move) {
    this.targets = targets;
    this.canDrag = canDrag;
    this.move = move;
    this.entry = null;
    for (const target of targets) {
      const accept = event => {
        if (!this.entry || !this.canDrag()) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        this.highlight(target);
      };
      target.addEventListener("dragenter", accept);
      target.addEventListener("dragover", accept);
      target.addEventListener("dragleave", event => {
        if (!(event.relatedTarget instanceof Node) || !target.contains(event.relatedTarget)) {
          target.classList.remove("is-drop-target");
        }
      });
      target.addEventListener("drop", event => {
        if (!this.entry) return;
        event.preventDefault();
        this.drop();
      });
    }
    document.addEventListener("dragend", () => this.clear());
    document.addEventListener("drop", event => {
      // Native text drops can otherwise insert the internal ID into a text field.
      if (this.entry) event.preventDefault();
      this.clear();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") this.clear();
    });
  }

  take(entry) {
    if (!this.canDrag()) return false;
    this.entry = entry;
    for (const target of this.targets) target.classList.add("is-drop-ready");
    return true;
  }

  highlight(active) {
    for (const target of this.targets) target.classList.toggle("is-drop-target", target === active);
  }

  clear() {
    this.entry = null;
    for (const target of this.targets) target.classList.remove("is-drop-target", "is-drop-ready");
  }

  drop() {
    const entry = this.entry;
    this.clear();
    if (entry && this.canDrag()) this.move(entry);
  }

  bind(control, entry) {
    control.draggable = true;
    control.classList.add("trash-draggable");
    let touch;
    let suppressClickUntil = 0;
    control.addEventListener("dragstart", event => {
      if (touch || !event.dataTransfer || !this.take(entry)) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData("text/plain", entry.id);
      event.dataTransfer.effectAllowed = "move";
    });
    control.addEventListener("dragend", () => this.clear());
    const grip = document.createElement("span");
    grip.className = "trash-grip";
    grip.setAttribute("aria-hidden", "true");
    grip.textContent = "⠿";
    control.append(grip);

    const targetAt = event => {
      const underPointer = document.elementFromPoint(event.clientX, event.clientY);
      return this.targets.find(target => underPointer && target.contains(underPointer));
    };
    grip.addEventListener("pointerdown", event => {
      if (event.pointerType === "mouse" || !event.isPrimary || !this.canDrag()) return;
      touch = {id: event.pointerId, x: event.clientX, y: event.clientY, active: false};
      grip.setPointerCapture(event.pointerId);
    });
    grip.addEventListener("pointermove", event => {
      if (touch?.id !== event.pointerId) return;
      if (!touch.active && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) >= 5) {
        touch.active = this.take(entry);
      }
      if (touch.active && this.entry === entry) {
        event.preventDefault();
        this.highlight(targetAt(event));
      }
    });
    const finish = event => {
      if (touch?.id !== event.pointerId) return;
      const active = touch.active;
      touch = null;
      if (!active) return;
      suppressClickUntil = Date.now() + 400;
      if (event.type === "pointerup" && this.entry === entry && targetAt(event)) this.drop();
      else this.clear();
    };
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) grip.addEventListener(event, finish);
    control.addEventListener("click", event => {
      if (event.detail && Date.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    return control;
  }
}
