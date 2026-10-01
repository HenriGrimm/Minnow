/**
 * Settings → General → Backup and restore, and the restore panel it shares
 * with the setup wizard. The server is a fetch stub; what is checked is what
 * the page asks for and what it tells the user.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { Window } from 'happy-dom';

import type { BackupStatus } from '../../src/backup/client.ts';

let statusMessages: Array<[string, string]> = [];
let confirmAnswer = true;
let confirmPrompts: string[] = [];
let pickedFolder: string | null = null;

mock.module('../../src/config/storage-mode.ts', {
  namedExports: { detectConfigServer: async () => 'server' },
});
mock.module('../../src/ui/status.ts', {
  namedExports: {
    setStatus: (state: string, message: string) => {
      statusMessages.push([state, message]);
    },
  },
});
mock.module('../../src/ui/app-dialog.ts', {
  namedExports: {
    appConfirm: async (message: string) => {
      confirmPrompts.push(message);
      return confirmAnswer;
    },
  },
});
mock.module('../../src/ui/workspace-folder-picker.ts', {
  namedExports: {
    openWorkspaceFolderPicker: async () => ({ cancelled: pickedFolder === null, path: pickedFolder }),
  },
});

const { renderBackupSettings } = await import('../../src/ui/settings-backup.ts');
const { mountRestorePanel } = await import('../../src/ui/backup-restore-panel.ts');
const { backupProgressPercent, formatBackupBytes, backupFileName } = await import(
  '../../src/backup/client.ts'
);

function baseStatus(): BackupStatus {
  return {
    home: 'C:/Users/me/.minnow',
    packaged: false,
    defaultDir: 'C:/Users/me/Documents/Minnow Backups',
    fileExtension: '.mnbak',
    minPassphraseLength: 8,
    keepRange: { min: 1, max: 60 },
    credentialsCategory: 'credentials',
    categories: [
      { id: 'settings', label: 'Settings and preferences', description: 'Preferences.', defaultOn: true, requiresPassphrase: false },
      { id: 'credentials', label: 'Credentials and encryption key', description: 'API keys.', defaultOn: true, requiresPassphrase: true },
      { id: 'chats', label: 'Chats and usage history', description: 'Conversations.', defaultOn: true, requiresPassphrase: false },
      { id: 'models', label: 'Downloaded models', description: 'Large.', defaultOn: false, requiresPassphrase: false },
    ],
    settings: {
      categories: ['settings', 'credentials', 'chats'],
      lastDestDir: '',
      schedule: { enabled: false, frequency: 'daily', destDir: '', keep: 7, hasPassphrase: false },
      state: {
        lastRunAt: null,
        lastSuccessAt: null,
        lastStatus: null,
        lastError: '',
        lastFile: '',
        nextRunAt: null,
        failures: 0,
      },
      lastExport: null,
    },
    restore: { pending: null, last: null },
    job: null,
  };
}

interface Call {
  method: string;
  route: string;
  body: Record<string, unknown> | null;
}

let win: Window;
let saved: Record<string, unknown>;
let calls: Call[];
let status: BackupStatus;
/** Per-route overrides: return a `[httpStatus, body]` pair. */
let routes: Record<string, (body: Record<string, unknown> | null) => [number, unknown]>;

beforeEach(() => {
  win = new Window({ url: 'http://localhost:9473' });
  saved = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  Object.assign(globalThis, { document: win.document, window: win });
  statusMessages = [];
  confirmPrompts = [];
  confirmAnswer = true;
  pickedFolder = null;
  calls = [];
  status = baseStatus();
  routes = {};
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const route = String(input).replace('/api/backup', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, route, body });
    const handler = routes[`${method} ${route}`];
    const [code, payload] = handler
      ? handler(body)
      : route === '/status'
        ? [200, status]
        : route === '/sizes'
          ? [200, { categories: [{ id: 'settings', files: 3, bytes: 2048 }, { id: 'credentials', files: 2, bytes: 512 }, { id: 'chats', files: 1, bytes: 5 * 1024 * 1024 }, { id: 'models', files: 4, bytes: 3 * 1024 ** 3 }] }]
          : [404, { error: 'Not found' }];
    return new Response(JSON.stringify(payload), { status: code });
  }) as typeof fetch;
});

