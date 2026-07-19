#!/usr/bin/env node
'use strict';

// Live one-off: hits the real WOTS API. Every run of startLogin creates a
// fresh account (see doc/wots-reference.md Open Question #1) and can trip
// SMS_THRESHOLD -- don't hammer it.

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const WOTS = require('..');

async function ask(rl, prompt) {
  const answer = await rl.question(prompt);
  return answer.trim();
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const phone = process.env.WOTS_PHONE
    || await ask(rl, 'Phone number (e.g. 555-123-4567): ');

  console.log(`Starting login for ${phone}...`);
  let session;
  try {
    session = await WOTS.startLogin(phone);
  } catch (err) {
    if (err.code === 'INVALID_PHONE') {
      console.error(`INVALID_PHONE: '${phone}' isn't a 10- or 11-digit US number.`);
    } else if (err.code === 'SMS_THRESHOLD') {
      console.error('SMS_THRESHOLD: server-side rate limit. Wait and try again.');
    } else {
      console.error(`startLogin failed: ${err.code || err.name} -- ${err.message}`);
      if (err.body) console.error('  body:', err.body);
    }
    rl.close();
    process.exit(1);
  }

  console.log('Registered.');
  console.log('  userId:        ', session.userId);
  console.log('  phone:         ', session.phone);
  console.log('  termsAccepted: ', session.termsAccepted);
  console.log('  deviceId:      ', session.deviceId);
  console.log('\nCheck your phone for the 4-digit SMS code.\n');

  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = await ask(rl, `Code (attempt ${attempt}/3, or "resend"): `);

    if (code.toLowerCase() === 'resend' || code.toLowerCase() === 'r') {
      try {
        await WOTS.resendCode(session);
        console.log('New code requested -- check your phone.\n');
      } catch (err) {
        console.error(`resendCode failed: ${err.code} -- ${err.message}`);
      }
      attempt--;
      continue;
    }

    try {
      const result = await WOTS.completeLogin(session, code);
      console.log('\nSUCCESS');
      console.log('  token: ', result.token);
      console.log('  sub:   ', result.sub);
      console.log('  auth:  ', result.auth);
      console.log('  exp:   ', result.exp, `(${new Date(result.exp * 1000).toISOString()})`);
      rl.close();
      return;
    } catch (err) {
      console.error(`completeLogin failed: ${err.code} -- ${err.message}`);
      if (err.code === 'INVALID_CODE_FORMAT') continue;
      if (err.code === 'CODE_NOT_VALID' && attempt < 3) {
        console.log('Try again, or type "resend" for a fresh code.');
        continue;
      }
      rl.close();
      process.exit(1);
    }
  }

  console.error(`\nGave up after 3 attempts. userId ${session.userId} will be orphaned.`);
  rl.close();
  process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected:', err);
  process.exit(1);
});
