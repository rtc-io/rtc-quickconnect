var quickconnect = require('../');

quickconnect('http://rtc.io/switchboard/', { room: 'qc-simple-demo' })
  .on('call:started', function(id, pc, data) {
    console.log('we have a new connection to: ' + id);
  });