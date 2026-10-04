# Wisp endpoints and hosting verification

Checked October 3, 2026 (Pacific time). Public endpoint availability is a snapshot, not an uptime guarantee. The application supports **15 total endpoint slots: one primary and fourteen backups**. The shipped list currently contains Anura and the separately implemented Monkeh Worker backup; it does not claim fifteen independent live servers.

## Endpoint evidence

| Endpoint | Publication/use evidence | Verification | Decision |
| --- | --- | --- | --- |
| `wss://anura.pro/wisp/` | Present in the original Monkeh archive. The [Anura project](https://github.com/MercuryWorkshop/anuraOS) identifies anura.pro as its hosted instance, and the operator's [Scramjet build workflow](https://github.com/MercuryWorkshop/scramjet/blob/main/.github/workflows/main.yml) configures Anura as its Wisp service. No Anura-specific restriction was found. | Valid Wisp CONTINUE, followed by an actual TCP HTTP request to example.com: `HTTP/1.1 200 OK`, Example Domain content, 930 bytes. | Primary. Root and `/wisp/` aliases are not counted as independent backups. |
| `wss://monkeh.1234-imwatchingyouopenthedoor.workers.dev/wisp/` | Owned Monkeh deployment, using `workers/wisp/index.mjs`. | Local native Workers runtime: v1 HTTP and v2 HTTP/HTTPS through www.google.com returned 200. HTTPS certificate validation stayed enabled. Cloud deployment must be checked after publishing. | Limited backup, integrated with the same deployment that serves the isolated proxy assets. |
| `wss://lunarrr.eminescusm.ro/w/` | Second endpoint in original Monkeh archive. | DNS `ENOTFOUND`. | Excluded. |
| `wss://wispserver.dev/wisp/` | [Operator homepage](https://wispserver.dev/) advertises a free service allowed in production. Its adblocking path uses the same host and is not a separate server. | DNS `ENOTFOUND`, also outside the local network sandbox. | Excluded while unavailable. |
| `wss://glseries.net/wisp/` | Publicly listed by a third-party client. [Operator profile](https://github.com/Endlessguyin) links glseries.net and its [Wisp deployment repository](https://github.com/Endlessguyin/scramjet). | One Wisp connection attempt timed out during WebSocket handshake after seven seconds. | Excluded. |
| `wss://incog.works/wisp/` | Publicly listed by a third-party client. The [Incognito repository](https://github.com/titaniumnetwork-dev/Incognito) links the operator's incog.works site. | DNS `ENOTFOUND`. | Excluded. |

The Mercury demo endpoint with a known restriction against production/public-facing use was deliberately neither queried nor configured. The [AnyProxy operator description](https://anyproxy.site/blog/wisp-protocol/) requires a live session, so its endpoint is not an anonymous backup. Illustrative `example`/documentation URLs and aliases are not counted as working services. These checks found no additional usable, unrestricted operator-published service to add honestly.

## Native Cloudflare Worker backup

`handleWisp(request, env)` in `workers/wisp/index.mjs` handles `/wisp/`. The app shell stays on its separate Pages origin. The Worker handles only Wisp TCP on ports 80/443; it does not run the Node server or expose the repository filesystem.

Required configuration:

```json
{
  "ENABLE_WISP": "true",
  "WISP_ALLOWED_ORIGINS": "[\"https://monkeh.1234-imwatchingyouopenthedoor.workers.dev\"]"
}
```

The origin list is a browser cross-origin restriction, not a secret or account authentication. The relay is intentionally reachable by this public application's users. Disable it with `ENABLE_WISP=false` if public access is no longer intended.

The `WISP_RATE` binding permits twelve upgrade attempts per IP per minute; `WISP_GLOBAL_RATE` permits 120 per minute with a shared key. Missing/failing bindings or missing Cloudflare client-IP metadata fail closed. Throttled requests receive HTTP 429 with Retry-After. Cloudflare rate-limit bindings are location-scoped and approximate, so the shared key is not an account-wide exact spending cap.

The implementation validates hostnames and checks a fixed DNS-over-HTTPS resolver's answer with `ipaddr.js`, then connects to the validated literal address. It rejects loopback/private/link-local/special addresses, IP literals supplied as hostnames, UDP, and non-web ports. Pending DNS and TCP work is canceled when its stream closes. It supports Wisp v1 and v2 framing with bounded flow control.

Per WebSocket session, limits are four concurrent streams, twenty total stream openings, a one MiB frame, two MiB pending input, sixteen MiB transferred data, a ten-second connection deadline, and a five-minute lifetime. The total stream cap also bounds DNS/TCP operations. These are deliberate application limits, not claims about Cloudflare's maximum service capacity.

Cloudflare explicitly [blocks outbound TCP to Cloudflare IP ranges](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations). This excludes many websites, including example.com at the time of testing. It cannot be worked around by relabeling the destination or replacing a TCP stream with `fetch()`. The owned Worker therefore remains a limited fallback; Anura is the general-purpose primary. The [Workers limits documentation](https://developers.cloudflare.com/workers/platform/limits/) also lists free-plan subrequest and CPU limits. Local success does not prove unlimited capacity or production availability.

The adapter uses the documented [WebSocketPair API](https://developers.cloudflare.com/workers/runtime-apis/websockets/) and [outbound TCP API](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/). It is an independent implementation, not the Mercury Worker demo intended only for small API clients.

## Validation and GitHub Actions

`node --test test/worker-wisp.test.mjs` exercises destination validation, DNS pinning, strict origins, v1/v2 negotiation, TCP forwarding, malformed messages, cancellation during DNS, flow control, frame/input/transfer limits, stream limits, and cleanup. The existing `Check` GitHub Actions workflow runs this test through `pnpm test`, so no persistent public runner is needed.

Wrangler 4.147.0 successfully bundled the isolated adapter with `deploy --dry-run`. The isolated configuration at `workers/wisp/wrangler.jsonc` is for loopback testing on port 8788; it is not a second production deployment. Local native runtime checks established v1/v2 WebSockets, rejected private destinations and port 22, and transferred real HTTP and HTTPS data.

[GitHub's current Actions terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions) prohibit treating Actions as a persistent serverless hosting service. Actions remains appropriate for bounded build and protocol tests. The repository does not set up a public Wisp tunnel, runner keepalive, repeated hosting jobs, or generated third-party accounts.
