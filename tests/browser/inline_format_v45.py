"""Real browser regression: selected text size/color, precise reformatting, saved markup, Space exit."""
from playwright.sync_api import expect, sync_playwright
from layout_v23 import boot

PASSWORD = "disposable-inline-format-test-password"


def make_note(page, title, text):
    page.click("#nav-home")
    page.locator(".home-actions .primary").click()
    page.fill("#new-title", title)
    page.locator("#create-form button[type=submit]").click()
    expect(page.locator("#title")).to_have_value(title)
    expect(page.locator(".notion-doc")).to_be_focused()
    page.keyboard.type(text)


def select_chars(page, start, end):
    page.evaluate("""([start,end])=>{
      const p=document.querySelector('.notion-doc p');p.closest('[contenteditable]').focus();
      const walk=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);let offset=0,node,first,last;
      while(node=walk.nextNode()){
        const next=offset+node.length;
        if(!first&&start>=offset&&start<next)first=[node,start-offset];
        if(!last&&end>offset&&end<=next)last=[node,end-offset];
        offset=next;
      }
      if(!first||!last)throw Error('Selection offsets outside paragraph');
      const range=document.createRange();range.setStart(...first);range.setEnd(...last);
      const sel=getSelection();sel.removeAllRanges();sel.addRange(range);
    }""", [start,end])
    expect(page.locator("#bubble-bar")).to_be_visible()


def marked(page, tone):
    return page.locator(f'.notion-doc mark[data-hl="{tone}"]').all_text_contents()


def sized(page, size):
    return page.locator(f'.notion-doc span[data-mm-size="{size}"]').all_text_contents()


