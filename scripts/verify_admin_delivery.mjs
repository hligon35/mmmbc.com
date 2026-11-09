import fs from 'node:fs/promises';
import { verifyAdminDelivery } from './admin-delivery.mjs';

const root = new URL('../', import.meta.url);
const manifest = await verifyAdminDelivery(
  url => fs.readFile(new URL('admin/public/' + url.slice('/admin/'.length), root), 'utf8'),
  url => fs.readFile(new URL('cf_site' + url, root), 'utf8')
);
console.log(`Verified mailbox workspace deployment: ${manifest.fingerprint.slice(0, 14)}`);
