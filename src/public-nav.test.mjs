import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.tokens = new Set();
  }

  setFromString(value) {
    this.tokens = new Set(String(value || '').split(/\s+/).filter(Boolean));
    this.owner._className = this.toString();
  }

  add(...tokens) {
    tokens.forEach((token) => this.tokens.add(token));
    this.owner._className = this.toString();
  }

  remove(...tokens) {
    tokens.forEach((token) => this.tokens.delete(token));
    this.owner._className = this.toString();
  }

  contains(token) {
    return this.tokens.has(token);
  }

  toggle(token, force) {
    if (force === true) {
      this.add(token);
      return true;
    }
    if (force === false) {
      this.remove(token);
      return false;
    }
    if (this.contains(token)) {
      this.remove(token);
      return false;
    }
    this.add(token);
    return true;
  }

  toString() {
    return Array.from(this.tokens).join(' ');
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || '').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this._className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.href = '';
    this.type = '';
    this.id = '';
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this.classList.setFromString(value);
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    if (child.id) this.ownerDocument.registerElement(child);
    return child;
  }

  replaceWith(next) {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    if (index >= 0) {
      next.parentElement = this.parentElement;
      siblings.splice(index, 1, next);
      if (next.id) this.ownerDocument.registerElement(next);
    }
  }

  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentElement = null;
  }

  addEventListener(type, listener) {
    const key = String(type);
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(listener);
  }

  dispatchEvent(event) {
    const payload = event || {};
    payload.type = payload.type || '';
    payload.target = payload.target || this;
    payload.currentTarget = this;
    payload.defaultPrevented = false;
    payload.propagationStopped = false;
    payload.preventDefault ||= () => { payload.defaultPrevented = true; };
    payload.stopPropagation ||= () => { payload.propagationStopped = true; };
    for (const listener of this.listeners.get(payload.type) || []) listener(payload);
    return !payload.defaultPrevented;
  }

  click() {
    this.dispatchEvent({ type: 'click', target: this });
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  setAttribute(name, value) {
    const key = String(name);
    const stringValue = String(value);
    this.attributes.set(key, stringValue);
    if (key === 'id') {
      this.id = stringValue;
      this.ownerDocument.registerElement(this);
    }
    if (key === 'class') this.className = stringValue;
    if (key === 'href') this.href = stringValue;
  }

  getAttribute(name) {
    const key = String(name);
    if (this.attributes.has(key)) return this.attributes.get(key);
    if (key === 'href') return this.href || null;
    if (key === 'id') return this.id || null;
    return null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const query = String(selector || '').trim();
    if (!query) return [];
    if (query === ':scope > a') return this.children.filter((child) => child.tagName === 'A');
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, query)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.byId = new Map();
    this.activeElement = null;
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
  }

  registerElement(element) {
    if (element?.id) this.byId.set(element.id, element);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this.byId.get(String(id)) || null;
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }

  addEventListener(type, listener) {
    const key = String(type);
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(listener);
  }

  dispatchEvent(event) {
    const payload = event || {};
    payload.type = payload.type || '';
    payload.target = payload.target || this.body;
    payload.currentTarget = this;
    payload.defaultPrevented = false;
    payload.preventDefault ||= () => { payload.defaultPrevented = true; };
    payload.stopPropagation ||= () => {};
    for (const listener of this.listeners.get(payload.type) || []) listener(payload);
  }
}

function matchesSelector(element, selector) {
  if (!(element instanceof FakeElement)) return false;
  if (selector.startsWith('.')) {
    return selector
      .split('.')
      .filter(Boolean)
      .every((token) => element.classList.contains(token));
  }
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  return element.tagName === selector.toUpperCase();
}

function makeAnchor(document, text, href) {
  const anchor = document.createElement('a');
  anchor.textContent = text;
  anchor.href = href;
  anchor.setAttribute('href', href);
  return anchor;
}

function loadPublicScript(document, pathname = '/index.html') {
  const navLinks = document.createElement('div');
  navLinks.className = 'nav-links';
  navLinks.setAttribute('id', 'navLinks');
  navLinks.appendChild(makeAnchor(document, 'Home', 'index.html'));
  navLinks.appendChild(makeAnchor(document, 'Ministries', 'Pages/ministries.html'));
  navLinks.appendChild(makeAnchor(document, 'Leadership & Staff', 'Pages/associate_ministers.html'));
  navLinks.appendChild(makeAnchor(document, 'Contact Us', 'Pages/contact.html'));

  const menuButton = document.createElement('button');
  menuButton.setAttribute('id', 'menuButton');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-controls', 'navLinks');

  document.body.appendChild(navLinks);
  document.body.appendChild(menuButton);
  document.registerElement(navLinks);
  document.registerElement(menuButton);

  const window = {
    document,
    location: { pathname, href: `https://example.test${pathname}` },
    alert: () => {},
    fetch: async () => { throw new Error('offline in test'); },
    setTimeout,
    clearTimeout
  };

  const script = fs.readFileSync(path.join(process.cwd(), 'script.js'), 'utf8');
  const context = vm.createContext({
    window,
    document,
    fetch: window.fetch,
    alert: window.alert,
    console,
    Math,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(script, context, { filename: 'script.js' });
  document.dispatchEvent({ type: 'DOMContentLoaded', target: document.body });

  return { navLinks, menuButton, document };
}

test('shared home navigation toggles, closes, and preserves Leadership submenu behavior', async () => {
  const document = new FakeDocument();
  const { navLinks, menuButton } = loadPublicScript(document, '/index.html');

  const leadershipGroup = navLinks.querySelector('.nav-item-group--leadership');
  assert.ok(leadershipGroup, 'Leadership group should be created by the shared nav script.');

  const submenuLinks = leadershipGroup.querySelectorAll('a');
  assert.equal(submenuLinks.length, 4);
  assert.deepEqual(
    submenuLinks.map((link) => link.getAttribute('href')),
    [
      'Pages/associate_ministers.html',
      'Pages/deacons.html',
      'Pages/deaconesses.html',
      'Pages/official_team_trustees.html'
    ]
  );

  menuButton.click();
  assert.equal(navLinks.classList.contains('active'), true);
  assert.equal(menuButton.getAttribute('aria-expanded'), 'true');

  const firstLink = navLinks.querySelectorAll('a').find((link) => link.textContent === 'Home');
  firstLink.click();
  assert.equal(navLinks.classList.contains('active'), false);
  assert.equal(menuButton.getAttribute('aria-expanded'), 'false');

  menuButton.click();
  const leadershipToggle = leadershipGroup.querySelector('.nav-parent-toggle');
  leadershipToggle.click();
  assert.equal(leadershipGroup.classList.contains('is-open'), true);
  assert.equal(leadershipToggle.getAttribute('aria-expanded'), 'true');

  submenuLinks[1].click();
  assert.equal(navLinks.classList.contains('active'), false);
  assert.equal(leadershipGroup.classList.contains('is-open'), false);
  assert.equal(menuButton.getAttribute('aria-expanded'), 'false');

  menuButton.click();
  leadershipToggle.click();
  document.dispatchEvent({ type: 'keydown', key: 'Escape', target: navLinks });
  assert.equal(navLinks.classList.contains('active'), false);
  assert.equal(menuButton.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, menuButton);

  menuButton.click();
  leadershipToggle.click();
  const outside = document.createElement('div');
  document.dispatchEvent({ type: 'click', target: outside });
  assert.equal(leadershipGroup.classList.contains('is-open'), false);
});