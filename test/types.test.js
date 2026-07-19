'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TYPES, REGION_ID } = require('../src/types');

test('catalog has 89 types (matches the reference doc)', () => {
  assert.equal(Object.keys(TYPES).length, 89);
});

test('region id is jersey_city', () => {
  assert.equal(REGION_ID, 'us.nj.jersey_city');
});

test('every entry has the required slim shape', () => {
  for (const [code, t] of Object.entries(TYPES)) {
    assert.equal(typeof t.typeName, 'string', `${code}.typeName`);
    assert.equal(typeof t.group, 'string', `${code}.group`);
    assert.equal(typeof t.subgroup, 'string', `${code}.subgroup`);
    assert.equal(typeof t.snoozable, 'boolean', `${code}.snoozable`);
    assert.equal(typeof t.redirect911, 'boolean', `${code}.redirect911`);
    assert.ok(Array.isArray(t.redirect911Conditions), `${code}.redirect911Conditions`);
    assert.ok(t.defaultOfficerIssueDescription, `${code}.defaultOfficerIssueDescription`);
    assert.equal(t.defaultOfficerIssueDescription.id, 'DEFAULT', `${code}.defaultOfficerIssueDescription.id`);
    assert.equal(typeof t.defaultOfficerIssueDescription.code, 'string', `${code}.defaultOfficerIssueDescription.code`);
    assert.equal(typeof t.defaultOfficerIssueDescription.d, 'string', `${code}.defaultOfficerIssueDescription.d`);
  }
});

test('OTHER_PARKING_VIOLATION default citation is D24.00', () => {
  assert.equal(TYPES.OTHER_PARKING_VIOLATION.defaultOfficerIssueDescription.code, 'D24.00');
});

test('OTHER_PARKING_VIOLATION exists with snoozable: false', () => {
  const t = TYPES.OTHER_PARKING_VIOLATION;
  assert.ok(t, 'OTHER_PARKING_VIOLATION not in catalog');
  assert.equal(t.snoozable, false);
  assert.equal(t.group, 'VEHICLE');
});

test('at least one type has redirect911: true (911-safety guard needs real inputs to test)', () => {
  const redirects = Object.entries(TYPES).filter(([, t]) => t.redirect911 === true);
  assert.ok(redirects.length > 0, 'expected some redirect911: true types');
});

test('all groups are one of the known values', () => {
  const known = new Set(['VEHICLE', 'QOL', 'SAFETY']);
  for (const [code, t] of Object.entries(TYPES)) {
    assert.ok(known.has(t.group), `${code} has unexpected group ${t.group}`);
  }
});
