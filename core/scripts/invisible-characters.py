"""Writes config/invisible-characters.txt: the whole invisible_character set (contract §4.2) for the case-folding table's
Unicode version, as code-point ranges, so a path is accepted or refused the same on every machine whatever Unicode
version its runtime knows. The path rule reads only this table, never the runtime's \\p{...}.

The set: every code point of general category C (format, control, surrogate, private use, unassigned), a line or
paragraph separator, a space separator other than the plain space, a default-ignorable code point, and U+2800 Braille
blank. The categories come from Python's unicodedata, and default-ignorable code points from the extract of the same
version's DerivedCoreProperties.txt kept beside this script (its lines copied exactly), so it runs offline.

    python3 scripts/invisible-characters.py            # write the table
    python3 scripts/invisible-characters.py --check    # exit 1 if the committed table differs from a fresh run
    python3 scripts/invisible-characters.py --verify   # fetch the original file and check the extract against it
"""

import hashlib
import re
import sys
import unicodedata
from pathlib import Path

root = Path(__file__).resolve().parent.parent
extract_file = root / "scripts" / "unicode" / "DerivedCoreProperties-16.0.0-Default_Ignorable_Code_Point.txt"
out = root / "config" / "invisible-characters.txt"
case_folding = root / "config" / "case-folding.txt"

extract = extract_file.read_text(encoding="utf-8")
version = re.search(r"^# DerivedCoreProperties-(\d+\.\d+\.\d+)\.txt$", extract, re.M).group(1)
folding_version = re.search(r"^# Unicode (\d+\.\d+\.\d+),", case_folding.read_text(encoding="utf-8"), re.M).group(1)
if version != folding_version:
    sys.exit(f"the extract is Unicode {version} but config/case-folding.txt is {folding_version}: they must be the same")
if unicodedata.unidata_version != version:
    sys.exit(f"this Python's unicodedata is Unicode {unicodedata.unidata_version}, not {version}: use a Python that has {version}")


def default_ignorable() -> set[int]:
    points: set[int] = set()
    for line in extract.splitlines():
        m = re.match(r"^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*; Default_Ignorable_Code_Point\b", line)
        if m:
            points.update(range(int(m.group(1), 16), int(m.group(2) or m.group(1), 16) + 1))
    total = int(re.search(r"^# Total code points: (\d+)$", extract, re.M).group(1))
    if len(points) != total:
        sys.exit(f"the extract lists {len(points)} default-ignorable code points, but its total line says {total}")
    return points


def invisible() -> list[str]:
    ignorable = default_ignorable()
    ranges: list[str] = []
    start = None
    for cp in range(0x110001):
        inside = cp <= 0x10FFFF and (
            (cat := unicodedata.category(chr(cp)))[0] == "C"
            or cat in ("Zl", "Zp")
            or (cat == "Zs" and cp != 0x20)
            or cp in ignorable
            or cp == 0x2800
        )
        if inside and start is None:
            start = cp
        elif not inside and start is not None:
            ranges.append(f"{start:04X}" if start == cp - 1 else f"{start:04X}..{cp - 1:04X}")
            start = None
    return ranges


def table() -> str:
    lines = [
        "# The invisible_character set for the path rule (contract §4.2), as code-point ranges (hex), sorted.",
        f"# Unicode {version}, made by scripts/invisible-characters.py from Python's unicodedata and",
        f"# scripts/unicode/{extract_file.name}.",
    ]
    return "\n".join(lines + invisible()) + "\n"


if "--verify" in sys.argv:
    import urllib.request

    recorded = re.search(r"\(SHA-256 ([0-9a-f]{64}), (\d+) bytes\)", extract)
    with urllib.request.urlopen(f"https://www.unicode.org/Public/{version}/ucd/DerivedCoreProperties.txt", timeout=60) as r:
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
        sys.exit("config/invisible-characters.txt differs from a fresh run: run scripts/invisible-characters.py")
    print("config/invisible-characters.txt matches a fresh run")
else:
    text = table()
    out.write_text(text, encoding="utf-8")
    print(f"wrote {out}: {len(text.splitlines()) - 3} ranges")
