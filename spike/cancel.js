#!/usr/bin/env node
'use strict';

// Cancels a report using the cancelInfo that spike/submit.js emitted.
//
// Usage:
//   WOTS_TOKEN=eyJ... node spike/cancel.js [cancelInfo.json]
//
// If no path is given, defaults to ./cancelInfo.json in cwd. You can also
// paste the JSON blob interactively when prompted.

const fs = require('node:fs');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const WOTS = require('..');

async function ask(rl, prompt) {
  return (await rl.question(prompt)).trim();
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const token = process.env.WOTS_TOKEN || await ask(rl, 'JWT: ');
  if (!token) { console.error('No token.'); rl.close(); process.exit(1); }

  const path = process.argv[2] || 'cancelInfo.json';
  let info;
  if (fs.existsSync(path)) {
    info = JSON.parse(fs.readFileSync(path, 'utf8'));
    console.log(`Loaded cancelInfo from ${path}`);
  } else {
    console.log(`No file at ${path} — paste the cancelInfo JSON:`);
    const raw = await ask(rl, '');
    info = JSON.parse(raw);
  }
  rl.close();

  console.log('\nWill cancel:');
  console.log(JSON.stringify(info, null, 2));

  try {
    const t0 = Date.now();
    const result = await WOTS.cancel(token, info);
    console.log(`\nCanceled in ${Date.now() - t0}ms.`);
    console.log('  primaryText:  ', result.primaryText);
    console.log('  secondaryText:', result.secondaryText);
    console.log('  canceledAt:   ', result.canceledAt ? new Date(result.canceledAt).toISOString() : '(none)');
  } catch (err) {
    console.error(`\ncancel failed: ${err.code || err.name} -- ${err.message}`);
    if (err.status) console.error(`  status: ${err.status}`);
    if (err.body) console.error('  body:', err.body);
    process.exit(1);
  }
}

main().catch((err) => { console.error('Unexpected:', err); process.exit(1); });
