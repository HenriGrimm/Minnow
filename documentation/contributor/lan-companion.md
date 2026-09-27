# LAN companion

Minnow can serve an authenticated phone or tablet companion on the same private network. It is not an internet-facing deployment mode. Implementation and API details: [`../context.md`](../context.md) (LAN companion / MIN-393). Env override: `MINNOW_NETWORK=lan` — see [commands.md](commands.md#environment-variables).

## Pair a device

1. On the host, open **Settings → General → Network access**.
2. Select **Local network** and restart Minnow.
3. Return to Network access, enter a device name, and select **Create pairing QR**.
4. Scan the QR within five minutes, or enter the **6-digit code** shown under the QR. Each link and code works once.
5. Keep the host running while using the companion.

The phone stores its own device credential. The host stores only a SHA-256 hash in `~/.minnow/auth/devices.json`.

## Revoke access

In **Settings → General → Network access → Paired devices**, select **Revoke**. The token is rejected on its next API request. An open companion checks the host every five seconds and replaces its UI with the pairing-required screen after revocation.

## Companion layout

At 640px and narrower, a paired non-host browser opens Code chat with a mode picker, notifications, and the Tasks control sheet. App navigation, outputs, browser automation, and terminal chrome are omitted because they need a full-size machine.

The control sheet is backed by `server/companion/control-plane.js` and `src/companion/control-plane.ts`. The execution-owning host renderer publishes a bounded snapshot every two seconds and consumes device commands. Paired devices may read that snapshot and enqueue `steer`, `queue`, `send`, `allow-once`, or `cancel`; they cannot publish state or consume commands. State and commands are memory-only, commands expire after five minutes, and approvals disappear when the host heartbeat is stale. The phone review is projected from the execution ledger, with a compact outcome/action/file summary rather than a second transcript implementation.

Mutating tools require approval on the companion even when the shared host permission is set to Full. `src/companion/remote-authority.ts` preserves that rule when a device instruction is relayed into a host-owned turn: each mutation still prompts, and remote approval never exposes `always-allow`.

Wider tablets and desktop browsers retain the full released-app shell.

## Security boundary

- Only the same LAN can reach this mode; router port forwarding is unsupported.
- Pairing requires LAN bind mode, a private/loopback source address, a valid Host header, a short-lived one-time secret, and same-origin requests.
- Device tokens cannot create pairings, list devices, or revoke devices.
- Host-only control routes publish state and consume commands; device-only routes read state and enqueue bounded commands.
- Remote approvals are limited to one call or denial. Device commands do not alter tool permissions.
- All other `/api/*` requests require the per-boot host token or an active device token.
- Do not share QR screenshots. Create a new challenge if a link expires.

## HTTP and PWA limitations

`http://<lan-ip>` is not a browser secure context. Safari and Chromium do not permit service workers there, so offline shell caching and dependable PWA installation are unavailable over plain LAN HTTP. The manifest remains available and the responsive companion works while connected to the host. HTTPS or a trusted private tunnel is required for installable/offline behavior and is intentionally outside LAN v1.

Voice capture can have the same secure-context limitation.

## Troubleshooting

- Confirm the phone and host are on the same non-guest Wi-Fi network.
- Allow inbound Node traffic on Minnow's port in the host firewall.
- Restart after changing Network access.
- Create a new QR if the previous link was opened once or is older than five minutes.
- If the reconnect banner remains visible, verify the host process is running and the LAN address has not changed.
- If pairing hangs on load, the QR may have picked a VPN or virtual-adapter address. Copy the Wi-Fi URL from the list above the QR instead, or regenerate the QR after the host prioritizes RFC1918 addresses.

