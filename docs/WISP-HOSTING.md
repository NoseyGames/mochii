# Wisp endpoints and hosting verification

Endpoint snapshot checked October 3, 2026 (Pacific time); configuration updated October 6. The site owner supplied 28 unique addresses and explicitly confirmed permission to use all of them in production, including Mercury. All are configured with their exact paths. The original Anura `/wisp/` alias remains, for 29 external endpoint URLs; aliases are not separate servers. Capacity is 32 URLs. The owned Cloudflare Wisp endpoint has been removed.

## Endpoint evidence

Each URL below received one bounded Wisp-handshake probe with a five-second deadline, the production proxy Origin, and TLS certificate validation enabled. No destination TCP stream was opened by this check. Seven remaining configured URLs completed Wisp negotiation, including both Anura aliases. Mercury responded first in this snapshot. Results vary with location, load, and time; a successful handshake does not guarantee all websites will work.

Every eligible public endpoint is raced concurrently at connection time, and the first valid greeting whose transport activates is selected. Failed, timed-out, malformed, or non-Wisp responses are skipped. Remaining probes close after selection. Failure cooldown and bounded automatic retry prevent tight reconnect loops. There is no owned Cloudflare fallback. Availability checks do not automatically replay forms or reload pages.

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

## Retired Cloudflare relay

The owned Cloudflare Wisp adapter, its dedicated configuration and its protocol tests have been removed. `workers/app.mjs` returns an immediate HTTP 410 for `/wisp` and `/wisp/*`, including WebSocket upgrade requests. These paths remain in `run_worker_first` so obsolete clients receive the retirement response instead of static content. The Wisp-specific environment variables and rate-limit bindings are removed.

Keep the shared Cloudflare Worker deployed: it still serves the isolated browser assets and the coding-help and music APIs. Removing that Worker would break the browser host and those features. The optional local Node gateway uses its independent `server-wisp.mjs` and `server-network.mjs`; it does not import the removed Worker adapter.

## Validation

`node --test test/worker-app.test.mjs test/static-config.test.mjs` verifies retired-route rejection, preservation of static/AI/music routing, and the external-only production endpoint list. The existing `Check` GitHub Actions workflow runs these tests through `pnpm test`. The removal itself does not recheck external endpoint availability; the table above remains the dated October 3 snapshot.
