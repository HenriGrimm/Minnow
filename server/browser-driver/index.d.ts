import type { ChildProcess } from 'node:child_process';


export type BrowserFamily = 'chrome' | 'chrome-canary' | 'edge' | 'brave' | 'chromium';

export interface BrowserCandidate {
  executablePath: string;
  family: BrowserFamily;
}

export interface BrowserCapabilityAvailable {
  available: true;
  executablePath: string;
  family: BrowserFamily;
  source: 'env' | 'probe';
}

export type BrowserUnavailableReason =
  | 'disabled-in-settings'
  | 'no-chromium-browser'
  | 'env-path-missing';

export interface BrowserCapabilityUnavailable {
  available: false;
  reason: BrowserUnavailableReason;
  detail: string;
  searched: string[];
}

export type BrowserCapability = BrowserCapabilityAvailable | BrowserCapabilityUnavailable;

export const BROWSER_PATH_ENV: 'MINNOW_BROWSER_PATH';

export const MAC_BROWSER_BUNDLES: ReadonlyArray<{
  bundleId: string;
  executable: string;
  family: BrowserFamily;
}>;

export function browserCandidates(
  platform: string,
  env?: Record<string, string | undefined>,
): BrowserCandidate[];

export function spotlightBrowserCandidates(): Promise<BrowserCandidate[]>;

export function familyFromPath(executablePath: string): BrowserFamily;

export function discoverBrowser(opts?: {
  platform?: string;
  env?: Record<string, string | undefined>;
  executablePath?: string;
  spotlight?: () => Promise<BrowserCandidate[]>;
}): Promise<BrowserCapability>;

export function probeBrowserCapability(opts?: {
  platform?: string;
  env?: Record<string, string | undefined>;
  executablePath?: string;
}): Promise<BrowserCapability>;


export const DEFAULT_HARD_TIMEOUT_MS: number;
export const DEFAULT_LAUNCH_TIMEOUT_MS: number;
export const DEFAULT_COMMAND_TIMEOUT_MS: number;
export const DEFAULT_NAVIGATION_TIMEOUT_MS: number;
export const LIVENESS_PROBE_TIMEOUT_MS: number;
export const DEFAULT_MAX_TEXT_CHARS: number;
export const MAX_CONSOLE_ENTRIES: number;

export interface LaunchOptions {
  executablePath?: string;
  headless?: boolean;
  profileDir?: string;
  hardTimeoutMs?: number;
  launchTimeoutMs?: number;
  commandTimeoutMs?: number;
  navigationTimeoutMs?: number;
  viewport?: { width: number; height: number };
  extraArgs?: string[];
  allowedOriginPatterns?: string[];
  env?: Record<string, string | undefined>;
  label?: string;
}

export interface NormalizedLaunchOptions {
  headless: boolean;
  hardTimeoutMs: number;
  launchTimeoutMs: number;
  commandTimeoutMs: number;
  navigationTimeoutMs: number;
  viewport: { width: number; height: number };
  extraArgs: string[];
}

export function normalizeLaunchOptions(opts?: LaunchOptions): NormalizedLaunchOptions;

export function buildLaunchArgs(input: {
  profileDir: string;
  options: NormalizedLaunchOptions;
}): string[];

export function capText(text: string, max?: number): string;


export function browserProfileRoot(): string;
export function createProfileDir(label?: string): Promise<string>;
export function removeProfileDir(dir: string): Promise<{ removed: boolean; error?: string }>;
export function sweepStaleProfiles(
  olderThanMs?: number,
): Promise<{ removed: string[]; failed: string[] }>;


export interface BrowserProcessHandle {
  child: ChildProcess;
  pid: number;
  port: number;
  browserWsUrl: string;
  profileDir: string;
  executablePath: string;
}

export interface DevToolsTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export function checkBrowserHealth(
  port: number,
  timeoutMs?: number,
): Promise<{ ok: true; version: string; browserWsUrl: string } | { ok: false; error: string }>;

export function listTargets(port: number, timeoutMs?: number): Promise<DevToolsTarget[]>;

export function launchBrowserProcess(input: {
  executablePath: string;
  profileDir: string;
  args: string[];
  launchTimeoutMs: number;
  onExit?: (reason: string) => void;
}): Promise<BrowserProcessHandle>;

