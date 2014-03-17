var quickconnect = require('..');
var test = require('tape');
var uuid = require('uuid');

test('can create a quickconnect session with a custom id', function(t) {
  var qc;

  t.plan(1);
  qc = quickconnect(location.origin, { id: 1, room: uuid.v4() });
  t.equal(qc.id, 1, 'created with specified id');
});