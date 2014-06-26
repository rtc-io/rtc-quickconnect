var quickconnect = require('../../');
var defaults = require('cog/defaults');
var detect = require('rtc-tools/detect');

module.exports = function(test, prefix, opts) {
  var connections = [];
  var roomId = require('uuid').v4();

  // ensure we have default opts for helpers
  opts = defaults({}, opts, require('./defaults'));

  // make the prefix sensible
  prefix = prefix ? (prefix + ': ') : '';

  // require('cog/logger').enable('rtc-quickconnect');

  test(prefix + 'create connection:0', function(t) {
    var qc;

    t.plan(1);
    qc = connections[0] = quickconnect(opts.signallingServer, {
      room: roomId
    });

    t.pass('connection:0 created');
  });

  // if we are using moz then we are going to need data channels to make
  // this work if no streams are added
  if (detect.moz && (! opts.nodc)) {
    test('creating dummy data channel for connection:0', function(t) {
      t.plan(1);
      connections[0].createDataChannel('__dummy');
      t.pass('data channel defined');
    });
  }

  if (opts && opts.prep0) {
    test('prepare connection:0', function(t) {
      opts.prep0(t, connections[0]);
    });
  }

  test(prefix + 'connection:0 connect to signaller', function(t) {
    t.plan(1);
    connections[0].once('connected', t.pass.bind(t, 'connected to signalling server'));
  });

  test(prefix + 'create connection:1', function(t) {
    var qc;

    t.plan(1);
    qc = connections[1] = quickconnect(opts.signallingServer, {
      room: roomId
    });

    t.pass('connection:1 created');
  });

  if (detect.moz && (! opts.nodc)) {
    test('creating dummy data channel for connection:1', function(t) {
      t.plan(1);
      connections[1].createDataChannel('__dummy');
      t.pass('data channel defined');
    });
  }

  if (opts && opts.prep1) {
    test('prepare connection:1', function(t) {
      opts.prep1(t, connections[1]);
    });
  }

  test(prefix + 'connection:1 connect to signaller', function(t) {
    t.plan(1);
    connections[1].once('connected', t.pass.bind(t, 'connected to signalling server'));
  });

  test(prefix + 'calls started', function(t) {
    t.plan(connections.length * 2);

    connections.forEach(function(conn, index) {
      conn.once('call:started', function(id, pc) {
        t.equal(id, connections[index ^ 1].id, 'id matched expected');
        t.ok(pc, 'got peer connection');
      });
    });
  });

  return connections;
};
