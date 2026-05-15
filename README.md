# Spanisch Lern-App (Guatemala)

Statische Web-App zum Spanisch-Lernen mit Sätzen, Audio, Ratings, Eselsbrücken
und KI-gestützten Übersetzungen.

## Lokal starten

`index.html` im Browser öffnen (Doppelklick). Audio wird vom selben Ordner
geladen, deshalb müssen die `es_guate_*.mp3` Dateien hier liegen bleiben.

## Dateien

- `index.html` — App-Markup
- `styles.css` — Styling
- `app.js` — Anwendungslogik
- `data.js` — die 84 Original-Sätze (generiert aus dem TSV unten)
- `anki_spanisch_guatemala_audio.txt` — Original-Anki-Datenquelle
- `parse_data.py` — generiert `data.js` aus dem TSV (relative Pfade)
- `es_guate_*.mp3` — 49 Audio-Dateien (36 Original-Sätze haben kein Audio)

## Datenfluss

Beim Hinzufügen neuer Sätze via UI:
- werden sie in `localStorage` als `hl_user_sentences` gespeichert
- sind nur in diesem Browser/Profil sichtbar

Beim Übersetzen via Claude API:
- API Key wird in `localStorage` als `hl_api_key` gespeichert
- Modell: `claude-haiku-4-5-20251001`
- Header `anthropic-dangerous-direct-browser-access: true` ist gesetzt

Auch in `localStorage`: Ratings (`hl_ratings`), Mnemonics (`hl_mnemonics`),
Auto-Play-Einstellung (`hl_autoplay`).

## Sätze permanent machen

Wenn du User-Sätze dauerhaft im Code haben willst (statt nur localStorage):
1. Sätze in `anki_spanisch_guatemala_audio.txt` ergänzen (Format: DE\tES [sound:datei.mp3]\tKategorien)
2. `python3 parse_data.py` ausführen → `data.js` wird neu generiert
3. Repo committen, deployen

## Tastatur-Shortcuts

- `Tab` (Recall) — aufdecken
- `Leertaste` — Play/Pause
- `←` / `→` — vor / zurück
- `T` (Listen) — Übersetzung ein/aus
- `Esc` — Sidebar schliessen
