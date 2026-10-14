# Agenten der AI Product Factory

Version: 1.0 · Status: Konzeptentwurf · Automation: deaktiviert

Die empfohlene technische Zielarchitektur ist in der
[Deployment-Architektur](DEPLOYMENT-ARCHITECTURE.md) beschrieben.
Für die Inbetriebnahme siehe [Installation und Aktivierung](OPERATIONS.md) sowie
die verbindliche [Secret-Belegung](SECRETS.md).

## Registrierung

| ID | Name | Rolle | Ausführung |
|---|---|---|---|
| `innovation-man` | Rainer Winkler | Innovation-Man | LLM-gestützt |
| `manager-man` | Douglas Jackson | Manager-Man | deterministischer Service |
| `sales-man` | Thomas Benzin | Sales-Man | LLM-gestützt |

Die technische ID ist stabil und wird für Aufträge, Ereignisse und
Berechtigungen verwendet. Die Namen sind Projektidentitäten. Aus ihnen werden
keine biografischen Eigenschaften realer Personen abgeleitet.

## Agentenordner und Dokumentation

### Innovation-Man — Rainer Winkler

- Ordner: `agents/innovation-man/`
- [Rollenbeschreibung](agents/innovation-man/README.md)
- [Name und eigene Beschreibung](agents/innovation-man/README-Rainer-Winkler.md)
- [Instruktionen](agents/innovation-man/instructions.md)

### Manager-Man — Douglas Jackson

- Ordner: `agents/manager-man/`
- [Rollenbeschreibung](agents/manager-man/README.md)
- [Name und eigene Beschreibung](agents/manager-man/README-Douglas-Jackson.md)
- [Instruktionen](agents/manager-man/instructions.md)

### Sales-Man — Thomas Benzin

- Ordner: `agents/sales-man/`
- [Rollenbeschreibung](agents/sales-man/README.md)
- [Name und eigene Beschreibung](agents/sales-man/README-Thomas-Benzin.md)
- [Instruktionen](agents/sales-man/instructions.md)

## Integration mit AI Pipes

AI Developer und AI Reviewer bleiben im Repository `ai-pipes` und werden hier
nicht als zusätzliche Factory-Agenten implementiert. Die Factory übergibt einen
`DevelopmentOrder` und erhält ein `VerifiedRelease`. Der Transport dieser
Aufträge ist noch nicht konfiguriert.

## Übergaben

| Von | An | Contract |
|---|---|---|
| Innovation-Man | Sales-Man | `ProductPitch` |
| Sales-Man | deterministische Policy Engine | `PortfolioDecision` |
| Policy Engine | Manager-Man | `ManagementCommand` |
| Manager-Man | `ai-pipes` | `DevelopmentOrder` |
| `ai-pipes` | Manager-Man | `VerifiedRelease` |

## Infrastrukturzuständigkeit

Manager-Man ist der einzige Infrastruktur-Schreiber. Zielbranch ist `main`.

| Repository | Erlaubte Pfade |
|---|---|
| `GurkeSchaleSammler/homelab-gitops` | `applications/ai-products.yaml`, `applications/ai-products/**` |
| `GurkeSchaleSammler/homelab-helm` | `charts/ai-products/**` |

Diese Pfade bezeichnen die spätere Deployment-Infrastruktur. Die
Agentendokumentation in diesem Entwurf besteht ausschließlich aus
Markdown-Dateien und gewährt selbst keine Berechtigungen.

## Gemeinsame Betriebsgrenzen

- Höchstens zehn belegte Slots.
- Slotbelegende Zustände: `RESERVED`, `BUILDING`, `REVIEWING`, `DEPLOYING`,
  `LIVE`, `ARCHIVING` und `ARCHIVE_FAILED`.
- Ein geplanter Pitch alle 900 Sekunden, mit eindeutiger Fenster-ID.
- Höchstens ein paralleler Build.
- Höchstens drei Entwicklungs-/Review-Runden pro Auftrag.
- Tägliches LLM-Kostenlimit in CHF, tägliches Tokenlimit und Build-Timeout
  sind noch festzulegen. Fehlende Limits blockieren neue Arbeit.
- Alle Grenzen werden serverseitig durchgesetzt.

## Portfolio-Policy

| Regel | Vorgabe |
|---|---|
| Mindestscore für Neuaufnahme | 70 |
| Mindestscore für Ersatzkandidat | 75 |
| Scorevorsprung bei Ersatz | mindestens 15 Punkte |
| Unabhängige Evidenz für Ersatz | mindestens zwei Belege |
| Mindestlaufzeit | sieben Tage |
| Ersatz bei echten Nutzern oder persistenten Daten | menschliche Freigabe erforderlich |

Die Werte sind Entwurfswerte und müssen vor Aktivierung bewusst bestätigt oder
angepasst werden. Ein Score überstimmt keine harten Ausschlussregeln.

## Laufzeit und Veröffentlichung

- Produktnamespace: `ai-product-<slug>`.
- Portalnamespace: `ai-products`.
- Produkthost: `<slug>.ai-products.gurkeschale.ch`.
- Portalhost: `ai-products.gurkeschale.ch`.
- Ressourcenlimits sind erforderlich.
- Releases benötigen verifizierte CI-, Review- und Registry-Nachweise.
- Veröffentlichung erfolgt erst nach bestätigtem Argo-Status und externer
  HTTP-Erreichbarkeit.

## Regeln für Schreibaktionen

Jede Mutation benötigt einen genehmigten Auftrag, die erwartete Revision,
einen Idempotenzschlüssel und einen Audit-Eintrag. Force Push ist verboten.
Die Automation bleibt bis zur technischen Implementierung und Konfiguration
deaktiviert. Markdown beschreibt die Regeln; es setzt keine Berechtigungen durch.
