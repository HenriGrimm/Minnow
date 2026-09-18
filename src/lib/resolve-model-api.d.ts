export type ResolvedApiKind =
  | 'lm-studio-v0'
  | 'openai-v1'
  | 'anthropic-v1'
  | 'agent-cli-v1';

export interface ModelApiProfile {
  apiKind?: string;
  autoApi?: boolean;
  modelApiOverrides?: Record<string, string>;
}

export interface ModelApiMeta {
  owned_by?: string;
  arch?: string;
  family?: string;
  api?: string;
}

export function modelLooksAnthropic(modelId: string, modelMeta?: ModelApiMeta | null): boolean;
export function resolveModelApi(
  runtimeOrProfile: ModelApiProfile | { profile?: ModelApiProfile },
  modelId: string,
  modelMeta?: ModelApiMeta | null,
): ResolvedApiKind;
