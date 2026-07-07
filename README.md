# Générateur de prospects SCI

MVP pour identifier des SCI propriétaires / bailleurs potentiels, enrichir les données publiques disponibles, scorer les sociétés qui ressemblent le plus à des clients potentiels de BailNotarie, puis préparer une prospection multicanal.

## Objectif métier

Trouver des SCI actives, principalement dans l'immobilier locatif long terme, avec le maximum de signaux utiles :

- identité société : SIREN, nom, adresse, activité, statut, âge ;
- dirigeants et associés quand disponibles légalement ;
- signaux immobiliers : activité `68.20A` / `68.20B`, nombre d'établissements, localisation, ancienneté ;
- signaux commerciaux : email, site, LinkedIn, réseaux sociaux, téléphone, source de chaque donnée ;
- score de proximité avec le client cible BailNotarie ;
- prochaine action de contact.

## Sources prioritaires

Sources publiques et stables à intégrer dans cet ordre :

1. API Recherche d'entreprises
   - ouverte, sans compte ;
   - base : `https://recherche-entreprises.api.gouv.fr/search` ;
   - utile pour démarrer vite : SCI actives, activité, dirigeants, siège, géolocalisation ;
   - limite officielle : 7 appels/seconde.

2. Sirene INSEE
   - données entreprises et établissements complètes ;
   - accès ouvert avec compte INSEE ;
   - utile pour alimenter un gros stock national proprement.

3. INPI / RNE
   - données du Registre national des entreprises, actes, statuts, comptes non confidentiels ;
   - accès API/SFTP gratuit après connexion à un compte INPI ;
   - utile pour récupérer plus de contexte légal et parfois les associés / documents.

4. DVF / Cadastre
   - ventes foncières sur les dernières années ;
   - utile pour signaux de marché et zones ;
   - attention : ne pas construire un mécanisme de réidentification de personnes à partir de recoupements.

5. Enrichissement web
   - recherche de site officiel, email générique, téléphone, LinkedIn dirigeant ou société ;
   - chaque donnée doit garder sa source et sa date de collecte ;
   - respecter RGPD, opt-out, conditions d'utilisation des sites, et règles anti-spam.

## MVP recommandé

Le premier produit doit être simple :

1. importer les SCI actives depuis l'API Recherche d'entreprises ;
2. filtrer sur `nature_juridique=6540`, `etat_administratif=A`, `section_activite_principale=L` ;
3. prioriser les activités `68.20A` et `68.20B` ;
4. stocker les prospects dans un CSV ou PostgreSQL ;
5. afficher un score simple et explicable ;
6. ajouter une colonne "prochaine action" : enrichir, vérifier, contacter, exclure.

## Stack cible

- Interface : Next.js
- Base : PostgreSQL Neon
- ORM : Prisma
- Collecte continue : worker TypeScript lance separement de Next.js
- Prototype local historique : scripts Python dans `src/sci_prospects`

La base produit n'est pas SQLite. SQLite ne sert plus que pour l'ancien prototype Python.

## Installation Next.js + Prisma

```powershell
npm install
npm run db:generate
npm run db:push
```

Le fichier `.env` doit contenir `DATABASE_URL` avec l'URL Neon.

## Usage produit

Lancer une collecte courte de test :

```powershell
npm run collect:test
```

Lancer la collecte continue :

```powershell
npm run collect -- --sleep 250 --cycle-sleep 3600000
```

Lancer l'interface :

```powershell
npm run dev
```

Puis ouvrir :

```text
http://localhost:3000
```

## Ancien prototype Python

Exporter 100 prospects SCI actifs :

```powershell
python .\src\sci_prospects\fetch_sci.py --limit 100 --csv .\data\prospects_sci.csv --jsonl .\data\prospects_sci.jsonl
```

Limiter à un département :

```powershell
python .\src\sci_prospects\fetch_sci.py --departement 75 --limit 100 --csv .\data\prospects_sci_75.csv
```

## Collecte continue

Pour collecter le maximum de SCI tout en respectant les limites de l'API, utilise le collecteur continu. Il balaie les departements un par un, garde un checkpoint dans SQLite et reprend ou il s'etait arrete.

Test court sur 3 pages :

```powershell
python .\src\sci_prospects\continuous_collector.py --departements 75,92 --max-pages 3 --csv .\data\prospects_sci_live.csv
```

Lancement continu :

```powershell
python .\src\sci_prospects\continuous_collector.py --sleep 0.25 --cycle-sleep 3600 --csv .\data\prospects_sci_live.csv
```

Parametres importants :

- `--sleep 0.25` limite la cadence a environ 4 appels/seconde, sous la limite officielle de 7 appels/seconde.
- `--cycle-sleep 3600` attend 1 heure apres un tour complet avant de verifier les nouvelles donnees.
- `--db` stocke les prospects et checkpoints dans SQLite.
- `--export-every` controle la frequence de regeneration du CSV.

## Interface locale

Lancer l'interface de gestion des prospects :

```powershell
python .\src\sci_prospects\web_app.py --db .\data\sci_prospects.sqlite --port 8765
```

Ouvrir ensuite :

```text
http://127.0.0.1:8765
```

Fonctions disponibles :

- vue liste triee par score ;
- filtres par nom, SIREN, ville, score, activite et statut ;
- fiche prospect avec dirigeants, adresse et raisons du score ;
- gestion du statut : a enrichir, a contacter, contacte, relance, exclu ;
- notes commerciales par prospect.

## Score v0

Le score actuel est volontairement simple :

- SCI active : base élevée ;
- activité `68.20A` ou `68.20B` : signal fort de location / exploitation immobilière ;
- plusieurs établissements ouverts : signal de patrimoine ou activité structurée ;
- dirigeants disponibles : utile pour enrichissement commercial ;
- société ancienne : signal de stabilité ;
- coordonnées géographiques : utile pour analyse locale ;
- catégorie PME/ETI/GE : signal de taille.

Ce score n'est pas une vérité métier. Il sert à trier les premiers lots et à apprendre vite.

## Conformité

À traiter dès le départ :

- garder la source et la date de chaque donnée ;
- ne pas prospecter les personnes en diffusion partielle Sirene ;
- ne pas utiliser DVF pour réidentifier indirectement des personnes ;
- prévoir suppression / opt-out ;
- ne pas scraper LinkedIn ou annuaires en violation de leurs conditions ;
- vérifier le cadre CNIL/RGPD avant prospection automatisée à grande échelle.

## Roadmap courte

1. CSV national propre depuis API Recherche d'entreprises.
2. Base PostgreSQL + déduplication par SIREN.
3. Enrichissement INPI/RNE.
4. Enrichissement email/site avec validation de source.
5. Scoring IA : résumé société, probabilité bailleur long terme, raison du score.
6. Tableau de bord simple : liste, filtres, fiche prospect, export séquence email.
