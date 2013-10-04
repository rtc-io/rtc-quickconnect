# rtc-quickconnect

This is a very high level helper library designed to help you get up
an running with WebRTC really, really quickly.  By using this module you
are trading off some flexibility, so if you need a more flexible
configuration you should drill down into lower level components of the
[rtc.io](http://www.rtc.io) suite.

## Example Usage

```js
var quickconnect = require('rtc-quickconnect');

quickconnect('test')
  .on('peer', function(id, connection) {
    console.log('got a new friend: ' + id, connection);
  });

```
