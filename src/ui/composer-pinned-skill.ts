import { createIconButton, createSelect } from './components';
import { getActiveChat, scheduleSaveSessions, touchChat } from '../state/sessions';
import { CAVEMAN_SKILL_ID, DEFAULT_CAVEMAN_INTENSITY, isCavemanIntensity } from '../skills/caveman-client';
import { PARTYMODE_SKILL_ID } from '../skills/partymode-client';
import type { PinnedSkillState } from '../skills/types';
import { listCavemanIntensityOptions } from '../skills/config';

let stripEl: HTMLDivElement | null = null;
let labelEl: HTMLSpanElement | null = null;
let selectEl: HTMLSelectElement | null = null;
let dismissBtn: HTMLButtonElement | null = null;

function ensureStrip(): HTMLDivElement {
  if (stripEl) return stripEl;

  stripEl = document.createElement('div');
  stripEl.id = 'pinnedSkillStrip';
  stripEl.className = 'composer-control pinned-skill-control hidden';
  stripEl.setAttribute('aria-live', 'polite');

  labelEl = document.createElement('span');
  labelEl.className = 'composer-control-label pinned-skill-control__label';
  labelEl.textContent = 'Caveman';

  selectEl = createSelect({ appearance: 'surface', id: 'pinnedSkillIntensity', size: 'sm', className: 'pinned-skill-control__select', ariaLabel: 'Caveman intensity', options: listCavemanIntensityOptions().map(level => ({ value: level, label: level })) });
  dismissBtn = createIconButton({ appearance: 'surface', icon: 'close', label: 'Unpin caveman mode', size: 'sm', className: 'pinned-skill-control__dismiss' });
  dismissBtn.textContent = '×';

  dismissBtn.addEventListener('click', () => {
    const chat = getActiveChat();
    chat.pinnedSkill = null;
    touchChat(chat);
    scheduleSaveSessions();
    syncComposerPinnedSkillFromActiveChat();
  });

  selectEl.addEventListener('change', () => {
    const chat = getActiveChat();
    const pinned = chat.pinnedSkill;
    if (!pinned || pinned.id !== CAVEMAN_SKILL_ID) return;
    const value = selectEl?.value ?? DEFAULT_CAVEMAN_INTENSITY;
    chat.pinnedSkill = {
      id: CAVEMAN_SKILL_ID,
      intensity: isCavemanIntensity(value) ? value : DEFAULT_CAVEMAN_INTENSITY,
    };
    touchChat(chat);
    scheduleSaveSessions();
    syncComposerPinnedSkillFromActiveChat();
  });

  stripEl.appendChild(labelEl);
  stripEl.appendChild(selectEl);
  stripEl.appendChild(dismissBtn);

  const host = document.getElementById('composerControls');
  const anchor = document.getElementById('workAgentDev');
  if (host) {
    if (anchor?.parentNode === host) {
      host.insertBefore(stripEl, anchor);
    } else {
      host.appendChild(stripEl);
    }
  }

  return stripEl;
}

function currentIntensity(pinned: PinnedSkillState): string {
  if (isCavemanIntensity(pinned.intensity)) {
    return pinned.intensity;
  }
  return DEFAULT_CAVEMAN_INTENSITY;
}

/** Show or hide the pinned skill chip from the active chat. */
export function syncComposerPinnedSkillFromActiveChat(): void {
  const strip = ensureStrip();
  const chat = getActiveChat();
  const pinned = chat.pinnedSkill;

  const isCaveman = pinned?.id === CAVEMAN_SKILL_ID;
  const isPartyMode = pinned?.id === PARTYMODE_SKILL_ID;

  if (!pinned || (!isCaveman && !isPartyMode)) {
    strip.classList.add('hidden');
    strip.classList.remove('pinned-skill-control--party');
    return;
  }

  strip.classList.remove('hidden');
  strip.classList.toggle('pinned-skill-control--party', isPartyMode);

  if (labelEl) {
    labelEl.textContent = isPartyMode ? '🎉 Party Mode' : 'Caveman';
  }

  if (selectEl) {
    selectEl.classList.toggle('hidden', isPartyMode);
    if (isCaveman) {
      selectEl.value = currentIntensity(pinned);
    }
  }

  if (dismissBtn) {
    dismissBtn.setAttribute(
      'aria-label',
      isPartyMode ? 'Unpin party mode' : 'Unpin caveman mode',
    );
    dismissBtn.title = isPartyMode ? 'Unpin party mode' : 'Unpin caveman mode';
  }
}

/** Set pinned caveman on the active chat (used by settings defaults on new chat). */
export function setActiveChatPinnedCaveman(intensity?: string): void {
  const chat = getActiveChat();
  chat.pinnedSkill = {
    id: CAVEMAN_SKILL_ID,
    intensity: isCavemanIntensity(intensity) ? intensity : DEFAULT_CAVEMAN_INTENSITY,
  };
  touchChat(chat);
  scheduleSaveSessions();
  syncComposerPinnedSkillFromActiveChat();
}
