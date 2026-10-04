# Third-party sources

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

## Proxy dependencies

BareMux and Epoxy are pinned npm dependencies; the build retains the BareMux
license file. Ultraviolet was supplied with the original Monkeh repository.
Required third-party license files are retained separately from ordinary code
comments. Dependency packages and their installed metadata are not altered by
the comment cleanup.

## Expanded game catalog and settings

The public [Tung Tung reference site](https://photos.tram-gallery.ru/) was reviewed
on October 4, 2026. Its six populated manifests list 2,709 game entries: GN-Math
(809), Seraph (468), Hydra (872), 3kh0 (370), Truffled (107), and TGLSC (83).
Monkeh keeps source-hosted launch and image links in a validated local snapshot,
alongside its original catalog. No game payloads, reference executable code,
advertising, chat, private APIs, or account-sync backend are copied into Monkeh.
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
That relay has not been added to Monkeh's public rotation.

Use `node scripts/update-game-catalog.mjs` to refresh the bundled catalog links.
Review the resulting source diff before publishing the refreshed snapshot.
