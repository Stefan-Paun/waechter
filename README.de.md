# waechter

Abhängigkeitsfreier [Claude-Code](https://claude.com/claude-code)-`PreToolUse`-Hook, der `git commit` und `git push` prüft, bevor Claude sie ausführt.

> Fängt typische Fehler ab, ist aber kein vollständiger Secret-Scanner. Zusätzlich [gitleaks](https://github.com/gitleaks/gitleaks) verwenden.

## Was geprüft wird

- **Commit:** hinzugefügte Zeilen auf 7 eingebaute Schlüsselmuster (Anthropic, OpenAI, ElevenLabs, GitHub, AWS, Twilio, privater Schlüssel) sowie konfigurierbar auf private E-Mail-Adressen, Telefonnummern und private Pfade (nur öffentliche Repos). In öffentlichen Repos muss der Autor zur noreply-Adresse passen.
- **Push:** in öffentlichen Repos werden `--all`/`--mirror`, Wildcard-Refspecs, gesperrte Branches und Commits (auch mit `--tags`) mit falscher Autor-Adresse blockiert. Bei Refspecs zählen Quelle **und** Ziel (`HEAD:old`, `HEAD:refs/heads/old`, `+old`, `:old`, `--delete origin old`); ein leerer Push oder `HEAD` meint den aktuellen Branch. Bestimmte Remotes fragen immer nach; wer an ein anderes Remote als `origin` pusht (Name, `--repo` oder URL), dessen URL zählt zusätzlich.
- **Force-Push** (`blockForcePush`, **Standard aus**): mit `true` blockieren öffentliche Repos `--force`, `-f` (auch `-uf`), `--force-with-lease`, `--force-if-includes` und `+ref`.
- **Befehle lesen:** statt einer Regex zerlegt ein kleiner eigener Shell-Zerleger (`shell.mjs`, keine Abhängigkeiten) den Befehl: Anführungszeichen, `&&` `||` `;` `|` Zeilenumbruch, `( )`, `$( )`, Backticks, Heredocs, `VAR=x`, `env`, `sudo`, `time`, `nohup`, `cd` (auch in Unterkontexten) und `bash -c`/`sh -c`/`zsh -c` (bis 8 Ebenen). `gitargs.mjs` liest globale git-Optionen (`-C` mehrfach und in Anführungszeichen, `-c k=v`, `--git-dir`, `--work-tree`, `GIT_DIR=`), sodass genau das Repo geprüft wird, das git benutzen würde.
- **Unklar** (offene Anführungszeichen, `eval`, Variable als Befehlsname oder Push-Argument, `cd "$X"`, Shell liest von stdin, `git -c alias.*`): wird streng behandelt, mit Erklärung. Öffentliches Repo: blockiert, sonst Rückfrage.
- **Geändertes Verhalten:** bisherige Umgehungen werden jetzt erkannt (`git -c … push`, `bash -c 'git push'`, `VAR=x git push`, `$(git push)`, Ziel eines Refspecs, `git commit -am`/`git commit <Pfade>`, `-c user.email=…`, `GIT_AUTHOR_EMAIL=…`, `--author=…`); beim Commit wird auch die Committer-Adresse geprüft. Lassen sich die zu pushenden Commits nicht lesen, fragt der Wächter nach.

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

### Windows

Claude Code führt Bash-Befehle unter Windows über Git Bash aus, der Zerleger liest daher POSIX-Syntax. Windows-Pfade in Anführungszeichen setzen (`git -C "C:\work\repo" push`) oder Git-Bash-Schreibweise (`/c/work/repo`) nutzen. Hook in `%USERPROFILE%\.claude\settings.json`: Befehl `node "%USERPROFILE%\tools\waechter\waechter.mjs"` (Beispiel siehe `README.md`). Standard-Konfiguration: `%USERPROFILE%\.config\waechter\config.json`.

## Konfiguration

`config.example.json` nach `~/.config/waechter/config.json` kopieren (oder `WAECHTER_CONFIG` setzen) und anpassen.

Große Diffs: Ist der gestagte Diff (oder das Push-Log) größer als `maxDiffMegabytes` (Standard 20) oder braucht git länger als 10 s, geht der Wächter nicht stillschweigend durch, sondern fragt nach: „diff too large or too slow to scan, check manually“. Damit große Commits prüfbar bleiben, nimmt `skipScanPaths` (Standard leer, optional) Git-Globs wie `**/package-lock.json` oder `**/*.min.js`, die vom Commit-Scan ausgenommen werden. Übersprungene Pfade werden gar nicht geprüft, daher sparsam einsetzen.

## Tests

`npm test` (Node 18+, keine Abhängigkeiten). Tests: `test/shell.test.mjs`, `test/gitargs.test.mjs`, `test/check.test.mjs` (temporäre Repos, erfundene Daten), `test/waechter.test.mjs`. Eine CI-Matrix (ubuntu/macos/windows × Node 18/20/22) liegt in `.github/workflows/test.yml`.

## Lizenz

MIT
