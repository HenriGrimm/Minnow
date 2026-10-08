/**
 * load_aesthetics_reference returns a complete, project-neutral design reference.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { toolLoadAestheticsReference } from '../../server/design/load-aesthetics-reference.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

describe('load_aesthetics_reference tool', () => {
  it('returns the bundled frontend-aesthetics markdown body', async () => {
    const { result } = await toolLoadAestheticsReference(PROJECT_ROOT);
    assert.ok(!result.startsWith('Error:'), result.slice(0, 200));
    assert.match(result, /# Frontend Aesthetics/);
    assert.match(result, /Specificity Ladder/);
    assert.match(result, /Project-neutral design reference/);
    assert.doesNotMatch(result, /TODO\(human\)|human-reviewed\. NOT auto-synced/);
  });

  it('provides substantive guidance, review checks, and worked examples', async () => {
    const { result } = await toolLoadAestheticsReference(PROJECT_ROOT);
    const sections = new Map(
      result.split(/^## /m).slice(1).map((section) => {
        const newline = section.indexOf('\n');
        return [section.slice(0, newline).trim(), section.slice(newline + 1).trim()];
      }),
    );
    for (const heading of [
      'Visual Hierarchy', 'Density', 'Color Systems', 'Type Pairing',
      'Motion Restraint', 'The Specificity Ladder', 'Worked Examples',
      'Discover the Brief', 'Creative Direction', 'Match the Surface',
      'Imagery and Iconography', 'Components and Interaction',
      'Forms, States, and UX Copy', 'Data and Complex Workspaces',
      'Responsive and International Design', 'Accessibility as a Design Constraint',
      'Performance and Implementation Craft', 'Critique and Visual Verification',
    ]) {
      const body = sections.get(heading);
      assert.ok(body && body.length > 300, `${heading} must contain substantive guidance`);
      assert.doesNotMatch(body, /\bTODO\b|\bTBD\b|placeholder/i);
      if (heading !== 'Worked Examples') assert.match(body, /\*\*Review check:\*\*/);
    }
    const examples = sections.get('Worked Examples');
    const beforeCount = (examples.match(/\*\*Before:\*\*/g) ?? []).length;
    assert.ok(beforeCount >= 5, 'cover brand, product, forms, async work, and content');
    assert.equal((examples.match(/\*\*After:\*\*/g) ?? []).length, beforeCount);
    assert.equal((examples.match(/\*\*Acceptance check:\*\*/g) ?? []).length, beforeCount);
  });

  it('keeps guidance project-neutral, sourced, and explicit about verification limits', async () => {
    const { result } = await toolLoadAestheticsReference(PROJECT_ROOT);
    assert.doesNotMatch(result, /Minnow application|--mn-|src\/styles\/tokens\.css|JetBrains Mono/);
    for (const source of [
      'https://impeccable.style/',
      'https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md',
      'https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4',
      'https://w3c.github.io/wcag/understanding/contrast-minimum.html',
      'https://web.dev/articles/vitals',
    ]) assert.ok(result.includes(source), `Missing primary source: ${source}`);
    for (const heading of [
      'Quality Rubric', 'Delivery Checklist', 'Sources and Editorial Decisions',
    ]) assert.ok(result.includes(`## ${heading}`), `Missing ${heading}`);
    assert.match(result, /build → render → critique → refine → recheck/);
    assert.match(result, /No prompt, score, or checklist guarantees world-class work/);
    assert.match(result, /unverified/);
  });

  it('returns the entire reference within a single bounded tool response', async () => {
    const { result } = await toolLoadAestheticsReference(PROJECT_ROOT);
    const source = await readFile(
      path.join(PROJECT_ROOT, 'src/skills/frontend-design/reference/frontend-aesthetics.md'), 'utf8',
    );
    assert.equal(result, source);
    assert.ok(Buffer.byteLength(result, 'utf8') <= 40_000, 'keep the reference below 40 KB');
  });

  it('returns Error when reference file is missing', async () => {
    const bogusRoot = path.join(PROJECT_ROOT, 'test/fixtures/memory-home-empty');
    const { result } = await toolLoadAestheticsReference(bogusRoot);
    assert.ok(result.startsWith('Error:'));
    assert.match(result, /missing frontend-aesthetics reference/);
    assert.match(result, /Update or reinstall Minnow/);
    assert.doesNotMatch(result, /npm install/);
  });
});
