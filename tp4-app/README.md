# FinSecure — TP4 (DevSecOps, Serverless & FinOps)

Fintech FinSecure : pipeline CI/CD sécurisé, architecture event-driven, gouvernance FinOps, cache Redis.

## Structure

```
tp4-app/
├── .github/workflows/deploy.yml      # CI/CD : WIF + Trivy + GKE deploy
├── functions/payment-processor/      # Cloud Function Pub/Sub
│   ├── index.js
│   └── package.json
├── k8s/deployment.yaml               # KSA + Workload Identity + initContainer secret
├── src/
│   ├── server.js                     # API Express avec endpoint /merchants
│   └── cache-service.js              # Pattern Cache-Aside Redis
├── package.json
├── Dockerfile
└── README.md
```

## Architecture event-driven

```
[Banque partenaire — Webhook]
        │
        ▼
[finsecure-payment-events] (Pub/Sub topic)
        │
        ├── Subscription push → [Cloud Function processPayment]
        │                              │
        │                              ├─ Secret Manager (DB password)
        │                              ├─ Cloud SQL (write)
        │                              └─ Cloud Logging (audit)
        │
        └── Dead Letter Topic ───→ [finsecure-payment-dead-letter]
                                   (après 5 tentatives)

[Cloud Scheduler]
   ├─ 0 23 * * *  → reconciliation quotidienne
   └─ 0 2 * * 0   → purge hebdomadaire
            │
            ▼
   [finsecure-scheduled-tasks] (Pub/Sub topic)
```

## Étapes principales

```bash
# 1. Secret Manager
gcloud services enable secretmanager.googleapis.com
echo -n "finsecure-db-password-prod-2026" | gcloud secrets create finsecure-db-password --data-file=- --replication-policy=automatic --labels=app=finsecure,env=production

# 2. Workload Identity Federation (voir TP4.md §1.2)
gcloud iam workload-identity-pools create github-pool --location=global
# ...puis configurer secrets GitHub : WIF_PROVIDER, GCP_PROJECT_ID

# 3. Scan Trivy intégré → cf. .github/workflows/deploy.yml

# 4. Pub/Sub + Cloud Function
gcloud pubsub topics create finsecure-payment-events
gcloud pubsub topics create finsecure-payment-dead-letter
cd functions/payment-processor && npm install
gcloud functions deploy finsecure-payment-processor \
  --gen2 --runtime=nodejs20 --region=europe-west9 \
  --source=. --entry-point=processPayment \
  --trigger-topic=finsecure-payment-events \
  --set-env-vars=GCP_PROJECT=$(gcloud config get-value project)

# 5. Cloud Scheduler
gcloud scheduler jobs create pubsub finsecure-daily-reconciliation \
  --location=europe-west9 --schedule="0 23 * * *" --time-zone="Europe/Paris" \
  --topic=finsecure-scheduled-tasks --message-body='{"task":"daily_reconciliation"}'

# 6. Budget FinOps
gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" \
  --display-name="FinSecure Budget Mensuel" --budget-amount=1500EUR \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0

# 7. Cache Redis (Memorystore)
gcloud redis instances create finsecure-cache --size=1 --region=europe-west9 \
  --network=projects/$(gcloud config get-value project)/global/networks/tp3-app-vpc \
  --tier=BASIC --redis-version=redis_7_0

# 8. Déployer l'app (CI/CD GitHub Actions sur push main)
```

## Patterns

| Pattern | Usage |
|---------|-------|
| Cache-Aside | `withCache(key, fetchFn, ttl)` dans `src/cache-service.js` |
| Workload Identity | KSA `finsecure-app-ksa` annoté → GSA → Secret Manager |
| Dead Letter Topic | `finsecure-payment-dead-letter` après 5 retries |
| Shift-left security | Scan Trivy bloque le déploiement si CVE CRITICAL/HIGH |
