// @vitest-environment jsdom
// Tests for the pure UI helpers extracted into src/util.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  escHtml, relativeTime, formatKeybind, generateId, generateCallId,
  KEY_CONTACTS, loadContacts, saveContacts, addOrUpdateContact,
  removeContact, touchLastCall, getContactName,
} from '../util.js';

function fakeStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

describe('escHtml', () => {
  it('escapes HTML-significant characters', () => {
    expect(escHtml('<a href="x">&"')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&quot;');
    expect(escHtml(42)).toBe('42');
  });
  it('escapes every significant entity', () => {
    expect(escHtml('&<>"')).toBe('&amp;&lt;&gt;&quot;');
  });
  it('returns an empty string unchanged', () => {
    expect(escHtml('')).toBe('');
  });
  it('coerces null/undefined objects to their string form', () => {
    expect(escHtml(null)).toBe('null');
    expect(escHtml(undefined)).toBe('undefined');
  });
  it('does not double-escape already-escaped input', () => {
    // Only the raw characters are escaped, so &amp; stays &amp;amp;
    expect(escHtml('&amp;')).toBe('&amp;amp;');
  });
});

describe('relativeTime', () => {
  it('formats relative timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    expect(relativeTime(Date.now())).toBe('just now');
    expect(relativeTime(Date.now() - 60_000)).toBe('1m ago');
    expect(relativeTime(Date.now() - 3_600_000)).toBe('1h ago');
    vi.useRealTimers();
  });
  it('treats a future timestamp as "just now"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    expect(relativeTime(Date.now() + 5_000)).toBe('just now');
    vi.useRealTimers();
  });
  it('handles the exact minute/hour/day boundaries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    expect(relativeTime(Date.now() - 0)).toBe('just now');           // diff 0
    expect(relativeTime(Date.now() - 59_000)).toBe('just now');      // just under a minute
    expect(relativeTime(Date.now() - 60_000)).toBe('1m ago');        // exactly a minute
    expect(relativeTime(Date.now() - 3_599_000)).toBe('59m ago');    // just under an hour
    expect(relativeTime(Date.now() - 3_600_000)).toBe('1h ago');     // exactly an hour
    expect(relativeTime(Date.now() - 86_399_000)).toBe('23h ago');   // just under a day
    expect(relativeTime(Date.now() - 86_400_000)).toBe(new Date(Date.now() - 86_400_000).toLocaleDateString()); // exactly a day
    vi.useRealTimers();
  });
});

describe('formatKeybind', () => {
  it('returns None for a null binding', () => {
    expect(formatKeybind(null)).toBe('None');
  });
  it('formats a plain key', () => {
    expect(formatKeybind({ code: 'KeyA' })).toBe('A');
    expect(formatKeybind({ code: 'Space' })).toBe('Space');
    expect(formatKeybind({ code: 'F1' })).toBe('F1');
  });
  it('formats modifier combos', () => {
    expect(formatKeybind({ code: 'KeyM', ctrl: true })).toBe('Ctrl+M');
    expect(formatKeybind({ code: 'Digit1', shift: true, alt: true })).toBe('Shift+Alt+1');
  });
  it('formats all modifiers at once', () => {
    expect(formatKeybind({ code: 'KeyZ', ctrl: true, shift: true, alt: true, meta: true }))
      .toBe('Ctrl+Shift+Alt+Meta+Z');
  });
  it('falls back to the raw code for unlabeled keys', () => {
    expect(formatKeybind({ code: 'Unlabeled123' })).toBe('Unlabeled123');
  });
  it('handles an empty code', () => {
    expect(formatKeybind({ code: '' })).toBe('');
  });
});

describe('id generation', () => {
  it('generates non-empty, unique ids and callIds', () => {
    expect(generateId()).toMatch(/\S+/);
    expect(generateCallId()).toMatch(/\S+/);
    const set = new Set(Array.from({ length: 200 }, () => generateId()));
    expect(set.size).toBe(200);
  });
  it('produces 1000 unique callIds', () => {
    const set = new Set(Array.from({ length: 1000 }, () => generateCallId()));
    expect(set.size).toBe(1000);
  });
});

