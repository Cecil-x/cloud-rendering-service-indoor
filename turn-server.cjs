const Turn = require('node-turn');

const LISTENING_IP = process.env.TURN_LISTENING_IP || '0.0.0.0';
const RELAY_IP = process.env.TURN_RELAY_IP || process.env.TURN_HOST || '172.20.13.53';
const PORT = Number(process.env.TURN_PORT || 3478);
const MIN_PORT = Number(process.env.TURN_MIN_PORT || 49160);
const MAX_PORT = Number(process.env.TURN_MAX_PORT || 49200);
const USERNAME = process.env.TURN_USERNAME || 'cloudrender';
const PASSWORD = process.env.TURN_PASSWORD || 'CloudRender@123456';
const REALM = process.env.TURN_REALM || 'cloudrender';

const server = new Turn({
  listeningPort: PORT,
  listeningIps: [LISTENING_IP],
  relayIps: [RELAY_IP],
  minPort: MIN_PORT,
  maxPort: MAX_PORT,
  authMech: 'long-term',
  credentials: {
    [USERNAME]: PASSWORD
  },
  realm: REALM,
  debugLevel: process.env.TURN_DEBUG || 'INFO'
});

server.start();

console.log(`TURN server listening on ${LISTENING_IP}:${PORT}`);
console.log(`TURN relay IP: ${RELAY_IP}, relay ports: ${MIN_PORT}-${MAX_PORT}`);
console.log(`TURN user: ${USERNAME}`);

process.on('SIGINT', () => {
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.stop();
  process.exit(0);
});
