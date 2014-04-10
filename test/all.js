var detect = require('rtc/detect');
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

if (! detect.moz) {
  require('./reactive');
  require('./reactive-stream-events');
}