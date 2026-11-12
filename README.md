# GitAnalyze

Collez l'adresse d'un dépôt git ou GitHub et obtenez un tableau de bord interactif :
activité dans le temps, contributeurs, heures de travail, types de commits,
langages, plus gros fichiers, fichiers les plus modifiés…

Tous les graphiques se filtrent par période, par auteur et avec ou sans les merges.

## Lancer le site

Prérequis : **Node.js 22.18+** (exécute le TypeScript sans compilation) et **git**.

```bash
npm install
npm run dev
```

Puis ouvrez <http://localhost:3000>.

Formats d'adresse acceptés :

| Saisie | Exemple |
| --- | --- |
| Raccourci GitHub | `expressjs/express` |
| URL web (même avec `/tree/...`) | `https://github.com/expressjs/express` |
| SSH | `git@github.com:expressjs/express.git` |

Le serveur clone toujours en HTTPS : seuls les dépôts **publics** peuvent être analysés.

## Fonctionnement

```
navigateur ──POST /api/analyses──▶ serveur Node ──git clone --bare──▶ GitHub, GitLab…
           ◀──progression (SSE)──         │
           ◀──rapport JSON (gzip)──  data/cache/<id>.json.gz
```

1. **`src/repoUrl.ts`** normalise l'adresse et refuse tout ce qui n'est pas un dépôt
   public sur un hôte autorisé (pas de `file://`, pas d'IP ni de `localhost`,
   pas d'identifiants dans l'URL).
2. **`src/analyze.ts`** clone le dépôt sans copie de travail, lit l'historique avec
   `git log --numstat` et compte les lignes de HEAD via `git cat-file --batch`.
   git est lancé sans shell, sans invite de mot de passe et en HTTPS uniquement.
3. **`src/jobs.ts`** gère la file d'attente (plusieurs visiteurs du même dépôt
   partagent une seule analyse) et le cache disque.
4. **`public/`** contient l'accueil et le tableau de bord (HTML, CSS et JS sans
   étape de build ; graphiques avec Chart.js). Les filtres sont calculés dans le
   navigateur : aucun aller-retour serveur.

## Configuration (variables d'environnement)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `3000` | Port HTTP |
| `HOST` | `127.0.0.1` | Interface d'écoute (`0.0.0.0` pour un serveur) |
| `ALLOWED_HOSTS` | `github.com,gitlab.com,bitbucket.org,codeberg.org` | Hôtes git autorisés (`*` = tout hôte public) |
| `MAX_CONCURRENT` | `2` | Analyses simultanées |
| `CACHE_TTL_MS` | `21600000` (6 h) | Durée de réutilisation d'un rapport |
| `CLONE_TIMEOUT_MS` | `600000` (10 min) | Délai maximal de clonage |
| `RATE_LIMIT` | `20` | Analyses lancées par IP toutes les 10 minutes |
| `DATA_DIR` | `data` | Dossier du cache |
| `TRUST_PROXY` | – | `1` derrière un reverse proxy (IP réelle pour la limite) |

## Docker

```bash
docker build -t gitanalyze .
docker run -p 3000:3000 -v gitanalyze-data:/data gitanalyze
```

## Outil en ligne de commande (C)

Le dossier `cli/` contient la première version de l'outil, en C : rapport dans le
terminal ou tableau de bord HTML autonome.

```bash
cd cli
gcc -O2 -Wall -o gitanalyze gitanalyze.c
./gitanalyze git@github.com:owner/repo.git          # rapport texte
./gitanalyze git@github.com:owner/repo.git --html   # tableau de bord HTML
```

`--html` embarque `dashboard.html` dans l'exécutable via `#embed` (gcc ≥ 15, clang ≥ 19).
Avec un compilateur plus ancien, le fichier est lu à côté de l'exécutable.

## Scripts

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Serveur avec rechargement automatique |
| `npm start` | Serveur en production |
| `npm run typecheck` | Vérification des types TypeScript |
