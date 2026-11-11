# Work Agent template (reference)

<!--
Copy this folder layout for a new agent:

src/chat/prompts/work-agents/<id>/
  agent.full.md
  README.md

Add <id> to registry.json ids[].
-->

```yaml
---
id: my-agent
label: My Agent
kind: work-agent
version: "1"
description: One-line purpose.
providerId: null          # or openai-compatible provider id from ~/.minnow/providers
modelId: null             # or model id on that provider
defaultForModes:          # optional — auto when workAgentAuto is on
  - build
allowedTools:             # optional — null = all mode-allowed tools
  - read_file
  - read_document
  - list_directory
---
```

Body supports interpolation: `{{work_agent}}`, `{{work_agent_label}}`, `{{mode}}`, `{{mode_label}}`, `{{cwd}}`.

User overrides:

- `~/.minnow/work-agents.json` — `{ "my-agent": { "providerId", "modelId", "disabled" } }`
- `~/.minnow/prompts/work-agents/<id>/agent.full.md` — prompt file override
