'use strict';
/*
 * Review Funnel — core logic. Dependency-free (Node built-ins only).
 * Rebuilt 2026-10-20 to Mica's final answers on all 12 open questions
 * ("build away" email, 21:24:36). The old defaults are gone.
 *
 * THE ONE RULE THAT SHAPES EVERYTHING (safe flow, permanent):
 *   After a job, EVERY customer gets the same text with TWO links:
 *   the business's Google review page and a private-feedback form.
 *   A private-feedback option is offered to everyone; nothing — a
 *   rating, a complaint, a staff hunch — is ever used to steer a
 *   customer toward one door or the other. The gated version
 *   ("happy -> Google, unhappy -> private only") is what Google calls
 *   review gating and is banned; it is NOT implemented here and must
 *   never be added. No incentives for reviews, ever.
 *
 * Flow:
 *   1. Staff tap "send" once after each job (one-tap "job done"
 *      form/webhook). NO end-of-day batch in v1 — removed on Mica's
 *      explicit instruction. The system queues a review-ask text.
 *   2. The text goes out within the business's target (15 minutes
 *      default), and only inside the business's send window, worked
 *      out in the business's own timezone (a job finished late queues
 *      to the next morning).
 *   3. The text carries TWO links right in the text: the business's
 *      Google review page, and the private-feedback form. Short and
 *      warm copy, neutral wording (no suggested rating, no incentive).
 *   4. The feedback form has an OPTIONAL 1–5 star rating, clearly
 *      marked "only the owner sees this". It is stored for the
 *      owner's records and NEVER used to steer, sort, or suppress —
 *      there is no code path anywhere that branches on it.
 *   5. Private feedback goes ONLY to the owner: stored per business,
 *      lands in the owner inbox, and fires an instant owner alert
 *      text. The owner thanks the customer on the page only — NO
 *      thank-you text is sent (one more text risks annoying people
 *      and costs money).
 *   6. A "do not send" hold exists for MISTAKES ONLY (wrong number,
 *      duplicate record). Every hold requires a written reason and is
 *      logged with it. It must never be used to skip someone because
 *      they'd leave a bad review — that is the same trick the safe
 *      flow rules out. A hold cancels the queued ask; the customer is
 *      not suppressed and can be re-reported.
 *   7. If the customer does nothing, exactly ONE reminder may be sent
 *      after the configured delay. Any reply or feedback submission
 *      suppresses the reminder.
 *   8. Suppression: STOP is permanent per business; a customer is
 *      asked at most once per 30 days per business; US (+1) numbers
 *      only; per-business fair-use cap of 500 asks per month
 *      (the Base plan limit — see the Plans section in README.md).
 *   9. Owner inbox is a private link with a built-in key. Treat it
 *      like a password. If it leaks, the owner can regenerate it
 *      (old link dies immediately).
 *
 * Honest counts: the weekly summary counts review asks sent,
 * private feedback notes received, and new contacts collected
 * (things we actually see), plus two hand-entered fields the
 * owner/staffer types in: new Google reviews spotted and the current
 * star rating. Google review counts are counted BY HAND in v1 — no
 * Google connection — and are labelled as hand-counted in the
 * summary text. The contacts count comes from the real opt-in
 * records and is NOT labelled hand-counted. We do NOT track taps on
 * the Google link (the text carries Google's own page directly).
 *
 * Contact collection (Isaac-approved add-on, 2026-10-20): the
 * feedback form also carries an optional, clearly separate "keep me
 * posted" section — an email field and an UNCHECKED-by-default
 * opt-in box. It is NEVER a gate: the Google link is already in the
 * customer's text before they see this page, the Google door sits
 * above the form, and feedback saves identically whether the box is
 * ticked or not. The opt-in changes nothing about how the customer
 * is treated (same ask, same reminder rules, same 30-day cap).
 * Opted-in contacts are stored per business for the owner (inbox
 * list + CSV download). This tool only collects and stores them —
 * it never sends marketing emails or texts.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createTwilioAdapter } = require('./twilio');

// Copy: short and warm, neutral — no suggested rating, no "if you
// loved us…", no incentive. {placeholders} filled per send.
const DEFAULT_REQUEST =
  "Hi, this is {business_name} — thanks for visiting today! We'd love a Google review from you: {google_link} Or tell us privately how we did: {feedback_link} (Reply STOP to opt out)";
const DEFAULT_REMINDER =
  "Hi, this is {business_name} — a quick nudge from {day}: we'd love a Google review: {google_link} Or tell us privately: {feedback_link} (Reply STOP to opt out)";
const DEFAULT_FEEDBACK_HEADING = 'Tell {business_name} directly';
const DEFAULT_FEEDBACK_SUBLINE =
  'Private feedback goes only to the owner of {business_name} — never posted publicly. Prefer to leave a public review? Tap the Google review button above.';
const DEFAULT_FEEDBACK_THANKS =
  'Thanks — your feedback went straight to the owner of {business_name}.';
const DEFAULT_OWNER_ALERT =
  'New private feedback for {business_name} — read it here: {inbox_link}';
// "Keep me posted" opt-in wording (feedback page, checkbox label).
// Plain-language v1 consent copy — a lawyer has NOT reviewed it (see
// ASSUMPTIONS.md). The checkbox it labels is UNCHECKED by default.
const DEFAULT_CONTACTS_CONSENT =
  'Yes, keep me posted — {business_name} can email or text me about offers and updates. I can opt out any time.';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MONTHLY_CAP = 500; // Base plan cap: up to 500 review asks a month (Micah's tier list, 2026-10-20)
const DEFAULT_LINK_BASE = 'https://staging.howard-communications.example';
// A send that fails is retried from the queue instead of being dropped:
// up to MAX_SEND_ATTEMPTS tries, RETRY_DELAY_MS apart. Only a send that
// actually succeeds starts the customer's 30-day repeat-cap clock.
const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;
// Delivery statuses that mean "the ask really went out". Mock mode
// reports 'mock-sent'; real Twilio reports its own statuses. Anything
// else ('send-failed', 'failed', suppression notes, ...) is not a send.
const SUCCESS_SEND_STATUSES = new Set(['mock-sent', 'queued', 'sending', 'sent', 'delivered']);
// Automatic weekly summary: Mondays at 9:00 AM in the business's own
// timezone, at most once per business per week (guard is persisted).
const WEEKLY_SUMMARY_DAY_INDEX = 1; // Monday (DAY_NAMES index)
const WEEKLY_SUMMARY_MINUTES = 9 * 60; // 9:00 AM local

// ---------- CSV parsing (quoted fields supported; same as Tool 1) ----------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else { field += ch; }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function parseWindowMinutes(value, fallback) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

/*
 * Custom copy safety net (Micah's wording re-review rule). If a business
 * row carries custom request/reminder wording, it is validated here at
 * load time and REJECTED — the whole config fails to load with a plain-
 * English error naming the business and exactly what is missing — when
 * it drops either link placeholder ({google_link}, {feedback_link}) or
 * the 'Reply STOP to opt out' line. Subjective tone rules (no suggested
 * rating, no "if you loved us…", no offers) cannot be checked by code;
 * they are a manual read-through step in ONBOARDING.md.
 */
