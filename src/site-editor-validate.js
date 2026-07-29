// Server-side validation + sanitization for the visual website editor.
// Client-side controls also validate (admin/public/site-editor.js), but per the
// security requirements, the server never trusts client validation alone.

import {
  WEEKDAYS,
  RICH_TEXT_ALLOWED_TAGS,
  RICH_TEXT_ALLOWED_URL_PROTOCOLS,
  URL_FIELD_ALLOWED_PROTOCOLS,
  getFieldSchema,
  getPageSchema
} from './site-editor-schema.js';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Loose but safe: digits, spaces, parens, plus, hyphen — 7 to 20 chars.
const PHONE_RE = /^[+()\-.\s\d]{7,20}$/;
const STABLE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function stripControlChars(input) {
  // Remove C0/C1 control characters except \n and \t.
  // eslint-disable-next-line no-control-regex
  return String(input).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function sanitizeText(raw, maxLength) {
  const cleaned = stripControlChars(String(raw ?? '')).replace(/\r\n/g, '\n').trim();
  return cleaned.slice(0, maxLength || 500);
}

function isSafeUrl(raw, allowedProtocols) {
  const value = String(raw || '').trim();
  if (!value) return false;
  // Reject javascript:, data:, vbscript:, and any other scheme not explicitly allowed.
  // Relative/root-relative paths (no scheme) are allowed for internal links.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    const scheme = value.slice(0, value.indexOf(':') + 1).toLowerCase();
    return allowedProtocols.includes(scheme);
  }
  // No scheme: allow relative paths / fragment / protocol-relative rejected (ambiguous).
  return !value.startsWith('//') && !/^\s*javascript:/i.test(value);
}

function sanitizeRichText(raw, maxLength) {
  let value = stripControlChars(String(raw ?? '')).slice(0, (maxLength || 2000) * 2);

  // Escape everything, then selectively re-allow the small tag allowlist.
  const escaped = value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  let out = escaped;
  for (const tag of RICH_TEXT_ALLOWED_TAGS) {
    if (tag === 'a') {
      // Re-allow <a href="..."> (and closing tag), validating the href protocol.
      out = out.replace(/&lt;a\s+href=(?:&quot;|")([^"&]*)(?:&quot;|")\s*&gt;/gi, (m, href) => {
        const decodedHref = href.replace(/&amp;/g, '&');
        if (!isSafeUrl(decodedHref, RICH_TEXT_ALLOWED_URL_PROTOCOLS)) return '';
        const escapedHref = decodedHref.replace(/"/g, '&quot;');
        return `<a href="${escapedHref}" rel="noopener noreferrer" target="_blank">`;
      });
      out = out.replace(/&lt;\/a&gt;/gi, '</a>');
    } else if (tag === 'br') {
      out = out.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
    } else {
      out = out.replace(new RegExp(`&lt;${tag}&gt;`, 'gi'), `<${tag}>`);
      out = out.replace(new RegExp(`&lt;\\/${tag}&gt;`, 'gi'), `</${tag}>`);
    }
  }
  return out.slice(0, maxLength || 2000);
}

function validateScalarField(schema, rawValue, path, errors) {
  const type = schema.type;

  if (rawValue === undefined || rawValue === null || rawValue === '') {
    if (schema.required) errors.push(`${path} is required.`);
    if (type === 'boolean') return false;
    if (type === 'image') return null;
    if (type === 'number') return typeof schema.min === 'number' ? schema.min : 0;
    return '';
  }

  switch (type) {
    case 'weekday': {
      const value = String(rawValue).trim();
      if (!WEEKDAYS.includes(value)) {
        errors.push(`${path} must be a valid weekday.`);
        return WEEKDAYS[0];
      }
      return value;
    }
    case 'time': {
      const value = String(rawValue).trim();
      if (!TIME_RE.test(value)) {
        errors.push(`${path} must be in HH:mm 24-hour format.`);
        return '00:00';
      }
      return value;
    }
    case 'text': {
      return sanitizeText(rawValue, schema.maxLength || 200);
    }
    case 'textarea': {
      return sanitizeText(rawValue, schema.maxLength || 2000);
    }
    case 'rich_text': {
      return sanitizeRichText(rawValue, schema.maxLength || 2000);
    }
    case 'email': {
      const value = sanitizeText(rawValue, 200);
      if (!EMAIL_RE.test(value)) {
        errors.push(`${path} must be a valid email address.`);
      }
      return value;
    }
    case 'telephone': {
      const value = sanitizeText(rawValue, 40);
      if (!PHONE_RE.test(value)) {
        errors.push(`${path} must be a valid phone number.`);
      }
      return value;
    }
    case 'url': {
      const value = sanitizeText(rawValue, 500);
      if (!isSafeUrl(value, URL_FIELD_ALLOWED_PROTOCOLS)) {
        errors.push(`${path} must be a valid http(s)/mailto/tel URL or site-relative path.`);
      }
      return value;
    }
    case 'boolean': {
      return Boolean(rawValue);
    }
    case 'number': {
      let value = Number(rawValue);
      if (!Number.isFinite(value)) {
        errors.push(`${path} must be a number.`);
        value = 0;
      }
      if (typeof schema.min === 'number' && value < schema.min) value = schema.min;
      if (typeof schema.max === 'number' && value > schema.max) value = schema.max;
      return Math.round(value);
    }
    case 'select': {
      const value = String(rawValue).trim();
      const options = Array.isArray(schema.options) ? schema.options.map((o) => o.value) : [];
      if (!options.includes(value)) {
        errors.push(`${path} must be one of: ${options.join(', ')}.`);
        return options[0] || '';
      }
      return value;
    }
    case 'image': {
      if (!isPlainObject(rawValue)) {
        errors.push(`${path} must be an image object with url/alt.`);
        return null;
      }
      const url = sanitizeText(rawValue.url, 500);
      const alt = sanitizeText(rawValue.alt, 200);
      if (url && !isSafeUrl(url, ['http:', 'https:', '']) && !url.startsWith('/')) {
        errors.push(`${path} image URL is not allowed.`);
      }
      if (schema.required && !url) errors.push(`${path} image is required.`);
      return { url, alt };
    }
    default:
      errors.push(`${path} has an unsupported field type.`);
      return null;
  }
}

