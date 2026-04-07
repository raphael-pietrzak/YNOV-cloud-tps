# TP 2 — Docker Avance, Cloud Run & Networking GCP

## Cours 2 | Developper pour le Cloud | YNOV Campus Montpellier — Master 2

**Date :** 07/04/2026 | **Duree TP :** 3 h | **Plateforme :** Google Cloud Platform

## Prerequis valides (Cours 1)

- Compte GCP actif, `gcloud` configure
- `docker` installe et fonctionnel
- Application Flask tp1-app/ operationnelle en local

## Objectifs

- Optimiser un Dockerfile avec le build multi-stage
- Orchestrer une stack applicative avec Docker Compose (app + base de donnees)
- Pousser une image vers Google Artifact Registry
- Deployer l'application sur Cloud Run
- Configurer un VPC avec sous-reseaux et regles de pare-feu

## Livrables attendus

- URL publique de votre application deployee sur Cloud Run (accessible depuis internet)
- Capture d'ecran du terminal : `docker images` montrant la reduction de taille (standard vs multi-stage)
- Capture d'ecran : service Cloud Run actif dans la console GCP
- Fichier docker-compose.yml fonctionnel
- README.md expliquant l'architecture et les commandes

## Partie 1 — Docker Multi-Stage Build (30 min)

Le build multi-stage permet de separer l'environnement de compilation de l'environnement de production, reduisant drastiquement la taille de l'image finale.

### 1.1 — Comprendre le probleme

Commencons par mesurer la taille d'une image "naive".

Creez un nouveau dossier tp2-app/ avec une application Node.js + TypeScript :

**tp2-app/src/index.ts**

```ts
import express, { Request, Response } from 'express';

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

app.get('/', (req: Request, res: Response) => {
  res.json({
    message: 'Hello from YNOV Cloud TP2',
    version: '2.0.0',
    stage: process.env.APP_ENV || 'production',
  });
});

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
```

**tp2-app/package.json**

```json
{
  "name": "tp2-app",
  "version": "2.0.0",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts"
  },
  "dependencies": {
    "express": "^4.18.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.11.5",
    "typescript": "^5.3.3"
  }
}
```

**tp2-app/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true
  }
}
```

**Dockerfile naive** (tp2-app/Dockerfile.naive)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
CMD ["node", "dist/index.js"]
```

```bash
cd tp2-app
# Builder l'image naive
docker build -f Dockerfile.naive -t tp2-naive:v1 .

# Mesurer la taille
docker images tp2-naive:v1
# Notez la taille : 282 MB
```

### 1.2 — Dockerfile Multi-Stage

Maintenant creez le vrai Dockerfile (tp2-app/Dockerfile) avec deux stages :

```dockerfile
# ============================================
# Stage 1 : Build — Environnement de compilation
# ============================================
FROM node:20-alpine AS build

WORKDIR /app

# Copier les fichiers de dependances
COPY package*.json ./
COPY tsconfig.json ./

# Installer TOUTES les dependances (y compris dev pour compiler TypeScript)
RUN npm install

# Copier le code source TypeScript
COPY src/ ./src/

# Compiler TypeScript -> JavaScript
RUN npm run build

# ============================================
# Stage 2 : Runtime — Image de production minimale
# ============================================
FROM node:20-alpine AS runtime

WORKDIR /app

# Copier uniquement package.json pour installer les dependances de PRODUCTION
COPY package*.json ./
RUN npm ci --only=production # Flag pour exclure devDependencies (syntaxe npm v9+)

# Copier uniquement les fichiers compiles depuis le stage "build"
# Syntaxe : COPY --from=[NOM_STAGE] [SOURCE] [DEST]
COPY --from=build /app/dist ./dist

# Utilisateur non-root pour la securite
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 8080
ENV APP_ENV=production
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
```

