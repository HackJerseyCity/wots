'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MockAgent, setGlobalDispatcher } = require('undici');

const { all, detail, submit, cancel } = require('../src/incidents');
const { TYPES } = require('../src/types');
const { BASE_URL } = require('../src/constants');

function withMock() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return agent;
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function tokenFor(userId) {
  return `${b64url({ alg: 'HS512' })}.${b64url({ sub: userId, auth: 'USER', exp: 9_999_999_999 })}.AAAA`;
}

test('all: single short page returns those items', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  agent.get(BASE_URL).intercept({ path: '/api/incident/short/u1/0/20', method: 'GET' })
    .reply(200, items, { headers: { 'content-type': 'application/json' } });

  const out = await all(tokenFor('u1'));
  assert.deepEqual(out, items);
});

test('all: paginates until an empty page comes back', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  const page1 = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}` }));
  const page2 = Array.from({ length: 20 }, (_, i) => ({ id: `b${i}` }));
  const page3 = [];

  agent.get(BASE_URL).intercept({ path: '/api/incident/short/u1/0/20', method: 'GET' })
    .reply(200, page1, { headers: { 'content-type': 'application/json' } });
  agent.get(BASE_URL).intercept({ path: '/api/incident/short/u1/20/20', method: 'GET' })
    .reply(200, page2, { headers: { 'content-type': 'application/json' } });
  agent.get(BASE_URL).intercept({ path: '/api/incident/short/u1/40/20', method: 'GET' })
    .reply(200, page3, { headers: { 'content-type': 'application/json' } });

  const out = await all(tokenFor('u1'));
  assert.equal(out.length, 40);
  assert.equal(out[0].id, 'a0');
  assert.equal(out[39].id, 'b19');
});

test('all: stops early on a short page', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  const page1 = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}` }));
  const page2 = [{ id: 'tail-1' }, { id: 'tail-2' }];

  agent.get(BASE_URL).intercept({ path: '/api/incident/short/u1/0/20', method: 'GET' })
    .reply(200, page1, { headers: { 'content-type': 'application/json' } });
  agent.get(BASE_URL).intercept({ path: '/api/incident/short/u1/20/20', method: 'GET' })
    .reply(200, page2, { headers: { 'content-type': 'application/json' } });
  // No third intercept — a third call would blow up on assertNoPendingInterceptors.

  const out = await all(tokenFor('u1'));
  assert.equal(out.length, 22);
  assert.equal(out[21].id, 'tail-2');
});

test('all: sends Authorization: Bearer <token>', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  let seen;
  const token = tokenFor('u1');

  agent.get(BASE_URL).intercept({ path: '/api/incident/short/u1/0/20', method: 'GET' })
    .reply((opts) => {
      seen = opts;
      return { statusCode: 200, data: '[]', responseOptions: { headers: { 'content-type': 'application/json' } } };
    });

  await all(token);
  const authHeader = Object.entries(seen.headers)
    .find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  assert.equal(authHeader, `Bearer ${token}`);
});

test('all: derives userId from JWT sub claim', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  agent.get(BASE_URL).intercept({ path: '/api/incident/short/user-xyz/0/20', method: 'GET' })
    .reply(200, [], { headers: { 'content-type': 'application/json' } });

  const out = await all(tokenFor('user-xyz'));
  assert.deepEqual(out, []);
});

test('all: handles wrapped response { data: [...] }', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  agent.get(BASE_URL).intercept({ path: '/api/incident/short/u1/0/20', method: 'GET' })
    .reply(200, { data: [{ id: 'w1' }, { id: 'w2' }] }, { headers: { 'content-type': 'application/json' } });

  const out = await all(tokenFor('u1'));
  assert.deepEqual(out, [{ id: 'w1' }, { id: 'w2' }]);
});

test('all: honors a custom pageSize', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  agent.get(BASE_URL).intercept({ path: '/api/incident/short/u1/0/50', method: 'GET' })
    .reply(200, [{ id: 'x' }], { headers: { 'content-type': 'application/json' } });

  const out = await all(tokenFor('u1'), { pageSize: 50 });
  assert.deepEqual(out, [{ id: 'x' }]);
});

