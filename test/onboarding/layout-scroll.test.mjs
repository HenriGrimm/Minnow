import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const onboardingCss = readFileSync(new URL('../../src/styles/onboarding.css', import.meta.url), 'utf8');

function ruleBlock(selector) {
  return onboardingCss.split(`\n${selector} {`)[1]?.split('}')[0] ?? '';
}

test('setup uses a bounded dialog above the visible workspace', () => {
  assert.match(ruleBlock('.mn-onboarding'), /background:\s*var\(--mn-overlay\)/);
  const dialogRule = ruleBlock('.mn-onboarding__dialog');
  assert.match(dialogRule, /width:\s*min\(100%,\s*640px\)/);
  assert.match(dialogRule, /max-height:\s*100%/);
  assert.match(dialogRule, /grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
  assert.doesNotMatch(onboardingCss, /onboarding-active[^{]*\{[^}]*visibility:\s*hidden/);
});

test('long setup steps scroll within the dialog while footer actions remain reachable', () => {
  const contentRule = ruleBlock('.mn-onboarding-step');
  assert.match(contentRule, /min-height:\s*0/);
  assert.match(contentRule, /overflow-y:\s*auto/);
  assert.match(contentRule, /overscroll-behavior:\s*contain/);
});
