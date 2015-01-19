var quickconnect = require('..');
var test = require('tape');
var uuid = require('uuid');
var connections = [];
var dcs = [];
var roomId = uuid.v4();
var validConnectionStates = ['connected', 'completed'];
var signallingServer = location.origin;

// require('cog/logger').enable('rtc-quickconnect');

test('create connection:0 (id = "a")', function(t) {
  var qc;

  t.plan(1);
  qc = connections[0] = quickconnect(signallingServer, {
    id: 'a',
    room: roomId
  });

  t.equal(qc.id, 'a', 'created with specified id');
  qc.createDataChannel('test');
});

test('create connection:1 (id = "b")', function(t) {
  var qc;

  t.plan(1);
  qc = connections[1] = quickconnect(signallingServer, {
    id: 'b',
    room: roomId
  });

  t.equal(qc.id, 'b', 'created with specified id');
  qc.createDataChannel('test');
});

test('check call active', function(t) {
  t.plan(connections.length * 3);

  connections.forEach(function(conn, index) {
    conn.waitForCall(connections[index ^ 1].id, function(err, pc) {
      t.ifError(err, 'call available');
      t.ok(pc, 'have peer connection');
      t.ok(validConnectionStates.indexOf(pc.iceConnectionState) >= 0, 'call connected');
    });
  });
});

test('data channels opened', function(t) {
  t.plan(4);
  connections[0].requestChannel(connections[1].id, 'test', function(err, dc) {
    t.ifError(err);
    dcs[0] = dc;
    t.equal(dc.readyState, 'open', 'connection test dc 0 open');
  });

  connections[1].requestChannel(connections[0].id, 'test', function(err, dc) {
    t.ifError(err);
    dcs[1] = dc;
    t.equal(dc.readyState, 'open', 'connection test dc 1 open');
  });
});

test('dc 0 send', function(t) {
  dcs[1].onmessage = function(evt) {
    t.equal(evt.data, 'hi', 'dc:1 received hi');
    dcs[1].onmessage = null;
  };

  t.plan(1);
  dcs[0].send('hi');
});

test('dc 1 send', function(t) {
  dcs[0].onmessage = function(evt) {
    t.equal(evt.data, 'hi', 'dc:1 received hi');
    dcs[0].onmessage = null;
  };

  t.plan(1);
  dcs[1].send('hi');
});

test('release references', function(t) {
  t.plan(1);
  connections.splice(0).forEach(function(conn, index) {
    conn.close();
  });

  dcs = [];
  t.pass('done');
});
