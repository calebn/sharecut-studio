from pathlib import Path

import pytest

import test_service_result_types as guard


@pytest.mark.parametrize("definition", ["def", "async def"])
@pytest.mark.parametrize(
    "annotation",
    [
        "Annotated[dict, 'metadata']",
        "Annotated[Dict, 'metadata']",
        "Annotated[dict[str, object], 'metadata']",
        "typing.Annotated[typing.Dict[str, int], 'metadata']",
        "typing_extensions.Annotated[builtins.dict, 'metadata']",
        "'typing.Annotated[dict[str, object], metadata]'",
        "Annotated['dict[str, object]', 'metadata']",
        "Annotated[Annotated[dict, 'inner'], 'outer']",
        "Annotated[Optional[dict], 'metadata']",
        "Optional[Annotated[dict, 'metadata']]",
        "Annotated[typing.Union[None, dict[str, object]], 'metadata']",
        "typing.Union[None, Annotated[dict, 'metadata']]",
        "Annotated[dict | None, 'metadata']",
        "None | Annotated[dict, 'metadata']",
        "Annotated[dict, 'metadata'] | None",
        "Annotated[dict | Dict[str, int], 'metadata'] | dict",
    ],
)
def test_annotated_dict_returns_exceed_an_empty_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, definition: str, annotation: str
) -> None:
    (tmp_path / "new_service.py").write_text(
        f"{definition} read() -> {annotation}: ...", encoding="utf-8"
    )
    monkeypatch.setattr(guard, "SERVICES", tmp_path)

    counts = guard._counts()
    assert counts == {"new_service.py": 1}
    assert guard._over_cap(counts, {}) == {"new_service.py": 1}


@pytest.mark.parametrize("definition", ["def", "async def"])
@pytest.mark.parametrize(
    "annotation",
    [
        "Annotated[str, dict]",
        "typing.Annotated[Model, typing.Dict[str, int]]",
        "typing_extensions.Annotated[int, {'type': dict}]",
        "Annotated[str, Optional[dict], dict | None]",
        "Annotated[str, metadata(dict)]",
        "Annotated[str, 'dict[']",
        "Annotated[str, 'Union[dict,']",
        "Annotated[str, 'dict', 'dict[']",
        "Annotated[list[dict], 'metadata']",
        "list[Annotated[dict, 'metadata']]",
        "Annotated[Mapping[str, dict], 'metadata']",
        "Optional[Annotated[list[dict], 'metadata']]",
        "Annotated[Union[tuple[dict], None], 'metadata']",
        "Annotated[Annotated[str, dict], dict]",
        "'typing.Annotated[str, dict]'",
        "Annotated[()]",
        "Annotated[dict]",
    ],
)
def test_annotated_metadata_and_contained_dicts_do_not_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, definition: str, annotation: str
) -> None:
    (tmp_path / "other_service.py").write_text(
        f"{definition} read() -> {annotation}: ...", encoding="utf-8"
    )
    monkeypatch.setattr(guard, "SERVICES", tmp_path)

    counts = guard._counts()
    assert counts == {}
    assert guard._over_cap(counts, {}) == {}
