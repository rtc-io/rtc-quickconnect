# rtc-quickconnect

This is a very high level helper library designed to help you get up
an running with WebRTC really, really quickly.  By using this module you
are trading off some flexibility, so if you need a more flexible
configuration you should drill down into lower level components of the
[rtc.io](http://www.rtc.io) suite.


[![NPM](https://nodei.co/npm/rtc-quickconnect.png)](https://nodei.co/npm/rtc-quickconnect/)

[![unstable](http://hughsk.github.io/stability-badges/dist/unstable.svg)](http://github.com/hughsk/stability-badges)

## Example Usage

In the simplest case you simply call quickconnect with a single string
argument to establish a namespace for your demo or application.  This string
will then be combined with randomly generated location hash that will
determine the room for your application signalling.

```js
var quickconnect = require('rtc-quickconnect');

quickconnect('test')
  .on('peer', function(conn, id) {
    console.log('got a new friend, id: ' + id, conn);
  });
```

## Example Usage (Using Data Channels)

By default, the `RTCPeerConnection` created by quickconnect will not be
"data channels ready".  You can change that very simply, by flagging
`data` as `true` during quickconnect initialization:

```js
var quickconnect = require('rtc-quickconnect');

quickconnect({ ns: 'test', data: true, dtls: true })
  .on('peer', function(connection, id) {
    console.log('got a new friend: ' + id, connection);
  })
  .on('dc:open', function(dc, id) {
    dc.addEventListener('message', function(evt) {
      console.log('peer ' + id + ' says: ' + evt.data);
    });

    console.log('dc open for peer: ' + id);
    dc.send('hi');
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

## Full Reactive Stream Conference Example

```js
var quickconnect = require('rtc-quickconnect');
var crel = require('crel');
var rtc = require('rtc');

// create containers for our local and remote video
var local = crel('div', { class: 'local' });
var remote = crel('div', { class: 'remote' });

var peers = {};
var peerVideos = {};

// capture local media
var media = rtc.media();

function handleConnect(conn, id) {
  // save the peer
  peers[id] = conn;

  // hook up our local media
  if (media.stream) {
    conn.addStream(media.stream);
  }
  else {
    media.once('capture', conn.addStream.bind(conn));
  }

  // add existing remote streams
  conn.getRemoteStreams().forEach(renderRemote(id));

  // listen for new streams
  conn.addEventListener('addstream', function(evt) {
    renderRemote(id)(evt.stream);
  });
}

// handle the signaller telling us a peer is leaving
function handleLeave(id) {
  // remove old streams
  (peerVideos[id] || []).forEach(function(el) {
    el.parentNode.removeChild(el);
  });

  peerVideos[id] = undefined;

  // close the peer connection
  peers[id].close();
  peers[id] = undefined;
}

// render a remote video
function renderRemote(id) {
  // create the peer videos list
  peerVideos[id] = peerVideos[id] || [];

  return function(stream) {
    peerVideos[id] = peerVideos[id].concat(rtc.media(stream).render(remote));
  }
}
// render to local
media.render(local);

// handle the connection stuff
quickconnect('test')
  .on('peer', handleConnect)
  .on('leave', handleLeave);

/* extra code to handle dynamic html and css creation */

// add some basic styling
document.head.appendChild(crel('style', [
  '.local { position: absolute;  right: 10px; }',
  '.local video { max-width: 200px; }'
].join('\n')));

// add the local and remote elements
document.body.appendChild(local);
document.body.appendChild(remote);
```

## License(s)

### Apache 2.0

Copyright 2013 National ICT Australia Limited (NICTA)

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
