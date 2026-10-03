import type { GitHistoryEdge, GitHistoryModel } from './model';

export interface GitHistoryBox { x: number; y: number; w: number; h: number }
export interface GitHistoryLayout {
  boxes: Map<string, GitHistoryBox>;
  width: number;
  height: number;
}
export interface GitHistoryRoute {
  edge: GitHistoryEdge;
  path: string;
  bounds: GitHistoryBox;
}

/** Older commits sit left of newer ones; branch lanes occupy separate rows. */
export function layoutGitHistory(model: GitHistoryModel): GitHistoryLayout {
  const boxes = new Map<string, GitHistoryBox>();
  let maxLane = 0;
  model.nodes.forEach((node, index) => {
    maxLane = Math.max(maxLane, node.lane);
    boxes.set(node.commit.hash, { x: 40 + (model.nodes.length - index - 1) * 320, y: 40 + node.lane * 144, w: 256, h: 104 });
  });
  return { boxes, width: Math.max(336, model.nodes.length * 320 + 16), height: 184 + maxLane * 144 };
}

/** Frame only the shown commits, without padding from hidden chronological slots. */
export function frameGitHistoryLayout(layout: GitHistoryLayout, model: GitHistoryModel): GitHistoryLayout {
  let left = Infinity;
  let top = Infinity;
  for (const node of model.nodes) {
    const box = layout.boxes.get(node.commit.hash)!;
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
  }
  const boxes = new Map<string, GitHistoryBox>();
  let width = 336;
  let height = 184;
  for (const node of model.nodes) {
    const box = layout.boxes.get(node.commit.hash)!;
    const framed = { ...box, x: box.x - left + 40, y: box.y - top + 40 };
    boxes.set(node.commit.hash, framed);
    width = Math.max(width, framed.x + framed.w + 40);
    height = Math.max(height, framed.y + framed.h + 40);
  }
  return { boxes, width, height };
}

export function routeGitHistoryEdges(model: GitHistoryModel, layout: GitHistoryLayout): GitHistoryRoute[] {
  return model.edges.flatMap((edge) => {
    const child = layout.boxes.get(edge.child);
    if (!child) return [];
    const parent = edge.boundary ? undefined : layout.boxes.get(edge.parent);
    const x1 = child.x;
    const y1 = child.y + child.h / 2;
    const x2 = parent ? parent.x + parent.w : x1 - 64;
    const y2 = parent ? parent.y + parent.h / 2 : y1;
    const bend = Math.max(x2 + 16, x1 - 24);
    const path = y1 === y2 ? `M ${x1} ${y1} L ${x2} ${y2}`
      : `M ${x1} ${y1} C ${bend} ${y1} ${bend} ${y2} ${bend - 12} ${y2} L ${x2} ${y2}`;
    return [{ edge, path, bounds: { x: x2, y: Math.min(y1, y2) - 4, w: x1 - x2, h: Math.abs(y2 - y1) + 8 } }];
  });
}
