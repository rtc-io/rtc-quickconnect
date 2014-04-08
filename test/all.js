var detect = require('rtc/detect');

require('./profile');
require('./datachannel');
// require('./heartbeat-disconnect');
require('./custom-id');

if (! detect.moz) {
  require('./reactive');
}