test('all: propagates JWT decode error for a bad token', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  await assert.rejects(all('not-a-jwt'), (err) => err.code === 'INVALID_JWT');
  agent.assertNoPendingInterceptors();
});

test('all: propagates server error as WotsError', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  agent.get(BASE_URL).intercept({ path: '/api/incident/short/u1/0/20', method: 'GET' })
    .reply(401, { type: 'UNAUTHORIZED' }, { headers: { 'content-type': 'application/json' } });

  await assert.rejects(all(tokenFor('u1')), (err) => err.status === 401);
});

// --- detail ------------------------------------------------------------

test('detail: POSTs {incidentId, userId} and returns parsed body', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  let seen;

  const shape = { id: 'inc-1', address: '123 Main St', typeName: 'Other illegal parking' };
  agent.get(BASE_URL).intercept({ path: '/api/incident/id', method: 'POST' })
    .reply((opts) => {
      seen = opts;
      return { statusCode: 200, data: JSON.stringify(shape), responseOptions: { headers: { 'content-type': 'application/json' } } };
    });

  const out = await detail(tokenFor('u1'), 'inc-1');
  assert.equal(seen.body, '{"incidentId":"inc-1","userId":"u1"}');
  assert.deepEqual(out, shape);
});

test('detail: sends Authorization: Bearer <token>', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  let seen;
  const token = tokenFor('u1');

  agent.get(BASE_URL).intercept({ path: '/api/incident/id', method: 'POST' })
    .reply((opts) => {
      seen = opts;
      return { statusCode: 200, data: '{}', responseOptions: { headers: { 'content-type': 'application/json' } } };
    });

  await detail(token, 'inc-1');
  const authHeader = Object.entries(seen.headers)
    .find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  assert.equal(authHeader, `Bearer ${token}`);
});

test('detail: rejects missing / non-string incidentId WITHOUT an HTTP call', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  await assert.rejects(detail(tokenFor('u1'), undefined), (err) => err.code === 'INVALID_INCIDENT_ID');
  await assert.rejects(detail(tokenFor('u1'), ''), (err) => err.code === 'INVALID_INCIDENT_ID');
  await assert.rejects(detail(tokenFor('u1'), 123), (err) => err.code === 'INVALID_INCIDENT_ID');
  agent.assertNoPendingInterceptors();
});

test('detail: propagates JWT decode error for a bad token', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  await assert.rejects(detail('not-a-jwt', 'inc-1'), (err) => err.code === 'INVALID_JWT');
  agent.assertNoPendingInterceptors();
});

test('detail: server 404 surfaces as WotsError with status', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  agent.get(BASE_URL).intercept({ path: '/api/incident/id', method: 'POST' })
    .reply(404, { type: 'NOT_FOUND' }, { headers: { 'content-type': 'application/json' } });

  await assert.rejects(
    detail(tokenFor('u1'), 'missing'),
    (err) => err.status === 404 && err.code === 'DETAIL_FAILED',
  );
});

// --- submit ------------------------------------------------------------

const VALID_TYPE = 'OTHER_PARKING_VIOLATION';

function baseReport(over = {}) {
  return {
    type: VALID_TYPE,
    lat: 40.7178,
    lon: -74.0431,
    phone: '5551234567',
    ...over,
  };
}

function mockGeo(agent, regionId = 'us.nj.jersey_city') {
  agent.get(BASE_URL).intercept({ path: '/api/geo/by/cord', method: 'POST' })
    .reply(200, { regionId, districtId: 'jc-central' }, { headers: { 'content-type': 'application/json' } });
}