```bash
# Builder l'image multi-stage
docker build -t tp2-app:v1 .

# Comparer les tailles
docker images | grep tp
# tp2-naive v1 ... 282 MB
# tp2-app v1 ... 240 MB

# Question : quelle est la reduction de taille en % ?
# Calcul : (taille_naive - taille_multistage) / taille_naive * 100 = 14.9 %
```

**Question :** Pourquoi les outils de build (TypeScript, gcc, etc.) ne doivent-ils pas etre presents dans l'image de production ?

Reponse :

L'image de production n'aura que ce qu'elle a besoin pour fonctionner (code compilé + dependances de production). Les outils de build sont inutiles et augmentent la surface d'attaque en cas de faille de securite. De plus, une image plus petite se telecharge plus vite et consomme moins de ressources.

### 1.3 — .dockerignore

Creez tp2-app/.dockerignore :

```text
node_modules
dist
*.log
.env
.git # Exclure le dossier .git
*.md
Dockerfile*
docker-compose*
```

## Partie 2 — Docker Compose : Stack App + PostgreSQL (30 min)

Docker Compose orchestre plusieurs conteneurs en local. On simule ici un environnement de developpement complet.

### 2.1 — Ajouter la connexion base de donnees

Modifiez tp2-app/src/index.ts pour ajouter une route /db :

```ts
import express, { Request, Response } from 'express';
import { Pool } from 'pg';

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

// Pool de connexion PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'ynov_db',
  user: process.env.DB_USER || 'ynov',
  password: process.env.DB_PASSWORD || 'password',
});

app.get('/', (req: Request, res: Response) => {
  res.json({ message: 'Hello from YNOV Cloud TP2', version: '2.1.0' });
});

app.get('/health', async (req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

app.get('/db', async (req: Request, res: Response) => {
  try {
    // Creer la table si elle n'existe pas et inserer une entree
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visits (
        id SERIAL PRIMARY KEY,
        visited_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query('INSERT INTO visits DEFAULT VALUES');
    const result = await pool.query('SELECT COUNT(*) as total FROM visits');
    res.json({ total_visits: parseInt(result.rows[0].total, 10) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on :${PORT}`);
});
```

Ajouter pg aux dependances dans package.json :

```bash
# Dans le dossier tp2-app
npm install pg
npm install --save-dev @types/pg
```

### 2.2 — Ecrire le fichier docker-compose.yml

Creez tp2-app/docker-compose.yml en completant les blancs :

```yaml
version: "3.9"
services:
  # Service applicatif Node.js
  web:
    build: .
    ports:
      - "8080:8080" # Mapper le port 8080 local vers le port 8080 du conteneur
    environment:
      - APP_ENV=development
      - DB_HOST=db # Nom du service PostgreSQL (resolution DNS automatique par Docker)
      - DB_PORT=5432
      - DB_NAME=ynov_db
      - DB_USER=ynov
      - DB_PASSWORD=secret_password
    depends_on:
      db:
        condition: service_healthy # Attendre que le healthcheck PostgreSQL soit healthy
    networks:
      - app-network

  # Service PostgreSQL
  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_DB=ynov_db
      - POSTGRES_USER=ynov
      - POSTGRES_PASSWORD=secret_password
    volumes:
      # Volume nomme pour la persistance des donnees
      - db_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ynov -d ynov_db"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - app-network

# Definition des volumes nommes
volumes:
  db_data:

# Definition du reseau dedie
networks:
  app-network:
    driver: bridge
```

**Question :** Pourquoi utilise-t-on `condition: service_healthy` plutot que `condition: service_started` pour `depends_on` ?

Reponse :

Pour pouvoir accepter des connexions, `service_started` ne garantit pas que la base de donnees est prete a recevoir des connexions, ce qui peut causer des erreurs de connexion dans le service web.

### 2.3 — Lancer et tester la stack

```bash
# Demarrer tous les services en arriere-plan
docker-compose up -d

