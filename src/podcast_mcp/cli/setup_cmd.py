from __future__ import annotations

import shutil
import sys
from pathlib import Path

import typer

from podcast_mcp.config import cache_dir, repo_root
from podcast_mcp.engines import FFmpegEngine
from podcast_mcp.util.binaries import bootstrap_ffmpeg
from podcast_mcp.util.model_assets import (
    bootstrap_nisqa_model,
    bootstrap_rnnoise_model,
)
from podcast_mcp.whisper_models import (
    DEFAULT_WHISPER_MODEL,
    WHISPER_MODEL_IDS,
    bootstrap_whisper_model,
    persist_whisper_model,
    validate_whisper_model,
)

setup_app = typer.Typer(help="Install and verify Podcast MCP.")

_COMPONENTS = ("ffmpeg", "whisper", "rnnoise", "silero-vad", "nisqa")


@setup_app.command("setup")
def setup(
    global_skills: bool = typer.Option(
        False, "--global-skills", help="Symlink skills to ~/.agents/skills/"
    ),
    whisper_model: str | None = typer.Option(
        None,
        "--whisper-model",
        help=(
            "Persist the machine Whisper model "
            f"(default {DEFAULT_WHISPER_MODEL}; options: {', '.join(WHISPER_MODEL_IDS)})."
        ),
    ),
) -> None:
    """Check dependencies, prepare cache, optionally link global skills."""
    cache_dir()
    if whisper_model is not None:
        try:
            chosen = persist_whisper_model(whisper_model)
        except ValueError as exc:
            typer.echo(str(exc), err=True)
            raise typer.Exit(2) from exc
        typer.echo(f"Whisper model preference: {chosen}")
    ok, msg = FFmpegEngine().check_available()
    if ok:
        typer.echo(f"FFmpeg: {msg}")
    else:
        typer.echo(f"FFmpeg missing: {msg}", err=True)
        typer.echo(
            "Fix: brew/apt install ffmpeg, or `podcast bootstrap --component ffmpeg`",
            err=True,
        )

    typer.echo(f"Cache: {cache_dir()}")
    typer.echo(f"Python: {sys.version.split()[0]}")
    typer.echo(f"MCP config: {repo_root() / '.agents' / 'mcp.json'}")

    if global_skills:
        _link_global_skills()
        typer.echo("Linked skills to ~/.agents/skills/")


@setup_app.command("doctor")
def doctor(
    project: Path | None = typer.Option(
        None,
        "--project",
        help="Optional episode project path for per-track timebase drift QC.",
    ),
    bundle: bool = typer.Option(
        False,
        "--bundle",
        help="Write a sanitized diagnostics zip for a support request (nothing is uploaded).",
    ),
    out: Path | None = typer.Option(
        None,
        "--out",
        help="Directory for --bundle (default: ~/Downloads).",
    ),
    open_issue: bool = typer.Option(
        False,
        "--open",
        help="Open the configured support URL in a browser (CLI only; never uploads the zip).",
    ),
) -> None:
    """Health check for FFmpeg, cache, and package import."""
    from podcast_mcp.services.doctor import echo_doctor_report, run_doctor_checks

    if bundle:
        from podcast_mcp.project_io import open_project
        from podcast_mcp.services.diagnostics import DiagnosticsService, default_bundle_dir

        ep = None
        if project is not None:
            _, ep = open_project(project)
        report = DiagnosticsService().build_bundle(
            ep,
            out_dir=out.expanduser() if out is not None else default_bundle_dir(),
        )
        typer.echo(str(report.path))
        typer.echo(report.support_url)
        if open_issue:
            import webbrowser

            webbrowser.open(report.support_url)
        return

    result = run_doctor_checks(project)
    echo_doctor_report(result, typer.echo, lambda m: typer.echo(m, err=True))
    if not result.passed:
        raise typer.Exit(1)
    typer.echo("All checks passed.")


