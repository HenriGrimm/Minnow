# Home

Home runs your project's issues through **Triage**, **Ready**, **In Progress**, **Review**, and **Done**. It uses the same issues, chats, models, and worktrees as Code and Issues.

## Capture and plan

Enter a goal or an error in the header. **Capture** creates an issue in Triage. **Plan into tasks** asks your utility model (or default model) for draft tasks. Review the drafts, then choose **Add to Ready**, **Add and select**, or **Discard**. Planning drafts does not start agents or edit project files.

Select **Accept to Ready** to accept a triage issue. Existing issue statuses follow the roles configured in Settings → Issues. Closed and canceled issues retain their existing meaning.

## Send issues to agents

Use card checkboxes to select issues. Shift-click selects a range within a column; **Select all** selects a column. Escape clears the selection.

The send bar groups issues **By files**, **Each**, or in **One chat**. File grouping uses actual linked file paths, including overlapping groups. Issues without linked files remain separate. **Options** selects the model and Build or Plan first mode. Plan first requires approval before implementation.

Each group gets a background chat and a managed worktree branched from the local `main` branch (`master` is the fallback). Minnow installs project dependencies in that worktree. The active chat and your checkout remain available.

Blocked groups are held until their blockers close or merge. **Start from main** explicitly skips that wait. Groups beyond the configured agent capacity wait for a slot. A batch shares one chat and worktree. Adding issues to a running isolated chat shares that chat's worktree; blocked issues stay selected. Instructions enter the running chat through its existing steering queue.

## Review in the dock

Select a card to open the bottom dock. It shows the issue, chat, worktree, branch, and target, along with the latest conversation. Agent questions use the shared answer controls. Send a message to request changes; finished work returns to Review. **Pause** stops the current turn and keeps the chat and worktree. **Resume** continues it.

For a new issue, review its description and linked context, add optional instructions, and start a chat. **Approve plan · build** switches a completed Plan first chat to Build.

Review the agent's reported checks in the conversation. **Approve · queue merge** serializes approvals, verifies that the managed worktree is committed, and checks the merge in a temporary checkout before updating the target. Conflicts keep the branch and worktree. Ask the agent to rebase or resolve in Code. Git refuses a landing that overlaps uncommitted changes in the target checkout. After a successful merge, Minnow removes the clean agent worktree and moves the issues to Done.

Preview uses an explicit handoff to Code. The dock also contains a scoped command console under **Terminal**, repository status under **Git**, linked plans and boards under **Plans**, and project jobs under **Scheduled**.

## Refresh

Project data refreshes every 10 seconds while Home is visible. Conversation updates preserve the message draft and scroll position. A failed refresh retains the last successful data with a retry action. The shell's workspace picker switches projects; **Open Code** opens the development workspace.