# Verifier l'etat des services (doivent etre "running" et "healthy")
docker-compose ps

# Voir les logs en temps reel
docker-compose logs web

# Arreter sans supprimer les volumes (donnees conservees)
docker-compose stop

# Arreter ET supprimer les volumes (reset complet)
docker-compose down -v

# Tester l'application
curl http://localhost:8080/
curl http://localhost:8080/health
curl http://localhost:8080/db # Premier appel -> total_visits: 1
curl http://localhost:8080/db # Second appel -> total_visits: 2
```

## Partie 3 — Artifact Registry & Push de l'Image (20 min)

Artifact Registry est le registry prive de GCP. Il remplace Container Registry (gcr.io) et supporte Docker, Maven, npm, Python, etc.

### 3.1 — Creer un repository Artifact Registry

```bash
# Creer un repository Docker dans Artifact Registry
# --repository-format=docker : type Docker
# --location : region GCP
gcloud artifacts repositories create tp2-registry \
  --repository-format=docker \
  --location=europe-west9 \
  --description="Registry TP2 YNOV"

# Lister les repositories existants
gcloud artifacts repositories list --location=europe-west9
```

### 3.2 — Authentifier Docker avec Artifact Registry

```bash
# Configurer Docker pour utiliser gcloud comme credential helper
# europe-west9-docker.pkg.dev est l'endpoint Artifact Registry pour Paris
gcloud auth configure-docker europe-west9-docker.pkg.dev

# Verifier la configuration dans ~/.docker/config.json
cat ~/.docker/config.json | grep -A3 "credHelpers"
```

### 3.3 — Tagger et pousser l'image

```bash
# Format du tag pour Artifact Registry :
# [REGION]-docker.pkg.dev/[PROJECT_ID]/[REPOSITORY]/[IMAGE]:[TAG]
PROJECT_ID=$(gcloud config get-value project)
IMAGE_TAG="europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry/tp2-app:v1"

echo "Image tag : ${IMAGE_TAG}"

# Tagger l'image locale avec le format Artifact Registry
docker tag tp2-app:v1 ${IMAGE_TAG}

# Pousser l'image
docker push ${IMAGE_TAG}

# Verifier que l'image est bien dans le registry
gcloud artifacts docker images list \
  europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry
```

## Partie 4 — Deploiement sur Cloud Run (20 min)

Cloud Run est le service PaaS serverless de GCP pour les conteneurs. Il scale automatiquement de 0 a N instances selon le trafic, et vous ne payez qu'a l'usage.

### 4.1 — Deployer le service

```bash
# Sur Mac M1 :
docker buildx build \
  --platform linux/amd64 \
  -t $IMAGE \
  --push .
```


```bash
PROJECT_ID=$(gcloud config get-value project)
IMAGE="europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry/tp2-app:v1"

gcloud run deploy tp2-service \
  --image=${IMAGE} \
  --region=europe-west9 \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --memory=512Mi \
  --cpu=1 \
  --max-instances=3 \
  --set-env-vars="APP_ENV=production"

# La commande retourne une URL publique du type :
# https://tp2-service-xxxxxxxxxx-ew.a.run.app
```

Note : Cloud Run ne peut pas se connecter directement a votre PostgreSQL local. Pour ce TP, le service /db retournera une erreur de connexion — ce n'est pas un probleme. On utilisera Cloud SQL en cours 4.

### 4.2 — Tester le deploiement

```bash
# Recuperer l'URL du service
SERVICE_URL=$(gcloud run services describe tp2-service \
  --region=europe-west9 \
  --format='value(status.url)')

echo "URL du service : ${SERVICE_URL}"

# Tester les endpoints
curl https://tp2-service-774901146170.europe-west9.run.app/
curl https://tp2-service-774901146170.europe-west9.run.app/health

# Resultat : 
# object{2}
# status: "error"
# database: "disconnected"

