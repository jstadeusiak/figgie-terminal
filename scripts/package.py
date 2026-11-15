"""Package the files Chrome loads into a release zip.

The archive holds the manifest, the content scripts it lists, the service
worker, and the scripts that worker imports. Everything else in the extension
directory (UI sources, replay tools, frozen replay engines) stays out.
"""

import json
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extension"


def worker_imports(worker: str) -> list[str]:
    """Return the scripts named in the service worker's importScripts call."""
    source = (SOURCE / worker).read_text(encoding="utf-8")
    call = re.search(r"importScripts\((.*?)\)", source, re.DOTALL)
    return re.findall(r"'([^']+)'", call.group(1))


manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
worker = manifest["background"]["service_worker"]
files = {"manifest.json", worker, *worker_imports(worker)}
for entry in manifest["content_scripts"]:
    files.update(entry.get("js", []))
    files.update(entry.get("css", []))

target = ROOT / "dist" / f"figgie-terminal-{manifest['version']}.zip"
target.parent.mkdir(exist_ok=True)
with ZipFile(target, "w", ZIP_DEFLATED) as archive:
    for name in sorted(files):
        archive.write(SOURCE / name, name)
print(target)
