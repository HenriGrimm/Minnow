import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { executeServerTool } from '../../server/runtime/tools-middleware.js';
import { buildPlan } from '../helpers/build-plan.mjs';

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

test('check_plan directs legacy plans to the Build format', async () => {
  await fs.writeFile(path.join(workspace, planPath), validPlan);
  assert.match(await check(), /planType: build/);
});

test('check_plan requires a path inside the workspace', async () => {
  const missing = await executeServerTool('check_plan', {}, { workspaceRoot: workspace });
  assert.match(missing.result, /Error: path is required/);
  const outside = await executeServerTool('check_plan', { path: '../outside.md' }, { workspaceRoot: workspace, filesystemAccessCeiling: 'workspace' });
  assert.match(outside.result, /outside the workspace directory/);
});

test('check_plan validates Build plans and reports step repairs', async () => {
  await fs.writeFile(path.join(workspace, planPath), buildPlan);
  assert.match(await check(), /Build plan parses successfully: 1 sequential step/);
  await fs.writeFile(path.join(workspace, planPath), buildPlan.replace('- Verify:', '- Missing:'));
  assert.match(await check(), /Step 1 needs Verify/);
  await fs.writeFile(path.join(workspace, planPath), buildPlan.replace('planType: build', 'planType: unknown'));
  assert.match(await check(), /planType: build/);
});
