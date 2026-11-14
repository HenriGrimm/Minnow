# Inspect board worker results

Open the task and choose **Activity** to read attempts. Compare the builder's work with the tester's evidence and the requirements under **Spec**.

| What you see | What to do |
| --- | --- |
| **Pass** | Read the evidence and check that it covers the required behavior. If the tested changes move during a rebase, wait for the board to verify them again. |
| **Fail** | Open the failing command or assertion. Confirm the board is repairing that specific failure, then read the next tester attempt. |
| **Blocked** | Open **Needs attention**, resolve the named environment or prerequisite, and use **Check again** when offered. |
| Integration check failed | Open the integration repair result separately, then check that final verification ran on the updated branch. |

Use **Retry** when the task offers it. Review the checkout before using **Reset** or **Rewind**, which can discard task work or return integration to an earlier point. **Skip** records a waiver. In **Settings**, search **Autopilot** for retry and time limits. Board model changes apply to new attempts.
