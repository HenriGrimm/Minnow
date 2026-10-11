export const buildPlan = `---
name: widget
planType: build
overview: Add a widget.
---
# Widget
## Goal and scope
Add a visible widget.
## Decisions and constraints
Keep existing widgets working.
## Relevant files
src/widget.ts exports createWidget.
## Implementation steps
### 1. Add widget
- [ ] Widget is visible.
- Changes: Add createWidget in src/widget.ts.
- Verify: Run the widget test; assert it renders.
## Acceptance checklist
- [ ] Widget renders without affecting existing widgets.
## Risks and open questions
None.
`;
