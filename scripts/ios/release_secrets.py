"""Values the iOS release must never print, and the redactor that keeps them out of every output.

``Secret`` holds a value that cannot be printed, formatted, serialized or pickled. Its value leaves
the type in exactly one place, ``release_run.spawn``; a test walks the syntax trees under
``scripts/ios`` and fails on a second caller. ``Redactor`` turns the secrets and the machine's
private directories (in every spelling ``private_paths.text_forms`` knows) into tokens, line by
line with carry-over so a value split across two reads is still caught, and applies shape rules
for values nobody knows in advance: signing identity names, profile UUIDs, certificate
fingerprints and the ``user:password@`` of a URL.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from pathlib import Path

from scripts.ios.private_paths import text_forms


class Secret:
    __slots__ = ("_value", "label")

    def __init__(self, value: str, label: str) -> None:
        object.__setattr__(self, "_value", value)
        object.__setattr__(self, "label", label)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("a Secret cannot change")

    def __repr__(self) -> str:
        return f"<{self.label}>"

    __str__ = __repr__

    def __format__(self, spec: str) -> str:
        return format(repr(self), spec)

    def __reduce__(self) -> tuple[object, ...]:
        raise TypeError("a Secret cannot be pickled")

    def __copy__(self) -> Secret:
        return self

    def __deepcopy__(self, memo: object) -> Secret:
        return self

    def reveal(self) -> str:
        return self._value

    def redaction_forms(self) -> list[str]:
        return text_forms(self._value)


SHAPE_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(
            r"(?:Apple Distribution|Apple Development|iPhone Distribution|iPhone Developer"
            r"|Developer ID (?:Application|Installer)|3rd Party Mac Developer \w+|Mac Developer)"
            r": [^\n(]*?\([A-Z0-9]{10}\)"
        ),
        "<signing-identity>",
    ),
    (
        re.compile(r"\b[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}\b"),
        "<uuid>",
    ),
    (re.compile(r"\b[0-9A-Fa-f]{40}\b"), "<fingerprint>"),
    (re.compile(r"\b[0-9A-F]{8}-[0-9A-F]{16}\b"), "<device-id>"),
    (re.compile(r"(?<=://)[^\s/@]+@"), "<userinfo>@"),
)
HOLD = 256


class Redactor:
    def __init__(
        self, secrets: Iterable[Secret] = (), directories: Mapping[str, Path | str] = ()
    ) -> None:
        tokens: dict[str, str] = {}
        for name, directory in dict(directories).items():
            for form in text_forms(str(directory)):
                tokens.setdefault(form, f"<{name}>")
        for secret in secrets:
            for form in secret.redaction_forms():
                tokens[form] = repr(secret)
        self._tokens = tokens
        self._pattern = (
            re.compile("|".join(re.escape(n) for n in sorted(tokens, key=len, reverse=True)))
            if tokens
            else None
        )
        self.hold = max((len(n) for n in tokens), default=0) + HOLD

    def redact(self, text: str) -> str:
        if self._pattern is not None:
            text = self._pattern.sub(lambda match: self._tokens[match.group(0)], text)
        for rule, token in SHAPE_RULES:
            text = rule.sub(token, text)
        return text

    def safe_cut(self, text: str, cut: int) -> int:
        """*cut*, moved back to the start of any known value it would split."""
        if self._pattern is not None:
            for match in self._pattern.finditer(text):
                if match.start() < cut < match.end():
                    return match.start()
        return cut

    def stream(self) -> RedactStream:
        return RedactStream(self)

    def exception_line(self, error: BaseException) -> str:
        return self.redact(f"{type(error).__name__}: {error}").replace("\n", " ")


class RedactStream:
    """Redacts text arriving in arbitrary chunks. A line is held until it ends, and a line that
    never ends is held back by the longest needle so a value cut by a read boundary is found."""

    def __init__(self, redactor: Redactor) -> None:
        self._redactor = redactor
        self._carry = ""

    def feed(self, chunk: str) -> str:
        text = self._carry + chunk
        head, newline, tail = text.rpartition("\n")
        emitted = self._redactor.redact(head + newline) if newline else ""
        if len(tail) > self._redactor.hold:
            cut = self._redactor.safe_cut(tail, len(tail) - self._redactor.hold)
            emitted += self._redactor.redact(tail[:cut])
            tail = tail[cut:]
        self._carry = tail
        return emitted

    def finish(self) -> str:
        tail, self._carry = self._carry, ""
        return self._redactor.redact(tail)
