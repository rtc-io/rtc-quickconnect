var test = require('tape');
var quickconnect = require('../');
var connections = [];
var roomId = require('uuid').v4();
var dcs = [];

// require('cog/logger').enable('rtc-quickconnect');

test('quickconnect:0', function(t) {
  t.plan(1);
  connections[0] = quickconnect(location.origin, { room: roomId });
  connections[0].reactive();
  connections[0].once('connected', t.pass.bind(t, 'connected'));
});

test('quickconnect:1', function(t) {
  t.plan(1);
  connections[1] = quickconnect(location.origin, { room: roomId });
  connections[1].reactive();
  connections[1].once('connected', t.pass.bind(t, 'connected'));
});

test('call started', function(t) {
  t.plan(2);
  connections[0].once('call:started', function(id) {
    t.equal(id, connections[1].id, 'connection:0 established call with connection:1');
  });

  connections[1].once('call:started', function(id) {
    t.equal(id, connections[0].id, 'connection:1 established call with connection:0');
  });
});

test('create a datachannel on each of the connections', function(t) {
  t.plan(connections.length * 2);

  connections.forEach(function(connection, index) {
    connection.once('channel:opened:test', function(id, dc) {
      t.pass('received data channel for connection:' + index);
      dcs[index] = dc;
    });
  });

  connections.forEach(function(connection) {
    connection.createDataChannel('test');
    t.pass('data channel created');
  });
});

test('can send a message from dc:0 --> dc:1', function(t) {
  t.plan(2);
  dcs[1].onmessage = function(evt) {
    t.ok(evt, 'onmessage fired');
    t.equal(evt.data, 'hello', 'matched expected');

    dcs[1].onmessage = null;
  }

  dcs[0].send('hello');
});

test('can send a message from dc:1 --> dc:0', function(t) {
  t.plan(2);
  dcs[0].onmessage = function(evt) {
    t.ok(evt, 'onmessage fired');
    t.equal(evt.data, 'hi', 'matched expected');

    dcs[0].onmessage = null;
  }

  dcs[1].send('hi');
});

test('cleanup', function(t) {
  t.plan(connections.length);
  connections.splice(0).forEach(function(conn) {
    conn.once('disconnected', t.pass.bind(t, 'disconnected'));
    conn.close();
  });

  dcs = [];
});
