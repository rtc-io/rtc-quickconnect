var quickconnect = require('../..');
var pluck = require('whisk/pluck');

module.exports = function(roomId, connections) {
  return function(t) {
    var conn;
    var pending = connections.map(pluck('id'));

    function handleCallStart(peerId) {
      var peerIdx = pending.indexOf(peerId);

      t.ok(peerIdx >= 0, 'connected with ' + peerId);
      pending.splice(peerIdx, 1);

      console.log(pending);
      if (pending.length === 0) {
        conn.removeListener('call:started', handleCallStart);
      }
    }

    t.plan(connections.length + 1);
    conn = quickconnect(require('./signaling-server'), {
      room: roomId
    });

    // create a new data channel
    conn.createDataChannel('test');

    // wait for a connection to start on each of the existing channels
    if (pending.length > 0) {
      conn.on('call:started', handleCallStart);
    }

    connections.push(conn);
    t.pass('created new peer');
  };
};
