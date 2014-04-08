var media = require('rtc-media');
var quickconnect = require('../');
var test = require('tape');
var roomId = require('uuid').v4();
var localMedia;

test('can capture a local stream', function(t) {
  t.plan(1);

  localMedia = media();
  localMedia.once('capture', function(stream) {
    t.pass('captured media');
  });
});