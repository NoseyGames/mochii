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

## Cherri catalogs, music and settings

The public [Cherri reference](https://h35d5a9.jfs-autoelevadores.com.ar/) was
reviewed on October 4, 2026. Its public game catalogs list CKV (821), Seraph (501),
Truffled (505), UGS (1,512) and GN-Math (818). Eleven duplicate launch URLs and
the GN-Math comments entry are excluded, adding 4,145 source variants to the
existing 3,543. The combined title index contains 3,082 cards. Account-dependent
cloud/arcade providers and user-supplied ROM placeholders are not imported.
Only catalog metadata, covers and source-hosted launch links are referenced;
no game payloads or Cherri executable code are bundled.

Cherri's music is a live service rather than a finite track manifest. Monkeh
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
