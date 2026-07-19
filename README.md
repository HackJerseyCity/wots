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

- **`tel`** — any US format. `555-123-4567`, `(555) 123-4567`, `+1 555 123 4567`, and `15551234567` all normalize to `15551234567`. Non-US or malformed input rejects with `WotsError('INVALID_PHONE')` *before* any HTTP call.
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
    case WOTS.WotsError.codes.TIMEOUT:             /* request timed out */   break;
    case WOTS.WotsError.codes.NETWORK_ERROR:       /* transport error */     break;
    default: /* REGISTER_FAILED, ACTIVATE_FAILED, RESEND_FAILED, ... */
  }
}
```

`err.status` and `err.body` are attached when the failure came from an HTTP response.

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

## Testing

```
npm test
```

Runs `node --test` against `test/**/*.test.js`. HTTP is intercepted by `undici`'s `MockAgent` — no real network calls.

## Live smoke test

`spike/login.js` (git-ignored) is an interactive CLI that hits the real API. It prompts for the phone number (or reads `WOTS_PHONE`), prints the `userId`, then prompts for the SMS code with retry and resend support:

```
node spike/login.js
```

Every `startLogin` call creates a fresh WOTS account and can trip a server-side `SMS_THRESHOLD` rate limit — don't hammer it.
