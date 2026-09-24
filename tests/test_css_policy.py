"""CSS/JS theme policy: rem, tokens, consent-gated exceptions.

Does not strip comments — `!important` / `@layer` / viewport-size `@media`
are allowed only when a matching `stylelint-disable` includes
`-- user-approved:`.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_CSS_ROOTS: tuple[Path, ...] = (
    ROOT / "gui/web/src/styles",
    ROOT / "gui/web/public",
    ROOT / "deploy",
    ROOT / "ux/assets",
    ROOT / "docs-site/assets",
    ROOT / "src/podcast_relay/static",
    ROOT / "gui/desktop/splash",
)
_JS_ROOT = ROOT / "gui/web/src"
_SRC_ROOT = ROOT / "src"
_PY_CSS_COLOR = re.compile(
    r"(?:^|[{;,\s])(?:color|background(?:-color)?|border-color|fill|stroke)\s*:\s*"
    r"(?:\#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()",
)
_APPROVED = re.compile(r"--\s*user-approved:\s*\S")
_DISABLE = re.compile(r"stylelint-disable(?P<kind>-next-line|-line)?\s+(?P<body>[^;\n*]+)")
_ENABLE = re.compile(r"stylelint-enable(?:\s+(?P<rules>[^;\n*]+))?")
_PX = re.compile(r"(?<![\w.-])(-?\d+(?:\.\d+)?)px\b")
# Sync with gui/web/stylelint.config.js meowtec/no-px ignore ["1px", "-1px"].
_HAIRLINE_PX = 1.0
_VIEWPORT_MEDIA = re.compile(
    r"@media(?:(?!\{).)*\(\s*(?:min-|max-)?(?:width|height)\s*:",
    re.DOTALL,
)
_FONT_62 = re.compile(r"font-size\s*:\s*62\.5%")
_IMPORTANT = re.compile(r"!important", re.IGNORECASE)
_LAYER = re.compile(r"@layer\b")
_JS_STYLE_COLOR = re.compile(
    r"""\b(?:color|background|backgroundColor|borderColor|fill|stroke)\s*:\s*"""
    r"""['"](?:\#|rgba?\(|hsla?\()""",
)
_JS_STYLE_TYPE = re.compile(
    r"""\bfontSize\s*:\s*(?!['"]var\()(?:\d+|['"][^'"]*(?:px|rem|em)['"])""",
)
_JS_STYLE_SPACE = re.compile(
    r"""\b(?P<prop>padding(?:Top|Right|Bottom|Left)?|margin(?:Top|Right|Bottom|Left)?|"""
    r"""gap|rowGap|columnGap|borderRadius)\s*:\s*"""
    r"""(?!['"]var\()(?!0\b)(?!['"]0(?:px)?['"])"""
    r"""(?:\d+|['"][^'"]+)""",
)
# Token tier discipline (see docs/design-tokens.md): primitives are raw
# literals; theme files map primitives onto semantic roles and never author
# raw color. brand-tokens.css is exempt — its copies ship to splash/relay
# static contexts that never load primitives.css, so it stays self-contained.
_PRIMITIVES_CSS = ROOT / "gui/web/src/styles/theme/primitives.css"
_THEME_CSS = (
    ROOT / "gui/web/src/styles/theme/theme-dark.css",
    ROOT / "gui/web/src/styles/theme/theme-light.css",
    ROOT / "gui/web/src/styles/theme/theme-fixed.css",
)
_PARTIALS_DIR = ROOT / "gui/web/src/styles/partials"
_PRIMITIVE_REF = re.compile(r"var\(\s*--primitive-")
_CSS_VAR_REF = re.compile(r"var\(\s*--")
_CSS_HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")
_CSS_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)


def _css_files() -> list[Path]:
    files: list[Path] = []
    for root in _CSS_ROOTS:
        if root.is_dir():
            files.extend(sorted(root.rglob("*.css")))
    return files


def _js_files() -> list[Path]:
    files: list[Path] = []
    for path in sorted(_JS_ROOT.rglob("*.ts")):
        files.append(path)
    for path in sorted(_JS_ROOT.rglob("*.tsx")):
        files.append(path)
    return files


def _split_rules(raw: str | None) -> set[str]:
    if not raw:
        return set()
    return {part.strip() for part in raw.split(",") if part.strip()}


def _code_without_comments(line: str) -> str:
    return re.sub(r"/\*.*?\*/", "", line)


