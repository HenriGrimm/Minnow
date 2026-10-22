# Board work agents

Boards use the shared chat runner and tool system for two worker roles.

| Role | Responsibility |
| --- | --- |
| **Builder** | Implements one task, repairs concrete failures and preserves completed work |
| **Tester** | Independently verifies the task's Test and Accept requirements without modifying application code |

The server schedules work, serializes merges, and runs final integration checks. A separate planner or supervisor agent does not drive the board.

## Reports

Workers call `report_outcome` with their observed result:

- **pass**: the required behavior was demonstrated.
- **fail**: an implementation defect or failing assertion was observed.
- **blocked**: a required prerequisite or verification capability is unavailable.

A blocked report names the specific need. The board either attempts supported local recovery or retains the work while awaiting the prerequisite. An unavailable environment is not evidence that the implementation failed.

Workers can include typed prerequisites for workspace-relative files, executable names, local service ports or browser capability. These use read-only checks and resume automatically when resolved. Free-text needs remain available for requirements that cannot be checked automatically.

Recovery-enabled testers receive required verification IDs from the current task specification. A passing report includes each ID and observed evidence; missing or unexecuted required checks cannot pass.

Required browser checks run through supported project test commands or available server browser tools. A worker cannot substitute source inspection for required rendered behavior.

## Repair and continuation

Repairs reuse the task checkout and receive the original specification, previous report and relevant failure evidence. Repeated failures enter diagnosis before exhausting the configured budget. Independent test approval is renewed when rebasing changes the tested content.

Final integration failures create their own repair task. They do not replace the scope of an unfinished original task.

## Configuration

Choose the board model and reasoning in its header. New attempts inherit the updated selection; active attempts keep theirs.

**Settings → Autopilot** controls repair allowances, final repair rounds, the board-wide recovery budget and attempt duration. Provider-wide waits share admission with other work using that account. Tool permissions and workspace boundaries still apply during recovery.

See [Orchestrate boards](boards.md) for run controls, retained work and action holds.
