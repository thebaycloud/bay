# Bay docs

The public product documentation, built with [Mintlify](https://mintlify.com).
`docs.json` is the whole site definition — theme, navigation, every page.

```bash
cd apps/docs
npm install
npm run dev          # http://localhost:3000
npm run check        # broken links
```

## What goes here, and what does not

This is **product language** — the words a person reads. `docs/` at the repo root
is the platform's own documentation: architecture, ADRs, plans, runbooks. The two
do not mix, and [`CONTEXT.md`](../../CONTEXT.md) is the rule for which word
belongs where.

Nothing on these pages should describe a mechanism a user cannot act on.

## Where the content comes from

Every reference page is derived from something that can be checked, and should be
re-derived rather than edited by hand when the source moves:

| Page | Source of truth |
|---|---|
| `cli/*` | `bay help --all` in `packages/cli` |
| `configuration/*` | The exported interfaces in `apps/web/lib/app-config.ts` |
| `concepts` | The product-language half of [`CONTEXT.md`](../../CONTEXT.md) |
| `quickstart` | Real `bay init` / `bay check` / `bay ship` output |

If a page and its source disagree, the source is right and the page is a bug.
