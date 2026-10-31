import { createHash } from 'node:crypto';
import { getSessionsDb } from '../config/sessions-db.js';
import { ChatContractError } from './contracts.js';

const states = new Set(['reserved', 'allocating', 'ready', 'failed', 'cancelled', 'recovery_required', 'tombstoned']);
const terminal = new Set(['cancelled', 'recovery_required', 'tombstoned']);
const strategies = new Set(['shared', 'new_worktree', 'existing_worktree']);
const mutable = new Set(['setupState', 'ownerId', 'targetCanonicalPath', 'targetWorkspaceId', 'dependencies', 'error', 'cancelledAt', 'deletedAt']);
const id = (value, field) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new ChatContractError('invalid_request', `Invalid ${field}`);
  return value;
};
const text = (value, field, nullable = false) => {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 32768 || value.includes('\0')) throw new ChatContractError('invalid_request', `Invalid ${field}`);
  return value;
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

/** No chat FK: deleting a conversation never loses ownership of retained files. */
export function initChatWorkspaceSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_workspace_allocations (
    allocation_id TEXT PRIMARY KEY,
    child_chat_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    intent_hash TEXT NOT NULL,
    setup_state TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_workspace_project ON chat_workspace_allocations(project_id,setup_state,allocation_id);`);
}

export function createChatWorkspaceRepository({ db = getSessionsDb(), now = Date.now } = {}) {
  initChatWorkspaceSchema(db);
  const read = row => row ? Object.freeze(JSON.parse(row.payload_json)) : null;
  const get = allocationId => read(db.prepare('SELECT payload_json FROM chat_workspace_allocations WHERE allocation_id=?').get(id(allocationId, 'allocationId')));
  function save(previous, patch) {
    const next = { ...previous, ...clone(patch), revision: previous.revision + 1, updatedAt: now() };
    const result = db.prepare('UPDATE chat_workspace_allocations SET setup_state=?,revision=?,payload_json=?,updated_at=? WHERE allocation_id=? AND revision=?')
      .run(next.setupState, next.revision, JSON.stringify(next), next.updatedAt, next.allocationId, previous.revision);
    if (result.changes !== 1) throw new ChatContractError('stale_revision', 'Workspace setup changed');
    return Object.freeze(next);
  }
  const repository = {
    getByAllocation: get,
    getByChild(childChatId) { return read(db.prepare('SELECT payload_json FROM chat_workspace_allocations WHERE child_chat_id=?').get(id(childChatId, 'childChatId'))); },
    reserve(input) {
      const identity = {
        allocationId: id(input.allocationId, 'allocationId'), childChatId: id(input.childChatId, 'childChatId'),
        projectId: id(input.projectId, 'projectId'), strategy: input.strategy,
        sourceWorkspaceId: id(input.sourceWorkspaceId, 'sourceWorkspaceId'), sourceCanonicalPath: text(input.sourceCanonicalPath, 'sourceCanonicalPath'),
        sourceCommonDir: text(input.sourceCommonDir, 'sourceCommonDir', true),
        targetPath: text(input.targetPath, 'targetPath'),
        slotId: input.slotId == null ? null : id(input.slotId, 'slotId'), branch: text(input.branch, 'branch', true),
        baseSha: text(input.baseSha, 'baseSha', true), sourceHeadSha: text(input.sourceHeadSha, 'sourceHeadSha', true),
        sourceDirty: input.sourceDirty === true, uncommittedParentEditsExcluded: input.strategy === 'new_worktree',
      };
      if (!strategies.has(identity.strategy)) throw new ChatContractError('invalid_request', 'Invalid workspace strategy');
      for (const sha of [identity.baseSha, identity.sourceHeadSha]) if (sha !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new ChatContractError('invalid_request', 'Invalid captured commit');
      const fingerprint = hash(identity);
      return db.transaction(() => {
        const previous = db.prepare('SELECT payload_json,intent_hash FROM chat_workspace_allocations WHERE allocation_id=? OR child_chat_id=?').get(identity.allocationId, identity.childChatId);
        if (previous) {
          if (previous.intent_hash !== fingerprint) throw new ChatContractError('idempotency_conflict', 'Workspace allocation identity was reused');
          return { ...read(previous), replayed: true };
        }
        const stamp = now();
        const record = { version: 1, ...identity, setupState: 'reserved', ownerId: null, targetCanonicalPath: null, targetWorkspaceId: null,
          dependencies: null, error: null, cancelledAt: null, deletedAt: null, revision: 0, createdAt: stamp, updatedAt: stamp };
        db.prepare('INSERT INTO chat_workspace_allocations(allocation_id,child_chat_id,project_id,intent_hash,setup_state,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(record.allocationId, record.childChatId, record.projectId, fingerprint, record.setupState, JSON.stringify(record), stamp, stamp);
        return { ...record, replayed: false };
      })();
    },
    claim(allocationId, { expectedRevision, ownerId, retry = false } = {}) {
      return db.transaction(() => {
        const previous = get(allocationId);
        if (!previous || previous.revision !== expectedRevision) throw new ChatContractError('stale_revision', 'Workspace setup changed');
        if (previous.setupState !== 'reserved' && !(retry && previous.setupState === 'failed')) throw new ChatContractError('ownership_conflict', 'Workspace setup is already owned or terminal');
        return save(previous, { setupState: 'allocating', ownerId: id(ownerId, 'ownerId'), error: null });
      })();
    },
    update(allocationId, patch, { expectedRevision, ownerId } = {}) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !mutable.has(key))) throw new ChatContractError('invalid_request', 'Unsupported workspace binding change');
      if (patch.setupState !== undefined && !states.has(patch.setupState)) throw new ChatContractError('invalid_request', 'Invalid workspace setup state');
      if (patch.targetWorkspaceId != null) id(patch.targetWorkspaceId, 'targetWorkspaceId');
      if (patch.targetCanonicalPath != null) text(patch.targetCanonicalPath, 'targetCanonicalPath');
      if (patch.ownerId != null) id(patch.ownerId, 'ownerId');
      return db.transaction(() => {
        const previous = get(allocationId);
        if (!previous || previous.revision !== expectedRevision) throw new ChatContractError('stale_revision', 'Workspace setup changed');
        if (terminal.has(previous.setupState)) throw new ChatContractError('ownership_conflict', 'Terminal workspace setup cannot be resumed');
        if (previous.ownerId && previous.ownerId !== ownerId) throw new ChatContractError('ownership_conflict', 'Workspace setup belongs to another owner');
        if (previous.setupState === 'ready' && patch.setupState !== 'tombstoned') throw new ChatContractError('ownership_conflict', 'A ready checkout binding is immutable');
        if (patch.setupState && patch.setupState !== 'tombstoned' &&
          (previous.setupState !== 'allocating' || !['ready', 'failed', 'cancelled', 'recovery_required'].includes(patch.setupState))) {
          throw new ChatContractError('ownership_conflict', 'Workspace setup transition requires its allocation owner');
        }
        if ((previous.targetCanonicalPath && patch.targetCanonicalPath !== undefined && patch.targetCanonicalPath !== previous.targetCanonicalPath) ||
            (previous.targetWorkspaceId && patch.targetWorkspaceId !== undefined && patch.targetWorkspaceId !== previous.targetWorkspaceId)) {
          throw new ChatContractError('ownership_conflict', 'The confirmed checkout identity is immutable');
        }
        return save(previous, patch);
      })();
    },
    tombstone(childChatId) {
      return db.transaction(() => {
        const previous = repository.getByChild(childChatId);
        if (!previous || previous.setupState === 'tombstoned') return previous;
        return save(previous, { setupState: 'tombstoned', deletedAt: now() });
      })();
    },
    list({ projectId, setupState, afterAllocationId = '', limit = 1000 } = {}) {
      if (projectId !== undefined) id(projectId, 'projectId');
      if (setupState !== undefined && !states.has(setupState)) throw new ChatContractError('invalid_request', 'Invalid workspace setup state');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ChatContractError('invalid_request', 'Invalid workspace binding limit');
      return db.prepare('SELECT payload_json FROM chat_workspace_allocations WHERE (? IS NULL OR project_id=?) AND (? IS NULL OR setup_state=?) AND allocation_id>? ORDER BY allocation_id LIMIT ?')
        .all(projectId ?? null, projectId ?? null, setupState ?? null, setupState ?? null, afterAllocationId, limit).map(read);
    },
  };
  return repository;
}
