# Repository Instructions

## What This App Does

This repository contains the ICSE public status page for
`status.securityexcellence.net`.

It is a Cloudflare Workers app with three responsibilities:

- Serve the static status page from `public/` through the Worker assets binding.
- Expose status APIs from the Worker under `/api/*`.
- Run scheduled HTTP health checks from the Worker `scheduled()` handler and store the latest snapshot plus recent events in Workers KV.

Current storage is intentionally simple: Workers KV stores `status:latest`,
`status:history`, and `status:last-run`. The monitored service list lives in
`config/services.json`.

## Hard Rules

- Never deploy without explicit user approval in the current conversation.
- Never run `npm run deploy`, `wrangler deploy`, Cloudflare deployment APIs, deploy hooks, or dashboard deployment actions unless the user has explicitly approved that deployment.
- Dry-run deployment checks are allowed only when the command clearly includes `--dry-run` and the result cannot publish or promote a Worker version.
- Never commit or push without explicit user approval in the current conversation.
- Never run `git commit`, `git push`, GitHub release commands, PR merge commands, or any equivalent action that writes to GitHub unless the user has explicitly approved it.
- Do not enable Cloudflare Git auto-deploy, deploy hooks, or other automatic deployment paths unless the user explicitly asks for that change.

## Code Organization

- `src/index.ts` owns Worker entrypoints, routing, and API responses.
- `src/status.ts` owns service config validation, health checks, aggregation, history generation, KV persistence, and JSON helpers.
- `src/types.ts` owns shared TypeScript interfaces and status-state types.
- `src/status.test.ts` covers config parsing, service checking, aggregation, history, and KV persistence.
- `public/` contains the framework-free static frontend.
- `config/services.json` is the only place service checks should be added.
- `wrangler.jsonc` owns Cloudflare bindings, static assets, cron triggers, and custom domain configuration.

## Conventions

- Use TypeScript ESM and keep `strict` compatibility.
- Keep Worker runtime code platform-native: use Fetch API, `Request`, `Response`, `AbortController`, and Cloudflare bindings instead of Node-only APIs.
- Treat HTTP `2xx` and `3xx` as healthy. Treat HTTP `4xx`, `5xx`, timeouts, and network failures as outages.
- Keep service `id` values stable. They are used for status history and state comparisons.
- Keep the frontend vanilla HTML/CSS/JavaScript unless there is a clear need for a framework.
- Keep API responses JSON with `cache-control: no-store`.
- Prefer small pure helpers in `src/status.ts` and focused tests in `src/status.test.ts`.
- Use ASCII for project docs and code unless a file already requires non-ASCII content.

## Tests And Verification

- Run `npm run check` before handing off code changes.
- `npm run check` runs TypeScript with `tsc --noEmit` and Vitest with `vitest run`.
- For local Worker verification, run `npm run dev`, then use:
  `curl "http://localhost:8787/cdn-cgi/handler/scheduled"`.
- After triggering the scheduled handler locally, inspect `/api/status` and `/api/history`.
- If Cloudflare config changed, `npm run deploy -- --dry-run` may be used for bundle verification because it does not publish.

