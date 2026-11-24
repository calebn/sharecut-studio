from __future__ import annotations

import re
from typing import Any

import yaml

TAG = re.compile(r"\{\{[^}\n]*\}\}")
TAG_ONLY_LINE = re.compile(rf"^[ \t]*(?:{TAG.pattern}[ \t]*)+$\n?", re.MULTILINE)


class DuplicateKeyError(yaml.YAMLError):
    """A mapping repeats a key; PyYAML would keep the last one silently."""


class StrictLoader(yaml.SafeLoader):
    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
        seen: set[Any] = set()
        for key_node, _ in node.value:
            key = self.construct_object(key_node, deep=True)
            if key in seen:
                raise DuplicateKeyError(
                    f"duplicate key {key!r} at line {key_node.start_mark.line + 1}"
                )
            seen.add(key)
        return super().construct_mapping(node, deep)


def load_strict(text: str) -> Any:
    return yaml.load(text, Loader=StrictLoader)


def load_template(text: str) -> Any:
    return load_strict(TAG.sub("t", TAG_ONLY_LINE.sub("", text)))
