# waechter

Abhängigkeitsfreier [Claude-Code](https://claude.com/claude-code)-`PreToolUse`-Hook, der `git commit` und `git push` prüft, bevor Claude sie ausführt.

> Fängt typische Fehler ab, ist aber kein vollständiger Secret-Scanner. Zusätzlich [gitleaks](https://github.com/gitleaks/gitleaks) verwenden.

## Was geprüft wird

- **Commit:** hinzugefügte Zeilen auf 7 eingebaute Schlüsselmuster (Anthropic, OpenAI, ElevenLabs, GitHub, AWS, Twilio, privater Schlüssel) sowie konfigurierbar auf private E-Mail-Adressen, Telefonnummern und private Pfade (nur öffentliche Repos). In öffentlichen Repos muss der Autor zur noreply-Adresse passen.
- **Push:** in öffentlichen Repos werden `--all`/`--mirror`, gesperrte Branches und Commits mit falscher Autor-Adresse blockiert. Bestimmte Remotes fragen immer nach.

Öffentliche Repos: blockiert (deny). Sonst: Rückfrage (ask).

## Installation

Repo klonen und in `~/.claude/settings.json` einen `PreToolUse`-Hook mit Matcher `Bash` eintragen, der `node $HOME/pfad/zu/waechter/waechter.mjs` aufruft (Beispiel siehe `README.md`).

## Konfiguration

`config.example.json` nach `~/.config/waechter/config.json` kopieren (oder `WAECHTER_CONFIG` setzen) und anpassen.

## Tests

`npm test` (Node 18+, keine Abhängigkeiten).

## Lizenz

MIT
