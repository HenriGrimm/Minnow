import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Call = { operation: string; stack: string };

/** Opt-in, synchronous breadcrumbs: native crashes cannot flush a JS logger. */
export function installNativeCallTrace(filePath: string): () => void {
  const stringify = JSON.stringify;
  const entries = Object.entries;
  const active: Call[] = [];

  function record(call: Call, state: string): void {
    try {
      fs.writeFileSync(filePath, `${new Date().toISOString()} pid=${process.pid} ${state} ${call.operation}\n${call.stack}\n`, {
        encoding: 'utf8', mode: 0o600,
      });
    } catch {
      // Diagnostics must not change the operation's result or error.
    }
  }

  function trace<T>(operation: string, run: () => T): T {
    const call = { operation, stack: (new Error().stack ?? '').slice(0, 8_000) };
    active.push(call);
    record(call, 'active');
    let state = 'threw';
    try {
      const result = run();
      state = 'completed';
      return result;
    } finally {
      active.pop();
      const parent = active[active.length - 1];
      record(parent ?? call, parent ? 'active' : state);
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  JSON.stringify = function (this: unknown, ...args: Parameters<typeof stringify>) {
    return trace('JSON.stringify', () => Reflect.apply(stringify, this, args));
  } as typeof stringify;
  Object.entries = function (this: unknown, ...args: Parameters<typeof entries>) {
    return trace('Object.entries', () => Reflect.apply(entries, this, args));
  } as typeof entries;

  return () => {
    JSON.stringify = stringify;
    Object.entries = entries;
  };
}

export function enableNativeCallTrace(): void {
  if (process.env.MINNOW_NATIVE_CRASH_TRACE !== '1') return;
  const home = process.env.MINNOW_HOME?.trim() || path.join(os.homedir(), '.minnow');
  try {
    installNativeCallTrace(path.join(home, 'logs', `native-call-${process.pid}.txt`));
  } catch {
    // An unwritable log directory must not prevent startup.
  }
}
