var test = require('tape');
var quickconnect = require('..');
var roomId = require('uuid').v4();
var clients = [];
var signallingServer = location.origin;

test('create test participant', function(t) {
  t.plan(3);

  clients[0] = quickconnect(signallingServer, { room: roomId });
  clients[0].once('local:announce', function() {
    t.pass('have locally announced');
  });

  clients[0].once('connected', t.pass.bind(t, 'connected to the signaling server'));
  clients[0].once('message:roominfo', function(data) {
    t.ok(data && data.memberCount === 1, 'got correct membercount');
  });
});

test('announce with additional profile information', function(t) {
  t.plan(5);

  clients[0].once('peer:announce', function(data) {
    t.equal(data.name, 'Bob', 'client:0 got name data');
  });

  clients[1] = quickconnect(signallingServer, { room: roomId }).profile({ name: 'Bob' });
  clients[1].once('local:announce', function(data) {
    t.equal(data.name, 'Bob', 'name included in local announce');
  });

  clients[1].once('connected', t.pass.bind(t, 'connected to the signaling server'));
  clients[1].once('message:roominfo', function(data) {
    t.ok(data && data.memberCount === 2, 'got correct membercount');
  });

  clients[1].once('peer:announce', function(data) {
    t.pass('client:1 received reciprocated announce');
  });
});

test('create additional client', function(t) {
  t.plan(3);

  clients[0].once('peer:announce', function(data) {
    t.equal(data.name, 'Fred', 'client:0 got new client (Fred)');
  });

  clients[1].once('peer:announce', function(data) {
    t.equal(data.name, 'Fred', 'client:1 got new client (Fred)');
  });

  clients[2] = quickconnect(signallingServer, { room: roomId }).profile({ name: 'Fred' });
  clients[2].once('local:announce', function() {
    t.pass('have locally announced');
  });
});

test('client:2 updates profile', function(t) {
  t.plan(4);

  clients[2].profile({ age: 57 });
  clients[0].once('peer:update', function(data) {
    t.equal(data.name, 'Fred', 'client:0 got peer:update (name === Fred)');
    t.equal(data.age, 57, 'client:0 got peer:update (age === 57)');
  });

  clients[1].once('peer:update', function(data) {
    t.equal(data.name, 'Fred', 'client:1 got peer:update (name === Fred)');
    t.equal(data.age, 57, 'client:1 got peer:update (age === 57)');
  });
});

test('release references', function(t) {
  t.plan(1);
  clients.splice(0).forEach(function(conn, index) {
    conn.close();
  });

  t.pass('done');
});
