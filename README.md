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
  .on('peer', function(conn, id) {
    console.log('got a new friend, id: ' + id, conn);
  });
```

## Example Usage (Using Data Channels)

```js
var quickconnect = require('rtc-quickconnect');

quickconnect({ ns: 'test', data: true, dtls: true })
  .on('peer', function(connection, id) {
    console.log('got a new friend: ' + id, connection);
  })
  .on('dc:open', function(dc, id) {
    console.log('dc open for peer: ' + id);
  });
```

## How it works?

The `rtc-quickconnect` module makes use of our internal, publicly available
signaller which uses [socket.io](http://socket.io/) and our 
[signalling adapter](https://github.com/rtc-io/rtc-signaller-socket.io).

Our test signaller is exactly that, __something we use for testing__.  If 
you want to run your own signaller this is very simple and you should 
consult the `rtc-signaller-socket.io` module for information on how to
do this.  Once you have this running, simply provide quickconnect a
signaller option when creating:

```js
var quickconnect = require('rtc-quickconnect');

quickconnect({ ns: 'test', signaller: 'http://mysignaller.com:3000' });
```
