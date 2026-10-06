import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { executeServerTool } from '../../server/runtime/tools-middleware.js';

let workspace;

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-check-plan-'));
  await fs.mkdir(path.join(workspace, 'documentation', 'plans'), { recursive: true });
});

after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

const planPath = 'documentation/plans/widget.md';
const validPlan = `---
name: widget
overview: Add a widget.
todos:
  - id: W1-A
    content: "Wave 1: Add widget"
    status: pending
isProject: true
---

# Widget

## Wave Breakdown

### Wave 1 — Widget

#### Task W1-A: Add widget
- **Build:** Add src/widget.ts.
- **Test:** Run the widget test.
- **Accept:** The widget is available.
- **Touches:** src/widget.ts
`;

async function check() {
  return (await executeServerTool('check_plan', { path: planPath }, { workspaceRoot: workspace })).result;
}

test('check_plan uses the board parser for saved plans and reports repairable errors', async () => {
  await fs.writeFile(path.join(workspace, planPath), validPlan);
  assert.match(await check(), /Plan parses successfully: 1 task\(s\) across 1 wave\(s\)/);

  await fs.writeFile(path.join(workspace, planPath), validPlan.replace('- **Test:** Run the widget test.\n', ''));
  const result = await check();
  assert.match(result, /Plan does not parse:/);
  assert.match(result, /line \d+:\d+/);
  assert.match(result, /hint:/);
});

test('check_plan requires a path inside the workspace', async () => {
  const missing = await executeServerTool('check_plan', {}, { workspaceRoot: workspace });
  assert.match(missing.result, /Error: path is required/);
  const outside = await executeServerTool('check_plan', { path: '../outside.md' }, { workspaceRoot: workspace });
  assert.match(outside.result, /outside the workspace directory/);
});
