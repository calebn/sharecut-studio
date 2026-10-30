from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import TypeAdapter

from feed_helpers import (
    EXPORTED_AT,
    add_clip,
    complete_show,
    inputs,
    make_project,
    mp3,
    pin,
    with_transcript,
)
from podcast_mcp.feed.fields import FIELDS, lookup
from podcast_mcp.feed.model import (
    CommandFix,
    ExportFile,
    ExportFiles,
    FeedEdit,
    InputFix,
    Pending,
    Person,
    ShowSummary,
)
from podcast_mcp.feed.resolve import digest, edited_pins, resolve
from podcast_mcp.models.feed import FeedSection
from podcast_mcp.util.coded_error import CodedValueError

EDIT = TypeAdapter(FeedEdit)


def _set(key: str, value: object) -> FeedEdit:
    return EDIT.validate_python({"op": "set", "key": key, "value": value})


def _unset(key: str) -> FeedEdit:
    return EDIT.validate_python({"op": "unset", "key": key})


def _findings(view, severity=None):
    return [(f.key, f.severity) for f in view.findings if severity in (None, f.severity)]


def test_fields_are_the_only_tag_list_and_keys_are_unique() -> None:
    keys = [spec.key for spec in FIELDS]

    assert len(keys) == len(set(keys))
    assert "item.title" in keys and "channel.title" in keys


