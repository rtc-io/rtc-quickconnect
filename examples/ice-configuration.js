var quickconnect = require('../');
var opts = {
  ns: 'dctest',
  iceServers: [
    { url: 'stun:stun.l.google.com:19302' }
  ]
};

quickconnect('http://rtc.io/switchboard/', opts)
  // tell quickconnect we want a datachannel called test
  .createDataChannel('test')
  // when the test channel is open, let us know
  .on('test:open', function(dc, id) {
    dc.onmessage = function(evt) {
      console.log('peer ' + id + ' says: ' + evt.data);
    };

    console.log('test dc open for peer: ' + id);
    dc.send('hi');
  });