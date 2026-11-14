# Test a Minnow release in Graphite

Use a packaged build, a disposable Minnow home, and a small Git repository with a test command and a local preview. Record the version, platform, provider, and workspace used. Use a disposable remote for the GitHub checks.

Before testing the package, confirm the build's CI results. For a source build, run `npm run test:check-coverage`, `npm run test:product-wiki`, and `npm run check:performance-budgets` after building.

## Install and run the build loop

1. Launch the package. In **Choose a workspace**, open a folder and confirm Code displays it. Connect a model and send the read-only prompt in the [first-change walkthrough](../manual/get-started/first-chat.md).
2. Set **Manual** in the composer and request a small file edit. Confirm the correct path appears in approval, grant it once, then verify the change under **Diff**. Repeat with a denial and confirm the tool respects it.
3. Open **Files**, save an editor change, and check the workspace diff. Open **Terminal** from the bottom launcher, run a project check, and confirm its checkout. Open **Browser** and load the test project's local URL.
4. Open **Source control**, inspect and stage the intended hunk or file, and commit. For a GitHub repo, verify PRs and Actions after signing in from External Connections.
5. Open the thread card, switch threads, then return. Confirm the current checkout, surface placement, transcript, and model. Use the sidebar, command palette, thread search, and archive to locate the earlier work.

## Check integrations and recovery

- Start an issue thread in a new worktree and verify its branch and linked issue. Open a board and check build/test progress, pause/resume, and a failure that enters **Needs attention**. See [board test scenarios](../contributor/orchestrate-board-testing.md).
- Run a custom automation manually, inspect the run and its transcript, then check that a scheduled run shows its next time. Verify tray behavior separately from fully quitting.
- Open the manual, search for a common task, and follow a link to another page. Ask a chat to find a manual page and cite its path.
- Open **Models → Discover** and confirm a model's files and memory estimate render. With a local provider and a hosted or CLI provider available, switch between them and confirm the activated model appears in the thread card.
- Check that a configured model, thread, issue, and Brain page survive a restart. Exercise a protected backup and restore into a fresh profile. Verify that project files at their original paths are intact.
- On a supported phone, pair from **Settings → General → Devices**, open the same thread, and send a follow-up. Disconnect the device from Settings and confirm access ends.
- In a packaged build, inspect update status and restart behavior. Follow the version's [release runbook](../maintainer/releasing.md).

For a failure, save reproduction steps, the first useful error, and a screenshot. Use **Settings → About → Health and diagnostics → Copy report** for a diagnostic summary and review it before sharing.
