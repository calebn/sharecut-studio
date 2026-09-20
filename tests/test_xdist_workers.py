from conftest import automatic_xdist_workers


def test_automatic_xdist_workers_limits_auto_to_four() -> None:
    assert automatic_xdist_workers(64) == 4
    assert automatic_xdist_workers(None) == 1


def test_automatic_xdist_workers_uses_available_small_cpu_count() -> None:
    assert automatic_xdist_workers(2) == 2
