#!/usr/bin/env node
'use strict';

// Live one-off: fetches every one of your own WOTS reports.
//
// Auth: pass your JWT in the WOTS_TOKEN environment variable, or paste it
// when prompted. Get one by running spike/login.js first and copying the
// `token:` line.
//
// Uses only your own userId (from the token's sub claim) -- never point
// this at someone else's userId.

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const WOTS = require('..');

async function ask(rl, prompt) {
  const answer = await rl.question(prompt);
  return answer.trim();
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const token = process.env.WOTS_TOKEN || await ask(rl, 'JWT (from spike/login.js): ');
  if (!token) {
    console.error('No token supplied.');
    rl.close();
    process.exit(1);
  }
  rl.close();

  let reports;
  try {
    const t0 = Date.now();
    reports = await WOTS.all(token);
    console.log(`\nFetched ${reports.length} reports in ${Date.now() - t0}ms.\n`);
  } catch (err) {
    console.error(`WOTS.all failed: ${err.code || err.name} -- ${err.message}`);
    if (err.status) console.error(`  status: ${err.status}`);
    if (err.body) console.error('  body:', err.body);
    process.exit(1);
  }

  if (!reports.length) {
    console.log('(no reports)');
    return;
  }

  const preview = reports.slice(0, 10);
  for (const r of preview) {
    const id = r.id ?? '?';
    const type = r.typeName ?? r.type ?? '?';
    const addr = r.address ?? '?';
    const status = r.primaryText ?? '';
    console.log(`  ${id}  |  ${type}  |  ${addr}  |  ${status}`);
  }
  if (reports.length > preview.length) {
    console.log(`  ... and ${reports.length - preview.length} more`);
  }
}

main().catch((err) => {
  console.error('Unexpected:', err);
  process.exit(1);
});