export function killBrowserProcess(
  child: ChildProcess,
  opts?: { graceMs?: number; waitMs?: number },
): Promise<{ killed: boolean; alreadyDead: boolean }>;

export function isPidAlive(pid: number): boolean;

export function trackedBrowserPids(): number[];


export type CdpErrorCode = 'timeout' | 'closed' | 'protocol' | 'connect';

export class CdpError extends Error {
  constructor(message: string, code: CdpErrorCode);
  code: CdpErrorCode;
}

export class CdpClient {
  constructor(endpoint: string, opts?: { commandTimeoutMs?: number });
  endpoint: string;
  closed: boolean;
  connect(connectTimeoutMs?: number): Promise<void>;
  send(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
  close(reason?: string): void;
}

export function connectTarget(
  wsUrl: string,
  opts?: { commandTimeoutMs?: number; connectTimeoutMs?: number },
): Promise<CdpClient>;

export interface SnapshotNode {
  uid: number;
  role: string;
  name: string;
  value?: string;
  backendNodeId: number;
  children?: SnapshotNode[];
}

export interface Snapshot {
  nodes: SnapshotNode[];
  byUid: Map<number, SnapshotNode>;
  text: string;
}

export function buildSnapshot(axNodes: Array<Record<string, unknown>> | undefined): Snapshot;
export function renderTree(nodes: SnapshotNode[], indent?: number): string;
export function takeSnapshot(client: CdpClient, opts?: { timeoutMs?: number }): Promise<Snapshot>;
export function resolveUid(snapshot: Snapshot, uid: number): SnapshotNode | undefined;


export type SessionEndReason =
  | 'user'
  | 'hard-timeout'
  | 'unresponsive'
  | 'external'
  | 'launch-failure';

export type BrowserDriverErrorCode =
  | 'gone'
  | 'allowlist'
  | 'timeout'
  | 'protocol'
  | 'closed'
  | 'invalid';

export class BrowserDriverError extends Error {
  constructor(message: string, code: BrowserDriverErrorCode);
  code: BrowserDriverErrorCode;
}

export interface SessionStatus {
  alive: boolean;
  pid: number;
  port: number;
  profileDir: string;
  executablePath: string;
  browserVersion: string;
  endedReason: SessionEndReason | null;
  endedDetail: string | null;
  currentUrl: string | null;
}

export interface ConsoleEntry {
  level: string;
  text: string;
  at: number;
}

export interface NavigateResult {
  outcome: 'loaded' | 'timeout';
  url: string;
  title: string;
  killed?: boolean;
}

export type ScreenshotResult =
  | { ok: true; id: string; filePath: string; sizeBytes: number }
  | { ok: false; error: string };

export class BrowserSession {
  readonly handle: BrowserProcessHandle;
  readonly targetId: string;
  alive: boolean;
  currentUrl: string | null;
  lastSnapshot: Snapshot | null;

  status(): SessionStatus;
  isResponsive(): Promise<boolean>;
  consoleMessages(): ConsoleEntry[];
  recordConsoleEntry(level: string, text: string): void;

  navigate(url: string, opts?: { timeoutMs?: number }): Promise<NavigateResult>;
  evaluate(
    expression: string,
    opts?: { timeoutMs?: number; awaitPromise?: boolean },
  ): Promise<unknown>;
  text(opts?: { maxChars?: number; timeoutMs?: number }): Promise<string>;
  html(opts?: { maxChars?: number; timeoutMs?: number }): Promise<string>;
  snapshot(opts?: { timeoutMs?: number }): Promise<Snapshot>;
  screenshot(opts?: { timeoutMs?: number }): Promise<ScreenshotResult>;

  kill(reason?: SessionEndReason, detail?: string): Promise<SessionStatus>;
  close(): Promise<SessionStatus>;
}

export interface LaunchSuccess {
  ok: true;
  session: BrowserSession;
  capability: BrowserCapabilityAvailable;
}

export interface LaunchFailure {
  ok: false;
  reason: BrowserUnavailableReason | 'launch-failed';
  detail: string;
}

export type LaunchResult = LaunchSuccess | LaunchFailure;

export function launchBrowser(opts?: LaunchOptions): Promise<LaunchResult>;
