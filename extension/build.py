"""Bundle terminal.html and terminal.css into ui-assets.js.

The content script renders the terminal inside an isolated shadow root, so its
markup and styles ship as one generated script instead of page resources.
Edit the HTML and CSS sources, then run `npm run build`.
"""

import json
from pathlib import Path

SOURCE = Path(__file__).resolve().parent


def body_markup(document: str) -> str:
    """Return the markup between <body> and </body>."""
    return document.split("<body>", 1)[1].split("</body>", 1)[0]


assets = {
    "html": body_markup((SOURCE / "terminal.html").read_text(encoding="utf-8")),
    "css": (SOURCE / "terminal.css").read_text(encoding="utf-8"),
}
(SOURCE / "ui-assets.js").write_text(
    "globalThis.FiggieTerminalAssets = " + json.dumps(assets) + ";\n",
    encoding="utf-8",
)
