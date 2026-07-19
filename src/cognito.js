'use strict';

const { createHash, createHmac, randomUUID } = require('node:crypto');

const { WotsError } = require('./errors');
const { IMAGE_BUCKET, IMAGE_CONTENT_TYPE } = require('./constants');

const IDENTITY_POOL_ID = 'us-east-1:6a0cdcee-767b-4cca-8c69-7473509288c8';
const COGNITO_ENDPOINT = 'https://cognito-identity.us-east-1.amazonaws.com/';
const REGION = 'us-east-1';
const S3_HOST = 's3.amazonaws.com';

async function cognitoCall(target, body, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  let res, text;
  try {
    res = await fetchImpl(COGNITO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': target,
      },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (err) {
    throw new WotsError('PHOTO_UPLOAD_FAILED', {
      message: `Cognito ${target} network error: ${err.message}`,
      cause: err,
    });
  }
  if (!res.ok) {
    throw new WotsError('PHOTO_UPLOAD_FAILED', {
      message: `Cognito ${target} returned ${res.status}`,
      status: res.status,
      body: text,
    });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new WotsError('PHOTO_UPLOAD_FAILED', {
      message: `Cognito ${target} non-JSON response`,
      body: text,
      cause: err,
    });
  }
}

async function getIdentityId(opts = {}) {
  const body = { IdentityPoolId: opts.identityPoolId || IDENTITY_POOL_ID };
  const res = await cognitoCall('AWSCognitoIdentityService.GetId', body, opts);
  if (!res.IdentityId) {
    throw new WotsError('PHOTO_UPLOAD_FAILED', { message: 'GetId did not return IdentityId', body: res });
  }
  return res.IdentityId;
}

async function getCredentialsForIdentity(identityId, opts = {}) {
  const res = await cognitoCall(
    'AWSCognitoIdentityService.GetCredentialsForIdentity',
    { IdentityId: identityId },
    opts,
  );
  if (!res.Credentials) {
    throw new WotsError('PHOTO_UPLOAD_FAILED', { message: 'GetCredentialsForIdentity missing Credentials', body: res });
  }
  return res.Credentials;
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function amzDates(now) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function sigv4SignS3Put({ bucket, key, bytes, contentType = IMAGE_CONTENT_TYPE, creds, region = REGION, now = new Date() }) {
  const host = S3_HOST;
  const canonicalUri = '/' + [bucket, ...key.split('/')].map(encodeURIComponent).join('/');
  const { amzDate, dateStamp } = amzDates(now);
  const payloadHash = sha256Hex(bytes);

  const signedHeadersMap = {
    'content-type': contentType,
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'x-amz-security-token': creds.SessionToken,
  };
  const sortedHeaderNames = Object.keys(signedHeadersMap).sort();
  const canonicalHeaders = sortedHeaderNames.map((n) => `${n}:${signedHeadersMap[n]}\n`).join('');
  const signedHeaders = sortedHeaderNames.join(';');

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac('AWS4' + creds.SecretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.AccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `https://${host}${canonicalUri}`,
    headers: {
      'content-type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'x-amz-security-token': creds.SessionToken,
      authorization,
    },
  };
}

function s3KeyFor(now = new Date()) {
  const mm = String(now.getUTCMonth() + 1);
  const yyyy = String(now.getUTCFullYear());
  const ms = now.getTime();
  return `${mm}_${yyyy}/${randomUUID()}_${ms}.jpg`;
}

async function uploadImage(bytes, opts = {}) {
  if (!bytes || (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes))) {
    throw new WotsError('PHOTO_UPLOAD_FAILED', { message: 'bytes must be a Buffer or Uint8Array' });
  }

  const bucket = opts.bucket || IMAGE_BUCKET;
  const identityId = await getIdentityId(opts);
  const creds = await getCredentialsForIdentity(identityId, opts);

  const now = new Date();
  const key = opts.key || s3KeyFor(now);
  const signed = sigv4SignS3Put({
    bucket,
    key,
    bytes,
    contentType: opts.contentType || IMAGE_CONTENT_TYPE,
    creds,
    region: opts.region || REGION,
    now,
  });

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await fetchImpl(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: bytes,
    });
  } catch (err) {
    throw new WotsError('PHOTO_UPLOAD_FAILED', { message: `S3 PUT network error: ${err.message}`, cause: err });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new WotsError('PHOTO_UPLOAD_FAILED', { message: `S3 PUT returned ${res.status}`, status: res.status, body });
  }
  return key;
}

module.exports = {
  IDENTITY_POOL_ID,
  COGNITO_ENDPOINT,
  REGION,
  getIdentityId,
  getCredentialsForIdentity,
  sigv4SignS3Put,
  uploadImage,
};
