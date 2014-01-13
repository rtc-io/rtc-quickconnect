var quickconnect = require('../');

quickconnect('http://rtc.io/switchboard/', { ns: 'dctest' })
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