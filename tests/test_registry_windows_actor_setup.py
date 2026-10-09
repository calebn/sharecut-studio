from __future__ import annotations

import subprocess
from types import SimpleNamespace

import pytest

from test_registry_backup_windows import _Account, _run


def test_account_failure_diagnostic_redacts_password_and_keeps_it_out_of_argv(monkeypatch):
    account = _Account("owned-test-user", "Synthetic-long-credential-aA1!")
    calls = []

    def fail(arguments, **kwargs):
        calls.append((arguments, kwargs["input"]))
        return SimpleNamespace(
            returncode=1, stdout=account.password, stderr="account policy refused"
        )

    monkeypatch.setattr(subprocess, "run", fail)
    with pytest.raises(RuntimeError) as caught:
        _run(
            ["powershell.exe", "-NonInteractive", "-Command", "New-LocalUser"],
            account=account,
            create=True,
        )
    assert account.password not in repr(account)
    assert account.password not in str(caught.value)
    assert "[redacted]" in str(caught.value)
    assert "account policy refused" in str(caught.value)
    assert account.password not in repr(calls[0][0])
    assert account.password in calls[0][1]


def test_account_timeout_excludes_captured_credentials_and_argv(monkeypatch):
    account = _Account("owned-test-user", "Synthetic-long-credential-aA1!")

    def timeout(arguments, **kwargs):
        raise subprocess.TimeoutExpired(arguments, 30, output=account.password)

    monkeypatch.setattr(subprocess, "run", timeout)
    with pytest.raises(RuntimeError, match="timed out") as caught:
        _run(["powershell.exe"], account=account, create=True)
    assert account.password not in str(caught.value)
    assert caught.value.__suppress_context__


@pytest.mark.parametrize("create", [True, False])
def test_actor_children_strip_all_module_path_cases_without_mutating_parent(monkeypatch, create):
    account = _Account("owned-test-user", "Synthetic-long-credential-aA1!")
    inherited = {"PSModulePath": "pwsh modules", "psMODULEpath": "other modules", "KEEP": "same"}
    monkeypatch.setattr("test_registry_backup_windows.os.environ", inherited)
    children = []

    def run(arguments, **kwargs):
        children.append(kwargs)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", run)
    _run(["powershell.exe", "-NonInteractive"], account=account, create=create)
    assert children[0].get("env") == {"KEEP": "same"}
    assert inherited == {
        "PSModulePath": "pwsh modules",
        "psMODULEpath": "other modules",
        "KEEP": "same",
    }
    assert children[0]["input"] == (
        '{"name": "owned-test-user", "password": "Synthetic-long-credential-aA1!"}'
        if create
        else "owned-test-user"
    )


def test_get_acl_environment_copy_removes_variants_including_overrides(monkeypatch):
    from registry_windows_fixture import powershell_environment

    parent = {"PSModulePath": "pwsh", "psmodulePATH": "incompatible", "OTHER": "kept"}
    monkeypatch.setattr("registry_windows_fixture.os.environ", parent)
    child = powershell_environment(
        overrides={"SHARECUT_TEST_SOURCE": "owned-source", "PsModulePath": "override"}
    )
    assert child == {"OTHER": "kept", "SHARECUT_TEST_SOURCE": "owned-source"}
    assert parent == {"PSModulePath": "pwsh", "psmodulePATH": "incompatible", "OTHER": "kept"}


def test_source_get_acl_child_strips_module_path_cases_and_preserves_parent(tmp_path, monkeypatch):
    from test_share_registry_source_privacy import (
        test_fresh_windows_directory_installs_protected_private_inheritable_acl,
    )

    inherited = {
        "SYSTEMROOT": "owned-system-root",
        "PSModulePath": "pwsh",
        "psMODULEpath": "bad",
        "KEEP": "same",
    }
    children = []
    monkeypatch.setattr("registry_windows_fixture.os.environ", inherited)
    monkeypatch.setattr(
        "test_share_registry_source_privacy.share_registry.SqliteShareRegistry",
        lambda path: SimpleNamespace(recording_key_secret=lambda: b"s" * 32, close=lambda: None),
    )

    def inspect(arguments, **kwargs):
        children.append((arguments, kwargs))
        return SimpleNamespace(stdout="True\nD:P(A;OICI;FA;;;owner)\n", returncode=0)

    monkeypatch.setattr(subprocess, "run", inspect)
    test_fresh_windows_directory_installs_protected_private_inheritable_acl(tmp_path)
    assert len(children) == 1
    assert "Get-Acl" in children[0][0][-1]
    assert children[0][1]["env"] == {
        "SYSTEMROOT": "owned-system-root",
        "KEEP": "same",
        "SHARECUT_TEST_SOURCE": str(tmp_path / "new-source"),
    }
    assert inherited == {
        "SYSTEMROOT": "owned-system-root",
        "PSModulePath": "pwsh",
        "psMODULEpath": "bad",
        "KEEP": "same",
    }
