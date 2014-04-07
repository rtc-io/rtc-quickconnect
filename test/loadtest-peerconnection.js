var async = require('async');
var test = require('tape');
var quickconnect = require('..');
var connections = [];
var roomId = require('uuid').v4();

function addNew(t) {
  var conn;
  var expectedPeers = connections.length;

  t.plan(1);
  conn = quickconnect(location.origin, { room: roomId });

  // create the new data channel
  conn.createDataChannel('dc');
  connections.push(conn);

  if (expectedPeers === 0) {
    t.pass('no peers expected');
  }
  else {
    conn.on('dc:open', function handleChannelOpen() {
      expectedPeers -= 1;
      if (expectedPeers <= 0) {
        t.pass('all expected data channels opened');
        conn.removeListener('dc:open', handleChannelOpen);

        // release the connection reference
        conn = null;
      }


    });
  }
}

// create 6 connections with a full-way mesh (30 peer connections total)
for (var ii = 0, count = 6; ii < count; ii++) {
  test('load test: create ' + (ii + 1), addNew);
}

test('close the connections', function(t) {
  t.plan(1);

  connections.splice(0).forEach(function(conn) {
    conn.close();
  });

  t.pass('connections closed');
});