function validateCustomCopy(businessName, fieldName, template) {
  const t = String(template || '').trim();
  if (!t) return; // empty means "use the default copy", which is fine
  const missing = [];
  if (t.indexOf('{google_link}') === -1) missing.push('the {google_link} placeholder (the Google review link)');
  if (t.indexOf('{feedback_link}') === -1) missing.push('the {feedback_link} placeholder (the private-feedback link)');
  if (t.indexOf('Reply STOP to opt out') === -1) missing.push("the '(Reply STOP to opt out)' line");
  if (missing.length) {
    const msg = 'Cannot load "' + businessName + '": its custom ' + fieldName +
      ' is missing ' + missing.join(' and ') + '. Every customer text must carry both links and the opt-out line — ' +
      'dropping either link breaks the safe flow, and the opt-out line is legally required. Fix the wording and reload.';
    console.error('CONFIG ERROR: ' + msg);
    throw new Error(msg);
  }
}

function loadBusinesses(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('businesses.csv has no data rows: ' + csvPath);
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.join('').trim() !== '').map((r) => {
    const rec = {};
    header.forEach((h, i) => { rec[h] = (r[i] || '').trim(); });
    validateCustomCopy(rec.business_name, 'request_message', rec.request_message);
    validateCustomCopy(rec.business_name, 'reminder_message', rec.reminder_message);
    return {
      name: rec.business_name,
      twilioNumber: rec.twilio_number,
      ownerMobile: rec.owner_mobile,
      timezone: (rec.timezone || '').trim() || null, // IANA name, e.g. "America/New_York"
      googleReviewLink: rec.google_review_link,
      pageToken: rec.page_token, // per-business secret for the owner inbox link; regenerable
      apiSecret: rec.api_secret || '', // per-business secret required by the working POST endpoints
      sendDelayMinutes: Number(rec.send_delay_minutes || 15), // target: within 15 minutes of the tap
      monthlyRequestCap: Number(rec.monthly_request_cap || DEFAULT_MONTHLY_CAP),
      // Texts are only sent between these local times (the "send window").
      // Anything that would land outside it queues to the next opening.
      windowStartMin: parseWindowMinutes(rec.send_window_start, 8 * 60),
      windowEndMin: parseWindowMinutes(rec.send_window_end, 20 * 60),
      reminderDelayHours: Number(rec.reminder_delay_hours || 72),
      requestMessage: rec.request_message || DEFAULT_REQUEST,
      reminderMessage: rec.reminder_message || DEFAULT_REMINDER,
      feedbackHeading: rec.feedback_heading || DEFAULT_FEEDBACK_HEADING,
      feedbackSubline: rec.feedback_subline || DEFAULT_FEEDBACK_SUBLINE,
      feedbackThanks: rec.feedback_thanks_message || DEFAULT_FEEDBACK_THANKS,
      active: /^(true|yes|1|active)$/i.test(rec.active || ''),
      handCounts: null, // owner-entered: { googleReviewsSpotted, currentRating, updatedAt }
    };
  });
}

// ---------- Timezone helpers (same approach as Tool 1) ----------
const dtfCache = new Map();
function getFormatter(timeZone) {
  if (!dtfCache.has(timeZone)) {
    dtfCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
  }
  return dtfCache.get(timeZone);
}

function zonedParts(date, timeZone) {
  if (timeZone) {
    try {
      const parts = {};
      for (const part of getFormatter(timeZone).formatToParts(date)) parts[part.type] = part.value;
      const dayIndex = DAY_NAMES.indexOf(parts.weekday);
      if (dayIndex >= 0) {
        return {
          year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
          dayIndex, hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second || 0),
        };
      }
    } catch (err) {
      // Unknown timezone name in the config — fall through to local time.
    }
  }
  return {
    year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
    dayIndex: date.getDay(), hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds(),
  };
}

function tzOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  if (!timeZone) return new Date(year, month - 1, day, hour, minute, 0);
  let guess = wallAsUtc;
  for (let i = 0; i < 3; i++) guess = wallAsUtc - tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

function nextSendTime(business, date) {
  const start = business.windowStartMin;
  const end = business.windowEndMin;
  if (start === 0 && end >= 24 * 60) return date;
  const p = zonedParts(date, business.timezone);
  const nowMin = p.hour * 60 + p.minute;
  if (nowMin >= start && nowMin < end) return date;
  if (nowMin < start) {
    return zonedTimeToUtc(p.year, p.month, p.day, Math.floor(start / 60), start % 60, business.timezone);
  }
  const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedTimeToUtc(
    tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(),
    Math.floor(start / 60), start % 60, business.timezone
  );
}

function render(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
}

function isUsNumber(number) {
  return /^\+1\d{10}$/.test(String(number || ''));
}

// Deliberately simple v1 email check: something@something.something,
// no spaces. It exists to catch typos ("not-an-email", a missing @),
// not to prove an address is real or deliverable.
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());
}

/*
 * Normalize a phone number as staff/customers actually type it.
 * A bare 10-digit US number ("4045559999") and formatted versions
 * ("(404) 555-9998", "404-555-9998") are treated as +1 numbers, the
 * same as "14045559999" or "+14045559999". A leading + keeps its own
 * country code (so +44 ... stays a non-US number and is skipped as
 * such). Anything that doesn't reduce to digits is returned as-is so
 * the caller can reject it as unreadable, not as "non-US".
 */
function normalizeNumber(number) {
  const raw = String(number || '').trim();
  if (!raw) return '';
  if (raw[0] === '+') return '+' + raw.replace(/\D/g, '');
  const digits = raw.replace(/\D/g, '');
  if (/^\d{10}$/.test(digits)) return '+1' + digits;
  if (/^\d{11}$/.test(digits) && digits[0] === '1') return '+' + digits;
  return digits || raw;
}

// True when the value at least looks like a real phone number (a +
// followed by 7–15 digits) — used to tell "valid but not US" apart
// from "not a phone number at all" when logging why a job was skipped.
function looksLikePhoneNumber(number) {
  return /^\+\d{7,15}$/.test(String(number || ''));
}

function isSuccessfulSendStatus(status) {
  return SUCCESS_SEND_STATUSES.has(String(status || ''));
}

// Unguessable token (inbox links, feedback links): 144 bits of
// cryptographic randomness, URL-safe. Never derive from time or
// Math.random — a guessed inbox link reads a business's feedback.
function newToken() {
  return 't' + crypto.randomBytes(18).toString('base64url');
}

