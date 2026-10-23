from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def origin(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ValueError("Expected an HTTP(S) URL without userinfo")
    if any(char.isspace() or char in '"<>\\' for char in parsed.netloc):
        raise ValueError("Invalid origin")
    return (
        parsed.scheme,
        parsed.hostname.lower(),
        parsed.port or (443 if parsed.scheme == "https" else 80),
    )


class IndexAnchor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.in_head = False
        self.charset_seen = False
        self.first_script: tuple[int, int, bool, bool] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "head":
            self.in_head = True
        elif tag == "meta" and self.in_head and any(key == "charset" for key, _ in attrs):
            self.charset_seen = True
        elif tag == "script" and self.first_script is None:
            row, column = self.getpos()
            self.first_script = row, column, self.in_head, self.charset_seen

    def handle_endtag(self, tag: str) -> None:
        if tag == "head":
            self.in_head = False


def inventory(root: Path) -> dict[str, str]:
    paths = sorted(root.rglob("*"))
    if any(path.is_symlink() for path in paths):
        raise ValueError("Symlinks are not supported in this bounded fixture")
    return {
        str(path.relative_to(root)): sha256(path.read_bytes()) for path in paths if path.is_file()
    }


def stage(
    source: Path, output: Path, gate_path: Path, document_url: str, base_uri: str
) -> dict[str, object]:
    expected_origin = origin(document_url)
    if origin(base_uri) != expected_origin:
        raise ValueError("Unexpected cross-origin base URI")
    if output.exists() or output.resolve().is_relative_to(source.resolve()):
        raise ValueError("Output must be new and outside the original build")
    manifest_path = output.parent / (output.name + "-manifest.json")
    if manifest_path.exists():
        raise ValueError("Manifest path already exists")
    original_files = inventory(source)
    if not (source / "assets").is_dir():
        raise ValueError("Expected the existing static assets directory")
    original = (source / "index.html").read_bytes()
    gate = gate_path.read_bytes()
    gate_hash = sha256(gate)
    added_path = "assets/qa2149-nav-gate-" + gate_hash + ".js"
    if (source / added_path).exists() or (source / added_path).is_symlink():
        raise ValueError("Gate asset path collides with an original source path")
    parsed_url = urlsplit(document_url)
    gate_url = urlunsplit((parsed_url.scheme, parsed_url.netloc, "/" + added_path, "", ""))
    if origin(urljoin(base_uri, gate_url)) != expected_origin:
        raise ValueError("Resolved gate URL is not same-origin")
    text = original.decode("utf-8")
    anchor = IndexAnchor()
    anchor.feed(text)
    if anchor.first_script is None or not anchor.first_script[2] or not anchor.first_script[3]:
        raise ValueError("Expected the first application script in head after the real charset")
    row, column, _, _ = anchor.first_script
    offset = len(
        text[: sum(len(line) + 1 for line in text.split("\n")[: row - 1]) + column].encode()
    )
    insertion = (
        '<script data-qa-2149="prebootstrap-nav-gate" src="'
        + escape(gate_url, quote=True)
        + '"></script>\n'
    ).encode()
    instrumented = original[:offset] + insertion + original[offset:]
    assert instrumented.replace(insertion, b"", 1) == original
    shutil.copytree(source, output)
    (output / "index.html").write_bytes(instrumented)
    with (output / added_path).open("xb") as handle:
        handle.write(gate)
    staged_files = inventory(output)
    assert set(staged_files) == set(original_files) | {added_path}
    assert all(
        staged_files[name] == digest
        for name, digest in original_files.items()
        if name != "index.html"
    )
    assert inventory(source) == original_files
    manifest = {
        "source_dist": str(source.resolve()),
        "output_dist": str(output.resolve()),
        "document_url": document_url,
        "base_uri": base_uri,
        "gate_url": gate_url,
        "added_gate_path": added_path,
        "gate_sha256": gate_hash,
        "html_insertion": insertion.decode(),
        "original_files_sha256": original_files,
        "staged_files_sha256": staged_files,
        "only_html_insertion_and_one_added_gate_file": True,
        "limitation": "Disk inventory is not HTTP/browser proof. Verify actual archived responses before any SHAM.",
    }
    with manifest_path.open("x") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    return manifest


def verify_archives(manifest: dict, evidence: dict) -> dict[str, object]:
    expected_origin = origin(manifest["document_url"])
    for key in ["original_document", "staged_document", "gate"]:
        item = evidence[key]
        if item["status"] != 200 or item["redirect_chain"] or item["url"] != item["final_url"]:
            raise ValueError("Unexpected response status or redirect: " + key)
        if origin(item["final_url"]) != expected_origin:
            raise ValueError("Unexpected response origin: " + key)
    original, staged, gate = (
        evidence[key] for key in ["original_document", "staged_document", "gate"]
    )
    if original["url"] != manifest["document_url"] or staged["url"] != original["url"]:
        raise ValueError("Document URL changed")
    if original["base_uri"] != manifest["base_uri"] or staged["base_uri"] != original["base_uri"]:
        raise ValueError("Base URI changed")
    if (
        not original["csp_headers"]
        or staged["csp_headers"] != original["csp_headers"]
        or gate["csp_headers"] != original["csp_headers"]
    ):
        raise ValueError("Missing or altered actual CSP response headers")
    if gate["url"] != manifest["gate_url"] or gate["resolved_script_url"] != manifest["gate_url"]:
        raise ValueError("Unexpected resolved gate URL")
    if gate["content_type"].split(";", 1)[0].strip().lower() not in {
        "application/javascript",
        "text/javascript",
    }:
        raise ValueError("Unexpected JavaScript MIME type")
    for document in [original, staged]:
        if document["content_type"].split(";", 1)[0].strip().lower() != "text/html":
            raise ValueError("Unexpected document MIME type")
    original_body = Path(original["body_path"]).read_bytes()
    staged_body = Path(staged["body_path"]).read_bytes()
    insertion = manifest["html_insertion"].encode()
    if staged_body.count(insertion) != 1 or staged_body.replace(insertion, b"", 1) != original_body:
        raise ValueError("Actual response differs beyond the one external script insertion")
    if sha256(Path(gate["body_path"]).read_bytes()) != manifest["gate_sha256"]:
        raise ValueError("Actual returned gate bytes do not match")
    loaded = evidence["loaded_original_assets"]
    if not loaded or set(loaded) != set(evidence["loaded_original_resource_paths"]):
        raise ValueError("Actual browser resource inventory and archived asset paths disagree")
    for name, body_path in loaded.items():
        digest = manifest["original_files_sha256"].get(name)
        if (
            digest is None
            or not name.endswith((".js", ".css"))
            or sha256(Path(body_path).read_bytes()) != digest
        ):
            raise ValueError("Loaded original asset bytes changed: " + name)
    return {
        "result": "PASS",
        "response_gate_sha256": manifest["gate_sha256"],
        "limit": "Archived-input checks only. Browser must still prove CSP allows execution, first-script metadata and SHAM ordering.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Stage or verify the same-origin external diagnostic"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    staging = commands.add_parser("stage")
    for flag in ["source-dist", "output-dist", "gate"]:
        staging.add_argument("--" + flag, type=Path, required=True)
    staging.add_argument("--document-url", required=True)
    staging.add_argument("--base-uri", required=True)
    checking = commands.add_parser("verify")
    checking.add_argument("--manifest", type=Path, required=True)
    checking.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "stage":
        result = stage(
            args.source_dist, args.output_dist, args.gate, args.document_url, args.base_uri
        )
    else:
        result = verify_archives(
            json.loads(args.manifest.read_text()), json.loads(args.evidence.read_text())
        )
    print(json.dumps(result, indent=2))
