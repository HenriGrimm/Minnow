import { getActiveChat, scheduleSaveSessions, touchChat } from '../state/sessions';
import { CAVEMAN_SKILL_ID, DEFAULT_CAVEMAN_INTENSITY, isCavemanIntensity } from '../skills/caveman-client';
import { PARTYMODE_SKILL_ID } from '../skills/partymode-client';
import type { PinnedSkillState } from '../skills/types';
import { listCavemanIntensityOptions } from '../skills/config';

let stripEl: HTMLDivElement | null = null;
let labelEl: HTMLSpanElement | null = null;
let selectEl: HTMLSelectElement | null = null;
let dismissBtn: HTMLButtonElement | null = null;

function ensureStrip(): HTMLDivElement | null {
  const host = document.getElementById('composerControls');
  if (!host) return null;
  if (stripEl?.parentNode === host) return stripEl;

  stripEl = document.createElement('div');
  stripEl.id = 'pinnedSkillStrip';
  stripEl.className = 'composer-control pinned-skill-control hidden';
  stripEl.setAttribute('aria-live', 'polite');

  labelEl = document.createElement('span');
  labelEl.className = 'composer-control-label pinned-skill-control__label';
  labelEl.textContent = 'Caveman';

  selectEl = document.createElement('select');
  selectEl.id = 'pinnedSkillIntensity';
  selectEl.className = 'pinned-skill-control__select';
  selectEl.setAttribute('aria-label', 'Caveman intensity');
  for (const level of listCavemanIntensityOptions()) {
    const opt = document.createElement('option');
    opt.value = level;
    opt.textContent = level;
    selectEl.appendChild(opt);
  }

  dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'pinned-skill-control__dismiss';
  dismissBtn.setAttribute('aria-label', 'Unpin caveman mode');
  dismissBtn.title = 'Unpin caveman mode';
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

  const anchor = document.getElementById('workAgentDev');
  host.insertBefore(stripEl, anchor?.parentNode === host ? anchor : null);

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
  if (typeof document === 'undefined') return;
  const strip = ensureStrip();
  if (!strip) return;
  const chat = getActiveChat();
  const pinned = chat.pinnedSkill;

  const isCaveman = pinned?.id === CAVEMAN_SKILL_ID;
  const isPartyMode = pinned?.id === PARTYMODE_SKILL_ID;

  if (!pinned) {
    strip.classList.add('hidden');
    strip.classList.remove('pinned-skill-control--party');
    return;
  }

  strip.classList.remove('hidden');
  strip.classList.toggle('pinned-skill-control--party', isPartyMode);
  const label = isPartyMode ? '🎉 Party Mode' : isCaveman ? 'Caveman' : `/${pinned.id}`;

  if (labelEl) {
    labelEl.textContent = label;
  }

  if (selectEl) {
    selectEl.classList.toggle('hidden', !isCaveman);
    if (isCaveman) {
      selectEl.value = currentIntensity(pinned);
    }
  }

  if (dismissBtn) {
    const dismissLabel = `Unpin ${isPartyMode ? 'Party Mode' : label}`;
    dismissBtn.setAttribute('aria-label', dismissLabel);
    dismissBtn.title = dismissLabel;
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
