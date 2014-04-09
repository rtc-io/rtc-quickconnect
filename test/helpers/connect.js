var quickconnect = require('../../');
var defaults = require('cog/defaults');

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

    qc.once('connected', t.pass.bind(t, 'connected to signalling server'));
  });

  if (opts && opts.prep0) {
    test('prepare connection:0', function(t) {
      opts.prep0(t, connections[0]);
    });
  }

  test(prefix + 'create connection:1', function(t) {
    var qc;

    t.plan(1);
    qc = connections[1] = quickconnect(opts.signallingServer, {
      room: roomId
    });

    qc.once('connected', t.pass.bind(t, 'connected to signalling server'));
  });

  if (opts && opts.prep1) {
    test('prepare connection:1', function(t) {
      opts.prep1(t, connections[1]);
    });
  }

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