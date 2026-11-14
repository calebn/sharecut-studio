"""scripts/ios/release_secrets.py and release_run.py: secrets that cannot print, one place that reveals them."""

from __future__ import annotations

import ast
import copy
import json
import operator
import pickle
import sys
from pathlib import Path

import pytest
from scripts.ios.release_run import Command, PrivateFile, spawn
from scripts.ios.release_secrets import Redactor, Secret

from script_loader import SCRIPTS

IOS = SCRIPTS / "ios"


def test_a_secret_prints_as_its_label_in_every_format() -> None:
    secret = Secret("AAAAAAAAAA", "team")
    assert str(secret) == repr(secret) == f"{secret}" == operator.mod("%s", secret) == "<team>"
    assert f"{secret:>8}" == "  <team>"
    assert str([secret]) == "[<team>]"
    assert copy.deepcopy(secret) is secret


def test_a_secret_cannot_be_serialized_pickled_or_changed() -> None:
    secret = Secret("AAAAAAAAAA", "team")
    with pytest.raises(TypeError):
        json.dumps({"team": secret})
    with pytest.raises(TypeError, match="cannot be pickled"):
        pickle.dumps(secret)
    with pytest.raises(AttributeError):
        secret.label = "x"


def test_the_redactor_catches_every_spelling_of_a_secret_and_a_directory() -> None:
    key = Secret("/Users/someone/keys/My Key.p8", "key-path")
    redactor = Redactor([key, Secret("AAAAAAAAAA", "team")], {"home": "/Users/someone"})
    assert redactor.redact("a /Users/someone/keys/My Key.p8 b") == "a <key-path> b"
    assert redactor.redact("p /Users/someone/keys/My%20Key.p8") == "p <key-path>"
    assert redactor.redact('j "\\/Users\\/someone\\/keys\\/My Key.p8"') == 'j "<key-path>"'
    assert redactor.redact("t=AAAAAAAAAA at /Users/someone/code") == "t=<team> at <home>/code"


def test_the_redactor_masks_values_it_cannot_know_in_advance() -> None:
    text = (
        "Signing Identity: Apple Distribution: Some Person (BBBBBBBBBB)\n"
        "profile 0b6f7b0e-1c3a-4a0e-9f3f-8f4b2d1c9a11 sha 0123456789abcdef0123456789abcdef01234567"
    )
    assert Redactor().redact(text) == (
        "Signing Identity: <signing-identity>\nprofile <uuid> sha <fingerprint>"
    )


def test_a_secret_split_across_reads_is_still_caught() -> None:
    redactor = Redactor([Secret("SECRETVALUE123", "key")])
    stream = redactor.stream()
    out = [stream.feed("log SECRETVAL"), stream.feed("UE123 tail\nmore"), stream.finish()]
    assert "".join(out) == "log <key> tail\nmore"
    long_line = "x" * 5000 + "SECRETVALUE123" + "y" * 5000
    stream = redactor.stream()
    pieces = [stream.feed(long_line[i : i + 7]) for i in range(0, len(long_line), 7)]
    pieces.append(stream.finish())
    assert "SECRETVALUE" not in "".join(pieces)
    assert "".join(pieces).count("<key>") == 1


def test_an_exception_line_is_one_redacted_line() -> None:
    redactor = Redactor([Secret("AAAAAAAAAA", "team")])
    assert (
        redactor.exception_line(ValueError("bad AAAAAAAAAA\nnext")) == "ValueError: bad <team> next"
    )


def calls(tree: ast.AST, name: str) -> list[ast.Call]:
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == name
    ]


def enclosing_functions(tree: ast.AST, target: ast.AST) -> list[str]:
    return [
        node.name
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and any(child is target for child in ast.walk(node))
    ]


