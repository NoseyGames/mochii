# Hosting Monkeh

Checked against provider documentation on 2026-10-04. The adapters in this
repository prepare deployments; they do not create accounts or guarantee that
an unclaimed hostname is available. Keep deployments on the free plan unless
the owner explicitly chooses an upgrade.

## Shared build and mirror requirements

Use Node 24.x (the project requires at least 22.12) and the pinned pnpm 11.19.0:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Publish only `dist/`. It contains the app and matching proxy vendor assets;
server code, tests, dependency metadata and local secrets are excluded. Keep
`pnpm-workspace.yaml`: it explicitly disables the optional bufferutil native
build while retaining pnpm's strict policy for other dependency scripts.

Each provider below can serve a complete **static mirror** over HTTPS at its
own origin. The mirror includes Ultraviolet, `/proxy-host.html`, `/sw.js` and
the matching transport assets. The browser uses the external Wisp server
selected from `browser-tools/config.js` for outgoing connections. Static
configuration has no `proxyOrigin` or `shellOrigins`; a new mirror needs no
origin allowlist entry or redirect to the primary site. A blocked shared
Worker hostname no longer disables the browser on another reachable mirror.

Static music search/API requests and selected audio also use the local proxy
runtime and selected Wisp server. Games and movies launch through that same
mirror. These deployments do not themselves run a Wisp server or the optional
Node backend. Upstream services and at least one compatible external Wisp
server must remain reachable. The retired Worker `/wisp` routes still return
HTTP 410.

Coding help is separate: it calls `/api/assist` on the current mirror. It works
only when that origin serves the Worker coding-help API with the required AI
binding. Plain static deployments report it as unavailable without contacting
a fixed fallback Worker. It is not required for browsing or media playback.

Settings and saved scripts belong to each mirror's browser origin; they do
not automatically follow users between links. Frame messages validate the
exact current origin and expected frame. Static proxy pages nevertheless
share an origin with the app: this is not browser-enforced origin isolation.
Use a dedicated hostname without logged-in administration tools or sensitive
applications. The optional Node deployment retains its distinct app/proxy
origins and configured origin checks; see the README for that separate setup.

For local static testing, serve `dist` at `http://localhost:4173` and open
`/math.html` there. Only one local origin is needed. Production mirrors must
use HTTPS so the service worker can run.

## Practical deployment choices

| Provider | Use for this repository | Account/access required | Repository configuration |
| --- | --- | --- | --- |
| Cloudflare Pages | Existing primary mirror; additional Pages projects can serve the same build | Cloudflare login and GitHub repository access for Git builds | `pnpm build`, output `dist`; existing `_headers` |
| Render Static Site | Additional GitHub-connected static mirror | Render login, connected GitHub account, Render GitHub app access to this repo | `render.yaml` |
| Vercel | Static mirror when the repository/account qualifies for Hobby | Vercel login and GitHub app access; private organization repos cannot deploy to Hobby through Git | `vercel.json` |
| Netlify | Git-connected static mirror when eligible, or upload a local `dist` build | Netlify login; Git import also needs repo access; private organization repos require Pro | `netlify.toml`, existing `_headers` |
| Surge | Upload a local `dist` build without connecting private GitHub source | Surge login; first-time account setup/verification may be needed | No repository adapter required |

All offer a free static-hosting route subject to their account eligibility and
usage limits. Check the actual account plan before creating a deployment.

### Cloudflare Pages

Use the existing Git integration, production branch `main`, build `pnpm build`
and output `dist`. The separate Worker uses `wrangler.jsonc`; Pages serves the
static output. See [Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)
and [build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/).

### Render

Import the repository as a Blueprint using `render.yaml`, or create a **Static
Site** with the same settings. The adapter selects Node 24, installs with the
exact pnpm version and frozen lockfile, publishes `dist`, and deploys future
commits after CI checks pass. It creates one static site with no paid compute,
database or disk. The assigned HTTPS `onrender.com` address serves the proxy
assets locally and requires no static origin configuration changes.

