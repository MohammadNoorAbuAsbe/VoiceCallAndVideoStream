// ─────────────────────────────────────────────────────────────────────────────
//  Pure, browser-agnostic helpers shared by the UI (main.js) and unit tests.
//  No browser-only globals are touched at module load time.
// ─────────────────────────────────────────────────────────────────────────────

// ─── HTML escaping ───────────────────────────────────────────────────────────
// @illusion: escape HTML special characters for safe DOM insertion
export function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Relative time ───────────────────────────────────────────────────────────
// @illusion: format timestamp as human-readable relative time string
export function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000)     return 'just now';
  if (diff < 3_600_000)  return Math.floor(diff / 60_000)   + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

// ─── Mute keybind formatting ─────────────────────────────────────────────────
const _codeLabels = {
  Space:'Space', Backquote:'`', Minus:'-', Equal:'=', BracketLeft:'[', BracketRight:']',
  Backslash:'\\', Semicolon:';', Quote:"'", Comma:',', Period:'.', Slash:'/',
  Backspace:'Backspace', Tab:'Tab', CapsLock:'Caps', Enter:'Enter', Escape:'Esc',
  Delete:'Del', Insert:'Ins', Home:'Home', End:'End', PageUp:'PgUp', PageDown:'PgDn',
  ArrowUp:'↑', ArrowDown:'↓', ArrowLeft:'←', ArrowRight:'→',
  PrintScreen:'PrtSc', ScrollLock:'ScrLk', Pause:'Pause', NumLock:'NumLk',
};
for (let i = 1; i <= 12; i++) _codeLabels['F' + i] = 'F' + i;
for (let i = 0; i <= 9; i++)  _codeLabels['Digit' + i] = String(i);
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') _codeLabels['Key' + c] = c;

// @illusion: format keybind object as human-readable display string
export function formatKeybind(kb) {
  if (!kb) return 'None';
  const parts = [];
  if (kb.ctrl)  parts.push('Ctrl');
  if (kb.shift) parts.push('Shift');
  if (kb.alt)   parts.push('Alt');
  if (kb.meta)  parts.push('Meta');
  parts.push(_codeLabels[kb.code] || kb.code);
  return parts.join('+');
}

// ─── Call ID generation ────────────────────────────────────────────────────────
// @illusion: generate random call ID for signaling
export function generateCallId(){ return Math.random().toString(36).slice(2, 12); }

// ─── Contacts (localStorage-backed) ──────────────────────────────────────────
export const KEY_CONTACTS = 'vcall_contacts';

// @illusion: load contacts array from localStorage
export function loadContacts(store = localStorage) {
  try { return JSON.parse(store.getItem(KEY_CONTACTS) || '[]'); }
  catch { return []; }
}
// @illusion: persist contacts array to localStorage
export function saveContacts(list, store = localStorage) {
  store.setItem(KEY_CONTACTS, JSON.stringify(list));
}
// @illusion: add new contact or update existing one by ID, prepend to list
export function addOrUpdateContact(name, id, store = localStorage) {
  const list = loadContacts(store).filter(c => c.id !== id);
  list.unshift({ id, name, lastCall: null });
  saveContacts(list, store);
}
// @illusion: remove contact by ID from stored list
export function removeContact(id, store = localStorage) {
  saveContacts(loadContacts(store).filter(c => c.id !== id), store);
}
// @illusion: update last-call timestamp for a contact
export function touchLastCall(id, store = localStorage) {
  const list = loadContacts(store);
  const c = list.find(c => c.id === id);
  if (c) { c.lastCall = Date.now(); saveContacts(list, store); }
}
// @illusion: lookup contact name by ID, show truncated ID if not found
export function getContactName(id, store = localStorage) {
  const c = loadContacts(store).find(c => c.id === id);
  return c ? c.name : id.slice(0, 10) + '…';
}
