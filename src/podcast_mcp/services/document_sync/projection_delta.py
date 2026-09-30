"""Closed ProjectView section edits. All positions address one sequenced predecessor."""

from __future__ import annotations

import json
from collections import Counter
from difflib import SequenceMatcher
from typing import Any

ROOTS = frozenset(
    [
        "project_path",
        "meta",
        "timeline_duration_sec",
        "tracks",
        "clips",
        "chapters",
        "pending_edits",
        "edit_boundaries",
        "applied_edits",
        "effects_by_track",
        "envelopes",
        "social_clips",
        "comments",
        "render_status",
        "edit_impact",
        "history",
        "transcript",
    ]
)
LISTS = frozenset(
    [
        "tracks",
        "chapters",
        "pending_edits",
        "edit_boundaries",
        "envelopes",
        "social_clips",
        "comments",
    ]
)
GROUPS = {
    "clips": ("tracks",),
    "applied_edits": ("records",),
    "effects_by_track": (),
    "render_status": ("tracks", "invalidations"),
    "edit_impact": ("segments",),
    "history": ("groups", "entries"),
    "transcript": ("utterances",),
}
COLLECTIONS = LISTS | frozenset(
    [
        "clip_rows",
        "effect_rows",
        "render_tracks",
        "invalidations",
        "impact_segments",
        "history_groups",
        "history_entries",
        "utterances",
        "applied_records",
    ]
)
PARENTS = {
    "clip_rows": "clips",
    "effect_rows": "effects_by_track",
    "render_tracks": "render_status",
    "invalidations": "render_status",
    "impact_segments": "edit_impact",
    "history_groups": "history",
    "history_entries": "history",
    "utterances": "transcript",
    "applied_records": "applied_edits",
}
MEMBERS = {
    "records": "applied_records",
    "invalidations": "invalidations",
    "segments": "impact_segments",
    "groups": "history_groups",
    "entries": "history_entries",
    "utterances": "utterances",
}


def split(view: dict[str, Any]) -> dict[tuple[str, str | None], Any]:
    if set(view) - ROOTS:
        raise ValueError(f"Unknown projection fields: {set(view) - ROOTS}")
    sections: dict[tuple[str, str | None], Any] = {}
    for root, value in view.items():
        if root not in GROUPS or value is None:
            sections[(root, None)] = value
            continue
        if root == "effects_by_track":
            sections[(root, None)] = {}
            for key, rows in value.items():
                sections[("effect_rows", key)] = rows
            continue
        sections[(root, None)] = {k: v for k, v in value.items() if k not in GROUPS[root]}
        for member in GROUPS[root]:
            if member not in value:
                continue
            part = value[member]
            if member == "tracks":
                if root == "clips":
                    # Preserve even an empty map.
                    sections[("clips", None)]["tracks"] = {}
                    for key, rows in part.items():
                        sections[("clip_rows", key)] = rows
                else:
                    sections[("render_tracks", None)] = [
                        {"key": k, "value": v} for k, v in part.items()
                    ]
            else:
                sections[(MEMBERS[member], None)] = part
    return sections


