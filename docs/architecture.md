# Architecture MVP

```text
RH Dashboard Web
      |
      v
FastAPI
      |
      v
Orchestrateur
      |
      +--> Agent import Excel -> Agent nettoyage -> MongoDB
      |
      +--> Agent traitement CV -> Agent embedding -> Agent scoring -> MongoDB
```

## Decisions

- Le depot CV est interne RH.
- Les candidats externes n'ont pas d'interface publique dans ce MVP.
- Le dashboard est dans l'application web.
- Power BI reste possible comme couche reporting ulterieure.

## Collections MongoDB

```text
employes
candidats
cv_documents
postes
conges
heures_supplementaires
mouvements
agent_runs
logs
notifications
```
