var quickconnect = require('../../');

module.exports = function(test, prefix, signallingServer) {
  var connections = [];
  var roomId = require('uuid').v4();

  // make the prefix sensible
  prefix = prefix ? (prefix + ': ') : '';

  // use location origin unless specified otherwise
  signallingServer = signallingServer || location.origin;

  // require('cog/logger').enable('rtc-quickconnect');

  test(prefix + 'create connection:0', function(t) {
    var qc;

    t.plan(1);
    qc = connections[0] = quickconnect(signallingServer, {
      room: roomId
    });

    // flag as reactive
    qc.reactive();
    qc.once('connected', t.pass.bind(t, 'connected to signalling server'));
  });

  test(prefix + 'create connection:1', function(t) {
    var qc;

    t.plan(1);
    qc = connections[1] = quickconnect(signallingServer, {
      room: roomId
    });

    // flag as reactive
    qc.reactive();
    qc.once('connected', t.pass.bind(t, 'connected to signalling server'));
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