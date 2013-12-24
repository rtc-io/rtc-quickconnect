var quickconnect = require('../');

quickconnect({ ns: 'test', signalhost: 'http://rtc.io/switchboard/' })
  .on('peer', function(conn, id, data, monitor) {
    console.log('got a new friend, id: ' + id, conn);
  });