# Systeme d'analyse predictive RH - SONASID

Premier MVP pour centraliser les donnees RH, importer les fichiers Excel, deposer les CV par le service RH et afficher un dashboard web interne.

## Choix actuel

- Le dashboard principal est integre dans l'application web.
- L'acces est reserve au service RH.
- Le depot des CV est fait par les RH, pas par les candidats externes.
- Power BI pourra etre ajoute plus tard pour le reporting decisionnel avance.

## Installation

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Demarrer MongoDB localement, puis lancer l'API :

```bash
uvicorn app.main:app --reload
```

## URLs utiles

- API : `http://127.0.0.1:8000`
- Documentation : `http://127.0.0.1:8000/docs`
- Dashboard RH : `http://127.0.0.1:8000/api/v1/dashboard`

## Acces RH

L'authentification est desormais reelle : `POST /api/v1/auth/login` verifie
le mot de passe (hache en base MongoDB) et renvoie un jeton JWT. Toutes les
routes RH exigent ensuite l'en-tete `Authorization: Bearer <token>`.

Comptes de demonstration crees automatiquement au premier demarrage
(collection `users` vide) :

```text
rh.nador      / sonasid2026   -> role rh
admin.nador   / sonasid2026   -> role admin
manager.nador / sonasid2026   -> role manager
```

## Base vectorielle

`app/services/vector_store_service.py` utilise ChromaDB en mode persistant
(dossier local `data/vector_store`, aucun serveur externe requis). Les CV
analyses et les offres creees/mises a jour y sont automatiquement indexes.
**ChromaDB est optionnel** (dependance lourde) : installez-le avec
`pip install -r requirements-ai.txt`. Sans lui, l'application fonctionne
normalement, seule la recherche semantique / detection de doublon de CV
est desactivee silencieusement.

## Dashboard piloté par le fichier Excel

Le dashboard n'affiche plus aucune donnée d'exemple : tant qu'aucun fichier
Excel n'est importé (menu "Import annuel"), tous les indicateurs restent
vides. Une fois un fichier importé, chaque indicateur est calculé depuis les
colonnes réellement présentes (`Motif` pour les départs, `Forfait HS` pour
les heures supplémentaires si la colonne existe, etc.) ; si une colonne
attendue est absente du fichier (ex: congés, découpage SONASID/sous-traitants),
l'indicateur affiche honnêtement "non disponible" plutôt qu'un chiffre
inventé.

## Analyse CV : donnees reelles + checkpoint

La page "Analyse CV" affiche desormais les informations extraites du CV
utiles a la decision RH : email et telephone (cliquables), diplome, profil,
duree d'experience et lignes de parcours detectees, et les competences
(detectees / adaptees / manquantes). Avant d'indexer un nouveau CV dans la
base vectorielle, le systeme verifie s'il ressemble fortement (>= 92% de
similarite) a un CV deja traite et affiche un bandeau "Profil deja vu" le
cas echeant (utile pour reperer les doublons de candidature).

## Chatbot RH

`POST /api/v1/chatbot/message` repond aux questions sur les offres et les
indicateurs du dataset. Toute demande de modification renvoie une action
"en attente" (`requires_confirmation: true`) qui doit etre validee via
`POST /api/v1/chatbot/confirm` avant d'etre appliquee et journalisee
(`audit_logs`). Le chatbot cote interface web (candidats, entretiens,
pipeline) suit la meme regle de confirmation.

Exemple de connexion :

```bash
curl -X POST http://127.0.0.1:8000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "rh.nador", "password": "sonasid2026"}'
```

## Modules deja prepares

- Import Excel vers MongoDB
- Nettoyage de donnees
- Depot CV par RH
- Extraction texte PDF/DOCX
- Extraction simple du profil
- Scoring candidat basique
- Dashboard web interne
- Logs d'agents

## Prochaines etapes

1. ~~Ajouter une vraie authentification avec login/mot de passe.~~ Fait (JWT + mots de passe haches).
2. Completer les indicateurs RH dans le dashboard avec les vraies donnees congés/heures supplementaires/departs (actuellement illustratives, a brancher sur les collections `conges` et `heures_supplementaires`).
3. ~~Brancher une base vectorielle Qdrant ou Chroma.~~ Fait (Chroma, persistant local).
4. ~~Ajouter le chatbot RH avec confirmation obligatoire avant modification.~~ Fait (jobs cote backend ; candidats/entretiens cote interface web).
5. Persister les candidats/candidatures en MongoDB (actuellement en memoire cote interface web pour la demo) afin que le chatbot backend puisse aussi repondre sur les candidats.
6. Ajouter les exports pour Power BI si necessaire.

## Dependances IA optionnelles

Pour brancher Qdrant, les embeddings avances et les modeles predictifs plus tard :

```bash
pip install -r requirements-ai.txt
```

## Roles actuels

Les roles geres par le MVP sont :

```text
admin
rh
manager
```

Le role est desormais determine par le compte connecte (voir "Acces RH"
plus haut), via le jeton JWT renvoye par `/api/v1/auth/login` :

```text
Authorization: Bearer <token>
```

## Endpoints Lot 1 - Offres

```text
POST   /api/v1/jobs
GET    /api/v1/jobs
GET    /api/v1/jobs/{job_id}
PATCH  /api/v1/jobs/{job_id}
POST   /api/v1/jobs/{job_id}/open
POST   /api/v1/jobs/{job_id}/close
POST   /api/v1/jobs/{job_id}/archive
DELETE /api/v1/jobs/{job_id}
```

Suppression : logique uniquement, reservee au role `admin`.

## Lancement Docker

```bash
copy .env.example .env
docker compose up --build
```

## Interface de presentation

Une premiere interface web interne est disponible ici :

```text
http://127.0.0.1:8001/app
```

Elle contient : dashboard, offres, detail offre, candidats, candidatures, depot CV RH et logs admin. Les donnees affichees sont des donnees de demonstration pour presenter le concept avant le branchement complet MongoDB/API.
