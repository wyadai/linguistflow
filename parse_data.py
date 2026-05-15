#!/usr/bin/env python3
"""Parse the Anki TSV file into data.js for the HTML app to consume.

Place anki_spanisch_guatemala_audio.txt and the es_guate_*.mp3 files
in the same folder as this script, then run:
    python3 parse_data.py
"""
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "anki_spanisch_guatemala_audio.txt"

SOUND_RE = re.compile(r"\[sound:([^\]]+)\]")

sentences = []
for raw in SRC.read_text(encoding="utf-8").splitlines():
    if not raw.strip():
        continue
    parts = raw.split("\t")
    if len(parts) < 3:
        continue
    german = parts[0].strip()
    spanish_with_sound = parts[1].strip()
    categories_raw = parts[2].strip()
    m = SOUND_RE.search(spanish_with_sound)
    audio_file = m.group(1) if m else ""
    spanish = SOUND_RE.sub("", spanish_with_sound).strip()
    categories = [c for c in categories_raw.split() if c]
    audio_path = HERE / audio_file if audio_file else None
    has_audio = bool(audio_file) and audio_path.exists() and audio_path.stat().st_size > 0
    sentences.append({
        "id": len(sentences) + 1,
        "de": german,
        "es": spanish,
        "audio": audio_file if has_audio else "",
        "cats": categories,
    })

all_cats = sorted({c for s in sentences for c in s["cats"]})
CAT_LABELS = {
    "Arbeit": "Arbeit",
    "Familie_Freunde": "Familie & Freunde",
    "Gesundheit_Koerper": "Gesundheit & Körper",
    "Hobby_Freizeit": "Hobby & Freizeit",
    "Kueche_Essen": "Küche & Essen",
    "Reisen_Verkehr": "Reisen & Verkehr",
    "Smalltalk_Hoeflichkeit": "Smalltalk & Höflichkeit",
    "Wetter_Natur": "Wetter & Natur",
    "Wohnen_Haushalt": "Wohnen & Haushalt",
}

data = {
    "sentences": sentences,
    "categories": [{"key": c, "label": CAT_LABELS.get(c, c)} for c in all_cats],
}

out_js = HERE / "data.js"
out_js.write_text("const DATA = " + json.dumps(data, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")
n_audio = sum(1 for s in sentences if s["audio"])
print(f"Wrote {out_js}: {len(sentences)} sentences ({n_audio} with audio)")
