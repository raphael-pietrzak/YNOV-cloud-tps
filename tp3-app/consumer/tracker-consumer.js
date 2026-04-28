const { Kafka } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'logistream-tracker-consumer',
  brokers: [process.env.KAFKA_BOOTSTRAP_SERVERS || 'localhost:9092'],
});

// Consumer Group : si plusieurs instances du tracker-service tournent,
// Kafka distribue les partitions entre elles automatiquement
const consumer = kafka.consumer({
  groupId: 'tracker-service-group',
});

// Simulation du stockage en base de données
const truckPositions = new Map();

async function startConsuming() {
  await consumer.connect();
  console.log('Consumer Kafka connecté');

  // S'abonner aux topics pertinents
  await consumer.subscribe({
    topics: ['truck-positions', 'delivery-alerts'],
    fromBeginning: false, // Partir du dernier offset (pas de relecture historique)
  });

  await consumer.run({
    // Nombre de messages traités en parallèle par partition
    partitionsConsumedConcurrently: 3,
    eachMessage: async ({ topic, partition, message }) => {
      const key = message.key?.toString();
      const value = JSON.parse(message.value.toString());
      const offset = message.offset;

      if (topic === 'truck-positions') {
        // Mettre à jour la position du camion en mémoire (et en DB en prod)
        truckPositions.set(key, {
          ...value,
          last_seen: new Date().toISOString(),
          processed_at: Date.now(),
        });

        console.log(`[POSITION] ${value.truck_id} | ${value.latitude.toFixed(4)},${value.longitude.toFixed(4)} | ${value.speed_kmh} km/h | Partition ${partition} | Offset ${offset}`);

        // Détecter les camions à l'arrêt (vitesse < 5 km/h depuis plus de 30 min)
        if (value.speed_kmh < 5) {
          await publishAlert(value.truck_id, 'TRUCK_STOPPED', value);
        }

        // Détecter le carburant bas (< 20%)
        if (value.fuel_level < 20) {
          await publishAlert(value.truck_id, 'LOW_FUEL', value);
        }

      } else if (topic === 'delivery-alerts') {
        // Traiter les alertes : notifier les dispatchers
        console.log(`[ALERTE] ${value.alert_type} | ${value.truck_id} | ${value.message}`);
        // En production : envoyer un email/SMS au dispatcher
        await notifyDispatcher(value);
      }
    },
  });
}

async function publishAlert(truckId, alertType, context) {
  // En production : produire vers le topic delivery-alerts
  console.log(`[DÉTECTION] ${alertType} pour ${truckId}`);
}

async function notifyDispatcher(alert) {
  // En production : appel à l'API de notification (email/SMS)
  console.log(`[NOTIFICATION] Dispatcher alerté : ${alert.alert_type}`);
}

// Arrêt propre : commit des offsets avant de quitter
process.on('SIGTERM', async () => {
  console.log('SIGTERM reçu — commit des offsets en cours');
  await consumer.disconnect();
  process.exit(0);
});

startConsuming().catch(err => {
  console.error('Erreur consumer :', err);
  process.exit(1);
});