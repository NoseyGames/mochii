# Monkeh

Monkeh is a static app with an isolated browser proxy. Cloudflare serves HTML,
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
  static assets. No Worker backend or paid container is required.
- App: https://testingproductionubgdontgo.pages.dev/math.html
- Isolated proxy host: https://monkeh.1234-imwatchingyouopenthedoor.workers.dev

The same static output goes to both hosts. Shell entry pages on the proxy host
redirect to the app so settings and saved scripts stay on the app origin.
The proxy bridge accepts only the configured shell origin. Preview deployments
redirect shell entries to production; unknown mirrors cannot enable the proxy.
When moving hosts, edit both origins in `browser-tools/config.js` and deploy both.

For a local static preview, serve dist on **localhost:4173 and localhost:4174**
with any static HTTP server. Open http://localhost:4173/math.html. Both ports are
required for isolation; the public server still needs an internet connection.

## Servers and failover

Edit `deployment.wispEndpoints` in `browser-tools/config.js`. It contains the
original Anura endpoint, `wss://anura.pro/wisp/`. The old Lunar hostname no longer
resolved during verification and is excluded. Only include servers offered for
public use or which you control; do not add arbitrary endpoints just to fill slots.

The client supports a primary plus ten backups, validates a Wisp greeting,
serializes transport changes, checks availability every 30 seconds and switches
after two failures. **Retry** immediately rechecks the connection. It pauses
while offline and resumes when the network returns. Switching connections cannot
preserve TCP sessions; reload is manual so forms and uploads are not replayed.

One working endpoint is bundled, so there is currently no independent live
backup. Public operators can impose limits, block destinations or stop service.
Their policies govern outgoing traffic; the optional Node gateway's restrictions
do not apply to those servers. The proxy host must be reachable as well as the
server. The list is public code and must never contain credentials.

## Browser tools

Open a page, then select **Tools**. The dock resizes and works in fullscreen.

- **Console:** captured logs/errors, filters, command history, preserve log,
  awaited JavaScript evaluation and `$0` for the inspected element.
- **Inspect:** pick an element, browse the DOM, search with CSS selectors, inspect
  attributes/computed styles and apply temporary inline CSS.
- **Userscripts:** create, edit, save and manually run JavaScript. Ctrl/Cmd+S
  saves; Ctrl/Cmd+Enter runs. Saved scripts stay in this browser. Automatic
  execution on remote pages is paused to prevent pages obtaining saved source
  by claiming another URL. No `GM_*` extension APIs are provided.

Tools operate on proxied pages, not shell apps or opaque catalog frames. Capture
starts after page load, so early startup logs and nested cross-origin frames
are not included. These are embedded page tools, not native browser DevTools.

## Apps and current limits

Auk, Voxiles, Desktop Lab and the browser tools are static. Remote catalogs,
fonts, movie providers, Ruffle, JSZip and CodeMirror depend on their upstreams.
Voxiles ZIP imports support self-contained entry files; companion-asset archives
are not fully supported. Provider outages and sites that resist proxy rewriting
cannot be eliminated by static hosting.

Desktop Lab launches the official v86 Windows 2000/98 browser emulators through
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
