# /// script
# requires-python = ">=3.11"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Export pinned Flatpak packaging for a published Carrier tag. Does not submit it."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import urllib.request

import yaml


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", help="Published release tag, e.g. v1.13.0")
    parser.add_argument("output", type=Path, help="New output directory")
    args = parser.parse_args()
    if not re.fullmatch(r"v\d+\.\d+\.\d+", args.tag):
        parser.error("tag must be a stable vMAJOR.MINOR.PATCH release")
    if args.output.exists():
        parser.error("output must not already exist")

    packaging = Path(__file__).resolve().parent
    root = packaging.parent.parent
    app_id = "io.github.kristofferr.carrier"
    metadata_path = root / f"src-tauri/linux/{app_id}.metainfo.xml"

    try:
        release_commit = subprocess.run(
            ["git", "rev-parse", "--verify", f"{args.tag}^{{commit}}"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        checkout_commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", release_commit, checkout_commit],
            cwd=root,
            check=True,
            capture_output=True,
        )
        committed_metadata = subprocess.run(
            [
                "git",
                "show",
                f"{checkout_commit}:{metadata_path.relative_to(root).as_posix()}",
            ],
            cwd=root,
            check=True,
            capture_output=True,
        ).stdout
    except subprocess.CalledProcessError:
        parser.error("tag must resolve to an ancestor of the packaging checkout")

    metadata = metadata_path.read_bytes()
    if metadata != committed_metadata:
        parser.error("AppStream metadata must be committed")
    checkout_version = json.loads((root / "package.json").read_text())["version"]
    if checkout_version != args.tag[1:]:
        parser.error("checkout application version differs from tag")
    url = f"https://github.com/kristofferR/Carrier/archive/{release_commit}.tar.gz"
    with urllib.request.urlopen(url, timeout=120) as response:
        archive = response.read()
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as source:
        prefix = f"Carrier-{release_commit}"
        lockfile = source.extractfile(f"{prefix}/src-tauri/Cargo.lock")
        if lockfile is None or lockfile.read() != (root / "src-tauri/Cargo.lock").read_bytes():
            parser.error("tag Cargo.lock differs; regenerate cargo-sources.json from that tag first")
        package = source.extractfile(f"{prefix}/package.json")
        if package is None or json.load(package)["version"] != args.tag[1:]:
            parser.error("tag and application version differ")

    manifest = yaml.safe_load((packaging / f"{app_id}.yml").read_text())
    manifest["modules"][0]["sources"] = [
        {"type": "archive", "url": url, "sha256": hashlib.sha256(archive).hexdigest()},
        {"type": "file", "path": f"{app_id}.metainfo.xml", "dest": "src-tauri/linux"},
        "cargo-sources.json",
    ]
    metadata_text = metadata.decode()
    if f'<release version="{args.tag[1:]}"' not in metadata_text:
        parser.error("AppStream metadata needs release notes for this version")

    args.output.mkdir(parents=True)
    (args.output / f"{app_id}.yml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    (args.output / f"{app_id}.metainfo.xml").write_text(metadata_text)
    shutil.copyfile(packaging / "cargo-sources.json", args.output / "cargo-sources.json")
    print(f"Prepared {args.output / f'{app_id}.yml'}")


if __name__ == "__main__":
    main()
