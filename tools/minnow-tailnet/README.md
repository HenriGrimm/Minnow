# minnow-tailnet

The built-in Tailscale node behind **Settings → Devices → Anywhere**. It embeds Tailscale with [`tsnet`](https://pkg.go.dev/tailscale.com/tsnet), so neither the computer nor the phone needs the Tailscale app. With Funnel on (the default), a phone opens `https://minnow-<host>.<tailnet>.ts.net` in a normal browser.

Minnow starts and supervises this program from [`server/remote/tailnet.js`](../../server/remote/tailnet.js). It is never run by hand in normal use.

## Build

```bash
npm run tailnet:build
```

That builds for this machine into `resources/bin/<os>-<arch>/`. Package builds run `node scripts/build-tailnet-sidecar.mjs --package` automatically. Go 1.24 or newer is required. Without Go, local package builds skip the helper and CI builds fail.

## Protocol

**Launch**

```
minnow-tailnet --state-dir <dir> --hostname <name> --target http://127.0.0.1:<port> [--funnel]
```

The per-boot secret arrives in the `MINNOW_INGRESS_SECRET` environment variable, never on the command line. `--state-dir` holds the node identity (`~/.minnow/tailnet/`). It is never backed up.

**Events.** One JSON object per line on stdout:

| `event` | Fields | Meaning |
|---------|--------|---------|
| `starting` | | Node is coming up |
| `needs-login` | `authUrl` | Open this page to sign in to Tailscale |
| `needs-approval` | `feature` (`device`, `https` or `funnel`), `url` | A tailnet admin must approve this device, or allow a feature once |
| `ready` | `url`, `dnsName`, `funnel`, `loginName`, `tailnet` | Serving |
| `error` | `code`, `message` | Something failed; the process may exit |
| `stopped` | | Clean shutdown |

**Commands.** One JSON object per line on stdin. `{"cmd":"logout"}` signs the node out and exits. When stdin reaches EOF (Minnow went away), the program shuts down.

**Proxy.** Every request is forwarded to `--target` with the browser's `Host` preserved. Client-supplied `X-Minnow-*` and `X-Forwarded-*` headers are removed, then these are added:

- `X-Minnow-Ingress-Secret`: the per-boot secret. Minnow's trusted listener rejects anything without it.
- `X-Minnow-Ingress`: `funnel` (public internet) or `tailnet` (a device with the Tailscale app).
- `X-Forwarded-For`: the real client address, used for rate limiting.
- `X-Minnow-Tailnet-User`: the login of a tailnet peer, when known.

Server-sent events and WebSocket upgrades stream through unbuffered.

## Test

```bash
cd tools/minnow-tailnet && go vet ./... && go test ./...
```

Minnow's own tests use [`test/fixtures/remote/fake-tailnet-sidecar.mjs`](../../test/fixtures/remote/fake-tailnet-sidecar.mjs), which speaks the same protocol without Tailscale.
