# ICSE Status

Status page for ICSE services and sites, intended to run on Cloudflare Workers at
`status.securityexcellence.net`.

The project is one Worker deployment:

- Worker static assets serve the public page from `public/`.
- API routes expose current status and recent changes.
- A Cron Trigger runs every 5 minutes.
- Workers KV stores the latest snapshot and a rolling history list.

Project safety rules for agents and maintainers:

- Do not deploy without explicit approval.
- Do not commit or push to GitHub without explicit approval.
- See `AGENTS.md` for the hard rules future agents must follow.

## Setup

Install dependencies:

```sh
npm install
```

Create the KV namespaces in Cloudflare:

```sh
npx wrangler kv namespace create STATUS_KV
npx wrangler kv namespace create STATUS_KV --preview
```

Copy the returned `id` and `preview_id` values into `wrangler.jsonc`.

## Configure Services

Service checks are configured in `config/services.json`. The file starts with an
empty `services` array so a fresh deployment does not monitor anything
accidentally.

### Add The First Service Check

Replace the empty array in `config/services.json` with the first service entry:

```json
{
  "$schema": "./services.schema.json",
  "services": [
    {
      "id": "main-site",
      "name": "Main Site",
      "group": "Websites",
      "url": "https://securityexcellence.net",
      "description": "Primary public website",
      "timeoutMs": 8000
    }
  ]
}
```

Rules:

- `id` must be lowercase letters, digits, and hyphens.
- `url` must be `http` or `https`.
- HTTP `2xx` and `3xx` responses are healthy.
- HTTP `4xx`, `5xx`, timeouts, and network failures are outages.
- `timeoutMs` is optional and must be between `1000` and `30000`.
- Keep `id` stable once a service has been deployed; changing it makes the app
  treat the endpoint as a different service in history.

Then verify locally:

```sh
npm run check
npm run dev
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
curl "http://localhost:8787/api/status"
```

Open `http://localhost:8787` and confirm the service appears with the expected
group, name, health state, HTTP code, and latency.

### Add Subsequent Service Checks

Append another object to the `services` array:

```json
{
  "id": "support-portal",
  "name": "Support Portal",
  "group": "Websites",
  "url": "https://support.securityexcellence.net",
  "description": "Client support portal",
  "timeoutMs": 8000
}
```

Checklist for each new service:

- Use a unique lowercase `id` with letters, digits, and hyphens.
- Use the same `group` for related services so the UI clusters them.
- Use the public URL that best represents user-facing availability.
- Omit `timeoutMs` unless the endpoint needs a custom timeout.
- Run `npm run check`, start local Wrangler, trigger the scheduled handler, and
  inspect `/api/status`.

## API

- `GET /api/status` returns the latest status snapshot.
- `GET /api/history` returns recent status-change events.
- `GET /api/health` returns Worker health and config metadata.

## Local Development

Start Wrangler:

```sh
npm run dev
```

Trigger the scheduled handler locally:

```sh
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

Then open `http://localhost:8787`.

## Checks

Run type checks and tests:

```sh
npm run check
```

## Deploy

Hard rule: do not deploy without explicit approval.

After approval, replacing the KV namespace IDs, and confirming the Cloudflare
zone is available for `securityexcellence.net`, deploy:

```sh
npm run deploy
```

The route in `wrangler.jsonc` maps the Worker to `status.securityexcellence.net`.

## Cloudflare UI Setup

These are the Cloudflare dashboard steps to get the project ready. The source of
truth for this repo remains `wrangler.jsonc`; avoid making dashboard-only
changes that conflict with it.

1. Confirm the zone:
   - In Cloudflare, make sure `securityexcellence.net` is an active zone in the
     account.
   - Confirm `status.securityexcellence.net` does not already have a conflicting
     CNAME record. Cloudflare Custom Domains cannot be created on a hostname with
     an existing CNAME.

2. Create the KV namespace:
   - Go to Workers KV.
   - Select Create instance.
   - Name it for this app, for example `icse-status`.
   - Create a preview namespace too, or create one with Wrangler using
     `npx wrangler kv namespace create STATUS_KV --preview`.
   - Put the production `id` and preview `preview_id` into `wrangler.jsonc`.

3. Create or connect the Worker:
   - Go to Workers & Pages.
   - Select Create application.
   - Import the existing Git repository if you want Cloudflare Builds to manage
     deployments, or create the Worker through the first approved Wrangler
     deploy.
   - If using Cloudflare Builds, use the repository root, leave Build command
     empty, and use `npm run deploy` as the deploy command.
   - Do not enable automatic deployment until that workflow is explicitly
     approved.

4. Confirm bindings:
   - Go to Workers & Pages, select the `icse-status` Worker, then open Bindings.
   - Confirm there is a KV namespace binding named `STATUS_KV`.
   - If adding it in the dashboard, choose KV namespace, set Variable name to
     `STATUS_KV`, select the namespace created above, and save.

5. Confirm static assets:
   - `wrangler.jsonc` already points the assets binding at `./public` using the
     binding name `ASSETS`.
   - Wrangler uploads the files in that directory with the Worker during an
     approved deployment.

6. Confirm the cron trigger:
   - `wrangler.jsonc` configures `*/5 * * * *`.
   - For a deployed Worker, go to Workers & Pages, select the Worker, then open
     Settings > Triggers > Cron Triggers to confirm it exists.
   - Cron trigger changes can take up to 15 minutes to propagate.

7. Add the custom domain:
   - Go to Workers & Pages.
   - Select the Worker.
   - Go to Settings > Domains & Routes > Add > Custom Domain.
   - Enter `status.securityexcellence.net`.
   - Select Add Custom Domain.
   - Cloudflare should create the DNS record and certificate for the custom
     domain.

8. Smoke test after an approved deployment:
   - Open `https://status.securityexcellence.net`.
   - Check `https://status.securityexcellence.net/api/health`.
   - Check `https://status.securityexcellence.net/api/status`.
   - In the Worker dashboard, use Settings > Trigger Events > View events to
     confirm scheduled invocations after the cron has had time to run.

Cloudflare references:

- Workers dashboard setup: https://developers.cloudflare.com/workers/get-started/dashboard/
- Workers KV setup and bindings: https://developers.cloudflare.com/kv/get-started/
- Workers static assets: https://developers.cloudflare.com/workers/static-assets/
- Cron triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Worker custom domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
