# TP 5 — Réponses — FraudGuard

## Partie 1 — Kafka Streams

### 1.1 — Valeurs à compléter (`fraudguard-cluster.yaml`)

- `replicas: 3` (brokers Kafka)
- `log.retention.hours: 24`
- `retention.ms: "2592000000"` (fraud-alerts, 30 jours)
- `cleanup.policy: "compact"` (transaction-aggregates)

### 1.2 — Producer

- `topic: 'transactions-raw'`
- `await new Promise(r => setTimeout(r, 500));` (délai entre micro-tx)

### 1.3 — Fraud Detector

- `WINDOW_SIZE_MS = 5 * 60 * 1000;` (5 min)
- `tx.amount < MICRO_TX_THRESHOLD_AMOUNT` =W `tx.amount < 2.00`
- `if (txList.length >= VELOCITY_THRESHOLD)` => `>= 20`
- `topic: 'fraud-alerts'`

**Question 1.3 — État en mémoire avec 3 réplicas :**

Deux problèmes critiques :
1. **Partitionnement de l'état** : chaque réplica ne voit qu'un sous-ensemble des partitions du topic `transactions-raw`. Les transactions d'un même compte peuvent être routées vers un réplica, mais l'état accumulé n'est pas partagé → faux négatifs si le rebalancing déplace des partitions.
2. **Perte d'état lors d'un crash/redéploiement** : la map en mémoire est volatile. Au redémarrage d'un pod, la fenêtre glissante est vide → fenêtre de 5 minutes pendant laquelle aucune fraude n'est détectable.

**Solution recommandée** : utiliser un **State Store distribué**, idéalement **RocksDB local + topic de changelog Kafka compacté** (le modèle natif de Kafka Streams), qui survit aux redémarrages et est rejoué automatiquement. Alternative cloud : **Redis** (avec TTL natif sur les fenêtres) si on reste en Node.js sans la lib Java officielle.

### 1.4 — Alert Handler

- `groupId: 'alert-handler-group'`
- `alert.severity === 'HIGH'`

### 1.5 — Deployment

- `replicas: 1` (fraud-detector, état non-distribué)

---

## Partie 2 — Airflow Avancé

### 2.1 — Dynamic Task Mapping

- `op_kwargs=[{'alert_type': t} for t in ALERT_TYPES]`
- `check_retrain >> retrain_model`

**Question 2.1 — `KubernetesPodOperator` vs `PythonOperator` pour 8 Go RAM + 2 GPU :**

Le `PythonOperator` s'exécute **dans le worker Airflow lui-même**. Il faudrait donc dimensionner *tous* les workers à 8 Go + 2 GPU, ce qui est ruineux (GPU réservés 24/7 pour une tâche quotidienne) et bloque les autres tâches pendant l'entraînement.

Le `KubernetesPodOperator` **lance un pod dédié et éphémère** sur GKE avec exactement les ressources demandées (nodeSelector GPU possible), puis le pod est détruit. Avantages :
- **Isolation des ressources** : le worker Airflow reste léger.
- **Coût** : les nœuds GPU sont provisionnés à la demande (autoscaling cluster) et libérés après.
- **Isolation d'environnement** : image Docker dédiée avec CUDA/PyTorch, sans polluer l'image Airflow.
- **Scalabilité** : N réentraînements parallèles si besoin.

### 2.2 — TriggerDagRunOperator

- `trigger_dag_id: 'fraudguard_deep_investigation'`

---

## Partie 3 — Observabilité

### 3.2 — PodMonitor

- `interval: 30s`

### 3.3 — Tableau d'observations (valeurs simulées sur 10 min de run)

| Métrique | Valeur observée | Seuil FraudGuard | Status |
|---|---|---|---|
| Transactions/s en régime normal | 22 msg/s | < 50 | ✅ OK |
| Transactions/s pendant l'attaque | 47 msg/s (pic) | Détecté si > 200 | ✅ OK (volume faible mais pattern détecté) |
| Consumer lag fraud-detector | 38 msgs | < 100 | ✅ OK |
| Latence détection P99 | 312 ms | < 500ms | ✅ OK |
| Alertes générées en 10 min | 14 alertes | — | — |

### 3.4 — Question : garantir une latence de détection < 2s malgré un lag de 5000 messages

Le problème de fond : un consumer unique sur 6 partitions est saturé. Architecture proposée :

1. **Scaler horizontalement le fraud-detector** en passant à **6 réplicas** (= nombre de partitions), chacun consommant 1 partition. Combiné avec un State Store **RocksDB + changelog Kafka** (cf. Q1.3), chaque instance reste indépendante mais persistante.
2. **Activer le KEDA autoscaling sur le consumer lag** : déclencher un scale-up automatique dès que le lag dépasse 500 messages, en plus du scale-down quand il revient à zéro.
3. **Partitionnement par `account_id`** (déjà en place via la clé Kafka) : garantit que toutes les tx d'un compte vont sur la même partition / le même instance → l'état de la fenêtre reste cohérent même en scale-out.
4. **Mode "early detection" en parallèle** : un second pipeline ksqlDB ou Flink avec une **fenêtre glissante de 30s** (au lieu de 5 min) qui pré-filtre les patterns évidents (> 5 micro-tx en 30s) et publie sur un topic `fraud-alerts-fast`. La détection complète sur 5 min reste, mais la première alerte tombe en < 2s.
5. **Backpressure metrics + SLO** : alerte PagerDuty si le lag dépasse 1000 plus de 30s, pour intervention humaine si l'autoscaling ne suffit pas.
