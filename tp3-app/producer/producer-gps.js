const { Kafka, Partitioners } = require('kafkajs');

// Configuration du client Kafka
const kafka = new Kafka({
  clientId: 'logistream-gps-producer',
  brokers: [process.env.KAFKA_BOOTSTRAP_SERVERS || 'localhost:9092'],
  // Retry automatique avec backoff exponentiel
  retry: {
    initialRetryTime: 100,
    retries: 8,
  },
});

const producer = kafka.producer({
  createPartitioner: Partitioners.LegacyPartitioner,
});

// Simuler la flotte de camions LogiStream
const TRUCKS = [
  { id: 'TRK-001', driver: 'Martin Dupont', route: 'Paris-Lyon' },
  { id: 'TRK-002', driver: 'Sophie Laurent', route: 'Lyon-Marseille' },
  { id: 'TRK-003', driver: 'Jean Moreau', route: 'Bordeaux-Paris' },
];

function generateGPSPosition(truck) {
  // Simuler un mouvement progressif sur la route
  const basePositions = {
    'Paris-Lyon': { lat: 48.8566, lng: 2.3522 },
    'Lyon-Marseille': { lat: 45.7640, lng: 4.8357 },
    'Bordeaux-Paris': { lat: 44.8378, lng: -0.5792 },
  };
  const base = basePositions[truck.route];
  return {
    truck_id: truck.id,
    driver: truck.driver,
    route: truck.route,
    // Variation aléatoire ±0.1 degré pour simuler le mouvement
    latitude: base.lat + (Math.random() - 0.5) * 0.1,
    longitude: base.lng + (Math.random() - 0.5) * 0.1,
    speed_kmh: Math.floor(Math.random() * 40) + 70, // 70-110 km/h
    fuel_level: Math.floor(Math.random() * 60) + 20, // 20-80%
    timestamp: new Date().toISOString(),
    event_type: 'GPS_UPDATE',
  };
}

async function startProducing() {
  await producer.connect();
  console.log('Producer Kafka connecté — début de l\'envoi des positions GPS');
  let messageCount = 0;

  // Envoyer une position GPS pour chaque camion toutes les 10 secondes
  setInterval(async () => {
    const messages = TRUCKS.map(truck => {
      const position = generateGPSPosition(truck);
      return {
        // La clé de partition = truck_id : toutes les positions d'un camion
        // vont dans la même partition → ordre garanti par camion
        key: truck.id,
        value: JSON.stringify(position),
        headers: {
          'event-type': 'gps-position',
          'source': 'mobile-app',
        },
      };
    });

    try {
      await producer.send({
        topic: 'truck-positions',
        messages: messages,
      });
      messageCount += messages.length;
      console.log(`[${new Date().toISOString()}] ${messages.length} positions envoyées (total: ${messageCount})`);
    } catch (err) {
      console.error('Erreur d\'envoi Kafka :', err.message);
    }
  }, 10000); // Toutes les 10 secondes

  // Envoyer une alerte simulée toutes les 30 secondes
  setInterval(async () => {
    const truck = TRUCKS[Math.floor(Math.random() * TRUCKS.length)];
    const alert = {
      truck_id: truck.id,
      alert_type: 'DELIVERY_DELAY',
      severity: 'WARNING',
      message: `Camion ${truck.id} en retard de 15 minutes sur la route ${truck.route}`,
      estimated_delay_minutes: Math.floor(Math.random() * 30) + 5,
      timestamp: new Date().toISOString(),
    };
    await producer.send({
      topic: 'delivery-alerts',
      messages: [{ key: truck.id, value: JSON.stringify(alert) }],
    });
    console.log(`[ALERTE] ${alert.message}`);
  }, 30000);
}

// Gestion propre de l'arrêt (SIGTERM pour Kubernetes)
process.on('SIGTERM', async () => {
  console.log('SIGTERM reçu — arrêt propre du producer');
  await producer.disconnect();
  process.exit(0);
});

startProducing().catch(err => {
  console.error('Erreur fatale :', err);
  process.exit(1);
});