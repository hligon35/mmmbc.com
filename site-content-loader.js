/*
 * site-content-loader.js
 *
 * Reusable public-page hydration loader for the visual website editor.
 * Include with: <script src="site-content-loader.js" defer data-cms-page="home"></script>
 * (use a relative path such as "../site-content-loader.js" from files under Pages/).
 *
 * Normal (public) mode:
 *   - Fetches GET /api/site-content/{page} (published fields only, unauthenticated).
 *   - Hydrates every [data-cms-field] element found on the page.
 *   - On any failure, silently keeps the static HTML already baked into the page
 *     (graceful fallback — the page must never break or show blank/error content).
 *
 * Editor (admin) mode — activated by a ?cms_edit=1 query string, expected to be used
 * only when this page is loaded inside the admin visual editor's iframe:
 *   - Never fetches published content itself; waits for the parent frame to push the
 *     current draft via postMessage so the admin always edits/see the draft, not the
 *     live published copy.
 *   - Adds hover/focus affordances to editable elements and intercepts clicks on them,
 *     reporting the field key/type/position back to the parent so it can position a
 *     contextual popover editor.
 *   - Intercepts other internal link clicks so the iframe never navigates away from
 *     the page being edited.
 *
 * postMessage protocol (all messages are validated for shape + same-origin):
 *   iframe -> parent: { source: 'mmmbc-cms', type: 'ready', page }
 *   iframe -> parent: { source: 'mmmbc-cms', type: 'fieldClick', page, field, fieldType, rect }
 *   iframe -> parent: { source: 'mmmbc-cms', type: 'navigateBlocked', page, href }
 *   iframe -> parent: { source: 'mmmbc-cms', type: 'error', page, message }
 *   parent -> iframe: { source: 'mmmbc-cms', type: 'init', page, fields }
 *   parent -> iframe: { source: 'mmmbc-cms', type: 'refresh', page, fields }
 *   parent -> iframe: { source: 'mmmbc-cms', type: 'setField', page, field, value }
 */
