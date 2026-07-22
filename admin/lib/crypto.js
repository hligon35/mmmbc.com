const crypto = require('crypto');

const PREFIX = 'enc:v1';

function getKey() {
  const raw = String(process.env.ADMIN_CRYPTO_KEY || process.env.APP_CRYPTO_KEY || '').trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function maybeEncrypt(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (!text || text.startsWith(`${PREFIX}:`)) return text;

  const key = getKey();
  if (!key) return text;

  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  } catch {
    return text;
  }
}

function maybeDecrypt(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (!text.startsWith(`${PREFIX}:`)) return text;

  const key = getKey();
  if (!key) return text;

  const parts = text.split(':');
  if (parts.length !== 6) return text;

  try {
    const iv = Buffer.from(parts[3], 'base64');
    const tag = Buffer.from(parts[4], 'base64');
    const encrypted = Buffer.from(parts[5], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return text;
  }
}

module.exports = {
  maybeEncrypt,
  maybeDecrypt
};
