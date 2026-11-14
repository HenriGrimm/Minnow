# Troubleshoot Minnow

Open Settings and search **Health and diagnostics** if several features fail at once. Inspect the failing subsystem and use **Copy report** if you need to report it. Read the exported report before sharing it.

## No model, no response, or an incomplete reply

1. Open **Models → Providers** and refresh the connection. For an agent CLI, use **Models → Subscriptions → Verify**.
2. For a local runtime, check that it is running and the model is loaded. For a managed model, read **Models → Local server** logs. For a cloud endpoint, check the API URL, key, and quota.
3. Open a new thread with the same model and send a short prompt. If that works, return to the original thread and attach only the files needed for a smaller follow-up. Check [Routing](../apps/models.md#routing) if a support task uses a different provider.

## Changes or files are missing

Open the thread card and check the workspace and branch. Open **Files** or **Terminal** in the same thread and confirm the path. Check the **Edited** summary under the reply for that turn's changes. Use **Open workspace diff** for the main workspace or open **Source control** to inspect staged and unstaged work. Verify that the folder is a Git repository for checkout-level diff and commit commands.

If a tool stops at an approval, look in **Activity → Needs you**. Confirm the command or path before approving. If a tool cannot write during **/ask** or **/plan**, use a new ordinary turn for implementation.

## The preview is blank

Open the exact local URL in your system browser. If it fails there, check the listening address and port in **Terminal** or **Dev servers** and fix the startup error first. If it works there, reload the **Browser** surface and confirm you are using the desktop app for native preview and agent browser tools.

## A thread, board, or automation is waiting

- For a thread, read its last tool step, check pending approvals in Activity, and inspect its child runs in **Agents**. If asked to **Confirm stopped**, verify the command has stopped on the host first.
- For a board, open **Needs attention**. Open the task's **Activity** and read the latest build or test result. Resolve the displayed prerequisite and use **Check again** when offered.
- For an automation, inspect its latest run and schedule. Minnow must be running when it is due. If the prompt needs approval, interactive input, or a desktop-only tool, the run cannot get it.

When reporting a problem, include the Minnow version, OS, the steps that reproduce it, the expected result, and the first error. [Minnow issues](https://github.com/HenriGrimm/Minnow/issues)
