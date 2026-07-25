const STRIPE_API = 'https://api.stripe.com/v1';
const PLATFORM_FEE_RATE = 0.025;
const MIN_GIFT_CENTS = 100;
const MAX_GIFT_CENTS = 10000000;

const FUNDS = Object.freeze({
  tithe: 'Tithe',
  offering: 'Offering',
  general: 'General Donation',
  building: 'Building Fund',
  missions: 'Missions',
  other: 'Other'
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function normalizeText(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function normalizeEmail(value) {
  const email = normalizeText(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function normalizeFund(value) {
  const fund = normalizeText(value, 30).toLowerCase();
  return Object.prototype.hasOwnProperty.call(FUNDS, fund) ? fund : '';
}

function unixToIso(value) {
  const seconds = Number(value || 0);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function getBaseUrl(request, env) {
  const configured = normalizeText(env.PUBLIC_SITE_URL, 300).replace(/\/$/, '');
  if (configured) return configured;
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

async function stripeRequest(env, path, params, connectedAccountId = '') {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured.');

  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  if (connectedAccountId) headers['Stripe-Account'] = connectedAccountId;

  const response = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers,
    body: params.toString()
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Stripe request failed (${response.status}).`;
    throw new Error(message);
  }
  return data;
}

async function ensureGivingTables(env) {
  if (!env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS giving_donations (
      id TEXT PRIMARY KEY,
      stripe_event_id TEXT,
      stripe_checkout_session_id TEXT UNIQUE,
      stripe_payment_intent_id TEXT,
      stripe_subscription_id TEXT,
      stripe_connected_account_id TEXT,
      donor_name TEXT,
      donor_email TEXT,
      fund_code TEXT NOT NULL,
      frequency TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      platform_fee_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'usd',
      payment_status TEXT NOT NULL,
      payment_method_type TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      paid_at TEXT,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS giving_subscription_payments (
      id TEXT PRIMARY KEY,
      stripe_event_id TEXT,
      stripe_invoice_id TEXT UNIQUE NOT NULL,
      stripe_subscription_id TEXT,
      stripe_payment_intent_id TEXT,
      stripe_connected_account_id TEXT,
      donor_name TEXT,
      donor_email TEXT,
      fund_code TEXT NOT NULL,
      amount_due_cents INTEGER NOT NULL DEFAULT 0,
      amount_paid_cents INTEGER NOT NULL DEFAULT 0,
      platform_fee_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'usd',
      payment_status TEXT NOT NULL,
      billing_reason TEXT,
      period_start TEXT,
      period_end TEXT,
      paid_at TEXT,
      failed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS giving_subscriptions (
      stripe_subscription_id TEXT PRIMARY KEY,
      stripe_connected_account_id TEXT,
      stripe_customer_id TEXT,
      donor_name TEXT,
      donor_email TEXT,
      fund_code TEXT NOT NULL,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      platform_fee_percent REAL NOT NULL DEFAULT 2.5,
      currency TEXT NOT NULL DEFAULT 'usd',
      status TEXT NOT NULL,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      current_period_start TEXT,
      current_period_end TEXT,
      canceled_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      stripe_event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      connected_account_id TEXT,
      processed_at TEXT NOT NULL
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_giving_paid_at ON giving_donations(paid_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_giving_fund ON giving_donations(fund_code)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_giving_email ON giving_donations(donor_email)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_subscription_payments_paid_at ON giving_subscription_payments(paid_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_subscription_payments_subscription ON giving_subscription_payments(stripe_subscription_id)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_subscription_payments_fund ON giving_subscription_payments(fund_code)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON giving_subscriptions(status)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_subscriptions_email ON giving_subscriptions(donor_email)')
  ]);
}

async function createCheckoutSession(request, env) {
  if (!env.STRIPE_CONNECTED_ACCOUNT_ID) {
    return json({ error: 'Church giving is not configured yet.' }, 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  const amountCents = Number(payload?.amountCents);
  const fund = normalizeFund(payload?.fund);
  const frequency = payload?.frequency === 'monthly' ? 'monthly' : 'one_time';
  const donorName = normalizeText(payload?.donorName, 120);
  const donorEmail = normalizeEmail(payload?.donorEmail);
  const note = normalizeText(payload?.note, 300);

  if (!Number.isInteger(amountCents) || amountCents < MIN_GIFT_CENTS || amountCents > MAX_GIFT_CENTS) {
    return json({ error: 'Enter an amount between $1 and $100,000.' }, 400);
  }
  if (!fund) return json({ error: 'Choose a valid giving fund.' }, 400);
  if (!donorEmail) return json({ error: 'Enter a valid email address.' }, 400);

  const baseUrl = getBaseUrl(request, env);
  const applicationFeeCents = Math.round(amountCents * PLATFORM_FEE_RATE);
  const params = new URLSearchParams();
  params.set('mode', frequency === 'monthly' ? 'subscription' : 'payment');
  params.set('success_url', `${baseUrl}/Pages/giving-success.html?session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${baseUrl}/Pages/giving.html?canceled=1`);
  params.set('customer_email', donorEmail);
  params.set('billing_address_collection', 'auto');
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', 'usd');
  params.set('line_items[0][price_data][product_data][name]', FUNDS[fund]);
  params.set('line_items[0][price_data][product_data][description]', 'Contribution to Mt. Moriah Missionary Baptist Church');
  params.set('line_items[0][price_data][unit_amount]', String(amountCents));
  params.set('metadata[fund]', fund);
  params.set('metadata[fund_label]', FUNDS[fund]);
  params.set('metadata[frequency]', frequency);
  params.set('metadata[donor_name]', donorName);
  params.set('metadata[note]', note);
  params.set('metadata[platform_fee_rate]', '2.5%');
  params.set('metadata[source]', 'mmmbc_website');

  if (frequency === 'monthly') {
    params.set('line_items[0][price_data][recurring][interval]', 'month');
    params.set('subscription_data[application_fee_percent]', '2.5');
    params.set('subscription_data[metadata][fund]', fund);
    params.set('subscription_data[metadata][fund_label]', FUNDS[fund]);
    params.set('subscription_data[metadata][donor_name]', donorName);
    params.set('subscription_data[metadata][donor_email]', donorEmail);
    params.set('subscription_data[metadata][amount_cents]', String(amountCents));
    params.set('subscription_data[metadata][source]', 'mmmbc_website');
  } else {
    params.set('payment_intent_data[application_fee_amount]', String(applicationFeeCents));
    params.set('payment_intent_data[metadata][fund]', fund);
    params.set('payment_intent_data[metadata][fund_label]', FUNDS[fund]);
    params.set('payment_intent_data[metadata][donor_name]', donorName);
    params.set('payment_intent_data[metadata][source]', 'mmmbc_website');
  }

  try {
    const session = await stripeRequest(env, '/checkout/sessions', params, env.STRIPE_CONNECTED_ACCOUNT_ID);

    await ensureGivingTables(env);
    if (env.DB) {
      const now = new Date().toISOString();
      await env.DB.prepare(`INSERT OR IGNORE INTO giving_donations (
        id, stripe_checkout_session_id, stripe_connected_account_id,
        donor_name, donor_email, fund_code, frequency, amount_cents,
        platform_fee_cents, currency, payment_status, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'usd', 'checkout_created', ?, ?, ?)`).bind(
        crypto.randomUUID(),
        session.id,
        env.STRIPE_CONNECTED_ACCOUNT_ID,
        donorName,
        donorEmail,
        fund,
        frequency,
        amountCents,
        frequency === 'monthly' ? 0 : applicationFeeCents,
        note,
        now,
        now
      ).run();
    }

    return json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unable to start checkout.' }, 502);
  }
}

function hexToBytes(hex) {
  if (!hex || hex.length % 2) return new Uint8Array();
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a[i] ^ b[i];
  return result === 0;
}

async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  const parts = String(signatureHeader || '').split(',');
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2) || '';
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  if (!timestamp || !signatures.length || !secret) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signedPayload = `${timestamp}.${rawBody}`;
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload)));
  return signatures.some((signature) => constantTimeEqual(digest, hexToBytes(signature)));
}

function getSessionAmount(session) {
  return Number(session?.amount_total || session?.amount_subtotal || 0);
}

async function processCheckoutEvent(event, env) {
  const session = event?.data?.object || {};
  const metadata = session.metadata || {};
  const fund = normalizeFund(metadata.fund) || 'general';
  const frequency = metadata.frequency === 'monthly' || session.mode === 'subscription' ? 'monthly' : 'one_time';
  const amountCents = getSessionAmount(session);
  const platformFeeCents = Math.round(amountCents * PLATFORM_FEE_RATE);
  const now = new Date().toISOString();
  const paid = session.payment_status === 'paid' || event.type === 'checkout.session.async_payment_succeeded';

  await env.DB.prepare(`INSERT INTO giving_donations (
    id, stripe_event_id, stripe_checkout_session_id, stripe_payment_intent_id,
    stripe_subscription_id, stripe_connected_account_id, donor_name, donor_email,
    fund_code, frequency, amount_cents, platform_fee_cents, currency,
    payment_status, note, created_at, paid_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(stripe_checkout_session_id) DO UPDATE SET
    stripe_event_id = excluded.stripe_event_id,
    stripe_payment_intent_id = excluded.stripe_payment_intent_id,
    stripe_subscription_id = excluded.stripe_subscription_id,
    donor_name = excluded.donor_name,
    donor_email = excluded.donor_email,
    payment_status = excluded.payment_status,
    paid_at = excluded.paid_at,
    updated_at = excluded.updated_at`).bind(
      crypto.randomUUID(),
      event.id,
      session.id,
      session.payment_intent || null,
      session.subscription || null,
      event.account || env.STRIPE_CONNECTED_ACCOUNT_ID || null,
      normalizeText(metadata.donor_name || session.customer_details?.name, 120),
      normalizeEmail(session.customer_details?.email || session.customer_email),
      fund,
      frequency,
      amountCents,
      platformFeeCents,
      normalizeText(session.currency || 'usd', 10),
      paid ? 'paid' : normalizeText(session.payment_status || event.type, 60),
      normalizeText(metadata.note, 300),
      now,
      paid ? now : null,
      now
    ).run();
}

function getInvoiceSubscriptionId(invoice) {
  return normalizeText(
    invoice?.subscription ||
    invoice?.parent?.subscription_details?.subscription ||
    invoice?.subscription_details?.subscription,
    200
  );
}

function getInvoiceMetadata(invoice) {
  return invoice?.subscription_details?.metadata || invoice?.parent?.subscription_details?.metadata || invoice?.metadata || {};
}

function getInvoicePeriod(invoice) {
  const firstLine = Array.isArray(invoice?.lines?.data) ? invoice.lines.data[0] : null;
  return {
    start: unixToIso(firstLine?.period?.start || invoice?.period_start),
    end: unixToIso(firstLine?.period?.end || invoice?.period_end)
  };
}

async function processInvoiceEvent(event, env) {
  const invoice = event?.data?.object || {};
  const metadata = getInvoiceMetadata(invoice);
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  const fund = normalizeFund(metadata.fund) || 'general';
  const amountDue = Number(invoice.amount_due || 0);
  const amountPaid = Number(invoice.amount_paid || 0);
  const paid = event.type === 'invoice.paid' || invoice.status === 'paid';
  const period = getInvoicePeriod(invoice);
  const now = new Date().toISOString();

  await env.DB.prepare(`INSERT INTO giving_subscription_payments (
    id, stripe_event_id, stripe_invoice_id, stripe_subscription_id,
    stripe_payment_intent_id, stripe_connected_account_id, donor_name,
    donor_email, fund_code, amount_due_cents, amount_paid_cents,
    platform_fee_cents, currency, payment_status, billing_reason,
    period_start, period_end, paid_at, failed_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(stripe_invoice_id) DO UPDATE SET
    stripe_event_id = excluded.stripe_event_id,
    stripe_payment_intent_id = excluded.stripe_payment_intent_id,
    donor_name = excluded.donor_name,
    donor_email = excluded.donor_email,
    amount_due_cents = excluded.amount_due_cents,
    amount_paid_cents = excluded.amount_paid_cents,
    platform_fee_cents = excluded.platform_fee_cents,
    payment_status = excluded.payment_status,
    paid_at = excluded.paid_at,
    failed_at = excluded.failed_at,
    updated_at = excluded.updated_at`).bind(
      crypto.randomUUID(),
      event.id,
      invoice.id,
      subscriptionId || null,
      invoice.payment_intent || null,
      event.account || env.STRIPE_CONNECTED_ACCOUNT_ID || null,
      normalizeText(metadata.donor_name || invoice.customer_name, 120),
      normalizeEmail(metadata.donor_email || invoice.customer_email),
      fund,
      amountDue,
      amountPaid,
      Math.round((paid ? amountPaid : amountDue) * PLATFORM_FEE_RATE),
      normalizeText(invoice.currency || 'usd', 10),
      paid ? 'paid' : 'failed',
      normalizeText(invoice.billing_reason, 80),
      period.start,
      period.end,
      paid ? now : null,
      paid ? null : now,
      unixToIso(invoice.created) || now,
      now
    ).run();

  if (subscriptionId) {
    await env.DB.prepare(`UPDATE giving_subscriptions SET
      donor_name = COALESCE(NULLIF(?, ''), donor_name),
      donor_email = COALESCE(NULLIF(?, ''), donor_email),
      fund_code = ?,
      amount_cents = CASE WHEN ? > 0 THEN ? ELSE amount_cents END,
      currency = ?,
      status = CASE WHEN ? = 1 THEN 'active' ELSE 'past_due' END,
      current_period_start = COALESCE(?, current_period_start),
      current_period_end = COALESCE(?, current_period_end),
      updated_at = ?
      WHERE stripe_subscription_id = ?`).bind(
        normalizeText(metadata.donor_name || invoice.customer_name, 120),
        normalizeEmail(metadata.donor_email || invoice.customer_email),
        fund,
        amountDue,
        amountDue,
        normalizeText(invoice.currency || 'usd', 10),
        paid ? 1 : 0,
        period.start,
        period.end,
        now,
        subscriptionId
      ).run();
  }
}

function getSubscriptionAmount(subscription) {
  const item = Array.isArray(subscription?.items?.data) ? subscription.items.data[0] : null;
  return Number(item?.price?.unit_amount || item?.plan?.amount || subscription?.metadata?.amount_cents || 0);
}

async function processSubscriptionEvent(event, env) {
  const subscription = event?.data?.object || {};
  const metadata = subscription.metadata || {};
  const fund = normalizeFund(metadata.fund) || 'general';
  const now = new Date().toISOString();
  const status = event.type === 'customer.subscription.deleted'
    ? 'canceled'
    : normalizeText(subscription.status || 'unknown', 40);

  await env.DB.prepare(`INSERT INTO giving_subscriptions (
    stripe_subscription_id, stripe_connected_account_id, stripe_customer_id,
    donor_name, donor_email, fund_code, amount_cents, platform_fee_percent,
    currency, status, cancel_at_period_end, current_period_start,
    current_period_end, canceled_at, ended_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 2.5, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(stripe_subscription_id) DO UPDATE SET
    stripe_customer_id = excluded.stripe_customer_id,
    donor_name = COALESCE(NULLIF(excluded.donor_name, ''), giving_subscriptions.donor_name),
    donor_email = COALESCE(NULLIF(excluded.donor_email, ''), giving_subscriptions.donor_email),
    fund_code = excluded.fund_code,
    amount_cents = excluded.amount_cents,
    currency = excluded.currency,
    status = excluded.status,
    cancel_at_period_end = excluded.cancel_at_period_end,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    canceled_at = excluded.canceled_at,
    ended_at = excluded.ended_at,
    updated_at = excluded.updated_at`).bind(
      subscription.id,
      event.account || env.STRIPE_CONNECTED_ACCOUNT_ID || null,
      subscription.customer || null,
      normalizeText(metadata.donor_name, 120),
      normalizeEmail(metadata.donor_email),
      fund,
      getSubscriptionAmount(subscription),
      normalizeText(subscription.currency || subscription.items?.data?.[0]?.price?.currency || 'usd', 10),
      status,
      subscription.cancel_at_period_end ? 1 : 0,
      unixToIso(subscription.current_period_start),
      unixToIso(subscription.current_period_end),
      unixToIso(subscription.canceled_at),
      unixToIso(subscription.ended_at),
      unixToIso(subscription.created) || now,
      now
    ).run();
}

async function handleWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'Webhook is not configured.' }, 503);
  const rawBody = await request.text();
  const signature = request.headers.get('Stripe-Signature') || '';
  const valid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ error: 'Invalid webhook signature.' }, 400);

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Invalid webhook payload.' }, 400);
  }

  await ensureGivingTables(env);
  if (!env.DB) return json({ received: true, stored: false });

  const existing = await env.DB.prepare('SELECT stripe_event_id FROM stripe_webhook_events WHERE stripe_event_id = ?')
    .bind(event.id).first();
  if (existing) return json({ received: true, duplicate: true });

  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'].includes(event.type)) {
    await processCheckoutEvent(event, env);
  } else if (['invoice.paid', 'invoice.payment_failed'].includes(event.type)) {
    await processInvoiceEvent(event, env);
  } else if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
    await processSubscriptionEvent(event, env);
  }

  await env.DB.prepare(`INSERT INTO stripe_webhook_events (
    stripe_event_id, event_type, connected_account_id, processed_at
  ) VALUES (?, ?, ?, ?)`).bind(
      event.id,
      event.type,
      event.account || null,
      new Date().toISOString()
    ).run();

  return json({ received: true });
}

async function getCheckoutStatus(request, env) {
  const sessionId = normalizeText(new URL(request.url).searchParams.get('session_id'), 200);
  if (!sessionId || !env.STRIPE_CONNECTED_ACCOUNT_ID || !env.STRIPE_SECRET_KEY) {
    return json({ status: 'unknown' }, 400);
  }

  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Stripe-Account': env.STRIPE_CONNECTED_ACCOUNT_ID
  };
  const response = await fetch(`${STRIPE_API}/checkout/sessions/${encodeURIComponent(sessionId)}`, { headers });
  const session = await response.json().catch(() => ({}));
  if (!response.ok) return json({ status: 'unknown' }, response.status);

  return json({
    status: session.payment_status || 'unknown',
    amountTotal: Number(session.amount_total || 0),
    currency: session.currency || 'usd',
    fund: session.metadata?.fund_label || 'Contribution',
    donorEmail: session.customer_details?.email || session.customer_email || ''
  });
}

export async function handleGivingRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/api/giving/checkout') {
    return createCheckoutSession(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/api/stripe/webhook') {
    return handleWebhook(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/api/giving/session') {
    return getCheckoutStatus(request, env);
  }
  return null;
}