def test_a_new_episode_names_what_each_missing_fact_needs(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    project.feed = FeedSection()

    view = resolve(inputs(project, files=ExportFiles()), {})

    assert view.item["item.title"].source.kind == "derived"
    intro = view.item["item.intro"].source
    assert isinstance(intro, Pending) and intro.fix == InputFix(key="item.intro")
    assert view.item["item.pubDate"].source == Pending(
        why="Set when you export.", fix=CommandFix(command="export_episode")
    )
    assert view.item["item.enclosure.url"].source.why == "Where will this be hosted?"
    assert view.sections.audio.source.fix == CommandFix(command="export_episode")
    assert view.file == "none"


def test_the_show_fact_is_none_choose_or_ready(tmp_path: Path) -> None:
    project = make_project(tmp_path, speakers=("Ana Reyes", "Mira Calder"))
    two = [ShowSummary("a", "Alpha"), ShowSummary("b", "Beta")]

    none = resolve(inputs(project), {}).show
    choose = resolve(inputs(project, shows=two), {}).show
    ready = resolve(inputs(project, show=complete_show()), {}).show

    assert none.kind == "none" and none.suggest.language == "English"
    assert [h.name for h in none.suggest.hosts] == ["Ana Reyes", "Mira Calder"]
    assert [s.id for s in choose.shows] == ["a", "b"]
    assert ready.id == "long-river"


def test_without_a_show_one_blocker_stands_in_for_every_show_fact(tmp_path: Path) -> None:
    project = make_project(tmp_path)

    view = resolve(inputs(project), {})
    chosen = resolve(inputs(project, shows=[ShowSummary("a", "A"), ShowSummary("b", "B")]), {})

    assert next((f.key, f.severity, f.fix) for f in view.findings if f.severity == "blocker") == (
        None,
        "blocker",
        CommandFix(command="create_show"),
    )
    assert chosen.findings[0].fix == CommandFix(command="link_show")
    assert not [f for f in view.findings if (f.key or "").startswith("channel.")]
    assert view.channel["channel.title"].source.fix == CommandFix(command="create_show")


def test_a_complete_episode_has_no_blockers_or_warnings(tmp_path: Path) -> None:
    project = make_project(tmp_path)

    view = resolve(inputs(project, show=complete_show()), {"item.intro": pin("A walk.")})

    assert _findings(view, "blocker") == [] and _findings(view, "warn") == []
    assert [f.key for f in view.findings] == ["item.episode"]
    assert view.item["item.enclosure.url"].value.endswith("nobody_asked_the_river.mp3")
    assert view.item["item.enclosure.length"].value == 49_920_000


def test_findings_are_ordered_blockers_then_warnings_then_info(tmp_path: Path) -> None:
    project = make_project(tmp_path)

    view = resolve(inputs(project, show=complete_show(media_url=None)), {})

    assert [f.severity for f in view.findings] == ["blocker", "warn", "info"]
    blocker = view.findings[0]
    assert (blocker.key, blocker.platform, blocker.fix) == (
        "item.enclosure.url",
        "RSS",
        InputFix(key="item.enclosure.url"),
    )
    assert view.findings[1].platform == "Apple"


def test_a_wav_only_export_is_a_blocker_that_sends_the_person_to_export(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    files = ExportFiles(wav=ExportFile("nobody_asked_the_river.wav", 10, 3120.0))

    view = resolve(inputs(project, show=complete_show(), files=files), {})

    blocker = next(f for f in view.findings if f.key == "item.enclosure.length")
    assert "WAV" in blocker.message and blocker.fix == CommandFix(command="export_episode")
    assert view.item["item.duration"].value == 3120
    assert view.item["item.duration"].source.kind == "measured"


def test_a_pin_wins_and_a_matching_auto_value_is_not_drift(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    world = inputs(project, show=complete_show())
    pins = edited_pins(world, {}, _set("item.title", "New name"), "agent")

    view = resolve(world, pins)

    fact = view.item["item.title"]
    assert fact.value == "New name"
    assert (fact.source.kind, fact.source.by, fact.source.drifted) == ("pinned", "agent", False)
    assert pins["item.title"].basis == digest("Nobody asked the river")


def test_a_pin_drifts_when_the_value_it_replaced_moves_and_keep_mine_resets_the_basis(
    tmp_path: Path,
) -> None:
    project = make_project(tmp_path)
    world = inputs(project, show=complete_show())
    project.feed.pins = edited_pins(world, {}, _set("item.title", "Mine"), "person")

    project.name = "Renamed upstream"
    drifted = resolve(world, project.feed.pins)

    assert drifted.item["item.title"].source.drifted is True
    assert "title" in drifted.drift_detail["item.title"]
    assert ("item.title", "info") in _findings(drifted)
    kept = edited_pins(world, project.feed.pins, _set("item.title", "Mine"), "person")
    assert resolve(world, kept).item["item.title"].source.drifted is False
    used_new = edited_pins(world, project.feed.pins, _unset("item.title"), "person")
    assert resolve(world, used_new).item["item.title"].value == "Renamed upstream"


def test_notes_drift_when_a_chapter_changes_after_they_were_pinned(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    world = inputs(project, show=complete_show())
    pins = edited_pins(world, {}, _set("item.notes", "My notes."), "person")
    assert "item.notes" in resolve(world, pins).item
    assert resolve(world, pins).item["item.notes"].source.drifted is False

    project.chapters[1].title = "The new mill"

    view = resolve(world, pins)
    assert view.item["item.notes"].source.drifted is True
    assert view.notes_html == "<p>My notes.</p>"


def test_notes_are_composed_and_hidden_until_pinned(tmp_path: Path) -> None:
    project = make_project(tmp_path, speakers=("Ana Reyes", "Dr. Mira Calder"))
    with_transcript(project)
    world = inputs(
        project,
        show=complete_show(),
        files=ExportFiles(audio=mp3(), transcripts=(ExportFile("nobody_asked_the_river.vtt", 5),)),
    )

    view = resolve(world, {"item.intro": pin("A walk & a <talk>.")})

    assert "item.notes" not in view.item
    assert view.notes_html == (
        "<p>A walk &amp; a &lt;talk&gt;.</p>"
        "<p>Chapters</p><ol><li>0:00 Cold open</li><li>5:12 The old mill</li></ol>"
        "<p>With</p><ul><li>Ana Reyes, host</li><li>Dr. Mira Calder, guest</li></ul>"
        '<p><a href="https://cdn.example.test/long-river/nobody_asked_the_river.vtt">Transcript</a></p>'
    )


def test_a_long_chapter_list_uses_hours_in_the_notes(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    project.chapters[1].time = 3723.2

    view = resolve(inputs(project, show=complete_show()), {})

    assert "<li>1:02:03 The old mill</li>" in view.notes_html


def test_an_unmatched_speaker_is_a_guest_with_a_warning_that_a_pin_resolves(tmp_path: Path) -> None:
    project = make_project(tmp_path, speakers=("Ana Reyes", "Mira Calder"))
    world = inputs(project, show=complete_show())

    view = resolve(world, {})

    assert [(c.name, c.role) for c in view.sections.credits.value] == [
        ("Ana Reyes", "host"),
        ("Mira Calder", "guest"),
    ]
    warn = next(f for f in view.findings if f.key == "item.person[Mira Calder].role")
    assert (warn.severity, warn.platform) == ("warn", "Podcasting 2.0")
    pins = edited_pins(
        world, {}, _set("item.person[Mira Calder].href", "https://mira.example.test"), "person"
    )
    pins = edited_pins(world, pins, _set("item.person[Mira Calder].role", "guest"), "person")
    after = resolve(world, pins)
    assert after.sections.credits.value[1].href == "https://mira.example.test"
    assert not [f for f in after.findings if (f.key or "").startswith("item.person")]


def test_a_person_can_be_left_out_of_the_listing(tmp_path: Path) -> None:
    project = make_project(tmp_path, speakers=("Ana Reyes", "Mira Calder"))
    world = inputs(project, show=complete_show())
    pins = edited_pins(world, {}, _set("item.person[Mira Calder].exclude", True), "person")

    names = [c.name for c in resolve(world, pins).sections.credits.value]

    assert names == ["Ana Reyes"]


def test_speakers_come_from_dialogue_tracks_by_name_once(tmp_path: Path) -> None:
    project = make_project(tmp_path, speakers=("Ana Reyes", "ana reyes", " "))

    view = resolve(inputs(project, show=complete_show()), {})

    assert [c.name for c in view.sections.credits.value] == ["Ana Reyes"]
    assert view.sections.credits.source.rule == "1 speaker"


def test_soundbites_are_the_approved_clips_and_odd_lengths_warn(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    add_clip(project, 612, 653, "Nobody asked the river")

    ok = resolve(inputs(project, show=complete_show()), {})
    add_clip(project, 10, 14, "Too short")
    short = resolve(inputs(project, show=complete_show()), {})

    assert [(s.title, s.start, s.end) for s in ok.sections.soundbites.value] == [
        ("Nobody asked the river", 612, 653)
    ]
    assert ok.sections.soundbites.source.rule == "1 approved clip"
    assert not [f for f in ok.findings if f.key == "item.soundbite"]
    assert [f.severity for f in short.findings if f.key == "item.soundbite"] == ["warn"]


def test_transcripts_are_the_exported_files_with_the_transcript_language(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    with_transcript(project, "pt-BR")
    files = ExportFiles(
        audio=mp3(),
        transcripts=(ExportFile("x.vtt", 1), ExportFile("x.srt", 2)),
    )

    view = resolve(inputs(project, show=complete_show(), files=files), {})

    assert [(t.format, t.language) for t in view.sections.transcripts.value] == [
        ("VTT", "pt-BR"),
        ("SRT", "pt-BR"),
    ]


def test_explicit_and_art_are_inherited_from_the_show_until_pinned(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    world = inputs(project, show=complete_show())

    view = resolve(world, {})
    own = resolve(
        world,
        edited_pins(world, {}, _set("item.image", "https://cdn.example.test/ep.jpg"), "person"),
    )

    assert view.item["item.explicit"].source.from_ == "channel.explicit"
    assert view.sections.art.source.from_ == "channel.image"
    assert view.sections.art.value.alt == "The Long River cover art"
    assert own.sections.art.value.src == "https://cdn.example.test/ep.jpg"
    assert own.sections.art.source.kind == "pinned"


def test_the_channel_language_follows_the_transcript_until_the_show_sets_one(
    tmp_path: Path,
) -> None:
    project = make_project(tmp_path)
    with_transcript(project, "es")
    show = complete_show()
    pins = {k: v for k, v in show.pins.items() if k != "channel.language"}

    view = resolve(inputs(project, show=complete_show(pins=pins)), {})

    assert view.channel["channel.language"].value == "es"
    assert view.channel["channel.language"].source.kind == "derived"


def test_a_show_pin_is_read_from_the_show_not_the_episode(tmp_path: Path) -> None:
    project = make_project(tmp_path)

    view = resolve(inputs(project, show=complete_show()), {"channel.title": pin("Ignored")})

    assert view.channel["channel.title"].value == "The Long River"


def test_notes_over_the_platform_limits_warn_by_platform(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    world = inputs(project, show=complete_show())

    four_k = resolve(world, {"item.notes": pin("x" * 4001)})
    ten_k = resolve(world, {"item.notes": pin("x" * 10_001)})

    assert [f.platform for f in four_k.findings if f.key == "item.notes"] == ["PSP-1"]
    assert sorted(f.platform for f in ten_k.findings if f.key == "item.notes") == ["Apple", "PSP-1"]


def test_a_long_title_is_an_info_for_spotify(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    project.name = "T" * 101

    view = resolve(inputs(project, show=complete_show()), {})

    assert ("item.title", "info") in _findings(view)


def test_file_state_compares_the_rendered_feed_with_the_file_on_disk(tmp_path: Path) -> None:
    from podcast_mcp.feed.render import render

    project = make_project(tmp_path)
    world = inputs(project, show=complete_show())
    xml = render(resolve(world, {}))
    on_disk = inputs(project, show=complete_show(), files=ExportFiles(audio=mp3(), feed_xml=xml))

    assert resolve(on_disk, {}).file == "current"
    assert resolve(on_disk, {"item.intro": pin("New")}).file == "stale"
    assert resolve(world, {}).file == "none"


def test_the_empty_string_unsets_and_unsetting_nothing_changes_nothing(tmp_path: Path) -> None:
    world = inputs(make_project(tmp_path), show=complete_show())
    pins = {"item.intro": pin("Hello")}

    assert edited_pins(world, pins, _set("item.intro", ""), "person") == {}
    assert edited_pins(world, pins, _unset("item.title"), "person") == pins
    assert edited_pins(world, pins, _unset("item.nope"), "agent") == pins


@pytest.mark.parametrize(
    ("key", "value", "code"),
    [
        ("item.nope", "x", "feed_field_unknown"),
        ("item.guid", "urn:uuid:other", "feed_field_not_editable"),
        ("item.duration", 5, "feed_field_not_editable"),
        ("item.chapters", "x", "feed_field_edit_at_source"),
        ("item.enclosure.url", "http://cdn.example.test/a.mp3", "feed_value_invalid"),
        ("item.enclosure.url", "https://cdn.example.test/é.mp3", "feed_value_invalid"),
        ("item.season", 0, "feed_value_invalid"),
        ("item.pubDate", "next tuesday", "feed_value_invalid"),
        ("item.person[Ana].href", "ftp://x", "feed_value_invalid"),
        ("item.explicit", "maybe", "feed_value_invalid"),
    ],
)
def test_a_bad_edit_is_refused_with_a_code(
    tmp_path: Path, key: str, value: object, code: str
) -> None:
    world = inputs(make_project(tmp_path), show=complete_show())

    with pytest.raises(CodedValueError) as raised:
        edited_pins(world, {}, _set(key, value), "person")

    assert raised.value.code == code


def test_lookup_knows_fields_and_person_attributes_only() -> None:
    assert lookup("item.title") is FIELDS[[s.key for s in FIELDS].index("item.title")]
    assert lookup("item.person[Ana Reyes].img").key == "item.person[Ana Reyes].img"
    assert lookup("item.person[Ana].nickname") is None
    assert lookup("nothing") is None


def test_identity_is_minted_once() -> None:
    feed = FeedSection()

    assert feed.mint_identity(EXPORTED_AT) is True
    guid, first = feed.guid, feed.first_exported_at
    assert guid.startswith("urn:uuid:") and first == EXPORTED_AT
    assert feed.mint_identity(EXPORTED_AT.replace(year=2030)) is False
    assert (feed.guid, feed.first_exported_at) == (guid, first)


def test_the_hosted_audio_address_follows_the_template_and_the_export(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    show = complete_show(media_url="https://cdn.example.test/{file}")
    files = ExportFiles(audio=mp3("Episode 12 ü.mp3"))

    view = resolve(inputs(project, show=show, files=files), {})

    assert (
        view.item["item.enclosure.url"].value
        == "https://cdn.example.test/Episode%2012%20%C3%BC.mp3"
    )
    assert view.item["item.enclosure.type"].value == "audio/mpeg"
    assert (
        resolve(inputs(project, show=show, files=ExportFiles(audio=mp3("e.m4a"))), {})
        .item["item.enclosure.type"]
        .value
        == "audio/x-m4a"
    )


def test_every_person_in_the_roster_keeps_their_attributes(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    roster = (
        Person(
            "Ana Reyes",
            role="host",
            group="cast",
            img="https://i.example.test/a.jpg",
            href="https://a.example.test",
        ),
    )

    view = resolve(inputs(project, show=complete_show(roster=roster)), {})

    credit = view.sections.credits.value[0]
    assert (credit.img, credit.href, credit.group) == (
        "https://i.example.test/a.jpg",
        "https://a.example.test",
        None,
    )
