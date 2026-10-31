# Use Minnow on your phone

Use Minnow from a phone or tablet while your computer runs it. Pick up a conversation from the sofa, steer an agent, follow a board, file an issue, or read a file. Nothing needs to be installed on the phone.

There are two ways for a phone to reach your computer. You can use either or both:

| | Home network | Anywhere |
|---|---|---|
| Works | While the phone is on the same Wi-Fi | At home, at work, on mobile data |
| Setup | One click | One-time free Tailscale sign-in on the computer |
| On the phone | Nothing to install | Nothing to install |
| Home Screen app, microphone | Limited (plain HTTP) | Full (HTTPS) |

## Connect a phone

1. On your computer, open **Settings → Devices** and choose **Connect a phone**.
2. The first time, choose where the phone should work: **On my Wi-Fi** or **Anywhere**. You can change this later.
3. Open the phone's Camera app, point it at the QR, and tap the link.
4. On the phone, tap **Connect**.

Minnow opens on the phone, and the computer shows the phone's name in the sheet. That's it. There is no code to type and nothing to name in advance; the phone suggests a name, which you can change.

The phone stays connected through computer restarts, Minnow updates, Wi-Fi changes, and phone restarts. If the computer is asleep or Minnow is closed, the phone shows **Can't reach** with a likely reason and reconnects on its own when the computer is back.

## Share a live chat

The computer runs the conversation. Open the same chat on your phone to see its
reply, reasoning, tool activity and final status as they arrive.

You can send messages and stop a reply from either device. Sending while the
agent is working steers the current run at its next step. Choose **Queue for later**
to wait until the reply finishes, or **Steer current run** on a queued message to
apply it sooner. These actions reach the existing run on your computer.

Keep the workspace open in Minnow on the computer to start a reply from the phone.
Phone drafts and unsent computer drafts stay separate. If the connection drops,
the phone catches up when it reconnects and keeps a message draft until the
computer confirms it was accepted.

## Make it work anywhere

**Settings → Devices → Anywhere → Make it work anywhere** sets up a private, secure address for your computer, such as `https://minnow-studio.example.ts.net`. Minnow includes Tailscale for this, so you install nothing:

1. Choose **Sign in with Tailscale**. A browser page opens; sign in with Google, Apple, Microsoft, or GitHub. The personal plan is free.
2. If your Tailscale account requires new devices to be approved, choose **Approve this computer** and approve it on the Machines page that opens. If it asks you to allow HTTPS or public access, choose the button Minnow shows and approve it the same way. Then come back.
3. The Anywhere card shows **On** and the address.

New QR codes now use the Anywhere address. It works on home Wi-Fi too, so each phone needs only one address.

The Anywhere address can be reached from the internet, the same way a website can. Only devices you connect can use Minnow there. Anything else sees only the connect page. Choose **Only devices with the Tailscale app** if you prefer the address to be reachable only from devices signed in to your Tailscale account; those phones then need the Tailscale app.

A phone connected on the home network sees **Use Minnow away from home** once Anywhere is on. **Switch** moves it to the Anywhere address without approving it again.

**Sign out of Tailscale** removes this computer from your Tailscale account. Phones using the Anywhere address stop working until you set it up again.

## Add Minnow to your Home Screen

After connecting, the phone offers **Add Minnow to your Home Screen**:

- **iPhone and iPad:** tap **Share**, then **Add to Home Screen**, then open Minnow from your Home Screen.
- **Android:** tap **Install app**.

The Home Screen app signs itself in. If it ever opens to **Connect this device**, tap **Request access** and approve it on your computer.

A Home Screen app belongs to the address it was added from. After moving a phone to the Anywhere address, add Minnow to the Home Screen again from there.

## Request access

A device that is not connected shows **Connect this device** with:

- **Scan QR** (Android, on the Anywhere address): scan the code from **Settings → Devices → Connect a phone** without leaving the app.
- **Request access**: the phone shows a 4-digit number. Your computer shows a card with the same number; check that they match and choose **Approve**. A phone that is already connected in its browser can be approved as that same device.
- **Enter a code instead** (home network only): type the 6-digit code shown under **Can't scan?** in the Connect sheet.

On the Anywhere address, requests are accepted only while the Connect sheet is open on your computer.

## Manage devices

**Settings → Devices → Your devices** lists every connected phone and tablet with when it was last used, how it connected, and whether it has a Home Screen app.

