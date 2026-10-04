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
