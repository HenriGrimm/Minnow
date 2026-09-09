# Skill chips in composer and chat

## Goal

Slash skills should look like dedicated command tokens (Cursor-style `/skill-id` pills), not plain text, and they must remain visible after send.

## Why

Send currently strips `/skill-id` from user text, stores `[skill: id]` as a footer, then the bubble renderer removes that footer. The thread looks like the skill was never used. The composer is a textarea, so tokens also never get a bespoke treatment while typing.

## Shape

- **Register:** product. **Color:** restrained; chips use family accent tokens (`--mn-accent-soft`, `--mn-accent-ink`, `--mn-accent-border`).
- **Scene:** developer at a repo, Code chat rail, sending `/impeccable` mid-task. Dark or light follows the active palette.
- **Anchor:** Cursor slash skill pills (user screenshot).
- **Not:** gradient text, glass, side stripes, or a second toolbar chip (pinned caveman stays as-is).

## Todos

- [x] Shared token split + restore `/skill-id` from `[skill:]` history footers
- [x] Render inline `.skill-chip` in user message bubbles
- [x] Composer highlight overlay on Code + Chat composers
- [x] Edit / copy / prompt-history restore the leading slash token
- [x] Tests + `documentation/context.md`

## Out of scope

- Changing which skill is injected into the model
- Multi-skill agent execution (still first slash token)
- Pinned caveman/party toolbar chip redesign
