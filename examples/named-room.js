var quickconnect = require('../');
var opts = {
  room: 'dctest-room',
  data: true,
  signalhost: 
};

quickconnect('http://rtc.io/switchboard/', { room: 'dctest-room' })
  .addChannel('test')
  .on('test:open', function(dc, id) {
    dc.onmessage = function(evt) {
      console.log('peer ' + id + ' says: ' + evt.data);
    };

    console.log('test dc open for peer: ' + id);
    dc.send('hi');
  });