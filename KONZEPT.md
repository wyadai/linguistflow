# Spanisch Lern-App — Konzept & Vision

Dieses Dokument hält die Lernphilosophie, den Workflow und die Ausbaurichtung
der App fest. Es dient als Referenz, wenn neue Features besprochen werden,
damit alle Entscheidungen mit der Gesamtidee übereinstimmen.

---

## Lernphilosophie

Die App ist auf **schnellen Spracherwerb durch massiven Input und stetige
Wiederholung** ausgelegt, basierend auf zwei Konzepten:

**Sprachinseln (language islands).** Statt grammatik-getriebenem Vokabellernen
sammelt man Sätze in thematischen Inseln — z.B. „Familie & Freunde", „Küche
& Essen", „Arbeit". Innerhalb jeder Insel identifiziert man die Fragen und
Sätze, die man im Alltag wirklich braucht, und übt genau diese. Das schafft
gebrauchsfertige Sprachfähigkeit für reale Situationen, statt theoretisches
Wissen.

**Shadowing.** Man hört Muttersprachler-Audio und spricht parallel laut nach.
Das trainiert Aussprache, Intonation und Sprachgefühl gleichzeitig. Damit das
gut funktioniert, braucht man **viele Wiederholungen pro Satz** und idealerweise
**Audio auch im Hintergrund** — beim Kochen, Unterwegs, beim Sport. Deshalb
ist Audio das wichtigste Asset der App, und die App muss auf dem Handy
funktionieren, auch wenn der Bildschirm aus ist.

---

## Workflow (3-Stufen-Loop)

Jeder Satz durchläuft idealerweise drei Phasen:

### 1. Anhören & Wiederholen (fokussiert, am Bildschirm)

Neue Sätze landen hier. Man sieht den spanischen Satz, die deutsche
Übersetzung, und kann das Audio einzeln oder durchgehend abspielen. Man
liest mit, hört zu, vergleicht. Hier baut man die initiale Bekanntschaft
mit den Sätzen auf — verstehen, was sie bedeuten und wie sie klingen.

### 2. Dauerschleife / Shadowing (passiv, unterwegs)

Sobald man die Sätze grob kennt, schaltet man die App in den Auto-Play-Modus
und lässt sie im Hintergrund durchlaufen — beim Kochen, Pendeln, Sport, im
Haushalt. Man spricht laut nach, was man hört (Shadowing). Hier passieren
die meisten Wiederholungen. Bildschirm darf aus sein, Lock-Screen darf aktiv
sein — die App muss trotzdem weiterspielen. **Das ist die volumengrösste
Phase und der eigentliche Zweck der mobilen App.**

### 3. Active Recall (fokussiert, am Bildschirm)

Im zweiten Tab sieht man nur den deutschen Satz und versucht, ihn aktiv auf
Spanisch zu bilden. Dann deckt man auf, sieht die richtige Lösung und das
Audio, und bewertet die Karte:

- **1 Stern (Schwierig)** — kam gar nicht drauf, kommt zurück in die Loop
- **2 Sterne (Okay)** — meistens richtig, noch nicht sicher
- **3 Sterne (Easy)** — sass, aber noch nicht automatisch
- **🧠 Gelernt** — fest sitzend, kann aus der Loop raus

Beim Active Recall arbeitet man gezielt mit den Filtern: z.B. nur die
1- und 2-Sterne-Sätze wiederholen, bis sie weiterrücken.

---

## Inhalts-Pipeline

### Aktuell (manuell + halbautomatisch)

1. **Hinzufügen:** Deutschen Satz im Sidebar eintippen, Kategorien wählen
2. **Übersetzen:** Per Knopfdruck via Claude API (Haiku 4.5,
   Guatemala-Spanisch, tú-Form) — oder manuell via Chat-Workflow
3. **Audio:** Aktuell nur für die 48 Original-Sätze vorhanden. Neue Sätze
   haben kein Audio (Feature in Arbeit, siehe unten)

### Geplant: Konversations-basiertes Hinzufügen

Statt einzelne Sätze einzutippen soll der User ein **Sprachinsel-Gespräch
mit Claude** führen können:

