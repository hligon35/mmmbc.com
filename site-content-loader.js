/*
 * site-content-loader.js
 *
 * Published profile-content hydration loader.
 * The standalone visual Site Editor has been removed. Static HTML remains the
 * fallback whenever no published profile payload is available.
 *
 * Public mode:
 *   - Fetches GET /public/site-content/{page} (published fields only, unauthenticated).
 *   - Hydrates every [data-cms-field] element found on the page.
 *   - On any failure, silently keeps the static HTML already baked into the page
 *     (graceful fallback — the page must never break or show blank/error content).
 *
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
          details.appendChild(titleP);

          if (item.details) {
            var detailsP = document.createElement('p');
            detailsP.setAttribute('data-cms-item-field', 'details');
            detailsP.setAttribute('data-cms-type', 'textarea');
            detailsP.textContent = item.details || '';
            details.appendChild(detailsP);
          }

          block.appendChild(details);
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
        if (items.length === 0) return; // preserve static markup for visitors
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
    fetch('/public/site-content/' + encodeURIComponent(PAGE), { credentials: 'omit', cache: 'default' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.fields) applyFields(data.fields);
      })
      .catch(function () {
        // Network/parse failure: keep the static HTML already rendered on the page.
      });
  }

  function start() {
    try {
      loadPublished();
    } catch (err) {
      // Keep the static page content if hydration fails.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
