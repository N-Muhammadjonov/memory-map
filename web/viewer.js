import {AttachmentMarkup} from "./attachment-markup.js";
import {CanvasBoard} from "./canvas-board.js";
import {MindMapBoard} from "./mind-map.js";
import {readMindMap} from "./mind-map-model.js";

const IMAGES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  svg: "image/svg+xml", heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff",
};
const AUDIO = {
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg",
  flac: "audio/flac", aac: "audio/aac", opus: "audio/ogg", aiff: "audio/aiff", mid: "audio/midi",
};
const VIDEO = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", ogv: "video/ogg",
  mkv: "video/x-matroska", avi: "video/x-msvideo", mpg: "video/mpeg", mpeg: "video/mpeg",
};
const TEXT = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "log", "xml", "html", "htm", "css",
  "js", "jsx", "mjs", "ts", "tsx", "py", "yaml", "yml", "ini", "toml", "conf", "srt", "vtt",
  "sh", "bash", "sql", "c", "h", "cpp", "cc", "java", "kt", "swift", "go", "rs", "rb", "php", "cs"]);
const OFFICE = new Set(["docx", "docm", "xlsx", "xlsm", "pptx", "pptm", "odt", "ods", "odp"]);
const TEXT_BOM = { "255,254": "utf-16le", "254,255": "utf-16be" };
const TEXT_LIMIT = 512 * 1024;
const CANVAS_LIMIT = 8 * 1024 * 1024;
const MIND_MAP_LIMIT = 2 * 1024 * 1024;

function extension(name) {
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
}

