var quickconnect = require('../');

quickconnect('test')
  .on('peer', function(conn, id) {
    console.log('got a new friend, id: ' + id, conn);
  });