var quickconnect = require('..');
var test = require('tape');
var uuid = require('uuid');
var connections = [];
var dcs = [];
var roomId = uuid.v4();
var addConnection = require('./helpers/add-connection');

// require('cog/logger').enable('rtc-quickconnect');

test('connect 0', addConnection(roomId, connections));
test('connect 1', addConnection(roomId, connections));
test('connect 2', addConnection(roomId, connections));
test('connect 3', addConnection(roomId, connections));

test('clean up', function(t) {
  t.plan(1);

  connections.splice(0).forEach(function(connection) {
    connection.close();
  });

  return t.pass('done');
});
