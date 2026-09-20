from podcast_mcp.edits.track_ids import SAFE_TRACK_ID, slug_track_id


def test_slug_track_id_strips_path_segments():
    assert slug_track_id("../evil/passwd") == "evil_passwd"
    assert slug_track_id("Host Mic!") == "host_mic"
    assert slug_track_id("!!!") == "track"
    assert slug_track_id("host") == "host"


def test_safe_track_id_rejects_dots_and_slashes():
    assert SAFE_TRACK_ID.fullmatch("host_mic-2")
    assert not SAFE_TRACK_ID.fullmatch("../evil")
    assert not SAFE_TRACK_ID.fullmatch("foo/bar")
