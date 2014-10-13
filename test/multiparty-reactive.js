var test = require('tape');
var quickconnect = require('../');
var connections = [];
var roomId = require('uuid').v4();
var times = require('whisk/times');
var pluck = require('whisk/pluck');
var dcs = [];
var testStream = new AudioContext().createMediaStreamDestination().stream;
var connectionCount = 3;

// require('cog/logger').enable('rtc-quickconnect');

test('create ' + connectionCount + ' connections', function(t) {
  connections = times(connectionCount).map(function() {
    var qc = quickconnect(location.origin, {
      room: roomId,
      reactive: true,
      iceServers: require('./helpers/stun-google')
    });

    // create a single data channel
    qc.createDataChannel('test');
    return qc;
  });

  t.plan(connections.length);
  connections.forEach(function(conn) {
    conn.once('connected', t.pass.bind(t, 'connected'));
  });
});


test('establish connection matrix', function(t) {
  t.plan(connections.length * (connections.length - 1));

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

test('add another data channel (t2) on each of the connections', function(t) {
  t.plan(connections.length * (connections.length - 1));
  connections.forEach(function(conn) {
    var expected = connections.map(pluck('id')).filter(function(id) {
      return id !== conn.id;
    });

    function handleChannelOpen(id) {
      var idx = expected.indexOf(id);

      t.ok(idx >= 0, conn.id + ' got dc (t2) from ' + id);
      if (idx >= 0) {
        expected.splice(idx, 1);
      }

      if (expected.length === 0) {
        conn.removeListener('channel:opened:t2', handleChannelOpen);
      }
    }

    conn.on('channel:opened:t2', handleChannelOpen);
    conn.createDataChannel('t2');
  });
});

test('add another two data channels (t3,t4) and a stream on each of the connections', function(t) {
  t.plan(connections.length * (connections.length - 1) * 3);
  connections.forEach(function(conn) {
    var expected = connections.map(pluck('id')).filter(function(id) {
      return id !== conn.id;
    });

    function checkDone() {
      if (expected.length === 0) {
        conn.removeListener('channel:opened:t3', handleT3Open);
        conn.removeListener('channel:opened:t4', handleT4Open);
        conn.removeListener('stream:added', handleStream);
      }
    }

    function handleStream(id) {
      var idx = expected.indexOf(id);

      t.ok(idx >= 0, conn.id + ' got stream from ' + id);
      if (idx >= 0) {
        expected.splice(idx, 1);
      }

      checkDone();
    }

    function handleT3Open(id) {
      var idx = expected.indexOf(id);

      t.ok(idx >= 0, conn.id + ' got dc (t3) from ' + id);
      if (idx >= 0) {
        expected.splice(idx, 1);
      }

      checkDone();
    }

    function handleT4Open(id) {
      var idx = expected.indexOf(id);

      t.ok(idx >= 0, conn.id + ' got dc (t4) from ' + id);
      if (idx >= 0) {
        expected.splice(idx, 1);
      }

      checkDone();
    }

    // expect two lots of connections
    expected = expected.concat(expected).concat(expected);

    conn.on('channel:opened:t3', handleT3Open);
    conn.on('channel:opened:t4', handleT4Open);
    conn.on('stream:added', handleStream);
    conn.createDataChannel('t3');
    conn.createDataChannel('t4');
    conn.addStream(testStream);
  });
});

test('cleanup', function(t) {
  t.plan(connections.length);
  connections.splice(0).forEach(function(conn) {
    conn.once('disconnected', t.pass.bind(t, 'disconnected'));
    conn.close();
  });

  dcs = [];
});
