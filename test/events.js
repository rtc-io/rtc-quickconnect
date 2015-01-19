var quickconnect = require('..');
var test = require('tape');
var uuid = require('uuid');
var connections = [];
var dcs = [];
var roomId = uuid.v4();
var signallingServer = location.origin;

// require('cog/logger').enable('rtc-quickconnect');

test('peer:connect', function(t) {
  var qc;
  var timer;
  var statsArgs = [ gotStats, function() {} ];

  function gotStats(stats) {
    t.pass('got stats');
    clearTimeout(timer);
  }

  t.plan(5);

  qc = connections[0] = quickconnect(signallingServer, { room: roomId });
  qc.once('peer:connect', function(id, pc, data) {
    t.equal(id, connections[1].id, 'detected connect');

    qc.once('channel:opened:et', function() {
      t.pass('data channel open');
      pc.getStats.apply(pc, (pc.getStats.length === 3 ? [null] : []).concat(statsArgs));
    });

    qc.createDataChannel('et');
  });

  qc.once('peer:couple', function(id, pc, data, monitor) {
    t.ok(monitor, 'coupling created, monitor created');
    monitor.once('connected', t.pass.bind(t, 'connected'));
  });


  connections[1] = quickconnect(signallingServer, { room: roomId }).createDataChannel('et');

  timer = setTimeout(function () {
    t.fail('Timed out')
  }, 10000);
});

test('clean up', function(t) {
  t.plan(1);

  for (var i = 0; i < connections.length; i++) {
    connections[0].close();
  }
  connections = [];
  return t.pass('done');
})
