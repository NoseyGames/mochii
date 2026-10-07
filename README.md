# mochii

mochii is a static app with an isolated browser proxy. Cloudflare serves HTML,
JavaScript and assets; the browser connects directly to the public Wisp server
list in `browser-tools/config.js`. Static hosting does not request `/api/config`
or require a Node backend.

## Static deployment

```sh
pnpm install --frozen-lockfile
pnpm build
```

Publish **dist/**, not the repository root. The build copies the exact pinned
BareMux and Epoxy packages, adds a real 404 page, and excludes server code, tests,
local configuration and dependency metadata. `pnpm-workspace.yaml` disables the
optional bufferutil native build so pnpm 11's strict install succeeds.

- Cloudflare Pages: build command `pnpm build`, output directory `dist`.
- Cloudflare Worker: `npx wrangler deploy`; `wrangler.jsonc` builds and uploads
  static assets plus the coding-help and music routes. No paid container is required.
- App: https://testingproductionubgdontgo.pages.dev/math.html
- Isolated proxy host: https://monkeh.1234-imwatchingyouopenthedoor.workers.dev

The same static output goes to the shell hosts and the isolated proxy host.
Shell entry pages on the proxy host redirect to the primary app. Approved
mirrors retain their own address; settings and saved scripts stay on that
mirror's origin. The bridge accepts only the exact configured shell origins.
Known Pages previews redirect to production; unknown mirrors cannot enable the
proxy. When adding a host, update `shellOrigins` in `browser-tools/config.js`
and the Worker's `ASSIST_ALLOWED_ORIGINS`, then deploy the app and Worker.

For a local static preview, serve dist on **localhost:4173 and localhost:4174**
with any static HTTP server. Open http://localhost:4173/math.html. Both ports are
required for isolation; the public server still needs an internet connection.

## Servers and failover

Edit `deployment.wispEndpoints` in `browser-tools/config.js`. The list includes
all 28 unique addresses supplied by the site owner with production-use permission,
and the original Anura `/wisp/` path: 29 external endpoint URLs in total.
Exact endpoint paths are retained; a Wisp address does not need a trailing slash.

The client supports 32 addresses and races eligible public endpoints concurrently.
The first valid Wisp greeting whose transport activates wins; failed, timed-out,
and non-Wisp connections are skipped. Unused probes are closed immediately.
The retired Monkeh Wisp endpoint is not in the pool. Transport changes are serialized.
The client checks availability every 30 seconds and switches after two failures.
**Retry** immediately races the connection again. It pauses
while offline and resumes when the network returns. Switching connections cannot
preserve TCP sessions; reload is manual so forms and uploads are not replayed.

Configured addresses are candidates, not a promise that every
server is currently online or compatible. Public operators can impose limits,
block destinations or stop service. See `docs/WISP-HOSTING.md` for probe results.
Their policies govern outgoing traffic; the optional Node gateway's restrictions
do not apply to those servers. The proxy host must be reachable as well as the
server. The list is public code and must never contain credentials.

Pages render and accept input while resources are still loading. A small status
indicator replaces the full-page loading cover; a slow resource does not blank
the page or replay navigation. Navigations reuse the existing proxy host when
permissions allow. Console output stays bounded and avoids hidden DOM updates.

If an upstream connection ends with `tls handshake eof`, the error notice offers
**Switch server and reopen address**. It excludes that relay and opens the last
address entered in Monkeh as a fresh GET. The toolbar's **Switch proxy server**
changes the transport without reloading the page. Neither action automatically
replays submitted forms or disables certificate checks. A successful Wisp
handshake does not guarantee that a particular destination will accept TLS;
switching can recover from relay-specific failures but cannot prevent every
upstream outage or block.

See [hosting instructions](docs/HOSTING.md) for Cloudflare, Netlify, Vercel,
Render and other static-host options. Each approved mirror uses the same isolated
proxy host; additional shell addresses are not independent proxy backends.

## Browser tools

Open a page, then select **Tools**. The right dock resizes with a drag or arrow keys, closes with X, and works in fullscreen. Small screens stack the dock below the page.

- **Console:** captured logs/errors, filters, command history, preserve log,
  awaited JavaScript evaluation and `$0` for the inspected element.
- **Inspect:** pick an element, browse the DOM, search with CSS selectors, inspect
  attributes/computed styles, edit text and attributes, delete elements, undo up to 20 edits, and apply temporary inline CSS. Picking reveals the selected DOM row.
- **Userscripts:** create, edit, save and manually run JavaScript. Ctrl/Cmd+S
  saves; Ctrl/Cmd+Enter runs. Saved scripts stay in this browser. Automatic
  execution on remote pages is paused to prevent pages obtaining saved source
  by claiming another URL. No `GM_*` extension APIs are provided.

Tools operate on proxied pages, not shell apps or opaque catalog frames. Capture
starts when the page document becomes available, so early startup logs and nested cross-origin frames
are not included. These are embedded page tools, not native browser DevTools.

## Privacy and coding help

Settings control the search engine, HTTPS for entered addresses, popups, downloads,
catalog cover images, clearing console data on close, and access to coding help.
Popup and download permissions apply when the viewed frame is reopened or reloaded.
These are browser preferences, not anonymity or tracker-blocking guarantees.

**Tools → Help** sends only the question and optional code shown in its form to
Cloudflare Workers AI. Copying a userscript draft into the form is explicit;
page content, cookies, history, and saved scripts are never attached automatically.
Answers are plain text and never execute. No API key is shipped to browsers.

The Worker uses Qwen2.5 Coder with bounded input/output, request deadlines,
origin checks, and rate limits. Keep this account on **Workers Free**: its daily
10,000-neuron allowance stops inference when exhausted. A Paid account can bill
beyond that allowance; the per-location rate limiter is not a global spending cap.
Set `ENABLE_ASSIST=false` before changing to a paid account if billing is unwanted.
Missing bindings and exhausted quotas show a recoverable error. Plain static or
Node deployments without the Worker API can browse normally but have no AI help.

See [Wisp hosting notes](docs/WISP-HOSTING.md) for public-server verification
and the retired Cloudflare relay. The shared Worker still serves the isolated
browser assets, coding help and music; its obsolete `/wisp` routes return HTTP 410.

## Apps and current limits

Auk, Voxiles, Desktops, Mochii Cloud and the browser tools are static. Remote catalogs,
fonts, movie providers, Ruffle, JSZip and CodeMirror depend on their upstreams.
Voxiles ZIP imports support self-contained entry files; companion-asset archives
are not fully supported. Provider outages and sites that resist proxy rewriting
cannot be eliminated by static hosting.

**Apps → Mochii Cloud** opens the redesigned cloud-gaming catalog. Its 106
entries retain the upstream game metadata, search, details, themes, controller
navigation and launch options. Recent sessions and settings are stored locally
on each mirror. Monkeh does not create game accounts or verify a provider session.
Source provenance is recorded in [third-party sources](docs/THIRD-PARTY-SOURCES.md).

A temporary Figure adapter matches 94 catalog games to Figure's hosted launcher.
**Play with Figure** opens inside Mochii through Monkeh's isolated proxy host;
Figure manages account setup, notices, and queues in the player. The Mochii
catalog does not store Figure credentials or claim that a game is ready. Games
without a Figure match remain visible with playback unavailable. Streaming
protocols, proxy compatibility, and external service availability can prevent
playback; there is no direct-provider or new-tab fallback.

Setup includes a free temporary inbox using Maildrop's documented API. A random
address is generated locally for each new tab session and retained across reloads
for up to 24 hours. Opening Setup checks mail directly with Maildrop; polling
pauses when Setup or the page is hidden. Messages are displayed as text, without
executing email HTML or loading remote images. Anyone who knows the mailbox
address can read it through Maildrop, so it is unsuitable for passwords or
lasting account recovery. The inbox does not create third-party game accounts.

Desktops launches the official v86 Windows 2000/98 browser emulators through
Monkeh. These require no account, but are not modern Windows cloud VMs. Save the
guest state before leaving. Guest networking is disabled and is separate from
the proxy used to load the emulator page. `deployment.windowsVm` can be set to a
validated HTTPS gateway configuration for a machine you already have; the app
does not provision a VM or generate provider accounts.

## Optional Node hosting

`pnpm start` retains the self-hosted Node HTTP/Wisp gateway. Its config script
explicitly selects `/api/config`; static output never does. See `.env.example`
for settings. Node >=22.12 and pnpm 11.19 are required.

The app uses PORT (3000 by default), the isolated proxy PROXY_PORT (PORT + 1),
and HOST defaults to 127.0.0.1. Public hosting requires distinct HTTPS
PUBLIC_ORIGIN/PROXY_ORIGIN, WebSocket forwarding, and either PROXY_AUTH_TOKEN or
explicit ALLOW_PUBLIC_PROXY=true. Use separate authentication on both origins;
never share shell cookies with the proxy. WISP_BACKUPS_JSON configures Node-mode
backups; WINDOWS_VM_URL/WINDOWS_VM_NAME configure its optional gateway launcher.

The Node gateway validates public DNS addresses, pins connections, restricts
ports, authenticates HTTP/WebSockets and bounds streams, buffers and timeouts.
These protections do not turn a public third-party server into a trusted backend.

## Verification

```sh
pnpm check
pnpm test
pnpm build
```

Tests cover static configuration without API requests, origin isolation,
curated asset packaging, real transport WASM, failover, tools, apps and optional
Node security boundaries. See SECURITY-AUDIT.md for review scope and limits.

Ultraviolet came with this repository. The build uses unmodified pinned npm
BareMux/Epoxy distributions. `apps/auk.js` is adapted from the previously loaded
Consessions/flyflix controller. Sources: https://github.com/MercuryWorkshop/anura,
https://copy.sh/v86/ and https://guacamole.apache.org/.

## Library and appearance

Games combines the original catalog with the Tung Tung and Cherri libraries. Use source
filters, Favorites, Recently played, Random game, and paged results. The bundled
manifest keeps the catalog available when a source is down; cover images and
game launches still require their hosts. Refresh links with
`node scripts/update-game-catalog.mjs` before a normal build/deploy.

The current snapshot has 7,688 launch variants grouped into 3,082 title cards.
Normalized names are indexed once with Maps and Sets; source filters and search
reuse that index. Alternate providers remain selectable on each card. Sequels
and dotted version numbers remain distinct. Only public game links are included.

Music searches all five Cherri music sources concurrently, progressively merging
matching titles into one row. Select an alternate source or artist version in the
player. Favorites, volume, shuffle and repeat stay on this device. Only the selected
audio is streamed; opening the library does not preload songs. A bundled discovery
snapshot is refreshed by `node scripts/update-music-catalog.mjs`. Live search and
playback use the isolated Worker's bounded `/api/music/*` relay and depend on the
upstream music service. Configure `MUSIC_ALLOWED_ORIGINS` or the existing
`ASSIST_ALLOWED_ORIGINS`; `MUSIC_RATE` limits each visitor to 120 requests/minute.

Settings includes dark/light modes, six fonts, accent colors, backgrounds, tab
cloaking, a cloaked window, a panic shortcut, close protection, and animation
preferences. Settings and game lists stay in this browser. No ads, chat, or
cloud account synchronization is included.

Searchable settings sections include character masking, browser identity presets
and custom user agents, background opacity/blur, glass effects, and settings
export/import. The user agent applies to the selected proxy view's HTTP requests
and JavaScript navigator string; it does not emulate another engine or device.
Reload the viewed page after changing it. Snow, rain and bubbles are optional,
bounded effects that pause while browsing a page, while hidden, or when reduced
motion is enabled. Character masking changes shell labels only and preserves
readable accessibility labels and original search/catalog identities.

External game and app URLs use the isolated proxy automatically, including
Flyflix at `https://flyflix.net/`. A service-worker compatibility fallback also
routes escaped HTTP(S) requests from identified UV documents through UV. It
does not proxy WebRTC or guarantee compatibility with every site.

Native DevTools shortcuts redirect to `oops.html` by default. The optional
docked-panel heuristic can mistake browser side panels for DevTools and is off
by default. Undocked/menu-open DevTools and cross-origin iframe keyboard focus
cannot reliably be detected. This is a UI deterrent, not source-code protection;
Monkeh's own browser inspector remains available.
