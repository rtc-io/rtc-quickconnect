var quickconnect = require('../');

quickconnect('https://switchboard.rtc.io/', { room: 'dctest-room' })
  .addChannel('test')
  .on('channel:opened:test', function(id, dc) {
    dc.onmessage = function(evt) {
      console.log('peer ' + id + ' says: ' + evt.data);
    };

    console.log('test dc open for peer: ' + id);
    dc.send('hi');
  });
