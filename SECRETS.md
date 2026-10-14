# Secret-Belegung der Helm-Charts

Secretwerte werden nicht in Git, `values.yaml`, Helm-Argumenten oder Argo-CD
Application-Manifests gespeichert. Jedes Chart referenziert ein bereits im
Zielnamespace vorhandenes Secret. Für Produktion sollte dieses Secret durch
External Secrets Operator, SOPS oder Sealed Secrets erzeugt werden.

Zusätzlich benötigt jedes Chart ein eigenes Registry-Pull-Secret vom Typ
`kubernetes.io/dockerconfigjson`. Dafür wird ein read-only GHCR-Token verwendet,
nicht der schreibberechtigte GitHub-Token von Manager-Man.

## Innovation-Man

Secretname gemäß Standardwert: `innovation-man-secrets`

| Schlüssel | Inhalt |
|---|---|
| `database-url` | PostgreSQL-URL für die eingeschränkte Rolle `innovation_man` |
| `llm-api-key` | API-Key des verwendeten LLM-Providers |

Image-Pull-Secret: `ghcr-innovation-man` mit ausschließlich `read:packages`.

Innovation-Man benötigt keine GitHub-, Registry-, Argo-, Kubernetes- oder
ai-pipes-Zugangsdaten.

## Sales-Man

Secretname gemäß Standardwert: `sales-man-secrets`

| Schlüssel | Inhalt |
|---|---|
| `database-url` | PostgreSQL-URL für die eingeschränkte Rolle `sales_man` |
| `llm-api-key` | API-Key des verwendeten LLM-Providers |

Image-Pull-Secret: `ghcr-sales-man` mit ausschließlich `read:packages`.

Sales-Man benötigt keine GitHub-, Registry-, Argo-, Kubernetes- oder
ai-pipes-Zugangsdaten.

## Manager-Man

Secretname gemäß Standardwert: `manager-man-secrets`

| Schlüssel | Inhalt |
|---|---|
| `database-url` | PostgreSQL-URL für die Laufzeitrolle `manager_man` |
| `github-token` | Token des separaten GitHub-Servicekontos |
| `ai-pipes-api-token` | Token zum Erstellen von `DevelopmentOrder`s in ai-pipes |
| `ai-pipes-webhook-token` | mindestens 32 zufällige Zeichen; ai-pipes sendet damit `VerifiedRelease` zurück |
| `registry-bearer-token` | optionaler read-only Token zur Prüfung des Image-Digests |
| `argocd-auth-token` | read-only Argo-CD-API-Token zur Statusprüfung |

Image-Pull-Secret: `ghcr-manager-man` mit ausschließlich `read:packages`. Dafür
wird nicht `github-token` wiederverwendet.

Für die einmalige Datenbankmigration existiert getrennt
`factory-migration-secrets` mit dem Schlüssel `database-url`. Dieser Benutzer
benötigt DDL-Rechte. Er wird nur in den kurzlebigen Helm-Hook geladen und nicht
in den Manager-Laufzeitpod.

## GitHub-Rechte des Manager-Kontos

Der Code verwendet ausschließlich die GitHub REST API. Benötigt werden:

- Contents: Lesen und Schreiben in `homelab-helm` und `homelab-gitops`
- Contents: Lesen in den erzeugten Produkt-Repositories
- Checks: Lesen in den Produkt-Repositories
- Pull requests: Lesen in den Produkt-Repositories
- Metadata: Lesen

Ein separater Account ist sinnvoll. Ein uneingeschränkter Classic-PAT mit
Kontovollzugriff ist technisch nicht erforderlich und vergrößert den möglichen
Schaden erheblich. Bevorzugt wird ein Fine-grained PAT, das nur die genannten
Repositories und Rechte enthält. Wenn du dem Account organisatorisch volle
Rechte gibst, sollte der im Cluster gespeicherte Token trotzdem auf diese
minimalen Berechtigungen begrenzt werden.

Das GitHub-Passwort wird niemals als Secret hinterlegt.

## Beispiel für eine lokale Testinstallation

Die folgenden Befehle sind nur für einen manuellen Test geeignet, weil
Shell-History und lokale Prozesslisten ein zusätzliches Risiko darstellen. In
Produktion sollte der Secret-Controller die Werte erzeugen.

```sh
kubectl -n ai-product-factory create secret generic innovation-man-secrets \
  --from-literal=database-url='postgresql://innovation_man:…@postgres:5432/ai_product_factory' \
  --from-literal=llm-api-key='…'

kubectl -n ai-product-factory create secret generic sales-man-secrets \
  --from-literal=database-url='postgresql://sales_man:…@postgres:5432/ai_product_factory' \
  --from-literal=llm-api-key='…'

kubectl -n ai-product-factory create secret generic manager-man-secrets \
  --from-literal=database-url='postgresql://manager_man:…@postgres:5432/ai_product_factory' \
  --from-literal=github-token='…' \
  --from-literal=ai-pipes-api-token='…' \
  --from-literal=ai-pipes-webhook-token='…' \
  --from-literal=registry-bearer-token='…' \
  --from-literal=argocd-auth-token='…'
```

## Nicht geheime Chartwerte

Modellname, LLM-Endpoint, GitHub-Organisation, Repositorynamen, ai-pipes-URL,
Argo-CD-URL, Registry-Host-Allowlist und Produktdomain sind Konfiguration und
stehen in den jeweiligen `values.yaml`. Tokens und Datenbankkennwörter gehören
immer in die oben genannten Secrets.