describe('contacts (injected store)', () => {
  let store;
  beforeEach(() => { store = fakeStore(); });

  it('starts empty', () => {
    expect(loadContacts(store)).toEqual([]);
  });

  it('adds and updates a contact (no duplicates)', () => {
    addOrUpdateContact('Bob', 'id-bob', store);
    addOrUpdateContact('Bobby', 'id-bob', store); // same id → update, not duplicate
    addOrUpdateContact('Sue', 'id-sue', store);
    const list = loadContacts(store);
    expect(list.length).toBe(2);
    expect(list[0]).toEqual({ id: 'id-sue', name: 'Sue', lastCall: null }); // newest first
    expect(getContactName('id-bob', store)).toBe('Bobby');
  });

  it('removes a contact', () => {
    addOrUpdateContact('Bob', 'id-bob', store);
    removeContact('id-bob', store);
    expect(loadContacts(store)).toEqual([]);
  });

  it('touches lastCall', () => {
    addOrUpdateContact('Bob', 'id-bob', store);
    touchLastCall('id-bob', store);
    const c = loadContacts(store).find((x) => x.id === 'id-bob');
    expect(typeof c.lastCall).toBe('number');
  });

  it('falls back to a truncated id for unknown contacts', () => {
    expect(getContactName('abcdefghijklmnop', store)).toBe('abcdefghij…');
  });
  it('truncates an unknown id to 10 chars plus an ellipsis', () => {
    expect(getContactName('short', store)).toBe('short…');
    expect(getContactName('1234567890', store)).toBe('1234567890…');
  });
  it('returns the truncated id for an empty contact list', () => {
    expect(getContactName('someid', store)).toBe('someid…');
  });
  it('returns the id truncated when the id is unknown', () => {
    expect(getContactName('abcdefghijklmno', store)).toBe('abcdefghij…');
  });
});

describe('contacts (corrupt / odd storage)', () => {
  it('returns [] for corrupt JSON', () => {
    const store = fakeStore();
    store.setItem(KEY_CONTACTS, '{not valid json');
    expect(loadContacts(store)).toEqual([]);
  });
  it('returns the parsed value even if it is not an array', () => {
    const store = fakeStore();
    store.setItem(KEY_CONTACTS, JSON.stringify({ id: 'x' }));
    expect(loadContacts(store)).toEqual({ id: 'x' });
  });
  it('returns [] when the key is missing', () => {
    const store = fakeStore();
    expect(loadContacts(store)).toEqual([]);
  });
  it('saveContacts round-trips a custom list', () => {
    const store = fakeStore();
    const list = [{ id: 'a', name: 'A', lastCall: 1 }];
    saveContacts(list, store);
    expect(loadContacts(store)).toEqual(list);
  });
  it('addOrUpdateContact resets lastCall to null on update', () => {
    const store = fakeStore();
    addOrUpdateContact('Bob', 'id-bob', store);
    touchLastCall('id-bob', store);
    addOrUpdateContact('Bobby', 'id-bob', store); // update
    const c = loadContacts(store).find((x) => x.id === 'id-bob');
    expect(c.name).toBe('Bobby');
    expect(c.lastCall).toBeNull();
  });
  it('removeContact ignores a non-existent id', () => {
    const store = fakeStore();
    addOrUpdateContact('Bob', 'id-bob', store);
    removeContact('does-not-exist', store);
    expect(loadContacts(store).length).toBe(1);
  });
  it('touchLastCall is a no-op for an unknown id', () => {
    const store = fakeStore();
    expect(() => touchLastCall('nope', store)).not.toThrow();
  });
});

describe('contacts (default localStorage)', () => {
  beforeEach(() => { localStorage.removeItem(KEY_CONTACTS); });

  it('uses localStorage by default without throwing', () => {
    expect(loadContacts()).toEqual([]);
    addOrUpdateContact('Bob', 'id-bob');
    expect(loadContacts().length).toBe(1);
  });
});
