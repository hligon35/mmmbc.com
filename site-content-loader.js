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
 *   iframe -> parent: { source: 'mmmbc-cms', type: 'collectionItemClick', page, collection, itemId, field, fieldType, rect }
 *   iframe -> parent: { source: 'mmmbc-cms', type: 'collectionItemActions', page, collection, itemId, rect }
 *   iframe -> parent: { source: 'mmmbc-cms', type: 'navigateBlocked', page, href }
 *   iframe -> parent: { source: 'mmmbc-cms', type: 'error', page, message }
 *   parent -> iframe: { source: 'mmmbc-cms', type: 'init', page, fields }
 *   parent -> iframe: { source: 'mmmbc-cms', type: 'refresh', page, fields }
 *   parent -> iframe: { source: 'mmmbc-cms', type: 'setField', page, field, value }
 *   parent -> iframe: { source: 'mmmbc-cms', type: 'setCollectionItemField', page, collection, itemId, field, value }
 *   parent -> iframe: { source: 'mmmbc-cms', type: 'setSelection', page, collection, itemId, field }
 *   parent -> iframe: { source: 'mmmbc-cms', type: 'clearSelection', page }
 */
(function () {
  'use strict';

  var CURRENT_SCRIPT = document.currentScript;
  var PAGE = CURRENT_SCRIPT ? CURRENT_SCRIPT.getAttribute('data-cms-page') : null;
  if (!PAGE) return;

  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
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

  function addItemActionsHandle(root, label) {
    if (!isEditorMode) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cms-item-actions-btn cms-editable';
    btn.setAttribute('data-cms-item-actions', '');
    btn.setAttribute('aria-label', 'More actions for ' + label);
    btn.textContent = '\u22EE';
    root.appendChild(btn);
  }

  // Groups an activity's visual classes to match the hand-tuned static layout: Sunday
  // worship activities and Thursday ministry activities each have their own dedicated
  // CSS (see public-components.css), everything else uses the generic row layout.
  function scheduleGroupClasses(collectionKey, day) {
    if (collectionKey === 'worship.schedule' && day === 'Sunday') {
      return { dayExtra: 'sunday-schedule', groupClass: 'sunday-event-group' };
    }
    if (collectionKey === 'ministries.weeklySchedule' && day === 'Thursday') {
      return { dayExtra: 'thursday-schedule', groupClass: 'thursday-event-group' };
    }
    return { dayExtra: '', groupClass: 'simple-event-row' };
  }

  function renderScheduleCollection(container, items, collectionKey) {
    var byDay = {};
    var dayOrder = [];
    items.forEach(function (item) {
      var day = item && item.day;
      if (!day) return;
      if (!(day in byDay)) { byDay[day] = []; dayOrder.push(day); }
      byDay[day].push(item);
    });
    dayOrder.sort(function (a, b) { return WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b); });

    container.innerHTML = '';

    dayOrder.forEach(function (day) {
      var dayItems = byDay[day].slice().sort(function (a, b) {
        var sa = Number(a.sortOrder) || 0;
        var sb = Number(b.sortOrder) || 0;
        if (sa !== sb) return sa - sb;
        return String(a.time || '').localeCompare(String(b.time || ''));
      });
      var cls = scheduleGroupClasses(collectionKey, day);

      var dayDiv = document.createElement('div');
      dayDiv.className = cls.dayExtra ? ('day ' + cls.dayExtra) : 'day';

      var labelDiv = document.createElement('div');
      labelDiv.className = 'day-label';
      var dayP = document.createElement('p');
      dayP.className = 'worship-day';
      dayP.textContent = day;
      var firstItem = dayItems[0];
      if (firstItem) {
        dayP.setAttribute('data-cms-item-field', 'day');
        dayP.setAttribute('data-cms-type', 'weekday');
        dayP.setAttribute('data-cms-item-id', firstItem.id);
        if (isEditorMode) {
          dayP.classList.add('cms-editable');
          dayP.setAttribute('tabindex', '0');
          dayP.setAttribute('role', 'button');
          dayP.setAttribute('aria-label', 'Edit day for ' + (firstItem.title || 'this activity'));
        }
      }
      labelDiv.appendChild(dayP);
      dayDiv.appendChild(labelDiv);

      var eventsDiv = document.createElement('div');
      eventsDiv.className = 'day-events';

      var byTime = {};
      var timeOrder = [];
      dayItems.forEach(function (item) {
        var t = item.time || '';
        if (!(t in byTime)) { byTime[t] = []; timeOrder.push(t); }
        byTime[t].push(item);
      });

      timeOrder.forEach(function (time) {
        var timeItems = byTime[time];
        var groupDiv = document.createElement('div');
        groupDiv.className = cls.groupClass;

        var timeH3 = document.createElement('h3');
        timeH3.className = 'time-slot';
        timeH3.textContent = formatTime12h(time);
        var firstTimeItem = timeItems[0];
        timeH3.setAttribute('data-cms-item-field', 'time');
        timeH3.setAttribute('data-cms-type', 'time');
        timeH3.setAttribute('data-cms-item-id', firstTimeItem.id);
        if (isEditorMode) {
          timeH3.classList.add('cms-editable');
          timeH3.setAttribute('tabindex', '0');
          timeH3.setAttribute('role', 'button');
          timeH3.setAttribute('aria-label', 'Edit time for ' + (firstTimeItem.title || 'this activity'));
        }
        groupDiv.appendChild(timeH3);

        var blocksParent = groupDiv;
        if (timeItems.length > 1) {
          blocksParent = document.createElement('div');
          blocksParent.className = 'event-service-blocks-row';
          groupDiv.appendChild(blocksParent);
        }

        timeItems.forEach(function (item) {
          var block = document.createElement('div');
          block.className = 'service-block';
          block.setAttribute('data-cms-item', '');
          block.setAttribute('data-cms-item-id', item.id);

          var details = document.createElement('div');
          details.className = 'service-details';

          var titleP = document.createElement('p');
          titleP.setAttribute('data-cms-item-field', 'title');
          titleP.setAttribute('data-cms-type', 'text');
          titleP.textContent = item.title || '';
          if (isEditorMode) {
            titleP.classList.add('cms-editable');
            titleP.setAttribute('tabindex', '0');
            titleP.setAttribute('role', 'button');
            titleP.setAttribute('aria-label', 'Edit activity name: ' + (item.title || ''));
          }
          details.appendChild(titleP);

          if (item.details || isEditorMode) {
            var detailsP = document.createElement('p');
            detailsP.setAttribute('data-cms-item-field', 'details');
            detailsP.setAttribute('data-cms-type', 'textarea');
            detailsP.textContent = item.details || '';
            if (isEditorMode) {
              detailsP.classList.add('cms-editable');
              detailsP.setAttribute('tabindex', '0');
              detailsP.setAttribute('role', 'button');
              detailsP.setAttribute('aria-label', 'Edit details for ' + (item.title || 'this activity'));
            }
            details.appendChild(detailsP);
          }

          block.appendChild(details);
          addItemActionsHandle(block, item.title || 'this activity');
          blocksParent.appendChild(block);
        });

        eventsDiv.appendChild(groupDiv);
      });

      dayDiv.appendChild(eventsDiv);
      container.appendChild(dayDiv);
    });
  }

  function hydrateCollectionField(fieldKey) {
    var items = state.fields[fieldKey];
    if (!Array.isArray(items)) return;

    var containers = document.querySelectorAll('[data-cms-collection="' + cssEscape(fieldKey) + '"]');
    containers.forEach(function (container) {
      if (container.hasAttribute('data-cms-schedule')) {
        if (items.length === 0 && !isEditorMode) return; // preserve static markup for visitors
        renderScheduleCollection(container, items, fieldKey);
        return;
      }

      if (items.length === 0) return; // preserve existing static markup

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
        root.setAttribute('data-cms-item-id', item && item.id ? item.id : '');
        root.querySelectorAll('[data-cms-item-field]').forEach(function (fieldEl) {
          var key = fieldEl.getAttribute('data-cms-item-field');
          var type = fieldEl.getAttribute('data-cms-type') || 'text';
          setElementValue(fieldEl, type, item ? item[key] : '');
          if (isEditorMode) {
            fieldEl.classList.add('cms-editable');
            fieldEl.setAttribute('tabindex', '0');
            fieldEl.setAttribute('role', 'button');
            fieldEl.setAttribute('aria-label', 'Edit ' + key + (item && item.name ? ' for ' + item.name : ''));
          }
        });
        addItemActionsHandle(root, (item && item.name) || (item && item.title) || 'this item');
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

  function findItemFieldAncestor(el) {
    var node = el;
    while (node && node !== document.body) {
      if (node.hasAttribute && node.hasAttribute('data-cms-item-field')) return node;
      node = node.parentElement;
    }
    return null;
  }

  function findItemActionsAncestor(el) {
    var node = el;
    while (node && node !== document.body) {
      if (node.hasAttribute && node.hasAttribute('data-cms-item-actions')) return node;
      node = node.parentElement;
    }
    return null;
  }

  function findCollectionAncestor(el) {
    var node = el;
    while (node && node !== document.body) {
      if (node.hasAttribute && node.hasAttribute('data-cms-collection')) return node;
      node = node.parentElement;
    }
    return null;
  }

  function findItemRootAncestor(el) {
    var node = el;
    while (node && node !== document.body) {
      if (node.hasAttribute && node.hasAttribute('data-cms-item-id') && node.hasAttribute('data-cms-item')) return node;
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

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }

  // Injects a small stylesheet, only in editor mode, giving every editable element a
  // visible hover / keyboard-focus / selected state so senior-friendly users can always
  // see what is clickable before they click it. Never loaded in normal public mode.
  function injectEditorStyles() {
    var style = document.createElement('style');
    style.setAttribute('data-cms-editor-styles', '');
    style.textContent =
      '.cms-editable{outline:2px solid transparent;outline-offset:2px;cursor:pointer;border-radius:4px;transition:outline-color .12s ease,background-color .12s ease;}' +
      '.cms-editable:hover{outline-color:#4c8bf5;background-color:rgba(76,139,245,0.08);}' +
      '.cms-editable:focus-visible{outline-color:#1a56db;outline-width:3px;background-color:rgba(26,86,219,0.10);}' +
      '.cms-editable--selected{outline-color:#e08a00 !important;outline-width:3px !important;background-color:rgba(224,138,0,0.12) !important;}' +
      '.cms-item-actions-btn{position:absolute;top:-10px;right:-10px;width:26px;height:26px;border-radius:50%;border:1px solid #ccc;background:#fff;color:#333;font-size:14px;line-height:1;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.25);opacity:0;pointer-events:none;z-index:5;}' +
      '[data-cms-item]{position:relative;}' +
      '[data-cms-item]:hover .cms-item-actions-btn,[data-cms-item]:focus-within .cms-item-actions-btn,.cms-item-actions-btn:focus-visible{opacity:1;pointer-events:auto;}';
    document.head.appendChild(style);
  }

  // Marks every plain [data-cms-field] element as keyboard-focusable/hoverable. Collection
  // item fields and schedule-rendered fields already get this treatment where they're built
  // (hydrateCollectionField / renderScheduleCollection), since those are (re)created on the fly.
  function markScalarFieldsEditable() {
    document.querySelectorAll('[data-cms-field]').forEach(function (el) {
      el.classList.add('cms-editable');
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
      if (!el.hasAttribute('aria-label')) {
        el.setAttribute('aria-label', 'Edit ' + (el.getAttribute('data-cms-field') || 'this content'));
      }
    });
  }

  function clearSelectionClasses() {
    document.querySelectorAll('.cms-editable--selected').forEach(function (el) {
      el.classList.remove('cms-editable--selected');
    });
  }

  function applySelection(data) {
    clearSelectionClasses();
    if (!data || (!data.field && !data.itemId)) return;
    var selector;
    if (data.collection && data.itemId && data.field) {
      selector = '[data-cms-item-id="' + cssEscape(data.itemId) + '"][data-cms-item-field="' + cssEscape(data.field) + '"]';
    } else if (data.field) {
      selector = '[data-cms-field="' + cssEscape(data.field) + '"]';
    }
    if (!selector) return;
    document.querySelectorAll(selector).forEach(function (el) { el.classList.add('cms-editable--selected'); });
  }

  function handleEditableActivation(target) {
    var itemFieldEl = findItemFieldAncestor(target);
    if (itemFieldEl) {
      var collectionEl = findCollectionAncestor(itemFieldEl);
      var itemRoot = findItemRootAncestor(itemFieldEl);
      postToParent({
        type: 'collectionItemClick',
        collection: collectionEl ? collectionEl.getAttribute('data-cms-collection') : '',
        itemId: itemFieldEl.getAttribute('data-cms-item-id') || (itemRoot ? itemRoot.getAttribute('data-cms-item-id') : ''),
        field: itemFieldEl.getAttribute('data-cms-item-field'),
        fieldType: itemFieldEl.getAttribute('data-cms-type') || 'text',
        rect: rectOf(itemFieldEl)
      });
      return true;
    }

    var actionsEl = findItemActionsAncestor(target);
    if (actionsEl) {
      var itemRoot2 = findItemRootAncestor(actionsEl);
      var collectionEl2 = findCollectionAncestor(actionsEl);
      postToParent({
        type: 'collectionItemActions',
        collection: collectionEl2 ? collectionEl2.getAttribute('data-cms-collection') : '',
        itemId: itemRoot2 ? itemRoot2.getAttribute('data-cms-item-id') : '',
        rect: rectOf(actionsEl)
      });
      return true;
    }

    var fieldEl = findFieldAncestor(target);
    if (fieldEl) {
      postToParent({
        type: 'fieldClick',
        field: fieldEl.getAttribute('data-cms-field'),
        fieldType: fieldEl.getAttribute('data-cms-type') || 'text',
        rect: rectOf(fieldEl)
      });
      return true;
    }

    return false;
  }

  function initEditorMode() {
    injectEditorStyles();
    markScalarFieldsEditable();

    document.addEventListener('click', function (event) {
      if (handleEditableActivation(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      var anchorEl = findAnchorAncestor(event.target);
      if (anchorEl) {
        event.preventDefault();
        event.stopPropagation();
        postToParent({ type: 'navigateBlocked', href: anchorEl.getAttribute('href') });
      }
    }, true);

    // Keyboard activation (Enter / Space) for every focusable editable element, so the
    // editor is fully usable without a mouse.
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      var target = event.target;
      if (!target || !target.classList || !target.classList.contains('cms-editable')) return;
      if (handleEditableActivation(target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);

    window.addEventListener('message', function (event) {
      if (!isValidParentMessage(event)) return;
      var data = event.data;
      if (data.type === 'init' || data.type === 'refresh') {
        applyFields(data.fields);
        markScalarFieldsEditable();
      } else if (data.type === 'setField') {
        if (typeof data.field === 'string') {
          state.fields[data.field] = data.value;
          if (Array.isArray(data.value)) {
            hydrateCollectionField(data.field);
          } else {
            hydrateScalarField(data.field);
          }
        }
      } else if (data.type === 'setCollectionItemField') {
        var items = state.fields[data.collection];
        if (Array.isArray(items) && typeof data.itemId === 'string' && typeof data.field === 'string') {
          var item = items.filter(function (it) { return it && it.id === data.itemId; })[0];
          if (item) {
            item[data.field] = data.value;
            hydrateCollectionField(data.collection);
          }
        }
      } else if (data.type === 'setSelection') {
        applySelection(data);
      } else if (data.type === 'clearSelection') {
        clearSelectionClasses();
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
