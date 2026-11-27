import assert from 'node:assert/strict';
import test from 'node:test';
import {FONT_SIZE_POINTS, readStoredInlineStyle, storedSize, storedHighlight} from '../web/inline-format.js';
import {inlineMdToHtml} from '../web/notion-editor.js';

test('stored inline size and highlight preserve nested styles and plain surrounding text', () => {
  const raw=storedSize(24,storedHighlight('green','**beta**'));
  assert.equal(raw,'<span data-mm-size="24"><mark data-mm-hl="green">**beta**</mark></span>');
  const style=readStoredInlineStyle(raw+' suffix');
  assert.equal(style.raw,raw);assert.equal(style.type,'size');assert.equal(style.value,'24');
  assert.equal(inlineMdToHtml('alpha '+raw+' gamma'), 'alpha <span data-mm-size="24"><mark data-hl="green"><strong>beta</strong></mark></span> gamma');
  assert.equal(inlineMdToHtml('==legacy=='), '<mark>legacy</mark>');
  assert.equal(storedHighlight('pink',''), '');
  assert.equal(storedSize(99,'ordinary'),'ordinary');
  assert.ok(FONT_SIZE_POINTS.includes(12));
});

test('inline style parser does not enable arbitrary HTML or tampered attributes', () => {
  for (const unsafe of ['<span data-mm-size="99">bad</span>','<mark data-mm-hl="unknown">bad</mark>',
    '<span data-mm-size="24" onclick="bad()">bad</span>','<span data-mm-size="24">not closed']) {
    assert.equal(readStoredInlineStyle(unsafe),null);
    assert.ok(inlineMdToHtml(unsafe).startsWith('&lt;'));
  }
  assert.match(inlineMdToHtml('<span data-mm-size="12"><img src=x onerror=bad()></span>'), /&lt;img src=x onerror=bad\(\)&gt;/);
  assert.equal(inlineMdToHtml('`<span data-mm-size="12">literal</span>`'),'<code>&lt;span data-mm-size=&quot;12&quot;&gt;literal&lt;/span&gt;</code>');
  assert.match(inlineMdToHtml('[<span data-mm-size="24">label</span>](https://example.com)'), /<span data-mm-size="24">label<\/span><\/a>/);
});
