# 08. Security, storage, backups and remote devices

Date: 2026-10-23. Baseline: ba2068d1c5353f86287f9a02b665fb7ea0bbac3f. Read-only review with synthetic scratch reproductions.

## Assessment

Minnow has substantial boundary work: per-listener identity, host/device separation, same-origin cookie checks, hashed device credentials, symlink-aware workspace paths, authenticated backups and staged restore. The selected existing tests passed. Three independently reproduced failures remain material to trusting a chat-driven workspace: concurrent first key creation loses decryptability, revocation does not terminate existing terminal access, and process interruption during restore can leave a mixed profile that normal boot continues to open.

These are specific contract failures, not a claim that the entire security design is unsound.

## Scope and boundaries

Read/sampled `server/runtime/{auth-middleware,authenticate-token,request-auth,path-access,workspace-scope-middleware,bootstrap,host-lock,ws-attach}.js`; `server/auth/{routes,pairing,device-store,cookie}.js`; `server/network/{access,ingress}.js`; `server/remote/ingress-manager.js`; `server/security/secret-box.js`; `server/workspace/safe-path.js`; `server/backup/{catalog,format,restore,restore-apply,middleware}.js`; shell sandbox mode/adapter resolution; Electron navigation/trusted IPC; relevant tests.

Not exhaustive: penetration testing; every API authorization route; MCP/plugin worker security; Tailscale sidecar/native networking; OS ACL guarantees; cryptographic implementation audit; every session-store conflict path; Linux/macOS native sandbox execution; real mobile pairing. No live profile or credential contents were inspected.

## Good

- **Listener identity is an explicit trust boundary.** The host token authenticates only on loopback ingress, and remote HTML does not embed it. The sidecar cannot become host merely because its peer address is local (`server/network/ingress.js:1`; `server/runtime/authenticate-token.js`). Existing ingress tests passed.
- **Device credentials are not normal JavaScript session state.** Store records contain hashes, browser cookies are HttpOnly, cookie-authenticated writes/WebSockets require the exact origin, and authentication storage outages return retryable failure rather than false revocation (`server/runtime/request-auth.js:35`, `:89`). Relevant cookie/device tests passed.
- **Filesystem scope canonicalizes symlinks.** Boundary resolution walks existing parents for new paths and uses native Windows realpath (`server/workspace/safe-path.js:18`). This is stronger than lexical prefix checks.
- **Backups are deliberately cataloged.** Sensitive categories require a passphrase; credentials/key move together; caches and process state are explicitly excluded (`server/backup/catalog.js:42`). Restore validates known roots, unsafe paths, duplicate entries and SQLite integrity (`server/backup/restore.js:283`, `:322`).
- **Restore is staged before opening stores.** Caught failures unwind directory moves and preserve previous data; existing staging/rollback/key-change tests passed. Keep that foundation while adding crash durability.
- **Privileged Electron IPC validates the sender.** Registered shell ID, main-frame identity and app document URL must all match (`electron/navigation-policy.ts:30`; `electron/trusted-ipc.ts:17`); external protocol dispatch is allowlisted.

## Findings

### 08-01 [P1] Concurrent first encryption creates competing master keys and loses successful writes

**Evidence:** `server/security/secret-box.js:47` checks only a resolved key cache. Multiple callers may all read ENOENT at `:54`, create random keys and write the same .key non-exclusively at `:70`; each can then encrypt with its own key. There is no shared initialization promise or exclusive-create/re-read protocol.

**Trigger:** two or more secret-encryption requests overlap before the profile has a key. Multiple host processes sharing a fresh home add the same filesystem race.

**Observed:** the saved reproduction invoked 32 concurrent encryptions against a fresh temporary MINNOW_HOME. All 32 succeeded; only 1 envelope subsequently decrypted, while 31 failed. No real credentials were involved.

**Impact:** API credentials, scheduled prompts or other encrypted records may be accepted and then become unreadable. This is direct loss of decryptability, with downstream failures such as one corrupt scheduler prompt blocking dispatch (09-01).

**Confidence:** confirmed by executable scratch reproduction.

**Repair:** coalesce initialization inside a process and use atomic exclusive key creation across processes. Losing creators must read the winning key. Never overwrite an existing key as initialization. Add same-process and separate-process first-use regression coverage, including file permission behavior.

**Reproduce:** `node documentation/reviews/2026-10-23/evidence/08-secret-init-race.mjs`. Current code exits 1 at the intended invariant assertion.

### 08-02 [P1] Revoked devices retain input access through an existing terminal WebSocket

**Evidence:** `server/terminal/pty-ws.js:29` authorizes only the upgrade; it discards the authenticated identity. Subsequent messages call `writePtySession` without revalidation (`:58`, `:64`). `revokeDevice`/`revokeCredential` remove stored records but do not close active sockets (`server/auth/device-store.js:450`, `:464`).

**Trigger:** a paired device opens a terminal connection, then the owner revokes that device.

**Observed:** a real local WebSocket used a synthetic credential in a temporary registry and a mocked PTY. After revocation, direct authentication returned false but the existing socket still delivered one input write. No real command executed.

**Impact:** the host's revoke action prevents new requests but does not immediately remove an already-open remote control channel. A compromised device can continue sending terminal input until the connection ends.