def _scan_css(path: Path) -> list[str]:
    hits: list[str] = []
    rel = path.relative_to(ROOT)
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    block: set[str] = set()
    pending_next: set[str] = set()
    active_at: dict[int, set[str]] = {}
    for i, line in enumerate(lines, 1):
        loc = f"{rel}:{i}"
        code = _code_without_comments(line)
        active = set(block)
        if pending_next:
            active |= pending_next
            pending_next = set()
        for match in _DISABLE.finditer(line):
            body = match.group("body").strip()
            rules_part = body.partition(" -- ")[0]
            rules = _split_rules(rules_part)
            if not _APPROVED.search(line):
                hits.append(
                    f"{loc}: stylelint-disable must include "
                    f"`-- user-approved: reason` ({line.strip()})"
                )
                continue
            kind = match.group("kind")
            if kind == "-next-line":
                pending_next |= rules
            elif kind == "-line":
                active |= rules
            else:
                block |= rules
        for match in _ENABLE.finditer(line):
            rules = _split_rules(match.group("rules"))
            if not rules:
                block.clear()
            else:
                block -= rules
        active_at[i] = set(active)
        if _FONT_62.search(code):
            hits.append(f"{loc}: font-size 62.5% is banned (no exceptions)")
        if _IMPORTANT.search(code) and "declaration-no-important" not in active:
            hits.append(f"{loc}: !important needs `stylelint-disable` + `-- user-approved:`")
        if _LAYER.search(code) and "at-rule-disallowed-list" not in active:
            hits.append(f"{loc}: @layer needs `stylelint-disable` + `-- user-approved:`")
        for px in _PX.finditer(code):
            if abs(float(px.group(1))) == _HAIRLINE_PX:
                continue
            if "meowtec/no-px" not in active:
                hits.append(
                    f"{loc}: `{px.group(0)}` needs "
                    "`stylelint-disable` + `-- user-approved:` "
                    "(or use rem / a theme token)"
                )
    for match in _VIEWPORT_MEDIA.finditer(text):
        line_no = text[: match.start()].count("\n") + 1
        loc = f"{rel}:{line_no}"
        if "media-feature-name-disallowed-list" not in active_at.get(line_no, set()):
            hits.append(
                f"{loc}: viewport-size @media needs `stylelint-disable` + `-- user-approved:`"
            )
    return hits


def test_stylelint_disables_require_user_approved() -> None:
    hits: list[str] = []
    for path in _css_files():
        hits.extend(h for h in _scan_css(path) if "stylelint-disable must include" in h)
    assert not hits, "unapproved Stylelint disables:\n" + "\n".join(hits)


def test_important_and_layer_are_consent_gated() -> None:
    hits: list[str] = []
    for path in _css_files():
        hits.extend(h for h in _scan_css(path) if "!important" in h or "@layer" in h)
    assert not hits, "unapproved !important / @layer:\n" + "\n".join(hits)


def test_viewport_size_media_is_consent_gated() -> None:
    hits: list[str] = []
    for path in _css_files():
        hits.extend(h for h in _scan_css(path) if "viewport-size @media" in h)
    assert not hits, "unapproved viewport-size @media:\n" + "\n".join(hits)


def test_px_outside_hairlines_is_consent_gated() -> None:
    hits: list[str] = []
    for path in _css_files():
        hits.extend(h for h in _scan_css(path) if "px`" in h)
    assert not hits, "unapproved px:\n" + "\n".join(hits)


def test_root_font_size_62_5_percent_banned() -> None:
    hits: list[str] = []
    for path in _css_files():
        hits.extend(h for h in _scan_css(path) if "62.5%" in h)
    assert not hits, "62.5% root font-size:\n" + "\n".join(hits)


def test_js_inline_styles_use_theme_tokens() -> None:
    hits: list[str] = []
    for path in _js_files():
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(ROOT)
        for i, line in enumerate(text.splitlines(), 1):
            if _JS_STYLE_COLOR.search(line):
                hits.append(f"{rel}:{i}: hardcoded color (use var(--…))")
            if _JS_STYLE_TYPE.search(line):
                hits.append(f"{rel}:{i}: hardcoded fontSize (use var(--font-size-*))")
            if _JS_STYLE_SPACE.search(line):
                hits.append(f"{rel}:{i}: hardcoded padding/margin/gap/radius (use var(--space-*))")
    assert not hits, "JS inline style magic numbers:\n" + "\n".join(hits)


