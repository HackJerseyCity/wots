# wots

A Node client for the WOTS public HTTP API.

Node 18+ (uses the built-in `fetch`, `crypto.randomUUID`, and `node:test`). No runtime dependencies.

## Install

```
npm install wots
```

## Authentication

WOTS login is **phone number + 4-digit SMS code** — there is no password. Because the code arrives out-of-band, authentication is a two-call flow the caller drives:

```js
const WOTS = require('wots');

// 1. Ask the server to text a 4-digit code to the phone.
const session = await WOTS.startLogin('555-123-4567');
// session = { userId, phone, termsAccepted, deviceType, deviceId }

// 2. The user reads the SMS, hands you the code. Exchange it for a JWT.
const { token, sub, auth, exp } = await WOTS.completeLogin(session, '1234');
// token is the WOTS server JWT — send it as `Authorization: Bearer <token>`
// on every subsequent API call. It's HS512-signed with three claims
// (sub, auth, exp) and a ~90-day lifetime.

// Optional: if the code is genuinely lost or expired, request a fresh one
// on the SAME userId (do NOT call startLogin again — that creates a new,
// orphaned account).
await WOTS.resendCode(session);
```

### Inputs

- **`tel`** — any US format. `555-123-4567`, `(555) 123-4567`, `+1 555 123 4567`, `15551234567`, and `+15551234567` all normalize to `+15551234567`. Non-US or malformed input rejects with `WotsError('INVALID_PHONE')` *before* any HTTP call. The `+` prefix is required by the server — see [Note on account reattachment](#note-on-account-reattachment) below for why.
- **`code`** — exactly 4 digits as a string. Anything else rejects with `WotsError('INVALID_CODE_FORMAT')` before any HTTP call.

### Errors

Every failure throws a `WotsError` with a typed `.code` you can switch on:

```js
try {
  const session = await WOTS.startLogin(tel);
  // ...
} catch (err) {
  switch (err.code) {
    case WOTS.WotsError.codes.INVALID_PHONE:       /* malformed number */    break;
    case WOTS.WotsError.codes.SMS_THRESHOLD:       /* server rate-limited */ break;
    case WOTS.WotsError.codes.CODE_NOT_VALID:      /* wrong 4-digit code */  break;
    case WOTS.WotsError.codes.INVALID_CODE_FORMAT: /* code wasn't 4 digits */break;
    case WOTS.WotsError.codes.INVALID_INCIDENT_ID: /* bad detail() id */     break;
    case WOTS.WotsError.codes.INVALID_CANCEL_INFO: /* bad cancel() info */   break;
    case WOTS.WotsError.codes.INVALID_REPORT:      /* submit() bad input */  break;
    case WOTS.WotsError.codes.UNKNOWN_TYPE:        /* submit() type not in catalog */ break;
    case WOTS.WotsError.codes.REDIRECT_911:        /* submit() blocked — call 911 */  break;
    case WOTS.WotsError.codes.DUPLICATES_FOUND:    /* submit() saw nearby reports */  break;
    case WOTS.WotsError.codes.PHOTO_UPLOAD_FAILED: /* submit() Cognito/S3 error */    break;
    case WOTS.WotsError.codes.TIMEOUT:             /* request timed out */   break;
    case WOTS.WotsError.codes.NETWORK_ERROR:       /* transport error */     break;
    default: /* REGISTER_FAILED, ACTIVATE_FAILED, RESEND_FAILED,
               LIST_FAILED, DETAIL_FAILED, SUBMIT_FAILED,
               CANCEL_FAILED, GEO_LOOKUP_FAILED, ... */
  }
}
```

`err.status` and `err.body` are attached when the failure came from an HTTP response.

### Note on account reattachment

The reference documentation this package was built from (`doc/wots-reference.md`, "Open Question #1") lists it as an unresolved mystery whether calling `register/account` on a phone number that already has a WOTS account reattaches to that existing account or silently spawns a new empty orphan. The Python scripts in `doc/` demonstrated the failure mode — a call would come back looking like success, but return a brand-new empty `userId`, so listing reports gave zero results.

**This client resolves it: the reattachment key is the phone-number string, with the `+` prefix.** Sending `+15551234567` reattaches to the caller's real account. Sending `15551234567` (no `+`) silently spawns a fresh orphan. Confirmed 2026-07-19 by comparing a Charles Proxy capture of the real iOS app (sends `+`, reattaches) against this client without the `+` (spawns orphan) and with the `+` (reattaches to the same 2018-vintage `userId` the real app landed on). `deviceId` value and freshness do not matter — a random UUID reattaches fine when the phone format is right.

`normalizeUsPhone` in `src/auth.js` handles this automatically, but if you're extending this client or reading a captured trace, keep the `+` in mind. Removing it — for "cleanup" or to match the format the reference doc's Python scripts historically used — silently breaks every login.

### End-to-end example

```js
const readline = require('node:readline/promises');
const WOTS = require('wots');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const session = await WOTS.startLogin('555-123-4567');
console.log('userId:', session.userId);

const code = (await rl.question('SMS code: ')).trim();
const result = await WOTS.completeLogin(session, code);

console.log('token:', result.token);
console.log('expires:', new Date(result.exp * 1000).toISOString());
rl.close();
```

## Reports

### `WOTS.all(token, opts?) → Promise<Incident[]>`

Fetches every one of your own reports, paging through `/api/incident/short/{userId}/{offset}/{limit}` under the hood. The `userId` is pulled from the token's `sub` claim — you only pass the token.

```js
const reports = await WOTS.all(token);
console.log(`${reports.length} reports`);
for (const r of reports.slice(0, 3)) {
  console.log(r.id, r.address, r.typeName, r.primaryText);
}
```

Options: `{ pageSize = 20, baseUrl, fetchImpl, timeoutMs }`. Pagination stops on an empty page or a short page. Server errors surface as `WotsError` with `err.status` attached; a 401/403 means the token is dead — re-authenticate.

### `WOTS.detail(token, incidentId, opts?) → Promise<Incident>`

Fetches the full `PublicIncident` object for a single report — resolution text, officer info, timestamps, `userContent` (comments + `imageUrls`), citation description, and the `props` map. Backed by `POST /api/incident/id` with `{ incidentId, userId }`; the `userId` again comes from the token's `sub` claim.

```js
const [first] = await WOTS.all(token);
const full = await WOTS.detail(token, first.id);
console.log(full.address, full.publicResolution, full.userContent.imageUrls);
```

Rejects synchronously with `WotsError('INVALID_INCIDENT_ID')` for a missing/non-string id. Server 4xx/5xx surface as `WotsError('DETAIL_FAILED', ...)` with `err.status` and `err.body` attached.

### `WOTS.submit(token, report, opts?) → Promise<{ incidentId, duplicatesSeen, cancelInfo }>`

Files a new incident report. The API is deliberately small; the library does the region lookup, the (optional) Cognito → S3 photo upload, the 20-field body assembly, and the duplicate/force-create dance under the hood.

```js
const result = await WOTS.submit(token, {
  type: 'OTHER_PARKING_VIOLATION',  // required — one of the 89 codes in WOTS.TYPES
  lat: 40.7178,                     // required
  lon: -74.0431,                    // required
  phone: '+15551234567',            // required
  address: '123 Main St, Jersey City NJ 07302',  // optional; defaults to lat,lon
  comment: 'Blocking the crosswalk',              // optional
  image: fs.readFileSync('photo.jpg'),            // optional; Buffer or Uint8Array
});

console.log(result.incidentId);       // the newly-created publicIncidentId
console.log(result.duplicatesSeen);   // [] on clean create; non-empty if we auto-confirmed past nearby reports
console.log(result.cancelInfo);       // { incidentId, lat, lon, submittedAt } — hold onto this for cancel
```

**Opts:** `{ regionId, imageBucket, imageRegion, baseUrl, fetchImpl, timeoutMs = 30_000, autoConfirmDuplicates = true }`. `timeoutMs` is 30 s because the server's geospatial duplicate search averages ~15 s. Setting `autoConfirmDuplicates: false` makes `submit` throw `WotsError('DUPLICATES_FOUND', { duplicates })` on the first-round duplicate response instead of force-retrying — for callers who want to prompt a human first.

**Photos:** pass `image` as a `Buffer` or `Uint8Array`. Under the hood the library mints an anonymous Cognito identity (`us-east-1:6a0cdcee-767b-4cca-8c69-7473509288c8`), gets temporary S3 credentials, SigV4-signs a PUT to `s3.amazonaws.com/incidentimages/{M}_{YYYY}/{uuid}_{ms}.jpg` (path-style, `binary/octet-stream`), and records just the object key (e.g. `7_2026/…jpg`) in `imagesUrs`. The `incidentimages` bucket is CloudFront's origin, so the public URL for the photo is `https://d1vfd7a3zydjom.cloudfront.net/{imagesUrs[0]}` — no bucket prefix, no auth. `opts.imageBucket` lets you override the default `incidentimages` bucket if the API ever moves. No other config needed.

**Safety:** types with `redirect911: true` throw `WotsError('REDIRECT_911')` client-side before any request. Those are 911-worthy incidents; call emergency services, not WOTS.

**No public URL for the new report.** WOTS doesn't publish per-incident public URLs — `result.incidentId` is the reference. Verify with `await WOTS.detail(token, result.incidentId)` or `await WOTS.all(token)`. If you attached a photo, the CDN URL is `https://d1vfd7a3zydjom.cloudfront.net/{imagesUrs[0]}` and it becomes visible via `detail(...).userContent.imageUrls[0]` once the CDN picks it up (usually seconds).

**Cancel linkage:** the returned `cancelInfo` is exactly what `WOTS.cancel` (below) needs. It preserves the fractional-ms `submittedAt` we sent, which the cancel endpoint requires verbatim.

### `WOTS.cancel(token, cancelInfo, opts?) → Promise<Incident>`

Cancels a report you just filed. Backed by `POST /api/incident/cancel` with `{ userId, lat, lon, submittedAt, incidentId }`. Pass the `cancelInfo` object that `submit` returned — the fractional-ms `submittedAt` in there must be the exact value we sent on the original submit, not `Date.now()` at cancel time.

```js
const result = await WOTS.submit(token, { type, lat, lon, phone, comment });
// realized it's a mistake / duplicate:
const canceled = await WOTS.cancel(token, result.cancelInfo);
console.log(canceled.primaryText);  // "Issue Cancelled by You"
```

The server has a short cancel window; too-late attempts surface as `WotsError('CANCEL_FAILED')` with `err.status`/`err.body`. Malformed `cancelInfo` throws `WotsError('INVALID_CANCEL_INFO')` client-side, no HTTP call.

## Testing

```
npm test
```

Runs `node --test` against `test/**/*.test.js`. HTTP is intercepted by `undici`'s `MockAgent` — no real network calls.

## Live smoke tests

Three git-ignored scripts under `spike/` exercise the real API end-to-end. Each accepts either an environment variable or an interactive prompt.

**`spike/login.js`** — full auth flow. Prompts for the phone number (or reads `WOTS_PHONE`), prints the `userId`, then prompts for the 4-digit SMS code with retry + `resend` support. On success, prints the JWT and decoded `sub` / `auth` / `exp`.

```
node spike/login.js
```

For a phone number with an existing WOTS account, `startLogin` reattaches to it (see [Note on account reattachment](#note-on-account-reattachment)); for a phone number with no prior account, it creates one. Either way, hitting `register/account` too often can trip the server-side `SMS_THRESHOLD` rate limit — don't hammer it.

**`spike/all.js`** — dumps a 10-row preview of every one of your own reports. Reads `WOTS_TOKEN` from the environment, or prompts.

```
WOTS_TOKEN=eyJ... node spike/all.js
```

**`spike/detail.js`** — pretty-prints the full detail for one incident. Takes the incidentId as its first argv or from a prompt.

```
WOTS_TOKEN=eyJ... node spike/detail.js <incidentId>
```

**`spike/submit.js`** — files a new report. **This creates a real, persisted incident visible to enforcement.** The script prints a big warning banner, previews the outgoing JSON, and requires a literal `YES` before hitting the wire. On success, it prints `cancelInfo` — save it if you might want to cancel.

```
WOTS_TOKEN=eyJ... node spike/submit.js
```

**`spike/cancel.js`** — cancels a report using the `cancelInfo` printed by `spike/submit.js`. Reads the JSON from `cancelInfo.json` (default) or the path given as argv:

```
WOTS_TOKEN=eyJ... node spike/cancel.js path/to/cancelInfo.json
```

**Typical loop:** `spike/login.js` → copy the JWT into `WOTS_TOKEN` → `spike/all.js` → copy an `id` from the preview → `spike/detail.js <id>`.
