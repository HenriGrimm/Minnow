# MIN-126 verification

Date: 2026-10-07. Launch implementation is in the worktree. Live paid provider tests and live Claude/Codex/Cursor image-tool smoke tests were **not run**. Follow-on Mistral and native backend gates are not implemented.

## Implemented

- Independent disabled-by-default image binding with strict configuration validation; existing encrypted provider credentials.
- OpenAI Images generation/multipart edits and OpenRouter dedicated Images API with endpoint capability validation and pinned routing. Only base64 artifacts are accepted; returned URLs and redirects are never followed. HTTPS provider connections only.
- Shared image tools, default Ask, Off/Plan denial, explicit Full for unattended execution, role checks, binding revalidation, execution-identity replay protection and abort propagation.
- Workspace-relative references and exclusive raster outputs, Sharp byte/pixel/format validation, bounded thumbnails, workspace previews, job metadata and actual reported usage/cost.
- Models Routing controls, save/retry, metadata checks, test-generation tool path, search registry, `/image-generation`, manual and architecture inventory.
- Journals retain recoverable bytes after a post-generation storage failure. There is no recovery button; a recoverable journal requires deliberate local recovery, never a new generation POST.

## Checks

| Check | Result |
| --- | --- |
| Image server/config/adapter/asset/job/shared-dispatch fixtures | 10 passed |
| Settings/result/approval UI fixtures | 3 passed |
| Image skill fixture | 1 passed |
| Existing routing + file-benchmark regressions with new UI fixtures | 9 passed |
| Config CRUD + migration | 17 passed; updated expected tool defaults |
| Skills suite | 129 passed |
| Attachment suite | 104 passed |
| Backup suite | 90 passed |
| Product wiki suite | 13 passed |
| Test discovery | 1638 files; 1635 included, 3 excluded; passed |
| `npx tsc --noEmit` | Passed |
| `npm run build` | Passed; existing dynamic-import warnings |
| `npm run headless:build` | Passed |
| `npm test` | Completed, not green; failed files rerun and compared with unchanged HEAD |
| Rendered settings | Desktop and 800px layouts inspected in isolated temporary home; saved adapter/model survived reopening; no generation request |

The initial full run exposed a new file-benchmark inventory assertion. Image tools are now Utility tools and generation is explicitly emit-only in benchmarks. The failed-file rerun passed 721 of 733 tests (one skipped); its remaining 11 failures also reproduced on unchanged HEAD. Two config fixture failures from the earlier runner batch were repaired by recording the image defaults and existing web-map/extract defaults; two Windows file-symlink tests remain EPERM on both revisions.

Remaining baseline failures: missing `frontend-design` benchmark skill probe; aesthetics reference lookup; Godot outline test; build tool-payload ceiling; research search-chain tests; check-plan fixture; tool-start remount timing; editor binding and git-publish mocks missing exports. These are recorded as baseline issues, not passes. The full tool-payload test reports 15,822 tokens on unchanged HEAD and 16,097 with image tools against its 15,000 ceiling. No ceiling was increased.

## Bundle comparison

An isolated archive of unchanged HEAD was built using the same installed dependencies. Both revisions exceed existing eager-JS and total-asset budgets:

| Metric | HEAD | Image worktree | Ceiling |
| --- | ---: | ---: | ---: |
| Eager JS | 4828.6 KB | 4840.1 KB | 4800 KB |
| Total assets | 11017.2 KB | 11033.2 KB | 11000 KB |

Entry JS/CSS and largest lazy chunk remain within ceilings. Budgets and the committed baseline were not changed.

## Verification limits

Provider fixture contracts were checked against the [OpenAI generation reference](https://developers.openai.com/api/reference/resources/images/methods/generate), [edit reference](https://developers.openai.com/api/reference/resources/images/methods/edit) and [OpenRouter dedicated Image API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation). This is not evidence of account entitlement, real provider billing or live model availability.

No live credentials, paid calls or subscription token extraction were used. CLI version evidence and incomplete native gates are recorded in [native findings](image-generation-native-cli-findings.md). Real CLI, board and packaged end-to-end image runs remain unverified; shared dispatch fixtures cover the underlying service, permissions, isolation, cancellation and replay. Full release acceptance is therefore not claimed.