test('submit: happy path (no image) — one POST, returns incidentId + cancelInfo', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  mockGeo(agent);

  let seen;
  agent.get(BASE_URL).intercept({ path: '/api/incident', method: 'POST' })
    .reply((opts) => {
      seen = opts;
      return { statusCode: 200, data: JSON.stringify({ publicIncidentId: 'inc-9', title: 'Filed', msg: 'Thanks' }), responseOptions: { headers: { 'content-type': 'application/json' } } };
    });

  const result = await submit(tokenFor('u1'), baseReport());
  assert.equal(result.incidentId, 'inc-9');
  assert.deepEqual(result.duplicatesSeen, []);
  assert.equal(result.cancelInfo.incidentId, 'inc-9');
  assert.equal(result.cancelInfo.lat, 40.7178);
  assert.equal(result.cancelInfo.lon, -74.0431);
  assert.equal(typeof result.cancelInfo.submittedAt, 'number');

  const body = JSON.parse(seen.body);
  assert.equal(body.type, VALID_TYPE);
  assert.equal(body.typeName, TYPES[VALID_TYPE].typeName);
  assert.equal(body.group, TYPES[VALID_TYPE].group);
  assert.equal(body.subgroup, TYPES[VALID_TYPE].subgroup);
  assert.equal(body.snoozable, TYPES[VALID_TYPE].snoozable);
  assert.equal(body.regionId, 'us.nj.jersey_city');
  assert.deepEqual(body.imagesUrs, []);
  assert.equal(body.forceCreate, false);
  assert.equal(body.userId, 'u1');
  assert.deepEqual(body.officerIssueDescription, TYPES[VALID_TYPE].defaultOfficerIssueDescription);
});

test('submit: body byte-fidelity — imagesUrs (not imageUrls), fractional submittedAt, field order', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  mockGeo(agent);
  let seen;
  agent.get(BASE_URL).intercept({ path: '/api/incident', method: 'POST' })
    .reply((opts) => {
      seen = opts;
      return { statusCode: 200, data: JSON.stringify({ publicIncidentId: 'inc-x' }), responseOptions: { headers: { 'content-type': 'application/json' } } };
    });

  await submit(tokenFor('u1'), baseReport());

  const raw = seen.body;
  assert.ok(raw.includes('"imagesUrs"'), 'must send imagesUrs, not imageUrls');
  assert.ok(!raw.includes('"imageUrls"'), 'must NOT send imageUrls');

  const parsed = JSON.parse(raw);
  assert.ok(parsed.submittedAt !== Math.floor(parsed.submittedAt), 'submittedAt must have a fractional part');

  const expectedOrder = [
    'type', 'typeName', 'group', 'subgroup', 'regionId', 'lat', 'lon', 'address',
    'submitUserLat', 'submitUserLon', 'comment', 'imagesUrs', 'selections',
    'officerIssueDescription', 'iconUrl', 'userPhone', 'userId', 'submittedAt',
    'forceCreate', 'snoozable',
  ];
  assert.deepEqual(Object.keys(parsed), expectedOrder);
});

test('submit: duplicate → auto force-retry, returns duplicatesSeen', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  mockGeo(agent);

  const dup = { typeName: 'Something similar', addressText: '124 Main', distanceText: '30 ft' };
  const bodies = [];
  const record = (opts) => bodies.push(JSON.parse(opts.body));
  agent.get(BASE_URL).intercept({ path: '/api/incident', method: 'POST' })
    .reply((opts) => {
      record(opts);
      return { statusCode: 200, data: JSON.stringify({ publicIncidentId: null, duplicates: [dup] }), responseOptions: { headers: { 'content-type': 'application/json' } } };
    });
  agent.get(BASE_URL).intercept({ path: '/api/incident', method: 'POST' })
    .reply((opts) => {
      record(opts);
      return { statusCode: 200, data: JSON.stringify({ publicIncidentId: 'inc-forced' }), responseOptions: { headers: { 'content-type': 'application/json' } } };
    });

  const result = await submit(tokenFor('u1'), baseReport());
  assert.equal(result.incidentId, 'inc-forced');
  assert.deepEqual(result.duplicatesSeen, [dup]);
  assert.equal(bodies[0].forceCreate, false);
  assert.equal(bodies[1].forceCreate, true);
  assert.equal(bodies[0].submittedAt, bodies[1].submittedAt, 'retry preserves submittedAt');
});

