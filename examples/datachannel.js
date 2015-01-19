var freeice = require('freeice');
var quickconnect = require('../');
var opts = {
  room: 'qcexample-dctest',
  // debug: true,
  iceServers: freeice()
};

quickconnect('https://switchboard.rtc.io/', opts)
  // tell quickconnect we want a datachannel called test
  .createDataChannel('test')
  // when the test channel is open, let us know
  .on('channel:opened:test', function(id, dc) {
    dc.onmessage = function(evt) {
      console.log('peer ' + id + ' says: ' + evt.data);
    };

    console.log('test dc open for peer: ' + id);
    dc.send('hi');
  });
