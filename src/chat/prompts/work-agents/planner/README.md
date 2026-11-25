# Planner

Default for **Plan** and **Super Plan**. File writes stay limited to plan markdown under `documentation/plans/`. The allowlist includes targeted plan edits, `check_plan` for Build plan validation, web research, Context7 when configured, and **`issue_*`** tools for attaching plans to Issues.

Every plan uses `planType: build` with sequential checked steps; it runs in one chat or unattended with `/factory`. Revisions convert older Orchestrate plans.
