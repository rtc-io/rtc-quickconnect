var async = require('async');
var test = require('tape');
var quickconnect = require('..');
var connections = [];
var roomId = require('uuid').v4();

function addNew(t) {
  var conn;
  var expectedPeers = connections.length;

  t.plan(2);

  // initialise the connection
  conn = quickconnect(location.origin, { room: roomId });

  if (connections.length === 0) {
    t.pass('no peer channels yet available');
  }
  else {
    async.parallel(connections.map(function(conn) {
      return conn.once.bind(conn, 'dc:open');
    }), t.pass.bind(t, 'peer channels open'));
  }

  // create the new data channel
  conn.createDataChannel('dc');

  if (expectedPeers === 0) {
    t.pass('no peers expected');
  }
  else {
    conn.on('dc:open', function handleChannelOpen() {
      expectedPeers -= 1;
      if (expectedPeers <= 0) {
        t.pass('got all expected peers');
      }

      conn.removeListener('dc:open', handleChannelOpen);
    });
  }
}

for (var ii = 0, count = 20; ii < count; ii++) {
  test('create ' + (ii + 1), addNew);
}

test('close the connections', function(t) {
  t.plan(1);

  connections.forEach(function(conn) {
    conn.close();
  });

  // reset the connections array
  connections = [];

  t.pass('connections closed');
});