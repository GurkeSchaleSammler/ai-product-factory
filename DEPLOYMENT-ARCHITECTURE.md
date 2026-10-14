# Deployment-Architektur

Status: Zielbild · Automation weiterhin deaktiviert

## Ziel

Jeder Factory-Agent wird als eigenes TypeScript-Projekt gebaut, erhält ein
eigenes Container-Image und wird über ein eigenes Helm-Chart installiert. Die
Agenten tauschen keine ungesicherten Direktaufrufe aus. PostgreSQL hält den
Workflowzustand und eine transaktionale Job-/Outbox-Tabelle.

```text
Innovation-Man (CronJob, alle 15 Minuten)
        │ ProductPitch
        ▼
PostgreSQL: Workflowzustand, Jobs, Outbox, Audit
        │
        ▼
Sales-Man (Deployment/Worker)
        │ PortfolioDecision
        ▼
Policy Engine (deterministisches Modul im Manager-Prozess)
        │ ManagementCommand
        ▼
Manager-Man (Deployment/Worker)
        │
        ├──► neues GitHub-Produkt-Repository
        │      Quelle: <Manager-Konto>/empty-produkt, Branch main
        │      Ziel: main im Manager-GitHub-Konto
        │
        └──► INIT-Issue "Begin <Produktname>" mit vollständigem Pitch
```

Die Policy Engine ist kein vierter Agent. Sie wird als deterministisches,
vollständig getestetes TypeScript-Modul im Manager-Service ausgeführt. Sie darf
keine Modellaufrufe enthalten.

## Empfohlene Repository-Struktur

```text
ai-product-factory/
├── agents/                         # fachliche Dokumentation
├── services/
│   ├── innovation-man/             # TypeScript-CronJob
│   │   ├── src/
│   │   ├── package.json
│   │   └── Dockerfile
│   ├── sales-man/                  # TypeScript-Worker
│   │   ├── src/
│   │   ├── package.json
│   │   └── Dockerfile
│   └── manager-man/                # Policy und Ausführung
│       ├── src/
│       ├── package.json
│       └── Dockerfile
├── packages/
│   ├── contracts/                  # Zod-Schemas und TypeScript-Typen
│   ├── database/                   # Migrationen, Jobs und Outbox
│   └── observability/              # Logs, Metriken und Tracing
├── package.json                    # npm/pnpm-Workspaces
└── tsconfig.base.json
```

Die produktiven Charts bleiben gemäß Repository-Grenze in
`GurkeSchaleSammler/homelab-helm`:

```text
charts/ai-products/
├── innovation-man/
├── sales-man/
└── manager-man/
```

Die drei Argo-Anwendungen liegen in
`GurkeSchaleSammler/homelab-gitops/applications/ai-products/`.

## Durchgängiger Workflow

### 1. Innovation-Man

Das Chart installiert einen Kubernetes-`CronJob` mit dem Zeitplan
`*/15 * * * *`, `concurrencyPolicy: Forbid` und einer begrenzten Laufzeit. Der
Prozess berechnet aus UTC-Zeit eine eindeutige 15-Minuten-Fenster-ID. Auf der
Datenbank liegt ein Unique Constraint für diese ID.

In einer Transaktion werden der `ProductPitch`, ein Job für Sales-Man und der
Audit-Eintrag geschrieben. Existiert das Fenster bereits, beendet sich der Job
erfolgreich ohne einen zweiten Pitch.

### 2. Sales-Man

Sales-Man beansprucht einen offenen Pitch mit `FOR UPDATE SKIP LOCKED` und einer
zeitlich begrenzten Lease. Er validiert Ein- und Ausgabe mit Zod, führt den
Modellaufruf aus und schreibt `PortfolioDecision`, Manager-Job und Audit-Eintrag
in einer Transaktion.

Nach einem Absturz läuft die Lease aus und der Job kann erneut übernommen
werden. Eine eindeutige Pitch-ID verhindert doppelte Entscheidungen.

### 3. Manager-Man

Manager-Man validiert die Entscheidung gegen die aktuelle Portfolio-Revision.
Das lokale Policy-Modul prüft Slots, Mindestwerte, Schutzfrist, Evidenz,
Freigaben, Budgets und Not-Aus. Nur bei Erfolg entsteht ein
`ManagementCommand`.

