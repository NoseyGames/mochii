# Monkeh

Monkeh runs its app and browser proxy on separate origins from one Node process.
The app owns your settings and userscripts; remote pages run on the isolated
proxy origin and communicate with the browser tools through a limited message bridge.

## Run locally

Use Node.js 22.12 or later and pnpm 11.19.0:

```sh
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm start
```

Open http://localhost:3000/math.html for the app. The original landing page and
popup launcher remain available at http://localhost:3000/.

`HOST` defaults to `127.0.0.1`. The app listens on `PORT` (default `3000`), and
its isolated proxy listens on `PROXY_PORT` (default `PORT + 1`). Both ports must
be available. The default proxy origin is `http://127.0.0.1:3001`.
`.env.example` documents configuration; set it in your shell/hosting environment
or use Node's `--env-file` option. The server does not load `.env` automatically.

## Verify

```sh
pnpm check
pnpm test
```

The checks parse JavaScript files and inline scripts/handlers, validate the
actual bundled transport WASM, and exercise HTTP routes and Wisp WebSocket
handshakes. External game catalogs, movie providers, fonts, Ruffle, JSZip, and
CodeMirror still depend on their upstream services and network access.
Voxiles ZIP loading currently supports self-contained entry files; archives
whose entry file needs companion assets are not fully supported.

## Browser tools

Open a page with the search box, then click **Tools** in the viewer header.
The dock stays with the browser, resizes by dragging its upper edge (or using
arrow keys on the resize handle), and remains available in fullscreen.

- **Console:** captured page logs, errors and rejected promises; message filters,
  a preserve-log option, JavaScript execution, and command history. Enter runs a
  command; Shift+Enter inserts a line. Promise results are awaited. `$0` refers
  to the element selected by the inspector.
- **Inspect:** pick an element on the page, browse its DOM tree, or find it by
  CSS selector. Inspect attributes and computed styles, then apply inline CSS.
  Escape cancels picking; a reload clears temporary edits.
- **Userscripts:** create, edit, save, delete, and run plain JavaScript directly
  in the dock. Scripts are stored in this browser, with automatic execution
  disabled by default. Automatic execution is paused on isolated remote pages:
  a remote page cannot request saved script source by claiming another URL.
  Use **Run** to execute the current draft deliberately. Match patterns support HTTP(S) URLs, `*`, leading wildcard subdomains,
  and comma-separated alternatives. Ctrl/Cmd+S saves; Ctrl/Cmd+Enter runs the
  draft. An async function scope supports `await` and repeated executions.

The tools inspect isolated proxy documents. Tools are disabled for shell-origin
apps and opaque catalog frames. Proxy destinations are decoded for display. Console capture begins when the page
finishes loading; earlier startup messages and nested cross-origin frames are
not captured. Direct cross-origin pages cannot be inspected; open them through
the proxy search. These are embedded page tools, not the browser's native
DevTools, and do not provide extension APIs such as `GM_*`.

## Frontend/backend connection

- `/api/health` reports availability, and `/api/config` supplies the isolated
  origin, server list, optional Windows gateway, and authentication requirement.
- `/wisp/` handles the proxy transport. The client checks a valid Wisp greeting
  before activating Epoxy, rather than accepting any WebSocket connection.
- `/bearmux/` and `/bearmux/epoxy/` serve the pinned installed packages.
- On the proxy origin, `/proxy-host.html` owns BareMux, the service worker, and
  the viewed document. `/sw.js` handles `/service/` only on that origin.
- The app never evaluates viewed-page JavaScript in its own realm. Console values,
  inspector snapshots and network events crossing the bridge are untrusted data.
- Proxy assets cannot serve the app, editor, userscript store or shell controller.

The legacy files in `bearmux/` are retained as source history; installed packages
are served at those URLs. Epoxy 3 uses a different transport API and is not a
drop-in upgrade for this Ultraviolet/BareMux setup.

## Failover

Set `WISP_BACKUPS_JSON` to an array of up to ten `{ "name": "…", "url": "wss://…/" }`
objects. The primary server plus ten backups are supported; duplicate URLs are
removed. Remote endpoints require `wss://`; `ws://` is accepted only for localhost.
Settings shows the actual configured count. An empty list means one server.

