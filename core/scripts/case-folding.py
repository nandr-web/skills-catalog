"""Writes config/case-folding.txt: Unicode full case folding (CaseFolding.txt statuses C and F), one mapping per line.

JavaScript has no full case fold, and toUpperCase/toLowerCase alone miss some ("ẞ" never becomes "ss"), so the core
reads this table. Python's str.casefold() is full case folding; the header records the Unicode version it used.

    python3 scripts/case-folding.py
"""

import sys
import unicodedata
from pathlib import Path

out = Path(__file__).resolve().parent.parent / "config" / "case-folding.txt"
lines = [
    "# Unicode full case folding (CaseFolding.txt, statuses C and F), for every \"ignoring case\" rule (contract §4.2).",
    f"# Unicode {unicodedata.unidata_version}, made by scripts/case-folding.py from Python {sys.version.split()[0]}'s str.casefold().",
    "# Each line: a code point, then what it folds to (hex). Code points not listed fold to themselves.",
]
for cp in range(0x110000):
    if 0xD800 <= cp <= 0xDFFF:
        continue
    c = chr(cp)
    folded = c.casefold()
    if folded != c:
        lines.append(f"{cp:04X} " + " ".join(f"{ord(x):04X}" for x in folded))
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"wrote {out}: {len(lines) - 3} mappings")
