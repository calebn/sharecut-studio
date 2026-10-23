# ShareCut logo masters

`logo-dark.svg` and `logo-light.svg` are the approved **Two tracks + ShareCut**
primary lockup (no "Studio" in the wordmark), vendored for the app so it never
needs a runtime CDN or private-repository fetch (#1923).

| File | Source | Git blob SHA |
| --- | --- | --- |
| `logo-dark.svg` | `calebn/sharecut-ops` `deploy/sharecut/site/assets/logo-dark.svg` at `c2beb137c343abeab82a26695005259ae178b7e6` | `12505c2b675600219043327a796169017fc9402d` |
| `logo-light.svg` | `calebn/sharecut-ops` `deploy/sharecut/site/assets/logo-light.svg` at `c2beb137c343abeab82a26695005259ae178b7e6` | `58c24af87f49a2ea3281b851269b02cc076d304e` |

Per the owner's note on #1923, both files are byte-for-byte matches of the
round-11 editable bundle's `ShareCut-only-study/` directory. They are vector
paths with outlined lettering, so no font is needed to render them. The
internal "study" labels in their `<title>` and `aria-label` predate the
selection of ShareCut-only; the app does not render them (its own accessible
names come from the product-name text).

`tests/test_public_sites.py` checks the blob SHAs above against the files.

## Derived files

`scripts/build_brand_assets.py` writes everything derived from the masters.
It copies the symbol paths (`two-tracks-selected-symbol`) and the wordmark
paths verbatim and only changes the canvas around them.

| Output | Use |
| --- | --- |
| `symbol-dark.svg`, `symbol-light.svg` | Symbol alone on dark and light backgrounds |
| `symbol-mono.svg` | Single colour (`currentColor`), same geometry |
| `gui/desktop/src-tauri/app-icon.svg` (copies: `gui/web/public/favicon.svg`, `src-tauri/icons/icon.svg`) | Rounded tile for favicon, Windows, Linux and the Tauri icon set |
| `gui/desktop/src-tauri/app-icon-macos.svg` | Tile inset to Apple's 824 px grid, source of `icon.icns` |
| `gui/web/public/assets/app/icon.svg` | Full-bleed maskable Home Screen icon (symbol inside the 40% safe circle) |
| `gui/web/src/ui/brand/lockupGeometry.ts` | Geometry for the `BrandLockup` and `BrandSymbol` components |

The app lockup is themed with `--color-text-primary` (upper tracks and
wordmark) and `--color-accent` (lower tracks), the same colours as the masters
in dark (`#f1efe8`, `#ff6d48`) and light (`#1a211e`, `#df4b28`).

Under forced colors (Windows high contrast) the app lockup and the desktop splash mark
fill every shape with `CanvasText`, because Chromium keeps authored SVG fills and the
cream ink would vanish on a white Canvas. The app reads this through
`--color-brand-mark-ink` and `--color-brand-mark-accent` in `theme/tokens.css`.

## Regenerating icon bitmaps

After changing a master or the generator, run `python3 scripts/build_brand_assets.py`,
then rebuild the bitmaps:

1. Home Screen PNGs: `cd gui/web && npx vite-node scripts/render-app-icons.ts`.
2. Desktop set: render `app-icon.svg` to a transparent 1024 px `app-icon.png`, then
   `cd gui/desktop && npx tauri icon src-tauri/app-icon.png -o src-tauri/icons`.
3. macOS: render `app-icon-macos.svg` to a 1024 px PNG, run `npx tauri icon` on it into a
   scratch folder and copy only its `icon.icns` over `src-tauri/icons/icon.icns`.
