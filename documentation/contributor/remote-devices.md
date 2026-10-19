# Remote devices

How phones and tablets reach a running Minnow. User-facing guide: [Use Minnow on your phone](../manual/extend/companion.md).

## Listeners and ingress

The desktop window always talks to a **loopback** listener (`127.0.0.1:9473`, or the next free port in dev). Phones never use it. They arrive on separate listeners that the remote ingress manager ([`server/remote/ingress-manager.js`](../../server/remote/ingress-manager.js)) starts and stops at runtime, with no restart:

| Ingress | Listener | Reached by |
|---------|----------|------------|
| `loopback` | Desktop server (Vite in dev, in-process server packaged) | The desktop app only |
| `lan` | `[::]:9480` (`MINNOW_LAN_PORT`), dual-stack | Phones on the same Wi-Fi |
| `tailnet` / `funnel` | Trusted `127.0.0.1:<ephemeral>` listener, fed by the `minnow-tailnet` sidecar | Phones anywhere: `funnel` from the internet, `tailnet` from devices with the Tailscale app |

Every request is tagged with the listener that accepted it ([`server/network/ingress.js`](../../server/network/ingress.js), `getRequestIngress(req)`). **Never decide whether a request comes from the host by its peer address**: the sidecar proxies from `127.0.0.1`. The host's per-boot token is accepted, and injected into HTML, only on `loopback` ([`authenticate-token.js`](../../server/runtime/authenticate-token.js), [`spa-auth-html.js`](../../server/runtime/spa-auth-html.js)).

The home-network port never drifts. A busy port is reported as `port-in-use` in Settings, because a phone's sign-in belongs to its exact origin. On macOS the QR prefers the Bonjour name (`<LocalHostName>.local`), which survives DHCP changes. Elsewhere it uses the best-ranked RFC1918 address. Host validation re-reads interface addresses every 10 s, so a Wi-Fi change never locks phones out ([`server/network/access.js`](../../server/network/access.js)).

Config lives in `config.json` → `server.remote = { lan: { enabled, port }, anywhere: { enabled, funnel } }`. The legacy `server.networkAccess: 'lan'` migrates on first read and is kept in sync for older readers. `MINNOW_NETWORK=lan` forces the home-network listener on at boot.

## Credentials

- **Device store v2** ([`server/auth/device-store.js`](../../server/auth/device-store.js), `~/.minnow/auth/devices.json`): one record per device, holding one credential per place it signs in from (`browser`, `home-screen`, `other-origin`). Only SHA-256 hashes are stored. v1 files migrate in place, keeping their tokens valid; a `devices.v1.json.bak` copy is kept. Reads are cached by mtime and size, and in-process writes refresh the cache synchronously, so a revocation is effective on the next request. Last-seen times are buffered and written at most once a minute.
- **Cookie** ([`server/auth/cookie.js`](../../server/auth/cookie.js)): `minnow_device`, `HttpOnly; SameSite=Lax; Max-Age=400d`, plus `Secure` on HTTPS ingress. It is re-issued daily while in use. Page scripts never see the secret. A confirmed revocation (`401` + `X-Minnow-Auth: required`) clears it.
- **Same-origin rule** ([`server/runtime/request-auth.js`](../../server/runtime/request-auth.js)): cookies are scoped by host, not port, so cookie-authenticated requests must prove they come from Minnow's origin. A non-GET request needs a matching `Origin`. A GET with `Sec-Fetch-Site` other than `same-origin`/`none` is refused. WebSocket upgrades need a matching `Origin`. Header and query tokens are exempt, because browsers cannot attach them cross-site.
- A pairing saved by an older build in `localStorage` is moved into the cookie on first load (`POST /api/auth/adopt`) and then deleted.

## Connecting

| Path | API | Notes |
|------|-----|-------|
| QR | Host `POST /api/auth/connect-sessions` → phone `POST /api/auth/claim { ticket }` | 128-bit single-use ticket in the URL fragment (`/connect#t=…`), 10 min TTL. The host polls `GET /api/auth/connect-sessions/:id`. |
| Code | `POST /api/auth/claim { code }` | 6 digits, **home network only**. Throttled per source. |
| Request access | Phone `POST /api/auth/requests` → host `GET /api/auth/requests`, `POST …/:id/approve|deny` → phone polls `GET /api/auth/requests/:id` (`X-Minnow-Request-Secret`) | 4-digit verify number, 3 min TTL, at most 5 pending. Approve can attach to an existing device. On `funnel`, accepted only while a pairing window is open (10 min after a connect session is opened). |
| Home Screen | HTML for a signed-in device points `<link rel="manifest">` at `/api/auth/manifest?handoff=<t>`; `start_url` is `/?handoff=<t>` | Install tickets last 7 days and are persisted as hashes in `auth/handoff.json`, surviving restarts. The navigation exchanges the ticket server-side (`303`). A used ticket with a valid cookie redirects silently, because iOS relaunches `start_url` every time. |
| Move | Device `POST /api/auth/handoff { purpose: 'move' }` → navigate to `<anywhere>/?handoff=<t>` | 10 min TTL. Adds an `other-origin` credential to the same device. |