function validateCollectionField(schema, rawValue, path, errors) {
  const maxItems = schema.maxItems || 50;
  if (rawValue === undefined || rawValue === null) return [];
  if (!Array.isArray(rawValue)) {
    errors.push(`${path} must be a list.`);
    return [];
  }
  if (rawValue.length > maxItems) {
    errors.push(`${path} exceeds the maximum of ${maxItems} items.`);
  }

  const seenIds = new Set();
  const out = [];
  for (const rawItem of rawValue.slice(0, maxItems)) {
    if (!isPlainObject(rawItem)) continue;
    const id = String(rawItem.id || '').trim();
    if (!STABLE_ID_RE.test(id)) {
      errors.push(`${path} item id "${id}" is invalid (use letters, numbers, "-", "_").`);
      continue;
    }
    if (seenIds.has(id)) {
      errors.push(`${path} has a duplicate item id "${id}".`);
      continue;
    }
    seenIds.add(id);

    const item = { id };
    if (Array.isArray(schema.groups) && schema.groups.length) {
      const group = String(rawItem.group || '').trim();
      if (!schema.groups.includes(group)) {
        errors.push(`${path} item "${id}" has an invalid group.`);
      }
      item.group = schema.groups.includes(group) ? group : schema.groups[0];
    }

    for (const [fieldKey, fieldSchema] of Object.entries(schema.itemFields || {})) {
      item[fieldKey] = validateScalarField(fieldSchema, rawItem[fieldKey], `${path}.${fieldKey}`, errors);
    }
    out.push(item);
  }
  return out;
}

// Validates a full `fields` object for a page against its schema.
// - Rejects any key not present in the schema (returns as an error, field dropped).
// - `partial`: when true (draft saves), missing required fields are allowed (not yet
//   filled in); when false (publish), missing required fields are rejected.
export function validatePageFields(page, rawFields, { partial = true } = {}) {
  const pageSchema = getPageSchema(page);
  if (!pageSchema) throw new Error(`Unknown page "${page}".`);
  const schemaFields = pageSchema.fields;
  const errors = [];
  const out = {};

  const input = isPlainObject(rawFields) ? rawFields : {};
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(schemaFields, key)) {
      errors.push(`Unknown field "${key}" is not allowed on page "${page}".`);
    }
  }

  for (const [fieldKey, fieldSchema] of Object.entries(schemaFields)) {
    const rawValue = input[fieldKey];
    if (rawValue === undefined && partial) continue; // draft: allow gradual fill-in
    if (fieldSchema.type === 'collection') {
      out[fieldKey] = validateCollectionField(fieldSchema, rawValue, fieldKey, errors);
    } else {
      out[fieldKey] = validateScalarField(fieldSchema, rawValue, fieldKey, errors);
    }
  }

  if (!partial) {
    // Publish-time: every required field must have a non-empty resolved value.
    for (const [fieldKey, fieldSchema] of Object.entries(schemaFields)) {
      if (!fieldSchema.required) continue;
      const value = out[fieldKey];
      const empty = value === '' || value === null || value === undefined
        || (fieldSchema.type === 'image' && !value?.url);
      if (empty) errors.push(`"${fieldKey}" is required before publishing.`);
    }
  }

  return { ok: errors.length === 0, fields: out, errors };
}

export { getFieldSchema, getPageSchema, sanitizeRichText, isSafeUrl };