# Verifier les informations du service
gcloud run services describe tp2-service --region=europe-west9
```

**Question :** Quelle est la difference entre `--max-instances=3` et `--min-instances=1` dans Cloud Run ?

Reponse :

L'option `--max-instances=3` limite le nombre maximum d'instances que Cloud Run peut creer pour gerer le trafic. Si la demande depasse la capacite de 3 instances, les requetes seront mises en file d'attente ou rejetees. L'option `--min-instances=1` garantit qu'au moins une instance est toujours en cours d'execution, meme en periode d'inactivite. Cela permet de reduire le temps de reponse pour la premiere requete (pas de cold start), mais engendre des couts meme sans trafic.

### 4.3 — Observer le comportement de scale a zero

```bash
# Ne pas envoyer de requetes pendant 5 minutes, puis relancer
# Cloud Run reduit les instances a 0 apres inactivite (cold start)
# Mesurer le temps de reponse apres inactivite
time curl ${SERVICE_URL}/health

# Question : Combien de ms pour le premier appel (cold start) ?
# Reponse : 20ms

# Combien de ms pour les appels suivants (warm) ?
# Reponse : 10ms
```

## Partie 5 — Networking GCP : VPC & Firewall (20 min)

GCP cree un VPC "default" automatiquement. Pour des deploiements professionnels, on cree son propre VPC avec des sous-reseaux isoles.

### 5.1 — Creer un VPC personnalise

```bash
# Creer un VPC en mode custom (pas de sous-reseaux automatiques)
gcloud compute networks create tp2-vpc \
  --subnet-mode=custom # custom ou auto ?

# Creer un sous-reseau public (pour les services exposes a internet)
gcloud compute networks subnets create tp2-subnet-public \
  --network=tp2-vpc \
  --region=europe-west9 \
  --range=10.10.1.0/24 # Utiliser le bloc CIDR 10.10.1.0/

# Creer un sous-reseau prive (pour les bases de donnees, non expose)
gcloud compute networks subnets create tp2-subnet-private \
  --network=tp2-vpc \
  --region=europe-west9 \
  --range=10.10.2.0/
```

**Question :** Pourquoi separe-t-on les ressources applicatives et les bases de donnees dans des sous-reseaux differents ?

Reponse :

Cela permet d'appliquer des regles de securite differentes (firewall) entre les sous-reseaux. Par exemple, on peut autoriser le trafic HTTP depuis internet vers le sous-reseau public, mais restreindre l'acces a PostgreSQL uniquement depuis le sous-reseau prive. Cela limite la surface d'attaque en cas de faille de securite dans l'application.

### 5.2 — Regles de pare-feu (Firewall Rules)

```bash
# Regle 1 : Autoriser le trafic HTTP (port 80) depuis internet vers le sous-reseau public
gcloud compute firewall-rules create tp2-allow-http \
  --network=tp2-vpc \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:80 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=http-server

# Regle 2 : Autoriser le trafic HTTPS (port 443)
gcloud compute firewall-rules create tp2-allow-https \
  --network=tp2-vpc \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:443 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=http-server

# Regle 3 : Autoriser PostgreSQL (port 5432) UNIQUEMENT depuis le sous-reseau applicatif
gcloud compute firewall-rules create tp2-allow-postgres \
  --network=tp2-vpc \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:5432 \
  --source-ranges=10.10.1.0/24 # Uniquement depuis 10.10.1.0/24 (subnet public) \
  --target-tags=db-server

# Lister les regles de firewall du VPC
gcloud compute firewall-rules list --filter="network=tp2-vpc"
```

**Question :** Quelle est la difference entre un Security Group (AWS) et une Firewall Rule (GCP) ?

Reponse :

### 5.3 — Nettoyage du VPC

```bash
# Supprimer dans l'ordre inverse (les regles avant le VPC)
gcloud compute firewall-rules delete tp2-allow-http --quiet
gcloud compute firewall-rules delete tp2-allow-https --quiet
gcloud compute firewall-rules delete tp2-allow-postgres --quiet
gcloud compute networks subnets delete tp2-subnet-public --region=europe-west9 --quiet
gcloud compute networks subnets delete tp2-subnet-private --region=europe-west9 --quiet
gcloud compute networks delete tp2-vpc --quiet