Render static sites are free, with bandwidth and build usage counted against
the workspace allowance. A private GitHub repo must be included in the Render
GitHub app's repository access. See [static sites](https://render.com/docs/static-sites),
[free hosting](https://render.com/docs/free), [Git permissions](https://render.com/docs/git-provider),
[Blueprint fields](https://render.com/docs/blueprint-spec) and
[Node selection](https://render.com/docs/node-version).

### Vercel

Import the repo with preset **Other**, project root `.`, production branch
`main` and Node **24.x**. `vercel.json` pins both install and build commands to
`npx --yes pnpm@11.19.0`, publishes `dist`, and carries the cache/security headers.
This avoids relying on Vercel's pnpm lockfile inference, which documents older
pnpm defaults. No Corepack environment toggle is needed for these commands.

Hobby is for personal, noncommercial use. Its Git integration cannot deploy a
private repository owned by a GitHub organization; it also checks the commit
author against the Hobby account owner. Do not make the repo public or upgrade
a plan just to complete an import. See [Hobby eligibility](https://vercel.com/docs/plans/hobby),
[Git deployment permissions](https://vercel.com/docs/git),
[package-manager selection](https://vercel.com/docs/package-managers) and
[configuration fields](https://vercel.com/docs/project-configuration/vercel-json).

### Netlify

Import an eligible repo and keep its root as the base directory. Netlify reads
`netlify.toml`, selects Node 24, obtains the pinned pnpm from `package.json`,
installs with `--frozen-lockfile`, then runs `pnpm build` and publishes `dist`.
It reads the generated `_headers` file. For manual deployment, upload the local
`dist` folder through Netlify Drop; this publishes built assets without granting
GitHub source access. Future manual updates must upload a fresh build.

Current Free plans have a hard credit limit and no automatic paid recharge.
Private organization-owned Git repositories require Pro. Account plans created
before September 4, 2025 may use different legacy limits. See
[dependency setup](https://docs.netlify.com/build/configure-builds/manage-dependencies/),
[file configuration](https://docs.netlify.com/build/configure-builds/file-based-configuration/),
[deployment paths](https://docs.netlify.com/start/choose-your-path/) and
[current plan eligibility](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/).

### Surge

Build `dist` locally, sign into an existing Surge account, then use its CLI to
publish that folder to an available `https://<chosen-name>.surge.sh` domain.
The publish command is `surge ./dist https://<chosen-name>.surge.sh` after
installing the official CLI. The placeholder is not a live Monkeh address.
Surge hosts the output, so it does not need access to the private repository.

Surge subdomains support HTTPS. Its CLI can create an account at first login;
account creation, verification and any paid feature must be handled explicitly.
Do not assume Cloudflare's `_headers` format configures Surge. Treat this as a
secondary mirror candidate and verify response headers and browser behavior
before listing it as supported. See [getting started](https://surge.sh/docs/getting-started),
[HTTPS](https://surge.sh/docs/platform/ssl), [plans](https://surge.sh/help/upgrading-to-surge-plus)
and [account login](https://surge.sh/help/resetting-your-password).

## Why GitHub Pages is not a drop-in mirror

GitHub Free offers Pages for public repositories; this private repository needs
an eligible paid GitHub plan. A project site also defaults to
`https://<owner>.github.io/monkeh/`, while Monkeh uses root-relative asset and
service-worker URLs. Publishing `dist` there would break those routes. A custom
domain or a separate account-site repository could address
the path issue, but neither is assumed or created here. See
[GitHub Pages availability and site types](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).

## Verify each actual deployment

Open `/math.html` at its final HTTPS address. Confirm that configuration and
JavaScript routes return JavaScript, missing paths return 404, and no provider
SPA rewrite returns HTML for those requests. Check proxy navigation, console,
Inspect, a game launch, music search/playback and Flyflix from the new mirror.
Confirm `/proxy-host.html`, `/sw.js` and vendor assets load from that same
origin and outgoing requests use a working Wisp server. Check that plain
static hosts report coding help as unavailable, or verify the local API if
the mirror supplies it. Add only URLs that have passed these checks to the
published mirror list; dashboard/import links are setup tools, not mirrors.
