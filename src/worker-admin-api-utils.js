export function normalizeAnnouncements(data) {
  if (Array.isArray(data)) return { posts: data };
  if (Array.isArray(data?.posts)) return { posts: data.posts };
  if (Array.isArray(data?.announcements)) return { posts: data.announcements };
  return { posts: [] };
}

export function normalizeEvents(data) {
  if (Array.isArray(data)) return { events: data };
  if (Array.isArray(data?.events)) return { events: data.events };
  if (Array.isArray(data?.schedule)) return { events: data.schedule };
  return { events: [] };
}

export function normalizeBulletins(data) {
  if (Array.isArray(data)) return { bulletins: data };
  if (Array.isArray(data?.bulletins)) return { bulletins: data.bulletins };
  return { bulletins: [] };
}

export function isoOrEmpty(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString();
}

export function bulletinUrlForKey(fileKey) {
  const key = String(fileKey || '').trim();
  if (!key) return '';
  if (/^https?:\/\//i.test(key)) return key;
  if (key.startsWith('/')) return key;
  return `/cdn/gallery/${encodeURI(key)}`;
}

export function emptyFinances() {
  return {
    entries: [],
    meta: {
      categories: [],
      funds: []
    }
  };
}

export function financeText(value, max = 240) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

export function financeDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const t = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(t)) return '';
  return raw;
}

export function financeAmountToCents(value) {
  const num = Number(String(value || '').trim());
  if (!Number.isFinite(num) || num <= 0) return Number.NaN;
  return Math.round(num * 100);
}

export function financeUniqueSorted(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((v) => financeText(v, 120))
    .filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
}

export function parseDateOnlyToTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return Number.NaN;
  const ms = Date.parse(`${raw}T00:00:00`);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

export function startOfTodayMs() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function isoFromDateTimeParts(datePart, timePart) {
  const d = String(datePart || '').trim();
  if (!d) return '';
  const t = String(timePart || '').trim();
  const ms = Date.parse(`${d}T${t || '00:00'}`);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString();
}