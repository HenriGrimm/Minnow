import { setTimeout } from 'node:timers';

// Node 24's Windows test runner can force-exit while libuv is closing an async
// handle (UV_HANDLE_CLOSING). Give completed tests one bounded drain interval.
// Only the runner's direct exit is delayed; application exits, failures, hooks
// and deadlines retain their normal behavior. This preload never ships in-app.
if (process.platform === 'win32' && process.versions.node.startsWith('24.')) {
  const exit = process.exit.bind(process);
  let scheduled = false;
  process.exit = code => {
    const caller = new Error().stack?.split('\n')[2] ?? '';
    if (!/node:internal\/test_runner\/(?:test|harness):\d+:\d+/.test(caller)) return exit(code);
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => exit(code), 150);
  };
}
