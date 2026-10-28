from __future__ import annotations

import random
from pathlib import Path

import pytest

from podcast_mcp.engines import audio as audio_module
from podcast_mcp.engines.audio import (
    At,
    Audio,
    CrossfadeAudio,
    GainRamp,
    MaskAudio,
    MixAudio,
    OffSpeakerAudio,
    PlacedSource,
    SequenceAudio,
    SilenceAudio,
    SourceAudio,
    fade_duration,
    placed_sources,
    postorder,
)


def duration(audio: Audio) -> float:
    """Frozen copy of the whole-subtree duration walk."""
    durations: list[float] = []
    for node in postorder(audio):
        match node:
            case SourceAudio():
                durations.append(node.src_end - node.src_start)
            case SequenceAudio():
                child_count = len(node.tail) + 1
                child_durations = durations[-child_count:]
                del durations[-child_count:]
                durations.append(sum(child_durations))
            case CrossfadeAudio():
                right = durations.pop()
                left = durations.pop()
                durations.append(left + right - node.overlap_sec)
            case MixAudio():
                ats = (node.head, *node.tail)
                child_durations = durations[-len(ats) :]
                del durations[-len(ats) :]
                durations.append(
                    max(
                        at.start_sec + child_duration
                        for at, child_duration in zip(ats, child_durations, strict=True)
                    )
                )
            case SilenceAudio():
                durations.append(node.duration_sec)
            case MaskAudio() | OffSpeakerAudio():
                pass
    return durations[0]


def oracle_placed_sources(audio: Audio, *, crossfade_curve: str) -> list[PlacedSource]:
    """Frozen copy of the placement walk that re-measures every subtree it visits."""
    result: list[PlacedSource] = []

    def visit(node: Audio, at: float, ramps: tuple[GainRamp, ...]) -> None:
        match node:
            case SourceAudio():
                length = duration(node)
                own = []
                if node.fade_in_sec > 0:
                    own.append(
                        GainRamp(at, at + fade_duration(length, node.fade_in_sec), True, "tri")
                    )
                if node.fade_out_sec > 0:
                    own.append(
                        GainRamp(
                            at + length - fade_duration(length, node.fade_out_sec),
                            at + length,
                            False,
                            "tri",
                        )
                    )
                result.append(
                    PlacedSource(
                        node,
                        at,
                        tuple(r for r in (*ramps, *own) if r.start < at + length and r.end > at),
                    )
                )
            case SequenceAudio():
                for child in (node.head, *node.tail):
                    visit(child, at, ramps)
                    at += duration(child)
            case CrossfadeAudio():
                seam = at + duration(node.left)
                visit(
                    node.left,
                    at,
                    (*ramps, GainRamp(seam - node.overlap_sec, seam, False, crossfade_curve)),
                )
                visit(
                    node.right,
                    seam - node.overlap_sec,
                    (*ramps, GainRamp(seam - node.overlap_sec, seam, True, crossfade_curve)),
                )
            case MixAudio():
                for placed in (node.head, *node.tail):
                    visit(placed.audio, at + placed.start_sec, ramps)
            case SilenceAudio():
                pass
            case MaskAudio() | OffSpeakerAudio():
                visit(node.body, at, ramps)

    visit(audio, 0.0, ())
    return result


def _float(rng: random.Random) -> float:
    return rng.choice([0.0, 0.001, 0.1, 1 / 3, 0.7, 1.0]) + rng.random() * rng.choice([0.01, 1, 30])


def _leaf(rng: random.Random, index: int) -> Audio:
    if rng.random() < 0.15:
        return SilenceAudio(_float(rng))
    start = _float(rng)
    return SourceAudio(
        Path(f"s{rng.randrange(3)}.wav"),
        start,
        start + _float(rng) + 0.001,
        fade_in_sec=rng.choice([0.0, 0.0, 0.005, 0.05, 0.4, 2.0]),
        fade_out_sec=rng.choice([0.0, 0.0, 0.005, 0.05, 0.4, 2.0]),
        clip_id=f"c{index}",
    )


def _tree(rng: random.Random, depth: int, counter: list[int]) -> Audio:
    counter[0] += 1
    if depth == 0 or rng.random() < 0.2:
        return _leaf(rng, counter[0])
    kind = rng.choice(["seq", "seq", "xfade", "xfade", "mix", "mask", "off"])
    if kind == "seq":
        children = [_tree(rng, depth - 1, counter) for _ in range(rng.randint(1, 5))]
        return SequenceAudio(children[0], tuple(children[1:]))
    if kind == "xfade":
        left = _tree(rng, depth - 1, counter)
        right = _tree(rng, depth - 1, counter)
        shorter = min(duration(left), duration(right))
        return CrossfadeAudio(left, right, rng.choice([0.0, 0.5, 1.0]) * shorter * rng.random())
    if kind == "mix":
        ats = [At(_float(rng), _tree(rng, depth - 1, counter)) for _ in range(rng.randint(1, 4))]
        return MixAudio(ats[0], tuple(ats[1:]))
    body = _tree(rng, depth - 1, counter)
    if kind == "mask":
        return MaskAudio(body, _float(rng), ((0.1, 0.2),))
    primary = next(
        (n for n in postorder(body) if isinstance(n, SourceAudio)),
        _leaf(rng, counter[0]),
    )
    return OffSpeakerAudio(body, primary, ())


def _chain(rng: random.Random, length: int) -> Audio:
    node: Audio = _leaf(rng, 0)
    for index in range(length):
        sibling = _leaf(rng, index + 1)
        node = rng.choice(
            [
                SequenceAudio(node, (sibling,)),
                CrossfadeAudio(node, sibling, 0.0),
                MixAudio(At(_float(rng), node), (At(_float(rng), sibling),)),
                MaskAudio(node, 0.0, ()),
            ]
        )
    return node


@pytest.mark.parametrize("curve", ["tri", "qsin"])
def test_placed_sources_match_the_remeasuring_oracle_exactly(curve: str) -> None:
    rng = random.Random(2359)
    compared = 0
    for case in range(400):
        tree = _tree(rng, rng.randint(1, 6), [0])
        assert placed_sources(tree, crossfade_curve=curve) == oracle_placed_sources(
            tree, crossfade_curve=curve
        ), case
        compared += 1
    for length in (1, 7, 40):
        tree = _chain(rng, length)
        assert placed_sources(tree, crossfade_curve=curve) == oracle_placed_sources(
            tree, crossfade_curve=curve
        )
    assert compared == 400


def test_placed_sources_floats_are_bit_identical() -> None:
    rng = random.Random(77)
    for _ in range(200):
        tree = _tree(rng, 6, [0])
        new = placed_sources(tree, crossfade_curve="tri")
        old = oracle_placed_sources(tree, crossfade_curve="tri")
        assert [
            (
                p.timeline_start.hex(),
                [(r.start.hex(), r.end.hex(), r.rising, r.curve) for r in p.ramps],
            )
            for p in new
        ] == [
            (
                p.timeline_start.hex(),
                [(r.start.hex(), r.end.hex(), r.rising, r.curve) for r in p.ramps],
            )
            for p in old
        ]


def test_placed_sources_measures_each_subtree_once() -> None:
    tree = _chain(random.Random(5), 60)
    steps = 0
    real = audio_module.postorder

    def counting(node: Audio):
        nonlocal steps
        for item in real(node):
            steps += 1
            yield item

    audio_module.postorder = counting
    try:
        placed_sources(tree, crossfade_curve="tri")
    finally:
        audio_module.postorder = real
    assert steps <= 2 * sum(1 for _ in real(tree))
