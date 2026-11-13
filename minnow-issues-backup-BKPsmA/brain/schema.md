# Brain Routing Schema

## Page layout

- `pages/facts/` — discrete facts (migrated memory entries)
- `pages/<domain>/` — global knowledge domains
- `pages/workspaces/<key>/` — workspace-scoped pages

## Frontmatter

Each page carries `id` (stable UUID), `title`, `tags`, `source`, `summary`, `pinned`, timestamps, `anchors`, `status`, and `input_hash`.
