var quickconnect = require('../');

quickconnect('http://rtc.io/switchboard/')
  .on('peer', function(pc, id, data, monitor) {
    console.log('got a new friend, id: ' + id, pc);
  });