def fingerprint(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def match_key(section: str, row: dict[str, Any]) -> Any:
    if section == "utterances":
        words = row.get("words")
        if words:

            def raw_key(word: dict[str, Any]) -> str:
                return fingerprint(word.get("timing_target", word.get("word_index")))

            return (row["track_id"], "raw-range", raw_key(words[0]), raw_key(words[-1]))
        return (row["track_id"], "source-window", row["start"], row["end"])
    if section == "envelopes":
        return (row["track_id"], row["parameter"])
    if section == "render_tracks":
        return row["key"]
    if section == "history_groups":
        if row.get("id") is not None:
            return ("snapshot", row["id"])
        if row.get("before_id") and row.get("after_id"):
            return ("mutation", row["before_id"], row["after_id"])
    if isinstance(row, dict) and row.get("id") is not None:
        return row["id"]
    return fingerprint(row)


def splice(before: Any, after: Any) -> dict[str, Any]:
    left = 0
    while left < min(len(before), len(after)) and before[left] == after[left]:
        left += 1
    right = 0
    while (
        right < min(len(before) - left, len(after) - left)
        and before[-1 - right] == after[-1 - right]
    ):
        right += 1
    return {
        "index": left,
        "delete": len(before) - left - right,
        "insert": after[left : len(after) - right if right else None],
    }


def row_update(section: str, before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    if section == "envelopes":
        return {
            "set": {k: v for k, v in after.items() if k != "points" and before.get(k) != v},
            "unset": [k for k in before if k not in after],
            "point_edits": list_delta("points", before.get("points", []), after.get("points", [])),
        }
    if section != "utterances":
        return {"value": after}
    # Words and text are the only large fields on an utterance row.
    headers = {k: v for k, v in after.items() if k not in ("words", "text") and before.get(k) != v}
    deleted = [k for k in before if k not in after]
    op: dict[str, Any] = {"set": headers, "unset": deleted}
    if before.get("text") != after.get("text"):
        # Wire indices count Unicode scalar values, not UTF-16 code units.
        op["text"] = splice(before.get("text", ""), after.get("text", ""))
    if before.get("words") != after.get("words") and "words" in after:
        op["words"] = splice(before.get("words", []), after["words"])
        op["requires_words"] = "words" in before
        op["word_count"] = len(before.get("words", []))
    return op


def inserted_utterance(
    row: dict[str, Any],
    previous: list[dict[str, Any]],
    positions: dict[str, tuple[int, int]],
    text_budget: list[int],
) -> dict[str, Any]:
    encoded: dict[str, Any] = {
        "header": {k: v for k, v in row.items() if k not in ("words", "text")}
    }
    text = row.get("text", "")
    encoded["text"] = {"literal": text}
    for index, prior in enumerate(previous):
        prior_text = prior.get("text", "")
        text_budget[0] -= len(prior_text)
        if text_budget[0] < 0:
            break
        offset = prior_text.find(text)
        if text and offset >= 0:
            encoded["text"] = {"row": index, "index": offset, "count": len(text)}
            break
    if "words" in row:
        parts: list[dict[str, Any]] = []
        for word in row["words"]:
            found = positions.get(fingerprint(word))
            if found:
                ri, wi = found
                if (
                    parts
                    and parts[-1].get("row") == ri
                    and parts[-1]["index"] + parts[-1]["count"] == wi
                ):
                    parts[-1]["count"] += 1
                else:
                    parts.append({"row": ri, "index": wi, "count": 1})
            elif parts and "literal" in parts[-1]:
                parts[-1]["literal"].append(word)
            else:
                parts.append({"literal": [word]})
        encoded["words"] = parts
    return encoded


def list_delta(
    section: str, before: list[dict[str, Any]], after: list[dict[str, Any]]
) -> dict[str, Any]:
    keys_before = [match_key(section, row) for row in before]
    keys_after = [match_key(section, row) for row in after]
    left = 0
    while left < min(len(keys_before), len(keys_after)) and keys_before[left] == keys_after[left]:
        left += 1
    right = 0
    while (
        right < min(len(keys_before) - left, len(keys_after) - left)
        and keys_before[-1 - right] == keys_after[-1 - right]
    ):
        right += 1
    old_end = len(before) - right
    new_end = len(after) - right
    codes = [("equal", 0, left, 0, left)]
    middle_before, middle_after = keys_before[left:old_end], keys_after[left:new_end]
    counts_before, counts_after = Counter(middle_before), Counter(middle_after)
    match_work = sum(count * counts_after[key] for key, count in counts_before.items())
    if match_work > 1_000_000:
        codes.append(("replace", left, old_end, left, new_end))
    else:
        matcher = SequenceMatcher(None, middle_before, middle_after, autojunk=False)
        codes.extend(
            (tag, i + left, j + left, x + left, y + left)
            for tag, i, j, x, y in matcher.get_opcodes()
        )
    codes.append(("equal", old_end, len(before), new_end, len(after)))
    positions: dict[str, tuple[int, int]] = {}
    if section == "utterances":
        for ri, prior in enumerate(before):
            for wi, word in enumerate(prior.get("words", [])):
                positions.setdefault(fingerprint(word), (ri, wi))
    text_budget = [2_000_000]
    splices = []
    updates = []
    for tag, i, j, x, y in codes:
        if tag == "equal":
            for a, b in zip(range(i, j), range(x, y), strict=True):
                if before[a] != after[b]:
                    updates.append({"index": b, **row_update(section, before[a], after[b])})
        else:
            splices.append(
                {
                    "index": i,
                    "delete": j - i,
                    "insert": [
                        inserted_utterance(row, before, positions, text_budget)
                        for row in after[x:y]
                    ]
                    if section == "utterances"
                    else after[x:y],
                }
            )
    return {
        "before_count": len(before),
        "splices": splices,
        "updates": updates,
        **({"row_encoding": "predecessor-spans"} if section == "utterances" else {}),
    }


def diff_projection(before: dict[str, Any], after: dict[str, Any]) -> list[dict[str, Any]]:
    old, new = split(before), split(after)
    ops = []
    for key, value in new.items():
        if key in old and old[key] == value:
            continue
        section, parent = key
        if key in old and section in COLLECTIONS:
            ops.append(
                {
                    "type": "rows",
                    "section": section,
                    "parent": parent,
                    **list_delta(section, old[key], value),
                }
            )
        else:
            ops.append({"type": "replace", "section": section, "parent": parent, "value": value})
    for section, parent in old.keys() - new.keys():
        root = PARENTS.get(section, section)
        if root in after:
            ops.append({"type": "remove", "section": section, "parent": parent})
    return ops
