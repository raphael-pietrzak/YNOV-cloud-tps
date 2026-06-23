# TP 6 — Réponses — FraudGuard

Dépôt GitOps : `tp6-app/fraudguard-gitops/`
Rapport Chaos : `tp6-app/fraudguard-gitops/CHAOS_REPORT.md`
Runbook DR : `tp6-app/fraudguard-gitops/RUNBOOK_DR.md`

---

## Partie 1 — ArgoCD

### 1.1 Installation

- `type: LoadBalancer` pour le patch du service `argocd-server`.

### 1.3 Root Application

- `path: apps`
- `prune: true`
- `selfHeal: true`
- Sync wave du `fraud-detector` : `"2"`.

**Question — sync waves Kafka (0) vs fraud-detector (2)**

Le `fraud-detector` est un consumer Kafka. Il a besoin que les brokers soient prêts, que les topics existent et que les CRDs Strimzi soient déjà installés. Les sync waves imposent cet ordre : wave 0 pour la plateforme (Strimzi, Prometheus Operator, Rollouts CRDs), wave 1 pour ce qui dépend des CRDs (KafkaTopic, ServiceMonitor), wave 2 pour le métier.

Sans sync wave, ArgoCD applique tout en parallèle. On obtient des erreurs `no matches for kind` sur les ressources qui référencent un CRD pas encore créé, et les pods métier partent en `CrashLoopBackOff` parce que Kafka n'est pas joignable. Tout finit par se stabiliser, mais avec 2–3 minutes de bruit d'alertes inutile.

### 1.4 Self-Heal

| Action | Avant | Après 3 min | Self-Heal ? |
|---|---|---|---|
| `kubectl scale --replicas=0` | 1 | 1 | Oui (drift sur `.spec.replicas`) |
| `kubectl delete pod fraud-detector-xxx` | 1 pod | 1 nouveau pod | Non — c'est le ReplicaSet qui recrée le pod, pas ArgoCD. Pas de drift sur le manifeste. |
| `kubectl edit configmap kafka-config` | valeur initiale | valeur initiale | Oui (drift sur `.data`) |

### 1.5 Rollout Canary

- `setWeight: 20` puis `40`
- `failureLimit: 3`

**Question — Canary vs Blue-Green**

En Canary, on déplace progressivement un pourcentage croissant de trafic vers la nouvelle version (20 → 40 → 80 → 100 %). Les deux versions cohabitent, ce qui permet d'observer la régression sous charge réelle avec un blast radius limité au % shifté.

En Blue-Green, on déploie la nouvelle version à 100 % en parallèle et on bascule tout le trafic d'un coup en changeant le selector du service. Aucun trafic mixte, donc pas de problème de compatibilité de schéma, et rollback instantané.

FraudGuard devrait préférer Blue-Green quand la v2 contient une migration de schéma incompatible avec la v1 (nouvelle structure de message Kafka, breaking change du state store), ou quand le service partage un consumer group : 20 % de pods v2 dans le même groupe que 80 % v1 produit des comportements indéfinis si la sérialisation diffère. Sinon, Canary reste l'option par défaut.

---

## Partie 2 — Observabilité

### 2.3 Tracing

- URL Tempo OTLP gRPC : `http://tempo.monitoring.svc.cluster.local:4317`
- `span.setAttribute('sampling.priority', 1)` pour forcer la capture du span côté agent.

### 2.2 LogQL

- `{namespace="fraudguard", app="fraud-detector"}`

**Question — cardinalité des labels Loki**

Loki construit un index inversé sur le tuple de labels. Chaque combinaison unique crée un stream physique avec ses propres chunks. Mettre `user_id` ou `request_id` en label crée autant de streams que de valeurs distinctes, ce qui fait exploser la mémoire de l'ingester, ralentit les requêtes et alourdit le coût de stockage (overhead fixe par chunk).

Pour rechercher par Request ID malgré tout, on laisse le champ dans le contenu du log (JSON) et on filtre au scan :

```logql
{namespace="fraudguard", app="fraud-detector"} | json | request_id="abc-123"
```

C'est plus lent qu'une recherche indexée, mais ça reste sous contrôle car le filtre s'applique après la sélection initiale par labels.

**Question — span Kafka 850 ms**

Plusieurs pistes à creuser : pression GC ou disque saturé sur le broker (vérifier les métriques JVM et I/O), nombre de partitions du topic trop faible créant de la contention sur le leader, configuration `acks=all` avec un follower lent, ou une NetworkPolicy/expérience Chaos non nettoyée qui ajoute de la latence.

Dans Grafana, la fonctionnalité Trace-to-Logs (configurée dans la datasource Tempo) permet de cliquer sur le span et d'ouvrir directement Loki filtré sur le `trace_id` et la fenêtre temporelle correspondante, sur le namespace `kafka`. On voit immédiatement les logs broker au moment exact de la lenteur.

### 2.4 SLO

| Service | SLI | SLO | SLA | Error Budget mensuel |
|---|---|---|---|---|
| `tx-producer` | Taux publish OK | 99.95 % | 99.9 % | 21,6 min |
| `fraud-detector` | Latence P99 | < 500 ms | < 1000 ms | 21,6 min |
| `alert-handler` | CRITICAL traités < 5 s | 99.9 % | 99.5 % | 43,2 min |
| Système global | Disponibilité E2E | 99.95 % | 99.9 % | 21,6 min |

