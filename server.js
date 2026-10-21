'use strict';
/*
 * Review Funnel — demo server. Node built-in http only, no deps.
 *
 * Run (MOCK mode, the default — no Twilio account, no real SMS):
 *   node server.js
 *
 * Routes:
 *   POST /job/done    — staff report a finished job ("send" button):
 *                       fields Business=<business Twilio number>,
 *                       Customer=<customer mobile>. Requires the
 *                       business's api_secret (field Secret or header
 *                       X-Api-Secret). NO batch in v1.
 *   POST /job/hold    — "do not send" hold for MISTAKES ONLY
 *                       (wrong number, duplicate record). Requires a
 *                       written reason AND the business's api_secret.
 *                       Cancels queued asks; logged.
 *   POST /tick        — send everything whose time has come
 *                       (in production this runs on a timer — see below;
 *                        exposed as a route so the demo/tests can drive it)
 *   POST /sms/inbound — Twilio inbound SMS webhook (replies + STOP).
 *                       In real mode the Twilio request signature is
 *                       checked; in mock mode checking is off (logged).
 *   GET  /r/:token/feedback      — private feedback form, with the
 *                       Google review door shown above it. Visiting the
 *                       page marks the ask's clickedFeedbackPage, so the
 *                       reminder is suppressed even without a submission.
 *   POST /r/:token/feedback     — submit private feedback (owner-only)
 *   GET  /b/:token/feedback     — counter-QR feedback page: the same
 *                       form, not tied to a texted ask, PLUS the
 *                       self-serve "text me the link" box below it.
 *   POST /b/:token/feedback     — submit counter-QR feedback
 *   POST /b/:token/self-serve   — the customer types their OWN number
 *                       on the counter page and gets the standard
 *                       two-link ask text right away (source:
 *                       self-serve; same STOP / 30-day / fair-use
 *                       rules as a staff send)
 *   GET  /staff/:pageToken      — staff send page: one phone field, one
 *                       big "send" button, one small "do not send" form.
 *                       Reached via the business's own secret link.
 *   POST /staff/:pageToken/job-done — staff page submit (same logic as
 *                       /job/done; the secret link in the URL is the key)
 *   POST /staff/:pageToken/hold — staff page "do not send" submit
 *   GET  /inbox/:pageToken      — owner inbox: feedback list + counts
 *                       + "Customer contacts" list + "make a new link"
 *                       button (link rotation)
 *   GET  /inbox/:pageToken/contacts.csv — download the business's
 *                       opted-in contact list as CSV (same private
 *                       inbox link protects it as the inbox itself)
 *   POST /inbox/:pageToken/rotate — regenerate the inbox link; the
 *                       old one stops working immediately. Requires the
 *                       business's api_secret (the page token alone is
 *                       not enough — a leaked link must not let the
 *                       leaker rotate the owner out).
 *   POST /summary/hand-counts   — owner/staffer enters by hand what
 *                       they see on the Google listing: new reviews
 *                       spotted + current star rating
 *   POST /summary/send          — text the owner the weekly summary.
 *                       Requires the business's api_secret.
 *   GET  /health, GET /
 *
 * Optional demo-only field: SimulatedTime=<ISO timestamp> on POSTs makes
 * the delay / send-window / reminder logic evaluate at that moment, so
 * quiet hours and reminders can be demonstrated on demand. Twilio never
 * sends this field; production traffic simply omits it.
 *
 * Env: PORT (default 3001), BUSINESSES_CSV, EVENT_LOG, SENT_LOG,
 *      FEEDBACK_LOG, STATE_FILE (state snapshot; default ./state.json),
 *      LINK_BASE, TWILIO_MODE ("mock" default; "real" is
 *      intentionally not used here).
 */
const http = require('http');
const querystring = require('querystring');
const path = require('path');
const { createService, loadBusinesses, render, normalizeNumber, newToken, DEFAULT_CONTACTS_CONSENT } = require('./core');
const { createTwilioAdapter, validateTwilioSignature } = require('./twilio');

const dir = __dirname;
const businesses = loadBusinesses(process.env.BUSINESSES_CSV || path.join(dir, 'businesses.csv'));
const adapter = createTwilioAdapter({}); // defaults to mock unless TWILIO_MODE=real
const service = createService({
  businesses,
  adapter,
  eventLogPath: process.env.EVENT_LOG || path.join(dir, 'events.jsonl'),
  sentLogPath: process.env.SENT_LOG || path.join(dir, 'sent-messages.jsonl'),
  feedbackLogPath: process.env.FEEDBACK_LOG || path.join(dir, 'feedback.jsonl'),
  statePath: process.env.STATE_FILE || path.join(dir, 'state.json'),
});