(function () {
  'use strict';

  var CURRENT_SCRIPT = document.currentScript;
  var PAGE = CURRENT_SCRIPT ? CURRENT_SCRIPT.getAttribute('data-cms-page') : null;
  if (!PAGE) return;

  var SAFE_URL_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'];
  var RICH_TEXT_TAGS = { B: true, STRONG: true, I: true, EM: true, BR: true, P: true, A: true };
  var RICH_TEXT_URL_PROTOCOLS = ['http:', 'https:', 'mailto:'];

  var isEditorMode = false;
  try {
    isEditorMode = new URLSearchParams(window.location.search || '').get('cms_edit') === '1';
  } catch (e) {
    isEditorMode = false;
  }

  var state = { fields: {} };

  function isSafeUrl(raw, allowedProtocols) {
    var value = String(raw == null ? '' : raw).trim();
    if (!value) return false;
    if (/[\u0000-\u001f]/.test(value)) return false;
    if (value.slice(0, 2) === '//') return false;
    try {
      var parsed = new URL(value, window.location.origin);
      return allowedProtocols.indexOf(parsed.protocol) !== -1;
    } catch (e) {
      return false;
    }
  }

  // Minimal defense-in-depth client re-sanitizer for rich_text fields. The server
  // already sanitizes with a strict tag/attribute allowlist before storing published
  // content, but we never trust a network response enough to assign raw innerHTML.
  function sanitizeRichTextClient(html) {
    var source = String(html == null ? '' : html);
    var doc;
    try {
      doc = document.implementation.createHTMLDocument('');
    } catch (e) {
      return '';
    }
    doc.body.innerHTML = source;

    function cleanNode(node) {
      var children = Array.prototype.slice.call(node.childNodes);
      children.forEach(function (child) {
        if (child.nodeType === 3) return; // text node, always fine
        if (child.nodeType !== 1) {
          child.parentNode.removeChild(child);
          return;
        }
        if (!RICH_TEXT_TAGS[child.tagName]) {
          // Unwrap disallowed elements but keep their text content.
          var text = doc.createTextNode(child.textContent || '');
          child.parentNode.replaceChild(text, child);
          return;
        }
        Array.prototype.slice.call(child.attributes).forEach(function (attr) {
          if (child.tagName === 'A' && attr.name === 'href') {
            if (!isSafeUrl(attr.value, RICH_TEXT_URL_PROTOCOLS)) child.removeAttribute('href');
            return;
          }
          child.removeAttribute(attr.name);
        });
        if (child.tagName === 'A') {
          child.setAttribute('rel', 'noopener noreferrer');
        }
        cleanNode(child);
      });
    }

    cleanNode(doc.body);
    return doc.body.innerHTML;
  }

  function setElementValue(el, type, value) {
    var attr = el.getAttribute('data-cms-attr');

    if (type === 'boolean') {
      el.hidden = !value;
      return;
    }

    if (type === 'image') {
      var img = value && typeof value === 'object' ? value : {};
      if (attr) {
        if (attr === 'src' || attr === 'href') {
          if (isSafeUrl(img.url, SAFE_URL_PROTOCOLS)) el.setAttribute(attr, img.url);
        } else {
          el.setAttribute(attr, img.url || '');
        }
        return;
      }
      if (el.tagName === 'IMG') {
        if (isSafeUrl(img.url, SAFE_URL_PROTOCOLS)) el.src = img.url;
        if (img.alt) el.alt = img.alt;
      }
      return;
    }

    if (type === 'url') {
      var urlValue = String(value == null ? '' : value);
      if (attr) {
        if (isSafeUrl(urlValue, SAFE_URL_PROTOCOLS)) el.setAttribute(attr, urlValue);
      } else if (isSafeUrl(urlValue, SAFE_URL_PROTOCOLS)) {
        el.textContent = urlValue;
      }
      return;
    }

    if (type === 'rich_text') {
      el.innerHTML = sanitizeRichTextClient(value);
      return;
    }

    if (type === 'email' && attr === 'href') {
      el.setAttribute('href', 'mailto:' + String(value == null ? '' : value).trim());
      return;
    }

    if (type === 'telephone' && attr === 'href') {
      var digits = String(value == null ? '' : value).replace(/[^0-9+]/g, '');
      el.setAttribute('href', 'tel:' + digits);
      return;
    }

    if (type === 'time') {
      var textValue2 = formatTime12h(value);
      if (attr) el.setAttribute(attr, textValue2);
      else el.textContent = textValue2;
      return;
    }

    if (type === 'select') {
      var displayValue = String(value == null ? '' : value);
      var optionsRaw = el.getAttribute('data-cms-options');
      if (optionsRaw) {
        try {
          var options = JSON.parse(optionsRaw);
          if (options && Object.prototype.hasOwnProperty.call(options, displayValue)) {
            displayValue = options[displayValue];
          }
        } catch (e) {
          // ignore malformed data-cms-options, fall back to the raw value
        }
      }
      if (attr) el.setAttribute(attr, displayValue);
      else el.textContent = displayValue;
      return;
    }

    // text, textarea, email, telephone, weekday and any other scalar type.
    var textValue = value == null ? '' : String(value);
    if (attr) {
      el.setAttribute(attr, textValue);
    } else {
      el.textContent = textValue;
    }
  }

  // Renders a stored 24h "HH:MM" time value the same way the static markup already
  // did (e.g. "11:00" -> "11:00am", "18:30" -> "6:30pm").
  function formatTime12h(value) {
    var match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value == null ? '' : value).trim());
    if (!match) return String(value == null ? '' : value);
    var hour = parseInt(match[1], 10);
    var minute = match[2];
    var suffix = hour >= 12 ? 'pm' : 'am';
    var hour12 = hour % 12;
    if (hour12 === 0) hour12 = 12;
    return hour12 + ':' + minute + suffix;
  }

  function hydrateScalarField(fieldKey) {
    if (!(fieldKey in state.fields)) return;
    var elements = document.querySelectorAll('[data-cms-field="' + cssEscape(fieldKey) + '"]');
    elements.forEach(function (el) {
      var type = el.getAttribute('data-cms-type') || 'text';
      setElementValue(el, type, state.fields[fieldKey]);
    });
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function hydrateCollectionField(fieldKey) {
    var items = state.fields[fieldKey];
    if (!Array.isArray(items) || items.length === 0) return; // preserve existing static markup

    var containers = document.querySelectorAll('[data-cms-collection="' + cssEscape(fieldKey) + '"]');
    containers.forEach(function (container) {
      var template = container.querySelector('template[data-cms-item-template]');
      if (!template) return;
      var group = container.getAttribute('data-cms-collection-group');
      var groupItems = group ? items.filter(function (item) { return item && item.group === group; }) : items;
      if (groupItems.length === 0) return;

      Array.prototype.slice.call(container.querySelectorAll('[data-cms-item]')).forEach(function (node) {
        node.parentNode.removeChild(node);
      });

      groupItems.forEach(function (item) {
        var fragment = template.content ? template.content.cloneNode(true) : null;
        if (!fragment) return;
        var root = fragment.firstElementChild;
        if (!root) return;
        root.setAttribute('data-cms-item', '');
        root.querySelectorAll('[data-cms-item-field]').forEach(function (fieldEl) {
          var key = fieldEl.getAttribute('data-cms-item-field');
          var type = fieldEl.getAttribute('data-cms-type') || 'text';
          setElementValue(fieldEl, type, item ? item[key] : '');
        });
        container.insertBefore(root, template);
      });
    });
  }

  function applyFields(fields) {
    state.fields = fields && typeof fields === 'object' ? fields : {};
    Object.keys(state.fields).forEach(function (fieldKey) {
      var value = state.fields[fieldKey];
      if (Array.isArray(value)) {
        hydrateCollectionField(fieldKey);
      } else {
        hydrateScalarField(fieldKey);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Normal (public) mode
  // ---------------------------------------------------------------------
  function loadPublished() {
    fetch('/api/site-content/' + encodeURIComponent(PAGE), { credentials: 'omit', cache: 'default' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.fields) applyFields(data.fields);
      })
      .catch(function () {
        // Network/parse failure: keep the static HTML already rendered on the page.
      });
  }

  // ---------------------------------------------------------------------
  // Editor mode
  // ---------------------------------------------------------------------
  function postToParent(message) {
    if (!window.parent || window.parent === window) return;
    try {
      window.parent.postMessage(Object.assign({ source: 'mmmbc-cms', page: PAGE }, message), window.location.origin);
    } catch (e) {
      // ignore postMessage failures (e.g. parent already navigated away)
    }
  }

  function isValidParentMessage(event) {
    if (event.origin !== window.location.origin) return false;
    if (event.source !== window.parent) return false;
    var data = event.data;
    if (!data || typeof data !== 'object') return false;
    if (data.source !== 'mmmbc-cms') return false;
    if (data.page !== PAGE) return false;
    return true;
  }

  function findFieldAncestor(el) {
    var node = el;
    while (node && node !== document.body) {
      if (node.hasAttribute && node.hasAttribute('data-cms-field')) return node;
      node = node.parentElement;
    }
    return null;
  }

  function findAnchorAncestor(el) {
    var node = el;
    while (node && node !== document.body) {
      if (node.tagName === 'A' && node.hasAttribute('href')) return node;
      node = node.parentElement;
    }
    return null;
  }

  function initEditorMode() {
    document.addEventListener('click', function (event) {
      var fieldEl = findFieldAncestor(event.target);
      if (fieldEl) {
        event.preventDefault();
        event.stopPropagation();
        var rect = fieldEl.getBoundingClientRect();
        postToParent({
          type: 'fieldClick',
          field: fieldEl.getAttribute('data-cms-field'),
          fieldType: fieldEl.getAttribute('data-cms-type') || 'text',
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
        });
        return;
      }
      var anchorEl = findAnchorAncestor(event.target);
      if (anchorEl) {
        event.preventDefault();
        event.stopPropagation();
        postToParent({ type: 'navigateBlocked', href: anchorEl.getAttribute('href') });
      }
    }, true);

    window.addEventListener('message', function (event) {
      if (!isValidParentMessage(event)) return;
      var data = event.data;
      if (data.type === 'init' || data.type === 'refresh') {
        applyFields(data.fields);
      } else if (data.type === 'setField') {
        if (typeof data.field === 'string') {
          state.fields[data.field] = data.value;
          if (Array.isArray(data.value)) {
            hydrateCollectionField(data.field);
          } else {
            hydrateScalarField(data.field);
          }
        }
      }
    });

    postToParent({ type: 'ready' });
  }

  function start() {
    try {
      if (isEditorMode) {
        initEditorMode();
      } else {
        loadPublished();
      }
    } catch (err) {
      if (isEditorMode) postToParent({ type: 'error', message: String(err && err.message || err) });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
