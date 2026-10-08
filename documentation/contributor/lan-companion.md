# LAN companion

Minnow can serve an authenticated phone or tablet companion on the same private network. It is not an internet-facing deployment mode. Implementation and API details: [`../context.md`](../context.md) (LAN companion / MIN-393). Env override: `MINNOW_NETWORK=lan` — see [commands.md](commands.md#environment-variables).

## Pair a device

1. On the host, open **Settings → General → Network access**.
2. Select **Local network** and restart Minnow.
3. Return to Network access, enter a device name, and select **Create pairing QR**.
4. Scan the QR within five minutes, or enter the **6-digit code** shown under the QR. Each link and code works once.
5. Keep the host running while using the companion.

The phone stores its own device credential. The host stores only a SHA-256 hash in `~/.minnow/auth/devices.json`.

Pair in the browser, wait for Minnow to open, then use **Add to Home Screen**. New installations carry the paired device credential into the installed app, including when iOS gives it separate storage. Older installations made before pairing may need one code entered inside the installed app, or can be removed and installed again from the connected browser. The saved credential survives workspace selection, reloads, and host restarts. Reopening a used QR link uses the existing pairing. Keep using the same host address; changing the address requires reconnecting at the new address.

The authenticated, private `/api/auth/manifest` provides a stable app identity and a device-specific launch fragment. The app saves that credential into its own storage and removes the fragment before loading the workspace. The launch credential remains subject to host revocation, including on later launches; it cannot create or manage pairings. The manifest is never cached by Minnow's service worker or shared HTTP caches. An already saved credential takes precedence over an older installation credential.

Phones and tablets reconnect automatically after a temporary Wi-Fi interruption or host outage. The reconnect banner stays visible until the host responds. An outage does not require another code. A confirmed rejection from the host's auth session endpoint clears the credential; provider authentication failures and temporary device-store errors do not.

## Revoke access

In **Settings → General → Network access → Paired devices**, select **Revoke**. The token is rejected on its next API request. An open companion checks the host every five seconds and replaces its UI with the pairing-required screen after revocation.

## Companion layout

At 640px and narrower, a paired non-host browser opens Code chat with a mode picker and notifications. App navigation, outputs, browser automation, and terminal chrome are omitted — they need a full-size machine. Mutating tools require approval on the companion even when the shared host permission is set to Full.

Wider tablets and desktop browsers retain the full released-app shell.

Saved chats and chat folders refresh across visible desktop and companion views every five seconds and on returning to the app. The active transcript refreshes in place without switching chats. Unsaved edits, drafts, and running local turns are protected; concurrent edits to the same chat still use the existing conflict checks. Touch swipes toward older messages release auto-follow, including during momentum scrolling.

## Security boundary

- Only the same LAN can reach this mode; router port forwarding is unsupported.
- Pairing requires LAN bind mode, a private/loopback source address, a valid Host header, a short-lived one-time secret, and same-origin requests.
- Device tokens cannot create pairings, list devices, or revoke devices.
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

