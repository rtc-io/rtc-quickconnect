var quickconnect = require('../');

quickconnect('test')
  .on('peer', function(id, connection) {
    console.log('got a new friend: ' + id, connection);
  });
