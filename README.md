# rtc-quickconnect

This is a high level helper module designed to help you get up
an running with WebRTC really, really quickly.  By using this module you
are trading off some flexibility, so if you need a more flexible
configuration you should drill down into lower level components of the
[rtc.io](http://www.rtc.io) suite.  In particular you should check out
[rtc](https://github.com/rtc-io/rtc).


[![NPM](https://nodei.co/npm/rtc-quickconnect.png)](https://nodei.co/npm/rtc-quickconnect/)

[![Build Status](https://api.travis-ci.org/rtc-io/rtc-quickconnect.svg?branch=master)](https://travis-ci.org/rtc-io/rtc-quickconnect) [![unstable](https://img.shields.io/badge/stability-unstable-yellowgreen.svg)](https://github.com/dominictarr/stability#unstable) 
[![rtc.io google group](http://img.shields.io/badge/discuss-rtc.io-blue.svg)](https://groups.google.com/forum/#!forum/rtc-io)



## Example Usage

In the simplest case you simply call quickconnect with a single string
argument which tells quickconnect which server to use for signaling:

```js
var quickconnect = require('rtc-quickconnect');

quickconnect('https://switchboard.rtc.io/', { room: 'qc-simple-demo' })
  .on('call:started', function(id, pc, data) {
    console.log('we have a new connection to: ' + id);
  });

```

## Events

The following events are emitted from the signalling object created by calling `quickconnect()`. Additionally, any of the underlying [signaller events](https://github.com/rtc-io/rtc-signaller#signaller-events) can also be used.

### Peer Level Events

The peer level events provided in quickconnect provide you the ability to tap into the various stages of the lifecycle for connecting with a peer, before the connection actually migrates to the status of a connected "call".

- `peer:connect => function(id, peerconnection, data)`

  The `peer:connect` event is emitted when we first create a connection to a discovered peer.  The `peerconnection` argument is a standard `RTCPeerConnection` instance.

- `peer:couple => funtion(id, peerconnection, data, monitor)`

  The `peer:couple` event is emitted when once quickconnect has [coupled](https://github.com/rtc-io/rtc-tools#rtc-toolscouple) to it's remote counterpart.

### Call Level Events

A "call" in quickconnect is equivalent to an established `RTCPeerConnection` between this quickconnect instance a remote peer.

- `call:started => function(id, peerconnection, data)`

  Triggered once a peer connection has been established been established between this quickconnect instance and another.

- `call:ended => function(id)`

  Triggered when a peer connection has been closed.  This may be due to the peer connection itself indicating that it has been closed, or we may have lost connection with the remote signaller and the connection has timed out.

- `call:expired => function(id)`

  Triggered when a peer connection is timed out due to the expiry of the heartbeat to the remote peer. Note that this event is thrown before (and in addition to) the more generic `call:ended` event.

### Data Channel Level Events

- `channel:opened => function(id, datachannel, data)`

  The `channel:opened` event is triggered whenever an `RTCDataChannel` has been opened (it's ready to send data) to a remote peer.

- `channel:opened:%label% => function(id, datachannel, data)`

  This is equivalent of the `channel:opened` event, but only triggered for a channel with label `%label%`.  For example:

  ```js
  quickconnect('https://switchboard.rtc.io/', { room: 'test' })
    .createDataChannel('foo')
    .createDataChannel('bar')
    .on('channel:opened:foo', function(id, dc) {
      console.log('channel foo opened for peer: ' + id);
    });
  ```

  In the case above the console message would only be displayed for the `foo` channel once open, and when the `bar` channel is opened no handler would be invoked.

- `channel:closed => function(id, datachannel, label)`

  Emitted when the channel has been closed, works when a connection has been closed or the channel itself has been closed.

- `channel:closed:%label% => function(id, datachannel, label)`

  The label specific equivalent of `channel:closed`.

### Stream Level Events

- `stream:added => function(id, stream, data)`

  The `stream:added` event is triggered when an `RTCPeerConnection` has successfully been established to another peer that contains remote streams.  Additionally, if you are using quickconnect in it's "reactive" mode then you will also receive `stream:added` events as streams are dynamically added to the connection by the remote peer.

- `stream:removed => function(id)`

  As per the `stream:added` event but triggered when a stream has been removed.


## Example Usage (using data channels)

When working with WebRTC data channels, you can call the `createDataChannel` function helper that is attached to the object returned from the `quickconnect` call.  The `createDataChannel` function signature matches the signature of the `RTCPeerConnection` `createDataChannel` function.

At the minimum it requires a label for the channel, but you can also pass through a dictionary of options that can be used to fine tune the data channel behaviour.  For more information on these options, I'd recommend having a quick look at the WebRTC spec:

<http://dev.w3.org/2011/webrtc/editor/webrtc.html#dictionary-rtcdatachannelinit-members>

If in doubt, I'd recommend not passing through options.

```js
var freeice = require('freeice');
var quickconnect = require('rtc-quickconnect');
var opts = {
  room: 'qcexample-dctest',
  // debug: true,
  iceServers: freeice()
};

quickconnect('https://switchboard.rtc.io/', opts)
  // tell quickconnect we want a datachannel called test
  .createDataChannel('test')
  // when the test channel is open, let us know
  .on('channel:opened:test', function(id, dc) {
    dc.onmessage = function(evt) {
      console.log('peer ' + id + ' says: ' + evt.data);
    };

    console.log('test dc open for peer: ' + id);
    dc.send('hi');
  });

```

## Example Usage (using captured media)

Another example is displayed below, and this example demonstrates how to use `rtc-quickconnect` to create a simple video conferencing application:

```js
var quickconnect = require('rtc-quickconnect');
var crel = require('crel');
var capture = require('rtc-capture');
var attach = require('rtc-attach');
var qsa = require('fdom/qsa');
var plugins = [
  require('rtc-plugin-temasys')
];

// create containers for our local and remote video
var local = crel('div', { class: 'local' });
var remote = crel('div', { class: 'remote' });
var peerMedia = {};

// once media is captured, connect
capture({ audio: true, video: true }, { plugins: plugins }, function(err, localStream) {
  if (err) {
    return console.error('could not capture media: ', err);
  }

  // render the local media
  attach(localStream, { plugins: plugins }, function(err, el) {
    local.appendChild(el);
  });

  // initiate connection
  quickconnect('https://switchboard.rtc.io/', { room: 'conftest', plugins: plugins })
    // broadcast our captured media to other participants in the room
    .addStream(localStream)
    // when a peer is connected (and active) pass it to us for use
    .on('call:started', function(id, pc, data) {
      attach(pc.getRemoteStreams()[0], { plugins: plugins }, function(err, el) {
        if (err) return;

        el.dataset.peer = id;
        remote.appendChild(el);
      });
    })
    // when a peer leaves, remove teh media
    .on('call:ended', function(id) {
      qsa('*[data-peer="' + id + '"]', remote).forEach(function(el) {
        el.parentNode.removeChild(el);
      });
    });
});

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

- `expectedLocalStreams` (default: not specified) _added 3.0_

  By providing a positive integer value for this option will mean that
  the created quickconnect instance will wait until the specified number of
  streams have been added to the quickconnect "template" before announcing
  to the signaling server.

- `manualJoin` (default: `false`)

  Set this value to `true` if you would prefer to call the `join` function
  to connecting to the signalling server, rather than having that happen
  automatically as soon as quickconnect is ready to.

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

#### addStream

```
addStream(stream:MediaStream) => qc
```

Add the stream to active calls and also save the stream so that it
can be added to future calls.

#### endCalls()

The `endCalls` function terminates all the active calls that have been
created in this quickconnect instance.  Calling `endCalls` does not
kill the connection with the signalling server.

#### close()

The `close` function provides a convenient way of closing all associated
peer connections.  This function simply uses the `endCalls` function and
the underlying `leave` function of the signaller to do a "full cleanup"
of all connections.

#### createDataChannel(label, config)

Request that a data channel with the specified `label` is created on
the peer connection.  When the data channel is open and available, an
event will be triggered using the label of the data channel.

For example, if a new data channel was requested using the following
call:

```js
var qc = quickconnect('https://switchboard.rtc.io/').createDataChannel('test');
```

Then when the data channel is ready for use, a `test:open` event would
be emitted by `qc`.

#### join()

The `join` function is used when `manualJoin` is set to true when creating
a quickconnect instance.  Call the `join` function once you are ready to
join the signalling server and initiate connections with other people.

#### `get(name)`

The `get` function returns the property value for the specified property name.

#### `getLocalStreams()`

Return a copy of the local streams that have currently been configured

#### reactive()

Flag that this session will be a reactive connection.

#### removeStream

```
removeStream(stream:MediaStream)
```

Remove the specified stream from both the local streams that are to
be connected to new peers, and also from any active calls.

#### requestChannel

```
requestChannel(targetId, label, callback)
```

This is a function that can be used to respond to remote peers supplying
a data channel as part of their configuration.  As per the `receiveStream`
function this function will either fire the callback immediately if the
channel is already available, or once the channel has been discovered on
the call.

#### requestStream

```
requestStream(targetId, idx, callback)
```

Used to request a remote stream from a quickconnect instance. If the
stream is already available in the calls remote streams, then the callback
will be triggered immediately, otherwise this function will monitor
`stream:added` events and wait for a match.

In the case that an unknown target is requested, then an exception will
be thrown.

#### profile(data)

Update the profile data with the attached information, so when
the signaller announces it includes this data in addition to any
room and id information.

#### waitForCall

```
waitForCall(targetId, callback)
```

Wait for a call from the specified targetId.  If the call is already
active the callback will be fired immediately, otherwise we will wait
for a `call:started` event that matches the requested `targetId`

## License(s)

### Apache 2.0

Copyright 2015 National ICT Australia Limited (NICTA)

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
