# Image generation native CLI gate

Inspection date: 2026-10-07. Verdict: **not enabled / gate incomplete** for both native backends.

| Evidence | Codex | Cursor |
| --- | --- | --- |
| Local version command | `codex --version`: `codex-cli 0.160.0` | `cursor --version`: `3.23.12`, commit `2d29876d567da1607532b23bbf2cd5ddbca496f0`, x64 |
| Interpretation | Installed CLI version only | Desktop launcher version; does not establish ACP/agent protocol version |
| Existing isolation | `server/generations/codex-app-server/manager.js` and `server/generations/agent-cli/invocation.js` still disable `image_generation` | Existing ACP permission checks retained |
| Account entitlement / paid generation | Not tested | Not tested |
| Approval before native submission | Not established | Not established |
| Reference disclosure, isolated artifact capture | Not established | Not established |
| Cancellation, upstream billing, replay | Not established | Not established |

No native image backend was registered or exposed as selectable. Version output alone is not a positive readiness signal. No subscription tokens were extracted and no live paid requests were made. W4-B's protocol/account probes and measured feasibility gate remain follow-on work, as does any subsequent implementation plan after a positive verdict.
