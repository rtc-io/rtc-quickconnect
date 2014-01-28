var test = require('tape');
var quickconnect = require('..');
var roomId = require('uuid').v4();
var clients = [];

test('create test participant', function(t) {
  t.plan(1);

  clients[0] = quickconnect(location.origin);
  clients[0].once('local:announce', function() {
    t.pass('have locally announced');
  });
});

test('announce with additional profile information', function(t) {
  t.plan(2);

  clients[0].once('peer:announce', function(data) {
    t.equal(data.name, 'Bob', 'client:0 got name data');
  });

  clients[1] = quickconnect(location.origin).profile({ name: 'Bob' });
  clients[1].once('local:announce', function(data) {
    t.equal(data.name, 'Bob', 'name included in local announce');
  });
});