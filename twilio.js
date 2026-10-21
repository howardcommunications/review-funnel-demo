'use strict';
/*
 * Twilio adapter.
 *
 * MOCK mode (default, TWILIO_MODE unset or "mock"): no network calls, no
 * credentials, no real SMS. sendSms() resolves with a recorded message
 * object; the caller (core.js) writes it to sent-messages.jsonl and to the
 * event log. This is the only mode used in this build / demo.
 *
 * REAL mode (TWILIO_MODE=real): reads TWILIO_ACCOUNT_SID and
 * TWILIO_AUTH_TOKEN from environment variables only (never hardcoded),
 * and POSTs to Twilio's Messages API with Node's built-in https module.
 * It is implemented so the same core logic can go live later, but it must
 * NOT be used until a Twilio account / test number exists and toll-free
 * verification is approved. Nothing in the demo or the tests enables it.
 */
const https = require('https');
const querystring = require('querystring');
const crypto = require('crypto');

/*
 * Twilio request signature check (for the /sms/inbound webhook in real
 * mode). Twilio signs every webhook: HMAC-SHA1, keyed by the account's
 * auth token, over the full request URL plus the POST parameters sorted
 * by name, base64-encoded, sent in the X-Twilio-Signature header. This
 * proves the request really came from Twilio and not from someone
 * pretending — without it, anyone could feed fake STOPs or replies into
 * the system. In mock (test) mode there is no signature to check, so the
 * server accepts the request but logs that checking is off.
 */
function validateTwilioSignature(authToken, url, params, signature) {
  if (!authToken || !signature) return false;
  let data = String(url || '');
  for (const key of Object.keys(params || {}).sort()) {
    data += key + String(params[key]);
  }
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createTwilioAdapter(options) {
  const opts = options || {};
  const mode = opts.mode || process.env.TWILIO_MODE || 'mock';

  if (mode !== 'real') {
    return {
      mode: 'mock',
      // Returns a "sent" record instead of calling Twilio.
      async sendSms(message) {
        return {
          sid: 'MOCK_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          status: 'mock-sent',
          from: message.from,
          to: message.to,
          body: message.body,
          kind: message.kind || 'sms',
        };
      },
    };
  }

  // ---- Real mode (NOT used in this build) ----
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error(
      'TWILIO_MODE=real requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in the environment. ' +
      'Refusing to start without them (secrets are never hardcoded).'
    );
  }
  return {
    mode: 'real',
    async sendSms(message) {
      const payload = querystring.stringify({
        From: message.from,
        To: message.to,
        Body: message.body,
      });
      const requestOptions = {
        hostname: 'api.twilio.com',
        path: '/2010-04-01/Accounts/' + accountSid + '/Messages.json',
        method: 'POST',
        auth: accountSid + ':' + authToken,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
        },
      };
      return new Promise((resolve, reject) => {
        const req = https.request(requestOptions, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(data); } catch (e) { parsed = { raw: data }; }
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ sid: parsed.sid, status: parsed.status || 'sent', from: message.from, to: message.to, body: message.body, kind: message.kind || 'sms' });
            } else {
              reject(new Error('Twilio API error ' + res.statusCode + ': ' + data));
            }
          });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    },
  };
}

module.exports = { createTwilioAdapter, validateTwilioSignature };