test('submit: autoConfirmDuplicates=false throws DUPLICATES_FOUND without retry', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  mockGeo(agent);

  const dup = { typeName: 'X' };
  agent.get(BASE_URL).intercept({ path: '/api/incident', method: 'POST' })
    .reply(200, { publicIncidentId: null, duplicates: [dup] }, { headers: { 'content-type': 'application/json' } });

  await assert.rejects(
    submit(tokenFor('u1'), baseReport(), { autoConfirmDuplicates: false }),
    (err) => err.code === 'DUPLICATES_FOUND' && Array.isArray(err.duplicates) && err.duplicates[0].typeName === 'X',
  );
  agent.assertNoPendingInterceptors();
});

test('submit: REDIRECT_911 throws before any HTTP call', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  // find a type that has redirect911: true
  const nineOneOne = Object.entries(TYPES).find(([, v]) => v.redirect911 === true)[0];

  await assert.rejects(
    submit(tokenFor('u1'), baseReport({ type: nineOneOne })),
    (err) => err.code === 'REDIRECT_911',
  );
  agent.assertNoPendingInterceptors();
});

test('submit: UNKNOWN_TYPE throws before any HTTP call', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  await assert.rejects(
    submit(tokenFor('u1'), baseReport({ type: 'NOT_A_REAL_TYPE' })),
    (err) => err.code === 'UNKNOWN_TYPE',
  );
  agent.assertNoPendingInterceptors();
});

test('submit: INVALID_REPORT for missing lat/lon/phone', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  await assert.rejects(submit(tokenFor('u1'), baseReport({ lat: undefined })), (err) => err.code === 'INVALID_REPORT');
  await assert.rejects(submit(tokenFor('u1'), baseReport({ lon: undefined })), (err) => err.code === 'INVALID_REPORT');
  await assert.rejects(submit(tokenFor('u1'), baseReport({ phone: undefined })), (err) => err.code === 'INVALID_REPORT');
  await assert.rejects(submit(tokenFor('u1'), baseReport({ phone: 'abc' })), (err) => err.code === 'INVALID_REPORT');
  agent.assertNoPendingInterceptors();
});

test('submit: opts.regionId skips geo lookup', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  agent.get(BASE_URL).intercept({ path: '/api/incident', method: 'POST' })
    .reply(200, { publicIncidentId: 'inc-r' }, { headers: { 'content-type': 'application/json' } });

  const r = await submit(tokenFor('u1'), baseReport(), { regionId: 'us.nj.jersey_city' });
  assert.equal(r.incidentId, 'inc-r');
  // No unused interceptors — geo was NOT called
  agent.assertNoPendingInterceptors();
});

test('submit: Authorization Bearer header on the submit call', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  mockGeo(agent);
  const tok = tokenFor('u1');
  let seen;
  agent.get(BASE_URL).intercept({ path: '/api/incident', method: 'POST' })
    .reply((opts) => {
      seen = opts;
      return { statusCode: 200, data: JSON.stringify({ publicIncidentId: 'inc-a' }), responseOptions: { headers: { 'content-type': 'application/json' } } };
    });

  await submit(tok, baseReport());
  const auth = Object.entries(seen.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  assert.equal(auth, `Bearer ${tok}`);
});

test('submit: server 500 → SUBMIT_FAILED', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  mockGeo(agent);
  agent.get(BASE_URL).intercept({ path: '/api/incident', method: 'POST' })
    .reply(500, { type: 'BOOM' }, { headers: { 'content-type': 'application/json' } });

  await assert.rejects(
    submit(tokenFor('u1'), baseReport()),
    (err) => err.code === 'SUBMIT_FAILED' && err.status === 500,
  );
});

test('submit: bad phone → INVALID_REPORT (not INVALID_PHONE, since submit is the boundary)', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  await assert.rejects(
    submit(tokenFor('u1'), baseReport({ phone: 'not-a-number' })),
    (err) => err.code === 'INVALID_REPORT',
  );
  agent.assertNoPendingInterceptors();
});

test('submit: geo lookup failure → GEO_LOOKUP_FAILED', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  agent.get(BASE_URL).intercept({ path: '/api/geo/by/cord', method: 'POST' })
    .reply(404, { type: 'NO_REGION' }, { headers: { 'content-type': 'application/json' } });

  await assert.rejects(
    submit(tokenFor('u1'), baseReport()),
    (err) => err.code === 'GEO_LOOKUP_FAILED',
  );
});

// --- cancel ------------------------------------------------------------