- **Rename** changes the name shown on the computer.
- **Disconnect** removes the device and its Home Screen app immediately. The phone shows **This device was disconnected** within a few seconds and can ask for access again.

Disconnect a phone you have lost. Its saved sign-in stops working on its next request.

## What you get on a phone

On a phone-sized screen (640px and narrower), Minnow opens as a phone app with four tabs along the bottom. It uses the same chats, boards, issues and files as your computer, so work started on one continues on the other.

- **Chats**: your conversations in the current workspace, newest first, with pinned chats on top. A dot shows a chat that is working, waiting for you, failed or has a new reply. Tap the workspace name to switch workspaces. The pencil button starts a new chat.
- **Chat**: a conversation fills the screen. Tap the mode under the title to change it, and the model name above the keyboard to pick a model. The paperclip attaches photos and files. Tool approvals and questions appear above the composer, as on the computer. **⋯** renames, pins or deletes the chat.
- **Boards**: your Orchestrate boards with their progress. Open one to follow its cards live, by wave or by column. Start, pause, stop or resume it from the bar at the bottom. Tap a card for its spec, its runs (each run opens as a readable transcript), its changed files with diffs, and the same Start, Retry, Skip, Reset and Rewind actions as on the computer.
- **Issues**: open, in-progress, triage and done issues, grouped by status. Tap **+** to file one. An issue shows its status, priority and type (tap to change them), its description, sub-issues, linked chats and comments. **Work on this** starts a Build, Plan, Debug or Discuss chat for it.
- **Files**: browse the workspace folder by folder, or search with **Go to file**. Recently opened files are listed first. Code opens with syntax highlighting and line numbers; the wrap button switches between wrapped lines and side-scrolling. Markdown opens formatted, with **⋯ → Show source** for the raw text, and images open full width. Files are read-only on a phone.

The phone's back gesture goes back one screen. Tapping the current tab again returns to the top of that tab.

**Mutating tools always ask for approval on a phone**, even when the computer has that tool set to Full.

Tablets and laptop browsers on wide screens get the full app. To use the full app on a phone, choose **⋯ → Settings → Use the desktop layout** in Chats; open Minnow with `?mobile=1` to switch back.

Saved chats and chat folders update across open Minnow windows within about five seconds and refresh when you return to the app. Your current chat, unsaved edits, and running turns are protected. Swipe toward older messages to pause automatic scrolling; **Jump to latest** resumes it.

## Security

- Every device signs in with its own revocable credential, kept in a secure cookie the phone's web pages cannot read. The computer stores only a SHA-256 hash of it.
- The computer's own sign-in works only in the desktop app. It is never accepted from the home network or the Anywhere address.
- Connected devices cannot connect, list, rename, or disconnect other devices.
- Requests that use a device's sign-in must come from Minnow's own page; other websites, including other programs on the same computer, cannot use it.
- Anywhere traffic is encrypted end to end between the phone and your computer.

More on the overall model: [Privacy and security](../reference/privacy-and-security.md).

## When it does not work

| Symptom | Check |
|---------|-------|
| **Can't reach** on home Wi-Fi | The phone is on the same Wi-Fi, not a guest network that isolates devices. The computer is awake and Minnow is open. |
| Home network card shows a busy port | Another program is using port 9480. Quit it and choose **Try again**. |
| Phone can't open the home-network address | The computer's firewall allows Minnow. |
| **Can't reach** away from home | The phone has internet. The computer is awake, online, and Minnow is open. |
| Anywhere card is stuck on a step | Finish the Tailscale page that opened, or choose **Cancel** and start again. |
| Set up with the wrong Tailscale account | Choose **Use a different account** on the Anywhere card, then sign in with the right one. |
| The QR link says it was used or expired | Codes work once and last ten minutes. Choose **Make a new code**. |
| Home Screen app asks to connect | Tap **Request access** and approve it on your computer. |
| A phone set up with an older version of Minnow can't reach it | Phones now use their own address (port 9480). Connect the phone again from **Settings → Devices**, and replace an old Home Screen app with a new one. |
| No microphone on the home network | Plain HTTP blocks the microphone. Use the Anywhere address. |

## Related

- [Privacy and security](../reference/privacy-and-security.md)
- [Settings app](../apps/settings.md)
- [Issues app](../apps/issues.md)
