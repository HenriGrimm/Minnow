import type { CdpClient, LaunchOptions, LaunchResult, Snapshot } from '../browser-driver/index';

export interface AgentBrowserOwner {
  chatId: string;
  runId: string;
  agentId: string;
}

export interface AgentBrowserTab {
  tabId: string;
  status: 'launching' | 'ready' | 'transferring' | 'closing' | 'unsafe';
  title: string;
  url: string;
  owner: AgentBrowserOwner | null;
  viewport: { width: number; height: number };
  controlMode: 'watch' | 'guide' | 'control';
  activity: 'idle' | 'agent' | 'guide' | 'control';
  busy: boolean;
  currentAction: string | null;
  revision: number;
  frameRevision: number;
  documentRevision: number;
  createdAt: number;
  updatedAt: number;
}

export type AgentBrowserErrorCode =
  | 'invalid'
  | 'not-found'
  | 'not-owner'
  | 'stale-lease'
  | 'busy'
  | 'closed'
  | 'launch-failed'
  | 'unsafe-transfer';

export class AgentBrowserError extends Error {
  constructor(message: string, code: AgentBrowserErrorCode);
  code: AgentBrowserErrorCode;
}

export interface AgentBrowserReservation {
  tab: AgentBrowserTab;
  lease: string | null;
}

export interface AgentBrowserCall {
  owner: AgentBrowserOwner;
  tabId: string;
  lease: string;
  timeoutMs?: number;
}

export interface AgentBrowserServiceOptions {
  launcher?: (opts?: LaunchOptions & { label?: string }) => Promise<LaunchResult>;
  launchOptions?: LaunchOptions;
  viewport?: { width: number; height: number };
  maxTabs?: number;
  connector?: (url:string, opts?:{commandTimeoutMs?:number;connectTimeoutMs?:number}) => Promise<CdpClient>;
}

export const DEFAULT_AGENT_BROWSER_VIEWPORT: Readonly<{ width: 1440; height: 900 }>;
export const DEFAULT_AGENT_BROWSER_HARD_TIMEOUT_MS: number;
export const DEFAULT_AGENT_BROWSER_MAX_TABS: number;

export interface AgentBrowserFrame {
  png: Buffer;
  pngBase64: string;
  width: number;
  height: number;
  viewport: {width:number;height:number};
  capturedAt: number;
  revision: number;
}

export interface AgentBrowserGuideEvent {
  type: 'guide';
  guideId: string;
  tabId: string;
  owner: AgentBrowserOwner | null;
  url: string;
  point: {x:number;y:number};
  message: string;
  element: unknown;
  createdAt: number;
  selectionToken: string;
  documentRevision: number;
  frameRevision: number;
}

export interface AgentBrowserGuideSelection {
  selectionToken: string;
  tabId: string;
  owner: AgentBrowserOwner;
  url: string;
  point: {x:number;y:number};
  element: unknown;
  documentRevision: number;
  frameRevision: number;
  createdAt: number;
}

export class AgentBrowserService {
  constructor(opts?: AgentBrowserServiceOptions);
  reserveTab(owner: AgentBrowserOwner, opts?: { url?: string; viewport?: {width:number;height:number}; launchOptions?: LaunchOptions }): Promise<AgentBrowserReservation>;
  listTabs(): AgentBrowserTab[];
  listOwnedTabs(owner: AgentBrowserOwner): AgentBrowserTab[];
  inspectOwnedTab(input: AgentBrowserCall): AgentBrowserTab;
  inspectOwnedTab(owner: AgentBrowserOwner, tabId:string): AgentBrowserTab;
  updateTabPolicy(tabId:string, allowedOriginPatterns:string[]): AgentBrowserTab;
  navigate(input: AgentBrowserCall & {url:string}): Promise<{outcome:'loaded'|'timeout';url:string;title:string;killed?:boolean}>;
  evaluate(input: AgentBrowserCall & {expression:string;awaitPromise?:boolean}): Promise<unknown>;
  snapshot(input: AgentBrowserCall): Promise<Snapshot>;
  click(input: AgentBrowserCall & {uid:number}): Promise<{uid:number;role:string;name:string}>;
  fill(input: AgentBrowserCall & {uid:number;text:string;clear?:boolean;submit?:boolean}): Promise<{uid:number;role:string;name:string;length:number}>;
  screenshot(input: AgentBrowserCall): Promise<{ok:true;id:string;filePath:string;sizeBytes:number}|{ok:false;error:string}>;
  releaseOwnedTab(input: AgentBrowserCall): Promise<AgentBrowserReservation>;
  closeOwnedTab(input: AgentBrowserCall): Promise<void>;
  setControlMode(tabId:string, mode:'watch'|'guide'|'control'): Promise<AgentBrowserTab>;
  captureFrame(tabId:string, opts?:{timeoutMs?:number}): Promise<AgentBrowserFrame>;
  guideElementAtPoint(tabId:string, input:{x:number;y:number;message?:string;timeoutMs?:number}): Promise<AgentBrowserGuideSelection>;
  selectGuideElement(tabId:string, input:{point:{x:number;y:number};frameRevision?:number|string;viewport?:{width:number;height:number};timeoutMs?:number}): Promise<AgentBrowserGuideSelection>;
  deliverGuide(tabId:string, input:{selectionToken:string;message:string}): Promise<AgentBrowserGuideEvent>;
  guide(tabId:string, input:{selectionToken?:string;message:string;point?:{x:number;y:number};timeoutMs?:number}): Promise<AgentBrowserGuideEvent>;
  takeGuideEvents(owner:AgentBrowserOwner): AgentBrowserGuideEvent[];
  navigateOperator(tabId:string, url:string, opts?:{timeoutMs?:number}): Promise<{outcome:'loaded'|'timeout';url:string;title:string;killed?:boolean}>;
  historyOperator(tabId:string, action:'back'|'forward'|'reload', opts?:{timeoutMs?:number}): Promise<{moved:boolean;url:string}>;
  dispatchControlInput(tabId:string, event:Record<string,unknown>, opts?:{timeoutMs?:number}): Promise<{ok:true}>;
  operatorNavigate(tabId:string, url:string, opts?:{timeoutMs?:number}): ReturnType<AgentBrowserService['navigateOperator']>;
  operatorBack(tabId:string, opts?:{timeoutMs?:number}): ReturnType<AgentBrowserService['historyOperator']>;
  operatorForward(tabId:string, opts?:{timeoutMs?:number}): ReturnType<AgentBrowserService['historyOperator']>;
  operatorReload(tabId:string, opts?:{timeoutMs?:number}): ReturnType<AgentBrowserService['historyOperator']>;
  operatorInput(tabId:string, event:Record<string,unknown>, opts?:{timeoutMs?:number}): Promise<{ok:true}>;
  releaseTab(tabId: string): Promise<AgentBrowserReservation>;
  unassignTab(tabId: string): Promise<AgentBrowserReservation>;
  reassignTab(tabId: string, owner: AgentBrowserOwner): Promise<AgentBrowserReservation>;
  closeTab(tabId: string): Promise<void>;
  clearTabs(): Promise<void>;
  close(): Promise<void>;
  on(event:'tab-changed', listener:(tab:AgentBrowserTab)=>void): this;
  on(event:'tabs-changed', listener:(tabs:AgentBrowserTab[])=>void): this;
  on(event:'guide', listener:(event:AgentBrowserGuideEvent)=>void): this;
}

export function createAgentBrowserService(opts?: AgentBrowserServiceOptions): AgentBrowserService;
