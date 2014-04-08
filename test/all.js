var detect = require('rtc/detect');
var isTestling = typeof __testlingConsole != 'undefined';

require('./profile');
require('./datachannel');
// require('./heartbeat-disconnect');
require('./custom-id');

if (! detect.moz) {
  require('./reactive');
}

// if we are running in testling then run the media tests
if (isTestling) {
  require('./media');

  // if (! detect.moz) {
  //   require('./media-reactive');
  // }
}
