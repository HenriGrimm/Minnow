import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOMATION_PRESETS,
  buildPresetPrompt,
  defaultPresetConfig,
  describePrReviewSteps,
  normalizePresetConfig,
  presetCapabilities,
} from '../../src/lib/automation-presets.mjs';
import { describeAnySchedule, parseNaturalSchedule } from '../../src/lib/natural-schedule.mjs';

describe('automation presets', () => {
  test('every preset has a valid default config and instructions', () => {
    for (const preset of AUTOMATION_PRESETS) {
      const config = { ...defaultPresetConfig(preset.id), ...(preset.group === 'github' ? { repository: 'owner/repo' } : {}) };
      const normalized = normalizePresetConfig(preset.id, config);
      assert.ok(buildPresetPrompt(preset.id, normalized).length > 20, preset.id);
    }
  });

  test('GitHub presets require owner/repository', () => {
    assert.throws(() => normalizePresetConfig('pr-review', { repository: '' }), /owner\/repository/);
    assert.throws(() => normalizePresetConfig('ci-fixer', { repository: 'not a repo' }), /owner\/repository/);
  });

  test('PR Reviewer config drops unknown reviewers and keeps choices', () => {
    const config = normalizePresetConfig('pr-review', { repository: 'Mira/Shoal', reviewers: ['tests', 'bogus'], onPass: 'merge', claim: false, interval: '9m' });
    assert.equal(config.repository, 'mira/shoal');
    assert.deepEqual(config.reviewers, ['tests']);
    assert.equal(config.onPass, 'merge');
    assert.equal(config.claim, false);
    assert.equal(config.interval, '2m');
    assert.ok(presetCapabilities('pr-review', config).includes('merge'));
    assert.ok(!presetCapabilities('pr-review', { ...config, onPass: 'comment', onFail: 'comment' }).includes('merge'));
  });

  test('PR Reviewer steps and instructions follow the options', () => {
    const base = normalizePresetConfig('pr-review', { repository: 'o/r' });
    assert.equal(describePrReviewSteps(base)[1].title, 'Claim it');
    assert.equal(describePrReviewSteps({ ...base, claim: false }).some((s) => s.title === 'Claim it'), false);
    const text = buildPresetPrompt('pr-review', { ...base, onPass: 'approve' });
    assert.match(text, /Review in progress/);
    assert.match(text, /approve it/);
  });
});

describe('plain-words schedules', () => {
  const cases = [
    ['every weekday at 9am', 'cron', '0 9 * * 1-5', 'Weekdays at 9:00 AM'],
    ['every 5 minutes', 'interval', '5m', 'Every 5 minutes'],
    ['mondays at 8', 'cron', '0 8 * * 1', 'Mondays at 8:00 AM'],
    ['daily at 6pm', 'cron', '0 18 * * *', 'Daily at 6:00 PM'],
    ['hourly', 'interval', '1h', 'Every hour'],
    ['tuesdays and thursdays at 14:30', 'cron', '30 14 * * 2,4', 'Tuesdays and Thursdays at 2:30 PM'],
    ['0 9 * * 1-5', 'cron', '0 9 * * 1-5', 'Weekdays at 9:00 AM'],
    ['manual', 'manual', 'manual', 'Only when you run it'],
  ];
  for (const [input, kind, value, description] of cases) {
    test(input, () => {
      const parsed = parseNaturalSchedule(input);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      assert.deepEqual(parsed.schedule, { kind, value });
      assert.equal(parsed.description, description);
    });
  }

  test('rejects sub-minute and unknown phrases', () => {
    assert.equal(parseNaturalSchedule('every 30 seconds').ok, false);
    assert.equal(parseNaturalSchedule('whenever').ok, false);
  });

  test('describes stored schedules', () => {
    assert.equal(describeAnySchedule({ kind: 'interval', value: '2m' }), 'Every 2 minutes');
    assert.equal(describeAnySchedule({ kind: 'cron', value: '*/7 * * * *' }), 'Cron */7 * * * *');
  });
});