// ---------- Service ----------
function createService(config) {
  const cfg = config || {};
  const businesses = cfg.businesses || [];
  const adapter = cfg.adapter || createTwilioAdapter({ mode: 'mock' });
  const linkBase = (cfg.linkBase || process.env.LINK_BASE || DEFAULT_LINK_BASE).replace(/\/$/, '');
  const eventLogPath = cfg.eventLogPath || null;
  const sentLogPath = cfg.sentLogPath || null;
  const feedbackLogPath = cfg.feedbackLogPath || null;
  const statePath = cfg.statePath || null;
  const events = [];
  const sentMessages = [];
  const feedbackRecords = [];
  const contacts = []; // "keep me posted" opt-ins, per business, owner-only
  const suppressed = new Map();
  const lastAskAt = new Map();
  const sentThisMonth = new Map(); // twilioNumber|YYYY-MM (business's own clock) -> asks actually sent
  const queue = [];
  const asksByToken = new Map();
  const lastSummaryWeek = new Map(); // twilioNumber -> Monday date (business-local) of the last auto summary

  function appendLine(filePath, obj) {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
  }

  function readJsonLines(filePath) {
    if (!filePath) return [];
    try {
      return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch (e) { return null; }
      }).filter(Boolean);
    } catch (err) {
      return []; // no log yet — first run
    }
  }

  /*
   * PERSISTENCE. Chosen approach: a state snapshot file (JSON), written
   * atomically (temp file + rename) on every state change and loaded at
   * boot. The .jsonl logs cannot rebuild everything — a rotated inbox
   * token, for one, is deliberately never written to the event log with
   * its new value — so replaying logs was rejected. The snapshot holds
   * exactly the things a restart must never lose:
   *   - STOP suppressions (a stopped customer must NEVER be texted again)
   *   - lastAskAt (the 30-day repeat-cap clocks)
   *   - sentThisMonth (the fair-use counts)
   *   - feedback records, hand-entered Google counts, and the
   *     "keep me posted" contact list (the owner's customer list must
   *     not evaporate in a restart either)
   *   - pending queue items (asks/reminders not yet sent, with retries)
   *   - ask records (so feedback links and reminder rules survive)
   *   - each business's CURRENT inbox token (a rotation stays rotated —
   *     the token printed in businesses.csv does not come back to life)
   *   - the weekly-summary guard (at most one auto summary per week)
   * The in-memory log views (events / sent messages) are additionally
   * rehydrated from the existing .jsonl logs, which stay the canonical
   * human-readable trail; feedback comes from the snapshot when one
   * exists and falls back to feedback.jsonl on first boot.
   */
  function saveState() {
    if (!statePath) return;
    const snapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      suppressed: {},
      lastAskAt: {},
      sentThisMonth: {},
      lastSummaryWeek: {},
      handCounts: {},
      pageTokens: {},
      feedback: feedbackRecords,
      contacts: contacts,
      queue: queue.map((item) => ({
        type: item.type, businessNumber: item.business.twilioNumber,
        customer: item.customer, token: item.token,
        dueAt: item.dueAt, jobAt: item.jobAt, attempts: item.attempts || 0,
      })),
      asks: {},
    };
    for (const [k, v] of suppressed) snapshot.suppressed[k] = Array.from(v);
    for (const [k, v] of lastAskAt) snapshot.lastAskAt[k] = v;
    for (const [k, v] of sentThisMonth) snapshot.sentThisMonth[k] = v;
    for (const [k, v] of lastSummaryWeek) snapshot.lastSummaryWeek[k] = v;
    for (const b of businesses) {
      if (b.handCounts) snapshot.handCounts[b.twilioNumber] = b.handCounts;
      if (b.pageToken) snapshot.pageTokens[b.twilioNumber] = b.pageToken;
    }
    for (const [token, ask] of asksByToken) {
      snapshot.asks[token] = {
        businessNumber: ask.business.twilioNumber, customer: ask.customer,
        jobAt: ask.jobAt, sentAt: ask.sentAt, source: ask.source || 'staff',
        clickedFeedbackPage: !!ask.clickedFeedbackPage, replied: !!ask.replied,
        feedbackSubmitted: !!ask.feedbackSubmitted, reminderSent: !!ask.reminderSent,
      };
    }
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const tmpPath = statePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 1));
      fs.renameSync(tmpPath, statePath);
    } catch (err) {
      // A failed save must not crash a send, but it must be loud: the
      // next restart would lose state without it.
      console.error('WARNING: could not save service state to ' + statePath + ': ' + err.message);
    }
  }

  function restoreState() {
    // Rehydrate the log views from the canonical .jsonl trails.
    for (const e of readJsonLines(eventLogPath)) events.push(e);
    for (const m of readJsonLines(sentLogPath)) sentMessages.push(m);
    let snapshot = null;
    if (statePath) {
      try { snapshot = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (err) { snapshot = null; }
    }
    if (!snapshot) {
      for (const f of readJsonLines(feedbackLogPath)) feedbackRecords.push(f);
      return;
    }
    for (const [num, customers] of Object.entries(snapshot.suppressed || {})) {
      suppressed.set(num, new Set(customers));
    }
    for (const [k, v] of Object.entries(snapshot.lastAskAt || {})) lastAskAt.set(k, v);
    for (const [k, v] of Object.entries(snapshot.sentThisMonth || {})) sentThisMonth.set(k, v);
    for (const [k, v] of Object.entries(snapshot.lastSummaryWeek || {})) lastSummaryWeek.set(k, v);
    for (const record of snapshot.feedback || []) feedbackRecords.push(record);
    for (const contact of snapshot.contacts || []) contacts.push(contact);
    for (const b of businesses) {
      // The snapshot's token wins over the CSV: a rotated link stays rotated.
      if (snapshot.pageTokens && snapshot.pageTokens[b.twilioNumber]) b.pageToken = snapshot.pageTokens[b.twilioNumber];
      if (snapshot.handCounts && snapshot.handCounts[b.twilioNumber]) b.handCounts = snapshot.handCounts[b.twilioNumber];
    }
    for (const item of snapshot.queue || []) {
      const business = findBusiness(item.businessNumber);
      if (!business) continue; // business removed from the config sheet — drop its queue
      queue.push({
        type: item.type, business, customer: item.customer, token: item.token,
        dueAt: item.dueAt, jobAt: item.jobAt, attempts: item.attempts || 0,
      });
    }
    for (const [token, a] of Object.entries(snapshot.asks || {})) {
      const business = findBusiness(a.businessNumber);
      if (!business) continue;
      asksByToken.set(token, {
        business, customer: a.customer, jobAt: a.jobAt, sentAt: a.sentAt, source: a.source || 'staff',
        clickedFeedbackPage: !!a.clickedFeedbackPage, replied: !!a.replied,
        feedbackSubmitted: !!a.feedbackSubmitted, reminderSent: !!a.reminderSent,
      });
    }
  }

  function logEvent(event) {
    const entry = Object.assign({
      timestamp: new Date().toISOString(),
      business: null, customer: null, event_type: null,
      message_variant: null, delivery_status: null, detail: null,
    }, event);
    events.push(entry);
    appendLine(eventLogPath, entry);
    return entry;
  }

  async function send(record) {
    const result = await adapter.sendSms(record);
    const sent = Object.assign({}, record, { sid: result.sid, status: result.status });
    sentMessages.push(sent);
    appendLine(sentLogPath, sent);
    return sent;
  }

  function findBusiness(twilioNumber) {
    return businesses.find((b) => b.twilioNumber === twilioNumber) || null;
  }

  function findBusinessByPageToken(pageToken) {
    return businesses.find((b) => b.pageToken === pageToken) || null;
  }

  function isSuppressed(business, customer) {
    const set = suppressed.get(business.twilioNumber);
    return !!set && set.has(customer);
  }

  function addSuppression(business, customer) {
    if (!suppressed.has(business.twilioNumber)) suppressed.set(business.twilioNumber, new Set());
    suppressed.get(business.twilioNumber).add(customer);
  }

  // Fair-use cap: asks actually sent this calendar month (on the
  // business's own clock). Base plan limit per Micah's tier list (500/mo).
  function monthKey(business, at) {
    const p = zonedParts(at, business.timezone);
    return business.twilioNumber + '|' + p.year + '-' + String(p.month).padStart(2, '0');
  }

  function feedbackLink(token) {
    return linkBase + '/r/' + token + '/feedback';
  }

  function inboxLink(business) {
    return linkBase + '/inbox/' + business.pageToken;
  }

  // The staff send page: one phone field, one big "send" button, one
  // small "do not send" form. Reached via the business's own secret
  // link — the same token as the inbox, so rotation rotates both.
  function staffLink(business) {
    return linkBase + '/staff/' + business.pageToken;
  }

  function handleJobDone(params, now) {
    const at = now || new Date();
    const business = findBusiness(normalizeNumber(params.Business || params.To));
    const rawCustomer = String(params.Customer || params.From || '');
    const customer = normalizeNumber(rawCustomer);
    if (!business) {
      logEvent({ timestamp: at.toISOString(), customer, event_type: 'job-done', delivery_status: 'skipped (unknown business number)', detail: 'no business configured for ' + (params.Business || params.To) });
      return { action: 'skipped', reason: 'unknown-business' };
    }
    if (!business.active) {
      logEvent({ timestamp: at.toISOString(), business: business.name, customer, event_type: 'job-done', delivery_status: 'skipped (business inactive)' });
      return { action: 'skipped', reason: 'inactive' };
    }
    // Bare 10-digit and formatted US numbers are accepted by
    // normalizeNumber; what reaches here but is not a US number is
    // either a valid foreign number or not a number at all — logged
    // with the real reason, never as a generic "non-US".
    if (!isUsNumber(customer)) {
      if (looksLikePhoneNumber(customer)) {
        logEvent({ timestamp: at.toISOString(), business: business.name, customer, event_type: 'job-done', delivery_status: 'skipped (non-US number)', detail: 'the number looks like a valid phone number but is not a US (+1) number; only US numbers are texted' });
        return { action: 'skipped', reason: 'non-us' };
      }
      logEvent({ timestamp: at.toISOString(), business: business.name, customer: rawCustomer, event_type: 'job-done', delivery_status: 'skipped (invalid number)', detail: 'could not read a phone number from "' + rawCustomer + '" — nothing was queued' });
      return { action: 'skipped', reason: 'invalid-number' };
    }
    if (isSuppressed(business, customer)) {
      logEvent({ timestamp: at.toISOString(), business: business.name, customer, event_type: 'job-done', delivery_status: 'suppressed (STOP)' });
      return { action: 'suppressed', reason: 'stop' };
    }
    const capKey = business.twilioNumber + '|' + customer;
    const last = lastAskAt.get(capKey);
    if (last !== undefined && at.getTime() - last < THIRTY_DAYS_MS) {
      logEvent({
        timestamp: at.toISOString(), business: business.name, customer, event_type: 'job-done',
        delivery_status: 'suppressed (repeat cap)',
        detail: 'last review ask for this customer was ' + new Date(last).toISOString() + '; cap is one ask per 30 days per business',
      });
      return { action: 'suppressed', reason: 'repeat-cap' };
    }
    // A failed send must not burn the 30-day clock — so the clock is
    // only set when a send actually succeeds (see processDue). But a
    // double-tap by staff must not queue two asks either: if an ask is
    // already waiting for this customer, treat this report the same
    // as a repeat inside the cap.
    const alreadyQueued = queue.some((q) => q.type === 'ask' && q.business === business && q.customer === customer);
    if (alreadyQueued) {
      logEvent({
        timestamp: at.toISOString(), business: business.name, customer, event_type: 'job-done',
        delivery_status: 'suppressed (repeat cap)',
        detail: 'a review ask is already queued for this customer; the 30-day clock starts when a send actually succeeds',
      });
      return { action: 'suppressed', reason: 'repeat-cap' };
    }
    const sent = sentThisMonth.get(monthKey(business, at)) || 0;
    if (sent >= business.monthlyRequestCap) {
      logEvent({
        timestamp: at.toISOString(), business: business.name, customer, event_type: 'job-done',
        delivery_status: 'suppressed (fair-use cap)',
        detail: 'fair-use cap of ' + business.monthlyRequestCap + ' review asks per month reached for this business (Base plan limit; overages handled by hand for now)',
      });
      return { action: 'suppressed', reason: 'fair-use-cap' };
    }
    const token = newToken();
    const sendAt = nextSendTime(business, new Date(at.getTime() + business.sendDelayMinutes * 60000));
    queue.push({ type: 'ask', business, customer, token, dueAt: sendAt.getTime(), jobAt: at.getTime(), attempts: 0 });
    asksByToken.set(token, {
      business, customer, jobAt: at.getTime(), sentAt: null,
      clickedFeedbackPage: false, replied: false,
      feedbackSubmitted: false, reminderSent: false,
    });
    saveState();
    logEvent({
      timestamp: at.toISOString(), business: business.name, customer, event_type: 'job-done',
      delivery_status: 'queued', detail: 'review ask queued for ' + sendAt.toISOString() + ' (delay ' + business.sendDelayMinutes + ' min, inside send window)',
    });
    return { action: 'queued', token, sendAt };
  }

  /*
   * SELF-SERVE "text me the link" (Isaac-approved workaround,
   * 2026-10-21). A customer standing at the counter (or holding the
   * receipt) scans the counter code and, instead of relying on staff
   * having their number, types their OWN number into the box on the
   * counter page and asks for the link by text. That typed request
   * IS the opt-in: the customer asked for this one text themselves.
   *
   * The ask then runs through the exact same machinery as a staff
   * send — same two-link text, same sender (the business's own
   * number), same STOP list, same 30-day repeat cap, same 500/month
   * fair-use cap, same reminder rules afterwards — with two
   * deliberate differences, both consequences of the customer asking
   * on the spot:
   *   - NO 15-minute delay: the ask is due immediately (still inside
   *     the business's send window — a scan at 11 PM queues to the
   *     next morning's window open, like any other ask).
   *   - It is logged with event_type 'self-serve' and the ask record
   *     carries source 'self-serve', so the owner can see how the
   *     ask started.
   * Sends and retries happen in processDue, exactly like staff asks:
   * a failed send is retried (3 attempts), never silently dropped,
   * and only a successful send counts toward the monthly cap and
   * starts the 30-day clock.
   */
  function handleSelfServeAsk(business, rawNumber, now) {
    const at = now || new Date();
    const rawCustomer = String(rawNumber || '');
    const customer = normalizeNumber(rawCustomer);
    if (!business) {
      logEvent({ timestamp: at.toISOString(), customer, event_type: 'self-serve', delivery_status: 'skipped (unknown business number)', detail: 'self-serve request for a business that is not configured — nothing was queued' });
      return { action: 'skipped', reason: 'unknown-business' };
    }
    if (!business.active) {
      logEvent({ timestamp: at.toISOString(), business: business.name, customer, event_type: 'self-serve', delivery_status: 'skipped (business inactive)' });
      return { action: 'skipped', reason: 'inactive' };
    }
    if (!isUsNumber(customer)) {
      if (looksLikePhoneNumber(customer)) {
        logEvent({ timestamp: at.toISOString(), business: business.name, customer, event_type: 'self-serve', delivery_status: 'skipped (non-US number)', detail: 'self-serve: the number looks like a valid phone number but is not a US (+1) number; only US numbers are texted' });
        return { action: 'skipped', reason: 'non-us' };
      }
      logEvent({ timestamp: at.toISOString(), business: business.name, customer: rawCustomer, event_type: 'self-serve', delivery_status: 'skipped (invalid number)', detail: 'self-serve: could not read a phone number from "' + rawCustomer + '" — nothing was queued' });
      return { action: 'skipped', reason: 'invalid-number' };
    }
    if (isSuppressed(business, customer)) {
      logEvent({ timestamp: at.toISOString(), business: business.name, customer, event_type: 'self-serve', delivery_status: 'suppressed (STOP)', detail: 'self-serve: this number is on the business STOP list — no text was sent; the customer can still use the links on the page' });
      return { action: 'suppressed', reason: 'stop' };
    }
    const capKey = business.twilioNumber + '|' + customer;
    const last = lastAskAt.get(capKey);
    if (last !== undefined && at.getTime() - last < THIRTY_DAYS_MS) {
      logEvent({
        timestamp: at.toISOString(), business: business.name, customer, event_type: 'self-serve',
        delivery_status: 'suppressed (repeat cap)',
        detail: 'self-serve: last review ask for this customer was ' + new Date(last).toISOString() + '; cap is one ask per 30 days per business — nothing sent',
      });
      return { action: 'suppressed', reason: 'repeat-cap' };
    }
    const alreadyQueued = queue.some((q) => q.type === 'ask' && q.business === business && q.customer === customer);
    if (alreadyQueued) {
      logEvent({
        timestamp: at.toISOString(), business: business.name, customer, event_type: 'self-serve',
        delivery_status: 'suppressed (repeat cap)',
        detail: 'self-serve: a review ask is already queued for this customer; the 30-day clock starts when a send actually succeeds',
      });
      return { action: 'suppressed', reason: 'repeat-cap' };
    }
    const sent = sentThisMonth.get(monthKey(business, at)) || 0;
    if (sent >= business.monthlyRequestCap) {
      logEvent({
        timestamp: at.toISOString(), business: business.name, customer, event_type: 'self-serve',
        delivery_status: 'suppressed (fair-use cap)',
        detail: 'self-serve: fair-use cap of ' + business.monthlyRequestCap + ' review asks per month reached for this business (Base plan limit; overages handled by hand for now)',
      });
      return { action: 'suppressed', reason: 'fair-use-cap' };
    }
    const token = newToken();
    const sendAt = nextSendTime(business, at); // right away — no 15-minute wait — but never outside the send window
    queue.push({ type: 'ask', business, customer, token, dueAt: sendAt.getTime(), jobAt: at.getTime(), attempts: 0 });
    asksByToken.set(token, {
      business, customer, jobAt: at.getTime(), sentAt: null, source: 'self-serve',
      clickedFeedbackPage: false, replied: false,
      feedbackSubmitted: false, reminderSent: false,
    });
    saveState();
    logEvent({
      timestamp: at.toISOString(), business: business.name, customer, event_type: 'self-serve',
      delivery_status: 'queued', detail: 'self-serve: the customer typed their own number on the counter page and asked for the link (that typed request is the opt-in) — review ask queued for ' + sendAt.toISOString() + ' (right away, no 15-minute wait; source: self-serve)',
    });
    return { action: 'queued', token, sendAt };
  }

  /*
   * "Do not send" hold — for MISTAKES ONLY (wrong number, duplicate
   * record). Cancels this customer's queued asks/reminders. A hold
   * REQUIRES a written reason and is logged with it; without a reason
   * the hold is rejected. This must never be used to skip someone
   * because they might leave a bad review — that would be the same
   * screening trick the safe flow rules out. A held customer is NOT
   * suppressed and can be re-reported later.
   */
  function handleHold(params, now) {
    const at = now || new Date();
    const business = findBusiness(normalizeNumber(params.Business || params.To));
    const customer = normalizeNumber(params.Customer || params.From);
    const reason = String(params.reason || params.Reason || '').trim();
    if (!business) return { action: 'rejected', reason: 'unknown-business' };
    if (!reason) {
      logEvent({
        timestamp: at.toISOString(), business: business.name, customer, event_type: 'job-hold',
        delivery_status: 'rejected (no reason)', detail: 'hold rejected: a reason is required (wrong number, duplicate record, ...)',
      });
      return { action: 'rejected', reason: 'reason-required' };
    }
    let cancelled = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].business === business && queue[i].customer === customer) { queue.splice(i, 1); cancelled++; }
    }
    // The 30-day clock only starts when a send actually succeeds (see
    // processDue), so a held report — whose ask never went out — leaves
    // no cap marker behind: the (corrected) customer can be re-reported
    // right away. An earlier successfully sent ask keeps its own clock.
    saveState();
    logEvent({
      timestamp: at.toISOString(), business: business.name, customer, event_type: 'job-hold',
      delivery_status: 'held (do not send)', detail: 'queued texts cancelled: ' + cancelled + '. Reason: ' + reason,
    });
    return { action: 'held', cancelled, reason };
  }

  /*
   * A queue item is never dropped before its send succeeds. If the send
   * throws (carrier/Twilio failure), the item stays in the queue with
   * its attempt count raised and is retried RETRY_DELAY_MS later, up
   * to MAX_SEND_ATTEMPTS. After the last attempt a final 'failed' event
   * is logged and the item is dropped — loudly, never silently. Only a
   * successful send: counts toward the monthly fair-use cap, queues the
   * reminder, marks the ask sent, and starts the customer's 30-day
   * repeat-cap clock. A failed send does none of those.
   */
  function removeFromQueue(item) {
    const i = queue.indexOf(item);
    if (i !== -1) queue.splice(i, 1);
  }

  function noteSendFailure(item, at, err) {
    item.attempts = (item.attempts || 0) + 1;
    const { business, customer } = item;
    const errText = String((err && err.message) || err);
    if (item.attempts >= MAX_SEND_ATTEMPTS) {
      removeFromQueue(item);
      logEvent({
        timestamp: at.toISOString(), business: business.name, customer, event_type: item.type,
        delivery_status: 'failed',
        detail: item.type + ' send failed after ' + item.attempts + ' attempts (' + errText +
          ') — giving up. The customer was NOT charged a fair-use slot and the 30-day clock was NOT started.',
      });
      saveState();
      return 'send-failed-final';
    }
    item.dueAt = at.getTime() + RETRY_DELAY_MS;
    logEvent({
      timestamp: at.toISOString(), business: business.name, customer, event_type: item.type,
      delivery_status: 'send-failed',
      detail: item.type + ' send failed (attempt ' + item.attempts + ' of ' + MAX_SEND_ATTEMPTS + ': ' + errText +
        ') — will retry at ' + new Date(item.dueAt).toISOString() + '. Nothing counted yet.',
    });
    saveState();
    return 'send-failed';
  }

  async function processDue(now) {
    const at = now || new Date();
    const due = queue.filter((q) => q.dueAt <= at.getTime()).sort((a, b) => a.dueAt - b.dueAt);
    const outcomes = [];
    for (const item of due) {
      const { business, customer, token } = item;
      const ask = asksByToken.get(token);
      if (item.type === 'ask') {
        if (isSuppressed(business, customer)) {
          removeFromQueue(item);
          logEvent({ timestamp: at.toISOString(), business: business.name, customer, event_type: 'ask', delivery_status: 'suppressed (STOP)', detail: 'customer opted out after the job was reported; queued ask cancelled' });
          outcomes.push({ type: 'ask', action: 'suppressed-stop', customer });
          saveState();
          continue;
        }
        // Re-check the fair-use cap at send time too — the queue may
        // have filled the month since the job was reported.
        const sent = sentThisMonth.get(monthKey(business, at)) || 0;
        if (sent >= business.monthlyRequestCap) {
          removeFromQueue(item);
          logEvent({ timestamp: at.toISOString(), business: business.name, customer, event_type: 'ask', delivery_status: 'suppressed (fair-use cap)', detail: 'cap of ' + business.monthlyRequestCap + ' per month reached before send' });
          outcomes.push({ type: 'ask', action: 'suppressed-cap', customer });
          saveState();
          continue;
        }
        const body = render(business.requestMessage, {
          business_name: business.name,
          google_link: business.googleReviewLink,
          feedback_link: feedbackLink(token),
        });
        let sentText;
        try {
          sentText = await send({ from: business.twilioNumber, to: customer, body, kind: 'review-ask' });
        } catch (err) {
          outcomes.push({ type: 'ask', action: noteSendFailure(item, at, err), customer });
          continue;
        }
        removeFromQueue(item);
        sentThisMonth.set(monthKey(business, at), sent + 1);
        // The 30-day repeat-cap clock starts HERE — only when the ask
        // actually went out. A failed/retried send never starts it.
        lastAskAt.set(business.twilioNumber + '|' + customer, at.getTime());
        if (ask) ask.sentAt = at.getTime();
        logEvent({
          timestamp: at.toISOString(), business: business.name, customer, event_type: 'ask',
          message_variant: 'review-ask', delivery_status: sentText.status, detail: body,
        });
        if (business.reminderDelayHours > 0) {
          const reminderAt = nextSendTime(business, new Date(at.getTime() + business.reminderDelayHours * 3600000));
          queue.push({ type: 'reminder', business, customer, token, dueAt: reminderAt.getTime(), jobAt: item.jobAt, attempts: 0 });
        }
        saveState();
        outcomes.push({ type: 'ask', action: 'sent', customer, token });
      } else { // reminder
        const engaged = ask && (ask.replied || ask.clickedFeedbackPage || ask.feedbackSubmitted);
        if (isSuppressed(business, customer)) {
          removeFromQueue(item);
          logEvent({ timestamp: at.toISOString(), business: business.name, customer, event_type: 'reminder', delivery_status: 'suppressed (STOP)' });
          outcomes.push({ type: 'reminder', action: 'suppressed-stop', customer });
          saveState();
          continue;
        }
        if (engaged) {
          removeFromQueue(item);
          const why = ask.feedbackSubmitted ? 'feedback submitted' : ask.replied ? 'customer replied' : 'feedback page visited';
          logEvent({ timestamp: at.toISOString(), business: business.name, customer, event_type: 'reminder', delivery_status: 'suppressed (engaged)', detail: 'reminder not sent: ' + why });
          outcomes.push({ type: 'reminder', action: 'suppressed-engaged', customer });
          saveState();
          continue;
        }
        if (!ask || ask.reminderSent) {
          removeFromQueue(item);
          outcomes.push({ type: 'reminder', action: 'already-sent', customer });
          saveState();
          continue;
        }
        const jobDay = DAY_NAMES_FULL[zonedParts(new Date(item.jobAt), business.timezone).dayIndex];
        const body = render(business.reminderMessage, {
          business_name: business.name,
          google_link: business.googleReviewLink,
          feedback_link: feedbackLink(token), day: jobDay,
        });
        let sentText;
        try {
          sentText = await send({ from: business.twilioNumber, to: customer, body, kind: 'review-reminder' });
        } catch (err) {
          outcomes.push({ type: 'reminder', action: noteSendFailure(item, at, err), customer });
          continue;
        }
        removeFromQueue(item);
        ask.reminderSent = true;
        logEvent({
          timestamp: at.toISOString(), business: business.name, customer, event_type: 'reminder',
          message_variant: 'review-reminder', delivery_status: sentText.status, detail: body,
        });
        saveState();
        outcomes.push({ type: 'reminder', action: 'sent', customer });
      }
    }
    return outcomes;
  }

  async function handleInboundSms(params, now) {
    const at = now || new Date();
    const business = findBusiness(normalizeNumber(params.To));
    const from = normalizeNumber(params.From);
    const body = String(params.Body || '');
    if (!business) {
      logEvent({ timestamp: at.toISOString(), customer: from, event_type: 'inbound-sms', delivery_status: 'skipped (unknown business number)', detail: body });
      return { action: 'skipped', reason: 'unknown-business' };
    }
    const word = body.trim().toUpperCase().replace(/[.!]$/, '');
    if (STOP_WORDS.has(word)) {
      addSuppression(business, from);
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].business === business && queue[i].customer === from) queue.splice(i, 1);
      }
      // Persisted immediately: a restart must never text a STOPped customer again.
      saveState();
      logEvent({
        timestamp: at.toISOString(), business: business.name, customer: from, event_type: 'inbound-sms',
        message_variant: 'STOP', delivery_status: 'suppressed (STOP)', detail: body + ' — customer permanently suppressed for this business; queued texts cancelled',
      });
      return { action: 'stop-recorded' };
    }
    if (from === business.ownerMobile) {
      logEvent({ timestamp: at.toISOString(), business: business.name, customer: from, event_type: 'inbound-sms', delivery_status: 'owner message logged (no action in v1)', detail: body });
      return { action: 'owner-message-logged' };
    }
    for (const ask of asksByToken.values()) {
      if (ask.business === business && ask.customer === from) ask.replied = true;
    }
    logEvent({
      timestamp: at.toISOString(), business: business.name, customer: from, event_type: 'inbound-sms',
      message_variant: 'customer-reply', delivery_status: 'received', detail: body,
    });
    const forwardBody = 'Reply from ' + from + ' (' + business.name + '): ' + body;
    const fwd = await send({ from: business.twilioNumber, to: business.ownerMobile, body: forwardBody, kind: 'customer-reply-forward' });
    logEvent({
      timestamp: at.toISOString(), business: business.name, customer: from, event_type: 'inbound-sms',
      message_variant: 'customer-reply-forward', delivery_status: fwd.status, detail: forwardBody,
    });
    return { action: 'reply-forwarded' };
  }

  /*
   * "Keep me posted" contact collection. The customer ticked an
   * UNCHECKED-by-default box on the feedback page and (optionally)
   * left an email. The record is stored for the OWNER only — the
   * shop is building a customer list it owns. The opt-in changes
   * NOTHING about how the customer is treated: same ask, same
   * reminder rules, same 30-day cap. Nothing is ever sent to these
   * contacts by this tool (collect and store only).
   *
   * Graceful-failure choice: if the customer ticks the box but the
   * email they typed is not a readable email address, the feedback
   * still saves exactly as before and NO contact is stored (a broken
   * address would only pollute the owner's list) — and the skip is
   * logged, so the owner can see it happened. If the box is ticked
   * with no email at all, the contact is stored with the phone we
   * already have (the ask's customer number, or the "best number"
   * field) and no email.
   *
   * Dedupe: the same email (or phone) opting in twice for the same
   * business stays ONE record — its date is refreshed, never doubled.
   */
  function recordContact(business, ask, fields, at) {
    const name = String(fields.name || '').trim();
    const emailRaw = String(fields.email || '').trim();
    const email = emailRaw || null;
    const contactNumber = normalizeNumber(fields.contact_number || '');
    const phone = (ask && ask.customer) || (looksLikePhoneNumber(contactNumber) ? contactNumber : null);
    if (emailRaw && !isValidEmail(emailRaw)) {
      logEvent({
        timestamp: at.toISOString(), business: business.name, customer: ask ? ask.customer : null,
        event_type: 'contact-opt-in', delivery_status: 'skipped (invalid email)',
        detail: 'customer ticked "keep me posted" but the email typed ("' + emailRaw + '") is not a readable email address — feedback saved as usual, no contact stored',
      });
      return null;
    }
    if (!email && !phone) {
      logEvent({
        timestamp: at.toISOString(), business: business.name, customer: ask ? ask.customer : null,
        event_type: 'contact-opt-in', delivery_status: 'skipped (no contact details)',
        detail: 'customer ticked "keep me posted" but left no email and no reachable number — nothing stored',
      });
      return null;
    }
    const emailKey = email ? email.toLowerCase() : null;
    const existing = contacts.find((c) => c.business === business.name &&
      ((emailKey && c.email && c.email.toLowerCase() === emailKey) || (phone && c.phone === phone)));
    if (existing) {
      existing.timestamp = at.toISOString();
      if (name) existing.name = name;
      if (email && !existing.email) existing.email = email;
      if (phone && !existing.phone) existing.phone = phone;
      logEvent({
        timestamp: at.toISOString(), business: business.name, customer: ask ? ask.customer : null,
        event_type: 'contact-opt-in', delivery_status: 'updated (already on the list)',
        detail: 'customer opted in again — still one contact record for this business; its date was refreshed',
      });
      return existing;
    }
    const contact = { business: business.name, timestamp: at.toISOString(), name, email, phone, optIn: true };
    contacts.push(contact);
    logEvent({
      timestamp: at.toISOString(), business: business.name, customer: ask ? ask.customer : null,
      event_type: 'contact-opt-in', delivery_status: 'recorded',
      detail: 'customer opted in ("keep me posted") on the feedback page — contact stored for the owner only; this tool never sends anything to it',
    });
    return contact;
  }

  /*
   * Private feedback submission. The rating is OPTIONAL, 1–5, and
   * clearly "only the owner sees this" — it is stored for the owner's
   * records and NEVER used to steer, sort, or suppress. There is no
   * code path anywhere that branches on it (search the file: the only
   * places `rating` appears are storing it and showing it to the
   * owner). Goes ONLY to the owner of that business; the owner gets
   * an instant alert text. NO thank-you text is sent to the customer
   * (Mica's Q11: the on-page thank-you is enough; one more text risks
   * annoying people and costs money).
   */
  async function recordFeedback(token, fields, now) {
    const at = now || new Date();
    const ask = asksByToken.get(token);
    if (!ask) return null;
    const business = ask.business;
    let rating = null;
    const rawRating = Number(String(fields.rating || '').trim());
    if (rawRating >= 1 && rawRating <= 5 && Number.isInteger(rawRating)) rating = rawRating;
    const record = {
      timestamp: at.toISOString(),
      business: business.name,
      customer: ask.customer,
      name: (fields.name || '').trim(),
      message: (fields.message || '').trim(),
      rating, // optional, owner-only; never used for steering
      make_it_right: (fields.make_it_right || '').trim(),
      contact_ok: /^(yes|true|1)$/i.test(String(fields.contact_ok || '')),
      contact_number: normalizeNumber(fields.contact_number || '') || null,
      read: false,
      handled: false,
    };
    feedbackRecords.push(record);
    appendLine(feedbackLogPath, record);
    // Optional "keep me posted" opt-in — entirely separate from the
    // feedback itself. The box is UNCHECKED by default; unticked
    // stores nothing and changes nothing, and the feedback above has
    // already saved identically either way. An opt-in never feeds
    // back into any decision about this customer (no branch reads it).
    if (/^(yes|on|true|1)$/i.test(String(fields.keep_posted || ''))) {
      recordContact(business, ask, fields, at);
    }
    ask.feedbackSubmitted = true;
    saveState();
    logEvent({
      timestamp: at.toISOString(), business: business.name, customer: ask.customer, event_type: 'feedback',
      delivery_status: 'received', detail: 'private feedback received (content stored in feedback records, owner-only)',
    });
    const alertBody = render(DEFAULT_OWNER_ALERT, { business_name: business.name, inbox_link: inboxLink(business) });
    const alert = await send({ from: business.twilioNumber, to: business.ownerMobile, body: alertBody, kind: 'owner-feedback-alert' });
    logEvent({
      timestamp: at.toISOString(), business: business.name, customer: ask.customer, event_type: 'feedback',
      message_variant: 'owner-notification', delivery_status: alert.status, detail: alertBody,
    });
    return { record, confirmation: render(business.feedbackThanks, { business_name: business.name }) };
  }

  function getFeedback(business) {
    return feedbackRecords.filter((f) => f.business === business.name);
  }

  function getContacts(business) {
    return contacts.filter((c) => c.business === business.name);
  }

  function csvField(value) {
    const s = String(value == null ? '' : value);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // The owner's downloadable customer list: name, email, phone, and
  // the date they opted in. Only that business's contacts, ever.
  function contactsCsv(business) {
    const lines = ['name,email,phone,opted_in_date'];
    for (const c of getContacts(business)) {
      lines.push([csvField(c.name), csvField(c.email), csvField(c.phone),
        csvField(String(c.timestamp || '').slice(0, 10))].join(','));
    }
    return lines.join('\n') + '\n';
  }

  /*
   * Owner inbox link rotation. If the secret link ever leaks, make a
   * new one: the old token stops working immediately.
   */
  function rotatePageToken(business, now) {
    const at = now || new Date();
    const oldToken = business.pageToken;
    business.pageToken = newToken();
    // Persisted immediately: the snapshot's token wins over the CSV on
    // the next boot, so a rotated link stays rotated across restarts.
    saveState();
    logEvent({
      timestamp: at.toISOString(), business: business.name, event_type: 'token-rotate',
      delivery_status: 'rotated', detail: 'owner inbox link regenerated; the previous link no longer works',
    });
    return { oldToken, link: inboxLink(business) };
  }

  /*
   * Hand-entered Google counts for v1 (Q6): the owner/staffer reads
   * the business's Google listing and types in what they see — new
   * reviews spotted since last time and the current star rating.
   * The weekly summary prints these with "counted by hand" next to
   * them so nobody mistakes them for automatic numbers.
   */
  function setHandCounts(business, counts, now) {
    const at = now || new Date();
    const spotted = Number(String(counts.google_reviews_spotted || '').trim());
    const rating = Number(String(counts.current_rating || '').trim());
    if (!Number.isInteger(spotted) || spotted < 0) return { action: 'rejected', reason: 'bad-spotted' };
    if (Number.isNaN(rating) || rating < 0 || rating > 5) return { action: 'rejected', reason: 'bad-rating' };
    business.handCounts = { googleReviewsSpotted: spotted, currentRating: rating, updatedAt: at.toISOString() };
    saveState();
    logEvent({
      timestamp: at.toISOString(), business: business.name, event_type: 'hand-counts',
      delivery_status: 'recorded', detail: 'owner entered by hand: ' + spotted + ' new Google reviews spotted, current rating ' + rating,
    });
    return { action: 'recorded' };
  }

  function buildSummary(business, now, days) {
    const at = now || new Date();
    const span = (days || 7) * 24 * 3600000;
    const inSpan = events.filter((e) => {
      if (e.business !== business.name) return false;
      const age = at.getTime() - new Date(e.timestamp).getTime();
      return age >= 0 && age <= span;
    });
    // Count contacts collected in the span — from the actual opt-in
    // records (their stored dates), never counted by hand.
    const contactsInSpan = contacts.filter((c) => {
      if (c.business !== business.name) return false;
      const age = at.getTime() - new Date(c.timestamp).getTime();
      return age >= 0 && age <= span;
    }).length;
    // Count asks that really went out — 'mock-sent' in test mode, or
    // any of Twilio's own successful statuses live ('sent',
    // 'delivered', ...). Failed/suppressed asks are never counted.
    return {
      asksSent: inSpan.filter((e) => e.event_type === 'ask' && isSuccessfulSendStatus(e.delivery_status)).length,
      feedbackReceived: inSpan.filter((e) => e.event_type === 'feedback' && e.delivery_status === 'received').length,
      contactsCollected: contactsInSpan,
      googleReviewsSpotted: business.handCounts ? business.handCounts.googleReviewsSpotted : null,
      currentRating: business.handCounts ? business.handCounts.currentRating : null,
    };
  }

  function summaryText(business, counts) {
    const spotted = counts.googleReviewsSpotted === null || counts.googleReviewsSpotted === undefined
      ? 'not yet entered by hand'
      : counts.googleReviewsSpotted + ' new Google reviews spotted (counted by hand)';
    const rating = counts.currentRating === null || counts.currentRating === undefined
      ? 'not yet entered by hand'
      : 'rating ' + counts.currentRating + ' (from your Google listing, counted by hand)';
    return 'Weekly review summary for ' + business.name + ': ' +
      counts.asksSent + ' review asks sent, ' +
      counts.feedbackReceived + ' private feedback notes received, ' +
      (counts.contactsCollected || 0) + ' new contacts collected (through the feedback page), ' +
      spotted + ', ' + rating + '.';
  }

  async function sendWeeklySummary(business, now) {
    const at = now || new Date();
    const counts = buildSummary(business, at, 7);
    const body = summaryText(business, counts);
    const sentText = await send({ from: business.twilioNumber, to: business.ownerMobile, body, kind: 'weekly-summary' });
    logEvent({
      timestamp: at.toISOString(), business: business.name, customer: null, event_type: 'summary',
      message_variant: 'weekly-summary', delivery_status: sentText.status, detail: body,
    });
    return { counts, body };
  }

  // The Monday date (in the business's own timezone) of the week the
  // automatic summary belongs to — the guard key for "at most one
  // auto summary per week".
  function summaryWeekKey(business, at) {
    const p = zonedParts(at, business.timezone);
    const monday = new Date(Date.UTC(p.year, p.month - 1, p.day - ((p.dayIndex + 6) % 7)));
    return monday.getUTCFullYear() + '-' + String(monday.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(monday.getUTCDate()).padStart(2, '0');
  }

  /*
   * Automatic weekly summary: Mondays at 9:00 AM in each business's
   * own timezone (firing at most once per week per business). The
   * guard is persisted, so a restart can neither skip nor double-send
   * a week. Called by the server's timer; also driven directly by the
   * tests. Only active businesses are included.
   */
  async function sendDueWeeklySummaries(now) {
    const at = now || new Date();
    const sentTo = [];
    for (const business of businesses) {
      if (!business.active) continue;
      const p = zonedParts(at, business.timezone);
      if (p.dayIndex !== WEEKLY_SUMMARY_DAY_INDEX) continue; // Monday only
      if (p.hour * 60 + p.minute < WEEKLY_SUMMARY_MINUTES) continue; // from 9:00 AM local on
      const key = summaryWeekKey(business, at);
      if (lastSummaryWeek.get(business.twilioNumber) === key) continue; // already sent this week
      try {
        await sendWeeklySummary(business, at);
        lastSummaryWeek.set(business.twilioNumber, key);
        saveState();
        sentTo.push(business.name);
      } catch (err) {
        logEvent({
          timestamp: at.toISOString(), business: business.name, customer: null, event_type: 'summary',
          delivery_status: 'send-failed',
          detail: 'automatic weekly summary failed (' + ((err && err.message) || err) + ') — will retry on the next tick',
        });
      }
    }
    return sentTo;
  }

  restoreState();

  return {
    handleJobDone,
    handleSelfServeAsk,
    handleHold,
    processDue,
    handleInboundSms,
    recordFeedback,
    getFeedback,
    getContacts,
    contactsCsv,
    rotatePageToken,
    setHandCounts,
    buildSummary,
    summaryText,
    sendWeeklySummary,
    sendDueWeeklySummaries,
    findBusiness,
    findBusinessByPageToken,
    isSuppressed,
    feedbackLink,
    inboxLink,
    staffLink,
    logEvent,
    saveState,
    linkBase,
    queue,
    asksByToken,
    events,
    sentMessages,
    feedbackRecords,
    contacts,
    businesses,
  };
}

module.exports = {
  createService,
  loadBusinesses,
  parseCsv,
  render,
  normalizeNumber,
  looksLikePhoneNumber,
  nextSendTime,
  zonedParts,
  isUsNumber,
  isValidEmail,
  isSuccessfulSendStatus,
  newToken,
  DEFAULT_REQUEST,
  DEFAULT_REMINDER,
  DEFAULT_FEEDBACK_HEADING,
  DEFAULT_FEEDBACK_SUBLINE,
  DEFAULT_FEEDBACK_THANKS,
  DEFAULT_OWNER_ALERT,
  DEFAULT_CONTACTS_CONSENT,
  DEFAULT_MONTHLY_CAP,
  MAX_SEND_ATTEMPTS,
  RETRY_DELAY_MS,
  SUCCESS_SEND_STATUSES,
};
