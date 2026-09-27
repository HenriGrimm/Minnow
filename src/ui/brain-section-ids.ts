export type BrainSectionId =
  | 'graph'
  | 'edit'
  | 'log'
  | 'schema'
  | 'proposals'
  | 'memories'
  | 'ingest'
  | 'lint'
  | 'code'
  | 'settings';

export const BRAIN_SECTIONS: readonly BrainSectionId[] = [
  'graph',
  'edit',
  'log',
  'schema',
  'proposals',
  'memories',
  'ingest',
  'lint',
  'code',
  'settings',
];

export const BRAIN_SECTION_LABELS: Record<BrainSectionId, string> = {
  graph: 'Graph',
  edit: 'Edit',
  log: 'Log',
  schema: 'Schema',
  proposals: 'Proposals',
  memories: 'Memories',
  ingest: 'Ingest',
  lint: 'Lint',
  code: 'Code',
  settings: 'Settings',
};

/** Sections tucked under the Brain rail's More disclosure. */
export const BRAIN_MORE_SECTIONS: ReadonlySet<BrainSectionId> = new Set([
  'ingest',
  'lint',
  'schema',
  'log',
  'settings',
]);
