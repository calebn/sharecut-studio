"""Shared brand tokens: one SoT, one light/dark contract, no consumer redeclare."""

from __future__ import annotations

import colorsys
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

BRAND_TOKENS = ROOT / "deploy/brand/brand-tokens.css"
MARKETING_CSS = ROOT / "deploy/brand/marketing.css"
THEME_CSS = ROOT / "gui/web/src/styles/theme.css"
THEME_TOKENS = ROOT / "gui/web/src/styles/theme/tokens.css"
THEME_DARK = ROOT / "gui/web/src/styles/theme/theme-dark.css"
THEME_LIGHT = ROOT / "gui/web/src/styles/theme/theme-light.css"
PRIMITIVES_CSS = ROOT / "gui/web/src/styles/theme/primitives.css"

SHARED_COLOR_ROLES: tuple[str, ...] = (
    "--color-bg-canvas",
    "--color-bg-surface",
    "--color-bg-elevated",
    "--color-border",
    "--color-border-strong",
    "--color-text-primary",
    "--color-text-secondary",
    "--color-accent",
    "--color-accent-solid",
    "--color-accent-on-solid",
    "--color-shadow-soft",
)

DOCS_THEME_ROLES = (
    "--color-bg-canvas",
    "--color-text-primary",
    "--color-border",
)
CSS_HEX_RE = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})")

_PROP_RE = re.compile(
    r"(--color-[a-z0-9-]+)\s*:\s*([^;]+);",
    re.IGNORECASE | re.DOTALL,
)

DARK_SELECTOR = re.compile(
    r":root\s*,\s*:root\[data-theme\s*=\s*[\"']dark[\"']\]\s*\{",
    re.IGNORECASE | re.DOTALL,
)
LIGHT_DATA_SELECTOR = re.compile(
    r":root\[data-theme\s*=\s*[\"']light[\"']\]\s*\{",
    re.IGNORECASE,
)
LIGHT_PREFERS_SELECTOR = re.compile(
    r":root:not\(\s*\[\s*data-theme\s*\]\s*\)\s*\{",
    re.IGNORECASE,
)
COMPANY_SELECTOR = re.compile(
    r":root\.company\s*\{",
    re.IGNORECASE,
)
PREFERS_LIGHT_MEDIA = re.compile(
    r"@media\s*\(\s*prefers-color-scheme\s*:\s*light\s*\)\s*\{",
    re.IGNORECASE,
)
COMPANY_ACCENT_ROLES: frozenset[str] = frozenset(
    {
        "--color-accent",
        "--color-accent-solid",
        "--color-accent-on-solid",
    }
)


def _normalize_value(raw: str) -> str:
    value = " ".join(raw.split()).strip()
    if re.fullmatch(r"#[0-9a-fA-F]{3,8}", value):
        return value.lower()
    return value


def _color_props(block: str, roles: frozenset[str] | None = None) -> dict[str, str]:
    found: dict[str, str] = {}
    for name, raw in _PROP_RE.findall(block):
        if roles is not None and name not in roles:
            continue
        if name not in found:
            found[name] = _normalize_value(raw)
    return found


def _props_from_block(block: str) -> dict[str, str]:
    return _color_props(block, frozenset(SHARED_COLOR_ROLES))