def test_viewport_media_regex_spans_newlines() -> None:
    assert _VIEWPORT_MEDIA.search("@media\n  (max-width: 40rem)")
    assert _VIEWPORT_MEDIA.search("@media (max-height: 40rem)")
    assert not _VIEWPORT_MEDIA.search("@media (hover: hover)")


def test_js_inline_space_flags_gap_and_radius() -> None:
    assert _JS_STYLE_SPACE.search("gap: 8")
    assert _JS_STYLE_SPACE.search('borderRadius: "4px"')
    assert _JS_STYLE_SPACE.search("rowGap: 12")
    assert not _JS_STYLE_SPACE.search('gap: "var(--space-1)"')
    assert not _JS_STYLE_SPACE.search('padding: "var(--space-2)"')
    assert not _JS_STYLE_SPACE.search("padding: 0")


def _py_files() -> list[Path]:
    return sorted(p for p in _SRC_ROOT.rglob("*.py") if p.is_file())


def test_python_does_not_author_css_colors() -> None:
    """Embedded HTML/CSS in Python must use var(--…); hex lives in theme CSS files.

    Stylelint never sees relay/splash HTML authored in .py, so this is the gate
    that would have caught ``color:#222`` in ``podcast_relay/app.py``.
    """
    hits: list[str] = []
    for path in _py_files():
        rel = path.relative_to(ROOT)
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if _PY_CSS_COLOR.search(line):
                hits.append(f"{rel}:{i}: hardcoded color in Python (use a .css file + var(--…))")
    assert not hits, "Python-authored CSS colors:\n" + "\n".join(hits)


def test_python_css_color_regex_catches_hex() -> None:
    assert _PY_CSS_COLOR.search("color:#222")
    assert _PY_CSS_COLOR.search("background:#f2f2f2")
    assert not _PY_CSS_COLOR.search("color: var(--color-text-primary)")
    assert not _PY_CSS_COLOR.search("background: var(--color-bg-elevated)")


def _declaration_values(text: str) -> list[tuple[int, str]]:
    """(line_no, value) for each `--prop: value;` declaration, comments stripped."""
    values: list[tuple[int, str]] = []
    code = _CSS_COMMENT.sub("", text)
    for m in re.finditer(r"--[\w-]+\s*:\s*([^;]+);", code):
        line_no = code[: m.start()].count("\n") + 1
        values.append((line_no, m.group(1)))
    return values


def test_primitives_are_raw_values() -> None:
    """Primitive tier: literals only — a primitive referencing var(--…) is a
    semantic token wearing the wrong name."""
    rel = _PRIMITIVES_CSS.relative_to(ROOT)
    hits = [
        f"{rel}:{line}: primitive references var(--…) ({value.strip()[:60]})"
        for line, value in _declaration_values(_PRIMITIVES_CSS.read_text(encoding="utf-8"))
        if _CSS_VAR_REF.search(value)
    ]
    assert not hits, "primitives must be raw values:\n" + "\n".join(hits)


def test_theme_files_use_primitives_not_raw_hex() -> None:
    """Semantic tier: theme-dark/light map primitives onto --color-* roles and
    never author raw hex. (brand-tokens.css is exempt: self-contained mirror.)"""
    hits: list[str] = []
    for path in _THEME_CSS:
        rel = path.relative_to(ROOT)
        text = _CSS_COMMENT.sub("", path.read_text(encoding="utf-8"))
        for i, line in enumerate(text.splitlines(), 1):
            for m in _CSS_HEX.finditer(line):
                hits.append(f"{rel}:{i}: raw {m.group(0)} (use var(--primitive-*))")
    assert not hits, "raw hex in theme files:\n" + "\n".join(hits)


def test_partials_never_read_primitives() -> None:
    """Component tier: partials consume semantic roles only. Reading
    --primitive-* from a partial skips the theme and fixed tiers."""
    hits: list[str] = []
    for path in sorted(_PARTIALS_DIR.rglob("*.css")):
        rel = path.relative_to(ROOT)
        text = _CSS_COMMENT.sub("", path.read_text(encoding="utf-8"))
        for i, line in enumerate(text.splitlines(), 1):
            if _PRIMITIVE_REF.search(line):
                hits.append(f"{rel}:{i}: reads a primitive (map it in a theme file)")
    assert not hits, "partials must not read primitives:\n" + "\n".join(hits)


