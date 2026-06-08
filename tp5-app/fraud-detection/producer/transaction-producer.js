/**
 * FraudGuard Transaction Producer
 * Simule le flux de transactions de la néobanque Meridian.
 * Inclut des transactions légitimes ET des patterns frauduleux.
 */
const { Kafka, Partitioners } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'fraudguard-tx-producer',
  brokers: [process.env.KAFKA_BOOTSTRAP_SERVERS || 'localhost:9092'],
});

const producer = kafka.producer({
  createPartitioner: Partitioners.LegacyPartitioner,
});

const LEGITIMATE_ACCOUNTS = [
  { id: 'ACC-1001', name: 'Alice Martin', avg_tx: 85, daily_limit: 2000 },
  { id: 'ACC-1002', name: 'Bob Dupont', avg_tx: 120, daily_limit: 5000 },
  { id: 'ACC-1003', name: 'Claire Leroy', avg_tx: 45, daily_limit: 1500 },
  { id: 'ACC-1004', name: 'David Moreau', avg_tx: 200, daily_limit: 10000 },
];

const FRAUD_ACCOUNT = { id: 'ACC-9999', name: 'Compte Mule', avg_tx: 0.50 };

let txCounter = 0;

function generateTransaction(account, isFraud = false) {
  txCounter++;
  const amount = isFraud
    ? 0.50 + Math.random() * 0.50
    : account.avg_tx * (0.5 + Math.random());

  return {
    tx_id: `TX-${Date.now()}-${txCounter.toString().padStart(6, '0')}`,
    account_id: account.id,
    account_name: account.name,
    amount: parseFloat(amount.toFixed(2)),
    currency: 'EUR',
    merchant: isFraud ? 'MERCHANT-MULE-001' : `MERCHANT-${Math.floor(Math.random() * 50) + 1}`,
    tx_type: isFraud ? 'TRANSFER' : (Math.random() > 0.3 ? 'PAYMENT' : 'WITHDRAWAL'),
    ip_address: isFraud ? '185.234.219.45' : `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
    device_fingerprint: isFraud ? 'BOT-FINGERPRINT-XYZ' : `DEVICE-${account.id}`,
    timestamp: new Date().toISOString(),
    is_fraud_simulation: isFraud,
  };
}

async function startProducing() {
  await producer.connect();
  console.log('[FraudGuard] Producer démarré — simulation du flux transactionnel');

  setInterval(async () => {
    const account = LEGITIMATE_ACCOUNTS[Math.floor(Math.random() * LEGITIMATE_ACCOUNTS.length)];
    const tx = generateTransaction(account, false);

    await producer.send({
      topic: 'transactions-raw',
      messages: [{
        key: tx.account_id,
        value: JSON.stringify(tx),
        headers: { 'tx-type': tx.tx_type },
      }],
    });
  }, 200);

  setInterval(async () => {
    console.log('[SIMULATION] Lancement d\'une attaque par micro-transactions...');
    for (let i = 0; i < 25; i++) {
      const tx = generateTransaction(FRAUD_ACCOUNT, true);
      await producer.send({
        topic: 'transactions-raw',
        messages: [{
          key: FRAUD_ACCOUNT.id,
          value: JSON.stringify(tx),
        }],
      });
      await new Promise(r => setTimeout(r, 500));
    }
    console.log('[SIMULATION] Attaque par micro-transactions terminée');
  }, 60000);
}

process.on('SIGTERM', async () => {
  await producer.disconnect();
  process.exit(0);
});

startProducing().catch(console.error);
