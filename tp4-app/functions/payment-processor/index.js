const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const secretClient = new SecretManagerServiceClient();

/**
 * FinSecure Payment Processor
 * Cloud Function déclenchée par un message Pub/Sub à chaque transaction validée.
 */
exports.processPayment = async (message, context) => {
  const payload = message.data
    ? Buffer.from(message.data, 'base64').toString()
    : '{}';

  let transaction;
  try {
    transaction = JSON.parse(payload);
  } catch (err) {
    console.error('Payload JSON invalide :', payload);
    return;
  }

  console.log(`Traitement transaction : ${transaction.transaction_id}`);
  console.log(`Montant : ${transaction.amount} ${transaction.currency}`);
  console.log(`Marchand : ${transaction.merchant_id}`);

  const requiredFields = ['transaction_id', 'amount', 'currency', 'status', 'merchant_id'];
  for (const field of requiredFields) {
    if (!transaction[field]) {
      console.error(`Champ manquant : ${field}`);
      return;
    }
  }

  const projectId = process.env.GCP_PROJECT;
  const [version] = await secretClient.accessSecretVersion({
    name: `projects/${projectId}/secrets/finsecure-db-password/versions/latest`,
  });
  const dbPassword = version.payload.data.toString();
  console.log(`Connexion DB avec secret récupéré : ${dbPassword.substring(0, 4)}****`);

  await simulateDbWrite(transaction);

  console.log(JSON.stringify({
    severity: 'INFO',
    event_type: 'PAYMENT_PROCESSED',
    transaction_id: transaction.transaction_id,
    amount: transaction.amount,
    currency: transaction.currency,
    merchant_id: transaction.merchant_id,
    processed_at: new Date().toISOString(),
  }));
};

async function simulateDbWrite(transaction) {
  return new Promise(resolve => setTimeout(resolve, 50));
}
