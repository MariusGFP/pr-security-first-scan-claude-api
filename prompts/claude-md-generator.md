# Rolle
Du generierst eine CLAUDE.md Datei die als Projektkontext für alle zukünftigen Claude Code Aufrufe dient.

# Was ist CLAUDE.md?
Claude Code liest beim Start automatisch eine CLAUDE.md im Repo-Root. Diese Datei ist das
"Gedächtnis" des Projekts – sie gibt jedem Agent sofort Kontext ohne dass er die gesamte
Codebase erneut analysieren muss.

# Aufgabe
Erstelle eine CLAUDE.md basierend auf der Schichtanalyse. Die Datei muss folgende Struktur haben:

# Struktur (exakt einhalten)

## Projekt
- Name, Zweck, Zielgruppe (je 1 Satz)

## Tech-Stack
- Sprache + Version (z.B. PHP 8.4, TypeScript 5.x, Java 21)
- Framework + Version (z.B. Laravel 12, Next.js 15, Spring Boot 3.x)
- Datenbank (z.B. MySQL 8, PostgreSQL 16)
- Weitere Services (Redis, Elasticsearch, S3, etc.)

## Architektur-Patterns
- Welche Patterns werden verwendet (Repository Pattern, Service Layer, etc.)
- Request-Lifecycle in 1-2 Sätzen

## Verzeichnis-Konventionen
- Wo liegt was (Controllers, Services, Models, Views, Tests)
- Naming-Konventionen (PascalCase für Klassen, snake_case für DB-Spalten, etc.)

## Code-Konventionen
- Validierung: FormRequests vs. inline
- Autorisierung: Policies vs. Gates vs. inline
- Fehlerbehandlung: Wie werden Exceptions gehandhabt
- API-Response-Format: Einheitliches Format beschreiben

## Wichtige Befehle
- App starten, Tests ausführen, Migrations, Seeding
- Linting, Code-Formatting

## Bekannte Besonderheiten
- Ungewöhnliche Patterns oder Workarounds
- Legacy-Code-Bereiche die besondere Vorsicht erfordern
- Bereiche mit bekannter technischer Schuld

# Regeln
- Maximal 150 Zeilen – muss schnell lesbar sein
- Nur Fakten aus dem Code – keine Vermutungen
- Keine Wiederholung von Framework-Defaults (nur projektspezifisches)
- Markdown-Format, keine Code-Blöcke (außer für Befehle)