echo "Nettoyage VPC termine"
```

## Partie 6 — Cloud Storage Avance : Versioning & Lifecycle (20 min)

En production, on ne supprime jamais accidentellement des fichiers. Le versioning et les regles de lifecycle protegent les donnees et optimisent les couts.

### 6.1 — Bucket avec versioning active

```bash
PROJECT_ID=$(gcloud config get-value project)
BUCKET="ynov-tp2-versioned-${PROJECT_ID}"

# Creer un bucket avec versioning active des la creation
gcloud storage buckets create gs://${BUCKET} \
  --location=europe-west9 \
  --uniform-bucket-level-access # Controle d'acces unifie (recommande)

# Activer le versioning sur le bucket
gcloud storage buckets update gs://${BUCKET} \
  --versioning # Flag pour activer le versioning

# Verifier
gcloud storage buckets describe gs://${BUCKET} \
  --format="value(versioning.enabled)"
# Resultat attendu : True
```

### 6.2 — Tester le versioning

```bash
# Creer et uploader un fichier
echo "Version 1 - $(date)" > config.json
gcloud storage cp config.json gs://${BUCKET}/

# Modifier et uploader une nouvelle version
echo "Version 2 - $(date)" > config.json
gcloud storage cp config.json gs://${BUCKET}/

# Uploader une 3eme version
echo "Version 3 - $(date)" > config.json
gcloud storage cp config.json gs://${BUCKET}/

# Lister TOUTES les versions (y compris les anciennes)
gcloud storage ls -a gs://${BUCKET}/config.json

# Question : combien de versions voyez-vous ?
# Reponse : 3

# Lire une ancienne version via sa generation (numero affiche dans ls -a)
# gcloud storage cp "gs://${BUCKET}/config.json#[NUMERO_GENERATION]" ./config_v1.json
```

### 6.3 — Regles de lifecycle automatisees

```bash
# Creer un fichier de regles lifecycle (JSON)
cat > lifecycle.json << 'EOF'
{
  "lifecycle": {
    "rule": [
      {
        "action": { "type": "Delete" },
        "condition": {
          "numNewerVersions": 3,
          "isLive": false
        }
      },
      {
        "action": {
          "type": "SetStorageClass",
          "storageClass": "NEARLINE"
        },
        "condition": {
          "age": 30,
          "isLive": true
        }
      }
    ]
  }
}
EOF

# Appliquer les regles lifecycle au bucket
gcloud storage buckets update gs://${BUCKET} \
  --lifecycle-file=lifecycle.json

# Verifier les regles appliquees
gcloud storage buckets describe gs://${BUCKET} \
  --format="json(lifecycle)"
```

**Question :** Expliquez les deux regles lifecycle configurees ci-dessus. Quel est l'interet economique de passer en classe NEARLINE apres 30 jours ?

Regle 1 : Supprime les anciennes versions d'un fichier, en conservant uniquement les 3 dernières versions.

Regle 2 : Change la classe de stockage d'un fichier en NEARLINE après 30 jours.

Interet economique : La classe NEARLINE est moins couteuse que la classe STANDARD pour le stockage de fichiers qui sont rarement accedes. En basculant automatiquement les fichiers inactifs vers NEARLINE, on peut reduire les couts de stockage a long terme, tout en conservant les fichiers accessibles en cas de besoin.

### 6.4 — Nettoyage

```bash
# Supprimer TOUTES les versions (y compris les non-live)
gcloud storage rm -r --all-versions gs://${BUCKET}
```

## Partie 7 — Cloud Run Avance : Revisions & Traffic Splitting (20 min)

Cloud Run gere des revisions (snapshots immuables d'un deploiement). On peut router le trafic entre plusieurs revisions pour des deploiements progressifs.

### 7.1 — Deployer une nouvelle revision

On simule une mise a jour applicative en changeant une variable d'environnement (sans changer le code).

```bash
PROJECT_ID=$(gcloud config get-value project)
IMAGE="europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry/tp2-app:v1"

