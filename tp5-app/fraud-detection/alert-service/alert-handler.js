/**
 * FraudGuard Alert Handler
 * Consomme les alertes Kafka et déclenche les actions :
 * - Bloquer le compte (sévérité CRITICAL)
 * - Notifier le Risk Manager (sévérité HIGH)
 * - Enregistrer pour audit (toutes les alertes)
 */
const { Kafka } = require('kafkajs');
const { Firestore } = require('@google-cloud/firestore');

const kafka = new Kafka({
  clientId: 'fraudguard-alert-handler',
  brokers: [process.env.KAFKA_BOOTSTRAP_SERVERS || 'localhost:9092'],
});

const consumer = kafka.consumer({ groupId: 'alert-handler-group' });
const db = new Firestore({ projectId: process.env.GCP_PROJECT });

async function processAlert(alert) {
  console.log(`[ALERT HANDLER] Traitement : ${alert.alert_type} — ${alert.account_id}`);

  await db.collection('fraud_alerts').doc(alert.alert_id).set({
    ...alert,
    processed_at: Firestore.Timestamp.now(),
    status: 'PENDING_REVIEW',
  });

  if (alert.severity === 'CRITICAL') {
    await blockAccount(alert.account_id, alert.alert_id);
    await notifyRiskManager(alert, 'URGENT: Compte bloqué automatiquement');

  } else if (alert.severity === 'HIGH') {
    await notifyRiskManager(alert, 'Action requise : pattern de fraude détecté');
    await limitAccountTransactions(alert.account_id, 50);

  } else if (alert.severity === 'MEDIUM') {
    console.log(`[AUDIT] Alerte MEDIUM enregistrée pour revue Airflow quotidienne`);
  }
}

async function blockAccount(accountId, alertId) {
  console.log(`[ACTION] BLOCAGE du compte ${accountId} — Alerte ${alertId}`);
  await db.collection('blocked_accounts').doc(accountId).set({
    blocked_at: Firestore.Timestamp.now(),
    reason: alertId,
    status: 'BLOCKED',
  });
}

async function limitAccountTransactions(accountId, maxAmount) {
  console.log(`[ACTION] Limitation du compte ${accountId} à ${maxAmount}€/transaction`);
}

async function notifyRiskManager(alert, message) {
  console.log(`[NOTIFICATION] Risk Manager : ${message}`);
  console.log(`  Compte: ${alert.account_id} | Type: ${alert.alert_type}`);
}

async function startAlertHandling() {
  await consumer.connect();
  await consumer.subscribe({ topics: ['fraud-alerts'], fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      const alert = JSON.parse(message.value.toString());
      await processAlert(alert);
    },
  });
}

process.on('SIGTERM', async () => { await consumer.disconnect(); process.exit(0); });
startAlertHandling().catch(console.error);
