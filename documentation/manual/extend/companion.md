# Use Minnow from another device

Minnow can serve an authenticated companion to a phone or tablet on the same network: pick up a conversation, monitor a long agent run, guide queued work, approve one tool call, review results, or add a scheduled job.

It is deliberately a local-network feature. It is not a way to expose Minnow to the internet, and port-forwarding it is unsupported.

## Turn it on and pair

1. On the computer running Minnow, open **Settings → General → Network access**.
2. Choose **Local network** and **restart Minnow**. The restart is required — the server has to rebind.
3. Come back to Network access, type a name for the device, and choose **Create pairing QR**.
4. On the phone, scan the QR within five minutes, or type the **6-digit code** shown under it.
5. Leave the host running while you use the companion.

Each QR and each code works exactly once.

The phone stores its own credential. The host stores only a SHA-256 hash of it — the token itself is never written to disk on the host.

## What you get

On a phone-sized screen (640px and narrower) the companion is a focused chat shell: conversations, the composer, the mode picker, notifications, Scheduler, and a compact **Tasks** control sheet.

The Tasks sheet reports which desktop-owned tasks are running, queued, waiting for input, failed, or completed. Open a task to see its latest outcome, action count, and changed-file summary. While a task is running you can either:

- **Steer now** to add guidance at the next safe tool-loop boundary.
- **Queue next** to run a follow-up after the current turn.

Completed, failed, and idle tasks offer **Send follow-up** instead. Controls are delivered to the host task renderer. Electron can keep that renderer alive when the window is hidden in the tray; browser mode requires the host Minnow tab and `npm start` to remain open. If the renderer is unavailable, the sheet says so and rejects new commands rather than saving a surprise action for later.

Tool approvals raised by the desktop appear at the top of the sheet with the tool, workspace, and bounded argument preview. A paired device can **Allow once** or **Deny**. It cannot choose Always allow or change host permissions. Instructions sent from the phone retain companion authority when the desktop executes them, so every mutating tool still requires a fresh approval.

Deliberately absent: the file explorer, terminal, browser automation, and app navigation. Those need a real screen and a keyboard.

**Mutating tools always ask for approval on the companion**, even when the host has that tool set to Full. This also applies when the phone steers a desktop-owned run. A phone in your pocket should not be able to silently authorize a file deletion.

Tablets and laptop browsers on wide screens get the full app shell.

## Revoking a device

**Settings → General → Network access → Paired devices → Revoke**. The token is rejected on its next request. An open companion polls every five seconds and switches to the pairing screen shortly after.

Revoke a device you have lost. There is no remote wipe of the phone's stored credential, but it stops working immediately.

## The security boundary

- Only devices on the same local network can reach it.
- Pairing requires all of: LAN mode active, a request from a private address, a valid host header, the one-time secret, and a same-origin request.
- A device token cannot create pairings, list devices, or revoke anything. Device management is host-only.
- In the control plane, device tokens can read only the bounded in-memory task snapshot and enqueue bounded control commands. Only the host renderer can publish task state or consume commands.
- Control commands expire after five minutes and are not written to disk. Stale host snapshots never expose actionable approvals.
- Every other API request needs either the host's per-boot token or an active device token.
- Do not share a QR screenshot. If a link expires or was opened, make a new one.

More on the overall model: [Privacy and security](../reference/privacy-and-security.md).

## Limits worth knowing

`http://<lan-ip>` is not a browser secure context. Browsers therefore refuse to install it as an app or cache it offline, and microphone capture may be blocked. The companion works fine while connected to the host; installable and offline behaviour needs HTTPS, which is not part of this version.

## When it does not work

| Symptom | Check |
|---------|-------|
| Phone cannot reach the host | Same Wi-Fi, and not a guest network that isolates clients |
| Connection refused | Host firewall — allow inbound traffic on Minnow's port |
| Setting had no effect | Restart after changing Network access |
| QR does not load | It may have chosen a VPN or virtual adapter address. Copy the Wi-Fi URL listed above the QR instead, or regenerate. |
| Reconnect banner stuck | Host still running? Did the machine's LAN address change? |
| Link expired | Create a new pairing challenge; they last five minutes and work once |

## Related

- [Privacy and security](../reference/privacy-and-security.md)
- [Settings app](../apps/settings.md)
- [Scheduler app](../apps/scheduler.md)