Formule : `Error Budget = (1 − SLO) × 30 × 24 × 60`. 99.95 % → 21,6 min, 99.9 % → 43,2 min.

Dans la Recording Rule : `(1 - 0.995)` pour le SLO fraud-detector.

**Question — Error Budget à 5 %**

La décision SRE est un feature freeze immédiat sur le service. Plus aucun déploiement de nouvelle feature, uniquement des bug fixes et du hardening, jusqu'à reconstitution du budget au mois suivant. On lance en parallèle les post-mortems des incidents responsables, avec action items priorisés, et l'équipe se concentre sur la fiabilité (tests de résilience, automatisation des rollbacks).

Pour les Product Managers, l'impact est direct : la roadmap est arbitrée par le budget d'erreur, pas par les wishes business. Le PM doit re-prioriser le sprint en repoussant les nouvelles features et accepter du temps ingénierie dédié à la stabilisation. C'est exactement le mécanisme qui aligne les incentives Dev (vélocité) et Ops (fiabilité) : violer le SLO coûte plus cher que de ralentir.

---

## Partie 3 — Chaos Engineering

- PodChaos : `action: pod-kill`
- NetworkChaos : `action: delay`, `latency: '200ms'`
- HPA : `averageUtilization: 70`

**Question — `mode: one` et `duration` limitée**

Sans `mode: one`, l'expérience touche tous les pods correspondant au selector en même temps. Un `pod-kill` sur 4 réplicas sur 4 = panne totale, SLO violé, perte commerciale. Sans `duration`, l'expérience tourne indéfiniment, ce qui peut masquer un incident réel survenant en parallèle ou prolonger la dégradation au-delà de la fenêtre de maintenance.

Deux sécurités supplémentaires avant un Game Day en production :

1. Un kill switch automatique : un `AbortWorkflow` Chaos Mesh déclenché par une alerte Prometheus si la disponibilité tombe sous un seuil (ex. 99 % sur 1 min), via un webhook AlertManager → Chaos Mesh API.
2. Un blast radius volumétrique et temporel : fenêtre horaire de faible trafic (3 h–5 h du matin), une seule AZ ciblée (`topology.kubernetes.io/zone=europe-west9-a`), et un pourcentage maximum de réplicas affectés (`mode: fixed-percent`, `value: "25"`). En complément, un communication plan (Slack, status page) pour trier rapidement toute alerte non liée au chaos.

Idéalement aussi, un runbook de rollback validé et un dry-run en staging strictement identique 24 h avant.

---

## Partie 4 — Multi-cloud DR

### 4.1 Mapping GCP → AWS

| Service GCP | Équivalent AWS | Synchronisation |
|---|---|---|
| GKE | EKS | Manifestes identiques via GitOps |
| Cloud Storage | S3 | Storage Transfer Service (ou `gsutil rsync`) |
| Firestore | DynamoDB | CDC via Datastream → Kinesis |
| Artifact Registry | ECR | `skopeo sync` en cron |
| Cloud DNS | Route 53 | Failover record (TTL 60 s) |
| Cloud Load Balancing | Global Accelerator (ou ALB + Route 53) | Health check |

### 4.2 Terraform

- `count = var.cloud_provider == "aws" ? 1 : 0`

**Question — Cold standby vs Warm standby**

En cold standby, il faut recréer le cluster depuis Terraform. Compter 12–15 min pour le control plane EKS, 5–8 min pour les node groups, et 15–25 min pour le bootstrap ArgoCD + premier sync de toute la stack. RTO réaliste : 45–60 min, contre 15 min en warm standby. L'objectif RTO < 15 min n'est plus tenable.

L'économie de 450 €/mois n'est pas pertinente pour FraudGuard. 5 400 €/an d'économie face à 125 000 € de pénalité SLA pour un seul incident dépassant 15 min (cf. INC-051), la valeur attendue de la pénalité dépasse largement le gain. Et FraudGuard est un service temps réel : 45 min de DR représentent environ 157 500 transactions non analysées, soit une fenêtre exploitable par les fraudeurs qui adaptent leurs attaques aux incidents connus.

On garde donc le warm standby. Une optimisation possible : passer les 3 nodes en `t3.medium` au lieu de `t3.large` en régime nominal (économie d'environ 40 %) et scaler verticalement au moment du failover avec `eksctl scale nodegroup`.

---

## Livrables

- `tp6-app/fraudguard-gitops/bootstrap/root-app.yaml`
- `tp6-app/fraudguard-gitops/apps/**` — Applications ArgoCD
- `tp6-app/fraudguard-gitops/manifests/**` — Kafka, monitoring, Rollouts, métier
- `tp6-app/fraudguard-gitops/chaos/experiments/` — 3 expériences Chaos Mesh
- `tp6-app/fraudguard-gitops/terraform/` — module multi-cloud + env DR AWS
- `tp6-app/fraudguard-gitops/CHAOS_REPORT.md`
- `tp6-app/fraudguard-gitops/RUNBOOK_DR.md`
- `tp6-app/fraudguard-gitops/README.md`
