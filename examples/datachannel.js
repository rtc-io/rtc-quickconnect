var quickconnect = require('../');

quickconnect({ ns: 'test', data: true, dtls: true })
  .on('peer', function(connection, id) {
    console.log('got a new friend: ' + id, connection);
  })
  .on('dc:open', function(dc, id) {
    console.log('dc open for peer: ' + id);
  });