def test_a_secret_is_revealed_in_spawn_and_nowhere_else() -> None:
    found = []
    for path in sorted(IOS.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        found += [(path.name, enclosing_functions(tree, call)) for call in calls(tree, "reveal")]
    assert found
    assert {(name, tuple(functions)) for name, functions in found} == {
        ("release_run.py", ("spawn",))
    }


def test_the_redaction_forms_are_read_only_to_build_the_redactor() -> None:
    found = []
    for path in sorted(IOS.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        found += [
            (path.name, enclosing_functions(tree, call)[-1])
            for call in calls(tree, "redaction_forms")
        ]
        found += [
            (path.name, "attribute")
            for node in ast.walk(tree)
            if isinstance(node, ast.Attribute)
            and node.attr == "_value"
            and path.name != "release_secrets.py"
        ]
    assert found == [("release_secrets.py", "__init__")]


def child(
    code: str, *, env: dict[str, str | Secret] | None = None, files: tuple[PrivateFile, ...] = ()
) -> Command:
    return Command((sys.executable, "-c", code), Path.cwd(), env or {}, files)


def test_spawn_gives_the_child_exactly_its_environment_and_redacts_the_output(
    tmp_path: Path,
) -> None:
    secret = Secret("SECRETVALUE123", "key")
    redactor = Redactor([secret], {"tmp": tmp_path})
    code = (
        "import os,sys,time\n"
        "print(sorted(k for k in os.environ if k != 'LC_CTYPE'))\n"
        "sys.stdout.write('part SECRETVAL'); sys.stdout.flush(); time.sleep(0.05)\n"
        "sys.stdout.write('UE123 end\\n'); print('dir', os.environ['WHERE'])\n"
        "print(open(os.environ['PRIV']).read()); sys.exit(3)\n"
    )
    private = tmp_path / "options.plist"
    command = child(
        code,
        env={"WHERE": str(tmp_path), "KEY": secret, "PRIV": str(private)},
        files=(PrivateFile(private, ("<team>", secret, "</team>")),),
    )
    log = tmp_path / "logs" / "step.log"
    result = spawn(command, redactor, log)
    assert result.exit_code == 3
    assert result.tail.splitlines() == [
        "['KEY', 'PRIV', 'WHERE']",
        "part <key> end",
        "dir <tmp>",
        "<team><key></team>",
    ]
    assert "SECRETVALUE123" not in log.read_text()
    assert oct(log.stat().st_mode & 0o777) == "0o600"
    assert not private.exists()


def test_spawn_reports_a_missing_program_without_raising() -> None:
    result = spawn(Command(("/no/such/program",), Path.cwd()), Redactor())
    assert result.exit_code == 127
    assert "FileNotFoundError" in result.tail


def test_a_command_displays_secrets_as_tokens_and_hides_the_quiet_environment() -> None:
    command = Command(
        ("xcrun", "altool", "--api-key", Secret("KEYID12345", "key-id")),
        Path("/Users/someone/repo"),
        {"PATH": "/usr/bin", "APPLE_DEVELOPMENT_TEAM": Secret("AAAAAAAAAA", "team")},
    )
    assert command.display(Redactor(directories={"checkout": "/Users/someone/repo"})) == (
        "(cd <checkout> && APPLE_DEVELOPMENT_TEAM=<team> xcrun altool --api-key <key-id>)"
    )


def test_a_private_file_replaces_a_planted_link_and_a_loose_older_file(tmp_path: Path) -> None:
    target = tmp_path / "victim.txt"
    target.write_text("untouched")
    target.chmod(0o644)
    link = tmp_path / "options.plist"
    link.symlink_to(target)
    probe = Command(
        (sys.executable, "-c", f"print(open({str(link)!r}).read())"),
        tmp_path,
        {},
        (PrivateFile(link, ("secret-text",)),),
    )
    assert spawn(probe, Redactor()).tail == "secret-text"
    assert target.read_text() == "untouched" and oct(target.stat().st_mode & 0o777) == "0o644"
    assert not link.exists()

    loose = tmp_path / "loose.plist"
    loose.write_text("old")
    loose.chmod(0o644)
    mode = Command(
        (sys.executable, "-c", f"import os;print(oct(os.stat({str(loose)!r}).st_mode & 0o777))"),
        tmp_path,
        {},
        (PrivateFile(loose, ("new",)),),
    )
    assert spawn(mode, Redactor()).tail == "0o600"


def test_a_log_refuses_a_planted_link_and_tightens_an_older_file(tmp_path: Path) -> None:
    target = tmp_path / "victim.log"
    target.write_text("untouched")
    link = tmp_path / "step.log"
    link.symlink_to(target)
    command = Command((sys.executable, "-c", "print('hello')"), tmp_path)
    with pytest.raises(OSError):
        spawn(command, Redactor(), link)
    assert target.read_text() == "untouched"

    older = tmp_path / "older.log"
    older.write_text("first\n")
    older.chmod(0o644)
    spawn(command, Redactor(), older)
    assert older.read_text() == "first\nhello\n"
    assert oct(older.stat().st_mode & 0o777) == "0o600"
