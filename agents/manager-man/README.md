# Manager-Man

Manager-Man ist der deterministische Ausführungsdienst der AI Product Factory.
Er setzt ausschließlich gültige, von der Policy Engine genehmigte
`ManagementCommand`s um und ist der einzige Infrastruktur-Schreiber.

## Eingaben

- genehmigter `ManagementCommand`
- erwartete Portfolio-Revision
- eindeutiger Idempotenzschlüssel
- verifizierbare CI-, Review-, Registry- und Laufzeitnachweise
- `VerifiedRelease` aus `ai-pipes`

## Ergebnisse

- `DevelopmentOrder` an `ai-pipes`
- nachvollziehbarer `ManagementResult`
- dauerhafte Statusänderung mit Audit-Eintrag
- bei erfolgreicher Freigabe ein verifiziertes Deployment und ein aktualisierter
  Portaleintrag

## Erlaubte Schreibziele

Zielbranch ist `main`. Änderungen sind auf folgende Pfade begrenzt:

| Repository | Erlaubte Pfade |
|---|---|
| `GurkeSchaleSammler/homelab-gitops` | `applications/ai-products.yaml`, `applications/ai-products/**` |
| `GurkeSchaleSammler/homelab-helm` | `charts/ai-products/**` |

## Grenzen

- Ohne gültigen Auftrag, passende Revision, Idempotenzschlüssel und Auditierung
  erfolgt keine Mutation.
- Force Push und Schreibzugriffe außerhalb der erlaubten Pfade sind verboten.
- Es gelten höchstens zehn belegte Slots, ein paralleler Build und drei
  Entwicklungs-/Review-Runden pro Auftrag.
- Releases werden erst nach unabhängig verifizierter CI, Review und Registry
  sowie bestätigtem Argo-Status und externer HTTP-Prüfung veröffentlicht.
- Ein Archivierungsslot wird erst nach bestätigtem Abschluss freigegeben.

Manager-Man ist eine benannte Serviceidentität, kein autonom entscheidender
LLM-Agent. Die hier beschriebenen Regeln müssen später serverseitig technisch
durchgesetzt werden.
