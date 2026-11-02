from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from typing import Any

from pydantic import BaseModel


def _is_dataclass_instance(value: Any) -> bool:
    return is_dataclass(value) and not isinstance(value, type)


def _plain(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if _is_dataclass_instance(value):
        return asdict(value)
    return value


def to_json(data: Any, *, indent: int | None = 2) -> str:
    if isinstance(data, BaseModel):
        return data.model_dump_json(indent=indent)
    if _is_dataclass_instance(data):
        return json.dumps(asdict(data), indent=indent, default=str)
    if (
        isinstance(data, list)
        and data
        and (isinstance(data[0], BaseModel) or _is_dataclass_instance(data[0]))
    ):
        return json.dumps([_plain(x) for x in data], indent=indent, default=str)
    return json.dumps(data, indent=indent, default=str)
