#!/usr/bin/env node
'use strict';
/*
 * Generate one print-ready QR PNG per business in businesses.csv.
 *
 * Usage:
 *   node generate_qr.js [base-url] [output-dir]
 *
 *   base-url    The web address the codes point at. Defaults to the
 *               clearly-marked PLACEHOLDER below. The real web address
 *               is NOT chosen yet — after Isaac locks it, re-run with
 *               the real address and reprint the PNGs (one command).
 *   output-dir  Defaults to ./qr
 *
 * Each code opens that business's counter feedback page:
 *   <base-url>/b/<pageToken>/feedback
 * (served by server.js — the same feedback form as the texted link,
 * not tied to any one customer's text.)
 *
 * Print notes: PNG, black on white, quiet zone of 4 modules (the
 * standard minimum), at least 1200 px on a side — clean enough to
 * print at the counter. After writing each file the script decodes it
 * back and compares it to the exact URL, so a bad code can never ship
 * silently. If the business rotates its inbox link later, the /b/ URL
 * changes too — reprint that business's code.
 *
 * No dependencies: pure Node.js (the QR encoder lives in qr.js).
 */
const fs = require('fs');
const path = require('path');
const { loadBusinesses } = require('./core');
const { encodeText, modulesToPng, decodePng } = require('./qr');

// Clearly-marked stand-in. FINAL PRINTS MUST WAIT for Isaac to lock the
// real web address, then: node generate_qr.js https://the-real-address
const PLACEHOLDER_BASE = 'https://PLACEHOLDER-WEB-ADDRESS.example';

const base = (process.argv[2] || PLACEHOLDER_BASE).replace(/\/$/, '');
const outDir = process.argv[3] || path.join(__dirname, 'qr');
const isPlaceholder = base === PLACEHOLDER_BASE;

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function main() {
  const businesses = loadBusinesses(process.argv[4] || path.join(__dirname, 'businesses.csv'));
  fs.mkdirSync(outDir, { recursive: true });
  let failed = 0;
  for (const b of businesses) {
    if (!b.active) {
      console.log('SKIP (inactive): ' + b.name);
      continue;
    }
    const url = base + '/b/' + b.pageToken + '/feedback';
    const { version, size, mask, modules } = encodeText(url);
    const scale = Math.max(1, Math.ceil(1200 / (size + 8)));
    const dim = (size + 8) * scale;
    const png = modulesToPng(modules, { scale, quiet: 4 });
    const file = path.join(outDir, slug(b.name) + '.png');
    fs.writeFileSync(file, png);
    // Verify: decode the file we just wrote and demand the exact URL.
    let verified = false;
    try {
      const back = decodePng(fs.readFileSync(file));
      verified = back.text === url;
    } catch (err) {
      console.log('VERIFY ERROR for ' + b.name + ': ' + err.message);
    }
    if (!verified) {
      failed++;
      console.log('VERIFY FAILED: ' + file);
      continue;
    }
    console.log('OK: ' + file + '  (' + dim + 'x' + dim + ' px, QR v' + version + ', mask ' + mask + ')');
    console.log('    -> ' + url);
  }
  console.log('----');
  if (isPlaceholder) {
    console.log('WARNING: these codes point at the PLACEHOLDER address (' + PLACEHOLDER_BASE + ').');
    console.log('They scan and open the right page SHAPE, but they are NOT final: after Isaac');
    console.log('locks the real web address, regenerate with:');
    console.log('  node generate_qr.js https://the-real-address');
    console.log('and reprint before putting them on any counter.');
  } else {
    console.log('Codes point at: ' + base);
  }
  if (failed) {
    console.error(failed + ' code(s) failed verification.');
    process.exit(1);
  }
  console.log('All codes written and verified by decode-back.');
}

main();
