import { readDefaultModelBinding } from '../models/selection';
import type { BoardState } from '../../server/orchestrator/core/types';
import { decodeModelSelectKey } from '../lib/model-select-key.ts';
import type { BoardReasoningPatch } from './board-journal-reasoning.ts';
import {
  fieldsFromJournalReasoning,
  isBoardJournalReasoning,
  journalReasoningFromFields,
  mergeReasoningPatch,
} from './board-journal-reasoning.ts';
import {
  adoptBoardModelChipTrigger,
  setBoardModelTriggerContext,
  syncBoardModelChipTrigger,
  unmountBoardModelChipTrigger,
} from '../ui/composer-model-trigger.ts';
import {
  wireBoardHeaderReasoningSource,
  detachBoardHeaderReasoning,
  teardownBoardHeaderReasoning,
} from '../ui/orchestrate-board-reasoning.ts';

export interface V2BoardHeaderCommands {
  setModel: (providerId: string, id: string, reasoning: string) => Promise<void>;
  onNeedModel: () => void;
}

let liveState: BoardState | null = null;
let liveCommands: V2BoardHeaderCommands | null = null;

export function resolveV2BoardModelBinding(state: BoardState | null): {
  providerId: string;
  modelId: string;
} {
  const bound = state?.model;
  if (bound?.providerId && bound.id) {
    return { providerId: bound.providerId, modelId: bound.id };
  }
  const binding = readDefaultModelBinding();
  return { providerId: binding.providerId || '', modelId: binding.modelId };
}

export function detachV2BoardHeaderInstruments(): void {
  const slot = document.querySelector(
    '#orchestratorBoardsRoot .board-header__model-slot',
  ) as HTMLElement | null;
  const chip = slot?.querySelector('.composer-model-trigger-wrap--board') as HTMLElement | null;
  chip?.remove();
  detachBoardHeaderReasoning();
}

export function attachV2BoardHeaderInstruments(
  controls: HTMLElement,
  state: BoardState,
  commands: V2BoardHeaderCommands,
): void {
  liveState = state;
  liveCommands = commands;

  const slot =
    (controls.querySelector('.board-header__model-slot') as HTMLElement | null) ??
    (() => {
      const created = document.createElement('div');
      created.className = 'board-header__model-slot mn-os-mb-model-slot';
      controls.insertBefore(created, controls.firstChild);
      return created;
    })();

  adoptBoardModelChipTrigger(slot);
  setBoardModelTriggerContext({
    resolveBinding: () => resolveV2BoardModelBinding(liveState),
    persist: (providerId, modelId) => {
      const reasoning = liveState?.model?.reasoning ?? '';
      if (liveState) {
        liveState = {
          ...liveState,
          model: {
            providerId,
            id: modelId,
            reasoning: reasoning || null,
          },
        };
      }
      void liveCommands?.setModel(providerId, modelId, reasoning);
    },
    onChanged: () => {
    },
  });
  syncBoardModelChipTrigger();

  wireBoardHeaderReasoningSource(controls, {
    resolveBinding: () => resolveV2BoardModelBinding(liveState),
    getBoard: () => fieldsFromJournalReasoning(liveState?.model?.reasoning),
    isRunning: () => liveState?.status === 'running',
    persist: (patch: BoardReasoningPatch) => {
      const current = fieldsFromJournalReasoning(liveState?.model?.reasoning);
      const next = mergeReasoningPatch(current, patch);
      const journal = journalReasoningFromFields(next);
      const binding = resolveV2BoardModelBinding(liveState);
      if (!binding.providerId || !binding.modelId) {
        liveCommands?.onNeedModel();
        return;
      }
      void liveCommands?.setModel(
        binding.providerId,
        binding.modelId,
        isBoardJournalReasoning(journal) ? journal : '',
      );
      if (liveState) {
        liveState = {
          ...liveState,
          model: {
            providerId: binding.providerId,
            id: binding.modelId,
            reasoning: journal || null,
          },
        };
      }
    },
    onChanged: () => {
    },
  });
}

export function teardownV2BoardHeaderInstruments(): void {
  liveState = null;
  liveCommands = null;
  unmountBoardModelChipTrigger();
  teardownBoardHeaderReasoning();
}
