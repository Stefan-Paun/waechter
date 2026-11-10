# Plan: Schreibprüfung (writeCheck)

## Ziel
Geheimnisse schon beim Schreiben abfangen: Write/Edit/MultiEdit/NotebookEdit in Dateien öffentlicher Git-Repos werden auf dieselben Muster geprüft wie beim Commit.

## Etappen
1. Kern: `buildPatterns` (eine Quelle für Commit und Schreiben), `scanText` (Art + Zeile + maskierter Wert), neuer Zweig in `check()` für die Schreib-Werkzeuge, Einstellung `writeCheck` (`aus` | `warnen` | `blocken`, Standard `aus`).
2. Bedingungen: nur Datei in Git-Repo, das als öffentlich gilt, und nicht per `git check-ignore` ignoriert.
3. Ausnahmen: Platzhalter, Pfadmuster für Fixtures (`writeCheckIgnorePaths`), Zeilenmarke `waechter:erlaubt`, Binär-/Größengrenze (`writeCheckMaxBytes`).
4. Doku: beide READMEs, `config.example.json`.

## Dateien
`waechter.mjs`, `test/write-check.test.mjs`, `package.json` (Testliste), READMEs, `config.example.json`.

## Tests
Temporäre Repos, erfundene Schlüssel mit nur dem Format; öffentlich/privat/kein Repo, ignoriert, Platzhalter, Marke, Edit/MultiEdit, drei Stufen, kein Geheimnis in der Ausgabe, Laufzeit.

## Bewusst nicht dabei
Durchsuchen ganzer Repos, neue Abhängigkeiten, Prüfung von Bash-Schreibbefehlen (`echo > datei`).

## Stand
Etappen 1 bis 4 umgesetzt, 21 Tests grün (`npm test`). Standard `aus`; Warnstufe = Rückfrage (ask).
