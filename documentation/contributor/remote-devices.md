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

### Phone app

[`src/mobile/`](../../src/mobile/) is the phone UI. [`mode.ts`](../../src/mobile/mode.ts) decides once at boot: a non-Electron page whose viewport matches `PHONE_MQ` (or that was opened with `?mobile=1`, remembered in `localStorage`; `?mobile=0` opts out) stamps `html.mn-mobile-app`. Boot then skips the workspace gate, onboarding and the welcome page (phones follow the computer's current workspace), runs the normal `initApp()`, and mounts the shell before `markChromeReady()`. [`mobile-app.css`](../../src/styles/mobile-app.css) hides the desktop chrome but keeps the global approval and question hosts.

The shell is four tabs, each with its own screen stack ([`nav.ts`](../../src/mobile/nav.ts)). Pushes add a `history` entry without touching the hash, which the OS router owns, so the back gesture pops one screen. Nothing forks the engine:

| Tab | Data | Notes |
|-----|------|-------|
| Chats | `sessionState`, `subscribeSidebarRender`, chat dot states | A thread mounts the real Code transcript, composer and prompt hosts through `mountSharedChatHost`, so streaming, approvals, questions and queued messages behave as on the desktop. Model picks go through a phone sheet ([`models.ts`](../../src/mobile/models.ts)) over the same `#modelSelect` catalog. |
| Boards | `createBoardListClient`, `createBoardClient` | Task actions come from `buildTaskCardMenuItems`, attempt transcripts from `adaptAttemptTranscript` + `renderTranscriptView`, diffs from `readTaskFileDiff`. |
| Issues | `issues-store`, taxonomy | **Work on this** runs `runIssueWorkspaceChat`. |
| Files | `list_directory`, falling back to `/api/brain/code/files` when agent file tools are off; `/api/preview/file` for content | Read-only. Large files show their first 2000 lines. |

Notification taps route to phone screens through `openMobileNotificationTarget`. Tests: `test/mobile/`.

Host side: **Settings → Devices** ([`settings-devices.ts`](../../src/ui/settings-devices.ts)), the Connect sheet ([`settings-devices-connect.ts`](../../src/ui/settings-devices-connect.ts)), and approval cards in any app ([`device-request-prompt.ts`](../../src/ui/device-request-prompt.ts), notification kind `device_request`).

### Shared chat execution

The computer renderer always owns the chat engine, including messages sent from
a phone. Paired devices cannot claim turns or start persistent main-chat
generations. Their composer sends authenticated commands through `/api/chat-sync`:
Send uses the PC's normal send path (or queues a follow-up while busy), Push now
steers its existing run, and Stop aborts that run and its tools on the computer.
Commands target the actual owning view and do not switch its active chat. An idle
chat needs its workspace open in a computer view; an unavailable PC keeps the
phone's draft and reports the connection failure.

Host and observer event streams use the shared WebSocket transport. The host
coalesces new tokens for up to 40 ms and sends reasoning, prose, tool transcript
changes, queue state and terminal outcomes directly to the other views. Indexed
transcript patches and incremental text avoid resending a whole chat per token.
Reconnect replays a coalesced current-turn snapshot; idle session polling is a
fallback, not the live output path. Phone wake/online reconnects immediately.

Command ids deduplicate HTTP retries and stream replay. The PC saves a bounded
`remoteCommandReceipts` list with accepted user/queue changes before acknowledging
delivery, so a host reload does not send an accepted message twice. Device drafts
remain in that device's `sessionStorage`, and a phone-originated turn preserves
the PC's unsent composer text and attachments.

Claims are held in server memory with a 30-second renewal deadline. An expired
claim remains protected while its backend generation is live. A replaced renderer
checks its claim before further model or tool actions and stops on ownership loss.
The owning view remembers its claim in `sessionStorage` for reload recovery;
recovery refreshes the saved transcript before replaying any generation or tools.
Pending-tool recovery transfers its claim to the next model round, and the settled
transcript flushes before ownership is released. Tests cover real event streams,
two-device admission, tool gaps, expiry, wake after replacement, passive recovery,
live reasoning/prose and tools, command retries, steering, stopping and draft isolation.

## Testing

```bash
npm run test:remote
```

- `test/remote/` covers ingress tagging, the store, cookies and same-origin, pairing v2, the live LAN listener, the tailnet supervisor, the service worker, and an end-to-end flow. Tests use real sockets and [`test/fixtures/remote/fake-tailnet-sidecar.mjs`](../../test/fixtures/remote/fake-tailnet-sidecar.mjs) in place of Tailscale.
- `test/api/companion-*.test.mts` cover the phone client. `test/ui/settings-devices.test.mts` and `device-request-prompt.test.mts` cover the host UI.
- The Go helper: `cd tools/minnow-tailnet && go vet ./... && go test ./...`.

Manual checks that automation cannot cover, on a real iPhone: Add to Home Screen opens signed in; the app survives force-quit, phone reboot, Minnow restart and a Mac Wi-Fi change; Anywhere works on mobile data.
