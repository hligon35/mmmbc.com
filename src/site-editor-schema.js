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
  'image', 'boolean', 'select', 'rich_text', 'collection', 'number'
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

// Shared shape for both weekly-schedule collections on the Home page. Each item is one
// activity (one weekday + one time + a name + optional details), so two activities that
// share the same day and/or time are simply two separate items — never merged.
const scheduleItemFields = {
  day: { type: 'weekday', label: 'Day', required: true },
  time: { type: 'time', label: 'Time', required: true },
  title: { type: 'text', label: 'Activity name', required: true, maxLength: 120 },
  details: { type: 'textarea', label: 'Details (optional)', maxLength: 400 },
  sortOrder: { type: 'number', label: 'Sort order', min: 0, max: 999 }
};

export const PAGE_SCHEMAS = {
  home: {
    label: 'Home',
    fields: {
      'hero.cta.text': { type: 'text', label: 'Hero button text', required: true, maxLength: 60 },
      'hero.cta.url': { type: 'url', label: 'Hero button link', required: true },
      'sections.worship.heading': { type: 'text', label: 'Worship Times heading', required: true, maxLength: 80 },
      'sections.ministries.heading': { type: 'text', label: 'Weekly Ministry Times heading', required: true, maxLength: 80 },
      'worship.schedule': {
        type: 'collection', label: 'Worship schedule', itemLabel: 'Service', maxItems: 30, itemFields: scheduleItemFields
      },
      'ministries.weeklySchedule': {
        type: 'collection', label: 'Weekly ministry schedule', itemLabel: 'Activity', maxItems: 30, itemFields: scheduleItemFields
      }
    }
  },
  ministries: {
    label: 'Ministries',
    fields: {
      'page.title': { type: 'text', label: 'Page heading', required: true, maxLength: 100 },
      'page.intro': { type: 'rich_text', label: 'Intro text', maxLength: 2000 },
      profiles: {
        type: 'collection', label: 'Ministry leaders', itemLabel: 'Leader', maxItems: 40, itemFields: profileItemFields
      }
    }
  },
  leadership: {
    label: 'Leadership & Staff',
    fields: {
      'page.title': { type: 'text', label: 'Page heading', required: true, maxLength: 100 },
      'sections.staff.heading': { type: 'text', label: 'Staff section heading', required: true, maxLength: 80 },
      'sections.deacons.heading': { type: 'text', label: 'Deacons section heading', required: true, maxLength: 80 },
      'sections.deacons.intro': { type: 'rich_text', label: 'Deacons intro text', maxLength: 2000 },
      'sections.deaconesses.heading': { type: 'text', label: 'Deaconesses section heading', required: true, maxLength: 80 },
      'sections.official_team.heading': { type: 'text', label: 'Official Team & Trustees section heading', required: true, maxLength: 80 },
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
      'page.title': { type: 'text', label: 'Page heading', required: true, maxLength: 100 },
      hero_image: { type: 'image', label: 'History page photo' }
    }
  },
  facility_rental: {
    label: 'Facility Rental',
    fields: {
      'page.title': { type: 'text', label: 'Page heading', required: true, maxLength: 100 },
      'sections.rental.heading1': { type: 'text', label: 'First section heading', required: true, maxLength: 80 },
      'sections.rental.description': { type: 'rich_text', label: 'Sacred Celebrations description', maxLength: 2000 },
      'sections.rental.heading2': { type: 'text', label: 'Second section heading', required: true, maxLength: 80 },
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
      'page.title': { type: 'text', label: 'Page heading', required: true, maxLength: 100 },
      'page.description': { type: 'rich_text', label: 'Intro description', maxLength: 1000 },
      currently_live: { type: 'boolean', label: 'Show "We are currently LIVE" banner' },
      'stream.url': { type: 'url', label: 'Livestream embed URL', required: true }
    }
  },
  contact: {
    label: 'Contact',
    fields: {
      'page.title': { type: 'text', label: 'Page heading', required: true, maxLength: 100 },
      'page.intro': { type: 'rich_text', label: 'Intro text', maxLength: 500 },
      'sections.form.intro': { type: 'rich_text', label: 'Form section intro text', maxLength: 500 },
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
    'sections.worship.heading': 'Worship Times',
    'sections.ministries.heading': 'Weekly Ministry Times',
    'worship.schedule': [
      { id: 'sun-0930-discipleship', day: 'Sunday', time: '09:30', title: 'Discipleship Training', details: 'Youth & Adult', sortOrder: 0 },
      { id: 'sun-1100-worship', day: 'Sunday', time: '11:00', title: 'Morning Worship', details: '', sortOrder: 1 },
      { id: 'mon-1800-prayer', day: 'Monday', time: '18:00', title: 'Prayer Meeting', details: '', sortOrder: 2 },
      { id: 'wed-1830-bible-study', day: 'Wednesday', time: '18:30', title: 'Bible Study', details: '', sortOrder: 3 }
    ],
    'ministries.weeklySchedule': [
      { id: 'tue-1800-womens-ministry', day: 'Tuesday', time: '18:00', title: 'Womens Ministry', details: 'Every 4th Tuesday', sortOrder: 0 },
      { id: 'wed-1730-youth-choir', day: 'Wednesday', time: '17:30', title: 'Youth Choir Rehearsal', details: 'Every Wednesday before 3rd Sunday', sortOrder: 1 },
      { id: 'wed-1730-ushers-meeting', day: 'Wednesday', time: '17:30', title: "Usher's Meeting", details: 'Last Wednesday of the Month: Mar, Jun, Sept, Dec', sortOrder: 2 },
      { id: 'thu-1800-mass-choir', day: 'Thursday', time: '18:00', title: 'Mass Choir Rehearsal', details: 'Thursday before 1st & 5th Sunday', sortOrder: 3 },
      { id: 'thu-1800-womens-choir', day: 'Thursday', time: '18:00', title: "Women's Choir Rehearsal", details: 'Thursday before 2nd Sunday', sortOrder: 4 },
      { id: 'thu-1830-male-choir', day: 'Thursday', time: '18:30', title: 'Male Choir Rehearsal', details: 'Thursday before 4th & 5th Sunday', sortOrder: 5 }
    ]
  },
  ministries: {
    'page.title': 'Ministries',
    'page.intro': 'Learn more about the ministries and leaders who serve the Mt. Moriah Missionary Baptist Church family.',
    profiles: [] // Existing ministries.html cards remain static markup; empty collection = no override.
  },
  leadership: {
    'page.title': 'Leadership & Staff',
    'sections.staff.heading': 'Staff',
    'sections.deacons.heading': 'Deacons',
    'sections.deacons.intro': '<p>The deacons are ordained to do their work according to Acts 6:1-8, 1 Timothy 3:8-13 and Titus 2.</p><p>The deacons assist the pastor, cooperate with the pastor in providing the pulpit supply and the leaders of the prayer meeting; visit members; care for the sick and needy and distressed members of the church. The board shall promote Christian instruction and ministry to the church membership.</p>',
    'sections.deaconesses.heading': 'Deaconesses',
    'sections.official_team.heading': 'Official Team & Trustees',
    profiles: []
  },
  church_history: {
    'page.title': 'CHURCH HISTORY',
    hero_image: { url: '/ConImg/webPages/church_history_image1.jpeg', alt: 'Mt. Moriah Missionary Baptist Church historical photo' }
  },
  facility_rental: {
    'page.title': 'Facility Rental',
    'sections.rental.heading1': 'Sacred Celebrations',
    'sections.rental.description': '<p>Your wedding or other special event must be a sacred celebration. Your plans for the service should reflect that fact and also align with the beliefs and worship practices of Mt. Moriah Missionary Baptist Church. Careful planning will ensure that your wedding is meaningful to you, your family, and friends.</p><p>Mt. Moriah Missionary Baptist Church seats up to 250 people, and the fellowship and educational building seating is 200.</p>',
    'sections.rental.heading2': 'Submit a Request for Building Rental',
    'contact.email': 'mtmoriahmbc@comcast.net',
    'contact.phone': '(270) 443-3714',
    availability: 'open'
  },
  live_praise: {
    'page.title': 'Live Praise',
    'page.description': '<p>When our services are being broadcast LIVE, the current service will be shown at the top of the page.</p><p>Otherwise, the most recent service will appear at the top.</p><p>Other past services are shown below the first image in chronological order.</p>',
    currently_live: false,
    'stream.url': 'https://www.youtube.com/embed/live_stream?channel=UCkAaHiYmUKIdKePifg1D2pg&rel=0'
  },
  contact: {
    'page.title': 'Contact Us',
    'page.intro': 'Have questions? Need more information about our church or an upcoming event? Please feel free to reach out to us!',
    'sections.form.intro': 'We value your connection. Use the form below to send us a message.',
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
