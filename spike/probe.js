#!/usr/bin/env node
'use strict';

// Diagnostic: does our token work on incident/last (POST) even when
// incident/short (GET) 403s?

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const { decodeJwtPayload } = require('..');
const { BASE_URL, DEFAULT_HEADERS } = require('../src/constants');

async function ask(rl, prompt) {
  const a = await rl.question(prompt);
  return a.trim();
}

async function hit(name, url, opts) {
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(url, opts);
    text = await res.text();
  } catch (err) {
    console.log(`${name}  FETCH-ERROR  ${err.message}`);
    return;
  }
  console.log(`${name}  ${res.status}  ${Date.now() - t0}ms`);
  console.log(`  ${text.slice(0, 300)}`);
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const token = process.env.WOTS_TOKEN || await ask(rl, 'JWT: ');
  rl.close();

  const { sub: userId } = decodeJwtPayload(token);
  console.log(`\nUsing userId ${userId}\n`);

  const headers = { ...DEFAULT_HEADERS, Authorization: `Bearer ${token}` };

  // A. GET short list — the one that 403s
  await hit(
    'GET  incident/short/{userId}/0/20 ',
    `${BASE_URL}/api/incident/short/${userId}/0/20`,
    { method: 'GET', headers },
  );

  // B. POST incident/last — the trace confirmed this works post-login
  await hit(
    'POST incident/last                ',
    `${BASE_URL}/api/incident/last`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    },
  );

  // C. GET the full-form incident list — docs say this exists but not tested
  await hit(
    'GET  incident/{userId}/0/20       ',
    `${BASE_URL}/api/incident/${userId}/0/20`,
    { method: 'GET', headers },
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