The client rotates through available servers on startup failure, checks the
active endpoint every 30 seconds, and switches after two failed health checks.
It also checks backend health after a proxy error page, pauses offline, resumes
online, and retries unavailable endpoints with bounded cooldown. A site-specific
HTTP error alone does not trigger failover. Transport changes cannot preserve
existing TCP/WebSocket sessions. A notice offers a manual reload so forms and
uploads are not silently replayed.

**Ten live public backup servers are not included.** The public endpoints
researched did not establish ten usable services with appropriate operator terms.
[Mercury's demo operator](https://wisp.mercurywork.shop/) explicitly asks that its
server not be used for public-facing sites. Supply endpoints you operate or that
an operator offers for your intended use. Backups have their own privacy and
network policies; the local server's destination restrictions do not govern them.

## Windows desktops

**Apps → Desktop Lab** launches the official v86 Windows 2000 or Windows 98
browser emulator through Monkeh. These historic guest systems need no account.
They are not modern Windows cloud VMs. Save the guest state before leaving;
changes are not automatically persisted. Guest networking is off by default and
is separate from the proxy used to load the emulator website. It is not claimed
to be routed through Monkeh.

For an existing hosted Windows machine, `WINDOWS_VM_URL` and `WINDOWS_VM_NAME`
add a launcher for an HTTPS gateway such as Apache Guacamole. This does not
provision a VM, generate third-party accounts, or bypass a provider's login.
Microsoft Windows App requires a signed-in account with an assigned resource.
Compatibility of external gateways depends on their authentication and embedding
requirements and must be tested with the actual provider.

Sources: [v86](https://copy.sh/v86/),
[Microsoft Windows App](https://learn.microsoft.com/en-us/windows-app/get-started-connect-devices-desktops-apps),
[Guacamole reverse proxy setup](https://guacamole.apache.org/doc/gug/reverse-proxy.html).

## Hosting and access control

Run `pnpm install --frozen-lockfile --prod --ignore-scripts`, then `pnpm start`.
Public binding requires distinct HTTPS `PUBLIC_ORIGIN` and `PROXY_ORIGIN` values.
Route the former to `PORT` and the latter to `PROXY_PORT`, preserving Host headers
and forwarding WebSocket upgrades on `/wisp/`. Prefer a separate registrable domain
for the proxy and never share app authentication cookies or secrets with it.

The default loopback bind is local-only. To bind publicly, set a private
`PROXY_AUTH_TOKEN` (at least 16 characters), or deliberately set
`ALLOW_PUBLIC_PROXY=true`. The token is HTTP Basic authentication, with username
`monkeh` unless `PROXY_AUTH_USER` is set. Use HTTPS. Both origins need authentication;
some browsers block an initial Basic prompt in an iframe. In Settings, use
**Sign in to the proxy connection** to authenticate that origin directly, then retry.
The token is never placed in the public configuration or URL.

The gateway blocks direct IP and private/loopback DNS destinations, pins validated
DNS addresses, restricts destination ports, validates packet structure, and limits
connections, streams, buffers and timeouts. Default limits include 64 WebSockets
(16 per IP), 64 streams per connection, 16 per destination host, and 1024 total
streams. Wisp messages are capped at 8 MiB, incoming buffers at 16 MiB per client
and 64 MiB total, outgoing buffers at 2 MiB, and idle TCP streams at two minutes.
Large plain-HTTP uploads over the message limit can fail; HTTPS usually fragments
its records. These are abuse mitigations, not a guarantee against resource exhaustion.

GitHub Pages cannot run this Node/WebSocket backend. GitHub stores the code; a
working deployment needs both origins and the Node process. See
[SECURITY-AUDIT.md](SECURITY-AUDIT.md) for scope, verification and remaining limits.

## Third-party assets

Ultraviolet and legacy transport bundles came with this repository. The server
uses unmodified npm transport packages with their included license metadata.
`apps/auk.js` is adapted from the controller previously loaded by `apps/auk.html`
at `https://cdn.jsdelivr.net/gh/Consessions/flyflix@main/auxscript.js`.
