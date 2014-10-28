var quickconnect = require('..');
var test = require('tape');
var uuid = require('uuid');
var connections = [];
var dcs = [];
var roomId = uuid.v4();
var connectionCount = 3;
var times = require('whisk/times');
var pluck = require('whisk/pluck');

// require('cog/logger').enable('rtc-quickconnect');

test('create ' + connectionCount + ' connections', function(t) {
  connections = times(connectionCount).map(function() {
    var qc = quickconnect(location.origin, {
      room: roomId,
      iceServers: require('./helpers/stun-google')
    });

    // create a single data channel
    qc.createDataChannel('test');
    return qc;
  });

  t.plan(connections.length);
  connections.forEach(function(conn) {
    conn.once('connected', t.pass.bind(t, 'connected ' + conn.id));
  });
});


test('establish connection matrix', function(t) {
  t.plan(connections.length * (connections.length - 1));
  console.log('waiting for ' + (connections.length * (connections.length - 1)) + ' connections');

  connections.forEach(function(conn) {
    var expected = connections.map(pluck('id')).filter(function(id) {
      return id !== conn.id;
    });

    function callStart(id) {
      var idx = expected.indexOf(id);

      t.ok(idx >= 0, conn.id + ' started call with ' + id);
      if (idx >= 0) {
        expected.splice(idx, 1);
      }

      if (expected.length === 0) {
        conn.removeListener('call:started', callStart);
      }
    }

    conn.on('call:started', callStart);
  });
});

test('clean up', function(t) {
  t.plan(1);

  connections.splice(0).forEach(function(connection) {
    connection.close();
  });

  return t.pass('done');
});
