export function ensureChatPreparationArtifact(options: {
  appRoot: string;
  env?: NodeJS.ProcessEnv;
  importBuilder?: (url: string) => Promise<{ buildChatPreparation: (options: { outfile: string }) => Promise<unknown> }>;
}): Promise<{ outfile: string; built: boolean }>;
