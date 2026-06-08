# TP 4 — Réponses — FinSecure

## Partie 1 — DevSecOps

### 1.1 — Secret Manager

- `--replication-policy=automatic` (secret Stripe)
- `--secret="finsecure-db-password"`

**Question 1.1 — Deux autres solutions GCP pour des configs sensibles dans Kubernetes :**

1. **Kubernetes Secrets natifs (chiffrés par envelope encryption via Cloud KMS sur GKE)** — adapté pour des secrets éphémères ou non critiques, lus directement par les pods sans appel API externe. Plus simple, mais pas de rotation native ni d'audit fin par accès.
2. **Config Connector / External Secrets Operator + Secret Manager** — synchronise automatiquement les secrets de Secret Manager vers des `Secret` Kubernetes. Idéal en hybride : ergonomie native K8s + source de vérité GCP avec audit/rotation. Utiliser Secret Manager + Workload Identity en direct quand on veut zéro persistance du secret dans etcd ; les Secrets natifs si on a besoin de mounts standards sans dépendance externe.

---

### 1.2 — Workload Identity Federation

- `--role="roles/container.developer"`
- `service_account: "finsecure-github-sa@${{ secrets.GCP_PROJECT_ID }}.iam.gserviceaccount.com"`

**Question 1.2 — WIF vs clé JSON :**

WIF échange un token OIDC GitHub (durée ~1h, signé par GitHub, lié au repo + workflow + branche) contre un token GCP court-terme. **Risques éliminés :**
- Plus de clé JSON longue durée à stocker dans GitHub Secrets → impossible de fuiter une clé permanente via un fork malveillant, un commit accidentel, ou un employé qui quitte la boîte.
- L'identité est attestée par GitHub (audience + sub vérifiables) → seul le repo `FinSecure/...` peut s'authentifier, pas n'importe qui possédant la clé.
- Audit GCP corrélable au workflow run GitHub.

---

### 1.3 — Scan Trivy

- `needs: build-push`
- `--exit-code 1`
- `--severity "CRITICAL,HIGH"`

**Question 1.3 — Pourquoi scanner après build / avant déploiement :**

Le scan est un **quality gate** : si une CVE critique est trouvée, le pipeline échoue et l'image n'arrive jamais en prod. Placé après le déploiement, l'image vulnérable serait déjà exposée au trafic réel (clients de FinSecure, donc paiements PCI/DSP2) — le scan ne servirait qu'à constater l'incident a posteriori, pas à le prévenir. C'est le principe **shift-left** de DevSecOps.

---

### 1.4 — Workload Identity GKE

- `--role="roles/iam.workloadIdentityUser"`
- `--role="roles/secretmanager.secretAccessor"`
- `serviceAccountName: finsecure-app-ksa`
- `readOnly: true`

---

## Partie 2 — Serverless Event-Driven

### 2.1 — Pub/Sub

- `--dead-letter-topic=finsecure-payment-dead-letter`

**Question 2.1 — Push vs Pull :**

- **Pull** : le consommateur récupère lui-même les messages (gcloud, SDK, GKE worker). Contrôle fin du débit, idéal pour un traitement batch / un worker GKE qui régule sa concurrence. Utiliser pour la **réconciliation batch** côté FinSecure.
- **Push** : Pub/Sub POST le message vers un endpoint HTTPS (Cloud Function, Cloud Run). Pas de pod permanent à payer, scaling automatique. Utiliser pour le **traitement temps réel des webhooks de paiement** (Cloud Function `processPayment`).

---

### 2.2 — Cloud Function

- `Buffer.from(message.data, 'base64').toString()`
- `if (!transaction[field])`
- `--trigger-topic=finsecure-payment-events`

---

### 2.3 — Test event-driven

**Question 2.3 — Pourquoi ne pas throw sur JSON invalide :**

Pub/Sub considère qu'une exception (ou un code HTTP ≥ 500) = échec → retry automatique avec backoff exponentiel, et après `max-delivery-attempts` (5), le message part en Dead Letter Topic. Pour un **payload corrompu non parsable**, le retry est inutile (le message ne deviendra jamais valide) et coûteux (invocations facturées, latence sur les bons messages). On **log + return** = ACK silencieux, et idéalement on publie séparément vers un topic `invalid-messages` pour audit.

---

### 2.4 — Cloud Scheduler

- `--schedule="0 23 * * *"`
- `--time-zone="Europe/Paris"`

---

## Partie 3 — FinOps

### 3.1 — Labels

- `environment=production`

**Question 3.1 — Chargeback par client :**

