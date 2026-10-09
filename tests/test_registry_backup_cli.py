import json
import sqlite3
from contextlib import closing
from pathlib import Path

from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.share_registry import get_share_registry


def test_cli_backup_publishes_secret_then_refuses_same_name(tmp_path: Path) -> None:
    registry = get_share_registry()
    secret = registry.recording_key_secret()
    output = tmp_path / "backups"
    output.mkdir(mode=0o700)
    destination = output / "new.sqlite"
    runner = CliRunner()
    arguments = ["review", "backup-registry", "--dest", str(destination)]
    created = runner.invoke(app, arguments)
    assert created.exit_code == 0, created.output
    assert json.loads(created.stdout) == {
        "source": str(registry.db_path),
        "backup": str(destination),
    }
    assert secret.hex() not in created.output
    with closing(sqlite3.connect(destination)) as restored:
        assert restored.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
    original = destination.stat().st_ino, destination.read_bytes()
    refused = runner.invoke(app, arguments)
    assert refused.exit_code == 1
    assert "must be unused" in refused.output
    assert (destination.stat().st_ino, destination.read_bytes()) == original
    assert list(output.iterdir()) == [destination]
    assert registry.recording_key_secret() == secret


def test_cli_default_names_are_distinct_complete_backups() -> None:
    registry = get_share_registry()
    secret = registry.recording_key_secret()
    runner = CliRunner()
    paths = []
    for _ in range(2):
        result = runner.invoke(app, ["review", "backup-registry"])
        assert result.exit_code == 0, result.output
        destination = Path(json.loads(result.stdout)["backup"])
        paths.append(destination)
        with closing(sqlite3.connect(destination)) as restored:
            assert (
                restored.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
            )
    assert paths[0] != paths[1]
    assert all(path.parent == registry.db_path.parent for path in paths)
