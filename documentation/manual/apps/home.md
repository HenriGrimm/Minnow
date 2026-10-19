# Dashboard

Dashboard runs your project's issues through **Triage**, **Ready**, **In Progress**, **Review**, and **Done**. It uses the same issues, chats, models, and worktrees as Code and Issues.

Change an issue's status using the status dropdown on its card or in the issue workspace header. The menu includes your custom statuses. Grouped cards have a separate dropdown for each issue. Status changes save to the shared issue tracker; agent activity and merge controls continue to reflect the actual worktree run.

## Capture and plan

When the project has no issues, Dashboard shows a goal field instead of empty columns. Enter a goal or an error, then choose **Add issue** to create an issue in Triage. **Plan a goal** asks your utility model (or last selected chat model) for draft tasks. Review the drafts, then choose **Add to Ready**, **Add and select**, or **Discard**. Planning drafts does not start agents or edit project files. The issue flow appears when issues are added; the goal field then stays in the header. **Continue building in Code** returns to your existing Code session.

Select **Accept to Ready** to accept a triage issue. Existing issue statuses follow the roles configured in Settings → Issues. Closed and canceled issues retain their existing meaning.

## Send issues to agents

Use card checkboxes to select issues. Shift-click selects a range within a column; **Select all** selects a column. Escape clears the selection.

The send bar groups issues **By files**, **Each**, or in **One chat**. File grouping uses actual linked file paths, including overlapping groups. Issues without linked files remain separate. **Options** selects the model and Build or Plan first mode. Plan first requires approval before implementation.

Each group gets a background chat and a managed worktree branched from the local `main` branch (`master` is the fallback). Minnow installs project dependencies in that worktree. The active chat and your checkout remain available.

Blocked groups are held until their blockers close or merge. **Start from main** explicitly skips that wait. Groups beyond the configured agent capacity wait for a slot. A batch shares one chat and worktree. Adding issues to a running isolated chat shares that chat's worktree; blocked issues stay selected. Instructions enter the running chat through its existing steering queue.

## Review in the dock

Select a card to open its workspace in the bottom dock. The header shows the issue, agent state, branch, merge target, and number of issues sharing the worktree. Open **Details** to view and edit the full issue with the same layout as the Issues app popover, including its description, saved plan, properties, resources, and comments. Drag the divider or use its arrow keys to resize the dock; **Maximize details** gives it the full workspace. Collapse keeps your draft and current view.

**Conversation** uses the same message and tool rendering as Code. Agent questions use the shared answer controls. Send a message to request changes; finished work returns to Review. You can draft a message while the agent works, then pause or wait before sending. **Pause** stops the current turn and keeps the chat and worktree. **Resume** continues it. **Open in Code** opens the linked chat.

For a new issue, the formatted brief and start controls share one reading column. Add optional instructions, choose Build or Plan first, then select **Start build** or **Start planning**. **Approve plan & build** switches a completed Plan first chat to Build.

**Changes** shows committed and uncommitted changes against the merge target. Select a file to inspect its diff. The diff occupies the workspace; use **Conversation** to review the agent’s messages or request changes. **Details** keeps issue editing in the dock and opens automatically when a plan is ready for approval.

**Merge into main** (or the configured target) queues the merge. Shared work shows every affected issue beside the action. If changes remain uncommitted, **Ask agent to commit** sends them back for preparation. Minnow verifies that the managed worktree is committed and checks the merge in a temporary checkout before updating the target. Conflicts keep the branch and worktree. Ask the agent to resolve them or inspect them in Code. Git refuses a landing that overlaps uncommitted changes in the target checkout. After a successful merge, Minnow removes the clean agent worktree and moves the issues to Done.

## Refresh

Project data refreshes every 10 seconds while Dashboard is visible. Conversation updates preserve the message draft and scroll position. A failed refresh retains the last successful data with a retry action. The shell's workspace picker switches projects; **Open Code** opens the development workspace.

Use **Model** in the launch controls to choose a model or pool for new chats. It follows the last composer selection until you choose an override. The choice applies to that dispatch without changing the remembered chat model; adding work to an existing chat keeps its model.