# Deployer une "v2" avec une variable d'environnement differente
# --no-traffic : la nouvelle revision ne recoit PAS de trafic immediatement
gcloud run deploy tp2-service \
  --image=${IMAGE} \
  --region=europe-west9 \
  --no-traffic \
  --set-env-vars="APP_ENV=production,APP_VERSION=2.0.0" \
  --tag=v2-canary # Tag pour identifier cette revision

# Lister les revisions
gcloud run revisions list \
  --service=tp2-service \
  --region=europe-west9
```

### 7.2 — Traffic Splitting (deploiement Canary)

```bash
# Router 80% du trafic vers la revision stable, 20% vers la nouvelle
# Recuperer les noms des 2 dernieres revisions
REV_STABLE=$(gcloud run revisions list \
  --service=tp2-service --region=europe-west9 \
  --format="value(name)" | sed -n '2p') # 2eme = ancienne

REV_CANARY=$(gcloud run revisions list \
  --service=tp2-service --region=europe-west9 \
  --format="value(name)" | sed -n '1p') # 1ere = derniere (canary)

echo "Stable : ${REV_STABLE}"
echo "Canary : ${REV_CANARY}"

# Diviser le trafic : 80% stable, 20% canary
gcloud run services update-traffic tp2-service \
  --region=europe-west9 \
  --to-revisions="${REV_STABLE}=80,${REV_CANARY}=20"

# Verifier la repartition du trafic
gcloud run services describe tp2-service \
  --region=europe-west9 \
  --format="yaml(status.traffic)"
```

### 7.3 — Tester la repartition

```bash
SERVICE_URL=$(gcloud run services describe tp2-service \
  --region=europe-west9 --format='value(status.url)')

# Envoyer 10 requetes et observer quelle version repond
for i in $(seq 1 10); do
  curl -s ${SERVICE_URL}/ | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stage','?'))"
done

# Question : sur 10 requetes, combien environ ont recu APP_VERSION=2.0.0 ?
# Resultat observe : Je suis censé avoir 2 develop et 8 production, mais c'est aleatoire a chaque execution, normal sur aussi peu de requetes.
# Explication mathematique (20% de 10 requetes) : 0.2 * 10 = 2 requetes pour la canary, 8 requetes pour la stable.
```

### 7.4 — Basculer 100 % vers la nouvelle revision (promotion)

```bash
# Apres validation : envoyer 100% du trafic vers la canary
gcloud run services update-traffic tp2-service \
  --region=europe-west9 \
  --to-latest

# Verifier
gcloud run services describe tp2-service \
  --region=europe-west9 \
  --format="yaml(status.traffic)"
```

**Question :** Pourquoi le traffic splitting est-il preferable a un redeploiement direct (`--to-latest` immediat) en production ?

Reponse :

Si ça crash ça ne va impacter que 20% des utilisateurs, et on peut rapidement revenir en arrière.

## Partie 8 — Docker Compose : Ajouter un Cache Redis (20 min)

Les applications cloud utilisent souvent un cache en memoire pour reduire la charge sur la base de donnees et accelerer les reponses.

### 8.1 — Ajouter Redis au docker-compose.yml

Modifiez tp2-app/docker-compose.yml pour ajouter un service Redis :

```yaml
# Ajouter ce service apres "db:"
cache:
  image: redis:7-alpine # Utiliser la version 7
  command: redis-server --maxmemory 128mb --maxmemory-policy allkeys-lru
  ports:
    - "6379:6379"
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 5s
    timeout: 3s
    retries: 3
  networks:
    - app-network
