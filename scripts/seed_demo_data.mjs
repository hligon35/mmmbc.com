#!/usr/bin/env node

/*
 * Populate a safe, repeatable MMMBC demo dataset.
 *
 * This command has two jobs:
 *   1. apply synthetic rows to the admin/site D1 databases and CMS fields;
 *   2. optionally submit synthetic records through the real public form APIs.
 *
 * Every generated id starts with demo- and every email uses example.com. The
 * remote target is blocked unless MMBC_ALLOW_REMOTE_DEMO_SEED=1 is set. Form
 * submission is intended for local or preview only.
 *
 * Examples:
 *   node scripts/seed_demo_data.mjs --target preview --apply \
 *     --replace-page-content --submit-forms --write-static
 *   node scripts/seed_demo_data.mjs --target local --apply --submit-forms \
 *     --base-url http://127.0.0.1:8787
 *   node scripts/seed_demo_data.mjs --target preview --apply \
 *     --replace-page-content --submit-forms --upload-r2
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { INITIAL_PUBLISHED_CONTENT, PAGE_KEYS } from '../src/site-editor-schema.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_COUNT = 10;
const DEMO_EMAIL_DOMAIN = 'example.com';
const PROFILE_PAGES = [
  'leadership',
  'associate_ministers',
  'deacons',
  'deaconesses',
  'official_team_trustees',
  'ministries'
];
const PROFILE_IMAGE_POOL = [
  '/ConImg/webPages/leadership_staff_image1.jpeg',
  '/ConImg/webPages/leadership_staff_image2.png',
  '/ConImg/webPages/leadership_staff_image3.jpeg',
  '/ConImg/webPages/deacons_image2.jpeg',
  '/ConImg/webPages/deacons_image3.jpeg',
  '/ConImg/webPages/deaconesses_image3.png',
  '/ConImg/webPages/official_team_image3.png',
  '/ConImg/webPages/official_team_image4.png',
  '/ConImg/webPages/ministries_image1.png',
  '/ConImg/webPages/ministries_image2.jpeg'
];

const TARGETS = {
  local: {
    adminDb: 'admin',
    siteDb: 'site',
    bucket: 'mmmbc-preview',
    wranglerEnv: null,
    remote: false,
    baseUrl: 'http://127.0.0.1:8787'
  },
  preview: {
    adminDb: 'admin-preview',
    siteDb: 'site-preview',
    bucket: 'mmmbc-preview',
    wranglerEnv: 'preview',
    remote: true,
    baseUrl: 'https://mmmbc-preview.hligon.workers.dev'
  },
  remote: {
    adminDb: 'admin',
    siteDb: 'site',
    bucket: 'mmmbc',
    wranglerEnv: 'production',
    remote: true,
    baseUrl: 'https://mmmbc.alphazonelabs.com'
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isoAt(asOf, dayOffset = 0, hourOffset = 0) {
  const date = new Date(asOf);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  date.setUTCHours(date.getUTCHours() + hourOffset);
  return date.toISOString();
}

function dateAt(asOf, dayOffset = 0) {
  return isoAt(asOf, dayOffset).slice(0, 10);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function demoId(kind, index) {
  return `demo-${kind}-${pad(index)}`;
}

function demoEmail(kind, index) {
  return `demo-${kind}-${pad(index)}@${DEMO_EMAIL_DOMAIN}`;
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlInsert(table, columns, rows, { replace = true } = {}) {
  if (!rows.length) return '';
  const verb = replace ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
  const values = rows.map((row) => `  (${columns.map((column) => sqlValue(row[column])).join(', ')})`).join(',\n');
  return `${verb} INTO ${table} (${columns.join(', ')})\nVALUES\n${values};\n`;
}

function profileGroup(index) {
  return ['staff', 'deacons', 'deaconesses', 'official_team'][index % 4];
}

function demoProfile(page, index) {
  const image = page === 'leadership' && index === 1
    ? { url: '/cdn/gallery/site/pastorHarvey.jpeg', alt: 'Rev. Stephen Harvey' }
    : { url: PROFILE_IMAGE_POOL[(index - 1) % PROFILE_IMAGE_POOL.length], alt: `Demo ${page} profile ${pad(index)}` };
  const profile = {
    id: demoId(`profile-${page}`, index),
    name: `Demo ${page.replaceAll('_', ' ')} Profile ${pad(index)}`,
    title: `Demo ${page.replaceAll('_', ' ')} role ${pad(index)}`,
    bio: `Synthetic demo profile ${pad(index)} for the ${page.replaceAll('_', ' ')} page. This record is safe sample content for demonstrating the editor and public profile layout.`,
    image
  };
  if (page === 'leadership') profile.group = profileGroup(index - 1);
  return profile;
}

function demoSchedule(kind, index) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day = days[(index + (kind === 'ministry' ? 2 : 0)) % days.length];
  const hour = kind === 'ministry' ? 17 + (index % 3) : 9 + (index % 4);
  return {
    id: demoId(`${kind}-schedule`, index),
    day,
    time: `${pad(hour)}:${index % 2 ? '30' : '00'}`,
    title: `Demo ${kind === 'ministry' ? 'Ministry' : 'Worship'} Activity ${pad(index)}`,
    details: `Synthetic schedule entry ${pad(index)} for editor and public-site demonstrations.`,
    sortOrder: 10 + index
  };
}

function buildPageFields(count) {
  const pages = {};
  for (const page of PAGE_KEYS) pages[page] = clone(INITIAL_PUBLISHED_CONTENT[page] || {});
  pages.home['worship.schedule'] = [
    ...(pages.home['worship.schedule'] || []),
    ...Array.from({ length: count }, (_, i) => demoSchedule('worship', i + 1))
  ];
  pages.home['ministries.weeklySchedule'] = [
    ...(pages.home['ministries.weeklySchedule'] || []),
    ...Array.from({ length: count }, (_, i) => demoSchedule('ministry', i + 1))
  ];
  for (const page of PROFILE_PAGES) {
    pages[page].profiles = [
      ...(Array.isArray(pages[page].profiles) ? pages[page].profiles : []),
      ...Array.from({ length: count }, (_, i) => demoProfile(page, i + 1))
    ];
  }
  return pages;
}

function buildData({ count = DEFAULT_COUNT, asOf = new Date().toISOString() } = {}) {
  const contacts = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      id: demoId('contact', n),
      first_name: 'Demo', middle_name: n % 2 ? 'A.' : null, last_name: `Member${pad(n)}`,
      preferred_name: `Demo Member ${pad(n)}`, suffix: null,
      contact_type: n % 3 === 0 ? 'visitor' : 'member',
      membership_status: n % 3 === 0 ? 'prospect' : 'active', status: 'active',
      primary_email: demoEmail('contact', n), secondary_email: null,
      mobile_phone: `(270) 555-${String(1000 + n).slice(-4)}`, home_phone: null,
      preferred_contact_method: n % 2 ? 'email' : 'phone',
      address_line_1: `${100 + n} Demo Faith Avenue`, address_line_2: null,
      city: 'Paducah', state: 'KY', postal_code: '42003',
      birth_month: (n % 12) + 1, birth_day: (n % 27) + 1,
      anniversary_month: n % 2 ? (n % 12) + 1 : null, anniversary_day: n % 2 ? (n % 27) + 1 : null,
      member_since: n % 3 === 0 ? null : `${2015 + (n % 10)}-01-11`,
      notes: `Synthetic demo directory record ${pad(n)}.`,
      created_by: 'demo-seed', updated_by: 'demo-seed',
      created_at: isoAt(asOf, -120 + n), updated_at: isoAt(asOf, -n), archived_at: null,
      account_number: `MM-DEMO${pad(n)}`, normalized_primary_phone: `270555${String(1000 + n).slice(-4)}`,
      normalized_home_phone: null
    };
  });

  const announcements = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return { id: demoId('announcement', n), title: `Demo Announcement ${pad(n)}`, body: `Synthetic announcement ${pad(n)} for the admin dashboard and public ticker.`, created_at: isoAt(asOf, -n), expires_at: isoAt(asOf, 30 + n) };
  });
  const events = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return { id: demoId('event', n), title: `Demo Event ${pad(n)}`, event_date: dateAt(asOf, n), event_time: `${pad(9 + (n % 8))}:${n % 2 ? '30' : '00'}`, created_at: isoAt(asOf, -n), updated_at: isoAt(asOf, -n) };
  });
  const gallery = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return { id: demoId('gallery', n), album: 'Demo Gallery', label: `Demo Gallery Image ${pad(n)}`, tags_json: JSON.stringify(['demo', 'sample']), file_key: `site/demo/gallery-${pad(n)}.jpeg`, thumb_key: `site/demo/gallery-${pad(n)}.jpeg`, original_name: `demo-gallery-${pad(n)}.jpeg`, created_at: isoAt(asOf, -n), position: n, is_hidden: 0 };
  });
  const bulletins = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return { id: demoId('bulletin', n), title: `Demo Bulletin ${pad(n)}`, file_key: `site/demo/bulletin-${pad(n)}.pdf`, original_name: `demo-bulletin-${pad(n)}.pdf`, starts_at: isoAt(asOf, -2), ends_at: isoAt(asOf, 30 + n), created_at: isoAt(asOf, -n) };
  });
  const documents = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return { id: demoId('document', n), title: `Demo Document ${pad(n)}`, description: `Synthetic document ${pad(n)} for the static documents view.`, file: `/cdn/gallery/site/demo/bulletin-${pad(n)}.pdf`, originalName: `demo-document-${pad(n)}.pdf`, createdAt: isoAt(asOf, -n) };
  });
  const newsletterRecords = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const statuses = ['draft', 'scheduled', 'sent', 'failed', 'retrying'];
    const status = statuses[(n - 1) % statuses.length];
    return { id: demoId('newsletter-record', n), subject: `Demo Newsletter ${pad(n)}`, message: `Synthetic newsletter body ${pad(n)}.`, emails: JSON.stringify([demoEmail('subscriber', n)]), status, sent_count: status === 'sent' ? n : 0, schedule_at: status === 'scheduled' ? isoAt(asOf, 2 + n) : null, schedule_date: status === 'scheduled' ? dateAt(asOf, 2 + n) : null, schedule_time: status === 'scheduled' ? '09:00' : null, schedule_timezone: 'America/Chicago', retry_count: status === 'retrying' ? 1 : 0, error: status === 'failed' ? 'Synthetic demo delivery failure.' : null, created_at: isoAt(asOf, -n), updated_at: isoAt(asOf, -n), sent_at: status === 'sent' ? isoAt(asOf, -1) : null };
  });
  const groups = Array.from({ length: count }, (_, i) => ({ id: demoId('group', i + 1), name: `Demo Ministry Group ${pad(i + 1)}`, category: 'ministry', description: `Synthetic group ${pad(i + 1)}.`, status: 'active', created_at: isoAt(asOf, -60 + i), updated_at: isoAt(asOf, -i) }));
  const lists = Array.from({ length: count }, (_, i) => ({ id: demoId('list', i + 1), name: `Demo Newsletter List ${pad(i + 1)}`, description: `Synthetic list ${pad(i + 1)}.`, status: 'active', created_at: isoAt(asOf, -60 + i), updated_at: isoAt(asOf, -i) }));
  const newsletterSubscribers = contacts.map((contact, i) => ({ id: demoId('newsletter-subscriber', i + 1), contact_id: contact.id, email: demoEmail('subscriber', i + 1), status: i % 4 === 0 ? 'pending' : 'active', consent_source: 'demo_seed', consent_date: dateAt(asOf, -30 - i), confirmed_at: i % 4 === 0 ? null : isoAt(asOf, -30 - i), unsubscribed_at: null, suppression_reason: null, last_emailed_at: i % 3 === 0 ? isoAt(asOf, -7) : null, created_at: isoAt(asOf, -30 - i), updated_at: isoAt(asOf, -i) }));
  const groupMembers = contacts.map((contact, i) => ({ id: demoId('group-member', i + 1), group_id: groups[i % groups.length].id, contact_id: contact.id, role: i % 2 ? 'Volunteer' : 'Coordinator', joined_at: dateAt(asOf, -30 - i), ended_at: null, notes: 'Synthetic demo assignment.' }));
  const listMembers = newsletterSubscribers.map((subscriber, i) => ({ id: demoId('list-member', i + 1), list_id: lists[i % lists.length].id, subscriber_id: subscriber.id, added_at: isoAt(asOf, -30 - i), removed_at: null }));
  const activity = contacts.map((contact, i) => ({ id: demoId('activity', i + 1), actor_email: 'demo-seed@example.com', event_type: i % 3 === 0 ? 'visitor_check_in' : 'contact_updated', entity_type: 'contact', entity_id: contact.id, summary: `Demo directory activity ${pad(i + 1)}`, metadata_json: JSON.stringify({ synthetic: true, visitNumber: i % 3 === 0 ? (i % 5) + 1 : 0 }), created_at: isoAt(asOf, -i) }));

  const funds = Array.from({ length: count }, (_, i) => ({ id: demoId('fund', i + 1), fund_name: `Demo Fund ${pad(i + 1)}`, fund_code: `DEMO${pad(i + 1)}`, active: 1, created_at: isoAt(asOf, -365 + i), updated_at: isoAt(asOf, -i) }));
  const financeEntries = Array.from({ length: count }, (_, i) => ({ id: demoId('finance-entry', i + 1), entry_date: dateAt(asOf, -i), type: i % 3 === 0 ? 'expense' : 'income', category: i % 3 === 0 ? 'Demo Expense' : 'Demo Offering', fund: funds[i % funds.length].fund_name, method: i % 2 ? 'Online' : 'Check', party: `Demo Party ${pad(i + 1)}`, memo: `Synthetic ledger entry ${pad(i + 1)}.`, amount_cents: 1000 + (i * 375), created_at: isoAt(asOf, -i), updated_at: isoAt(asOf, -i) }));
  const donors = contacts.map((contact, i) => ({ id: demoId('donor', i + 1), first_name: contact.first_name, middle_name: contact.middle_name, last_name: contact.last_name, preferred_name: contact.preferred_name, household_id: null, mailing_address: `${contact.address_line_1}, ${contact.city}, ${contact.state} ${contact.postal_code}`, email: contact.primary_email, phone: contact.mobile_phone, statement_delivery: i % 2 ? 'email' : 'mail', active: 1, statement_eligible: 1, directory_contact_id: contact.id, account_number: contact.account_number, donor_kind: contact.contact_type === 'visitor' ? 'one_time' : 'member', merged_into_donor_id: null, envelope_number: `D${pad(i + 1)}`, envelope_code: `MM-DEMO-ENV-${pad(i + 1)}`, envelope_code_status: 'active', envelope_code_issued_at: isoAt(asOf, -365), envelope_code_updated_at: isoAt(asOf, -i), created_at: isoAt(asOf, -365), updated_at: isoAt(asOf, -i) }));
  const envelopeCodes = donors.map((donor, i) => ({ id: demoId('envelope-code', i + 1), donor_id: donor.id, envelope_code: donor.envelope_code, envelope_number_snapshot: donor.envelope_number, status: 'active', issued_at: isoAt(asOf, -365), updated_at: isoAt(asOf, -i), replaced_by_code: null, note: 'Synthetic demo envelope code.' }));
  const scanCodes = donors.map((donor, i) => ({ id: demoId('scan-code', i + 1), code_value: donor.envelope_code, code_family: 'member_envelope', donor_id: donor.id, status: 'active', issued_at: isoAt(asOf, -365), updated_at: isoAt(asOf, -i), replaced_by_code_value: null, note: 'Synthetic demo scan code.', created_by: 'demo-seed' }));
  const batches = Array.from({ length: count }, (_, i) => ({ id: demoId('collection-batch', i + 1), service_date: dateAt(asOf, -i), service_name: 'Demo Sunday Worship', status: i % 4 === 0 ? 'finalized' : 'draft', declared_physical_cash_cents: 5000 + i * 100, declared_check_cents: 2500 + i * 50, calculated_envelope_total_cents: 7000 + i * 100, calculated_loose_cash_total_cents: 500 + i * 10, calculated_batch_total_cents: 7500 + i * 110, discrepancy_cents: 0, discrepancy_explanation: null, count_sheet_attachment_ref: null, created_by: 'demo-seed@example.com', created_at: isoAt(asOf, -i), updated_at: isoAt(asOf, -i), finalized_at: i % 4 === 0 ? isoAt(asOf, -i) : null, voided_at: null, voided_by: null, void_reason: null, deposit_date: i % 4 === 0 ? dateAt(asOf, 1 - i) : null, deposit_reference: i % 4 === 0 ? `DEMO-DEP-${pad(i + 1)}` : null, deposited_amount_cents: i % 4 === 0 ? 7500 + i * 110 : null, deposit_confirmed_at: i % 4 === 0 ? isoAt(asOf, 1 - i) : null, deposit_verified_by: i % 4 === 0 ? 'demo-seed@example.com' : null, deposit_internal_control_exception: null, approval_version: i % 4 === 0 ? 1 : 0 }));
  const counters = batches.map((batch, i) => ({ id: demoId('counter', i + 1), batch_id: batch.id, counter_email: demoEmail('counter', i + 1), assigned_by: 'demo-seed@example.com', assigned_at: isoAt(asOf, -i) }));
  const approvals = batches.map((batch, i) => ({ id: demoId('counter-approval', i + 1), batch_id: batch.id, counter_email: demoEmail('counter', i + 1), approved_by: 'demo-seed@example.com', approved_at: isoAt(asOf, -i), batch_version: 1 }));
  const envelopes = batches.map((batch, i) => ({ id: demoId('collection-envelope', i + 1), batch_id: batch.id, donor_id: donors[i % donors.length].id, envelope_code_snapshot: donors[i % donors.length].envelope_code, envelope_number_snapshot: donors[i % donors.length].envelope_number, transaction_kind: 'registered_envelope', payment_method: 'check', check_number: `DEMO${pad(i + 1)}`, envelope_total_cents: 1000 + i * 100, entry_status: 'active', created_by: 'demo-seed@example.com', updated_by: 'demo-seed@example.com', created_at: isoAt(asOf, -i), updated_at: isoAt(asOf, -i) }));
  const allocations = envelopes.map((entry, i) => ({ id: demoId('allocation', i + 1), envelope_entry_id: entry.id, fund_id: funds[i % funds.length].id, fund_code: funds[i % funds.length].fund_code, amount_cents: entry.envelope_total_cents, note: 'Synthetic allocation.', created_at: isoAt(asOf, -i), updated_at: isoAt(asOf, -i) }));
  const looseGiving = batches.map((batch, i) => ({ id: demoId('loose-giving', i + 1), batch_id: batch.id, fund_id: funds[i % funds.length].id, fund_code: funds[i % funds.length].fund_code, payment_method: 'cash', amount_cents: 500 + i * 20, note: 'Synthetic loose giving.', created_by: 'demo-seed@example.com', created_at: isoAt(asOf, -i), updated_at: isoAt(asOf, -i) }));
  const financeAudit = batches.map((batch, i) => ({ id: demoId('finance-audit', i + 1), batch_id: batch.id, donor_id: donors[i % donors.length].id, envelope_entry_id: envelopes[i].id, event_type: 'collection', event_action: 'created', actor_email: 'demo-seed@example.com', reason: 'Demo seed', metadata_json: JSON.stringify({ synthetic: true }), created_at: isoAt(asOf, -i) }));

  const givingDonations = Array.from({ length: count }, (_, i) => ({ id: demoId('giving-donation', i + 1), stripe_event_id: demoId('stripe-event-donation', i + 1), stripe_checkout_session_id: demoId('checkout-session', i + 1), stripe_payment_intent_id: demoId('payment-intent', i + 1), stripe_subscription_id: null, stripe_connected_account_id: null, donor_name: `Demo Donor ${pad(i + 1)}`, donor_email: demoEmail('donor', i + 1), fund_code: funds[i % funds.length].fund_code, frequency: 'one_time', amount_cents: 2500 + i * 250, platform_fee_cents: 0, currency: 'usd', payment_status: 'paid', payment_method_type: 'card', note: 'Synthetic demo donation.', created_at: isoAt(asOf, -i), paid_at: isoAt(asOf, -i), updated_at: isoAt(asOf, -i) }));
  const givingSubscriptions = Array.from({ length: count }, (_, i) => ({ stripe_subscription_id: demoId('subscription', i + 1), stripe_connected_account_id: null, stripe_customer_id: demoId('customer', i + 1), donor_name: `Demo Subscriber ${pad(i + 1)}`, donor_email: demoEmail('giving-subscription', i + 1), fund_code: funds[i % funds.length].fund_code, amount_cents: 1000 + i * 100, platform_fee_percent: 2.5, currency: 'usd', status: i % 4 === 0 ? 'past_due' : 'active', cancel_at_period_end: 0, current_period_start: isoAt(asOf, -30), current_period_end: isoAt(asOf, 30), canceled_at: null, ended_at: null, created_at: isoAt(asOf, -60), updated_at: isoAt(asOf, -i) }));
  const subscriptionPayments = givingSubscriptions.map((subscription, i) => ({ id: demoId('subscription-payment', i + 1), stripe_event_id: demoId('stripe-event-payment', i + 1), stripe_invoice_id: demoId('invoice', i + 1), stripe_subscription_id: subscription.stripe_subscription_id, stripe_payment_intent_id: demoId('subscription-payment-intent', i + 1), stripe_connected_account_id: null, donor_name: subscription.donor_name, donor_email: subscription.donor_email, fund_code: subscription.fund_code, amount_due_cents: subscription.amount_cents, amount_paid_cents: i % 4 === 0 ? 0 : subscription.amount_cents, platform_fee_cents: 0, currency: 'usd', payment_status: i % 4 === 0 ? 'failed' : 'paid', billing_reason: 'subscription_cycle', period_start: isoAt(asOf, -30), period_end: isoAt(asOf, 0), paid_at: i % 4 === 0 ? null : isoAt(asOf, -i), failed_at: i % 4 === 0 ? isoAt(asOf, -i) : null, created_at: isoAt(asOf, -i), updated_at: isoAt(asOf, -i) }));
  const webhookEvents = Array.from({ length: count }, (_, i) => ({ stripe_event_id: demoId('stripe-webhook', i + 1), event_type: i % 2 ? 'invoice.paid' : 'checkout.session.completed', connected_account_id: null, processed_at: isoAt(asOf, -i) }));
  const adminUsers = Array.from({ length: count }, (_, i) => ({ id: demoId('admin-user', i + 1), email: demoEmail('admin', i + 1), full_name: `Demo Admin ${pad(i + 1)}`, role: ['website_editor', 'finance_entry', 'auditor'][i % 3], status: 'suspended', invited_by: 'demo-seed@example.com', invited_at: isoAt(asOf, -30 - i), activated_at: null, last_login_at: null, created_at: isoAt(asOf, -30 - i), updated_at: isoAt(asOf, -i) }));
  const adminInvites = Array.from({ length: count }, (_, i) => ({ id: demoId('admin-invite', i + 1), email: demoEmail('invite', i + 1), role: ['website_editor', 'finance_entry', 'auditor'][i % 3], status: 'revoked', invited_by: 'demo-seed@example.com', invited_at: isoAt(asOf, -30 - i), updated_at: isoAt(asOf, -i) }));
  const adminAudit = adminUsers.map((user, i) => ({ id: demoId('admin-audit', i + 1), actor_user_id: null, actor_email: 'demo-seed@example.com', action: 'demo.user.created', target_user_id: user.id, target_email: user.email, previous_value_json: null, new_value_json: JSON.stringify({ synthetic: true, status: user.status }), created_at: isoAt(asOf, -i) }));
  const siteSubscribers = Array.from({ length: count }, (_, i) => ({ id: demoId('site-subscriber', i + 1), email: demoEmail('form-subscriber', i + 1), name: `Demo Newsletter Subscriber ${pad(i + 1)}`, status: 'active', created_at: isoAt(asOf, -i) }));

  return {
    asOf, count,
    pages: buildPageFields(count),
    admin: { announcements, events, gallery, bulletins, newsletterRecords, contacts, groups, groupMembers, newsletterSubscribers, lists, listMembers, activity, funds, financeEntries, donors, envelopeCodes, scanCodes, batches, counters, approvals, envelopes, allocations, looseGiving, financeAudit, givingDonations, givingSubscriptions, subscriptionPayments, webhookEvents, adminUsers, adminInvites, adminAudit },
    site: { subscribers: siteSubscribers },
    static: { announcements, events, gallery, bulletins, documents, newsletterSubscribers, pages: buildPageFields(count) },
    r2: [
      { key: 'site/pastorHarvey.jpeg', source: 'pastorHarvey.jpeg', contentType: 'image/jpeg' },
      ...gallery.map((item) => ({ key: item.file_key, source: 'pastorHarvey.jpeg', contentType: 'image/jpeg' })),
      ...bulletins.map((item) => ({ key: item.file_key, source: 'scripts/fixtures/demo-bulletin.pdf', contentType: 'application/pdf' }))
    ]
  };
}

const ADMIN_EXTRA_SCHEMA = `
CREATE TABLE IF NOT EXISTS finance_funds (id TEXT PRIMARY KEY, fund_name TEXT NOT NULL UNIQUE, fund_code TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS finance_meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, title TEXT NOT NULL, event_date TEXT NOT NULL, event_time TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT);
CREATE TABLE IF NOT EXISTS bulletins (id TEXT PRIMARY KEY, title TEXT NOT NULL, file_key TEXT NOT NULL, original_name TEXT, starts_at TEXT, ends_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS finance_entries (id TEXT PRIMARY KEY, entry_date TEXT NOT NULL, type TEXT NOT NULL, category TEXT, fund TEXT, method TEXT, party TEXT, memo TEXT, amount_cents INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, section TEXT NOT NULL, name TEXT NOT NULL, title TEXT, bio TEXT, image_key TEXT, position INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS newsletter_records (id TEXT PRIMARY KEY, subject TEXT NOT NULL, message TEXT NOT NULL, emails TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, sent_count INTEGER NOT NULL DEFAULT 0, schedule_at TEXT, schedule_date TEXT, schedule_time TEXT, schedule_timezone TEXT, retry_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT);
CREATE TABLE IF NOT EXISTS admin_invites (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'website_editor', status TEXT NOT NULL DEFAULT 'invited', invited_by TEXT, invited_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_users (id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE, full_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'website_editor', status TEXT NOT NULL DEFAULT 'pending', invited_by TEXT, invited_at TEXT NOT NULL, activated_at TEXT, last_login_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_audit_log (id TEXT PRIMARY KEY, actor_user_id TEXT, actor_email TEXT NOT NULL, action TEXT NOT NULL, target_user_id TEXT, target_email TEXT, previous_value_json TEXT, new_value_json TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS site_page_content (page TEXT PRIMARY KEY, draft_fields TEXT NOT NULL DEFAULT '{}', draft_version INTEGER NOT NULL DEFAULT 0, draft_updated_at TEXT, draft_updated_by TEXT, published_fields TEXT NOT NULL DEFAULT '{}', published_version INTEGER NOT NULL DEFAULT 0, published_updated_at TEXT, published_updated_by TEXT, previous_published_fields TEXT, previous_published_version INTEGER, previous_published_updated_at TEXT, created_at TEXT NOT NULL);
`;

const SITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS subscribers (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contact_messages (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, address TEXT, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received', email_error TEXT, created_at TEXT NOT NULL, subject TEXT NOT NULL DEFAULT 'General Website Inquiry', read_at TEXT, archived_at TEXT, auto_reply_status TEXT NOT NULL DEFAULT 'pending', auto_reply_at TEXT, auto_reply_error TEXT);
CREATE TABLE IF NOT EXISTS facility_rental_requests (id TEXT PRIMARY KEY, audience TEXT NOT NULL DEFAULT 'member', person_responsible TEXT NOT NULL, phone TEXT NOT NULL, purpose TEXT NOT NULL, date_of_use TEXT NOT NULL, time_from TEXT NOT NULL, time_to TEXT NOT NULL, contact_email TEXT, form_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'received', email_error TEXT, created_at TEXT NOT NULL, read_at TEXT, archived_at TEXT, auto_reply_status TEXT NOT NULL DEFAULT 'pending', auto_reply_at TEXT, auto_reply_error TEXT);
CREATE TABLE IF NOT EXISTS form_rate_limits (id INTEGER PRIMARY KEY AUTOINCREMENT, rate_key TEXT NOT NULL, created_at TEXT NOT NULL);
`;

function buildPageRows(data, replacePageContent) {
  const rows = Object.entries(data.pages).map(([page, fields]) => ({
    page,
    draft_fields: JSON.stringify(fields), draft_version: 1, draft_updated_at: data.asOf, draft_updated_by: 'demo-seed',
    published_fields: JSON.stringify(fields), published_version: 1, published_updated_at: data.asOf, published_updated_by: 'demo-seed',
    previous_published_fields: null, previous_published_version: null, previous_published_updated_at: null, created_at: data.asOf
  }));
  return sqlInsert('site_page_content', ['page', 'draft_fields', 'draft_version', 'draft_updated_at', 'draft_updated_by', 'published_fields', 'published_version', 'published_updated_at', 'published_updated_by', 'previous_published_fields', 'previous_published_version', 'previous_published_updated_at', 'created_at'], rows, { replace: replacePageContent });
}

function buildAdminSql(data, { replacePageContent = true, clean = false } = {}) {
  const a = data.admin;
  const profileRows = PROFILE_PAGES.flatMap((page) => (data.pages[page]?.profiles || []).filter((p) => String(p.id).startsWith('demo-')).map((p, index) => ({ id: p.id, section: page, name: p.name, title: p.title, bio: p.bio, image_key: p.image?.url || '', position: index + 1, created_at: data.asOf, updated_at: data.asOf })));
  const statements = [ADMIN_EXTRA_SCHEMA, fs.readFileSync(path.join(ROOT, 'cf/schema.sql'), 'utf8')];
  if (clean) {
    for (const table of ['announcements', 'events', 'gallery_items', 'bulletins', 'finance_entries', 'profiles', 'newsletter_records', 'directory_contacts', 'directory_groups', 'directory_group_members', 'newsletter_subscribers', 'newsletter_lists', 'newsletter_list_members', 'directory_activity_log', 'finance_funds', 'finance_entries', 'finance_donors', 'finance_donor_envelope_codes', 'finance_scan_codes', 'finance_collection_batches', 'finance_collection_counters', 'finance_collection_counter_approvals', 'finance_collection_envelopes', 'finance_collection_allocations', 'finance_collection_loose_giving', 'finance_collection_audit_events', 'giving_donations', 'giving_subscriptions', 'giving_subscription_payments', 'stripe_webhook_events', 'admin_users', 'admin_invites', 'admin_audit_log']) statements.push(`DELETE FROM ${table} WHERE id LIKE 'demo-%' OR ${table === 'giving_subscriptions' ? "stripe_subscription_id LIKE 'demo-%'" : table === 'stripe_webhook_events' ? "stripe_event_id LIKE 'demo-%'" : '0=1'};`);
    return `${statements.join('\n')}\n`;
  }
  statements.push(sqlInsert('announcements', ['id', 'title', 'body', 'created_at', 'expires_at'], a.announcements));
  statements.push(sqlInsert('events', ['id', 'title', 'event_date', 'event_time', 'created_at', 'updated_at'], a.events));
  statements.push(sqlInsert('gallery_items', ['id', 'album', 'label', 'tags_json', 'file_key', 'thumb_key', 'original_name', 'created_at', 'position', 'is_hidden'], a.gallery));
  statements.push(sqlInsert('bulletins', ['id', 'title', 'file_key', 'original_name', 'starts_at', 'ends_at', 'created_at'], a.bulletins));
  statements.push(sqlInsert('finance_entries', ['id', 'entry_date', 'type', 'category', 'fund', 'method', 'party', 'memo', 'amount_cents', 'created_at', 'updated_at'], a.financeEntries));
  statements.push(sqlInsert('profiles', ['id', 'section', 'name', 'title', 'bio', 'image_key', 'position', 'created_at', 'updated_at'], profileRows));
  statements.push(sqlInsert('newsletter_records', ['id', 'subject', 'message', 'emails', 'status', 'sent_count', 'schedule_at', 'schedule_date', 'schedule_time', 'schedule_timezone', 'retry_count', 'error', 'created_at', 'updated_at', 'sent_at'], a.newsletterRecords));
  statements.push(sqlInsert('directory_contacts', Object.keys(a.contacts[0]), a.contacts));
  statements.push(sqlInsert('directory_groups', Object.keys(a.groups[0]), a.groups));
  statements.push(sqlInsert('directory_group_members', Object.keys(a.groupMembers[0]), a.groupMembers));
  statements.push(sqlInsert('newsletter_subscribers', Object.keys(a.newsletterSubscribers[0]), a.newsletterSubscribers));
  statements.push(sqlInsert('newsletter_lists', Object.keys(a.lists[0]), a.lists));
  statements.push(sqlInsert('newsletter_list_members', Object.keys(a.listMembers[0]), a.listMembers));
  statements.push(sqlInsert('directory_activity_log', Object.keys(a.activity[0]), a.activity));
  statements.push(sqlInsert('finance_funds', Object.keys(a.funds[0]), a.funds));
  statements.push("INSERT OR REPLACE INTO finance_meta (key, value_json, updated_at) VALUES ('demo-seed', ?, ?);".replace('?', sqlValue(JSON.stringify({ synthetic: true, count: data.count }))).replace('?', sqlValue(data.asOf)));
  statements.push(sqlInsert('finance_donors', Object.keys(a.donors[0]), a.donors));
  statements.push(sqlInsert('finance_donor_envelope_codes', Object.keys(a.envelopeCodes[0]), a.envelopeCodes));
  statements.push(sqlInsert('finance_scan_codes', Object.keys(a.scanCodes[0]), a.scanCodes));
  statements.push(sqlInsert('finance_collection_batches', Object.keys(a.batches[0]), a.batches));
  statements.push(sqlInsert('finance_collection_counters', Object.keys(a.counters[0]), a.counters));
  statements.push(sqlInsert('finance_collection_counter_approvals', Object.keys(a.approvals[0]), a.approvals));
  statements.push(sqlInsert('finance_collection_envelopes', Object.keys(a.envelopes[0]), a.envelopes));
  statements.push(sqlInsert('finance_collection_allocations', Object.keys(a.allocations[0]), a.allocations));
  statements.push(sqlInsert('finance_collection_loose_giving', Object.keys(a.looseGiving[0]), a.looseGiving));
  statements.push(sqlInsert('finance_collection_audit_events', Object.keys(a.financeAudit[0]), a.financeAudit));
  statements.push(sqlInsert('giving_donations', Object.keys(a.givingDonations[0]), a.givingDonations));
  statements.push(sqlInsert('giving_subscriptions', Object.keys(a.givingSubscriptions[0]), a.givingSubscriptions));
  statements.push(sqlInsert('giving_subscription_payments', Object.keys(a.subscriptionPayments[0]), a.subscriptionPayments));
  statements.push(sqlInsert('stripe_webhook_events', Object.keys(a.webhookEvents[0]), a.webhookEvents));
  statements.push(sqlInsert('admin_users', Object.keys(a.adminUsers[0]), a.adminUsers));
  statements.push(sqlInsert('admin_invites', Object.keys(a.adminInvites[0]), a.adminInvites));
  statements.push(sqlInsert('admin_audit_log', Object.keys(a.adminAudit[0]), a.adminAudit));
  statements.push(buildPageRows(data, replacePageContent));
  return `${statements.join('\n')}\n`;
}

function buildSiteSql(data, { includeSubmissionFallback = false, clean = false } = {}) {
  const statements = [SITE_SCHEMA];
  if (clean) {
    statements.push("DELETE FROM subscribers WHERE id LIKE 'demo-%'; DELETE FROM contact_messages WHERE id LIKE 'demo-%'; DELETE FROM facility_rental_requests WHERE id LIKE 'demo-%';");
    return `${statements.join('\n')}\n`;
  }
  statements.push(sqlInsert('subscribers', ['id', 'email', 'name', 'status', 'created_at'], data.site.subscribers));
  if (includeSubmissionFallback) {
    const contacts = Array.from({ length: data.count }, (_, i) => ({ id: demoId('contact-message', i + 1), name: `Demo Contact ${pad(i + 1)}`, email: demoEmail('contact-form', i + 1), phone: `(270) 555-${String(2000 + i + 1).slice(-4)}`, address: `${200 + i} Demo Contact Street`, message: `Synthetic contact submission ${pad(i + 1)} created by the demo fallback.`, status: 'received', email_error: null, created_at: isoAt(data.asOf, -i), subject: `Demo Contact Subject ${pad(i + 1)}`, read_at: null, archived_at: null, auto_reply_status: 'skipped_demo', auto_reply_at: isoAt(data.asOf, -i), auto_reply_error: '' }));
    const rentals = Array.from({ length: data.count }, (_, i) => ({ id: demoId('facility-rental', i + 1), audience: i % 2 ? 'non_member' : 'member', person_responsible: `Demo Rental Contact ${pad(i + 1)}`, phone: `(270) 555-${String(3000 + i + 1).slice(-4)}`, purpose: `Synthetic facility rental request ${pad(i + 1)}`, date_of_use: dateAt(data.asOf, 14 + i), time_from: '10:00', time_to: '14:00', contact_email: demoEmail('rental-form', i + 1), form_json: JSON.stringify({ personResponsible: `Demo Rental Contact ${pad(i + 1)}`, purpose: `Synthetic facility rental request ${pad(i + 1)}`, synthetic: true }), status: 'received', email_error: null, created_at: isoAt(data.asOf, -i), read_at: null, archived_at: null, auto_reply_status: 'skipped_demo', auto_reply_at: isoAt(data.asOf, -i), auto_reply_error: '' }));
    statements.push(sqlInsert('contact_messages', Object.keys(contacts[0]), contacts));
    statements.push(sqlInsert('facility_rental_requests', Object.keys(rentals[0]), rentals));
  }
  return `${statements.join('\n')}\n`;
}

function buildStaticAssets(data) {
  const profileItems = PROFILE_PAGES.flatMap((page) => (data.pages[page]?.profiles || []).map((profile) => ({
    id: profile.id, page, section: profile.group || page, image: profile.image?.url || '', name: profile.name, title: profile.title || '', bio: profile.bio || '', alt: profile.image?.alt || profile.name
  })));
  return {
    'announcements.json': { posts: data.static.announcements.map((row) => ({ id: row.id, title: row.title, body: row.body, createdAt: row.created_at, expiresAt: row.expires_at })) },
    'schedule.json': data.static.events.map((row) => ({ id: row.id, title: row.title, date: row.event_date, time: row.event_time, createdAt: row.created_at, updatedAt: row.updated_at })),
    'gallery.json': { items: data.static.gallery.map((row) => ({ id: row.id, album: row.album, label: row.label, tags: JSON.parse(row.tags_json), file: `/cdn/gallery/${row.file_key}`, thumb: `/cdn/gallery/${row.thumb_key}`, originalName: row.original_name, createdAt: row.created_at, position: row.position })) },
    'bulletins.json': { bulletins: data.static.bulletins.map((row) => ({ id: row.id, title: row.title, originalName: row.original_name, url: `/cdn/gallery/${row.file_key}`, startsAt: row.starts_at, endsAt: row.ends_at, createdAt: row.created_at })) },
    'documents.json': { documents: data.static.documents },
    'livestream.json': { active: { platform: 'website', status: 'offline' }, embeds: { youtube: '', facebook: '', website: '' }, recurring: Array.from({ length: data.count }, (_, i) => ({ id: demoId('livestream', i + 1), title: `Demo Recurring Livestream ${pad(i + 1)}`, day: ['Sunday', 'Wednesday'][i % 2], time: i % 2 ? '18:30' : '11:00', platform: 'youtube', url: 'https://www.youtube.com/' })) },
    'site-settings.json': { subscribers: data.site.subscribers.map((row) => ({ email: row.email, name: row.name, group: 'demo' })) },
    'profiles.json': { profiles: profileItems, pageMeta: { ministries: { pageTitle: 'Ministries', introText: 'Demo ministry profiles for the public-site walkthrough.' }, leadership: { pageTitle: 'Leadership & Staff', staffHeading: 'Staff', deaconsHeading: 'Deacons', deaconessesHeading: 'Deaconesses', officialTeamHeading: 'Official Team & Trustees' }, nav: { ministriesLabel: 'Ministries', leadershipLabel: 'Leadership & Staff' } } }
  };
}

async function writeStaticAssets(data) {
  const assets = buildStaticAssets(data);
  for (const [name, value] of Object.entries(assets)) {
    await fsp.writeFile(path.join(ROOT, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
}

function wranglerCommand() {
  const local = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  if (fs.existsSync(local)) return { command: local, prefix: [] };
  return { command: 'npx', prefix: ['wrangler'] };
}

async function runWrangler(args) {
  const { command, prefix } = wranglerCommand();
  const result = await execFileAsync(command, [...prefix, ...args], { cwd: ROOT, maxBuffer: 20 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function targetArgs(target) {
  return target.remote ? ['--remote', '--env', target.wranglerEnv] : ['--local'];
}

async function applyD1(target, database, sql, label) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mmmbc-demo-'));
  const file = path.join(tempDir, `${label}.sql`);
  await fsp.writeFile(file, sql, 'utf8');
  try {
    await runWrangler(['d1', 'migrations', 'apply', database, ...targetArgs(target)]);
    await runWrangler(['d1', 'execute', database, ...targetArgs(target), '--file', file]);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function uploadR2(target, objects) {
  for (const object of objects) {
    const source = path.join(ROOT, object.source);
    if (!fs.existsSync(source)) throw new Error(`R2 source file not found: ${object.source}`);
    const args = ['r2', 'object', 'put', `${target.bucket}/${object.key}`, '--file', source, ...targetArgs(target)];
    await runWrangler(args);
  }
}

async function postJson(fetchImpl, baseUrl, pathname, body) {
  const response = await fetchImpl(new URL(pathname, `${baseUrl.replace(/\/$/, '')}/`).toString(), {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* report raw response below */ }
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${parsed?.error || text || 'request failed'}`);
  return parsed || {};
}

export async function submitDemoForms({ baseUrl, count = DEFAULT_COUNT, asOf = new Date().toISOString(), fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable; use Node 18+ or provide fetchImpl.');
  if (!baseUrl) throw new Error('--base-url is required when submitting forms.');
  const result = { newsletter: [], contact: [], facilityRental: [] };
  for (let i = 1; i <= count; i += 1) {
    result.newsletter.push(await postJson(fetchImpl, baseUrl, '/api/public/newsletter/subscribe', { email: demoEmail('form-subscriber', i), name: `Demo Form Subscriber ${pad(i)}` }));
  }
  for (let i = 1; i <= count; i += 1) {
    result.contact.push(await postJson(fetchImpl, baseUrl, '/api/public/contact-message', { name: `Demo Form Contact ${pad(i)}`, email: demoEmail('contact-form', i), phone: `(270) 555-${String(4000 + i).slice(-4)}`, address: `${300 + i} Demo Submission Way`, message: `Synthetic contact form submission ${pad(i)} created by seed_demo_data.mjs at ${asOf}.` }));
  }
  for (let i = 1; i <= count; i += 1) {
    result.facilityRental.push(await postJson(fetchImpl, baseUrl, '/api/public/facility-rental-request', { audience: i % 2 ? 'member' : 'non_member', form: { eventGroup: `Demo Rental Group ${pad(i)}`, firstName: 'Demo', lastName: `Renter${pad(i)}`, personResponsible: `Demo Renter${pad(i)}`, phone: `(270) 555-${String(5000 + i).slice(-4)}`, contactEmail: demoEmail('rental-form', i), addressLine1: `${200 + i} Demo Rental Way`, city: 'Paducah', state: 'KY', postalCode: '42003', purpose: `Synthetic facility rental request ${pad(i)}`, dateOfUse: dateAt(asOf, 14 + i), timeFrom: '10:00', timeTo: '14:00', facilities: ['Fellowship Hall'], responsibleSignature: `Demo Renter${pad(i)}`, responsibleSignatureDate: dateAt(asOf), synthetic: true } }));
  }
  return result;
}

function parseArgs(argv) {
  const options = { target: 'local', count: DEFAULT_COUNT, asOf: new Date().toISOString(), apply: false, submitForms: false, writeStatic: false, buildStatic: false, uploadR2: false, clean: false, replacePageContent: true, baseUrl: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--submit-forms') options.submitForms = true;
    else if (arg === '--write-static') options.writeStatic = true;
    else if (arg === '--build-static') options.buildStatic = true;
    else if (arg === '--upload-r2') options.uploadR2 = true;
    else if (arg === '--clean') options.clean = true;
    else if (arg === '--preserve-page-content') options.replacePageContent = false;
    else if (arg === '--replace-page-content') options.replacePageContent = true;
    else if (arg === '--target') options.target = String(argv[++i] || '').toLowerCase();
    else if (arg === '--count') options.count = Number(argv[++i]);
    else if (arg === '--as-of') options.asOf = String(argv[++i] || '');
    else if (arg === '--base-url') options.baseUrl = String(argv[++i] || '');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.count) || options.count < 10) throw new Error('--count must be an integer of at least 10.');
  if (!TARGETS[options.target]) throw new Error('--target must be local, preview, or remote.');
  if (!Number.isFinite(Date.parse(options.asOf))) throw new Error('--as-of must be a valid ISO date/time.');
  if (options.buildStatic) options.writeStatic = true;
  if (options.submitForms && !options.apply) throw new Error('--submit-forms requires --apply so the demo target is explicit.');
  return options;
}

function helpText() {
  return `Usage: node scripts/seed_demo_data.mjs [options]\n\n  --target local|preview|remote   D1/Worker target (default: local)\n  --count N                       entries per type; minimum 10\n  --as-of ISO                     stable timestamp for generated records\n  --apply                         apply generated SQL to both D1 databases\n  --submit-forms                  POST newsletter/contact/rental demo forms\n  --base-url URL                  public Worker URL for --submit-forms\n  --write-static                  write populated root JSON fallback assets\n  --build-static                  write JSON assets and run build:cf\n  --upload-r2                     upload pastorHarvey/gallery/bulletin demo files\n  --replace-page-content          write populated CMS draft/published fields (default)\n  --preserve-page-content         do not replace existing CMS page rows\n  --clean                         remove demo-* records from the target databases\n\nRemote production seeding additionally requires MMBC_ALLOW_REMOTE_DEMO_SEED=1.\nForm submission is blocked for the remote target.\n`;
}

export { buildData, buildAdminSql, buildSiteSql, buildStaticAssets, parseArgs };

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log(helpText()); return; }
  const target = TARGETS[options.target];
  if (options.target === 'remote' && process.env.MMBC_ALLOW_REMOTE_DEMO_SEED !== '1') {
    throw new Error('Remote production seeding is blocked. Set MMBC_ALLOW_REMOTE_DEMO_SEED=1 only after confirming the target.');
  }
  if (options.submitForms && options.target === 'remote') throw new Error('Form submission is blocked for the remote target to protect production email and visitor data.');
  const data = buildData({ count: options.count, asOf: new Date(options.asOf).toISOString() });
  const baseUrl = options.baseUrl || target.baseUrl;

  console.log(`Prepared ${options.count} synthetic entries per demo type for ${options.target}.`);
  console.log(`CMS profile fields: ${PROFILE_PAGES.map((page) => `${page}=${data.pages[page].profiles.length}`).join(', ')}`);
  console.log(`CMS schedules: worship=${data.pages.home['worship.schedule'].length}, ministries=${data.pages.home['ministries.weeklySchedule'].length}`);

  if (options.writeStatic) {
    await writeStaticAssets(data);
    console.log('Wrote populated static JSON fallback assets.');
  }
  if (options.buildStatic) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await execFileAsync(npm, ['run', 'build:cf'], { cwd: ROOT, maxBuffer: 20 * 1024 * 1024 });
    console.log('Built cf_site from the populated static assets.');
  }
  if (options.apply) {
    const adminSql = buildAdminSql(data, { replacePageContent: options.replacePageContent, clean: options.clean });
    const siteSql = buildSiteSql(data, { includeSubmissionFallback: !options.submitForms, clean: options.clean });
    await applyD1(target, target.adminDb, adminSql, 'admin-demo');
    await applyD1(target, target.siteDb, siteSql, 'site-demo');
    console.log(`Applied ${options.clean ? 'cleanup for' : 'demo data to'} admin and site D1 (${target.adminDb}, ${target.siteDb}).`);
  }
  if (options.uploadR2) {
    await uploadR2(target, data.r2);
    console.log(`Uploaded ${data.r2.length} demo objects to R2 bucket ${target.bucket}.`);
  }
  if (options.submitForms) {
    const submitted = await submitDemoForms({ baseUrl, count: options.count, asOf: data.asOf });
    console.log(`Submitted ${submitted.newsletter.length} newsletter, ${submitted.contact.length} contact, and ${submitted.facilityRental.length} facility-rental forms to ${baseUrl}.`);
  }
  if (!options.apply && !options.writeStatic && !options.uploadR2 && !options.submitForms) console.log(helpText());
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) main().catch((error) => { console.error(error?.stack || String(error)); process.exitCode = 1; });

