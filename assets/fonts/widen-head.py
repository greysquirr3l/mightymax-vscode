#!/usr/bin/env python3
"""
Widen the mightymax-head glyph in the bundled status-bar font by
8% horizontally, preserving vertical metrics.

Run from anywhere (the script resolves paths from its location):

    python3 assets/fonts/widen-head.py

The script:
  1. Reads the original .woff from `git`'s HEAD (so it operates on
     the unmodified glyph, not the already-widened file).
  2. Applies a horizontal scale of SCALE = 1.08 to the
     `mightymax-head` glyph only (vertical is preserved).
  3. Bumps the advance width to ROUND(626 × 1.08) = 676 so the
     glyph stays centered in its slot.
  4. Writes the font in place; fontforge emits a WOFF with CFF
     outlines.

The +8% was selected as a "very slight" widening per design intent.
Bump SCALE up or down for more / less.

Why this script rather than a pure .pe Transform:

    fontforge.glyph.transform([1.08, 0, 0, 1, 0, 0]) preserves the
    CFF outline round-trip cleanly. fontforge's .pe Transform()
    operator rescales the glyph relative to the em box and resets
    the bounding box, producing a 30 % vertical resize and losing
    the descender placement. The python binding does NOT have this
    problem; .pe does.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile

import fontforge

SCALE = 1.08
ORIGINAL_ADVANCE = 626
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
WOFF_PATH = os.path.join(HERE, 'mightymax.woff')


def _load_original_from_git() -> bytes:
    """Load the pristine pre-widened .woff bytes from git HEAD.

    fontTools refuses to round-trip a font that's already been
    re-widened through fontforge (the bbox shifts a couple of
    em-units each pass), so we anchor every regeneration against
    the original.
    """
    out = subprocess.run(
        ['git', 'show', f'HEAD:assets/fonts/{os.path.basename(WOFF_PATH)}'],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
    return out.stdout


def main():
    original = _load_original_from_git()
    with tempfile.NamedTemporaryFile(suffix='.woff', delete=False) as tmp:
        tmp.write(original)
        tmp_path = tmp.name
    try:
        font = fontforge.open(tmp_path)
        for g in font.glyphs():
            if g.glyphname == 'mightymax-head':
                before_bbox = g.boundingBox()
                g.transform([SCALE, 0, 0, 1, 0, 0])
                g.width = round(ORIGINAL_ADVANCE * SCALE)
                after_bbox = g.boundingBox()
                print(f'before bbox: {before_bbox}')
                print(f'after  bbox: {after_bbox}')
                print(f'advance {ORIGINAL_ADVANCE} -> {g.width}')
                break
        else:
            sys.exit('glyph `mightymax-head` not found in font')
        font.generate(WOFF_PATH, bitmap_type='woff')
        print(f'wrote {WOFF_PATH}')
    finally:
        os.unlink(tmp_path)


if __name__ == '__main__':
    main()

