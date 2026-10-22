from __future__ import annotations

import json
import os
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

import multistream_media as media
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import play_audit, timeline_render, transcript_gated_play
from podcast_mcp.engines import source_proxy_audio as proxy
from podcast_mcp.engines.bleed_gate import BleedGatePlan
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import (
    Clip,
    ClipBleedRestore,
    ClipMuteRegion,
    ClipOffSpeakerMuteRegion,
    EpisodeProject,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
)
from podcast_mcp.models.episode import (
    RoomToneFill,
    SourceRecording,
    SourceSpan,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.hashing import sha256_file, short_digest
from podcast_mcp.util.wav import open_wav


def _write(path: Path, rate=44100, hz=431):
    t = np.arange(2 * rate) / rate
    values = np.round(
        13000 * np.column_stack((np.sin(t * 2 * np.pi * hz), np.sin(t * 2 * np.pi * (hz + 79))))
    ).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(values.tobytes())


def _read(path):
    with open_wav(path) as f:
        return f.getframerate(), np.frombuffer(f.readframes(f.getnframes()), "<i2").reshape(
            -1, f.getnchannels()
        ).copy()


def _project(tmp_path, monkeypatch, effect="raw", ordinary="none", unity=False):
    _write(tmp_path / "source.wav")
    p = EpisodeProject.create("Proxy", str(tmp_path))
    track = Track(
        id="origin", label="Origin", media=MediaAsset(path="source.wav"), transcript_gate=True
    )
    p.tracks = [track]
    clip = Clip(
        id="selected",
        track_id="origin",
        source_start=0.20381,
        source_end=1.27391,
        timeline_start=7.35,
        fade_in_ms=250,
        fade_out_ms=350,
    )
    clip.off_speaker_mute_regions = [
        ClipOffSpeakerMuteRegion(start_s=0.15, end_s=1.7, fade_out_ms=80, fade_in_ms=60)
    ]
    clip.bleed_restore = ClipBleedRestore(
        source_sha256=sha256_file(tmp_path / "source.wav"),
        regions=[SourceSpan(start_s=0.45, end_s=0.9)],
    )
    if ordinary in ["hard", "lower", "room"]:
        clip.mute_regions = [
            ClipMuteRegion(
                start_s=0.1,
                end_s=1.8,
                fade_in_ms=0,
                fade_out_ms=0,
                gain_db=-12 if ordinary == "lower" else None,
            )
        ]
    if ordinary == "room":
        _write(tmp_path / "room.wav", rate=48000, hz=257)
        p.sources = [SourceRecording(id="room", path="room.wav")]
        clip.mute_regions[0].fill = RoomToneFill(source_id="room", start_s=1.6, end_s=1.8)
    if ordinary == "ignored":
        p.transcripts = [
            Transcript(
                track_id="origin",
                words=[TranscriptWord(text="ignored", start=0.1, end=1.8, ignored=True)],
            )
        ]
    p.clips = [
        clip,
        clip.model_copy(update={"id": "other", "timeline_start": 10.0, "bleed_restore": None}),
    ]
    if effect != "raw":
        fx = (
            ProcessingEffect(effect="acompressor", params={"threshold_db": -24, "ratio": 8})
            if effect == "compressor"
            else ProcessingEffect(effect="loudnorm")
        )
        p.processing_chains = [ProcessingChain(track_id="origin", effects=[fx])]
    plan = BleedGatePlan(attenuation_spans=() if unity else ((0.05, 1.95),), fade_sec=0.02)
    monkeypatch.setattr(proxy, "build_bleed_gate_plan", lambda *_a, **_k: plan)
    monkeypatch.setattr(transcript_gated_play, "build_bleed_gate_plan", lambda *_a, **_k: plan)
    return p, track, clip, plan


@pytest.mark.parametrize("effect", ["raw", "compressor", "loudnorm"])
@pytest.mark.parametrize("ordinary", ["none", "hard", "lower", "ignored", "room"])
def test_continuous_prepared_proxy_is_bounded(tmp_path, monkeypatch, effect, ordinary):
    p, track, clip, plan = _project(tmp_path, monkeypatch, effect, ordinary)
    legacy = tmp_path / "legacy.wav"
    timeline_render.render_source_with_chain(p, track, legacy, defaults=load_defaults())
    baseline_hash = sha256_file(legacy)
    pair = {}
    real = proxy._render_pair

    def capture(*args, **kwargs):
        w, v, clock = real(*args, **kwargs)
        pair.update(w=_read(w)[1], v=_read(v)[1], clock=clock)
        return w, v, clock

    monkeypatch.setattr(proxy, "_render_pair", capture)
    target = tmp_path / "variant.wav"
    proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    rate, y = _read(target)
    b = _read(legacy)[1]
    clock = pair["clock"]
    native = clock.native.audio.sample_rate

    def mapped(frame):
        for a, z in [
            (native, clock.producer.sample_rate),
            (clock.producer.sample_rate, clock.consumer.sample_rate),
            (clock.consumer.sample_rate, rate),
        ]:
            frame = (frame * z + a // 2) // a
        return frame

    lo, hi = mapped(int(np.ceil(0.45 * native))), mapped(int(np.ceil(0.9 * native)))
    n = np.arange(len(y))
    member = (n >= lo) & (n < hi)
    h = np.zeros(len(y))
    fade = min(round(0.02 * rate), (hi - lo) // 2)
    h[member] = np.minimum(1, np.minimum((n[member] - lo) / fade, (hi - 1 - n[member]) / fade))
    g = plan.gains_for_frames(0, len(y), rate)
    expected = np.clip(
        b.astype(float)
        + ((1 - g) * h)[:, None] * (pair["w"].astype(float) - pair["v"].astype(float)),
        -32768,
        32767,
    ).astype("<i2")
    np.testing.assert_array_equal(y, expected)
    np.testing.assert_array_equal(y[~member], b[~member])
    assert sha256_file(legacy) == baseline_hash
    assert p.clips[1].bleed_restore is None
    if ordinary in ["hard", "ignored"]:
        np.testing.assert_array_equal(y, b)
    else:
        assert np.any(y != b)
    assert not list(tmp_path.glob(".source-proxy-*"))


def test_secondary_before_unity_and_inactive_choice(tmp_path, monkeypatch):
    p, track, clip, _ = _project(tmp_path, monkeypatch, unity=True)
    _write(tmp_path / "wrong.wav", hz=991)
    track.media = MediaAsset(path="wrong.wav")
    p.sources = [SourceRecording(id="secondary", path="source.wav")]
    clip.source_id = "secondary"
    expected = tmp_path / "expected.wav"
    timeline_render.render_source_with_chain(
        p, track, expected, selected_source_path=tmp_path / "source.wav", defaults=load_defaults()
    )
    target = tmp_path / "variant.wav"
    monkeypatch.setattr(
        proxy, "_render_pair", lambda *_a, **_k: pytest.fail("Unity retains selected B0")
    )
    proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    assert target.read_bytes() == expected.read_bytes()
    assert track.media.path == "wrong.wav"
    _write(tmp_path / "source.wav", hz=997)
    timeline_render.render_source_with_chain(
        p, track, expected, selected_source_path=tmp_path / "source.wav", defaults=load_defaults()
    )
    proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    assert target.read_bytes() == expected.read_bytes()
    clip.bleed_restore = None
    timeline_render.render_source_with_chain(p, track, expected, defaults=load_defaults())
    proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    assert target.read_bytes() == expected.read_bytes()


def test_nonempty_zero_db_gate_is_exact_noop(tmp_path, monkeypatch):
    p, track, clip, _ = _project(tmp_path, monkeypatch)
    plan = BleedGatePlan(attenuation_spans=((0.05, 1.95),), reduction="attenuate", attenuation_db=0)
    monkeypatch.setattr(proxy, "build_bleed_gate_plan", lambda *_a, **_k: plan)
    monkeypatch.setattr(transcript_gated_play, "build_bleed_gate_plan", lambda *_a, **_k: plan)
    expected = tmp_path / "expected.wav"
    timeline_render.render_source_with_chain(p, track, expected, defaults=load_defaults())
    monkeypatch.setattr(
        proxy, "_render_pair", lambda *_a, **_k: pytest.fail("Unity plan needs no private FX")
    )
    target = tmp_path / "variant.wav"
    proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    assert target.read_bytes() == expected.read_bytes()


def test_malformed_real_clock_retains_output(tmp_path, monkeypatch):
    p, _, clip, _ = _project(tmp_path, monkeypatch)
    target = tmp_path / "variant.wav"
    target.write_bytes(b"complete old artifact")
    real = proxy._observations

    def damage(graph, stderr, formats):
        if "body" in formats:
            text = stderr.read_text()
            stderr.write_text(text.replace("rate:44100 nb_samples:", "rate:0 nb_samples:", 1))
        return real(graph, stderr, formats)

    monkeypatch.setattr(proxy, "_observations", damage)
    with pytest.raises(CodedValueError):
        proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    assert target.read_bytes() == b"complete old artifact"


@pytest.mark.parametrize("failure", ["media", "project", "clock", "extent"])
def test_failure_keeps_previous_output(tmp_path, monkeypatch, failure):
    p, _, clip, _ = _project(tmp_path, monkeypatch)
    target = tmp_path / "variant.wav"
    target.write_bytes(b"previous complete artifact")
    real = proxy._render_pair

    def damage(*args, **kwargs):
        w, v, clock = real(*args, **kwargs)
        if failure == "media":
            _write(tmp_path / "source.wav", hz=997)
        elif failure == "project":
            p.clips[0].source_start = 0.3
        elif failure == "extent":
            with v.open("r+b") as stream:
                stream.truncate(v.stat().st_size - 2)
        else:
            raise CodedValueError("Malformed clock", code="bleed_restore_clock_invalid")
        return w, v, clock

    monkeypatch.setattr(proxy, "_render_pair", damage)
    with pytest.raises(CodedValueError):
        proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    assert target.read_bytes() == b"previous complete artifact"
    assert not list(tmp_path.glob(".source-proxy-*"))


def test_aac_actual_decoder_extent(tmp_path, monkeypatch):
    p, track, clip, _ = _project(tmp_path, monkeypatch, effect="loudnorm")
    engine = FFmpegEngine()
    encoded = tmp_path / "source.aac"
    subprocess.run(
        [
            engine.ffmpeg,
            "-v",
            "error",
            "-y",
            "-i",
            str(tmp_path / "source.wav"),
            "-c:a",
            "aac",
            "-f",
            "adts",
            str(encoded),
        ],
        check=True,
        capture_output=True,
    )
    shutil.copyfile(encoded, tmp_path / "source.wav")
    clip.bleed_restore.source_sha256 = sha256_file(tmp_path / "source.wav")
    target = tmp_path / "variant.wav"
    proxy.render_source_proxy_restore(p, clip.id, target, engine=engine, defaults=load_defaults())
    legacy = tmp_path / "legacy.wav"
    timeline_render.render_source_with_chain(
        p, track, legacy, engine=engine, defaults=load_defaults()
    )
    assert _read(target)[1].shape == _read(legacy)[1].shape


@pytest.mark.parametrize("effect", ["raw", "compressor", "loudnorm"])
@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("split", [False, True])
def test_saved_joint_anchors_with_filled_fades(tmp_path, monkeypatch, effect, rate, split):
    p, track, clip, plan = _project(tmp_path, monkeypatch, effect, "room")
    _write(tmp_path / "source.wav", rate=rate)
    _write(tmp_path / "gate.wav", rate=48000 if rate == 44100 else 44100, hz=137)
    monkeypatch.setattr(
        timeline_render, "current_gate_fill_path", lambda *_a: tmp_path / "gate.wav"
    )
    clip.source_start = 0.70381 if split else 0.20381
    clip.mute_regions[0].start_s = 0.35
    clip.mute_regions[0].end_s = 1.1
    clip.mute_regions[0].fade_in_ms = 120
    clip.mute_regions[0].fade_out_ms = 120
    clip.bleed_restore.source_sha256 = sha256_file(tmp_path / "source.wav")
    clip.bleed_restore.regions = [
        SourceSpan(start_s=0.15, end_s=1.45),
        SourceSpan(start_s=0.6, end_s=0.9),
    ]
    legacy = tmp_path / "legacy.wav"
    timeline_render.render_source_with_chain(p, track, legacy, defaults=load_defaults())
    target = tmp_path / "variant.wav"
    captured = {}
    real = proxy._combine

    def combine(b, w, v, spec, clock):
        captured.update(b=_read(b)[1], w=_read(w)[1], v=_read(v)[1], clock=clock)
        return real(b, w, v, spec, clock)

    monkeypatch.setattr(proxy, "_combine", combine)
    proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    output_rate, y = _read(target)
    clock = captured["clock"]
    native = clock.native.audio.sample_rate

    def mapped(n):
        for before, after in [
            (native, clock.producer.sample_rate),
            (clock.producer.sample_rate, clock.consumer.sample_rate),
            (clock.consumer.sample_rate, output_rate),
        ]:
            n = (n * after + before // 2) // before
        return n

    start = (int(clip.source_start * 1e6 + 1e-6) * native + 500000) // 1000000
    end = (int(clip.source_end * 1e6 + 1e-6) * native + 500000) // 1000000
    n = np.arange(len(y))
    h = np.zeros(len(y))
    member = np.zeros(len(y), dtype=bool)
    for region in clip.bleed_restore.regions:
        lo, hi = (
            mapped(int(np.ceil(region.start_s * native))),
            mapped(int(np.ceil(region.end_s * native))),
        )
        selected = (n >= max(mapped(start), lo)) & (n < min(mapped(end), hi))
        fade = min(round(0.02 * output_rate), (hi - lo) // 2)
        values = np.minimum(1, np.minimum((n[selected] - lo) / fade, (hi - 1 - n[selected]) / fade))
        h[selected] = np.maximum(h[selected], values)
        member |= selected
    assert h[mapped(start)] == 1
    g = plan.gains_for_frames(0, len(y), output_rate)
    expected = np.clip(
        captured["b"].astype(float)
        + ((1 - g) * h)[:, None] * (captured["w"].astype(float) - captured["v"].astype(float)),
        -32768,
        32767,
    ).astype("<i2")
    np.testing.assert_array_equal(y, expected)
    np.testing.assert_array_equal(y[~member], _read(legacy)[1][~member])


def test_peer_recording_change_refuses_publication(tmp_path, monkeypatch):
    p, _, clip, _ = _project(tmp_path, monkeypatch)
    _write(tmp_path / "peer.wav", hz=887)
    p.tracks.append(Track(id="peer", label="Peer", media=MediaAsset(path="peer.wav")))
    render = proxy.render_source_with_chain

    def changed(*args, **kwargs):
        result = render(*args, **kwargs)
        _write(tmp_path / "peer.wav", hz=991)
        return result

    monkeypatch.setattr(proxy, "render_source_with_chain", changed)
    target = tmp_path / "variant.wav"
    target.write_bytes(b"old complete variant")
    with pytest.raises(CodedValueError):
        proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    assert target.read_bytes() == b"old complete variant"


def test_peer_recording_cannot_be_output(tmp_path, monkeypatch):
    p, _, clip, _ = _project(tmp_path, monkeypatch)
    peer = tmp_path / "peer.wav"
    _write(peer, hz=887)
    p.tracks.append(Track(id="peer", label="Peer", media=MediaAsset(path="peer.wav")))
    before = peer.read_bytes()
    with pytest.raises(ValueError, match="must not replace"):
        proxy.render_source_proxy_restore(p, clip.id, peer, defaults=load_defaults())
    assert peer.read_bytes() == before


@pytest.mark.parametrize("ordinary", ["none", "room"])
def test_zero_raw_source_retains_prepared_fill(tmp_path, monkeypatch, ordinary):
    p, track, clip, _ = _project(tmp_path, monkeypatch, ordinary=ordinary)
    with wave.open(str(tmp_path / "source.wav"), "wb") as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(44100)
        f.writeframes(np.zeros((88200, 2), dtype="<i2").tobytes())
    clip.bleed_restore.source_sha256 = sha256_file(tmp_path / "source.wav")
    if ordinary == "none":
        _write(tmp_path / "gate.wav", rate=48000, hz=137)
        monkeypatch.setattr(
            timeline_render, "current_gate_fill_path", lambda *_a: tmp_path / "gate.wav"
        )
    target = tmp_path / "variant.wav"
    proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    baseline = tmp_path / "baseline.wav"
    timeline_render.render_source_with_chain(p, track, baseline, defaults=load_defaults())
    assert np.any(_read(target)[1] != _read(baseline)[1])


def test_final_commit_boundary_revalidates(tmp_path, monkeypatch):
    p, _, clip, _ = _project(tmp_path, monkeypatch)
    target = tmp_path / "variant.wav"
    target.write_bytes(b"old complete variant")
    original = proxy.publish_completed_file

    def publish(temp, dest, *, before_replace):
        def changed():
            p.clips[0].source_end = 1.2
            before_replace()

        return original(temp, dest, before_replace=changed)

    monkeypatch.setattr(proxy, "publish_completed_file", publish)
    with pytest.raises(CodedValueError):
        proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    assert target.read_bytes() == b"old complete variant"


def _model(path):
    rows = ["rnnoise-nu model file version 1"]
    for kind, m, n in [
        ("dense", 42, 4),
        ("gru", 4, 4),
        ("gru", 50, 4),
        ("gru", 50, 4),
        ("dense", 4, 22),
        ("dense", 4, 1),
    ]:
        if kind == "dense":
            rows.extend([f"{m} {n} 1", " ".join(["0"] * (m * n)), " ".join(["0"] * n)])
        else:
            rows.extend(
                [
                    f"{m} {n} 0",
                    " ".join(["0"] * (m * n * 3)),
                    " ".join(["0"] * (n * n * 3)),
                    " ".join(["0"] * (n * 3)),
                ]
            )
    path.write_text("\n".join(rows) + "\n")


@pytest.mark.parametrize("effect", ["raw", "compressor", "loudnorm"])
def test_grouped_room_seek_matches_decode_from_zero(tmp_path, monkeypatch, effect):
    p, _, clip, _ = _project(tmp_path, monkeypatch, effect, "room")
    room = tmp_path / "room.wav"
    rate = 48000
    t = np.arange(8 * rate) / rate
    samples = np.round(
        11000 * np.column_stack((np.sin(2 * np.pi * 257 * t), np.sin(2 * np.pi * 337 * t)))
    ).astype("<i2")
    with wave.open(str(room), "wb") as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(samples.tobytes())
    clip.mute_regions[0].fill.start_s = 6.27391
    clip.mute_regions[0].fill.end_s = 6.47391
    commands = []
    execute = proxy._execute

    def capture(engine, command, directory, name, formats):
        if name in ["whole", "without"]:
            commands.append(command)
        return execute(engine, command, directory, name, formats)

    monkeypatch.setattr(proxy, "_execute", capture)
    target = tmp_path / "variant.wav"
    proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    grouped = target.read_bytes()
    assert len(commands) == 2
    for command in commands:
        assert command.count("-i") == 2
        assert command.count(str(room)) == 1
        assert command[command.index("-ss") + 1] == "5.000000"
        assert command.index("-ss") > command.index(str(tmp_path / "source.wav"))
        assert "asplit=6" in command[command.index("-filter_complex") + 1]
    at = proxy.MediaSeek.at

    def from_zero(seconds):
        seek = at(seconds)
        return proxy.MediaSeek(seek.start_us, 0)

    monkeypatch.setattr(proxy.MediaSeek, "at", from_zero)
    reference = tmp_path / "reference.wav"
    proxy.render_source_proxy_restore(p, clip.id, reference, defaults=load_defaults())
    assert reference.read_bytes() == grouped


@pytest.mark.parametrize("changed", [False, True])
def test_real_rate_changing_chain_seals_model(tmp_path, monkeypatch, changed):
    p, track, clip, _ = _project(tmp_path, monkeypatch)
    model = tmp_path / "model.rnnn"
    _model(model)
    p.processing_chains = [
        ProcessingChain(
            track_id=track.id,
            effects=[
                ProcessingEffect(effect="loudnorm"),
                ProcessingEffect(effect="arnndn", params={"model": str(model)}),
                ProcessingEffect(effect="loudnorm"),
            ],
        )
    ]
    target = tmp_path / "variant.wav"
    target.write_bytes(b"old complete variant")
    real = proxy._render_pair

    def render(*args, **kwargs):
        result = real(*args, **kwargs)
        if changed:
            model.write_text(model.read_text() + "\n")
        return result

    monkeypatch.setattr(proxy, "_render_pair", render)
    if changed:
        with pytest.raises(CodedValueError):
            proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
        assert target.read_bytes() == b"old complete variant"
    else:
        proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
        expected = tmp_path / "legacy.wav"
        timeline_render.render_source_with_chain(p, track, expected, defaults=load_defaults())
        assert _read(target)[1].shape == _read(expected)[1].shape


def test_default_model_binding_cannot_change_between_passes(tmp_path, monkeypatch):
    p, track, clip, _ = _project(tmp_path, monkeypatch)
    first = tmp_path / "first.rnnn"
    _model(first)
    second = tmp_path / "second.rnnn"
    _model(second)
    monkeypatch.setenv("PODCAST_MCP_RNNOISE_MODEL", str(first))
    p.processing_chains = [
        ProcessingChain(track_id=track.id, effects=[ProcessingEffect(effect="arnndn")])
    ]
    render = proxy.render_source_with_chain

    def replace(*args, **kwargs):
        result = render(*args, **kwargs)
        monkeypatch.setenv("PODCAST_MCP_RNNOISE_MODEL", str(second))
        return result

    monkeypatch.setattr(proxy, "render_source_with_chain", replace)
    target = tmp_path / "variant.wav"
    target.write_bytes(b"old complete artifact")
    with pytest.raises(CodedValueError):
        proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    assert target.read_bytes() == b"old complete artifact"


@pytest.mark.parametrize("binding", ["source", "room", "model", "peer"])
def test_logical_input_alias_is_sealed_before_capture(tmp_path, monkeypatch, binding):
    p, track, clip, _ = _project(
        tmp_path, monkeypatch, ordinary="room" if binding == "room" else "none"
    )
    first, second = tmp_path / "first.wav", tmp_path / "second.wav"
    _write(first, hz=257)
    _write(second, hz=653)
    alias = tmp_path / "alias.wav"
    if binding == "model":
        first, second = tmp_path / "first.rnnn", tmp_path / "second.rnnn"
        _model(first)
        _model(second)
        alias = tmp_path / "alias.rnnn"
        p.processing_chains = [
            ProcessingChain(
                track_id=track.id,
                effects=[ProcessingEffect(effect="arnndn", params={"model": str(alias)})],
            )
        ]
    alias.symlink_to(first.name)
    if binding == "source":
        track.media.path = alias.name
        clip.bleed_restore.source_sha256 = sha256_file(alias)
    elif binding == "room":
        p.sources[0].path = alias.name
    elif binding == "peer":
        peer = Track(id="peer", label="Peer", media=MediaAsset(path=alias.name))
        p.tracks.append(peer)
        p.clips.append(
            Clip(id="peerclip", track_id=peer.id, source_start=0, source_end=2, timeline_start=7.35)
        )
    capture = proxy._Dependencies.capture

    def replace(*args, **kwargs):
        if binding != "peer":
            alias.unlink()
            alias.symlink_to(second.name)
        result = capture(*args, **kwargs)
        if binding == "peer":
            alias.unlink()
            alias.symlink_to(second.name)
        return result

    monkeypatch.setattr(proxy._Dependencies, "capture", replace)
    target = tmp_path / "variant.wav"
    target.write_bytes(b"old complete artifact")
    first_bytes, second_bytes = first.read_bytes(), second.read_bytes()
    with pytest.raises(CodedValueError):
        proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    assert target.read_bytes() == b"old complete artifact"
    assert first.read_bytes() == first_bytes and second.read_bytes() == second_bytes


def test_fill_eligibility_is_sealed_before_capture(tmp_path, monkeypatch):
    p, _, clip, _ = _project(tmp_path, monkeypatch)
    source = tmp_path / "source.wav"
    fill = tmp_path / "gate.wav"
    _write(fill, hz=137)
    revision = source.stat()
    monkeypatch.setattr(
        timeline_render,
        "current_gate_fill_path",
        lambda *_a: fill if source.stat().st_mtime_ns == revision.st_mtime_ns else None,
    )
    capture = proxy._Dependencies.capture

    def touch(*args, **kwargs):
        os.utime(source, ns=(revision.st_atime_ns, revision.st_mtime_ns + 1))
        return capture(*args, **kwargs)

    monkeypatch.setattr(proxy._Dependencies, "capture", touch)
    target = tmp_path / "variant.wav"
    target.write_bytes(b"old complete artifact")
    with pytest.raises(CodedValueError):
        proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    assert target.read_bytes() == b"old complete artifact"


def _swap_source(tmp_path, clip, name):
    shutil.copy(media.multistream(tmp_path, name), tmp_path / "source.wav")
    clip.bleed_restore.source_sha256 = sha256_file(tmp_path / "source.wav")


def test_proxy_decode_clock_reads_the_first_audio_stream(tmp_path):
    source = media.multistream(tmp_path, "kid.ogg")
    (tmp_path / "work").mkdir()
    audio = proxy._decode_clock(FFmpegEngine(), source, tmp_path / "work").audio
    assert (audio.sample_rate, audio.channel_layout, audio.frames) == (22050, "mono", 44100)


def test_source_chain_render_takes_the_first_audio_stream(tmp_path):
    source = media.multistream(tmp_path, "st.mkv")
    project = EpisodeProject.create("Chain", str(tmp_path))
    track = Track(id="origin", label="Origin", media=MediaAsset(path=source.name))
    project.tracks = [track]
    multi = tmp_path / "multi.out.wav"
    timeline_render.render_source_with_chain(project, track, multi, defaults=load_defaults())
    assert _read(multi)[0] == 22050
    (tmp_path / "single").mkdir()
    shutil.copy(media.first_stream_only(source, tmp_path / "single"), source)
    single = tmp_path / "single.out.wav"
    timeline_render.render_source_with_chain(project, track, single, defaults=load_defaults())
    assert multi.read_bytes() == single.read_bytes()


@pytest.mark.parametrize("name", ["st.mkv", "kid.ogg"])
def test_restore_proxy_of_a_multistream_source_uses_the_first_stream(tmp_path, monkeypatch, name):
    p, _, clip, _ = _project(tmp_path, monkeypatch)
    _swap_source(tmp_path, clip, name)
    target = tmp_path / "variant.wav"
    proxy.render_source_proxy_restore(p, clip.id, target, defaults=load_defaults())
    rate, frames = _read(target)
    assert (rate, len(frames)) == (22050, 44100)


def test_first_stream_fix_moves_render_and_proxy_identities(tmp_path, monkeypatch):
    p, track, clip, _ = _project(tmp_path, monkeypatch)
    assert timeline_render.RENDER_SEMANTICS_REV == 20
    captured = proxy.SourceProxyInputs.capture_occurrence(
        p, clip.id, FFmpegEngine(), defaults=load_defaults()
    )
    assert captured.identity_payload["revision"] == "source-proxy-inputs-v2"
    payloads = []

    def spy(raw, *args, **kwargs):
        payloads.append(json.loads(raw))
        return short_digest(raw, *args, **kwargs)

    monkeypatch.setattr(play_audit, "short_digest", spy)
    play_audit.proxy_render_hash(p, track.id, defaults=load_defaults())
    assert payloads[-1]["stream"] == "0:a:0"