Unauthenticated routes are exactly `host-info`, `claim`, `requests` (POST), `requests/:id` (GET) and `manifest` ([`auth-middleware.js`](../../server/runtime/auth-middleware.js) `isPairingBootstrapRoute`). `funnel` ingress adds a global budget of 30 bootstrap attempts per minute, and `host-info` hides the computer name unless a pairing window is open. Responses on remote ingress carry `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and HSTS on HTTPS.

## Built-in Tailscale

[`tools/minnow-tailnet`](../../tools/minnow-tailnet/README.md) is a Go program built with `tsnet`, documented with its stdout/stdin protocol in its README. [`server/remote/tailnet.js`](../../server/remote/tailnet.js) supervises it:

- It generates a per-boot secret (passed in `MINNOW_INGRESS_SECRET`) and starts the trusted listener. That listener rejects anything without the secret and records `funnel`/`tailnet` and the real client IP from the sidecar's headers.
- It spawns the sidecar with `--state-dir ~/.minnow/tailnet`. This directory is never backed up, because the node identity is bound to the machine.
- It maps events to status: `off`, `unavailable` (binary missing), `starting`, `needs-login {authUrl}`, `needs-approval {feature, url}`, `ready {url, dnsName, loginName}`, or `error`. A crashed helper restarts with backoff.
- Server-side loops back into the listener (the stream tunnel in `stream-ws.js`) carry the secret through `getRequestRelayHeaders(req)`.

**Dev servers and Funnel.** Under `npm start`, the remote listeners serve Vite's dev middlewares (source modules, `/@vite/client`), because phones need them to load the app. With Funnel on, that puts a Vite dev server on the internet. Develop Anywhere with **Only devices with the Tailscale app** (`funnel: false`), and test public Funnel access on a packaged build, which serves only `dist/`.

The binary is located from `MINNOW_TAILNET_BIN`, then packaged `resources/bin/`, then `resources/bin/<os>-<arch>/` in a checkout ([`sidecar-binary.js`](../../server/remote/sidecar-binary.js)). Build it with `npm run tailnet:build` (Go 1.24+). Package builds run `scripts/build-tailnet-sidecar.mjs --package`, which fails in CI without Go.

## Phone client

[`src/companion/bootstrap.ts`](../../src/companion/bootstrap.ts) runs before normal boot on any page without the host token:

- `/connect#t=…` → the connect screen (one button).
- Otherwise it waits for `GET /api/auth/session`. A `401` + marker shows **Disconnected** if this browser was connected before, else **Connect this device** (Scan QR where the browser has `BarcodeDetector` and a secure context, Request access, code entry on the home network).
- After connecting, the Home Screen tip appears once, and a phone on `http:` is offered the move to Anywhere when it is ready.

The connection monitor ([`connection.ts`](../../src/companion/connection.ts)) probes every five seconds and on wake/online/pageshow. An outage never ends a pairing.

Host side: **Settings → Devices** ([`settings-devices.ts`](../../src/ui/settings-devices.ts)), the Connect sheet ([`settings-devices-connect.ts`](../../src/ui/settings-devices-connect.ts)), and approval cards in any app ([`device-request-prompt.ts`](../../src/ui/device-request-prompt.ts), notification kind `device_request`).

## Testing

```bash
npm run test:remote
```

- `test/remote/` covers ingress tagging, the store, cookies and same-origin, pairing v2, the live LAN listener, the tailnet supervisor, the service worker, and an end-to-end flow. Tests use real sockets and [`test/fixtures/remote/fake-tailnet-sidecar.mjs`](../../test/fixtures/remote/fake-tailnet-sidecar.mjs) in place of Tailscale.
- `test/api/companion-*.test.mts` cover the phone client. `test/ui/settings-devices.test.mts` and `device-request-prompt.test.mts` cover the host UI.
- The Go helper: `cd tools/minnow-tailnet && go vet ./... && go test ./...`.

Manual checks that automation cannot cover, on a real iPhone: Add to Home Screen opens signed in; the app survives force-quit, phone reboot, Minnow restart and a Mac Wi-Fi change; Anywhere works on mobile data.
