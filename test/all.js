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

if (! detect.moz) {
  require('./event-stream-added');

  require('./reactive');
  require('./reactive-event-stream-added');
}