import type { ApiKind } from '../providers/types';

export function modelLooksAnthropic(
  modelId: string,
  modelMeta?: {
    owned_by?: string;
    arch?: string;
    family?: string;
    api?: string;
  } | null,
): boolean;
export function resolveModelApi(
  runtimeOrProfile: {
    profile?: {
      apiKind?: string;
      baseUrl?: string;
      autoApi?: boolean;
      modelApiOverrides?: Record<string, string>;
    };
    apiKind?: string;
    baseUrl?: string;
    autoApi?: boolean;
    modelApiOverrides?: Record<string, string>;
  },
  modelId: string,
  modelMeta?: {
    owned_by?: string;
    arch?: string;
    family?: string;
    api?: string;
  } | null,
): ApiKind;
