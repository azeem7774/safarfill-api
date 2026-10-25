# SafarFill licence server

Cloudflare Worker for SafarFill (publisher: Sahl Labs): licence keys, server-side passport parsing,
AI reader proxy and the admin dashboard at `/admin`.

- API for the extension: see `API.md`
- Database: `schema.sql` (Cloudflare D1, binding `DB`)
- Secrets (Cloudflare, type Secret): `ANTHROPIC_KEY`, `ADMIN_KEY`, `SIGNING_KEY`

## Build the single file for the Cloudflare editor
    npm install
    node build.mjs        # writes dist/worker.js

## Test locally
    # .dev.vars needs SIGNING_KEY, ADMIN_KEY, ANTHROPIC_KEY, AI_URL (test values only)
    npx wrangler d1 execute safarfill --local --file=schema.sql
    node test/mock-anthropic.mjs &
    npx wrangler dev --local --port 8787
    node test/run.mjs

## Deploy
Cloudflare dashboard -> Workers & Pages -> safarfill-api -> Edit code -> paste dist/worker.js -> Deploy.
