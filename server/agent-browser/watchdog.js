import { spawnSync } from 'node:child_process';

const parentPid = Number(process.argv[2]);
const browserPid = Number(process.argv[3]);

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function killBrowser() {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(browserPid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5_000,
      });
    } else {
      try {
        process.kill(-browserPid, 'SIGKILL');
      } catch {
        process.kill(browserPid, 'SIGKILL');
      }
    }
  } catch {
  }
}

if (!alive(browserPid)) process.exit(0);
if (!alive(parentPid)) {
  killBrowser();
  process.exit(0);
}

process.on('disconnect', () => {
  if (alive(browserPid)) killBrowser();
  process.exit(0);
});

const timer = setInterval(() => {
  if (!alive(browserPid)) process.exit(0);
  if (alive(parentPid)) return;
  killBrowser();
  process.exit(0);
}, 2_000);
