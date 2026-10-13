// Explicitly published ministry media. Gallery privacy remains authoritative when a record exists.
export const MINISTRY_R2_IMAGES = Object.freeze({
  "site/ministry/elaine-fletcher.jpg": "gallery/2024-11/2026-01-22_Elaine-FLetcher_c8d8be27-0a45-4e65-a167-153f011f7318.jpg",
  "site/ministry/jesse-shields.jpg": "gallery/2024-11/2026-01-22_Jesse-Shields_2560a920-a6b7-433c-931e-39e2e9fc34d0.jpg",
  "site/ministry/janice-jones.jpg": "gallery/2024-11/2026-01-22_Janice-Jones_ad8e386d-e8f1-43c5-a1d8-d8942783a3f3.jpg",
  "site/ministry/custodial.png": "gallery/2024-11/2026-01-22_Custodial_1a3c0a89-db2e-4949-ab13-8b6997d54e7f.png",
  "site/ministry/disciple-training.png": "gallery/2024-11/2026-01-22_disciple-training_a1edcff2-9585-464a-a1c2-ae3ed2c73f85.png",
  "site/ministry/mary-dumas.jpg": "gallery/2024-11/2026-01-22_Mary-Dumas_6f71404e-b054-478a-8300-ebb64c490916.jpg",
  "site/ministry/video.png": "gallery/2024-11/2026-01-22_Video_1efb3294-b6c2-4766-ad3f-47a0473d8ab5.png"
});

export const LEGACY_MINISTRY_IMAGES = Object.freeze({
  "Elaine.jpeg": "/cdn/gallery/site/ministry/elaine-fletcher.jpg",
  "Earlie.jpeg": "/cdn/gallery/gallery/2025-05/2026-01-22_Earlie_07ac31f4-7ca8-4b65-a985-01141c1754c4.jpeg",
  "Richard-Washington.png": "/ConImg/webPages/Richard%20Washington.png",
  "Brenda-Stokes.png": "/ConImg/webPages/Brenda%20Stokes.png",
  "Image-Coming-Soon.png": "/ConImg/profile-photo-pending.svg",
  "disciple-training.png": "/cdn/gallery/site/ministry/disciple-training.png",
  "Jesse-Shields.jpg": "/cdn/gallery/site/ministry/jesse-shields.jpg",
  "Tonya-Gill.png": "/ConImg/webPages/Tonya%20Gill.png",
  "Janice-Jones.jpg": "/cdn/gallery/site/ministry/janice-jones.jpg",
  "Custodial.png": "/cdn/gallery/site/ministry/custodial.png",
  "Derek-Strong.png": "/ConImg/webPages/Derek%20Strong.png",
  "Mary-Dumas.jpg": "/cdn/gallery/site/ministry/mary-dumas.jpg",
  "Elbert-Speers.png": "/ConImg/webPages/Elbert%20Speers.png",
  "Video.png": "/cdn/gallery/site/ministry/video.png"
});

export function resolveLegacyMinistryImageUrl(value) {
  try {
    const url = new URL(String(value || ''), 'https://mmmbc.com');
    if (!['mmmbc.com', 'www.mmmbc.com', 'mmmbc.alphazonelabs.com'].includes(url.hostname)
        || !url.pathname.startsWith('/wp-content/uploads/')) return value;
    const filename = decodeURIComponent(url.pathname.split('/').pop());
    return LEGACY_MINISTRY_IMAGES[filename] || value;
  } catch { return value; }
}

export function normalizeMinistryImages(fields) {
  if (!Array.isArray(fields?.profiles)) return fields;
  return { ...fields, profiles: fields.profiles.map(profile => {
    if (!profile?.image?.url) return profile;
    return { ...profile, image: { ...profile.image, url: resolveLegacyMinistryImageUrl(profile.image.url) } };
  }) };
}

export async function servePublishedMinistryImage(request, env, key) {
  const source = MINISTRY_R2_IMAGES[key];
  if (!source) return new Response('Not found', { status: 404 });
  if (!env.DB || !env.GALLERY_BUCKET) return new Response('Image temporarily unavailable', { status: 503 });
  try {
    const row = await env.DB.prepare('SELECT is_hidden FROM gallery_items WHERE file_key=? OR thumb_key=? LIMIT 1').bind(source, source).first();
    // Missing gallery indexes are allowed only for these explicitly published source keys.
    if (row && Number(row.is_hidden)) return new Response('Not found', { status: 404 });
    const object = await env.GALLERY_BUCKET.get(source);
    if (!object) return new Response('Not found', { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Content-Type', key.endsWith('.png') ? 'image/png' : 'image/jpeg');
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  } catch {
    // Do not serve media when gallery visibility cannot be checked.
    return new Response('Image temporarily unavailable', { status: 503 });
  }
}