def _extract_balanced_block(css: str, open_brace_at: int) -> str:
    depth = 0
    i = open_brace_at
    while i < len(css):
        ch = css[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return css[open_brace_at + 1 : i]
        i += 1
    raise AssertionError("unbalanced CSS brace while parsing brand/theme block")


def _rule_bodies(css: str, compiled: re.Pattern[str]) -> list[str]:
    bodies: list[str] = []
    for match in compiled.finditer(css):
        open_at = css.find("{", match.end() - 1)
        assert open_at != -1, f"opening brace missing after {compiled.pattern}"
        bodies.append(_extract_balanced_block(css, open_at))
    return bodies


def _first_rule_body(css: str, compiled: re.Pattern[str]) -> str:
    bodies = _rule_bodies(css, compiled)
    assert bodies, f"selector not found: {compiled.pattern}"
    return bodies[0]


def _declarations_of(css: str, name: str) -> list[str]:
    return re.findall(rf"(?m)^\s*{re.escape(name)}\s*:", css)


def _custom_property_value(css: str, name: str) -> str:
    matches = re.findall(rf"(?m)^\s*{re.escape(name)}\s*:\s*([^;]+);", css)
    assert len(matches) == 1, f"expected one declaration for {name}, found {len(matches)}"
    return _normalize_value(matches[0])


def brand_dark_roles() -> dict[str, str]:
    css = BRAND_TOKENS.read_text(encoding="utf-8")
    return _props_from_block(_first_rule_body(css, DARK_SELECTOR))


def brand_light_data_roles() -> dict[str, str]:
    css = BRAND_TOKENS.read_text(encoding="utf-8")
    return _props_from_block(_first_rule_body(css, LIGHT_DATA_SELECTOR))


def _prefers_light_root_body(css: str, *, missing: str) -> str:
    media = PREFERS_LIGHT_MEDIA.search(css)
    assert media is not None, f"{missing} prefers-color-scheme: light missing"
    media_body = _extract_balanced_block(css, media.end() - 1)
    return _first_rule_body(media_body, LIGHT_PREFERS_SELECTOR)


def brand_light_prefers_roles() -> dict[str, str]:
    css = BRAND_TOKENS.read_text(encoding="utf-8")
    return _props_from_block(_prefers_light_root_body(css, missing="brand-tokens"))


def test_theme_css_imports_brand_tokens_first() -> None:
    text = THEME_CSS.read_text(encoding="utf-8")
    assert text.index('"./theme/brand-tokens.css"') < text.index('"./theme/tokens.css"')


def test_brand_tokens_use_theme_contract_selectors() -> None:
    css = BRAND_TOKENS.read_text(encoding="utf-8")
    assert DARK_SELECTOR.search(css)
    assert LIGHT_DATA_SELECTOR.search(css)
    assert PREFERS_LIGHT_MEDIA.search(css)
    assert LIGHT_PREFERS_SELECTOR.search(css)


def test_daw_themes_use_theme_contract_selectors() -> None:
    dark = THEME_DARK.read_text(encoding="utf-8")
    light = THEME_LIGHT.read_text(encoding="utf-8")
    assert DARK_SELECTOR.search(dark)
    assert LIGHT_DATA_SELECTOR.search(light)
    assert PREFERS_LIGHT_MEDIA.search(light)
    assert LIGHT_PREFERS_SELECTOR.search(light)


def test_consumers_do_not_redeclare_shared_brand_colors() -> None:
    """Except marketing `:root.company` accent overrides."""
    consumers = (
        THEME_DARK.read_text(encoding="utf-8"),
        THEME_LIGHT.read_text(encoding="utf-8"),
        THEME_TOKENS.read_text(encoding="utf-8"),
    )
    for role in SHARED_COLOR_ROLES:
        for css in consumers:
            assert not _declarations_of(css, role), f"{role} redeclared outside brand-tokens"

    marketing = MARKETING_CSS.read_text(encoding="utf-8")
    company_css = "\n".join(_rule_bodies(marketing, COMPANY_SELECTOR))
    assert company_css, "marketing missing :root.company accent overrides"
    for role in SHARED_COLOR_ROLES:
        in_file = _declarations_of(marketing, role)
        in_company = _declarations_of(company_css, role)
        if role in COMPANY_ACCENT_ROLES:
            assert in_company, f"{role} missing from :root.company"
            assert len(in_file) == len(in_company), f"{role} declared outside :root.company"
        else:
            assert not in_file, f"marketing redeclares {role}"


def test_company_light_accents_beat_brand_light() -> None:
    marketing = MARKETING_CSS.read_text(encoding="utf-8")
    assert marketing.index('@import "./brand-tokens.css"') < marketing.index(":root.company")

    default_company = _props_from_block(_first_rule_body(marketing, COMPANY_SELECTOR))
    assert default_company["--color-accent"] == "#8aa8a0"
    assert default_company["--color-accent-solid"] == "#3d5c56"
    assert default_company["--color-accent-on-solid"] == "#ffffff"

    media = PREFERS_LIGHT_MEDIA.search(marketing)
    assert media is not None, "marketing prefers-color-scheme: light missing"
    media_body = _extract_balanced_block(marketing, media.end() - 1)
    company_light = _props_from_block(_first_rule_body(media_body, COMPANY_SELECTOR))
    brand_light = brand_light_prefers_roles()
    assert company_light["--color-accent"] == "#3d5c56"
    assert company_light["--color-accent-solid"] == "#3d5c56"
    assert company_light["--color-accent"] != brand_light["--color-accent"]
    assert company_light["--color-accent-solid"] != brand_light["--color-accent-solid"]


def test_brand_tokens_define_all_shared_roles() -> None:
    dark = brand_dark_roles()
    light = brand_light_data_roles()
    missing_d = [r for r in SHARED_COLOR_ROLES if r not in dark]
    missing_l = [r for r in SHARED_COLOR_ROLES if r not in light]
    assert not missing_d, f"dark brand-tokens missing {missing_d}"
    assert not missing_l, f"light brand-tokens missing {missing_l}"


def test_brand_light_prefers_matches_data_theme() -> None:
    primary = brand_light_data_roles()
    other = brand_light_prefers_roles()
    missing_p = [r for r in SHARED_COLOR_ROLES if r not in primary]
    missing_o = [r for r in SHARED_COLOR_ROLES if r not in other]
    assert not missing_p, f"data-theme light missing {missing_p}"
    assert not missing_o, f"prefers light missing {missing_o}"
    for role in SHARED_COLOR_ROLES:
        assert primary[role] == other[role], (
            f"{role} mismatch: data-theme={primary[role]!r} prefers={other[role]!r}"
        )


def test_docs_theme_roles_are_valid_hex_in_each_brand_theme() -> None:
    """Storybook's docs theme passes these roles to its color parser."""
    for theme_name, roles in (
        ("dark", brand_dark_roles()),
        ("light data-theme", brand_light_data_roles()),
        ("light OS preference", brand_light_prefers_roles()),
    ):
        for role in DOCS_THEME_ROLES:
            value = roles.get(role)
            assert value is not None, f"{theme_name} missing {role}"
            assert CSS_HEX_RE.fullmatch(value), f"{theme_name} {role} is not CSS hex: {value}"


def test_theme_light_prefers_matches_data_theme() -> None:
    css = THEME_LIGHT.read_text(encoding="utf-8")
    primary = _color_props(_first_rule_body(css, LIGHT_DATA_SELECTOR))
    other = _color_props(_prefers_light_root_body(css, missing="theme-light"))
    assert primary, "theme-light data-theme block has no --color-* props"
    missing_p = sorted(set(other) - set(primary))
    missing_o = sorted(set(primary) - set(other))
    assert not missing_p, f"data-theme light missing {missing_p}"
    assert not missing_o, f"prefers light missing {missing_o}"
    for role, value in primary.items():
        assert other[role] == value, (
            f"{role} mismatch: data-theme={value!r} prefers={other[role]!r}"
        )


def test_daw_functional_accent_follows_brand_var() -> None:
    """Keep small accent text legible and reserve badges for neutral status."""
    dark = _color_props(_first_rule_body(THEME_DARK.read_text(encoding="utf-8"), DARK_SELECTOR))
    assert dark["--color-accent-fg"] == "var(--color-accent)"
    assert dark["--color-badge-fg"] == "var(--color-text-secondary)"
    assert dark["--color-selection"] == "var(--color-accent)"

    primitive = "--primitive-orange-750"
    primitive_value = _custom_property_value(PRIMITIVES_CSS.read_text(encoding="utf-8"), primitive)
    assert primitive_value == "#b13a1e"

    light_css = THEME_LIGHT.read_text(encoding="utf-8")
    light_rules = (
        _first_rule_body(light_css, LIGHT_DATA_SELECTOR),
        _prefers_light_root_body(light_css, missing="theme-light"),
    )
    for light_rule in light_rules:
        light = _color_props(light_rule)
        assert light["--color-selection"] == "var(--color-accent)"
        assert light["--color-accent-fg"] == f"var({primitive})"
        assert light["--color-badge-fg"] == "var(--color-text-secondary)"


def _contrast_ratio(first: str, second: str) -> float:
    def luminance(value: str) -> float:
        channels = [int(value[index : index + 2], 16) / 255 for index in (1, 3, 5)]
        linear = [
            channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4
            for channel in channels
        ]
        return sum(
            weight * channel
            for weight, channel in zip((0.2126, 0.7152, 0.0722), linear, strict=True)
        )

    lighter, darker = sorted((luminance(first), luminance(second)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def test_design_palette_preserves_text_and_action_contrast() -> None:
    """The visual target's decorative accent needs a darker filled action in light mode."""
    light = brand_light_data_roles()
    dark = brand_dark_roles()
    assert light["--color-bg-canvas"] == "#f4f1eb"
    assert light["--color-bg-surface"] == "#fffdf9"
    assert light["--color-accent"] == "#df4b28"
    assert dark["--color-bg-canvas"] == "#181614"
    assert dark["--color-accent"] == "#ff6d48"
    accent_text = _custom_property_value(
        PRIMITIVES_CSS.read_text(encoding="utf-8"), "--primitive-orange-750"
    )
    for surface in ("--color-bg-canvas", "--color-bg-surface", "--color-bg-elevated"):
        assert _contrast_ratio(accent_text, light[surface]) >= 4.5
    for roles in (light, dark):
        assert _contrast_ratio(roles["--color-text-primary"], roles["--color-bg-surface"]) >= 4.5
        assert (
            _contrast_ratio(roles["--color-accent-on-solid"], roles["--color-accent-solid"]) >= 4.5
        )


_VAR_ONLY_RE = re.compile(r"^var\(\s*(--[\w-]+)\s*\)$")
_PRIMITIVE_HEX_RE = re.compile(r"(--primitive-[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b")
LADDER_RUNGS = ("canvas", "base", "raised", "overlay", "sunken")


def _studio_roles(theme: str) -> dict[str, str]:
    """Primitives + brand + Studio theme roles for one theme (explicit data-theme)."""
    primitives = dict(_PRIMITIVE_HEX_RE.findall(PRIMITIVES_CSS.read_text(encoding="utf-8")))
    if theme == "dark":
        brand = brand_dark_roles()
        block = _first_rule_body(THEME_DARK.read_text(encoding="utf-8"), DARK_SELECTOR)
    else:
        brand = brand_light_data_roles()
        block = _first_rule_body(THEME_LIGHT.read_text(encoding="utf-8"), LIGHT_DATA_SELECTOR)
    return {**primitives, **brand, **_color_props(block)}


def _resolve_hex(name: str, roles: dict[str, str]) -> str:
    value = roles[name]
    for _ in range(8):
        match = _VAR_ONLY_RE.match(value)
        if not match:
            break
        value = roles[match.group(1)]
    assert CSS_HEX_RE.fullmatch(value), f"{name} does not resolve to a hex color: {value}"
    return value


def _hue_distance(first: str, second: str) -> float:
    def hue(value: str) -> float:
        red, green, blue = (int(value[index : index + 2], 16) / 255 for index in (1, 3, 5))
        return colorsys.rgb_to_hls(red, green, blue)[0] * 360

    distance = abs(hue(first) - hue(second)) % 360
    return min(distance, 360 - distance)


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_surface_ladder_text_partners_meet_contrast(theme: str) -> None:
    """Five-rung ladder (#135): each rung has a text-on-* partner at ≥4.5:1."""
    roles = _studio_roles(theme)
    for rung in LADDER_RUNGS:
        background = _resolve_hex(f"--color-bg-{rung}", roles)
        foreground = _resolve_hex(f"--color-text-on-{rung}", roles)
        assert _contrast_ratio(foreground, background) >= 4.5, (theme, rung)


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_ladder_rungs_stack_in_order(theme: str) -> None:
    """Sunken sits below base; overlay never sits below raised."""
    roles = _studio_roles(theme)

    def luminance(name: str) -> float:
        value = _resolve_hex(name, roles)
        return _contrast_ratio(value, "#000000")

    assert luminance("--color-bg-sunken") < luminance("--color-bg-base")
    assert luminance("--color-bg-overlay") >= luminance("--color-bg-raised")


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_danger_reads_apart_from_the_accent(theme: str) -> None:
    """Primary actions and destructive actions must not share a red (#20 review)."""
    roles = _studio_roles(theme)
    accent = _resolve_hex("--color-accent-solid", roles)
    danger = _resolve_hex("--color-danger", roles)
    assert _hue_distance(accent, danger) >= 20
    assert _contrast_ratio(danger, _resolve_hex("--color-bg-surface", roles)) >= 4.5


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_selected_chip_and_fields_keep_text_contrast(theme: str) -> None:
    roles = _studio_roles(theme)
    chip = _resolve_hex("--color-chip-selected", roles)
    field = _resolve_hex("--color-field", roles)
    for text in ("--color-text-primary", "--color-text-secondary"):
        assert _contrast_ratio(_resolve_hex(text, roles), chip) >= 4.5, (theme, text, "chip")
        assert _contrast_ratio(_resolve_hex(text, roles), field) >= 4.5, (theme, text, "field")