@setup_app.command("bootstrap")
def bootstrap(
    component: str = typer.Option(
        "all",
        "--component",
        help=f"Which asset to install: all, {', '.join(_COMPONENTS)}.",
    ),
    whisper_model: str = typer.Option(
        DEFAULT_WHISPER_MODEL,
        "--whisper-model",
        help=(
            "Whisper model size to pre-cache and persist "
            f"(default {DEFAULT_WHISPER_MODEL}; options: {', '.join(WHISPER_MODEL_IDS)})."
        ),
    ),
    upgrade: bool = typer.Option(False, "--upgrade", help="Re-download even if already cached."),
) -> None:
    """Download optional heavyweight assets on demand (FFmpeg, Whisper, RNNoise).

    Nothing here is required to install the package -- everything is fetched
    lazily into the cache dir (`podcast doctor` shows the path) the first time
    you actually need it. Run this once for a fully offline-ready setup, or
    per-component (`--component ffmpeg`) to top up just one piece. Safe to
    re-run; already-cached assets are skipped unless `--upgrade`.
    """
    if component != "all" and component not in _COMPONENTS:
        typer.echo(
            f"Unknown component {component!r}; choose from: all, {', '.join(_COMPONENTS)}",
            err=True,
        )
        raise typer.Exit(2)

    wanted: tuple[str, ...] = _COMPONENTS if component == "all" else (component,)
    # NISQA is opt-in only (joinqc extra); never pull on `bootstrap --component all`.
    if component == "all":
        wanted = tuple(c for c in wanted if c != "nisqa")
    ok = True
    if "ffmpeg" in wanted:
        ok = _bootstrap_ffmpeg_component(force=upgrade) and ok
    if "whisper" in wanted:
        try:
            model = validate_whisper_model(whisper_model)
        except ValueError as exc:
            typer.echo(str(exc), err=True)
            raise typer.Exit(2) from exc
        ok = _bootstrap_whisper_component(model) and ok
    if "rnnoise" in wanted:
        ok = _bootstrap_rnnoise_component(force=upgrade) and ok
    if "silero-vad" in wanted:
        ok = _report_silero_component() and ok
    if "nisqa" in wanted:
        ok = _bootstrap_nisqa_component(force=upgrade) and ok

    if not ok:
        raise typer.Exit(1)
    typer.echo("Bootstrap complete.")


def _bootstrap_ffmpeg_component(*, force: bool) -> bool:
    if not force and shutil.which("ffmpeg") and shutil.which("ffprobe"):
        typer.echo("[skip] ffmpeg: already on system PATH")
        return True
    try:
        ffmpeg_path, ffprobe_path = bootstrap_ffmpeg(force=force)
    except ImportError as exc:
        typer.echo(f"[fail] ffmpeg: {exc}", err=True)
        return False
    except Exception as exc:  # pragma: no cover - network/platform failures
        typer.echo(f"[fail] ffmpeg: {exc}", err=True)
        return False
    typer.echo(f"[ok] ffmpeg: {ffmpeg_path}")
    typer.echo(f"[ok] ffprobe: {ffprobe_path}")
    return True


def _bootstrap_whisper_component(model_size: str) -> bool:
    try:
        result = bootstrap_whisper_model(model_size)
    except ImportError as exc:
        typer.echo(f"[fail] whisper: {exc}", err=True)
        return False
    except Exception as exc:  # pragma: no cover - network/platform failures
        typer.echo(f"[fail] whisper: {exc}", err=True)
        return False
    typer.echo(f"[ok] whisper model {result['model']!r} cached at {result['cache']}")
    if result.get("persist_error"):
        typer.echo(
            f"[warn] could not persist Whisper preference: {result['persist_error']}",
            err=True,
        )
    return True


def _bootstrap_rnnoise_component(*, force: bool) -> bool:
    try:
        path = bootstrap_rnnoise_model(force=force)
    except Exception as exc:  # pragma: no cover - network failures
        typer.echo(f"[fail] rnnoise: {exc}", err=True)
        return False
    typer.echo(f"[ok] rnnoise model: {path}")
    return True


def _bootstrap_nisqa_component(*, force: bool) -> bool:
    try:
        path = bootstrap_nisqa_model(force=force)
    except Exception as exc:  # pragma: no cover - network failures
        typer.echo(f"[fail] nisqa: {exc}", err=True)
        return False
    typer.echo(f"[ok] nisqa model: {path}")
    return True


def _report_silero_component() -> bool:
    from podcast_mcp.engines.vad_silero import is_available, model_path

    if not is_available():
        typer.echo(
            "[fail] silero-vad: not available (onnxruntime/faster-whisper missing)", err=True
        )
        return False
    typer.echo(f"[ok] silero-vad: bundled with faster-whisper at {model_path()}")
    return True


def _link_global_skills() -> None:
    src_root = repo_root() / ".agents" / "skills"
    dest_root = Path.home() / ".agents" / "skills"
    dest_root.mkdir(parents=True, exist_ok=True)
    for skill_dir in src_root.iterdir():
        if not skill_dir.is_dir():
            continue
        dest = dest_root / skill_dir.name
        if dest.exists() or dest.is_symlink():
            dest.unlink()
        dest.symlink_to(skill_dir.resolve())
