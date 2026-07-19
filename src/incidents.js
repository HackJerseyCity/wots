'use strict';

const { request } = require('./http');
const { decodeJwtPayload } = require('./jwt');
const { WotsError } = require('./errors');
const { TYPES } = require('./types');
const { uploadImage } = require('./cognito');
const { normalizeUsPhone } = require('./auth');

const DEFAULT_PAGE_SIZE = 20;
const LIST_TIMEOUT_MS = 20_000;
const DETAIL_TIMEOUT_MS = 20_000;
const GEO_TIMEOUT_MS = 20_000;
const SUBMIT_TIMEOUT_MS = 30_000;
const CANCEL_TIMEOUT_MS = 20_000;

function userIdFromToken(token) {
  const payload = decodeJwtPayload(token);
  const userId = payload && payload.sub;
  if (typeof userId !== 'string' || !userId) {
    throw new WotsError('INVALID_JWT', { message: "token has no 'sub' claim" });
  }
  return userId;
}

async function all(token, opts = {}) {
  const userId = userIdFromToken(token);

  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const items = [];
  let offset = 0;

  while (true) {
    const path = `/api/incident/short/${encodeURIComponent(userId)}/${offset}/${pageSize}`;
    const body = await request(path, {
      method: 'GET',
      authToken: token,
      timeoutMs: opts.timeoutMs ?? LIST_TIMEOUT_MS,
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
      failureCode: 'LIST_FAILED',
    });



    const page = Array.isArray(body)
      ? body
      : (body && Array.isArray(body.data) ? body.data
        : (body && Array.isArray(body.items) ? body.items : []));

    if (page.length === 0) break;
    items.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return items;
}

async function detail(token, incidentId, opts = {}) {
  if (typeof incidentId !== 'string' || !incidentId) {
    throw new WotsError('INVALID_INCIDENT_ID', { message: 'incidentId must be a non-empty string' });
  }
  const userId = userIdFromToken(token);

  return await request('/api/incident/id', {
    method: 'POST',
    body: { incidentId, userId },
    authToken: token,
    timeoutMs: opts.timeoutMs ?? DETAIL_TIMEOUT_MS,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    failureCode: 'DETAIL_FAILED',
  });
}

function requireNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

async function resolveRegion(token, lat, lon, opts) {
  try {
    const body = await request('/api/geo/by/cord', {
      method: 'POST',
      body: { lat, lon },
      authToken: token,
      timeoutMs: opts.timeoutMs ?? GEO_TIMEOUT_MS,
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
      failureCode: 'GEO_LOOKUP_FAILED',
    });
    if (!body || typeof body.regionId !== 'string') {
      throw new WotsError('GEO_LOOKUP_FAILED', { message: 'geo/by/cord did not return a regionId', body });
    }
    return body.regionId;
  } catch (err) {
    if (err instanceof WotsError && err.code === 'GEO_LOOKUP_FAILED') throw err;
    if (err instanceof WotsError) {
      throw new WotsError('GEO_LOOKUP_FAILED', { message: err.message, status: err.status, body: err.body, cause: err });
    }
    throw err;
  }
}

function buildAddressObject(report) {
  const addressText = typeof report.address === 'string' && report.address
    ? report.address
    : `${report.lat},${report.lon}`;
  return {
    address: addressText,
    city: '',
    state: '',
    zip: '',
    country: 'United States',
    addressLat: report.lat,
    addressLng: report.lon,
  };
}

function buildSubmitBody({ report, typeMeta, regionId, userId, userPhone, imagesUrs, submittedAt, forceCreate }) {
  return {
    type: report.type,
    typeName: typeMeta.typeName,
    group: typeMeta.group,
    subgroup: typeMeta.subgroup,
    regionId,
    lat: report.lat,
    lon: report.lon,
    address: buildAddressObject(report),
    submitUserLat: report.lat,
    submitUserLon: report.lon,
    comment: typeof report.comment === 'string' ? report.comment : '',
    imagesUrs,
    selections: [],
    officerIssueDescription: typeMeta.defaultOfficerIssueDescription || null,
    iconUrl: null,
    userPhone,
    userId,
    submittedAt,
    forceCreate,
    snoozable: typeMeta.snoozable,
  };
}

async function submit(token, report, opts = {}) {
  if (!report || typeof report !== 'object') {
    throw new WotsError('INVALID_REPORT', { message: 'report must be an object' });
  }
  if (typeof report.type !== 'string' || !report.type) {
    throw new WotsError('INVALID_REPORT', { message: 'report.type is required' });
  }
  const typeMeta = TYPES[report.type];
  if (!typeMeta) {
    throw new WotsError('UNKNOWN_TYPE', { message: `unknown type ${report.type}` });
  }
  if (typeMeta.redirect911) {
    throw new WotsError('REDIRECT_911', {
      message: `type ${report.type} requires calling 911, not filing a WOTS report`,
    });
  }
  if (!requireNumber(report.lat) || !requireNumber(report.lon)) {
    throw new WotsError('INVALID_REPORT', { message: 'report.lat and report.lon must be numbers' });
  }
  const userPhone = normalizeUsPhone(report.phone);
  if (!userPhone) {
    throw new WotsError('INVALID_REPORT', { message: 'report.phone must be a US phone number' });
  }
  const userId = userIdFromToken(token);

  const regionId = opts.regionId || await resolveRegion(token, report.lat, report.lon, opts);

  let imagesUrs = [];
  if (report.image) {
    const key = await uploadImage(report.image, {
      bucket: opts.imageBucket,
      region: opts.imageRegion,
      fetchImpl: opts.fetchImpl,
    });
    imagesUrs = [key];
  }

  const submittedAt = Date.now() + Math.random();
  const autoConfirm = opts.autoConfirmDuplicates !== false;

  const firstBody = buildSubmitBody({
    report, typeMeta, regionId, userId, userPhone, imagesUrs, submittedAt, forceCreate: false,
  });

  const firstResp = await request('/api/incident', {
    method: 'POST',
    body: firstBody,
    authToken: token,
    timeoutMs: opts.timeoutMs ?? SUBMIT_TIMEOUT_MS,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    failureCode: 'SUBMIT_FAILED',
  });

  if (firstResp && firstResp.publicIncidentId) {
    return {
      incidentId: firstResp.publicIncidentId,
      duplicatesSeen: [],
      cancelInfo: { incidentId: firstResp.publicIncidentId, lat: report.lat, lon: report.lon, submittedAt },
    };
  }

  const duplicates = Array.isArray(firstResp && firstResp.duplicates) ? firstResp.duplicates : [];
  if (!autoConfirm) {
    throw new WotsError('DUPLICATES_FOUND', {
      message: `server flagged ${duplicates.length} nearby report(s); retry with autoConfirmDuplicates: true`,
      duplicates,
    });
  }

  const forcedBody = { ...firstBody, forceCreate: true };
  const secondResp = await request('/api/incident', {
    method: 'POST',
    body: forcedBody,
    authToken: token,
    timeoutMs: opts.timeoutMs ?? SUBMIT_TIMEOUT_MS,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    failureCode: 'SUBMIT_FAILED',
  });

  if (!secondResp || !secondResp.publicIncidentId) {
    throw new WotsError('SUBMIT_FAILED', {
      message: 'force-create resubmit did not return a publicIncidentId',
      body: secondResp,
    });
  }
  return {
    incidentId: secondResp.publicIncidentId,
    duplicatesSeen: duplicates,
    cancelInfo: { incidentId: secondResp.publicIncidentId, lat: report.lat, lon: report.lon, submittedAt },
  };
}

async function cancel(token, cancelInfo, opts = {}) {
  if (!cancelInfo || typeof cancelInfo !== 'object') {
    throw new WotsError('INVALID_CANCEL_INFO', { message: 'cancelInfo must be an object' });
  }
  const { incidentId, lat, lon, submittedAt } = cancelInfo;
  if (typeof incidentId !== 'string' || !incidentId) {
    throw new WotsError('INVALID_CANCEL_INFO', { message: 'incidentId is required' });
  }
  if (!requireNumber(lat) || !requireNumber(lon)) {
    throw new WotsError('INVALID_CANCEL_INFO', { message: 'lat/lon must be numbers' });
  }
  if (!requireNumber(submittedAt)) {
    throw new WotsError('INVALID_CANCEL_INFO', { message: 'submittedAt must be the original submit ms (number)' });
  }
  const userId = userIdFromToken(token);

  return await request('/api/incident/cancel', {
    method: 'POST',
    body: { userId, lat, lon, submittedAt, incidentId },
    authToken: token,
    timeoutMs: opts.timeoutMs ?? CANCEL_TIMEOUT_MS,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    failureCode: 'CANCEL_FAILED',
  });
}

module.exports = { all, detail, submit, cancel };
