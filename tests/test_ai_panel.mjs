import assert from "node:assert/strict";
import {test} from "node:test";
import {readAIStream} from "../web/ai-panel.js";
import {renderMarkdown} from "../web/markdown.js";

test("AI event stream preserves JSON and multibyte text across chunks", async () => {
  const bytes = new TextEncoder().encode('{"type":"text_delta","text":"O‘rik"}\n{"type":"done"}');
  const stream = new ReadableStream({start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  }});
  const seen = [];
  await readAIStream(stream, event => seen.push(event));
  assert.deepEqual(seen, [{type: "text_delta", text: "O‘rik"}, {type: "done"}]);
});

test("AI Markdown renders formatting while keeping HTML, links and images inert", () => {
  const tags = [];
  const make = (tag, text = "") => ({tag, textContent: text, append() {}, appendChild() {}});
  globalThis.document = {
    createDocumentFragment: () => make("fragment"),
    createElement(tag) { tags.push(tag); return make(tag); },
    createTextNode: text => make("text", text),
  };
  renderMarkdown("**Bold** [Edit](https://example.test) ![Image](https://example.test/i) <script>bad</script>",
                 {untrusted: true});
  assert.ok(tags.includes("strong"));
  for (const tag of ["a", "img", "script"]) assert.equal(tags.includes(tag), false);
});
