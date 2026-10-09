import os
import subprocess
from pathlib import Path

import pytest

from podcast_mcp.util.binaries import FFmpegPairResolutionError, resolve_ffmpeg, resolve_ffmpeg_pair


def executable_pair(directory: Path, version: str, probe_version: str | None = None):
    directory.mkdir(parents=True, exist_ok=True)
    paths = []
    for name, release in (("ffmpeg", version), ("ffprobe", probe_version or version)):
        path = directory / (name + (".exe" if os.name == "nt" else ""))
        path.write_text(f"#!/bin/sh\nprintf '%s\\n' '{name} version {release}'\n")
        path.chmod(0o755)
        paths.append(path)
    return paths


@pytest.fixture(autouse=True)
def isolate(monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", "")
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    for variable in ("PODCAST_MCP_FFMPEG", "PODCAST_MCP_FFPROBE", "PODCAST_MCP_FFMPEG_BUNDLE"):
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.setattr("podcast_mcp.util.binaries._native_homebrew_pair", lambda: None)
    if os.name == "nt":

        def run(argv, **kwargs):
            contents = Path(argv[0]).read_text()
            output = contents.split("'")[3] + "\n"
            return subprocess.CompletedProcess(argv, 0, output, "")

        monkeypatch.setattr("podcast_mcp.util.binaries.run", run)


@pytest.mark.parametrize(
    "version",
    [
        "6.1.1",
        "7.0",
        "8.0.1",
        "9.0.1",
        "10.0",
        "N-123",
        "garbage",
        "9.0.2-dev",
        "9.0.2-10-gabcd",
        "9.0.2+snapshot",
    ],
)
def test_unsupported_release_fails_before_return(tmp_path, version):
    paths = executable_pair(tmp_path / "explicit", version)
    with pytest.raises(FFmpegPairResolutionError, match="9"):
        resolve_ffmpeg_pair(*map(str, paths))


def test_unequal_releases_fail(tmp_path):
    paths = executable_pair(tmp_path / "explicit", "9.0.2", "9.0.3")
    with pytest.raises(FFmpegPairResolutionError, match="match"):
        resolve_ffmpeg_pair(*map(str, paths))


@pytest.mark.parametrize("version,expected", [("9.0.2", (9, 0, 2)), ("9.1.3", (9, 1, 3))])
def test_supported_pair_records_release_and_source(tmp_path, version, expected):
    paths = executable_pair(tmp_path / "explicit", version)
    pair = resolve_ffmpeg_pair(*map(str, paths))
    assert pair.version == expected
    assert pair.source == "explicit"
    assert (pair.ffmpeg, pair.ffprobe) == tuple(map(str, paths))


def test_single_command_rejects_bad_companion(tmp_path, monkeypatch):
    paths = executable_pair(tmp_path / "bin", "9.0.2", "8.0.1")
    monkeypatch.setenv("PATH", str(paths[0].parent))
    with pytest.raises(FFmpegPairResolutionError, match="9"):
        resolve_ffmpeg()


def test_declared_bundle_wins_over_old_path_and_fails_closed(tmp_path, monkeypatch):
    bundle = executable_pair(tmp_path / "bundle", "9.0.2")
    old = executable_pair(tmp_path / "old", "6.1.1")
    monkeypatch.setenv("PATH", str(old[0].parent))
    monkeypatch.setenv("PODCAST_MCP_FFMPEG_BUNDLE", str(bundle[0].parent))
    pair = resolve_ffmpeg_pair()
    assert pair.ffmpeg == str(bundle[0])
    assert pair.source == "bundle"
    bundle[1].unlink()
    with pytest.raises(FFmpegPairResolutionError, match="bundle"):
        resolve_ffmpeg_pair()


def test_partial_override_does_not_mix_with_automatic_pair(tmp_path, monkeypatch):
    explicit = executable_pair(tmp_path / "explicit", "9.0.2")
    explicit[1].unlink()
    automatic = executable_pair(tmp_path / "automatic", "9.0.2")
    monkeypatch.setenv("PATH", str(automatic[0].parent))
    with pytest.raises(FFmpegPairResolutionError, match="sibling"):
        resolve_ffmpeg_pair(ffmpeg=str(explicit[0]))


def test_bare_override_uses_resolved_executable_sibling(tmp_path, monkeypatch):
    paths = executable_pair(tmp_path / "bin", "9.0.2")
    monkeypatch.setenv("PATH", str(paths[0].parent))
    pair = resolve_ffmpeg_pair(ffmpeg="ffmpeg")
    assert pair.ffprobe == str(paths[1])
    assert pair.source == "explicit"


def test_bundle_requires_exact_pinned_release(tmp_path, monkeypatch):
    paths = executable_pair(tmp_path / "bundle", "9.0.3")
    monkeypatch.setenv("PODCAST_MCP_FFMPEG_BUNDLE", str(paths[0].parent))
    with pytest.raises(FFmpegPairResolutionError, match="exact pinned"):
        resolve_ffmpeg_pair()


def test_explicit_ungated_audio_cannot_bypass_pair_validation(tmp_path):
    from podcast_mcp.engines.ungated_audio import load_mono_full

    paths = executable_pair(tmp_path / "explicit", "8.0.1")
    with pytest.raises(FFmpegPairResolutionError, match="unsupported"):
        load_mono_full(tmp_path / "unopened.wav", ffmpeg=str(paths[0]))


def test_bare_commands_are_fixed_before_path_changes(tmp_path, monkeypatch):
    selected = executable_pair(tmp_path / "selected", "9.0.2")
    other = executable_pair(tmp_path / "other", "8.0.1")
    monkeypatch.setenv("PATH", str(selected[0].parent))
    pair = resolve_ffmpeg_pair(ffmpeg="ffmpeg", ffprobe="ffprobe")
    monkeypatch.setenv("PATH", str(other[0].parent))
    admitted_again = resolve_ffmpeg_pair(pair.ffmpeg, pair.ffprobe)
    assert admitted_again.version == (9, 0, 2)
    assert admitted_again.ffmpeg == str(selected[0])


def test_automatic_discovery_skips_unsupported_pair_and_keeps_source(tmp_path, monkeypatch):
    old = executable_pair(tmp_path / "old", "6.1.1")
    supported = executable_pair(tmp_path / "supported", "9.1.3")
    monkeypatch.setenv("PATH", os.pathsep.join(map(str, (old[0].parent, supported[0].parent))))
    pair = resolve_ffmpeg_pair()
    assert pair.ffmpeg == str(supported[0])
    assert pair.version == (9, 1, 3)
    assert pair.source == "path"


def test_native_homebrew_pair_precedes_path(tmp_path, monkeypatch):
    native = executable_pair(tmp_path / "native", "9.0.2")
    path_pair = executable_pair(tmp_path / "path", "9.1.3")
    monkeypatch.setattr(
        "podcast_mcp.util.binaries._native_homebrew_pair", lambda: tuple(map(str, native))
    )
    monkeypatch.setenv("PATH", str(path_pair[0].parent))
    assert resolve_ffmpeg_pair().source == "homebrew"


def test_source_cache_pair_is_last_candidate(tmp_path, monkeypatch):
    cached = executable_pair(tmp_path / "cache" / "bin", "9.0.2")
    pair = resolve_ffmpeg_pair()
    assert pair.ffmpeg == str(cached[0])
    assert pair.source == "cache"
    cached[1].unlink()
    assert not pair.is_available()
    with pytest.raises(FFmpegPairResolutionError, match="not found"):
        resolve_ffmpeg_pair()


@pytest.mark.parametrize(
    "failure", [FileNotFoundError("missing"), subprocess.TimeoutExpired("ffmpeg", 10)]
)
def test_probe_failure_is_actionable_and_cannot_return_pair(tmp_path, monkeypatch, failure):
    paths = executable_pair(tmp_path / "explicit", "9.0.2")

    def failed(*args, **kwargs):
        raise failure

    monkeypatch.setattr("podcast_mcp.util.binaries.run", failed)
    with pytest.raises(FFmpegPairResolutionError, match=r"Cannot run.*Install matching"):
        resolve_ffmpeg_pair(*map(str, paths))
