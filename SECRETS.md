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
| `llm-api-key` | DeepSeek API-Key für `deepseek-flash` |

Image-Pull-Secret: `ghcr-innovation-man` mit ausschließlich `read:packages`.

Innovation-Man benötigt keine GitHub-, Registry-, Argo- oder Kubernetes-Zugangsdaten.

## Sales-Man

Secretname gemäß Standardwert: `sales-man-secrets`

| Schlüssel | Inhalt |
|---|---|
| `database-url` | PostgreSQL-URL für die eingeschränkte Rolle `sales_man` |
| `llm-api-key` | DeepSeek API-Key für `deepseek-flash` |

Image-Pull-Secret: `ghcr-sales-man` mit ausschließlich `read:packages`.

Sales-Man benötigt keine GitHub-, Registry-, Argo- oder Kubernetes-Zugangsdaten.

## Manager-Man

Secretname gemäß Standardwert: `manager-man-secrets`

| Schlüssel | Inhalt |
|---|---|
| `database-url` | PostgreSQL-URL für die Laufzeitrolle `manager_man` |
| `github-token` | Classic PAT des separaten Manager-GitHub-Kontos; wird in neue Produkt-Repositories zusätzlich als `TAMBINOS_PAT` hinterlegt |
| `deepseek-api-key` | DeepSeek-Key für die AI-Pipes-Workflows; wird verschlüsselt als Repo-Secret `DEEPSEEK_API_KEY` gesetzt |
| `infra-github-token` | Separater Token von `GurkeSchaleSammler` mit Schreibrechten auf `homelab-helm` und `homelab-gitops`. Wird niemals an Produkt-Repositories weitergegeben. |

Der durch `github-token` authentifizierte Login muss `sechssiebe67-wq` sein.
Manager-Man prüft dies vor jeder Produkt-Repository-Erstellung und bricht bei
einem Token eines anderen Kontos ohne Mutation ab.

Image-Pull-Secret: `ghcr-manager-man` mit ausschließlich `read:packages`. Dafür
wird nicht `github-token` wiederverwendet.

Für die einmalige Datenbankmigration existiert getrennt
`factory-migration-secrets` mit dem Schlüssel `database-url`. Dieser Benutzer
benötigt DDL-Rechte. Er wird nur in den kurzlebigen Helm-Hook geladen und nicht
in den Manager-Laufzeitpod.

## GitHub-Rechte des Manager-Kontos

Der Code verwendet ausschließlich die GitHub REST API. Der Classic PAT benötigt:

- `repo` für private Repositories, Inhalte, Issues, Pull Requests und Actions-Secrets
- `workflow`, weil die kopierte Vorlage Dateien unter `.github/workflows/` enthält
- `read:packages` und `write:packages`, wenn Produkt-Workflows GHCR verwenden
- `delete:packages` nur wenn Manager-Man Images löschen soll
- `delete_repo` nur wenn Manager-Man Produkt-Repositories löschen soll

Ein separater Account ist sinnvoll. Ein uneingeschränkter Classic-PAT mit
Kontovollzugriff ist technisch nicht erforderlich und vergrößert den möglichen
Schaden erheblich. Bevorzugt wird ein Fine-grained PAT, das nur die genannten
Repositories und Rechte enthält. Wenn du dem Account organisatorisch volle
Rechte gibst, sollte der im Cluster gespeicherte Token trotzdem auf diese
minimalen Berechtigungen begrenzt werden.

Das GitHub-Passwort wird niemals als Secret hinterlegt.

Für private Produktimages wird `ghcr-product-images` im Namespace
`ai-product-factory` als Registry-Secret benötigt. Der Sync-Hook jedes
Produkt-Charts kopiert ausschließlich dieses Secret in seinen eigenen
Produktnamespace. Der Manager erhält nur lesenden Zugriff auf Argo-Applications.

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
  --from-literal=deepseek-api-key='…'
```

## Nicht geheime Chartwerte

Modellname, LLM-Endpoint, Repositorynamen, Pipeline-Branch und die Sichtbarkeit
neuer Produkt-Repositories sind Konfiguration und stehen in den jeweiligen
`values.yaml`. Tokens und Datenbankkennwörter gehören immer in die oben
genannten Secrets.
