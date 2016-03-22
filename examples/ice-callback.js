var quickconnect = require('../');
var opts = {
  room: 'icecallback',
  ice: function(opts, callback) {
    console.log('requesting ICE servers for connection to ' + opts.targetPeer);
    return callback(null, [{ url: 'stun:stun.l.google.com:19302'}]);
  }
};

quickconnect('https://switchboard.rtc.io/', opts)
  // tell quickconnect we want a datachannel called test
  .createDataChannel('iceconfig')
  // Log the ice servers we are using
  .on('peer:iceservers', function(id, scheme, iceServers) {
    console.log('using ' + iceServers.length + ' ICE servers for connection to ' + id);
  })
  // when the test channel is open, let us know
  .on('channel:opened:iceconfig', function(id, dc) {
    dc.onmessage = function(evt) {
      console.log('peer ' + id + ' says: ' + evt.data);
    };

    console.log('test dc open for peer: ' + id);
    dc.send('hi');
  });
