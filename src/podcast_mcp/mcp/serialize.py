from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from typing import Any

from pydantic import BaseModel


def to_json(data: Any, *, indent: int | None = 2) -> str:
    if isinstance(data, BaseModel):
        return data.model_dump_json(indent=indent)
    if is_dataclass(data) and not isinstance(data, type):
        return json.dumps(asdict(data), indent=indent)
    if isinstance(data, list) and data and is_dataclass(data[0]):
        return json.dumps([asdict(x) for x in data], indent=indent)
    if isinstance(data, list) and data and isinstance(data[0], BaseModel):
        return json.dumps([x.model_dump() for x in data], indent=indent)
    return json.dumps(data, indent=indent, default=str)
