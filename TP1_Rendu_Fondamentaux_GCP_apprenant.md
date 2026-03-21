# TP1 - Fondamentaux Cloud & Setup GCP (Rendu)

## Partie 1 - Quiz Fondamentaux Cloud

### 1.1 - Modeles de service

| Description | Modele |
| --- | --- |
| Vous gerez uniquement votre code, l'infrastructure est abstraite | PaaS |
| Vous gerez l'OS, le middleware et l'application | IaaS |
| Vous utilisez l'application via un navigateur | SaaS |
| Google Compute Engine | IaaS |
| Google App Engine / Cloud Run | PaaS |
| Google Workspace | SaaS |

### 1.2 - Caracteristiques NIST

- **Self-service a la demande** : Provisionnement automatique sans intervention humaine.
- **Large acces reseau** : Accessible via internet depuis differents appareils.
- **Mutualisation des ressources** : Ressources partagees entre plusieurs clients.
- **Elasticite rapide** : Adaptation rapide des ressources selon le besoin.
- **Service mesure** : Facturation a l'usage.

### 1.3 - Monolithe vs Microservices

| Affirmation | Reponse |
| --- | --- |
| Deploiement independant | Microservices |
| Couplage fort | Monolithe |
| Scalabilite independante | Microservices |
| Debugging simple | Monolithe |
| Technologie agnostique | Microservices |

### 1.4 - Services GCP

| Categorie | Services |
| --- | --- |
| Compute | Compute Engine, Cloud Run, GKE |
| Stockage | Cloud Storage, Persistent Disk |
| Base de donnees | Cloud SQL, BigQuery |
| Reseau | VPC, Cloud DNS |
| Observabilite | Cloud Logging |

## Partie 2 - Setup GCP & gcloud CLI

### 2.1 - Verification

```bash
gcloud version
docker version
```

![alt text](<readme/Screenshot 2026-03-20 at 12.21.38.png>)

### 2.2 - Configuration

```bash
gcloud auth login
gcloud auth list
gcloud config set project project-30a4ee58-7db6-4e3c-94b
gcloud config set compute/region europe-west1
gcloud config set compute/zone europe-west1-b
gcloud config list
```

![alt text](<readme/Screenshot 2026-03-20 at 12.21.56.png>)

**Difference region / zone :** une region est un ensemble de zones geographiques, une zone est un datacenter specifique dans une region.

### 2.3 - Activation des APIs

a) Dans IAM & Admin → IAM, quel est votre rôle sur le projet ?

```text
Administrateur d'utilisation du service
Administrateur de l'organisation
Déplaceur de projets
Propriétaire
```

b) Dans Facturation, quel montant de crédit vous reste-t-il ?

```text
254,00 €
```

c) Dans APIs & Services → Tableau de bord, listez 3 APIs qui sont déjà activées par défaut :

```text
Cloud Storage API
Compute Engine API
Analytics Hub API
```

d)

```bash
gcloud services enable \
  compute.googleapis.com \
  run.googleapis.com \
  container.googleapis.com \
  iam.googleapis.com \
  storage.googleapis.com

gcloud services list --enabled
```

## Partie 3 - Cloud Storage

### 3.1 - Creer un bucket

```bash
gcloud storage buckets create gs://ynov-tp1-raphael-20032026 \
  --location=europe-west9 \
  --default-storage-class=STANDARD

gcloud storage buckets list
```

![alt text](<readme/Screenshot 2026-03-20 at 12.46.50.png>)

**Pourquoi unique ?** Parce que les buckets sont globaux (namespace partagés mondialement).

### 3.2 - Upload / Download

```bash
gcloud storage cp test_tp1.txt gs://ynov-tp1-raphael-20032026/
cat test_tp1_downloaded.txt
```

### 3.3 — Métadonnées et permissions

![alt text](<readme/Screenshot 2026-03-20 at 14.28.36.png>)

Quel est le storageClass de votre bucket ?

```text
STANDARD
```

### 3.4 - Suppression du  cp test

```bash
gcloud storage rm -r gs://ynov-tp1-raphael-20032026
```

## Partie 4 - Compute Engine

### 4.1 - Creer une VM

```bash
gcloud compute instances create tp1-vm \
  --machine-type=e2-micro \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --zone=europe-west9-b \
  --tags=http-server

gcloud compute instances list
```

![alt text](<readme/Screenshot 2026-03-20 at 16.09.04.png>)

**Difference machine-type :**
- e2-micro : gratuit / faible puissance
- n2-standard-4 : performant / couteux

### 4.2 - Connexion SSH

```bash
gcloud compute ssh tp1-vm --zone=europe-west9-b
```

### 4.3 - Suppression VM

```bash
gcloud compute instances delete tp1-vm \
  --zone=europe-west9-b \
  --quiet
```

## Partie 5 - Flask + Docker

**Pourquoi copier requirements.txt avant ?** Pour optimiser le cache Docker et eviter de reinstaller les dependances a chaque build.


### Build & Run

```bash
docker build -t tp1-flask:v1 .

docker images | grep tp1-flask

docker run -d \
  -p 8080:8080 \
  --name tp1-container \
  -e APP_ENV=development \
  tp1-flask:v1

docker ps
curl http://localhost:8080/
curl http://localhost:8080/health
```

**Difference image / conteneur :**
- Image : template immuable
- Conteneur : instance en cours d'execution

### 5.5 Nettoyage

```bash
docker stop tp1-container
docker rm tp1-container
```

## Partie 6 - IAM

### 6.1 - Differences de roles

- storage.admin : acces total
- storage.objectViewer : lecture seule

### 6.2 - Lister les service accounts

```bash
gcloud iam service-accounts list
```

### 6.3 - Role minimal

```bash
--role="roles/storage.objectViewer"
```

**Pourquoi pas owner/editor ?** Car cela viole le principe du moindre privilege et augmente les risques de securite.

### 6.4 - Alternative aux cles JSON

Workload Identity (authentification sans cle).

## Partie 7 - Docker Debug

### 7.2 - Variable APP_ENV

```bash
APP_ENV=debug
```

### 7.3 - Inspecter le conteneur

!!! ps ne fonctionne pas pareil pour wget
```bash
ps aux
/bin/sh: 1: ps: not found
wget -qO- http://localhost:8080/health
/bin/sh: 5: wget: not found
```

```bash
docker exec -it tp1-debug /bin/sh
docker exec tp1-debug env | grep APP_ENV
```

### 7.4 - RAM

RAM : 32.2MiB / 3.827GiB = 0.82%

```bash
docker logs --tail=20 tp1-debug
```

### 7.5 - Couche la plus lourde

**Question :** quelle couche est la plus volumineuse et pourquoi ?
Installation des dependances Python (pip install). Cela telecharge les packages et leurs dependances, ce qui peut etre volumineux.


## Préparation TP2

![alt text](<readme/Préparation Cours 2.png>)