**Confidence:** confirmed transport reproduction. Other long-lived sockets/streams need the same lifecycle audit; this finding proves the terminal input path specifically.

**Repair:** retain device/credential identity on each connection; close matching sockets on revocation and listener shutdown. Revalidate where necessary across processes and test already-open terminal plus other privileged streams, not just new HTTP requests.

**Reproduce:** `node --experimental-test-module-mocks documentation/reviews/2026-10-23/evidence/08-revoked-terminal-socket.mjs`. Expected failing assertion; output reports invalid HTTP credential and one post-revocation write.

### 08-03 [P1] Restore's move journal is not durable across process death

**Evidence:** the Journal stores completed moves only in an array (`server/backup/restore-apply.js:126`, `:139`). `swapRoot` parks the live directory then moves the staged directory into place (`:293`). After process death, that root has no incoming staging directory. Retry recreates an empty incoming directory (`:285`) and tries to park the already-restored live directory over the existing nonempty prior-data directory. Normal boot logs the failure then continues opening stores (`server/runtime/bootstrap.js:54`).

**Trigger:** crash/forced exit after one directory root has been installed and before the remaining roots or final restore marker are completed.

**Observed:** the saved reproduction kills a child immediately after the first directory's second rename. Retry fails with EPERM on this Windows host; issues contains restored data while brain still contains old data. Previous data is retained, but profile coherence is not recovered.

**Impact:** the app can open a profile combining different restore timelines. Retrying repeatedly cannot resolve the tested state. Existing tests cover thrown failures/unwind, which can still run in-memory cleanup, rather than abrupt death between durable side effects.

**Confidence:** confirmed fault/restart reproduction on Windows. Other filesystem error codes/platform behavior may differ.

**Repair:** persist and flush a per-root operation journal before/after renames; make recovery idempotent using explicit staged/parked/live state. Block normal store initialization when recovery cannot establish a complete old or new profile, and provide a recovery screen. Test process exits at every rename boundary, including rollback.

**Reproduce:** `node documentation/reviews/2026-10-23/evidence/08-restore-crash.mjs`. Current code exits 1 after reporting the mixed values.

### 08-04 [P1, cross-vertical] Failure diagnostics store full generation bodies outside configured home

**Evidence:** `server/generations/upstream.js:53` writes `homedir()/.minnow/debug/openai-upstream-last-error.json`, including requestBody and provider response, on HTTP/HTML errors (`:473`, `:511`). It ignores MINNOW_HOME and has no debug opt-in in that path. The backup catalog excludes debug (`server/backup/catalog.js`), so this extra copy is outside the normal profile/backup lifecycle.

**Impact:** private conversation/context supplied to a model can be persisted unexpectedly as a separate plaintext failure artifact, including when an isolated profile was requested.

**Confidence:** source-confirmed; originally identified by the Models reviewer and cross-checked here. No live dump content was read.

**Repair:** use the configured home, opt-in bounded redacted diagnostics, restrictive creation permissions and explicit retention. Keep enough non-sensitive status metadata for ordinary errors.

## Priorities and product improvements

1. Repair 08-01 and add concurrency regression coverage before further credential-store expansion.
2. Make revocation cover live connections, not only future requests.
3. Add durable crash recovery to restore before promising profile replacement safety.
4. Apply the same profile identity and retention rules to diagnostics.
5. **Product proposal:** describe backup coverage in outcome terms: conversations/settings versus project repositories, uncommitted worktrees and external files. A successful profile backup is not automatically a backup of every software artifact an agent touched. The catalog deliberately excludes worktrees; avoid implying otherwise in the chat-led build journey.

## Validation and limitations

- Selected existing security/remote/backup suites: `test/security/{auth-middleware,device-auth}.test.mjs`, `test/remote/{cookie-auth,ingress}.test.mjs`, `test/backup/{restore-apply,catalog}.test.mjs`: **64 passed**.
- Three new review evidence scripts above detect current undesirable behavior and intentionally exit 1. Each creates synthetic state in a new temporary directory and removes its own files; terminal execution is mocked.
- Electron navigation/IPC policy, HTTP/WS shutdown, updater reducer and headless approval/preflight batch: **26 passed** (shared with report 09).
- Source review only for native sandbox support and Tailscale trust. No native OS sandbox or real phone assessed.
- No full build/full suite, source edits, credential reads or external git operations.

**Isolation exception:** report 09's already-running packaged-boundary batch exercised the provider-terminal-failure test in `test/headless/production-boundary.test.mjs` through existing compiled artifacts. Because of 08-04, it may have written synthetic fixture diagnostics to the real home path `~/.minnow/debug/openai-upstream-last-error.json`. The warning arrived after that batch had started. No reviewer inspected or deleted that live file. Do not interpret the scratch-home setup as proof that every incidental runtime write was isolated.

## Dependencies

Secret initialization affects provider/plugin/MCP/action/scheduler stores. Restore consistency affects every subsystem opening a profile. Device revocation requires shared WebSocket/stream lifecycle handling across terminal, generations and agent views. Approval/path traversal findings in the chat/tools review are additional policy issues; this report does not duplicate their reproduction.

