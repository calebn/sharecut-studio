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