afterEach(() => {
  Object.assign(globalThis, saved);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function change(el: Element, value?: string): void {
  if (value !== undefined) (el as HTMLInputElement).value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
  el.dispatchEvent(new win.Event('change', { bubbles: true }) as unknown as Event);
}

function buttonNamed(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((b) => b.textContent === label);
  assert.ok(found, `button "${label}" should exist`);
  return found as HTMLButtonElement;
}

async function mountSettings(): Promise<HTMLElement> {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  await renderBackupSettings(mount);
  await settle();
  return mount;
}

describe('formatting', () => {
  test('sizes, file names and progress', () => {
    assert.equal(formatBackupBytes(0), '0 B');
    assert.equal(formatBackupBytes(1536), '1.5 KB');
    assert.equal(formatBackupBytes(363 * 1024 * 1024), '363 MB');
    assert.equal(backupFileName('C:\\Backups\\minnow-backup-1.mnbak'), 'minnow-backup-1.mnbak');
    assert.equal(backupFileName('/home/me/backups/a.mnbak'), 'a.mnbak');
    assert.equal(backupProgressPercent({ bytes: 50, totalBytes: 200, files: 0, totalFiles: 0 }), 25);
    assert.equal(backupProgressPercent({ bytes: 0, totalBytes: 0, files: 3, totalFiles: 4 }), 75);
    assert.equal(backupProgressPercent({ bytes: 0, totalBytes: 0, files: 0, totalFiles: 0 }), 0);
  });
});

describe('backup settings', () => {
  test('shows what a backup includes, with sizes, and warns that there is none yet', async () => {
    const mount = await mountSettings();
    assert.match(mount.querySelector('.backup-notices')!.textContent!, /No backup yet/);

    const boxes = [...mount.querySelectorAll<HTMLInputElement>('input[data-backup-category]')];
    assert.deepEqual(boxes.map((box) => `${box.dataset.backupCategory}:${box.checked}`), [
      'settings:true',
      'credentials:true',
      'chats:true',
      'models:false',
    ]);
    assert.deepEqual(
      [...mount.querySelectorAll('.backup-checklist__size')].map((cell) => cell.textContent),
      ['2.0 KB', '512 B', '5.0 MB', '3.0 GB'],
    );
    assert.match(mount.querySelector('.backup-total')!.textContent!, /About 5\.0 MB before compression/);
    assert.match(mount.textContent!, /Needs a passphrase/);
  });

  test('changing the selection saves it, and the last category cannot be removed', async () => {
    routes['PUT /settings'] = (body) => [200, { settings: { ...status.settings, categories: body!.categories } }];
    const mount = await mountSettings();
    const box = (id: string) => mount.querySelector<HTMLInputElement>(`input[data-backup-category="${id}"]`)!;

    box('models').checked = true;
    change(box('models'));
    await settle();
    assert.deepEqual(calls.at(-1), {
      method: 'PUT',
      route: '/settings',
      body: { categories: ['settings', 'credentials', 'chats', 'models'] },
    });
    assert.match(mount.querySelector('.backup-total')!.textContent!, /3\.0 GB/);

    for (const id of ['settings', 'credentials', 'chats']) {
      box(id).checked = false;
      change(box(id));
      await settle();
    }
    const before = calls.length;
    box('models').checked = false;
    change(box('models'));
    await settle();
    assert.equal(box('models').checked, true, 'the last one snaps back');
    assert.equal(calls.length, before, 'and nothing is sent');
    assert.deepEqual(statusMessages.at(-1), ['err', 'Keep at least one thing in the backup']);
  });

  test('warns that credentials are left out until a passphrase is typed', async () => {
    const mount = await mountSettings();
    const note = [...mount.querySelectorAll<HTMLElement>('.backup-note')].find((n) =>
      /Without a passphrase/.test(n.textContent ?? ''),
    )!;
    assert.equal(note.hidden, false);
    change(mount.querySelector('#settingsBackupPassphrase')!, 'long enough passphrase');
    assert.equal(note.hidden, true);
  });

  test('checks the passphrase before asking the server for a backup', async () => {
    const mount = await mountSettings();
    const pass = mount.querySelector<HTMLInputElement>('#settingsBackupPassphrase')!;
    const confirm = mount.querySelector<HTMLInputElement>('#settingsBackupPassphraseConfirm')!;
    const create = mount.querySelector<HTMLButtonElement>('#settingsBackupCreateBtn')!;
    const exports = () => calls.filter((call) => call.route === '/export').length;

    change(pass, 'short');
    change(confirm, 'short');
    create.click();
    await settle();
    assert.match(mount.textContent!, /at least 8 characters/);

    change(pass, 'long enough passphrase');
    change(confirm, 'a different passphrase');
    create.click();
    await settle();
    assert.match(mount.textContent!, /two passphrases do not match/);
    assert.equal(exports(), 0);
  });

  test('creates a backup, reports where it went, and forgets the passphrase', async () => {
    routes['POST /export'] = () => [
      202,
      {
        job: {
          id: 'job-1',
          kind: 'export',
          status: 'done',
          startedAt: '',
          finishedAt: '',
          progress: { bytes: 10, totalBytes: 10, files: 6, totalFiles: 6 },
          result: {
            file: 'D:/Backups/minnow-backup-2026-10-01_09-00-00.mnbak',
            archiveBytes: 2 * 1024 * 1024,
            files: 6,
            bytes: 10,
            encrypted: true,
            includesCredentials: true,
            credentialsOmitted: 0,
          },
          error: '',
          errorCode: '',
        },
      },
    ];
    const mount = await mountSettings();
    const pass = mount.querySelector<HTMLInputElement>('#settingsBackupPassphrase')!;
    const confirm = mount.querySelector<HTMLInputElement>('#settingsBackupPassphraseConfirm')!;
    change(pass, 'long enough passphrase');
    change(confirm, 'long enough passphrase');
    change(mount.querySelector('.backup-path-input')!, 'D:/Backups');
    mount.querySelector<HTMLButtonElement>('#settingsBackupCreateBtn')!.click();
    await settle();
    await settle();

    const sent = calls.find((call) => call.route === '/export')!;
    assert.deepEqual(sent.body, {
      destDir: 'D:/Backups',
      categories: ['settings', 'credentials', 'chats'],
      passphrase: 'long enough passphrase',
    });
    assert.match(mount.textContent!, /Backup saved to D:\/Backups\/minnow-backup-.*\(2\.0 MB, encrypted\)/);
    assert.match(mount.textContent!, /Minnow cannot recover it/);
    assert.equal(pass.value, '');
    assert.equal(confirm.value, '');
    assert.equal(mount.innerHTML.includes('long enough passphrase'), false);
    assert.deepEqual(statusMessages.at(-1), ['ok', 'Backup created']);
  });

  test('a failed backup says why and re-enables the button', async () => {
    routes['POST /export'] = () => [400, { error: 'Choose a folder outside the Minnow data folder.', code: 'dest_inside_home' }];
    const mount = await mountSettings();
    const create = mount.querySelector<HTMLButtonElement>('#settingsBackupCreateBtn')!;
    create.click();
    await settle();
    await settle();
    assert.match(mount.textContent!, /outside the Minnow data folder/);
    assert.equal(create.disabled, false);
  });

  test('turning snapshots on starts with the folder already in use', async () => {
    routes['PUT /settings'] = (body) => {
      const patch = body!.schedule as Record<string, unknown>;
      return [200, { settings: { ...status.settings, schedule: { ...status.settings.schedule, ...patch } } }];
    };
    const mount = await mountSettings();
    const toggle = mount.querySelector<HTMLInputElement>('#settingsBackupScheduleEnabled')!;
    assert.equal(mount.querySelector<HTMLButtonElement>('#settingsBackupSnapshotBtn')!.disabled, true);

    toggle.checked = true;
    change(toggle);
    await settle();
    assert.deepEqual(calls.at(-1)!.body, {
      schedule: { enabled: true, destDir: 'C:/Users/me/Documents/Minnow Backups' },
    });
    assert.equal(mount.querySelector<HTMLButtonElement>('#settingsBackupSnapshotBtn')!.disabled, false);
    assert.deepEqual(statusMessages.at(-1), ['ok', 'Scheduled snapshots are on']);
  });

  test('a rejected snapshot setting snaps back', async () => {
    routes['PUT /settings'] = () => [400, { error: 'Keep between 1 and 60 snapshots.', code: 'bad_schedule' }];
    const mount = await mountSettings();
    const keep = mount.querySelector<HTMLInputElement>('#settingsBackupKeep')!;
    change(keep, '500');
    await settle();
    assert.equal(keep.value, '7');
    assert.deepEqual(statusMessages.at(-1), ['err', 'Keep between 1 and 60 snapshots.']);
  });

  test('the snapshot passphrase is set and removed, never shown', async () => {
    routes['PUT /settings'] = (body) => {
      const patch = body!.schedule as { passphrase?: string | null };
      return [
        200,
        { settings: { ...status.settings, schedule: { ...status.settings.schedule, hasPassphrase: typeof patch.passphrase === 'string' } } },
      ];
    };
    const mount = await mountSettings();
    const form = mount.querySelector<HTMLElement>('.backup-passphrase-form')!;
    assert.equal(form.hidden, true);
    assert.match(mount.textContent!, /Snapshots are not encrypted and leave credentials out/);

    buttonNamed(mount, 'Set passphrase').click();
    assert.equal(form.hidden, false);
    const [first, second] = [...form.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    change(first, 'snapshot passphrase');
    change(second, 'snapshot passphrase');
    buttonNamed(form, 'Save passphrase').click();
    await settle();

    assert.deepEqual(calls.at(-1)!.body, { schedule: { passphrase: 'snapshot passphrase' } });
    assert.equal(form.hidden, true);
    assert.equal(first.value, '');
    assert.match(mount.textContent!, /Snapshots are encrypted and include credentials/);
    assert.equal(buttonNamed(mount, 'Remove').hidden, false);

    buttonNamed(mount, 'Remove').click();
    await settle();
    assert.match(confirmPrompts.at(-1)!, /Remove the snapshot passphrase/);
    assert.deepEqual(calls.at(-1)!.body, { schedule: { passphrase: null } });
  });

  test('a failed snapshot is shown with its reason', async () => {
    status.settings.schedule = { enabled: true, frequency: 'daily', destDir: 'E:/Snapshots', keep: 7, hasPassphrase: false };
    status.settings.state = {
      ...status.settings.state,
      lastRunAt: '2026-10-01T03:00:00.000Z',
      lastStatus: 'failed',
      lastError: 'The snapshot folder is not available: E:/Snapshots (ENOENT).',
      nextRunAt: '2026-10-01T04:00:00.000Z',
      failures: 1,
    };
    const mount = await mountSettings();
    assert.match(mount.textContent!, /The last snapshot failed: The snapshot folder is not available/);
    assert.match(mount.querySelector('.backup-snapshot-status')!.textContent!, /\(failed\)\. Next:/);
  });

  test('a restore waiting for a restart can be cancelled', async () => {
    status.restore.pending = {
      id: 'r1',
      kind: 'restore',
      createdAt: '2026-10-01T10:00:00.000Z',
      archive: { file: 'D:/Backups/a.mnbak', createdAt: '2026-09-30T10:00:00.000Z', appVersion: '0.1.6', encrypted: true },
      categories: ['chats'],
      warnings: ['This backup was made by Minnow 0.1.5.'],
      attempts: 0,
      lastError: '',
      failed: false,
    };
    routes['POST /restore/cancel'] = () => {
      status.restore.pending = null;
      return [200, { cancelled: true }];
    };
    const mount = await mountSettings();
    const notices = mount.querySelector('.backup-notices')!;
    assert.match(notices.textContent!, /is unpacked and checked\. Quit Minnow and start it again/);
    assert.match(notices.textContent!, /made by Minnow 0\.1\.5/);
    assert.equal(notices.querySelector('button')!.textContent, 'Cancel restore', 'no restart button outside the installed app');
    assert.equal(
      mount.querySelector<HTMLElement>('#settingsBackupRestoreBtn')!.closest<HTMLElement>('.settings-actions')!.hidden,
      true,
    );

    buttonNamed(notices, 'Cancel restore').click();
    await settle();
    await settle();
    assert.equal(/unpacked and checked/.test(notices.textContent!), false);
    assert.deepEqual(statusMessages.at(-1), ['ok', 'Cancelled']);
  });

  test('a restore that gave up shows the error and offers another try', async () => {
    status.restore.pending = {
      id: 'r1',
      kind: 'restore',
      createdAt: '',
      archive: null,
      categories: [],
      warnings: [],
      attempts: 3,
      lastError: 'EBUSY: resource busy, rename sessions',
      failed: true,
    };
    const mount = await mountSettings();
    const notices = mount.querySelector('.backup-notices')!;
    assert.match(notices.textContent!, /stopped trying\. Your data is unchanged\. EBUSY/);
    buttonNamed(notices, 'Try again at next start');
  });

  test('the last restore can be undone or its previous data deleted', async () => {
    status.restore.last = {
      id: 'r1',
      appliedAt: '2026-10-01T10:00:00.000Z',
      rolledBackAt: null,
      archive: { file: 'D:/Backups/a.mnbak', createdAt: '2026-09-30T10:00:00.000Z', appVersion: '0.1.6', encrypted: true },
      categories: ['chats'],
      keyChanged: true,
      setAside: 2,
      canUndo: true,
      previousDataBytes: 420 * 1024 * 1024,
    };
    routes['POST /restore/undo'] = () => [200, { id: 'r1', restartRequired: true }];
    const mount = await mountSettings();
    assert.match(mount.textContent!, /Previous data kept: 420 MB/);
    assert.match(mount.textContent!, /2 encrypted files it did not replace were set aside/);

    confirmAnswer = false;
    buttonNamed(mount, 'Undo restore').click();
    await settle();
    assert.equal(calls.some((call) => call.route === '/restore/undo'), false, 'declining the prompt does nothing');

    confirmAnswer = true;
    buttonNamed(mount, 'Undo restore').click();
    await settle();
    await settle();
    assert.ok(calls.some((call) => call.route === '/restore/undo'));
    buttonNamed(mount, 'Delete previous data');
  });

  test('a paired device is told backups are managed on the host', async () => {
    routes['GET /status'] = () => [403, { error: 'Host session required' }];
    const mount = await mountSettings();
    assert.match(mount.textContent!, /managed on the computer that runs Minnow/);
    assert.equal(mount.querySelector('#settingsBackupCreateBtn'), null);
  });
});

describe('restore panel', () => {
  const listed = [
    { file: 'D:/Backups/b.mnbak', name: 'b.mnbak', archiveBytes: 2048, createdAt: '2026-10-01T10:00:00.000Z', appVersion: '0.1.6', encrypted: true, includesCredentials: true, label: '' },
    { file: 'D:/Backups/a.mnbak', name: 'a.mnbak', archiveBytes: 1024, createdAt: '2026-09-30T10:00:00.000Z', appVersion: '0.1.6', encrypted: false, includesCredentials: false, label: '' },
  ];
  const preview = {
    file: 'D:/Backups/b.mnbak',
    archiveBytes: 2048,
    createdAt: '2026-10-01T10:00:00.000Z',
    appVersion: '0.1.6',
    platform: 'win32',
    label: '',
    encrypted: true,
    includesCredentials: true,
    totals: { files: 9, bytes: 8192 },
    categories: [
      { id: 'chats', label: 'Chats and usage history', description: '', files: 1, bytes: 4096, known: true },
      { id: 'brain', label: 'Brain and memory', description: '', files: 8, bytes: 4096, known: true },
      { id: 'future', label: 'future', description: '', files: 1, bytes: 1, known: false },
    ],
    warnings: ['Part of this backup is from a newer Minnow and will be skipped.'],
    passphraseOk: null,
  };

  function mountPanel(overrides: Partial<Parameters<typeof mountRestorePanel>[1]> = {}) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const events: string[] = [];
    const handle = mountRestorePanel(host, {
      initialDir: 'D:/Backups',
      canRestartInPlace: false,
      onClose: () => events.push('close'),
      onChanged: () => events.push('changed'),
      ...overrides,
    });
    return { host, events, handle };
  }

  test('lists the backups in a folder, newest first, and says when there are none', async () => {
    routes['POST /list'] = (body) => [200, { backups: body!.dir === 'D:/Backups' ? listed : [] }];
    const { host } = mountPanel();
    await settle();
    const picks = [...host.querySelectorAll('.backup-restore__pick')];
    assert.equal(picks.length, 2);
    assert.match(picks[0].textContent!, /2\.0 KB · Encrypted · includes credentials/);
    assert.match(picks[1].textContent!, /Not encrypted · no credentials/);

    change(host.querySelector('.backup-path-input')!, 'D:/Empty');
    await settle();
    assert.match(host.textContent!, /No Minnow backups in this folder/);
  });

  test('previews, asks for the passphrase, and stages the chosen parts', async () => {
    routes['POST /list'] = () => [200, { backups: listed }];
    routes['POST /inspect'] = () => [200, { backup: preview }];
    routes['POST /restore'] = () => [
      202,
      {
        job: {
          id: 'job-2',
          kind: 'restore',
          status: 'done',
          startedAt: '',
          finishedAt: '',
          progress: { bytes: 1, totalBytes: 1, files: 9, totalFiles: 9 },
          result: { id: 'r1', files: 9, bytes: 8192, categories: ['chats'], warnings: [], restartRequired: true },
          error: '',
          errorCode: '',
        },
      },
    ];
    const { host, events } = mountPanel();
    await settle();
    (host.querySelector('.backup-restore__pick') as HTMLButtonElement).click();
    await settle();

    assert.match(host.textContent!, /Minnow 0\.1\.6/);
    assert.match(host.textContent!, /from a newer Minnow and will be skipped/);
    const boxes = [...host.querySelectorAll<HTMLInputElement>('.backup-checklist input')];
    assert.deepEqual(boxes.map((box) => [box.checked, box.disabled]), [[true, false], [true, false], [false, true]]);

    const restore = host.querySelector<HTMLButtonElement>('#backupRestoreConfirmBtn')!;
    restore.click();
    await settle();
    assert.match(host.textContent!, /Enter the passphrase for this backup/);
    assert.equal(calls.some((call) => call.route === '/restore'), false);

    boxes[1].checked = false;
    change(boxes[1]);
    change(host.querySelector('input[type="password"]')!, 'the passphrase');
    restore.click();
    await settle();
    await settle();

    assert.match(confirmPrompts.at(-1)!, /Your current data is kept so you can undo this/);
    assert.deepEqual(calls.find((call) => call.route === '/restore')!.body, {
      path: 'D:/Backups/b.mnbak',
      passphrase: 'the passphrase',
      categories: ['chats'],
    });
    assert.match(host.textContent!, /Quit Minnow and start it again to switch to it/);
    assert.deepEqual(events, ['changed']);
    assert.equal(host.innerHTML.includes('the passphrase'), false);
  });

  test('a wrong passphrase keeps the preview open with the reason', async () => {
    routes['POST /list'] = () => [200, { backups: listed }];
    routes['POST /inspect'] = () => [200, { backup: preview }];
    routes['POST /restore'] = () => [
      202,
      {
        job: {
          id: 'job-3',
          kind: 'restore',
          status: 'failed',
          startedAt: '',
          finishedAt: '',
          progress: { bytes: 0, totalBytes: 1, files: 0, totalFiles: 9 },
          result: null,
          error: 'Wrong passphrase, or this backup is damaged.',
          errorCode: 'bad_passphrase',
        },
      },
    ];
    const { host, events } = mountPanel();
    await settle();
    (host.querySelector('.backup-restore__pick') as HTMLButtonElement).click();
    await settle();
    change(host.querySelector('input[type="password"]')!, 'nope nope nope');
    const restore = host.querySelector<HTMLButtonElement>('#backupRestoreConfirmBtn')!;
    restore.click();
    await settle();
    await settle();
    assert.match(host.textContent!, /Wrong passphrase, or this backup is damaged/);
    assert.equal(restore.disabled, false);
    assert.deepEqual(events, []);
  });

  test('a pasted file path opens that backup directly', async () => {
    routes['POST /inspect'] = (body) => [200, { backup: { ...preview, file: body!.path } }];
    const { host } = mountPanel({ initialDir: 'E:/Drive/minnow-backup-1.mnbak' });
    await settle();
    await settle();
    assert.equal(calls.some((call) => call.route === '/list'), false);
    assert.match(host.textContent!, /minnow-backup-1\.mnbak/);
    assert.ok(host.querySelector('#backupRestoreConfirmBtn'));
  });

  test('in the setup wizard it skips the confirm and offers a restart in the installed app', async () => {
    routes['POST /list'] = () => [200, { backups: listed }];
    routes['POST /inspect'] = () => [200, { backup: { ...preview, encrypted: false, includesCredentials: false } }];
    routes['POST /restore'] = () => [
      202,
      {
        job: {
          id: 'job-4',
          kind: 'restore',
          status: 'done',
          startedAt: '',
          finishedAt: '',
          progress: { bytes: 1, totalBytes: 1, files: 9, totalFiles: 9 },
          result: { id: 'r1', files: 9, bytes: 8192, categories: ['chats', 'brain'], warnings: [], restartRequired: true },
          error: '',
          errorCode: '',
        },
      },
    ];
    let restarted = 0;
    (window as unknown as { minnow: unknown }).minnow = { app: { restart: async () => { restarted += 1; } } };
    const { host } = mountPanel({ elevated: true, canRestartInPlace: true });
    await settle();
    (host.querySelector('.backup-restore__pick') as HTMLButtonElement).click();
    await settle();
    host.querySelector<HTMLButtonElement>('#backupRestoreConfirmBtn')!.click();
    await settle();
    await settle();

    assert.equal(confirmPrompts.length, 0);
    assert.match(host.textContent!, /Restart Minnow to switch to it/);
    buttonNamed(host, 'Restart Minnow').click();
    assert.equal(restarted, 1);
  });
});
