"""``HostSessions``: a code opens one session once, within its minute; a session id is live until the process ends."""

from __future__ import annotations

import pytest

from podcast_mcp.gui.host_session import CODE_TTL_SEC, HostSessions


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def sessions(clock: Clock) -> HostSessions:
    return HostSessions(clock=clock)


def test_a_code_lasts_sixty_seconds() -> None:
    assert CODE_TTL_SEC == 60.0


def test_a_code_opens_a_session(sessions: HostSessions) -> None:
    session_id = sessions.redeem(sessions.issue_code())

    assert session_id is not None
    assert sessions.is_live(session_id) is True


def test_a_code_works_once(sessions: HostSessions) -> None:
    code = sessions.issue_code()

    first = sessions.redeem(code)
    second = sessions.redeem(code)

    assert first is not None
    assert second is None
    assert sessions.is_live(first) is True


def test_a_code_expires_at_sixty_seconds(sessions: HostSessions, clock: Clock) -> None:
    just_in_time = sessions.issue_code()
    too_late = sessions.issue_code()

    clock.now += 59.9
    assert sessions.redeem(just_in_time) is not None
    clock.now += 0.1
    assert sessions.redeem(too_late) is None


def test_an_expired_code_stays_refused_after_the_clock_is_read_again(
    sessions: HostSessions, clock: Clock
) -> None:
    code = sessions.issue_code()
    clock.now += 61

    assert sessions.redeem(code) is None
    assert sessions.redeem(code) is None


@pytest.mark.parametrize("presented", ["", "wrong", "a" * 500, "café", "\ud800"])
def test_a_wrong_code_is_refused_and_leaves_the_real_one_valid(
    sessions: HostSessions, presented: str
) -> None:
    code = sessions.issue_code()

    assert sessions.redeem(presented) is None
    assert sessions.redeem(code) is not None


def test_each_code_opens_its_own_session(sessions: HostSessions) -> None:
    first_code, second_code = sessions.issue_code(), sessions.issue_code()

    first = sessions.redeem(first_code)
    second = sessions.redeem(second_code)

    assert first and second and first != second
    assert {first, second}.isdisjoint({first_code, second_code})


@pytest.mark.parametrize("presented", [None, "", "wrong"])
def test_an_unknown_session_id_is_not_live(sessions: HostSessions, presented: str | None) -> None:
    sessions.redeem(sessions.issue_code())

    assert sessions.is_live(presented) is False


def test_a_code_is_not_a_session_id(sessions: HostSessions) -> None:
    code = sessions.issue_code()

    assert sessions.is_live(code) is False


def test_a_session_outlives_its_code(sessions: HostSessions, clock: Clock) -> None:
    session_id = sessions.redeem(sessions.issue_code())
    clock.now += 86_400

    assert sessions.is_live(session_id) is True


def test_a_second_store_knows_nothing_of_the_first(sessions: HostSessions) -> None:
    session_id = sessions.redeem(sessions.issue_code())

    assert HostSessions().is_live(session_id) is False
