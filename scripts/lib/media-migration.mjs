import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function imageType(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg', 'jpg'];
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['image/png', 'png'];
  if (/^GIF8[79]a$/.test(bytes.subarray(0,6).toString())) return ['image/gif', 'gif'];
  if (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return ['image/webp', 'webp'];
  throw new Error('Unsupported image bytes; keep this file for manual review.');
}

export async function migrateMedia({ candidates, inventory, readExisting, readSource, upload, manifest, save, dryRun = true }) {
  manifest.objects ||= {};
  manifest.sources ||= {};
  const byHash = new Map();
  // Prefer already registered/public originals; never unhide a matching private photo.
  inventory.sort((a,b) => Number(a.hidden)-Number(b.hidden) || Number(!a.galleryId)-Number(!b.galleryId));
  for (const object of inventory) {
    if (object.size > 10 * 1024 * 1024) continue; // Cannot equal a supported smaller source.
    const cached = manifest.objects[object.key];
    const digest = cached?.etag === object.etag && cached?.size === object.size && /^[a-f0-9]{64}$/.test(cached.sha256) ? cached.sha256 : sha256(await readExisting(object.key));
    manifest.objects[object.key] = { sha256: digest, etag: object.etag, size: object.size };
    if (!byHash.has(digest)) byHash.set(digest, object);
  }
  await save(manifest);
  const summary = { dryRun, scanned: candidates.length, uploaded: 0, reused: 0, planned: 0, failed: 0, hidden: 0 };
  for (const candidate of candidates) {
    try {
      const bytes = await readSource(candidate);
      if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('Image is empty or exceeds the 10 MB import limit.');
      const [type, extension] = imageType(bytes);
      const digest = sha256(bytes);
      const match = byHash.get(digest);
      let result;
      if (dryRun) {
        result = { key: match?.key || `gallery/wordpress/${digest}.${extension}`, hidden: Boolean(match?.hidden), sha256: digest };
        summary[match ? 'reused' : 'planned']++;
      } else if (match?.imported) {
        result = match.result;
        summary.reused++;
      } else {
        result = await upload({ candidate, bytes, type, sha256: digest, reuseKey: match?.key || '' });
        if (result.sha256 !== digest) throw new Error('Server content hash does not match the source.');
        summary[result.reused ? 'reused' : 'uploaded']++;
      }
      if (result.hidden) summary.hidden++;
      const entry = { ...result, status: dryRun ? 'planned' : 'complete', sha256: digest,
        source: candidate.source, oldUrls: candidate.oldUrls || [candidate.source], label: candidate.label };
      manifest.sources[candidate.source] = entry;
      // Identical source files later in this run reuse the same destination and D1 identity.
      byHash.set(digest, { key: result.key, hidden: result.hidden, imported: !dryRun, result });
    } catch (error) {
      summary.failed++;
      manifest.sources[candidate.source] = { status: 'failed', source: candidate.source, error: String(error.message).slice(0,300) };
    }
    await save(manifest);
  }
  manifest.summary = summary;
  manifest.updatedAt = new Date().toISOString();
  await save(manifest);
  return summary;
}
