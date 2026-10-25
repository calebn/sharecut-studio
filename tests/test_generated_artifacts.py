"""Every generated artifact and contract check runs under pytest, so CI and `make test` agree."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
WORKFLOW = ROOT / ".github" / "workflows" / "test.yml"

PYTEST_JOB_CHECKS: tuple[tuple[str, ...], ...] = (
    ("export_document_command_schema.py", "--check"),
    ("export_docs_site_contract.py", "--check"),
    ("export_capabilities_docs.py", "--check"),
    ("check_capabilities_manifest.py",),
    ("check_extension_contracts.py",),
    ("check_progress.py",),
    ("decisions_index.py", "--check"),
    ("export_pipeline_params.py", "--check"),
)
# These exporters format their output with Biome from gui/web/node_modules, which the
# pytest job does not install. The frontend job runs them after `npm ci`.
FRONTEND_JOB_CHECKS: tuple[str, ...] = (
    "scripts/export_capabilities_copy.py --check",
    "scripts/export_timeline_zoom.py --check",
    "scripts/export_limit_contracts.py --check",
    "scripts/export_project_types.py --check",
)


def _run(script: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPTS / script), *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize("check", PYTEST_JOB_CHECKS, ids=[" ".join(c) for c in PYTEST_JOB_CHECKS])
def test_generated_artifact_is_current(check: tuple[str, ...]) -> None:
    result = _run(*check)
    assert result.returncode == 0, result.stdout + result.stderr


def test_every_checkable_exporter_is_covered() -> None:
    covered = {check[0] for check in PYTEST_JOB_CHECKS}
    covered |= {Path(command.split()[0]).name for command in FRONTEND_JOB_CHECKS}
    exporters = {
        path.name
        for path in SCRIPTS.glob("export_*.py")
        if "--check" in path.read_text(encoding="utf-8")
    }
    assert exporters - covered == set()


@pytest.mark.parametrize("command", FRONTEND_JOB_CHECKS)
def test_biome_formatted_exporters_run_in_the_frontend_job(command: str) -> None:
    assert f"python3 {command}" in WORKFLOW.read_text(encoding="utf-8")


def test_project_type_generator_fails_on_a_schema_shape_it_cannot_express(monkeypatch) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    gen = load_script("export_project_types", register=True)
    assert gen._declaration("AnyModel", {"title": "Any"}) == "export type AnyModel = unknown;\n"
    with pytest.raises(ValueError, match="unhandled JSON-schema shape"):
        gen._declaration("UnsupportedModel", {"not": {"type": "string"}})


def test_project_type_generator_reports_model_and_nested_schema_path(monkeypatch) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    gen = load_script("export_project_types", register=True)
    monkeypatch.setattr(
        gen,
        "_definitions",
        lambda: {
            "DiagnosticModel": {
                "type": "object",
                "properties": {"nested": {"type": "array", "items": {"not": {"type": "string"}}}},
            }
        },
    )

    with pytest.raises(ValueError, match="unhandled JSON-schema shape") as exc_info:
        gen.project_types()

    message = str(exc_info.value)
    assert "DiagnosticModel" in message
    assert '$["properties"]["nested"]["items"]' in message


@pytest.mark.parametrize(
    ("schema", "path"),
    [
        ({"not": {}}, "$"),
        ({"properties": {"field": {"not": {}}}}, '$["properties"]["field"]'),
        ({"type": "array", "items": {"not": {}}}, '$["items"]'),
        (
            {"type": "array", "prefixItems": [{"type": "string"}, {"not": {}}]},
            '$["prefixItems"][1]',
        ),
        ({"anyOf": [{"type": "string"}, {"type": "string"}, {"not": {}}]}, '$["anyOf"][2]'),
        ({"oneOf": [{"type": "string"}, {"not": {}}]}, '$["oneOf"][1]'),
        ({"allOf": [{"type": "string"}, {"not": {}}]}, '$["allOf"][1]'),
        ({"type": ["string", "unsupported"]}, '$["type"][1]'),
        ({"additionalProperties": {"not": {}}}, '$["additionalProperties"]'),
        (
            {"type": ["null", "array"], "items": {"not": {}}},
            '$["items"]',
        ),
        (
            {"anyOf": [{"type": ["object"], "properties": {"field": {"not": {}}}}]},
            '$["anyOf"][0]["properties"]["field"]',
        ),
        (
            {"type": ["array"], "items": {"type": ["null", "unsupported"]}},
            '$["items"]["type"][1]',
        ),
        (
            {"properties": {"outer": {"type": "object", "properties": {"inner": {"not": {}}}}}},
            '$["properties"]["outer"]["properties"]["inner"]',
        ),
        ({"properties": {"a.b[0]/~": {"not": {}}}}, '$["properties"]["a.b[0]/~"]'),
        ({"properties": {'quote"\\line\n': {"not": {}}}}, r'$["properties"]["quote\"\\line\n"]'),
        ({"properties": {"": {"not": {}}}}, '$["properties"][""]'),
        ({"properties": {"é": {"not": {}}}}, r'$["properties"]["\u00e9"]'),
    ],
)
def test_project_type_generator_locates_unsupported_source_nodes(
    monkeypatch, schema: dict[str, Any], path: str
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    gen = load_script("export_project_types", register=True)
    model = 'Diagnostic\n"Model'
    with pytest.raises(ValueError, match="unhandled JSON-schema shape") as exc_info:
        gen._declaration(model, schema)
    message = str(exc_info.value)
    assert f"in model {model!r} at {path}" in message


def test_project_type_generator_attributes_referenced_definition_failure(monkeypatch) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    gen = load_script("export_project_types", register=True)
    monkeypatch.setattr(
        gen,
        "_definitions",
        lambda: {
            "ParentModel": {"properties": {"child": {"$ref": "#/$defs/ChildModel"}}},
            "ChildModel": {"not": {}, "if": {}},
        },
    )
    with pytest.raises(ValueError, match="unhandled JSON-schema shape") as exc_info:
        gen.project_types()
    assert str(exc_info.value) == (
        "export_project_types: unhandled JSON-schema shape ['if', 'not'] in model 'ChildModel' at $"
    )


@pytest.mark.parametrize(
    ("schema", "rendered"),
    [
        ({}, "unknown"),
        *[
            ({key: value}, "unknown")
            for key, value in {
                "title": "Any",
                "description": "",
                "default": None,
                "examples": [],
                "deprecated": True,
                "readOnly": True,
                "writeOnly": True,
                "$comment": "Any",
            }.items()
        ],
        ({"title": "Any", "deprecated": True, "default": None, "$comment": "Any"}, "unknown"),
        ({"type": "array"}, "Array<unknown>"),
        ({"type": "object"}, "Record<string, unknown>"),
        *[
            ({"additionalProperties": extra}, "Record<string, unknown>")
            for extra in ({}, True, False)
        ],
        ({"type": "string", "not": {}}, "string"),
        ({"$ref": "#/$defs/ChildModel", "not": {}}, "ChildModel"),
        ({"const": "fixed", "not": {}}, '"fixed"'),
        ({"enum": [None, True, 2], "not": {}}, "null | true | 2"),
        ({"anyOf": [{"type": "string"}, {"type": "string"}], "not": {}}, "string"),
        ({"oneOf": [{"type": "null"}, {"type": "boolean"}]}, "null | boolean"),
        ({"allOf": [{"type": "string"}, {"type": "number"}]}, "string & number"),
        ({"type": ["integer", "null"]}, "number | null"),
        (
            {"type": "array", "prefixItems": [{"type": "string"}, {"type": "boolean"}]},
            "[string, boolean]",
        ),
        ({"additionalProperties": {"type": "number"}}, "Record<string, number>"),
        ({"type": ["unsupported"], "additionalProperties": True}, "Record<string, unknown>"),
    ],
)
def test_project_type_generator_preserves_accepted_shapes(
    monkeypatch, schema: dict[str, Any], rendered: str
) -> None:
    monkeypatch.syspath_prepend(str(SCRIPTS))
    gen = load_script("export_project_types", register=True)
    assert gen._declaration("AcceptedModel", schema) == f"export type AcceptedModel = {rendered};\n"


@pytest.mark.parametrize("check", [False, True], ids=["write", "check"])
@pytest.mark.parametrize("existing", [False, True], ids=["absent", "sentinels"])
def test_project_type_generator_cli_failure_preserves_outputs(
    tmp_path, check: bool, existing: bool
) -> None:
    paths = [tmp_path / "project.ts", tmp_path / "commands.ts"]
    sentinels = [b"project sentinel\n", b"commands sentinel\n"]
    if existing:
        for path, content in zip(paths, sentinels, strict=True):
            path.write_bytes(content)
    source = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv.pop(1))
import export_project_types as gen
gen.PROJECT_OUT = Path(sys.argv.pop(1))
gen.COMMANDS_OUT = Path(sys.argv.pop(1))
gen._definitions = lambda: {
    "ValidModel": {"type": "string"},
    "DiagnosticModel": {"properties": {"nested": {"type": "array", "items": {"not": {}}}}},
}
raise SystemExit(gen.main())
"""
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            source,
            str(SCRIPTS),
            *map(str, paths),
            *(["--check"] if check else []),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1, result.stdout + result.stderr
    assert "ValueError: export_project_types: unhandled JSON-schema shape ['not']" in result.stderr
    assert 'in model \'DiagnosticModel\' at $["properties"]["nested"]["items"]' in result.stderr
    assert result.stdout == ""
    for path, content in zip(paths, sentinels, strict=True):
        if existing:
            assert path.read_bytes() == content
        else:
            assert not path.exists()
