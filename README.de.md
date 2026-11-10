# waechter

Abhängigkeitsfreier [Claude-Code](https://claude.com/claude-code)-`PreToolUse`-Hook, der `git commit` und `git push` prüft, bevor Claude sie ausführt.

> Fängt typische Fehler ab, ist aber kein vollständiger Secret-Scanner. Zusätzlich [gitleaks](https://github.com/gitleaks/gitleaks) verwenden.

## Was geprüft wird

- **Commit:** hinzugefügte Zeilen auf 7 eingebaute Schlüsselmuster (Anthropic, OpenAI, ElevenLabs, GitHub, AWS, Twilio, privater Schlüssel) sowie konfigurierbar auf private E-Mail-Adressen, Telefonnummern und private Pfade (nur öffentliche Repos). In öffentlichen Repos muss der Autor zur noreply-Adresse passen.
- **Push:** in öffentlichen Repos werden `--all`/`--mirror`, gesperrte Branches und Commits mit falscher Autor-Adresse blockiert. Bestimmte Remotes fragen immer nach.

Öffentliche Repos: blockiert (deny). Sonst: Rückfrage (ask).

## Schreibprüfung (optional)

Mit `writeCheck` prüft der Hook auch `Write`, `Edit`, `MultiEdit` und `NotebookEdit`, und zwar nur den **neuen** Inhalt (bei Änderungen jeden eingesetzten Text einzeln) mit denselben Mustern wie beim Commit, bevor die Datei geschrieben wird.

- Greift nur für Dateien in einem Git-Repo, das als öffentlich gilt (`publicRepoPatterns`) und das **nicht** von git ignoriert ist (`git check-ignore`). Eine `.env` aus der `.gitignore` ist also erlaubt. Kein Repo oder privates Repo: nichts passiert.
- `writeCheck`: `"aus"` (Standard), `"warnen"` (Rückfrage), `"blocken"` (verweigert, Claude sieht den Grund). **Standard ist `aus`, damit sich bestehende Installationen nicht verschärfen**; zusätzlich muss der Matcher des Hooks um `Write|Edit|MultiEdit|NotebookEdit` erweitert werden.
- Ausnahmen: offensichtliche Platzhalter (`xxx`, `example`, `changeme`, `<...>`, lange Folgen gleicher Zeichen), Pfade aus `writeCheckIgnorePaths` (Regex auf den Repo-relativen Pfad, z. B. Test-Fixtures), Zeilen mit `waechter:erlaubt`, Binärinhalt und Inhalt über `writeCheckMaxBytes` (Standard 1000000).
- Die Meldung nennt Musterart und Zeile; der Wert wird nie ausgegeben oder protokolliert, nur maskiert (erste 4 Zeichen + Länge). Sie weist auf Umgebungsvariable, ignorierte Datei oder Schlüsselbund hin.

Matcher: `"matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit"`.

## Installation

Repo klonen und in `~/.claude/settings.json` einen `PreToolUse`-Hook mit Matcher `Bash` eintragen, der `node $HOME/pfad/zu/waechter/waechter.mjs` aufruft (Beispiel siehe `README.md`).

## Konfiguration

`config.example.json` nach `~/.config/waechter/config.json` kopieren (oder `WAECHTER_CONFIG` setzen) und anpassen.

## Tests

`npm test` (Node 18+, keine Abhängigkeiten).

## Lizenz

MIT
