# Security and reliability review

Reviewed 2026-10-02, updated for static hosting 2026-10-03. This is a source review
with targeted automated and browser checks, not a certification or a claim that
every possible bug was eliminated.

Static deployments now use a code-defined external Wisp list and two existing
origins, without API requests. The limited browser bridge and manual userscript
execution remain. Both hosts serve a curated static build; shell entry pages on
the proxy host redirect to the app. The Node-specific authentication, private
destination filtering and resource limits below apply only to optional Node
hosting, not third-party Wisp servers. Public server availability and destination
policies remain outside this project's control. Only one working public endpoint
is currently included; support for ten backups is not ten deployed servers.

## Findings addressed

| Area | Problem found | Change |
| --- | --- | --- |
| Browser isolation | Proxied scripts and cross-realm console wrappers could reach the app's origin | Separate proxy listener and origin; limited MessageChannel bridge; shell DOM and saved scripts stay on the app origin |
| Userscripts | A page could claim another destination and obtain automatically executed saved code | Remote automatic execution paused; only user-triggered draft execution is sent to the page |
| Bridge | Untrusted tree, log and metadata messages could overrun UI work or carry stale results | Bounded inert snapshots, cycle/depth checks, event limits, RPC deadlines, generation checks and exact handshake origin/source checks |
| Network access | Destination parsing and asynchronous DNS/close races could bypass stream lifecycle assumptions | Public-address validation and pinning, strict destination types/ports, pending DNS limits, cancelled-stream checks and duplicate-ID rejection |
| Wisp protocol | Unbounded payloads, queued data and connection counts; invalid control sequences | Bounded gateway, packet validation, flow control, idle/connect timeouts and global/per-client limits |
| Authentication | A public bind could silently create an unrestricted proxy | Local-only default; public bind requires explicit origins plus a token or deliberate opt-in; HTTP and WebSocket authentication |
| Request boundary | Host/origin confusion and private asset exposure | Host and WebSocket Origin checks, restricted static paths, realpath containment, private-file rejection and proxy-only asset allowlist |
| Startup/failover | A WebSocket opening was mistaken for a working Wisp server; retry races | Validate Wisp greeting, serialize real transport mutations, wait for worker control, retry with cooldown, pause offline, test primary plus ten backups |
| Catalogs | Unbounded remote input and external HTML running in the shell origin | Stream size/time limits, bounded records and opaque sandboxed remote documents; dynamic ad script injection removed |
| Auk | Malformed stored projects/settings and executable preview filename content | Validation and limits, safe preview title, opaque previews, preserve unreadable stored projects instead of silently overwriting |
| Vox | Unbounded file/ZIP/download inputs and unsafe JSON URLs | Streaming size limits, bounded ZIP decompression/library size, strict protocols, object URL cleanup and isolated Ruffle |
| Third-party scripts | Mutable provider scripts could execute in the app origin | Pinned CodeMirror/JSZip/Ruffle with integrity checks where applicable; pinned Flyflix code on the separate proxy origin, with sandboxed embedding |
| Compatibility | Tight WebSocket limit rejected a legitimate Epoxy upload | Real installed WASM upload/echo regression; bounded 8 MiB message limit supports the tested 5.5 MiB upload |

## Verification

- Final checks passed: 224 tests (0 failures) and 59 JavaScript/HTML script units
  parsed with the repository syntax checker.
- Automated tests exercise HTTP routes, auth, SSRF boundaries, DNS races,
  protocol errors, connection/queue caps, actual Epoxy WASM traffic, proxy-origin
  asset isolation, worker migration, failover, tools RPC and app input handling.
- `pnpm audit --json` reports zero advisories for the installed dependency graph.
  This checks published advisories, not all vulnerabilities. It does not audit
  remotely loaded application content or every vendored bundle.
- Browser checks verified a real HTTPS page through the isolated origin, console
  evaluation and log capture, inspector selection/styles, and manual userscripts.
- The browser test `console.log.constructor('return window.top.document.title')()`
  from the viewed page produced `SecurityError` rather than the shell's title.