export function previewKind(name, bytes) {
  const suffix = extension(name);
  if (suffix === "canvas" || suffix === "mindmap") return {kind: suffix};
  const marker = new TextDecoder("latin1").decode(bytes);
  if (/^%PDF-[0-9]+\.[0-9]+/m.test(marker.slice(0, 1024)) || suffix === "pdf") return {kind: "pdf"};
  if (byteHeader(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return {kind: "image", mime: "image/png"};
  if (byteHeader(bytes, [255, 216, 255])) return {kind: "image", mime: "image/jpeg"};
  if (/^GIF8[79]a/.test(marker)) return {kind: "image", mime: "image/gif"};
  if (marker.startsWith("RIFF") && marker.slice(8, 12) === "WEBP") return {kind: "image", mime: "image/webp"};
  if (marker.startsWith("RIFF") && marker.slice(8, 12) === "WAVE") return {kind: "audio", mime: "audio/wav"};
  if (marker.startsWith("fLaC")) return {kind: "audio", mime: "audio/flac"};
  if (marker.startsWith("ID3")) return {kind: "audio", mime: "audio/mpeg"};
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(marker)) return {kind: "image", mime: "image/svg+xml"};
  if (OFFICE.has(suffix)) return {kind: "office"};
  if (Object.hasOwn(IMAGES, suffix)) return {kind: "image", mime: IMAGES[suffix]};
  if (Object.hasOwn(AUDIO, suffix)) return {kind: "audio", mime: AUDIO[suffix]};
  if (Object.hasOwn(VIDEO, suffix)) return {kind: "video", mime: VIDEO[suffix]};
  const encoding = TEXT_BOM[bytes.slice(0, 2).join(",")];
  if (encoding) return {kind: "text", encoding};
  let unicode = "";
  try { unicode = new TextDecoder("utf-8", {fatal: true}).decode(bytes, {stream: true}); }
  catch {}
  const looksText = unicode && !/[\x00-\x08\x0e-\x1f\x7f]/.test(unicode);
  const looksLegacyText = TEXT.has(suffix) && ![...bytes].some(byte => byte < 32 && ![9, 10, 12, 13].includes(byte));
  if (looksText || looksLegacyText || (!bytes.length && TEXT.has(suffix))) {
    return {kind: "text", encoding: looksText || !bytes.length ? "utf-8" : "windows-1252"};
  }
  return {kind: "download"};
}

function byteHeader(sample, header) {
  return header.every((value, index) => sample[index] === value);
}

export function textPreviewPages(text) {
  const pages = [];
  let lines = [];
  let length = 0;
  for (const line of text.split("\n")) {
    const chars = Array.from(line);
    const segments = [];
    for (let from = 0; from < chars.length; from += 1500) segments.push(chars.slice(from, from + 1500).join(""));
    if (!segments.length) segments.push("");
    for (const part of segments) {
      if (lines.length >= 55 || length + part.length > 7000) {
        pages.push(lines.join("\n"));
        lines = [];
        length = 0;
      }
      lines.push(part);
      length += part.length;
    }
  }
  pages.push(lines.join("\n"));
  return pages;
}

function el(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

async function readMapBlob(blob) {
  if (blob.size > MIND_MAP_LIMIT) throw new Error("The mind map exceeds 2 MiB.");
  const bytes = await blob.arrayBuffer();
  const map = readMindMap(new TextDecoder().decode(bytes));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const checksum = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  return {map, checksum};
}

export function fileLabel(name) {
  return extension(name).slice(0, 6).toUpperCase() || "FAYL";
}

export function fileType(name) {
  const suffix = extension(name);
  if (["pdf", "canvas", "mindmap"].includes(suffix)) return suffix;
  if (Object.hasOwn(IMAGES, suffix)) return "image";
  if (OFFICE.has(suffix) || ["doc", "xls", "ppt", "rtf"].includes(suffix)) return "office";
  if (Object.hasOwn(AUDIO, suffix) || Object.hasOwn(VIDEO, suffix)) return "media";
  return "text";
}

export class FileViewer {
  constructor(container, tools, heading, request, openReference, mindMapOptions) {
    this.container = container;
    this.tools = tools;
    this.heading = heading;
    this.request = request;
    this.openReference = openReference;
    this.mindMapOptions = mindMapOptions;
    this.active = null;
  }

  close() {
    const session = this.active;
    this.active = null;
    if (session) {
      session.abort.abort();
      session.board?.close();
      session.markup?.close();
      session.render?.cancel();
      if (session.pdfTask) void session.pdfTask.destroy().catch(() => {});
      if (session.url) URL.revokeObjectURL(session.url);
    }
    this.container.replaceChildren();
    this.container.classList.remove("canvas-content", "mind-map-content");
    this.tools.replaceChildren();
    this.tools.inert = false;
    this.heading.textContent = "";
  }

  async flush() {
    this.active?.board?.finishRename(true);
    await this.active?.board?.flush();
    await this.active?.markup?.flush();
  }

  moveMindMapTo(target) {
    const session = this.active;
    if (!session?.board || fileType(session.file.name) !== "mindmap" || target.active) return false;
    const {board} = session;
    this.active = null;
    session.viewer = target;
    target.active = session;
    target.heading.textContent = session.file.mapTitle || session.file.name;
    target.tools.replaceChildren(...this.tools.childNodes);
    target.container.replaceChildren(board.main);
    target.container.classList.add("mind-map-content");
    this.container.classList.remove("mind-map-content");
    target.mindMapOptions.inspectorHost.replaceChildren(board.inspector);
    this.tools.inert = false;
    target.tools.inert = Boolean(board.reloading);
    board.tools = target.tools;
    board.firstVisible = false;
    board.schedule();
    return true;
  }

  message(text, isError = false) {
    const message = el("p", text);
    message.className = isError ? "viewer-message error" : "viewer-message";
    this.container.replaceChildren(message);
  }

  async open(noteId, file, canEdit = true) {
    this.close();
    const path = `/notes/${noteId}/files/${file.id}`;
    const session = {noteId, file, path, canEdit, viewer: this, abort: new AbortController(), pageNumber: 1, pageSequence: 0};
    this.active = session;
    this.heading.textContent = file.mapTitle || file.name;
    this.message("Opening file…");
    const suffix = extension(file.name);
    try {
      if (OFFICE.has(suffix)) {
        const data = await this.request(path + "?view=document", {signal: session.abort.signal});
        if (this.active === session) await this.showOffice(session, data.sections);
        return;
      }
      const response = await this.request(path, {blob: true, signal: session.abort.signal});
      const blob = await response.blob();
      const sample = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
      if (this.active !== session) return;
      const preview = previewKind(file.name, sample);
      if (preview.kind === "download") {
        this.message("Download the original to open this format in its app (" + this.fileSize(blob.size) + ").");
      } else if (preview.kind === "pdf") {
        await this.showPdf(session, new Uint8Array(await blob.arrayBuffer()));
      } else if (preview.kind === "mindmap") {
        const {map, checksum: initialChecksum} = await readMapBlob(blob);
        let checksum = initialChecksum;
        if (this.active !== session) return;
        this.container.classList.add("mind-map-content");
        session.board = new MindMapBoard(this.container, this.tools, map, {
          editable: canEdit,
          notes: this.mindMapOptions.notes,
          readLinkedNote: (id, signal) => session.viewer.mindMapOptions.readLinkedNote?.(id, signal) ?? Promise.resolve(""),
          inspectorHost: this.mindMapOptions.inspectorHost,
          inline: () => Boolean(session.viewer.mindMapOptions.inline),
          showInspector: () => session.viewer.mindMapOptions.showInspector(),
          trash: canEdit ? () => session.viewer.mindMapOptions.onTrash(noteId, file) : null,
          reload: async () => {
            const response = await this.request(path, {blob: true, signal: session.abort.signal});
            const saved = await readMapBlob(await response.blob());
            checksum = saved.checksum;
            file.mapTitle = saved.map.topics.find(topic => topic.id === saved.map.root).title;
            const active = session.viewer;
            if (active.active === session) active.heading.textContent = file.mapTitle;
            return saved.map;
          },
          save: async map => {
            const result = await this.request(path + "?view=mind-map", {
              body: {map, checksum}, signal: session.abort.signal,
            });
            checksum = result.checksum;
            file.mapTitle = result.mapTitle;
            const active = session.viewer;
            if (active.active === session) active.heading.textContent = result.mapTitle;
            active.mindMapOptions.onSave(file);
          },
        });
      } else if (preview.kind === "canvas") {
        if (blob.size > CANVAS_LIMIT) throw new Error("The Canvas file exceeds 8 MiB.");
        const bytes = await blob.arrayBuffer();
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        let checksum = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
        if (this.active !== session) return;
        session.board = new CanvasBoard(this.container, this.tools, new TextDecoder().decode(bytes),
          (reference, subpath) => this.openReference(file, reference, subpath), async canvas => {
            const result = await this.request(path, {body: {canvas, checksum}, signal: session.abort.signal});
            checksum = result.checksum;
          }, canEdit);
        this.container.classList.add("canvas-content");
        session.board.fit();
      } else if (preview.kind === "text") {
        const bytes = await blob.slice(0, TEXT_LIMIT).arrayBuffer();
        const text = new TextDecoder(preview.encoding).decode(bytes, {stream: blob.size > TEXT_LIMIT});
        const pages = textPreviewPages(text);
        if (this.active !== session) return;
        await this.pager(session, pages.length, page => {
          const section = el("section");
          section.className = "markup-document";
          section.append(el("pre", pages[page - 1]));
          if (blob.size > TEXT_LIMIT && page === 1) section.prepend(el("p", "Preview of the first 512 KiB."));
          return this.annotate(session, page, section, "markup-fixed");
        });
      } else {
        const tag = preview.kind === "image" ? "img" : preview.kind;
        const element = el(tag);
        if (tag === "img") {
          element.alt = file.name;
          element.classList.add("viewer-fit");
          element.addEventListener("click", () => {
            element.classList.toggle("viewer-fit");
            session.markup?.stage.classList.toggle("markup-original", !element.classList.contains("viewer-fit"));
          });
        } else {
          element.controls = true;
          element.preload = "metadata";
          element.playsInline = true;
          element.addEventListener("error", () => {
            if (this.active === session) this.message("This browser cannot play this file. Download the original.", true);
          }, {once: true});
        }
        session.url = URL.createObjectURL(new Blob([blob], {type: preview.mime}));
        element.src = session.url;
        if (tag === "img") {
          await this.decodeImage(element);
          if (this.active === session) await this.annotate(session, 1, element, "markup-visual");
        } else {
          this.container.replaceChildren(element);
        }
      }
    } catch (error) {
      if (this.active === session && error.name !== "AbortError") {
        this.message(`${error.message || "Could not open the file."} You can download it above.`, true);
      }
    }
  }

  fileSize(bytes) {
    const unit = bytes < 1024 ? "B" : bytes < 1024 ** 2 ? "KiB" : "MiB";
    const amount = bytes / (unit === "B" ? 1 : unit === "KiB" ? 1024 : 1024 ** 2);
    return new Intl.NumberFormat(undefined, {maximumFractionDigits: 1}).format(amount) + " " + unit;
  }

  async decodeImage(image) {
    try { await image.decode(); }
    catch { throw new Error("This browser could not decode the image."); }
  }

  annotate(session, page, element, style) {
    if (this.active !== session) return;
    session.markup ??= new AttachmentMarkup(this, session);
    return session.markup.mount(page, element, style);
  }

  async pager(session, count, render) {
    if (this.active !== session) return;
    if (!count) { this.message("This document has no pages.", true); return; }
    if (count === 1) {
      await render(1);
      return;
    }
    const previous = el("button", "‹");
    const next = el("button", "›");
    const label = el("span");
    const pager = el("div");
    pager.className = "viewer-pager";
    previous.type = next.type = "button";
    previous.setAttribute("aria-label", "Previous page");
    next.setAttribute("aria-label", "Next page");
    label.setAttribute("aria-live", "polite");
    let moving = false;
    function update() {
      label.textContent = session.pageNumber + " / " + count;
      previous.disabled = moving || session.pageNumber === 1;
      next.disabled = moving || session.pageNumber === count;
    }
    const change = async page => {
      if (moving || this.active !== session || page < 1 || page > count) return;
      moving = true;
      update();
      try {
        await session.markup?.flush();
        if (this.active !== session) return;
      } catch {
        return;
      } finally {
        moving = false;
        update();
      }
      session.pageNumber = page;
      session.markup?.suspend();
      moving = true;
      update();
      try {
        await render(page);
      } catch (error) {
        if (this.active === session && error.name !== "RenderingCancelledException") {
          this.message(error.message || "Could not open this page.", true);
        }
      } finally {
        moving = false;
        update();
      }
    };
    previous.addEventListener("click", () => { void change(session.pageNumber - 1); });
    next.addEventListener("click", () => { void change(session.pageNumber + 1); });
    pager.append(previous, label, next);
    this.tools.replaceChildren(pager);
    await change(1);
  }

  previewTable(rows) {
    const table = el("table");
    const body = el("tbody");
    for (const row of rows) {
      const line = el("tr");
      line.append(...row.map(value => el("td", value)));
      body.append(line);
    }
    table.append(body);
    return table;
  }

  async showOffice(session, sections) {
    if (!sections.length) {
      this.message("This document has no readable preview. You can download the original.");
      return;
    }
    const pages = sections.flatMap(section => {
      if (section.blocks || section.rows) return [section];
      return textPreviewPages(section.text || "").map(text => ({title: section.title, text}));
    });
    await this.pager(session, pages.length, async page => {
      const section = pages[page - 1];
      const article = el("article");
      article.className = "markup-document";
      const tables = [section.rows, ...(section.blocks || []).map(block => block.rows)].filter(Boolean);
      const columns = Math.max(0, ...tables.flatMap(rows => rows.map(row => row.length)));
      if (columns > 6) article.style.inlineSize = Math.min(3400, columns * 110) + "px";
      if (section.title) article.append(el("h3", section.title));
      const images = [];
      if (section.blocks) {
        for (const block of section.blocks) {
          if (block.rows) article.append(this.previewTable(block.rows));
          else if (block.image) {
            const figure = el("img");
            figure.alt = "Image from the document";
            figure.src = block.image;
            article.append(figure);
            images.push(this.decodeImage(figure).catch(() => figure.remove()));
          } else if (block.level) {
            article.append(el("h" + Math.min(block.level, 6), block.text));
          } else {
            article.append(el("p", block.text || " "));
          }
        }
      } else if (section.rows) {
        article.append(this.previewTable(section.rows));
      } else {
        article.append(el("pre", section.text || "No text found."));
      }
      await Promise.all(images);
      if (this.active === session) await this.annotate(session, page, article, "markup-fixed");
    });
  }

  async showPdf(session, data) {
    const pdf = await import("/pdf/pdf.mjs");
    if (this.active !== session) return;
    pdf.GlobalWorkerOptions.workerSrc = "/pdf/pdf.worker.mjs";
    session.pdfTask = pdf.getDocument({
      data, cMapUrl: "/pdf/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdf/standard_fonts/",
      isEvalSupported: false, enableXfa: false, useWasm: false, useSystemFonts: true,
      maxImageSize: 20_000_000, canvasMaxAreaInBytes: 32_000_000,
    });
    session.pdfTask.onPassword = (submit, reason) => {
      if (this.active !== session) return;
      const form = el("form");
      form.className = "viewer-pager";
      const password = el("input");
      password.type = "password";
      password.required = true;
      password.setAttribute("aria-label", "PDF password");
      password.autocomplete = "off";
      const help = reason === pdf.PasswordResponses.INCORRECT_PASSWORD ? "Incorrect PDF password" : "Enter the PDF password.";
      const unlock = el("button", "Open PDF");
      form.append(el("span", help), password, unlock);
      form.addEventListener("submit", event => {
        event.preventDefault();
        const secret = password.value;
        password.value = "";
        submit(secret);
      });
      this.tools.replaceChildren(form);
      password.focus();
    };
    session.document = await session.pdfTask.promise;
    if (this.active !== session) return;
    this.tools.replaceChildren();
    await this.pager(session, session.document.numPages, () => this.renderPdfPage(session, pdf.AnnotationMode.ENABLE));
  }

  async renderPdfPage(session, annotationMode) {
    const sequence = ++session.pageSequence;
    session.render?.cancel();
    const page = await session.document.getPage(session.pageNumber);
    if (this.active !== session || sequence !== session.pageSequence) return;
    const size = page.getViewport({scale: 1});
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(200, this.container.clientWidth - 35);
    const scale = Math.min(width * ratio / size.width, 3000 / size.width, 4000 / size.height);
    const viewport = page.getViewport({scale});
    const canvas = el("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    canvas.setAttribute("aria-label", `PDF, page ${session.pageNumber}`);
    session.render = page.render({canvas, viewport, annotationMode});
    await session.render.promise;
    if (this.active === session && sequence === session.pageSequence) {
      await this.annotate(session, session.pageNumber, canvas, "markup-visual");
    }
  }
}

