# FraudGuard — TP5 (Kafka Streams, Airflow Avancé & Observabilité)

Pipeline de détection de fraude temps réel pour la néobanque FraudGuard (Meridian Group).

## Architecture

```
[Transaction Producer]   (Node.js / kafkajs)
        │
        ▼
   ┌──────────────────┐
   │ Kafka (Strimzi)  │   topics : transactions-raw, fraud-alerts, transaction-aggregates
   └──────────────────┘
        │
        ▼
[Fraud Detector — Kafka Streams Node.js]
   ├─ Tumbling Window 5 min par compte
   ├─ Pattern 1 : > 10 micro-tx (<2€) en 5 min
   ├─ Pattern 2 : > 20 tx en 5 min (vélocité)
   └─ Pattern 3 : IP suspecte (bot)
        │
        ▼
   topic : fraud-alerts
        │
        ▼
[Alert Handler]
   ├─ CRITICAL → blocage compte (Firestore)
   ├─ HIGH     → notification Risk Manager + limitation
   └─ MEDIUM   → audit pour Airflow batch

[Airflow]
   ├─ DAG fraudguard_daily_report (07h00 UTC)
   │    ├─ Dynamic Task Mapping par type d'alerte
   │    ├─ Consolidation → BigQuery
   │    ├─ KubernetesPodOperator → réentraînement ML si FP > 10%
   │    └─ TriggerDagRunOperator → fraudguard_deep_investigation si jour anormal

[Observabilité]
   ├─ Prometheus (scrape Strimzi JMX)
   ├─ Grafana (dashboards Kafka + custom FraudGuard)
   └─ Alerting (Spike Detection, Detector Lag)
```

## Structure

```
tp5-app/
├── kafka/
│   ├── fraudguard-cluster.yaml      # Cluster Strimzi + topics + metrics
│   └── kafka-metrics.yaml           # PodMonitor Prometheus
├── fraud-detection/
│   ├── producer/                    # Simulateur transactions
│   ├── streams/                     # Moteur Kafka Streams
│   └── alert-service/               # Handler Firestore
├── k8s/
│   └── fraudguard-deployments.yaml  # Déploiements GKE
├── dags/
│   └── fraud_daily_report.py        # DAG Airflow avancé
└── README.md
```

## Commandes de déploiement

```bash
# Namespace
kubectl create namespace fraudguard

# Strimzi operator
kubectl apply -f https://strimzi.io/install/latest?namespace=kafka -n kafka
kubectl wait --for=condition=Ready pod -l name=strimzi-cluster-operator -n kafka --timeout=120s

# Cluster Kafka + topics
kubectl apply -f kafka/fraudguard-cluster.yaml
kubectl wait kafka/fraudguard-kafka --for=condition=Ready --timeout=300s -n fraudguard

# Build & push images
PROJECT_ID=$(gcloud config get-value project)
for service in producer streams alert-service; do
  docker build -t europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry/fraudguard-${service}:v1 fraud-detection/${service}/
  docker push europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry/fraudguard-${service}:v1
done

# Déploiements (remplacer [PROJECT_ID] dans le yaml au préalable)
sed -i.bak "s/\[PROJECT_ID\]/${PROJECT_ID}/g" k8s/fraudguard-deployments.yaml
kubectl apply -f k8s/fraudguard-deployments.yaml

# Monitoring stack
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --set grafana.adminPassword="FraudGuard2026!" \
  --set grafana.service.type=LoadBalancer --timeout 10m

# Metrics Kafka
kubectl apply -f kafka/kafka-metrics.yaml

# DAG Airflow : copier dans le bucket DAGs Airflow
# kubectl cp dags/fraud_daily_report.py airflow/<scheduler-pod>:/opt/airflow/dags/
```

## Patterns de fraude détectés

| Pattern | Seuil | Sévérité | Action |
|---------|-------|----------|--------|
| MICRO_TRANSACTION_PATTERN | > 10 tx < 2€ / 5 min | HIGH | Limit + notify |
| HIGH_VELOCITY | > 20 tx / 5 min | CRITICAL | Block account |
| SUSPICIOUS_IP | IP blacklist | MEDIUM | Audit batch |
