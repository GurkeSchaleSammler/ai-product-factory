# Installation und Aktivierung

## Voraussetzungen

- Kubernetes mit Unterstützung für `batch/v1` CronJobs und NetworkPolicies
- PostgreSQL 15 oder neuer
- Argo CD
- drei in GHCR veröffentlichte Images
- `ai-pipes` mit `POST /v1/development-orders` und Rückruf auf
  `POST /v1/releases` des Manager-Service
- die in [SECRETS.md](SECRETS.md) beschriebenen Secrets

## Datenbankrollen

Die Migration erzeugt die drei Gruppenrollen `factory_innovation`,
`factory_sales` und `factory_manager` ohne Login. Lege die tatsächlichen
Login-Rollen als Datenbankadministrator mit zufälligen Kennwörtern an:

```sql
CREATE ROLE innovation_man LOGIN PASSWORD 'CHANGE_ME';
CREATE ROLE sales_man LOGIN PASSWORD 'CHANGE_ME';
CREATE ROLE manager_man LOGIN PASSWORD 'CHANGE_ME';

GRANT factory_innovation TO innovation_man;
GRANT factory_sales TO sales_man;
GRANT factory_manager TO manager_man;
```

Die Migration benötigt einen separaten Datenbank-Owner mit DDL- und
`CREATEROLE`-Rechten. Seine URL liegt nur in `factory-migration-secrets`.

## Images

Die GitHub-Action baut alle drei Images bei einem Push auf `main`. Übernimm
anschließend die veröffentlichten Digests in die drei `values.yaml` oder in die
GitOps-Overrides. Für Deployments wird immer `repository@sha256:digest`
verwendet, nicht `latest`.

## Charts installieren

Kopiere die Chart-Verzeichnisse nach `homelab-helm/charts/ai-products/` oder
referenziere sie dort als unveränderte Quelle. Beispiel für die erste
Installation:

```sh
helm upgrade --install manager-man deploy/charts/manager-man \
  --namespace ai-product-factory --create-namespace \
  --set migration.enabled=true

helm upgrade --install sales-man deploy/charts/sales-man \
  --namespace ai-product-factory

helm upgrade --install innovation-man deploy/charts/innovation-man \
  --namespace ai-product-factory
```

Das bestehende `homelab-gitops/bootstrap/root-app.yaml` beobachtet derzeit den
Ordner `applications` ohne rekursive Verarbeitung. Damit die vorgesehenen
Dateien unter `applications/ai-products/**` erkannt werden, muss die Quelle der
Root-Application einmalig ergänzt werden:

```yaml
spec:
  source:
    directory:
      recurse: true
```

Diese Bootstrap-Änderung wird bewusst von einem Menschen vorgenommen. Der
Manager selbst behält ausschließlich Schreibrechte auf
`applications/ai-products.yaml` und `applications/ai-products/**`.

Vorher müssen Modellnamen, Endpoints, Registry-Allowlist, Netzwerkbereiche und
Image-Digests an die reale Umgebung angepasst sein. Bei einem Datenbankdienst
innerhalb des Clusters sollte die NetworkPolicy statt eines großen CIDR-Bereichs
später über Namespace- und Pod-Selektoren eingeschränkt werden.

## Bewusstes Aktivieren

Nach der Migration sind Automation und Arbeit absichtlich blockiert. Setze
zuerst realistische Grenzwerte. Das folgende Beispiel ist keine Empfehlung für
deren Höhe:

```sql
UPDATE factory_settings
SET daily_llm_cost_limit_chf = 5.00,
    daily_token_limit = 100000,
    build_timeout_seconds = 1800,
    emergency_stop = false,
    automation_enabled = true,
    updated_at = now()
WHERE singleton = true;
```

Die Reihenfolge ist wichtig: Secrets, Netzwerk, ai-pipes-Rückruf und
Healthchecks müssen funktionieren, bevor `automation_enabled` gesetzt wird.

## Not-Aus

```sql
UPDATE factory_settings
SET emergency_stop = true,
    automation_enabled = false,
    updated_at = now()
WHERE singleton = true;
```

Der Not-Aus verhindert neue Arbeit. Bereits veröffentlichte Produkte bleiben
online.
