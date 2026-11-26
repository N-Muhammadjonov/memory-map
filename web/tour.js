// Guided first-time tour: highlights core workflows (create note, [[ links, / menu, 3D graph).
export const TOUR_STEPS = [
  {
    id: "create-note",
    target: "#home-panel .home-actions .primary",
    fallbackTarget: "#create-note",
    titleKey: "tour-step1-title",
    fallbackTitle: "Create a note",
    bodyKey: "tour-step1-body",
    fallbackBody: "Click + here or use New note on Home to create your first encrypted note.",
  },
  {
    id: "wiki-links",
    target: "#notion-editor",
    fallbackTarget: "#notes-pane",
    titleKey: "tour-step2-title",
    fallbackTitle: "Link ideas with [[",
    bodyKey: "tour-step2-body",
    fallbackBody: "Type [[ inside any note to link to another note and build your knowledge graph.",
  },
  {
    id: "slash-menu",
    target: "#notion-editor",
    fallbackTarget: "#home-panel .home-start",
    titleKey: "tour-step3-title",
    fallbackTitle: "Slash menu /",
    bodyKey: "tour-step3-body",
    fallbackBody: "Type / on a new line in a note to insert headings, checklists, tables, code, or drawings.",
  },
  {
    id: "graph-view",
    target: "#nav-map",
    titleKey: "tour-step4-title",
    fallbackTitle: "Explore the 3D graph",
    bodyKey: "tour-step4-body",
    fallbackBody: "Open 3D graph to see all connected notes, topics, and shortest link paths.",
  },
];

export function startGuidedTour({t, onFinish} = {}) {
  const existing = document.querySelector(".tour-card");
  if (existing?.open) return;
  const translate = (key, fallback) => {
    const label = t?.(key);
    return label && label !== key ? label : fallback;
  };

  let index = 0;
  const previousFocus = document.activeElement;
  const card = document.createElement("dialog");
  card.className = "tour-card";
  card.setAttribute("aria-labelledby", "guided-tour-heading");
  const ring = document.createElement("span");
  ring.className = "tour-ring";
  ring.setAttribute("aria-hidden", "true");
  const stepMeta = document.createElement("div");
  stepMeta.className = "tour-step-meta";
  const title = document.createElement("h3");
  title.id = "guided-tour-heading";
  const body = document.createElement("p");
  body.setAttribute("aria-live", "polite");
  const actions = document.createElement("div");
  actions.className = "tour-actions";

  function button(key, fallback, className, activate) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = className;
    el.textContent = translate(key, fallback);
    el.addEventListener("click", activate);
    return el;
  }

  const skip = button("tour-skip", "Skip", "ghost-btn", () => card.close());
  const previous = button("tour-prev", "Back", "ghost-btn", () => { index--; renderStep(); });
  const next = button("tour-next", "Next", "primary", () => {
    if (index + 1 === TOUR_STEPS.length) card.close();
    else { index++; renderStep(); }
  });

  function positionCard() {
    const step = TOUR_STEPS[index];
    const rect = [step.target, step.fallbackTarget].filter(Boolean)
      .map(selector => document.querySelector(selector)?.getBoundingClientRect())
      .find(bounds => bounds && bounds.width && bounds.height && bounds.bottom > 0 && bounds.top < innerHeight);
    ring.hidden = !rect;
    if (rect) {
      const x = Math.max(2, rect.left);
      const y = Math.max(2, rect.top);
      ring.style.cssText = `left:${x}px;top:${y}px;width:${Math.min(innerWidth - 2, rect.right) - x}px;height:${Math.min(innerHeight - 2, rect.bottom) - y}px`;
    }
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const centerX = (innerWidth - width) / 2;
    const centerY = (innerHeight - height) / 2;
    const preferredY = rect && rect.bottom + height + 20 <= innerHeight
      ? rect.bottom + 10 : rect && rect.top >= height + 20 ? rect.top - height - 10 : centerY;
    card.style.left = `${Math.max(12, Math.min(innerWidth - width - 12, rect?.left ?? centerX))}px`;
    card.style.top = `${Math.max(12, Math.min(innerHeight - height - 12, preferredY))}px`;
  }

  function renderStep() {
    const step = TOUR_STEPS[index];
    stepMeta.textContent = `${index + 1} / ${TOUR_STEPS.length}`;
    title.textContent = translate(step.titleKey, step.fallbackTitle);
    body.textContent = translate(step.bodyKey, step.fallbackBody);
    previous.disabled = index === 0;
    next.textContent = index + 1 === TOUR_STEPS.length
      ? translate("tour-done", "Done") : translate("tour-next", "Next");
    positionCard();
    next.focus();
  }

  card.addEventListener("keydown", event => {
    if (event.key === "ArrowRight" || (event.key === "ArrowLeft" && !previous.disabled)) {
      event.preventDefault();
      (event.key === "ArrowRight" ? next : previous).click();
    }
  });
  card.addEventListener("close", () => {
    window.removeEventListener("resize", positionCard);
    card.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
    onFinish?.();
  }, {once: true});
  actions.append(skip, previous, next);
  card.append(ring, stepMeta, title, body, actions);
  document.body.append(card);
  card.showModal();
  window.addEventListener("resize", positionCard);
  renderStep();
}
