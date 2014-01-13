/* jshint node: true */
'use strict';

var EventEmitter = require('events').EventEmitter;
var rtc = require('rtc');
var debug = rtc.logger('rtc-quickconnect');
var signaller = require('rtc-signaller');
var defaults = require('cog/defaults');
var reTrailingSlash = /\/$/;

/**
  # rtc-quickconnect

  This is a very high level helper library designed to help you get up
  an running with WebRTC really, really quickly.  By using this module you
  are trading off some flexibility, so if you need a more flexible
  configuration you should drill down into lower level components of the
  [rtc.io](http://www.rtc.io) suite.

  ## Example Usage

  In the simplest case you simply call quickconnect with a single string
  argument to establish a namespace for your demo or application.  This string
  will then be combined with randomly generated location hash that will
  determine the room for your application signalling.

  <<< examples/simple.js

  ## Example Usage (Using Data Channels)

  By default, the `RTCPeerConnection` created by quickconnect will not be
  "data channels ready".  You can change that very simply, by flagging
  `data` as `true` during quickconnect initialization:

  <<< examples/datachannel.js

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

**/
module.exports = function(signalhost, opts) {
  var hash = location.hash.slice(1);
  var signaller = require('rtc-signaller')(signalhost);

  // init configurable vars
  var ns = (opts || {}).ns || '';
  var room = (opts || {}).room;
  var debugging = (opts || {}).debug;

  // collect the local streams
  var localStreams = [];

  // create the known data channels registry
  var channels = {};

  function gotPeerChannel(channel, data) {
    // create the channelOpen function
    var emitChannelOpen = signaller.emit.bind(
      signaller,
      channel.label + ':open',
      channel,
      data.id,
      data
    );

    debug('channel ' + channel.label + ' discovered for peer: ' + data.id, channel);
    if (channel.readyState === 'open') {
      return emitChannelOpen();
    }

    channel.onopen = emitChannelOpen;
  }

  // if the room is not defined, then generate the room name
  if (! room) {
    // if the hash is not assigned, then create a random hash value
    if (! hash) {
      hash = location.hash = '' + (Math.pow(2, 53) * Math.random());
    }

    room = ns + '#' + hash;
  }

  if (debugging) {
    rtc.logger.enable.apply(rtc.logger, Array.isArray(debug) ? debugging : ['*']);
  }

  signaller.on('peer:announce', function(data, srcState) {
    var pc;
    var monitor;

    // if the room is not a match, abort
    if (data.room !== room) {
      return;
    }

    // create a peer connection
    pc = rtc.createConnection(opts, opts.constraints);

    // add the local streams
    localStreams.forEach(function(stream) {
      pc.addStream(stream);
    });

    // add the data channels
    // do this differently based on whether the connection is a
    // master or a slave connection
    if (signaller.isMaster(data.id)) {
      debug('is master, creating data channels: ', Object.keys(channels));

      // create the channels
      Object.keys(channels).forEach(function(label) {
        gotPeerChannel(pc.createDataChannel(label, channels[label]), data);
      });
    }
    else {
      pc.ondatachannel = function(evt) {
        console.log('received data channel event', evt, channels);
        // if the data channel is a known channel monitor it for open
        if (evt && evt.channel && channels[evt.channel.label] !== undefined) {
          gotPeerChannel(evt.channel, data);
        }
      };
    }

    // couple the connections
    monitor = rtc.couple(pc, data.id, signaller, opts);

    // once active, trigger the peer connect event
    monitor.once('active', function() {
      signaller.emit('peer:connect', pc, data.id, data);
    });

    // if we are the master connnection, create the offer
    // NOTE: this only really for the sake of politeness, as rtc couple
    // implementation handles the slave attempting to create an offer
    if (signaller.isMaster(data.id)) {
      monitor.createOffer();
    }
  });

  // announce ourselves to our new friend
  signaller.announce({ room: room });

  /**
    #### Broadcasting Media using Quickconnect

    To be completed.
  **/
  signaller.broadcast = function(stream) {
    localStreams.push(stream);
    return signaller;
  };

  /**
    #### Using Data Channels with QuickConnect

    To be completed.
  **/
  signaller.createDataChannel = function(label, opts) {
    // save the data channel opts in the local channels dictionary
    channels[label] = opts || null;
    return signaller;
  };

  // pass the signaller on
  return signaller;
};

/**
  ## Additional examples

  ### Full Reactive Stream Conference Example

  <<< examples/conference.js
**/
