#!/usr/bin/env node
'use strict';

// Live one-off: files a REAL, PERSISTED incident. Enforcement can see it.
// Prints cancelInfo on success so you can undo the report by hand.

const fs = require('node:fs');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const WOTS = require('..');

async function ask(rl, prompt, def) {
  const raw = await rl.question(def ? `${prompt} [${def}]: ` : `${prompt}: `);
  const a = raw.trim();
  return a || def || '';
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log('╔═════════════════════════════════════════════════════════════╗');
  console.log('║  WARNING: this creates a REAL, PERSISTED WOTS incident.     ║');
  console.log('║  Enforcement can see it. Only run against your own account. ║');
  console.log('║  Have a plan to cancel if this is a test.                   ║');
  console.log('╚═════════════════════════════════════════════════════════════╝\n');

  const token = process.env.WOTS_TOKEN || await ask(rl, 'JWT');
  if (!token) { console.error('No token supplied.'); rl.close(); process.exit(1); }

  const type = await ask(rl, 'type code', 'OTHER_PARKING_VIOLATION');
  const meta = WOTS.TYPES[type];
  if (!meta) {
    console.error(`Unknown type ${type}. Run: node -e "console.log(Object.keys(require('wots').TYPES).join('\\n'))"`);
    rl.close(); process.exit(1);
  }
  console.log(`  -> ${meta.typeName} (${meta.group}/${meta.subgroup}, snoozable=${meta.snoozable})`);

  const lat = parseFloat(await ask(rl, 'lat'));
  const lon = parseFloat(await ask(rl, 'lon'));
  const phone = await ask(rl, 'phone (US)');
  const address = await ask(rl, 'address (optional)');
  const comment = await ask(rl, 'comment (optional)');
  const imagePath = await ask(rl, 'image path (optional)');

  let image;
  if (imagePath) {
    image = fs.readFileSync(imagePath);
    console.log(`  -> ${image.length} bytes to upload`);
  }

  const report = { type, lat, lon, phone, address, comment, image };
  console.log('\nWill submit:');
  console.log(JSON.stringify({ ...report, image: image ? `<${image.length} bytes>` : undefined }, null, 2));
  const confirm = await ask(rl, '\nType YES to submit');
  if (confirm !== 'YES') { console.log('Aborted.'); rl.close(); process.exit(1); }
  rl.close();

  try {
    const t0 = Date.now();
    const result = await WOTS.submit(token, report);
    console.log(`\nSUCCESS in ${Date.now() - t0}ms.`);
    console.log(`  incidentId:     ${result.incidentId}`);
    console.log(`  duplicatesSeen: ${result.duplicatesSeen.length}`);
    for (const d of result.duplicatesSeen) console.log(`    - ${d.typeName || '?'}  ${d.addressText || ''}  ${d.distanceText || ''}`);
    console.log(`\ncancelInfo (save this to cancel later):`);
    console.log(JSON.stringify(result.cancelInfo, null, 2));
  } catch (err) {
    console.error(`\nsubmit failed: ${err.code || err.name} -- ${err.message}`);
    if (err.status) console.error(`  status: ${err.status}`);
    if (err.body) console.error('  body:', err.body);
    if (err.duplicates) console.error('  duplicates:', err.duplicates);
    process.exit(1);
  }
}

main().catch((err) => { console.error('Unexpected:', err); process.exit(1); });