- v86's official Windows 2000 demo booted without an account both directly and
  through Apps → Desktops → Launch Windows 2000 on the isolated Monkeh proxy.
- Vox opened and rejected an executable game URL. Auk loaded its editor and
  preserved saved code; Run Preview generated the expected sandboxed document.
  In the hidden in-app test browser its preview appeared blank despite containing
  the expected text; visual rendering of that preview remains unconfirmed.
- Flyflix initially failed with an opaque frame. Moving its pinned provider to
  the isolated origin restored its homepage, navigation and catalog in the browser.

Re-run `pnpm check` and `pnpm test` after changes.

## Limits and deployment requirements

1. **Remote websites still share one proxy origin.** The new boundary separates
   them from the app shell; it is not a complete browser-grade boundary between
   unrelated remote sites. Treat page-reported URLs/titles as untrusted. Avoid
   using this proxy for sensitive accounts or storing secrets on its origin.
2. **Fifteen independent public servers were not verified.** The pool now supports
   fifteen entries. Anura is the verified public primary; an owned Cloudflare
   Worker provides a restricted backup. Its native Wisp adapter passed local
   runtime HTTP/HTTPS and destination-denial checks. See docs/WISP-HOSTING.md
   for current endpoint results, deployment status, and Cloudflare limitations.
3. Health probes validate protocol availability. They do not guarantee that a
   server can reach every destination or that a website will load successfully.
   Switching transport can break existing streams; manual reload avoids silently
   replaying forms, uploads and desktop sessions.
4. Public hosting needs two distinct HTTPS origins and WebSocket forwarding.
   Prefer separate registrable domains and keep cookies/credentials off the proxy
   origin. Basic authentication may need an initial top-level sign-in on each
   origin. Restrict access and apply hosting-level resource controls as needed.
5. Wisp's 8 MiB message cap, two-minute idle TCP timeout and resource limits can
   reject very large uploads or long-idle connections. Limits reduce abuse; they
   do not make a public proxy immune to denial of service.
6. Catalog HTML and imported games run with opaque origins. Flyflix uses the
   separate proxy origin so its storage and routing can work. Some third-party
   apps requiring storage, same-origin APIs or particular embedding policies may
   fail. Sandboxing cannot reliably terminate an infinite script loop or bound
   every asset a third-party page chooses to load.
7. v86 Windows 2000/98 are historical emulators, not provisioned modern Windows
   cloud VMs. Save guest state before leaving. Guest networking is disabled by
   default and is not claimed to use Monkeh's proxy. Modern Windows hosting and
   provider accounts have not been provisioned.
8. Third-party catalogs, fonts, providers, emulator assets and CDNs remain
   external dependencies. No claim is made that every remote game/site is usable.


## Browser and Worker follow-up — 2026-10-03

- Inspector selection now carries a bounded ancestor tree without reordering DOM
  siblings. Text/attribute/deletion RPCs validate size, destination document and
  session generation. Undo retains at most twenty bounded edits inside the page.
- Repeated address navigation reuses only an existing authenticated-by-origin
  bridge to the exact configured proxy host. Changed sandbox permissions force a
  fresh outer frame; stale navigation replies cannot replace a newer page.
- Coding help accepts only explicit JSON question/code fields, caps request and
  response sizes, times out body reading/inference, rate-limits before reading,
  requires the exact shell origin, and returns no provider diagnostics. Model
  output renders as text and never executes. Browser sends a snapshot of the
  fields at Ask click, never implicit page/session context.
- Workers Free supplies the hard daily AI allowance. Rate limits are local to a
  Cloudflare location and are not a global billing cap. Changing the account to
  Paid can incur charges unless coding help is disabled first.
- Native Worker Wisp pins validated public DNS answers, restricts ports to 80/443,
  bounds frames/streams/queues/transfer/lifetime and handshake rates, and fails
  closed without required configuration. Origin restrictions do not authenticate
  non-browser clients. Cloudflare's TCP egress blocks Cloudflare destinations;
  this endpoint is a limited backup, not universal browsing infrastructure.

This is a source, automated-test and targeted runtime review, not a claim that
all possible issues or third-party failures have been eliminated.