1. User wählt (oder Claude fragt nach) ein Thema, z.B. „Arbeit"
2. Claude stellt gezielte Fragen auf Deutsch
   („Wie beschreibst du jemandem deinen Job?", „Was sagst du, wenn du in
   einem Meeting eine Idee vorschlagen willst?")
3. User antwortet auf Deutsch (Text oder gesprochen)
4. Claude **zerlegt die Antworten in einzelne nützliche Sätze**, übersetzt
   sie automatisch auf Guatemala-Spanisch
5. Diese Sätze landen automatisch in der App, kategorisiert
6. **Automatische Audio-Generierung** via ElevenLabs — jeder neue Satz
   bekommt sofort eine MP3, damit der Shadowing-Loop direkt anlaufen kann

So entsteht eine persönliche, alltagsrelevante Sprachinsel-Sammlung statt
generischer Lehrbuch-Sätze.

### Persönliches User-Profil (Kontext für die KI)

Der Schlüssel zu wirklich relevanten Sprachinseln ist ein **persönliches
Profil**, das der User pflegt. Dort beschreibt er frei:

- Lebenssituation (z.B. „frisch verheiratet, plane einen Umzug")
- Aktuelle Themen im Alltag (z.B. „Wohnungssuche, Hausbau, Hochzeitsvorbereitung")
- Beziehungskontext (z.B. „lebe mit Partnerin in Guatemala, Hund namens Yuna")
- Berufliches Umfeld (z.B. „arbeite im Vertrieb, viele Kundentermine")
- Hobbys, Interessen, anstehende Reisen

Dieses Profil wird Claude bei jeder Sprachinsel-Generierung als Kontext
mitgegeben. Statt generischer „Wie heisst du?"-Sätze entstehen so Sätze,
die der User in den nächsten Wochen wirklich braucht.

**Datenschutz:**

Profil-Daten sind persönlich und müssen geschützt werden. Schutzschichten,
in der Reihenfolge der Implementierung:

1. *Lokal-first (Phase A):* Profil lebt nur in localStorage des Browsers.
   Wird ausschliesslich Claude pro Sprachinsel-Anfrage geschickt, sonst
   verlässt es das Gerät nie
2. *Mit Supabase (Phase B):* Row-Level Security stellt sicher, dass nur
   der eingeloggte User sein Profil lesen kann. Standard-Pattern
3. *Optional (Phase C):* Client-seitige Verschlüsselung mit User-eigenem
   Master-Passwort — selbst Supabase könnte den Klartext nicht lesen.
   Nur sinnvoll, wenn der User das aktiv möchte

Empfehlung an den User beim Anlegen des Profils: **Vornamen statt voller
Namen, Rollen statt Identitäten**. Keine Adressen, Bankdaten, Passwörter,
medizinische Details. Inhalte, die er problemlos einem Freund erzählen
würde — nicht das, was nur sein Anwalt wissen sollte. Das Profil geht
mit jeder Anfrage zur Anthropic-API; Anthropic speichert API-Inhalte
nicht dauerhaft, aber sie sind in der Übertragung enthalten.

### Audio-Pipeline (geplant)

- Einmalige Generierung der 36 fehlenden Original-Audios (Sätze ohne MP3)
  via ElevenLabs-Skript
- Für jeden neu hinzugefügten Satz: automatische Audio-Generierung, sobald
  die Übersetzung vorliegt
- Konsistente Stimme (z.B. weibliche guatemaltekische Stimme) über alle Sätze

---

## Multi-Device & Sync

Die App muss auf **Desktop und Mobile** funktionieren, weil die Nutzung
sehr unterschiedlich ist:

- **Desktop (fokussiert):** Neue Sätze hinzufügen, Active Recall, Bewertungen
  setzen, Eselsbrücken pflegen
- **Mobile (passiv):** Dauerschleife / Shadowing unterwegs, auch bei
  gesperrtem Bildschirm

Damit das funktioniert, muss:

1. Die App auf beiden Devices identisch verfügbar sein (deshalb statisches
   Web-Hosting, z.B. GitHub Pages)
2. **Daten zwischen den Geräten synchronisieren** — Ratings, neue Sätze,
   Eselsbrücken, Lernfortschritt. Aktueller Stand: manueller Export/Import
   via JSON-Datei. Langfristig: automatischer Cloud-Sync (Supabase oder
   ähnlich)
3. **Audio im Hintergrund** weiterlaufen, wenn der Bildschirm aus ist oder
   gesperrt ist. Auf Android via PWA mit Media Session API. Auf iOS
   eingeschränkt, aber via PWA grundsätzlich möglich

---

## Geplanter Statistikbereich

Eine eigene Ansicht/Tab für Lernfortschritt:

- **Streak:** Anzahl Tage in Folge mit aktiver Nutzung
- **Aktive Tage gesamt**
- **Sätze gehört** (Listening-Plays)
- **Sätze repetiert** im Active Recall
- **Sätze gelernt** (auf 🧠 gesetzt)
- **Verteilung nach Sprachinseln** — wie viele Sätze pro Kategorie, wie
  viele davon gelernt
- evtl. Heatmap (welche Tage aktiv)

Genaue Metriken werden definiert, wenn das Feature aktuell wird.

---

## Aktueller Stand

**Funktioniert lokal:**

- Karten-Ansicht mit Spanisch + Deutsch + Audio
- Listen-Modus (Auto-Play optional ein/aus) + Active Recall mit Tab-Aufdecken
- 3-Sterne + Gehirn-Rating, Filter nach Rating
- Kategorien-Filter in Sidebar
- Eselsbrücken: dezente Anzeige auf Karte, Toggle via M-Button
- Suche, Tastatur-Shortcuts, Speed/Repeat-Controls
- Neue Sätze hinzufügen im Sidebar
- Übersetzung manuell via Chat-Prompt-Workflow ODER direkt via Claude API
- Manueller Export/Import (JSON-Datei) für Sync zwischen Geräten

**Noch offen / als nächstes:**

1. ElevenLabs-Integration (Audios für die 36 fehlenden Original-Sätze + für
   neue Sätze)
2. Test der App auf dem Handy (Touch-Targets, Layout)
3. PWA-Setup (installierbar, Background-Audio, Lock-Screen-Steuerung)
4. Öffentliches GitHub-Hosting + URL fürs Handy
5. Persönliches User-Profil (lokal, für Sprachinsel-Kontext an Claude)
6. Konversations-Modus mit Claude für Sprachinsel-Aufbau (nutzt das Profil)
7. Statistikbereich
8. Langfristig: automatischer Cloud-Sync statt manuellem Export/Import

---

## Designprinzipien

- **Audio ist König.** Jeder Satz muss eine saubere MP3 haben, weil Shadowing
  ohne Audio nicht funktioniert
- **Minimalismus.** Kein Schnickschnack — die App muss schnell laden,
  reaktionsschnell sein, auch auf älteren Handys
- **Persönliche Sprachinseln statt generischer Vokabellisten.** Was der
  User wirklich sagen will, nicht was im Lehrbuch steht
- **Maximale Wiederholung.** Die App muss niedrigschwellig genug sein, dass
  man sie täglich öffnet und im Hintergrund laufen lässt
- **Eigentum der Daten.** Alle Lerndaten gehören dem User, müssen
  exportierbar sein und ohne Server funktionieren können (Offline-fähig
  als Ziel)
