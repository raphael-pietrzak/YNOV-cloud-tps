require('./tracing'); // DOIT être le premier require

const { Kafka } = require('kafkajs');
const { trace } = require('@opentelemetry/api');

const tracer = trace.getTracer('fraud-detector', 'v2');

const kafka = new Kafka({
  clientId: 'fraud-detector',
  brokers: (process.env.KAFKA_BOOTSTRAP_SERVERS || 'localhost:9092').split(','),
});

const consumer = kafka.consumer({ groupId: 'fraud-detection-group' });
const producer = kafka.producer();

async function analyzeTransaction(transaction) {
  return await tracer.startActiveSpan('analyze_transaction', async (span) => {
    span.setAttributes({
      'fraud.account_id': transaction.account_id,
      'fraud.tx_amount': transaction.amount,
      'fraud.tx_type': transaction.tx_type,
    });

    try {
      const alerts = detectFraud(transaction);
      span.setAttribute('fraud.alerts_count', alerts.length);

      if (alerts.length > 0) {
        span.setAttribute('fraud.alert_severity', alerts[0].severity);
        span.setAttribute('sampling.priority', 1);
      }

      span.setStatus({ code: 1 });
      return alerts;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: 2, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

function detectFraud(tx) {
  const alerts = [];
  if (tx.amount > 10000) {
    alerts.push({ type: 'HIGH_AMOUNT', severity: 'CRITICAL' });
  }
  return alerts;
}

async function run() {
  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({ topic: 'transactions-raw', fromBeginning: false });

  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }) => {
      const tx = JSON.parse(message.value.toString());
      const alerts = await analyzeTransaction(tx);

      for (const alert of alerts) {
        await producer.send({
          topic: 'fraud-alerts',
          messages: [{ value: JSON.stringify({ ...alert, account_id: tx.account_id }) }],
        });
      }

      await consumer.commitOffsets([
        { topic, partition, offset: (parseInt(message.offset, 10) + 1).toString() },
      ]);
    },
  });
}

run().catch((err) => {
  console.error('[fraud-detector] fatal:', err);
  process.exit(1);
});