```

Ajouter la variable d'environnement Redis dans le service web :

```yaml
environment:
  - REDIS_HOST=cache # Nom du service cache
  - REDIS_PORT=6379
```

Et ajouter la dependance :

```yaml
depends_on:
  db:
    condition: service_healthy
  cache:
    condition: service_healthy
```

### 8.2 — Ajouter la route /cached dans l'application

Ajoutez dans src/index.ts :

```ts
import { createClient } from 'redis';

const redisClient = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
});

redisClient.connect().catch(console.error);

app.get('/cached', async (req: Request, res: Response) => {
  const CACHE_KEY = 'visit_count_cached';
  const TTL_SECONDS = 10;

  try {
    // Lire depuis le cache Redis
    const cached = await redisClient.get(CACHE_KEY);

    if (cached !== null) {
      return res.json({
        total_visits: parseInt(cached, 10),
        source: "cache", // "cache" si lu depuis Redis
        ttl_remaining: await redisClient.ttl(CACHE_KEY),
      });
    }

    // Cache miss : lire depuis PostgreSQL
    const result = await pool.query('SELECT COUNT(*) as total FROM visits');
    const count = parseInt(result.rows[0].total, 10);

    // Stocker dans Redis avec TTL de 10 secondes
    await redisClient.setEx(CACHE_KEY, TTL_SECONDS, String(count));

    return res.json({
      total_visits: count,
      source: "database", // "database" si lu depuis PostgreSQL
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});
```

Installer le client Redis :

```bash
# redis v4+ inclut ses propres types TypeScript — @types/redis n'existe plus
npm install redis
```

### 8.3 — Tester le cache

```bash
docker-compose up -d --build

# Premiere requete -> source: "database" (cache froid)
curl http://localhost:8080/cached

# Requetes suivantes dans les 10 secondes -> source: "cache"
curl http://localhost:8080/cached
curl http://localhost:8080/cached

# Attendre 11 secondes et relancer -> source: "database" (cache expire)
sleep 11 && curl http://localhost:8080/cached

# Question : quel est l'interet du TTL (Time-To-Live) dans un cache ?
# Reponse :
```

**Question :** Dans quelle situation l'utilisation d'un cache Redis peut-elle poser un probleme de coherence des donnees ?

Reponse :

Si les donnees dans la base de donnees changent frequemment, le cache peut retourner des donnees obsoletes (stale) jusqu'a ce que le TTL expire. Cela peut poser un probleme de coherence si l'application a besoin de donnees a jour en temps reel.


## Nettoyage final

```bash
# Supprimer le service Cloud Run
gcloud run services delete tp2-service --region=europe-west9 --quiet

# Supprimer le repository Artifact Registry (et toutes les images)
gcloud artifacts repositories delete tp2-registry \
  --location=europe-west9 --quiet

# Verification
gcloud run services list --region=europe-west9
gcloud artifacts repositories list --location=europe-west9
```

## Recapitulatif — Competences validees

- Docker multi-stage build (reduction de taille d'image)
- Docker Compose avec PostgreSQL et Redis (stack multi-services)
- Google Artifact Registry (push et gestion d'images)
- Cloud Run (deploiement, revisions, traffic splitting canary)
- VPC + Subnets + Firewall Rules GCP
- Cloud Storage versioning et regles lifecycle
- Cache Redis avec TTL et gestion de la coherence

## Pour le Cours 3 (28/04/2026)

- Repository Git complet avec Dockerfile, docker-compose.yml et README
- URL Cloud Run de l'application deployee (preuve de deploiement)
- Journal des commandes executees avec les resultats
- Installer kubectl : `gcloud components install kubectl`
- Installer terraform : https://developer.hashicorp.com/terraform/downloads
