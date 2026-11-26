/* Run in a local browser environment with Playwright and a matching browser installed. */
const assert = require("node:assert/strict");
const {spawn, spawnSync} = require("node:child_process");
const {mkdtempSync, mkdirSync, rmSync, writeFileSync} = require("node:fs");
const {tmpdir} = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const playwright = require("playwright");

const root = path.resolve(process.env.XOTIRA_ROOT || path.join(__dirname, "../.."));
const results = path.resolve(process.env.QA_EVIDENCE || path.join(root, "browser-evidence"));
const python = process.env.XOTIRA_PYTHON || "python3";
const engine = process.env.QA_ENGINE || "chromium";
const password = "xotira-disposable-browser-fixture";
const widths = [320, 360, 390, 430, 768, 1024, 1280, 1440];

async function main() {
  const folder = mkdtempSync(path.join(tmpdir(), "xotira-browser-"));
  mkdirSync(results, {recursive: true});
  let app, browser;
  const log = {engine, app: process.env.QA_REVISION || "v22", cases: [], metrics: []};
  try {
    const vault = path.join(folder, "browser.xotira");
    const seed = spawnSync(python, [path.join(__dirname, "../batch1_fixtures.py"), vault], {
      cwd: root, env: {...process.env, PYTHONPATH: root}, encoding: "utf8",
    });
    assert.equal(seed.status, 0, seed.stderr);
    app = spawn(python, ["app.py", "--vault", vault, "--no-browser"], {cwd: root, stdio: ["ignore", "pipe", "inherit"]});
    const [line] = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The fixture server did not start.")), 8000);
      readline.createInterface({input: app.stdout}).once("line", value => {
        clearTimeout(timeout);
        resolve([value]);
      });
      app.once("error", reject);
      app.once("exit", code => reject(new Error("Fixture server exited: " + code)));
    });
    const url = line.match(/http:\/\/127\.0\.0\.1:\d+\/#\S+/)?.[0];
    assert.ok(url, "Expected a loopback launch URL");
    browser = await playwright[engine].launch(process.env.QA_BROWSER ? {executablePath: process.env.QA_BROWSER} : {});
    const page = await browser.newPage({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, hasTouch: true});
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const unlock = async () => {
      await page.waitForFunction(() => !document.querySelector("#workspace").hidden ||
        document.querySelector("#gate-message").textContent === "Enter your password to unlock your notes.");
      if (await page.locator("#workspace").isVisible()) return;
      await page.locator("#password").fill(password);
      await page.locator("#unlock-button").click();
      await page.locator("#workspace").waitFor();
    };
    await page.goto(url);
    await unlock();
    const open = async title => {
      if (!await page.locator("#notes").isVisible()) await page.locator("#toggle-sidebar").click();
      await page.locator("#notes").getByRole("button", {name: title, exact: true}).click();
    };
    await open("Image only");
    const picture = page.locator(".n-img-slot img");
    await picture.waitFor();
    await page.screenshot({path: path.join(results, "image-initial-390-dpr2.png")});
    const imageBase = await page.locator(".n-img-slot").getAttribute("data-img-src");
    const boundaries = page.locator(".notion-doc > p.n-image-boundary");
    assert.equal(await boundaries.count(), 2);
    await boundaries.first().tap({position: {x: 10, y: 9}});
    await page.keyboard.insertText("Before 🧭");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.insertText("After " + "x".repeat(200));
    await page.waitForFunction(() => document.querySelector("#saved").textContent === "Saved");
    for (let i = 0; i < 3; i++) {
      await page.reload();
      await unlock();
      await open("Image only");
      assert.equal(await boundaries.count(), 2);
      assert.equal(await page.locator(".n-img-slot").getAttribute("data-img-src"), imageBase);
      assert.equal(await boundaries.first().textContent(), "Before 🧭");
      assert.equal(await boundaries.last().textContent(), "After " + "x".repeat(200));
    }
    await page.locator("#toggle-source").click();
    assert.ok((await page.locator("#body").inputValue()).includes("](" + imageBase + ")"));
    await page.locator("#toggle-source").click();
    await page.screenshot({path: path.join(results, "image-390-dpr2.png")});
    log.cases.push("Image boundaries, navigation, source and reopen");

    for (let i = 1; i <= 6; i++) {
      await page.locator("#notes").getByRole("button", {name: new RegExp("Overflow fixture " + i + " ")}).click();
    }
    await open("Image only");
    for (const width of widths) {
      await page.setViewportSize({width, height: 844});
      await page.waitForFunction(() => document.querySelector(".stage-bar").clientWidth > 0);
      const metrics = await page.evaluate(() => {
        const stage = document.querySelector(".stage-bar").getBoundingClientRect();
        const more = document.querySelector("#file-menu summary").getBoundingClientRect();
        const image = document.querySelector(".n-img-slot img");
        const imageWidth = image?.getBoundingClientRect().width;
        return {viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth,
          stageRight: stage.right, moreRight: more.right, imageWidth};
      });
      assert.ok(metrics.document - metrics.viewport <= 1, JSON.stringify(metrics));
      assert.ok(metrics.moreRight <= metrics.viewport + 1, JSON.stringify(metrics));
      log.metrics.push({width, ...metrics});
    }
    await page.setViewportSize({width: 390, height: 844});
    await open("Drawing fixtures");
    const appendedDrawing = page.locator(".n-img-slot button").last();
    await appendedDrawing.click();
    await page.locator("#viewer-draw-edit").click();
    const canvas = page.locator("#draw-surface");
    await canvas.waitFor();
    const slider = page.locator("#draw-size");
    await slider.press("Home");
    assert.equal(await slider.inputValue(), "1");
    await slider.press("End");
    assert.equal(await slider.inputValue(), "20");
    for (const viewport of [{width: 390, height: 844}, {width: 844, height: 390}]) {
      await page.setViewportSize(viewport);
      const box = await canvas.boundingBox();
      assert.ok(Math.abs(box.width / box.height - 5 / 3) <= 0.015);
      log.metrics.push({canvas: box, ...viewport});
    }
    await canvas.click({position: {x: 60, y: 70}});
    await page.screenshot({path: path.join(results, "drawing-landscape-dpr2.png")});
    const update = page.waitForResponse(response => response.url().endsWith("?view=drawing") && response.request().method() === "POST");
    await page.locator("#draw-save").click();
    assert.equal((await update).status(), 200);
    await page.locator("#draw-dialog").waitFor({state: "hidden"});
    await page.locator("#viewer-draw-edit").click();
    await canvas.waitFor();
    await page.locator("#draw-cancel").click();
    page.once("dialog", dialog => void dialog.dismiss());
    await page.locator("#viewer-draw-delete").click();
    assert.ok(await page.locator("#viewer-panel").isVisible());
    page.once("dialog", dialog => void dialog.accept());
    await page.locator("#viewer-draw-delete").click();
    await page.locator("#viewer-panel").waitFor({state: "hidden"});
    await page.setViewportSize({width: 1280, height: 850});
    if (await page.locator("#toggle-sidebar").getAttribute("aria-pressed") !== "true") {
      await page.locator("#toggle-sidebar").click();
    }
    await open("Image only");
    await page.locator("#note-attachments").click();
    const attachments = page.locator(".editor #files .file-entry");
    await attachments.first().waitFor();
    assert.equal(await page.locator(".note-page #files").count(), 0);

    await page.locator("#note-mind-new").click();
    assert.equal(await page.locator("#mind-attach").isChecked(), true);
    await page.locator("#mind-title").fill("Attached fixture mind map");
    await page.locator("#mind-create-submit").click();
    const map = page.locator(".inline-mind-card").filter({has: page.getByRole("heading", {name: "Attached fixture mind map"})});
    const topic = map.locator(".mind-topic > button").first();
    await topic.waitFor();
    await map.getByRole("button", {name: "+ Branch", exact: true}).click();
    const children = () => page.locator(".mind-topic > button:first-child").filter({hasText: /^New topic$/});
    await children().filter({visible: true}).first().waitFor();
    const expand = map.getByRole("button", {name: "Expand mind map"});
    await expand.click();
    await page.locator("#viewer-panel").waitFor();
    assert.equal(await page.locator("#viewer-panel .mind-topic > button[aria-pressed='true']").textContent(), "New topic");
    await page.locator("#viewer-tools").getByRole("button", {name: "Delete branch", exact: true}).click();
    assert.equal(await page.locator("#viewer-panel .mind-topic").count(), 1);
    await page.getByRole("button", {name: "Back to note"}).click();
    assert.equal(await page.locator("#title").inputValue(), "Image only");
    await map.getByRole("button", {name: "Undo", exact: true}).click();
    assert.equal(await map.locator(".mind-topic").count(), 2);

    for (const width of widths) {
      await page.setViewportSize({width, height: 844});
      const noteMetrics = await map.evaluate(node => ({
        width: document.documentElement.clientWidth, right: node.getBoundingClientRect().right,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        toolOverflow: node.querySelector(".viewer-tools").scrollWidth - node.querySelector(".viewer-tools").clientWidth,
      }));
      assert.ok(noteMetrics.right <= noteMetrics.width + 1 && noteMetrics.overflow <= 1 && noteMetrics.toolOverflow <= 1,
        JSON.stringify(noteMetrics));
      await expand.click();
      const fullMetrics = await page.locator("#viewer-tools").evaluate(node => ({
        viewport: document.documentElement.clientWidth, right: node.getBoundingClientRect().right,
        toolOverflow: node.scrollWidth - node.clientWidth,
      }));
      assert.ok(fullMetrics.right <= fullMetrics.viewport + 1 && fullMetrics.toolOverflow <= 1, JSON.stringify(fullMetrics));
      await page.getByRole("button", {name: "Back to note"}).click();
      await map.waitFor();
    }
    await page.setViewportSize({width: 1280, height: 850});
    if (await page.locator("#toggle-sidebar").getAttribute("aria-pressed") !== "true") {
      await page.locator("#toggle-sidebar").click();
    }
    if (await page.locator("#toggle-inspector").getAttribute("aria-pressed") !== "true") {
      await page.locator("#note-attachments").click();
    }
    await attachments.getByText(/Attached fixture mind map/i).waitFor();

    const imageButton = page.locator(".n-img-slot .embedded-image");
    await imageButton.scrollIntoViewIfNeeded();
    const imageBox = await imageButton.boundingBox();
    const dropTarget = page.locator("#trash");
    const dropBox = await dropTarget.boundingBox();
    const left = imageBox.x + imageBox.width / 2;
    const top = imageBox.y + Math.min(imageBox.height / 2, 40);
    await page.mouse.move(left, top);
    await page.mouse.down();
    await page.mouse.move(left + 20, top, {steps: 5});
    await dropTarget.and(page.locator(".is-drop-ready")).waitFor();
    assert.equal(await dropTarget.getAttribute("class").then(value => value.includes("is-drop-target")), false);
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#trash")).backgroundColor === "rgb(23, 91, 188)");
    await page.mouse.move(dropBox.x + dropBox.width / 2, dropBox.y + dropBox.height / 2, {steps: 8});
    await page.mouse.move(dropBox.x + dropBox.width / 2 + 1, dropBox.y + dropBox.height / 2);
    await dropTarget.and(page.locator(".is-drop-target")).waitFor();
    await page.mouse.up();
    await imageButton.waitFor({state: "detached"});
    assert.ok(await map.isVisible());
    log.cases.push("Inline map expansion, branch deletion and preserved Undo at 320–1440px; inline image drag");

    await page.locator("#nav-calendar").click();
    await page.locator(".calendar-month [aria-current='date']").click();
    await page.getByRole("button", {name: "New event", exact: true}).click();
    await page.locator("#new-title").fill("Fixture calendar event");
    await page.locator("#create-form button[type='submit']").click();
    await page.locator("#prop-reminder").waitFor();
    await page.locator("#prop-reminder").fill("2020-11-21T12:00");
    await page.locator("#prop-reminder").press("Tab");
    await page.locator("#show-reminders").waitFor();
    await page.locator("#show-reminders").click();
    await page.locator("#reminder-list").getByRole("button", {name: "Fixture calendar event"}).waitFor();
    await page.locator("#reminder-close").click();

    await page.locator("#nav-roadmaps").click();
    await page.getByRole("button", {name: "New roadmap", exact: true}).click();
    await page.locator("#reading-panel").waitFor();
    await page.locator("#nav-roadmaps").click();
    const task = page.locator(".roadmap-task input").first();
    await task.waitFor();
    await task.check();
    await page.waitForFunction(() => document.querySelector(".roadmap-summary progress")?.value === 1);
    log.cases.push("Calendar event, durable reminder and roadmap completion");

    const dragSource = page.locator("#notes").getByRole("button", {name: "Fixture calendar event", exact: true});
    const trash = page.locator("#trash");
    await dragSource.scrollIntoViewIfNeeded();
    const sourceBox = await dragSource.boundingBox();
    const trashBox = await trash.boundingBox();
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(trashBox.x + trashBox.width / 2, trashBox.y + trashBox.height / 2, {steps: 8});
    await page.mouse.move(trashBox.x + trashBox.width / 2 + 1, trashBox.y + trashBox.height / 2);
    await trash.and(page.locator(".is-drop-target")).waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#trash")).backgroundColor === "rgb(23, 91, 188)");
    await page.mouse.up();
    await dragSource.waitFor({state: "detached"});
    await trash.click();
    await dragSource.waitFor();
    log.cases.push("Native note drag lights up Trash, then moves the note into it");
    assert.deepEqual(errors, []);
    log.cases.push("Native range, ratio, drawing edit/save/cancel/delete");
    log.status = "PASS";
  } catch (error) {
    log.status = "FAILED_OR_BLOCKED";
    log.error = String(error).split("\n")[0].replace(/\/#\S+/g, "/#REDACTED");
    throw new Error(log.error);
  } finally {
    if (browser) await browser.close();
    if (app) {
      const exited = new Promise(resolve => app.once("close", resolve));
      if (app.exitCode === null && app.signalCode === null) { app.kill(); await exited; }
    }
    rmSync(folder, {recursive: true, force: true});
    writeFileSync(path.join(results, "batch1-browser.json"), JSON.stringify(log, null, 2));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
