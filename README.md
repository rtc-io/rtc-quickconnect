# rtc-quickconnect

This is a high level helper module designed to help you get up
an running with WebRTC really, really quickly.  By using this module you
are trading off some flexibility, so if you need a more flexible
configuration you should drill down into lower level components of the
[rtc.io](http://www.rtc.io) suite.  In particular you should check out
[rtc](https://github.com/rtc-io/rtc).


[![NPM](https://nodei.co/npm/rtc-quickconnect.png)](https://nodei.co/npm/rtc-quickconnect/)

[![Build Status](https://img.shields.io/travis/rtc-io/rtc-quickconnect.svg?branch=master)](https://travis-ci.org/rtc-io/rtc-quickconnect)
![unstable](https://img.shields.io/badge/stability-unstable-yellowgreen.svg)

[![Gitter chat](https://badges.gitter.im/rtc-io/discuss.png)](https://gitter.im/rtc-io/discuss)


## Example Usage

In the simplest case you simply call quickconnect with a single string
argument which tells quickconnect which server to use for signaling:

```js
var quickconnect = require('rtc-quickconnect');

quickconnect('http://rtc.io/switchboard/', { room: 'qc-simple-demo' })
  .on('call:started', function(id, pc, data) {
    console.log('we have a new connection to: ' + id);
  });
```

## Example Usage (using data channels)

When working with WebRTC data channels, you can call the `createDataChannel`
function helper that is attached to the object returned from the
`quickconnect` call.  The `createDataChannel` function signature matches
the signature of the `RTCPeerConnection` `createDataChannel` function.

At the minimum it requires a label for the channel, but you can also pass
through a dictionary of options that can be used to fine tune the
data channel behaviour.  For more information on these options, I'd
recommend having a quick look at the WebRTC spec:

http://dev.w3.org/2011/webrtc/editor/webrtc.html#dictionary-rtcdatachannelinit-members

If in doubt, I'd recommend not passing through options.

```js
var freeice = require('freeice');
var quickconnect = require('rtc-quickconnect');
var opts = {
  room: 'qcexample-dctest',
  // debug: true,
  iceServers: freeice()
};

quickconnect('http://rtc.io/switchboard/', opts)
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

__NOTE:__ Data channel interoperability has been tested between Chrome 32
and Firefox 26, which both make use of SCTP data channels.

__NOTE:__ The current stable version of Chrome is 31, so interoperability
with Firefox right now will be hard to achieve.

## Example Usage (using captured media)

Another example is displayed below, and this example demonstrates how
to use `rtc-quickconnect` to create a simple video conferencing application:

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
  quickconnect('http://rtc.io/switchboard/', { room: 'conftest' })
    // create a chat channel
    .createDataChannel('chat')
    // broadcast our captured media to other participants in the room
    .broadcast(stream)
    // when a peer is connected (and active) pass it to us for use
    .on('call:started', function(id, pc, data) {
      console.log('peer connected: ', id);

      // render the remote streams
      pc.getRemoteStreams().forEach(renderRemote(id));
    })
    .on('chat:open', function(dc) {
      dc.onmessage = function(evt) {
        console.log('received chat message: ' + evt.data);
      };

      setInterval(function() {
        dc.send('hello');
      }, 1000);
    })
    // when a peer leaves, remove teh media
    .on('call:ended', function(id) {
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

## Regarding Signalling and a Signalling Server

Signaling is an important part of setting up a WebRTC connection and for
our examples we use our own test instance of the
[rtc-switchboard](https://github.com/rtc-io/rtc-switchboard). For your
testing and development you are more than welcome to use this also, but
just be aware that we use this for our testing so it may go up and down
a little.  If you need something more stable, why not consider deploying
an instance of the switchboard yourself - it's pretty easy :)

## Reference

```
quickconnect(signalhost, opts?) => rtc-sigaller instance (+ helpers)
```

### Valid Quick Connect Options

The options provided to the `rtc-quickconnect` module function influence the
behaviour of some of the underlying components used from the rtc.io suite.

Listed below are some of the commonly used options:

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

- `iceServers`

This provides a list of ice servers that can be used to help negotiate a
connection between peers.

#### Options for P2P negotiation

Under the hood, quickconnect uses the
[rtc/couple](https://github.com/rtc-io/rtc#rtccouple) logic, and the options
passed to quickconnect are also passed onto this function.

### Quickconnect Broadcast and Data Channel Helper Functions

The following are functions that are patched into the `rtc-signaller`
instance that make working with and creating functional WebRTC applications
a lot simpler.

#### broadcast(stream)

Add the stream to the set of local streams that we will broadcast
to other peers.

#### getChannel(targetId, name)

This is an accessor method to get an **active** channel by it's label. If
the channel is not yet active, then this function will return `undefined`.
In this case you should use the `%label%:open` event handler to wait for
the channel.

#### close()

The `close` function provides a convenient way of closing all associated
peer connections.

#### createDataChannel(label, config)

Request that a data channel with the specified `label` is created on
the peer connection.  When the data channel is open and available, an
event will be triggered using the label of the data channel.

For example, if a new data channel was requested using the following
call:

```js
var qc = quickconnect('http://rtc.io/switchboard').createDataChannel('test');
```

Then when the data channel is ready for use, a `test:open` event would
be emitted by `qc`.

#### profile(data)

Update the profile data with the attached information, so when 
the signaller announces it includes this data in addition to any
room and id information.

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
