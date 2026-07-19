#!/usr/bin/env node
'use strict';

// Live one-off: fetches the full detail for a single incident.
//
// Usage:
//   WOTS_TOKEN=eyJ... node spike/detail.js <incidentId>
//   node spike/detail.js                # prompts for both
//
// Tip: grab an incidentId from spike/all.js output.

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const WOTS = require('..');

async function ask(rl, prompt) {
  const a = await rl.question(prompt);
  return a.trim();
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const token = process.env.WOTS_TOKEN || await ask(rl, 'JWT (from spike/login.js): ');
  const incidentId = process.argv[2] || await ask(rl, 'incidentId: ');
  rl.close();

  if (!token || !incidentId) {
    console.error('Need both a token and an incidentId.');
    process.exit(1);
  }

  let full;
  try {
    const t0 = Date.now();
    full = await WOTS.detail(token, incidentId);
    console.log(`\nFetched in ${Date.now() - t0}ms.\n`);
  } catch (err) {
    console.error(`WOTS.detail failed: ${err.code || err.name} -- ${err.message}`);
    if (err.status) console.error(`  status: ${err.status}`);
    if (err.body) console.error('  body:', err.body);
    process.exit(1);
  }

  const readable = (ms) => (ms ? new Date(ms).toISOString() : '(none)');
  console.log(`  id:                ${full.id}`);
  console.log(`  type:              ${full.typeName || full.type}`);
  console.log(`  address:           ${full.address}`);
  console.log(`  lat/lon:           ${full.lat}, ${full.lon}`);
  console.log(`  primaryText:       ${full.primaryText}`);
  console.log(`  secondaryText:     ${full.secondaryText || ''}`);
  console.log(`  receivedAt:        ${readable(full.receivedAt)}`);
  console.log(`  assignedAt:        ${readable(full.assignedAt)}`);
  console.log(`  resolvedAt:        ${readable(full.resolvedAt)}`);
  console.log(`  canceledAt:        ${readable(full.canceledAt)}`);
  if (full.publicResolution) {
    console.log(`  publicResolution:  ${full.publicResolution}`);
  }
  if (full.officerIssueDescription) {
    const d = full.officerIssueDescription;
    console.log(`  officer citation:  ${d.code || ''} ${d.d || d.id || ''}`);
  }
  const uc = full.userContent || {};
  const comments = (uc.comments || []).map((c) => c.text).filter(Boolean).join(' | ');
  if (comments) console.log(`  your comments:     ${comments}`);
  if (uc.imageUrls && uc.imageUrls.length) {
    console.log(`  images (${uc.imageUrls.length}):`);
    for (const u of uc.imageUrls) console.log(`    - ${u}`);
  }
  if (full.props) {
    const badge = full.props.OFFICER_BADGE;
    const label = full.props.OFFICER_LABEL;
    if (label || badge) console.log(`  officer:           ${label || ''} ${badge ? `(badge ${badge})` : ''}`.trim());
  }
}

main().catch((err) => {
  console.error('Unexpected:', err);
  process.exit(1);
});