def test_color_roles_live_in_theme_tier_files() -> None:
    """tokens.css holds scale, layout and composite tokens; every --color-*
    role that maps a primitive lives in theme-dark/light/fixed.css."""
    tokens = ROOT / "gui/web/src/styles/theme/tokens.css"
    text = _CSS_COMMENT.sub("", tokens.read_text(encoding="utf-8"))
    hits = [
        f"{tokens.relative_to(ROOT)}:{i}: {line.strip()[:60]}"
        for i, line in enumerate(text.splitlines(), 1)
        if re.match(r"\s*--color-[\w-]+\s*:", line) and _PRIMITIVE_REF.search(line)
    ]
    assert not hits, "color roles belong in a theme tier file:\n" + "\n".join(hits)


def test_fixed_tier_reads_only_primitives_and_its_own_roles() -> None:
    """theme-fixed.css must look the same in both themes, so it may read only
    primitives and roles it defines itself. A themed role (e.g. the overlay
    whites, which turn dark in light mode) would leak the theme into the
    fixed-dark transport."""
    path = ROOT / "gui/web/src/styles/theme/theme-fixed.css"
    text = _CSS_COMMENT.sub("", path.read_text(encoding="utf-8"))
    defined = set(_CUSTOM_PROP_DEF.findall(text))
    hits = [
        f"{path.relative_to(ROOT)}: reads themed {name}"
        for name in sorted(set(_CUSTOM_PROP_USE.findall(text)))
        if not name.startswith("--primitive-") and name not in defined
    ]
    assert not hits, "fixed tier must not read themed roles:\n" + "\n".join(hits)


def test_tier_regex_helpers() -> None:
    assert _CSS_VAR_REF.search("color: var(--primitive-neutral-900)")
    assert not _CSS_VAR_REF.search("color: #0f0e0c")
    assert _CSS_HEX.search("#0f0e0c")
    assert not _CSS_HEX.search("var(--primitive-neutral-900)")
    assert _PRIMITIVE_REF.search("mask: var(--primitive-black)")
    assert not _PRIMITIVE_REF.search("color: var(--color-text-primary)")
    assert _declaration_values("--a: #fff;\n--b: var(--a);")[0] == (1, "#fff")
    # hex inside comments is not a declaration value
    assert _declaration_values("/* #fff */\n--a: var(--b);") == [(2, "var(--b)")]


_CUSTOM_PROP_DEF = re.compile(r"(--[\w-]+)\s*:")
_CUSTOM_PROP_USE = re.compile(r"var\(\s*(--[\w-]+)")
_TS_PROP_READ = re.compile(r"getPropertyValue\(\s*[\"'](--[\w-]+)[\"']")
_TS_PROP_SET = re.compile(r"[\"'](--[\w-]+)[\"']\s*:|setProperty\(\s*[\"'](--[\w-]+)")
# Template prefixes composed at runtime (e.g. `--presence-${i}`).
_DYNAMIC_PROP_PREFIXES = ("--color-", "--presence-")


def test_studio_references_only_defined_custom_properties() -> None:
    """An undefined var() silently invalidates the whole declaration (#20: dashed
    edit ghosts and the undo toast size never rendered). Every custom property a
    Studio stylesheet or script reads must be defined by a stylesheet or set
    inline by a component."""
    studio = ROOT / "gui/web/src"
    css_files = sorted(studio.rglob("*.css"))
    all_scripts = sorted([*studio.rglob("*.ts"), *studio.rglob("*.tsx")])
    script_files = [
        path for path in all_scripts if ".test." not in path.name and ".stories." not in path.name
    ]
    # Stories render what ships, so their var() reads must resolve too; they
    # never count as defining a property (production doesn't load them).
    story_files = [path for path in all_scripts if ".stories." in path.name]
    defined: set[str] = set()
    for path in css_files:
        defined.update(_CUSTOM_PROP_DEF.findall(_CSS_COMMENT.sub("", path.read_text())))
    for path in script_files:
        for first, second in _TS_PROP_SET.findall(path.read_text()):
            defined.add(first or second)
    missing: list[str] = []
    for path in [*css_files, *script_files, *story_files]:
        text = path.read_text()
        if path.suffix == ".css":
            text = _CSS_COMMENT.sub("", text)
        used = {*_CUSTOM_PROP_USE.findall(text), *_TS_PROP_READ.findall(text)}
        for name in sorted(used - defined):
            # Template reads (`var(--color-bg-${rung})`) capture only a prefix.
            if name.endswith("-") and name.startswith(_DYNAMIC_PROP_PREFIXES):
                continue
            missing.append(f"{path.relative_to(ROOT)}: {name}")
    assert not missing, "undefined custom properties:\n" + "\n".join(missing)
