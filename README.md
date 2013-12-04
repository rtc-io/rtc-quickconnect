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

quickconnect({ ns: 'test', signalhost: 'http://sig.rtc.io:50000' })
  .on('peer', function(conn, id, data, monitor) {
    console.log('got a new friend, id: ' + id, conn);
  });
```

## Example Usage (Using Data Channels)

By default, the `RTCPeerConnection` created by quickconnect will not be
"data channels ready".  You can change that very simply, by flagging
`data` as `true` during quickconnect initialization:

```js
var quickconnect = require('rtc-quickconnect');
var opts = {
  ns: 'dctest',
  data: true,
  signalhost: 'http://sig.rtc.io:50000'
};

quickconnect(opts)
  .on('peer', function(connection, id, data, monitor) {
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

__NOTE:__ Our public test signaller is currently unavailable, you will
need to run up a version of `rtc-switchboard` locally for the time being.

The `rtc-quickconnect` module makes use of our internal, publicly available
signaller which uses [primus](https://github.com/primus/primus) and our
[signalling adapter](https://github.com/rtc-io/rtc-switchboard).

Our test signaller is exactly that, __something we use for testing__.  If
you want to run your own signaller this is very simple and you should
consult the `rtc-signaller-socket.io` module for information on how to
do this.  Once you have this running, simply provide quickconnect a
signaller option when creating:

```js
var quickconnect = require('rtc-quickconnect');

quickconnect({ ns: 'test', signaller: 'http://mysignaller.com:3000' });
```

## Reference

```
quickconnect(opts?) => EventEmitter
```

The `rtc-quickconnect` module exports a single function that is used to
create a node [EventEmitter](http://nodejs.org/api/events.html) and
start the signalling process required to establish WebRTC peer connections.

### Valid Quick Connect Options

The options provided to the `rtc-quickconnect` module function influence the
behaviour of some of the underlying components used from the rtc.io suite.

Listed below are some of the commonly used options:

- `signalhost`: The host that will be used to coordinate signalling between
  peers.  This defaults to `http://localhost:3000` but during testing feel
  free to use our test signalling server (`http://sig.rtc.io:50000`).

- `ns`: An optional namespace for your signalling room.  While quickconnect
  will generate a unique hash for the room, this can be made to be more
  unique by providing a namespace.  Using a namespace means two demos
  that have generated the same hash but use a different namespace will be
  in different rooms.

- `room` (added 0.6): Rather than use the internal hash generation
  (plus optional namespace) for room name generation, simply use this room
  name instead.  __NOTE:__ Use of the `room` option takes precendence over
  `ns`.

- `debug`: Write rtc.io suite debug output to the browser console.

#### Options for Peer Connection Creation

Options that are passed onto the
[rtc.createConnection](https://github.com/rtc-io/rtc#createconnectionopts-constraints)
function:

- `data`: Provide `{ data: true }` if you want to enable data channels on
  the peer connection.

- `constraints`: Used to provide specific constraints when creating a new
  peer connection.

#### Options for P2P negotiation

Under the hood, quickconnect uses the
[rtc/couple](https://github.com/rtc-io/rtc#rtccouple) logic, and the options
passed to quickconnect are also passed onto this function.

## Additional examples

### Full Reactive Stream Conference Example

```js
var quickconnect = require('rtc-quickconnect');
var crel = require('crel');

// create containers for our local and remote video
var local = crel('div', { class: 'local' });
var remote = crel('div', { class: 'remote' });

var peers = {};
var peerVideos = {};

// capture local media
var media = require('rtc-media');
var localMedia = media();

function handleConnect(conn, id, data, monitor) {
  // save the peer
  peers[id] = conn;

  // hook up our local media
  if (localMedia.stream) {
    conn.addStream(localMedia.stream);
  }
  else {
    localMedia.once('capture', conn.addStream.bind(conn));
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
    peerVideos[id] = peerVideos[id].concat(media(stream).render(remote));
  }
}
// render to local
localMedia.render(local);

// handle the connection stuff
quickconnect({ ns: 'conftest', signalhost: 'http://sig.rtc.io:50000/' })
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
