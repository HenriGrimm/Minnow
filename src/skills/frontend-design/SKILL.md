---
name: frontend-design
description: Design, build, or refine frontend interfaces with project-specific art direction, working interactions, and rendered verification. Use for websites, apps, components, and focused UI repairs.
label: Frontend Design
user-invocable: true
disable-model-invocation: false
argument-hint: "[interface or flow to design, build, or refine]"
---

# Frontend Design

Create distinctive, usable interfaces through a coherent visual idea and working software. Apply this to the active project; preserve explicit user requirements, approved designs, existing components, and design-system conventions. For a focused repair, retain the surrounding design and use only the relevant checks.

## Design guidance

Read [the frontend aesthetics guide](reference/frontend-aesthetics.md) before substantial design work. It covers creative direction, hierarchy, density, typography, color, imagery, interaction, states, data views, responsive design, accessibility, motion, performance, and verification, with worked examples and primary-source attribution.

Use `load_skill` with `id: "frontend-design"` and `reference: "reference/frontend-aesthetics.md"`; follow `next_offset` until the relevant guidance is read. If that tool is unavailable, `load_aesthetics_reference` returns the same bundled guide, or read the file relative to this skill's directory with an available file tool. Never assume the active workspace contains Minnow's source tree. If the reference cannot be read, report that limitation and apply the workflow below.

## Workflow

1. **Understand the task.** Inspect real content, the implementation, design-system rules, and supplied references. Identify the audience, primary flow, scope, and observable success criteria. Resolve consequential unknowns; use stated assumptions for minor choices.
2. **Choose a direction.** For a new experience or redesign, form a subject-specific visual thesis and consider meaningfully different compositions. For an approved design, prioritize fidelity. Fit the surface: a work tool should expose its workspace, a brand page should explain its offering, and commerce should make product details and commitment clear.
3. **Compose and implement.** Establish content hierarchy, layout, semantic token roles, type, and an asset plan. Reuse sound project primitives. Build real interactions and relevant loading, empty, error, and recovery states. Keep claims and demonstration data honest.
4. **Inspect and refine.** Run the interface with realistic content. Inspect the whole page and relevant narrow layouts; exercise the primary flow and recovery with pointer and keyboard. Check focus, contrast, enlarged text, reduced motion, and performance as appropriate to the change. Fix the most consequential observed problems and recheck affected behavior.
5. **Deliver evidence.** Show the working result and visual evidence when available. Report checks performed, remaining issues, and any unverified behavior. A successful build or self-rating alone does not establish visual quality.

Use the project's available tools and permissions. This skill does not authorize unrelated redesigns, dependency installs, publication, or permission changes. If rendering, browser inspection, or asset generation is unavailable, use a deliberate fallback and state the verification gap.
