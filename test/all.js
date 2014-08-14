var detect = require('rtc-tools/detect');
var isTestling = typeof __testlingConsole != 'undefined';

// if we are running in testling then run the media tests
if (isTestling) {
  require('./media');

  if (! detect.moz) {
    // require('./media-reactive');
  }
}

require('./profile');
require('./datachannel');
// require('./heartbeat-disconnect');
require('./custom-id');
require('./request-stream');
require('./events');

// we need some firefox issues resolved before all tests can be run
if (! detect.moz) {
  // https://bugzilla.mozilla.org/show_bug.cgi?id=852665
  require('./reconnect');

  // https://bugzilla.mozilla.org/show_bug.cgi?id=857115
  require('./reactive');
  require('./reactive-stream-events');
}
