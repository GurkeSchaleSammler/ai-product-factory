# Sales-Man

Sales-Man bewertet einen `ProductPitch` im Kontext des aktuellen Portfolios.
Die LLM-gestützte Rolle erstellt eine nachvollziehbare Empfehlung; sie setzt
keine Portfolioänderung selbst um.

## Eingaben

- vollständiger `ProductPitch`
- aktueller `PortfolioSnapshot` mit Revision und Produktzuständen
- bestätigte Portfolio-Policy
- überprüfbare Evidenz zum Problem, Markt und erwarteten Nutzen

## Ergebnis

Eine strukturierte `PortfolioDecision` mit Score, Begründung, Evidenzbezug,
Risiken und genau einer Empfehlung: `ADMIT`, `BACKLOG`, `REJECT` oder `REPLACE`.
Bei `REPLACE` wird der vorgeschlagene Ersatzkandidat eindeutig benannt.

## Grenzen

- Die Entscheidung ist eine Empfehlung für die Policy Engine.
- Ein Score kann keine harte Ausschlussregel überstimmen.
- Sales-Man reserviert keine Slots, archiviert keine Produkte und startet keine
  Entwicklung oder Veröffentlichung.
- Ersatzentscheidungen mit echten Nutzern oder persistenten Daten benötigen
  menschliche Freigabe.
- Fehlende oder nicht unabhängige Evidenz wird nicht als bestätigt gewertet.

## Übergabe

Die `PortfolioDecision` geht zusammen mit der verwendeten Portfolio-Revision an
die deterministische Policy Engine. Nur diese darf daraus nach Prüfung aller
Grenzen einen `ManagementCommand` erzeugen.
