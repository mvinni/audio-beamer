const { ExpressPeerServer } = require('peer');

module.exports = function(app) {
  const server = app.listen(9000);
  const idGenerator = () => (Math.random().toString(36) + '00000000000').substr(2, 8);

  const peerServer = ExpressPeerServer(server, {
    debug: true,
    path: '/beam',
    generateClientId: idGenerator
  });

  app.use('/peerjs', peerServer);

  peerServer.on('connection', (client) => {
    console.log('peerjs connected: ', client.id);
  });
  peerServer.on('disconnect', (client) => {
    console.log('peerjs disconnect: ', client.id);
  });
};
