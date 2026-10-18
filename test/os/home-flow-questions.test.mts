import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from './dom-helpers.mts';
import { launchInstance, resetInstancesForTests } from '../../src/os/instances.ts';
import { setHomeQuestionHost, clearHomeQuestionHost } from '../../src/home/question-host.ts';
import { notifyAskQuestionDisplayContextChanged } from '../../src/chat/ask-question-display.ts';
import { showQuestionCardsModal, resetQuestionCardsModalForTests } from '../../src/ui/question-cards-modal.ts';

test('a background chat question parks with its Home dock and can be answered on return', { timeout: 5000 }, async () => {
  const win = new Window(); installHappyDomGlobals(win); seedMinimalSession('keep-active');
  document.body.innerHTML = '<div id="homeFlowQuestions"></div>';
  launchInstance('home');
  const host = document.getElementById('homeFlowQuestions')!;
  try {
    setHomeQuestionHost('background-chat', host);
    const result = showQuestionCardsModal({ questions: [{ id: 'scope', prompt: 'Which checks?', allow_multiple: true, options: [{ id: 'unit', label: 'Unit checks' }, { id: 'browser', label: 'Browser checks' }] }] }, {}, { chatId: 'background-chat' });
    assert.ok(host.querySelector('.question-cards-panel'));
    clearHomeQuestionHost(); notifyAskQuestionDisplayContextChanged();
    assert.equal(host.hidden, true);
    setHomeQuestionHost('background-chat', host); notifyAskQuestionDisplayContextChanged();
    assert.ok(host.querySelector('.question-cards-panel'));
    assert.equal(host.hidden, false);
    host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    const submit = host.querySelector<HTMLButtonElement>('.question-cards-submit')!;
    assert.equal(submit.disabled, false); submit.click();
    const answer = await result;
    assert.equal(answer.status, 'answered');
    if (answer.status === 'answered') assert.deepEqual(answer.answers[0].selectedIds, ['unit']);
  } finally { clearHomeQuestionHost(); resetQuestionCardsModalForTests(); resetInstancesForTests(); await teardownHappyDomAsync(win); }
});
