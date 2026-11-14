# Game-data attribution

The bundled progression manifest contains normalized factual data derived from the English HolodoriDB master-data diff repository:

- Source: https://github.com/HolodoriDB/holodori-db-eng-diff
- Source commit: `95e08ebe8f5b0bec83af036230f10291726b7130`
- Master-data version: `fbca8c670e074558b24708bf163fff446a614f709afa9d1784395a15444121b0`
- Manifest schema: `5`
- Asset tool: https://github.com/HolodoriDB/holodori-asset-tools
- Asset tool commit: `13f150fe9dfbd367be53e5ea1c0a4ceb258b74f2`
- Asset catalog revision: `69`

Only reviewed facts required by the planner are bundled from the database. The app also includes offline visual assets mapped by the reviewed manifest:

- Card thumbnails, full unsquished artwork, and vertical recognition artwork served by https://cdn.holodori.dev
- Card full-art and transparent signature movies retrieved from the current OCTO resource catalog with `holodori-asset-tools`
- Progression-material icons imported with `holodori-asset-tools`
- Cute/Pure/Happy, Performance/Technique/Sense, rarity-star, and Bloom-flower WebPs served by https://api.holodori.best/manual_assets and observed on https://holodori.best/cards and https://holodori.best/game-data/import-cards
- Holomem Board node shells, connection sockets, and shadows served by https://api.holodori.best/manual_assets and observed on https://holodori.best/game-data?tab=board
- Holomem Board effect icons served by https://cdn.holodori.dev and mapped from the normalized Board effect types

`src/renderer/public/assets/asset-sources.json` records the provenance and hashes of static assets. `src/renderer/public/assets/cards/animation-sources.json` records the source resource, source MD5, converted WebM path, dimensions, byte length, alpha status, and SHA-256 for every stored card movie. Encrypted USM downloads and temporary extracted streams are not included.

HolodoriDB is an independent upstream research project. Its inclusion here does not imply endorsement of this application.

The exact chart timeline is a separately reviewed, deterministically generated data pack derived from the current official `.sus` resources. Acquisition uses the external GPLv3 `HolodoriDB/holodori-asset-tools` utility pinned above. Every decrypted source file is SHA-256 pinned in a temporary acquisition receipt; the generator deterministically re-encrypts it and requires its MD5 to equal both the official asset-catalog entry and `MusicDifficultyChart.chartHash`. Raw `.sus` files, the asset catalog, lane/width data, slide geometry/topology, and the BPM map are never copied into the application data pack.

The retained source pack contains only a compact index, exact integer-microsecond scoring-event deltas, official note-type codes, and SP trigger times. It cannot reconstruct the source charts. The exact two retained files are included in application packages for lazy, verified, read-only chart access.

`src/data/account.json` is a separate normalized account manifest built from the same reviewed HolodoriDB commit. It contains the 54 catalog members, all four Holomem Board layouts, 153 physical Board positions per layout, 324 character-aware node variants with exact costs/effects, all 124 card Connect effects with their Bloom 5 upgrades and spatial extent masks, exact parameter ratios/Level tables/Bloom bonuses for all 178 cards, and 178 supported outfits with canonical source-card relationships. The importer keeps physical node identity separate from character-specific variants and fails on unresolved or duplicate mappings.

`src/data/scoring.json` is a separately verified schema-1 projection from that same commit. It retains card-skill relationships, skill levels/effects/targets/conditions and relevant English descriptions, current-level roster bonuses, Bloom skill upgrades, all 16 official groups, and metadata for all 194 retained songs. It reuses account parameters, Boards, outfits and Memories by ID. Reviewed source-table and manifest digests are pinned in `scoring-identity.json`; unsupported scoring rules remain explicit in the read-only team report. See [scoring rules](docs/scoring-rules.md).
