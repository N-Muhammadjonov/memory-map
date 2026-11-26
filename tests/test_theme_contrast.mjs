import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");

function declarations(selector) {
  const marker = css.indexOf(selector + " {");
  assert.notEqual(marker, -1, selector);
  const section = css.slice(marker, css.indexOf("}", marker));
  return Object.fromEntries([...section.matchAll(/--([\w-]+):\s*([^;]+);/g)]
    .map(([, key, value]) => [key, value.trim()]));
}

const defaults = declarations(":root");
const palettes = {
  dark: defaults,
  slate: {...defaults, ...declarations(':root[data-theme="slate"]')},
  light: {...defaults, ...declarations(':root[data-theme="light"]')},
};

function channels(color) {
  if (color.startsWith("#")) {
    return color.slice(1).match(/../g).map(channel => parseInt(channel, 16));
  }
  return color.match(/[\d.]+/g).map(Number);
}

function composite([r, g, b, alpha = 1], background) {
  return [r, g, b].map((value, index) => value * alpha + background[index] * (1 - alpha));
}

function luminance(rgb) {
  return rgb.slice(0, 3).map(value => {
    const normalized = value / 255;
    return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
}

function expectContrast(palette, foreground, background, overlay = null) {
  const foregroundColor = channels(palette[foreground]);
  let backgroundColor = channels(palette[background]);
  if (overlay) backgroundColor = composite(channels(overlay), backgroundColor);
  const first = luminance(foregroundColor);
  const second = luminance(backgroundColor);
  const ratio = (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
  assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
}

for (const [theme, palette] of Object.entries(palettes)) {
  test(`${theme}: text, buttons, links and badges meet 4.5:1 contrast`, () => {
    for (const surface of ["bg", "sidebar", "surface", "hover", "input-bg"]) {
      for (const foreground of ["text", "muted", "subtle", "link", "danger"]) {
        expectContrast(palette, foreground, surface);
      }
    }
    expectContrast(palette, "on-action", "action");
    expectContrast(palette, "on-action", "action-hover");
    expectContrast(palette, "on-accent", "accent");
    expectContrast(palette, "accent", "bg", palette["accent-soft"]);
    expectContrast(palette, "accent", "surface", palette["accent-soft"]);
    expectContrast(palette, "selection-fg", "selection-bg");
    const statuses = {
      "status-neutral": "rgba(148,163,184,.14)",
      "status-info": "rgba(96,165,250,.16)",
      "status-warning": "rgba(251,191,36,.16)",
      "status-success": "rgba(52,211,153,.16)",
      "status-danger": "rgba(239,68,68,.16)",
    };
    for (const [foreground, overlay] of Object.entries(statuses)) {
      expectContrast(palette, foreground, "bg", overlay);
      expectContrast(palette, foreground, "surface", overlay);
    }
  });

  test(`${theme}: code comments, tokens and controls remain legible`, () => {
    for (const token of Object.keys(palette).filter(name => name.startsWith("token-"))) {
      expectContrast(palette, token, "code-bg");
    }
    for (const surface of ["code-bg", "code-toolbar", "code-button", "code-hover"]) {
      for (const foreground of ["code-text", "code-muted", "status-success"]) {
        expectContrast(palette, foreground, surface);
      }
    }
    expectContrast(palette, "code-error", "code-toolbar");
    expectContrast(palette, "inline-code-fg", "inline-code-bg");
  });
}
