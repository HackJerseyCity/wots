'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MockAgent, setGlobalDispatcher } = require('undici');

const {
  getIdentityId,
  getCredentialsForIdentity,
  sigv4SignS3Put,
  uploadImage,
  COGNITO_ENDPOINT,
  IDENTITY_POOL_ID,
} = require('../src/cognito');

function withMock() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return agent;
}

test('getIdentityId POSTs GetId with the pool id, returns IdentityId', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  let seen;
  agent.get('https://cognito-identity.us-east-1.amazonaws.com').intercept({ path: '/', method: 'POST' })
    .reply((opts) => {
      seen = opts;
      return { statusCode: 200, data: JSON.stringify({ IdentityId: 'us-east-1:id-xyz' }), responseOptions: { headers: { 'content-type': 'application/x-amz-json-1.1' } } };
    });

  const id = await getIdentityId();
  assert.equal(id, 'us-east-1:id-xyz');
  assert.equal(seen.body, `{"IdentityPoolId":"${IDENTITY_POOL_ID}"}`);
  const target = Object.entries(seen.headers).find(([k]) => k.toLowerCase() === 'x-amz-target')?.[1];
  assert.equal(target, 'AWSCognitoIdentityService.GetId');
});

test('getCredentialsForIdentity POSTs with the identity, returns temp creds', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());
  let seen;
  const creds = {
    Credentials: {
      AccessKeyId: 'AKIA123',
      SecretKey: 'secret456',
      SessionToken: 'session789',
      Expiration: 1_800_000_000,
    },
  };
  agent.get('https://cognito-identity.us-east-1.amazonaws.com').intercept({ path: '/', method: 'POST' })
    .reply((opts) => {
      seen = opts;
      return { statusCode: 200, data: JSON.stringify(creds), responseOptions: { headers: { 'content-type': 'application/x-amz-json-1.1' } } };
    });

  const out = await getCredentialsForIdentity('us-east-1:id-xyz');
  assert.equal(out.AccessKeyId, 'AKIA123');
  assert.equal(out.SecretKey, 'secret456');
  assert.equal(out.SessionToken, 'session789');
  assert.equal(seen.body, `{"IdentityId":"us-east-1:id-xyz"}`);
  const target = Object.entries(seen.headers).find(([k]) => k.toLowerCase() === 'x-amz-target')?.[1];
  assert.equal(target, 'AWSCognitoIdentityService.GetCredentialsForIdentity');
});

test('sigv4SignS3Put uses path-style URL and binary/octet-stream by default', () => {
  const signed = sigv4SignS3Put({
    bucket: 'incidentimages',
    key: '7_2026/abc_1783000000000.jpg',
    bytes: Buffer.from('hello'),
    creds: { AccessKeyId: 'AKIA', SecretKey: 'S', SessionToken: 'TOK' },
    region: 'us-east-1',
    now: new Date('2026-07-15T12:34:56Z'),
  });

  assert.match(signed.url, /^https:\/\/s3\.amazonaws\.com\/incidentimages\/7_2026\/abc_1783000000000\.jpg$/);
  assert.equal(signed.headers['content-type'], 'binary/octet-stream');
  assert.equal(signed.headers['x-amz-security-token'], 'TOK');
  assert.equal(signed.headers['x-amz-date'], '20260715T123456Z');
  assert.match(signed.headers['x-amz-content-sha256'], /^[0-9a-f]{64}$/);
  assert.match(
    signed.headers['authorization'],
    /^AWS4-HMAC-SHA256 Credential=AKIA\/20260715\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
  );
});

test('sigv4SignS3Put signature is deterministic for fixed input', () => {
  const input = {
    bucket: 'b', key: 'k.jpg', bytes: Buffer.from('x'),
    creds: { AccessKeyId: 'AKIA', SecretKey: 'S', SessionToken: 'T' },
    region: 'us-east-1', now: new Date('2026-01-01T00:00:00Z'),
  };
  const a = sigv4SignS3Put(input);
  const b = sigv4SignS3Put(input);
  assert.equal(a.headers.authorization, b.headers.authorization);
});

test('uploadImage: defaults to bucket=incidentimages, path-style URL, returns full path', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  agent.get('https://cognito-identity.us-east-1.amazonaws.com').intercept({ path: '/', method: 'POST' })
    .reply(200, { IdentityId: 'us-east-1:xyz' }, { headers: { 'content-type': 'application/x-amz-json-1.1' } });
  agent.get('https://cognito-identity.us-east-1.amazonaws.com').intercept({ path: '/', method: 'POST' })
    .reply(200, { Credentials: { AccessKeyId: 'AK', SecretKey: 'SK', SessionToken: 'ST' } }, { headers: { 'content-type': 'application/x-amz-json-1.1' } });

  let seenPut;
  agent.get('https://s3.amazonaws.com').intercept({ path: /^\/incidentimages\/\d+_\d{4}\/.+\.jpg$/, method: 'PUT' })
    .reply((opts) => {
      seenPut = opts;
      return { statusCode: 200, data: '' };
    });

  const path = await uploadImage(Buffer.from('fake-jpeg'));

  // Returned value is JUST the S3 object key (goes into imagesUrs as-is; CDN reads it
  // from the incidentimages bucket, so no bucket prefix should appear in the string).
  assert.match(path, /^\d+_\d{4}\/[0-9a-f-]+_\d+\.jpg$/);
  assert.doesNotMatch(path, /^incidentimages/);
  // The wire URL (path-style) still has the bucket prefix because S3 needs it there.
  assert.match(seenPut.path, /^\/incidentimages\/\d+_\d{4}\/[0-9a-f-]+_\d+\.jpg$/);
  const h = new Map(Object.entries(seenPut.headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(h.get('content-type'), 'binary/octet-stream');
  assert.equal(h.get('x-amz-security-token'), 'ST');
  assert.ok(h.get('authorization').startsWith('AWS4-HMAC-SHA256 Credential=AK/'));
});

test('uploadImage: Cognito failure surfaces as PHOTO_UPLOAD_FAILED', async (t) => {
  const agent = withMock();
  t.after(() => agent.close());

  agent.get('https://cognito-identity.us-east-1.amazonaws.com').intercept({ path: '/', method: 'POST' })
    .reply(500, { __type: 'InternalFailure' }, { headers: { 'content-type': 'application/x-amz-json-1.1' } });

  await assert.rejects(
    uploadImage(Buffer.from('x')),
    (err) => err.code === 'PHOTO_UPLOAD_FAILED',
  );
});
