"""The show store: one YAML file per show, written atomically under a lock."""

from __future__ import annotations

import subprocess
import sys
import textwrap
import threading
from pathlib import Path

import pytest
import yaml

from podcast_mcp.feed.model import Person
from podcast_mcp.feed.show_store import ShowStore, show_id_for
from podcast_mcp.models.feed import Pin
from podcast_mcp.util.coded_error import CodedValueError


@pytest.fixture
def store(tmp_path: Path) -> ShowStore:
    return ShowStore(tmp_path / "shows")


def test_a_machine_with_no_shows_directory_has_no_shows(store: ShowStore) -> None:
    assert list(store.shows()) == []
    assert store.profile("long-river") is None


def test_creating_a_show_names_it_and_writes_one_yaml_file(
    store: ShowStore, tmp_path: Path
) -> None:
    created = store.create("The Long River")

    assert created.id == "the-long-river"
    assert created.pins["channel.title"].value == "The Long River"
    assert [(s.id, s.title) for s in store.shows()] == [("the-long-river", "The Long River")]
    raw = yaml.safe_load((tmp_path / "shows" / "the-long-river.yaml").read_text(encoding="utf-8"))
    assert raw["id"] == "the-long-river"
    assert raw["pins"]["channel.title"]["value"] == "The Long River"


def test_creating_a_show_that_exists_is_refused_and_changes_nothing(store: ShowStore) -> None:
    store.create("The Long River")
    store.update("the-long-river", lambda show: show.pins.pop("channel.title"))

    with pytest.raises(CodedValueError) as raised:
        store.create("The Long River")

    assert raised.value.code == "feed_show_exists"
    assert "channel.title" not in store.profile("the-long-river").pins


@pytest.mark.parametrize(
    ("title", "slug"),
    [
        ("The Long River", "the-long-river"),
        ("  Café  Nöir!! ", "cafe-noir"),
        ("field-notes", "field-notes"),
        ("A" * 90, "a" * 64),
    ],
)
def test_a_title_becomes_a_safe_file_name(title: str, slug: str) -> None:
    assert show_id_for(title) == slug


@pytest.mark.parametrize("title", ["", "   ", "!!!", "../../etc"])
def test_a_name_with_nothing_to_spell_a_file_from_is_refused(title: str) -> None:
    if title == "../../etc":
        assert show_id_for(title) == "etc"
        return
    with pytest.raises(CodedValueError) as raised:
        show_id_for(title)
    assert raised.value.code == "feed_show_name_invalid"


def test_a_profile_round_trips_pins_roster_hosting_and_ledger(store: ShowStore) -> None:
    store.create("The Long River")

    def fill(show: object) -> None:
        show.pins["channel.author"] = Pin(value="Ana Reyes", by="agent")
        show.roster.append(Person("Ana Reyes", role="host", href="https://ana.example.test"))
        show.media_url = "https://cdn.example.test/long-river/{file}"
        show.ledger["urn:uuid:1"] = 1

    store.update("the-long-river", fill)
    again = ShowStore(store.directory).profile("the-long-river")

    assert again is not None
    assert again.pins["channel.author"].by == "agent"
    assert again.roster == [Person("Ana Reyes", role="host", href="https://ana.example.test")]
    assert again.media_url == "https://cdn.example.test/long-river/{file}"
    assert dict(again.ledger) == {"urn:uuid:1": 1}


def test_an_update_that_changes_nothing_writes_nothing(store: ShowStore) -> None:
    store.create("The Long River")
    path = store.directory / "the-long-river.yaml"
    before = path.stat().st_mtime_ns

    store.update("the-long-river", lambda show: None)

    assert path.stat().st_mtime_ns == before


def test_updating_a_show_that_does_not_exist_is_refused(store: ShowStore) -> None:
    with pytest.raises(CodedValueError) as raised:
        store.update("nope", lambda show: None)

    assert raised.value.code == "feed_show_unknown"


def test_a_failing_update_leaves_the_file_and_the_lock_alone(store: ShowStore) -> None:
    store.create("The Long River")

    def boom(show: object) -> None:
        show.pins["channel.author"] = Pin(value="half")
        raise RuntimeError("stop")

    with pytest.raises(RuntimeError):
        store.update("the-long-river", boom)

    assert "channel.author" not in store.profile("the-long-river").pins
    store.update("the-long-river", lambda show: show.ledger.update({"g": 1}))
    assert store.profile("the-long-river").ledger == {"g": 1}


def test_a_corrupt_file_is_named_not_treated_as_a_missing_show(store: ShowStore) -> None:
    store.create("The Long River")
    (store.directory / "the-long-river.yaml").write_text("pins: [not, a, mapping", encoding="utf-8")

    with pytest.raises(CodedValueError) as raised:
        store.profile("the-long-river")

    assert raised.value.code == "feed_show_unreadable"
    assert "the-long-river.yaml" in str(raised.value)
    assert [s.id for s in store.shows()] == ["the-long-river"]


def test_a_file_whose_id_disagrees_with_its_name_is_unreadable(store: ShowStore) -> None:
    store.create("The Long River")
    path = store.directory / "the-long-river.yaml"
    path.write_text(path.read_text(encoding="utf-8").replace("id: the-long", "id: other-long"))

    with pytest.raises(CodedValueError) as raised:
        store.profile("the-long-river")

    assert raised.value.code == "feed_show_unreadable"


def test_ledger_numbers_count_up_per_show_and_never_repeat(store: ShowStore) -> None:
    store.create("The Long River")
    store.create("Field Notes")

    assert store.number_for("the-long-river", "urn:uuid:a") == 1
    assert store.number_for("the-long-river", "urn:uuid:b") == 2
    assert store.number_for("the-long-river", "urn:uuid:a") == 1
    assert store.number_for("field-notes", "urn:uuid:a") == 1


def test_two_writers_in_one_process_lose_no_update(tmp_path: Path) -> None:
    ShowStore(tmp_path / "shows").create("The Long River")
    errors: list[BaseException] = []

    def work(name: str) -> None:
        local = ShowStore(tmp_path / "shows")  # a second store object, as a second request has
        try:
            for index in range(25):
                local.update(
                    "the-long-river",
                    lambda show, key=f"{name}{index}": show.pins.update(
                        {f"channel.x-{key}": Pin(value=key)}
                    ),
                )
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=work, args=(n,)) for n in ("a", "b")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    pins = ShowStore(tmp_path / "shows").profile("the-long-river").pins
    assert errors == []
    assert len([k for k in pins if k.startswith("channel.x-")]) == 50


def test_two_processes_number_their_episodes_without_a_repeat(tmp_path: Path) -> None:
    ShowStore(tmp_path / "shows").create("The Long River")
    script = textwrap.dedent(
        """
        import sys
        from pathlib import Path
        from podcast_mcp.feed.show_store import ShowStore

        store = ShowStore(Path(sys.argv[1]))
        for index in range(15):
            store.number_for("the-long-river", f"urn:uuid:{sys.argv[2]}-{index}")
        """
    )
    procs = [
        subprocess.Popen([sys.executable, "-I", "-c", script, str(tmp_path / "shows"), name])
        for name in ("a", "b")
    ]
    assert [p.wait(timeout=120) for p in procs] == [0, 0]

    ledger = ShowStore(tmp_path / "shows").profile("the-long-river").ledger
    assert sorted(ledger.values()) == list(range(1, 31))
