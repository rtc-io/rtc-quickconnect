var quickconnect = require('../');

quickconnect('test')
  .on('peer', function(conn, id, data, monitor) {
    console.log('got a new friend, id: ' + id, conn);
  });