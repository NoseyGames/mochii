# Wisp endpoints and hosting verification

Checked October 3, 2026 (Pacific time). The site owner supplied 28 unique addresses and explicitly confirmed permission to use all of them in production, including Mercury. All are configured with their exact paths. The original Anura `/wisp/` alias and owned Worker remain, for 30 configured URLs; aliases are not separate servers. Capacity is 32 URLs.

## Endpoint evidence

Each URL below received one bounded Wisp-handshake probe with a five-second deadline, the production proxy Origin, and TLS certificate validation enabled. No destination TCP stream was opened by this check. Eight configured URLs completed Wisp negotiation, including both Anura aliases and the owned Worker. Mercury responded first in this snapshot. Results vary with location, load, and time; a successful handshake does not guarantee all websites will work.

Every eligible public endpoint is raced concurrently at connection time, and the first valid greeting whose transport activates is selected. Failed, timed-out, malformed, or non-Wisp responses are skipped. Remaining probes close after selection. Failure cooldown and bounded automatic retry prevent tight reconnect loops. The Worker is fallback-only because of its destination restrictions. Availability checks do not automatically replay forms or reload pages.

| Exact endpoint | Snapshot result | Elapsed |
| --- | --- | --- |
| `wss://wisp.mercurywork.shop/` | Valid Wisp v1 | 321 ms |
| `wss://glseries.net/wisp/` | Timed out; skipped | 5001 ms |
| `wss://wispserver.dev/wisp` | DNS unavailable; skipped | 131 ms |
| `wss://seminar.drama.english.assignment.literature.homebrewer.org/wisp/` | Timed out; skipped | 5015 ms |
| `wss://admin.proxy.hydrovolter.com/scramjet/wisp/` | Valid Wisp v1 | 644 ms |
| `wss://scram.owoellen.rocks/wisp/` | DNS unavailable; skipped | 294 ms |
| `wss://math.americahistory.online/wisp/` | HTTP 200 instead of WebSocket; skipped | 565 ms |
| `wss://lichology.com/wisp/` | Valid Wisp v1 | 555 ms |
| `wss://mages.io/wisp/` | Valid Wisp v1 | 642 ms |
| `wss://onlinegames.ro/wisp/` | HTTP 200 instead of WebSocket; skipped | 616 ms |
| `wss://wisp.rhw.one/ws/` | TLS failed; skipped | 624 ms |
| `wss://wisp-server.com/wisp/` | DNS unavailable; skipped | 553 ms |
| `wss://wisp.classroom.lat/` | DNS unavailable; skipped | 582 ms |
| `wss://radiusproxy.app/wisp/` | DNS unavailable; skipped | 612 ms |
| `wss://anura.pro/` | Valid Wisp v1 | 831 ms |
| `wss://phantom.lol/wisp/` | Valid Wisp v1 | 843 ms |
| `wss://geometry.axiseducation.one/` | HTTP 301 instead of WebSocket; skipped | 853 ms |
| `wss://onlineosdev.nl/` | DNS unavailable; skipped | 779 ms |
| `wss://webmath.help/wisp/` | DNS unavailable; skipped | 820 ms |
| `wss://explorechemistry.online/wisp/` | HTTP 200 instead of WebSocket; skipped | 1092 ms |
| `wss://quantumchemistry.club/wisp/` | HTTP 200 instead of WebSocket; skipped | 1148 ms |
| `wss://henhouse.social/relay` | DNS unavailable; skipped | 961 ms |
| `wss://dragon-orange.exe.xyz/` | No valid Wisp greeting; skipped | 1305 ms |
| `wss://strfry.ymir.cloud/` | Timed out; skipped | 5004 ms |
| `wss://antiprimal.net/` | DNS unavailable; skipped | 1089 ms |
| `wss://nostr.me/relay` | Timed out; skipped | 5004 ms |
| `wss://relay.crostr.com/` | Timed out; skipped | 5004 ms |
| `wss://wisp.solife.me/` | Timed out; skipped | 5004 ms |
| `wss://anura.pro/wisp/` | Valid Wisp v1 | 1414 ms |
| `wss://monkeh.1234-imwatchingyouopenthedoor.workers.dev/wisp/` | Valid Wisp v1 | 1377 ms |

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

Cloudflare explicitly [blocks outbound TCP to Cloudflare IP ranges](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations). This excludes many websites, including example.com at the time of testing. It cannot be worked around by relabeling the destination or replacing a TCP stream with `fetch()`. The owned Worker therefore remains a limited fallback after the public endpoint race. The [Workers limits documentation](https://developers.cloudflare.com/workers/platform/limits/) also lists free-plan subrequest and CPU limits. Production HTTP and certificate-validated HTTPS checks passed on October 3; these checks do not prove unlimited capacity or availability.

The adapter uses the documented [WebSocketPair API](https://developers.cloudflare.com/workers/runtime-apis/websockets/) and [outbound TCP API](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/). It is an independent implementation, not the Mercury Worker demo intended only for small API clients.

## Validation and GitHub Actions

`node --test test/worker-wisp.test.mjs` exercises destination validation, DNS pinning, strict origins, v1/v2 negotiation, TCP forwarding, malformed messages, cancellation during DNS, flow control, frame/input/transfer limits, stream limits, and cleanup. The existing `Check` GitHub Actions workflow runs this test through `pnpm test`, so no persistent public runner is needed.

Wrangler 4.147.0 successfully bundled the isolated adapter with `deploy --dry-run`. The isolated configuration at `workers/wisp/wrangler.jsonc` is for loopback testing on port 8788; it is not a second production deployment. Local native runtime checks established v1/v2 WebSockets, rejected private destinations and port 22, and transferred real HTTP and HTTPS data.

[GitHub's current Actions terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions) prohibit treating Actions as a persistent serverless hosting service. Actions remains appropriate for bounded build and protocol tests. The repository does not set up a public Wisp tunnel, runner keepalive, repeated hosting jobs, or generated third-party accounts.
