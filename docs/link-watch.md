# Mirror discovery notifications

`workers/link-watch.mjs` is a separate Cloudflare Worker. A browser visiting a Monkeh mirror reports that page's own origin to `POST /report`. The Worker verifies the mirror's marker, stores the origin in a SQLite Durable Object, and queues a Discord notification. It does not crawl websites, expose a list of mirrors, or accept a public test-send request.

The default Worker name is `monkeh-link-watch`. Its independent configuration is `wrangler.link-watch.jsonc`; deploying the main app does not deploy this Worker.

## Configure and deploy

1. Review `ALLOWED_HOST_SUFFIXES` and `ALLOWED_CUSTOM_HOSTS` in `wrangler.link-watch.jsonc`. Suffixes allow subdomains only. Custom hosts are exact hostnames, separated by commas. The defaults allow `pages.dev`, `workers.dev`, `netlify.app`, `vercel.app`, `onrender.com`, and `github.io`. A private mirror domain is not included automatically.
2. Deploy with `npx wrangler deploy --config wrangler.link-watch.jsonc`. The `v1` migration creates the SQLite Durable Object namespace. Keep that namespace, the `MirrorLedger` class, and the object name `monkeh-mirrors-v1` for future deployments.
3. Set the secret using `npx wrangler secret put DISCORD_WEBHOOK_URL --config wrangler.link-watch.jsonc`. Enter the webhook URL at the secret prompt. Do not put it in a file, browser script, public environment variable, commit, or command argument. Accepted URLs use `https://discord.com/api/webhooks/<id>/<token>` or the `/api/v10/webhooks/` equivalent, without a query or fragment.
4. Set the app's mirror-report endpoint to the deployed Worker's `/report` URL and redeploy the app. Serve `/monkeh-mirror.json` with `Content-Type: application/json` and this body:

```json
{"project":"NoseyGames/monkeh","version":1}
```

5. Open `/health` on the Worker. It reports readiness, configuration flags, and delivery counts, without URLs or secrets. `ready: true` means a valid webhook secret and the ledger are configured and the webhook has not been blocked by a known authentication/not-found response. It does not confirm that Discord has accepted a message.

Setting the secret enables delivery for subsequent accepted reports. There is no deployment or live delivery in the automated tests. Follow the repository's shipping approval process before deploying or sending a notification.

## Request and response contract

The client sends JSON `{"origin":"https://your-mirror.pages.dev"}` with a matching browser `Origin` header and `Content-Type: application/json`. The endpoint accepts canonical HTTPS origins only: no path, trailing slash, credentials, port, IP literal, or local/reserved hostname. Its exact CORS origin is the validated incoming origin; credentialed CORS is not enabled.

| Response | Meaning | Browser behavior |
| --- | --- | --- |
| `202 queued` | Marker verified and notification durably queued | Remember this origin was accepted |
| `200 already_known` | Origin already has a permanent ledger entry | Remember this origin was accepted |
| `409 verifying` or `verification_expired` | Another verification owns the lease, or this lease expired | Try again on a later visit |
| `422 unverified` | Marker could not be verified | Try again on a later visit |
| `429 rate_limited` | A verification, discovery, queue, or request cap was reached | Respect `Retry-After`; try again later |
| `503 not_configured` or `temporarily_unavailable` | Secret, binding, webhook, or storage is unavailable | Try again on a later visit |
| `400`, `403`, `415` | Invalid body, origin, or content type | Correct the client/configuration |

The client should save a permanent acknowledgement only after `200` or `202`. With no valid webhook secret, `POST /report` returns `503` before verification or queueing. A known entry can be `queued`, `sending`, `delivered`, `failed`, or `uncertain`; a repeat report never creates another notification for it.

## Verification and limits

Verification fetches only `<origin>/monkeh-mirror.json`, rejects redirects, requires JSON, limits the body to 2 KiB, and allows five seconds for the complete response. Invalid markers are cached for five minutes. Verification is a marker check, not proof that the mirror is operated or endorsed by the repository owner: an allowed host's operator can publish the same public marker.

The durable ledger enforces global limits of 60 reports per minute, six validations per minute, 120 validations per day, ten newly accepted mirrors per hour, 50 per day, 100 pending deliveries, and 30 webhook attempts per hour. Fixed time windows can permit bursts around their boundaries. A separate Cloudflare rate-limit binding reduces incoming report load; the ledger remains the global authority. These caps bound accepted work, not all billable requests from an arbitrary attack.

Only the verified origin is included in Discord's message. Mentions and link embeds are disabled. Marker contents, page titles, visitor data, and the webhook secret are never included. Observability logging is disabled in this configuration; the code does not log secrets or mirror URLs.

## Deduplication and delivery failures

The origin is the ledger's primary key. Atomic reservations prevent simultaneous visits from verifying and queueing the same origin twice. Entries, including delivered entries, are retained without an expiry. Deduplication survives ordinary Worker restarts and redeployments while the same Durable Object storage is preserved. Deleting/replacing the namespace, changing the object name, or restoring an older database can discard that history. Each different origin is a different mirror; paths on the same origin are not separate mirrors.

The Worker asks Discord for confirmation using `wait=true` and records delivery only after a successful response containing a message ID. Only received `429` rate-limit rejections are retried: they honor the supplied delay, use exponential backoff, and pause other sends. These retries have a maximum of eight total attempts. Permanent rejection stops that entry; `401`, `403`, or `404` pauses the entire queue until a different valid webhook secret is configured. A subsequent report or health request resumes existing queued work after secret rotation.

Discord does not expose an idempotency key for this endpoint. Therefore exactly-once delivery cannot be guaranteed across network failures or server failures. A `5xx` server error, timeout, lost/unreadable success response, or interrupted in-flight delivery becomes `uncertain` and is not automatically resent. A server error can occur after Discord has created the message. Holding these outcomes avoids automatic duplicates after ambiguous results but can leave a notification unsent. Do not promise both zero duplicates and guaranteed delivery under every failure.

Review `failed` and `uncertain` counts through `/health`; an administrator can inspect the ledger privately with Cloudflare's Durable Object database tools. Review Discord before any manual recovery of an uncertain row. There is no public retry or ledger-edit endpoint. Do not delete delivered rows to clear an alert.

## Validation

Run `node --test test/link-watch.test.mjs` and `node --check workers/link-watch.mjs`. Tests use real in-memory SQLite with mocked Cloudflare storage/alarm APIs and mocked HTTP responses; they never contact Discord. They cover malformed origins, marker validation, exact CORS, concurrent repeats, restart/history persistence, request and queue limits, retry backoff, webhook rotation, permanent failures, and unknown outcomes.

The Wrangler dry-run build and local workerd runtime checks also pass. Local checks exercised real Durable Object SQLite transactions through health requests, configuration readiness, missing-secret rejection, and mismatched-origin rejection. The configured check used an obviously fake webhook and queued no reports. Actual Discord delivery and the target Cloudflare account still need deployment validation after authorization.

The design follows Cloudflare's [SQLite Durable Object storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) and [alarm semantics](https://developers.cloudflare.com/durable-objects/api/alarms/), including at-least-once alarm execution. Discord's [Execute Webhook contract](https://docs.discord.com/developers/resources/webhook#execute-webhook) describes confirmation and mention controls; its [rate-limit guidance](https://docs.discord.com/developers/topics/rate-limits) describes `Retry-After` and invalid webhook handling.