def main():
    server, url = boot(seed=False)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width":1280,"height":800})
            page.goto(url)
            page.wait_for_selector("#password:enabled")
            page.fill("#password",PASSWORD)
            page.fill("#confirmation",PASSWORD)
            page.click("#unlock-button")
            expect(page.locator("#workspace")).to_be_visible()
            title="Exact inline styles"
            make_note(page,title,"Alpha beta gamma")
            select_chars(page,6,10)
            page.locator('[data-cmd="mark-green"]').click()
            assert marked(page,"green")==["beta"]
            select_chars(page,7,9)
            page.locator('[data-cmd="mark-blue"]').click()
            assert marked(page,"green")==["b","a"], marked(page,"green")
            assert marked(page,"blue")==["et"]
            # Toggling the same color removes only the selected substring.
            select_chars(page,7,9)
            page.locator('[data-cmd="mark-blue"]').click()
            assert marked(page,"blue")==[]
            assert marked(page,"green")==["b","a"]
            expect(page.locator(".notion-doc p").first).to_have_text("Alpha beta gamma")
            expect(page.locator("#font-size-select")).to_be_visible()
            assert page.locator("#bubble-bar #font-size-select").count() == 0
            page.click("#title")
            page.locator("#font-size-select").select_option("72")
            assert sized(page,72)==[]
            select_chars(page,11,16)
            page.locator('.bubble-font-size').select_option('24')
            assert sized(page,24)==["gamma"], sized(page,24)
            assert page.locator('.notion-doc span[data-mm-size="24"]').evaluate('(node)=>getComputedStyle(node).fontSize')=="32px"
            select_chars(page,12,14)
            page.locator('.bubble-font-size').select_option('12')
            assert sized(page,24)==["g","ma"], sized(page,24)
            assert sized(page,12)==["am"]
            select_chars(page,12,14)
            page.locator('.bubble-font-size').select_option('default')
            assert sized(page,12)==[]
            assert sized(page,24)==["g","ma"]
            select_chars(page,6,7)
            page.locator('.bubble-font-size').select_option('18')
            assert sized(page,18)==["b"] and marked(page,"green")==["b","a"]
            # Persist through note navigation (Markdown serialization and rehydration).
            page.click("#title")
            page.click("#nav-home")
            page.locator("#home-panel").get_by_role("button",name=title,exact=True).click()
            expect(page.locator("#title")).to_have_value(title)
            assert sized(page,18)==["b"] and sized(page,24)==["g","ma"]
            assert marked(page,"green")==["b","a"]
            expect(page.locator(".notion-doc p").first).to_have_text("Alpha beta gamma")

            make_note(page,"Highlight Space exit","start highlight end")
            select_chars(page,6,15)
            page.locator('[data-cmd="mark-pink"]').click()
            page.evaluate("""()=>{const mark=document.querySelector('.notion-doc mark');const r=document.createRange();r.selectNodeContents(mark);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);}""")
            page.keyboard.press("Space")
            page.keyboard.press("Space")
            page.keyboard.type("outside")
            assert "outside" in page.locator(".notion-doc p").first.text_content()
            assert not any("outside" in text for text in marked(page,"pink")), marked(page,"pink")
            assert "highlight" in "".join(marked(page,"pink"))

            # Selections across blocks must preserve both paragraphs and nested bold.
            result=page.evaluate("""async()=>{
              const {applyInlineStyle}=await import('/inline-format.js');
              const {docDomToMarkdown,markdownToDocHtml}=await import('/notion-editor.js');
              const {renderMarkdown}=await import('/markdown.js');
              const root=document.createElement('div');root.contentEditable='true';root.innerHTML='<p><strong>first</strong> line</p><p>second tail</p>';document.body.append(root);
              const r=document.createRange();r.setStart(root.querySelector('strong').firstChild,2);r.setEnd(root.lastChild.firstChild,3);const selection=getSelection();selection.removeAllRanges();selection.addRange(r);
              applyInlineStyle(root,selection,'highlight','yellow');
              const md=docDomToMarkdown(root);const restored=document.createElement('div');restored.innerHTML=markdownToDocHtml(md);
              const preview=document.createElement('div');preview.append(renderMarkdown('<span data-mm-size="24"><mark data-mm-hl="blue">**sample**</mark></span>',{}));
              const result={paragraphs:root.querySelectorAll('p').length,marks:[...root.querySelectorAll('mark')].map(m=>m.textContent).join(''),bold:root.querySelector('strong').textContent,roundtrip:restored.textContent,preview:preview.querySelector('[data-mm-size="24"] mark[data-hl="blue"] strong')?.textContent};root.remove();return result;
            }""")
            assert result=={"paragraphs":2,"marks":"rst linesec","bold":"first","roundtrip":"first linesecond tail","preview":"sample"},result
            # All sidebar content shares one scroll container, not just the notes list.
            page.set_viewport_size({"width":1280,"height":390})
            scroll = page.locator(".library").evaluate("""el => {
                const nav = el.querySelector(".side-nav");
                const before = nav.getBoundingClientRect().top;
                el.scrollTop = el.scrollHeight;
                return {outer: el.scrollTop, moved: before - nav.getBoundingClientRect().top,
                        notes: getComputedStyle(el.querySelector(".notes")).overflowY};
            }""")
            assert scroll["outer"] > 0 and scroll["moved"] > 0 and scroll["notes"] == "visible", scroll
            page.set_viewport_size({"width":1280,"height":800})
            expect(page.locator("#font-size-select")).to_be_visible()
            expect(page.locator("#spell-toggle")).to_be_hidden()
            page.locator("#language-menu summary").click()
            expect(page.locator("#spell-toggle")).to_be_visible()
            original_spell = page.locator("#spell-toggle").get_attribute("aria-pressed")
            page.locator("#spell-toggle").click()
            assert page.locator("#spell-toggle").get_attribute("aria-pressed") != original_spell
            page.locator("#language-menu summary").click()
            expect(page.locator("#spell-toggle")).to_be_hidden()
            page.locator("#file-menu summary").click()
            page.locator("#open-feedback").click()
            expect(page.locator("#feedback-dialog")).to_be_visible()
            assert page.locator("#fb-contact").count() == 0
            page.locator("#fb-cancel").click()
            browser.close()
            print("PASS exact selected size/highlight, nested and multi-block formatting, persistence, preview, double-space exit")
    finally:
        server.terminate()
        server.wait(timeout=10)


if __name__=="__main__":
    main()
