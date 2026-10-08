---
name: image-generation
label: Generate an image
description: Generate or edit raster assets in the current workspace using Minnow's configured image provider and approved image tools.
---

Use this skill for photos, illustrations, textures and raster assets. Prefer the project's existing SVG/icon system or code for interface structure and diagrams.

1. Inspect asset conventions and call `image_generation_info`. If unavailable, direct the user to Models → Routing → Image generation and provider credentials. Never inherit the chat model, use a native CLI image tool, install a runtime, or call a provider through shell/HTTP as a workaround.
2. Clarify only material missing requirements: subject, purpose, composition, dimensions, transparency, and what an edit must preserve. Use supported options reported by the tool; do not invent model IDs or credentials.
3. Plan mode may inspect status and prepare prompts, but cannot generate or edit images. Respect Full/Ask/Off and role restrictions. Enabling this skill does not grant permission.
4. Call `generate_image` with one prompt. Reference-image edits require `operation: edit` and workspace-relative `reference_paths`; these files leave the machine. Explain new paid calls during iteration. Approval names the provider/model, destination and uploads. Unknown cost is not zero.
5. Use the returned job ID and real artifact path. If canceled or `outcome_unknown`, call `image_generation_info` with `job_id`; never blindly resubmit. Cancellation may not prevent provider charges.
6. Verify actual format, dimensions and saved path. Inspect pixels only when the current model supports vision and receives an image attachment. Text-only agents must report metadata without claiming visual inspection.
7. Use the asset in project code only when the current task and mode authorize edits. Preserve all originals. Each revision uses a prior saved reference and a new output path. Report the resulting asset and any limitations.

Generation example: `generate_image({"prompt":"A quiet forest illustration for a website hero"})`.

Edit example: `generate_image({"prompt":"Keep the composition; change the sky to dusk","operation":"edit","reference_paths":["assets/forest.png"]})`.
