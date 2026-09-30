import type { BrainCodeRepoMap } from '../../brain/types';
import type { GraphData, GraphNode } from './graph/types';

/** Keep the force canvas legible even when the repo map contains thousands of symbols. */
const MAX_FILES = 45;
const MAX_SYMBOLS = 150;
const MAX_SYMBOLS_PER_FILE = 8;

export interface CodeMapGraphData extends GraphData {
  totalFiles: number;
  totalSymbols: number;
}

function symbolLabel(text: string): string {
  const signature = text.trim().replace(/^-\s*/, '').replace(/^\[[^\]]+\]\s*/, '');
  return signature.match(/^[^(\s:]+/)?.[0] || signature.slice(0, 48);
}

/** Build a directory → file → symbol graph from the same ranked rows shown in the outline. */
export function buildCodeMapGraph(map: BrainCodeRepoMap): CodeMapGraphData {
  const entries = map.entries ?? [];
  const files = new Set<string>();
  const symbols = entries.filter((entry) => entry.type === 'symbol');
  for (const entry of entries) {
    if (entry.type === 'file' || entry.type === 'symbol') files.add(entry.file.replace(/\\/g, '/'));
  }

  const nodes = new Map<string, GraphNode>();
  const edges: GraphData['edges'] = [];
  const keptFiles = new Set<string>();
  const perFile = new Map<string, number>();
  let keptSymbols = 0;

  for (const entry of entries) {
    if (entry.type !== 'file' && entry.type !== 'symbol') continue;
    const file = entry.file.replace(/\\/g, '/');
    if (!keptFiles.has(file)) {
      if (keptFiles.size >= MAX_FILES) continue;
      keptFiles.add(file);
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '(root)';
      const dirId = `dir:${dir}`;
      const fileId = `file:${file}`;
      if (!nodes.has(dirId)) nodes.set(dirId, { id: dirId, kind: 'tag', label: dir.split('/').pop() || dir, sublabel: dir, path: dir });
      nodes.set(fileId, { id: fileId, kind: 'page', label: file.split('/').pop() || file, sublabel: file, path: file });
      edges.push({ id: `contains:${dirId}:${fileId}`, source: dirId, target: fileId, kind: 'tag' });
    }
    if (entry.type !== 'symbol') continue;
    const fileCount = perFile.get(file) ?? 0;
    if (keptSymbols >= MAX_SYMBOLS || fileCount >= MAX_SYMBOLS_PER_FILE) continue;
    perFile.set(file, fileCount + 1);
    keptSymbols += 1;
    const id = `sym:${entry.symbolId}`;
    nodes.set(id, { id, kind: 'symbol', label: symbolLabel(entry.text), sublabel: file, symbolId: entry.symbolId });
    edges.push({ id: `contains:file:${file}:${id}`, source: `file:${file}`, target: id, kind: 'tag' });
  }

  return {
    nodes: [...nodes.values()],
    edges,
    totalFiles: files.size,
    totalSymbols: symbols.length,
    truncated: keptFiles.size < files.size || keptSymbols < symbols.length,
    hiddenCount: files.size - keptFiles.size + symbols.length - keptSymbols,
  };
}

/** Portable structure diagram, independent of canvas positioning. */
export function codeMapGraphToMermaid(graph: GraphData): string {
  const ids = new Map(graph.nodes.map((node, index) => [node.id, `n${index}`]));
  const safe = (value: string) => value.replace(/["\\\r\n]/g, ' ').slice(0, 100);
  const lines = ['flowchart LR'];
  for (const node of graph.nodes) lines.push(`  ${ids.get(node.id)}["${safe(node.label)}"]`);
  for (const edge of graph.edges) {
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (source && target) lines.push(`  ${source} --> ${target}`);
  }
  return lines.join('\n');
}
