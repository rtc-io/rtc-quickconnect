var quickconnect = require('..');
var test = require('tape');
var uuid = require('uuid');
var connections = [];
var dcs = [];
var roomId = uuid.v4();
// var signallingServer = 'http://rtc.io/switchboard/';
var signallingServer = location.origin;

require('cog/logger').enable('rtc-quickconnect');

test('peer:connect', function(t) {

  var qc, timer;
  t.plan(1);
  qc = connections[0] = quickconnect(signallingServer, { room: roomId });

  qc.on('peer:connect', function(pc, data) {

    qc.on('channel:opened:et', function(id, dc) { 

      pc.getStats(function(stats) {
        clearTimeout(timer);
        t.pass('emits correctly');
      });
    });

    qc.createDataChannel('et');
  });  

  connections[1] = quickconnect(signallingServer, { room: roomId }).createDataChannel('eventstest');

  timer = setTimeout(function () {
    t.fail('Timed out')
  }, 5000);
});

test('clean up', function(t) {
  for (var i = 0; i < connections.length; i++) {
    connections[0].close();
  }
  connections = [];
  return t.pass('done');
})