Reservierung und interner Entwicklungsauftrag werden gemeinsam in einer
Datenbanktransaktion gespeichert. Externe Aktionen werden anschließend über die
Outbox idempotent ausgeführt. Manager-Man erstellt ein eigenständiges Repository,
kopiert die Dateien aus `<Manager-Konto>/empty-produkt:main` ohne Quellhistorie nach
`main`, setzt die Actions-Secrets und eröffnet das zugewiesene INIT-Issue mit
`scope-override`. Auftrag-ID und Repository-Beschreibung verhindern, dass ein
Retry ein fremdes Repository übernimmt oder ein zweites Start-Issue erzeugt.

## Datenbank und Berechtigungen

Eine gemeinsame PostgreSQL-Instanz ist ausreichend, aber jeder Agent erhält
eine eigene Datenbankrolle und ein eigenes Kennwort:

| Dienst | Minimale Datenbankrechte |
|---|---|
| Innovation-Man | Portfolio lesen; Pitches, eigene Jobs und Audit schreiben |
| Sales-Man | Pitches lesen; Entscheidungen, eigene Jobs und Audit schreiben |
| Manager-Man | Entscheidungen lesen; Policy-, Portfolio-, Outbox- und Auditdaten verwalten |

Schreiboperationen sollten möglichst über eng begrenzte SQL-Funktionen erfolgen.
So kann auch ein kompromittierter LLM-Agent nicht direkt Portfoliozustände oder
Managementaufträge verändern.

## Secrets pro Helm-Chart

Secretwerte gehören weder in Git noch in `values.yaml`. Jedes Chart verlangt
den Namen eines bereits vorhandenen Secrets, zum Beispiel `existingSecret`.
Das Deployment referenziert nur einzelne benötigte Schlüssel mit `secretKeyRef`
und verwendet kein gemeinsames `envFrom`-Sammelsecret.

| Chart | Eigene Secretwerte |
|---|---|
| Innovation-Man | LLM-Zugang, eigene PostgreSQL-Zugangsdaten |
| Sales-Man | LLM-Zugang, eigene PostgreSQL-Zugangsdaten |
| Manager-Man | eigene PostgreSQL-Zugangsdaten, GitHub-PAT und DeepSeek-Key für die erzeugten Produkt-Repositories |

Empfohlen ist External Secrets Operator, SOPS oder Sealed Secrets. Unabhängig vom
gewählten Backend werden drei getrennte Kubernetes-Secrets erzeugt. Innovation-
und Sales-Pods erhalten niemals GitHub-, Registry-, Argo- oder
Cluster-Zugangsdaten.

Jedes Chart erhält außerdem ein eigenes `ServiceAccount`, eine standardmäßig
leere Kubernetes-RBAC-Rolle, eine `NetworkPolicy`, read-only Root-Filesystem,
deaktivierte Privilege Escalation und feste CPU-/RAM-Limits. Nur Manager-Man
bekommt die für seine externen Ziele notwendigen Netzwerkfreigaben.

## Container- und Chart-Vertrag

Alle Images laufen als nicht privilegierter Benutzer, verarbeiten `SIGTERM`
sauber und schreiben strukturierte JSON-Logs ohne Secretwerte.

- Innovation-Man ist ein beendender Prozess: Erfolg liefert Exitcode 0.
- Sales-Man und Manager-Man bieten `/health/live`, `/health/ready` und `/metrics`.
- Konfiguration wird beim Start strikt validiert; unbekannte oder fehlende Werte
  verhindern den Start.
- Images werden mit unveränderlichem Digest statt nur mit einem Tag deployed.
- Chart, Image und Contracts werden gemeinsam versioniert und in CI geprüft.

## Empfohlene Umsetzungsreihenfolge

1. Zod-Contracts und Zustandsmaschine festlegen.
2. PostgreSQL-Migrationen, Job-Leases, Outbox und Audit implementieren.
3. Innovation-Man als 15-Minuten-CronJob implementieren.
4. Sales-Man als idempotenten Worker implementieren.
5. Policy Engine und Manager-Man ohne externe Schreibzugänge testen.
6. Drei Images bauen, signieren und per Digest referenzieren.
7. Drei getrennte Helm-Charts mit separaten Secrets und ServiceAccounts bauen.
8. End-to-End-Tests mit simulierter GitHub-Repo-Erstellung, Secret-Konfiguration und Issue-Eröffnung ausführen.
9. Budgets, Timeouts und Policywerte bestätigen.
10. Erst danach die Automation kontrolliert aktivieren.
