# Mochii: third-party sources and licensing

The root [LICENSE](../LICENSE) applies only to original material that
NoseyGames owns and can license. It does not relicense third-party material or
claim ownership of dependencies, imported catalogs, games, music, artwork, or
upstream implementations. Permission to use one part of Mochii is not
permission to use every linked work. The inventory below is a record of known
sources, not a certification that every possible third-party right has been
cleared.

The custom license's immediate termination rule applies only to its own grant.
It cannot replace the termination, reinstatement, or other provisions of a
third-party license. Accurate claims about a contributor's own modifications
are allowed. Ordinary code-comment cleanup must preserve legally required
notices and license documents; moving attribution to this file does not by
itself satisfy every dependency's license.

## Mochii Cloud

Mochii Cloud adapts the catalog and feature set of
[Cine-Cloud-SRC](https://github.com/codiesnutkiss-sudo/Cine-Cloud-SRC/tree/main/src)
by `codiesnutkiss-sudo`, retrieved on October 4, 2026. The upstream
[README](https://github.com/codiesnutkiss-sudo/Cine-Cloud-SRC/blob/main/README.md)
states: “Feel free to copy or fork, or whatever!” The source also expressly
allows remaking it. No separate formal license file was present in the tree.

The retrieved tree SHA was `60329ad825753ce983fb1d8f7e1a150c2de46bdb`.
The adapted catalog contains all 106 original entries. Mochii's interface and
controller have been rewritten, and ordinary code comments have been removed.

Game titles, descriptions, artwork, provider pages and the original tutorial
remain third-party materials. Launches point to Raccoon Games or the Eaglercraft
provider identified in the original catalog. The catalog does not include the
games themselves or grant ownership of them. Provider availability, access,
accounts and usage requirements are controlled by those providers.

## Temporary inbox

The temporary inbox is independently implemented against the documented
[Maildrop API](https://docs.maildrop.cc/api-reference/overview). Maildrop provides
the address domain and message storage; the browser calls its public GraphQL
endpoint directly. No Figure client or server implementation is bundled.

## Bundled and installed proxy dependencies

The following was checked against installed package metadata and upstream
sources on October 6, 2026. Package names and upstream project names are
retained because they identify the actual authors' work.

| Component | Version or location | Rights and source |
| --- | --- | --- |
| BareMux, Mercury Workshop Inc. | `@mercuryworkshop/bare-mux` 2.1.9; built to `bearmux/` | MIT. Copyright 2024 Mercury Workshop Inc. [Source and license](https://github.com/MercuryWorkshop/bare-mux). The build copies its complete license to `bearmux/LICENSE`. |
| Epoxy Transport, Mercury Workshop | `@mercuryworkshop/epoxy-transport` 2.1.28; built to `bearmux/epoxy/index.mjs` | `AGPL-3.0-only`. Published npm gitHead `f9ccb9b14f88a7fda355dc4cf039106c95797849`; the installed source and build script match that [revision](https://github.com/MercuryWorkshop/epoxy-transport/tree/f9ccb9b14f88a7fda355dc4cf039106c95797849). |
| Epoxy TLS, Mercury Workshop | Transitive `@mercuryworkshop/epoxy-tls` 2.1.18-1; bundled into the transport | `AGPL-3.0-only`; its npm package contains the full license. Release gitHead `b428c01cde0bf9be25469f24ad8b4d2b7c5f6f3b` differs from embedded build revision `e2d1d4e50a97be4a1a242eea6b212cfb77b78426`. Both sources are retained; their only differences are version fields in three manifests. [Source and build instructions](https://github.com/MercuryWorkshop/epoxy-tls). |
| Ultraviolet, Titanium Network and contributors | Version 3.2.10; supplied `ultrav/uv.bundle.js`, `uv.client.js`, `uv.handler.js`, and `uv.sw.js` | [Source revision `92d907579bc61b6290ded490877834698e0c6439`](https://github.com/titaniumnetwork-dev/Ultraviolet/tree/92d907579bc61b6290ded490877834698e0c6439). All four bundles have identical JavaScript ASTs to the official npm 3.2.10 files after ordinary comment removal. The actual release and revision LICENSE files match and contain GNU AGPL v3, despite conflicting npm metadata claiming MIT. The actual license is retained. |
| ipaddr.js, whitequark | `ipaddr.js` 2.5.0, Node dependency | MIT. Copyright 2011–2017 whitequark. [Source and license](https://github.com/whitequark/ipaddr.js). |
| ws, Einar Otto Stangvik, Arnout Kazemier, Luigi Pinca and contributors | `ws` 8.22.0, Node dependency | MIT. [Source and license](https://github.com/websockets/ws). The installed package retains the copyright notices and full terms. |

The root custom license does not apply to these components. Keep their
copyright and license notices with redistributed copies. The AGPL components
must retain their own terms, including the applicable source-distribution and
network-source requirements. A public repository containing only compiled
JavaScript or WebAssembly is not necessarily the corresponding source.
Upstream links alone do not establish that the exact deployed version can be
rebuilt.

The publicly served [license and source page](../licenses/index.html) supplies
full license texts, Ultraviolet's bundled dependency notices, and five original
source archives. [NOTICE.txt](../licenses/NOTICE.txt) records provenance,
modifications and build instructions; [sources.json](../licenses/sources.json)
records exact revisions and archive checksums. BareMux's npm metadata does not
provide a gitHead, so its source is identified by the upstream 2.1.9 version
commit. The archives preserve upstream notices, comments, manifests and
lockfiles. They do not include an offline mirror of every transitive npm
package or Rust crate, and no bit-for-bit rebuild of BareMux or the Epoxy TLS
WebAssembly has been established.

For distribution, provide the applicable full license texts, identify the
corresponding source and build instructions for the shipped versions, retain
notices in bundled dependencies, and document modifications. AGPL section 6
governs distribution of non-source forms; section 13 addresses modified
network-interactive versions. Sections 7, 8, and 10 govern additional terms,
termination/reinstatement, and downstream rights. See the
[upstream AGPL text](https://github.com/titaniumnetwork-dev/Ultraviolet/blob/main/LICENSE).
This record does not assert that independently written Mochii code and the
proxy constitute a mere aggregate, or that adding a custom license resolves
copyleft compatibility.

## Other app code and externally loaded libraries

`apps/auk.js` was adapted from the previously loaded Consessions/flyflix
controller, as recorded in the original project README. The exact upstream
revision and its license were not established in this audit. The inherited
portions are excluded from the root ownership claim; this notice does not
invent a license or permission for them.

Auk loads CodeMirror 5.65.13 and Font Awesome Free 6.4.2 from cdnjs. Another
shell page references Font Awesome Free 6.4.0. CodeMirror uses the
[MIT license](https://github.com/codemirror/codemirror5/blob/master/LICENSE).
Font Awesome Free separates its [font, icon, and code licenses](https://fontawesome.com/license/free);
the applicable upstream terms continue to apply to each type of asset.

Vox loads JSZip 3.10.1 from cdnjs and Ruffle 0.6.0 from unpkg when its Flash
player is used. JSZip offers an [MIT or GPLv3 choice](https://github.com/Stuk/jszip/blob/v3.10.1/LICENSE.markdown).
Ruffle provides its [own license terms](https://github.com/ruffle-rs/ruffle#license).
Mochii does not claim authorship of these libraries or the games opened with
them. The code remains hosted by the named CDN unless a later build explicitly
vendors it.

Google Fonts and Material Symbols are loaded from Google's hosted services.
Their font and icon licenses remain with their publishers. Hosted v86,
Anura, Guacamole, Raccoon, Flyflix, and other linked services are separate
projects; a link, iframe, or proxy route does not transfer their rights to
Mochii. Relevant upstreams include [v86](https://github.com/copy/v86),
[Anura](https://github.com/MercuryWorkshop/anura), and
[Apache Guacamole](https://guacamole.apache.org/).

## Expanded game catalog and settings

The public [Tung Tung reference site](https://photos.tram-gallery.ru/) was reviewed
on October 4, 2026. Its six populated manifests list 2,709 game entries: GN-Math
(809), Seraph (468), Hydra (872), 3kh0 (370), Truffled (107), and TGLSC (83).
Mochii keeps source-hosted launch and image links in a validated local snapshot,
alongside its original catalog. No game payloads, reference executable code,
advertising, chat, private APIs, or account-sync backend are copied into Mochii.
The chat/comments entry is excluded, leaving 2,708 reference games plus 835
original entries. Exact duplicate URLs within a source are collapsed; source
variants remain.
The catalog does not grant ownership of the linked games. Their hosts control
availability and access conditions.

Settings and library controls are independently implemented. Cat and Doubleu
backgrounds are original CSS/SVG interpretations. Google Fonts loads only when
a non-default font is selected. Preferences, favorites, and recent games stay
in the browser.

The reference browser's public engine defaults to its same-origin Wisp route,
`wss://photos.tram-gallery.ru/wisp/`, with a `gl_wisp` local-storage override.
That relay has not been added to Mochii's public rotation.

Use `node scripts/update-game-catalog.mjs` to refresh the bundled catalog links.
Review the resulting source diff before publishing the refreshed snapshot.

## Cherri catalogs, music and settings

The public [Cherri reference](https://h35d5a9.jfs-autoelevadores.com.ar/) was
reviewed on October 4, 2026. Its public game catalogs list CKV (821), Seraph (501),
Truffled (505), UGS (1,512) and GN-Math (818). Eleven duplicate launch URLs and
the GN-Math comments entry are excluded, adding 4,145 source variants to the
existing 3,543. The combined title index contains 3,082 cards. Account-dependent
cloud/arcade providers and user-supplied ROM placeholders are not imported.
Only catalog metadata, covers and source-hosted launch links are referenced;
no game payloads or Cherri executable code are bundled.

Cherri's music is a live service rather than a finite track manifest. Mochii
independently implements a player that searches its five anonymous source IDs:
Qobuz, Tidal, YouTube Music, and two SoundCloud routes. Matching normalized titles
share a row, with provider/artist variants retained. The SoundCloud routes were
observed returning Qobuz results, so returned source identities are preserved.
The discovery snapshot has 287 unique titles and 288 provider variants. The
bounded Worker relay requests only fixed public search, browse and stream routes;
it never sends account cookies, passwords, or arbitrary destination URLs. No
audio files are bundled or downloaded in advance. Availability and rights to
stream remain controlled by the upstream providers.

Settings, character masking, browser identity, and snow/rain/bubble effects are
independent implementations inspired by Cherri and the public Figure interface.
No sign-in, account synchronization, advertising, or chat features are added.
