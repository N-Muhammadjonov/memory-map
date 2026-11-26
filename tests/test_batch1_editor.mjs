import assert from "node:assert/strict";
import test from "node:test";
import {docDomToMarkdown, ensureImageBoundaries, markdownToDocHtml} from "../web/notion-editor.js";

const textNode = value => ({nodeType: 3, textContent: value});

class Element {
  nodeType = 1;
  childNodes = [];
  dataset = {};
  classes = new Set();
  classList = {
    add: (...values) => values.forEach(value => this.classes.add(value)),
    remove: (...values) => values.forEach(value => this.classes.delete(value)),
    contains: value => this.classes.has(value),
    toggle: (value, on) => on ? this.classes.add(value) : this.classes.delete(value),
  };

  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = {createElement: name => new Element(name)};
  }

  get textContent() { return this.childNodes.map(node => node.textContent).join(""); }
  get previousElementSibling() { return this.parent.childNodes[this.parent.childNodes.indexOf(this) - 1]; }
  get nextElementSibling() { return this.parent.childNodes[this.parent.childNodes.indexOf(this) + 1]; }
  querySelectorAll(selector) { return this.childNodes.filter(node => node.classes?.has(selector.split(".").at(-1))); }
  querySelector() {
    return this.childNodes.find(node => node.tagName === "BR" && "imagePlaceholder" in node.dataset);
  }
  remove() { this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1); }
  append(node) { node.parent = this; this.childNodes.push(node); }
  before(node) { node.parent = this.parent; this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 0, node); }
  after(node) { node.parent = this.parent; this.parent.childNodes.splice(this.parent.childNodes.indexOf(this) + 1, 0, node); }
}

const sourceFor = digit => "attachment:" + digit.repeat(32);
const image = (digit, alt) => {
  const el = new Element("div");
  el.classList.add("n-img-slot");
  el.dataset = {imgSrc: sourceFor(digit), imgAlt: alt};
  return el;
};

test("image boundaries are editable siblings and serialize no empty markers", () => {
  globalThis.Node = {TEXT_NODE: 3, ELEMENT_NODE: 1};
  const doc = new Element("div");
  doc.append(image("a", ""));
  doc.append(image("b", "Second"));
  const original = `![](${sourceFor("a")})\n\n![Second](${sourceFor("b")})`;
  for (let iteration = 0; iteration < 3; iteration++) ensureImageBoundaries(doc);
  assert.deepEqual(doc.childNodes.map(node => node.tagName), ["P", "DIV", "P", "DIV", "P"]);
  assert.equal(docDomToMarkdown(doc), original);
  for (const [index, text] of [[0, "Before"], [2, "Between"], [4, "After"]]) {
    doc.childNodes[index].append(textNode(text));
  }
  ensureImageBoundaries(doc);
  assert.equal(docDomToMarkdown(doc),
    `Before\n\n![](${sourceFor("a")})\n\nBetween\n\n![Second](${sourceFor("b")})\n\nAfter`);
  const html = markdownToDocHtml(`Before\n![](${sourceFor("a")})\nAfter`);
  assert.match(html, /<p>Before<\/p><div class="n-img-slot" contenteditable="false"/);
  assert.match(html, /<\/div><p>After<\/p>/);
});

test("Markdown keeps vault links and high-level numbered headings after rendering", async () => {
  const {inlineMdToHtml, markdownToDocHtml} = await import("../web/notion-editor.js");
  const {extractOutline} = await import("../web/markdown.js");
  assert.match(inlineMdToHtml("[Review](../notes/Week%202.md#100%25%20Done)"),
    /href="#" data-href="\.\.\/notes\/Week%202\.md#100%25%20Done"/);
  assert.match(inlineMdToHtml("[This section](#100%25%20Done)"),
    /href="#" data-href="#100%25%20Done"/);
  const markdown = "Overview\n#### 100% Done ###\n\n###### C#";
  assert.equal(markdownToDocHtml(markdown), "<p>Overview</p><h4>100% Done</h4><h6>C#</h6>");
  assert.deepEqual(extractOutline(markdown), [{level: 4, text: "100% Done"}, {level: 6, text: "C#"}]);
});
