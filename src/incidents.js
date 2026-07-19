'use strict';

const { request } = require('./http');
const { decodeJwtPayload } = require('./jwt');
const { WotsError } = require('./errors');

const DEFAULT_PAGE_SIZE = 20;
const LIST_TIMEOUT_MS = 20_000;

async function all(token, opts = {}) {
  const payload = decodeJwtPayload(token);
  const userId = payload && payload.sub;
  if (typeof userId !== 'string' || !userId) {
    throw new WotsError('INVALID_JWT', { message: "token has no 'sub' claim" });
  }

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

module.exports = { all };
