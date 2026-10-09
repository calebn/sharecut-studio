from __future__ import annotations

import os
import runpy
import stat
import sys
from contextlib import closing
from types import SimpleNamespace

import pytest

from podcast_mcp.edits import share_registry


@pytest.mark.skipif(os.name != "posix", reason="POSIX no-follow registry namespace")
@pytest.mark.parametrize("input_kind", ["environment", "option"])
def test_ux_seed_refuses_raw_registry_alias_before_token_output(tmp_path, monkeypatch, input_kind):
    target_parent = tmp_path / "trusted"
    target_parent.mkdir(mode=0o700)
    target = target_parent / "registry.sqlite"
    with closing(share_registry.SqliteShareRegistry(target)) as owner:
        secret = owner.recording_key_secret()
        owner.claim_active(
            {
                "token": "ux-seed-sentinel",
                "id": "ux-seed-sentinel",
                "project_workspace": str(tmp_path),
                "review_version_id": "version",
            }
        )
    before = target.stat().st_ino, target.read_bytes(), stat.S_IMODE(target.stat().st_mode)
    unsafe = tmp_path / "replaceable"
    unsafe.mkdir(mode=0o700)
    unsafe.chmod(0o777)
    raw_registry = unsafe / "registry.sqlite"
    raw_registry.symlink_to(target)
    project = tmp_path / "project.json"
    project.write_text("{}", encoding="utf-8")
    tokens_out = tmp_path / "owned" / "guest-tokens.json"

    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.collaboration.share import ShareService

    workspace = SimpleNamespace(
        project=SimpleNamespace(
            review=SimpleNamespace(
                versions=[SimpleNamespace(label="UX demo review", id="existing-version")]
            )
        )
    )
    monkeypatch.setattr(ProjectWorkspace, "open", lambda *_args: workspace)
    monkeypatch.setattr(ShareService, "__init__", lambda self, _: None)

    def exercise_registry(*args, **kwargs):
        active = share_registry.get_share_registry()
        assert active.recording_key_secret() == secret
        return {"token": "would-have-been-seeded", "url": "https://example.invalid/r/token"}

    monkeypatch.setattr(ShareService, "create", exercise_registry)
    arguments = [
        "scripts/ux_demo_prepare_shares.py",
        "--project",
        str(project),
        "--tokens-out",
        str(tokens_out),
    ]
    if input_kind == "option":
        monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(target_parent / "host.sqlite"))
        arguments.extend(["--registry", str(raw_registry)])
    else:
        monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(raw_registry))
    monkeypatch.setattr(sys, "argv", arguments)

    main = runpy.run_path("scripts/ux_demo_prepare_shares.py", run_name="ux_seed_test")["main"]
    with pytest.raises(PermissionError):
        main()

    assert not tokens_out.exists(), "refusal must happen before the UX token manifest is written"
    assert (
        target.stat().st_ino,
        target.read_bytes(),
        stat.S_IMODE(target.stat().st_mode),
    ) == before
    with closing(share_registry.sqlite3.connect(target)) as observer:
        assert observer.execute("SELECT token FROM active_shares ORDER BY token").fetchall() == [
            ("ux-seed-sentinel",)
        ]
        assert observer.execute("SELECT secret FROM recording_key_secret").fetchone() == (secret,)
