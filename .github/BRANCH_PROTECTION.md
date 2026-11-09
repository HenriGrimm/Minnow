# Branch protection for `main`

The [`ci` workflow](workflows/ci.yml) must pass before merging pull requests, including
the deterministic Orchestrate scenario-contract gate.

## GitHub settings

1. Open **Settings → Branches → Branch protection rules** for `main`.
2. Enable **Require status checks to pass before merging**.
3. Add required checks:
   - **`typecheck + tests`** (aggregate check for Ubuntu and all Windows and macOS shards)
   - **`product wiki`** (catalog drift and manual copy gates — fast Ubuntu job)
   - **`board scenario contract`**
4. Recommended: **Require branches to be up to date before merging**.

The **typecheck + tests** check passes only when every platform test job passes.
Use the aggregate check name in branch protection so the required check stays
the same when shard counts change. Replace any older per-platform
`typecheck + tests (<platform>)` requirements with this aggregate.
The scheduled [`board-nightly.yml`](workflows/board-nightly.yml) and
release-only [`board-release.yml`](workflows/board-release.yml) gates are not PR
branch-protection checks.
