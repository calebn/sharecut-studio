# Shared UI brand CSS

[`brand-tokens.css`](brand-tokens.css) is the source of truth for shared scale
and brand `--color-*` roles (canvas / surface / elevated, borders, text, accent,
shadow-soft). It is shared by the local GUI and bundled relay assets:

1. `html[data-theme="light"|"dark"]` wins ([`useTheme`](../../gui/web/src/hooks/useTheme.ts)).
2. Else follow `prefers-color-scheme` on `:root:not([data-theme])`.
3. Dark baseline is `:root` / `:root[data-theme="dark"]`.

[`marketing.css`](marketing.css) is page reset + helpers. Shared Cover / Stack /
Cluster / Switcher / Center / Box / wordmark / lede live in
[`cover-layout.css`](cover-layout.css). Nest primitives (`box stack tight`,
`plain stack tight`); do not add descendant layout to Box. Card body mute is
`.note`, not `.lede`. No `!important`. No `@layer` (tokens + import order are
the cascade).

Identical copies (enforced by `tests/test_public_sites.py`):

| Source | Copies |
| --- | --- |
| [`brand-tokens.css`](brand-tokens.css) | [`gui/web/src/styles/theme/brand-tokens.css`](../../gui/web/src/styles/theme/brand-tokens.css), [`gui/desktop/splash/brand-tokens.css`](../../gui/desktop/splash/brand-tokens.css), [`src/podcast_relay/static/brand-tokens.css`](../../src/podcast_relay/static/brand-tokens.css) |
| [`cover-layout.css`](cover-layout.css) | [`gui/web/src/styles/partials/cover-layout.css`](../../gui/web/src/styles/partials/cover-layout.css) |

Do not restyle individual UI surfaces. Lane / clip / warning tokens stay in
`theme-dark.css` / `theme-light.css` using the **same selectors**.
CI: `tests/test_brand_color_roles.py`.

After editing a brand file, copy it to the paths above.
