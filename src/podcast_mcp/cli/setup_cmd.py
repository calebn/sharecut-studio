from __future__ import annotations

import sys
from pathlib import Path

import typer

from podcast_mcp.config.defaults import cache_dir, repo_root
from podcast_mcp.engines import FFmpegEngine
from podcast_mcp.services.pipeline import (
    DEFAULT_WHISPER_MODEL,
    MODELS,
    WHISPER_MODEL_IDS,
    install_model,
    model_status,
    models_for,
    persist_whisper_model,
    resolve_whisper_model,
    validate_whisper_model,
)
from podcast_mcp.util.binaries import FFmpegPairResolutionError

setup_app = typer.Typer(help="Install and verify Podcast MCP.")

_COMPONENT_IDS = tuple(spec.id for spec in MODELS)


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
    try:
        ok, msg = FFmpegEngine().check_available()
    except FFmpegPairResolutionError as exc:
        ok, msg = False, str(exc)
    if ok:
        typer.echo(f"FFmpeg: {msg}")
    else:
        typer.echo(f"FFmpeg missing: {msg}", err=True)
        typer.echo(
            "Fix: install a matching FFmpeg 9.0.2 or later 9.x pair; see docs/setup.md",
            err=True,
        )

    typer.echo("Models:")
    whisper = resolve_whisper_model()
    for spec in MODELS:
        status = model_status(spec.id, whisper if spec.id == "whisper" else None)
        if status["ok"]:
            typer.echo(f"  {spec.id}: ready ({spec.purpose})")
        else:
            typer.echo(
                f"  {spec.id}: missing ({spec.purpose}, {spec.size}). Fix: {status['bootstrap']}"
            )

    typer.echo(f"Cache: {cache_dir()}")
    typer.echo(f"Python: {sys.version.split()[0]}")
    mcp_config = repo_root() / ".agents" / "mcp.json"
    if mcp_config.is_file():
        typer.echo(f"MCP config: {mcp_config}")
    else:
        typer.echo('MCP server entry: {"command": "podcast-mcp", "args": []}')

    if global_skills:
        if not _skills_root().is_dir():
            typer.echo(
                "No skills to link: skills ship with the repository checkout, not the installed package.",
                err=True,
            )
            raise typer.Exit(1)
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
    from podcast_mcp.services.support import (
        DiagnosticsService,
        default_bundle_dir,
        echo_doctor_report,
        run_doctor_checks,
    )

    if bundle:
        from podcast_mcp.project.io import open_project

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
    component: str | None = typer.Option(
        None,
        "--component",
        help=(
            f"Which model to install: all, {', '.join(_COMPONENT_IDS)}. "
            f"Default: {', '.join(spec.id for spec in models_for('required', 'recommended'))}."
        ),
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
    """Download model assets on demand.

    Nothing here is required to install the package -- everything is fetched
    lazily into the cache dir (`podcast doctor` shows the path) the first time
    you actually need it. A bare run installs the recommended models (Whisper
    and RNNoise); `--component all` installs every model, or name one
    (`--component whisper`) to top up just that piece. Safe to re-run;
    already-cached assets are skipped unless `--upgrade`.
    """
    if component is not None and component != "all" and component not in _COMPONENT_IDS:
        typer.echo(
            f"Unknown component {component!r}; choose from: all, {', '.join(_COMPONENT_IDS)}",
            err=True,
        )
        raise typer.Exit(2)

    if component is None:
        wanted = models_for("required", "recommended")
    elif component == "all":
        wanted = MODELS
    else:
        wanted = tuple(spec for spec in MODELS if spec.id == component)
    if any(spec.id == "whisper" for spec in wanted):
        try:
            whisper_model = validate_whisper_model(whisper_model)
        except ValueError as exc:
            typer.echo(str(exc), err=True)
            raise typer.Exit(2) from exc
    ok = True
    for spec in wanted:
        reason = spec.unavailable() if component == "all" else None
        if reason is not None and not model_status(spec.id)["ok"]:
            typer.echo(f"[skip] {spec.id}: {reason}")
            continue
        try:
            result = install_model(spec, whisper_model=whisper_model, force=upgrade)
        except Exception as exc:
            typer.echo(f"[fail] {spec.id}: {exc}", err=True)
            ok = False
            continue
        verb = "[skip]" if result.get("skipped") else "[ok]"
        detail = str(result.get("path") or result.get("reason", ""))
        if model := result.get("model"):
            detail = f"{detail} ({model})"
        typer.echo(f"{verb} {spec.id}: {detail}")
        if result.get("persist_error"):
            typer.echo(
                f"[warn] could not persist Whisper preference: {result['persist_error']}",
                err=True,
            )

    if not ok:
        raise typer.Exit(1)
    typer.echo("Bootstrap complete.")


def _skills_root() -> Path:
    return repo_root() / ".agents" / "skills"


def _link_global_skills() -> None:
    src_root = _skills_root()
    dest_root = Path.home() / ".agents" / "skills"
    dest_root.mkdir(parents=True, exist_ok=True)
    for skill_dir in src_root.iterdir():
        if not skill_dir.is_dir():
            continue
        dest = dest_root / skill_dir.name
        if dest.exists() or dest.is_symlink():
            dest.unlink()
        dest.symlink_to(skill_dir.resolve())
