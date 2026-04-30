const startStunServer = require('./server');
const port = parseInt(process.env.STUN_PORT, 10) || 3478;
startStunServer(port);
