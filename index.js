/* jshint node: true */
/* global location */
'use strict';

var rtc = require('rtc-tools');
var mbus = require('mbus');
var detectPlugin = require('rtc-core/plugin');
var debug = rtc.logger('rtc-quickconnect');
var extend = require('cog/extend');
var sdpSupport = require('./lib/sdpsupport');

/**
  # rtc-quickconnect

  This is a high level helper module designed to help you get up
  an running with WebRTC really, really quickly.  By using this module you
  are trading off some flexibility, so if you need a more flexible
  configuration you should drill down into lower level components of the
  [rtc.io](http://www.rtc.io) suite.  In particular you should check out
  [rtc](https://github.com/rtc-io/rtc).

  ## Example Usage

  In the simplest case you simply call quickconnect with a single string
  argument which tells quickconnect which server to use for signaling:

  <<< examples/simple.js

  <<< docs/events.md

  <<< docs/examples.md

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

**/
module.exports = function (signalhost, opts) {
  var hash = typeof location != 'undefined' && location.hash.slice(1);
  var signaller = require('rtc-pluggable-signaller')(extend({
    signaller: signalhost,

    // use the primus endpoint as a fallback in case we are talking to an
    // older switchboard instance
    endpoints: ['/', '/primus']
  }, opts));

  var getPeerData = require('./lib/getpeerdata')(signaller.peers);
  var generateIceServers = require('rtc-core/genice');

  // init configurable vars
  var ns = (opts || {}).ns || '';
  var room = (opts || {}).room;
  var debugging = (opts || {}).debug;
  var allowJoin = !(opts || {}).manualJoin;
  var profile = {};
  var announced = false;

  // Schemes allow customisation about how connections are made
  // In particular, providing schemes allows providing different sets of ICE servers
  // between peers
  var schemes = require('./lib/schemes')(signaller, opts);

  // collect the local streams
  var localStreams = [];

  // create the calls map
  var calls = signaller.calls = require('./lib/calls')(signaller, opts);

  // create the known data channels registry
  var channels = {};
  var pending = {};
  // Reconnecting indicates peers that are in the process of reconnecting
  var reconnecting = {};

  // save the plugins passed to the signaller
  var plugins = signaller.plugins = (opts || {}).plugins || [];
  var plugin = detectPlugin(plugins);
  var pluginReady;

  // check how many local streams have been expected (default: 0)
  var expectedLocalStreams = parseInt((opts || {}).expectedLocalStreams, 10) || 0;
  var announceTimer = 0;
  var updateTimer = 0;
  var CLOSED_STATES = ['failed', 'closed', 'disconnected'];

  function checkReadyToAnnounce() {
    clearTimeout(announceTimer);
    // if we have already announced do nothing!
    if (announced) {
      return;
    }

    if (!allowJoin) {
      return;
    }

    // if we have a plugin but it's not initialized we aren't ready
    if (plugin && (!pluginReady)) {
      return;
    }

    // if we are waiting for a set number of streams, then wait until we have
    // the required number
    if (expectedLocalStreams && localStreams.length < expectedLocalStreams) {
      return;
    }

    // announce ourselves to our new friend
    announceTimer = setTimeout(function () {
      var data = extend({ room: room }, profile);

      // announce and emit the local announce event
      signaller.announce(data);
      announced = true;
    }, 0);
  }

  function connect(id, connectOpts) {
    debug('connecting to ' + id);
    if (!id) return debug('invalid target peer ID');
    if (pending[id]) {
      return debug('a connection is already pending for ' + id + ', as of ' + (Date.now() - pending[id]) + 'ms ago');
    }
    connectOpts = connectOpts || {};

    var scheme = schemes.get(connectOpts.scheme, true);
    var data = getPeerData(id);
    var pc;
    var monitor;
    var call;
    // if the room is not a match, abort
    if (data.room !== room) {
      return debug('mismatching room, expected: ' + room + ', got: ' + (data && data.room));
    }
    if (data.id !== id) {
      return debug('mismatching ids, expected: ' + id + ', got: ' + data.id);
    }

    // Allow prevention of connections if required
    if (scheme && typeof scheme.allowConnection === 'function' && !scheme.allowConnection(id, data)) {
      signaller('peer:rejected', id, data, scheme);
      return debug('peer connection was rejected for ' + id);
    }

    pending[id] = Date.now();

    // end any call to this id so we know we are starting fresh
    calls.end(id);

    signaller('peer:prepare', id, data, scheme);

    function clearPending(msg) {
      debug('connection for ' + id + ' is no longer pending [' + (msg || 'no reason') + '], connect available again');
      if (pending[id]) {
        delete pending[id];
      }
      if (reconnecting[id]) {
        delete reconnecting[id];
      }
    }

    // Regenerate ICE servers (or use existing cached ICE)
    generateIceServers(extend({ targetPeer: id }, opts, (scheme || {}).connection), function (err, iceServers) {
      if (err) {
        signaller('icegeneration:error', id, scheme && scheme.id, err);
      } else {
        signaller('peer:iceservers', id, scheme && scheme.id, iceServers || []);
      }

      // Generate the connection options for the provided options and default values
      var connectionOptions = extend({
        sdpSemantics: sdpSupport.detectTargetSemantics(signaller, data)
      }, opts, { iceServers: iceServers });

      // create a peer connection
      // iceServers that have been created using genice taking precendence
      pc = rtc.createConnection(connectionOptions, (opts || {}).constraints);

      signaller('peer:connect', id, pc, data);

      // add this connection to the calls list
      call = calls.create(id, pc, data, connectionOptions);

      // add the local streams/tracks
      localStreams.forEach(function (stream) {
        if (pc.addTrack){
          stream.getAudioTracks().concat(stream.getVideoTracks()).forEach(
            track => pc.addTrack(track, stream));
        }
        else {
          pc.addStream(stream);
        }

        // Fire the couple event
        signaller('peer:localMediaAdded', id, pc, data);
      });

      // add any necessary data channels
      Object.keys(channels).forEach(function (label) {
        addDataChannelToConnection(pc, id, label);
      });
      
      // Watch for any datachannel creation from in-band negotiated channels
      pc.ondatachannel = function (evt) {
        var channel = evt && evt.channel;

        // if we have no channel, abort
        if (!channel) {
          return;
        }

        if (channels[channel.label] !== undefined) {
          gotPeerChannel(channel, pc, getPeerData(id));
        }
      };

      // couple the connections
      debug('coupling ' + signaller.id + ' to ' + id);
      monitor = rtc.couple(pc, id, signaller, extend({}, opts, {
        logger: mbus('pc.' + id, signaller)
      }));

      // Apply the monitor to the call
      call.monitor = monitor;

      // once active, trigger the peer connect event
      monitor.once('connected', function () {
        clearPending('connected successfully');
        calls.start(id, pc, data);
      });
      monitor.once('closed', function () {
        clearPending('closed');
        calls.end(id);
      });
      monitor.once('aborted', function () {
        clearPending('aborted');
      });
      monitor.once('failed', function () {
        clearPending('failed');
        calls.fail(id);
      });

      // The following states are intermediate states based on the disconnection timer
      monitor.once('failing', calls.failing.bind(null, id));
      monitor.once('recovered', calls.recovered.bind(null, id));

      // Fire the couple event
      signaller('peer:couple', id, pc, data, monitor);

      // if we are the master connnection, create the offer
      // NOTE: this only really for the sake of politeness, as rtc couple
      // implementation handles the slave attempting to create an offer
      if (signaller.isMaster(id)) {
        monitor.createOffer();
      }

      signaller('peer:prepared', id);
    });
  }

  function getActiveCall(peerId) {
    var call = calls.get(peerId);

    if (!call) {
      throw new Error('No active call for peer: ' + peerId);
    }

    return call;
  }

  /**
    Adds a data channel to a peer connection, if required.
    The channel will be added to the connection under the following situations:
    1. This is the master peer in the connection to `targetPeer`
    2. `opts.negotiated` is true
   */
  function addDataChannelToConnection(pc, targetPeer, label) {
    if (!pc || !targetPeer || !label) return;
    var channelId = Object.keys(channels).indexOf(label);
    if (channelId === -1) return console.warn('Channel ID not found');    
    var channelOpts = channels[label] || {};
    var negotiated = !!channelOpts.negotiated;
    // If negotiated, allow auto generation of the channel ID
    if (negotiated) {
      channelOpts = extend({ id: channelId }, channelOpts);
    }
    
    // If not negotiated, we have to be the master in order to create
    if (!negotiated && !signaller.isMaster(targetPeer)) return;

    var data = getPeerData(targetPeer);
    gotPeerChannel(pc.createDataChannel(label, channelOpts), pc, data);
  }

  function gotPeerChannel(channel, pc, data) {
    var channelMonitor;
    var channelConnectionTimer;

    function channelReady() {
      var call = calls.get(data.id);
      var args = [data.id, channel, data, pc];

      // decouple the channel.onopen listener
      debug('reporting channel "' + channel.label + '" ready, have call: ' + (!!call));
      clearInterval(channelMonitor);
      clearTimeout(channelConnectionTimer);
      channel.onopen = null;

      // save the channel
      if (call) {
        call.channels.set(channel.label, channel);

        // Remove the channel from the call on close, and emit the required events
        channel.onclose = function () {
          debug('channel "' + channel.label + '" to ' + data.id + ' has closed');
          var args = [data.id, channel, channel.label];
          // decouple the events
          channel.onopen = null;
          // Remove the channel entry
          call.channels.remove(channel.label);

          // emit the plain channel:closed event
          signaller.apply(signaller, ['channel:closed'].concat(args));

          // emit the labelled version of the event
          signaller.apply(signaller, ['channel:closed:' + channel.label].concat(args));
        }
      }

      // trigger the %channel.label%:open event
      debug('triggering channel:opened events for channel: ' + channel.label);

      // emit the plain channel:opened event
      signaller.apply(signaller, ['channel:opened'].concat(args));

      // emit the channel:opened:%label% eve
      signaller.apply(
        signaller,
        ['channel:opened:' + channel.label].concat(args)
      );
    }

    // If the channel has failed to create for some reason, recreate the channel
    function recreateChannel() {
      debug('recreating data channel: ' + channel.label);
      // Clear timers
      clearInterval(channelMonitor);
      clearTimeout(channelConnectionTimer);

      // Force the channel to close if it is in an open state
      if (['connecting', 'open'].indexOf(channel.readyState) !== -1) {
        channel.close();
      }

      // Recreate the channel using the cached options
      signaller.createDataChannel(channel.label, channels[channel.label])
    }

    debug('channel ' + channel.label + ' discovered for peer: ' + data.id);
    if (channel.readyState === 'open') {
      return channelReady();
    }

    debug('channel not ready, current state = ' + channel.readyState);
    channel.onopen = channelReady;

    // monitor the channel open (don't trust the channel open event just yet)
    channelMonitor = setInterval(function () {
      debug('checking channel state, current state = ' + channel.readyState + ', connection state ' + pc.iceConnectionState);
      if (channel.readyState === 'open') {
        channelReady();
      }
      // If the underlying connection has failed/closed, or if the ready state of the channel has transitioned to a closure
      // state, then terminate the monitor
      else if (CLOSED_STATES.indexOf(pc.iceConnectionState) !== -1 || CLOSED_STATES.indexOf(channel.readyState) !== -1) {
        debug('connection or channel has terminated, cancelling channel monitor');
        clearInterval(channelMonitor);
        clearTimeout(channelConnectionTimer);
      }
      // If the connection has connected, but the channel is stuck in the connecting state
      // start a timer. If this expires, then we will attempt to created the data channel
      else if (pc.iceConnectionState === 'connected' && channel.readyState === 'connecting' && !channelConnectionTimer) {
        channelConnectionTimer = setTimeout(function () {
          if (channel.readyState !== 'connecting') return;
          var args = [data.id, channel, data, pc];

          // emit the plain channel:failed event
          signaller.apply(signaller, ['channel:failed'].concat(args));

          // emit the channel:opened:%label% eve
          signaller.apply(
            signaller,
            ['channel:failed:' + channel.label].concat(args)
          );

          // Recreate the channel
          return recreateChannel();
        }, (opts || {}).channelTimeout || 2000);
      }

    }, 500);
  }

  function initPlugin() {
    return plugin && plugin.init(opts, function (err) {
      if (err) {
        return console.error('Could not initialize plugin: ', err);
      }

      pluginReady = true;
      checkReadyToAnnounce();
    });
  }

  function handleLocalAnnounce(data) {
    // if we send an announce with an updated room then update our local room name
    if (data && typeof data.room != 'undefined') {
      room = data.room;
    }
  }

  function handlePeerFilter(id, data) {
    // only connect with the peer if we are ready
    data.allow = data.allow && (localStreams.length >= expectedLocalStreams);
  }

  function handlePeerUpdate(data) {
    // Do not allow peer updates if we are not announced
    if (!announced) return;

    var id = data && data.id;
    var activeCall = id && calls.get(id);

    // if we have received an update for a peer that has no active calls,
    // and is not currently in the process of setting up a call
    // then pass this onto the announce handler
    if (id && (!activeCall) && !pending[id] && !reconnecting[id]) {
      debug('received peer update from peer ' + id + ', no active calls');
      signaller('peer:autoreconnect', id);
      return signaller.reconnectTo(id);
    }
  }

  function handlePeerLeave(data) {
    var id = data && data.id;
    if (id) {
      delete pending[id];
      calls.end(id);
    }
  }

  function handlePeerClose(id) {
    if (!announced) return;
    delete pending[id];
    debug('call has from ' + signaller.id + ' to ' + id + ' has ended, reannouncing');
    return signaller.profile();
  }

  // if the room is not defined, then generate the room name
  if (!room) {
    // if the hash is not assigned, then create a random hash value
    if (typeof location != 'undefined' && (!hash)) {
      hash = location.hash = '' + (Math.pow(2, 53) * Math.random());
    }

    room = ns + '#' + hash;
  }

  if (debugging) {
    rtc.logger.enable.apply(rtc.logger, Array.isArray(debug) ? debugging : ['*']);
  }

  signaller.on('peer:announce', function (data) {
    connect(data.id, { scheme: data.scheme });
  });

  signaller.on('peer:update', handlePeerUpdate);

  signaller.on('message:reconnect', function (data, sender, message) {
    debug('received reconnect message');

    // Sender arguments are always last
    if (!message) {
      message = sender;
      sender = data;
      data = undefined;
    }
    if (!sender.id) return console.warn('Could not reconnect, no sender ID');

    // Abort any current calls
    calls.abort(sender.id);
    delete reconnecting[sender.id];
    signaller('peer:reconnecting', sender.id, data || {});
    // Reapply sender information in case aborts caused it to be removed
    signaller.peers.set(sender.id, sender);
    connect(sender.id, data || {});

    // If this is the master, echo the reconnection back to the peer instructing that
    // the reconnection has been accepted and to connect
    var isMaster = signaller.isMaster(sender.id);
    if (isMaster) {
      signaller.to(sender.id).send('/reconnect', data || {});
    }
  });

  /**
    ### Quickconnect Broadcast and Data Channel Helper Functions

    The following are functions that are patched into the `rtc-signaller`
    instance that make working with and creating functional WebRTC applications
    a lot simpler.

  **/

  /**
    #### addStream

    ```
    addStream(stream:MediaStream) => qc
    ```

    Add the stream to active calls and also save the stream so that it
    can be added to future calls.

  **/
  signaller.broadcast = signaller.addStream = function (stream) {
    localStreams.push(stream);

    // if we have any active calls, then add the stream
    calls.keys().forEach(function (id) {
      // get call obj
      var call = calls.get(id);

      // check addTrack or addStream
      if (call.pc.addTrack) {

        // Firefox + Chrome 64 and above
        stream.getAudioTracks().concat(stream.getVideoTracks()).forEach(function (track) {
          debug('addTrack trackId:',track.id, ',streamId:',stream.id);
          call.pc.addTrack(track, stream);
        });
      } else {
        // Upto chrome 63
        call.pc.addStream(stream);
      }

      signaller('peer:localMediaAdded', id, call.pc);
    });

    checkReadyToAnnounce();
    return signaller;
  };


  /**
    #### addTrack

    The `addTrack` function terminates do the pure WebRTC addTrack logic.
  **/
  signaller.addTrack = function (track, stream) {
    if(localStreams.indexOf(stream) == -1){
      localStreams.push(stream);
    }

    // if we have any active calls, then add the stream
    calls.values().forEach(function (call) {
      call.pc.addTrack(track, stream);
    });

    checkReadyToAnnounce();
    return signaller;
  };

  /**
    #### replaceTrack

    The `replaceTrack` function call web WebRTC API for replaceTrack (sender)
    replaceTrack(newTrack, oldTrackId)
  **/
  signaller.replaceTrack = function (track, trackId) {

    // all tracks
    var allTracks = [];
    localStreams.forEach(s=>{
      allTracks = allTracks.concat(s.getTracks());
    });


    // find existing track
    var removingTrack = allTracks.find(t=>t.id === trackId);
    if (removingTrack){
      var replacingStream = localStreams.find(s=>
        s.getTracks().find(t=>t === removingTrack));

      // removing 
      replacingStream.removeTrack(removingTrack);

      // add new track
      replacingStream.addTrack(track);
    }
    else{
      console.error('cannot find the track to be replaced:', trackId, track);
      return;
    }
    

    // replace pc track
    calls.values().forEach(function(call) {
      var sender = call.pc.getSenders().find(function(s) {
        return s.track.id === removingTrack.id;
      });

      if (sender){
        // found the sender, then replace the track
        sender.replaceTrack(track);
      }
      else{
        console.error('cannot find sender:', trackId, track);
      }
    });

    return signaller;
  }; 


  /**
    #### endCall

    The `endCall` function terminates the active call with the given ID.
    If a call with the call ID does not exist it will do nothing.
  **/
  signaller.endCall = calls.end;

  /**
    #### endCalls()

    The `endCalls` function terminates all the active calls that have been
    created in this quickconnect instance.  Calling `endCalls` does not
    kill the connection with the signalling server.

  **/
  signaller.endCalls = function () {
    calls.keys().forEach(calls.end);
  };

  /**
    #### close()

    The `close` function provides a convenient way of closing all associated
    peer connections.  This function simply uses the `endCalls` function and
    the underlying `leave` function of the signaller to do a "full cleanup"
    of all connections.
  **/
  signaller.close = function () {
    // We are no longer announced
    announced = false;

    // Remove any pending update annoucements
    if (updateTimer) clearTimeout(updateTimer);

    // Cleanup
    signaller.endCalls();
    signaller.leave();
  };

  /**
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

  **/
  signaller.createDataChannel = function (label, opts) {
    // save the data channel opts in the local channels dictionary
    channels[label] = opts || null;

    // create a channel on all existing calls
    calls.keys().forEach(function (peerId) {
      var call = calls.get(peerId);
      var dc;

      // if we are the master connection, create the data channel
      if (call && call.pc) {
        var existingChannel = call.channels.get(label);
        if (existingChannel && existingChannel.readyState !== 'closed') {
          return debug('Attempted to create data channel "' + label + '" for a call to ' + peerId + ' but an open channel already exists');
        }
        // Add the datachannel (if required)
        addDataChannelToConnection(call.pc, peerId, label);
      }
    });    

    return signaller;
  };

  /**
    #### join()

    The `join` function is used when `manualJoin` is set to true when creating
    a quickconnect instance.  Call the `join` function once you are ready to
    join the signalling server and initiate connections with other people.

  **/
  signaller.join = function () {
    allowJoin = true;
    checkReadyToAnnounce();
  };

  /**
    #### `get(name)`

    The `get` function returns the property value for the specified property name.
  **/
  signaller.get = function (name) {
    return profile[name];
  };

  /**
    #### `getLocalStreams()`

    Return a copy of the local streams that have currently been configured
  **/
  signaller.getLocalStreams = function () {
    return [].concat(localStreams);
  };

  /**
    #### reactive()

    Flag that this session will be a reactive connection.

  **/
  signaller.reactive = function () {
    // add the reactive flag
    opts = opts || {};
    opts.reactive = true;

    // chain
    return signaller;
  };

  /**
    #### registerScheme

    Registers a connection scheme for use, and check it for validity
   **/
  signaller.registerScheme = schemes.add;

  /**
   #### getSche,e

   Returns the connection sheme given by ID
  **/
  signaller.getScheme = schemes.get;

  /**
    #### removeStream

    ```
    removeStream(stream:MediaStream)
    ```

    Remove the specified stream from both the local streams that are to
    be connected to new peers, and also from any active calls.

  **/
  signaller.removeStream = function (stream) {

    var localIndex = localStreams.indexOf(stream);

    // remove the stream from any active calls
    calls.values().forEach(function (call) {

      // If `RTCPeerConnection.removeTrack` exists (Firefox), then use that
      // as `RTCPeerConnection.removeStream` is not supported
      if (call.pc.removeTrack) {
        stream.getTracks().forEach(function (track) {
          try {
            call.pc.removeTrack(call.pc.getSenders().find(function (sender) { return sender.track == track; }));
          } catch (e) {
            // When using LocalMediaStreamTracks, this seems to throw an error due to
            // LocalMediaStreamTrack not implementing the RTCRtpSender inteface.
            // Without `removeStream` and with `removeTrack` not allowing for local stream
            // removal, this needs some thought when dealing with FF renegotiation
            console.error('Error removing media track', e);
          }
        });
      }
      // Otherwise we just use `RTCPeerConnection.removeStream`
      else {
        try {
          call.pc.removeStream(stream);
        } catch (e) {
          console.error('Failed to remove media stream', e);
        }
      }
    });

    // remove the stream from the localStreams array
    if (localIndex >= 0) {
      localStreams.splice(localIndex, 1);
    }

    return signaller;
  };

  /**
    #### requestChannel

    ```
    requestChannel(targetId, label, callback)
    ```

    This is a function that can be used to respond to remote peers supplying
    a data channel as part of their configuration.  As per the `receiveStream`
    function this function will either fire the callback immediately if the
    channel is already available, or once the channel has been discovered on
    the call.

  **/
  signaller.requestChannel = function (targetId, label, callback) {
    var call = getActiveCall(targetId);
    var channel = call && call.channels.get(label);

    // if we have then channel trigger the callback immediately
    if (channel) {
      callback(null, channel);
      return signaller;
    }

    // if not, wait for it
    signaller.once('channel:opened:' + label, function (id, dc) {
      callback(null, dc);
    });

    return signaller;
  };

  /**
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
  **/
  signaller.requestStream = function (targetId, idx, callback) {
    var call = getActiveCall(targetId);
    var stream;

    function waitForStream(peerId) {
      if (peerId !== targetId) {
        return;
      }

      // get the stream
      stream = call.pc.getRemoteStreams()[idx];

      // if we have the stream, then remove the listener and trigger the cb
      if (stream) {
        signaller.removeListener('stream:added', waitForStream);
        callback(null, stream);
      }
    }

    // look for the stream in the remote streams of the call
    stream = call.pc.getRemoteStreams()[idx];

    // if we found the stream then trigger the callback
    if (stream) {
      callback(null, stream);
      return signaller;
    }

    // otherwise wait for the stream
    signaller.on('stream:added', waitForStream);
    return signaller;
  };

  /**
    #### profile(data)

    Update the profile data with the attached information, so when
    the signaller announces it includes this data in addition to any
    room and id information.

  **/
  signaller.profile = function (data) {
    extend(profile, data || {});

    // if we have already announced, then reannounce our profile to provide
    // others a `peer:update` event
    if (announced) {
      clearTimeout(updateTimer);
      updateTimer = setTimeout(function () {
        // Check that our announced status hasn't changed
        if (!announced) return;
        debug('[' + signaller.id + '] reannouncing');
        signaller.announce(profile);
      }, (opts || {}).updateDelay || 1000);
    }

    return signaller;
  };

  /**
    #### waitForCall

    ```
    waitForCall(targetId, callback)
    ```

    Wait for a call from the specified targetId.  If the call is already
    active the callback will be fired immediately, otherwise we will wait
    for a `call:started` event that matches the requested `targetId`

  **/
  signaller.waitForCall = function (targetId, callback) {
    var call = calls.get(targetId);

    if (call && call.active) {
      callback(null, call.pc);
      return signaller;
    }

    signaller.on('call:started', function handleNewCall(id) {
      if (id === targetId) {
        signaller.removeListener('call:started', handleNewCall);
        callback(null, calls.get(id).pc);
      }
    });
  };

  /**
    Attempts to reconnect to a certain target peer. It will close any existing
    call to that peer, and restart the connection process
   **/
  signaller.reconnectTo = function (id, reconnectOpts) {
    if (!id) return;
    signaller.to(id).send('/reconnect', reconnectOpts)
    // If this is the master, connect, otherwise the master will send a /reconnect
    // message back instructing the connection to start
    var isMaster = signaller.isMaster(id);
    if (isMaster) {
      // Abort any current calls
      signaller('log', 'aborting call');
      // Preserve peer data
      var peerData = signaller.peers.get(id);
      try {
        calls.abort(id);
      } catch (e) {
        signaller('log', e.message);
      }
      signaller('log', 'call aborted');
      signaller('peer:reconnecting', id, reconnectOpts || {});
      // Reapply peer data in case it was deleted during abort
      signaller.peers.set(id, peerData);
      return connect(id, reconnectOpts);
    }
    // Flag that we are waiting for the master to indicate the reconnection is a go
    else {
      reconnecting[id] = Date.now();
    }
  };

  // if we have an expected number of local streams, then use a filter to
  // check if we should respond
  if (expectedLocalStreams) {
    signaller.on('peer:filter', handlePeerFilter);
  }

  // respond to local announce messages
  signaller.on('local:announce', handleLocalAnnounce);

  // handle ping messages
  signaller.on('message:ping', calls.ping);

  // Handle when a remote peer leaves that the appropriate closing occurs this
  // side as well
  signaller.on('message:leave', handlePeerLeave);

  // When a call:ended, we reannounce ourselves. This offers a degree of failure handling
  // as if a call has dropped unexpectedly (ie. failure/unable to connect) the other peers
  // connected to the signaller will attempt to reconnect
  signaller.on('call:ended', handlePeerClose);

  // if we plugin is active, then initialize it
  if (plugin) {
    initPlugin();
  } else {
    // Test if we are ready to announce
    process.nextTick(function () {
      checkReadyToAnnounce();
    });
  }

  // pass the signaller on
  return signaller;
};
