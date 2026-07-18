// Shared jsdom fixtures for UI tests.
// Loads the real index.html <body> so every getElementById in main.js resolves.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.resolve(__dirname, '..', '..', 'index.html');

const html = fs.readFileSync(HTML_PATH, 'utf8');
const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/i);
const BODY_HTML = bodyMatch ? bodyMatch[1] : '';

/** Inject the app body into the jsdom document. */
export function setupDom() {
  document.body.innerHTML = BODY_HTML;
}

export function getEl(id) {
  return document.getElementById(id);
}

export function clickEl(id) {
  const el = document.getElementById(id);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return el;
}

export function setInput(id, value) {
  const el = document.getElementById(id);
  el.value = value;
  return el;
}
