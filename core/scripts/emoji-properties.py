"""Writes config/emoji-properties.txt: the Extended_Pictographic and Emoji_Modifier code points the rules reviewer reads
(contract §5.3, to spare a variation selector or joiner inside an emoji), as code-point ranges, so a line is reviewed the
same on every machine whatever Unicode version its runtime knows. The reviewer reads only this table, never the
runtime's \\p{...}.

The ranges come from the extract of emoji-data.txt kept beside this script (its lines copied exactly), so it runs offline
with any python3. Each property's code points must add up to the extract's own "# Total elements:" line, and the extract
must keep the original's version line.

    python3 scripts/emoji-properties.py            # write the table
    python3 scripts/emoji-properties.py --check    # exit 1 if the committed table differs from a fresh run
    python3 scripts/emoji-properties.py --verify   # fetch the original file and check the extract against it
"""

import hashlib
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
extract_file = root / "scripts" / "unicode" / "emoji-data-16.0.0-Emoji_Modifier_Extended_Pictographic.txt"
out = root / "config" / "emoji-properties.txt"
VERSION = "16.0"
VERSION_LINE = f"# Used with Emoji Version {VERSION} and subsequent minor revisions (if any)"
PROPERTIES = ["Extended_Pictographic", "Emoji_Modifier"]

extract = extract_file.read_text(encoding="utf-8")
if VERSION_LINE not in extract.splitlines():
    sys.exit(f"the extract doesn't keep emoji-data.txt's version line for Emoji {VERSION}")


def points(prop):
    found = set()
    for line in extract.splitlines():
        m = re.match(r"^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*; " + prop + r"\b", line)
        if m:
            found.update(range(int(m.group(1), 16), int(m.group(2) or m.group(1), 16) + 1))
    section = extract[extract.index(f"have {prop}=No") :]
    total = int(re.search(r"^# Total elements: (\d+)$", section, re.M).group(1))
    if len(found) != total:
        sys.exit(f"the extract lists {len(found)} {prop} code points, but its total line says {total}")
    return found


def ranges(found):
    out_ranges = []
    start = None
    for cp in range(0x110001):
        inside = cp in found
        if inside and start is None:
            start = cp
        elif not inside and start is not None:
            out_ranges.append(f"{start:04X}" if start == cp - 1 else f"{start:04X}..{cp - 1:04X}")
            start = None
    return out_ranges


def table():
    lines = [
        "# The emoji properties the rules reviewer reads (contract §5.3), as code-point ranges (hex), sorted, each section after its [property] line.",
        f"# Emoji {VERSION}, made by scripts/emoji-properties.py from scripts/unicode/{extract_file.name}.",
    ]
    for prop in PROPERTIES:
        lines.append(f"[{prop}]")
        lines.extend(ranges(points(prop)))
    return "\n".join(lines) + "\n"


if "--verify" in sys.argv:
    import urllib.request

    recorded = re.search(r"\(SHA-256 ([0-9a-f]{64}), (\d+) bytes\)", extract)
    with urllib.request.urlopen("https://www.unicode.org/Public/16.0.0/ucd/emoji/emoji-data.txt", timeout=60) as r:
        original = r.read()
    if hashlib.sha256(original).hexdigest() != recorded.group(1) or len(original) != int(recorded.group(2)):
        sys.exit("the original's SHA-256 or size isn't the one the extract records")
    original_lines = set(original.decode("utf-8").splitlines())
    copied = [l for l in extract.splitlines()[3:] if l and l not in original_lines]
    if copied:
        sys.exit(f"these extract lines aren't in the original: {copied[:3]}")
    print(f"the extract matches the original ({recorded.group(1)})")
elif "--check" in sys.argv:
    if out.read_text(encoding="utf-8") != table():
        sys.exit("config/emoji-properties.txt differs from a fresh run: run scripts/emoji-properties.py")
    print("config/emoji-properties.txt matches a fresh run")
else:
    text = table()
    out.write_text(text, encoding="utf-8")
    print(f"wrote {out}: {len(text.splitlines()) - 2 - len(PROPERTIES)} ranges")
