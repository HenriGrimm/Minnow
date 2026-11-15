---
name: worktree-local-environment
planType: build
overview: Automatically seed ignored local development and test dotenv files into execution worktrees without approval, without sharing writable files or exposing credentials.
---

# Automatic local environments for worktrees

## Goal and scope

Worktree setup inherits ignored `.env`, `.env.local`, `.env.development`, `.env.development.local`, `.env.dev`, `.env.dev.local`, `.env.test`, `.env.test.local`, `.env.testing`, and `.env.testing.local` files from its originating checkout, including nested packages. No approval or workspace setting is needed. Production, staging, signing, templates, arbitrary ignored files, dependencies, caches, and build outputs are not inherited. Files are copied as opaque bytes, never parsed, logged, committed, or linked back to the source.

Existing destination files and tracked destination paths are never overwritten. Destination ignore rules must protect newly inherited files; unsafe destinations fail setup rather than risk staging credentials. Only regular files through non-linked directory paths inside verified same-repository checkouts are eligible. Atomic exclusive publication, private temporary files, size/count bounds, cancellation, and sanitized errors protect retries and concurrent setup. A failed setup retains its checkout and cannot report ready or start installers that depend on missing configuration.

## Decisions and constraints

Copying configuration is not database, service, or port isolation; existing injected port environment remains authoritative. No automatic migrations, seeding, service creation, dotenv parsing, or rewriting connection strings. Automatic inheritance replaces the earlier proposed approval-based design at the user's request.

## Relevant files

- `server/worktree/local-environment.js`, `server/worktree/prepare-dependencies.js`: shared preparation.
- `server/worktree/worktree-ops.js`, `server/worktree/middleware.js`, `server/git/git-ops.js`: chat, board and Source Control creation/preparation.
- `server/chats/workspace.js`, `server/orchestrator/worktree-lifecycle.js`: child and integration retries.
- `server/scheduler/github-watch-runtime.js`, `server/scheduler/pr-review-runtime.js`: automation execution checkouts.
- `test/server/worktree-local-environment.test.mjs`, affected child/scheduler tests: regression coverage.
- `documentation/context.md`, `documentation/manual/apps/code.md`: architecture and user documentation.

## Implementation steps

### 1. Shared environment preparation
- [x] Local environment preparation is safe and automatic.
- Changes: Implement the following helper and wrapper without changing dependency-only utilities.
- Add a server-only helper using NUL-delimited Git ignored-file discovery with exact development/test basenames and dependency/output exclusions.
- Verify source/destination repository identity, destination tracked/ignore state, path boundaries and regular-file identity. Copy via private same-directory temporary files and atomic no-clobber publication; preserve existing files and clean temporary files on failure/cancellation.
- Return path/status metadata only, with bounded, content-free errors. Add a dependency preparation wrapper that blocks installers on environment failure without changing dependency-only utilities.
- Acceptance: root and nested dummy dotenv files appear byte-identically, remain ignored, and are independently editable; templates, production/signing files, dependencies, links and unrelated repositories cannot leak.
- Verify: Run the real-Git helper regression tests in `test/server/worktree-local-environment.test.mjs`.

### 2. Setup and retry integration
- [x] Every execution-worktree creation path prepares its environment.
- Changes: Wire the shared helper and wrapper into the entry points listed above.
- Use shared preparation before dependencies in chat, child-chat and board integration/task setup, including existing-checkout retries. Respect canonical chat binding before environment/installer work.
- Add environment preparation to Source Control worktree creation, explicit chat preparation, and automation execution worktrees. Exclude merge-preview scratch checkouts, which perform Git-only calculations and do not execute project code.
- Acceptance: every execution checkout is prepared before model/test/install work, failures retain files and do not fall back to the source checkout, and retries do not overwrite local edits.
- Verify: Exercise canonical/direct/automatic/child/board/Source Control and automation fixtures with dummy dotenv files.

### 3. Regression and release checks
- [x] Regression checks pass and the shipped behavior is documented.
- Changes: Add the tests and documentation below, then inspect the complete patch.
- Add real-Git scratch tests for supported names, nested paths with spaces, ignored/tracked boundaries, copy independence, missing files, failure recovery, concurrent calls, cancellation and symlink protections.
- Exercise automatic/canonical/direct/child/board/Source Control and automation paths, including a dependency-install fixture that requires the copied dotenv file.
- Run focused Node/TypeScript suites, test discovery coverage and TypeScript checking; inspect git diff/status. Update architecture and shipped manual with the implemented contract and resource-isolation limits.
- Acceptance: affected suites and typecheck pass, no dotenv contents enter tool results, no unrelated files change, and unrun or platform-limited checks are reported.
- Verify: Run affected Node suites, `npm run test:check-coverage`, and `npx tsc --noEmit`.

## Acceptance checklist

- [x] Supported ignored dotenv files are inherited without prompts before installation.
- [x] Retries preserve destination files and never modify source bytes.
- [x] Unsafe paths, incomplete Git reads and copy failures prevent readiness without exposing values.
- [x] Focused regression suites, discovery coverage and typecheck pass.

## Verification evidence

- Windows: 18 affected and boundary test files, 206 tests passed, zero failures, one existing Unix-only login-shell test skipped. Real lifecycle scripts verified single-package and npm-workspace environment availability before installation; canonical and child allocation, board, Source Control and automation flows were exercised with dummy values only.
- `npx tsc --noEmit`, `npm run test:check-coverage`, and `node scripts/validate-packaged-runtime-files.mjs` passed. The plan parses with `check_plan`.
- Directory-junction safety was exercised on Windows. File-symlink creation is unavailable on this host; that conditional test branch still needs Unix/privileged Windows CI. No full cross-platform release build or complete `npm test` run was performed. Existing Node shell and experimental module-mocking deprecation warnings remain.

## Risks and open questions

- Local `.env` files can point to shared or live services despite their filename; no generic service isolation is inferred.
- Cross-platform link/permission behavior needs regression coverage; Windows symlink tests may require privileges.
- Filesystem and Git checks do not make concurrent external editor or branch changes atomic.
- Git reports ignored nested repositories as directory markers even with dotenv pathspecs. Discovery omits these markers rather than treating them as files.
- Temporary copy bytes are protected by an additive `.minnow-env-*.tmp` rule in the shared Git `info/exclude`, so a crash cannot expose leftover staging files to normal Git staging.
- Atomic no-overwrite publication requires filesystem hard-link support; unsupported filesystems fail setup explicitly rather than use a potentially destructive rename fallback.
- Reused task branches synchronize their base before environment preparation so destination ignore checks use the final branch contents.