function validCancelInfo(over = {}) {
  return { incidentId: 'inc-1', lat: 40.7178, lon: -74.0431, submittedAt: 1783000000000.5, ...over };
}

test('cancel: POSTs the exact body {userId, lat, lon, submittedAt, incidentId}', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  let seen;
  agent.get(BASE_URL).intercept({ path: '/api/incident/cancel', method: 'POST' })
    .reply((opts) => {
      seen = opts;
      return { statusCode: 200, data: JSON.stringify({ id: 'inc-1', canceledAt: 1783000005000, primaryText: 'Issue Cancelled by You' }), responseOptions: { headers: { 'content-type': 'application/json' } } };
    });

  const canceled = await cancel(tokenFor('u1'), validCancelInfo());
  const body = JSON.parse(seen.body);
  assert.deepEqual(body, { userId: 'u1', lat: 40.7178, lon: -74.0431, submittedAt: 1783000000000.5, incidentId: 'inc-1' });
  assert.equal(canceled.canceledAt, 1783000005000);
});

test('cancel: preserves fractional submittedAt exactly (does not truncate)', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  let seen;
  agent.get(BASE_URL).intercept({ path: '/api/incident/cancel', method: 'POST' })
    .reply((opts) => {
      seen = opts;
      return { statusCode: 200, data: '{}', responseOptions: { headers: { 'content-type': 'application/json' } } };
    });

  const info = validCancelInfo({ submittedAt: 1783171182358.7361 });
  await cancel(tokenFor('u1'), info);
  const body = JSON.parse(seen.body);
  assert.equal(body.submittedAt, 1783171182358.7361);
});

test('cancel: sends Authorization: Bearer <token>', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  const tok = tokenFor('u1');
  let seen;
  agent.get(BASE_URL).intercept({ path: '/api/incident/cancel', method: 'POST' })
    .reply((opts) => {
      seen = opts;
      return { statusCode: 200, data: '{}', responseOptions: { headers: { 'content-type': 'application/json' } } };
    });

  await cancel(tok, validCancelInfo());
  const auth = Object.entries(seen.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  assert.equal(auth, `Bearer ${tok}`);
});

test('cancel: INVALID_CANCEL_INFO when fields are missing/wrong type', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  await assert.rejects(cancel(tokenFor('u1'), null), (e) => e.code === 'INVALID_CANCEL_INFO');
  await assert.rejects(cancel(tokenFor('u1'), {}), (e) => e.code === 'INVALID_CANCEL_INFO');
  await assert.rejects(cancel(tokenFor('u1'), validCancelInfo({ incidentId: undefined })), (e) => e.code === 'INVALID_CANCEL_INFO');
  await assert.rejects(cancel(tokenFor('u1'), validCancelInfo({ lat: undefined })), (e) => e.code === 'INVALID_CANCEL_INFO');
  await assert.rejects(cancel(tokenFor('u1'), validCancelInfo({ lon: undefined })), (e) => e.code === 'INVALID_CANCEL_INFO');
  await assert.rejects(cancel(tokenFor('u1'), validCancelInfo({ submittedAt: undefined })), (e) => e.code === 'INVALID_CANCEL_INFO');
  await assert.rejects(cancel(tokenFor('u1'), validCancelInfo({ submittedAt: 'nope' })), (e) => e.code === 'INVALID_CANCEL_INFO');

  agent.assertNoPendingInterceptors();
});

test('cancel: server 4xx/5xx → CANCEL_FAILED with status/body', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  agent.get(BASE_URL).intercept({ path: '/api/incident/cancel', method: 'POST' })
    .reply(410, { type: 'GONE' }, { headers: { 'content-type': 'application/json' } });

  await assert.rejects(
    cancel(tokenFor('u1'), validCancelInfo()),
    (err) => err.code === 'CANCEL_FAILED' && err.status === 410 && err.body.type === 'GONE',
  );
});

test('cancel: bad token → INVALID_JWT before any HTTP call', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  await assert.rejects(
    cancel('not-a-jwt', validCancelInfo()),
    (err) => err.code === 'INVALID_JWT',
  );
  agent.assertNoPendingInterceptors();
});
