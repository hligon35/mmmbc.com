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
      'Content-Type': 'application/json; charset=utf