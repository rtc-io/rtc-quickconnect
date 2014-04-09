var test = require('tape');
var connections = require('./helpers/reactive-connections')(test, 'stream:added tests');
var media = require('rtc-media');
var localStream;

require('cog/logger').enable('rtc-quickconnect');

test('capture stream', function(t) {
  t.plan(1);

  media()
    .on('error', t.ifError.bind(t))
    .once('capture', function(stream) {
      t.ok(localStream = stream, 'got stream');
    });
});

test('broadcast stream from 0 --> 1', function(t) {
  t.plan(2);
  connections[1].once('stream:added', function(id, label, stream) {
    t.ok(stream instanceof MediaStream, 'got stream');
    t.equal(label, 'main', 'label == main');
  });

  connections[0].broadcast(localStream);
});