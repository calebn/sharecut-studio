"""Read the access-log redaction rules out of the relay Caddyfiles and apply them.

Caddy's regexp log filter calls Go's Regexp.ReplaceAllString, so the replacement
follows Go's Expand rules (`$1X` names the group "1X", not group 1 then "X").
`expand` emulates those rules on top of Python's `re`.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CADDYFILES = ("deploy/relay/Caddyfile.prod", "deploy/relay/Caddyfile.local")
FIELDS = ("request>uri", "request>headers>Referer", "resp_headers>Location")

_RULE_RE = re.compile(r"^\s*(\S+) regexp (\S+) (\S+)\s*$", re.MULTILINE)
_NON_RE2 = re.compile(r"\(\?<?[=!]|\\[1-9]|\(\?P=")


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def log_block(text: str) -> str:
    """Return the `log { ... }` block (the (token_logs) snippet body or the inline block)."""
    lines = text.splitlines(keepends=True)
    start = next(i for i, line in enumerate(lines) if line.strip() == "log {")
    depth = 0
    for end in range(start, len(lines)):
        depth += lines[end].count("{") - lines[end].count("}")
        if depth == 0:
            return "".join(lines[start : end + 1])
    raise AssertionError("unterminated log block")


def rules(text: str) -> dict[str, tuple[str, str]]:
    return {field: (pat, repl) for field, pat, repl in _RULE_RE.findall(log_block(text))}


def expand(template: str, match: re.Match[str]) -> str:
    """Go's Regexp.Expand: `$name` takes the longest run of letters, digits and `_`."""
    out: list[str] = []
    i = 0
    while i < len(template):
        char = template[i]
        if char != "$":
            out.append(char)
            i += 1
            continue
        i += 1
        if i < len(template) and template[i] == "$":
            out.append("$")
            i += 1
            continue
        if i < len(template) and template[i] == "{":
            close = template.find("}", i)
            name = template[i + 1 : close]
            i = close + 1
        else:
            j = i
            while j < len(template) and (template[j].isalnum() or template[j] == "_"):
                j += 1
            name = template[i:j]
            i = j
        if not name:
            out.append("$")
            continue
        if name.isdigit():
            index = int(name)
            value = match.group(index) if index <= match.re.groups else None
        else:
            value = match.groupdict().get(name)
        out.append(value or "")
    return "".join(out)


def apply(rule_set: dict[str, tuple[str, str]], field: str, value: str) -> str:
    pattern, replacement = rule_set[field]
    assert not _NON_RE2.search(pattern), "pattern uses syntax RE2 does not support"
    return re.sub(pattern, lambda m: expand(replacement, m), value)
