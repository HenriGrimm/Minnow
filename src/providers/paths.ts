/**
 * Default upstream paths per apiKind (overridable on provider profile).
 */

import type { ApiKind, ProviderPublic } from './types';
import { deriveMessagesPathFromChat } from '../lib/derive-messages-path.mjs';

export interface ProviderPathOverrides {
  modelsPath?: string;
  chatCompletionsPath?: string;
  messagesPath?: string;
  modelsLoadPath?: string;
  modelsUnloadPath?: string;
}

/** Map apiKind to default LM Studio v0 or OpenAI v1 paths. */
export function getDefaultPaths(
  apiKind: ApiKind,
  overrides: ProviderPathOverrides = {},
): {
  modelsPath: string;
  chatCompletionsPath: string;
  messagesPath?: string;
  modelsLoadPath?: string;
  modelsUnloadPath?: string;
} {
  const defaults =
    apiKind === 'openai-v1'
      ? {
          modelsPath: '/v1/models',
          chatCompletionsPath: '/v1/chat/completions',
          messagesPath: '/v1/messages',
        }
      : apiKind === 'anthropic-v1'
        ? {
            modelsPath: '/v1/models',
            chatCompletionsPath: '/v1/messages',
            messagesPath: '/v1/messages',
          }
        : apiKind === 'lm-studio-v0'
          ? {
              modelsPath: '/api/v0/models',
              chatCompletionsPath: '/api/v0/chat/completions',
              modelsLoadPath: '/api/v1/models/load',
              modelsUnloadPath: '/api/v1/models/unload',
            }
          : {
              modelsPath: '',
              chatCompletionsPath: '',
            };

  const out = {
    modelsPath: overrides.modelsPath || defaults.modelsPath,
    chatCompletionsPath: overrides.chatCompletionsPath || defaults.chatCompletionsPath,
    ...(defaults.messagesPath
      ? {
          messagesPath:
            overrides.messagesPath ||
            (apiKind === 'anthropic-v1'
              ? overrides.chatCompletionsPath || defaults.messagesPath
              : deriveMessagesPathFromChat(
                  overrides.chatCompletionsPath || defaults.chatCompletionsPath,
                )),
        }
      : {}),
  };

  if ('modelsLoadPath' in defaults && defaults.modelsLoadPath) {
    return {
      ...out,
      modelsLoadPath: overrides.modelsLoadPath || defaults.modelsLoadPath,
      modelsUnloadPath: overrides.modelsUnloadPath || defaults.modelsUnloadPath,
    };
  }

  return out;
}

/** Paths for a stored provider profile. */
export function pathsForProvider(provider: ProviderPublic): {
  modelsPath: string;
  chatCompletionsPath: string;
  messagesPath?: string;
  modelsLoadPath?: string;
  modelsUnloadPath?: string;
} {
  return getDefaultPaths(provider.apiKind, {
    modelsPath: provider.modelsPath,
    chatCompletionsPath: provider.chatCompletionsPath,
    messagesPath: provider.messagesPath,
    modelsLoadPath: provider.modelsLoadPath,
    modelsUnloadPath: provider.modelsUnloadPath,
  });
}
