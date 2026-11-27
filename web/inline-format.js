/** Safe, round-trippable inline styles and precise text-range editing. */
export const FONT_SIZE_POINTS = Object.freeze([8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 48, 72]);
export const HIGHLIGHT_TONES = Object.freeze(["yellow", "green", "blue", "pink"]);

const styleTagPattern = escaped => escaped
  ? /&lt;(?:span data-mm-size=&quot;(\d{1,2})&quot;|mark data-mm-hl=&quot;([a-z]+)&quot;|\/(span|mark))&gt;/g
  : /<(?:span data-mm-size="(\d{1,2})"|mark data-mm-hl="([a-z]+)"|\/(span|mark))>/g;

function opening(match) {
  if (match[1] !== undefined) return {tag:"span", type:"size", value:String(Number(match[1])), valid:FONT_SIZE_POINTS.includes(Number(match[1]))};
  if (match[2] !== undefined) return {tag:"mark", type:"highlight", value:match[2], valid:HIGHLIGHT_TONES.includes(match[2])};
  return null;
}

/** Recognize only balanced exact style syntax; raw arbitrary HTML remains untrusted. */
export function readStoredInlineStyle(source) {
  const pattern = styleTagPattern(false);
  const first = pattern.exec(source);
  const style = first && first.index === 0 ? opening(first) : null;
  if (!style?.valid) return null;
  const stack = [style.tag];
  let match;
  while ((match = pattern.exec(source))) {
    const next = opening(match);
    if (next) stack.push(next.tag);
    else {
      if (stack.at(-1) !== match[3]) return null;
      stack.pop();
      if (!stack.length) return {...style, raw:source.slice(0, pattern.lastIndex), inner:source.slice(first[0].length, match.index)};
    }
  }
  return null;
}

/** Only reinstate known escaped tag pairs; never unescape their contents or arbitrary attributes. */
export function restoreEscapedInlineStyles(source, stash) {
  const stack = [], matched = new Map();
  for (const match of source.matchAll(styleTagPattern(true))) {
    const style = opening(match);
    if (style) stack.push({style, match});
    else if (stack.at(-1)?.style.tag === match[3]) {
      const start = stack.pop();
      if (!start.style.valid) continue;
      const {tag,type,value} = start.style;
      matched.set(start.match.index, type === "size" ? `<span data-mm-size="${value}">` : `<mark data-hl="${value}">`);
      matched.set(match.index, `</${tag}>`);
    } else stack.length = 0;
  }
  return source.replace(styleTagPattern(true), (raw, _s, _h, _c, offset) => matched.has(offset) ? stash(matched.get(offset)) : raw);
}

export function storedSize(value, inner) {
  return inner && FONT_SIZE_POINTS.includes(Number(value)) ? `<span data-mm-size="${Number(value)}">${inner}</span>` : inner;
}

export function storedHighlight(value, inner) {
  return inner && HIGHLIGHT_TONES.includes(value) ? `<mark data-mm-hl="${value}">${inner}</mark>` : inner ? `==${inner}==` : "";
}

const formatSelector = type => type === "size" ? "span[data-mm-size]" : "mark";
const formatValue = (element, type) => !element ? null : type === "size" ? element.dataset.mmSize : (element.dataset.hl || "yellow");

/** Split siblings around a selected branch without cloning/moving unrelated text out of its formatting. */
function isolateChild(child, parent) {
  if (child.previousSibling) {
    const before = parent.cloneNode(false);
    parent.before(before);
    while (parent.firstChild !== child) before.append(parent.firstChild);
  }
  if (child.nextSibling) {
    const after = parent.cloneNode(false);
    parent.after(after);
    while (child.nextSibling) after.append(child.nextSibling);
  }
}

/** Lift just one text node's ancestor branch out of a style, preserving every other style. */
export function removeTextStyle(node, wrapper) {
  if (!wrapper?.contains(node)) return;
  let branch = node;
  while (branch.parentNode !== wrapper) {
    const parent = branch.parentNode;
    isolateChild(branch, parent);
    branch = parent;
  }
  isolateChild(branch, wrapper);
  wrapper.replaceWith(branch);
}

function eligibleText(node, root) {
  return Boolean(node.data.length && node.parentElement && root.contains(node) &&
    !node.parentElement.closest('[contenteditable="false"], .n-code-box, pre, code, button, select, textarea, input'));
}

/** Apply/remove the style to exact selected character spans, including selections spanning blocks. */
export function applyInlineStyle(root, selection, type, value) {
  if (!selection?.rangeCount || selection.isCollapsed || !["size", "highlight"].includes(type)) return false;
  if (type === "size" && value !== null && !FONT_SIZE_POINTS.includes(Number(value))) return false;
  if (type === "highlight" && !HIGHLIGHT_TONES.includes(value)) return false;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return false;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4); // NodeFilter.SHOW_TEXT
  const selector = formatSelector(type), selected = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!eligibleText(node, root) || !range.intersectsNode(node)) continue;
    const start = range.startContainer === node ? range.startOffset : 0;
    const end = range.endContainer === node ? range.endOffset : node.data.length;
    if (end > start) selected.push({node,start,end,existing:formatValue(node.parentElement.closest(selector),type)});
  }
  if (!selected.length) return false;
  const remove = value === null || (type === "highlight" && selected.every(entry => entry.existing === value));
  const nodes = [];
  // Process backwards; splitting and moving branches preserves the original text node references.
  for (const entry of selected.reverse()) {
    let text = entry.node;
    if (entry.end < text.data.length) text.splitText(entry.end);
    if (entry.start > 0) text = text.splitText(entry.start);
    let existing;
    while ((existing = text.parentElement?.closest(selector)) && root.contains(existing)) removeTextStyle(text,existing);
    if (!remove) {
      const wrapper = doc.createElement(type === "size" ? "span" : "mark");
      if (type === "size") wrapper.dataset.mmSize = String(Number(value));
      else wrapper.dataset.hl = value;
      text.before(wrapper);wrapper.append(text);
    }
    nodes.unshift(text);
  }
  const updated = doc.createRange();
  updated.setStart(nodes[0], 0);
  updated.setEnd(nodes.at(-1), nodes.at(-1).data.length);
  selection.removeAllRanges();selection.addRange(updated);
  return true;
}

/** On the second consecutive space, insert an ordinary space outside the mark. */
export function exitHighlightAtCaret(root, selection) {
  if (!selection?.rangeCount || !selection.isCollapsed || !root.contains(selection.anchorNode)) return false;
  const range = selection.getRangeAt(0);
  const anchor = selection.anchorNode.nodeType === 3 ? selection.anchorNode.parentElement : selection.anchorNode;
  const mark = anchor?.closest?.("mark");
  if (!mark || !root.contains(mark)) return false;
  const plain = root.ownerDocument.createTextNode(" ");
  range.insertNode(plain);
  let wrapper;
  while ((wrapper = plain.parentElement?.closest("mark")) && root.contains(wrapper)) removeTextStyle(plain, wrapper);
  const caret = root.ownerDocument.createRange();caret.setStart(plain,1);caret.collapse(true);
  selection.removeAllRanges();selection.addRange(caret);
  return true;
}