Ajouter un label `customer` (ou `tenant`) sur chaque ressource dédiée à un client : `customer=boutiquea`, `customer=marketplaceb`, `customer=ecommercec`. Pour les ressources **mutualisées** (cluster GKE partagé, Pub/Sub commun), ajouter un label `customer=shared` et répartir les coûts au prorata via une clé métier (nombre de transactions/client par mois) calculée depuis BigQuery billing export. Compléter avec `billing-mode=dedicated|shared` pour distinguer dans Looker Studio.

---

### 3.2 — Budget

**Question 3.2 — 90% du budget atteint le 20 du mois :**

**Quick wins (< 1 jour) :**
- Identifier le top 3 SKU en croissance via Billing Reports (groupé par service).
- Couper les environnements non-prod (staging/dev) le soir et le week-end (Cloud Scheduler stop/start).
- Réduire les `min-instances` des Cloud Functions/Cloud Run à 0.
- Supprimer les disques persistants orphelins, snapshots vieux, IPs statiques non attachées.
- Réduire la rétention des logs Cloud Logging (sink BigQuery + delete des logs verbeux).

**À planifier :**
- Activer les **Committed Use Discounts** sur les charges stables (GKE, Cloud SQL).
- Mettre en place un FinOps dashboard avec alertes par équipe (labels).
- Reviewer le rightsizing GKE (HPA, VPA, Autopilot).
- Mettre en cache (Memorystore) les requêtes SQL coûteuses (cf. Partie 4).
- Politique IAM `iam.disableServiceAccountKeyCreation` + quotas par projet.

---

### 3.4 — Committed Use Discounts

| Ressource | On-demand | CUD 1 an (-30/25%) |
|---|---|---|
| GKE Autopilot | 280€ | **196€** |
| Cloud SQL | 120€ | **90€** |
| **Total** | **400€** | **286€** |

**Question 3.4 — CUD 3 ans pour une startup en forte croissance :**

**Non recommandé en l'état.** Un CUD 3 ans engage à payer la capacité même si les besoins évoluent. Facteurs à analyser avant :
- **Stabilité de la baseline** : quelle part de la charge est *prévisible* sur 3 ans ? Réserver seulement le **socle minimum** (ex. 50% de l'usage actuel), payer à la demande le reste.
- **Trajectoire produit** : pivot probable ? Migration multicloud envisagée ? Acquisition possible (le CUD ne se transfère pas facilement) ?
- **Cash flow** : un CUD se prépaie partiellement → impact trésorerie pour une Série A.
- **Profil d'usage** : si la charge double en 18 mois, un CUD 1 an renouvelé est plus flexible.

**Recommandation FinSecure** : CUD **1 an** sur ~60% du baseline GKE + Cloud SQL → ~18% d'économies sans verrouiller la trajectoire.

---

## Partie 4 — Cache Redis

### 4.1 — Memorystore

- `--tier=BASIC` (pas de HA pour le TP)

### 4.2 — Cache-Aside

- `ttlSeconds = 3600`
- `await client.del(key)`
- `await invalidateCache('merchants:all')`
- `REDIS_HOST: value: "10.x.x.x"` (IP renvoyée par `gcloud redis instances describe`)

### 4.3 — Benchmark

| Métrique | Sans cache | Avec cache | Gain |
|---|---|---|---|
| Latence moyenne | ~210 ms | ~4 ms | **~52×** |
| Latence p99 | ~280 ms | ~12 ms | **~23×** |
| Requêtes/s | ~48 | ~2 100 | **~44×** |

(Valeurs typiques observées avec `hey -n 100 -c 10` sur GKE europe-west9 + Memorystore BASIC 1 GB. À remplacer par les valeurs réellement mesurées.)

**Question 4.3 — Nouveau marchand "BoutiqueD" avec TTL 1h :**

Sans invalidation explicite, il faudra **jusqu'à 1 heure** avant que `BoutiqueD` apparaisse (au prochain expire du TTL et cache miss).

**Stratégie d'invalidation recommandée — Write-Through / Cache Invalidation à l'écriture :**
- Sur chaque `POST /merchants` (et `PUT`, `DELETE`), appeler `invalidateCache('merchants:all')` (déjà câblé).
- Pour un système distribué, publier un message Pub/Sub `merchant.updated` consommé par toutes les instances qui invalident leur cache local + Redis.
- Alternative : keys versionnées (`merchants:all:v{n}`) où `n` est incrémenté à chaque écriture → pas besoin de DEL, garbage collection naturel par TTL.

Le TTL reste un filet de sécurité (cohérence éventuelle si l'invalidation échoue) mais ne doit pas être le mécanisme principal de cohérence pour des données mutables.
