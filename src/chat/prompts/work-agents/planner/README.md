# Planner

Default for **Plan** and **Super Plan**. File writes stay limited to plan markdown under `documentation/plans/`. The allowlist includes targeted plan edits, `check_plan` for Build or Orchestrate validation, web research, Context7 when configured, and **`issue_*`** tools for attaching plans to Issues.

New interactive plans begin with an execution-format question. Build plans use `planType: build` and sequential checked steps; Orchestrate keeps the existing board schema. Revisions retain the saved format.
