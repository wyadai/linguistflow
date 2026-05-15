#!/usr/bin/env python3
"""
Generate missing audio files via ElevenLabs API.

Usage:
    1. Get an API key from https://elevenlabs.io/app/settings/api-keys
    2. Set environment variables:
         export ELEVENLABS_API_KEY="sk_..."
         export ELEVENLABS_VOICE_ID="..."  # optional, see below
    3. Run: python3 generate_audio.py
       Or dry-run first:  python3 generate_audio.py --dry-run

The script reads `anki_spanisch_guatemala_audio.txt`, finds sentences whose
audio file is missing (or empty), and generates them via ElevenLabs.
Files are saved as `es_guate_NN.mp3` in this folder.

After running, re-run `python3 parse_data.py` to update `data.js`.

Voice selection:
  ElevenLabs has a voice library at https://elevenlabs.io/app/voice-library.
  Pick a voice that sounds good in Spanish (filter by "Spanish" or
  "Latin American"). Copy its Voice ID and set ELEVENLABS_VOICE_ID.

  Default voice below is Liam (works for multilingual). Replace with a
  better Spanish/Guatemalan voice for production quality.

Pricing reminder (as of writing):
  Free tier: 10,000 chars/month
  Starter ($5/mo): 30,000 chars/month
  36 missing sentences ≈ 2,500-3,000 chars total → fits free tier.
"""

import os
import re
import sys
import json
import time
from pathlib import Path
import urllib.request
import urllib.error

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

HERE = Path(__file__).resolve().parent
TSV  = HERE / "anki_spanisch_guatemala_audio.txt"

API_KEY  = os.environ.get("ELEVENLABS_API_KEY", "").strip()
VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "TX3LPaxmHKxFdv7VOQHJ").strip()  # Liam — multilingual, default

MODEL_ID = "eleven_multilingual_v2"

VOICE_SETTINGS = {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0.0,
    "use_speaker_boost": True,
}

DRY_RUN = "--dry-run" in sys.argv or "-n" in sys.argv

SOUND_RE = re.compile(r"\[sound:([^\]]+)\]")

# --------------------------------------------------------------------------
# Read TSV → list of (audio_filename, spanish_text, german_text)
# --------------------------------------------------------------------------

if not TSV.exists():
    print(f"ERROR: {TSV.name} not found in {HERE}", file=sys.stderr)
    sys.exit(1)

sentences = []
for line_num, raw in enumerate(TSV.read_text(encoding="utf-8").splitlines(), 1):
    if not raw.strip():
        continue
    parts = raw.split("\t")
    if len(parts) < 3:
        continue
    de = parts[0].strip()
    es_raw = parts[1].strip()
    m = SOUND_RE.search(es_raw)
    if not m:
        continue
    audio_name = m.group(1)
    es = SOUND_RE.sub("", es_raw).strip()
    sentences.append({"audio": audio_name, "es": es, "de": de, "line": line_num})

# --------------------------------------------------------------------------
# Find missing audios
# --------------------------------------------------------------------------

missing = []
for s in sentences:
    p = HERE / s["audio"]
    if not p.exists() or p.stat().st_size == 0:
        missing.append(s)

total_chars = sum(len(s["es"]) for s in missing)
print(f"{len(sentences)} sentences total, {len(missing)} missing audio.")
print(f"Total characters to generate: {total_chars}")
print(f"Voice ID: {VOICE_ID}")
print(f"Model:    {MODEL_ID}")
print()

if not missing:
    print("Nothing to do — all audios present. ✓")
    sys.exit(0)

if DRY_RUN:
    print("DRY RUN — would generate:")
    for s in missing:
        print(f"  {s['audio']} ({len(s['es'])} chars)  {s['es']}")
    print()
    print("Run without --dry-run to actually generate.")
    sys.exit(0)

if not API_KEY:
    print("ERROR: ELEVENLABS_API_KEY environment variable not set.", file=sys.stderr)
    print("Get a key at https://elevenlabs.io/app/settings/api-keys", file=sys.stderr)
    print("Then: export ELEVENLABS_API_KEY=\"sk_...\"  (or set it in your shell profile)", file=sys.stderr)
    sys.exit(1)

# --------------------------------------------------------------------------
# Generate
# --------------------------------------------------------------------------

url_tpl = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"

succeeded = 0
failed = 0

for i, s in enumerate(missing, 1):
    out_path = HERE / s["audio"]
    text_preview = s["es"][:60] + ("…" if len(s["es"]) > 60 else "")
    print(f"[{i:2d}/{len(missing)}] {s['audio']}: {text_preview}")

    url = url_tpl.format(voice_id=VOICE_ID)
    body = json.dumps({
        "text": s["es"],
        "model_id": MODEL_ID,
        "voice_settings": VOICE_SETTINGS,
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "xi-api-key": API_KEY,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            audio_bytes = resp.read()
        out_path.write_bytes(audio_bytes)
        succeeded += 1
        print(f"            → saved ({len(audio_bytes):,} bytes)")
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8")[:300]
        except Exception:
            pass
        print(f"            ✗ HTTP {e.code}: {err_body}", file=sys.stderr)
        failed += 1
        # On rate-limit or auth error, stop early
        if e.code in (401, 403, 429):
            print("            STOPPING (auth/rate-limit error).", file=sys.stderr)
            break
    except urllib.error.URLError as e:
        print(f"            ✗ Network error: {e}", file=sys.stderr)
        failed += 1
    except Exception as e:
        print(f"            ✗ Unexpected error: {e}", file=sys.stderr)
        failed += 1

    # Small delay to be nice to the API
    time.sleep(0.3)

print()
print(f"Done. {succeeded} succeeded, {failed} failed.")
if succeeded:
    print("Next step:  python3 parse_data.py   (to refresh data.js)")
