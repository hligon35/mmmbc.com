// Centralized field registry ("page schema") for the visual website editor.
// Every editable public-site field must be declared here — the API rejects any
// page key or field key that isn't listed in this file. This is the single
// source of truth consumed by:
//   - src/worker-site-editor.js (server-side validation + the schema API response)
//   - admin/public/site-editor.js (renders the correct control per field.type)
//
// To add a new field: add an entry under the page's `fields` map, then add a
// matching `data-cms-field="<page>.<fieldKey>" data-cms-type="<type>"` element to
// the corresponding public HTML page. See SITE_EDITOR.md for the full guide.

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const FIELD_TYPES = [
  'weekday', 'time', 'text', 'textarea', 'email', 'telephone', 'url',
  'image', 'boolean', 'select', 'rich_text', 'collection'
];

// Tags/attributes allowed through the (minimal, regex-based) rich_text sanitizer.
export const RICH_TEXT_ALLOWED_TAGS = ['b', 'strong', 'i', 'em', 'br', 'p', 'a'];
export const RICH_TEXT_ALLOWED_URL_PROTOCOLS = ['http:', 'https:', 'mailto:'];
export const URL_FIELD_ALLOWED_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'];

const profileItemFields = {
  name: { type: 'text', label: 'Name', required: true, maxLength: 120 },
  title: { type: 'text', label: 'Title / role', maxLength: 160 },
  bio: { type: 'textarea', label: 'Biography', maxLength: 4000 },
  image: { type: 'image', label: 'Photo' }
};

export const PAGE_SCHEMAS = {
  home: {
    label: 'Home',
    fields: {
      'hero.cta.text': { type: 'text', label: 'Hero button text', required: true, maxLength: 60 },
      'hero.cta.url': { type: 'url', label: 'Hero button link', required: true },
      'worship.primary.day': { type: 'weekday', label: 'Primary worship day', required: true },
      'worship.primary.time': { type: 'time', label: 'Primary worship time', required: true },
      'worship.primary.label': { type: 'text', label: 'Primary worship service name', required: true, maxLength: 120 }
    }
  },
  ministries: {
    label: 'Ministries',
    fields: {
      'page.intro': { type: 'rich_text', label: 'Intro text', maxLength: 2000 },
      profiles: {
        type: 'collection', label: 'Ministry leaders', itemLabel: 'Leader', maxItems: 40, itemFields: profileItemFields
      }
    }
  },
  leadership: {
    label: 'Leadership & Staff',
    fields: {
      profiles: {
        type: 'collection',
        label: 'Leadership profiles',
        itemLabel: 'Profile',
        maxItems: 60,
        groups: ['staff', 'deacons', 'deaconesses', 'official_team'],
        itemFields: profileItemFields
      }
    }
  },
  church_history: {
    label: 'Church History',
    fields: {
      hero_image: { type: 'image', label: 'History page photo' }
    }
  },
  facility_rental: {
    label: 'Facility Rental',
    fields: {
      'contact.email': { type: 'email', label: 'Rental contact email', required: true },
      'contact.phone': { type: 'telephone', label: 'Rental contact phone', required: true },
      availability: {
        type: 'select',
        label: 'Availability status',
        required: true,
        options: [
          { value: 'open', label: 'Open for booking' },
          { value: 'limited', label: 'Limited availability' },
          { value: 'closed', label: 'Not currently available' }
        ]
      }
    }
  },
  live_praise: {
    label: 'Live Praise',
    fields: {
      currently_live: { type: 'boolean', label: 'Show "We are currently LIVE" banner' },
      'stream.url': { type: 'url', label: 'Livestream embed URL', required: true }
    }
  },
  contact: {
    label: 'Contact',
    fields: {
      'contact.address': { type: 'textarea', label: 'Address', required: true, maxLength: 300 },
      'contact.phone': { type: 'telephone', label: 'Phone', required: true },
      'contact.email': { type: 'email', label: 'Email', required: true },
      'contact.fax': { type: 'telephone', label: 'Fax' }
    }
  }
};

export const PAGE_KEYS = Object.keys(PAGE_SCHEMAS);

// Initial published values — MUST mirror the current live static HTML exactly so the
// first migration (first time a page row is created) does not change public appearance.
// This migration is idempotent: src/worker-site-editor.js only inserts this seed data
// when a page has no existing row; it never overwrites a value that's already stored.
export const INITIAL_PUBLISHED_CONTENT = {
  home: {
    'hero.cta.text': 'Contact Us',
    'hero.cta.url': '/Pages/contact.html#contact-form-section',
    'worship.primary.day': 'Sunday',
    'worship.primary.time': '11:00',
    'worship.primary.label': 'Morning Worship'
  },
  ministries: {
    'page.intro': 'Learn more about the ministries and leaders who serve the Mt. Moriah Missionary Baptist Church family.',
    profiles: [] // Existing ministries.html cards remain static markup; empty collection = no override.
  },
  leadership: {
    profiles: []
  },
  church_history: {
    hero_image: { url: '/ConImg/webPages/church_history_image1.jpeg', alt: 'Mt. Moriah Missionary Baptist Church historical photo' }
  },
  facility_rental: {
    'contact.email': 'mtmoriahmbc@comcast.net',
    'contact.phone': '(270) 443-3714',
    availability: 'open'
  },
  live_praise: {
    currently_live: false,
    'stream.url': 'https://www.youtube.com/embed/live_stream?channel=UCkAaHiYmUKIdKePifg1D2pg&rel=0'
  },
  contact: {
    'contact.address': '1201 S 8th St, Paducah, KY 42003',
    'contact.phone': '(270) 443-3714',
    'contact.email': 'mtmoriahmbc1201@gmail.com',
    'contact.fax': '(270) 443-7125'
  }
};

export function getPageSchema(page) {
  return PAGE_SCHEMAS[String(page || '').trim().toLowerCase()] || null;
}

export function getFieldSchema(page, fieldKey) {
  const schema = getPageSchema(page);
  if (!schema) return null;
  return schema.fields[fieldKey] || null;
}
