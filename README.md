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

quickconnect('http://rtc.io/switchboard/')
  .on('peer', function(pc, id, data, monitor) {
    console.log('got a new friend, id: ' + id, conn);
  });
```

## Example Usage (Using Data Channels)

By default, the `RTCPeerConnection` created by quickconnect will not be
"data channels ready".  You can change that very simply, by flagging
`data` as `true` during quickconnect initialization:

```js
var quickconnect = require('rtc-quickconnect');

quickconnect('http://rtc.io/switchboard/', { ns: 'dctest' })
  // tell quickconnect we want a datachannel called test
  .createDataChannel('test')
  // when the test channel is open, let us know
  .on('test:open', function(dc, id) {
    dc.onmessage = function(evt) {
      console.log('peer ' + id + ' says: ' + evt.data);
    };

    console.log('test dc open for peer: ' + id);
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

- `signalhost` (default: 'http://localhost:3000')

  The host that will be used to coordinate signalling between
  peers.  This defaults to `http://localhost:3000` but during testing feel
  free to use our test signalling server (`http://sig.rtc.io:50000`).

- `ns` (default: '')

  An optional namespace for your signalling room.  While quickconnect
  will generate a unique hash for the room, this can be made to be more
  unique by providing a namespace.  Using a namespace means two demos
  that have generated the same hash but use a different namespace will be
  in different rooms.

- `room` (default: null) _added 0.6_

  Rather than use the internal hash generation
  (plus optional namespace) for room name generation, simply use this room
  name instead.  __NOTE:__ Use of the `room` option takes precendence over
  `ns`.

- `debug` (default: false)

Write rtc.io suite debug output to the browser console.

#### Options for Peer Connection Creation

Options that are passed onto the
[rtc.createConnection](https://github.com/rtc-io/rtc#createconnectionopts-constraints)
function:

- `data` (default: false)

  Provide `{ data: true }` if you want to enable data channels on
  the peer connection.

- `constraints`

  Used to provide specific constraints when creating a new
  peer connection.

#### Options for P2P negotiation

Under the hood, quickconnect uses the
[rtc/couple](https://github.com/rtc-io/rtc#rtccouple) logic, and the options
passed to quickconnect are also passed onto this function.

#### Broadcasting Media using Quickconnect

To be completed.

#### Using Data Channels with QuickConnect

To be completed.

## Additional examples

### Full Reactive Stream Conference Example

```js
var quickconnect = require('rtc-quickconnect');
var media = require('rtc-media');
var crel = require('crel');

// create containers for our local and remote video
var local = crel('div', { class: 'local' });
var remote = crel('div', { class: 'remote' });
var media  
var peerMedia = {};

// capture local media
var localMedia = media();

// require('cog/logger').enable('*');

// once media is captured, connect
localMedia.once('capture', function(stream) {
  quickconnect('http://rtc.io/switchboard/', { ns: 'dctest' })
    // broadcast our captured media to other participants in the room
    .broadcast(stream)
    // when a peer is connected (and active) pass it to us for use
    .on('peer:connect', function(pc, id, data) {
      console.log('peer connected: ', id);

      // render the remote streams
      pc.getRemoteStreams().forEach(renderRemote(id));
    })
    // when a peer leaves, remove teh media
    .on('peer:leave', function(id) {
      // remove media for the target peer from the dom
      (peerMedia[id] || []).splice(0).forEach(function(el) {
        el.parentNode.removeChild(el);
      });
    })
});

// render the local media
localMedia.render(local);

// render a remote video
function renderRemote(id) {
  // create the peer media list
  peerMedia[id] = peerMedia[id] || [];

  return function(stream) {
    peerMedia[id] = peerMedia[id].concat(media(stream).render(remote));
  }
}

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

Copyright 2014 National ICT Australia Limited (NICTA)

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