/*
 * Endpoint locks. The working POST endpoints (/job/done, /job/hold,
 * /summary/send, and the inbox-link rotation) require the business's
 * own secret (the api_secret column in businesses.csv), passed either
 * as the Secret form field or the X-Api-Secret header. A missing or
 * wrong secret is rejected (403) and logged — an unknown business
 * number on /job/done or /job/hold keeps the old "skipped
 * (unknown business number)" behaviour, since there is no secret to
 * check against.
 */
function businessSecretOk(req, params, business) {
  const provided = String(params.Secret || req.headers['x-api-secret'] || '');
  return !!business.apiSecret && provided === business.apiSecret;
}

function requireBusinessSecret(req, res, params, business) {
  if (businessSecretOk(req, params, business)) return true;
  service.logEvent({
    business: business.name,
    event_type: 'endpoint-auth',
    delivery_status: 'rejected (bad secret)',
    detail: 'rejected ' + req.method + ' ' + req.url + ': the business secret was missing or wrong',
  });
  sendJson(res, 403, { ok: false, error: 'unauthorized: missing or wrong business secret' });
  return false;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/*
 * Counter-QR feedback page support. A printed QR at the shop counter
 * points at <base>/b/<pageToken>/feedback. It is the SAME feedback form
 * (Google review door above it) as the texted link, but it is not tied
 * to any texted ask — the customer has no number on file, so no reminder
 * can ever be sent for it. One lightweight ask record per business is
 * kept (created lazily, kept in memory + the state snapshot) so
 * submissions flow through the exact same recordFeedback path as texted
 * asks: stored owner-only, owner alert text, on-page thank-you, counted
 * in the weekly summary's feedback line.
 * Note: the URL contains the business's pageToken, so rotating the inbox
 * link changes this address too — reprint the QR after a rotation.
 */
const counterAskTokens = new Map(); // twilioNumber -> ask token for the counter QR page
function counterAsk(business, now) {
  let token = counterAskTokens.get(business.twilioNumber);
  let ask = token && service.asksByToken.get(token);
  if (!ask) {
    token = newToken();
    ask = {
      business, customer: null, jobAt: now.getTime(), sentAt: now.getTime(),
      clickedFeedbackPage: true, replied: false,
      feedbackSubmitted: false, reminderSent: true, source: 'counter-qr',
    };
    service.asksByToken.set(token, ask);
    counterAskTokens.set(business.twilioNumber, token);
    service.saveState();
  }
  return token;
}

function pageShell(title, inner) {
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + esc(title) + '</title></head>' +
    '<body style="font-family: sans-serif; max-width: 34em; margin: 2em auto; padding: 0 1em; color: #111;">' +
    inner + '</body></html>';
}

// The private feedback form. The Google review door is shown above it —
// private feedback never replaces the public door (the anti-gating rule,
// made visible). The star rating is OPTIONAL and is marked, in plain
// words, as "only the owner sees this" — it is for the owner's records
// and is never used to steer customers.
//
// opts (counter-QR page only): { note, selfServeAction }. The self-serve
// "text me the link" box is a SEPARATE section rendered BELOW this form
// on the counter page: it never gates, delays, or changes the feedback
// form or the Google door, and the page works fully if it is ignored.
function feedbackPage(business, token, actionPath, opts) {
  const options = opts || {};
  const action = actionPath || ('/r/' + token + '/feedback');
  const selfServeBox = options.selfServeAction ? (
    '<hr style="margin:2em 0;">' +
    '<h2 style="color:#111;">Rather get the link by text?</h2>' +
    '<p style="color:#444;">Punch in your own number and we will text you the same review link — handy if you want it saved in your messages for later.</p>' +
    '<form method="POST" action="' + esc(options.selfServeAction) + '">' +
    '<p><label style="color:#111;">Your mobile number<br>' +
    '<input name="phone" inputmode="tel" autocomplete="tel" style="width:100%; padding:0.8em; font-size:1.1em; box-sizing:border-box;"></label></p>' +
    '<p><button type="submit" style="width:100%; padding:1em; font-size:1.1em; background:#1a73e8; color:#ffffff; border:none; border-radius:8px;">Text me the review link</button></p>' +
    '<p style="color:#444;">We will text you the review link once. Reply STOP any time to opt out.</p>' +
    '</form>'
  ) : '';
  return pageShell('Tell ' + business.name + ' directly', (
    (options.note ? '<p style="color:#111; background:#eef6ee; border:1px solid #9c9; padding:0.7em; border-radius:6px;">' + esc(options.note) + '</p>' : '') +
    '<p><a href="' + esc(business.googleReviewLink) + '" ' +
    'style="display:block; text-align:center; padding:0.8em; background:#1a73e8; color:#ffffff; border-radius:8px; text-decoration:none;">' +
    'Leave a public Google review instead</a></p>' +
    '<h1 style="color:#111;">' + esc(render(business.feedbackHeading, { business_name: business.name })) + '</h1>' +
    '<p style="color:#444;">' + esc(render(business.feedbackSubline || '', { business_name: business.name }) || 'This goes privately to the owner — it is not a public review.') + '</p>' +
    '<form method="POST" action="' + esc(action) + '">' +
    '<p><label style="color:#111;">Your name (optional)<br>' +
    '<input name="name" style="width:100%; padding:0.5em;"></label></p>' +
    '<p><span style="color:#111;">Star rating (optional — <strong>only the owner sees this</strong>; it is for their records and is never used for anything else)</span><br>' +
    '<label style="color:#111; margin-right:0.6em;"><input type="radio" name="rating" value=""> Skip</label>' +
    [1, 2, 3, 4, 5].map((n) =>
      '<label style="color:#111; margin-right:0.6em;"><input type="radio" name="rating" value="' + n + '"> ' + n + '</label>'
    ).join('') + '</p>' +
    '<p><label style="color:#111;">What happened?<br>' +
    '<textarea name="message" rows="4" style="width:100%; padding:0.5em;"></textarea></label></p>' +
    '<p><label style="color:#111;">What would make it right?<br>' +
    '<textarea name="make_it_right" rows="3" style="width:100%; padding:0.5em;"></textarea></label></p>' +
    '<p><label style="color:#111;">May the owner contact you about this? ' +
    '<select name="contact_ok"><option value="no">No</option><option value="yes">Yes</option></select></label></p>' +
    '<p><label style="color:#111;">Best number to reach you (optional)<br>' +
    '<input name="contact_number" style="width:100%; padding:0.5em;"></label></p>' +
    // "Keep me posted" — a SEPARATE, optional section, below the
    // feedback itself. The checkbox is UNCHECKED by default, and the
    // feedback above saves identically whether it is ticked or not:
    // collection is never a gate (the Google door is above this form,
    // and the Google link was already in the customer's text).
    '<fieldset style="border:1px solid #bbb; border-radius:8px; padding:0.8em; margin:1em 0;">' +
    '<legend style="color:#111; padding:0 0.3em;">Stay in touch (optional)</legend>' +
    '<p style="color:#444; margin-top:0;">Separate from your feedback above — only fill this in if you want to hear from ' + esc(business.name) + ' again.</p>' +
    '<p><label style="color:#111;">Email (optional)<br>' +
    '<input type="email" name="email" style="width:100%; padding:0.5em;"></label></p>' +
    '<p><label style="color:#111;"><input type="checkbox" name="keep_posted" value="yes"> ' +
    esc(render(DEFAULT_CONTACTS_CONSENT, { business_name: business.name })) + '</label></p>' +
    '</fieldset>' +
    '<p><button type="submit" style="padding:0.8em 2em; font-size:1em;">Send to the owner</button></p>' +
    '</form>' +
    selfServeBox
  ));
}

// Plain-words result lines for the self-serve box, shown at the top of
// the counter page after a submit. The page never claims a text was
// sent before the send was actually accepted (see the route below).
function selfServeNoteFor(result, outcome) {
  if (!result) return 'Something went wrong — the links on this page work just as well.';
  if (result.action === 'queued') {
    if (outcome === 'sent') return 'Sent! Check your texts — the review link is on its way from us.';
    if (outcome === 'send-failed' || outcome === 'send-failed-final') return 'We are sending it now — if it does not arrive in a few minutes, the links on this page work just as well.';
    if (outcome === 'suppressed-cap') return 'We could not send it just now — the links on this page work just as well.';
    if (outcome === 'suppressed-stop') return 'No problem — we will not text that number. You can still use the links right here on this page.';
    return 'Thanks — your link will be texted to you shortly, inside our normal texting hours.';
  }
  if (result.action === 'suppressed') {
    if (result.reason === 'stop') return 'No problem — we will not text that number. You can still use the links right here on this page.';
    if (result.reason === 'repeat-cap') return 'That number already got the link recently — check your texts, or just use the links on this page.';
    if (result.reason === 'fair-use-cap') return 'We could not send it just now — the links on this page work just as well.';
    return 'We could not send it just now — the links on this page work just as well.';
  }
  if (result.action === 'skipped') {
    if (result.reason === 'invalid-number') return 'That number doesn\u2019t look right — check it and try again.';
    if (result.reason === 'non-us') return 'That number doesn\u2019t look like a US number, and we can only text US numbers — the links on this page work just as well.';
    return 'We could not send it just now — the links on this page work just as well.';
  }
  return 'We could not send it just now — the links on this page work just as well.';
}

function feedbackThanksPage(business, confirmation) {
  return pageShell(business.name, (
    '<h1 style="color:#111;">Thank you</h1>' +
    '<p style="color:#111;">' + esc(confirmation) + '</p>'
  ));
}

// Owner inbox: that business's private feedback (newest first) plus
// the honest counts. Reached via the per-business token link.
// Includes the "make a new link" button — a leaked link gets replaced.
function inboxPage(business, counts) {
  const items = service.getFeedback(business).slice().reverse();
  const list = items.length
    ? items.map((f) => (
      '<li style="color:#111; margin-bottom:1em;"><strong>' + esc(f.timestamp) + '</strong>' +
      (f.name ? ' — from ' + esc(f.name) : ' — anonymous') +
      (f.rating != null ? '<br>Private star rating (owner-only): ' + esc(String(f.rating)) + ' of 5' : '') +
      '<br>What happened: ' + esc(f.message) +
      (f.make_it_right ? '<br>What would make it right: ' + esc(f.make_it_right) : '') +
      '<br>May contact back: ' + (f.contact_ok ? 'yes' + (f.contact_number ? ' at ' + esc(f.contact_number) : '') : 'no') +
      '</li>'
    )).join('')
    : '<li style="color:#111;">No private feedback yet.</li>';
  const hand = business.handCounts;
  const contactList = service.getContacts(business).slice().reverse();
  const contactsHtml = contactList.length
    ? '<ul>' + contactList.map((c) => (
      '<li style="color:#111; margin-bottom:0.6em;"><strong>' + esc(c.name || 'No name given') + '</strong>' +
      (c.email ? '<br>Email: ' + esc(c.email) : '') +
      (c.phone ? '<br>Phone: ' + esc(c.phone) : '') +
      '<br>Opted in: ' + esc(String(c.timestamp || '').slice(0, 10)) + '</li>'
    )).join('') + '</ul>' +
    '<p><a href="/inbox/' + esc(business.pageToken) + '/contacts.csv" style="color:#1a73e8;">Download contact list (CSV)</a></p>'
    : '<p style="color:#111;">No contacts yet — they appear here when a customer ticks "keep me posted" on the feedback page.</p>';
  return pageShell(business.name + ' — owner inbox', (
    '<h1 style="color:#111;">' + esc(business.name) + ' — private feedback inbox</h1>' +
    '<p style="color:#111;">Last 7 days: ' + counts.asksSent + ' review asks sent, ' +
    counts.feedbackReceived + ' private feedback notes received, ' +
    (counts.contactsCollected || 0) + ' new contacts collected.</p>' +
    '<p style="color:#111;">Google listing (counted by hand): ' +
    (hand ? esc(String(hand.googleReviewsSpotted)) + ' new reviews spotted, rating ' + esc(String(hand.currentRating)) + ' (entered ' + esc(hand.updatedAt.slice(0, 10)) + ')' : 'not entered yet') +
    '.</p>' +
    '<ul>' + list + '</ul>' +
    '<h2 style="color:#111;">Customer contacts</h2>' +
    '<p style="color:#444;">Customers who ticked "keep me posted" on the feedback page. This list is yours — ' +
    'it is stored only here, and this tool never sends them anything.</p>' +
    contactsHtml +
    '<h2 style="color:#111;">This link is private</h2>' +
    '<p style="color:#444;">Treat this link like a password — anyone with it can read your feedback. ' +
    'If it ever leaks (forwarded, posted somewhere), make a new one here; the old one stops working right away.</p>' +
    '<form method="POST" action="/inbox/' + esc(business.pageToken) + '/rotate">' +
    '<p><label style="color:#111;">Business secret (from your setup sheet)<br>' +
    '<input type="password" name="Secret" style="width:100%; padding:0.5em;" autocomplete="off"></label></p>' +
    '<p><button type="submit" style="padding:0.7em 1.5em;">Make a new private link</button></p></form>'
  ));
}

function rotatedPage(business, newLink) {
  return pageShell(business.name, (
    '<h1 style="color:#111;">Your new private link is ready</h1>' +
    '<p style="color:#111;">Save this new link somewhere safe and delete the old one — the old one no longer works.</p>' +
    '<p><a href="' + esc(newLink) + '" style="color:#1a73e8;">' + esc(newLink) + '</a></p>' +
    '<p><a href="' + esc(newLink) + '" style="color:#1a73e8;">Open your new inbox</a></p>' +
    '<p style="color:#444;">Note: your staff send page uses the same secret link, so its address changed too — the new one is at the same link family as this inbox.</p>'
  ));
}

/*
 * Staff send page. One phone-number field, one big "Job done — send
 * review ask" button, and a separate small "Do not send (mistake)"
 * form with number + reason fields. Plain, mobile-friendly, single
 * page. Reached via the business's own secret link, so no separate
 * login is needed — the link is the key. Submits go through the same
 * handleJobDone / handleHold logic as the API endpoints.
 */
function staffPage(business, note) {
  return pageShell(business.name + ' — staff', (
    '<h1 style="color:#111;">' + esc(business.name) + '</h1>' +
    (note ? '<p style="color:#111; background:#eef6ee; border:1px solid #9c9; padding:0.7em; border-radius:6px;">' + esc(note) + '</p>' : '') +
    '<h2 style="color:#111;">Finished a job?</h2>' +
    '<p style="color:#444;">Tap once after each job. The customer gets the review text in about 15 minutes, inside the shop\u2019s sending hours.</p>' +
    '<form method="POST" action="/staff/' + esc(business.pageToken) + '/job-done">' +
    '<p><label style="color:#111;">Customer mobile number<br>' +
    '<input name="Customer" inputmode="tel" autocomplete="off" style="width:100%; padding:0.8em; font-size:1.1em; box-sizing:border-box;"></label></p>' +
    '<p><button type="submit" style="width:100%; padding:1em; font-size:1.15em; background:#1a73e8; color:#ffffff; border:none; border-radius:8px;">Job done \u2014 send review ask</button></p>' +
    '</form>' +
    '<hr style="margin:2em 0;">' +
    '<h2 style="color:#111;">Made a mistake?</h2>' +
    '<p style="color:#444;">Wrong number or duplicate record only. This needs a written reason, and it never skips someone who might leave a bad review.</p>' +
    '<form method="POST" action="/staff/' + esc(business.pageToken) + '/hold">' +
    '<p><label style="color:#111;">Customer mobile number<br>' +
    '<input name="Customer" inputmode="tel" autocomplete="off" style="width:100%; padding:0.7em; font-size:1.05em; box-sizing:border-box;"></label></p>' +
    '<p><label style="color:#111;">Why (required)<br>' +
    '<input name="reason" placeholder="wrong number \u2014 customer changed phones" style="width:100%; padding:0.7em; font-size:1.05em; box-sizing:border-box;"></label></p>' +
    '<p><button type="submit" style="padding:0.8em 1.6em; font-size:1em;">Do not send (mistake)</button></p>' +
    '</form>'
  ));
}

function staffNoteFor(result) {
  if (!result) return 'Something went wrong — please try again.';
  if (result.action === 'queued') return 'Review ask queued — it goes out in about 15 minutes.';
  if (result.action === 'held') return 'Done — nothing will be sent. The reason is logged.';
  if (result.action === 'suppressed') {
    if (result.reason === 'stop') return 'Not sent — this number asked us to stop texting (STOP).';
    if (result.reason === 'repeat-cap') return 'Not sent — this customer already got a review ask in the last 30 days.';
    if (result.reason === 'fair-use-cap') return 'Not sent — this month\u2019s review-ask limit for the shop is reached.';
    return 'Not sent (' + result.reason + ').';
  }
  if (result.action === 'rejected') {
    if (result.reason === 'reason-required') return 'A written reason is required — tell us why (e.g. wrong number).';
    return 'Could not do that (' + result.reason + ').';
  }
  return 'Not sent (' + result.reason + ').';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, mode: adapter.mode, businesses: businesses.map((b) => b.name) });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(
        'Review Funnel demo server (mode: ' + adapter.mode + ')\n' +
        'POST /job/done            — staff report a finished job, one tap (Business, Customer, Secret)\n' +
        'POST /job/hold            — "do not send" hold for mistakes only (Business, Customer, reason REQUIRED, Secret)\n' +
        'POST /tick                — send due asks/reminders\n' +
        'POST /sms/inbound         — Twilio inbound SMS webhook (replies + STOP; signature checked in real mode)\n' +
        'GET  /r/:token/feedback   — private feedback form (Google review door shown above it)\n' +
        'POST /r/:token/feedback   — submit private feedback\n' +
        'GET  /b/:token/feedback   — counter-QR feedback page: the same form, not tied to a texted ask, plus the self-serve "text me the link" box\n' +
        'POST /b/:token/feedback   — submit counter-QR feedback\n' +
        'POST /b/:token/self-serve — customer types their own number on the counter page; the standard two-link ask is texted right away (same STOP / 30-day / fair-use rules)\n' +
        'GET  /staff/:token        — staff send page (phone field + big send button + do-not-send form)\n' +
        'POST /staff/:token/job-done — staff page submit\n' +
        'POST /staff/:token/hold   — staff page do-not-send submit (reason REQUIRED)\n' +
        'GET  /inbox/:token        — owner inbox (private-key link)\n' +
        'GET  /inbox/:token/contacts.csv — download the opted-in contact list (CSV)\n' +
        'POST /inbox/:token/rotate — regenerate the inbox link; old one dies (Secret REQUIRED)\n' +
        'POST /summary/hand-counts — owner enters Google counts by hand\n' +
        'POST /summary/send        — text the owner the weekly summary (Secret REQUIRED)\n' +
        'GET  /health              — status\n' +
        '\n' +
        'Locked endpoints (/job/done, /job/hold, /summary/send, /inbox/:token/rotate)\n' +
        'need the business secret: field Secret or header X-Api-Secret.\n' +
        'The weekly owner summary also sends itself automatically, Mondays at 9:00 AM\n' +
        'in each business\'s own time zone.\n'
      );
    }

    // Feedback form (Google review door shown above it). GET /r/:token
    // is kept as an alias of the form.
    if (parts[0] === 'r' && parts[1]) {
      const token = decodeURIComponent(parts[1]);
      const ask = service.asksByToken.get(token);
      if (!ask) return sendHtml(res, 404, pageShell('Not found', '<p style="color:#111;">This link is not active.</p>'));
      const business = ask.business;
      if (req.method === 'GET' && (parts.length === 2 || (parts.length === 3 && parts[2] === 'feedback'))) {
        // The customer opened the feedback page. Mark it: even if they
        // never submit, the reminder is suppressed — someone who looked
        // but stayed silent does not get chased.
        if (!ask.clickedFeedbackPage) {
          ask.clickedFeedbackPage = true;
          service.saveState();
        }
        return sendHtml(res, 200, feedbackPage(business, token));
      }
      if (req.method === 'POST' && parts[2] === 'feedback') {
        const params = querystring.parse(await readBody(req));
        const now = params.SimulatedTime ? new Date(params.SimulatedTime) : undefined;
        delete params.SimulatedTime;
        const result = await service.recordFeedback(token, params, now);
        if (!result) return sendHtml(res, 404, pageShell('Not found', '<p style="color:#111;">This link is not active.</p>'));
        return sendHtml(res, 200, feedbackThanksPage(business, result.confirmation));
      }
    }

    if (parts[0] === 'b' && parts[1]) {
      const business = service.findBusinessByPageToken(decodeURIComponent(parts[1]));
      if (!business) return sendHtml(res, 404, pageShell('Not found', '<p style="color:#111;">This page is not active.</p>'));
      const pagePath = '/b/' + encodeURIComponent(parts[1]) + '/feedback';
      const selfServePath = '/b/' + encodeURIComponent(parts[1]) + '/self-serve';
      const renderCounterPage = (note, now) => {
        const token = counterAsk(business, now || new Date());
        return feedbackPage(business, token, pagePath, { note: note || null, selfServeAction: selfServePath });
      };
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'feedback') {
        return sendHtml(res, 200, renderCounterPage(null, new Date()));
      }
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'feedback') {
        const params = querystring.parse(await readBody(req));
        const now = params.SimulatedTime ? new Date(params.SimulatedTime) : undefined;
        delete params.SimulatedTime;
        const token = counterAsk(business, now || new Date());
        const result = await service.recordFeedback(token, params, now);
        if (!result) return sendHtml(res, 404, pageShell('Not found', '<p style="color:#111;">This page is not active.</p>'));
        return sendHtml(res, 200, feedbackThanksPage(business, result.confirmation));
      }
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'self-serve') {
        // Self-serve "text me the link": the customer typed their OWN
        // number — that typed request is the opt-in. Queue the ask
        // through the same machinery as a staff send, then send what
        // is due right away so the page can honestly say whether the
        // text went out, is being retried, or could not be sent.
        const params = querystring.parse(await readBody(req));
        const now = params.SimulatedTime ? new Date(params.SimulatedTime) : new Date();
        delete params.SimulatedTime;
        const rawPhone = params.phone || params.Customer || '';
        const result = service.handleSelfServeAsk(business, rawPhone, now);
        let outcome = null;
        if (result.action === 'queued') {
          const outcomes = await service.processDue(now);
          const customer = normalizeNumber(rawPhone);
          const mine = outcomes.find((o) => o.type === 'ask' && (o.token === result.token || o.customer === customer));
          outcome = mine ? mine.action : 'not-due-yet'; // outside the send window: queued for the next opening
        }
        return sendHtml(res, 200, renderCounterPage(selfServeNoteFor(result, outcome), now));
      }
    }

    // Owner inbox + link rotation.
    if (parts[0] === 'inbox' && parts[1]) {
      const business = service.findBusinessByPageToken(decodeURIComponent(parts[1]));
      if (!business) return sendHtml(res, 404, pageShell('Not found', '<p style="color:#111;">Inbox not found.</p>'));
      if (req.method === 'GET' && parts.length === 2) {
        return sendHtml(res, 200, inboxPage(business, service.buildSummary(business, new Date(), 7)));
      }
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'contacts.csv') {
        // The contact-list download sits behind the SAME private
        // inbox link as the inbox itself (a wrong token never gets
        // here — the business lookup above already 404'd).
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="contacts.csv"',
        });
        return res.end(service.contactsCsv(business));
      }
      if (req.method === 'POST' && parts[2] === 'rotate') {
        const params = querystring.parse(await readBody(req));
        if (!requireBusinessSecret(req, res, params, business)) return undefined;
        const result = service.rotatePageToken(business, new Date());
        return sendHtml(res, 200, rotatedPage(business, result.link));
      }
    }

    // Staff send page (secret link in the URL is the key).
    if (parts[0] === 'staff' && parts[1]) {
      const business = service.findBusinessByPageToken(decodeURIComponent(parts[1]));
      if (!business) return sendHtml(res, 404, pageShell('Not found', '<p style="color:#111;">Staff page not found.</p>'));
      if (req.method === 'GET' && parts.length === 2) {
        return sendHtml(res, 200, staffPage(business, null));
      }
      if (req.method === 'POST' && parts.length === 3 && (parts[2] === 'job-done' || parts[2] === 'hold')) {
        const params = querystring.parse(await readBody(req));
        const now = params.SimulatedTime ? new Date(params.SimulatedTime) : undefined;
        delete params.SimulatedTime;
        if (parts[2] === 'job-done') {
          const result = service.handleJobDone(
            { Business: business.twilioNumber, Customer: params.Customer }, now);
          return sendHtml(res, 200, staffPage(business, staffNoteFor(result)));
        }
        const result = service.handleHold(
          { Business: business.twilioNumber, Customer: params.Customer, reason: params.reason }, now);
        return sendHtml(res, 200, staffPage(business, staffNoteFor(result)));
      }
    }

    if (req.method === 'POST' && url.pathname === '/job/done') {
      const params = querystring.parse(await readBody(req));
      const now = params.SimulatedTime ? new Date(params.SimulatedTime) : undefined;
      delete params.SimulatedTime;
      const business = service.findBusiness(normalizeNumber(params.Business || params.To || ''));
      if (business && !requireBusinessSecret(req, res, params, business)) return undefined;
      return sendJson(res, 200, { ok: true, result: service.handleJobDone(params, now) });
    }
    if (req.method === 'POST' && url.pathname === '/job/hold') {
      const params = querystring.parse(await readBody(req));
      const now = params.SimulatedTime ? new Date(params.SimulatedTime) : undefined;
      delete params.SimulatedTime;
      const business = service.findBusiness(normalizeNumber(params.Business || params.To || ''));
      if (business && !requireBusinessSecret(req, res, params, business)) return undefined;
      const result = service.handleHold(params, now);
      if (result.action === 'rejected') return sendJson(res, 400, { ok: false, result });
      return sendJson(res, 200, { ok: true, result });
    }
    if (req.method === 'POST' && url.pathname === '/tick') {
      const params = querystring.parse(await readBody(req));
      const now = params.SimulatedTime ? new Date(params.SimulatedTime) : undefined;
      delete params.SimulatedTime;
      return sendJson(res, 200, { ok: true, outcomes: await service.processDue(now) });
    }
    if (req.method === 'POST' && url.pathname === '/sms/inbound') {
      const params = querystring.parse(await readBody(req));
      if (adapter.mode === 'real') {
        // Live: prove the request really came from Twilio. Without this,
        // anyone could feed fake STOPs or replies into the system.
        const publicUrl = (process.env.PUBLIC_BASE_URL || ('https://' + (req.headers.host || 'localhost'))) + req.url;
        if (!validateTwilioSignature(process.env.TWILIO_AUTH_TOKEN, publicUrl, params, req.headers['x-twilio-signature'])) {
          service.logEvent({
            event_type: 'inbound-sms', delivery_status: 'rejected (bad signature)',
            detail: 'inbound SMS rejected: Twilio request signature did not verify',
          });
          return sendJson(res, 403, { ok: false, error: 'bad Twilio signature' });
        }
      } else {
        // Test mode: no signature to check. Logged so the gap is visible.
        service.logEvent({
          event_type: 'inbound-sms', delivery_status: 'signature check skipped (test mode)',
          detail: 'Twilio signature checking is OFF in mock mode — it turns on automatically in real mode',
        });
      }
      const now = params.SimulatedTime ? new Date(params.SimulatedTime) : undefined;
      delete params.SimulatedTime;
      return sendJson(res, 200, { ok: true, result: await service.handleInboundSms(params, now) });
    }
    if (req.method === 'POST' && url.pathname === '/summary/hand-counts') {
      const params = querystring.parse(await readBody(req));
      const now = params.SimulatedTime ? new Date(params.SimulatedTime) : undefined;
      delete params.SimulatedTime;
      const business = service.findBusiness(params.Business || '');
      if (!business) return sendJson(res, 404, { ok: false, error: 'unknown business' });
      const result = service.setHandCounts(business, params, now);
      if (result.action === 'rejected') return sendJson(res, 400, { ok: false, result });
      return sendJson(res, 200, { ok: true, result });
    }
    if (req.method === 'POST' && url.pathname === '/summary/send') {
      const params = querystring.parse(await readBody(req));
      const now = params.SimulatedTime ? new Date(params.SimulatedTime) : undefined;
      delete params.SimulatedTime;
      const business = service.findBusiness(params.Business || '');
      if (!business) return sendJson(res, 404, { ok: false, error: 'unknown business' });
      if (!requireBusinessSecret(req, res, params, business)) return undefined;
      return sendJson(res, 200, { ok: true, result: await service.sendWeeklySummary(business, now) });
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
  }
});

const port = Number(process.env.PORT || 3001);
if (require.main === module) {
  server.listen(port, () => {
    console.log('Review Funnel demo listening on port ' + port + ' (Twilio mode: ' + adapter.mode + ')');
    console.log('Businesses loaded: ' + businesses.map((b) => b.name + ' [' + b.twilioNumber + ', tz ' + b.timezone + ']').join('; '));
  });
  // Production behaviour: check the queue every minute and send what is
  // due, and send each business its automatic weekly summary on Monday
  // at 9:00 AM in the business's own timezone (guarded to once a week,
  // persisted across restarts). (The demo/tests drive the same
  // functions through POST /tick and by calling the service directly.)
  const timer = setInterval(() => {
    service.processDue(new Date()).catch((err) => console.error('tick failed: ' + err.message));
    service.sendDueWeeklySummaries(new Date()).catch((err) => console.error('weekly summary failed: ' + err.message));
  }, 60000);
  if (timer.unref) timer.unref();
}

module.exports = { server, service };
