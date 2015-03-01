(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.quickconnect = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
(function (process){
/* jshint node: true */
'use strict';

var rtc = require('rtc-tools');
var mbus = require('mbus');
var cleanup = require('rtc-tools/cleanup');
var detectPlugin = require('rtc-core/plugin');
var debug = rtc.logger('rtc-quickconnect');
var defaults = require('cog/defaults');
var extend = require('cog/extend');
var getable = require('cog/getable');
var messenger = require('./messenger');
var reTrailingSlash = /\/$/;

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
module.exports = function(signalhost, opts) {
  var hash = typeof location != 'undefined' && location.hash.slice(1);
  var signaller = require('rtc-signaller')(messenger(signalhost), opts);

  // init configurable vars
  var ns = (opts || {}).ns || '';
  var room = (opts || {}).room;
  var debugging = (opts || {}).debug;
  var allowJoin = !(opts || {}).manualJoin;
  var heartbeat = (opts || {}).heartbeat || 2500;
  var profile = {};
  var announced = false;

  // initialise iceServers to undefined
  // we will not announce until these have been properly initialised
  var iceServers;

  // collect the local streams
  var localStreams = [];

  // create the calls map
  var calls = signaller.calls = getable({});

  // create the known data channels registry
  var channels = {};

  // save the plugins passed to the signaller
  var plugins = signaller.plugins = (opts || {}).plugins || [];
  var plugin = detectPlugin(signaller.plugins);
  var pluginReady;

  // check how many local streams have been expected (default: 0)
  var expectedLocalStreams = parseInt((opts || {}).expectedLocalStreams, 10) || 0;
  var announceTimer = 0;
  var heartbeatTimer = 0;
  var updateTimer = 0;

  function callCreate(id, pc) {
    calls.set(id, {
      active: false,
      pc: pc,
      channels: getable({}),
      streams: [],
      lastping: Date.now()
    });
  }

  function callEnd(id) {
    var call = calls.get(id);

    // if we have no data, then do nothing
    if (! call) {
      return;
    }

    debug('ending call to: ' + id);

    // if we have no data, then return
    call.channels.keys().forEach(function(label) {
      var channel = call.channels.get(label);
      var args = [id, channel, label];

      // emit the plain channel:closed event
      signaller.apply(signaller, ['channel:closed'].concat(args));

      // emit the labelled version of the event
      signaller.apply(signaller, ['channel:closed:' + label].concat(args));

      // decouple the events
      channel.onopen = null;
    });

    // trigger stream:removed events for each of the remotestreams in the pc
    call.streams.forEach(function(stream) {
      signaller('stream:removed', id, stream);
    });

    // delete the call data
    calls.delete(id);

    // if we have no more calls, disable the heartbeat
    if (calls.keys().length === 0) {
      hbReset();
    }

    // trigger the call:ended event
    signaller('call:ended', id, call.pc);

    // ensure the peer connection is properly cleaned up
    cleanup(call.pc);
  }

  function callStart(id, pc, data) {
    var call = calls.get(id);
    var streams = [].concat(pc.getRemoteStreams());

    // flag the call as active
    call.active = true;
    call.streams = [].concat(pc.getRemoteStreams());

    pc.onaddstream = createStreamAddHandler(id);
    pc.onremovestream = createStreamRemoveHandler(id);

    debug(signaller.id + ' - ' + id + ' call start: ' + streams.length + ' streams');
    signaller('call:started', id, pc, data);

    // configure the heartbeat timer
    hbInit();

    // examine the existing remote streams after a short delay
    process.nextTick(function() {
      // iterate through any remote streams
      streams.forEach(receiveRemoteStream(id));
    });
  }

  function checkReadyToAnnounce() {
    clearTimeout(announceTimer);
    // if we have already announced do nothing!
    if (announced) {
      return;
    }

    if (! allowJoin) {
      return;
    }

    // if we have a plugin but it's not initialized we aren't ready
    if (plugin && (! pluginReady)) {
      return;
    }

    // if we have no iceServers we aren't ready
    if (! iceServers) {
      return;
    }

    // if we are waiting for a set number of streams, then wait until we have
    // the required number
    if (expectedLocalStreams && localStreams.length < expectedLocalStreams) {
      return;
    }

    // announce ourselves to our new friend
    announceTimer = setTimeout(function() {
      var data = extend({ room: room }, profile);

      // announce and emit the local announce event
      signaller.announce(data);
      announced = true;
    }, 0);
  }

 function connect(id) {
    var data = getPeerData(id);
    var pc;
    var monitor;

    // if the room is not a match, abort
    if (data.room !== room) {
      return;
    }

    // end any call to this id so we know we are starting fresh
    callEnd(id);

    // create a peer connection
    // iceServers that have been created using genice taking precendence
    pc = rtc.createConnection(
      extend({}, opts, { iceServers: iceServers }),
      (opts || {}).constraints
    );

    signaller('peer:connect', data.id, pc, data);

    // add this connection to the calls list
    callCreate(data.id, pc);

    // add the local streams
    localStreams.forEach(function(stream, idx) {
      pc.addStream(stream);
    });

    // add the data channels
    // do this differently based on whether the connection is a
    // master or a slave connection
    if (signaller.isMaster(data.id)) {
      debug('is master, creating data channels: ', Object.keys(channels));

      // create the channels
      Object.keys(channels).forEach(function(label) {
       gotPeerChannel(pc.createDataChannel(label, channels[label]), pc, data);
      });
    }
    else {
      pc.ondatachannel = function(evt) {
        var channel = evt && evt.channel;

        // if we have no channel, abort
        if (! channel) {
          return;
        }

        if (channels[channel.label] !== undefined) {
          gotPeerChannel(channel, pc, getPeerData(id));
        }
      };
    }

    // couple the connections
    debug('coupling ' + signaller.id + ' to ' + data.id);
    monitor = rtc.couple(pc, id, signaller, extend({}, opts, {
      logger: mbus('pc.' + id, signaller)
    }));

    signaller('peer:couple', id, pc, data, monitor);

    // once active, trigger the peer connect event
    monitor.once('connected', callStart.bind(null, id, pc, data))
    monitor.once('closed', callEnd.bind(null, id));

    // if we are the master connnection, create the offer
    // NOTE: this only really for the sake of politeness, as rtc couple
    // implementation handles the slave attempting to create an offer
    if (signaller.isMaster(id)) {
      monitor.createOffer();
    }
  }

  function createStreamAddHandler(id) {
    return function(evt) {
      debug('peer ' + id + ' added stream');
      updateRemoteStreams(id);
      receiveRemoteStream(id)(evt.stream);
    }
  }

  function createStreamRemoveHandler(id) {
    return function(evt) {
      debug('peer ' + id + ' removed stream');
      updateRemoteStreams(id);
      signaller('stream:removed', id, evt.stream);
    };
  }

  function getActiveCall(peerId) {
    var call = calls.get(peerId);

    if (! call) {
      throw new Error('No active call for peer: ' + peerId);
    }

    return call;
  }

  function getPeerData(id) {
    var peer = signaller.peers.get(id);

    return peer && peer.data;
  }

  function gotPeerChannel(channel, pc, data) {
    var channelMonitor;

    function channelReady() {
      var call = calls.get(data.id);
      var args = [ data.id, channel, data, pc ];

      // decouple the channel.onopen listener
      debug('reporting channel "' + channel.label + '" ready, have call: ' + (!!call));
      clearInterval(channelMonitor);
      channel.onopen = null;

      // save the channel
      if (call) {
        call.channels.set(channel.label, channel);
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

    debug('channel ' + channel.label + ' discovered for peer: ' + data.id);
    if (channel.readyState === 'open') {
      return channelReady();
    }

    debug('channel not ready, current state = ' + channel.readyState);
    channel.onopen = channelReady;

    // monitor the channel open (don't trust the channel open event just yet)
    channelMonitor = setInterval(function() {
      debug('checking channel state, current state = ' + channel.readyState);
      if (channel.readyState === 'open') {
        channelReady();
      }
    }, 500);
  }

  function hbInit() {
    // if the heartbeat timer is active, or heartbeat has been disabled (0, false, etc) return
    if (heartbeatTimer || (! heartbeat)) {
      return;
    }

    heartbeatTimer = setInterval(hbSend, heartbeat);
  }

  function hbSend() {
    var tickInactive = (Date.now() - (heartbeat * 4));

    // iterate through our established calls
    calls.keys().forEach(function(id) {
      var call = calls.get(id);

      // if the call ping is too old, end the call
      if (call.lastping < tickInactive) {
        return callEnd(id);
      }

      // send a ping message
      signaller.to(id).send('/ping');
    });
  }

  function hbReset() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = 0;
  }

  function initPlugin() {
    return plugin && plugin.init(opts, function(err) {
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
    var id = data && data.id;
    var activeCall = id && calls.get(id);

    // if we have received an update for a peer that has no active calls,
    // then pass this onto the announce handler
    if (id && (! activeCall)) {
      debug('received peer update from peer ' + id + ', no active calls');
      signaller.to(id).send('/reconnect');
      return connect(id);
    }
  }

  function handlePing(sender) {
    var call = calls.get(sender && sender.id);

    // set the last ping for the data
    if (call) {
      call.lastping = Date.now();
    }
  }

  function receiveRemoteStream(id) {
    var call = calls.get(id);

    return function(stream) {
      signaller('stream:added', id, stream, getPeerData(id));
    };
  }

  function updateRemoteStreams(id) {
    var call = calls.get(id);

    if (call && call.pc) {
      call.streams = [].concat(call.pc.getRemoteStreams());
    }
  }

  // if the room is not defined, then generate the room name
  if (! room) {
    // if the hash is not assigned, then create a random hash value
    if (typeof location != 'undefined' && (! hash)) {
      hash = location.hash = '' + (Math.pow(2, 53) * Math.random());
    }

    room = ns + '#' + hash;
  }

  if (debugging) {
    rtc.logger.enable.apply(rtc.logger, Array.isArray(debug) ? debugging : ['*']);
  }

  signaller.on('peer:announce', function(data) {
    connect(data.id);
  });

  signaller.on('peer:update', handlePeerUpdate);

  signaller.on('message:reconnect', function(sender) {
    connect(sender.id);
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
  signaller.broadcast = signaller.addStream = function(stream) {
    localStreams.push(stream);

    // if we have any active calls, then add the stream
    calls.values().forEach(function(data) {
      data.pc.addStream(stream);
    });

    checkReadyToAnnounce();
    return signaller;
  };

  /**
    #### endCalls()

    The `endCalls` function terminates all the active calls that have been
    created in this quickconnect instance.  Calling `endCalls` does not
    kill the connection with the signalling server.

  **/
  signaller.endCalls = function() {
    calls.keys().forEach(callEnd);
  };

  /**
    #### close()

    The `close` function provides a convenient way of closing all associated
    peer connections.  This function simply uses the `endCalls` function and
    the underlying `leave` function of the signaller to do a "full cleanup"
    of all connections.
  **/
  signaller.close = function() {
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
  signaller.createDataChannel = function(label, opts) {
    // create a channel on all existing calls
    calls.keys().forEach(function(peerId) {
      var call = calls.get(peerId);
      var dc;

      // if we are the master connection, create the data channel
      if (call && call.pc && signaller.isMaster(peerId)) {
        dc = call.pc.createDataChannel(label, opts);
        gotPeerChannel(dc, call.pc, getPeerData(peerId));
      }
    });

    // save the data channel opts in the local channels dictionary
    channels[label] = opts || null;

    return signaller;
  };

  /**
    #### join()

    The `join` function is used when `manualJoin` is set to true when creating
    a quickconnect instance.  Call the `join` function once you are ready to
    join the signalling server and initiate connections with other people.

  **/
  signaller.join = function() {
    allowJoin = true;
    checkReadyToAnnounce();
  };

  /**
    #### `get(name)`

    The `get` function returns the property value for the specified property name.
  **/
  signaller.get = function(name) {
    return profile[name];
  };

  /**
    #### `getLocalStreams()`

    Return a copy of the local streams that have currently been configured
  **/
  signaller.getLocalStreams = function() {
    return [].concat(localStreams);
  };

  /**
    #### reactive()

    Flag that this session will be a reactive connection.

  **/
  signaller.reactive = function() {
    // add the reactive flag
    opts = opts || {};
    opts.reactive = true;

    // chain
    return signaller;
  };

  /**
    #### removeStream

    ```
    removeStream(stream:MediaStream)
    ```

    Remove the specified stream from both the local streams that are to
    be connected to new peers, and also from any active calls.

  **/
  signaller.removeStream = function(stream) {
    var localIndex = localStreams.indexOf(stream);

    // remove the stream from any active calls
    calls.values().forEach(function(call) {
      call.pc.removeStream(stream);
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
  signaller.requestChannel = function(targetId, label, callback) {
    var call = getActiveCall(targetId);
    var channel = call && call.channels.get(label);

    // if we have then channel trigger the callback immediately
    if (channel) {
      callback(null, channel);
      return signaller;
    }

    // if not, wait for it
    signaller.once('channel:opened:' + label, function(id, dc) {
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
  signaller.requestStream = function(targetId, idx, callback) {
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
  signaller.profile = function(data) {
    extend(profile, data);

    // if we have already announced, then reannounce our profile to provide
    // others a `peer:update` event
    if (announced) {
      clearTimeout(updateTimer);
      updateTimer = setTimeout(function() {
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
  signaller.waitForCall = function(targetId, callback) {
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

  // if we have an expected number of local streams, then use a filter to
  // check if we should respond
  if (expectedLocalStreams) {
    signaller.on('peer:filter', handlePeerFilter);
  }

  // respond to local announce messages
  signaller.on('local:announce', handleLocalAnnounce);

  // handle ping messages
  signaller.on('message:ping', handlePing);

  // use genice to find our iceServers
  require('rtc-core/genice')(opts, function(err, servers) {
    if (err) {
      return console.error('could not find iceServers: ', err);
    }

    iceServers = servers;
    checkReadyToAnnounce();
  });

  // if we plugin is active, then initialize it
  if (plugin) {
    initPlugin();
  }

  // pass the signaller on
  return signaller;
};

}).call(this,require('_process'))

},{"./messenger":2,"_process":9,"cog/defaults":3,"cog/extend":4,"cog/getable":5,"mbus":10,"rtc-core/genice":12,"rtc-core/plugin":14,"rtc-signaller":18,"rtc-tools":47,"rtc-tools/cleanup":43}],2:[function(require,module,exports){
module.exports = function(messenger) {
  if (typeof messenger == 'function') {
    return messenger;
  }

  return require('rtc-switchboard-messenger')(messenger);
};

},{"rtc-switchboard-messenger":34}],3:[function(require,module,exports){
/* jshint node: true */
'use strict';

/**
## cog/defaults

```js
var defaults = require('cog/defaults');
```

### defaults(target, *)

Shallow copy object properties from the supplied source objects (*) into
the target object, returning the target object once completed.  Do not,
however, overwrite existing keys with new values:

```js
defaults({ a: 1, b: 2 }, { c: 3 }, { d: 4 }, { b: 5 }));
```

See an example on [requirebin](http://requirebin.com/?gist=6079475).
**/
module.exports = function(target) {
  // ensure we have a target
  target = target || {};

  // iterate through the sources and copy to the target
  [].slice.call(arguments, 1).forEach(function(source) {
    if (! source) {
      return;
    }

    for (var prop in source) {
      if (target[prop] === void 0) {
        target[prop] = source[prop];
      }
    }
  });

  return target;
};
},{}],4:[function(require,module,exports){
/* jshint node: true */
'use strict';

/**
## cog/extend

```js
var extend = require('cog/extend');
```

### extend(target, *)

Shallow copy object properties from the supplied source objects (*) into
the target object, returning the target object once completed:

```js
extend({ a: 1, b: 2 }, { c: 3 }, { d: 4 }, { b: 5 }));
```

See an example on [requirebin](http://requirebin.com/?gist=6079475).
**/
module.exports = function(target) {
  [].slice.call(arguments, 1).forEach(function(source) {
    if (! source) {
      return;
    }

    for (var prop in source) {
      target[prop] = source[prop];
    }
  });

  return target;
};
},{}],5:[function(require,module,exports){
/**
  ## cog/getable

  Take an object and provide a wrapper that allows you to `get` and
  `set` values on that object.

**/
module.exports = function(target) {
  function get(key) {
    return target[key];
  }

  function set(key, value) {
    target[key] = value;
  }

  function remove(key) {
    return delete target[key];
  }

  function keys() {
    return Object.keys(target);
  };

  function values() {
    return Object.keys(target).map(function(key) {
      return target[key];
    });
  };

  if (typeof target != 'object') {
    return target;
  }

  return {
    get: get,
    set: set,
    remove: remove,
    delete: remove,
    keys: keys,
    values: values
  };
};

},{}],6:[function(require,module,exports){
/* jshint node: true */
'use strict';

/**
  ## cog/jsonparse

  ```js
  var jsonparse = require('cog/jsonparse');
  ```

  ### jsonparse(input)

  This function will attempt to automatically detect stringified JSON, and
  when detected will parse into JSON objects.  The function looks for strings
  that look and smell like stringified JSON, and if found attempts to
  `JSON.parse` the input into a valid object.

**/
module.exports = function(input) {
  var isString = typeof input == 'string' || (input instanceof String);
  var reNumeric = /^\-?\d+\.?\d*$/;
  var shouldParse ;
  var firstChar;
  var lastChar;

  if ((! isString) || input.length < 2) {
    if (isString && reNumeric.test(input)) {
      return parseFloat(input);
    }

    return input;
  }

  // check for true or false
  if (input === 'true' || input === 'false') {
    return input === 'true';
  }

  // check for null
  if (input === 'null') {
    return null;
  }

  // get the first and last characters
  firstChar = input.charAt(0);
  lastChar = input.charAt(input.length - 1);

  // determine whether we should JSON.parse the input
  shouldParse =
    (firstChar == '{' && lastChar == '}') ||
    (firstChar == '[' && lastChar == ']') ||
    (firstChar == '"' && lastChar == '"');

  if (shouldParse) {
    try {
      return JSON.parse(input);
    }
    catch (e) {
      // apparently it wasn't valid json, carry on with regular processing
    }
  }


  return reNumeric.test(input) ? parseFloat(input) : input;
};
},{}],7:[function(require,module,exports){
/* jshint node: true */
'use strict';

/**
  ## cog/logger

  ```js
  var logger = require('cog/logger');
  ```

  Simple browser logging offering similar functionality to the
  [debug](https://github.com/visionmedia/debug) module.

  ### Usage

  Create your self a new logging instance and give it a name:

  ```js
  var debug = logger('phil');
  ```

  Now do some debugging:

  ```js
  debug('hello');
  ```

  At this stage, no log output will be generated because your logger is
  currently disabled.  Enable it:

  ```js
  logger.enable('phil');
  ```

  Now do some more logger:

  ```js
  debug('Oh this is so much nicer :)');
  // --> phil: Oh this is some much nicer :)
  ```

  ### Reference
**/

var active = [];
var unleashListeners = [];
var targets = [ console ];

/**
  #### logger(name)

  Create a new logging instance.
**/
var logger = module.exports = function(name) {
  // initial enabled check
  var enabled = checkActive();

  function checkActive() {
    return enabled = active.indexOf('*') >= 0 || active.indexOf(name) >= 0;
  }

  // register the check active with the listeners array
  unleashListeners[unleashListeners.length] = checkActive;

  // return the actual logging function
  return function() {
    var args = [].slice.call(arguments);

    // if we have a string message
    if (typeof args[0] == 'string' || (args[0] instanceof String)) {
      args[0] = name + ': ' + args[0];
    }

    // if not enabled, bail
    if (! enabled) {
      return;
    }

    // log
    targets.forEach(function(target) {
      target.log.apply(target, args);
    });
  };
};

/**
  #### logger.reset()

  Reset logging (remove the default console logger, flag all loggers as
  inactive, etc, etc.
**/
logger.reset = function() {
  // reset targets and active states
  targets = [];
  active = [];

  return logger.enable();
};

/**
  #### logger.to(target)

  Add a logging target.  The logger must have a `log` method attached.

**/
logger.to = function(target) {
  targets = targets.concat(target || []);

  return logger;
};

/**
  #### logger.enable(names*)

  Enable logging via the named logging instances.  To enable logging via all
  instances, you can pass a wildcard:

  ```js
  logger.enable('*');
  ```

  __TODO:__ wildcard enablers
**/
logger.enable = function() {
  // update the active
  active = active.concat([].slice.call(arguments));

  // trigger the unleash listeners
  unleashListeners.forEach(function(listener) {
    listener();
  });

  return logger;
};
},{}],8:[function(require,module,exports){
/* jshint node: true */
'use strict';

/**
  ## cog/throttle

  ```js
  var throttle = require('cog/throttle');
  ```

  ### throttle(fn, delay, opts)

  A cherry-pickable throttle function.  Used to throttle `fn` to ensure
  that it can be called at most once every `delay` milliseconds.  Will
  fire first event immediately, ensuring the next event fired will occur
  at least `delay` milliseconds after the first, and so on.

**/
module.exports = function(fn, delay, opts) {
  var lastExec = (opts || {}).leading !== false ? 0 : Date.now();
  var trailing = (opts || {}).trailing;
  var timer;
  var queuedArgs;
  var queuedScope;

  // trailing defaults to true
  trailing = trailing || trailing === undefined;
  
  function invokeDefered() {
    fn.apply(queuedScope, queuedArgs || []);
    lastExec = Date.now();
  }

  return function() {
    var tick = Date.now();
    var elapsed = tick - lastExec;

    // always clear the defered timer
    clearTimeout(timer);

    if (elapsed < delay) {
      queuedArgs = [].slice.call(arguments, 0);
      queuedScope = this;

      return trailing && (timer = setTimeout(invokeDefered, delay - elapsed));
    }

    // call the function
    lastExec = tick;
    fn.apply(this, arguments);
  };
};
},{}],9:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};
var queue = [];
var draining = false;

function drainQueue() {
    if (draining) {
        return;
    }
    draining = true;
    var currentQueue;
    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        var i = -1;
        while (++i < len) {
            currentQueue[i]();
        }
        len = queue.length;
    }
    draining = false;
}
process.nextTick = function (fun) {
    queue.push(fun);
    if (!draining) {
        setTimeout(drainQueue, 0);
    }
};

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],10:[function(require,module,exports){
var reDelim = /[\.\:]/;

/**
  # mbus

  If Node's EventEmitter and Eve were to have a child, it might look something like this.
  No wildcard support at this stage though...

  ## Example Usage

  <<< docs/usage.md

  ## Reference

  ### `mbus(namespace?, parent?, scope?)`

  Create a new message bus with `namespace` inheriting from the `parent`
  mbus instance.  If events from this message bus should be triggered with
  a specific `this` scope, then specify it using the `scope` argument.

**/

var createBus = module.exports = function(namespace, parent, scope) {
  var registry = {};
  var feeds = [];

  function bus(name) {
    var args = [].slice.call(arguments, 1);
    var delimited = normalize(name);
    var handlers = registry[delimited] || [];
    var results;

    // send through the feeds
    feeds.forEach(function(feed) {
      feed({ name: delimited, args: args });
    });

    // run the registered handlers
    results = [].concat(handlers).map(function(handler) {
      return handler.apply(scope || this, args);
    });

    // run the parent handlers
    if (bus.parent) {
      results = results.concat(
        bus.parent.apply(
          scope || this,
          [(namespace ? namespace + '.' : '') + delimited].concat(args)
        )
      );
    }

    return results;
  }

  /**
    ### `mbus#clear()`

    Reset the handler registry, which essential deregisters all event listeners.

    _Alias:_ `removeAllListeners`
  **/
  function clear(name) {
    // if we have a name, reset handlers for that handler
    if (name) {
      delete registry[normalize(name)];
    }
    // otherwise, reset the entire handler registry
    else {
      registry = {};
    }
  }

  /**
    ### `mbus#feed(handler)`

    Attach a handler function that will see all events that are sent through
    this bus in an "object stream" format that matches the following format:

    ```
    { name: 'event.name', args: [ 'event', 'args' ] }
    ```

    The feed function returns a function that can be called to stop the feed
    sending data.

  **/
  function feed(handler) {
    function stop() {
      feeds.splice(feeds.indexOf(handler), 1);
    }

    feeds.push(handler);
    return stop;
  }

  function normalize(name) {
    return (Array.isArray(name) ? name : name.split(reDelim)).join('.');
  }

  /**
    ### `mbus#off(name, handler)`

    Deregister an event handler.
  **/
  function off(name, handler) {
    var handlers = registry[normalize(name)] || [];
    var idx = handlers ? handlers.indexOf(handler._actual || handler) : -1;

    if (idx >= 0) {
      handlers.splice(idx, 1);
    }
  }

  /**
    ### `mbus#on(name, handler)`

    Register an event handler for the event `name`.

  **/
  function on(name, handler) {
    var handlers;

    name = normalize(name);
    handlers = registry[name];

    if (handlers) {
      handlers.push(handler);
    }
    else {
      registry[name] = [ handler ];
    }

    return bus;
  }


  /**
    ### `mbus#once(name, handler)`

    Register an event handler for the event `name` that will only
    trigger once (i.e. the handler will be deregistered immediately after
    being triggered the first time).

  **/
  function once(name, handler) {
    function handleEvent() {
      var result = handler.apply(this, arguments);

      bus.off(name, handleEvent);
      return result;
    }

    handler._actual = handleEvent;
    return on(name, handleEvent);
  }

  if (typeof namespace == 'function') {
    parent = namespace;
    namespace = '';
  }

  namespace = normalize(namespace || '');

  bus.clear = bus.removeAllListeners = clear;
  bus.feed = feed;
  bus.on = bus.addListener = on;
  bus.once = once;
  bus.off = bus.removeListener = off;
  bus.parent = parent || (namespace && createBus());

  return bus;
};

},{}],11:[function(require,module,exports){
/* jshint node: true */
/* global window: false */
/* global navigator: false */

'use strict';

var browser = require('detect-browser');

/**
  ### `rtc-core/detect`

  A browser detection helper for accessing prefix-free versions of the various
  WebRTC types.

  ### Example Usage

  If you wanted to get the native `RTCPeerConnection` prototype in any browser
  you could do the following:

  ```js
  var detect = require('rtc-core/detect'); // also available in rtc/detect
  var RTCPeerConnection = detect('RTCPeerConnection');
  ```

  This would provide whatever the browser prefixed version of the
  RTCPeerConnection is available (`webkitRTCPeerConnection`,
  `mozRTCPeerConnection`, etc).
**/
var detect = module.exports = function(target, opts) {
  var attach = (opts || {}).attach;
  var prefixIdx;
  var prefix;
  var testName;
  var hostObject = this || (typeof window != 'undefined' ? window : undefined);

  // initialise to default prefixes
  // (reverse order as we use a decrementing for loop)
  var prefixes = ((opts || {}).prefixes || ['ms', 'o', 'moz', 'webkit']).concat('');

  // if we have no host object, then abort
  if (! hostObject) {
    return;
  }

  // iterate through the prefixes and return the class if found in global
  for (prefixIdx = prefixes.length; prefixIdx--; ) {
    prefix = prefixes[prefixIdx];

    // construct the test class name
    // if we have a prefix ensure the target has an uppercase first character
    // such that a test for getUserMedia would result in a
    // search for webkitGetUserMedia
    testName = prefix + (prefix ?
                            target.charAt(0).toUpperCase() + target.slice(1) :
                            target);

    if (typeof hostObject[testName] != 'undefined') {
      // update the last used prefix
      detect.browser = detect.browser || prefix.toLowerCase();

      if (attach) {
         hostObject[target] = hostObject[testName];
      }

      return hostObject[testName];
    }
  }
};

// detect mozilla (yes, this feels dirty)
detect.moz = typeof navigator != 'undefined' && !!navigator.mozGetUserMedia;

// set the browser and browser version
detect.browser = browser.name;
detect.browserVersion = detect.version = browser.version;

},{"detect-browser":13}],12:[function(require,module,exports){
/**
  ### `rtc-core/genice`

  Respond appropriately to options that are passed to packages like
  `rtc-quickconnect` and trigger a `callback` (error first) with iceServer
  values.

  The function looks for either of the following keys in the options, in
  the following order or precedence:

  1. `ice` - this can either be an array of ice server values or a generator
     function (in the same format as this function).  If this key contains a
     value then any servers specified in the `iceServers` key (2) will be
     ignored.

  2. `iceServers` - an array of ice server values.
**/
module.exports = function(opts, callback) {
  var ice = (opts || {}).ice;
  var iceServers = (opts || {}).iceServers;

  if (typeof ice == 'function') {
    return ice(opts, callback);
  }
  else if (Array.isArray(ice)) {
    return callback(null, [].concat(ice));
  }

  callback(null, [].concat(iceServers || []));
};

},{}],13:[function(require,module,exports){
var browsers = [
  [ 'chrome', /Chrom(?:e|ium)\/([0-9\.]+)(:?\s|$)/ ],
  [ 'firefox', /Firefox\/([0-9\.]+)(?:\s|$)/ ],
  [ 'opera', /Opera\/([0-9\.]+)(?:\s|$)/ ],
  [ 'ie', /Trident\/7\.0.*rv\:([0-9\.]+)\).*Gecko$/ ],
  [ 'ie', /MSIE\s([0-9\.]+);.*Trident\/[4-7].0/ ],
  [ 'ie', /MSIE\s(7\.0)/ ],
  [ 'bb10', /BB10;\sTouch.*Version\/([0-9\.]+)/ ],
  [ 'android', /Android\s([0-9\.]+)/ ],
  [ 'ios', /iPad\;\sCPU\sOS\s([0-9\._]+)/ ],
  [ 'ios',  /iPhone\;\sCPU\siPhone\sOS\s([0-9\._]+)/ ],
  [ 'safari', /Safari\/([0-9\._]+)/ ]
];

var match = browsers.map(match).filter(isMatch)[0];
var parts = match && match[3].split(/[._]/).slice(0,3);

while (parts && parts.length < 3) {
  parts.push('0');
}

// set the name and version
exports.name = match && match[0];
exports.version = parts && parts.join('.');

function match(pair) {
  return pair.concat(pair[1].exec(navigator.userAgent));
}

function isMatch(pair) {
  return !!pair[2];
}

},{}],14:[function(require,module,exports){
var detect = require('./detect');
var requiredFunctions = [
  'init'
];

function isSupported(plugin) {
  return plugin && typeof plugin.supported == 'function' && plugin.supported(detect);
}

function isValid(plugin) {
  var supportedFunctions = requiredFunctions.filter(function(fn) {
    return typeof plugin[fn] == 'function';
  });

  return supportedFunctions.length === requiredFunctions.length;
}

module.exports = function(plugins) {
  return [].concat(plugins || []).filter(isSupported).filter(isValid)[0];
}

},{"./detect":11}],15:[function(require,module,exports){
module.exports = {
  // messenger events
  dataEvent: 'data',
  openEvent: 'open',
  closeEvent: 'close',
  errorEvent: 'error',

  // messenger functions
  writeMethod: 'write',
  closeMethod: 'close',

  // leave timeout (ms)
  leaveTimeout: 3000
};

},{}],16:[function(require,module,exports){
/* jshint node: true */
'use strict';

var extend = require('cog/extend');

/**
  #### announce

  ```
  /announce|%metadata%|{"id": "...", ... }
  ```

  When an announce message is received by the signaller, the attached
  object data is decoded and the signaller emits an `announce` message.

**/
module.exports = function(signaller) {

  function dataAllowed(data) {
    var cloned = extend({ allow: true }, data);
    signaller('peer:filter', data.id, cloned);

    return cloned.allow;
  }

  return function(args, messageType, srcData, srcState, isDM) {
    var data = args[0];
    var peer;

    // if we have valid data then process
    if (data && data.id && data.id !== signaller.id) {
      if (! dataAllowed(data)) {
        return;
      }
      // check to see if this is a known peer
      peer = signaller.peers.get(data.id);

      // trigger the peer connected event to flag that we know about a
      // peer connection. The peer has passed the "filter" check but may
      // be announced / updated depending on previous connection status
      signaller('peer:connected', data.id, data);

      // if the peer is existing, then update the data
      if (peer && (! peer.inactive)) {
        // update the data
        extend(peer.data, data);

        // trigger the peer update event
        return signaller('peer:update', data, srcData);
      }

      // create a new peer
      peer = {
        id: data.id,

        // initialise the local role index
        roleIdx: [data.id, signaller.id].sort().indexOf(data.id),

        // initialise the peer data
        data: {}
      };

      // initialise the peer data
      extend(peer.data, data);

      // reset inactivity state
      clearTimeout(peer.leaveTimer);
      peer.inactive = false;

      // set the peer data
      signaller.peers.set(data.id, peer);

      // if this is an initial announce message (no vector clock attached)
      // then send a announce reply
      if (signaller.autoreply && (! isDM)) {
        signaller
          .to(data.id)
          .send('/announce', signaller.attributes);
      }

      // emit a new peer announce event
      return signaller('peer:announce', data, peer);
    }
  };
};

},{"cog/extend":4}],17:[function(require,module,exports){
/* jshint node: true */
'use strict';

/**
  ### signaller message handlers

**/

module.exports = function(signaller, opts) {
  return {
    announce: require('./announce')(signaller, opts)
  };
};

},{"./announce":16}],18:[function(require,module,exports){
/* jshint node: true */
'use strict';

var detect = require('rtc-core/detect');
var defaults = require('cog/defaults');
var extend = require('cog/extend');
var mbus = require('mbus');
var getable = require('cog/getable');
var uuid = require('cuid');
var pull = require('pull-stream');
var pushable = require('pull-pushable');

// ready state constants
var RS_DISCONNECTED = 0;
var RS_CONNECTING = 1;
var RS_CONNECTED = 2;

// initialise signaller metadata so we don't have to include the package.json
// TODO: make this checkable with some kind of prepublish script
var metadata = {
  version: '5.2.3'
};

/**
  # rtc-signaller

  The `rtc-signaller` module provides a transportless signalling
  mechanism for WebRTC.

  ## Purpose

  <<< docs/purpose.md

  ## Getting Started

  While the signaller is capable of communicating by a number of different
  messengers (i.e. anything that can send and receive messages over a wire)
  it comes with support for understanding how to connect to an
  [rtc-switchboard](https://github.com/rtc-io/rtc-switchboard) out of the box.

  The following code sample demonstrates how:

  <<< examples/getting-started.js

  <<< docs/events.md

  <<< docs/signalflow-diagrams.md

  ## Reference

  The `rtc-signaller` module is designed to be used primarily in a functional
  way and when called it creates a new signaller that will enable
  you to communicate with other peers via your messaging network.

  ```js
  // create a signaller from something that knows how to send messages
  var signaller = require('rtc-signaller')(messenger);
  ```

  As demonstrated in the getting started guide, you can also pass through
  a string value instead of a messenger instance if you simply want to
  connect to an existing `rtc-switchboard` instance.

**/
module.exports = function(messenger, opts) {
  // get the autoreply setting
  var autoreply = (opts || {}).autoreply;
  var autoconnect = (opts || {}).autoconnect;
  var reconnect = (opts || {}).reconnect;

  // initialise the metadata
  var localMeta = {};

  // create the signaller
  var signaller = mbus('', (opts || {}).logger);

  // initialise the id
  var id = signaller.id = (opts || {}).id || uuid();

  // initialise the attributes
  var attributes = signaller.attributes = {
    browser: detect.browser,
    browserVersion: detect.browserVersion,
    id: id,
    agent: 'signaller@' + metadata.version
  };

  // create the peers map
  var peers = signaller.peers = getable({});

  // create the outbound message queue
  var queue = require('pull-pushable')();

  var processor;
  var announceTimer = 0;
  var readyState = RS_DISCONNECTED;

  function announceOnReconnect() {
    signaller.announce();
  }

  function bufferMessage(args) {
    queue.push(createDataLine(args));

    // if we are not connected (and should autoconnect), then attempt connection
    if (readyState === RS_DISCONNECTED && (autoconnect === undefined || autoconnect)) {
      connect();
    }
  }

  function createDataLine(args) {
    return args.map(prepareArg).join('|');
  }

  function createMetadata() {
    return extend({}, localMeta, { id: signaller.id });
  }

  function handleDisconnect() {
    if (reconnect === undefined || reconnect) {
      setTimeout(connect, 50);
    }
  }

  function prepareArg(arg) {
    if (typeof arg == 'object' && (! (arg instanceof String))) {
      return JSON.stringify(arg);
    }
    else if (typeof arg == 'function') {
      return null;
    }

    return arg;
  }

  /**
    ### `signaller.connect()`

    Manually connect the signaller using the supplied messenger.

    __NOTE:__ This should never have to be called if the default setting
    for `autoconnect` is used.
  **/
  var connect = signaller.connect = function() {
    // if we are already connecting then do nothing
    if (readyState === RS_CONNECTING) {
      return;
    }

    // initiate the messenger
    readyState = RS_CONNECTING;
    messenger(function(err, source, sink) {
      if (err) {
        readyState = RS_DISCONNECTED;
        return signaller('error', err);
      }

      // flag as connected
      readyState = RS_CONNECTED;

      // pass messages to the processor
      pull(
        source,

        // monitor disconnection
        pull.through(null, function() {
          readyState = RS_DISCONNECTED;
          signaller('disconnected');
        }),
        pull.drain(processor)
      );

      // pass the queue to the sink
      pull(queue, sink);

      // handle disconnection
      signaller.removeListener('disconnected', handleDisconnect);
      signaller.on('disconnected', handleDisconnect);

      // trigger the connected event
      signaller('connected');
    });
  };

  /**
    ### signaller#send(message, data*)

    Use the send function to send a message to other peers in the current
    signalling scope (if announced in a room this will be a room, otherwise
    broadcast to all peers connected to the signalling server).

  **/
  var send = signaller.send = function() {
    // iterate over the arguments and stringify as required
    // var metadata = { id: signaller.id };
    var args = [].slice.call(arguments);

    // inject the metadata
    args.splice(1, 0, createMetadata());
    bufferMessage(args);
  };

  /**
    ### announce(data?)

    The `announce` function of the signaller will pass an `/announce` message
    through the messenger network.  When no additional data is supplied to
    this function then only the id of the signaller is sent to all active
    members of the messenging network.

    #### Joining Rooms

    To join a room using an announce call you simply provide the name of the
    room you wish to join as part of the data block that you annouce, for
    example:

    ```js
    signaller.announce({ room: 'testroom' });
    ```

    Signalling servers (such as
    [rtc-switchboard](https://github.com/rtc-io/rtc-switchboard)) will then
    place your peer connection into a room with other peers that have also
    announced in this room.

    Once you have joined a room, the server will only deliver messages that
    you `send` to other peers within that room.

    #### Providing Additional Announce Data

    There may be instances where you wish to send additional data as part of
    your announce message in your application.  For instance, maybe you want
    to send an alias or nick as part of your announce message rather than just
    use the signaller's generated id.

    If for instance you were writing a simple chat application you could join
    the `webrtc` room and tell everyone your name with the following announce
    call:

    ```js
    signaller.announce({
      room: 'webrtc',
      nick: 'Damon'
    });
    ```

    #### Announcing Updates

    The signaller is written to distinguish between initial peer announcements
    and peer data updates (see the docs on the announce handler below). As
    such it is ok to provide any data updates using the announce method also.

    For instance, I could send a status update as an announce message to flag
    that I am going offline:

    ```js
    signaller.announce({ status: 'offline' });
    ```

  **/
  signaller.announce = function(data, sender) {

    function sendAnnounce() {
      (sender || send)('/announce', attributes);
      signaller('local:announce', attributes);
    }

    // if we are already connected, then ensure we announce on reconnect
    if (readyState === RS_CONNECTED) {
      // always announce on reconnect
      signaller.removeListener('connected', announceOnReconnect);
      signaller.on('connected', announceOnReconnect);
    }

    clearTimeout(announceTimer);

    // update internal attributes
    extend(attributes, data, { id: signaller.id });

    // send the attributes over the network
    return announceTimer = setTimeout(sendAnnounce, (opts || {}).announceDelay || 10);
  };

  /**
    ### isMaster(targetId)

    A simple function that indicates whether the local signaller is the master
    for it's relationship with peer signaller indicated by `targetId`.  Roles
    are determined at the point at which signalling peers discover each other,
    and are simply worked out by whichever peer has the lowest signaller id
    when lexigraphically sorted.

    For example, if we have two signaller peers that have discovered each
    others with the following ids:

    - `b11f4fd0-feb5-447c-80c8-c51d8c3cced2`
    - `8a07f82e-49a5-4b9b-a02e-43d911382be6`

    They would be assigned roles:

    - `b11f4fd0-feb5-447c-80c8-c51d8c3cced2`
    - `8a07f82e-49a5-4b9b-a02e-43d911382be6` (master)

  **/
  signaller.isMaster = function(targetId) {
    var peer = peers.get(targetId);

    return peer && peer.roleIdx !== 0;
  };

  /**
    ### leave()

    Tell the signalling server we are leaving.  Calling this function is
    usually not required though as the signalling server should issue correct
    `/leave` messages when it detects a disconnect event.

  **/
  signaller.leave = signaller.close = function() {
    // send the leave signal
    send('/leave', { id: id });

    // stop announcing on reconnect
    signaller.removeListener('disconnected', handleDisconnect);
    signaller.removeListener('connected', announceOnReconnect);

    // end our current queue
    queue.end();

    // create a new queue to buffer new messages
    queue = pushable();

    // set connected to false
    readyState = RS_DISCONNECTED;
  };

  /**
    ### metadata(data?)

    Get (pass no data) or set the metadata that is passed through with each
    request sent by the signaller.

    __NOTE:__ Regardless of what is passed to this function, metadata
    generated by the signaller will **always** include the id of the signaller
    and this cannot be modified.
  **/
  signaller.metadata = function(data) {
    if (arguments.length === 0) {
      return extend({}, localMeta);
    }

    localMeta = extend({}, data);
  };

  /**
    ### to(targetId)

    Use the `to` function to send a message to the specified target peer.
    A large parge of negotiating a WebRTC peer connection involves direct
    communication between two parties which must be done by the signalling
    server.  The `to` function provides a simple way to provide a logical
    communication channel between the two parties:

    ```js
    var send = signaller.to('e95fa05b-9062-45c6-bfa2-5055bf6625f4').send;

    // create an offer on a local peer connection
    pc.createOffer(
      function(desc) {
        // set the local description using the offer sdp
        // if this occurs successfully send this to our peer
        pc.setLocalDescription(
          desc,
          function() {
            send('/sdp', desc);
          },
          handleFail
        );
      },
      handleFail
    );
    ```

  **/
  signaller.to = function(targetId) {
    // create a sender that will prepend messages with /to|targetId|
    var sender = function() {
      // get the peer (yes when send is called to make sure it hasn't left)
      var peer = signaller.peers.get(targetId);
      var args;

      if (! peer) {
        throw new Error('Unknown peer: ' + targetId);
      }

      // if the peer is inactive, then abort
      if (peer.inactive) {
        return;
      }

      args = [
        '/to',
        targetId
      ].concat([].slice.call(arguments));

      // inject metadata
      args.splice(3, 0, createMetadata());
      bufferMessage(args);
    };

    return {
      announce: function(data) {
        return signaller.announce(data, sender);
      },

      send: sender,
    };
  };

  // initialise opts defaults
  opts = defaults({}, opts, require('./defaults'));

  // set the autoreply flag
  signaller.autoreply = autoreply === undefined || autoreply;

  // create the processor
  signaller.process = processor = require('./processor')(signaller, opts);

  // autoconnect
  if (autoconnect === undefined || autoconnect) {
    connect();
  }

  return signaller;
};

},{"./defaults":15,"./processor":33,"cog/defaults":3,"cog/extend":4,"cog/getable":5,"cuid":19,"mbus":10,"pull-pushable":20,"pull-stream":27,"rtc-core/detect":11}],19:[function(require,module,exports){
/**
 * cuid.js
 * Collision-resistant UID generator for browsers and node.
 * Sequential for fast db lookups and recency sorting.
 * Safe for element IDs and server-side lookups.
 *
 * Extracted from CLCTR
 * 
 * Copyright (c) Eric Elliott 2012
 * MIT License
 */

/*global window, navigator, document, require, process, module */
(function (app) {
  'use strict';
  var namespace = 'cuid',
    c = 0,
    blockSize = 4,
    base = 36,
    discreteValues = Math.pow(base, blockSize),

    pad = function pad(num, size) {
      var s = "000000000" + num;
      return s.substr(s.length-size);
    },

    randomBlock = function randomBlock() {
      return pad((Math.random() *
            discreteValues << 0)
            .toString(base), blockSize);
    },

    safeCounter = function () {
      c = (c < discreteValues) ? c : 0;
      c++; // this is not subliminal
      return c - 1;
    },

    api = function cuid() {
      // Starting with a lowercase letter makes
      // it HTML element ID friendly.
      var letter = 'c', // hard-coded allows for sequential access

        // timestamp
        // warning: this exposes the exact date and time
        // that the uid was created.
        timestamp = (new Date().getTime()).toString(base),

        // Prevent same-machine collisions.
        counter,

        // A few chars to generate distinct ids for different
        // clients (so different computers are far less
        // likely to generate the same id)
        fingerprint = api.fingerprint(),

        // Grab some more chars from Math.random()
        random = randomBlock() + randomBlock();

        counter = pad(safeCounter().toString(base), blockSize);

      return  (letter + timestamp + counter + fingerprint + random);
    };

  api.slug = function slug() {
    var date = new Date().getTime().toString(36),
      counter,
      print = api.fingerprint().slice(0,1) +
        api.fingerprint().slice(-1),
      random = randomBlock().slice(-2);

      counter = safeCounter().toString(36).slice(-4);

    return date.slice(-2) + 
      counter + print + random;
  };

  api.globalCount = function globalCount() {
    // We want to cache the results of this
    var cache = (function calc() {
        var i,
          count = 0;

        for (i in window) {
          count++;
        }

        return count;
      }());

    api.globalCount = function () { return cache; };
    return cache;
  };

  api.fingerprint = function browserPrint() {
    return pad((navigator.mimeTypes.length +
      navigator.userAgent.length).toString(36) +
      api.globalCount().toString(36), 4);
  };

  // don't change anything from here down.
  if (app.register) {
    app.register(namespace, api);
  } else if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    app[namespace] = api;
  }

}(this.applitude || this));

},{}],20:[function(require,module,exports){
var pull = require('pull-stream')

module.exports = pull.Source(function (onClose) {
  var buffer = [], cbs = [], waiting = [], ended

  function drain() {
    var l
    while(waiting.length && ((l = buffer.length) || ended)) {
      var data = buffer.shift()
      var cb   = cbs.shift()
      waiting.shift()(l ? null : ended, data)
      cb && cb(ended === true ? null : ended)
    }
  }

  function read (end, cb) {
    ended = ended || end
    waiting.push(cb)
    drain()
    if(ended)
      onClose && onClose(ended === true ? null : ended)
  }

  read.push = function (data, cb) {
    if(ended)
      return cb && cb(ended === true ? null : ended)
    buffer.push(data); cbs.push(cb)
    drain()
  }

  read.end = function (end, cb) {
    if('function' === typeof end)
      cb = end, end = true
    ended = ended || end || true;
    if(cb) cbs.push(cb)
    drain()
    if(ended)
      onClose && onClose(ended === true ? null : ended)
  }

  return read
})


},{"pull-stream":21}],21:[function(require,module,exports){

var sources  = require('./sources')
var sinks    = require('./sinks')
var throughs = require('./throughs')
var u        = require('pull-core')

for(var k in sources)
  exports[k] = u.Source(sources[k])

for(var k in throughs)
  exports[k] = u.Through(throughs[k])

for(var k in sinks)
  exports[k] = u.Sink(sinks[k])

var maybe = require('./maybe')(exports)

for(var k in maybe)
  exports[k] = maybe[k]

exports.Duplex  = 
exports.Through = exports.pipeable       = u.Through
exports.Source  = exports.pipeableSource = u.Source
exports.Sink    = exports.pipeableSink   = u.Sink



},{"./maybe":22,"./sinks":24,"./sources":25,"./throughs":26,"pull-core":23}],22:[function(require,module,exports){
var u = require('pull-core')
var prop = u.prop
var id   = u.id
var maybeSink = u.maybeSink

module.exports = function (pull) {

  var exports = {}
  var drain = pull.drain

  var find = 
  exports.find = function (test, cb) {
    return maybeSink(function (cb) {
      var ended = false
      if(!cb)
        cb = test, test = id
      else
        test = prop(test) || id

      return drain(function (data) {
        if(test(data)) {
          ended = true
          cb(null, data)
        return false
        }
      }, function (err) {
        if(ended) return //already called back
        cb(err === true ? null : err, null)
      })

    }, cb)
  }

  var reduce = exports.reduce = 
  function (reduce, acc, cb) {
    
    return maybeSink(function (cb) {
      return drain(function (data) {
        acc = reduce(acc, data)
      }, function (err) {
        cb(err, acc)
      })

    }, cb)
  }

  var collect = exports.collect = exports.writeArray =
  function (cb) {
    return reduce(function (arr, item) {
      arr.push(item)
      return arr
    }, [], cb)
  }

  return exports
}

},{"pull-core":23}],23:[function(require,module,exports){
exports.id = 
function (item) {
  return item
}

exports.prop = 
function (map) {  
  if('string' == typeof map) {
    var key = map
    return function (data) { return data[key] }
  }
  return map
}

exports.tester = function (test) {
  if(!test) return exports.id
  if('object' === typeof test
    && 'function' === typeof test.test)
      return test.test.bind(test)
  return exports.prop(test) || exports.id
}

exports.addPipe = addPipe

function addPipe(read) {
  if('function' !== typeof read)
    return read

  read.pipe = read.pipe || function (reader) {
    if('function' != typeof reader)
      throw new Error('must pipe to reader')
    return addPipe(reader(read))
  }
  read.type = 'Source'
  return read
}

var Source =
exports.Source =
function Source (createRead) {
  function s() {
    var args = [].slice.call(arguments)
    return addPipe(createRead.apply(null, args))
  }
  s.type = 'Source'
  return s
}


var Through =
exports.Through = 
function (createRead) {
  return function () {
    var args = [].slice.call(arguments)
    var piped = []
    function reader (read) {
      args.unshift(read)
      read = createRead.apply(null, args)
      while(piped.length)
        read = piped.shift()(read)
      return read
      //pipeing to from this reader should compose...
    }
    reader.pipe = function (read) {
      piped.push(read) 
      if(read.type === 'Source')
        throw new Error('cannot pipe ' + reader.type + ' to Source')
      reader.type = read.type === 'Sink' ? 'Sink' : 'Through'
      return reader
    }
    reader.type = 'Through'
    return reader
  }
}

var Sink =
exports.Sink = 
function Sink(createReader) {
  return function () {
    var args = [].slice.call(arguments)
    if(!createReader)
      throw new Error('must be createReader function')
    function s (read) {
      args.unshift(read)
      return createReader.apply(null, args)
    }
    s.type = 'Sink'
    return s
  }
}


exports.maybeSink = 
exports.maybeDrain = 
function (createSink, cb) {
  if(!cb)
    return Through(function (read) {
      var ended
      return function (close, cb) {
        if(close) return read(close, cb)
        if(ended) return cb(ended)

        createSink(function (err, data) {
          ended = err || true
          if(!err) cb(null, data)
          else     cb(ended)
        }) (read)
      }
    })()

  return Sink(function (read) {
    return createSink(cb) (read)
  })()
}


},{}],24:[function(require,module,exports){
var drain = exports.drain = function (read, op, done) {

  ;(function next() {
    var loop = true, cbed = false
    while(loop) {
      cbed = false
      read(null, function (end, data) {
        cbed = true
        if(end) {
          loop = false
          done && done(end === true ? null : end)
        }
        else if(op && false === op(data)) {
          loop = false
          read(true, done || function () {})
        }
        else if(!loop){
          next()
        }
      })
      if(!cbed) {
        loop = false
        return
      }
    }
  })()
}

var onEnd = exports.onEnd = function (read, done) {
  return drain(read, null, done)
}

var log = exports.log = function (read, done) {
  return drain(read, function (data) {
    console.log(data)
  }, done)
}


},{}],25:[function(require,module,exports){

var keys = exports.keys =
function (object) {
  return values(Object.keys(object))
}

var once = exports.once =
function (value) {
  return function (abort, cb) {
    if(abort) return cb(abort)
    if(value != null) {
      var _value = value; value = null
      cb(null, _value)
    } else
      cb(true)
  }
}

var values = exports.values = exports.readArray =
function (array) {
  if(!Array.isArray(array))
    array = Object.keys(array).map(function (k) {
      return array[k]
    })
  var i = 0
  return function (end, cb) {
    if(end)
      return cb && cb(end)  
    cb(i >= array.length || null, array[i++])
  }
}


var count = exports.count = 
function (max) {
  var i = 0; max = max || Infinity
  return function (end, cb) {
    if(end) return cb && cb(end)
    if(i > max)
      return cb(true)
    cb(null, i++)
  }
}

var infinite = exports.infinite = 
function (generate) {
  generate = generate || Math.random
  return function (end, cb) {
    if(end) return cb && cb(end)
    return cb(null, generate())
  }
}

var defer = exports.defer = function () {
  var _read, cbs = [], _end

  var read = function (end, cb) {
    if(!_read) {
      _end = end
      cbs.push(cb)
    } 
    else _read(end, cb)
  }
  read.resolve = function (read) {
    if(_read) throw new Error('already resolved')
    _read = read
    if(!_read) throw new Error('no read cannot resolve!' + _read)
    while(cbs.length)
      _read(_end, cbs.shift())
  }
  read.abort = function(err) {
    read.resolve(function (_, cb) {
      cb(err || true)
    })
  }
  return read
}

var empty = exports.empty = function () {
  return function (abort, cb) {
    cb(true)
  }
}

var depthFirst = exports.depthFirst =
function (start, createStream) {
  var reads = []

  reads.unshift(once(start))

  return function next (end, cb) {
    if(!reads.length)
      return cb(true)
    reads[0](end, function (end, data) {
      if(end) {
        //if this stream has ended, go to the next queue
        reads.shift()
        return next(null, cb)
      }
      reads.unshift(createStream(data))
      cb(end, data)
    })
  }
}
//width first is just like depth first,
//but push each new stream onto the end of the queue
var widthFirst = exports.widthFirst = 
function (start, createStream) {
  var reads = []

  reads.push(once(start))

  return function next (end, cb) {
    if(!reads.length)
      return cb(true)
    reads[0](end, function (end, data) {
      if(end) {
        reads.shift()
        return next(null, cb)
      }
      reads.push(createStream(data))
      cb(end, data)
    })
  }
}

//this came out different to the first (strm)
//attempt at leafFirst, but it's still a valid
//topological sort.
var leafFirst = exports.leafFirst = 
function (start, createStream) {
  var reads = []
  var output = []
  reads.push(once(start))
  
  return function next (end, cb) {
    reads[0](end, function (end, data) {
      if(end) {
        reads.shift()
        if(!output.length)
          return cb(true)
        return cb(null, output.shift())
      }
      reads.unshift(createStream(data))
      output.unshift(data)
      next(null, cb)
    })
  }
}


},{}],26:[function(require,module,exports){
(function (process){
var u      = require('pull-core')
var sources = require('./sources')
var sinks = require('./sinks')

var prop   = u.prop
var id     = u.id
var tester = u.tester

var map = exports.map = 
function (read, map) {
  map = prop(map) || id
  return function (end, cb) {
    read(end, function (end, data) {
      var data = !end ? map(data) : null
      cb(end, data)
    })
  }
}

var asyncMap = exports.asyncMap =
function (read, map) {
  if(!map) return read
  return function (end, cb) {
    if(end) return read(end, cb) //abort
    read(null, function (end, data) {
      if(end) return cb(end, data)
      map(data, cb)
    })
  }
}

var paraMap = exports.paraMap =
function (read, map, width) {
  if(!map) return read
  var ended = false, queue = [], _cb

  function drain () {
    if(!_cb) return
    var cb = _cb
    _cb = null
    if(queue.length)
      return cb(null, queue.shift())
    else if(ended && !n)
      return cb(ended)
    _cb = cb
  }

  function pull () {
    read(null, function (end, data) {
      if(end) {
        ended = end
        return drain()
      }
      n++
      map(data, function (err, data) {
        n--

        queue.push(data)
        drain()
      })

      if(n < width && !ended)
        pull()
    })
  }

  var n = 0
  return function (end, cb) {
    if(end) return read(end, cb) //abort
    //continue to read while there are less than 3 maps in flight
    _cb = cb
    if(queue.length || ended)
      pull(), drain()
    else pull()
  }
  return highWaterMark(asyncMap(read, map), width)
}

var filter = exports.filter =
function (read, test) {
  //regexp
  test = tester(test)
  return function next (end, cb) {
    read(end, function (end, data) {
      if(!end && !test(data))
        return next(end, cb)
      cb(end, data)
    })
  }
}

var filterNot = exports.filterNot =
function (read, test) {
  test = tester(test)
  return filter(read, function (e) {
    return !test(e)
  })
}

var through = exports.through = 
function (read, op, onEnd) {
  var a = false
  function once (abort) {
    if(a || !onEnd) return
    a = true
    onEnd(abort === true ? null : abort)
  }

  return function (end, cb) {
    if(end) once(end)
    return read(end, function (end, data) {
      if(!end) op && op(data)
      else once(end)
      cb(end, data)
    })
  }
}

var take = exports.take =
function (read, test) {
  var ended = false
  if('number' === typeof test) {
    var n = test; test = function () {
      return n --
    }
  }

  return function (end, cb) {
    if(ended) return cb(ended)
    if(ended = end) return read(ended, cb)

    read(null, function (end, data) {
      if(ended = ended || end) return cb(ended)
      if(!test(data)) {
        ended = true
        read(true, function (end, data) {
          cb(ended, data)
        })
      }
      else
        cb(null, data)
    })
  }
}

var unique = exports.unique = function (read, field, invert) {
  field = prop(field) || id
  var seen = {}
  return filter(read, function (data) {
    var key = field(data)
    if(seen[key]) return !!invert //false, by default
    else seen[key] = true
    return !invert //true by default
  })
}

var nonUnique = exports.nonUnique = function (read, field) {
  return unique(read, field, true)
}

var group = exports.group =
function (read, size) {
  var ended; size = size || 5
  var queue = []

  return function (end, cb) {
    //this means that the upstream is sending an error.
    if(end) return read(ended = end, cb)
    //this means that we read an end before.
    if(ended) return cb(ended)

    read(null, function next(end, data) {
      if(ended = ended || end) {
        if(!queue.length)
          return cb(ended)

        var _queue = queue; queue = []
        return cb(null, _queue)
      }
      queue.push(data)
      if(queue.length < size)
        return read(null, next)

      var _queue = queue; queue = []
      cb(null, _queue)
    })
  }
}

var flatten = exports.flatten = function (read) {
  var _read
  return function (abort, cb) {
    if(_read) nextChunk()
    else      nextStream()

    function nextChunk () {
      _read(null, function (end, data) {
        if(end) nextStream()
        else    cb(null, data)
      })
    }
    function nextStream () {
      read(null, function (end, stream) {
        if(end)
          return cb(end)
        if(Array.isArray(stream))
          stream = sources.values(stream)
        else if('function' != typeof stream)
          throw new Error('expected stream of streams')
        
        _read = stream
        nextChunk()
      })
    }
  }
}

var prepend =
exports.prepend =
function (read, head) {

  return function (abort, cb) {
    if(head !== null) {
      if(abort)
        return read(abort, cb)
      var _head = head
      head = null
      cb(null, _head)
    } else {
      read(abort, cb)
    }
  }

}

//var drainIf = exports.drainIf = function (op, done) {
//  sinks.drain(
//}

var _reduce = exports._reduce = function (read, reduce, initial) {
  return function (close, cb) {
    if(close) return read(close, cb)
    if(ended) return cb(ended)

    sinks.drain(function (item) {
      initial = reduce(initial, item)
    }, function (err, data) {
      ended = err || true
      if(!err) cb(null, initial)
      else     cb(ended)
    })
    (read)
  }
}

var nextTick = process.nextTick

var highWaterMark = exports.highWaterMark = 
function (read, highWaterMark) {
  var buffer = [], waiting = [], ended, reading = false
  highWaterMark = highWaterMark || 10

  function readAhead () {
    while(waiting.length && (buffer.length || ended))
      waiting.shift()(ended, ended ? null : buffer.shift())
  }

  function next () {
    if(ended || reading || buffer.length >= highWaterMark)
      return
    reading = true
    return read(ended, function (end, data) {
      reading = false
      ended = ended || end
      if(data != null) buffer.push(data)
      
      next(); readAhead()
    })
  }

  nextTick(next)

  return function (end, cb) {
    ended = ended || end
    waiting.push(cb)

    next(); readAhead()
  }
}




}).call(this,require('_process'))

},{"./sinks":24,"./sources":25,"_process":9,"pull-core":23}],27:[function(require,module,exports){
var sources  = require('./sources')
var sinks    = require('./sinks')
var throughs = require('./throughs')
var u        = require('pull-core')

function isFunction (fun) {
  return 'function' === typeof fun
}

function isReader (fun) {
  return fun && (fun.type === "Through" || fun.length === 1)
}
var exports = module.exports = function pull () {
  var args = [].slice.call(arguments)

  if(isReader(args[0]))
    return function (read) {
      args.unshift(read)
      return pull.apply(null, args)
    }

  var read = args.shift()

  //if the first function is a duplex stream,
  //pipe from the source.
  if(isFunction(read.source))
    read = read.source

  function next () {
    var s = args.shift()

    if(null == s)
      return next()

    if(isFunction(s)) return s

    return function (read) {
      s.sink(read)
      //this supports pipeing through a duplex stream
      //pull(a, b, a) "telephone style".
      //if this stream is in the a (first & last position)
      //s.source will have already been used, but this should never be called
      //so that is okay.
      return s.source
    }
  }

  while(args.length)
    read = next() (read)

  return read
}


for(var k in sources)
  exports[k] = u.Source(sources[k])

for(var k in throughs)
  exports[k] = u.Through(throughs[k])

for(var k in sinks)
  exports[k] = u.Sink(sinks[k])

var maybe = require('./maybe')(exports)

for(var k in maybe)
  exports[k] = maybe[k]

exports.Duplex  = 
exports.Through = exports.pipeable       = u.Through
exports.Source  = exports.pipeableSource = u.Source
exports.Sink    = exports.pipeableSink   = u.Sink



},{"./maybe":28,"./sinks":30,"./sources":31,"./throughs":32,"pull-core":29}],28:[function(require,module,exports){
var u = require('pull-core')
var prop = u.prop
var id   = u.id
var maybeSink = u.maybeSink

module.exports = function (pull) {

  var exports = {}
  var drain = pull.drain

  var find =
  exports.find = function (test, cb) {
    return maybeSink(function (cb) {
      var ended = false
      if(!cb)
        cb = test, test = id
      else
        test = prop(test) || id

      return drain(function (data) {
        if(test(data)) {
          ended = true
          cb(null, data)
        return false
        }
      }, function (err) {
        if(ended) return //already called back
        cb(err === true ? null : err, null)
      })

    }, cb)
  }

  var reduce = exports.reduce =
  function (reduce, acc, cb) {

    return maybeSink(function (cb) {
      return drain(function (data) {
        acc = reduce(acc, data)
      }, function (err) {
        cb(err, acc)
      })

    }, cb)
  }

  var collect = exports.collect = exports.writeArray =
  function (cb) {
    return reduce(function (arr, item) {
      arr.push(item)
      return arr
    }, [], cb)
  }

  var concat = exports.concat =
  function (cb) {
    return reduce(function (a, b) {
      return a + b
    }, '', cb)
  }

  return exports
}

},{"pull-core":29}],29:[function(require,module,exports){
arguments[4][23][0].apply(exports,arguments)
},{"dup":23}],30:[function(require,module,exports){
var drain = exports.drain = function (read, op, done) {

  ;(function next() {
    var loop = true, cbed = false
    while(loop) {
      cbed = false
      read(null, function (end, data) {
        cbed = true
        if(end) {
          loop = false
          if(done) done(end === true ? null : end)
          else if(end && end !== true)
            throw end
        }
        else if(op && false === op(data)) {
          loop = false
          read(true, done || function () {})
        }
        else if(!loop){
          next()
        }
      })
      if(!cbed) {
        loop = false
        return
      }
    }
  })()
}

var onEnd = exports.onEnd = function (read, done) {
  return drain(read, null, done)
}

var log = exports.log = function (read, done) {
  return drain(read, function (data) {
    console.log(data)
  }, done)
}


},{}],31:[function(require,module,exports){

var keys = exports.keys =
function (object) {
  return values(Object.keys(object))
}

var once = exports.once =
function (value) {
  return function (abort, cb) {
    if(abort) return cb(abort)
    if(value != null) {
      var _value = value; value = null
      cb(null, _value)
    } else
      cb(true)
  }
}

var values = exports.values = exports.readArray =
function (array) {
  if(!Array.isArray(array))
    array = Object.keys(array).map(function (k) {
      return array[k]
    })
  var i = 0
  return function (end, cb) {
    if(end)
      return cb && cb(end)
    cb(i >= array.length || null, array[i++])
  }
}


var count = exports.count =
function (max) {
  var i = 0; max = max || Infinity
  return function (end, cb) {
    if(end) return cb && cb(end)
    if(i > max)
      return cb(true)
    cb(null, i++)
  }
}

var infinite = exports.infinite =
function (generate) {
  generate = generate || Math.random
  return function (end, cb) {
    if(end) return cb && cb(end)
    return cb(null, generate())
  }
}

var defer = exports.defer = function () {
  var _read, cbs = [], _end

  var read = function (end, cb) {
    if(!_read) {
      _end = end
      cbs.push(cb)
    } 
    else _read(end, cb)
  }
  read.resolve = function (read) {
    if(_read) throw new Error('already resolved')
    _read = read
    if(!_read) throw new Error('no read cannot resolve!' + _read)
    while(cbs.length)
      _read(_end, cbs.shift())
  }
  read.abort = function(err) {
    read.resolve(function (_, cb) {
      cb(err || true)
    })
  }
  return read
}

var empty = exports.empty = function () {
  return function (abort, cb) {
    cb(true)
  }
}

var error = exports.error = function (err) {
  return function (abort, cb) {
    cb(err)
  }
}

var depthFirst = exports.depthFirst =
function (start, createStream) {
  var reads = []

  reads.unshift(once(start))

  return function next (end, cb) {
    if(!reads.length)
      return cb(true)
    reads[0](end, function (end, data) {
      if(end) {
        //if this stream has ended, go to the next queue
        reads.shift()
        return next(null, cb)
      }
      reads.unshift(createStream(data))
      cb(end, data)
    })
  }
}
//width first is just like depth first,
//but push each new stream onto the end of the queue
var widthFirst = exports.widthFirst =
function (start, createStream) {
  var reads = []

  reads.push(once(start))

  return function next (end, cb) {
    if(!reads.length)
      return cb(true)
    reads[0](end, function (end, data) {
      if(end) {
        reads.shift()
        return next(null, cb)
      }
      reads.push(createStream(data))
      cb(end, data)
    })
  }
}

//this came out different to the first (strm)
//attempt at leafFirst, but it's still a valid
//topological sort.
var leafFirst = exports.leafFirst =
function (start, createStream) {
  var reads = []
  var output = []
  reads.push(once(start))

  return function next (end, cb) {
    reads[0](end, function (end, data) {
      if(end) {
        reads.shift()
        if(!output.length)
          return cb(true)
        return cb(null, output.shift())
      }
      reads.unshift(createStream(data))
      output.unshift(data)
      next(null, cb)
    })
  }
}


},{}],32:[function(require,module,exports){
(function (process){
var u      = require('pull-core')
var sources = require('./sources')
var sinks = require('./sinks')

var prop   = u.prop
var id     = u.id
var tester = u.tester

var map = exports.map =
function (read, map) {
  map = prop(map) || id
  return function (abort, cb) {
    read(abort, function (end, data) {
      try {
      data = !end ? map(data) : null
      } catch (err) {
        return read(err, function () {
          return cb(err)
        })
      }
      cb(end, data)
    })
  }
}

var asyncMap = exports.asyncMap =
function (read, map) {
  if(!map) return read
  return function (end, cb) {
    if(end) return read(end, cb) //abort
    read(null, function (end, data) {
      if(end) return cb(end, data)
      map(data, cb)
    })
  }
}

var paraMap = exports.paraMap =
function (read, map, width) {
  if(!map) return read
  var ended = false, queue = [], _cb

  function drain () {
    if(!_cb) return
    var cb = _cb
    _cb = null
    if(queue.length)
      return cb(null, queue.shift())
    else if(ended && !n)
      return cb(ended)
    _cb = cb
  }

  function pull () {
    read(null, function (end, data) {
      if(end) {
        ended = end
        return drain()
      }
      n++
      map(data, function (err, data) {
        n--

        queue.push(data)
        drain()
      })

      if(n < width && !ended)
        pull()
    })
  }

  var n = 0
  return function (end, cb) {
    if(end) return read(end, cb) //abort
    //continue to read while there are less than 3 maps in flight
    _cb = cb
    if(queue.length || ended)
      pull(), drain()
    else pull()
  }
  return highWaterMark(asyncMap(read, map), width)
}

var filter = exports.filter =
function (read, test) {
  //regexp
  test = tester(test)
  return function next (end, cb) {
    var sync, loop = true
    while(loop) {
      loop = false
      sync = true
      read(end, function (end, data) {
        if(!end && !test(data))
          return sync ? loop = true : next(end, cb)
        cb(end, data)
      })
      sync = false
    }
  }
}

var filterNot = exports.filterNot =
function (read, test) {
  test = tester(test)
  return filter(read, function (e) {
    return !test(e)
  })
}

var through = exports.through =
function (read, op, onEnd) {
  var a = false
  function once (abort) {
    if(a || !onEnd) return
    a = true
    onEnd(abort === true ? null : abort)
  }

  return function (end, cb) {
    if(end) once(end)
    return read(end, function (end, data) {
      if(!end) op && op(data)
      else once(end)
      cb(end, data)
    })
  }
}

var take = exports.take =
function (read, test) {
  var ended = false
  if('number' === typeof test) {
    var n = test; test = function () {
      return n --
    }
  }

  return function (end, cb) {
    if(ended) return cb(ended)
    if(ended = end) return read(ended, cb)

    read(null, function (end, data) {
      if(ended = ended || end) return cb(ended)
      if(!test(data)) {
        ended = true
        read(true, function (end, data) {
          cb(ended, data)
        })
      }
      else
        cb(null, data)
    })
  }
}

var unique = exports.unique = function (read, field, invert) {
  field = prop(field) || id
  var seen = {}
  return filter(read, function (data) {
    var key = field(data)
    if(seen[key]) return !!invert //false, by default
    else seen[key] = true
    return !invert //true by default
  })
}

var nonUnique = exports.nonUnique = function (read, field) {
  return unique(read, field, true)
}

var group = exports.group =
function (read, size) {
  var ended; size = size || 5
  var queue = []

  return function (end, cb) {
    //this means that the upstream is sending an error.
    if(end) return read(ended = end, cb)
    //this means that we read an end before.
    if(ended) return cb(ended)

    read(null, function next(end, data) {
      if(ended = ended || end) {
        if(!queue.length)
          return cb(ended)

        var _queue = queue; queue = []
        return cb(null, _queue)
      }
      queue.push(data)
      if(queue.length < size)
        return read(null, next)

      var _queue = queue; queue = []
      cb(null, _queue)
    })
  }
}

var flatten = exports.flatten = function (read) {
  var _read
  return function (abort, cb) {
    if(_read) nextChunk()
    else      nextStream()

    function nextChunk () {
      _read(null, function (end, data) {
        if(end) nextStream()
        else    cb(null, data)
      })
    }
    function nextStream () {
      read(null, function (end, stream) {
        if(end)
          return cb(end)
        if(Array.isArray(stream) || stream && 'object' === typeof stream)
          stream = sources.values(stream)
        else if('function' != typeof stream)
          throw new Error('expected stream of streams')
        _read = stream
        nextChunk()
      })
    }
  }
}

var prepend =
exports.prepend =
function (read, head) {

  return function (abort, cb) {
    if(head !== null) {
      if(abort)
        return read(abort, cb)
      var _head = head
      head = null
      cb(null, _head)
    } else {
      read(abort, cb)
    }
  }

}

//var drainIf = exports.drainIf = function (op, done) {
//  sinks.drain(
//}

var _reduce = exports._reduce = function (read, reduce, initial) {
  return function (close, cb) {
    if(close) return read(close, cb)
    if(ended) return cb(ended)

    sinks.drain(function (item) {
      initial = reduce(initial, item)
    }, function (err, data) {
      ended = err || true
      if(!err) cb(null, initial)
      else     cb(ended)
    })
    (read)
  }
}

var nextTick = process.nextTick

var highWaterMark = exports.highWaterMark =
function (read, highWaterMark) {
  var buffer = [], waiting = [], ended, ending, reading = false
  highWaterMark = highWaterMark || 10

  function readAhead () {
    while(waiting.length && (buffer.length || ended))
      waiting.shift()(ended, ended ? null : buffer.shift())

    if (!buffer.length && ending) ended = ending;
  }

  function next () {
    if(ended || ending || reading || buffer.length >= highWaterMark)
      return
    reading = true
    return read(ended || ending, function (end, data) {
      reading = false
      ending = ending || end
      if(data != null) buffer.push(data)

      next(); readAhead()
    })
  }

  process.nextTick(next)

  return function (end, cb) {
    ended = ended || end
    waiting.push(cb)

    next(); readAhead()
  }
}

var flatMap = exports.flatMap =
function (read, mapper) {
  mapper = mapper || id
  var queue = [], ended

  return function (abort, cb) {
    if(queue.length) return cb(null, queue.shift())
    else if(ended)   return cb(ended)

    read(abort, function next (end, data) {
      if(end) ended = end
      else {
        var add = mapper(data)
        while(add && add.length)
          queue.push(add.shift())
      }

      if(queue.length) cb(null, queue.shift())
      else if(ended)   cb(ended)
      else             read(null, next)
    })
  }
}


}).call(this,require('_process'))

},{"./sinks":30,"./sources":31,"_process":9,"pull-core":29}],33:[function(require,module,exports){
/* jshint node: true */
'use strict';

var jsonparse = require('cog/jsonparse');

/**
  ### signaller process handling

  When a signaller's underling messenger emits a `data` event this is
  delegated to a simple message parser, which applies the following simple
  logic:

  - Is the message a `/to` message. If so, see if the message is for this
    signaller (checking the target id - 2nd arg).  If so pass the
    remainder of the message onto the standard processing chain.  If not,
    discard the message.

  - Is the message a command message (prefixed with a forward slash). If so,
    look for an appropriate message handler and pass the message payload on
    to it.

  - Finally, does the message match any patterns that we are listening for?
    If so, then pass the entire message contents onto the registered handler.
**/
module.exports = function(signaller, opts) {
  var handlers = require('./handlers')(signaller, opts);

  function sendEvent(parts, srcState, data) {
    // initialise the event name
    var evtName = 'message:' + parts[0].slice(1);

    // convert any valid json objects to json
    var args = parts.slice(2).map(jsonparse);

    signaller.apply(
      signaller,
      [evtName].concat(args).concat([srcState, data])
    );
  }

  return function(originalData) {
    var data = originalData;
    var isMatch = true;
    var parts;
    var handler;
    var srcData;
    var srcState;
    var isDirectMessage = false;

    // discard primus messages
    if (data && data.slice(0, 6) === 'primus') {
      return;
    }

    // force the id into string format so we can run length and comparison tests on it
    var id = signaller.id + '';

    // process /to messages
    if (data.slice(0, 3) === '/to') {
      isMatch = data.slice(4, id.length + 4) === id;
      if (isMatch) {
        parts = data.slice(5 + id.length).split('|').map(jsonparse);

        // get the source data
        isDirectMessage = true;

        // extract the vector clock and update the parts
        parts = parts.map(jsonparse);
      }
    }

    // if this is not a match, then bail
    if (! isMatch) {
      return;
    }

    // chop the data into parts
    signaller('rawdata', data);
    parts = parts || data.split('|').map(jsonparse);

    // if we have a specific handler for the action, then invoke
    if (typeof parts[0] == 'string') {
      // extract the metadata from the input data
      srcData = parts[1];

      // if we got data from ourself, then this is pretty dumb
      // but if we have then throw it away
      if (srcData && srcData.id === signaller.id) {
        return console.warn('got data from ourself, discarding');
      }

      // get the source state
      srcState = signaller.peers.get(srcData && srcData.id) || srcData;

      // handle commands
      if (parts[0].charAt(0) === '/') {
        // look for a handler for the message type
        handler = handlers[parts[0].slice(1)];

        if (typeof handler == 'function') {
          handler(
            parts.slice(2),
            parts[0].slice(1),
            srcData,
            srcState,
            isDirectMessage
          );
        }
        else {
          sendEvent(parts, srcState, originalData);
        }
      }
      // otherwise, emit data
      else {
        signaller(
          'data',
          parts.slice(0, 1).concat(parts.slice(2)),
          srcData,
          srcState,
          isDirectMessage
        );
      }
    }
  };
};

},{"./handlers":17,"cog/jsonparse":6}],34:[function(require,module,exports){
var extend = require('cog/extend');

/**
  # rtc-switchboard-messenger

  A specialised version of
  [`messenger-ws`](https://github.com/DamonOehlman/messenger-ws) designed to
  connect to [`rtc-switchboard`](http://github.com/rtc-io/rtc-switchboard)
  instances.

**/
module.exports = function(switchboard, opts) {
  return require('messenger-ws')(switchboard, extend({
    endpoints: ['/primus', '/']
  }, opts));
};

},{"cog/extend":4,"messenger-ws":35}],35:[function(require,module,exports){
var WebSocket = require('ws');
var wsurl = require('wsurl');
var ps = require('pull-ws');
var defaults = require('cog/defaults');
var reTrailingSlash = /\/$/;

/**
  # messenger-ws

  This is a simple messaging implementation for sending and receiving data
  via websockets.

  Follows the [messenger-archetype](https://github.com/DamonOehlman/messenger-archetype)

  ## Example Usage

  <<< examples/simple.js

**/
module.exports = function(url, opts) {
  var timeout = (opts || {}).timeout || 1000;
  var endpoints = ((opts || {}).endpoints || ['/']).map(function(endpoint) {
    return url.replace(reTrailingSlash, '') + endpoint;
  });

  function connect(callback) {
    var queue = [].concat(endpoints);
    var receivedData = false;
    var failTimer;
    var successTimer;

    function attemptNext() {
      var socket;

      function registerMessage(evt) {
        receivedData = true;
        (socket.removeEventListener || socket.removeListener)('message', registerMessage);
      }

      // if we have no more valid endpoints, then erorr out
      if (queue.length === 0) {
        return callback(new Error('Unable to connect to url: ' + url));
      }

      socket = new WebSocket(wsurl(queue.shift()));
      socket.addEventListener('error', handleError);
      socket.addEventListener('close', handleAbnormalClose);
      socket.addEventListener('open', function() {
        // create the source immediately to buffer any data
        var source = ps.source(socket, opts);

        // monitor data flowing from the socket
        socket.addEventListener('message', registerMessage);

        successTimer = setTimeout(function() {
          clearTimeout(failTimer);
          callback(null, source, ps.sink(socket, opts));
        }, 100);
      });

      failTimer = setTimeout(attemptNext, timeout);
    }

    function handleAbnormalClose(evt) {
      // if this was a clean close do nothing
      if (evt.wasClean && receivedData && queue.length === 0) {
        return;
      }

      return handleError();
    }

    function handleError() {
      clearTimeout(successTimer);
      clearTimeout(failTimer);
      attemptNext();
    }

    attemptNext();
  }

  return connect;
};

},{"cog/defaults":3,"pull-ws":36,"ws":41,"wsurl":42}],36:[function(require,module,exports){
exports = module.exports = duplex;

exports.source = require('./source');
exports.sink = require('./sink');

function duplex (ws, opts) {
  return {
    source: exports.source(ws),
    sink: exports.sink(ws, opts)
  };
};

},{"./sink":39,"./source":40}],37:[function(require,module,exports){
exports.id = 
function (item) {
  return item
}

exports.prop = 
function (map) {  
  if('string' == typeof map) {
    var key = map
    return function (data) { return data[key] }
  }
  return map
}

exports.tester = function (test) {
  if(!test) return exports.id
  if('object' === typeof test
    && 'function' === typeof test.test)
      return test.test.bind(test)
  return exports.prop(test) || exports.id
}

exports.addPipe = addPipe

function addPipe(read) {
  if('function' !== typeof read)
    return read

  read.pipe = read.pipe || function (reader) {
    if('function' != typeof reader && 'function' != typeof reader.sink)
      throw new Error('must pipe to reader')
    var pipe = addPipe(reader.sink ? reader.sink(read) : reader(read))
    return reader.source || pipe;
  }
  
  read.type = 'Source'
  return read
}

var Source =
exports.Source =
function Source (createRead) {
  function s() {
    var args = [].slice.call(arguments)
    return addPipe(createRead.apply(null, args))
  }
  s.type = 'Source'
  return s
}


var Through =
exports.Through = 
function (createRead) {
  return function () {
    var args = [].slice.call(arguments)
    var piped = []
    function reader (read) {
      args.unshift(read)
      read = createRead.apply(null, args)
      while(piped.length)
        read = piped.shift()(read)
      return read
      //pipeing to from this reader should compose...
    }
    reader.pipe = function (read) {
      piped.push(read) 
      if(read.type === 'Source')
        throw new Error('cannot pipe ' + reader.type + ' to Source')
      reader.type = read.type === 'Sink' ? 'Sink' : 'Through'
      return reader
    }
    reader.type = 'Through'
    return reader
  }
}

var Sink =
exports.Sink = 
function Sink(createReader) {
  return function () {
    var args = [].slice.call(arguments)
    if(!createReader)
      throw new Error('must be createReader function')
    function s (read) {
      args.unshift(read)
      return createReader.apply(null, args)
    }
    s.type = 'Sink'
    return s
  }
}


exports.maybeSink = 
exports.maybeDrain = 
function (createSink, cb) {
  if(!cb)
    return Through(function (read) {
      var ended
      return function (close, cb) {
        if(close) return read(close, cb)
        if(ended) return cb(ended)

        createSink(function (err, data) {
          ended = err || true
          if(!err) cb(null, data)
          else     cb(ended)
        }) (read)
      }
    })()

  return Sink(function (read) {
    return createSink(cb) (read)
  })()
}


},{}],38:[function(require,module,exports){
module.exports = function(socket, callback) {
  var remove = socket && (socket.removeEventListener || socket.removeListener);

  function cleanup () {
    if (typeof remove == 'function') {
      remove.call(socket, 'open', handleOpen);
      remove.call(socket, 'error', handleErr);
    }
  }

  function handleOpen(evt) {
    cleanup(); callback();
  }

  function handleErr (evt) {
    cleanup(); callback(evt);
  }

  // if the socket is closing or closed, return end
  if (socket.readyState >= 2) {
    return callback(true);
  }

  // if open, trigger the callback
  if (socket.readyState === 1) {
    return callback();
  }

  socket.addEventListener('open', handleOpen);
  socket.addEventListener('error', handleErr);
};

},{}],39:[function(require,module,exports){
(function (process){
var pull = require('pull-core');
var ready = require('./ready');

/**
  ### `sink(socket, opts?)`

  Create a pull-stream `Sink` that will write data to the `socket`.

  <<< examples/write.js

**/
module.exports = pull.Sink(function(read, socket, opts) {
  opts = opts || {}
  var closeOnEnd = opts.closeOnEnd !== false;
  var onClose = 'function' === typeof opts ? opts : opts.onClose;

  function next(end, data) {
    // if the stream has ended, simply return
    if (end) {
      if (closeOnEnd && socket.readyState <= 1) {
        if(onClose)
          socket.addEventListener('close', function (ev) {
            if(ev.wasClean) onClose()
            else {
              var err = new Error('ws error')
              err.event = ev
              onClose(err)
            }
          });

        socket.close();
      }

      return;
    }

    // socket ready?
    ready(socket, function(end) {
      if (end) {
        return read(end, function () {});
      }

      socket.send(data);
      process.nextTick(function() {
        read(null, next);
      });
    });
  }

  read(null, next);
});

}).call(this,require('_process'))

},{"./ready":38,"_process":9,"pull-core":37}],40:[function(require,module,exports){
var pull = require('pull-core');
var ready = require('./ready');

/**
  ### `source(socket)`

  Create a pull-stream `Source` that will read data from the `socket`.

  <<< examples/read.js

**/
module.exports = pull.Source(function(socket) {
  var buffer = [];
  var receiver;
  var ended;

  socket.addEventListener('message', function(evt) {
    if (receiver) {
      return receiver(null, evt.data);
    }

    buffer.push(evt.data);
  });

  socket.addEventListener('close', function(evt) {
    if (ended) return;
    if (receiver) {
      return receiver(ended = true);
    }
  });

  socket.addEventListener('error', function (evt) {
    if (ended) return;
    ended = evt;
    if (receiver) {
      receiver(ended);
    }
  });

  function read(abort, cb) {
    receiver = null;

    //if stream has already ended.
    if (ended)
      return cb(ended)

    // if ended, abort
    if (abort) {
      //this will callback when socket closes
      receiver = cb
      return socket.close()
    }

    ready(socket, function(end) {
      if (end) {
        return cb(ended = end);
      }

      // read from the socket
      if (ended && ended !== true) {
        return cb(ended);
      }
      else if (buffer.length > 0) {
        return cb(null, buffer.shift());
      }
      else if (ended) {
        return cb(true);
      }

      receiver = cb;
    });
  };

  return read;
});

},{"./ready":38,"pull-core":37}],41:[function(require,module,exports){

/**
 * Module dependencies.
 */

var global = (function() { return this; })();

/**
 * WebSocket constructor.
 */

var WebSocket = global.WebSocket || global.MozWebSocket;

/**
 * Module exports.
 */

module.exports = WebSocket ? ws : null;

/**
 * WebSocket constructor.
 *
 * The third `opts` options object gets ignored in web browsers, since it's
 * non-standard, and throws a TypeError if passed to the constructor.
 * See: https://github.com/einaros/ws/issues/227
 *
 * @param {String} uri
 * @param {Array} protocols (optional)
 * @param {Object) opts (optional)
 * @api public
 */

function ws(uri, protocols, opts) {
  var instance;
  if (protocols) {
    instance = new WebSocket(uri, protocols);
  } else {
    instance = new WebSocket(uri);
  }
  return instance;
}

if (WebSocket) ws.prototype = WebSocket.prototype;

},{}],42:[function(require,module,exports){
var reHttpUrl = /^http(.*)$/;

/**
  # wsurl

  Given a url (including protocol relative urls - i.e. `//`), generate an appropriate
  url for a WebSocket endpoint (`ws` or `wss`).

  ## Example Usage

  <<< examples/relative.js

**/

module.exports = function(url, opts) {
  var current = (opts || {}).current || (typeof location != 'undefined' && location.href);
  var currentProtocol = current && current.slice(0, current.indexOf(':'));
  var insecure = (opts || {}).insecure;
  var isRelative = url.slice(0, 2) == '//';
  var forceWS = (! currentProtocol) || currentProtocol === 'file:';

  if (isRelative) {
    return forceWS ?
      ((insecure ? 'ws:' : 'wss:') + url) :
      (currentProtocol.replace(reHttpUrl, 'ws$1') + ':' + url);
  }

  return url.replace(reHttpUrl, 'ws$1');
};

},{}],43:[function(require,module,exports){
/* jshint node: true */
'use strict';

var debug = require('cog/logger')('rtc/cleanup');

var CANNOT_CLOSE_STATES = [
  'closed'
];

var EVENTS_DECOUPLE_BC = [
  'addstream',
  'datachannel',
  'icecandidate',
  'negotiationneeded',
  'removestream',
  'signalingstatechange'
];

var EVENTS_DECOUPLE_AC = [
  'iceconnectionstatechange'
];

/**
  ### rtc-tools/cleanup

  ```
  cleanup(pc)
  ```

  The `cleanup` function is used to ensure that a peer connection is properly
  closed and ready to be cleaned up by the browser.

**/
module.exports = function(pc) {
  // see if we can close the connection
  var currentState = pc.iceConnectionState;
  var canClose = CANNOT_CLOSE_STATES.indexOf(currentState) < 0;

  function decouple(events) {
    events.forEach(function(evtName) {
      if (pc['on' + evtName]) {
        pc['on' + evtName] = null;
      }
    });
  }

  // decouple "before close" events
  decouple(EVENTS_DECOUPLE_BC);

  if (canClose) {
    debug('attempting connection close, current state: '+ pc.iceConnectionState);
    pc.close();
  }

  // remove the event listeners
  // after a short delay giving the connection time to trigger
  // close and iceconnectionstatechange events
  setTimeout(function() {
    decouple(EVENTS_DECOUPLE_AC);
  }, 100);
};

},{"cog/logger":7}],44:[function(require,module,exports){
/* jshint node: true */
'use strict';

var mbus = require('mbus');
var queue = require('rtc-taskqueue');
var cleanup = require('./cleanup');
var monitor = require('./monitor');
var throttle = require('cog/throttle');
var CLOSED_STATES = [ 'closed', 'failed' ];
var CHECKING_STATES = [ 'checking' ];

/**
  ### rtc-tools/couple

  #### couple(pc, targetId, signaller, opts?)

  Couple a WebRTC connection with another webrtc connection identified by
  `targetId` via the signaller.

  The following options can be provided in the `opts` argument:

  - `sdpfilter` (default: null)

    A simple function for filtering SDP as part of the peer
    connection handshake (see the Using Filters details below).

  ##### Example Usage

  ```js
  var couple = require('rtc/couple');

  couple(pc, '54879965-ce43-426e-a8ef-09ac1e39a16d', signaller);
  ```

  ##### Using Filters

  In certain instances you may wish to modify the raw SDP that is provided
  by the `createOffer` and `createAnswer` calls.  This can be done by passing
  a `sdpfilter` function (or array) in the options.  For example:

  ```js
  // run the sdp from through a local tweakSdp function.
  couple(pc, '54879965-ce43-426e-a8ef-09ac1e39a16d', signaller, {
    sdpfilter: tweakSdp
  });
  ```

**/
function couple(pc, targetId, signaller, opts) {
  var debugLabel = (opts || {}).debugLabel || 'rtc';
  var debug = require('cog/logger')(debugLabel + '/couple');

  // create a monitor for the connection
  var mon = monitor(pc, targetId, signaller, (opts || {}).logger);
  var emit = mbus('', mon);
  var reactive = (opts || {}).reactive;
  var endOfCandidates = true;

  // configure the time to wait between receiving a 'disconnect'
  // iceConnectionState and determining that we are closed
  var disconnectTimeout = (opts || {}).disconnectTimeout || 10000;
  var disconnectTimer;

  // initilaise the negotiation helpers
  var isMaster = signaller.isMaster(targetId);

  // initialise the processing queue (one at a time please)
  var q = queue(pc, opts);

  var createOrRequestOffer = throttle(function() {
    if (! isMaster) {
      return signaller.to(targetId).send('/negotiate');
    }

    q.createOffer();
  }, 100, { leading: false });

  var debounceOffer = throttle(q.createOffer, 100, { leading: false });

  function decouple() {
    debug('decoupling ' + signaller.id + ' from ' + targetId);

    // stop the monitor
//     mon.removeAllListeners();
    mon.stop();

    // cleanup the peerconnection
    cleanup(pc);

    // remove listeners
    signaller.removeListener('sdp', handleSdp);
    signaller.removeListener('candidate', handleCandidate);
    signaller.removeListener('negotiate', handleNegotiateRequest);

    // remove listeners (version >= 5)
    signaller.removeListener('message:sdp', handleSdp);
    signaller.removeListener('message:candidate', handleCandidate);
    signaller.removeListener('message:negotiate', handleNegotiateRequest);
  }

  function handleCandidate(data) {
    q.addIceCandidate(data);
  }

  function handleSdp(sdp, src) {
    emit('sdp.remote', sdp);

    // if the source is unknown or not a match, then don't process
    if ((! src) || (src.id !== targetId)) {
      return;
    }

    q.setRemoteDescription(sdp);
  }

  function handleConnectionClose() {
    debug('captured pc close, iceConnectionState = ' + pc.iceConnectionState);
    decouple();
  }

  function handleDisconnect() {
    debug('captured pc disconnect, monitoring connection status');

    // start the disconnect timer
    disconnectTimer = setTimeout(function() {
      debug('manually closing connection after disconnect timeout');
      cleanup(pc);
    }, disconnectTimeout);

    mon.on('statechange', handleDisconnectAbort);
  }

  function handleDisconnectAbort() {
    debug('connection state changed to: ' + pc.iceConnectionState);

    // if the state is checking, then do not reset the disconnect timer as
    // we are doing our own checking
    if (CHECKING_STATES.indexOf(pc.iceConnectionState) >= 0) {
      return;
    }

    resetDisconnectTimer();

    // if we have a closed or failed status, then close the connection
    if (CLOSED_STATES.indexOf(pc.iceConnectionState) >= 0) {
      return mon('closed');
    }

    mon.once('disconnect', handleDisconnect);
  }

  function handleLocalCandidate(evt) {
    var data;

    if (evt.candidate) {
      resetDisconnectTimer();

      // formulate into a specific data object so we won't be upset by plugin
      // specific implementations of the candidate data format (i.e. extra fields)
      data = {
        candidate: evt.candidate.candidate,
        sdpMid: evt.candidate.sdpMid,
        sdpMLineIndex: evt.candidate.sdpMLineIndex
      };

      emit('ice.local', data);
      signaller.to(targetId).send('/candidate', data);
      endOfCandidates = false;
    }
    else if (! endOfCandidates) {
      endOfCandidates = true;
      emit('ice.gathercomplete');
      signaller.to(targetId).send('/endofcandidates', {});
    }
  }

  function handleNegotiateRequest(src) {
    if (src.id === targetId) {
      emit('negotiate.request', src.id);
      debounceOffer();
    }
  }

  function resetDisconnectTimer() {
    mon.off('statechange', handleDisconnectAbort);

    // clear the disconnect timer
    debug('reset disconnect timer, state: ' + pc.iceConnectionState);
    clearTimeout(disconnectTimer);
  }

  // when regotiation is needed look for the peer
  if (reactive) {
    pc.onnegotiationneeded = function() {
      emit('negotiate.renegotiate');
      createOrRequestOffer();
    };
  }

  pc.onicecandidate = handleLocalCandidate;

  // when the task queue tells us we have sdp available, send that over the wire
  q.on('sdp.local', function(desc) {
    signaller.to(targetId).send('/sdp', desc);
  });

  // when we receive sdp, then
  signaller.on('sdp', handleSdp);
  signaller.on('candidate', handleCandidate);

  // listeners (signaller >= 5)
  signaller.on('message:sdp', handleSdp);
  signaller.on('message:candidate', handleCandidate);

  // if this is a master connection, listen for negotiate events
  if (isMaster) {
    signaller.on('negotiate', handleNegotiateRequest);
    signaller.on('message:negotiate', handleNegotiateRequest); // signaller >= 5
  }

  // when the connection closes, remove event handlers
  mon.once('closed', handleConnectionClose);
  mon.once('disconnected', handleDisconnect);

  // patch in the create offer functions
  mon.createOffer = createOrRequestOffer;

  return mon;
}

module.exports = couple;

},{"./cleanup":43,"./monitor":48,"cog/logger":7,"cog/throttle":8,"mbus":10,"rtc-taskqueue":49}],45:[function(require,module,exports){
/* jshint node: true */
'use strict';

/**
  ### rtc-tools/detect

  Provide the [rtc-core/detect](https://github.com/rtc-io/rtc-core#detect)
  functionality.
**/
module.exports = require('rtc-core/detect');

},{"rtc-core/detect":11}],46:[function(require,module,exports){
/* jshint node: true */
'use strict';

var debug = require('cog/logger')('generators');
var detect = require('./detect');
var defaults = require('cog/defaults');

var mappings = {
  create: {
    dtls: function(c) {
      if (! detect.moz) {
        c.optional = (c.optional || []).concat({ DtlsSrtpKeyAgreement: true });
      }
    }
  }
};

/**
  ### rtc-tools/generators

  The generators package provides some utility methods for generating
  constraint objects and similar constructs.

  ```js
  var generators = require('rtc/generators');
  ```

**/

/**
  #### generators.config(config)

  Generate a configuration object suitable for passing into an W3C
  RTCPeerConnection constructor first argument, based on our custom config.

  In the event that you use short term authentication for TURN, and you want
  to generate new `iceServers` regularly, you can specify an iceServerGenerator
  that will be used prior to coupling. This generator should return a fully
  compliant W3C (RTCIceServer dictionary)[http://www.w3.org/TR/webrtc/#idl-def-RTCIceServer].

  If you pass in both a generator and iceServers, the iceServers _will be
  ignored and the generator used instead.
**/

exports.config = function(config) {
  var iceServerGenerator = (config || {}).iceServerGenerator;

  return defaults({}, config, {
    iceServers: typeof iceServerGenerator == 'function' ? iceServerGenerator() : []
  });
};

/**
  #### generators.connectionConstraints(flags, constraints)

  This is a helper function that will generate appropriate connection
  constraints for a new `RTCPeerConnection` object which is constructed
  in the following way:

  ```js
  var conn = new RTCPeerConnection(flags, constraints);
  ```

  In most cases the constraints object can be left empty, but when creating
  data channels some additional options are required.  This function
  can generate those additional options and intelligently combine any
  user defined constraints (in `constraints`) with shorthand flags that
  might be passed while using the `rtc.createConnection` helper.
**/
exports.connectionConstraints = function(flags, constraints) {
  var generated = {};
  var m = mappings.create;
  var out;

  // iterate through the flags and apply the create mappings
  Object.keys(flags || {}).forEach(function(key) {
    if (m[key]) {
      m[key](generated);
    }
  });

  // generate the connection constraints
  out = defaults({}, constraints, generated);
  debug('generated connection constraints: ', out);

  return out;
};

},{"./detect":45,"cog/defaults":3,"cog/logger":7}],47:[function(require,module,exports){
/* jshint node: true */

'use strict';

/**
  # rtc-tools

  The `rtc-tools` module does most of the heavy lifting within the
  [rtc.io](http://rtc.io) suite.  Primarily it handles the logic of coupling
  a local `RTCPeerConnection` with it's remote counterpart via an
  [rtc-signaller](https://github.com/rtc-io/rtc-signaller) signalling
  channel.

  ## Getting Started

  If you decide that the `rtc-tools` module is a better fit for you than either
  [rtc-quickconnect](https://github.com/rtc-io/rtc-quickconnect) or
  [rtc](https://github.com/rtc-io/rtc) then the code snippet below
  will provide you a guide on how to get started using it in conjunction with
  the [rtc-signaller](https://github.com/rtc-io/rtc-signaller) (version 5.0 and above)
  and [rtc-media](https://github.com/rtc-io/rtc-media) modules:

  <<< examples/getting-started.js

  This code definitely doesn't cover all the cases that you need to consider
  (i.e. peers leaving, etc) but it should demonstrate how to:

  1. Capture video and add it to a peer connection
  2. Couple a local peer connection with a remote peer connection
  3. Deal with the remote steam being discovered and how to render
     that to the local interface.

  ## Reference

**/

var gen = require('./generators');

// export detect
var detect = exports.detect = require('./detect');
var findPlugin = require('rtc-core/plugin');

// export cog logger for convenience
exports.logger = require('cog/logger');

// export peer connection
var RTCPeerConnection =
exports.RTCPeerConnection = detect('RTCPeerConnection');

// add the couple utility
exports.couple = require('./couple');

/**
  ### createConnection

  ```
  createConnection(opts?, constraints?) => RTCPeerConnection
  ```

  Create a new `RTCPeerConnection` auto generating default opts as required.

  ```js
  var conn;

  // this is ok
  conn = rtc.createConnection();

  // and so is this
  conn = rtc.createConnection({
    iceServers: []
  });
  ```
**/
exports.createConnection = function(opts, constraints) {
  var plugin = findPlugin((opts || {}).plugins);
  var PeerConnection = (opts || {}).RTCPeerConnection || RTCPeerConnection;

  // generate the config based on options provided
  var config = gen.config(opts);

  // generate appropriate connection constraints
  constraints = gen.connectionConstraints(opts, constraints);

  if (plugin && typeof plugin.createConnection == 'function') {
    return plugin.createConnection(config, constraints);
  }

  return new PeerConnection(config, constraints);
};

},{"./couple":44,"./detect":45,"./generators":46,"cog/logger":7,"rtc-core/plugin":14}],48:[function(require,module,exports){
/* jshint node: true */
'use strict';

var mbus = require('mbus');

// define some state mappings to simplify the events we generate
var stateMappings = {
  completed: 'connected'
};

// define the events that we need to watch for peer connection
// state changes
var peerStateEvents = [
  'signalingstatechange',
  'iceconnectionstatechange',
];

/**
  ### rtc-tools/monitor

  ```
  monitor(pc, targetId, signaller, parentBus) => mbus
  ```

  The monitor is a useful tool for determining the state of `pc` (an
  `RTCPeerConnection`) instance in the context of your application. The
  monitor uses both the `iceConnectionState` information of the peer
  connection and also the various
  [signaller events](https://github.com/rtc-io/rtc-signaller#signaller-events)
  to determine when the connection has been `connected` and when it has
  been `disconnected`.

  A monitor created `mbus` is returned as the result of a
  [couple](https://github.com/rtc-io/rtc#rtccouple) between a local peer
  connection and it's remote counterpart.

**/
module.exports = function(pc, targetId, signaller, parentBus) {
  var monitor = mbus('', parentBus);
  var state;

  function checkState() {
    var newState = getMappedState(pc.iceConnectionState);

    // flag the we had a state change
    monitor('statechange', pc, newState);

    // if the active state has changed, then send the appopriate message
    if (state !== newState) {
      monitor(newState);
      state = newState;
    }
  }

  function handleClose() {
    monitor('closed');
  }

  pc.onclose = handleClose;
  peerStateEvents.forEach(function(evtName) {
    pc['on' + evtName] = checkState;
  });

  monitor.stop = function() {
    pc.onclose = null;
    peerStateEvents.forEach(function(evtName) {
      pc['on' + evtName] = null;
    });
  };

  monitor.checkState = checkState;

  // if we haven't been provided a valid peer connection, abort
  if (! pc) {
    return monitor;
  }

  // determine the initial is active state
  state = getMappedState(pc.iceConnectionState);

  return monitor;
};

/* internal helpers */

function getMappedState(state) {
  return stateMappings[state] || state;
}

},{"mbus":10}],49:[function(require,module,exports){
var detect = require('rtc-core/detect');
var findPlugin = require('rtc-core/plugin');
var PriorityQueue = require('priorityqueuejs');

// some validation routines
var checkCandidate = require('rtc-validator/candidate');

// the sdp cleaner
var sdpclean = require('rtc-sdpclean');

var PRIORITY_LOW = 100;
var PRIORITY_WAIT = 1000;

// priority order (lower is better)
var DEFAULT_PRIORITIES = [
  'candidate',
  'setLocalDescription',
  'setRemoteDescription',
  'createAnswer',
  'createOffer'
];

// define event mappings
var METHOD_EVENTS = {
  setLocalDescription: 'setlocaldesc',
  setRemoteDescription: 'setremotedesc',
  createOffer: 'offer',
  createAnswer: 'answer'
};

// define states in which we will attempt to finalize a connection on receiving a remote offer
var VALID_RESPONSE_STATES = ['have-remote-offer', 'have-local-pranswer'];

/**
  # rtc-taskqueue

  This is a package that assists with applying actions to an `RTCPeerConnection`
  in as reliable order as possible. It is primarily used by the coupling logic
  of the [`rtc-tools`](https://github.com/rtc-io/rtc-tools).

  ## Example Usage

  For the moment, refer to the simple coupling test as an example of how to use
  this package (see below):

  <<< test/couple.js

**/
module.exports = function(pc, opts) {
  // create the task queue
  var queue = new PriorityQueue(orderTasks);
  var tq = require('mbus')('', (opts || {}).logger);

  // initialise task importance
  var priorities = (opts || {}).priorities || DEFAULT_PRIORITIES;

  // check for plugin usage
  var plugin = findPlugin((opts || {}).plugins);

  // initialise state tracking
  var checkQueueTimer = 0;
  var currentTask;
  var defaultFail = tq.bind(tq, 'fail');

  // look for an sdpfilter function (allow slight mis-spellings)
  var sdpFilter = (opts || {}).sdpfilter || (opts || {}).sdpFilter;

  // initialise session description and icecandidate objects
  var RTCSessionDescription = (opts || {}).RTCSessionDescription ||
    detect('RTCSessionDescription');

  var RTCIceCandidate = (opts || {}).RTCIceCandidate ||
    detect('RTCIceCandidate');

  function abortQueue(err) {
    console.error(err);
  }

  function applyCandidate(task, next) {
    var data = task.args[0];
    var candidate = data && data.candidate && createIceCandidate(data);

    function handleOk() {
      tq('ice.remote.applied', candidate);
      next();
    }

    function handleFail(err) {
      tq('ice.remote.invalid', candidate);
      next(err);
    }

    // we have a null candidate, we have finished gathering candidates
    if (! candidate) {
      return next();
    }

    pc.addIceCandidate(candidate, handleOk, handleFail);
  }

  function checkQueue() {
    // peek at the next item on the queue
    var next = (! queue.isEmpty()) && (! currentTask) && queue.peek();
    var ready = next && testReady(next);
    var retry = (! queue.isEmpty()) && isNotClosed(pc);

    // reset the queue timer
    checkQueueTimer = 0;

    // if we don't have a task ready, then abort
    if (! ready) {
      return retry && triggerQueueCheck();
    }

    // update the current task (dequeue)
    currentTask = queue.deq();

    // process the task
    currentTask.fn(currentTask, function(err) {
      var fail = currentTask.fail || defaultFail;
      var pass = currentTask.pass;
      var taskName = currentTask.name;

      // if errored, fail
      if (err) {
        console.error(taskName + ' task failed: ', err);
        return fail(err);
      }

      if (typeof pass == 'function') {
        pass.apply(currentTask, [].slice.call(arguments, 1));
      }

      setTimeout(function() {
        currentTask = null;
        triggerQueueCheck();
      }, 0);
    });
  }

  function cleansdp(desc) {
    // ensure we have clean sdp
    var sdpErrors = [];
    var sdp = desc && sdpclean(desc.sdp, { collector: sdpErrors });

    // if we don't have a match, log some info
    if (desc && sdp !== desc.sdp) {
      console.info('invalid lines removed from sdp: ', sdpErrors);
      desc.sdp = sdp;
    }

    // if a filter has been specified, then apply the filter
    if (typeof sdpFilter == 'function') {
      desc.sdp = sdpFilter(desc.sdp, pc);
    }

    return desc;
  }

  function completeConnection() {
    if (VALID_RESPONSE_STATES.indexOf(pc.signalingState) >= 0) {
      return tq.createAnswer();
    }
  }

  function createIceCandidate(data) {
    if (plugin && typeof plugin.createIceCandidate == 'function') {
      return plugin.createIceCandidate(data);
    }

    return new RTCIceCandidate(data);
  }

  function createSessionDescription(data) {
    if (plugin && typeof plugin.createSessionDescription == 'function') {
      return plugin.createSessionDescription(data);
    }

    return new RTCSessionDescription(data);
  }

  function emitSdp() {
    tq('sdp.local', this.args[0]);
  }

  function enqueue(name, handler, opts) {
    return function() {
      var args = [].slice.call(arguments);

      if (opts && typeof opts.processArgs == 'function') {
        args = args.map(opts.processArgs);
      }

      queue.enq({
        args: args,
        name: name,
        fn: handler,

        // initilaise any checks that need to be done prior
        // to the task executing
        checks: [ isNotClosed ].concat((opts || {}).checks || []),

        // initialise the pass and fail handlers
        pass: (opts || {}).pass,
        fail: (opts || {}).fail
      });

      triggerQueueCheck();
    };
  }

  function execMethod(task, next) {
    var fn = pc[task.name];
    var eventName = METHOD_EVENTS[task.name] || (task.name || '').toLowerCase();
    var cbArgs = [ success, fail ];
    var isOffer = task.name === 'createOffer';

    function fail(err) {
      tq.apply(tq, [ 'negotiate.error', task.name, err ].concat(task.args));
      next(err);
    }

    function success() {
      tq.apply(tq, [ ['negotiate', eventName, 'ok'], task.name ].concat(task.args));
      next.apply(null, [null].concat([].slice.call(arguments)));
    }

    if (typeof fn != 'function') {
      return next(new Error('cannot call "' + task.name + '" on RTCPeerConnection'));
    }

    // invoke the function
    tq.apply(tq, ['negotiate.' + eventName].concat(task.args));
    fn.apply(
      pc,
      task.args.concat(cbArgs).concat(isOffer ? generateConstraints() : [])
    );
  }

  function extractCandidateEventData(data) {
    // extract nested candidate data (like we will see in an event being passed to this function)
    while (data && data.candidate && data.candidate.candidate) {
      data = data.candidate;
    }

    return data;
  }

  function generateConstraints() {
    var allowedKeys = {
      offertoreceivevideo: 'OfferToReceiveVideo',
      offertoreceiveaudio: 'OfferToReceiveAudio',
      icerestart: 'IceRestart',
      voiceactivitydetection: 'VoiceActivityDetection'
    };

    var constraints = {
      OfferToReceiveVideo: true,
      OfferToReceiveAudio: true
    };

    // update known keys to match
    Object.keys(opts || {}).forEach(function(key) {
      if (allowedKeys[key.toLowerCase()]) {
        constraints[allowedKeys[key.toLowerCase()]] = opts[key];
      }
    });

    return { mandatory: constraints };
  }

  function hasLocalOrRemoteDesc(pc, task) {
    return pc.__hasDesc || (pc.__hasDesc = !!pc.remoteDescription);
  }

  function isNotNegotiating(pc) {
    return pc.signalingState !== 'have-local-offer';
  }

  function isNotClosed(pc) {
    return pc.signalingState !== 'closed';
  }

  function isStable(pc) {
    return pc.signalingState === 'stable';
  }

  function isValidCandidate(pc, data) {
    return data.__valid ||
      (data.__valid = checkCandidate(data.args[0]).length === 0);
  }

  function orderTasks(a, b) {
    // apply each of the checks for each task
    var tasks = [a,b];
    var readiness = tasks.map(testReady);
    var taskPriorities = tasks.map(function(task, idx) {
      var ready = readiness[idx];
      var priority = ready && priorities.indexOf(task.name);

      return ready ? (priority >= 0 ? priority : PRIORITY_LOW) : PRIORITY_WAIT;
    });

    return taskPriorities[1] - taskPriorities[0];
  }

  // check whether a task is ready (does it pass all the checks)
  function testReady(task) {
    return (task.checks || []).reduce(function(memo, check) {
      return memo && check(pc, task);
    }, true);
  }

  function triggerQueueCheck() {
    if (checkQueueTimer) return;
    checkQueueTimer = setTimeout(checkQueue, 50);
  }

  // patch in the queue helper methods
  tq.addIceCandidate = enqueue('addIceCandidate', applyCandidate, {
    processArgs: extractCandidateEventData,
    checks: [ hasLocalOrRemoteDesc, isValidCandidate ]
  });

  tq.setLocalDescription = enqueue('setLocalDescription', execMethod, {
    processArgs: cleansdp,
    pass: emitSdp
  });

  tq.setRemoteDescription = enqueue('setRemoteDescription', execMethod, {
    processArgs: createSessionDescription,
    pass: completeConnection
  });

  tq.createOffer = enqueue('createOffer', execMethod, {
    checks: [ isNotNegotiating ],
    pass: tq.setLocalDescription
  });

  tq.createAnswer = enqueue('createAnswer', execMethod, {
    pass: tq.setLocalDescription
  });

  return tq;
};

},{"mbus":10,"priorityqueuejs":50,"rtc-core/detect":11,"rtc-core/plugin":14,"rtc-sdpclean":51,"rtc-validator/candidate":52}],50:[function(require,module,exports){
/**
 * Expose `PriorityQueue`.
 */
module.exports = PriorityQueue;

/**
 * Initializes a new empty `PriorityQueue` with the given `comparator(a, b)`
 * function, uses `.DEFAULT_COMPARATOR()` when no function is provided.
 *
 * The comparator function must return a positive number when `a > b`, 0 when
 * `a == b` and a negative number when `a < b`.
 *
 * @param {Function}
 * @return {PriorityQueue}
 * @api public
 */
function PriorityQueue(comparator) {
  this._comparator = comparator || PriorityQueue.DEFAULT_COMPARATOR;
  this._elements = [];
}

/**
 * Compares `a` and `b`, when `a > b` it returns a positive number, when
 * it returns 0 and when `a < b` it returns a negative number.
 *
 * @param {String|Number} a
 * @param {String|Number} b
 * @return {Number}
 * @api public
 */
PriorityQueue.DEFAULT_COMPARATOR = function(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  } else {
    a = a.toString();
    b = b.toString();

    if (a == b) return 0;

    return (a > b) ? 1 : -1;
  }
};

/**
 * Returns whether the priority queue is empty or not.
 *
 * @return {Boolean}
 * @api public
 */
PriorityQueue.prototype.isEmpty = function() {
  return this.size() === 0;
};

/**
 * Peeks at the top element of the priority queue.
 *
 * @return {Object}
 * @throws {Error} when the queue is empty.
 * @api public
 */
PriorityQueue.prototype.peek = function() {
  if (this.isEmpty()) throw new Error('PriorityQueue is empty');

  return this._elements[0];
};

/**
 * Dequeues the top element of the priority queue.
 *
 * @return {Object}
 * @throws {Error} when the queue is empty.
 * @api public
 */
PriorityQueue.prototype.deq = function() {
  var first = this.peek();
  var last = this._elements.pop();
  var size = this.size();

  if (size === 0) return first;

  this._elements[0] = last;
  var current = 0;

  while (current < size) {
    var largest = current;
    var left = (2 * current) + 1;
    var right = (2 * current) + 2;

    if (left < size && this._compare(left, largest) >= 0) {
      largest = left;
    }

    if (right < size && this._compare(right, largest) >= 0) {
      largest = right;
    }

    if (largest === current) break;

    this._swap(largest, current);
    current = largest;
  }

  return first;
};

/**
 * Enqueues the `element` at the priority queue and returns its new size.
 *
 * @param {Object} element
 * @return {Number}
 * @api public
 */
PriorityQueue.prototype.enq = function(element) {
  var size = this._elements.push(element);
  var current = size - 1;

  while (current > 0) {
    var parent = Math.floor((current - 1) / 2);

    if (this._compare(current, parent) <= 0) break;

    this._swap(parent, current);
    current = parent;
  }

  return size;
};

/**
 * Returns the size of the priority queue.
 *
 * @return {Number}
 * @api public
 */
PriorityQueue.prototype.size = function() {
  return this._elements.length;
};

/**
 *  Iterates over queue elements
 *
 *  @param {Function} fn
 */
PriorityQueue.prototype.forEach = function(fn) {
  return this._elements.forEach(fn);
};

/**
 * Compares the values at position `a` and `b` in the priority queue using its
 * comparator function.
 *
 * @param {Number} a
 * @param {Number} b
 * @return {Number}
 * @api private
 */
PriorityQueue.prototype._compare = function(a, b) {
  return this._comparator(this._elements[a], this._elements[b]);
};

/**
 * Swaps the values at position `a` and `b` in the priority queue.
 *
 * @param {Number} a
 * @param {Number} b
 * @api private
 */
PriorityQueue.prototype._swap = function(a, b) {
  var aux = this._elements[a];
  this._elements[a] = this._elements[b];
  this._elements[b] = aux;
};

},{}],51:[function(require,module,exports){
var validators = [
  [ /^(a\=candidate.*)$/, require('rtc-validator/candidate') ]
];

var reSdpLineBreak = /(\r?\n|\\r\\n)/;

/**
  # rtc-sdpclean

  Remove invalid lines from your SDP.

  ## Why?

  This module removes the occasional "bad egg" that will slip into SDP when it
  is generated by the browser.  In particular these situations are catered for:

  - invalid ICE candidates

**/
module.exports = function(input, opts) {
  var lineBreak = detectLineBreak(input);
  var lines = input.split(lineBreak);
  var collector = (opts || {}).collector;

  // filter out invalid lines
  lines = lines.filter(function(line) {
    // iterate through the validators and use the one that matches
    var validator = validators.reduce(function(memo, data, idx) {
      return typeof memo != 'undefined' ? memo : (data[0].exec(line) && {
        line: line.replace(data[0], '$1'),
        fn: data[1]
      });
    }, undefined);

    // if we have a validator, ensure we have no errors
    var errors = validator ? validator.fn(validator.line) : [];

    // if we have errors and an error collector, then add to the collector
    if (collector) {
      errors.forEach(function(err) {
        collector.push(err);
      });
    }

    return errors.length === 0;
  });

  return lines.join(lineBreak);
};

function detectLineBreak(input) {
  var match = reSdpLineBreak.exec(input);

  return match && match[0];
}

},{"rtc-validator/candidate":52}],52:[function(require,module,exports){
var debug = require('cog/logger')('rtc-validator');
var rePrefix = /^(?:a=)?candidate:/;
var reIP = /^(\d+\.){3}\d+$/;

/*

validation rules as per:
http://tools.ietf.org/html/draft-ietf-mmusic-ice-sip-sdp-03#section-8.1

   candidate-attribute   = "candidate" ":" foundation SP component-id SP
                           transport SP
                           priority SP
                           connection-address SP     ;from RFC 4566
                           port         ;port from RFC 4566
                           SP cand-type
                           [SP rel-addr]
                           [SP rel-port]
                           *(SP extension-att-name SP
                                extension-att-value)

   foundation            = 1*32ice-char
   component-id          = 1*5DIGIT
   transport             = "UDP" / transport-extension
   transport-extension   = token              ; from RFC 3261
   priority              = 1*10DIGIT
   cand-type             = "typ" SP candidate-types
   candidate-types       = "host" / "srflx" / "prflx" / "relay" / token
   rel-addr              = "raddr" SP connection-address
   rel-port              = "rport" SP port
   extension-att-name    = token
   extension-att-value   = *VCHAR
   ice-char              = ALPHA / DIGIT / "+" / "/"
*/
var partValidation = [
  [ /.+/, 'invalid foundation component', 'foundation' ],
  [ /\d+/, 'invalid component id', 'component-id' ],
  [ /(UDP|TCP)/i, 'transport must be TCP or UDP', 'transport' ],
  [ /\d+/, 'numeric priority expected', 'priority' ],
  [ reIP, 'invalid connection address', 'connection-address' ],
  [ /\d+/, 'invalid connection port', 'connection-port' ],
  [ /typ/, 'Expected "typ" identifier', 'type classifier' ],
  [ /.+/, 'Invalid candidate type specified', 'candidate-type' ]
];

/**
  ### `rtc-validator/candidate`

  Validate that an `RTCIceCandidate` (or plain old object with data, sdpMid,
  etc attributes) is a valid ice candidate.

  Specs reviewed as part of the validation implementation:

  - <http://tools.ietf.org/html/draft-ietf-mmusic-ice-sip-sdp-03#section-8.1>
  - <http://tools.ietf.org/html/rfc5245>

**/
module.exports = function(data) {
  var errors = [];
  var candidate = data && (data.candidate || data);
  var prefixMatch = candidate && rePrefix.exec(candidate);
  var parts = prefixMatch && candidate.slice(prefixMatch[0].length).split(/\s/);

  if (! candidate) {
    return [ new Error('empty candidate') ];
  }

  // check that the prefix matches expected
  if (! prefixMatch) {
    return [ new Error('candidate did not match expected sdp line format') ];
  }

  // perform the part validation
  errors = errors.concat(parts.map(validateParts)).filter(Boolean);

  return errors;
};

function validateParts(part, idx) {
  var validator = partValidation[idx];

  if (validator && (! validator[0].test(part))) {
    debug(validator[2] + ' part failed validation: ' + part);
    return new Error(validator[1]);
  }
}

},{"cog/logger":7}]},{},[1])(1)
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9ncnVudC1icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJpbmRleC5qcyIsIm1lc3Nlbmdlci5qcyIsIm5vZGVfbW9kdWxlcy9jb2cvZGVmYXVsdHMuanMiLCJub2RlX21vZHVsZXMvY29nL2V4dGVuZC5qcyIsIm5vZGVfbW9kdWxlcy9jb2cvZ2V0YWJsZS5qcyIsIm5vZGVfbW9kdWxlcy9jb2cvanNvbnBhcnNlLmpzIiwibm9kZV9tb2R1bGVzL2NvZy9sb2dnZXIuanMiLCJub2RlX21vZHVsZXMvY29nL3Rocm90dGxlLmpzIiwibm9kZV9tb2R1bGVzL2dydW50LWJyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3Byb2Nlc3MvYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy9tYnVzL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1jb3JlL2RldGVjdC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtY29yZS9nZW5pY2UuanMiLCJub2RlX21vZHVsZXMvcnRjLWNvcmUvbm9kZV9tb2R1bGVzL2RldGVjdC1icm93c2VyL2Jyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvcnRjLWNvcmUvcGx1Z2luLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvZGVmYXVsdHMuanMiLCJub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9oYW5kbGVycy9hbm5vdW5jZS5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL2hhbmRsZXJzL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvY3VpZC9kaXN0L2Jyb3dzZXItY3VpZC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXB1c2hhYmxlL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3B1bGwtcHVzaGFibGUvbm9kZV9tb2R1bGVzL3B1bGwtc3RyZWFtL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3B1bGwtcHVzaGFibGUvbm9kZV9tb2R1bGVzL3B1bGwtc3RyZWFtL21heWJlLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3B1bGwtcHVzaGFibGUvbm9kZV9tb2R1bGVzL3B1bGwtc3RyZWFtL25vZGVfbW9kdWxlcy9wdWxsLWNvcmUvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcHVsbC1wdXNoYWJsZS9ub2RlX21vZHVsZXMvcHVsbC1zdHJlYW0vc2lua3MuanMiLCJub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcHVsbC1wdXNoYWJsZS9ub2RlX21vZHVsZXMvcHVsbC1zdHJlYW0vc291cmNlcy5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXB1c2hhYmxlL25vZGVfbW9kdWxlcy9wdWxsLXN0cmVhbS90aHJvdWdocy5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXN0cmVhbS9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXN0cmVhbS9tYXliZS5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXN0cmVhbS9zaW5rcy5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXN0cmVhbS9zb3VyY2VzLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3B1bGwtc3RyZWFtL3Rocm91Z2hzLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvcHJvY2Vzc29yLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zd2l0Y2hib2FyZC1tZXNzZW5nZXIvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXN3aXRjaGJvYXJkLW1lc3Nlbmdlci9ub2RlX21vZHVsZXMvbWVzc2VuZ2VyLXdzL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zd2l0Y2hib2FyZC1tZXNzZW5nZXIvbm9kZV9tb2R1bGVzL21lc3Nlbmdlci13cy9ub2RlX21vZHVsZXMvcHVsbC13cy9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc3dpdGNoYm9hcmQtbWVzc2VuZ2VyL25vZGVfbW9kdWxlcy9tZXNzZW5nZXItd3Mvbm9kZV9tb2R1bGVzL3B1bGwtd3Mvbm9kZV9tb2R1bGVzL3B1bGwtY29yZS9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc3dpdGNoYm9hcmQtbWVzc2VuZ2VyL25vZGVfbW9kdWxlcy9tZXNzZW5nZXItd3Mvbm9kZV9tb2R1bGVzL3B1bGwtd3MvcmVhZHkuanMiLCJub2RlX21vZHVsZXMvcnRjLXN3aXRjaGJvYXJkLW1lc3Nlbmdlci9ub2RlX21vZHVsZXMvbWVzc2VuZ2VyLXdzL25vZGVfbW9kdWxlcy9wdWxsLXdzL3NpbmsuanMiLCJub2RlX21vZHVsZXMvcnRjLXN3aXRjaGJvYXJkLW1lc3Nlbmdlci9ub2RlX21vZHVsZXMvbWVzc2VuZ2VyLXdzL25vZGVfbW9kdWxlcy9wdWxsLXdzL3NvdXJjZS5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc3dpdGNoYm9hcmQtbWVzc2VuZ2VyL25vZGVfbW9kdWxlcy9tZXNzZW5nZXItd3Mvbm9kZV9tb2R1bGVzL3dzL2xpYi9icm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zd2l0Y2hib2FyZC1tZXNzZW5nZXIvbm9kZV9tb2R1bGVzL21lc3Nlbmdlci13cy9ub2RlX21vZHVsZXMvd3N1cmwvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL2NsZWFudXAuanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL2NvdXBsZS5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtdG9vbHMvZGV0ZWN0LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy10b29scy9nZW5lcmF0b3JzLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy10b29scy9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtdG9vbHMvbW9uaXRvci5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtdG9vbHMvbm9kZV9tb2R1bGVzL3J0Yy10YXNrcXVldWUvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL25vZGVfbW9kdWxlcy9ydGMtdGFza3F1ZXVlL25vZGVfbW9kdWxlcy9wcmlvcml0eXF1ZXVlanMvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL25vZGVfbW9kdWxlcy9ydGMtdGFza3F1ZXVlL25vZGVfbW9kdWxlcy9ydGMtc2RwY2xlYW4vaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL25vZGVfbW9kdWxlcy9ydGMtdGFza3F1ZXVlL25vZGVfbW9kdWxlcy9ydGMtdmFsaWRhdG9yL2NhbmRpZGF0ZS5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDOTFCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1BBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JJQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3S0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0VBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDYkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbmJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5R0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzFCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeERBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbkhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3RKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDcFNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMvREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQzVKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQ3ZVQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUMvQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUNuREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0VBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdk9BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDelZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUtBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dmFyIGY9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKTt0aHJvdyBmLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsZn12YXIgbD1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwobC5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxsLGwuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIHJ0YyA9IHJlcXVpcmUoJ3J0Yy10b29scycpO1xudmFyIG1idXMgPSByZXF1aXJlKCdtYnVzJyk7XG52YXIgY2xlYW51cCA9IHJlcXVpcmUoJ3J0Yy10b29scy9jbGVhbnVwJyk7XG52YXIgZGV0ZWN0UGx1Z2luID0gcmVxdWlyZSgncnRjLWNvcmUvcGx1Z2luJyk7XG52YXIgZGVidWcgPSBydGMubG9nZ2VyKCdydGMtcXVpY2tjb25uZWN0Jyk7XG52YXIgZGVmYXVsdHMgPSByZXF1aXJlKCdjb2cvZGVmYXVsdHMnKTtcbnZhciBleHRlbmQgPSByZXF1aXJlKCdjb2cvZXh0ZW5kJyk7XG52YXIgZ2V0YWJsZSA9IHJlcXVpcmUoJ2NvZy9nZXRhYmxlJyk7XG52YXIgbWVzc2VuZ2VyID0gcmVxdWlyZSgnLi9tZXNzZW5nZXInKTtcbnZhciByZVRyYWlsaW5nU2xhc2ggPSAvXFwvJC87XG5cbi8qKlxuICAjIHJ0Yy1xdWlja2Nvbm5lY3RcblxuICBUaGlzIGlzIGEgaGlnaCBsZXZlbCBoZWxwZXIgbW9kdWxlIGRlc2lnbmVkIHRvIGhlbHAgeW91IGdldCB1cFxuICBhbiBydW5uaW5nIHdpdGggV2ViUlRDIHJlYWxseSwgcmVhbGx5IHF1aWNrbHkuICBCeSB1c2luZyB0aGlzIG1vZHVsZSB5b3VcbiAgYXJlIHRyYWRpbmcgb2ZmIHNvbWUgZmxleGliaWxpdHksIHNvIGlmIHlvdSBuZWVkIGEgbW9yZSBmbGV4aWJsZVxuICBjb25maWd1cmF0aW9uIHlvdSBzaG91bGQgZHJpbGwgZG93biBpbnRvIGxvd2VyIGxldmVsIGNvbXBvbmVudHMgb2YgdGhlXG4gIFtydGMuaW9dKGh0dHA6Ly93d3cucnRjLmlvKSBzdWl0ZS4gIEluIHBhcnRpY3VsYXIgeW91IHNob3VsZCBjaGVjayBvdXRcbiAgW3J0Y10oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMpLlxuXG4gICMjIEV4YW1wbGUgVXNhZ2VcblxuICBJbiB0aGUgc2ltcGxlc3QgY2FzZSB5b3Ugc2ltcGx5IGNhbGwgcXVpY2tjb25uZWN0IHdpdGggYSBzaW5nbGUgc3RyaW5nXG4gIGFyZ3VtZW50IHdoaWNoIHRlbGxzIHF1aWNrY29ubmVjdCB3aGljaCBzZXJ2ZXIgdG8gdXNlIGZvciBzaWduYWxpbmc6XG5cbiAgPDw8IGV4YW1wbGVzL3NpbXBsZS5qc1xuXG4gIDw8PCBkb2NzL2V2ZW50cy5tZFxuXG4gIDw8PCBkb2NzL2V4YW1wbGVzLm1kXG5cbiAgIyMgUmVnYXJkaW5nIFNpZ25hbGxpbmcgYW5kIGEgU2lnbmFsbGluZyBTZXJ2ZXJcblxuICBTaWduYWxpbmcgaXMgYW4gaW1wb3J0YW50IHBhcnQgb2Ygc2V0dGluZyB1cCBhIFdlYlJUQyBjb25uZWN0aW9uIGFuZCBmb3JcbiAgb3VyIGV4YW1wbGVzIHdlIHVzZSBvdXIgb3duIHRlc3QgaW5zdGFuY2Ugb2YgdGhlXG4gIFtydGMtc3dpdGNoYm9hcmRdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLXN3aXRjaGJvYXJkKS4gRm9yIHlvdXJcbiAgdGVzdGluZyBhbmQgZGV2ZWxvcG1lbnQgeW91IGFyZSBtb3JlIHRoYW4gd2VsY29tZSB0byB1c2UgdGhpcyBhbHNvLCBidXRcbiAganVzdCBiZSBhd2FyZSB0aGF0IHdlIHVzZSB0aGlzIGZvciBvdXIgdGVzdGluZyBzbyBpdCBtYXkgZ28gdXAgYW5kIGRvd25cbiAgYSBsaXR0bGUuICBJZiB5b3UgbmVlZCBzb21ldGhpbmcgbW9yZSBzdGFibGUsIHdoeSBub3QgY29uc2lkZXIgZGVwbG95aW5nXG4gIGFuIGluc3RhbmNlIG9mIHRoZSBzd2l0Y2hib2FyZCB5b3Vyc2VsZiAtIGl0J3MgcHJldHR5IGVhc3kgOilcblxuICAjIyBSZWZlcmVuY2VcblxuICBgYGBcbiAgcXVpY2tjb25uZWN0KHNpZ25hbGhvc3QsIG9wdHM/KSA9PiBydGMtc2lnYWxsZXIgaW5zdGFuY2UgKCsgaGVscGVycylcbiAgYGBgXG5cbiAgIyMjIFZhbGlkIFF1aWNrIENvbm5lY3QgT3B0aW9uc1xuXG4gIFRoZSBvcHRpb25zIHByb3ZpZGVkIHRvIHRoZSBgcnRjLXF1aWNrY29ubmVjdGAgbW9kdWxlIGZ1bmN0aW9uIGluZmx1ZW5jZSB0aGVcbiAgYmVoYXZpb3VyIG9mIHNvbWUgb2YgdGhlIHVuZGVybHlpbmcgY29tcG9uZW50cyB1c2VkIGZyb20gdGhlIHJ0Yy5pbyBzdWl0ZS5cblxuICBMaXN0ZWQgYmVsb3cgYXJlIHNvbWUgb2YgdGhlIGNvbW1vbmx5IHVzZWQgb3B0aW9uczpcblxuICAtIGBuc2AgKGRlZmF1bHQ6ICcnKVxuXG4gICAgQW4gb3B0aW9uYWwgbmFtZXNwYWNlIGZvciB5b3VyIHNpZ25hbGxpbmcgcm9vbS4gIFdoaWxlIHF1aWNrY29ubmVjdFxuICAgIHdpbGwgZ2VuZXJhdGUgYSB1bmlxdWUgaGFzaCBmb3IgdGhlIHJvb20sIHRoaXMgY2FuIGJlIG1hZGUgdG8gYmUgbW9yZVxuICAgIHVuaXF1ZSBieSBwcm92aWRpbmcgYSBuYW1lc3BhY2UuICBVc2luZyBhIG5hbWVzcGFjZSBtZWFucyB0d28gZGVtb3NcbiAgICB0aGF0IGhhdmUgZ2VuZXJhdGVkIHRoZSBzYW1lIGhhc2ggYnV0IHVzZSBhIGRpZmZlcmVudCBuYW1lc3BhY2Ugd2lsbCBiZVxuICAgIGluIGRpZmZlcmVudCByb29tcy5cblxuICAtIGByb29tYCAoZGVmYXVsdDogbnVsbCkgX2FkZGVkIDAuNl9cblxuICAgIFJhdGhlciB0aGFuIHVzZSB0aGUgaW50ZXJuYWwgaGFzaCBnZW5lcmF0aW9uXG4gICAgKHBsdXMgb3B0aW9uYWwgbmFtZXNwYWNlKSBmb3Igcm9vbSBuYW1lIGdlbmVyYXRpb24sIHNpbXBseSB1c2UgdGhpcyByb29tXG4gICAgbmFtZSBpbnN0ZWFkLiAgX19OT1RFOl9fIFVzZSBvZiB0aGUgYHJvb21gIG9wdGlvbiB0YWtlcyBwcmVjZW5kZW5jZSBvdmVyXG4gICAgYG5zYC5cblxuICAtIGBkZWJ1Z2AgKGRlZmF1bHQ6IGZhbHNlKVxuXG4gIFdyaXRlIHJ0Yy5pbyBzdWl0ZSBkZWJ1ZyBvdXRwdXQgdG8gdGhlIGJyb3dzZXIgY29uc29sZS5cblxuICAtIGBleHBlY3RlZExvY2FsU3RyZWFtc2AgKGRlZmF1bHQ6IG5vdCBzcGVjaWZpZWQpIF9hZGRlZCAzLjBfXG5cbiAgICBCeSBwcm92aWRpbmcgYSBwb3NpdGl2ZSBpbnRlZ2VyIHZhbHVlIGZvciB0aGlzIG9wdGlvbiB3aWxsIG1lYW4gdGhhdFxuICAgIHRoZSBjcmVhdGVkIHF1aWNrY29ubmVjdCBpbnN0YW5jZSB3aWxsIHdhaXQgdW50aWwgdGhlIHNwZWNpZmllZCBudW1iZXIgb2ZcbiAgICBzdHJlYW1zIGhhdmUgYmVlbiBhZGRlZCB0byB0aGUgcXVpY2tjb25uZWN0IFwidGVtcGxhdGVcIiBiZWZvcmUgYW5ub3VuY2luZ1xuICAgIHRvIHRoZSBzaWduYWxpbmcgc2VydmVyLlxuXG4gIC0gYG1hbnVhbEpvaW5gIChkZWZhdWx0OiBgZmFsc2VgKVxuXG4gICAgU2V0IHRoaXMgdmFsdWUgdG8gYHRydWVgIGlmIHlvdSB3b3VsZCBwcmVmZXIgdG8gY2FsbCB0aGUgYGpvaW5gIGZ1bmN0aW9uXG4gICAgdG8gY29ubmVjdGluZyB0byB0aGUgc2lnbmFsbGluZyBzZXJ2ZXIsIHJhdGhlciB0aGFuIGhhdmluZyB0aGF0IGhhcHBlblxuICAgIGF1dG9tYXRpY2FsbHkgYXMgc29vbiBhcyBxdWlja2Nvbm5lY3QgaXMgcmVhZHkgdG8uXG5cbiAgIyMjIyBPcHRpb25zIGZvciBQZWVyIENvbm5lY3Rpb24gQ3JlYXRpb25cblxuICBPcHRpb25zIHRoYXQgYXJlIHBhc3NlZCBvbnRvIHRoZVxuICBbcnRjLmNyZWF0ZUNvbm5lY3Rpb25dKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjI2NyZWF0ZWNvbm5lY3Rpb25vcHRzLWNvbnN0cmFpbnRzKVxuICBmdW5jdGlvbjpcblxuICAtIGBpY2VTZXJ2ZXJzYFxuXG4gIFRoaXMgcHJvdmlkZXMgYSBsaXN0IG9mIGljZSBzZXJ2ZXJzIHRoYXQgY2FuIGJlIHVzZWQgdG8gaGVscCBuZWdvdGlhdGUgYVxuICBjb25uZWN0aW9uIGJldHdlZW4gcGVlcnMuXG5cbiAgIyMjIyBPcHRpb25zIGZvciBQMlAgbmVnb3RpYXRpb25cblxuICBVbmRlciB0aGUgaG9vZCwgcXVpY2tjb25uZWN0IHVzZXMgdGhlXG4gIFtydGMvY291cGxlXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0YyNydGNjb3VwbGUpIGxvZ2ljLCBhbmQgdGhlIG9wdGlvbnNcbiAgcGFzc2VkIHRvIHF1aWNrY29ubmVjdCBhcmUgYWxzbyBwYXNzZWQgb250byB0aGlzIGZ1bmN0aW9uLlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oc2lnbmFsaG9zdCwgb3B0cykge1xuICB2YXIgaGFzaCA9IHR5cGVvZiBsb2NhdGlvbiAhPSAndW5kZWZpbmVkJyAmJiBsb2NhdGlvbi5oYXNoLnNsaWNlKDEpO1xuICB2YXIgc2lnbmFsbGVyID0gcmVxdWlyZSgncnRjLXNpZ25hbGxlcicpKG1lc3NlbmdlcihzaWduYWxob3N0KSwgb3B0cyk7XG5cbiAgLy8gaW5pdCBjb25maWd1cmFibGUgdmFyc1xuICB2YXIgbnMgPSAob3B0cyB8fCB7fSkubnMgfHwgJyc7XG4gIHZhciByb29tID0gKG9wdHMgfHwge30pLnJvb207XG4gIHZhciBkZWJ1Z2dpbmcgPSAob3B0cyB8fCB7fSkuZGVidWc7XG4gIHZhciBhbGxvd0pvaW4gPSAhKG9wdHMgfHwge30pLm1hbnVhbEpvaW47XG4gIHZhciBoZWFydGJlYXQgPSAob3B0cyB8fCB7fSkuaGVhcnRiZWF0IHx8IDI1MDA7XG4gIHZhciBwcm9maWxlID0ge307XG4gIHZhciBhbm5vdW5jZWQgPSBmYWxzZTtcblxuICAvLyBpbml0aWFsaXNlIGljZVNlcnZlcnMgdG8gdW5kZWZpbmVkXG4gIC8vIHdlIHdpbGwgbm90IGFubm91bmNlIHVudGlsIHRoZXNlIGhhdmUgYmVlbiBwcm9wZXJseSBpbml0aWFsaXNlZFxuICB2YXIgaWNlU2VydmVycztcblxuICAvLyBjb2xsZWN0IHRoZSBsb2NhbCBzdHJlYW1zXG4gIHZhciBsb2NhbFN0cmVhbXMgPSBbXTtcblxuICAvLyBjcmVhdGUgdGhlIGNhbGxzIG1hcFxuICB2YXIgY2FsbHMgPSBzaWduYWxsZXIuY2FsbHMgPSBnZXRhYmxlKHt9KTtcblxuICAvLyBjcmVhdGUgdGhlIGtub3duIGRhdGEgY2hhbm5lbHMgcmVnaXN0cnlcbiAgdmFyIGNoYW5uZWxzID0ge307XG5cbiAgLy8gc2F2ZSB0aGUgcGx1Z2lucyBwYXNzZWQgdG8gdGhlIHNpZ25hbGxlclxuICB2YXIgcGx1Z2lucyA9IHNpZ25hbGxlci5wbHVnaW5zID0gKG9wdHMgfHwge30pLnBsdWdpbnMgfHwgW107XG4gIHZhciBwbHVnaW4gPSBkZXRlY3RQbHVnaW4oc2lnbmFsbGVyLnBsdWdpbnMpO1xuICB2YXIgcGx1Z2luUmVhZHk7XG5cbiAgLy8gY2hlY2sgaG93IG1hbnkgbG9jYWwgc3RyZWFtcyBoYXZlIGJlZW4gZXhwZWN0ZWQgKGRlZmF1bHQ6IDApXG4gIHZhciBleHBlY3RlZExvY2FsU3RyZWFtcyA9IHBhcnNlSW50KChvcHRzIHx8IHt9KS5leHBlY3RlZExvY2FsU3RyZWFtcywgMTApIHx8IDA7XG4gIHZhciBhbm5vdW5jZVRpbWVyID0gMDtcbiAgdmFyIGhlYXJ0YmVhdFRpbWVyID0gMDtcbiAgdmFyIHVwZGF0ZVRpbWVyID0gMDtcblxuICBmdW5jdGlvbiBjYWxsQ3JlYXRlKGlkLCBwYykge1xuICAgIGNhbGxzLnNldChpZCwge1xuICAgICAgYWN0aXZlOiBmYWxzZSxcbiAgICAgIHBjOiBwYyxcbiAgICAgIGNoYW5uZWxzOiBnZXRhYmxlKHt9KSxcbiAgICAgIHN0cmVhbXM6IFtdLFxuICAgICAgbGFzdHBpbmc6IERhdGUubm93KClcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNhbGxFbmQoaWQpIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChpZCk7XG5cbiAgICAvLyBpZiB3ZSBoYXZlIG5vIGRhdGEsIHRoZW4gZG8gbm90aGluZ1xuICAgIGlmICghIGNhbGwpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBkZWJ1ZygnZW5kaW5nIGNhbGwgdG86ICcgKyBpZCk7XG5cbiAgICAvLyBpZiB3ZSBoYXZlIG5vIGRhdGEsIHRoZW4gcmV0dXJuXG4gICAgY2FsbC5jaGFubmVscy5rZXlzKCkuZm9yRWFjaChmdW5jdGlvbihsYWJlbCkge1xuICAgICAgdmFyIGNoYW5uZWwgPSBjYWxsLmNoYW5uZWxzLmdldChsYWJlbCk7XG4gICAgICB2YXIgYXJncyA9IFtpZCwgY2hhbm5lbCwgbGFiZWxdO1xuXG4gICAgICAvLyBlbWl0IHRoZSBwbGFpbiBjaGFubmVsOmNsb3NlZCBldmVudFxuICAgICAgc2lnbmFsbGVyLmFwcGx5KHNpZ25hbGxlciwgWydjaGFubmVsOmNsb3NlZCddLmNvbmNhdChhcmdzKSk7XG5cbiAgICAgIC8vIGVtaXQgdGhlIGxhYmVsbGVkIHZlcnNpb24gb2YgdGhlIGV2ZW50XG4gICAgICBzaWduYWxsZXIuYXBwbHkoc2lnbmFsbGVyLCBbJ2NoYW5uZWw6Y2xvc2VkOicgKyBsYWJlbF0uY29uY2F0KGFyZ3MpKTtcblxuICAgICAgLy8gZGVjb3VwbGUgdGhlIGV2ZW50c1xuICAgICAgY2hhbm5lbC5vbm9wZW4gPSBudWxsO1xuICAgIH0pO1xuXG4gICAgLy8gdHJpZ2dlciBzdHJlYW06cmVtb3ZlZCBldmVudHMgZm9yIGVhY2ggb2YgdGhlIHJlbW90ZXN0cmVhbXMgaW4gdGhlIHBjXG4gICAgY2FsbC5zdHJlYW1zLmZvckVhY2goZnVuY3Rpb24oc3RyZWFtKSB7XG4gICAgICBzaWduYWxsZXIoJ3N0cmVhbTpyZW1vdmVkJywgaWQsIHN0cmVhbSk7XG4gICAgfSk7XG5cbiAgICAvLyBkZWxldGUgdGhlIGNhbGwgZGF0YVxuICAgIGNhbGxzLmRlbGV0ZShpZCk7XG5cbiAgICAvLyBpZiB3ZSBoYXZlIG5vIG1vcmUgY2FsbHMsIGRpc2FibGUgdGhlIGhlYXJ0YmVhdFxuICAgIGlmIChjYWxscy5rZXlzKCkubGVuZ3RoID09PSAwKSB7XG4gICAgICBoYlJlc2V0KCk7XG4gICAgfVxuXG4gICAgLy8gdHJpZ2dlciB0aGUgY2FsbDplbmRlZCBldmVudFxuICAgIHNpZ25hbGxlcignY2FsbDplbmRlZCcsIGlkLCBjYWxsLnBjKTtcblxuICAgIC8vIGVuc3VyZSB0aGUgcGVlciBjb25uZWN0aW9uIGlzIHByb3Blcmx5IGNsZWFuZWQgdXBcbiAgICBjbGVhbnVwKGNhbGwucGMpO1xuICB9XG5cbiAgZnVuY3Rpb24gY2FsbFN0YXJ0KGlkLCBwYywgZGF0YSkge1xuICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KGlkKTtcbiAgICB2YXIgc3RyZWFtcyA9IFtdLmNvbmNhdChwYy5nZXRSZW1vdGVTdHJlYW1zKCkpO1xuXG4gICAgLy8gZmxhZyB0aGUgY2FsbCBhcyBhY3RpdmVcbiAgICBjYWxsLmFjdGl2ZSA9IHRydWU7XG4gICAgY2FsbC5zdHJlYW1zID0gW10uY29uY2F0KHBjLmdldFJlbW90ZVN0cmVhbXMoKSk7XG5cbiAgICBwYy5vbmFkZHN0cmVhbSA9IGNyZWF0ZVN0cmVhbUFkZEhhbmRsZXIoaWQpO1xuICAgIHBjLm9ucmVtb3Zlc3RyZWFtID0gY3JlYXRlU3RyZWFtUmVtb3ZlSGFuZGxlcihpZCk7XG5cbiAgICBkZWJ1ZyhzaWduYWxsZXIuaWQgKyAnIC0gJyArIGlkICsgJyBjYWxsIHN0YXJ0OiAnICsgc3RyZWFtcy5sZW5ndGggKyAnIHN0cmVhbXMnKTtcbiAgICBzaWduYWxsZXIoJ2NhbGw6c3RhcnRlZCcsIGlkLCBwYywgZGF0YSk7XG5cbiAgICAvLyBjb25maWd1cmUgdGhlIGhlYXJ0YmVhdCB0aW1lclxuICAgIGhiSW5pdCgpO1xuXG4gICAgLy8gZXhhbWluZSB0aGUgZXhpc3RpbmcgcmVtb3RlIHN0cmVhbXMgYWZ0ZXIgYSBzaG9ydCBkZWxheVxuICAgIHByb2Nlc3MubmV4dFRpY2soZnVuY3Rpb24oKSB7XG4gICAgICAvLyBpdGVyYXRlIHRocm91Z2ggYW55IHJlbW90ZSBzdHJlYW1zXG4gICAgICBzdHJlYW1zLmZvckVhY2gocmVjZWl2ZVJlbW90ZVN0cmVhbShpZCkpO1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gY2hlY2tSZWFkeVRvQW5ub3VuY2UoKSB7XG4gICAgY2xlYXJUaW1lb3V0KGFubm91bmNlVGltZXIpO1xuICAgIC8vIGlmIHdlIGhhdmUgYWxyZWFkeSBhbm5vdW5jZWQgZG8gbm90aGluZyFcbiAgICBpZiAoYW5ub3VuY2VkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKCEgYWxsb3dKb2luKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gaWYgd2UgaGF2ZSBhIHBsdWdpbiBidXQgaXQncyBub3QgaW5pdGlhbGl6ZWQgd2UgYXJlbid0IHJlYWR5XG4gICAgaWYgKHBsdWdpbiAmJiAoISBwbHVnaW5SZWFkeSkpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBpZiB3ZSBoYXZlIG5vIGljZVNlcnZlcnMgd2UgYXJlbid0IHJlYWR5XG4gICAgaWYgKCEgaWNlU2VydmVycykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIGlmIHdlIGFyZSB3YWl0aW5nIGZvciBhIHNldCBudW1iZXIgb2Ygc3RyZWFtcywgdGhlbiB3YWl0IHVudGlsIHdlIGhhdmVcbiAgICAvLyB0aGUgcmVxdWlyZWQgbnVtYmVyXG4gICAgaWYgKGV4cGVjdGVkTG9jYWxTdHJlYW1zICYmIGxvY2FsU3RyZWFtcy5sZW5ndGggPCBleHBlY3RlZExvY2FsU3RyZWFtcykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIGFubm91bmNlIG91cnNlbHZlcyB0byBvdXIgbmV3IGZyaWVuZFxuICAgIGFubm91bmNlVGltZXIgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIGRhdGEgPSBleHRlbmQoeyByb29tOiByb29tIH0sIHByb2ZpbGUpO1xuXG4gICAgICAvLyBhbm5vdW5jZSBhbmQgZW1pdCB0aGUgbG9jYWwgYW5ub3VuY2UgZXZlbnRcbiAgICAgIHNpZ25hbGxlci5hbm5vdW5jZShkYXRhKTtcbiAgICAgIGFubm91bmNlZCA9IHRydWU7XG4gICAgfSwgMCk7XG4gIH1cblxuIGZ1bmN0aW9uIGNvbm5lY3QoaWQpIHtcbiAgICB2YXIgZGF0YSA9IGdldFBlZXJEYXRhKGlkKTtcbiAgICB2YXIgcGM7XG4gICAgdmFyIG1vbml0b3I7XG5cbiAgICAvLyBpZiB0aGUgcm9vbSBpcyBub3QgYSBtYXRjaCwgYWJvcnRcbiAgICBpZiAoZGF0YS5yb29tICE9PSByb29tKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gZW5kIGFueSBjYWxsIHRvIHRoaXMgaWQgc28gd2Uga25vdyB3ZSBhcmUgc3RhcnRpbmcgZnJlc2hcbiAgICBjYWxsRW5kKGlkKTtcblxuICAgIC8vIGNyZWF0ZSBhIHBlZXIgY29ubmVjdGlvblxuICAgIC8vIGljZVNlcnZlcnMgdGhhdCBoYXZlIGJlZW4gY3JlYXRlZCB1c2luZyBnZW5pY2UgdGFraW5nIHByZWNlbmRlbmNlXG4gICAgcGMgPSBydGMuY3JlYXRlQ29ubmVjdGlvbihcbiAgICAgIGV4dGVuZCh7fSwgb3B0cywgeyBpY2VTZXJ2ZXJzOiBpY2VTZXJ2ZXJzIH0pLFxuICAgICAgKG9wdHMgfHwge30pLmNvbnN0cmFpbnRzXG4gICAgKTtcblxuICAgIHNpZ25hbGxlcigncGVlcjpjb25uZWN0JywgZGF0YS5pZCwgcGMsIGRhdGEpO1xuXG4gICAgLy8gYWRkIHRoaXMgY29ubmVjdGlvbiB0byB0aGUgY2FsbHMgbGlzdFxuICAgIGNhbGxDcmVhdGUoZGF0YS5pZCwgcGMpO1xuXG4gICAgLy8gYWRkIHRoZSBsb2NhbCBzdHJlYW1zXG4gICAgbG9jYWxTdHJlYW1zLmZvckVhY2goZnVuY3Rpb24oc3RyZWFtLCBpZHgpIHtcbiAgICAgIHBjLmFkZFN0cmVhbShzdHJlYW0pO1xuICAgIH0pO1xuXG4gICAgLy8gYWRkIHRoZSBkYXRhIGNoYW5uZWxzXG4gICAgLy8gZG8gdGhpcyBkaWZmZXJlbnRseSBiYXNlZCBvbiB3aGV0aGVyIHRoZSBjb25uZWN0aW9uIGlzIGFcbiAgICAvLyBtYXN0ZXIgb3IgYSBzbGF2ZSBjb25uZWN0aW9uXG4gICAgaWYgKHNpZ25hbGxlci5pc01hc3RlcihkYXRhLmlkKSkge1xuICAgICAgZGVidWcoJ2lzIG1hc3RlciwgY3JlYXRpbmcgZGF0YSBjaGFubmVsczogJywgT2JqZWN0LmtleXMoY2hhbm5lbHMpKTtcblxuICAgICAgLy8gY3JlYXRlIHRoZSBjaGFubmVsc1xuICAgICAgT2JqZWN0LmtleXMoY2hhbm5lbHMpLmZvckVhY2goZnVuY3Rpb24obGFiZWwpIHtcbiAgICAgICBnb3RQZWVyQ2hhbm5lbChwYy5jcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCwgY2hhbm5lbHNbbGFiZWxdKSwgcGMsIGRhdGEpO1xuICAgICAgfSk7XG4gICAgfVxuICAgIGVsc2Uge1xuICAgICAgcGMub25kYXRhY2hhbm5lbCA9IGZ1bmN0aW9uKGV2dCkge1xuICAgICAgICB2YXIgY2hhbm5lbCA9IGV2dCAmJiBldnQuY2hhbm5lbDtcblxuICAgICAgICAvLyBpZiB3ZSBoYXZlIG5vIGNoYW5uZWwsIGFib3J0XG4gICAgICAgIGlmICghIGNoYW5uZWwpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY2hhbm5lbHNbY2hhbm5lbC5sYWJlbF0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGdvdFBlZXJDaGFubmVsKGNoYW5uZWwsIHBjLCBnZXRQZWVyRGF0YShpZCkpO1xuICAgICAgICB9XG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIGNvdXBsZSB0aGUgY29ubmVjdGlvbnNcbiAgICBkZWJ1ZygnY291cGxpbmcgJyArIHNpZ25hbGxlci5pZCArICcgdG8gJyArIGRhdGEuaWQpO1xuICAgIG1vbml0b3IgPSBydGMuY291cGxlKHBjLCBpZCwgc2lnbmFsbGVyLCBleHRlbmQoe30sIG9wdHMsIHtcbiAgICAgIGxvZ2dlcjogbWJ1cygncGMuJyArIGlkLCBzaWduYWxsZXIpXG4gICAgfSkpO1xuXG4gICAgc2lnbmFsbGVyKCdwZWVyOmNvdXBsZScsIGlkLCBwYywgZGF0YSwgbW9uaXRvcik7XG5cbiAgICAvLyBvbmNlIGFjdGl2ZSwgdHJpZ2dlciB0aGUgcGVlciBjb25uZWN0IGV2ZW50XG4gICAgbW9uaXRvci5vbmNlKCdjb25uZWN0ZWQnLCBjYWxsU3RhcnQuYmluZChudWxsLCBpZCwgcGMsIGRhdGEpKVxuICAgIG1vbml0b3Iub25jZSgnY2xvc2VkJywgY2FsbEVuZC5iaW5kKG51bGwsIGlkKSk7XG5cbiAgICAvLyBpZiB3ZSBhcmUgdGhlIG1hc3RlciBjb25ubmVjdGlvbiwgY3JlYXRlIHRoZSBvZmZlclxuICAgIC8vIE5PVEU6IHRoaXMgb25seSByZWFsbHkgZm9yIHRoZSBzYWtlIG9mIHBvbGl0ZW5lc3MsIGFzIHJ0YyBjb3VwbGVcbiAgICAvLyBpbXBsZW1lbnRhdGlvbiBoYW5kbGVzIHRoZSBzbGF2ZSBhdHRlbXB0aW5nIHRvIGNyZWF0ZSBhbiBvZmZlclxuICAgIGlmIChzaWduYWxsZXIuaXNNYXN0ZXIoaWQpKSB7XG4gICAgICBtb25pdG9yLmNyZWF0ZU9mZmVyKCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gY3JlYXRlU3RyZWFtQWRkSGFuZGxlcihpZCkge1xuICAgIHJldHVybiBmdW5jdGlvbihldnQpIHtcbiAgICAgIGRlYnVnKCdwZWVyICcgKyBpZCArICcgYWRkZWQgc3RyZWFtJyk7XG4gICAgICB1cGRhdGVSZW1vdGVTdHJlYW1zKGlkKTtcbiAgICAgIHJlY2VpdmVSZW1vdGVTdHJlYW0oaWQpKGV2dC5zdHJlYW0pO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGNyZWF0ZVN0cmVhbVJlbW92ZUhhbmRsZXIoaWQpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24oZXZ0KSB7XG4gICAgICBkZWJ1ZygncGVlciAnICsgaWQgKyAnIHJlbW92ZWQgc3RyZWFtJyk7XG4gICAgICB1cGRhdGVSZW1vdGVTdHJlYW1zKGlkKTtcbiAgICAgIHNpZ25hbGxlcignc3RyZWFtOnJlbW92ZWQnLCBpZCwgZXZ0LnN0cmVhbSk7XG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGdldEFjdGl2ZUNhbGwocGVlcklkKSB7XG4gICAgdmFyIGNhbGwgPSBjYWxscy5nZXQocGVlcklkKTtcblxuICAgIGlmICghIGNhbGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gYWN0aXZlIGNhbGwgZm9yIHBlZXI6ICcgKyBwZWVySWQpO1xuICAgIH1cblxuICAgIHJldHVybiBjYWxsO1xuICB9XG5cbiAgZnVuY3Rpb24gZ2V0UGVlckRhdGEoaWQpIHtcbiAgICB2YXIgcGVlciA9IHNpZ25hbGxlci5wZWVycy5nZXQoaWQpO1xuXG4gICAgcmV0dXJuIHBlZXIgJiYgcGVlci5kYXRhO1xuICB9XG5cbiAgZnVuY3Rpb24gZ290UGVlckNoYW5uZWwoY2hhbm5lbCwgcGMsIGRhdGEpIHtcbiAgICB2YXIgY2hhbm5lbE1vbml0b3I7XG5cbiAgICBmdW5jdGlvbiBjaGFubmVsUmVhZHkoKSB7XG4gICAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChkYXRhLmlkKTtcbiAgICAgIHZhciBhcmdzID0gWyBkYXRhLmlkLCBjaGFubmVsLCBkYXRhLCBwYyBdO1xuXG4gICAgICAvLyBkZWNvdXBsZSB0aGUgY2hhbm5lbC5vbm9wZW4gbGlzdGVuZXJcbiAgICAgIGRlYnVnKCdyZXBvcnRpbmcgY2hhbm5lbCBcIicgKyBjaGFubmVsLmxhYmVsICsgJ1wiIHJlYWR5LCBoYXZlIGNhbGw6ICcgKyAoISFjYWxsKSk7XG4gICAgICBjbGVhckludGVydmFsKGNoYW5uZWxNb25pdG9yKTtcbiAgICAgIGNoYW5uZWwub25vcGVuID0gbnVsbDtcblxuICAgICAgLy8gc2F2ZSB0aGUgY2hhbm5lbFxuICAgICAgaWYgKGNhbGwpIHtcbiAgICAgICAgY2FsbC5jaGFubmVscy5zZXQoY2hhbm5lbC5sYWJlbCwgY2hhbm5lbCk7XG4gICAgICB9XG5cbiAgICAgIC8vIHRyaWdnZXIgdGhlICVjaGFubmVsLmxhYmVsJTpvcGVuIGV2ZW50XG4gICAgICBkZWJ1ZygndHJpZ2dlcmluZyBjaGFubmVsOm9wZW5lZCBldmVudHMgZm9yIGNoYW5uZWw6ICcgKyBjaGFubmVsLmxhYmVsKTtcblxuICAgICAgLy8gZW1pdCB0aGUgcGxhaW4gY2hhbm5lbDpvcGVuZWQgZXZlbnRcbiAgICAgIHNpZ25hbGxlci5hcHBseShzaWduYWxsZXIsIFsnY2hhbm5lbDpvcGVuZWQnXS5jb25jYXQoYXJncykpO1xuXG4gICAgICAvLyBlbWl0IHRoZSBjaGFubmVsOm9wZW5lZDolbGFiZWwlIGV2ZVxuICAgICAgc2lnbmFsbGVyLmFwcGx5KFxuICAgICAgICBzaWduYWxsZXIsXG4gICAgICAgIFsnY2hhbm5lbDpvcGVuZWQ6JyArIGNoYW5uZWwubGFiZWxdLmNvbmNhdChhcmdzKVxuICAgICAgKTtcbiAgICB9XG5cbiAgICBkZWJ1ZygnY2hhbm5lbCAnICsgY2hhbm5lbC5sYWJlbCArICcgZGlzY292ZXJlZCBmb3IgcGVlcjogJyArIGRhdGEuaWQpO1xuICAgIGlmIChjaGFubmVsLnJlYWR5U3RhdGUgPT09ICdvcGVuJykge1xuICAgICAgcmV0dXJuIGNoYW5uZWxSZWFkeSgpO1xuICAgIH1cblxuICAgIGRlYnVnKCdjaGFubmVsIG5vdCByZWFkeSwgY3VycmVudCBzdGF0ZSA9ICcgKyBjaGFubmVsLnJlYWR5U3RhdGUpO1xuICAgIGNoYW5uZWwub25vcGVuID0gY2hhbm5lbFJlYWR5O1xuXG4gICAgLy8gbW9uaXRvciB0aGUgY2hhbm5lbCBvcGVuIChkb24ndCB0cnVzdCB0aGUgY2hhbm5lbCBvcGVuIGV2ZW50IGp1c3QgeWV0KVxuICAgIGNoYW5uZWxNb25pdG9yID0gc2V0SW50ZXJ2YWwoZnVuY3Rpb24oKSB7XG4gICAgICBkZWJ1ZygnY2hlY2tpbmcgY2hhbm5lbCBzdGF0ZSwgY3VycmVudCBzdGF0ZSA9ICcgKyBjaGFubmVsLnJlYWR5U3RhdGUpO1xuICAgICAgaWYgKGNoYW5uZWwucmVhZHlTdGF0ZSA9PT0gJ29wZW4nKSB7XG4gICAgICAgIGNoYW5uZWxSZWFkeSgpO1xuICAgICAgfVxuICAgIH0sIDUwMCk7XG4gIH1cblxuICBmdW5jdGlvbiBoYkluaXQoKSB7XG4gICAgLy8gaWYgdGhlIGhlYXJ0YmVhdCB0aW1lciBpcyBhY3RpdmUsIG9yIGhlYXJ0YmVhdCBoYXMgYmVlbiBkaXNhYmxlZCAoMCwgZmFsc2UsIGV0YykgcmV0dXJuXG4gICAgaWYgKGhlYXJ0YmVhdFRpbWVyIHx8ICghIGhlYXJ0YmVhdCkpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBoZWFydGJlYXRUaW1lciA9IHNldEludGVydmFsKGhiU2VuZCwgaGVhcnRiZWF0KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhiU2VuZCgpIHtcbiAgICB2YXIgdGlja0luYWN0aXZlID0gKERhdGUubm93KCkgLSAoaGVhcnRiZWF0ICogNCkpO1xuXG4gICAgLy8gaXRlcmF0ZSB0aHJvdWdoIG91ciBlc3RhYmxpc2hlZCBjYWxsc1xuICAgIGNhbGxzLmtleXMoKS5mb3JFYWNoKGZ1bmN0aW9uKGlkKSB7XG4gICAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChpZCk7XG5cbiAgICAgIC8vIGlmIHRoZSBjYWxsIHBpbmcgaXMgdG9vIG9sZCwgZW5kIHRoZSBjYWxsXG4gICAgICBpZiAoY2FsbC5sYXN0cGluZyA8IHRpY2tJbmFjdGl2ZSkge1xuICAgICAgICByZXR1cm4gY2FsbEVuZChpZCk7XG4gICAgICB9XG5cbiAgICAgIC8vIHNlbmQgYSBwaW5nIG1lc3NhZ2VcbiAgICAgIHNpZ25hbGxlci50byhpZCkuc2VuZCgnL3BpbmcnKTtcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhiUmVzZXQoKSB7XG4gICAgY2xlYXJJbnRlcnZhbChoZWFydGJlYXRUaW1lcik7XG4gICAgaGVhcnRiZWF0VGltZXIgPSAwO1xuICB9XG5cbiAgZnVuY3Rpb24gaW5pdFBsdWdpbigpIHtcbiAgICByZXR1cm4gcGx1Z2luICYmIHBsdWdpbi5pbml0KG9wdHMsIGZ1bmN0aW9uKGVycikge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICByZXR1cm4gY29uc29sZS5lcnJvcignQ291bGQgbm90IGluaXRpYWxpemUgcGx1Z2luOiAnLCBlcnIpO1xuICAgICAgfVxuXG4gICAgICBwbHVnaW5SZWFkeSA9IHRydWU7XG4gICAgICBjaGVja1JlYWR5VG9Bbm5vdW5jZSgpO1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlTG9jYWxBbm5vdW5jZShkYXRhKSB7XG4gICAgLy8gaWYgd2Ugc2VuZCBhbiBhbm5vdW5jZSB3aXRoIGFuIHVwZGF0ZWQgcm9vbSB0aGVuIHVwZGF0ZSBvdXIgbG9jYWwgcm9vbSBuYW1lXG4gICAgaWYgKGRhdGEgJiYgdHlwZW9mIGRhdGEucm9vbSAhPSAndW5kZWZpbmVkJykge1xuICAgICAgcm9vbSA9IGRhdGEucm9vbTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVQZWVyRmlsdGVyKGlkLCBkYXRhKSB7XG4gICAgLy8gb25seSBjb25uZWN0IHdpdGggdGhlIHBlZXIgaWYgd2UgYXJlIHJlYWR5XG4gICAgZGF0YS5hbGxvdyA9IGRhdGEuYWxsb3cgJiYgKGxvY2FsU3RyZWFtcy5sZW5ndGggPj0gZXhwZWN0ZWRMb2NhbFN0cmVhbXMpO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlUGVlclVwZGF0ZShkYXRhKSB7XG4gICAgdmFyIGlkID0gZGF0YSAmJiBkYXRhLmlkO1xuICAgIHZhciBhY3RpdmVDYWxsID0gaWQgJiYgY2FsbHMuZ2V0KGlkKTtcblxuICAgIC8vIGlmIHdlIGhhdmUgcmVjZWl2ZWQgYW4gdXBkYXRlIGZvciBhIHBlZXIgdGhhdCBoYXMgbm8gYWN0aXZlIGNhbGxzLFxuICAgIC8vIHRoZW4gcGFzcyB0aGlzIG9udG8gdGhlIGFubm91bmNlIGhhbmRsZXJcbiAgICBpZiAoaWQgJiYgKCEgYWN0aXZlQ2FsbCkpIHtcbiAgICAgIGRlYnVnKCdyZWNlaXZlZCBwZWVyIHVwZGF0ZSBmcm9tIHBlZXIgJyArIGlkICsgJywgbm8gYWN0aXZlIGNhbGxzJyk7XG4gICAgICBzaWduYWxsZXIudG8oaWQpLnNlbmQoJy9yZWNvbm5lY3QnKTtcbiAgICAgIHJldHVybiBjb25uZWN0KGlkKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVQaW5nKHNlbmRlcikge1xuICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KHNlbmRlciAmJiBzZW5kZXIuaWQpO1xuXG4gICAgLy8gc2V0IHRoZSBsYXN0IHBpbmcgZm9yIHRoZSBkYXRhXG4gICAgaWYgKGNhbGwpIHtcbiAgICAgIGNhbGwubGFzdHBpbmcgPSBEYXRlLm5vdygpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHJlY2VpdmVSZW1vdGVTdHJlYW0oaWQpIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChpZCk7XG5cbiAgICByZXR1cm4gZnVuY3Rpb24oc3RyZWFtKSB7XG4gICAgICBzaWduYWxsZXIoJ3N0cmVhbTphZGRlZCcsIGlkLCBzdHJlYW0sIGdldFBlZXJEYXRhKGlkKSk7XG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHVwZGF0ZVJlbW90ZVN0cmVhbXMoaWQpIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChpZCk7XG5cbiAgICBpZiAoY2FsbCAmJiBjYWxsLnBjKSB7XG4gICAgICBjYWxsLnN0cmVhbXMgPSBbXS5jb25jYXQoY2FsbC5wYy5nZXRSZW1vdGVTdHJlYW1zKCkpO1xuICAgIH1cbiAgfVxuXG4gIC8vIGlmIHRoZSByb29tIGlzIG5vdCBkZWZpbmVkLCB0aGVuIGdlbmVyYXRlIHRoZSByb29tIG5hbWVcbiAgaWYgKCEgcm9vbSkge1xuICAgIC8vIGlmIHRoZSBoYXNoIGlzIG5vdCBhc3NpZ25lZCwgdGhlbiBjcmVhdGUgYSByYW5kb20gaGFzaCB2YWx1ZVxuICAgIGlmICh0eXBlb2YgbG9jYXRpb24gIT0gJ3VuZGVmaW5lZCcgJiYgKCEgaGFzaCkpIHtcbiAgICAgIGhhc2ggPSBsb2NhdGlvbi5oYXNoID0gJycgKyAoTWF0aC5wb3coMiwgNTMpICogTWF0aC5yYW5kb20oKSk7XG4gICAgfVxuXG4gICAgcm9vbSA9IG5zICsgJyMnICsgaGFzaDtcbiAgfVxuXG4gIGlmIChkZWJ1Z2dpbmcpIHtcbiAgICBydGMubG9nZ2VyLmVuYWJsZS5hcHBseShydGMubG9nZ2VyLCBBcnJheS5pc0FycmF5KGRlYnVnKSA/IGRlYnVnZ2luZyA6IFsnKiddKTtcbiAgfVxuXG4gIHNpZ25hbGxlci5vbigncGVlcjphbm5vdW5jZScsIGZ1bmN0aW9uKGRhdGEpIHtcbiAgICBjb25uZWN0KGRhdGEuaWQpO1xuICB9KTtcblxuICBzaWduYWxsZXIub24oJ3BlZXI6dXBkYXRlJywgaGFuZGxlUGVlclVwZGF0ZSk7XG5cbiAgc2lnbmFsbGVyLm9uKCdtZXNzYWdlOnJlY29ubmVjdCcsIGZ1bmN0aW9uKHNlbmRlcikge1xuICAgIGNvbm5lY3Qoc2VuZGVyLmlkKTtcbiAgfSk7XG5cblxuXG4gIC8qKlxuICAgICMjIyBRdWlja2Nvbm5lY3QgQnJvYWRjYXN0IGFuZCBEYXRhIENoYW5uZWwgSGVscGVyIEZ1bmN0aW9uc1xuXG4gICAgVGhlIGZvbGxvd2luZyBhcmUgZnVuY3Rpb25zIHRoYXQgYXJlIHBhdGNoZWQgaW50byB0aGUgYHJ0Yy1zaWduYWxsZXJgXG4gICAgaW5zdGFuY2UgdGhhdCBtYWtlIHdvcmtpbmcgd2l0aCBhbmQgY3JlYXRpbmcgZnVuY3Rpb25hbCBXZWJSVEMgYXBwbGljYXRpb25zXG4gICAgYSBsb3Qgc2ltcGxlci5cblxuICAqKi9cblxuICAvKipcbiAgICAjIyMjIGFkZFN0cmVhbVxuXG4gICAgYGBgXG4gICAgYWRkU3RyZWFtKHN0cmVhbTpNZWRpYVN0cmVhbSkgPT4gcWNcbiAgICBgYGBcblxuICAgIEFkZCB0aGUgc3RyZWFtIHRvIGFjdGl2ZSBjYWxscyBhbmQgYWxzbyBzYXZlIHRoZSBzdHJlYW0gc28gdGhhdCBpdFxuICAgIGNhbiBiZSBhZGRlZCB0byBmdXR1cmUgY2FsbHMuXG5cbiAgKiovXG4gIHNpZ25hbGxlci5icm9hZGNhc3QgPSBzaWduYWxsZXIuYWRkU3RyZWFtID0gZnVuY3Rpb24oc3RyZWFtKSB7XG4gICAgbG9jYWxTdHJlYW1zLnB1c2goc3RyZWFtKTtcblxuICAgIC8vIGlmIHdlIGhhdmUgYW55IGFjdGl2ZSBjYWxscywgdGhlbiBhZGQgdGhlIHN0cmVhbVxuICAgIGNhbGxzLnZhbHVlcygpLmZvckVhY2goZnVuY3Rpb24oZGF0YSkge1xuICAgICAgZGF0YS5wYy5hZGRTdHJlYW0oc3RyZWFtKTtcbiAgICB9KTtcblxuICAgIGNoZWNrUmVhZHlUb0Fubm91bmNlKCk7XG4gICAgcmV0dXJuIHNpZ25hbGxlcjtcbiAgfTtcblxuICAvKipcbiAgICAjIyMjIGVuZENhbGxzKClcblxuICAgIFRoZSBgZW5kQ2FsbHNgIGZ1bmN0aW9uIHRlcm1pbmF0ZXMgYWxsIHRoZSBhY3RpdmUgY2FsbHMgdGhhdCBoYXZlIGJlZW5cbiAgICBjcmVhdGVkIGluIHRoaXMgcXVpY2tjb25uZWN0IGluc3RhbmNlLiAgQ2FsbGluZyBgZW5kQ2FsbHNgIGRvZXMgbm90XG4gICAga2lsbCB0aGUgY29ubmVjdGlvbiB3aXRoIHRoZSBzaWduYWxsaW5nIHNlcnZlci5cblxuICAqKi9cbiAgc2lnbmFsbGVyLmVuZENhbGxzID0gZnVuY3Rpb24oKSB7XG4gICAgY2FsbHMua2V5cygpLmZvckVhY2goY2FsbEVuZCk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyBjbG9zZSgpXG5cbiAgICBUaGUgYGNsb3NlYCBmdW5jdGlvbiBwcm92aWRlcyBhIGNvbnZlbmllbnQgd2F5IG9mIGNsb3NpbmcgYWxsIGFzc29jaWF0ZWRcbiAgICBwZWVyIGNvbm5lY3Rpb25zLiAgVGhpcyBmdW5jdGlvbiBzaW1wbHkgdXNlcyB0aGUgYGVuZENhbGxzYCBmdW5jdGlvbiBhbmRcbiAgICB0aGUgdW5kZXJseWluZyBgbGVhdmVgIGZ1bmN0aW9uIG9mIHRoZSBzaWduYWxsZXIgdG8gZG8gYSBcImZ1bGwgY2xlYW51cFwiXG4gICAgb2YgYWxsIGNvbm5lY3Rpb25zLlxuICAqKi9cbiAgc2lnbmFsbGVyLmNsb3NlID0gZnVuY3Rpb24oKSB7XG4gICAgc2lnbmFsbGVyLmVuZENhbGxzKCk7XG4gICAgc2lnbmFsbGVyLmxlYXZlKCk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyBjcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCwgY29uZmlnKVxuXG4gICAgUmVxdWVzdCB0aGF0IGEgZGF0YSBjaGFubmVsIHdpdGggdGhlIHNwZWNpZmllZCBgbGFiZWxgIGlzIGNyZWF0ZWQgb25cbiAgICB0aGUgcGVlciBjb25uZWN0aW9uLiAgV2hlbiB0aGUgZGF0YSBjaGFubmVsIGlzIG9wZW4gYW5kIGF2YWlsYWJsZSwgYW5cbiAgICBldmVudCB3aWxsIGJlIHRyaWdnZXJlZCB1c2luZyB0aGUgbGFiZWwgb2YgdGhlIGRhdGEgY2hhbm5lbC5cblxuICAgIEZvciBleGFtcGxlLCBpZiBhIG5ldyBkYXRhIGNoYW5uZWwgd2FzIHJlcXVlc3RlZCB1c2luZyB0aGUgZm9sbG93aW5nXG4gICAgY2FsbDpcblxuICAgIGBgYGpzXG4gICAgdmFyIHFjID0gcXVpY2tjb25uZWN0KCdodHRwczovL3N3aXRjaGJvYXJkLnJ0Yy5pby8nKS5jcmVhdGVEYXRhQ2hhbm5lbCgndGVzdCcpO1xuICAgIGBgYFxuXG4gICAgVGhlbiB3aGVuIHRoZSBkYXRhIGNoYW5uZWwgaXMgcmVhZHkgZm9yIHVzZSwgYSBgdGVzdDpvcGVuYCBldmVudCB3b3VsZFxuICAgIGJlIGVtaXR0ZWQgYnkgYHFjYC5cblxuICAqKi9cbiAgc2lnbmFsbGVyLmNyZWF0ZURhdGFDaGFubmVsID0gZnVuY3Rpb24obGFiZWwsIG9wdHMpIHtcbiAgICAvLyBjcmVhdGUgYSBjaGFubmVsIG9uIGFsbCBleGlzdGluZyBjYWxsc1xuICAgIGNhbGxzLmtleXMoKS5mb3JFYWNoKGZ1bmN0aW9uKHBlZXJJZCkge1xuICAgICAgdmFyIGNhbGwgPSBjYWxscy5nZXQocGVlcklkKTtcbiAgICAgIHZhciBkYztcblxuICAgICAgLy8gaWYgd2UgYXJlIHRoZSBtYXN0ZXIgY29ubmVjdGlvbiwgY3JlYXRlIHRoZSBkYXRhIGNoYW5uZWxcbiAgICAgIGlmIChjYWxsICYmIGNhbGwucGMgJiYgc2lnbmFsbGVyLmlzTWFzdGVyKHBlZXJJZCkpIHtcbiAgICAgICAgZGMgPSBjYWxsLnBjLmNyZWF0ZURhdGFDaGFubmVsKGxhYmVsLCBvcHRzKTtcbiAgICAgICAgZ290UGVlckNoYW5uZWwoZGMsIGNhbGwucGMsIGdldFBlZXJEYXRhKHBlZXJJZCkpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gc2F2ZSB0aGUgZGF0YSBjaGFubmVsIG9wdHMgaW4gdGhlIGxvY2FsIGNoYW5uZWxzIGRpY3Rpb25hcnlcbiAgICBjaGFubmVsc1tsYWJlbF0gPSBvcHRzIHx8IG51bGw7XG5cbiAgICByZXR1cm4gc2lnbmFsbGVyO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgam9pbigpXG5cbiAgICBUaGUgYGpvaW5gIGZ1bmN0aW9uIGlzIHVzZWQgd2hlbiBgbWFudWFsSm9pbmAgaXMgc2V0IHRvIHRydWUgd2hlbiBjcmVhdGluZ1xuICAgIGEgcXVpY2tjb25uZWN0IGluc3RhbmNlLiAgQ2FsbCB0aGUgYGpvaW5gIGZ1bmN0aW9uIG9uY2UgeW91IGFyZSByZWFkeSB0b1xuICAgIGpvaW4gdGhlIHNpZ25hbGxpbmcgc2VydmVyIGFuZCBpbml0aWF0ZSBjb25uZWN0aW9ucyB3aXRoIG90aGVyIHBlb3BsZS5cblxuICAqKi9cbiAgc2lnbmFsbGVyLmpvaW4gPSBmdW5jdGlvbigpIHtcbiAgICBhbGxvd0pvaW4gPSB0cnVlO1xuICAgIGNoZWNrUmVhZHlUb0Fubm91bmNlKCk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyBgZ2V0KG5hbWUpYFxuXG4gICAgVGhlIGBnZXRgIGZ1bmN0aW9uIHJldHVybnMgdGhlIHByb3BlcnR5IHZhbHVlIGZvciB0aGUgc3BlY2lmaWVkIHByb3BlcnR5IG5hbWUuXG4gICoqL1xuICBzaWduYWxsZXIuZ2V0ID0gZnVuY3Rpb24obmFtZSkge1xuICAgIHJldHVybiBwcm9maWxlW25hbWVdO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgYGdldExvY2FsU3RyZWFtcygpYFxuXG4gICAgUmV0dXJuIGEgY29weSBvZiB0aGUgbG9jYWwgc3RyZWFtcyB0aGF0IGhhdmUgY3VycmVudGx5IGJlZW4gY29uZmlndXJlZFxuICAqKi9cbiAgc2lnbmFsbGVyLmdldExvY2FsU3RyZWFtcyA9IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBbXS5jb25jYXQobG9jYWxTdHJlYW1zKTtcbiAgfTtcblxuICAvKipcbiAgICAjIyMjIHJlYWN0aXZlKClcblxuICAgIEZsYWcgdGhhdCB0aGlzIHNlc3Npb24gd2lsbCBiZSBhIHJlYWN0aXZlIGNvbm5lY3Rpb24uXG5cbiAgKiovXG4gIHNpZ25hbGxlci5yZWFjdGl2ZSA9IGZ1bmN0aW9uKCkge1xuICAgIC8vIGFkZCB0aGUgcmVhY3RpdmUgZmxhZ1xuICAgIG9wdHMgPSBvcHRzIHx8IHt9O1xuICAgIG9wdHMucmVhY3RpdmUgPSB0cnVlO1xuXG4gICAgLy8gY2hhaW5cbiAgICByZXR1cm4gc2lnbmFsbGVyO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgcmVtb3ZlU3RyZWFtXG5cbiAgICBgYGBcbiAgICByZW1vdmVTdHJlYW0oc3RyZWFtOk1lZGlhU3RyZWFtKVxuICAgIGBgYFxuXG4gICAgUmVtb3ZlIHRoZSBzcGVjaWZpZWQgc3RyZWFtIGZyb20gYm90aCB0aGUgbG9jYWwgc3RyZWFtcyB0aGF0IGFyZSB0b1xuICAgIGJlIGNvbm5lY3RlZCB0byBuZXcgcGVlcnMsIGFuZCBhbHNvIGZyb20gYW55IGFjdGl2ZSBjYWxscy5cblxuICAqKi9cbiAgc2lnbmFsbGVyLnJlbW92ZVN0cmVhbSA9IGZ1bmN0aW9uKHN0cmVhbSkge1xuICAgIHZhciBsb2NhbEluZGV4ID0gbG9jYWxTdHJlYW1zLmluZGV4T2Yoc3RyZWFtKTtcblxuICAgIC8vIHJlbW92ZSB0aGUgc3RyZWFtIGZyb20gYW55IGFjdGl2ZSBjYWxsc1xuICAgIGNhbGxzLnZhbHVlcygpLmZvckVhY2goZnVuY3Rpb24oY2FsbCkge1xuICAgICAgY2FsbC5wYy5yZW1vdmVTdHJlYW0oc3RyZWFtKTtcbiAgICB9KTtcblxuICAgIC8vIHJlbW92ZSB0aGUgc3RyZWFtIGZyb20gdGhlIGxvY2FsU3RyZWFtcyBhcnJheVxuICAgIGlmIChsb2NhbEluZGV4ID49IDApIHtcbiAgICAgIGxvY2FsU3RyZWFtcy5zcGxpY2UobG9jYWxJbmRleCwgMSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHNpZ25hbGxlcjtcbiAgfTtcblxuICAvKipcbiAgICAjIyMjIHJlcXVlc3RDaGFubmVsXG5cbiAgICBgYGBcbiAgICByZXF1ZXN0Q2hhbm5lbCh0YXJnZXRJZCwgbGFiZWwsIGNhbGxiYWNrKVxuICAgIGBgYFxuXG4gICAgVGhpcyBpcyBhIGZ1bmN0aW9uIHRoYXQgY2FuIGJlIHVzZWQgdG8gcmVzcG9uZCB0byByZW1vdGUgcGVlcnMgc3VwcGx5aW5nXG4gICAgYSBkYXRhIGNoYW5uZWwgYXMgcGFydCBvZiB0aGVpciBjb25maWd1cmF0aW9uLiAgQXMgcGVyIHRoZSBgcmVjZWl2ZVN0cmVhbWBcbiAgICBmdW5jdGlvbiB0aGlzIGZ1bmN0aW9uIHdpbGwgZWl0aGVyIGZpcmUgdGhlIGNhbGxiYWNrIGltbWVkaWF0ZWx5IGlmIHRoZVxuICAgIGNoYW5uZWwgaXMgYWxyZWFkeSBhdmFpbGFibGUsIG9yIG9uY2UgdGhlIGNoYW5uZWwgaGFzIGJlZW4gZGlzY292ZXJlZCBvblxuICAgIHRoZSBjYWxsLlxuXG4gICoqL1xuICBzaWduYWxsZXIucmVxdWVzdENoYW5uZWwgPSBmdW5jdGlvbih0YXJnZXRJZCwgbGFiZWwsIGNhbGxiYWNrKSB7XG4gICAgdmFyIGNhbGwgPSBnZXRBY3RpdmVDYWxsKHRhcmdldElkKTtcbiAgICB2YXIgY2hhbm5lbCA9IGNhbGwgJiYgY2FsbC5jaGFubmVscy5nZXQobGFiZWwpO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSB0aGVuIGNoYW5uZWwgdHJpZ2dlciB0aGUgY2FsbGJhY2sgaW1tZWRpYXRlbHlcbiAgICBpZiAoY2hhbm5lbCkge1xuICAgICAgY2FsbGJhY2sobnVsbCwgY2hhbm5lbCk7XG4gICAgICByZXR1cm4gc2lnbmFsbGVyO1xuICAgIH1cblxuICAgIC8vIGlmIG5vdCwgd2FpdCBmb3IgaXRcbiAgICBzaWduYWxsZXIub25jZSgnY2hhbm5lbDpvcGVuZWQ6JyArIGxhYmVsLCBmdW5jdGlvbihpZCwgZGMpIHtcbiAgICAgIGNhbGxiYWNrKG51bGwsIGRjKTtcbiAgICB9KTtcblxuICAgIHJldHVybiBzaWduYWxsZXI7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyByZXF1ZXN0U3RyZWFtXG5cbiAgICBgYGBcbiAgICByZXF1ZXN0U3RyZWFtKHRhcmdldElkLCBpZHgsIGNhbGxiYWNrKVxuICAgIGBgYFxuXG4gICAgVXNlZCB0byByZXF1ZXN0IGEgcmVtb3RlIHN0cmVhbSBmcm9tIGEgcXVpY2tjb25uZWN0IGluc3RhbmNlLiBJZiB0aGVcbiAgICBzdHJlYW0gaXMgYWxyZWFkeSBhdmFpbGFibGUgaW4gdGhlIGNhbGxzIHJlbW90ZSBzdHJlYW1zLCB0aGVuIHRoZSBjYWxsYmFja1xuICAgIHdpbGwgYmUgdHJpZ2dlcmVkIGltbWVkaWF0ZWx5LCBvdGhlcndpc2UgdGhpcyBmdW5jdGlvbiB3aWxsIG1vbml0b3JcbiAgICBgc3RyZWFtOmFkZGVkYCBldmVudHMgYW5kIHdhaXQgZm9yIGEgbWF0Y2guXG5cbiAgICBJbiB0aGUgY2FzZSB0aGF0IGFuIHVua25vd24gdGFyZ2V0IGlzIHJlcXVlc3RlZCwgdGhlbiBhbiBleGNlcHRpb24gd2lsbFxuICAgIGJlIHRocm93bi5cbiAgKiovXG4gIHNpZ25hbGxlci5yZXF1ZXN0U3RyZWFtID0gZnVuY3Rpb24odGFyZ2V0SWQsIGlkeCwgY2FsbGJhY2spIHtcbiAgICB2YXIgY2FsbCA9IGdldEFjdGl2ZUNhbGwodGFyZ2V0SWQpO1xuICAgIHZhciBzdHJlYW07XG5cbiAgICBmdW5jdGlvbiB3YWl0Rm9yU3RyZWFtKHBlZXJJZCkge1xuICAgICAgaWYgKHBlZXJJZCAhPT0gdGFyZ2V0SWQpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICAvLyBnZXQgdGhlIHN0cmVhbVxuICAgICAgc3RyZWFtID0gY2FsbC5wYy5nZXRSZW1vdGVTdHJlYW1zKClbaWR4XTtcblxuICAgICAgLy8gaWYgd2UgaGF2ZSB0aGUgc3RyZWFtLCB0aGVuIHJlbW92ZSB0aGUgbGlzdGVuZXIgYW5kIHRyaWdnZXIgdGhlIGNiXG4gICAgICBpZiAoc3RyZWFtKSB7XG4gICAgICAgIHNpZ25hbGxlci5yZW1vdmVMaXN0ZW5lcignc3RyZWFtOmFkZGVkJywgd2FpdEZvclN0cmVhbSk7XG4gICAgICAgIGNhbGxiYWNrKG51bGwsIHN0cmVhbSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gbG9vayBmb3IgdGhlIHN0cmVhbSBpbiB0aGUgcmVtb3RlIHN0cmVhbXMgb2YgdGhlIGNhbGxcbiAgICBzdHJlYW0gPSBjYWxsLnBjLmdldFJlbW90ZVN0cmVhbXMoKVtpZHhdO1xuXG4gICAgLy8gaWYgd2UgZm91bmQgdGhlIHN0cmVhbSB0aGVuIHRyaWdnZXIgdGhlIGNhbGxiYWNrXG4gICAgaWYgKHN0cmVhbSkge1xuICAgICAgY2FsbGJhY2sobnVsbCwgc3RyZWFtKTtcbiAgICAgIHJldHVybiBzaWduYWxsZXI7XG4gICAgfVxuXG4gICAgLy8gb3RoZXJ3aXNlIHdhaXQgZm9yIHRoZSBzdHJlYW1cbiAgICBzaWduYWxsZXIub24oJ3N0cmVhbTphZGRlZCcsIHdhaXRGb3JTdHJlYW0pO1xuICAgIHJldHVybiBzaWduYWxsZXI7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyBwcm9maWxlKGRhdGEpXG5cbiAgICBVcGRhdGUgdGhlIHByb2ZpbGUgZGF0YSB3aXRoIHRoZSBhdHRhY2hlZCBpbmZvcm1hdGlvbiwgc28gd2hlblxuICAgIHRoZSBzaWduYWxsZXIgYW5ub3VuY2VzIGl0IGluY2x1ZGVzIHRoaXMgZGF0YSBpbiBhZGRpdGlvbiB0byBhbnlcbiAgICByb29tIGFuZCBpZCBpbmZvcm1hdGlvbi5cblxuICAqKi9cbiAgc2lnbmFsbGVyLnByb2ZpbGUgPSBmdW5jdGlvbihkYXRhKSB7XG4gICAgZXh0ZW5kKHByb2ZpbGUsIGRhdGEpO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSBhbHJlYWR5IGFubm91bmNlZCwgdGhlbiByZWFubm91bmNlIG91ciBwcm9maWxlIHRvIHByb3ZpZGVcbiAgICAvLyBvdGhlcnMgYSBgcGVlcjp1cGRhdGVgIGV2ZW50XG4gICAgaWYgKGFubm91bmNlZCkge1xuICAgICAgY2xlYXJUaW1lb3V0KHVwZGF0ZVRpbWVyKTtcbiAgICAgIHVwZGF0ZVRpbWVyID0gc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgc2lnbmFsbGVyLmFubm91bmNlKHByb2ZpbGUpO1xuICAgICAgfSwgKG9wdHMgfHwge30pLnVwZGF0ZURlbGF5IHx8IDEwMDApO1xuICAgIH1cblxuICAgIHJldHVybiBzaWduYWxsZXI7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyB3YWl0Rm9yQ2FsbFxuXG4gICAgYGBgXG4gICAgd2FpdEZvckNhbGwodGFyZ2V0SWQsIGNhbGxiYWNrKVxuICAgIGBgYFxuXG4gICAgV2FpdCBmb3IgYSBjYWxsIGZyb20gdGhlIHNwZWNpZmllZCB0YXJnZXRJZC4gIElmIHRoZSBjYWxsIGlzIGFscmVhZHlcbiAgICBhY3RpdmUgdGhlIGNhbGxiYWNrIHdpbGwgYmUgZmlyZWQgaW1tZWRpYXRlbHksIG90aGVyd2lzZSB3ZSB3aWxsIHdhaXRcbiAgICBmb3IgYSBgY2FsbDpzdGFydGVkYCBldmVudCB0aGF0IG1hdGNoZXMgdGhlIHJlcXVlc3RlZCBgdGFyZ2V0SWRgXG5cbiAgKiovXG4gIHNpZ25hbGxlci53YWl0Rm9yQ2FsbCA9IGZ1bmN0aW9uKHRhcmdldElkLCBjYWxsYmFjaykge1xuICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KHRhcmdldElkKTtcblxuICAgIGlmIChjYWxsICYmIGNhbGwuYWN0aXZlKSB7XG4gICAgICBjYWxsYmFjayhudWxsLCBjYWxsLnBjKTtcbiAgICAgIHJldHVybiBzaWduYWxsZXI7XG4gICAgfVxuXG4gICAgc2lnbmFsbGVyLm9uKCdjYWxsOnN0YXJ0ZWQnLCBmdW5jdGlvbiBoYW5kbGVOZXdDYWxsKGlkKSB7XG4gICAgICBpZiAoaWQgPT09IHRhcmdldElkKSB7XG4gICAgICAgIHNpZ25hbGxlci5yZW1vdmVMaXN0ZW5lcignY2FsbDpzdGFydGVkJywgaGFuZGxlTmV3Q2FsbCk7XG4gICAgICAgIGNhbGxiYWNrKG51bGwsIGNhbGxzLmdldChpZCkucGMpO1xuICAgICAgfVxuICAgIH0pO1xuICB9O1xuXG4gIC8vIGlmIHdlIGhhdmUgYW4gZXhwZWN0ZWQgbnVtYmVyIG9mIGxvY2FsIHN0cmVhbXMsIHRoZW4gdXNlIGEgZmlsdGVyIHRvXG4gIC8vIGNoZWNrIGlmIHdlIHNob3VsZCByZXNwb25kXG4gIGlmIChleHBlY3RlZExvY2FsU3RyZWFtcykge1xuICAgIHNpZ25hbGxlci5vbigncGVlcjpmaWx0ZXInLCBoYW5kbGVQZWVyRmlsdGVyKTtcbiAgfVxuXG4gIC8vIHJlc3BvbmQgdG8gbG9jYWwgYW5ub3VuY2UgbWVzc2FnZXNcbiAgc2lnbmFsbGVyLm9uKCdsb2NhbDphbm5vdW5jZScsIGhhbmRsZUxvY2FsQW5ub3VuY2UpO1xuXG4gIC8vIGhhbmRsZSBwaW5nIG1lc3NhZ2VzXG4gIHNpZ25hbGxlci5vbignbWVzc2FnZTpwaW5nJywgaGFuZGxlUGluZyk7XG5cbiAgLy8gdXNlIGdlbmljZSB0byBmaW5kIG91ciBpY2VTZXJ2ZXJzXG4gIHJlcXVpcmUoJ3J0Yy1jb3JlL2dlbmljZScpKG9wdHMsIGZ1bmN0aW9uKGVyciwgc2VydmVycykge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIHJldHVybiBjb25zb2xlLmVycm9yKCdjb3VsZCBub3QgZmluZCBpY2VTZXJ2ZXJzOiAnLCBlcnIpO1xuICAgIH1cblxuICAgIGljZVNlcnZlcnMgPSBzZXJ2ZXJzO1xuICAgIGNoZWNrUmVhZHlUb0Fubm91bmNlKCk7XG4gIH0pO1xuXG4gIC8vIGlmIHdlIHBsdWdpbiBpcyBhY3RpdmUsIHRoZW4gaW5pdGlhbGl6ZSBpdFxuICBpZiAocGx1Z2luKSB7XG4gICAgaW5pdFBsdWdpbigpO1xuICB9XG5cbiAgLy8gcGFzcyB0aGUgc2lnbmFsbGVyIG9uXG4gIHJldHVybiBzaWduYWxsZXI7XG59O1xuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihtZXNzZW5nZXIpIHtcbiAgaWYgKHR5cGVvZiBtZXNzZW5nZXIgPT0gJ2Z1bmN0aW9uJykge1xuICAgIHJldHVybiBtZXNzZW5nZXI7XG4gIH1cblxuICByZXR1cm4gcmVxdWlyZSgncnRjLXN3aXRjaGJvYXJkLW1lc3NlbmdlcicpKG1lc3Nlbmdlcik7XG59O1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxuLyoqXG4jIyBjb2cvZGVmYXVsdHNcblxuYGBganNcbnZhciBkZWZhdWx0cyA9IHJlcXVpcmUoJ2NvZy9kZWZhdWx0cycpO1xuYGBgXG5cbiMjIyBkZWZhdWx0cyh0YXJnZXQsICopXG5cblNoYWxsb3cgY29weSBvYmplY3QgcHJvcGVydGllcyBmcm9tIHRoZSBzdXBwbGllZCBzb3VyY2Ugb2JqZWN0cyAoKikgaW50b1xudGhlIHRhcmdldCBvYmplY3QsIHJldHVybmluZyB0aGUgdGFyZ2V0IG9iamVjdCBvbmNlIGNvbXBsZXRlZC4gIERvIG5vdCxcbmhvd2V2ZXIsIG92ZXJ3cml0ZSBleGlzdGluZyBrZXlzIHdpdGggbmV3IHZhbHVlczpcblxuYGBganNcbmRlZmF1bHRzKHsgYTogMSwgYjogMiB9LCB7IGM6IDMgfSwgeyBkOiA0IH0sIHsgYjogNSB9KSk7XG5gYGBcblxuU2VlIGFuIGV4YW1wbGUgb24gW3JlcXVpcmViaW5dKGh0dHA6Ly9yZXF1aXJlYmluLmNvbS8/Z2lzdD02MDc5NDc1KS5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbih0YXJnZXQpIHtcbiAgLy8gZW5zdXJlIHdlIGhhdmUgYSB0YXJnZXRcbiAgdGFyZ2V0ID0gdGFyZ2V0IHx8IHt9O1xuXG4gIC8vIGl0ZXJhdGUgdGhyb3VnaCB0aGUgc291cmNlcyBhbmQgY29weSB0byB0aGUgdGFyZ2V0XG4gIFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKS5mb3JFYWNoKGZ1bmN0aW9uKHNvdXJjZSkge1xuICAgIGlmICghIHNvdXJjZSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGZvciAodmFyIHByb3AgaW4gc291cmNlKSB7XG4gICAgICBpZiAodGFyZ2V0W3Byb3BdID09PSB2b2lkIDApIHtcbiAgICAgICAgdGFyZ2V0W3Byb3BdID0gc291cmNlW3Byb3BdO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHRhcmdldDtcbn07IiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxuLyoqXG4jIyBjb2cvZXh0ZW5kXG5cbmBgYGpzXG52YXIgZXh0ZW5kID0gcmVxdWlyZSgnY29nL2V4dGVuZCcpO1xuYGBgXG5cbiMjIyBleHRlbmQodGFyZ2V0LCAqKVxuXG5TaGFsbG93IGNvcHkgb2JqZWN0IHByb3BlcnRpZXMgZnJvbSB0aGUgc3VwcGxpZWQgc291cmNlIG9iamVjdHMgKCopIGludG9cbnRoZSB0YXJnZXQgb2JqZWN0LCByZXR1cm5pbmcgdGhlIHRhcmdldCBvYmplY3Qgb25jZSBjb21wbGV0ZWQ6XG5cbmBgYGpzXG5leHRlbmQoeyBhOiAxLCBiOiAyIH0sIHsgYzogMyB9LCB7IGQ6IDQgfSwgeyBiOiA1IH0pKTtcbmBgYFxuXG5TZWUgYW4gZXhhbXBsZSBvbiBbcmVxdWlyZWJpbl0oaHR0cDovL3JlcXVpcmViaW4uY29tLz9naXN0PTYwNzk0NzUpLlxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHRhcmdldCkge1xuICBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSkuZm9yRWFjaChmdW5jdGlvbihzb3VyY2UpIHtcbiAgICBpZiAoISBzb3VyY2UpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBmb3IgKHZhciBwcm9wIGluIHNvdXJjZSkge1xuICAgICAgdGFyZ2V0W3Byb3BdID0gc291cmNlW3Byb3BdO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHRhcmdldDtcbn07IiwiLyoqXG4gICMjIGNvZy9nZXRhYmxlXG5cbiAgVGFrZSBhbiBvYmplY3QgYW5kIHByb3ZpZGUgYSB3cmFwcGVyIHRoYXQgYWxsb3dzIHlvdSB0byBgZ2V0YCBhbmRcbiAgYHNldGAgdmFsdWVzIG9uIHRoYXQgb2JqZWN0LlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24odGFyZ2V0KSB7XG4gIGZ1bmN0aW9uIGdldChrZXkpIHtcbiAgICByZXR1cm4gdGFyZ2V0W2tleV07XG4gIH1cblxuICBmdW5jdGlvbiBzZXQoa2V5LCB2YWx1ZSkge1xuICAgIHRhcmdldFtrZXldID0gdmFsdWU7XG4gIH1cblxuICBmdW5jdGlvbiByZW1vdmUoa2V5KSB7XG4gICAgcmV0dXJuIGRlbGV0ZSB0YXJnZXRba2V5XTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGtleXMoKSB7XG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHRhcmdldCk7XG4gIH07XG5cbiAgZnVuY3Rpb24gdmFsdWVzKCkge1xuICAgIHJldHVybiBPYmplY3Qua2V5cyh0YXJnZXQpLm1hcChmdW5jdGlvbihrZXkpIHtcbiAgICAgIHJldHVybiB0YXJnZXRba2V5XTtcbiAgICB9KTtcbiAgfTtcblxuICBpZiAodHlwZW9mIHRhcmdldCAhPSAnb2JqZWN0Jykge1xuICAgIHJldHVybiB0YXJnZXQ7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGdldDogZ2V0LFxuICAgIHNldDogc2V0LFxuICAgIHJlbW92ZTogcmVtb3ZlLFxuICAgIGRlbGV0ZTogcmVtb3ZlLFxuICAgIGtleXM6IGtleXMsXG4gICAgdmFsdWVzOiB2YWx1ZXNcbiAgfTtcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG4vKipcbiAgIyMgY29nL2pzb25wYXJzZVxuXG4gIGBgYGpzXG4gIHZhciBqc29ucGFyc2UgPSByZXF1aXJlKCdjb2cvanNvbnBhcnNlJyk7XG4gIGBgYFxuXG4gICMjIyBqc29ucGFyc2UoaW5wdXQpXG5cbiAgVGhpcyBmdW5jdGlvbiB3aWxsIGF0dGVtcHQgdG8gYXV0b21hdGljYWxseSBkZXRlY3Qgc3RyaW5naWZpZWQgSlNPTiwgYW5kXG4gIHdoZW4gZGV0ZWN0ZWQgd2lsbCBwYXJzZSBpbnRvIEpTT04gb2JqZWN0cy4gIFRoZSBmdW5jdGlvbiBsb29rcyBmb3Igc3RyaW5nc1xuICB0aGF0IGxvb2sgYW5kIHNtZWxsIGxpa2Ugc3RyaW5naWZpZWQgSlNPTiwgYW5kIGlmIGZvdW5kIGF0dGVtcHRzIHRvXG4gIGBKU09OLnBhcnNlYCB0aGUgaW5wdXQgaW50byBhIHZhbGlkIG9iamVjdC5cblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKGlucHV0KSB7XG4gIHZhciBpc1N0cmluZyA9IHR5cGVvZiBpbnB1dCA9PSAnc3RyaW5nJyB8fCAoaW5wdXQgaW5zdGFuY2VvZiBTdHJpbmcpO1xuICB2YXIgcmVOdW1lcmljID0gL15cXC0/XFxkK1xcLj9cXGQqJC87XG4gIHZhciBzaG91bGRQYXJzZSA7XG4gIHZhciBmaXJzdENoYXI7XG4gIHZhciBsYXN0Q2hhcjtcblxuICBpZiAoKCEgaXNTdHJpbmcpIHx8IGlucHV0Lmxlbmd0aCA8IDIpIHtcbiAgICBpZiAoaXNTdHJpbmcgJiYgcmVOdW1lcmljLnRlc3QoaW5wdXQpKSB7XG4gICAgICByZXR1cm4gcGFyc2VGbG9hdChpbnB1dCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGlucHV0O1xuICB9XG5cbiAgLy8gY2hlY2sgZm9yIHRydWUgb3IgZmFsc2VcbiAgaWYgKGlucHV0ID09PSAndHJ1ZScgfHwgaW5wdXQgPT09ICdmYWxzZScpIHtcbiAgICByZXR1cm4gaW5wdXQgPT09ICd0cnVlJztcbiAgfVxuXG4gIC8vIGNoZWNrIGZvciBudWxsXG4gIGlmIChpbnB1dCA9PT0gJ251bGwnKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvLyBnZXQgdGhlIGZpcnN0IGFuZCBsYXN0IGNoYXJhY3RlcnNcbiAgZmlyc3RDaGFyID0gaW5wdXQuY2hhckF0KDApO1xuICBsYXN0Q2hhciA9IGlucHV0LmNoYXJBdChpbnB1dC5sZW5ndGggLSAxKTtcblxuICAvLyBkZXRlcm1pbmUgd2hldGhlciB3ZSBzaG91bGQgSlNPTi5wYXJzZSB0aGUgaW5wdXRcbiAgc2hvdWxkUGFyc2UgPVxuICAgIChmaXJzdENoYXIgPT0gJ3snICYmIGxhc3RDaGFyID09ICd9JykgfHxcbiAgICAoZmlyc3RDaGFyID09ICdbJyAmJiBsYXN0Q2hhciA9PSAnXScpIHx8XG4gICAgKGZpcnN0Q2hhciA9PSAnXCInICYmIGxhc3RDaGFyID09ICdcIicpO1xuXG4gIGlmIChzaG91bGRQYXJzZSkge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShpbnB1dCk7XG4gICAgfVxuICAgIGNhdGNoIChlKSB7XG4gICAgICAvLyBhcHBhcmVudGx5IGl0IHdhc24ndCB2YWxpZCBqc29uLCBjYXJyeSBvbiB3aXRoIHJlZ3VsYXIgcHJvY2Vzc2luZ1xuICAgIH1cbiAgfVxuXG5cbiAgcmV0dXJuIHJlTnVtZXJpYy50ZXN0KGlucHV0KSA/IHBhcnNlRmxvYXQoaW5wdXQpIDogaW5wdXQ7XG59OyIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbi8qKlxuICAjIyBjb2cvbG9nZ2VyXG5cbiAgYGBganNcbiAgdmFyIGxvZ2dlciA9IHJlcXVpcmUoJ2NvZy9sb2dnZXInKTtcbiAgYGBgXG5cbiAgU2ltcGxlIGJyb3dzZXIgbG9nZ2luZyBvZmZlcmluZyBzaW1pbGFyIGZ1bmN0aW9uYWxpdHkgdG8gdGhlXG4gIFtkZWJ1Z10oaHR0cHM6Ly9naXRodWIuY29tL3Zpc2lvbm1lZGlhL2RlYnVnKSBtb2R1bGUuXG5cbiAgIyMjIFVzYWdlXG5cbiAgQ3JlYXRlIHlvdXIgc2VsZiBhIG5ldyBsb2dnaW5nIGluc3RhbmNlIGFuZCBnaXZlIGl0IGEgbmFtZTpcblxuICBgYGBqc1xuICB2YXIgZGVidWcgPSBsb2dnZXIoJ3BoaWwnKTtcbiAgYGBgXG5cbiAgTm93IGRvIHNvbWUgZGVidWdnaW5nOlxuXG4gIGBgYGpzXG4gIGRlYnVnKCdoZWxsbycpO1xuICBgYGBcblxuICBBdCB0aGlzIHN0YWdlLCBubyBsb2cgb3V0cHV0IHdpbGwgYmUgZ2VuZXJhdGVkIGJlY2F1c2UgeW91ciBsb2dnZXIgaXNcbiAgY3VycmVudGx5IGRpc2FibGVkLiAgRW5hYmxlIGl0OlxuXG4gIGBgYGpzXG4gIGxvZ2dlci5lbmFibGUoJ3BoaWwnKTtcbiAgYGBgXG5cbiAgTm93IGRvIHNvbWUgbW9yZSBsb2dnZXI6XG5cbiAgYGBganNcbiAgZGVidWcoJ09oIHRoaXMgaXMgc28gbXVjaCBuaWNlciA6KScpO1xuICAvLyAtLT4gcGhpbDogT2ggdGhpcyBpcyBzb21lIG11Y2ggbmljZXIgOilcbiAgYGBgXG5cbiAgIyMjIFJlZmVyZW5jZVxuKiovXG5cbnZhciBhY3RpdmUgPSBbXTtcbnZhciB1bmxlYXNoTGlzdGVuZXJzID0gW107XG52YXIgdGFyZ2V0cyA9IFsgY29uc29sZSBdO1xuXG4vKipcbiAgIyMjIyBsb2dnZXIobmFtZSlcblxuICBDcmVhdGUgYSBuZXcgbG9nZ2luZyBpbnN0YW5jZS5cbioqL1xudmFyIGxvZ2dlciA9IG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24obmFtZSkge1xuICAvLyBpbml0aWFsIGVuYWJsZWQgY2hlY2tcbiAgdmFyIGVuYWJsZWQgPSBjaGVja0FjdGl2ZSgpO1xuXG4gIGZ1bmN0aW9uIGNoZWNrQWN0aXZlKCkge1xuICAgIHJldHVybiBlbmFibGVkID0gYWN0aXZlLmluZGV4T2YoJyonKSA+PSAwIHx8IGFjdGl2ZS5pbmRleE9mKG5hbWUpID49IDA7XG4gIH1cblxuICAvLyByZWdpc3RlciB0aGUgY2hlY2sgYWN0aXZlIHdpdGggdGhlIGxpc3RlbmVycyBhcnJheVxuICB1bmxlYXNoTGlzdGVuZXJzW3VubGVhc2hMaXN0ZW5lcnMubGVuZ3RoXSA9IGNoZWNrQWN0aXZlO1xuXG4gIC8vIHJldHVybiB0aGUgYWN0dWFsIGxvZ2dpbmcgZnVuY3Rpb25cbiAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSBhIHN0cmluZyBtZXNzYWdlXG4gICAgaWYgKHR5cGVvZiBhcmdzWzBdID09ICdzdHJpbmcnIHx8IChhcmdzWzBdIGluc3RhbmNlb2YgU3RyaW5nKSkge1xuICAgICAgYXJnc1swXSA9IG5hbWUgKyAnOiAnICsgYXJnc1swXTtcbiAgICB9XG5cbiAgICAvLyBpZiBub3QgZW5hYmxlZCwgYmFpbFxuICAgIGlmICghIGVuYWJsZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBsb2dcbiAgICB0YXJnZXRzLmZvckVhY2goZnVuY3Rpb24odGFyZ2V0KSB7XG4gICAgICB0YXJnZXQubG9nLmFwcGx5KHRhcmdldCwgYXJncyk7XG4gICAgfSk7XG4gIH07XG59O1xuXG4vKipcbiAgIyMjIyBsb2dnZXIucmVzZXQoKVxuXG4gIFJlc2V0IGxvZ2dpbmcgKHJlbW92ZSB0aGUgZGVmYXVsdCBjb25zb2xlIGxvZ2dlciwgZmxhZyBhbGwgbG9nZ2VycyBhc1xuICBpbmFjdGl2ZSwgZXRjLCBldGMuXG4qKi9cbmxvZ2dlci5yZXNldCA9IGZ1bmN0aW9uKCkge1xuICAvLyByZXNldCB0YXJnZXRzIGFuZCBhY3RpdmUgc3RhdGVzXG4gIHRhcmdldHMgPSBbXTtcbiAgYWN0aXZlID0gW107XG5cbiAgcmV0dXJuIGxvZ2dlci5lbmFibGUoKTtcbn07XG5cbi8qKlxuICAjIyMjIGxvZ2dlci50byh0YXJnZXQpXG5cbiAgQWRkIGEgbG9nZ2luZyB0YXJnZXQuICBUaGUgbG9nZ2VyIG11c3QgaGF2ZSBhIGBsb2dgIG1ldGhvZCBhdHRhY2hlZC5cblxuKiovXG5sb2dnZXIudG8gPSBmdW5jdGlvbih0YXJnZXQpIHtcbiAgdGFyZ2V0cyA9IHRhcmdldHMuY29uY2F0KHRhcmdldCB8fCBbXSk7XG5cbiAgcmV0dXJuIGxvZ2dlcjtcbn07XG5cbi8qKlxuICAjIyMjIGxvZ2dlci5lbmFibGUobmFtZXMqKVxuXG4gIEVuYWJsZSBsb2dnaW5nIHZpYSB0aGUgbmFtZWQgbG9nZ2luZyBpbnN0YW5jZXMuICBUbyBlbmFibGUgbG9nZ2luZyB2aWEgYWxsXG4gIGluc3RhbmNlcywgeW91IGNhbiBwYXNzIGEgd2lsZGNhcmQ6XG5cbiAgYGBganNcbiAgbG9nZ2VyLmVuYWJsZSgnKicpO1xuICBgYGBcblxuICBfX1RPRE86X18gd2lsZGNhcmQgZW5hYmxlcnNcbioqL1xubG9nZ2VyLmVuYWJsZSA9IGZ1bmN0aW9uKCkge1xuICAvLyB1cGRhdGUgdGhlIGFjdGl2ZVxuICBhY3RpdmUgPSBhY3RpdmUuY29uY2F0KFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKSk7XG5cbiAgLy8gdHJpZ2dlciB0aGUgdW5sZWFzaCBsaXN0ZW5lcnNcbiAgdW5sZWFzaExpc3RlbmVycy5mb3JFYWNoKGZ1bmN0aW9uKGxpc3RlbmVyKSB7XG4gICAgbGlzdGVuZXIoKTtcbiAgfSk7XG5cbiAgcmV0dXJuIGxvZ2dlcjtcbn07IiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxuLyoqXG4gICMjIGNvZy90aHJvdHRsZVxuXG4gIGBgYGpzXG4gIHZhciB0aHJvdHRsZSA9IHJlcXVpcmUoJ2NvZy90aHJvdHRsZScpO1xuICBgYGBcblxuICAjIyMgdGhyb3R0bGUoZm4sIGRlbGF5LCBvcHRzKVxuXG4gIEEgY2hlcnJ5LXBpY2thYmxlIHRocm90dGxlIGZ1bmN0aW9uLiAgVXNlZCB0byB0aHJvdHRsZSBgZm5gIHRvIGVuc3VyZVxuICB0aGF0IGl0IGNhbiBiZSBjYWxsZWQgYXQgbW9zdCBvbmNlIGV2ZXJ5IGBkZWxheWAgbWlsbGlzZWNvbmRzLiAgV2lsbFxuICBmaXJlIGZpcnN0IGV2ZW50IGltbWVkaWF0ZWx5LCBlbnN1cmluZyB0aGUgbmV4dCBldmVudCBmaXJlZCB3aWxsIG9jY3VyXG4gIGF0IGxlYXN0IGBkZWxheWAgbWlsbGlzZWNvbmRzIGFmdGVyIHRoZSBmaXJzdCwgYW5kIHNvIG9uLlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oZm4sIGRlbGF5LCBvcHRzKSB7XG4gIHZhciBsYXN0RXhlYyA9IChvcHRzIHx8IHt9KS5sZWFkaW5nICE9PSBmYWxzZSA/IDAgOiBEYXRlLm5vdygpO1xuICB2YXIgdHJhaWxpbmcgPSAob3B0cyB8fCB7fSkudHJhaWxpbmc7XG4gIHZhciB0aW1lcjtcbiAgdmFyIHF1ZXVlZEFyZ3M7XG4gIHZhciBxdWV1ZWRTY29wZTtcblxuICAvLyB0cmFpbGluZyBkZWZhdWx0cyB0byB0cnVlXG4gIHRyYWlsaW5nID0gdHJhaWxpbmcgfHwgdHJhaWxpbmcgPT09IHVuZGVmaW5lZDtcbiAgXG4gIGZ1bmN0aW9uIGludm9rZURlZmVyZWQoKSB7XG4gICAgZm4uYXBwbHkocXVldWVkU2NvcGUsIHF1ZXVlZEFyZ3MgfHwgW10pO1xuICAgIGxhc3RFeGVjID0gRGF0ZS5ub3coKTtcbiAgfVxuXG4gIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICB2YXIgdGljayA9IERhdGUubm93KCk7XG4gICAgdmFyIGVsYXBzZWQgPSB0aWNrIC0gbGFzdEV4ZWM7XG5cbiAgICAvLyBhbHdheXMgY2xlYXIgdGhlIGRlZmVyZWQgdGltZXJcbiAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuXG4gICAgaWYgKGVsYXBzZWQgPCBkZWxheSkge1xuICAgICAgcXVldWVkQXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAwKTtcbiAgICAgIHF1ZXVlZFNjb3BlID0gdGhpcztcblxuICAgICAgcmV0dXJuIHRyYWlsaW5nICYmICh0aW1lciA9IHNldFRpbWVvdXQoaW52b2tlRGVmZXJlZCwgZGVsYXkgLSBlbGFwc2VkKSk7XG4gICAgfVxuXG4gICAgLy8gY2FsbCB0aGUgZnVuY3Rpb25cbiAgICBsYXN0RXhlYyA9IHRpY2s7XG4gICAgZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgfTtcbn07IiwiLy8gc2hpbSBmb3IgdXNpbmcgcHJvY2VzcyBpbiBicm93c2VyXG5cbnZhciBwcm9jZXNzID0gbW9kdWxlLmV4cG9ydHMgPSB7fTtcbnZhciBxdWV1ZSA9IFtdO1xudmFyIGRyYWluaW5nID0gZmFsc2U7XG5cbmZ1bmN0aW9uIGRyYWluUXVldWUoKSB7XG4gICAgaWYgKGRyYWluaW5nKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZHJhaW5pbmcgPSB0cnVlO1xuICAgIHZhciBjdXJyZW50UXVldWU7XG4gICAgdmFyIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB3aGlsZShsZW4pIHtcbiAgICAgICAgY3VycmVudFF1ZXVlID0gcXVldWU7XG4gICAgICAgIHF1ZXVlID0gW107XG4gICAgICAgIHZhciBpID0gLTE7XG4gICAgICAgIHdoaWxlICgrK2kgPCBsZW4pIHtcbiAgICAgICAgICAgIGN1cnJlbnRRdWV1ZVtpXSgpO1xuICAgICAgICB9XG4gICAgICAgIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB9XG4gICAgZHJhaW5pbmcgPSBmYWxzZTtcbn1cbnByb2Nlc3MubmV4dFRpY2sgPSBmdW5jdGlvbiAoZnVuKSB7XG4gICAgcXVldWUucHVzaChmdW4pO1xuICAgIGlmICghZHJhaW5pbmcpIHtcbiAgICAgICAgc2V0VGltZW91dChkcmFpblF1ZXVlLCAwKTtcbiAgICB9XG59O1xuXG5wcm9jZXNzLnRpdGxlID0gJ2Jyb3dzZXInO1xucHJvY2Vzcy5icm93c2VyID0gdHJ1ZTtcbnByb2Nlc3MuZW52ID0ge307XG5wcm9jZXNzLmFyZ3YgPSBbXTtcbnByb2Nlc3MudmVyc2lvbiA9ICcnOyAvLyBlbXB0eSBzdHJpbmcgdG8gYXZvaWQgcmVnZXhwIGlzc3Vlc1xuXG5mdW5jdGlvbiBub29wKCkge31cblxucHJvY2Vzcy5vbiA9IG5vb3A7XG5wcm9jZXNzLmFkZExpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3Mub25jZSA9IG5vb3A7XG5wcm9jZXNzLm9mZiA9IG5vb3A7XG5wcm9jZXNzLnJlbW92ZUxpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlQWxsTGlzdGVuZXJzID0gbm9vcDtcbnByb2Nlc3MuZW1pdCA9IG5vb3A7XG5cbnByb2Nlc3MuYmluZGluZyA9IGZ1bmN0aW9uIChuYW1lKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmJpbmRpbmcgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcblxuLy8gVE9ETyhzaHR5bG1hbilcbnByb2Nlc3MuY3dkID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gJy8nIH07XG5wcm9jZXNzLmNoZGlyID0gZnVuY3Rpb24gKGRpcikge1xuICAgIHRocm93IG5ldyBFcnJvcigncHJvY2Vzcy5jaGRpciBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xucHJvY2Vzcy51bWFzayA9IGZ1bmN0aW9uKCkgeyByZXR1cm4gMDsgfTtcbiIsInZhciByZURlbGltID0gL1tcXC5cXDpdLztcblxuLyoqXG4gICMgbWJ1c1xuXG4gIElmIE5vZGUncyBFdmVudEVtaXR0ZXIgYW5kIEV2ZSB3ZXJlIHRvIGhhdmUgYSBjaGlsZCwgaXQgbWlnaHQgbG9vayBzb21ldGhpbmcgbGlrZSB0aGlzLlxuICBObyB3aWxkY2FyZCBzdXBwb3J0IGF0IHRoaXMgc3RhZ2UgdGhvdWdoLi4uXG5cbiAgIyMgRXhhbXBsZSBVc2FnZVxuXG4gIDw8PCBkb2NzL3VzYWdlLm1kXG5cbiAgIyMgUmVmZXJlbmNlXG5cbiAgIyMjIGBtYnVzKG5hbWVzcGFjZT8sIHBhcmVudD8sIHNjb3BlPylgXG5cbiAgQ3JlYXRlIGEgbmV3IG1lc3NhZ2UgYnVzIHdpdGggYG5hbWVzcGFjZWAgaW5oZXJpdGluZyBmcm9tIHRoZSBgcGFyZW50YFxuICBtYnVzIGluc3RhbmNlLiAgSWYgZXZlbnRzIGZyb20gdGhpcyBtZXNzYWdlIGJ1cyBzaG91bGQgYmUgdHJpZ2dlcmVkIHdpdGhcbiAgYSBzcGVjaWZpYyBgdGhpc2Agc2NvcGUsIHRoZW4gc3BlY2lmeSBpdCB1c2luZyB0aGUgYHNjb3BlYCBhcmd1bWVudC5cblxuKiovXG5cbnZhciBjcmVhdGVCdXMgPSBtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKG5hbWVzcGFjZSwgcGFyZW50LCBzY29wZSkge1xuICB2YXIgcmVnaXN0cnkgPSB7fTtcbiAgdmFyIGZlZWRzID0gW107XG5cbiAgZnVuY3Rpb24gYnVzKG5hbWUpIHtcbiAgICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKTtcbiAgICB2YXIgZGVsaW1pdGVkID0gbm9ybWFsaXplKG5hbWUpO1xuICAgIHZhciBoYW5kbGVycyA9IHJlZ2lzdHJ5W2RlbGltaXRlZF0gfHwgW107XG4gICAgdmFyIHJlc3VsdHM7XG5cbiAgICAvLyBzZW5kIHRocm91Z2ggdGhlIGZlZWRzXG4gICAgZmVlZHMuZm9yRWFjaChmdW5jdGlvbihmZWVkKSB7XG4gICAgICBmZWVkKHsgbmFtZTogZGVsaW1pdGVkLCBhcmdzOiBhcmdzIH0pO1xuICAgIH0pO1xuXG4gICAgLy8gcnVuIHRoZSByZWdpc3RlcmVkIGhhbmRsZXJzXG4gICAgcmVzdWx0cyA9IFtdLmNvbmNhdChoYW5kbGVycykubWFwKGZ1bmN0aW9uKGhhbmRsZXIpIHtcbiAgICAgIHJldHVybiBoYW5kbGVyLmFwcGx5KHNjb3BlIHx8IHRoaXMsIGFyZ3MpO1xuICAgIH0pO1xuXG4gICAgLy8gcnVuIHRoZSBwYXJlbnQgaGFuZGxlcnNcbiAgICBpZiAoYnVzLnBhcmVudCkge1xuICAgICAgcmVzdWx0cyA9IHJlc3VsdHMuY29uY2F0KFxuICAgICAgICBidXMucGFyZW50LmFwcGx5KFxuICAgICAgICAgIHNjb3BlIHx8IHRoaXMsXG4gICAgICAgICAgWyhuYW1lc3BhY2UgPyBuYW1lc3BhY2UgKyAnLicgOiAnJykgKyBkZWxpbWl0ZWRdLmNvbmNhdChhcmdzKVxuICAgICAgICApXG4gICAgICApO1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHRzO1xuICB9XG5cbiAgLyoqXG4gICAgIyMjIGBtYnVzI2NsZWFyKClgXG5cbiAgICBSZXNldCB0aGUgaGFuZGxlciByZWdpc3RyeSwgd2hpY2ggZXNzZW50aWFsIGRlcmVnaXN0ZXJzIGFsbCBldmVudCBsaXN0ZW5lcnMuXG5cbiAgICBfQWxpYXM6XyBgcmVtb3ZlQWxsTGlzdGVuZXJzYFxuICAqKi9cbiAgZnVuY3Rpb24gY2xlYXIobmFtZSkge1xuICAgIC8vIGlmIHdlIGhhdmUgYSBuYW1lLCByZXNldCBoYW5kbGVycyBmb3IgdGhhdCBoYW5kbGVyXG4gICAgaWYgKG5hbWUpIHtcbiAgICAgIGRlbGV0ZSByZWdpc3RyeVtub3JtYWxpemUobmFtZSldO1xuICAgIH1cbiAgICAvLyBvdGhlcndpc2UsIHJlc2V0IHRoZSBlbnRpcmUgaGFuZGxlciByZWdpc3RyeVxuICAgIGVsc2Uge1xuICAgICAgcmVnaXN0cnkgPSB7fTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICAjIyMgYG1idXMjZmVlZChoYW5kbGVyKWBcblxuICAgIEF0dGFjaCBhIGhhbmRsZXIgZnVuY3Rpb24gdGhhdCB3aWxsIHNlZSBhbGwgZXZlbnRzIHRoYXQgYXJlIHNlbnQgdGhyb3VnaFxuICAgIHRoaXMgYnVzIGluIGFuIFwib2JqZWN0IHN0cmVhbVwiIGZvcm1hdCB0aGF0IG1hdGNoZXMgdGhlIGZvbGxvd2luZyBmb3JtYXQ6XG5cbiAgICBgYGBcbiAgICB7IG5hbWU6ICdldmVudC5uYW1lJywgYXJnczogWyAnZXZlbnQnLCAnYXJncycgXSB9XG4gICAgYGBgXG5cbiAgICBUaGUgZmVlZCBmdW5jdGlvbiByZXR1cm5zIGEgZnVuY3Rpb24gdGhhdCBjYW4gYmUgY2FsbGVkIHRvIHN0b3AgdGhlIGZlZWRcbiAgICBzZW5kaW5nIGRhdGEuXG5cbiAgKiovXG4gIGZ1bmN0aW9uIGZlZWQoaGFuZGxlcikge1xuICAgIGZ1bmN0aW9uIHN0b3AoKSB7XG4gICAgICBmZWVkcy5zcGxpY2UoZmVlZHMuaW5kZXhPZihoYW5kbGVyKSwgMSk7XG4gICAgfVxuXG4gICAgZmVlZHMucHVzaChoYW5kbGVyKTtcbiAgICByZXR1cm4gc3RvcDtcbiAgfVxuXG4gIGZ1bmN0aW9uIG5vcm1hbGl6ZShuYW1lKSB7XG4gICAgcmV0dXJuIChBcnJheS5pc0FycmF5KG5hbWUpID8gbmFtZSA6IG5hbWUuc3BsaXQocmVEZWxpbSkpLmpvaW4oJy4nKTtcbiAgfVxuXG4gIC8qKlxuICAgICMjIyBgbWJ1cyNvZmYobmFtZSwgaGFuZGxlcilgXG5cbiAgICBEZXJlZ2lzdGVyIGFuIGV2ZW50IGhhbmRsZXIuXG4gICoqL1xuICBmdW5jdGlvbiBvZmYobmFtZSwgaGFuZGxlcikge1xuICAgIHZhciBoYW5kbGVycyA9IHJlZ2lzdHJ5W25vcm1hbGl6ZShuYW1lKV0gfHwgW107XG4gICAgdmFyIGlkeCA9IGhhbmRsZXJzID8gaGFuZGxlcnMuaW5kZXhPZihoYW5kbGVyLl9hY3R1YWwgfHwgaGFuZGxlcikgOiAtMTtcblxuICAgIGlmIChpZHggPj0gMCkge1xuICAgICAgaGFuZGxlcnMuc3BsaWNlKGlkeCwgMSk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAgIyMjIGBtYnVzI29uKG5hbWUsIGhhbmRsZXIpYFxuXG4gICAgUmVnaXN0ZXIgYW4gZXZlbnQgaGFuZGxlciBmb3IgdGhlIGV2ZW50IGBuYW1lYC5cblxuICAqKi9cbiAgZnVuY3Rpb24gb24obmFtZSwgaGFuZGxlcikge1xuICAgIHZhciBoYW5kbGVycztcblxuICAgIG5hbWUgPSBub3JtYWxpemUobmFtZSk7XG4gICAgaGFuZGxlcnMgPSByZWdpc3RyeVtuYW1lXTtcblxuICAgIGlmIChoYW5kbGVycykge1xuICAgICAgaGFuZGxlcnMucHVzaChoYW5kbGVyKTtcbiAgICB9XG4gICAgZWxzZSB7XG4gICAgICByZWdpc3RyeVtuYW1lXSA9IFsgaGFuZGxlciBdO1xuICAgIH1cblxuICAgIHJldHVybiBidXM7XG4gIH1cblxuXG4gIC8qKlxuICAgICMjIyBgbWJ1cyNvbmNlKG5hbWUsIGhhbmRsZXIpYFxuXG4gICAgUmVnaXN0ZXIgYW4gZXZlbnQgaGFuZGxlciBmb3IgdGhlIGV2ZW50IGBuYW1lYCB0aGF0IHdpbGwgb25seVxuICAgIHRyaWdnZXIgb25jZSAoaS5lLiB0aGUgaGFuZGxlciB3aWxsIGJlIGRlcmVnaXN0ZXJlZCBpbW1lZGlhdGVseSBhZnRlclxuICAgIGJlaW5nIHRyaWdnZXJlZCB0aGUgZmlyc3QgdGltZSkuXG5cbiAgKiovXG4gIGZ1bmN0aW9uIG9uY2UobmFtZSwgaGFuZGxlcikge1xuICAgIGZ1bmN0aW9uIGhhbmRsZUV2ZW50KCkge1xuICAgICAgdmFyIHJlc3VsdCA9IGhhbmRsZXIuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcblxuICAgICAgYnVzLm9mZihuYW1lLCBoYW5kbGVFdmVudCk7XG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIGhhbmRsZXIuX2FjdHVhbCA9IGhhbmRsZUV2ZW50O1xuICAgIHJldHVybiBvbihuYW1lLCBoYW5kbGVFdmVudCk7XG4gIH1cblxuICBpZiAodHlwZW9mIG5hbWVzcGFjZSA9PSAnZnVuY3Rpb24nKSB7XG4gICAgcGFyZW50ID0gbmFtZXNwYWNlO1xuICAgIG5hbWVzcGFjZSA9ICcnO1xuICB9XG5cbiAgbmFtZXNwYWNlID0gbm9ybWFsaXplKG5hbWVzcGFjZSB8fCAnJyk7XG5cbiAgYnVzLmNsZWFyID0gYnVzLnJlbW92ZUFsbExpc3RlbmVycyA9IGNsZWFyO1xuICBidXMuZmVlZCA9IGZlZWQ7XG4gIGJ1cy5vbiA9IGJ1cy5hZGRMaXN0ZW5lciA9IG9uO1xuICBidXMub25jZSA9IG9uY2U7XG4gIGJ1cy5vZmYgPSBidXMucmVtb3ZlTGlzdGVuZXIgPSBvZmY7XG4gIGJ1cy5wYXJlbnQgPSBwYXJlbnQgfHwgKG5hbWVzcGFjZSAmJiBjcmVhdGVCdXMoKSk7XG5cbiAgcmV0dXJuIGJ1cztcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuLyogZ2xvYmFsIHdpbmRvdzogZmFsc2UgKi9cbi8qIGdsb2JhbCBuYXZpZ2F0b3I6IGZhbHNlICovXG5cbid1c2Ugc3RyaWN0JztcblxudmFyIGJyb3dzZXIgPSByZXF1aXJlKCdkZXRlY3QtYnJvd3NlcicpO1xuXG4vKipcbiAgIyMjIGBydGMtY29yZS9kZXRlY3RgXG5cbiAgQSBicm93c2VyIGRldGVjdGlvbiBoZWxwZXIgZm9yIGFjY2Vzc2luZyBwcmVmaXgtZnJlZSB2ZXJzaW9ucyBvZiB0aGUgdmFyaW91c1xuICBXZWJSVEMgdHlwZXMuXG5cbiAgIyMjIEV4YW1wbGUgVXNhZ2VcblxuICBJZiB5b3Ugd2FudGVkIHRvIGdldCB0aGUgbmF0aXZlIGBSVENQZWVyQ29ubmVjdGlvbmAgcHJvdG90eXBlIGluIGFueSBicm93c2VyXG4gIHlvdSBjb3VsZCBkbyB0aGUgZm9sbG93aW5nOlxuXG4gIGBgYGpzXG4gIHZhciBkZXRlY3QgPSByZXF1aXJlKCdydGMtY29yZS9kZXRlY3QnKTsgLy8gYWxzbyBhdmFpbGFibGUgaW4gcnRjL2RldGVjdFxuICB2YXIgUlRDUGVlckNvbm5lY3Rpb24gPSBkZXRlY3QoJ1JUQ1BlZXJDb25uZWN0aW9uJyk7XG4gIGBgYFxuXG4gIFRoaXMgd291bGQgcHJvdmlkZSB3aGF0ZXZlciB0aGUgYnJvd3NlciBwcmVmaXhlZCB2ZXJzaW9uIG9mIHRoZVxuICBSVENQZWVyQ29ubmVjdGlvbiBpcyBhdmFpbGFibGUgKGB3ZWJraXRSVENQZWVyQ29ubmVjdGlvbmAsXG4gIGBtb3pSVENQZWVyQ29ubmVjdGlvbmAsIGV0YykuXG4qKi9cbnZhciBkZXRlY3QgPSBtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHRhcmdldCwgb3B0cykge1xuICB2YXIgYXR0YWNoID0gKG9wdHMgfHwge30pLmF0dGFjaDtcbiAgdmFyIHByZWZpeElkeDtcbiAgdmFyIHByZWZpeDtcbiAgdmFyIHRlc3ROYW1lO1xuICB2YXIgaG9zdE9iamVjdCA9IHRoaXMgfHwgKHR5cGVvZiB3aW5kb3cgIT0gJ3VuZGVmaW5lZCcgPyB3aW5kb3cgOiB1bmRlZmluZWQpO1xuXG4gIC8vIGluaXRpYWxpc2UgdG8gZGVmYXVsdCBwcmVmaXhlc1xuICAvLyAocmV2ZXJzZSBvcmRlciBhcyB3ZSB1c2UgYSBkZWNyZW1lbnRpbmcgZm9yIGxvb3ApXG4gIHZhciBwcmVmaXhlcyA9ICgob3B0cyB8fCB7fSkucHJlZml4ZXMgfHwgWydtcycsICdvJywgJ21veicsICd3ZWJraXQnXSkuY29uY2F0KCcnKTtcblxuICAvLyBpZiB3ZSBoYXZlIG5vIGhvc3Qgb2JqZWN0LCB0aGVuIGFib3J0XG4gIGlmICghIGhvc3RPYmplY3QpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBpdGVyYXRlIHRocm91Z2ggdGhlIHByZWZpeGVzIGFuZCByZXR1cm4gdGhlIGNsYXNzIGlmIGZvdW5kIGluIGdsb2JhbFxuICBmb3IgKHByZWZpeElkeCA9IHByZWZpeGVzLmxlbmd0aDsgcHJlZml4SWR4LS07ICkge1xuICAgIHByZWZpeCA9IHByZWZpeGVzW3ByZWZpeElkeF07XG5cbiAgICAvLyBjb25zdHJ1Y3QgdGhlIHRlc3QgY2xhc3MgbmFtZVxuICAgIC8vIGlmIHdlIGhhdmUgYSBwcmVmaXggZW5zdXJlIHRoZSB0YXJnZXQgaGFzIGFuIHVwcGVyY2FzZSBmaXJzdCBjaGFyYWN0ZXJcbiAgICAvLyBzdWNoIHRoYXQgYSB0ZXN0IGZvciBnZXRVc2VyTWVkaWEgd291bGQgcmVzdWx0IGluIGFcbiAgICAvLyBzZWFyY2ggZm9yIHdlYmtpdEdldFVzZXJNZWRpYVxuICAgIHRlc3ROYW1lID0gcHJlZml4ICsgKHByZWZpeCA/XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0LmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgdGFyZ2V0LnNsaWNlKDEpIDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXQpO1xuXG4gICAgaWYgKHR5cGVvZiBob3N0T2JqZWN0W3Rlc3ROYW1lXSAhPSAndW5kZWZpbmVkJykge1xuICAgICAgLy8gdXBkYXRlIHRoZSBsYXN0IHVzZWQgcHJlZml4XG4gICAgICBkZXRlY3QuYnJvd3NlciA9IGRldGVjdC5icm93c2VyIHx8IHByZWZpeC50b0xvd2VyQ2FzZSgpO1xuXG4gICAgICBpZiAoYXR0YWNoKSB7XG4gICAgICAgICBob3N0T2JqZWN0W3RhcmdldF0gPSBob3N0T2JqZWN0W3Rlc3ROYW1lXTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGhvc3RPYmplY3RbdGVzdE5hbWVdO1xuICAgIH1cbiAgfVxufTtcblxuLy8gZGV0ZWN0IG1vemlsbGEgKHllcywgdGhpcyBmZWVscyBkaXJ0eSlcbmRldGVjdC5tb3ogPSB0eXBlb2YgbmF2aWdhdG9yICE9ICd1bmRlZmluZWQnICYmICEhbmF2aWdhdG9yLm1vekdldFVzZXJNZWRpYTtcblxuLy8gc2V0IHRoZSBicm93c2VyIGFuZCBicm93c2VyIHZlcnNpb25cbmRldGVjdC5icm93c2VyID0gYnJvd3Nlci5uYW1lO1xuZGV0ZWN0LmJyb3dzZXJWZXJzaW9uID0gZGV0ZWN0LnZlcnNpb24gPSBicm93c2VyLnZlcnNpb247XG4iLCIvKipcbiAgIyMjIGBydGMtY29yZS9nZW5pY2VgXG5cbiAgUmVzcG9uZCBhcHByb3ByaWF0ZWx5IHRvIG9wdGlvbnMgdGhhdCBhcmUgcGFzc2VkIHRvIHBhY2thZ2VzIGxpa2VcbiAgYHJ0Yy1xdWlja2Nvbm5lY3RgIGFuZCB0cmlnZ2VyIGEgYGNhbGxiYWNrYCAoZXJyb3IgZmlyc3QpIHdpdGggaWNlU2VydmVyXG4gIHZhbHVlcy5cblxuICBUaGUgZnVuY3Rpb24gbG9va3MgZm9yIGVpdGhlciBvZiB0aGUgZm9sbG93aW5nIGtleXMgaW4gdGhlIG9wdGlvbnMsIGluXG4gIHRoZSBmb2xsb3dpbmcgb3JkZXIgb3IgcHJlY2VkZW5jZTpcblxuICAxLiBgaWNlYCAtIHRoaXMgY2FuIGVpdGhlciBiZSBhbiBhcnJheSBvZiBpY2Ugc2VydmVyIHZhbHVlcyBvciBhIGdlbmVyYXRvclxuICAgICBmdW5jdGlvbiAoaW4gdGhlIHNhbWUgZm9ybWF0IGFzIHRoaXMgZnVuY3Rpb24pLiAgSWYgdGhpcyBrZXkgY29udGFpbnMgYVxuICAgICB2YWx1ZSB0aGVuIGFueSBzZXJ2ZXJzIHNwZWNpZmllZCBpbiB0aGUgYGljZVNlcnZlcnNgIGtleSAoMikgd2lsbCBiZVxuICAgICBpZ25vcmVkLlxuXG4gIDIuIGBpY2VTZXJ2ZXJzYCAtIGFuIGFycmF5IG9mIGljZSBzZXJ2ZXIgdmFsdWVzLlxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKG9wdHMsIGNhbGxiYWNrKSB7XG4gIHZhciBpY2UgPSAob3B0cyB8fCB7fSkuaWNlO1xuICB2YXIgaWNlU2VydmVycyA9IChvcHRzIHx8IHt9KS5pY2VTZXJ2ZXJzO1xuXG4gIGlmICh0eXBlb2YgaWNlID09ICdmdW5jdGlvbicpIHtcbiAgICByZXR1cm4gaWNlKG9wdHMsIGNhbGxiYWNrKTtcbiAgfVxuICBlbHNlIGlmIChBcnJheS5pc0FycmF5KGljZSkpIHtcbiAgICByZXR1cm4gY2FsbGJhY2sobnVsbCwgW10uY29uY2F0KGljZSkpO1xuICB9XG5cbiAgY2FsbGJhY2sobnVsbCwgW10uY29uY2F0KGljZVNlcnZlcnMgfHwgW10pKTtcbn07XG4iLCJ2YXIgYnJvd3NlcnMgPSBbXG4gIFsgJ2Nocm9tZScsIC9DaHJvbSg/OmV8aXVtKVxcLyhbMC05XFwuXSspKDo/XFxzfCQpLyBdLFxuICBbICdmaXJlZm94JywgL0ZpcmVmb3hcXC8oWzAtOVxcLl0rKSg/Olxcc3wkKS8gXSxcbiAgWyAnb3BlcmEnLCAvT3BlcmFcXC8oWzAtOVxcLl0rKSg/Olxcc3wkKS8gXSxcbiAgWyAnaWUnLCAvVHJpZGVudFxcLzdcXC4wLipydlxcOihbMC05XFwuXSspXFwpLipHZWNrbyQvIF0sXG4gIFsgJ2llJywgL01TSUVcXHMoWzAtOVxcLl0rKTsuKlRyaWRlbnRcXC9bNC03XS4wLyBdLFxuICBbICdpZScsIC9NU0lFXFxzKDdcXC4wKS8gXSxcbiAgWyAnYmIxMCcsIC9CQjEwO1xcc1RvdWNoLipWZXJzaW9uXFwvKFswLTlcXC5dKykvIF0sXG4gIFsgJ2FuZHJvaWQnLCAvQW5kcm9pZFxccyhbMC05XFwuXSspLyBdLFxuICBbICdpb3MnLCAvaVBhZFxcO1xcc0NQVVxcc09TXFxzKFswLTlcXC5fXSspLyBdLFxuICBbICdpb3MnLCAgL2lQaG9uZVxcO1xcc0NQVVxcc2lQaG9uZVxcc09TXFxzKFswLTlcXC5fXSspLyBdLFxuICBbICdzYWZhcmknLCAvU2FmYXJpXFwvKFswLTlcXC5fXSspLyBdXG5dO1xuXG52YXIgbWF0Y2ggPSBicm93c2Vycy5tYXAobWF0Y2gpLmZpbHRlcihpc01hdGNoKVswXTtcbnZhciBwYXJ0cyA9IG1hdGNoICYmIG1hdGNoWzNdLnNwbGl0KC9bLl9dLykuc2xpY2UoMCwzKTtcblxud2hpbGUgKHBhcnRzICYmIHBhcnRzLmxlbmd0aCA8IDMpIHtcbiAgcGFydHMucHVzaCgnMCcpO1xufVxuXG4vLyBzZXQgdGhlIG5hbWUgYW5kIHZlcnNpb25cbmV4cG9ydHMubmFtZSA9IG1hdGNoICYmIG1hdGNoWzBdO1xuZXhwb3J0cy52ZXJzaW9uID0gcGFydHMgJiYgcGFydHMuam9pbignLicpO1xuXG5mdW5jdGlvbiBtYXRjaChwYWlyKSB7XG4gIHJldHVybiBwYWlyLmNvbmNhdChwYWlyWzFdLmV4ZWMobmF2aWdhdG9yLnVzZXJBZ2VudCkpO1xufVxuXG5mdW5jdGlvbiBpc01hdGNoKHBhaXIpIHtcbiAgcmV0dXJuICEhcGFpclsyXTtcbn1cbiIsInZhciBkZXRlY3QgPSByZXF1aXJlKCcuL2RldGVjdCcpO1xudmFyIHJlcXVpcmVkRnVuY3Rpb25zID0gW1xuICAnaW5pdCdcbl07XG5cbmZ1bmN0aW9uIGlzU3VwcG9ydGVkKHBsdWdpbikge1xuICByZXR1cm4gcGx1Z2luICYmIHR5cGVvZiBwbHVnaW4uc3VwcG9ydGVkID09ICdmdW5jdGlvbicgJiYgcGx1Z2luLnN1cHBvcnRlZChkZXRlY3QpO1xufVxuXG5mdW5jdGlvbiBpc1ZhbGlkKHBsdWdpbikge1xuICB2YXIgc3VwcG9ydGVkRnVuY3Rpb25zID0gcmVxdWlyZWRGdW5jdGlvbnMuZmlsdGVyKGZ1bmN0aW9uKGZuKSB7XG4gICAgcmV0dXJuIHR5cGVvZiBwbHVnaW5bZm5dID09ICdmdW5jdGlvbic7XG4gIH0pO1xuXG4gIHJldHVybiBzdXBwb3J0ZWRGdW5jdGlvbnMubGVuZ3RoID09PSByZXF1aXJlZEZ1bmN0aW9ucy5sZW5ndGg7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24ocGx1Z2lucykge1xuICByZXR1cm4gW10uY29uY2F0KHBsdWdpbnMgfHwgW10pLmZpbHRlcihpc1N1cHBvcnRlZCkuZmlsdGVyKGlzVmFsaWQpWzBdO1xufVxuIiwibW9kdWxlLmV4cG9ydHMgPSB7XG4gIC8vIG1lc3NlbmdlciBldmVudHNcbiAgZGF0YUV2ZW50OiAnZGF0YScsXG4gIG9wZW5FdmVudDogJ29wZW4nLFxuICBjbG9zZUV2ZW50OiAnY2xvc2UnLFxuICBlcnJvckV2ZW50OiAnZXJyb3InLFxuXG4gIC8vIG1lc3NlbmdlciBmdW5jdGlvbnNcbiAgd3JpdGVNZXRob2Q6ICd3cml0ZScsXG4gIGNsb3NlTWV0aG9kOiAnY2xvc2UnLFxuXG4gIC8vIGxlYXZlIHRpbWVvdXQgKG1zKVxuICBsZWF2ZVRpbWVvdXQ6IDMwMDBcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG52YXIgZXh0ZW5kID0gcmVxdWlyZSgnY29nL2V4dGVuZCcpO1xuXG4vKipcbiAgIyMjIyBhbm5vdW5jZVxuXG4gIGBgYFxuICAvYW5ub3VuY2V8JW1ldGFkYXRhJXx7XCJpZFwiOiBcIi4uLlwiLCAuLi4gfVxuICBgYGBcblxuICBXaGVuIGFuIGFubm91bmNlIG1lc3NhZ2UgaXMgcmVjZWl2ZWQgYnkgdGhlIHNpZ25hbGxlciwgdGhlIGF0dGFjaGVkXG4gIG9iamVjdCBkYXRhIGlzIGRlY29kZWQgYW5kIHRoZSBzaWduYWxsZXIgZW1pdHMgYW4gYGFubm91bmNlYCBtZXNzYWdlLlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oc2lnbmFsbGVyKSB7XG5cbiAgZnVuY3Rpb24gZGF0YUFsbG93ZWQoZGF0YSkge1xuICAgIHZhciBjbG9uZWQgPSBleHRlbmQoeyBhbGxvdzogdHJ1ZSB9LCBkYXRhKTtcbiAgICBzaWduYWxsZXIoJ3BlZXI6ZmlsdGVyJywgZGF0YS5pZCwgY2xvbmVkKTtcblxuICAgIHJldHVybiBjbG9uZWQuYWxsb3c7XG4gIH1cblxuICByZXR1cm4gZnVuY3Rpb24oYXJncywgbWVzc2FnZVR5cGUsIHNyY0RhdGEsIHNyY1N0YXRlLCBpc0RNKSB7XG4gICAgdmFyIGRhdGEgPSBhcmdzWzBdO1xuICAgIHZhciBwZWVyO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSB2YWxpZCBkYXRhIHRoZW4gcHJvY2Vzc1xuICAgIGlmIChkYXRhICYmIGRhdGEuaWQgJiYgZGF0YS5pZCAhPT0gc2lnbmFsbGVyLmlkKSB7XG4gICAgICBpZiAoISBkYXRhQWxsb3dlZChkYXRhKSkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBjaGVjayB0byBzZWUgaWYgdGhpcyBpcyBhIGtub3duIHBlZXJcbiAgICAgIHBlZXIgPSBzaWduYWxsZXIucGVlcnMuZ2V0KGRhdGEuaWQpO1xuXG4gICAgICAvLyB0cmlnZ2VyIHRoZSBwZWVyIGNvbm5lY3RlZCBldmVudCB0byBmbGFnIHRoYXQgd2Uga25vdyBhYm91dCBhXG4gICAgICAvLyBwZWVyIGNvbm5lY3Rpb24uIFRoZSBwZWVyIGhhcyBwYXNzZWQgdGhlIFwiZmlsdGVyXCIgY2hlY2sgYnV0IG1heVxuICAgICAgLy8gYmUgYW5ub3VuY2VkIC8gdXBkYXRlZCBkZXBlbmRpbmcgb24gcHJldmlvdXMgY29ubmVjdGlvbiBzdGF0dXNcbiAgICAgIHNpZ25hbGxlcigncGVlcjpjb25uZWN0ZWQnLCBkYXRhLmlkLCBkYXRhKTtcblxuICAgICAgLy8gaWYgdGhlIHBlZXIgaXMgZXhpc3RpbmcsIHRoZW4gdXBkYXRlIHRoZSBkYXRhXG4gICAgICBpZiAocGVlciAmJiAoISBwZWVyLmluYWN0aXZlKSkge1xuICAgICAgICAvLyB1cGRhdGUgdGhlIGRhdGFcbiAgICAgICAgZXh0ZW5kKHBlZXIuZGF0YSwgZGF0YSk7XG5cbiAgICAgICAgLy8gdHJpZ2dlciB0aGUgcGVlciB1cGRhdGUgZXZlbnRcbiAgICAgICAgcmV0dXJuIHNpZ25hbGxlcigncGVlcjp1cGRhdGUnLCBkYXRhLCBzcmNEYXRhKTtcbiAgICAgIH1cblxuICAgICAgLy8gY3JlYXRlIGEgbmV3IHBlZXJcbiAgICAgIHBlZXIgPSB7XG4gICAgICAgIGlkOiBkYXRhLmlkLFxuXG4gICAgICAgIC8vIGluaXRpYWxpc2UgdGhlIGxvY2FsIHJvbGUgaW5kZXhcbiAgICAgICAgcm9sZUlkeDogW2RhdGEuaWQsIHNpZ25hbGxlci5pZF0uc29ydCgpLmluZGV4T2YoZGF0YS5pZCksXG5cbiAgICAgICAgLy8gaW5pdGlhbGlzZSB0aGUgcGVlciBkYXRhXG4gICAgICAgIGRhdGE6IHt9XG4gICAgICB9O1xuXG4gICAgICAvLyBpbml0aWFsaXNlIHRoZSBwZWVyIGRhdGFcbiAgICAgIGV4dGVuZChwZWVyLmRhdGEsIGRhdGEpO1xuXG4gICAgICAvLyByZXNldCBpbmFjdGl2aXR5IHN0YXRlXG4gICAgICBjbGVhclRpbWVvdXQocGVlci5sZWF2ZVRpbWVyKTtcbiAgICAgIHBlZXIuaW5hY3RpdmUgPSBmYWxzZTtcblxuICAgICAgLy8gc2V0IHRoZSBwZWVyIGRhdGFcbiAgICAgIHNpZ25hbGxlci5wZWVycy5zZXQoZGF0YS5pZCwgcGVlcik7XG5cbiAgICAgIC8vIGlmIHRoaXMgaXMgYW4gaW5pdGlhbCBhbm5vdW5jZSBtZXNzYWdlIChubyB2ZWN0b3IgY2xvY2sgYXR0YWNoZWQpXG4gICAgICAvLyB0aGVuIHNlbmQgYSBhbm5vdW5jZSByZXBseVxuICAgICAgaWYgKHNpZ25hbGxlci5hdXRvcmVwbHkgJiYgKCEgaXNETSkpIHtcbiAgICAgICAgc2lnbmFsbGVyXG4gICAgICAgICAgLnRvKGRhdGEuaWQpXG4gICAgICAgICAgLnNlbmQoJy9hbm5vdW5jZScsIHNpZ25hbGxlci5hdHRyaWJ1dGVzKTtcbiAgICAgIH1cblxuICAgICAgLy8gZW1pdCBhIG5ldyBwZWVyIGFubm91bmNlIGV2ZW50XG4gICAgICByZXR1cm4gc2lnbmFsbGVyKCdwZWVyOmFubm91bmNlJywgZGF0YSwgcGVlcik7XG4gICAgfVxuICB9O1xufTtcbiIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbi8qKlxuICAjIyMgc2lnbmFsbGVyIG1lc3NhZ2UgaGFuZGxlcnNcblxuKiovXG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oc2lnbmFsbGVyLCBvcHRzKSB7XG4gIHJldHVybiB7XG4gICAgYW5ub3VuY2U6IHJlcXVpcmUoJy4vYW5ub3VuY2UnKShzaWduYWxsZXIsIG9wdHMpXG4gIH07XG59O1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIGRldGVjdCA9IHJlcXVpcmUoJ3J0Yy1jb3JlL2RldGVjdCcpO1xudmFyIGRlZmF1bHRzID0gcmVxdWlyZSgnY29nL2RlZmF1bHRzJyk7XG52YXIgZXh0ZW5kID0gcmVxdWlyZSgnY29nL2V4dGVuZCcpO1xudmFyIG1idXMgPSByZXF1aXJlKCdtYnVzJyk7XG52YXIgZ2V0YWJsZSA9IHJlcXVpcmUoJ2NvZy9nZXRhYmxlJyk7XG52YXIgdXVpZCA9IHJlcXVpcmUoJ2N1aWQnKTtcbnZhciBwdWxsID0gcmVxdWlyZSgncHVsbC1zdHJlYW0nKTtcbnZhciBwdXNoYWJsZSA9IHJlcXVpcmUoJ3B1bGwtcHVzaGFibGUnKTtcblxuLy8gcmVhZHkgc3RhdGUgY29uc3RhbnRzXG52YXIgUlNfRElTQ09OTkVDVEVEID0gMDtcbnZhciBSU19DT05ORUNUSU5HID0gMTtcbnZhciBSU19DT05ORUNURUQgPSAyO1xuXG4vLyBpbml0aWFsaXNlIHNpZ25hbGxlciBtZXRhZGF0YSBzbyB3ZSBkb24ndCBoYXZlIHRvIGluY2x1ZGUgdGhlIHBhY2thZ2UuanNvblxuLy8gVE9ETzogbWFrZSB0aGlzIGNoZWNrYWJsZSB3aXRoIHNvbWUga2luZCBvZiBwcmVwdWJsaXNoIHNjcmlwdFxudmFyIG1ldGFkYXRhID0ge1xuICB2ZXJzaW9uOiAnNS4yLjMnXG59O1xuXG4vKipcbiAgIyBydGMtc2lnbmFsbGVyXG5cbiAgVGhlIGBydGMtc2lnbmFsbGVyYCBtb2R1bGUgcHJvdmlkZXMgYSB0cmFuc3BvcnRsZXNzIHNpZ25hbGxpbmdcbiAgbWVjaGFuaXNtIGZvciBXZWJSVEMuXG5cbiAgIyMgUHVycG9zZVxuXG4gIDw8PCBkb2NzL3B1cnBvc2UubWRcblxuICAjIyBHZXR0aW5nIFN0YXJ0ZWRcblxuICBXaGlsZSB0aGUgc2lnbmFsbGVyIGlzIGNhcGFibGUgb2YgY29tbXVuaWNhdGluZyBieSBhIG51bWJlciBvZiBkaWZmZXJlbnRcbiAgbWVzc2VuZ2VycyAoaS5lLiBhbnl0aGluZyB0aGF0IGNhbiBzZW5kIGFuZCByZWNlaXZlIG1lc3NhZ2VzIG92ZXIgYSB3aXJlKVxuICBpdCBjb21lcyB3aXRoIHN1cHBvcnQgZm9yIHVuZGVyc3RhbmRpbmcgaG93IHRvIGNvbm5lY3QgdG8gYW5cbiAgW3J0Yy1zd2l0Y2hib2FyZF0oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMtc3dpdGNoYm9hcmQpIG91dCBvZiB0aGUgYm94LlxuXG4gIFRoZSBmb2xsb3dpbmcgY29kZSBzYW1wbGUgZGVtb25zdHJhdGVzIGhvdzpcblxuICA8PDwgZXhhbXBsZXMvZ2V0dGluZy1zdGFydGVkLmpzXG5cbiAgPDw8IGRvY3MvZXZlbnRzLm1kXG5cbiAgPDw8IGRvY3Mvc2lnbmFsZmxvdy1kaWFncmFtcy5tZFxuXG4gICMjIFJlZmVyZW5jZVxuXG4gIFRoZSBgcnRjLXNpZ25hbGxlcmAgbW9kdWxlIGlzIGRlc2lnbmVkIHRvIGJlIHVzZWQgcHJpbWFyaWx5IGluIGEgZnVuY3Rpb25hbFxuICB3YXkgYW5kIHdoZW4gY2FsbGVkIGl0IGNyZWF0ZXMgYSBuZXcgc2lnbmFsbGVyIHRoYXQgd2lsbCBlbmFibGVcbiAgeW91IHRvIGNvbW11bmljYXRlIHdpdGggb3RoZXIgcGVlcnMgdmlhIHlvdXIgbWVzc2FnaW5nIG5ldHdvcmsuXG5cbiAgYGBganNcbiAgLy8gY3JlYXRlIGEgc2lnbmFsbGVyIGZyb20gc29tZXRoaW5nIHRoYXQga25vd3MgaG93IHRvIHNlbmQgbWVzc2FnZXNcbiAgdmFyIHNpZ25hbGxlciA9IHJlcXVpcmUoJ3J0Yy1zaWduYWxsZXInKShtZXNzZW5nZXIpO1xuICBgYGBcblxuICBBcyBkZW1vbnN0cmF0ZWQgaW4gdGhlIGdldHRpbmcgc3RhcnRlZCBndWlkZSwgeW91IGNhbiBhbHNvIHBhc3MgdGhyb3VnaFxuICBhIHN0cmluZyB2YWx1ZSBpbnN0ZWFkIG9mIGEgbWVzc2VuZ2VyIGluc3RhbmNlIGlmIHlvdSBzaW1wbHkgd2FudCB0b1xuICBjb25uZWN0IHRvIGFuIGV4aXN0aW5nIGBydGMtc3dpdGNoYm9hcmRgIGluc3RhbmNlLlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24obWVzc2VuZ2VyLCBvcHRzKSB7XG4gIC8vIGdldCB0aGUgYXV0b3JlcGx5IHNldHRpbmdcbiAgdmFyIGF1dG9yZXBseSA9IChvcHRzIHx8IHt9KS5hdXRvcmVwbHk7XG4gIHZhciBhdXRvY29ubmVjdCA9IChvcHRzIHx8IHt9KS5hdXRvY29ubmVjdDtcbiAgdmFyIHJlY29ubmVjdCA9IChvcHRzIHx8IHt9KS5yZWNvbm5lY3Q7XG5cbiAgLy8gaW5pdGlhbGlzZSB0aGUgbWV0YWRhdGFcbiAgdmFyIGxvY2FsTWV0YSA9IHt9O1xuXG4gIC8vIGNyZWF0ZSB0aGUgc2lnbmFsbGVyXG4gIHZhciBzaWduYWxsZXIgPSBtYnVzKCcnLCAob3B0cyB8fCB7fSkubG9nZ2VyKTtcblxuICAvLyBpbml0aWFsaXNlIHRoZSBpZFxuICB2YXIgaWQgPSBzaWduYWxsZXIuaWQgPSAob3B0cyB8fCB7fSkuaWQgfHwgdXVpZCgpO1xuXG4gIC8vIGluaXRpYWxpc2UgdGhlIGF0dHJpYnV0ZXNcbiAgdmFyIGF0dHJpYnV0ZXMgPSBzaWduYWxsZXIuYXR0cmlidXRlcyA9IHtcbiAgICBicm93c2VyOiBkZXRlY3QuYnJvd3NlcixcbiAgICBicm93c2VyVmVyc2lvbjogZGV0ZWN0LmJyb3dzZXJWZXJzaW9uLFxuICAgIGlkOiBpZCxcbiAgICBhZ2VudDogJ3NpZ25hbGxlckAnICsgbWV0YWRhdGEudmVyc2lvblxuICB9O1xuXG4gIC8vIGNyZWF0ZSB0aGUgcGVlcnMgbWFwXG4gIHZhciBwZWVycyA9IHNpZ25hbGxlci5wZWVycyA9IGdldGFibGUoe30pO1xuXG4gIC8vIGNyZWF0ZSB0aGUgb3V0Ym91bmQgbWVzc2FnZSBxdWV1ZVxuICB2YXIgcXVldWUgPSByZXF1aXJlKCdwdWxsLXB1c2hhYmxlJykoKTtcblxuICB2YXIgcHJvY2Vzc29yO1xuICB2YXIgYW5ub3VuY2VUaW1lciA9IDA7XG4gIHZhciByZWFkeVN0YXRlID0gUlNfRElTQ09OTkVDVEVEO1xuXG4gIGZ1bmN0aW9uIGFubm91bmNlT25SZWNvbm5lY3QoKSB7XG4gICAgc2lnbmFsbGVyLmFubm91bmNlKCk7XG4gIH1cblxuICBmdW5jdGlvbiBidWZmZXJNZXNzYWdlKGFyZ3MpIHtcbiAgICBxdWV1ZS5wdXNoKGNyZWF0ZURhdGFMaW5lKGFyZ3MpKTtcblxuICAgIC8vIGlmIHdlIGFyZSBub3QgY29ubmVjdGVkIChhbmQgc2hvdWxkIGF1dG9jb25uZWN0KSwgdGhlbiBhdHRlbXB0IGNvbm5lY3Rpb25cbiAgICBpZiAocmVhZHlTdGF0ZSA9PT0gUlNfRElTQ09OTkVDVEVEICYmIChhdXRvY29ubmVjdCA9PT0gdW5kZWZpbmVkIHx8IGF1dG9jb25uZWN0KSkge1xuICAgICAgY29ubmVjdCgpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGNyZWF0ZURhdGFMaW5lKGFyZ3MpIHtcbiAgICByZXR1cm4gYXJncy5tYXAocHJlcGFyZUFyZykuam9pbignfCcpO1xuICB9XG5cbiAgZnVuY3Rpb24gY3JlYXRlTWV0YWRhdGEoKSB7XG4gICAgcmV0dXJuIGV4dGVuZCh7fSwgbG9jYWxNZXRhLCB7IGlkOiBzaWduYWxsZXIuaWQgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVEaXNjb25uZWN0KCkge1xuICAgIGlmIChyZWNvbm5lY3QgPT09IHVuZGVmaW5lZCB8fCByZWNvbm5lY3QpIHtcbiAgICAgIHNldFRpbWVvdXQoY29ubmVjdCwgNTApO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHByZXBhcmVBcmcoYXJnKSB7XG4gICAgaWYgKHR5cGVvZiBhcmcgPT0gJ29iamVjdCcgJiYgKCEgKGFyZyBpbnN0YW5jZW9mIFN0cmluZykpKSB7XG4gICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoYXJnKTtcbiAgICB9XG4gICAgZWxzZSBpZiAodHlwZW9mIGFyZyA9PSAnZnVuY3Rpb24nKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICByZXR1cm4gYXJnO1xuICB9XG5cbiAgLyoqXG4gICAgIyMjIGBzaWduYWxsZXIuY29ubmVjdCgpYFxuXG4gICAgTWFudWFsbHkgY29ubmVjdCB0aGUgc2lnbmFsbGVyIHVzaW5nIHRoZSBzdXBwbGllZCBtZXNzZW5nZXIuXG5cbiAgICBfX05PVEU6X18gVGhpcyBzaG91bGQgbmV2ZXIgaGF2ZSB0byBiZSBjYWxsZWQgaWYgdGhlIGRlZmF1bHQgc2V0dGluZ1xuICAgIGZvciBgYXV0b2Nvbm5lY3RgIGlzIHVzZWQuXG4gICoqL1xuICB2YXIgY29ubmVjdCA9IHNpZ25hbGxlci5jb25uZWN0ID0gZnVuY3Rpb24oKSB7XG4gICAgLy8gaWYgd2UgYXJlIGFscmVhZHkgY29ubmVjdGluZyB0aGVuIGRvIG5vdGhpbmdcbiAgICBpZiAocmVhZHlTdGF0ZSA9PT0gUlNfQ09OTkVDVElORykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIGluaXRpYXRlIHRoZSBtZXNzZW5nZXJcbiAgICByZWFkeVN0YXRlID0gUlNfQ09OTkVDVElORztcbiAgICBtZXNzZW5nZXIoZnVuY3Rpb24oZXJyLCBzb3VyY2UsIHNpbmspIHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgcmVhZHlTdGF0ZSA9IFJTX0RJU0NPTk5FQ1RFRDtcbiAgICAgICAgcmV0dXJuIHNpZ25hbGxlcignZXJyb3InLCBlcnIpO1xuICAgICAgfVxuXG4gICAgICAvLyBmbGFnIGFzIGNvbm5lY3RlZFxuICAgICAgcmVhZHlTdGF0ZSA9IFJTX0NPTk5FQ1RFRDtcblxuICAgICAgLy8gcGFzcyBtZXNzYWdlcyB0byB0aGUgcHJvY2Vzc29yXG4gICAgICBwdWxsKFxuICAgICAgICBzb3VyY2UsXG5cbiAgICAgICAgLy8gbW9uaXRvciBkaXNjb25uZWN0aW9uXG4gICAgICAgIHB1bGwudGhyb3VnaChudWxsLCBmdW5jdGlvbigpIHtcbiAgICAgICAgICByZWFkeVN0YXRlID0gUlNfRElTQ09OTkVDVEVEO1xuICAgICAgICAgIHNpZ25hbGxlcignZGlzY29ubmVjdGVkJyk7XG4gICAgICAgIH0pLFxuICAgICAgICBwdWxsLmRyYWluKHByb2Nlc3NvcilcbiAgICAgICk7XG5cbiAgICAgIC8vIHBhc3MgdGhlIHF1ZXVlIHRvIHRoZSBzaW5rXG4gICAgICBwdWxsKHF1ZXVlLCBzaW5rKTtcblxuICAgICAgLy8gaGFuZGxlIGRpc2Nvbm5lY3Rpb25cbiAgICAgIHNpZ25hbGxlci5yZW1vdmVMaXN0ZW5lcignZGlzY29ubmVjdGVkJywgaGFuZGxlRGlzY29ubmVjdCk7XG4gICAgICBzaWduYWxsZXIub24oJ2Rpc2Nvbm5lY3RlZCcsIGhhbmRsZURpc2Nvbm5lY3QpO1xuXG4gICAgICAvLyB0cmlnZ2VyIHRoZSBjb25uZWN0ZWQgZXZlbnRcbiAgICAgIHNpZ25hbGxlcignY29ubmVjdGVkJyk7XG4gICAgfSk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIHNpZ25hbGxlciNzZW5kKG1lc3NhZ2UsIGRhdGEqKVxuXG4gICAgVXNlIHRoZSBzZW5kIGZ1bmN0aW9uIHRvIHNlbmQgYSBtZXNzYWdlIHRvIG90aGVyIHBlZXJzIGluIHRoZSBjdXJyZW50XG4gICAgc2lnbmFsbGluZyBzY29wZSAoaWYgYW5ub3VuY2VkIGluIGEgcm9vbSB0aGlzIHdpbGwgYmUgYSByb29tLCBvdGhlcndpc2VcbiAgICBicm9hZGNhc3QgdG8gYWxsIHBlZXJzIGNvbm5lY3RlZCB0byB0aGUgc2lnbmFsbGluZyBzZXJ2ZXIpLlxuXG4gICoqL1xuICB2YXIgc2VuZCA9IHNpZ25hbGxlci5zZW5kID0gZnVuY3Rpb24oKSB7XG4gICAgLy8gaXRlcmF0ZSBvdmVyIHRoZSBhcmd1bWVudHMgYW5kIHN0cmluZ2lmeSBhcyByZXF1aXJlZFxuICAgIC8vIHZhciBtZXRhZGF0YSA9IHsgaWQ6IHNpZ25hbGxlci5pZCB9O1xuICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpO1xuXG4gICAgLy8gaW5qZWN0IHRoZSBtZXRhZGF0YVxuICAgIGFyZ3Muc3BsaWNlKDEsIDAsIGNyZWF0ZU1ldGFkYXRhKCkpO1xuICAgIGJ1ZmZlck1lc3NhZ2UoYXJncyk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIGFubm91bmNlKGRhdGE/KVxuXG4gICAgVGhlIGBhbm5vdW5jZWAgZnVuY3Rpb24gb2YgdGhlIHNpZ25hbGxlciB3aWxsIHBhc3MgYW4gYC9hbm5vdW5jZWAgbWVzc2FnZVxuICAgIHRocm91Z2ggdGhlIG1lc3NlbmdlciBuZXR3b3JrLiAgV2hlbiBubyBhZGRpdGlvbmFsIGRhdGEgaXMgc3VwcGxpZWQgdG9cbiAgICB0aGlzIGZ1bmN0aW9uIHRoZW4gb25seSB0aGUgaWQgb2YgdGhlIHNpZ25hbGxlciBpcyBzZW50IHRvIGFsbCBhY3RpdmVcbiAgICBtZW1iZXJzIG9mIHRoZSBtZXNzZW5naW5nIG5ldHdvcmsuXG5cbiAgICAjIyMjIEpvaW5pbmcgUm9vbXNcblxuICAgIFRvIGpvaW4gYSByb29tIHVzaW5nIGFuIGFubm91bmNlIGNhbGwgeW91IHNpbXBseSBwcm92aWRlIHRoZSBuYW1lIG9mIHRoZVxuICAgIHJvb20geW91IHdpc2ggdG8gam9pbiBhcyBwYXJ0IG9mIHRoZSBkYXRhIGJsb2NrIHRoYXQgeW91IGFubm91Y2UsIGZvclxuICAgIGV4YW1wbGU6XG5cbiAgICBgYGBqc1xuICAgIHNpZ25hbGxlci5hbm5vdW5jZSh7IHJvb206ICd0ZXN0cm9vbScgfSk7XG4gICAgYGBgXG5cbiAgICBTaWduYWxsaW5nIHNlcnZlcnMgKHN1Y2ggYXNcbiAgICBbcnRjLXN3aXRjaGJvYXJkXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0Yy1zd2l0Y2hib2FyZCkpIHdpbGwgdGhlblxuICAgIHBsYWNlIHlvdXIgcGVlciBjb25uZWN0aW9uIGludG8gYSByb29tIHdpdGggb3RoZXIgcGVlcnMgdGhhdCBoYXZlIGFsc29cbiAgICBhbm5vdW5jZWQgaW4gdGhpcyByb29tLlxuXG4gICAgT25jZSB5b3UgaGF2ZSBqb2luZWQgYSByb29tLCB0aGUgc2VydmVyIHdpbGwgb25seSBkZWxpdmVyIG1lc3NhZ2VzIHRoYXRcbiAgICB5b3UgYHNlbmRgIHRvIG90aGVyIHBlZXJzIHdpdGhpbiB0aGF0IHJvb20uXG5cbiAgICAjIyMjIFByb3ZpZGluZyBBZGRpdGlvbmFsIEFubm91bmNlIERhdGFcblxuICAgIFRoZXJlIG1heSBiZSBpbnN0YW5jZXMgd2hlcmUgeW91IHdpc2ggdG8gc2VuZCBhZGRpdGlvbmFsIGRhdGEgYXMgcGFydCBvZlxuICAgIHlvdXIgYW5ub3VuY2UgbWVzc2FnZSBpbiB5b3VyIGFwcGxpY2F0aW9uLiAgRm9yIGluc3RhbmNlLCBtYXliZSB5b3Ugd2FudFxuICAgIHRvIHNlbmQgYW4gYWxpYXMgb3IgbmljayBhcyBwYXJ0IG9mIHlvdXIgYW5ub3VuY2UgbWVzc2FnZSByYXRoZXIgdGhhbiBqdXN0XG4gICAgdXNlIHRoZSBzaWduYWxsZXIncyBnZW5lcmF0ZWQgaWQuXG5cbiAgICBJZiBmb3IgaW5zdGFuY2UgeW91IHdlcmUgd3JpdGluZyBhIHNpbXBsZSBjaGF0IGFwcGxpY2F0aW9uIHlvdSBjb3VsZCBqb2luXG4gICAgdGhlIGB3ZWJydGNgIHJvb20gYW5kIHRlbGwgZXZlcnlvbmUgeW91ciBuYW1lIHdpdGggdGhlIGZvbGxvd2luZyBhbm5vdW5jZVxuICAgIGNhbGw6XG5cbiAgICBgYGBqc1xuICAgIHNpZ25hbGxlci5hbm5vdW5jZSh7XG4gICAgICByb29tOiAnd2VicnRjJyxcbiAgICAgIG5pY2s6ICdEYW1vbidcbiAgICB9KTtcbiAgICBgYGBcblxuICAgICMjIyMgQW5ub3VuY2luZyBVcGRhdGVzXG5cbiAgICBUaGUgc2lnbmFsbGVyIGlzIHdyaXR0ZW4gdG8gZGlzdGluZ3Vpc2ggYmV0d2VlbiBpbml0aWFsIHBlZXIgYW5ub3VuY2VtZW50c1xuICAgIGFuZCBwZWVyIGRhdGEgdXBkYXRlcyAoc2VlIHRoZSBkb2NzIG9uIHRoZSBhbm5vdW5jZSBoYW5kbGVyIGJlbG93KS4gQXNcbiAgICBzdWNoIGl0IGlzIG9rIHRvIHByb3ZpZGUgYW55IGRhdGEgdXBkYXRlcyB1c2luZyB0aGUgYW5ub3VuY2UgbWV0aG9kIGFsc28uXG5cbiAgICBGb3IgaW5zdGFuY2UsIEkgY291bGQgc2VuZCBhIHN0YXR1cyB1cGRhdGUgYXMgYW4gYW5ub3VuY2UgbWVzc2FnZSB0byBmbGFnXG4gICAgdGhhdCBJIGFtIGdvaW5nIG9mZmxpbmU6XG5cbiAgICBgYGBqc1xuICAgIHNpZ25hbGxlci5hbm5vdW5jZSh7IHN0YXR1czogJ29mZmxpbmUnIH0pO1xuICAgIGBgYFxuXG4gICoqL1xuICBzaWduYWxsZXIuYW5ub3VuY2UgPSBmdW5jdGlvbihkYXRhLCBzZW5kZXIpIHtcblxuICAgIGZ1bmN0aW9uIHNlbmRBbm5vdW5jZSgpIHtcbiAgICAgIChzZW5kZXIgfHwgc2VuZCkoJy9hbm5vdW5jZScsIGF0dHJpYnV0ZXMpO1xuICAgICAgc2lnbmFsbGVyKCdsb2NhbDphbm5vdW5jZScsIGF0dHJpYnV0ZXMpO1xuICAgIH1cblxuICAgIC8vIGlmIHdlIGFyZSBhbHJlYWR5IGNvbm5lY3RlZCwgdGhlbiBlbnN1cmUgd2UgYW5ub3VuY2Ugb24gcmVjb25uZWN0XG4gICAgaWYgKHJlYWR5U3RhdGUgPT09IFJTX0NPTk5FQ1RFRCkge1xuICAgICAgLy8gYWx3YXlzIGFubm91bmNlIG9uIHJlY29ubmVjdFxuICAgICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdjb25uZWN0ZWQnLCBhbm5vdW5jZU9uUmVjb25uZWN0KTtcbiAgICAgIHNpZ25hbGxlci5vbignY29ubmVjdGVkJywgYW5ub3VuY2VPblJlY29ubmVjdCk7XG4gICAgfVxuXG4gICAgY2xlYXJUaW1lb3V0KGFubm91bmNlVGltZXIpO1xuXG4gICAgLy8gdXBkYXRlIGludGVybmFsIGF0dHJpYnV0ZXNcbiAgICBleHRlbmQoYXR0cmlidXRlcywgZGF0YSwgeyBpZDogc2lnbmFsbGVyLmlkIH0pO1xuXG4gICAgLy8gc2VuZCB0aGUgYXR0cmlidXRlcyBvdmVyIHRoZSBuZXR3b3JrXG4gICAgcmV0dXJuIGFubm91bmNlVGltZXIgPSBzZXRUaW1lb3V0KHNlbmRBbm5vdW5jZSwgKG9wdHMgfHwge30pLmFubm91bmNlRGVsYXkgfHwgMTApO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyBpc01hc3Rlcih0YXJnZXRJZClcblxuICAgIEEgc2ltcGxlIGZ1bmN0aW9uIHRoYXQgaW5kaWNhdGVzIHdoZXRoZXIgdGhlIGxvY2FsIHNpZ25hbGxlciBpcyB0aGUgbWFzdGVyXG4gICAgZm9yIGl0J3MgcmVsYXRpb25zaGlwIHdpdGggcGVlciBzaWduYWxsZXIgaW5kaWNhdGVkIGJ5IGB0YXJnZXRJZGAuICBSb2xlc1xuICAgIGFyZSBkZXRlcm1pbmVkIGF0IHRoZSBwb2ludCBhdCB3aGljaCBzaWduYWxsaW5nIHBlZXJzIGRpc2NvdmVyIGVhY2ggb3RoZXIsXG4gICAgYW5kIGFyZSBzaW1wbHkgd29ya2VkIG91dCBieSB3aGljaGV2ZXIgcGVlciBoYXMgdGhlIGxvd2VzdCBzaWduYWxsZXIgaWRcbiAgICB3aGVuIGxleGlncmFwaGljYWxseSBzb3J0ZWQuXG5cbiAgICBGb3IgZXhhbXBsZSwgaWYgd2UgaGF2ZSB0d28gc2lnbmFsbGVyIHBlZXJzIHRoYXQgaGF2ZSBkaXNjb3ZlcmVkIGVhY2hcbiAgICBvdGhlcnMgd2l0aCB0aGUgZm9sbG93aW5nIGlkczpcblxuICAgIC0gYGIxMWY0ZmQwLWZlYjUtNDQ3Yy04MGM4LWM1MWQ4YzNjY2VkMmBcbiAgICAtIGA4YTA3ZjgyZS00OWE1LTRiOWItYTAyZS00M2Q5MTEzODJiZTZgXG5cbiAgICBUaGV5IHdvdWxkIGJlIGFzc2lnbmVkIHJvbGVzOlxuXG4gICAgLSBgYjExZjRmZDAtZmViNS00NDdjLTgwYzgtYzUxZDhjM2NjZWQyYFxuICAgIC0gYDhhMDdmODJlLTQ5YTUtNGI5Yi1hMDJlLTQzZDkxMTM4MmJlNmAgKG1hc3RlcilcblxuICAqKi9cbiAgc2lnbmFsbGVyLmlzTWFzdGVyID0gZnVuY3Rpb24odGFyZ2V0SWQpIHtcbiAgICB2YXIgcGVlciA9IHBlZXJzLmdldCh0YXJnZXRJZCk7XG5cbiAgICByZXR1cm4gcGVlciAmJiBwZWVyLnJvbGVJZHggIT09IDA7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIGxlYXZlKClcblxuICAgIFRlbGwgdGhlIHNpZ25hbGxpbmcgc2VydmVyIHdlIGFyZSBsZWF2aW5nLiAgQ2FsbGluZyB0aGlzIGZ1bmN0aW9uIGlzXG4gICAgdXN1YWxseSBub3QgcmVxdWlyZWQgdGhvdWdoIGFzIHRoZSBzaWduYWxsaW5nIHNlcnZlciBzaG91bGQgaXNzdWUgY29ycmVjdFxuICAgIGAvbGVhdmVgIG1lc3NhZ2VzIHdoZW4gaXQgZGV0ZWN0cyBhIGRpc2Nvbm5lY3QgZXZlbnQuXG5cbiAgKiovXG4gIHNpZ25hbGxlci5sZWF2ZSA9IHNpZ25hbGxlci5jbG9zZSA9IGZ1bmN0aW9uKCkge1xuICAgIC8vIHNlbmQgdGhlIGxlYXZlIHNpZ25hbFxuICAgIHNlbmQoJy9sZWF2ZScsIHsgaWQ6IGlkIH0pO1xuXG4gICAgLy8gc3RvcCBhbm5vdW5jaW5nIG9uIHJlY29ubmVjdFxuICAgIHNpZ25hbGxlci5yZW1vdmVMaXN0ZW5lcignZGlzY29ubmVjdGVkJywgaGFuZGxlRGlzY29ubmVjdCk7XG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdjb25uZWN0ZWQnLCBhbm5vdW5jZU9uUmVjb25uZWN0KTtcblxuICAgIC8vIGVuZCBvdXIgY3VycmVudCBxdWV1ZVxuICAgIHF1ZXVlLmVuZCgpO1xuXG4gICAgLy8gY3JlYXRlIGEgbmV3IHF1ZXVlIHRvIGJ1ZmZlciBuZXcgbWVzc2FnZXNcbiAgICBxdWV1ZSA9IHB1c2hhYmxlKCk7XG5cbiAgICAvLyBzZXQgY29ubmVjdGVkIHRvIGZhbHNlXG4gICAgcmVhZHlTdGF0ZSA9IFJTX0RJU0NPTk5FQ1RFRDtcbiAgfTtcblxuICAvKipcbiAgICAjIyMgbWV0YWRhdGEoZGF0YT8pXG5cbiAgICBHZXQgKHBhc3Mgbm8gZGF0YSkgb3Igc2V0IHRoZSBtZXRhZGF0YSB0aGF0IGlzIHBhc3NlZCB0aHJvdWdoIHdpdGggZWFjaFxuICAgIHJlcXVlc3Qgc2VudCBieSB0aGUgc2lnbmFsbGVyLlxuXG4gICAgX19OT1RFOl9fIFJlZ2FyZGxlc3Mgb2Ygd2hhdCBpcyBwYXNzZWQgdG8gdGhpcyBmdW5jdGlvbiwgbWV0YWRhdGFcbiAgICBnZW5lcmF0ZWQgYnkgdGhlIHNpZ25hbGxlciB3aWxsICoqYWx3YXlzKiogaW5jbHVkZSB0aGUgaWQgb2YgdGhlIHNpZ25hbGxlclxuICAgIGFuZCB0aGlzIGNhbm5vdCBiZSBtb2RpZmllZC5cbiAgKiovXG4gIHNpZ25hbGxlci5tZXRhZGF0YSA9IGZ1bmN0aW9uKGRhdGEpIHtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuIGV4dGVuZCh7fSwgbG9jYWxNZXRhKTtcbiAgICB9XG5cbiAgICBsb2NhbE1ldGEgPSBleHRlbmQoe30sIGRhdGEpO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyB0byh0YXJnZXRJZClcblxuICAgIFVzZSB0aGUgYHRvYCBmdW5jdGlvbiB0byBzZW5kIGEgbWVzc2FnZSB0byB0aGUgc3BlY2lmaWVkIHRhcmdldCBwZWVyLlxuICAgIEEgbGFyZ2UgcGFyZ2Ugb2YgbmVnb3RpYXRpbmcgYSBXZWJSVEMgcGVlciBjb25uZWN0aW9uIGludm9sdmVzIGRpcmVjdFxuICAgIGNvbW11bmljYXRpb24gYmV0d2VlbiB0d28gcGFydGllcyB3aGljaCBtdXN0IGJlIGRvbmUgYnkgdGhlIHNpZ25hbGxpbmdcbiAgICBzZXJ2ZXIuICBUaGUgYHRvYCBmdW5jdGlvbiBwcm92aWRlcyBhIHNpbXBsZSB3YXkgdG8gcHJvdmlkZSBhIGxvZ2ljYWxcbiAgICBjb21tdW5pY2F0aW9uIGNoYW5uZWwgYmV0d2VlbiB0aGUgdHdvIHBhcnRpZXM6XG5cbiAgICBgYGBqc1xuICAgIHZhciBzZW5kID0gc2lnbmFsbGVyLnRvKCdlOTVmYTA1Yi05MDYyLTQ1YzYtYmZhMi01MDU1YmY2NjI1ZjQnKS5zZW5kO1xuXG4gICAgLy8gY3JlYXRlIGFuIG9mZmVyIG9uIGEgbG9jYWwgcGVlciBjb25uZWN0aW9uXG4gICAgcGMuY3JlYXRlT2ZmZXIoXG4gICAgICBmdW5jdGlvbihkZXNjKSB7XG4gICAgICAgIC8vIHNldCB0aGUgbG9jYWwgZGVzY3JpcHRpb24gdXNpbmcgdGhlIG9mZmVyIHNkcFxuICAgICAgICAvLyBpZiB0aGlzIG9jY3VycyBzdWNjZXNzZnVsbHkgc2VuZCB0aGlzIHRvIG91ciBwZWVyXG4gICAgICAgIHBjLnNldExvY2FsRGVzY3JpcHRpb24oXG4gICAgICAgICAgZGVzYyxcbiAgICAgICAgICBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHNlbmQoJy9zZHAnLCBkZXNjKTtcbiAgICAgICAgICB9LFxuICAgICAgICAgIGhhbmRsZUZhaWxcbiAgICAgICAgKTtcbiAgICAgIH0sXG4gICAgICBoYW5kbGVGYWlsXG4gICAgKTtcbiAgICBgYGBcblxuICAqKi9cbiAgc2lnbmFsbGVyLnRvID0gZnVuY3Rpb24odGFyZ2V0SWQpIHtcbiAgICAvLyBjcmVhdGUgYSBzZW5kZXIgdGhhdCB3aWxsIHByZXBlbmQgbWVzc2FnZXMgd2l0aCAvdG98dGFyZ2V0SWR8XG4gICAgdmFyIHNlbmRlciA9IGZ1bmN0aW9uKCkge1xuICAgICAgLy8gZ2V0IHRoZSBwZWVyICh5ZXMgd2hlbiBzZW5kIGlzIGNhbGxlZCB0byBtYWtlIHN1cmUgaXQgaGFzbid0IGxlZnQpXG4gICAgICB2YXIgcGVlciA9IHNpZ25hbGxlci5wZWVycy5nZXQodGFyZ2V0SWQpO1xuICAgICAgdmFyIGFyZ3M7XG5cbiAgICAgIGlmICghIHBlZXIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIHBlZXI6ICcgKyB0YXJnZXRJZCk7XG4gICAgICB9XG5cbiAgICAgIC8vIGlmIHRoZSBwZWVyIGlzIGluYWN0aXZlLCB0aGVuIGFib3J0XG4gICAgICBpZiAocGVlci5pbmFjdGl2ZSkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGFyZ3MgPSBbXG4gICAgICAgICcvdG8nLFxuICAgICAgICB0YXJnZXRJZFxuICAgICAgXS5jb25jYXQoW10uc2xpY2UuY2FsbChhcmd1bWVudHMpKTtcblxuICAgICAgLy8gaW5qZWN0IG1ldGFkYXRhXG4gICAgICBhcmdzLnNwbGljZSgzLCAwLCBjcmVhdGVNZXRhZGF0YSgpKTtcbiAgICAgIGJ1ZmZlck1lc3NhZ2UoYXJncyk7XG4gICAgfTtcblxuICAgIHJldHVybiB7XG4gICAgICBhbm5vdW5jZTogZnVuY3Rpb24oZGF0YSkge1xuICAgICAgICByZXR1cm4gc2lnbmFsbGVyLmFubm91bmNlKGRhdGEsIHNlbmRlcik7XG4gICAgICB9LFxuXG4gICAgICBzZW5kOiBzZW5kZXIsXG4gICAgfTtcbiAgfTtcblxuICAvLyBpbml0aWFsaXNlIG9wdHMgZGVmYXVsdHNcbiAgb3B0cyA9IGRlZmF1bHRzKHt9LCBvcHRzLCByZXF1aXJlKCcuL2RlZmF1bHRzJykpO1xuXG4gIC8vIHNldCB0aGUgYXV0b3JlcGx5IGZsYWdcbiAgc2lnbmFsbGVyLmF1dG9yZXBseSA9IGF1dG9yZXBseSA9PT0gdW5kZWZpbmVkIHx8IGF1dG9yZXBseTtcblxuICAvLyBjcmVhdGUgdGhlIHByb2Nlc3NvclxuICBzaWduYWxsZXIucHJvY2VzcyA9IHByb2Nlc3NvciA9IHJlcXVpcmUoJy4vcHJvY2Vzc29yJykoc2lnbmFsbGVyLCBvcHRzKTtcblxuICAvLyBhdXRvY29ubmVjdFxuICBpZiAoYXV0b2Nvbm5lY3QgPT09IHVuZGVmaW5lZCB8fCBhdXRvY29ubmVjdCkge1xuICAgIGNvbm5lY3QoKTtcbiAgfVxuXG4gIHJldHVybiBzaWduYWxsZXI7XG59O1xuIiwiLyoqXG4gKiBjdWlkLmpzXG4gKiBDb2xsaXNpb24tcmVzaXN0YW50IFVJRCBnZW5lcmF0b3IgZm9yIGJyb3dzZXJzIGFuZCBub2RlLlxuICogU2VxdWVudGlhbCBmb3IgZmFzdCBkYiBsb29rdXBzIGFuZCByZWNlbmN5IHNvcnRpbmcuXG4gKiBTYWZlIGZvciBlbGVtZW50IElEcyBhbmQgc2VydmVyLXNpZGUgbG9va3Vwcy5cbiAqXG4gKiBFeHRyYWN0ZWQgZnJvbSBDTENUUlxuICogXG4gKiBDb3B5cmlnaHQgKGMpIEVyaWMgRWxsaW90dCAyMDEyXG4gKiBNSVQgTGljZW5zZVxuICovXG5cbi8qZ2xvYmFsIHdpbmRvdywgbmF2aWdhdG9yLCBkb2N1bWVudCwgcmVxdWlyZSwgcHJvY2VzcywgbW9kdWxlICovXG4oZnVuY3Rpb24gKGFwcCkge1xuICAndXNlIHN0cmljdCc7XG4gIHZhciBuYW1lc3BhY2UgPSAnY3VpZCcsXG4gICAgYyA9IDAsXG4gICAgYmxvY2tTaXplID0gNCxcbiAgICBiYXNlID0gMzYsXG4gICAgZGlzY3JldGVWYWx1ZXMgPSBNYXRoLnBvdyhiYXNlLCBibG9ja1NpemUpLFxuXG4gICAgcGFkID0gZnVuY3Rpb24gcGFkKG51bSwgc2l6ZSkge1xuICAgICAgdmFyIHMgPSBcIjAwMDAwMDAwMFwiICsgbnVtO1xuICAgICAgcmV0dXJuIHMuc3Vic3RyKHMubGVuZ3RoLXNpemUpO1xuICAgIH0sXG5cbiAgICByYW5kb21CbG9jayA9IGZ1bmN0aW9uIHJhbmRvbUJsb2NrKCkge1xuICAgICAgcmV0dXJuIHBhZCgoTWF0aC5yYW5kb20oKSAqXG4gICAgICAgICAgICBkaXNjcmV0ZVZhbHVlcyA8PCAwKVxuICAgICAgICAgICAgLnRvU3RyaW5nKGJhc2UpLCBibG9ja1NpemUpO1xuICAgIH0sXG5cbiAgICBzYWZlQ291bnRlciA9IGZ1bmN0aW9uICgpIHtcbiAgICAgIGMgPSAoYyA8IGRpc2NyZXRlVmFsdWVzKSA/IGMgOiAwO1xuICAgICAgYysrOyAvLyB0aGlzIGlzIG5vdCBzdWJsaW1pbmFsXG4gICAgICByZXR1cm4gYyAtIDE7XG4gICAgfSxcblxuICAgIGFwaSA9IGZ1bmN0aW9uIGN1aWQoKSB7XG4gICAgICAvLyBTdGFydGluZyB3aXRoIGEgbG93ZXJjYXNlIGxldHRlciBtYWtlc1xuICAgICAgLy8gaXQgSFRNTCBlbGVtZW50IElEIGZyaWVuZGx5LlxuICAgICAgdmFyIGxldHRlciA9ICdjJywgLy8gaGFyZC1jb2RlZCBhbGxvd3MgZm9yIHNlcXVlbnRpYWwgYWNjZXNzXG5cbiAgICAgICAgLy8gdGltZXN0YW1wXG4gICAgICAgIC8vIHdhcm5pbmc6IHRoaXMgZXhwb3NlcyB0aGUgZXhhY3QgZGF0ZSBhbmQgdGltZVxuICAgICAgICAvLyB0aGF0IHRoZSB1aWQgd2FzIGNyZWF0ZWQuXG4gICAgICAgIHRpbWVzdGFtcCA9IChuZXcgRGF0ZSgpLmdldFRpbWUoKSkudG9TdHJpbmcoYmFzZSksXG5cbiAgICAgICAgLy8gUHJldmVudCBzYW1lLW1hY2hpbmUgY29sbGlzaW9ucy5cbiAgICAgICAgY291bnRlcixcblxuICAgICAgICAvLyBBIGZldyBjaGFycyB0byBnZW5lcmF0ZSBkaXN0aW5jdCBpZHMgZm9yIGRpZmZlcmVudFxuICAgICAgICAvLyBjbGllbnRzIChzbyBkaWZmZXJlbnQgY29tcHV0ZXJzIGFyZSBmYXIgbGVzc1xuICAgICAgICAvLyBsaWtlbHkgdG8gZ2VuZXJhdGUgdGhlIHNhbWUgaWQpXG4gICAgICAgIGZpbmdlcnByaW50ID0gYXBpLmZpbmdlcnByaW50KCksXG5cbiAgICAgICAgLy8gR3JhYiBzb21lIG1vcmUgY2hhcnMgZnJvbSBNYXRoLnJhbmRvbSgpXG4gICAgICAgIHJhbmRvbSA9IHJhbmRvbUJsb2NrKCkgKyByYW5kb21CbG9jaygpO1xuXG4gICAgICAgIGNvdW50ZXIgPSBwYWQoc2FmZUNvdW50ZXIoKS50b1N0cmluZyhiYXNlKSwgYmxvY2tTaXplKTtcblxuICAgICAgcmV0dXJuICAobGV0dGVyICsgdGltZXN0YW1wICsgY291bnRlciArIGZpbmdlcnByaW50ICsgcmFuZG9tKTtcbiAgICB9O1xuXG4gIGFwaS5zbHVnID0gZnVuY3Rpb24gc2x1ZygpIHtcbiAgICB2YXIgZGF0ZSA9IG5ldyBEYXRlKCkuZ2V0VGltZSgpLnRvU3RyaW5nKDM2KSxcbiAgICAgIGNvdW50ZXIsXG4gICAgICBwcmludCA9IGFwaS5maW5nZXJwcmludCgpLnNsaWNlKDAsMSkgK1xuICAgICAgICBhcGkuZmluZ2VycHJpbnQoKS5zbGljZSgtMSksXG4gICAgICByYW5kb20gPSByYW5kb21CbG9jaygpLnNsaWNlKC0yKTtcblxuICAgICAgY291bnRlciA9IHNhZmVDb3VudGVyKCkudG9TdHJpbmcoMzYpLnNsaWNlKC00KTtcblxuICAgIHJldHVybiBkYXRlLnNsaWNlKC0yKSArIFxuICAgICAgY291bnRlciArIHByaW50ICsgcmFuZG9tO1xuICB9O1xuXG4gIGFwaS5nbG9iYWxDb3VudCA9IGZ1bmN0aW9uIGdsb2JhbENvdW50KCkge1xuICAgIC8vIFdlIHdhbnQgdG8gY2FjaGUgdGhlIHJlc3VsdHMgb2YgdGhpc1xuICAgIHZhciBjYWNoZSA9IChmdW5jdGlvbiBjYWxjKCkge1xuICAgICAgICB2YXIgaSxcbiAgICAgICAgICBjb3VudCA9IDA7XG5cbiAgICAgICAgZm9yIChpIGluIHdpbmRvdykge1xuICAgICAgICAgIGNvdW50Kys7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY291bnQ7XG4gICAgICB9KCkpO1xuXG4gICAgYXBpLmdsb2JhbENvdW50ID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gY2FjaGU7IH07XG4gICAgcmV0dXJuIGNhY2hlO1xuICB9O1xuXG4gIGFwaS5maW5nZXJwcmludCA9IGZ1bmN0aW9uIGJyb3dzZXJQcmludCgpIHtcbiAgICByZXR1cm4gcGFkKChuYXZpZ2F0b3IubWltZVR5cGVzLmxlbmd0aCArXG4gICAgICBuYXZpZ2F0b3IudXNlckFnZW50Lmxlbmd0aCkudG9TdHJpbmcoMzYpICtcbiAgICAgIGFwaS5nbG9iYWxDb3VudCgpLnRvU3RyaW5nKDM2KSwgNCk7XG4gIH07XG5cbiAgLy8gZG9uJ3QgY2hhbmdlIGFueXRoaW5nIGZyb20gaGVyZSBkb3duLlxuICBpZiAoYXBwLnJlZ2lzdGVyKSB7XG4gICAgYXBwLnJlZ2lzdGVyKG5hbWVzcGFjZSwgYXBpKTtcbiAgfSBlbHNlIGlmICh0eXBlb2YgbW9kdWxlICE9PSAndW5kZWZpbmVkJykge1xuICAgIG1vZHVsZS5leHBvcnRzID0gYXBpO1xuICB9IGVsc2Uge1xuICAgIGFwcFtuYW1lc3BhY2VdID0gYXBpO1xuICB9XG5cbn0odGhpcy5hcHBsaXR1ZGUgfHwgdGhpcykpO1xuIiwidmFyIHB1bGwgPSByZXF1aXJlKCdwdWxsLXN0cmVhbScpXG5cbm1vZHVsZS5leHBvcnRzID0gcHVsbC5Tb3VyY2UoZnVuY3Rpb24gKG9uQ2xvc2UpIHtcbiAgdmFyIGJ1ZmZlciA9IFtdLCBjYnMgPSBbXSwgd2FpdGluZyA9IFtdLCBlbmRlZFxuXG4gIGZ1bmN0aW9uIGRyYWluKCkge1xuICAgIHZhciBsXG4gICAgd2hpbGUod2FpdGluZy5sZW5ndGggJiYgKChsID0gYnVmZmVyLmxlbmd0aCkgfHwgZW5kZWQpKSB7XG4gICAgICB2YXIgZGF0YSA9IGJ1ZmZlci5zaGlmdCgpXG4gICAgICB2YXIgY2IgICA9IGNicy5zaGlmdCgpXG4gICAgICB3YWl0aW5nLnNoaWZ0KCkobCA/IG51bGwgOiBlbmRlZCwgZGF0YSlcbiAgICAgIGNiICYmIGNiKGVuZGVkID09PSB0cnVlID8gbnVsbCA6IGVuZGVkKVxuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHJlYWQgKGVuZCwgY2IpIHtcbiAgICBlbmRlZCA9IGVuZGVkIHx8IGVuZFxuICAgIHdhaXRpbmcucHVzaChjYilcbiAgICBkcmFpbigpXG4gICAgaWYoZW5kZWQpXG4gICAgICBvbkNsb3NlICYmIG9uQ2xvc2UoZW5kZWQgPT09IHRydWUgPyBudWxsIDogZW5kZWQpXG4gIH1cblxuICByZWFkLnB1c2ggPSBmdW5jdGlvbiAoZGF0YSwgY2IpIHtcbiAgICBpZihlbmRlZClcbiAgICAgIHJldHVybiBjYiAmJiBjYihlbmRlZCA9PT0gdHJ1ZSA/IG51bGwgOiBlbmRlZClcbiAgICBidWZmZXIucHVzaChkYXRhKTsgY2JzLnB1c2goY2IpXG4gICAgZHJhaW4oKVxuICB9XG5cbiAgcmVhZC5lbmQgPSBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGlmKCdmdW5jdGlvbicgPT09IHR5cGVvZiBlbmQpXG4gICAgICBjYiA9IGVuZCwgZW5kID0gdHJ1ZVxuICAgIGVuZGVkID0gZW5kZWQgfHwgZW5kIHx8IHRydWU7XG4gICAgaWYoY2IpIGNicy5wdXNoKGNiKVxuICAgIGRyYWluKClcbiAgICBpZihlbmRlZClcbiAgICAgIG9uQ2xvc2UgJiYgb25DbG9zZShlbmRlZCA9PT0gdHJ1ZSA/IG51bGwgOiBlbmRlZClcbiAgfVxuXG4gIHJldHVybiByZWFkXG59KVxuXG4iLCJcbnZhciBzb3VyY2VzICA9IHJlcXVpcmUoJy4vc291cmNlcycpXG52YXIgc2lua3MgICAgPSByZXF1aXJlKCcuL3NpbmtzJylcbnZhciB0aHJvdWdocyA9IHJlcXVpcmUoJy4vdGhyb3VnaHMnKVxudmFyIHUgICAgICAgID0gcmVxdWlyZSgncHVsbC1jb3JlJylcblxuZm9yKHZhciBrIGluIHNvdXJjZXMpXG4gIGV4cG9ydHNba10gPSB1LlNvdXJjZShzb3VyY2VzW2tdKVxuXG5mb3IodmFyIGsgaW4gdGhyb3VnaHMpXG4gIGV4cG9ydHNba10gPSB1LlRocm91Z2godGhyb3VnaHNba10pXG5cbmZvcih2YXIgayBpbiBzaW5rcylcbiAgZXhwb3J0c1trXSA9IHUuU2luayhzaW5rc1trXSlcblxudmFyIG1heWJlID0gcmVxdWlyZSgnLi9tYXliZScpKGV4cG9ydHMpXG5cbmZvcih2YXIgayBpbiBtYXliZSlcbiAgZXhwb3J0c1trXSA9IG1heWJlW2tdXG5cbmV4cG9ydHMuRHVwbGV4ICA9IFxuZXhwb3J0cy5UaHJvdWdoID0gZXhwb3J0cy5waXBlYWJsZSAgICAgICA9IHUuVGhyb3VnaFxuZXhwb3J0cy5Tb3VyY2UgID0gZXhwb3J0cy5waXBlYWJsZVNvdXJjZSA9IHUuU291cmNlXG5leHBvcnRzLlNpbmsgICAgPSBleHBvcnRzLnBpcGVhYmxlU2luayAgID0gdS5TaW5rXG5cblxuIiwidmFyIHUgPSByZXF1aXJlKCdwdWxsLWNvcmUnKVxudmFyIHByb3AgPSB1LnByb3BcbnZhciBpZCAgID0gdS5pZFxudmFyIG1heWJlU2luayA9IHUubWF5YmVTaW5rXG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKHB1bGwpIHtcblxuICB2YXIgZXhwb3J0cyA9IHt9XG4gIHZhciBkcmFpbiA9IHB1bGwuZHJhaW5cblxuICB2YXIgZmluZCA9IFxuICBleHBvcnRzLmZpbmQgPSBmdW5jdGlvbiAodGVzdCwgY2IpIHtcbiAgICByZXR1cm4gbWF5YmVTaW5rKGZ1bmN0aW9uIChjYikge1xuICAgICAgdmFyIGVuZGVkID0gZmFsc2VcbiAgICAgIGlmKCFjYilcbiAgICAgICAgY2IgPSB0ZXN0LCB0ZXN0ID0gaWRcbiAgICAgIGVsc2VcbiAgICAgICAgdGVzdCA9IHByb3AodGVzdCkgfHwgaWRcblxuICAgICAgcmV0dXJuIGRyYWluKGZ1bmN0aW9uIChkYXRhKSB7XG4gICAgICAgIGlmKHRlc3QoZGF0YSkpIHtcbiAgICAgICAgICBlbmRlZCA9IHRydWVcbiAgICAgICAgICBjYihudWxsLCBkYXRhKVxuICAgICAgICByZXR1cm4gZmFsc2VcbiAgICAgICAgfVxuICAgICAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICBpZihlbmRlZCkgcmV0dXJuIC8vYWxyZWFkeSBjYWxsZWQgYmFja1xuICAgICAgICBjYihlcnIgPT09IHRydWUgPyBudWxsIDogZXJyLCBudWxsKVxuICAgICAgfSlcblxuICAgIH0sIGNiKVxuICB9XG5cbiAgdmFyIHJlZHVjZSA9IGV4cG9ydHMucmVkdWNlID0gXG4gIGZ1bmN0aW9uIChyZWR1Y2UsIGFjYywgY2IpIHtcbiAgICBcbiAgICByZXR1cm4gbWF5YmVTaW5rKGZ1bmN0aW9uIChjYikge1xuICAgICAgcmV0dXJuIGRyYWluKGZ1bmN0aW9uIChkYXRhKSB7XG4gICAgICAgIGFjYyA9IHJlZHVjZShhY2MsIGRhdGEpXG4gICAgICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgIGNiKGVyciwgYWNjKVxuICAgICAgfSlcblxuICAgIH0sIGNiKVxuICB9XG5cbiAgdmFyIGNvbGxlY3QgPSBleHBvcnRzLmNvbGxlY3QgPSBleHBvcnRzLndyaXRlQXJyYXkgPVxuICBmdW5jdGlvbiAoY2IpIHtcbiAgICByZXR1cm4gcmVkdWNlKGZ1bmN0aW9uIChhcnIsIGl0ZW0pIHtcbiAgICAgIGFyci5wdXNoKGl0ZW0pXG4gICAgICByZXR1cm4gYXJyXG4gICAgfSwgW10sIGNiKVxuICB9XG5cbiAgcmV0dXJuIGV4cG9ydHNcbn1cbiIsImV4cG9ydHMuaWQgPSBcbmZ1bmN0aW9uIChpdGVtKSB7XG4gIHJldHVybiBpdGVtXG59XG5cbmV4cG9ydHMucHJvcCA9IFxuZnVuY3Rpb24gKG1hcCkgeyAgXG4gIGlmKCdzdHJpbmcnID09IHR5cGVvZiBtYXApIHtcbiAgICB2YXIga2V5ID0gbWFwXG4gICAgcmV0dXJuIGZ1bmN0aW9uIChkYXRhKSB7IHJldHVybiBkYXRhW2tleV0gfVxuICB9XG4gIHJldHVybiBtYXBcbn1cblxuZXhwb3J0cy50ZXN0ZXIgPSBmdW5jdGlvbiAodGVzdCkge1xuICBpZighdGVzdCkgcmV0dXJuIGV4cG9ydHMuaWRcbiAgaWYoJ29iamVjdCcgPT09IHR5cGVvZiB0ZXN0XG4gICAgJiYgJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIHRlc3QudGVzdClcbiAgICAgIHJldHVybiB0ZXN0LnRlc3QuYmluZCh0ZXN0KVxuICByZXR1cm4gZXhwb3J0cy5wcm9wKHRlc3QpIHx8IGV4cG9ydHMuaWRcbn1cblxuZXhwb3J0cy5hZGRQaXBlID0gYWRkUGlwZVxuXG5mdW5jdGlvbiBhZGRQaXBlKHJlYWQpIHtcbiAgaWYoJ2Z1bmN0aW9uJyAhPT0gdHlwZW9mIHJlYWQpXG4gICAgcmV0dXJuIHJlYWRcblxuICByZWFkLnBpcGUgPSByZWFkLnBpcGUgfHwgZnVuY3Rpb24gKHJlYWRlcikge1xuICAgIGlmKCdmdW5jdGlvbicgIT0gdHlwZW9mIHJlYWRlcilcbiAgICAgIHRocm93IG5ldyBFcnJvcignbXVzdCBwaXBlIHRvIHJlYWRlcicpXG4gICAgcmV0dXJuIGFkZFBpcGUocmVhZGVyKHJlYWQpKVxuICB9XG4gIHJlYWQudHlwZSA9ICdTb3VyY2UnXG4gIHJldHVybiByZWFkXG59XG5cbnZhciBTb3VyY2UgPVxuZXhwb3J0cy5Tb3VyY2UgPVxuZnVuY3Rpb24gU291cmNlIChjcmVhdGVSZWFkKSB7XG4gIGZ1bmN0aW9uIHMoKSB7XG4gICAgdmFyIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cylcbiAgICByZXR1cm4gYWRkUGlwZShjcmVhdGVSZWFkLmFwcGx5KG51bGwsIGFyZ3MpKVxuICB9XG4gIHMudHlwZSA9ICdTb3VyY2UnXG4gIHJldHVybiBzXG59XG5cblxudmFyIFRocm91Z2ggPVxuZXhwb3J0cy5UaHJvdWdoID0gXG5mdW5jdGlvbiAoY3JlYXRlUmVhZCkge1xuICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpXG4gICAgdmFyIHBpcGVkID0gW11cbiAgICBmdW5jdGlvbiByZWFkZXIgKHJlYWQpIHtcbiAgICAgIGFyZ3MudW5zaGlmdChyZWFkKVxuICAgICAgcmVhZCA9IGNyZWF0ZVJlYWQuYXBwbHkobnVsbCwgYXJncylcbiAgICAgIHdoaWxlKHBpcGVkLmxlbmd0aClcbiAgICAgICAgcmVhZCA9IHBpcGVkLnNoaWZ0KCkocmVhZClcbiAgICAgIHJldHVybiByZWFkXG4gICAgICAvL3BpcGVpbmcgdG8gZnJvbSB0aGlzIHJlYWRlciBzaG91bGQgY29tcG9zZS4uLlxuICAgIH1cbiAgICByZWFkZXIucGlwZSA9IGZ1bmN0aW9uIChyZWFkKSB7XG4gICAgICBwaXBlZC5wdXNoKHJlYWQpIFxuICAgICAgaWYocmVhZC50eXBlID09PSAnU291cmNlJylcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdjYW5ub3QgcGlwZSAnICsgcmVhZGVyLnR5cGUgKyAnIHRvIFNvdXJjZScpXG4gICAgICByZWFkZXIudHlwZSA9IHJlYWQudHlwZSA9PT0gJ1NpbmsnID8gJ1NpbmsnIDogJ1Rocm91Z2gnXG4gICAgICByZXR1cm4gcmVhZGVyXG4gICAgfVxuICAgIHJlYWRlci50eXBlID0gJ1Rocm91Z2gnXG4gICAgcmV0dXJuIHJlYWRlclxuICB9XG59XG5cbnZhciBTaW5rID1cbmV4cG9ydHMuU2luayA9IFxuZnVuY3Rpb24gU2luayhjcmVhdGVSZWFkZXIpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKVxuICAgIGlmKCFjcmVhdGVSZWFkZXIpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ211c3QgYmUgY3JlYXRlUmVhZGVyIGZ1bmN0aW9uJylcbiAgICBmdW5jdGlvbiBzIChyZWFkKSB7XG4gICAgICBhcmdzLnVuc2hpZnQocmVhZClcbiAgICAgIHJldHVybiBjcmVhdGVSZWFkZXIuYXBwbHkobnVsbCwgYXJncylcbiAgICB9XG4gICAgcy50eXBlID0gJ1NpbmsnXG4gICAgcmV0dXJuIHNcbiAgfVxufVxuXG5cbmV4cG9ydHMubWF5YmVTaW5rID0gXG5leHBvcnRzLm1heWJlRHJhaW4gPSBcbmZ1bmN0aW9uIChjcmVhdGVTaW5rLCBjYikge1xuICBpZighY2IpXG4gICAgcmV0dXJuIFRocm91Z2goZnVuY3Rpb24gKHJlYWQpIHtcbiAgICAgIHZhciBlbmRlZFxuICAgICAgcmV0dXJuIGZ1bmN0aW9uIChjbG9zZSwgY2IpIHtcbiAgICAgICAgaWYoY2xvc2UpIHJldHVybiByZWFkKGNsb3NlLCBjYilcbiAgICAgICAgaWYoZW5kZWQpIHJldHVybiBjYihlbmRlZClcblxuICAgICAgICBjcmVhdGVTaW5rKGZ1bmN0aW9uIChlcnIsIGRhdGEpIHtcbiAgICAgICAgICBlbmRlZCA9IGVyciB8fCB0cnVlXG4gICAgICAgICAgaWYoIWVycikgY2IobnVsbCwgZGF0YSlcbiAgICAgICAgICBlbHNlICAgICBjYihlbmRlZClcbiAgICAgICAgfSkgKHJlYWQpXG4gICAgICB9XG4gICAgfSkoKVxuXG4gIHJldHVybiBTaW5rKGZ1bmN0aW9uIChyZWFkKSB7XG4gICAgcmV0dXJuIGNyZWF0ZVNpbmsoY2IpIChyZWFkKVxuICB9KSgpXG59XG5cbiIsInZhciBkcmFpbiA9IGV4cG9ydHMuZHJhaW4gPSBmdW5jdGlvbiAocmVhZCwgb3AsIGRvbmUpIHtcblxuICA7KGZ1bmN0aW9uIG5leHQoKSB7XG4gICAgdmFyIGxvb3AgPSB0cnVlLCBjYmVkID0gZmFsc2VcbiAgICB3aGlsZShsb29wKSB7XG4gICAgICBjYmVkID0gZmFsc2VcbiAgICAgIHJlYWQobnVsbCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgICBjYmVkID0gdHJ1ZVxuICAgICAgICBpZihlbmQpIHtcbiAgICAgICAgICBsb29wID0gZmFsc2VcbiAgICAgICAgICBkb25lICYmIGRvbmUoZW5kID09PSB0cnVlID8gbnVsbCA6IGVuZClcbiAgICAgICAgfVxuICAgICAgICBlbHNlIGlmKG9wICYmIGZhbHNlID09PSBvcChkYXRhKSkge1xuICAgICAgICAgIGxvb3AgPSBmYWxzZVxuICAgICAgICAgIHJlYWQodHJ1ZSwgZG9uZSB8fCBmdW5jdGlvbiAoKSB7fSlcbiAgICAgICAgfVxuICAgICAgICBlbHNlIGlmKCFsb29wKXtcbiAgICAgICAgICBuZXh0KClcbiAgICAgICAgfVxuICAgICAgfSlcbiAgICAgIGlmKCFjYmVkKSB7XG4gICAgICAgIGxvb3AgPSBmYWxzZVxuICAgICAgICByZXR1cm5cbiAgICAgIH1cbiAgICB9XG4gIH0pKClcbn1cblxudmFyIG9uRW5kID0gZXhwb3J0cy5vbkVuZCA9IGZ1bmN0aW9uIChyZWFkLCBkb25lKSB7XG4gIHJldHVybiBkcmFpbihyZWFkLCBudWxsLCBkb25lKVxufVxuXG52YXIgbG9nID0gZXhwb3J0cy5sb2cgPSBmdW5jdGlvbiAocmVhZCwgZG9uZSkge1xuICByZXR1cm4gZHJhaW4ocmVhZCwgZnVuY3Rpb24gKGRhdGEpIHtcbiAgICBjb25zb2xlLmxvZyhkYXRhKVxuICB9LCBkb25lKVxufVxuXG4iLCJcbnZhciBrZXlzID0gZXhwb3J0cy5rZXlzID1cbmZ1bmN0aW9uIChvYmplY3QpIHtcbiAgcmV0dXJuIHZhbHVlcyhPYmplY3Qua2V5cyhvYmplY3QpKVxufVxuXG52YXIgb25jZSA9IGV4cG9ydHMub25jZSA9XG5mdW5jdGlvbiAodmFsdWUpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIChhYm9ydCwgY2IpIHtcbiAgICBpZihhYm9ydCkgcmV0dXJuIGNiKGFib3J0KVxuICAgIGlmKHZhbHVlICE9IG51bGwpIHtcbiAgICAgIHZhciBfdmFsdWUgPSB2YWx1ZTsgdmFsdWUgPSBudWxsXG4gICAgICBjYihudWxsLCBfdmFsdWUpXG4gICAgfSBlbHNlXG4gICAgICBjYih0cnVlKVxuICB9XG59XG5cbnZhciB2YWx1ZXMgPSBleHBvcnRzLnZhbHVlcyA9IGV4cG9ydHMucmVhZEFycmF5ID1cbmZ1bmN0aW9uIChhcnJheSkge1xuICBpZighQXJyYXkuaXNBcnJheShhcnJheSkpXG4gICAgYXJyYXkgPSBPYmplY3Qua2V5cyhhcnJheSkubWFwKGZ1bmN0aW9uIChrKSB7XG4gICAgICByZXR1cm4gYXJyYXlba11cbiAgICB9KVxuICB2YXIgaSA9IDBcbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoZW5kKVxuICAgICAgcmV0dXJuIGNiICYmIGNiKGVuZCkgIFxuICAgIGNiKGkgPj0gYXJyYXkubGVuZ3RoIHx8IG51bGwsIGFycmF5W2krK10pXG4gIH1cbn1cblxuXG52YXIgY291bnQgPSBleHBvcnRzLmNvdW50ID0gXG5mdW5jdGlvbiAobWF4KSB7XG4gIHZhciBpID0gMDsgbWF4ID0gbWF4IHx8IEluZmluaXR5XG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGlmKGVuZCkgcmV0dXJuIGNiICYmIGNiKGVuZClcbiAgICBpZihpID4gbWF4KVxuICAgICAgcmV0dXJuIGNiKHRydWUpXG4gICAgY2IobnVsbCwgaSsrKVxuICB9XG59XG5cbnZhciBpbmZpbml0ZSA9IGV4cG9ydHMuaW5maW5pdGUgPSBcbmZ1bmN0aW9uIChnZW5lcmF0ZSkge1xuICBnZW5lcmF0ZSA9IGdlbmVyYXRlIHx8IE1hdGgucmFuZG9tXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGlmKGVuZCkgcmV0dXJuIGNiICYmIGNiKGVuZClcbiAgICByZXR1cm4gY2IobnVsbCwgZ2VuZXJhdGUoKSlcbiAgfVxufVxuXG52YXIgZGVmZXIgPSBleHBvcnRzLmRlZmVyID0gZnVuY3Rpb24gKCkge1xuICB2YXIgX3JlYWQsIGNicyA9IFtdLCBfZW5kXG5cbiAgdmFyIHJlYWQgPSBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGlmKCFfcmVhZCkge1xuICAgICAgX2VuZCA9IGVuZFxuICAgICAgY2JzLnB1c2goY2IpXG4gICAgfSBcbiAgICBlbHNlIF9yZWFkKGVuZCwgY2IpXG4gIH1cbiAgcmVhZC5yZXNvbHZlID0gZnVuY3Rpb24gKHJlYWQpIHtcbiAgICBpZihfcmVhZCkgdGhyb3cgbmV3IEVycm9yKCdhbHJlYWR5IHJlc29sdmVkJylcbiAgICBfcmVhZCA9IHJlYWRcbiAgICBpZighX3JlYWQpIHRocm93IG5ldyBFcnJvcignbm8gcmVhZCBjYW5ub3QgcmVzb2x2ZSEnICsgX3JlYWQpXG4gICAgd2hpbGUoY2JzLmxlbmd0aClcbiAgICAgIF9yZWFkKF9lbmQsIGNicy5zaGlmdCgpKVxuICB9XG4gIHJlYWQuYWJvcnQgPSBmdW5jdGlvbihlcnIpIHtcbiAgICByZWFkLnJlc29sdmUoZnVuY3Rpb24gKF8sIGNiKSB7XG4gICAgICBjYihlcnIgfHwgdHJ1ZSlcbiAgICB9KVxuICB9XG4gIHJldHVybiByZWFkXG59XG5cbnZhciBlbXB0eSA9IGV4cG9ydHMuZW1wdHkgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoYWJvcnQsIGNiKSB7XG4gICAgY2IodHJ1ZSlcbiAgfVxufVxuXG52YXIgZGVwdGhGaXJzdCA9IGV4cG9ydHMuZGVwdGhGaXJzdCA9XG5mdW5jdGlvbiAoc3RhcnQsIGNyZWF0ZVN0cmVhbSkge1xuICB2YXIgcmVhZHMgPSBbXVxuXG4gIHJlYWRzLnVuc2hpZnQob25jZShzdGFydCkpXG5cbiAgcmV0dXJuIGZ1bmN0aW9uIG5leHQgKGVuZCwgY2IpIHtcbiAgICBpZighcmVhZHMubGVuZ3RoKVxuICAgICAgcmV0dXJuIGNiKHRydWUpXG4gICAgcmVhZHNbMF0oZW5kLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICBpZihlbmQpIHtcbiAgICAgICAgLy9pZiB0aGlzIHN0cmVhbSBoYXMgZW5kZWQsIGdvIHRvIHRoZSBuZXh0IHF1ZXVlXG4gICAgICAgIHJlYWRzLnNoaWZ0KClcbiAgICAgICAgcmV0dXJuIG5leHQobnVsbCwgY2IpXG4gICAgICB9XG4gICAgICByZWFkcy51bnNoaWZ0KGNyZWF0ZVN0cmVhbShkYXRhKSlcbiAgICAgIGNiKGVuZCwgZGF0YSlcbiAgICB9KVxuICB9XG59XG4vL3dpZHRoIGZpcnN0IGlzIGp1c3QgbGlrZSBkZXB0aCBmaXJzdCxcbi8vYnV0IHB1c2ggZWFjaCBuZXcgc3RyZWFtIG9udG8gdGhlIGVuZCBvZiB0aGUgcXVldWVcbnZhciB3aWR0aEZpcnN0ID0gZXhwb3J0cy53aWR0aEZpcnN0ID0gXG5mdW5jdGlvbiAoc3RhcnQsIGNyZWF0ZVN0cmVhbSkge1xuICB2YXIgcmVhZHMgPSBbXVxuXG4gIHJlYWRzLnB1c2gob25jZShzdGFydCkpXG5cbiAgcmV0dXJuIGZ1bmN0aW9uIG5leHQgKGVuZCwgY2IpIHtcbiAgICBpZighcmVhZHMubGVuZ3RoKVxuICAgICAgcmV0dXJuIGNiKHRydWUpXG4gICAgcmVhZHNbMF0oZW5kLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICBpZihlbmQpIHtcbiAgICAgICAgcmVhZHMuc2hpZnQoKVxuICAgICAgICByZXR1cm4gbmV4dChudWxsLCBjYilcbiAgICAgIH1cbiAgICAgIHJlYWRzLnB1c2goY3JlYXRlU3RyZWFtKGRhdGEpKVxuICAgICAgY2IoZW5kLCBkYXRhKVxuICAgIH0pXG4gIH1cbn1cblxuLy90aGlzIGNhbWUgb3V0IGRpZmZlcmVudCB0byB0aGUgZmlyc3QgKHN0cm0pXG4vL2F0dGVtcHQgYXQgbGVhZkZpcnN0LCBidXQgaXQncyBzdGlsbCBhIHZhbGlkXG4vL3RvcG9sb2dpY2FsIHNvcnQuXG52YXIgbGVhZkZpcnN0ID0gZXhwb3J0cy5sZWFmRmlyc3QgPSBcbmZ1bmN0aW9uIChzdGFydCwgY3JlYXRlU3RyZWFtKSB7XG4gIHZhciByZWFkcyA9IFtdXG4gIHZhciBvdXRwdXQgPSBbXVxuICByZWFkcy5wdXNoKG9uY2Uoc3RhcnQpKVxuICBcbiAgcmV0dXJuIGZ1bmN0aW9uIG5leHQgKGVuZCwgY2IpIHtcbiAgICByZWFkc1swXShlbmQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZCkge1xuICAgICAgICByZWFkcy5zaGlmdCgpXG4gICAgICAgIGlmKCFvdXRwdXQubGVuZ3RoKVxuICAgICAgICAgIHJldHVybiBjYih0cnVlKVxuICAgICAgICByZXR1cm4gY2IobnVsbCwgb3V0cHV0LnNoaWZ0KCkpXG4gICAgICB9XG4gICAgICByZWFkcy51bnNoaWZ0KGNyZWF0ZVN0cmVhbShkYXRhKSlcbiAgICAgIG91dHB1dC51bnNoaWZ0KGRhdGEpXG4gICAgICBuZXh0KG51bGwsIGNiKVxuICAgIH0pXG4gIH1cbn1cblxuIiwidmFyIHUgICAgICA9IHJlcXVpcmUoJ3B1bGwtY29yZScpXG52YXIgc291cmNlcyA9IHJlcXVpcmUoJy4vc291cmNlcycpXG52YXIgc2lua3MgPSByZXF1aXJlKCcuL3NpbmtzJylcblxudmFyIHByb3AgICA9IHUucHJvcFxudmFyIGlkICAgICA9IHUuaWRcbnZhciB0ZXN0ZXIgPSB1LnRlc3RlclxuXG52YXIgbWFwID0gZXhwb3J0cy5tYXAgPSBcbmZ1bmN0aW9uIChyZWFkLCBtYXApIHtcbiAgbWFwID0gcHJvcChtYXApIHx8IGlkXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIHJlYWQoZW5kLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICB2YXIgZGF0YSA9ICFlbmQgPyBtYXAoZGF0YSkgOiBudWxsXG4gICAgICBjYihlbmQsIGRhdGEpXG4gICAgfSlcbiAgfVxufVxuXG52YXIgYXN5bmNNYXAgPSBleHBvcnRzLmFzeW5jTWFwID1cbmZ1bmN0aW9uIChyZWFkLCBtYXApIHtcbiAgaWYoIW1hcCkgcmV0dXJuIHJlYWRcbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoZW5kKSByZXR1cm4gcmVhZChlbmQsIGNiKSAvL2Fib3J0XG4gICAgcmVhZChudWxsLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICBpZihlbmQpIHJldHVybiBjYihlbmQsIGRhdGEpXG4gICAgICBtYXAoZGF0YSwgY2IpXG4gICAgfSlcbiAgfVxufVxuXG52YXIgcGFyYU1hcCA9IGV4cG9ydHMucGFyYU1hcCA9XG5mdW5jdGlvbiAocmVhZCwgbWFwLCB3aWR0aCkge1xuICBpZighbWFwKSByZXR1cm4gcmVhZFxuICB2YXIgZW5kZWQgPSBmYWxzZSwgcXVldWUgPSBbXSwgX2NiXG5cbiAgZnVuY3Rpb24gZHJhaW4gKCkge1xuICAgIGlmKCFfY2IpIHJldHVyblxuICAgIHZhciBjYiA9IF9jYlxuICAgIF9jYiA9IG51bGxcbiAgICBpZihxdWV1ZS5sZW5ndGgpXG4gICAgICByZXR1cm4gY2IobnVsbCwgcXVldWUuc2hpZnQoKSlcbiAgICBlbHNlIGlmKGVuZGVkICYmICFuKVxuICAgICAgcmV0dXJuIGNiKGVuZGVkKVxuICAgIF9jYiA9IGNiXG4gIH1cblxuICBmdW5jdGlvbiBwdWxsICgpIHtcbiAgICByZWFkKG51bGwsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZCkge1xuICAgICAgICBlbmRlZCA9IGVuZFxuICAgICAgICByZXR1cm4gZHJhaW4oKVxuICAgICAgfVxuICAgICAgbisrXG4gICAgICBtYXAoZGF0YSwgZnVuY3Rpb24gKGVyciwgZGF0YSkge1xuICAgICAgICBuLS1cblxuICAgICAgICBxdWV1ZS5wdXNoKGRhdGEpXG4gICAgICAgIGRyYWluKClcbiAgICAgIH0pXG5cbiAgICAgIGlmKG4gPCB3aWR0aCAmJiAhZW5kZWQpXG4gICAgICAgIHB1bGwoKVxuICAgIH0pXG4gIH1cblxuICB2YXIgbiA9IDBcbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoZW5kKSByZXR1cm4gcmVhZChlbmQsIGNiKSAvL2Fib3J0XG4gICAgLy9jb250aW51ZSB0byByZWFkIHdoaWxlIHRoZXJlIGFyZSBsZXNzIHRoYW4gMyBtYXBzIGluIGZsaWdodFxuICAgIF9jYiA9IGNiXG4gICAgaWYocXVldWUubGVuZ3RoIHx8IGVuZGVkKVxuICAgICAgcHVsbCgpLCBkcmFpbigpXG4gICAgZWxzZSBwdWxsKClcbiAgfVxuICByZXR1cm4gaGlnaFdhdGVyTWFyayhhc3luY01hcChyZWFkLCBtYXApLCB3aWR0aClcbn1cblxudmFyIGZpbHRlciA9IGV4cG9ydHMuZmlsdGVyID1cbmZ1bmN0aW9uIChyZWFkLCB0ZXN0KSB7XG4gIC8vcmVnZXhwXG4gIHRlc3QgPSB0ZXN0ZXIodGVzdClcbiAgcmV0dXJuIGZ1bmN0aW9uIG5leHQgKGVuZCwgY2IpIHtcbiAgICByZWFkKGVuZCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoIWVuZCAmJiAhdGVzdChkYXRhKSlcbiAgICAgICAgcmV0dXJuIG5leHQoZW5kLCBjYilcbiAgICAgIGNiKGVuZCwgZGF0YSlcbiAgICB9KVxuICB9XG59XG5cbnZhciBmaWx0ZXJOb3QgPSBleHBvcnRzLmZpbHRlck5vdCA9XG5mdW5jdGlvbiAocmVhZCwgdGVzdCkge1xuICB0ZXN0ID0gdGVzdGVyKHRlc3QpXG4gIHJldHVybiBmaWx0ZXIocmVhZCwgZnVuY3Rpb24gKGUpIHtcbiAgICByZXR1cm4gIXRlc3QoZSlcbiAgfSlcbn1cblxudmFyIHRocm91Z2ggPSBleHBvcnRzLnRocm91Z2ggPSBcbmZ1bmN0aW9uIChyZWFkLCBvcCwgb25FbmQpIHtcbiAgdmFyIGEgPSBmYWxzZVxuICBmdW5jdGlvbiBvbmNlIChhYm9ydCkge1xuICAgIGlmKGEgfHwgIW9uRW5kKSByZXR1cm5cbiAgICBhID0gdHJ1ZVxuICAgIG9uRW5kKGFib3J0ID09PSB0cnVlID8gbnVsbCA6IGFib3J0KVxuICB9XG5cbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoZW5kKSBvbmNlKGVuZClcbiAgICByZXR1cm4gcmVhZChlbmQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKCFlbmQpIG9wICYmIG9wKGRhdGEpXG4gICAgICBlbHNlIG9uY2UoZW5kKVxuICAgICAgY2IoZW5kLCBkYXRhKVxuICAgIH0pXG4gIH1cbn1cblxudmFyIHRha2UgPSBleHBvcnRzLnRha2UgPVxuZnVuY3Rpb24gKHJlYWQsIHRlc3QpIHtcbiAgdmFyIGVuZGVkID0gZmFsc2VcbiAgaWYoJ251bWJlcicgPT09IHR5cGVvZiB0ZXN0KSB7XG4gICAgdmFyIG4gPSB0ZXN0OyB0ZXN0ID0gZnVuY3Rpb24gKCkge1xuICAgICAgcmV0dXJuIG4gLS1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmRlZCkgcmV0dXJuIGNiKGVuZGVkKVxuICAgIGlmKGVuZGVkID0gZW5kKSByZXR1cm4gcmVhZChlbmRlZCwgY2IpXG5cbiAgICByZWFkKG51bGwsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZGVkID0gZW5kZWQgfHwgZW5kKSByZXR1cm4gY2IoZW5kZWQpXG4gICAgICBpZighdGVzdChkYXRhKSkge1xuICAgICAgICBlbmRlZCA9IHRydWVcbiAgICAgICAgcmVhZCh0cnVlLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICAgICAgY2IoZW5kZWQsIGRhdGEpXG4gICAgICAgIH0pXG4gICAgICB9XG4gICAgICBlbHNlXG4gICAgICAgIGNiKG51bGwsIGRhdGEpXG4gICAgfSlcbiAgfVxufVxuXG52YXIgdW5pcXVlID0gZXhwb3J0cy51bmlxdWUgPSBmdW5jdGlvbiAocmVhZCwgZmllbGQsIGludmVydCkge1xuICBmaWVsZCA9IHByb3AoZmllbGQpIHx8IGlkXG4gIHZhciBzZWVuID0ge31cbiAgcmV0dXJuIGZpbHRlcihyZWFkLCBmdW5jdGlvbiAoZGF0YSkge1xuICAgIHZhciBrZXkgPSBmaWVsZChkYXRhKVxuICAgIGlmKHNlZW5ba2V5XSkgcmV0dXJuICEhaW52ZXJ0IC8vZmFsc2UsIGJ5IGRlZmF1bHRcbiAgICBlbHNlIHNlZW5ba2V5XSA9IHRydWVcbiAgICByZXR1cm4gIWludmVydCAvL3RydWUgYnkgZGVmYXVsdFxuICB9KVxufVxuXG52YXIgbm9uVW5pcXVlID0gZXhwb3J0cy5ub25VbmlxdWUgPSBmdW5jdGlvbiAocmVhZCwgZmllbGQpIHtcbiAgcmV0dXJuIHVuaXF1ZShyZWFkLCBmaWVsZCwgdHJ1ZSlcbn1cblxudmFyIGdyb3VwID0gZXhwb3J0cy5ncm91cCA9XG5mdW5jdGlvbiAocmVhZCwgc2l6ZSkge1xuICB2YXIgZW5kZWQ7IHNpemUgPSBzaXplIHx8IDVcbiAgdmFyIHF1ZXVlID0gW11cblxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICAvL3RoaXMgbWVhbnMgdGhhdCB0aGUgdXBzdHJlYW0gaXMgc2VuZGluZyBhbiBlcnJvci5cbiAgICBpZihlbmQpIHJldHVybiByZWFkKGVuZGVkID0gZW5kLCBjYilcbiAgICAvL3RoaXMgbWVhbnMgdGhhdCB3ZSByZWFkIGFuIGVuZCBiZWZvcmUuXG4gICAgaWYoZW5kZWQpIHJldHVybiBjYihlbmRlZClcblxuICAgIHJlYWQobnVsbCwgZnVuY3Rpb24gbmV4dChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZGVkID0gZW5kZWQgfHwgZW5kKSB7XG4gICAgICAgIGlmKCFxdWV1ZS5sZW5ndGgpXG4gICAgICAgICAgcmV0dXJuIGNiKGVuZGVkKVxuXG4gICAgICAgIHZhciBfcXVldWUgPSBxdWV1ZTsgcXVldWUgPSBbXVxuICAgICAgICByZXR1cm4gY2IobnVsbCwgX3F1ZXVlKVxuICAgICAgfVxuICAgICAgcXVldWUucHVzaChkYXRhKVxuICAgICAgaWYocXVldWUubGVuZ3RoIDwgc2l6ZSlcbiAgICAgICAgcmV0dXJuIHJlYWQobnVsbCwgbmV4dClcblxuICAgICAgdmFyIF9xdWV1ZSA9IHF1ZXVlOyBxdWV1ZSA9IFtdXG4gICAgICBjYihudWxsLCBfcXVldWUpXG4gICAgfSlcbiAgfVxufVxuXG52YXIgZmxhdHRlbiA9IGV4cG9ydHMuZmxhdHRlbiA9IGZ1bmN0aW9uIChyZWFkKSB7XG4gIHZhciBfcmVhZFxuICByZXR1cm4gZnVuY3Rpb24gKGFib3J0LCBjYikge1xuICAgIGlmKF9yZWFkKSBuZXh0Q2h1bmsoKVxuICAgIGVsc2UgICAgICBuZXh0U3RyZWFtKClcblxuICAgIGZ1bmN0aW9uIG5leHRDaHVuayAoKSB7XG4gICAgICBfcmVhZChudWxsLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICAgIGlmKGVuZCkgbmV4dFN0cmVhbSgpXG4gICAgICAgIGVsc2UgICAgY2IobnVsbCwgZGF0YSlcbiAgICAgIH0pXG4gICAgfVxuICAgIGZ1bmN0aW9uIG5leHRTdHJlYW0gKCkge1xuICAgICAgcmVhZChudWxsLCBmdW5jdGlvbiAoZW5kLCBzdHJlYW0pIHtcbiAgICAgICAgaWYoZW5kKVxuICAgICAgICAgIHJldHVybiBjYihlbmQpXG4gICAgICAgIGlmKEFycmF5LmlzQXJyYXkoc3RyZWFtKSlcbiAgICAgICAgICBzdHJlYW0gPSBzb3VyY2VzLnZhbHVlcyhzdHJlYW0pXG4gICAgICAgIGVsc2UgaWYoJ2Z1bmN0aW9uJyAhPSB0eXBlb2Ygc3RyZWFtKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcignZXhwZWN0ZWQgc3RyZWFtIG9mIHN0cmVhbXMnKVxuICAgICAgICBcbiAgICAgICAgX3JlYWQgPSBzdHJlYW1cbiAgICAgICAgbmV4dENodW5rKClcbiAgICAgIH0pXG4gICAgfVxuICB9XG59XG5cbnZhciBwcmVwZW5kID1cbmV4cG9ydHMucHJlcGVuZCA9XG5mdW5jdGlvbiAocmVhZCwgaGVhZCkge1xuXG4gIHJldHVybiBmdW5jdGlvbiAoYWJvcnQsIGNiKSB7XG4gICAgaWYoaGVhZCAhPT0gbnVsbCkge1xuICAgICAgaWYoYWJvcnQpXG4gICAgICAgIHJldHVybiByZWFkKGFib3J0LCBjYilcbiAgICAgIHZhciBfaGVhZCA9IGhlYWRcbiAgICAgIGhlYWQgPSBudWxsXG4gICAgICBjYihudWxsLCBfaGVhZClcbiAgICB9IGVsc2Uge1xuICAgICAgcmVhZChhYm9ydCwgY2IpXG4gICAgfVxuICB9XG5cbn1cblxuLy92YXIgZHJhaW5JZiA9IGV4cG9ydHMuZHJhaW5JZiA9IGZ1bmN0aW9uIChvcCwgZG9uZSkge1xuLy8gIHNpbmtzLmRyYWluKFxuLy99XG5cbnZhciBfcmVkdWNlID0gZXhwb3J0cy5fcmVkdWNlID0gZnVuY3Rpb24gKHJlYWQsIHJlZHVjZSwgaW5pdGlhbCkge1xuICByZXR1cm4gZnVuY3Rpb24gKGNsb3NlLCBjYikge1xuICAgIGlmKGNsb3NlKSByZXR1cm4gcmVhZChjbG9zZSwgY2IpXG4gICAgaWYoZW5kZWQpIHJldHVybiBjYihlbmRlZClcblxuICAgIHNpbmtzLmRyYWluKGZ1bmN0aW9uIChpdGVtKSB7XG4gICAgICBpbml0aWFsID0gcmVkdWNlKGluaXRpYWwsIGl0ZW0pXG4gICAgfSwgZnVuY3Rpb24gKGVyciwgZGF0YSkge1xuICAgICAgZW5kZWQgPSBlcnIgfHwgdHJ1ZVxuICAgICAgaWYoIWVycikgY2IobnVsbCwgaW5pdGlhbClcbiAgICAgIGVsc2UgICAgIGNiKGVuZGVkKVxuICAgIH0pXG4gICAgKHJlYWQpXG4gIH1cbn1cblxudmFyIG5leHRUaWNrID0gcHJvY2Vzcy5uZXh0VGlja1xuXG52YXIgaGlnaFdhdGVyTWFyayA9IGV4cG9ydHMuaGlnaFdhdGVyTWFyayA9IFxuZnVuY3Rpb24gKHJlYWQsIGhpZ2hXYXRlck1hcmspIHtcbiAgdmFyIGJ1ZmZlciA9IFtdLCB3YWl0aW5nID0gW10sIGVuZGVkLCByZWFkaW5nID0gZmFsc2VcbiAgaGlnaFdhdGVyTWFyayA9IGhpZ2hXYXRlck1hcmsgfHwgMTBcblxuICBmdW5jdGlvbiByZWFkQWhlYWQgKCkge1xuICAgIHdoaWxlKHdhaXRpbmcubGVuZ3RoICYmIChidWZmZXIubGVuZ3RoIHx8IGVuZGVkKSlcbiAgICAgIHdhaXRpbmcuc2hpZnQoKShlbmRlZCwgZW5kZWQgPyBudWxsIDogYnVmZmVyLnNoaWZ0KCkpXG4gIH1cblxuICBmdW5jdGlvbiBuZXh0ICgpIHtcbiAgICBpZihlbmRlZCB8fCByZWFkaW5nIHx8IGJ1ZmZlci5sZW5ndGggPj0gaGlnaFdhdGVyTWFyaylcbiAgICAgIHJldHVyblxuICAgIHJlYWRpbmcgPSB0cnVlXG4gICAgcmV0dXJuIHJlYWQoZW5kZWQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIHJlYWRpbmcgPSBmYWxzZVxuICAgICAgZW5kZWQgPSBlbmRlZCB8fCBlbmRcbiAgICAgIGlmKGRhdGEgIT0gbnVsbCkgYnVmZmVyLnB1c2goZGF0YSlcbiAgICAgIFxuICAgICAgbmV4dCgpOyByZWFkQWhlYWQoKVxuICAgIH0pXG4gIH1cblxuICBuZXh0VGljayhuZXh0KVxuXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGVuZGVkID0gZW5kZWQgfHwgZW5kXG4gICAgd2FpdGluZy5wdXNoKGNiKVxuXG4gICAgbmV4dCgpOyByZWFkQWhlYWQoKVxuICB9XG59XG5cblxuXG4iLCJ2YXIgc291cmNlcyAgPSByZXF1aXJlKCcuL3NvdXJjZXMnKVxudmFyIHNpbmtzICAgID0gcmVxdWlyZSgnLi9zaW5rcycpXG52YXIgdGhyb3VnaHMgPSByZXF1aXJlKCcuL3Rocm91Z2hzJylcbnZhciB1ICAgICAgICA9IHJlcXVpcmUoJ3B1bGwtY29yZScpXG5cbmZ1bmN0aW9uIGlzRnVuY3Rpb24gKGZ1bikge1xuICByZXR1cm4gJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIGZ1blxufVxuXG5mdW5jdGlvbiBpc1JlYWRlciAoZnVuKSB7XG4gIHJldHVybiBmdW4gJiYgKGZ1bi50eXBlID09PSBcIlRocm91Z2hcIiB8fCBmdW4ubGVuZ3RoID09PSAxKVxufVxudmFyIGV4cG9ydHMgPSBtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIHB1bGwgKCkge1xuICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKVxuXG4gIGlmKGlzUmVhZGVyKGFyZ3NbMF0pKVxuICAgIHJldHVybiBmdW5jdGlvbiAocmVhZCkge1xuICAgICAgYXJncy51bnNoaWZ0KHJlYWQpXG4gICAgICByZXR1cm4gcHVsbC5hcHBseShudWxsLCBhcmdzKVxuICAgIH1cblxuICB2YXIgcmVhZCA9IGFyZ3Muc2hpZnQoKVxuXG4gIC8vaWYgdGhlIGZpcnN0IGZ1bmN0aW9uIGlzIGEgZHVwbGV4IHN0cmVhbSxcbiAgLy9waXBlIGZyb20gdGhlIHNvdXJjZS5cbiAgaWYoaXNGdW5jdGlvbihyZWFkLnNvdXJjZSkpXG4gICAgcmVhZCA9IHJlYWQuc291cmNlXG5cbiAgZnVuY3Rpb24gbmV4dCAoKSB7XG4gICAgdmFyIHMgPSBhcmdzLnNoaWZ0KClcblxuICAgIGlmKG51bGwgPT0gcylcbiAgICAgIHJldHVybiBuZXh0KClcblxuICAgIGlmKGlzRnVuY3Rpb24ocykpIHJldHVybiBzXG5cbiAgICByZXR1cm4gZnVuY3Rpb24gKHJlYWQpIHtcbiAgICAgIHMuc2luayhyZWFkKVxuICAgICAgLy90aGlzIHN1cHBvcnRzIHBpcGVpbmcgdGhyb3VnaCBhIGR1cGxleCBzdHJlYW1cbiAgICAgIC8vcHVsbChhLCBiLCBhKSBcInRlbGVwaG9uZSBzdHlsZVwiLlxuICAgICAgLy9pZiB0aGlzIHN0cmVhbSBpcyBpbiB0aGUgYSAoZmlyc3QgJiBsYXN0IHBvc2l0aW9uKVxuICAgICAgLy9zLnNvdXJjZSB3aWxsIGhhdmUgYWxyZWFkeSBiZWVuIHVzZWQsIGJ1dCB0aGlzIHNob3VsZCBuZXZlciBiZSBjYWxsZWRcbiAgICAgIC8vc28gdGhhdCBpcyBva2F5LlxuICAgICAgcmV0dXJuIHMuc291cmNlXG4gICAgfVxuICB9XG5cbiAgd2hpbGUoYXJncy5sZW5ndGgpXG4gICAgcmVhZCA9IG5leHQoKSAocmVhZClcblxuICByZXR1cm4gcmVhZFxufVxuXG5cbmZvcih2YXIgayBpbiBzb3VyY2VzKVxuICBleHBvcnRzW2tdID0gdS5Tb3VyY2Uoc291cmNlc1trXSlcblxuZm9yKHZhciBrIGluIHRocm91Z2hzKVxuICBleHBvcnRzW2tdID0gdS5UaHJvdWdoKHRocm91Z2hzW2tdKVxuXG5mb3IodmFyIGsgaW4gc2lua3MpXG4gIGV4cG9ydHNba10gPSB1LlNpbmsoc2lua3Nba10pXG5cbnZhciBtYXliZSA9IHJlcXVpcmUoJy4vbWF5YmUnKShleHBvcnRzKVxuXG5mb3IodmFyIGsgaW4gbWF5YmUpXG4gIGV4cG9ydHNba10gPSBtYXliZVtrXVxuXG5leHBvcnRzLkR1cGxleCAgPSBcbmV4cG9ydHMuVGhyb3VnaCA9IGV4cG9ydHMucGlwZWFibGUgICAgICAgPSB1LlRocm91Z2hcbmV4cG9ydHMuU291cmNlICA9IGV4cG9ydHMucGlwZWFibGVTb3VyY2UgPSB1LlNvdXJjZVxuZXhwb3J0cy5TaW5rICAgID0gZXhwb3J0cy5waXBlYWJsZVNpbmsgICA9IHUuU2lua1xuXG5cbiIsInZhciB1ID0gcmVxdWlyZSgncHVsbC1jb3JlJylcbnZhciBwcm9wID0gdS5wcm9wXG52YXIgaWQgICA9IHUuaWRcbnZhciBtYXliZVNpbmsgPSB1Lm1heWJlU2lua1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChwdWxsKSB7XG5cbiAgdmFyIGV4cG9ydHMgPSB7fVxuICB2YXIgZHJhaW4gPSBwdWxsLmRyYWluXG5cbiAgdmFyIGZpbmQgPVxuICBleHBvcnRzLmZpbmQgPSBmdW5jdGlvbiAodGVzdCwgY2IpIHtcbiAgICByZXR1cm4gbWF5YmVTaW5rKGZ1bmN0aW9uIChjYikge1xuICAgICAgdmFyIGVuZGVkID0gZmFsc2VcbiAgICAgIGlmKCFjYilcbiAgICAgICAgY2IgPSB0ZXN0LCB0ZXN0ID0gaWRcbiAgICAgIGVsc2VcbiAgICAgICAgdGVzdCA9IHByb3AodGVzdCkgfHwgaWRcblxuICAgICAgcmV0dXJuIGRyYWluKGZ1bmN0aW9uIChkYXRhKSB7XG4gICAgICAgIGlmKHRlc3QoZGF0YSkpIHtcbiAgICAgICAgICBlbmRlZCA9IHRydWVcbiAgICAgICAgICBjYihudWxsLCBkYXRhKVxuICAgICAgICByZXR1cm4gZmFsc2VcbiAgICAgICAgfVxuICAgICAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICBpZihlbmRlZCkgcmV0dXJuIC8vYWxyZWFkeSBjYWxsZWQgYmFja1xuICAgICAgICBjYihlcnIgPT09IHRydWUgPyBudWxsIDogZXJyLCBudWxsKVxuICAgICAgfSlcblxuICAgIH0sIGNiKVxuICB9XG5cbiAgdmFyIHJlZHVjZSA9IGV4cG9ydHMucmVkdWNlID1cbiAgZnVuY3Rpb24gKHJlZHVjZSwgYWNjLCBjYikge1xuXG4gICAgcmV0dXJuIG1heWJlU2luayhmdW5jdGlvbiAoY2IpIHtcbiAgICAgIHJldHVybiBkcmFpbihmdW5jdGlvbiAoZGF0YSkge1xuICAgICAgICBhY2MgPSByZWR1Y2UoYWNjLCBkYXRhKVxuICAgICAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICBjYihlcnIsIGFjYylcbiAgICAgIH0pXG5cbiAgICB9LCBjYilcbiAgfVxuXG4gIHZhciBjb2xsZWN0ID0gZXhwb3J0cy5jb2xsZWN0ID0gZXhwb3J0cy53cml0ZUFycmF5ID1cbiAgZnVuY3Rpb24gKGNiKSB7XG4gICAgcmV0dXJuIHJlZHVjZShmdW5jdGlvbiAoYXJyLCBpdGVtKSB7XG4gICAgICBhcnIucHVzaChpdGVtKVxuICAgICAgcmV0dXJuIGFyclxuICAgIH0sIFtdLCBjYilcbiAgfVxuXG4gIHZhciBjb25jYXQgPSBleHBvcnRzLmNvbmNhdCA9XG4gIGZ1bmN0aW9uIChjYikge1xuICAgIHJldHVybiByZWR1Y2UoZnVuY3Rpb24gKGEsIGIpIHtcbiAgICAgIHJldHVybiBhICsgYlxuICAgIH0sICcnLCBjYilcbiAgfVxuXG4gIHJldHVybiBleHBvcnRzXG59XG4iLCJ2YXIgZHJhaW4gPSBleHBvcnRzLmRyYWluID0gZnVuY3Rpb24gKHJlYWQsIG9wLCBkb25lKSB7XG5cbiAgOyhmdW5jdGlvbiBuZXh0KCkge1xuICAgIHZhciBsb29wID0gdHJ1ZSwgY2JlZCA9IGZhbHNlXG4gICAgd2hpbGUobG9vcCkge1xuICAgICAgY2JlZCA9IGZhbHNlXG4gICAgICByZWFkKG51bGwsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgICAgY2JlZCA9IHRydWVcbiAgICAgICAgaWYoZW5kKSB7XG4gICAgICAgICAgbG9vcCA9IGZhbHNlXG4gICAgICAgICAgaWYoZG9uZSkgZG9uZShlbmQgPT09IHRydWUgPyBudWxsIDogZW5kKVxuICAgICAgICAgIGVsc2UgaWYoZW5kICYmIGVuZCAhPT0gdHJ1ZSlcbiAgICAgICAgICAgIHRocm93IGVuZFxuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYob3AgJiYgZmFsc2UgPT09IG9wKGRhdGEpKSB7XG4gICAgICAgICAgbG9vcCA9IGZhbHNlXG4gICAgICAgICAgcmVhZCh0cnVlLCBkb25lIHx8IGZ1bmN0aW9uICgpIHt9KVxuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYoIWxvb3Ape1xuICAgICAgICAgIG5leHQoKVxuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgaWYoIWNiZWQpIHtcbiAgICAgICAgbG9vcCA9IGZhbHNlXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuICAgIH1cbiAgfSkoKVxufVxuXG52YXIgb25FbmQgPSBleHBvcnRzLm9uRW5kID0gZnVuY3Rpb24gKHJlYWQsIGRvbmUpIHtcbiAgcmV0dXJuIGRyYWluKHJlYWQsIG51bGwsIGRvbmUpXG59XG5cbnZhciBsb2cgPSBleHBvcnRzLmxvZyA9IGZ1bmN0aW9uIChyZWFkLCBkb25lKSB7XG4gIHJldHVybiBkcmFpbihyZWFkLCBmdW5jdGlvbiAoZGF0YSkge1xuICAgIGNvbnNvbGUubG9nKGRhdGEpXG4gIH0sIGRvbmUpXG59XG5cbiIsIlxudmFyIGtleXMgPSBleHBvcnRzLmtleXMgPVxuZnVuY3Rpb24gKG9iamVjdCkge1xuICByZXR1cm4gdmFsdWVzKE9iamVjdC5rZXlzKG9iamVjdCkpXG59XG5cbnZhciBvbmNlID0gZXhwb3J0cy5vbmNlID1cbmZ1bmN0aW9uICh2YWx1ZSkge1xuICByZXR1cm4gZnVuY3Rpb24gKGFib3J0LCBjYikge1xuICAgIGlmKGFib3J0KSByZXR1cm4gY2IoYWJvcnQpXG4gICAgaWYodmFsdWUgIT0gbnVsbCkge1xuICAgICAgdmFyIF92YWx1ZSA9IHZhbHVlOyB2YWx1ZSA9IG51bGxcbiAgICAgIGNiKG51bGwsIF92YWx1ZSlcbiAgICB9IGVsc2VcbiAgICAgIGNiKHRydWUpXG4gIH1cbn1cblxudmFyIHZhbHVlcyA9IGV4cG9ydHMudmFsdWVzID0gZXhwb3J0cy5yZWFkQXJyYXkgPVxuZnVuY3Rpb24gKGFycmF5KSB7XG4gIGlmKCFBcnJheS5pc0FycmF5KGFycmF5KSlcbiAgICBhcnJheSA9IE9iamVjdC5rZXlzKGFycmF5KS5tYXAoZnVuY3Rpb24gKGspIHtcbiAgICAgIHJldHVybiBhcnJheVtrXVxuICAgIH0pXG4gIHZhciBpID0gMFxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmQpXG4gICAgICByZXR1cm4gY2IgJiYgY2IoZW5kKVxuICAgIGNiKGkgPj0gYXJyYXkubGVuZ3RoIHx8IG51bGwsIGFycmF5W2krK10pXG4gIH1cbn1cblxuXG52YXIgY291bnQgPSBleHBvcnRzLmNvdW50ID1cbmZ1bmN0aW9uIChtYXgpIHtcbiAgdmFyIGkgPSAwOyBtYXggPSBtYXggfHwgSW5maW5pdHlcbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoZW5kKSByZXR1cm4gY2IgJiYgY2IoZW5kKVxuICAgIGlmKGkgPiBtYXgpXG4gICAgICByZXR1cm4gY2IodHJ1ZSlcbiAgICBjYihudWxsLCBpKyspXG4gIH1cbn1cblxudmFyIGluZmluaXRlID0gZXhwb3J0cy5pbmZpbml0ZSA9XG5mdW5jdGlvbiAoZ2VuZXJhdGUpIHtcbiAgZ2VuZXJhdGUgPSBnZW5lcmF0ZSB8fCBNYXRoLnJhbmRvbVxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmQpIHJldHVybiBjYiAmJiBjYihlbmQpXG4gICAgcmV0dXJuIGNiKG51bGwsIGdlbmVyYXRlKCkpXG4gIH1cbn1cblxudmFyIGRlZmVyID0gZXhwb3J0cy5kZWZlciA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIF9yZWFkLCBjYnMgPSBbXSwgX2VuZFxuXG4gIHZhciByZWFkID0gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZighX3JlYWQpIHtcbiAgICAgIF9lbmQgPSBlbmRcbiAgICAgIGNicy5wdXNoKGNiKVxuICAgIH0gXG4gICAgZWxzZSBfcmVhZChlbmQsIGNiKVxuICB9XG4gIHJlYWQucmVzb2x2ZSA9IGZ1bmN0aW9uIChyZWFkKSB7XG4gICAgaWYoX3JlYWQpIHRocm93IG5ldyBFcnJvcignYWxyZWFkeSByZXNvbHZlZCcpXG4gICAgX3JlYWQgPSByZWFkXG4gICAgaWYoIV9yZWFkKSB0aHJvdyBuZXcgRXJyb3IoJ25vIHJlYWQgY2Fubm90IHJlc29sdmUhJyArIF9yZWFkKVxuICAgIHdoaWxlKGNicy5sZW5ndGgpXG4gICAgICBfcmVhZChfZW5kLCBjYnMuc2hpZnQoKSlcbiAgfVxuICByZWFkLmFib3J0ID0gZnVuY3Rpb24oZXJyKSB7XG4gICAgcmVhZC5yZXNvbHZlKGZ1bmN0aW9uIChfLCBjYikge1xuICAgICAgY2IoZXJyIHx8IHRydWUpXG4gICAgfSlcbiAgfVxuICByZXR1cm4gcmVhZFxufVxuXG52YXIgZW1wdHkgPSBleHBvcnRzLmVtcHR5ID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gZnVuY3Rpb24gKGFib3J0LCBjYikge1xuICAgIGNiKHRydWUpXG4gIH1cbn1cblxudmFyIGVycm9yID0gZXhwb3J0cy5lcnJvciA9IGZ1bmN0aW9uIChlcnIpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIChhYm9ydCwgY2IpIHtcbiAgICBjYihlcnIpXG4gIH1cbn1cblxudmFyIGRlcHRoRmlyc3QgPSBleHBvcnRzLmRlcHRoRmlyc3QgPVxuZnVuY3Rpb24gKHN0YXJ0LCBjcmVhdGVTdHJlYW0pIHtcbiAgdmFyIHJlYWRzID0gW11cblxuICByZWFkcy51bnNoaWZ0KG9uY2Uoc3RhcnQpKVxuXG4gIHJldHVybiBmdW5jdGlvbiBuZXh0IChlbmQsIGNiKSB7XG4gICAgaWYoIXJlYWRzLmxlbmd0aClcbiAgICAgIHJldHVybiBjYih0cnVlKVxuICAgIHJlYWRzWzBdKGVuZCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kKSB7XG4gICAgICAgIC8vaWYgdGhpcyBzdHJlYW0gaGFzIGVuZGVkLCBnbyB0byB0aGUgbmV4dCBxdWV1ZVxuICAgICAgICByZWFkcy5zaGlmdCgpXG4gICAgICAgIHJldHVybiBuZXh0KG51bGwsIGNiKVxuICAgICAgfVxuICAgICAgcmVhZHMudW5zaGlmdChjcmVhdGVTdHJlYW0oZGF0YSkpXG4gICAgICBjYihlbmQsIGRhdGEpXG4gICAgfSlcbiAgfVxufVxuLy93aWR0aCBmaXJzdCBpcyBqdXN0IGxpa2UgZGVwdGggZmlyc3QsXG4vL2J1dCBwdXNoIGVhY2ggbmV3IHN0cmVhbSBvbnRvIHRoZSBlbmQgb2YgdGhlIHF1ZXVlXG52YXIgd2lkdGhGaXJzdCA9IGV4cG9ydHMud2lkdGhGaXJzdCA9XG5mdW5jdGlvbiAoc3RhcnQsIGNyZWF0ZVN0cmVhbSkge1xuICB2YXIgcmVhZHMgPSBbXVxuXG4gIHJlYWRzLnB1c2gob25jZShzdGFydCkpXG5cbiAgcmV0dXJuIGZ1bmN0aW9uIG5leHQgKGVuZCwgY2IpIHtcbiAgICBpZighcmVhZHMubGVuZ3RoKVxuICAgICAgcmV0dXJuIGNiKHRydWUpXG4gICAgcmVhZHNbMF0oZW5kLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICBpZihlbmQpIHtcbiAgICAgICAgcmVhZHMuc2hpZnQoKVxuICAgICAgICByZXR1cm4gbmV4dChudWxsLCBjYilcbiAgICAgIH1cbiAgICAgIHJlYWRzLnB1c2goY3JlYXRlU3RyZWFtKGRhdGEpKVxuICAgICAgY2IoZW5kLCBkYXRhKVxuICAgIH0pXG4gIH1cbn1cblxuLy90aGlzIGNhbWUgb3V0IGRpZmZlcmVudCB0byB0aGUgZmlyc3QgKHN0cm0pXG4vL2F0dGVtcHQgYXQgbGVhZkZpcnN0LCBidXQgaXQncyBzdGlsbCBhIHZhbGlkXG4vL3RvcG9sb2dpY2FsIHNvcnQuXG52YXIgbGVhZkZpcnN0ID0gZXhwb3J0cy5sZWFmRmlyc3QgPVxuZnVuY3Rpb24gKHN0YXJ0LCBjcmVhdGVTdHJlYW0pIHtcbiAgdmFyIHJlYWRzID0gW11cbiAgdmFyIG91dHB1dCA9IFtdXG4gIHJlYWRzLnB1c2gob25jZShzdGFydCkpXG5cbiAgcmV0dXJuIGZ1bmN0aW9uIG5leHQgKGVuZCwgY2IpIHtcbiAgICByZWFkc1swXShlbmQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZCkge1xuICAgICAgICByZWFkcy5zaGlmdCgpXG4gICAgICAgIGlmKCFvdXRwdXQubGVuZ3RoKVxuICAgICAgICAgIHJldHVybiBjYih0cnVlKVxuICAgICAgICByZXR1cm4gY2IobnVsbCwgb3V0cHV0LnNoaWZ0KCkpXG4gICAgICB9XG4gICAgICByZWFkcy51bnNoaWZ0KGNyZWF0ZVN0cmVhbShkYXRhKSlcbiAgICAgIG91dHB1dC51bnNoaWZ0KGRhdGEpXG4gICAgICBuZXh0KG51bGwsIGNiKVxuICAgIH0pXG4gIH1cbn1cblxuIiwidmFyIHUgICAgICA9IHJlcXVpcmUoJ3B1bGwtY29yZScpXG52YXIgc291cmNlcyA9IHJlcXVpcmUoJy4vc291cmNlcycpXG52YXIgc2lua3MgPSByZXF1aXJlKCcuL3NpbmtzJylcblxudmFyIHByb3AgICA9IHUucHJvcFxudmFyIGlkICAgICA9IHUuaWRcbnZhciB0ZXN0ZXIgPSB1LnRlc3RlclxuXG52YXIgbWFwID0gZXhwb3J0cy5tYXAgPVxuZnVuY3Rpb24gKHJlYWQsIG1hcCkge1xuICBtYXAgPSBwcm9wKG1hcCkgfHwgaWRcbiAgcmV0dXJuIGZ1bmN0aW9uIChhYm9ydCwgY2IpIHtcbiAgICByZWFkKGFib3J0LCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICB0cnkge1xuICAgICAgZGF0YSA9ICFlbmQgPyBtYXAoZGF0YSkgOiBudWxsXG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIHJlYWQoZXJyLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgcmV0dXJuIGNiKGVycilcbiAgICAgICAgfSlcbiAgICAgIH1cbiAgICAgIGNiKGVuZCwgZGF0YSlcbiAgICB9KVxuICB9XG59XG5cbnZhciBhc3luY01hcCA9IGV4cG9ydHMuYXN5bmNNYXAgPVxuZnVuY3Rpb24gKHJlYWQsIG1hcCkge1xuICBpZighbWFwKSByZXR1cm4gcmVhZFxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmQpIHJldHVybiByZWFkKGVuZCwgY2IpIC8vYWJvcnRcbiAgICByZWFkKG51bGwsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZCkgcmV0dXJuIGNiKGVuZCwgZGF0YSlcbiAgICAgIG1hcChkYXRhLCBjYilcbiAgICB9KVxuICB9XG59XG5cbnZhciBwYXJhTWFwID0gZXhwb3J0cy5wYXJhTWFwID1cbmZ1bmN0aW9uIChyZWFkLCBtYXAsIHdpZHRoKSB7XG4gIGlmKCFtYXApIHJldHVybiByZWFkXG4gIHZhciBlbmRlZCA9IGZhbHNlLCBxdWV1ZSA9IFtdLCBfY2JcblxuICBmdW5jdGlvbiBkcmFpbiAoKSB7XG4gICAgaWYoIV9jYikgcmV0dXJuXG4gICAgdmFyIGNiID0gX2NiXG4gICAgX2NiID0gbnVsbFxuICAgIGlmKHF1ZXVlLmxlbmd0aClcbiAgICAgIHJldHVybiBjYihudWxsLCBxdWV1ZS5zaGlmdCgpKVxuICAgIGVsc2UgaWYoZW5kZWQgJiYgIW4pXG4gICAgICByZXR1cm4gY2IoZW5kZWQpXG4gICAgX2NiID0gY2JcbiAgfVxuXG4gIGZ1bmN0aW9uIHB1bGwgKCkge1xuICAgIHJlYWQobnVsbCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kKSB7XG4gICAgICAgIGVuZGVkID0gZW5kXG4gICAgICAgIHJldHVybiBkcmFpbigpXG4gICAgICB9XG4gICAgICBuKytcbiAgICAgIG1hcChkYXRhLCBmdW5jdGlvbiAoZXJyLCBkYXRhKSB7XG4gICAgICAgIG4tLVxuXG4gICAgICAgIHF1ZXVlLnB1c2goZGF0YSlcbiAgICAgICAgZHJhaW4oKVxuICAgICAgfSlcblxuICAgICAgaWYobiA8IHdpZHRoICYmICFlbmRlZClcbiAgICAgICAgcHVsbCgpXG4gICAgfSlcbiAgfVxuXG4gIHZhciBuID0gMFxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmQpIHJldHVybiByZWFkKGVuZCwgY2IpIC8vYWJvcnRcbiAgICAvL2NvbnRpbnVlIHRvIHJlYWQgd2hpbGUgdGhlcmUgYXJlIGxlc3MgdGhhbiAzIG1hcHMgaW4gZmxpZ2h0XG4gICAgX2NiID0gY2JcbiAgICBpZihxdWV1ZS5sZW5ndGggfHwgZW5kZWQpXG4gICAgICBwdWxsKCksIGRyYWluKClcbiAgICBlbHNlIHB1bGwoKVxuICB9XG4gIHJldHVybiBoaWdoV2F0ZXJNYXJrKGFzeW5jTWFwKHJlYWQsIG1hcCksIHdpZHRoKVxufVxuXG52YXIgZmlsdGVyID0gZXhwb3J0cy5maWx0ZXIgPVxuZnVuY3Rpb24gKHJlYWQsIHRlc3QpIHtcbiAgLy9yZWdleHBcbiAgdGVzdCA9IHRlc3Rlcih0ZXN0KVxuICByZXR1cm4gZnVuY3Rpb24gbmV4dCAoZW5kLCBjYikge1xuICAgIHZhciBzeW5jLCBsb29wID0gdHJ1ZVxuICAgIHdoaWxlKGxvb3ApIHtcbiAgICAgIGxvb3AgPSBmYWxzZVxuICAgICAgc3luYyA9IHRydWVcbiAgICAgIHJlYWQoZW5kLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICAgIGlmKCFlbmQgJiYgIXRlc3QoZGF0YSkpXG4gICAgICAgICAgcmV0dXJuIHN5bmMgPyBsb29wID0gdHJ1ZSA6IG5leHQoZW5kLCBjYilcbiAgICAgICAgY2IoZW5kLCBkYXRhKVxuICAgICAgfSlcbiAgICAgIHN5bmMgPSBmYWxzZVxuICAgIH1cbiAgfVxufVxuXG52YXIgZmlsdGVyTm90ID0gZXhwb3J0cy5maWx0ZXJOb3QgPVxuZnVuY3Rpb24gKHJlYWQsIHRlc3QpIHtcbiAgdGVzdCA9IHRlc3Rlcih0ZXN0KVxuICByZXR1cm4gZmlsdGVyKHJlYWQsIGZ1bmN0aW9uIChlKSB7XG4gICAgcmV0dXJuICF0ZXN0KGUpXG4gIH0pXG59XG5cbnZhciB0aHJvdWdoID0gZXhwb3J0cy50aHJvdWdoID1cbmZ1bmN0aW9uIChyZWFkLCBvcCwgb25FbmQpIHtcbiAgdmFyIGEgPSBmYWxzZVxuICBmdW5jdGlvbiBvbmNlIChhYm9ydCkge1xuICAgIGlmKGEgfHwgIW9uRW5kKSByZXR1cm5cbiAgICBhID0gdHJ1ZVxuICAgIG9uRW5kKGFib3J0ID09PSB0cnVlID8gbnVsbCA6IGFib3J0KVxuICB9XG5cbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoZW5kKSBvbmNlKGVuZClcbiAgICByZXR1cm4gcmVhZChlbmQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKCFlbmQpIG9wICYmIG9wKGRhdGEpXG4gICAgICBlbHNlIG9uY2UoZW5kKVxuICAgICAgY2IoZW5kLCBkYXRhKVxuICAgIH0pXG4gIH1cbn1cblxudmFyIHRha2UgPSBleHBvcnRzLnRha2UgPVxuZnVuY3Rpb24gKHJlYWQsIHRlc3QpIHtcbiAgdmFyIGVuZGVkID0gZmFsc2VcbiAgaWYoJ251bWJlcicgPT09IHR5cGVvZiB0ZXN0KSB7XG4gICAgdmFyIG4gPSB0ZXN0OyB0ZXN0ID0gZnVuY3Rpb24gKCkge1xuICAgICAgcmV0dXJuIG4gLS1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmRlZCkgcmV0dXJuIGNiKGVuZGVkKVxuICAgIGlmKGVuZGVkID0gZW5kKSByZXR1cm4gcmVhZChlbmRlZCwgY2IpXG5cbiAgICByZWFkKG51bGwsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZGVkID0gZW5kZWQgfHwgZW5kKSByZXR1cm4gY2IoZW5kZWQpXG4gICAgICBpZighdGVzdChkYXRhKSkge1xuICAgICAgICBlbmRlZCA9IHRydWVcbiAgICAgICAgcmVhZCh0cnVlLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICAgICAgY2IoZW5kZWQsIGRhdGEpXG4gICAgICAgIH0pXG4gICAgICB9XG4gICAgICBlbHNlXG4gICAgICAgIGNiKG51bGwsIGRhdGEpXG4gICAgfSlcbiAgfVxufVxuXG52YXIgdW5pcXVlID0gZXhwb3J0cy51bmlxdWUgPSBmdW5jdGlvbiAocmVhZCwgZmllbGQsIGludmVydCkge1xuICBmaWVsZCA9IHByb3AoZmllbGQpIHx8IGlkXG4gIHZhciBzZWVuID0ge31cbiAgcmV0dXJuIGZpbHRlcihyZWFkLCBmdW5jdGlvbiAoZGF0YSkge1xuICAgIHZhciBrZXkgPSBmaWVsZChkYXRhKVxuICAgIGlmKHNlZW5ba2V5XSkgcmV0dXJuICEhaW52ZXJ0IC8vZmFsc2UsIGJ5IGRlZmF1bHRcbiAgICBlbHNlIHNlZW5ba2V5XSA9IHRydWVcbiAgICByZXR1cm4gIWludmVydCAvL3RydWUgYnkgZGVmYXVsdFxuICB9KVxufVxuXG52YXIgbm9uVW5pcXVlID0gZXhwb3J0cy5ub25VbmlxdWUgPSBmdW5jdGlvbiAocmVhZCwgZmllbGQpIHtcbiAgcmV0dXJuIHVuaXF1ZShyZWFkLCBmaWVsZCwgdHJ1ZSlcbn1cblxudmFyIGdyb3VwID0gZXhwb3J0cy5ncm91cCA9XG5mdW5jdGlvbiAocmVhZCwgc2l6ZSkge1xuICB2YXIgZW5kZWQ7IHNpemUgPSBzaXplIHx8IDVcbiAgdmFyIHF1ZXVlID0gW11cblxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICAvL3RoaXMgbWVhbnMgdGhhdCB0aGUgdXBzdHJlYW0gaXMgc2VuZGluZyBhbiBlcnJvci5cbiAgICBpZihlbmQpIHJldHVybiByZWFkKGVuZGVkID0gZW5kLCBjYilcbiAgICAvL3RoaXMgbWVhbnMgdGhhdCB3ZSByZWFkIGFuIGVuZCBiZWZvcmUuXG4gICAgaWYoZW5kZWQpIHJldHVybiBjYihlbmRlZClcblxuICAgIHJlYWQobnVsbCwgZnVuY3Rpb24gbmV4dChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZGVkID0gZW5kZWQgfHwgZW5kKSB7XG4gICAgICAgIGlmKCFxdWV1ZS5sZW5ndGgpXG4gICAgICAgICAgcmV0dXJuIGNiKGVuZGVkKVxuXG4gICAgICAgIHZhciBfcXVldWUgPSBxdWV1ZTsgcXVldWUgPSBbXVxuICAgICAgICByZXR1cm4gY2IobnVsbCwgX3F1ZXVlKVxuICAgICAgfVxuICAgICAgcXVldWUucHVzaChkYXRhKVxuICAgICAgaWYocXVldWUubGVuZ3RoIDwgc2l6ZSlcbiAgICAgICAgcmV0dXJuIHJlYWQobnVsbCwgbmV4dClcblxuICAgICAgdmFyIF9xdWV1ZSA9IHF1ZXVlOyBxdWV1ZSA9IFtdXG4gICAgICBjYihudWxsLCBfcXVldWUpXG4gICAgfSlcbiAgfVxufVxuXG52YXIgZmxhdHRlbiA9IGV4cG9ydHMuZmxhdHRlbiA9IGZ1bmN0aW9uIChyZWFkKSB7XG4gIHZhciBfcmVhZFxuICByZXR1cm4gZnVuY3Rpb24gKGFib3J0LCBjYikge1xuICAgIGlmKF9yZWFkKSBuZXh0Q2h1bmsoKVxuICAgIGVsc2UgICAgICBuZXh0U3RyZWFtKClcblxuICAgIGZ1bmN0aW9uIG5leHRDaHVuayAoKSB7XG4gICAgICBfcmVhZChudWxsLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICAgIGlmKGVuZCkgbmV4dFN0cmVhbSgpXG4gICAgICAgIGVsc2UgICAgY2IobnVsbCwgZGF0YSlcbiAgICAgIH0pXG4gICAgfVxuICAgIGZ1bmN0aW9uIG5leHRTdHJlYW0gKCkge1xuICAgICAgcmVhZChudWxsLCBmdW5jdGlvbiAoZW5kLCBzdHJlYW0pIHtcbiAgICAgICAgaWYoZW5kKVxuICAgICAgICAgIHJldHVybiBjYihlbmQpXG4gICAgICAgIGlmKEFycmF5LmlzQXJyYXkoc3RyZWFtKSB8fCBzdHJlYW0gJiYgJ29iamVjdCcgPT09IHR5cGVvZiBzdHJlYW0pXG4gICAgICAgICAgc3RyZWFtID0gc291cmNlcy52YWx1ZXMoc3RyZWFtKVxuICAgICAgICBlbHNlIGlmKCdmdW5jdGlvbicgIT0gdHlwZW9mIHN0cmVhbSlcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ2V4cGVjdGVkIHN0cmVhbSBvZiBzdHJlYW1zJylcbiAgICAgICAgX3JlYWQgPSBzdHJlYW1cbiAgICAgICAgbmV4dENodW5rKClcbiAgICAgIH0pXG4gICAgfVxuICB9XG59XG5cbnZhciBwcmVwZW5kID1cbmV4cG9ydHMucHJlcGVuZCA9XG5mdW5jdGlvbiAocmVhZCwgaGVhZCkge1xuXG4gIHJldHVybiBmdW5jdGlvbiAoYWJvcnQsIGNiKSB7XG4gICAgaWYoaGVhZCAhPT0gbnVsbCkge1xuICAgICAgaWYoYWJvcnQpXG4gICAgICAgIHJldHVybiByZWFkKGFib3J0LCBjYilcbiAgICAgIHZhciBfaGVhZCA9IGhlYWRcbiAgICAgIGhlYWQgPSBudWxsXG4gICAgICBjYihudWxsLCBfaGVhZClcbiAgICB9IGVsc2Uge1xuICAgICAgcmVhZChhYm9ydCwgY2IpXG4gICAgfVxuICB9XG5cbn1cblxuLy92YXIgZHJhaW5JZiA9IGV4cG9ydHMuZHJhaW5JZiA9IGZ1bmN0aW9uIChvcCwgZG9uZSkge1xuLy8gIHNpbmtzLmRyYWluKFxuLy99XG5cbnZhciBfcmVkdWNlID0gZXhwb3J0cy5fcmVkdWNlID0gZnVuY3Rpb24gKHJlYWQsIHJlZHVjZSwgaW5pdGlhbCkge1xuICByZXR1cm4gZnVuY3Rpb24gKGNsb3NlLCBjYikge1xuICAgIGlmKGNsb3NlKSByZXR1cm4gcmVhZChjbG9zZSwgY2IpXG4gICAgaWYoZW5kZWQpIHJldHVybiBjYihlbmRlZClcblxuICAgIHNpbmtzLmRyYWluKGZ1bmN0aW9uIChpdGVtKSB7XG4gICAgICBpbml0aWFsID0gcmVkdWNlKGluaXRpYWwsIGl0ZW0pXG4gICAgfSwgZnVuY3Rpb24gKGVyciwgZGF0YSkge1xuICAgICAgZW5kZWQgPSBlcnIgfHwgdHJ1ZVxuICAgICAgaWYoIWVycikgY2IobnVsbCwgaW5pdGlhbClcbiAgICAgIGVsc2UgICAgIGNiKGVuZGVkKVxuICAgIH0pXG4gICAgKHJlYWQpXG4gIH1cbn1cblxudmFyIG5leHRUaWNrID0gcHJvY2Vzcy5uZXh0VGlja1xuXG52YXIgaGlnaFdhdGVyTWFyayA9IGV4cG9ydHMuaGlnaFdhdGVyTWFyayA9XG5mdW5jdGlvbiAocmVhZCwgaGlnaFdhdGVyTWFyaykge1xuICB2YXIgYnVmZmVyID0gW10sIHdhaXRpbmcgPSBbXSwgZW5kZWQsIGVuZGluZywgcmVhZGluZyA9IGZhbHNlXG4gIGhpZ2hXYXRlck1hcmsgPSBoaWdoV2F0ZXJNYXJrIHx8IDEwXG5cbiAgZnVuY3Rpb24gcmVhZEFoZWFkICgpIHtcbiAgICB3aGlsZSh3YWl0aW5nLmxlbmd0aCAmJiAoYnVmZmVyLmxlbmd0aCB8fCBlbmRlZCkpXG4gICAgICB3YWl0aW5nLnNoaWZ0KCkoZW5kZWQsIGVuZGVkID8gbnVsbCA6IGJ1ZmZlci5zaGlmdCgpKVxuXG4gICAgaWYgKCFidWZmZXIubGVuZ3RoICYmIGVuZGluZykgZW5kZWQgPSBlbmRpbmc7XG4gIH1cblxuICBmdW5jdGlvbiBuZXh0ICgpIHtcbiAgICBpZihlbmRlZCB8fCBlbmRpbmcgfHwgcmVhZGluZyB8fCBidWZmZXIubGVuZ3RoID49IGhpZ2hXYXRlck1hcmspXG4gICAgICByZXR1cm5cbiAgICByZWFkaW5nID0gdHJ1ZVxuICAgIHJldHVybiByZWFkKGVuZGVkIHx8IGVuZGluZywgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgcmVhZGluZyA9IGZhbHNlXG4gICAgICBlbmRpbmcgPSBlbmRpbmcgfHwgZW5kXG4gICAgICBpZihkYXRhICE9IG51bGwpIGJ1ZmZlci5wdXNoKGRhdGEpXG5cbiAgICAgIG5leHQoKTsgcmVhZEFoZWFkKClcbiAgICB9KVxuICB9XG5cbiAgcHJvY2Vzcy5uZXh0VGljayhuZXh0KVxuXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGVuZGVkID0gZW5kZWQgfHwgZW5kXG4gICAgd2FpdGluZy5wdXNoKGNiKVxuXG4gICAgbmV4dCgpOyByZWFkQWhlYWQoKVxuICB9XG59XG5cbnZhciBmbGF0TWFwID0gZXhwb3J0cy5mbGF0TWFwID1cbmZ1bmN0aW9uIChyZWFkLCBtYXBwZXIpIHtcbiAgbWFwcGVyID0gbWFwcGVyIHx8IGlkXG4gIHZhciBxdWV1ZSA9IFtdLCBlbmRlZFxuXG4gIHJldHVybiBmdW5jdGlvbiAoYWJvcnQsIGNiKSB7XG4gICAgaWYocXVldWUubGVuZ3RoKSByZXR1cm4gY2IobnVsbCwgcXVldWUuc2hpZnQoKSlcbiAgICBlbHNlIGlmKGVuZGVkKSAgIHJldHVybiBjYihlbmRlZClcblxuICAgIHJlYWQoYWJvcnQsIGZ1bmN0aW9uIG5leHQgKGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kKSBlbmRlZCA9IGVuZFxuICAgICAgZWxzZSB7XG4gICAgICAgIHZhciBhZGQgPSBtYXBwZXIoZGF0YSlcbiAgICAgICAgd2hpbGUoYWRkICYmIGFkZC5sZW5ndGgpXG4gICAgICAgICAgcXVldWUucHVzaChhZGQuc2hpZnQoKSlcbiAgICAgIH1cblxuICAgICAgaWYocXVldWUubGVuZ3RoKSBjYihudWxsLCBxdWV1ZS5zaGlmdCgpKVxuICAgICAgZWxzZSBpZihlbmRlZCkgICBjYihlbmRlZClcbiAgICAgIGVsc2UgICAgICAgICAgICAgcmVhZChudWxsLCBuZXh0KVxuICAgIH0pXG4gIH1cbn1cblxuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIGpzb25wYXJzZSA9IHJlcXVpcmUoJ2NvZy9qc29ucGFyc2UnKTtcblxuLyoqXG4gICMjIyBzaWduYWxsZXIgcHJvY2VzcyBoYW5kbGluZ1xuXG4gIFdoZW4gYSBzaWduYWxsZXIncyB1bmRlcmxpbmcgbWVzc2VuZ2VyIGVtaXRzIGEgYGRhdGFgIGV2ZW50IHRoaXMgaXNcbiAgZGVsZWdhdGVkIHRvIGEgc2ltcGxlIG1lc3NhZ2UgcGFyc2VyLCB3aGljaCBhcHBsaWVzIHRoZSBmb2xsb3dpbmcgc2ltcGxlXG4gIGxvZ2ljOlxuXG4gIC0gSXMgdGhlIG1lc3NhZ2UgYSBgL3RvYCBtZXNzYWdlLiBJZiBzbywgc2VlIGlmIHRoZSBtZXNzYWdlIGlzIGZvciB0aGlzXG4gICAgc2lnbmFsbGVyIChjaGVja2luZyB0aGUgdGFyZ2V0IGlkIC0gMm5kIGFyZykuICBJZiBzbyBwYXNzIHRoZVxuICAgIHJlbWFpbmRlciBvZiB0aGUgbWVzc2FnZSBvbnRvIHRoZSBzdGFuZGFyZCBwcm9jZXNzaW5nIGNoYWluLiAgSWYgbm90LFxuICAgIGRpc2NhcmQgdGhlIG1lc3NhZ2UuXG5cbiAgLSBJcyB0aGUgbWVzc2FnZSBhIGNvbW1hbmQgbWVzc2FnZSAocHJlZml4ZWQgd2l0aCBhIGZvcndhcmQgc2xhc2gpLiBJZiBzbyxcbiAgICBsb29rIGZvciBhbiBhcHByb3ByaWF0ZSBtZXNzYWdlIGhhbmRsZXIgYW5kIHBhc3MgdGhlIG1lc3NhZ2UgcGF5bG9hZCBvblxuICAgIHRvIGl0LlxuXG4gIC0gRmluYWxseSwgZG9lcyB0aGUgbWVzc2FnZSBtYXRjaCBhbnkgcGF0dGVybnMgdGhhdCB3ZSBhcmUgbGlzdGVuaW5nIGZvcj9cbiAgICBJZiBzbywgdGhlbiBwYXNzIHRoZSBlbnRpcmUgbWVzc2FnZSBjb250ZW50cyBvbnRvIHRoZSByZWdpc3RlcmVkIGhhbmRsZXIuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oc2lnbmFsbGVyLCBvcHRzKSB7XG4gIHZhciBoYW5kbGVycyA9IHJlcXVpcmUoJy4vaGFuZGxlcnMnKShzaWduYWxsZXIsIG9wdHMpO1xuXG4gIGZ1bmN0aW9uIHNlbmRFdmVudChwYXJ0cywgc3JjU3RhdGUsIGRhdGEpIHtcbiAgICAvLyBpbml0aWFsaXNlIHRoZSBldmVudCBuYW1lXG4gICAgdmFyIGV2dE5hbWUgPSAnbWVzc2FnZTonICsgcGFydHNbMF0uc2xpY2UoMSk7XG5cbiAgICAvLyBjb252ZXJ0IGFueSB2YWxpZCBqc29uIG9iamVjdHMgdG8ganNvblxuICAgIHZhciBhcmdzID0gcGFydHMuc2xpY2UoMikubWFwKGpzb25wYXJzZSk7XG5cbiAgICBzaWduYWxsZXIuYXBwbHkoXG4gICAgICBzaWduYWxsZXIsXG4gICAgICBbZXZ0TmFtZV0uY29uY2F0KGFyZ3MpLmNvbmNhdChbc3JjU3RhdGUsIGRhdGFdKVxuICAgICk7XG4gIH1cblxuICByZXR1cm4gZnVuY3Rpb24ob3JpZ2luYWxEYXRhKSB7XG4gICAgdmFyIGRhdGEgPSBvcmlnaW5hbERhdGE7XG4gICAgdmFyIGlzTWF0Y2ggPSB0cnVlO1xuICAgIHZhciBwYXJ0cztcbiAgICB2YXIgaGFuZGxlcjtcbiAgICB2YXIgc3JjRGF0YTtcbiAgICB2YXIgc3JjU3RhdGU7XG4gICAgdmFyIGlzRGlyZWN0TWVzc2FnZSA9IGZhbHNlO1xuXG4gICAgLy8gZGlzY2FyZCBwcmltdXMgbWVzc2FnZXNcbiAgICBpZiAoZGF0YSAmJiBkYXRhLnNsaWNlKDAsIDYpID09PSAncHJpbXVzJykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIGZvcmNlIHRoZSBpZCBpbnRvIHN0cmluZyBmb3JtYXQgc28gd2UgY2FuIHJ1biBsZW5ndGggYW5kIGNvbXBhcmlzb24gdGVzdHMgb24gaXRcbiAgICB2YXIgaWQgPSBzaWduYWxsZXIuaWQgKyAnJztcblxuICAgIC8vIHByb2Nlc3MgL3RvIG1lc3NhZ2VzXG4gICAgaWYgKGRhdGEuc2xpY2UoMCwgMykgPT09ICcvdG8nKSB7XG4gICAgICBpc01hdGNoID0gZGF0YS5zbGljZSg0LCBpZC5sZW5ndGggKyA0KSA9PT0gaWQ7XG4gICAgICBpZiAoaXNNYXRjaCkge1xuICAgICAgICBwYXJ0cyA9IGRhdGEuc2xpY2UoNSArIGlkLmxlbmd0aCkuc3BsaXQoJ3wnKS5tYXAoanNvbnBhcnNlKTtcblxuICAgICAgICAvLyBnZXQgdGhlIHNvdXJjZSBkYXRhXG4gICAgICAgIGlzRGlyZWN0TWVzc2FnZSA9IHRydWU7XG5cbiAgICAgICAgLy8gZXh0cmFjdCB0aGUgdmVjdG9yIGNsb2NrIGFuZCB1cGRhdGUgdGhlIHBhcnRzXG4gICAgICAgIHBhcnRzID0gcGFydHMubWFwKGpzb25wYXJzZSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gaWYgdGhpcyBpcyBub3QgYSBtYXRjaCwgdGhlbiBiYWlsXG4gICAgaWYgKCEgaXNNYXRjaCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIGNob3AgdGhlIGRhdGEgaW50byBwYXJ0c1xuICAgIHNpZ25hbGxlcigncmF3ZGF0YScsIGRhdGEpO1xuICAgIHBhcnRzID0gcGFydHMgfHwgZGF0YS5zcGxpdCgnfCcpLm1hcChqc29ucGFyc2UpO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSBhIHNwZWNpZmljIGhhbmRsZXIgZm9yIHRoZSBhY3Rpb24sIHRoZW4gaW52b2tlXG4gICAgaWYgKHR5cGVvZiBwYXJ0c1swXSA9PSAnc3RyaW5nJykge1xuICAgICAgLy8gZXh0cmFjdCB0aGUgbWV0YWRhdGEgZnJvbSB0aGUgaW5wdXQgZGF0YVxuICAgICAgc3JjRGF0YSA9IHBhcnRzWzFdO1xuXG4gICAgICAvLyBpZiB3ZSBnb3QgZGF0YSBmcm9tIG91cnNlbGYsIHRoZW4gdGhpcyBpcyBwcmV0dHkgZHVtYlxuICAgICAgLy8gYnV0IGlmIHdlIGhhdmUgdGhlbiB0aHJvdyBpdCBhd2F5XG4gICAgICBpZiAoc3JjRGF0YSAmJiBzcmNEYXRhLmlkID09PSBzaWduYWxsZXIuaWQpIHtcbiAgICAgICAgcmV0dXJuIGNvbnNvbGUud2FybignZ290IGRhdGEgZnJvbSBvdXJzZWxmLCBkaXNjYXJkaW5nJyk7XG4gICAgICB9XG5cbiAgICAgIC8vIGdldCB0aGUgc291cmNlIHN0YXRlXG4gICAgICBzcmNTdGF0ZSA9IHNpZ25hbGxlci5wZWVycy5nZXQoc3JjRGF0YSAmJiBzcmNEYXRhLmlkKSB8fCBzcmNEYXRhO1xuXG4gICAgICAvLyBoYW5kbGUgY29tbWFuZHNcbiAgICAgIGlmIChwYXJ0c1swXS5jaGFyQXQoMCkgPT09ICcvJykge1xuICAgICAgICAvLyBsb29rIGZvciBhIGhhbmRsZXIgZm9yIHRoZSBtZXNzYWdlIHR5cGVcbiAgICAgICAgaGFuZGxlciA9IGhhbmRsZXJzW3BhcnRzWzBdLnNsaWNlKDEpXTtcblxuICAgICAgICBpZiAodHlwZW9mIGhhbmRsZXIgPT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgIGhhbmRsZXIoXG4gICAgICAgICAgICBwYXJ0cy5zbGljZSgyKSxcbiAgICAgICAgICAgIHBhcnRzWzBdLnNsaWNlKDEpLFxuICAgICAgICAgICAgc3JjRGF0YSxcbiAgICAgICAgICAgIHNyY1N0YXRlLFxuICAgICAgICAgICAgaXNEaXJlY3RNZXNzYWdlXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBzZW5kRXZlbnQocGFydHMsIHNyY1N0YXRlLCBvcmlnaW5hbERhdGEpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBvdGhlcndpc2UsIGVtaXQgZGF0YVxuICAgICAgZWxzZSB7XG4gICAgICAgIHNpZ25hbGxlcihcbiAgICAgICAgICAnZGF0YScsXG4gICAgICAgICAgcGFydHMuc2xpY2UoMCwgMSkuY29uY2F0KHBhcnRzLnNsaWNlKDIpKSxcbiAgICAgICAgICBzcmNEYXRhLFxuICAgICAgICAgIHNyY1N0YXRlLFxuICAgICAgICAgIGlzRGlyZWN0TWVzc2FnZVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfTtcbn07XG4iLCJ2YXIgZXh0ZW5kID0gcmVxdWlyZSgnY29nL2V4dGVuZCcpO1xuXG4vKipcbiAgIyBydGMtc3dpdGNoYm9hcmQtbWVzc2VuZ2VyXG5cbiAgQSBzcGVjaWFsaXNlZCB2ZXJzaW9uIG9mXG4gIFtgbWVzc2VuZ2VyLXdzYF0oaHR0cHM6Ly9naXRodWIuY29tL0RhbW9uT2VobG1hbi9tZXNzZW5nZXItd3MpIGRlc2lnbmVkIHRvXG4gIGNvbm5lY3QgdG8gW2BydGMtc3dpdGNoYm9hcmRgXShodHRwOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLXN3aXRjaGJvYXJkKVxuICBpbnN0YW5jZXMuXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihzd2l0Y2hib2FyZCwgb3B0cykge1xuICByZXR1cm4gcmVxdWlyZSgnbWVzc2VuZ2VyLXdzJykoc3dpdGNoYm9hcmQsIGV4dGVuZCh7XG4gICAgZW5kcG9pbnRzOiBbJy9wcmltdXMnLCAnLyddXG4gIH0sIG9wdHMpKTtcbn07XG4iLCJ2YXIgV2ViU29ja2V0ID0gcmVxdWlyZSgnd3MnKTtcbnZhciB3c3VybCA9IHJlcXVpcmUoJ3dzdXJsJyk7XG52YXIgcHMgPSByZXF1aXJlKCdwdWxsLXdzJyk7XG52YXIgZGVmYXVsdHMgPSByZXF1aXJlKCdjb2cvZGVmYXVsdHMnKTtcbnZhciByZVRyYWlsaW5nU2xhc2ggPSAvXFwvJC87XG5cbi8qKlxuICAjIG1lc3Nlbmdlci13c1xuXG4gIFRoaXMgaXMgYSBzaW1wbGUgbWVzc2FnaW5nIGltcGxlbWVudGF0aW9uIGZvciBzZW5kaW5nIGFuZCByZWNlaXZpbmcgZGF0YVxuICB2aWEgd2Vic29ja2V0cy5cblxuICBGb2xsb3dzIHRoZSBbbWVzc2VuZ2VyLWFyY2hldHlwZV0oaHR0cHM6Ly9naXRodWIuY29tL0RhbW9uT2VobG1hbi9tZXNzZW5nZXItYXJjaGV0eXBlKVxuXG4gICMjIEV4YW1wbGUgVXNhZ2VcblxuICA8PDwgZXhhbXBsZXMvc2ltcGxlLmpzXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbih1cmwsIG9wdHMpIHtcbiAgdmFyIHRpbWVvdXQgPSAob3B0cyB8fCB7fSkudGltZW91dCB8fCAxMDAwO1xuICB2YXIgZW5kcG9pbnRzID0gKChvcHRzIHx8IHt9KS5lbmRwb2ludHMgfHwgWycvJ10pLm1hcChmdW5jdGlvbihlbmRwb2ludCkge1xuICAgIHJldHVybiB1cmwucmVwbGFjZShyZVRyYWlsaW5nU2xhc2gsICcnKSArIGVuZHBvaW50O1xuICB9KTtcblxuICBmdW5jdGlvbiBjb25uZWN0KGNhbGxiYWNrKSB7XG4gICAgdmFyIHF1ZXVlID0gW10uY29uY2F0KGVuZHBvaW50cyk7XG4gICAgdmFyIHJlY2VpdmVkRGF0YSA9IGZhbHNlO1xuICAgIHZhciBmYWlsVGltZXI7XG4gICAgdmFyIHN1Y2Nlc3NUaW1lcjtcblxuICAgIGZ1bmN0aW9uIGF0dGVtcHROZXh0KCkge1xuICAgICAgdmFyIHNvY2tldDtcblxuICAgICAgZnVuY3Rpb24gcmVnaXN0ZXJNZXNzYWdlKGV2dCkge1xuICAgICAgICByZWNlaXZlZERhdGEgPSB0cnVlO1xuICAgICAgICAoc29ja2V0LnJlbW92ZUV2ZW50TGlzdGVuZXIgfHwgc29ja2V0LnJlbW92ZUxpc3RlbmVyKSgnbWVzc2FnZScsIHJlZ2lzdGVyTWVzc2FnZSk7XG4gICAgICB9XG5cbiAgICAgIC8vIGlmIHdlIGhhdmUgbm8gbW9yZSB2YWxpZCBlbmRwb2ludHMsIHRoZW4gZXJvcnIgb3V0XG4gICAgICBpZiAocXVldWUubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHJldHVybiBjYWxsYmFjayhuZXcgRXJyb3IoJ1VuYWJsZSB0byBjb25uZWN0IHRvIHVybDogJyArIHVybCkpO1xuICAgICAgfVxuXG4gICAgICBzb2NrZXQgPSBuZXcgV2ViU29ja2V0KHdzdXJsKHF1ZXVlLnNoaWZ0KCkpKTtcbiAgICAgIHNvY2tldC5hZGRFdmVudExpc3RlbmVyKCdlcnJvcicsIGhhbmRsZUVycm9yKTtcbiAgICAgIHNvY2tldC5hZGRFdmVudExpc3RlbmVyKCdjbG9zZScsIGhhbmRsZUFibm9ybWFsQ2xvc2UpO1xuICAgICAgc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ29wZW4nLCBmdW5jdGlvbigpIHtcbiAgICAgICAgLy8gY3JlYXRlIHRoZSBzb3VyY2UgaW1tZWRpYXRlbHkgdG8gYnVmZmVyIGFueSBkYXRhXG4gICAgICAgIHZhciBzb3VyY2UgPSBwcy5zb3VyY2Uoc29ja2V0LCBvcHRzKTtcblxuICAgICAgICAvLyBtb25pdG9yIGRhdGEgZmxvd2luZyBmcm9tIHRoZSBzb2NrZXRcbiAgICAgICAgc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ21lc3NhZ2UnLCByZWdpc3Rlck1lc3NhZ2UpO1xuXG4gICAgICAgIHN1Y2Nlc3NUaW1lciA9IHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgY2xlYXJUaW1lb3V0KGZhaWxUaW1lcik7XG4gICAgICAgICAgY2FsbGJhY2sobnVsbCwgc291cmNlLCBwcy5zaW5rKHNvY2tldCwgb3B0cykpO1xuICAgICAgICB9LCAxMDApO1xuICAgICAgfSk7XG5cbiAgICAgIGZhaWxUaW1lciA9IHNldFRpbWVvdXQoYXR0ZW1wdE5leHQsIHRpbWVvdXQpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGhhbmRsZUFibm9ybWFsQ2xvc2UoZXZ0KSB7XG4gICAgICAvLyBpZiB0aGlzIHdhcyBhIGNsZWFuIGNsb3NlIGRvIG5vdGhpbmdcbiAgICAgIGlmIChldnQud2FzQ2xlYW4gJiYgcmVjZWl2ZWREYXRhICYmIHF1ZXVlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBoYW5kbGVFcnJvcigpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGhhbmRsZUVycm9yKCkge1xuICAgICAgY2xlYXJUaW1lb3V0KHN1Y2Nlc3NUaW1lcik7XG4gICAgICBjbGVhclRpbWVvdXQoZmFpbFRpbWVyKTtcbiAgICAgIGF0dGVtcHROZXh0KCk7XG4gICAgfVxuXG4gICAgYXR0ZW1wdE5leHQoKTtcbiAgfVxuXG4gIHJldHVybiBjb25uZWN0O1xufTtcbiIsImV4cG9ydHMgPSBtb2R1bGUuZXhwb3J0cyA9IGR1cGxleDtcblxuZXhwb3J0cy5zb3VyY2UgPSByZXF1aXJlKCcuL3NvdXJjZScpO1xuZXhwb3J0cy5zaW5rID0gcmVxdWlyZSgnLi9zaW5rJyk7XG5cbmZ1bmN0aW9uIGR1cGxleCAod3MsIG9wdHMpIHtcbiAgcmV0dXJuIHtcbiAgICBzb3VyY2U6IGV4cG9ydHMuc291cmNlKHdzKSxcbiAgICBzaW5rOiBleHBvcnRzLnNpbmsod3MsIG9wdHMpXG4gIH07XG59O1xuIiwiZXhwb3J0cy5pZCA9IFxuZnVuY3Rpb24gKGl0ZW0pIHtcbiAgcmV0dXJuIGl0ZW1cbn1cblxuZXhwb3J0cy5wcm9wID0gXG5mdW5jdGlvbiAobWFwKSB7ICBcbiAgaWYoJ3N0cmluZycgPT0gdHlwZW9mIG1hcCkge1xuICAgIHZhciBrZXkgPSBtYXBcbiAgICByZXR1cm4gZnVuY3Rpb24gKGRhdGEpIHsgcmV0dXJuIGRhdGFba2V5XSB9XG4gIH1cbiAgcmV0dXJuIG1hcFxufVxuXG5leHBvcnRzLnRlc3RlciA9IGZ1bmN0aW9uICh0ZXN0KSB7XG4gIGlmKCF0ZXN0KSByZXR1cm4gZXhwb3J0cy5pZFxuICBpZignb2JqZWN0JyA9PT0gdHlwZW9mIHRlc3RcbiAgICAmJiAnZnVuY3Rpb24nID09PSB0eXBlb2YgdGVzdC50ZXN0KVxuICAgICAgcmV0dXJuIHRlc3QudGVzdC5iaW5kKHRlc3QpXG4gIHJldHVybiBleHBvcnRzLnByb3AodGVzdCkgfHwgZXhwb3J0cy5pZFxufVxuXG5leHBvcnRzLmFkZFBpcGUgPSBhZGRQaXBlXG5cbmZ1bmN0aW9uIGFkZFBpcGUocmVhZCkge1xuICBpZignZnVuY3Rpb24nICE9PSB0eXBlb2YgcmVhZClcbiAgICByZXR1cm4gcmVhZFxuXG4gIHJlYWQucGlwZSA9IHJlYWQucGlwZSB8fCBmdW5jdGlvbiAocmVhZGVyKSB7XG4gICAgaWYoJ2Z1bmN0aW9uJyAhPSB0eXBlb2YgcmVhZGVyICYmICdmdW5jdGlvbicgIT0gdHlwZW9mIHJlYWRlci5zaW5rKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKCdtdXN0IHBpcGUgdG8gcmVhZGVyJylcbiAgICB2YXIgcGlwZSA9IGFkZFBpcGUocmVhZGVyLnNpbmsgPyByZWFkZXIuc2luayhyZWFkKSA6IHJlYWRlcihyZWFkKSlcbiAgICByZXR1cm4gcmVhZGVyLnNvdXJjZSB8fCBwaXBlO1xuICB9XG4gIFxuICByZWFkLnR5cGUgPSAnU291cmNlJ1xuICByZXR1cm4gcmVhZFxufVxuXG52YXIgU291cmNlID1cbmV4cG9ydHMuU291cmNlID1cbmZ1bmN0aW9uIFNvdXJjZSAoY3JlYXRlUmVhZCkge1xuICBmdW5jdGlvbiBzKCkge1xuICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpXG4gICAgcmV0dXJuIGFkZFBpcGUoY3JlYXRlUmVhZC5hcHBseShudWxsLCBhcmdzKSlcbiAgfVxuICBzLnR5cGUgPSAnU291cmNlJ1xuICByZXR1cm4gc1xufVxuXG5cbnZhciBUaHJvdWdoID1cbmV4cG9ydHMuVGhyb3VnaCA9IFxuZnVuY3Rpb24gKGNyZWF0ZVJlYWQpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKVxuICAgIHZhciBwaXBlZCA9IFtdXG4gICAgZnVuY3Rpb24gcmVhZGVyIChyZWFkKSB7XG4gICAgICBhcmdzLnVuc2hpZnQocmVhZClcbiAgICAgIHJlYWQgPSBjcmVhdGVSZWFkLmFwcGx5KG51bGwsIGFyZ3MpXG4gICAgICB3aGlsZShwaXBlZC5sZW5ndGgpXG4gICAgICAgIHJlYWQgPSBwaXBlZC5zaGlmdCgpKHJlYWQpXG4gICAgICByZXR1cm4gcmVhZFxuICAgICAgLy9waXBlaW5nIHRvIGZyb20gdGhpcyByZWFkZXIgc2hvdWxkIGNvbXBvc2UuLi5cbiAgICB9XG4gICAgcmVhZGVyLnBpcGUgPSBmdW5jdGlvbiAocmVhZCkge1xuICAgICAgcGlwZWQucHVzaChyZWFkKSBcbiAgICAgIGlmKHJlYWQudHlwZSA9PT0gJ1NvdXJjZScpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignY2Fubm90IHBpcGUgJyArIHJlYWRlci50eXBlICsgJyB0byBTb3VyY2UnKVxuICAgICAgcmVhZGVyLnR5cGUgPSByZWFkLnR5cGUgPT09ICdTaW5rJyA/ICdTaW5rJyA6ICdUaHJvdWdoJ1xuICAgICAgcmV0dXJuIHJlYWRlclxuICAgIH1cbiAgICByZWFkZXIudHlwZSA9ICdUaHJvdWdoJ1xuICAgIHJldHVybiByZWFkZXJcbiAgfVxufVxuXG52YXIgU2luayA9XG5leHBvcnRzLlNpbmsgPSBcbmZ1bmN0aW9uIFNpbmsoY3JlYXRlUmVhZGVyKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cylcbiAgICBpZighY3JlYXRlUmVhZGVyKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKCdtdXN0IGJlIGNyZWF0ZVJlYWRlciBmdW5jdGlvbicpXG4gICAgZnVuY3Rpb24gcyAocmVhZCkge1xuICAgICAgYXJncy51bnNoaWZ0KHJlYWQpXG4gICAgICByZXR1cm4gY3JlYXRlUmVhZGVyLmFwcGx5KG51bGwsIGFyZ3MpXG4gICAgfVxuICAgIHMudHlwZSA9ICdTaW5rJ1xuICAgIHJldHVybiBzXG4gIH1cbn1cblxuXG5leHBvcnRzLm1heWJlU2luayA9IFxuZXhwb3J0cy5tYXliZURyYWluID0gXG5mdW5jdGlvbiAoY3JlYXRlU2luaywgY2IpIHtcbiAgaWYoIWNiKVxuICAgIHJldHVybiBUaHJvdWdoKGZ1bmN0aW9uIChyZWFkKSB7XG4gICAgICB2YXIgZW5kZWRcbiAgICAgIHJldHVybiBmdW5jdGlvbiAoY2xvc2UsIGNiKSB7XG4gICAgICAgIGlmKGNsb3NlKSByZXR1cm4gcmVhZChjbG9zZSwgY2IpXG4gICAgICAgIGlmKGVuZGVkKSByZXR1cm4gY2IoZW5kZWQpXG5cbiAgICAgICAgY3JlYXRlU2luayhmdW5jdGlvbiAoZXJyLCBkYXRhKSB7XG4gICAgICAgICAgZW5kZWQgPSBlcnIgfHwgdHJ1ZVxuICAgICAgICAgIGlmKCFlcnIpIGNiKG51bGwsIGRhdGEpXG4gICAgICAgICAgZWxzZSAgICAgY2IoZW5kZWQpXG4gICAgICAgIH0pIChyZWFkKVxuICAgICAgfVxuICAgIH0pKClcblxuICByZXR1cm4gU2luayhmdW5jdGlvbiAocmVhZCkge1xuICAgIHJldHVybiBjcmVhdGVTaW5rKGNiKSAocmVhZClcbiAgfSkoKVxufVxuXG4iLCJtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHNvY2tldCwgY2FsbGJhY2spIHtcbiAgdmFyIHJlbW92ZSA9IHNvY2tldCAmJiAoc29ja2V0LnJlbW92ZUV2ZW50TGlzdGVuZXIgfHwgc29ja2V0LnJlbW92ZUxpc3RlbmVyKTtcblxuICBmdW5jdGlvbiBjbGVhbnVwICgpIHtcbiAgICBpZiAodHlwZW9mIHJlbW92ZSA9PSAnZnVuY3Rpb24nKSB7XG4gICAgICByZW1vdmUuY2FsbChzb2NrZXQsICdvcGVuJywgaGFuZGxlT3Blbik7XG4gICAgICByZW1vdmUuY2FsbChzb2NrZXQsICdlcnJvcicsIGhhbmRsZUVycik7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlT3BlbihldnQpIHtcbiAgICBjbGVhbnVwKCk7IGNhbGxiYWNrKCk7XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVFcnIgKGV2dCkge1xuICAgIGNsZWFudXAoKTsgY2FsbGJhY2soZXZ0KTtcbiAgfVxuXG4gIC8vIGlmIHRoZSBzb2NrZXQgaXMgY2xvc2luZyBvciBjbG9zZWQsIHJldHVybiBlbmRcbiAgaWYgKHNvY2tldC5yZWFkeVN0YXRlID49IDIpIHtcbiAgICByZXR1cm4gY2FsbGJhY2sodHJ1ZSk7XG4gIH1cblxuICAvLyBpZiBvcGVuLCB0cmlnZ2VyIHRoZSBjYWxsYmFja1xuICBpZiAoc29ja2V0LnJlYWR5U3RhdGUgPT09IDEpIHtcbiAgICByZXR1cm4gY2FsbGJhY2soKTtcbiAgfVxuXG4gIHNvY2tldC5hZGRFdmVudExpc3RlbmVyKCdvcGVuJywgaGFuZGxlT3Blbik7XG4gIHNvY2tldC5hZGRFdmVudExpc3RlbmVyKCdlcnJvcicsIGhhbmRsZUVycik7XG59O1xuIiwidmFyIHB1bGwgPSByZXF1aXJlKCdwdWxsLWNvcmUnKTtcbnZhciByZWFkeSA9IHJlcXVpcmUoJy4vcmVhZHknKTtcblxuLyoqXG4gICMjIyBgc2luayhzb2NrZXQsIG9wdHM/KWBcblxuICBDcmVhdGUgYSBwdWxsLXN0cmVhbSBgU2lua2AgdGhhdCB3aWxsIHdyaXRlIGRhdGEgdG8gdGhlIGBzb2NrZXRgLlxuXG4gIDw8PCBleGFtcGxlcy93cml0ZS5qc1xuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gcHVsbC5TaW5rKGZ1bmN0aW9uKHJlYWQsIHNvY2tldCwgb3B0cykge1xuICBvcHRzID0gb3B0cyB8fCB7fVxuICB2YXIgY2xvc2VPbkVuZCA9IG9wdHMuY2xvc2VPbkVuZCAhPT0gZmFsc2U7XG4gIHZhciBvbkNsb3NlID0gJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIG9wdHMgPyBvcHRzIDogb3B0cy5vbkNsb3NlO1xuXG4gIGZ1bmN0aW9uIG5leHQoZW5kLCBkYXRhKSB7XG4gICAgLy8gaWYgdGhlIHN0cmVhbSBoYXMgZW5kZWQsIHNpbXBseSByZXR1cm5cbiAgICBpZiAoZW5kKSB7XG4gICAgICBpZiAoY2xvc2VPbkVuZCAmJiBzb2NrZXQucmVhZHlTdGF0ZSA8PSAxKSB7XG4gICAgICAgIGlmKG9uQ2xvc2UpXG4gICAgICAgICAgc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2Nsb3NlJywgZnVuY3Rpb24gKGV2KSB7XG4gICAgICAgICAgICBpZihldi53YXNDbGVhbikgb25DbG9zZSgpXG4gICAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgICAgdmFyIGVyciA9IG5ldyBFcnJvcignd3MgZXJyb3InKVxuICAgICAgICAgICAgICBlcnIuZXZlbnQgPSBldlxuICAgICAgICAgICAgICBvbkNsb3NlKGVycilcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcblxuICAgICAgICBzb2NrZXQuY2xvc2UoKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIHNvY2tldCByZWFkeT9cbiAgICByZWFkeShzb2NrZXQsIGZ1bmN0aW9uKGVuZCkge1xuICAgICAgaWYgKGVuZCkge1xuICAgICAgICByZXR1cm4gcmVhZChlbmQsIGZ1bmN0aW9uICgpIHt9KTtcbiAgICAgIH1cblxuICAgICAgc29ja2V0LnNlbmQoZGF0YSk7XG4gICAgICBwcm9jZXNzLm5leHRUaWNrKGZ1bmN0aW9uKCkge1xuICAgICAgICByZWFkKG51bGwsIG5leHQpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICByZWFkKG51bGwsIG5leHQpO1xufSk7XG4iLCJ2YXIgcHVsbCA9IHJlcXVpcmUoJ3B1bGwtY29yZScpO1xudmFyIHJlYWR5ID0gcmVxdWlyZSgnLi9yZWFkeScpO1xuXG4vKipcbiAgIyMjIGBzb3VyY2Uoc29ja2V0KWBcblxuICBDcmVhdGUgYSBwdWxsLXN0cmVhbSBgU291cmNlYCB0aGF0IHdpbGwgcmVhZCBkYXRhIGZyb20gdGhlIGBzb2NrZXRgLlxuXG4gIDw8PCBleGFtcGxlcy9yZWFkLmpzXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBwdWxsLlNvdXJjZShmdW5jdGlvbihzb2NrZXQpIHtcbiAgdmFyIGJ1ZmZlciA9IFtdO1xuICB2YXIgcmVjZWl2ZXI7XG4gIHZhciBlbmRlZDtcblxuICBzb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignbWVzc2FnZScsIGZ1bmN0aW9uKGV2dCkge1xuICAgIGlmIChyZWNlaXZlcikge1xuICAgICAgcmV0dXJuIHJlY2VpdmVyKG51bGwsIGV2dC5kYXRhKTtcbiAgICB9XG5cbiAgICBidWZmZXIucHVzaChldnQuZGF0YSk7XG4gIH0pO1xuXG4gIHNvY2tldC5hZGRFdmVudExpc3RlbmVyKCdjbG9zZScsIGZ1bmN0aW9uKGV2dCkge1xuICAgIGlmIChlbmRlZCkgcmV0dXJuO1xuICAgIGlmIChyZWNlaXZlcikge1xuICAgICAgcmV0dXJuIHJlY2VpdmVyKGVuZGVkID0gdHJ1ZSk7XG4gICAgfVxuICB9KTtcblxuICBzb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignZXJyb3InLCBmdW5jdGlvbiAoZXZ0KSB7XG4gICAgaWYgKGVuZGVkKSByZXR1cm47XG4gICAgZW5kZWQgPSBldnQ7XG4gICAgaWYgKHJlY2VpdmVyKSB7XG4gICAgICByZWNlaXZlcihlbmRlZCk7XG4gICAgfVxuICB9KTtcblxuICBmdW5jdGlvbiByZWFkKGFib3J0LCBjYikge1xuICAgIHJlY2VpdmVyID0gbnVsbDtcblxuICAgIC8vaWYgc3RyZWFtIGhhcyBhbHJlYWR5IGVuZGVkLlxuICAgIGlmIChlbmRlZClcbiAgICAgIHJldHVybiBjYihlbmRlZClcblxuICAgIC8vIGlmIGVuZGVkLCBhYm9ydFxuICAgIGlmIChhYm9ydCkge1xuICAgICAgLy90aGlzIHdpbGwgY2FsbGJhY2sgd2hlbiBzb2NrZXQgY2xvc2VzXG4gICAgICByZWNlaXZlciA9IGNiXG4gICAgICByZXR1cm4gc29ja2V0LmNsb3NlKClcbiAgICB9XG5cbiAgICByZWFkeShzb2NrZXQsIGZ1bmN0aW9uKGVuZCkge1xuICAgICAgaWYgKGVuZCkge1xuICAgICAgICByZXR1cm4gY2IoZW5kZWQgPSBlbmQpO1xuICAgICAgfVxuXG4gICAgICAvLyByZWFkIGZyb20gdGhlIHNvY2tldFxuICAgICAgaWYgKGVuZGVkICYmIGVuZGVkICE9PSB0cnVlKSB7XG4gICAgICAgIHJldHVybiBjYihlbmRlZCk7XG4gICAgICB9XG4gICAgICBlbHNlIGlmIChidWZmZXIubGVuZ3RoID4gMCkge1xuICAgICAgICByZXR1cm4gY2IobnVsbCwgYnVmZmVyLnNoaWZ0KCkpO1xuICAgICAgfVxuICAgICAgZWxzZSBpZiAoZW5kZWQpIHtcbiAgICAgICAgcmV0dXJuIGNiKHRydWUpO1xuICAgICAgfVxuXG4gICAgICByZWNlaXZlciA9IGNiO1xuICAgIH0pO1xuICB9O1xuXG4gIHJldHVybiByZWFkO1xufSk7XG4iLCJcbi8qKlxuICogTW9kdWxlIGRlcGVuZGVuY2llcy5cbiAqL1xuXG52YXIgZ2xvYmFsID0gKGZ1bmN0aW9uKCkgeyByZXR1cm4gdGhpczsgfSkoKTtcblxuLyoqXG4gKiBXZWJTb2NrZXQgY29uc3RydWN0b3IuXG4gKi9cblxudmFyIFdlYlNvY2tldCA9IGdsb2JhbC5XZWJTb2NrZXQgfHwgZ2xvYmFsLk1veldlYlNvY2tldDtcblxuLyoqXG4gKiBNb2R1bGUgZXhwb3J0cy5cbiAqL1xuXG5tb2R1bGUuZXhwb3J0cyA9IFdlYlNvY2tldCA/IHdzIDogbnVsbDtcblxuLyoqXG4gKiBXZWJTb2NrZXQgY29uc3RydWN0b3IuXG4gKlxuICogVGhlIHRoaXJkIGBvcHRzYCBvcHRpb25zIG9iamVjdCBnZXRzIGlnbm9yZWQgaW4gd2ViIGJyb3dzZXJzLCBzaW5jZSBpdCdzXG4gKiBub24tc3RhbmRhcmQsIGFuZCB0aHJvd3MgYSBUeXBlRXJyb3IgaWYgcGFzc2VkIHRvIHRoZSBjb25zdHJ1Y3Rvci5cbiAqIFNlZTogaHR0cHM6Ly9naXRodWIuY29tL2VpbmFyb3Mvd3MvaXNzdWVzLzIyN1xuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSB1cmlcbiAqIEBwYXJhbSB7QXJyYXl9IHByb3RvY29scyAob3B0aW9uYWwpXG4gKiBAcGFyYW0ge09iamVjdCkgb3B0cyAob3B0aW9uYWwpXG4gKiBAYXBpIHB1YmxpY1xuICovXG5cbmZ1bmN0aW9uIHdzKHVyaSwgcHJvdG9jb2xzLCBvcHRzKSB7XG4gIHZhciBpbnN0YW5jZTtcbiAgaWYgKHByb3RvY29scykge1xuICAgIGluc3RhbmNlID0gbmV3IFdlYlNvY2tldCh1cmksIHByb3RvY29scyk7XG4gIH0gZWxzZSB7XG4gICAgaW5zdGFuY2UgPSBuZXcgV2ViU29ja2V0KHVyaSk7XG4gIH1cbiAgcmV0dXJuIGluc3RhbmNlO1xufVxuXG5pZiAoV2ViU29ja2V0KSB3cy5wcm90b3R5cGUgPSBXZWJTb2NrZXQucHJvdG90eXBlO1xuIiwidmFyIHJlSHR0cFVybCA9IC9eaHR0cCguKikkLztcblxuLyoqXG4gICMgd3N1cmxcblxuICBHaXZlbiBhIHVybCAoaW5jbHVkaW5nIHByb3RvY29sIHJlbGF0aXZlIHVybHMgLSBpLmUuIGAvL2ApLCBnZW5lcmF0ZSBhbiBhcHByb3ByaWF0ZVxuICB1cmwgZm9yIGEgV2ViU29ja2V0IGVuZHBvaW50IChgd3NgIG9yIGB3c3NgKS5cblxuICAjIyBFeGFtcGxlIFVzYWdlXG5cbiAgPDw8IGV4YW1wbGVzL3JlbGF0aXZlLmpzXG5cbioqL1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHVybCwgb3B0cykge1xuICB2YXIgY3VycmVudCA9IChvcHRzIHx8IHt9KS5jdXJyZW50IHx8ICh0eXBlb2YgbG9jYXRpb24gIT0gJ3VuZGVmaW5lZCcgJiYgbG9jYXRpb24uaHJlZik7XG4gIHZhciBjdXJyZW50UHJvdG9jb2wgPSBjdXJyZW50ICYmIGN1cnJlbnQuc2xpY2UoMCwgY3VycmVudC5pbmRleE9mKCc6JykpO1xuICB2YXIgaW5zZWN1cmUgPSAob3B0cyB8fCB7fSkuaW5zZWN1cmU7XG4gIHZhciBpc1JlbGF0aXZlID0gdXJsLnNsaWNlKDAsIDIpID09ICcvLyc7XG4gIHZhciBmb3JjZVdTID0gKCEgY3VycmVudFByb3RvY29sKSB8fCBjdXJyZW50UHJvdG9jb2wgPT09ICdmaWxlOic7XG5cbiAgaWYgKGlzUmVsYXRpdmUpIHtcbiAgICByZXR1cm4gZm9yY2VXUyA/XG4gICAgICAoKGluc2VjdXJlID8gJ3dzOicgOiAnd3NzOicpICsgdXJsKSA6XG4gICAgICAoY3VycmVudFByb3RvY29sLnJlcGxhY2UocmVIdHRwVXJsLCAnd3MkMScpICsgJzonICsgdXJsKTtcbiAgfVxuXG4gIHJldHVybiB1cmwucmVwbGFjZShyZUh0dHBVcmwsICd3cyQxJyk7XG59O1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIGRlYnVnID0gcmVxdWlyZSgnY29nL2xvZ2dlcicpKCdydGMvY2xlYW51cCcpO1xuXG52YXIgQ0FOTk9UX0NMT1NFX1NUQVRFUyA9IFtcbiAgJ2Nsb3NlZCdcbl07XG5cbnZhciBFVkVOVFNfREVDT1VQTEVfQkMgPSBbXG4gICdhZGRzdHJlYW0nLFxuICAnZGF0YWNoYW5uZWwnLFxuICAnaWNlY2FuZGlkYXRlJyxcbiAgJ25lZ290aWF0aW9ubmVlZGVkJyxcbiAgJ3JlbW92ZXN0cmVhbScsXG4gICdzaWduYWxpbmdzdGF0ZWNoYW5nZSdcbl07XG5cbnZhciBFVkVOVFNfREVDT1VQTEVfQUMgPSBbXG4gICdpY2Vjb25uZWN0aW9uc3RhdGVjaGFuZ2UnXG5dO1xuXG4vKipcbiAgIyMjIHJ0Yy10b29scy9jbGVhbnVwXG5cbiAgYGBgXG4gIGNsZWFudXAocGMpXG4gIGBgYFxuXG4gIFRoZSBgY2xlYW51cGAgZnVuY3Rpb24gaXMgdXNlZCB0byBlbnN1cmUgdGhhdCBhIHBlZXIgY29ubmVjdGlvbiBpcyBwcm9wZXJseVxuICBjbG9zZWQgYW5kIHJlYWR5IHRvIGJlIGNsZWFuZWQgdXAgYnkgdGhlIGJyb3dzZXIuXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihwYykge1xuICAvLyBzZWUgaWYgd2UgY2FuIGNsb3NlIHRoZSBjb25uZWN0aW9uXG4gIHZhciBjdXJyZW50U3RhdGUgPSBwYy5pY2VDb25uZWN0aW9uU3RhdGU7XG4gIHZhciBjYW5DbG9zZSA9IENBTk5PVF9DTE9TRV9TVEFURVMuaW5kZXhPZihjdXJyZW50U3RhdGUpIDwgMDtcblxuICBmdW5jdGlvbiBkZWNvdXBsZShldmVudHMpIHtcbiAgICBldmVudHMuZm9yRWFjaChmdW5jdGlvbihldnROYW1lKSB7XG4gICAgICBpZiAocGNbJ29uJyArIGV2dE5hbWVdKSB7XG4gICAgICAgIHBjWydvbicgKyBldnROYW1lXSA9IG51bGw7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvLyBkZWNvdXBsZSBcImJlZm9yZSBjbG9zZVwiIGV2ZW50c1xuICBkZWNvdXBsZShFVkVOVFNfREVDT1VQTEVfQkMpO1xuXG4gIGlmIChjYW5DbG9zZSkge1xuICAgIGRlYnVnKCdhdHRlbXB0aW5nIGNvbm5lY3Rpb24gY2xvc2UsIGN1cnJlbnQgc3RhdGU6ICcrIHBjLmljZUNvbm5lY3Rpb25TdGF0ZSk7XG4gICAgcGMuY2xvc2UoKTtcbiAgfVxuXG4gIC8vIHJlbW92ZSB0aGUgZXZlbnQgbGlzdGVuZXJzXG4gIC8vIGFmdGVyIGEgc2hvcnQgZGVsYXkgZ2l2aW5nIHRoZSBjb25uZWN0aW9uIHRpbWUgdG8gdHJpZ2dlclxuICAvLyBjbG9zZSBhbmQgaWNlY29ubmVjdGlvbnN0YXRlY2hhbmdlIGV2ZW50c1xuICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgIGRlY291cGxlKEVWRU5UU19ERUNPVVBMRV9BQyk7XG4gIH0sIDEwMCk7XG59O1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIG1idXMgPSByZXF1aXJlKCdtYnVzJyk7XG52YXIgcXVldWUgPSByZXF1aXJlKCdydGMtdGFza3F1ZXVlJyk7XG52YXIgY2xlYW51cCA9IHJlcXVpcmUoJy4vY2xlYW51cCcpO1xudmFyIG1vbml0b3IgPSByZXF1aXJlKCcuL21vbml0b3InKTtcbnZhciB0aHJvdHRsZSA9IHJlcXVpcmUoJ2NvZy90aHJvdHRsZScpO1xudmFyIENMT1NFRF9TVEFURVMgPSBbICdjbG9zZWQnLCAnZmFpbGVkJyBdO1xudmFyIENIRUNLSU5HX1NUQVRFUyA9IFsgJ2NoZWNraW5nJyBdO1xuXG4vKipcbiAgIyMjIHJ0Yy10b29scy9jb3VwbGVcblxuICAjIyMjIGNvdXBsZShwYywgdGFyZ2V0SWQsIHNpZ25hbGxlciwgb3B0cz8pXG5cbiAgQ291cGxlIGEgV2ViUlRDIGNvbm5lY3Rpb24gd2l0aCBhbm90aGVyIHdlYnJ0YyBjb25uZWN0aW9uIGlkZW50aWZpZWQgYnlcbiAgYHRhcmdldElkYCB2aWEgdGhlIHNpZ25hbGxlci5cblxuICBUaGUgZm9sbG93aW5nIG9wdGlvbnMgY2FuIGJlIHByb3ZpZGVkIGluIHRoZSBgb3B0c2AgYXJndW1lbnQ6XG5cbiAgLSBgc2RwZmlsdGVyYCAoZGVmYXVsdDogbnVsbClcblxuICAgIEEgc2ltcGxlIGZ1bmN0aW9uIGZvciBmaWx0ZXJpbmcgU0RQIGFzIHBhcnQgb2YgdGhlIHBlZXJcbiAgICBjb25uZWN0aW9uIGhhbmRzaGFrZSAoc2VlIHRoZSBVc2luZyBGaWx0ZXJzIGRldGFpbHMgYmVsb3cpLlxuXG4gICMjIyMjIEV4YW1wbGUgVXNhZ2VcblxuICBgYGBqc1xuICB2YXIgY291cGxlID0gcmVxdWlyZSgncnRjL2NvdXBsZScpO1xuXG4gIGNvdXBsZShwYywgJzU0ODc5OTY1LWNlNDMtNDI2ZS1hOGVmLTA5YWMxZTM5YTE2ZCcsIHNpZ25hbGxlcik7XG4gIGBgYFxuXG4gICMjIyMjIFVzaW5nIEZpbHRlcnNcblxuICBJbiBjZXJ0YWluIGluc3RhbmNlcyB5b3UgbWF5IHdpc2ggdG8gbW9kaWZ5IHRoZSByYXcgU0RQIHRoYXQgaXMgcHJvdmlkZWRcbiAgYnkgdGhlIGBjcmVhdGVPZmZlcmAgYW5kIGBjcmVhdGVBbnN3ZXJgIGNhbGxzLiAgVGhpcyBjYW4gYmUgZG9uZSBieSBwYXNzaW5nXG4gIGEgYHNkcGZpbHRlcmAgZnVuY3Rpb24gKG9yIGFycmF5KSBpbiB0aGUgb3B0aW9ucy4gIEZvciBleGFtcGxlOlxuXG4gIGBgYGpzXG4gIC8vIHJ1biB0aGUgc2RwIGZyb20gdGhyb3VnaCBhIGxvY2FsIHR3ZWFrU2RwIGZ1bmN0aW9uLlxuICBjb3VwbGUocGMsICc1NDg3OTk2NS1jZTQzLTQyNmUtYThlZi0wOWFjMWUzOWExNmQnLCBzaWduYWxsZXIsIHtcbiAgICBzZHBmaWx0ZXI6IHR3ZWFrU2RwXG4gIH0pO1xuICBgYGBcblxuKiovXG5mdW5jdGlvbiBjb3VwbGUocGMsIHRhcmdldElkLCBzaWduYWxsZXIsIG9wdHMpIHtcbiAgdmFyIGRlYnVnTGFiZWwgPSAob3B0cyB8fCB7fSkuZGVidWdMYWJlbCB8fCAncnRjJztcbiAgdmFyIGRlYnVnID0gcmVxdWlyZSgnY29nL2xvZ2dlcicpKGRlYnVnTGFiZWwgKyAnL2NvdXBsZScpO1xuXG4gIC8vIGNyZWF0ZSBhIG1vbml0b3IgZm9yIHRoZSBjb25uZWN0aW9uXG4gIHZhciBtb24gPSBtb25pdG9yKHBjLCB0YXJnZXRJZCwgc2lnbmFsbGVyLCAob3B0cyB8fCB7fSkubG9nZ2VyKTtcbiAgdmFyIGVtaXQgPSBtYnVzKCcnLCBtb24pO1xuICB2YXIgcmVhY3RpdmUgPSAob3B0cyB8fCB7fSkucmVhY3RpdmU7XG4gIHZhciBlbmRPZkNhbmRpZGF0ZXMgPSB0cnVlO1xuXG4gIC8vIGNvbmZpZ3VyZSB0aGUgdGltZSB0byB3YWl0IGJldHdlZW4gcmVjZWl2aW5nIGEgJ2Rpc2Nvbm5lY3QnXG4gIC8vIGljZUNvbm5lY3Rpb25TdGF0ZSBhbmQgZGV0ZXJtaW5pbmcgdGhhdCB3ZSBhcmUgY2xvc2VkXG4gIHZhciBkaXNjb25uZWN0VGltZW91dCA9IChvcHRzIHx8IHt9KS5kaXNjb25uZWN0VGltZW91dCB8fCAxMDAwMDtcbiAgdmFyIGRpc2Nvbm5lY3RUaW1lcjtcblxuICAvLyBpbml0aWxhaXNlIHRoZSBuZWdvdGlhdGlvbiBoZWxwZXJzXG4gIHZhciBpc01hc3RlciA9IHNpZ25hbGxlci5pc01hc3Rlcih0YXJnZXRJZCk7XG5cbiAgLy8gaW5pdGlhbGlzZSB0aGUgcHJvY2Vzc2luZyBxdWV1ZSAob25lIGF0IGEgdGltZSBwbGVhc2UpXG4gIHZhciBxID0gcXVldWUocGMsIG9wdHMpO1xuXG4gIHZhciBjcmVhdGVPclJlcXVlc3RPZmZlciA9IHRocm90dGxlKGZ1bmN0aW9uKCkge1xuICAgIGlmICghIGlzTWFzdGVyKSB7XG4gICAgICByZXR1cm4gc2lnbmFsbGVyLnRvKHRhcmdldElkKS5zZW5kKCcvbmVnb3RpYXRlJyk7XG4gICAgfVxuXG4gICAgcS5jcmVhdGVPZmZlcigpO1xuICB9LCAxMDAsIHsgbGVhZGluZzogZmFsc2UgfSk7XG5cbiAgdmFyIGRlYm91bmNlT2ZmZXIgPSB0aHJvdHRsZShxLmNyZWF0ZU9mZmVyLCAxMDAsIHsgbGVhZGluZzogZmFsc2UgfSk7XG5cbiAgZnVuY3Rpb24gZGVjb3VwbGUoKSB7XG4gICAgZGVidWcoJ2RlY291cGxpbmcgJyArIHNpZ25hbGxlci5pZCArICcgZnJvbSAnICsgdGFyZ2V0SWQpO1xuXG4gICAgLy8gc3RvcCB0aGUgbW9uaXRvclxuLy8gICAgIG1vbi5yZW1vdmVBbGxMaXN0ZW5lcnMoKTtcbiAgICBtb24uc3RvcCgpO1xuXG4gICAgLy8gY2xlYW51cCB0aGUgcGVlcmNvbm5lY3Rpb25cbiAgICBjbGVhbnVwKHBjKTtcblxuICAgIC8vIHJlbW92ZSBsaXN0ZW5lcnNcbiAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ3NkcCcsIGhhbmRsZVNkcCk7XG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdjYW5kaWRhdGUnLCBoYW5kbGVDYW5kaWRhdGUpO1xuICAgIHNpZ25hbGxlci5yZW1vdmVMaXN0ZW5lcignbmVnb3RpYXRlJywgaGFuZGxlTmVnb3RpYXRlUmVxdWVzdCk7XG5cbiAgICAvLyByZW1vdmUgbGlzdGVuZXJzICh2ZXJzaW9uID49IDUpXG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdtZXNzYWdlOnNkcCcsIGhhbmRsZVNkcCk7XG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdtZXNzYWdlOmNhbmRpZGF0ZScsIGhhbmRsZUNhbmRpZGF0ZSk7XG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdtZXNzYWdlOm5lZ290aWF0ZScsIGhhbmRsZU5lZ290aWF0ZVJlcXVlc3QpO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlQ2FuZGlkYXRlKGRhdGEpIHtcbiAgICBxLmFkZEljZUNhbmRpZGF0ZShkYXRhKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZVNkcChzZHAsIHNyYykge1xuICAgIGVtaXQoJ3NkcC5yZW1vdGUnLCBzZHApO1xuXG4gICAgLy8gaWYgdGhlIHNvdXJjZSBpcyB1bmtub3duIG9yIG5vdCBhIG1hdGNoLCB0aGVuIGRvbid0IHByb2Nlc3NcbiAgICBpZiAoKCEgc3JjKSB8fCAoc3JjLmlkICE9PSB0YXJnZXRJZCkpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBxLnNldFJlbW90ZURlc2NyaXB0aW9uKHNkcCk7XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVDb25uZWN0aW9uQ2xvc2UoKSB7XG4gICAgZGVidWcoJ2NhcHR1cmVkIHBjIGNsb3NlLCBpY2VDb25uZWN0aW9uU3RhdGUgPSAnICsgcGMuaWNlQ29ubmVjdGlvblN0YXRlKTtcbiAgICBkZWNvdXBsZSgpO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlRGlzY29ubmVjdCgpIHtcbiAgICBkZWJ1ZygnY2FwdHVyZWQgcGMgZGlzY29ubmVjdCwgbW9uaXRvcmluZyBjb25uZWN0aW9uIHN0YXR1cycpO1xuXG4gICAgLy8gc3RhcnQgdGhlIGRpc2Nvbm5lY3QgdGltZXJcbiAgICBkaXNjb25uZWN0VGltZXIgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgZGVidWcoJ21hbnVhbGx5IGNsb3NpbmcgY29ubmVjdGlvbiBhZnRlciBkaXNjb25uZWN0IHRpbWVvdXQnKTtcbiAgICAgIGNsZWFudXAocGMpO1xuICAgIH0sIGRpc2Nvbm5lY3RUaW1lb3V0KTtcblxuICAgIG1vbi5vbignc3RhdGVjaGFuZ2UnLCBoYW5kbGVEaXNjb25uZWN0QWJvcnQpO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlRGlzY29ubmVjdEFib3J0KCkge1xuICAgIGRlYnVnKCdjb25uZWN0aW9uIHN0YXRlIGNoYW5nZWQgdG86ICcgKyBwYy5pY2VDb25uZWN0aW9uU3RhdGUpO1xuXG4gICAgLy8gaWYgdGhlIHN0YXRlIGlzIGNoZWNraW5nLCB0aGVuIGRvIG5vdCByZXNldCB0aGUgZGlzY29ubmVjdCB0aW1lciBhc1xuICAgIC8vIHdlIGFyZSBkb2luZyBvdXIgb3duIGNoZWNraW5nXG4gICAgaWYgKENIRUNLSU5HX1NUQVRFUy5pbmRleE9mKHBjLmljZUNvbm5lY3Rpb25TdGF0ZSkgPj0gMCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHJlc2V0RGlzY29ubmVjdFRpbWVyKCk7XG5cbiAgICAvLyBpZiB3ZSBoYXZlIGEgY2xvc2VkIG9yIGZhaWxlZCBzdGF0dXMsIHRoZW4gY2xvc2UgdGhlIGNvbm5lY3Rpb25cbiAgICBpZiAoQ0xPU0VEX1NUQVRFUy5pbmRleE9mKHBjLmljZUNvbm5lY3Rpb25TdGF0ZSkgPj0gMCkge1xuICAgICAgcmV0dXJuIG1vbignY2xvc2VkJyk7XG4gICAgfVxuXG4gICAgbW9uLm9uY2UoJ2Rpc2Nvbm5lY3QnLCBoYW5kbGVEaXNjb25uZWN0KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZUxvY2FsQ2FuZGlkYXRlKGV2dCkge1xuICAgIHZhciBkYXRhO1xuXG4gICAgaWYgKGV2dC5jYW5kaWRhdGUpIHtcbiAgICAgIHJlc2V0RGlzY29ubmVjdFRpbWVyKCk7XG5cbiAgICAgIC8vIGZvcm11bGF0ZSBpbnRvIGEgc3BlY2lmaWMgZGF0YSBvYmplY3Qgc28gd2Ugd29uJ3QgYmUgdXBzZXQgYnkgcGx1Z2luXG4gICAgICAvLyBzcGVjaWZpYyBpbXBsZW1lbnRhdGlvbnMgb2YgdGhlIGNhbmRpZGF0ZSBkYXRhIGZvcm1hdCAoaS5lLiBleHRyYSBmaWVsZHMpXG4gICAgICBkYXRhID0ge1xuICAgICAgICBjYW5kaWRhdGU6IGV2dC5jYW5kaWRhdGUuY2FuZGlkYXRlLFxuICAgICAgICBzZHBNaWQ6IGV2dC5jYW5kaWRhdGUuc2RwTWlkLFxuICAgICAgICBzZHBNTGluZUluZGV4OiBldnQuY2FuZGlkYXRlLnNkcE1MaW5lSW5kZXhcbiAgICAgIH07XG5cbiAgICAgIGVtaXQoJ2ljZS5sb2NhbCcsIGRhdGEpO1xuICAgICAgc2lnbmFsbGVyLnRvKHRhcmdldElkKS5zZW5kKCcvY2FuZGlkYXRlJywgZGF0YSk7XG4gICAgICBlbmRPZkNhbmRpZGF0ZXMgPSBmYWxzZTtcbiAgICB9XG4gICAgZWxzZSBpZiAoISBlbmRPZkNhbmRpZGF0ZXMpIHtcbiAgICAgIGVuZE9mQ2FuZGlkYXRlcyA9IHRydWU7XG4gICAgICBlbWl0KCdpY2UuZ2F0aGVyY29tcGxldGUnKTtcbiAgICAgIHNpZ25hbGxlci50byh0YXJnZXRJZCkuc2VuZCgnL2VuZG9mY2FuZGlkYXRlcycsIHt9KTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVOZWdvdGlhdGVSZXF1ZXN0KHNyYykge1xuICAgIGlmIChzcmMuaWQgPT09IHRhcmdldElkKSB7XG4gICAgICBlbWl0KCduZWdvdGlhdGUucmVxdWVzdCcsIHNyYy5pZCk7XG4gICAgICBkZWJvdW5jZU9mZmVyKCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gcmVzZXREaXNjb25uZWN0VGltZXIoKSB7XG4gICAgbW9uLm9mZignc3RhdGVjaGFuZ2UnLCBoYW5kbGVEaXNjb25uZWN0QWJvcnQpO1xuXG4gICAgLy8gY2xlYXIgdGhlIGRpc2Nvbm5lY3QgdGltZXJcbiAgICBkZWJ1ZygncmVzZXQgZGlzY29ubmVjdCB0aW1lciwgc3RhdGU6ICcgKyBwYy5pY2VDb25uZWN0aW9uU3RhdGUpO1xuICAgIGNsZWFyVGltZW91dChkaXNjb25uZWN0VGltZXIpO1xuICB9XG5cbiAgLy8gd2hlbiByZWdvdGlhdGlvbiBpcyBuZWVkZWQgbG9vayBmb3IgdGhlIHBlZXJcbiAgaWYgKHJlYWN0aXZlKSB7XG4gICAgcGMub25uZWdvdGlhdGlvbm5lZWRlZCA9IGZ1bmN0aW9uKCkge1xuICAgICAgZW1pdCgnbmVnb3RpYXRlLnJlbmVnb3RpYXRlJyk7XG4gICAgICBjcmVhdGVPclJlcXVlc3RPZmZlcigpO1xuICAgIH07XG4gIH1cblxuICBwYy5vbmljZWNhbmRpZGF0ZSA9IGhhbmRsZUxvY2FsQ2FuZGlkYXRlO1xuXG4gIC8vIHdoZW4gdGhlIHRhc2sgcXVldWUgdGVsbHMgdXMgd2UgaGF2ZSBzZHAgYXZhaWxhYmxlLCBzZW5kIHRoYXQgb3ZlciB0aGUgd2lyZVxuICBxLm9uKCdzZHAubG9jYWwnLCBmdW5jdGlvbihkZXNjKSB7XG4gICAgc2lnbmFsbGVyLnRvKHRhcmdldElkKS5zZW5kKCcvc2RwJywgZGVzYyk7XG4gIH0pO1xuXG4gIC8vIHdoZW4gd2UgcmVjZWl2ZSBzZHAsIHRoZW5cbiAgc2lnbmFsbGVyLm9uKCdzZHAnLCBoYW5kbGVTZHApO1xuICBzaWduYWxsZXIub24oJ2NhbmRpZGF0ZScsIGhhbmRsZUNhbmRpZGF0ZSk7XG5cbiAgLy8gbGlzdGVuZXJzIChzaWduYWxsZXIgPj0gNSlcbiAgc2lnbmFsbGVyLm9uKCdtZXNzYWdlOnNkcCcsIGhhbmRsZVNkcCk7XG4gIHNpZ25hbGxlci5vbignbWVzc2FnZTpjYW5kaWRhdGUnLCBoYW5kbGVDYW5kaWRhdGUpO1xuXG4gIC8vIGlmIHRoaXMgaXMgYSBtYXN0ZXIgY29ubmVjdGlvbiwgbGlzdGVuIGZvciBuZWdvdGlhdGUgZXZlbnRzXG4gIGlmIChpc01hc3Rlcikge1xuICAgIHNpZ25hbGxlci5vbignbmVnb3RpYXRlJywgaGFuZGxlTmVnb3RpYXRlUmVxdWVzdCk7XG4gICAgc2lnbmFsbGVyLm9uKCdtZXNzYWdlOm5lZ290aWF0ZScsIGhhbmRsZU5lZ290aWF0ZVJlcXVlc3QpOyAvLyBzaWduYWxsZXIgPj0gNVxuICB9XG5cbiAgLy8gd2hlbiB0aGUgY29ubmVjdGlvbiBjbG9zZXMsIHJlbW92ZSBldmVudCBoYW5kbGVyc1xuICBtb24ub25jZSgnY2xvc2VkJywgaGFuZGxlQ29ubmVjdGlvbkNsb3NlKTtcbiAgbW9uLm9uY2UoJ2Rpc2Nvbm5lY3RlZCcsIGhhbmRsZURpc2Nvbm5lY3QpO1xuXG4gIC8vIHBhdGNoIGluIHRoZSBjcmVhdGUgb2ZmZXIgZnVuY3Rpb25zXG4gIG1vbi5jcmVhdGVPZmZlciA9IGNyZWF0ZU9yUmVxdWVzdE9mZmVyO1xuXG4gIHJldHVybiBtb247XG59XG5cbm1vZHVsZS5leHBvcnRzID0gY291cGxlO1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxuLyoqXG4gICMjIyBydGMtdG9vbHMvZGV0ZWN0XG5cbiAgUHJvdmlkZSB0aGUgW3J0Yy1jb3JlL2RldGVjdF0oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMtY29yZSNkZXRlY3QpXG4gIGZ1bmN0aW9uYWxpdHkuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gcmVxdWlyZSgncnRjLWNvcmUvZGV0ZWN0Jyk7XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG52YXIgZGVidWcgPSByZXF1aXJlKCdjb2cvbG9nZ2VyJykoJ2dlbmVyYXRvcnMnKTtcbnZhciBkZXRlY3QgPSByZXF1aXJlKCcuL2RldGVjdCcpO1xudmFyIGRlZmF1bHRzID0gcmVxdWlyZSgnY29nL2RlZmF1bHRzJyk7XG5cbnZhciBtYXBwaW5ncyA9IHtcbiAgY3JlYXRlOiB7XG4gICAgZHRsczogZnVuY3Rpb24oYykge1xuICAgICAgaWYgKCEgZGV0ZWN0Lm1veikge1xuICAgICAgICBjLm9wdGlvbmFsID0gKGMub3B0aW9uYWwgfHwgW10pLmNvbmNhdCh7IER0bHNTcnRwS2V5QWdyZWVtZW50OiB0cnVlIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxufTtcblxuLyoqXG4gICMjIyBydGMtdG9vbHMvZ2VuZXJhdG9yc1xuXG4gIFRoZSBnZW5lcmF0b3JzIHBhY2thZ2UgcHJvdmlkZXMgc29tZSB1dGlsaXR5IG1ldGhvZHMgZm9yIGdlbmVyYXRpbmdcbiAgY29uc3RyYWludCBvYmplY3RzIGFuZCBzaW1pbGFyIGNvbnN0cnVjdHMuXG5cbiAgYGBganNcbiAgdmFyIGdlbmVyYXRvcnMgPSByZXF1aXJlKCdydGMvZ2VuZXJhdG9ycycpO1xuICBgYGBcblxuKiovXG5cbi8qKlxuICAjIyMjIGdlbmVyYXRvcnMuY29uZmlnKGNvbmZpZylcblxuICBHZW5lcmF0ZSBhIGNvbmZpZ3VyYXRpb24gb2JqZWN0IHN1aXRhYmxlIGZvciBwYXNzaW5nIGludG8gYW4gVzNDXG4gIFJUQ1BlZXJDb25uZWN0aW9uIGNvbnN0cnVjdG9yIGZpcnN0IGFyZ3VtZW50LCBiYXNlZCBvbiBvdXIgY3VzdG9tIGNvbmZpZy5cblxuICBJbiB0aGUgZXZlbnQgdGhhdCB5b3UgdXNlIHNob3J0IHRlcm0gYXV0aGVudGljYXRpb24gZm9yIFRVUk4sIGFuZCB5b3Ugd2FudFxuICB0byBnZW5lcmF0ZSBuZXcgYGljZVNlcnZlcnNgIHJlZ3VsYXJseSwgeW91IGNhbiBzcGVjaWZ5IGFuIGljZVNlcnZlckdlbmVyYXRvclxuICB0aGF0IHdpbGwgYmUgdXNlZCBwcmlvciB0byBjb3VwbGluZy4gVGhpcyBnZW5lcmF0b3Igc2hvdWxkIHJldHVybiBhIGZ1bGx5XG4gIGNvbXBsaWFudCBXM0MgKFJUQ0ljZVNlcnZlciBkaWN0aW9uYXJ5KVtodHRwOi8vd3d3LnczLm9yZy9UUi93ZWJydGMvI2lkbC1kZWYtUlRDSWNlU2VydmVyXS5cblxuICBJZiB5b3UgcGFzcyBpbiBib3RoIGEgZ2VuZXJhdG9yIGFuZCBpY2VTZXJ2ZXJzLCB0aGUgaWNlU2VydmVycyBfd2lsbCBiZVxuICBpZ25vcmVkIGFuZCB0aGUgZ2VuZXJhdG9yIHVzZWQgaW5zdGVhZC5cbioqL1xuXG5leHBvcnRzLmNvbmZpZyA9IGZ1bmN0aW9uKGNvbmZpZykge1xuICB2YXIgaWNlU2VydmVyR2VuZXJhdG9yID0gKGNvbmZpZyB8fCB7fSkuaWNlU2VydmVyR2VuZXJhdG9yO1xuXG4gIHJldHVybiBkZWZhdWx0cyh7fSwgY29uZmlnLCB7XG4gICAgaWNlU2VydmVyczogdHlwZW9mIGljZVNlcnZlckdlbmVyYXRvciA9PSAnZnVuY3Rpb24nID8gaWNlU2VydmVyR2VuZXJhdG9yKCkgOiBbXVxuICB9KTtcbn07XG5cbi8qKlxuICAjIyMjIGdlbmVyYXRvcnMuY29ubmVjdGlvbkNvbnN0cmFpbnRzKGZsYWdzLCBjb25zdHJhaW50cylcblxuICBUaGlzIGlzIGEgaGVscGVyIGZ1bmN0aW9uIHRoYXQgd2lsbCBnZW5lcmF0ZSBhcHByb3ByaWF0ZSBjb25uZWN0aW9uXG4gIGNvbnN0cmFpbnRzIGZvciBhIG5ldyBgUlRDUGVlckNvbm5lY3Rpb25gIG9iamVjdCB3aGljaCBpcyBjb25zdHJ1Y3RlZFxuICBpbiB0aGUgZm9sbG93aW5nIHdheTpcblxuICBgYGBqc1xuICB2YXIgY29ubiA9IG5ldyBSVENQZWVyQ29ubmVjdGlvbihmbGFncywgY29uc3RyYWludHMpO1xuICBgYGBcblxuICBJbiBtb3N0IGNhc2VzIHRoZSBjb25zdHJhaW50cyBvYmplY3QgY2FuIGJlIGxlZnQgZW1wdHksIGJ1dCB3aGVuIGNyZWF0aW5nXG4gIGRhdGEgY2hhbm5lbHMgc29tZSBhZGRpdGlvbmFsIG9wdGlvbnMgYXJlIHJlcXVpcmVkLiAgVGhpcyBmdW5jdGlvblxuICBjYW4gZ2VuZXJhdGUgdGhvc2UgYWRkaXRpb25hbCBvcHRpb25zIGFuZCBpbnRlbGxpZ2VudGx5IGNvbWJpbmUgYW55XG4gIHVzZXIgZGVmaW5lZCBjb25zdHJhaW50cyAoaW4gYGNvbnN0cmFpbnRzYCkgd2l0aCBzaG9ydGhhbmQgZmxhZ3MgdGhhdFxuICBtaWdodCBiZSBwYXNzZWQgd2hpbGUgdXNpbmcgdGhlIGBydGMuY3JlYXRlQ29ubmVjdGlvbmAgaGVscGVyLlxuKiovXG5leHBvcnRzLmNvbm5lY3Rpb25Db25zdHJhaW50cyA9IGZ1bmN0aW9uKGZsYWdzLCBjb25zdHJhaW50cykge1xuICB2YXIgZ2VuZXJhdGVkID0ge307XG4gIHZhciBtID0gbWFwcGluZ3MuY3JlYXRlO1xuICB2YXIgb3V0O1xuXG4gIC8vIGl0ZXJhdGUgdGhyb3VnaCB0aGUgZmxhZ3MgYW5kIGFwcGx5IHRoZSBjcmVhdGUgbWFwcGluZ3NcbiAgT2JqZWN0LmtleXMoZmxhZ3MgfHwge30pLmZvckVhY2goZnVuY3Rpb24oa2V5KSB7XG4gICAgaWYgKG1ba2V5XSkge1xuICAgICAgbVtrZXldKGdlbmVyYXRlZCk7XG4gICAgfVxuICB9KTtcblxuICAvLyBnZW5lcmF0ZSB0aGUgY29ubmVjdGlvbiBjb25zdHJhaW50c1xuICBvdXQgPSBkZWZhdWx0cyh7fSwgY29uc3RyYWludHMsIGdlbmVyYXRlZCk7XG4gIGRlYnVnKCdnZW5lcmF0ZWQgY29ubmVjdGlvbiBjb25zdHJhaW50czogJywgb3V0KTtcblxuICByZXR1cm4gb3V0O1xufTtcbiIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG5cbid1c2Ugc3RyaWN0JztcblxuLyoqXG4gICMgcnRjLXRvb2xzXG5cbiAgVGhlIGBydGMtdG9vbHNgIG1vZHVsZSBkb2VzIG1vc3Qgb2YgdGhlIGhlYXZ5IGxpZnRpbmcgd2l0aGluIHRoZVxuICBbcnRjLmlvXShodHRwOi8vcnRjLmlvKSBzdWl0ZS4gIFByaW1hcmlseSBpdCBoYW5kbGVzIHRoZSBsb2dpYyBvZiBjb3VwbGluZ1xuICBhIGxvY2FsIGBSVENQZWVyQ29ubmVjdGlvbmAgd2l0aCBpdCdzIHJlbW90ZSBjb3VudGVycGFydCB2aWEgYW5cbiAgW3J0Yy1zaWduYWxsZXJdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLXNpZ25hbGxlcikgc2lnbmFsbGluZ1xuICBjaGFubmVsLlxuXG4gICMjIEdldHRpbmcgU3RhcnRlZFxuXG4gIElmIHlvdSBkZWNpZGUgdGhhdCB0aGUgYHJ0Yy10b29sc2AgbW9kdWxlIGlzIGEgYmV0dGVyIGZpdCBmb3IgeW91IHRoYW4gZWl0aGVyXG4gIFtydGMtcXVpY2tjb25uZWN0XShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0Yy1xdWlja2Nvbm5lY3QpIG9yXG4gIFtydGNdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjKSB0aGVuIHRoZSBjb2RlIHNuaXBwZXQgYmVsb3dcbiAgd2lsbCBwcm92aWRlIHlvdSBhIGd1aWRlIG9uIGhvdyB0byBnZXQgc3RhcnRlZCB1c2luZyBpdCBpbiBjb25qdW5jdGlvbiB3aXRoXG4gIHRoZSBbcnRjLXNpZ25hbGxlcl0oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMtc2lnbmFsbGVyKSAodmVyc2lvbiA1LjAgYW5kIGFib3ZlKVxuICBhbmQgW3J0Yy1tZWRpYV0oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMtbWVkaWEpIG1vZHVsZXM6XG5cbiAgPDw8IGV4YW1wbGVzL2dldHRpbmctc3RhcnRlZC5qc1xuXG4gIFRoaXMgY29kZSBkZWZpbml0ZWx5IGRvZXNuJ3QgY292ZXIgYWxsIHRoZSBjYXNlcyB0aGF0IHlvdSBuZWVkIHRvIGNvbnNpZGVyXG4gIChpLmUuIHBlZXJzIGxlYXZpbmcsIGV0YykgYnV0IGl0IHNob3VsZCBkZW1vbnN0cmF0ZSBob3cgdG86XG5cbiAgMS4gQ2FwdHVyZSB2aWRlbyBhbmQgYWRkIGl0IHRvIGEgcGVlciBjb25uZWN0aW9uXG4gIDIuIENvdXBsZSBhIGxvY2FsIHBlZXIgY29ubmVjdGlvbiB3aXRoIGEgcmVtb3RlIHBlZXIgY29ubmVjdGlvblxuICAzLiBEZWFsIHdpdGggdGhlIHJlbW90ZSBzdGVhbSBiZWluZyBkaXNjb3ZlcmVkIGFuZCBob3cgdG8gcmVuZGVyXG4gICAgIHRoYXQgdG8gdGhlIGxvY2FsIGludGVyZmFjZS5cblxuICAjIyBSZWZlcmVuY2VcblxuKiovXG5cbnZhciBnZW4gPSByZXF1aXJlKCcuL2dlbmVyYXRvcnMnKTtcblxuLy8gZXhwb3J0IGRldGVjdFxudmFyIGRldGVjdCA9IGV4cG9ydHMuZGV0ZWN0ID0gcmVxdWlyZSgnLi9kZXRlY3QnKTtcbnZhciBmaW5kUGx1Z2luID0gcmVxdWlyZSgncnRjLWNvcmUvcGx1Z2luJyk7XG5cbi8vIGV4cG9ydCBjb2cgbG9nZ2VyIGZvciBjb252ZW5pZW5jZVxuZXhwb3J0cy5sb2dnZXIgPSByZXF1aXJlKCdjb2cvbG9nZ2VyJyk7XG5cbi8vIGV4cG9ydCBwZWVyIGNvbm5lY3Rpb25cbnZhciBSVENQZWVyQ29ubmVjdGlvbiA9XG5leHBvcnRzLlJUQ1BlZXJDb25uZWN0aW9uID0gZGV0ZWN0KCdSVENQZWVyQ29ubmVjdGlvbicpO1xuXG4vLyBhZGQgdGhlIGNvdXBsZSB1dGlsaXR5XG5leHBvcnRzLmNvdXBsZSA9IHJlcXVpcmUoJy4vY291cGxlJyk7XG5cbi8qKlxuICAjIyMgY3JlYXRlQ29ubmVjdGlvblxuXG4gIGBgYFxuICBjcmVhdGVDb25uZWN0aW9uKG9wdHM/LCBjb25zdHJhaW50cz8pID0+IFJUQ1BlZXJDb25uZWN0aW9uXG4gIGBgYFxuXG4gIENyZWF0ZSBhIG5ldyBgUlRDUGVlckNvbm5lY3Rpb25gIGF1dG8gZ2VuZXJhdGluZyBkZWZhdWx0IG9wdHMgYXMgcmVxdWlyZWQuXG5cbiAgYGBganNcbiAgdmFyIGNvbm47XG5cbiAgLy8gdGhpcyBpcyBva1xuICBjb25uID0gcnRjLmNyZWF0ZUNvbm5lY3Rpb24oKTtcblxuICAvLyBhbmQgc28gaXMgdGhpc1xuICBjb25uID0gcnRjLmNyZWF0ZUNvbm5lY3Rpb24oe1xuICAgIGljZVNlcnZlcnM6IFtdXG4gIH0pO1xuICBgYGBcbioqL1xuZXhwb3J0cy5jcmVhdGVDb25uZWN0aW9uID0gZnVuY3Rpb24ob3B0cywgY29uc3RyYWludHMpIHtcbiAgdmFyIHBsdWdpbiA9IGZpbmRQbHVnaW4oKG9wdHMgfHwge30pLnBsdWdpbnMpO1xuICB2YXIgUGVlckNvbm5lY3Rpb24gPSAob3B0cyB8fCB7fSkuUlRDUGVlckNvbm5lY3Rpb24gfHwgUlRDUGVlckNvbm5lY3Rpb247XG5cbiAgLy8gZ2VuZXJhdGUgdGhlIGNvbmZpZyBiYXNlZCBvbiBvcHRpb25zIHByb3ZpZGVkXG4gIHZhciBjb25maWcgPSBnZW4uY29uZmlnKG9wdHMpO1xuXG4gIC8vIGdlbmVyYXRlIGFwcHJvcHJpYXRlIGNvbm5lY3Rpb24gY29uc3RyYWludHNcbiAgY29uc3RyYWludHMgPSBnZW4uY29ubmVjdGlvbkNvbnN0cmFpbnRzKG9wdHMsIGNvbnN0cmFpbnRzKTtcblxuICBpZiAocGx1Z2luICYmIHR5cGVvZiBwbHVnaW4uY3JlYXRlQ29ubmVjdGlvbiA9PSAnZnVuY3Rpb24nKSB7XG4gICAgcmV0dXJuIHBsdWdpbi5jcmVhdGVDb25uZWN0aW9uKGNvbmZpZywgY29uc3RyYWludHMpO1xuICB9XG5cbiAgcmV0dXJuIG5ldyBQZWVyQ29ubmVjdGlvbihjb25maWcsIGNvbnN0cmFpbnRzKTtcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG52YXIgbWJ1cyA9IHJlcXVpcmUoJ21idXMnKTtcblxuLy8gZGVmaW5lIHNvbWUgc3RhdGUgbWFwcGluZ3MgdG8gc2ltcGxpZnkgdGhlIGV2ZW50cyB3ZSBnZW5lcmF0ZVxudmFyIHN0YXRlTWFwcGluZ3MgPSB7XG4gIGNvbXBsZXRlZDogJ2Nvbm5lY3RlZCdcbn07XG5cbi8vIGRlZmluZSB0aGUgZXZlbnRzIHRoYXQgd2UgbmVlZCB0byB3YXRjaCBmb3IgcGVlciBjb25uZWN0aW9uXG4vLyBzdGF0ZSBjaGFuZ2VzXG52YXIgcGVlclN0YXRlRXZlbnRzID0gW1xuICAnc2lnbmFsaW5nc3RhdGVjaGFuZ2UnLFxuICAnaWNlY29ubmVjdGlvbnN0YXRlY2hhbmdlJyxcbl07XG5cbi8qKlxuICAjIyMgcnRjLXRvb2xzL21vbml0b3JcblxuICBgYGBcbiAgbW9uaXRvcihwYywgdGFyZ2V0SWQsIHNpZ25hbGxlciwgcGFyZW50QnVzKSA9PiBtYnVzXG4gIGBgYFxuXG4gIFRoZSBtb25pdG9yIGlzIGEgdXNlZnVsIHRvb2wgZm9yIGRldGVybWluaW5nIHRoZSBzdGF0ZSBvZiBgcGNgIChhblxuICBgUlRDUGVlckNvbm5lY3Rpb25gKSBpbnN0YW5jZSBpbiB0aGUgY29udGV4dCBvZiB5b3VyIGFwcGxpY2F0aW9uLiBUaGVcbiAgbW9uaXRvciB1c2VzIGJvdGggdGhlIGBpY2VDb25uZWN0aW9uU3RhdGVgIGluZm9ybWF0aW9uIG9mIHRoZSBwZWVyXG4gIGNvbm5lY3Rpb24gYW5kIGFsc28gdGhlIHZhcmlvdXNcbiAgW3NpZ25hbGxlciBldmVudHNdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLXNpZ25hbGxlciNzaWduYWxsZXItZXZlbnRzKVxuICB0byBkZXRlcm1pbmUgd2hlbiB0aGUgY29ubmVjdGlvbiBoYXMgYmVlbiBgY29ubmVjdGVkYCBhbmQgd2hlbiBpdCBoYXNcbiAgYmVlbiBgZGlzY29ubmVjdGVkYC5cblxuICBBIG1vbml0b3IgY3JlYXRlZCBgbWJ1c2AgaXMgcmV0dXJuZWQgYXMgdGhlIHJlc3VsdCBvZiBhXG4gIFtjb3VwbGVdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjI3J0Y2NvdXBsZSkgYmV0d2VlbiBhIGxvY2FsIHBlZXJcbiAgY29ubmVjdGlvbiBhbmQgaXQncyByZW1vdGUgY291bnRlcnBhcnQuXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihwYywgdGFyZ2V0SWQsIHNpZ25hbGxlciwgcGFyZW50QnVzKSB7XG4gIHZhciBtb25pdG9yID0gbWJ1cygnJywgcGFyZW50QnVzKTtcbiAgdmFyIHN0YXRlO1xuXG4gIGZ1bmN0aW9uIGNoZWNrU3RhdGUoKSB7XG4gICAgdmFyIG5ld1N0YXRlID0gZ2V0TWFwcGVkU3RhdGUocGMuaWNlQ29ubmVjdGlvblN0YXRlKTtcblxuICAgIC8vIGZsYWcgdGhlIHdlIGhhZCBhIHN0YXRlIGNoYW5nZVxuICAgIG1vbml0b3IoJ3N0YXRlY2hhbmdlJywgcGMsIG5ld1N0YXRlKTtcblxuICAgIC8vIGlmIHRoZSBhY3RpdmUgc3RhdGUgaGFzIGNoYW5nZWQsIHRoZW4gc2VuZCB0aGUgYXBwb3ByaWF0ZSBtZXNzYWdlXG4gICAgaWYgKHN0YXRlICE9PSBuZXdTdGF0ZSkge1xuICAgICAgbW9uaXRvcihuZXdTdGF0ZSk7XG4gICAgICBzdGF0ZSA9IG5ld1N0YXRlO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZUNsb3NlKCkge1xuICAgIG1vbml0b3IoJ2Nsb3NlZCcpO1xuICB9XG5cbiAgcGMub25jbG9zZSA9IGhhbmRsZUNsb3NlO1xuICBwZWVyU3RhdGVFdmVudHMuZm9yRWFjaChmdW5jdGlvbihldnROYW1lKSB7XG4gICAgcGNbJ29uJyArIGV2dE5hbWVdID0gY2hlY2tTdGF0ZTtcbiAgfSk7XG5cbiAgbW9uaXRvci5zdG9wID0gZnVuY3Rpb24oKSB7XG4gICAgcGMub25jbG9zZSA9IG51bGw7XG4gICAgcGVlclN0YXRlRXZlbnRzLmZvckVhY2goZnVuY3Rpb24oZXZ0TmFtZSkge1xuICAgICAgcGNbJ29uJyArIGV2dE5hbWVdID0gbnVsbDtcbiAgICB9KTtcbiAgfTtcblxuICBtb25pdG9yLmNoZWNrU3RhdGUgPSBjaGVja1N0YXRlO1xuXG4gIC8vIGlmIHdlIGhhdmVuJ3QgYmVlbiBwcm92aWRlZCBhIHZhbGlkIHBlZXIgY29ubmVjdGlvbiwgYWJvcnRcbiAgaWYgKCEgcGMpIHtcbiAgICByZXR1cm4gbW9uaXRvcjtcbiAgfVxuXG4gIC8vIGRldGVybWluZSB0aGUgaW5pdGlhbCBpcyBhY3RpdmUgc3RhdGVcbiAgc3RhdGUgPSBnZXRNYXBwZWRTdGF0ZShwYy5pY2VDb25uZWN0aW9uU3RhdGUpO1xuXG4gIHJldHVybiBtb25pdG9yO1xufTtcblxuLyogaW50ZXJuYWwgaGVscGVycyAqL1xuXG5mdW5jdGlvbiBnZXRNYXBwZWRTdGF0ZShzdGF0ZSkge1xuICByZXR1cm4gc3RhdGVNYXBwaW5nc1tzdGF0ZV0gfHwgc3RhdGU7XG59XG4iLCJ2YXIgZGV0ZWN0ID0gcmVxdWlyZSgncnRjLWNvcmUvZGV0ZWN0Jyk7XG52YXIgZmluZFBsdWdpbiA9IHJlcXVpcmUoJ3J0Yy1jb3JlL3BsdWdpbicpO1xudmFyIFByaW9yaXR5UXVldWUgPSByZXF1aXJlKCdwcmlvcml0eXF1ZXVlanMnKTtcblxuLy8gc29tZSB2YWxpZGF0aW9uIHJvdXRpbmVzXG52YXIgY2hlY2tDYW5kaWRhdGUgPSByZXF1aXJlKCdydGMtdmFsaWRhdG9yL2NhbmRpZGF0ZScpO1xuXG4vLyB0aGUgc2RwIGNsZWFuZXJcbnZhciBzZHBjbGVhbiA9IHJlcXVpcmUoJ3J0Yy1zZHBjbGVhbicpO1xuXG52YXIgUFJJT1JJVFlfTE9XID0gMTAwO1xudmFyIFBSSU9SSVRZX1dBSVQgPSAxMDAwO1xuXG4vLyBwcmlvcml0eSBvcmRlciAobG93ZXIgaXMgYmV0dGVyKVxudmFyIERFRkFVTFRfUFJJT1JJVElFUyA9IFtcbiAgJ2NhbmRpZGF0ZScsXG4gICdzZXRMb2NhbERlc2NyaXB0aW9uJyxcbiAgJ3NldFJlbW90ZURlc2NyaXB0aW9uJyxcbiAgJ2NyZWF0ZUFuc3dlcicsXG4gICdjcmVhdGVPZmZlcidcbl07XG5cbi8vIGRlZmluZSBldmVudCBtYXBwaW5nc1xudmFyIE1FVEhPRF9FVkVOVFMgPSB7XG4gIHNldExvY2FsRGVzY3JpcHRpb246ICdzZXRsb2NhbGRlc2MnLFxuICBzZXRSZW1vdGVEZXNjcmlwdGlvbjogJ3NldHJlbW90ZWRlc2MnLFxuICBjcmVhdGVPZmZlcjogJ29mZmVyJyxcbiAgY3JlYXRlQW5zd2VyOiAnYW5zd2VyJ1xufTtcblxuLy8gZGVmaW5lIHN0YXRlcyBpbiB3aGljaCB3ZSB3aWxsIGF0dGVtcHQgdG8gZmluYWxpemUgYSBjb25uZWN0aW9uIG9uIHJlY2VpdmluZyBhIHJlbW90ZSBvZmZlclxudmFyIFZBTElEX1JFU1BPTlNFX1NUQVRFUyA9IFsnaGF2ZS1yZW1vdGUtb2ZmZXInLCAnaGF2ZS1sb2NhbC1wcmFuc3dlciddO1xuXG4vKipcbiAgIyBydGMtdGFza3F1ZXVlXG5cbiAgVGhpcyBpcyBhIHBhY2thZ2UgdGhhdCBhc3Npc3RzIHdpdGggYXBwbHlpbmcgYWN0aW9ucyB0byBhbiBgUlRDUGVlckNvbm5lY3Rpb25gXG4gIGluIGFzIHJlbGlhYmxlIG9yZGVyIGFzIHBvc3NpYmxlLiBJdCBpcyBwcmltYXJpbHkgdXNlZCBieSB0aGUgY291cGxpbmcgbG9naWNcbiAgb2YgdGhlIFtgcnRjLXRvb2xzYF0oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMtdG9vbHMpLlxuXG4gICMjIEV4YW1wbGUgVXNhZ2VcblxuICBGb3IgdGhlIG1vbWVudCwgcmVmZXIgdG8gdGhlIHNpbXBsZSBjb3VwbGluZyB0ZXN0IGFzIGFuIGV4YW1wbGUgb2YgaG93IHRvIHVzZVxuICB0aGlzIHBhY2thZ2UgKHNlZSBiZWxvdyk6XG5cbiAgPDw8IHRlc3QvY291cGxlLmpzXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihwYywgb3B0cykge1xuICAvLyBjcmVhdGUgdGhlIHRhc2sgcXVldWVcbiAgdmFyIHF1ZXVlID0gbmV3IFByaW9yaXR5UXVldWUob3JkZXJUYXNrcyk7XG4gIHZhciB0cSA9IHJlcXVpcmUoJ21idXMnKSgnJywgKG9wdHMgfHwge30pLmxvZ2dlcik7XG5cbiAgLy8gaW5pdGlhbGlzZSB0YXNrIGltcG9ydGFuY2VcbiAgdmFyIHByaW9yaXRpZXMgPSAob3B0cyB8fCB7fSkucHJpb3JpdGllcyB8fCBERUZBVUxUX1BSSU9SSVRJRVM7XG5cbiAgLy8gY2hlY2sgZm9yIHBsdWdpbiB1c2FnZVxuICB2YXIgcGx1Z2luID0gZmluZFBsdWdpbigob3B0cyB8fCB7fSkucGx1Z2lucyk7XG5cbiAgLy8gaW5pdGlhbGlzZSBzdGF0ZSB0cmFja2luZ1xuICB2YXIgY2hlY2tRdWV1ZVRpbWVyID0gMDtcbiAgdmFyIGN1cnJlbnRUYXNrO1xuICB2YXIgZGVmYXVsdEZhaWwgPSB0cS5iaW5kKHRxLCAnZmFpbCcpO1xuXG4gIC8vIGxvb2sgZm9yIGFuIHNkcGZpbHRlciBmdW5jdGlvbiAoYWxsb3cgc2xpZ2h0IG1pcy1zcGVsbGluZ3MpXG4gIHZhciBzZHBGaWx0ZXIgPSAob3B0cyB8fCB7fSkuc2RwZmlsdGVyIHx8IChvcHRzIHx8IHt9KS5zZHBGaWx0ZXI7XG5cbiAgLy8gaW5pdGlhbGlzZSBzZXNzaW9uIGRlc2NyaXB0aW9uIGFuZCBpY2VjYW5kaWRhdGUgb2JqZWN0c1xuICB2YXIgUlRDU2Vzc2lvbkRlc2NyaXB0aW9uID0gKG9wdHMgfHwge30pLlJUQ1Nlc3Npb25EZXNjcmlwdGlvbiB8fFxuICAgIGRldGVjdCgnUlRDU2Vzc2lvbkRlc2NyaXB0aW9uJyk7XG5cbiAgdmFyIFJUQ0ljZUNhbmRpZGF0ZSA9IChvcHRzIHx8IHt9KS5SVENJY2VDYW5kaWRhdGUgfHxcbiAgICBkZXRlY3QoJ1JUQ0ljZUNhbmRpZGF0ZScpO1xuXG4gIGZ1bmN0aW9uIGFib3J0UXVldWUoZXJyKSB7XG4gICAgY29uc29sZS5lcnJvcihlcnIpO1xuICB9XG5cbiAgZnVuY3Rpb24gYXBwbHlDYW5kaWRhdGUodGFzaywgbmV4dCkge1xuICAgIHZhciBkYXRhID0gdGFzay5hcmdzWzBdO1xuICAgIHZhciBjYW5kaWRhdGUgPSBkYXRhICYmIGRhdGEuY2FuZGlkYXRlICYmIGNyZWF0ZUljZUNhbmRpZGF0ZShkYXRhKTtcblxuICAgIGZ1bmN0aW9uIGhhbmRsZU9rKCkge1xuICAgICAgdHEoJ2ljZS5yZW1vdGUuYXBwbGllZCcsIGNhbmRpZGF0ZSk7XG4gICAgICBuZXh0KCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gaGFuZGxlRmFpbChlcnIpIHtcbiAgICAgIHRxKCdpY2UucmVtb3RlLmludmFsaWQnLCBjYW5kaWRhdGUpO1xuICAgICAgbmV4dChlcnIpO1xuICAgIH1cblxuICAgIC8vIHdlIGhhdmUgYSBudWxsIGNhbmRpZGF0ZSwgd2UgaGF2ZSBmaW5pc2hlZCBnYXRoZXJpbmcgY2FuZGlkYXRlc1xuICAgIGlmICghIGNhbmRpZGF0ZSkge1xuICAgICAgcmV0dXJuIG5leHQoKTtcbiAgICB9XG5cbiAgICBwYy5hZGRJY2VDYW5kaWRhdGUoY2FuZGlkYXRlLCBoYW5kbGVPaywgaGFuZGxlRmFpbCk7XG4gIH1cblxuICBmdW5jdGlvbiBjaGVja1F1ZXVlKCkge1xuICAgIC8vIHBlZWsgYXQgdGhlIG5leHQgaXRlbSBvbiB0aGUgcXVldWVcbiAgICB2YXIgbmV4dCA9ICghIHF1ZXVlLmlzRW1wdHkoKSkgJiYgKCEgY3VycmVudFRhc2spICYmIHF1ZXVlLnBlZWsoKTtcbiAgICB2YXIgcmVhZHkgPSBuZXh0ICYmIHRlc3RSZWFkeShuZXh0KTtcbiAgICB2YXIgcmV0cnkgPSAoISBxdWV1ZS5pc0VtcHR5KCkpICYmIGlzTm90Q2xvc2VkKHBjKTtcblxuICAgIC8vIHJlc2V0IHRoZSBxdWV1ZSB0aW1lclxuICAgIGNoZWNrUXVldWVUaW1lciA9IDA7XG5cbiAgICAvLyBpZiB3ZSBkb24ndCBoYXZlIGEgdGFzayByZWFkeSwgdGhlbiBhYm9ydFxuICAgIGlmICghIHJlYWR5KSB7XG4gICAgICByZXR1cm4gcmV0cnkgJiYgdHJpZ2dlclF1ZXVlQ2hlY2soKTtcbiAgICB9XG5cbiAgICAvLyB1cGRhdGUgdGhlIGN1cnJlbnQgdGFzayAoZGVxdWV1ZSlcbiAgICBjdXJyZW50VGFzayA9IHF1ZXVlLmRlcSgpO1xuXG4gICAgLy8gcHJvY2VzcyB0aGUgdGFza1xuICAgIGN1cnJlbnRUYXNrLmZuKGN1cnJlbnRUYXNrLCBmdW5jdGlvbihlcnIpIHtcbiAgICAgIHZhciBmYWlsID0gY3VycmVudFRhc2suZmFpbCB8fCBkZWZhdWx0RmFpbDtcbiAgICAgIHZhciBwYXNzID0gY3VycmVudFRhc2sucGFzcztcbiAgICAgIHZhciB0YXNrTmFtZSA9IGN1cnJlbnRUYXNrLm5hbWU7XG5cbiAgICAgIC8vIGlmIGVycm9yZWQsIGZhaWxcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcih0YXNrTmFtZSArICcgdGFzayBmYWlsZWQ6ICcsIGVycik7XG4gICAgICAgIHJldHVybiBmYWlsKGVycik7XG4gICAgICB9XG5cbiAgICAgIGlmICh0eXBlb2YgcGFzcyA9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHBhc3MuYXBwbHkoY3VycmVudFRhc2ssIFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKSk7XG4gICAgICB9XG5cbiAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICAgIGN1cnJlbnRUYXNrID0gbnVsbDtcbiAgICAgICAgdHJpZ2dlclF1ZXVlQ2hlY2soKTtcbiAgICAgIH0sIDApO1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gY2xlYW5zZHAoZGVzYykge1xuICAgIC8vIGVuc3VyZSB3ZSBoYXZlIGNsZWFuIHNkcFxuICAgIHZhciBzZHBFcnJvcnMgPSBbXTtcbiAgICB2YXIgc2RwID0gZGVzYyAmJiBzZHBjbGVhbihkZXNjLnNkcCwgeyBjb2xsZWN0b3I6IHNkcEVycm9ycyB9KTtcblxuICAgIC8vIGlmIHdlIGRvbid0IGhhdmUgYSBtYXRjaCwgbG9nIHNvbWUgaW5mb1xuICAgIGlmIChkZXNjICYmIHNkcCAhPT0gZGVzYy5zZHApIHtcbiAgICAgIGNvbnNvbGUuaW5mbygnaW52YWxpZCBsaW5lcyByZW1vdmVkIGZyb20gc2RwOiAnLCBzZHBFcnJvcnMpO1xuICAgICAgZGVzYy5zZHAgPSBzZHA7XG4gICAgfVxuXG4gICAgLy8gaWYgYSBmaWx0ZXIgaGFzIGJlZW4gc3BlY2lmaWVkLCB0aGVuIGFwcGx5IHRoZSBmaWx0ZXJcbiAgICBpZiAodHlwZW9mIHNkcEZpbHRlciA9PSAnZnVuY3Rpb24nKSB7XG4gICAgICBkZXNjLnNkcCA9IHNkcEZpbHRlcihkZXNjLnNkcCwgcGMpO1xuICAgIH1cblxuICAgIHJldHVybiBkZXNjO1xuICB9XG5cbiAgZnVuY3Rpb24gY29tcGxldGVDb25uZWN0aW9uKCkge1xuICAgIGlmIChWQUxJRF9SRVNQT05TRV9TVEFURVMuaW5kZXhPZihwYy5zaWduYWxpbmdTdGF0ZSkgPj0gMCkge1xuICAgICAgcmV0dXJuIHRxLmNyZWF0ZUFuc3dlcigpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGNyZWF0ZUljZUNhbmRpZGF0ZShkYXRhKSB7XG4gICAgaWYgKHBsdWdpbiAmJiB0eXBlb2YgcGx1Z2luLmNyZWF0ZUljZUNhbmRpZGF0ZSA9PSAnZnVuY3Rpb24nKSB7XG4gICAgICByZXR1cm4gcGx1Z2luLmNyZWF0ZUljZUNhbmRpZGF0ZShkYXRhKTtcbiAgICB9XG5cbiAgICByZXR1cm4gbmV3IFJUQ0ljZUNhbmRpZGF0ZShkYXRhKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNyZWF0ZVNlc3Npb25EZXNjcmlwdGlvbihkYXRhKSB7XG4gICAgaWYgKHBsdWdpbiAmJiB0eXBlb2YgcGx1Z2luLmNyZWF0ZVNlc3Npb25EZXNjcmlwdGlvbiA9PSAnZnVuY3Rpb24nKSB7XG4gICAgICByZXR1cm4gcGx1Z2luLmNyZWF0ZVNlc3Npb25EZXNjcmlwdGlvbihkYXRhKTtcbiAgICB9XG5cbiAgICByZXR1cm4gbmV3IFJUQ1Nlc3Npb25EZXNjcmlwdGlvbihkYXRhKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGVtaXRTZHAoKSB7XG4gICAgdHEoJ3NkcC5sb2NhbCcsIHRoaXMuYXJnc1swXSk7XG4gIH1cblxuICBmdW5jdGlvbiBlbnF1ZXVlKG5hbWUsIGhhbmRsZXIsIG9wdHMpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKTtcblxuICAgICAgaWYgKG9wdHMgJiYgdHlwZW9mIG9wdHMucHJvY2Vzc0FyZ3MgPT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBhcmdzID0gYXJncy5tYXAob3B0cy5wcm9jZXNzQXJncyk7XG4gICAgICB9XG5cbiAgICAgIHF1ZXVlLmVucSh7XG4gICAgICAgIGFyZ3M6IGFyZ3MsXG4gICAgICAgIG5hbWU6IG5hbWUsXG4gICAgICAgIGZuOiBoYW5kbGVyLFxuXG4gICAgICAgIC8vIGluaXRpbGFpc2UgYW55IGNoZWNrcyB0aGF0IG5lZWQgdG8gYmUgZG9uZSBwcmlvclxuICAgICAgICAvLyB0byB0aGUgdGFzayBleGVjdXRpbmdcbiAgICAgICAgY2hlY2tzOiBbIGlzTm90Q2xvc2VkIF0uY29uY2F0KChvcHRzIHx8IHt9KS5jaGVja3MgfHwgW10pLFxuXG4gICAgICAgIC8vIGluaXRpYWxpc2UgdGhlIHBhc3MgYW5kIGZhaWwgaGFuZGxlcnNcbiAgICAgICAgcGFzczogKG9wdHMgfHwge30pLnBhc3MsXG4gICAgICAgIGZhaWw6IChvcHRzIHx8IHt9KS5mYWlsXG4gICAgICB9KTtcblxuICAgICAgdHJpZ2dlclF1ZXVlQ2hlY2soKTtcbiAgICB9O1xuICB9XG5cbiAgZnVuY3Rpb24gZXhlY01ldGhvZCh0YXNrLCBuZXh0KSB7XG4gICAgdmFyIGZuID0gcGNbdGFzay5uYW1lXTtcbiAgICB2YXIgZXZlbnROYW1lID0gTUVUSE9EX0VWRU5UU1t0YXNrLm5hbWVdIHx8ICh0YXNrLm5hbWUgfHwgJycpLnRvTG93ZXJDYXNlKCk7XG4gICAgdmFyIGNiQXJncyA9IFsgc3VjY2VzcywgZmFpbCBdO1xuICAgIHZhciBpc09mZmVyID0gdGFzay5uYW1lID09PSAnY3JlYXRlT2ZmZXInO1xuXG4gICAgZnVuY3Rpb24gZmFpbChlcnIpIHtcbiAgICAgIHRxLmFwcGx5KHRxLCBbICduZWdvdGlhdGUuZXJyb3InLCB0YXNrLm5hbWUsIGVyciBdLmNvbmNhdCh0YXNrLmFyZ3MpKTtcbiAgICAgIG5leHQoZXJyKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzdWNjZXNzKCkge1xuICAgICAgdHEuYXBwbHkodHEsIFsgWyduZWdvdGlhdGUnLCBldmVudE5hbWUsICdvayddLCB0YXNrLm5hbWUgXS5jb25jYXQodGFzay5hcmdzKSk7XG4gICAgICBuZXh0LmFwcGx5KG51bGwsIFtudWxsXS5jb25jYXQoW10uc2xpY2UuY2FsbChhcmd1bWVudHMpKSk7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBmbiAhPSAnZnVuY3Rpb24nKSB7XG4gICAgICByZXR1cm4gbmV4dChuZXcgRXJyb3IoJ2Nhbm5vdCBjYWxsIFwiJyArIHRhc2submFtZSArICdcIiBvbiBSVENQZWVyQ29ubmVjdGlvbicpKTtcbiAgICB9XG5cbiAgICAvLyBpbnZva2UgdGhlIGZ1bmN0aW9uXG4gICAgdHEuYXBwbHkodHEsIFsnbmVnb3RpYXRlLicgKyBldmVudE5hbWVdLmNvbmNhdCh0YXNrLmFyZ3MpKTtcbiAgICBmbi5hcHBseShcbiAgICAgIHBjLFxuICAgICAgdGFzay5hcmdzLmNvbmNhdChjYkFyZ3MpLmNvbmNhdChpc09mZmVyID8gZ2VuZXJhdGVDb25zdHJhaW50cygpIDogW10pXG4gICAgKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGV4dHJhY3RDYW5kaWRhdGVFdmVudERhdGEoZGF0YSkge1xuICAgIC8vIGV4dHJhY3QgbmVzdGVkIGNhbmRpZGF0ZSBkYXRhIChsaWtlIHdlIHdpbGwgc2VlIGluIGFuIGV2ZW50IGJlaW5nIHBhc3NlZCB0byB0aGlzIGZ1bmN0aW9uKVxuICAgIHdoaWxlIChkYXRhICYmIGRhdGEuY2FuZGlkYXRlICYmIGRhdGEuY2FuZGlkYXRlLmNhbmRpZGF0ZSkge1xuICAgICAgZGF0YSA9IGRhdGEuY2FuZGlkYXRlO1xuICAgIH1cblxuICAgIHJldHVybiBkYXRhO1xuICB9XG5cbiAgZnVuY3Rpb24gZ2VuZXJhdGVDb25zdHJhaW50cygpIHtcbiAgICB2YXIgYWxsb3dlZEtleXMgPSB7XG4gICAgICBvZmZlcnRvcmVjZWl2ZXZpZGVvOiAnT2ZmZXJUb1JlY2VpdmVWaWRlbycsXG4gICAgICBvZmZlcnRvcmVjZWl2ZWF1ZGlvOiAnT2ZmZXJUb1JlY2VpdmVBdWRpbycsXG4gICAgICBpY2VyZXN0YXJ0OiAnSWNlUmVzdGFydCcsXG4gICAgICB2b2ljZWFjdGl2aXR5ZGV0ZWN0aW9uOiAnVm9pY2VBY3Rpdml0eURldGVjdGlvbidcbiAgICB9O1xuXG4gICAgdmFyIGNvbnN0cmFpbnRzID0ge1xuICAgICAgT2ZmZXJUb1JlY2VpdmVWaWRlbzogdHJ1ZSxcbiAgICAgIE9mZmVyVG9SZWNlaXZlQXVkaW86IHRydWVcbiAgICB9O1xuXG4gICAgLy8gdXBkYXRlIGtub3duIGtleXMgdG8gbWF0Y2hcbiAgICBPYmplY3Qua2V5cyhvcHRzIHx8IHt9KS5mb3JFYWNoKGZ1bmN0aW9uKGtleSkge1xuICAgICAgaWYgKGFsbG93ZWRLZXlzW2tleS50b0xvd2VyQ2FzZSgpXSkge1xuICAgICAgICBjb25zdHJhaW50c1thbGxvd2VkS2V5c1trZXkudG9Mb3dlckNhc2UoKV1dID0gb3B0c1trZXldO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgbWFuZGF0b3J5OiBjb25zdHJhaW50cyB9O1xuICB9XG5cbiAgZnVuY3Rpb24gaGFzTG9jYWxPclJlbW90ZURlc2MocGMsIHRhc2spIHtcbiAgICByZXR1cm4gcGMuX19oYXNEZXNjIHx8IChwYy5fX2hhc0Rlc2MgPSAhIXBjLnJlbW90ZURlc2NyaXB0aW9uKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGlzTm90TmVnb3RpYXRpbmcocGMpIHtcbiAgICByZXR1cm4gcGMuc2lnbmFsaW5nU3RhdGUgIT09ICdoYXZlLWxvY2FsLW9mZmVyJztcbiAgfVxuXG4gIGZ1bmN0aW9uIGlzTm90Q2xvc2VkKHBjKSB7XG4gICAgcmV0dXJuIHBjLnNpZ25hbGluZ1N0YXRlICE9PSAnY2xvc2VkJztcbiAgfVxuXG4gIGZ1bmN0aW9uIGlzU3RhYmxlKHBjKSB7XG4gICAgcmV0dXJuIHBjLnNpZ25hbGluZ1N0YXRlID09PSAnc3RhYmxlJztcbiAgfVxuXG4gIGZ1bmN0aW9uIGlzVmFsaWRDYW5kaWRhdGUocGMsIGRhdGEpIHtcbiAgICByZXR1cm4gZGF0YS5fX3ZhbGlkIHx8XG4gICAgICAoZGF0YS5fX3ZhbGlkID0gY2hlY2tDYW5kaWRhdGUoZGF0YS5hcmdzWzBdKS5sZW5ndGggPT09IDApO1xuICB9XG5cbiAgZnVuY3Rpb24gb3JkZXJUYXNrcyhhLCBiKSB7XG4gICAgLy8gYXBwbHkgZWFjaCBvZiB0aGUgY2hlY2tzIGZvciBlYWNoIHRhc2tcbiAgICB2YXIgdGFza3MgPSBbYSxiXTtcbiAgICB2YXIgcmVhZGluZXNzID0gdGFza3MubWFwKHRlc3RSZWFkeSk7XG4gICAgdmFyIHRhc2tQcmlvcml0aWVzID0gdGFza3MubWFwKGZ1bmN0aW9uKHRhc2ssIGlkeCkge1xuICAgICAgdmFyIHJlYWR5ID0gcmVhZGluZXNzW2lkeF07XG4gICAgICB2YXIgcHJpb3JpdHkgPSByZWFkeSAmJiBwcmlvcml0aWVzLmluZGV4T2YodGFzay5uYW1lKTtcblxuICAgICAgcmV0dXJuIHJlYWR5ID8gKHByaW9yaXR5ID49IDAgPyBwcmlvcml0eSA6IFBSSU9SSVRZX0xPVykgOiBQUklPUklUWV9XQUlUO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHRhc2tQcmlvcml0aWVzWzFdIC0gdGFza1ByaW9yaXRpZXNbMF07XG4gIH1cblxuICAvLyBjaGVjayB3aGV0aGVyIGEgdGFzayBpcyByZWFkeSAoZG9lcyBpdCBwYXNzIGFsbCB0aGUgY2hlY2tzKVxuICBmdW5jdGlvbiB0ZXN0UmVhZHkodGFzaykge1xuICAgIHJldHVybiAodGFzay5jaGVja3MgfHwgW10pLnJlZHVjZShmdW5jdGlvbihtZW1vLCBjaGVjaykge1xuICAgICAgcmV0dXJuIG1lbW8gJiYgY2hlY2socGMsIHRhc2spO1xuICAgIH0sIHRydWUpO1xuICB9XG5cbiAgZnVuY3Rpb24gdHJpZ2dlclF1ZXVlQ2hlY2soKSB7XG4gICAgaWYgKGNoZWNrUXVldWVUaW1lcikgcmV0dXJuO1xuICAgIGNoZWNrUXVldWVUaW1lciA9IHNldFRpbWVvdXQoY2hlY2tRdWV1ZSwgNTApO1xuICB9XG5cbiAgLy8gcGF0Y2ggaW4gdGhlIHF1ZXVlIGhlbHBlciBtZXRob2RzXG4gIHRxLmFkZEljZUNhbmRpZGF0ZSA9IGVucXVldWUoJ2FkZEljZUNhbmRpZGF0ZScsIGFwcGx5Q2FuZGlkYXRlLCB7XG4gICAgcHJvY2Vzc0FyZ3M6IGV4dHJhY3RDYW5kaWRhdGVFdmVudERhdGEsXG4gICAgY2hlY2tzOiBbIGhhc0xvY2FsT3JSZW1vdGVEZXNjLCBpc1ZhbGlkQ2FuZGlkYXRlIF1cbiAgfSk7XG5cbiAgdHEuc2V0TG9jYWxEZXNjcmlwdGlvbiA9IGVucXVldWUoJ3NldExvY2FsRGVzY3JpcHRpb24nLCBleGVjTWV0aG9kLCB7XG4gICAgcHJvY2Vzc0FyZ3M6IGNsZWFuc2RwLFxuICAgIHBhc3M6IGVtaXRTZHBcbiAgfSk7XG5cbiAgdHEuc2V0UmVtb3RlRGVzY3JpcHRpb24gPSBlbnF1ZXVlKCdzZXRSZW1vdGVEZXNjcmlwdGlvbicsIGV4ZWNNZXRob2QsIHtcbiAgICBwcm9jZXNzQXJnczogY3JlYXRlU2Vzc2lvbkRlc2NyaXB0aW9uLFxuICAgIHBhc3M6IGNvbXBsZXRlQ29ubmVjdGlvblxuICB9KTtcblxuICB0cS5jcmVhdGVPZmZlciA9IGVucXVldWUoJ2NyZWF0ZU9mZmVyJywgZXhlY01ldGhvZCwge1xuICAgIGNoZWNrczogWyBpc05vdE5lZ290aWF0aW5nIF0sXG4gICAgcGFzczogdHEuc2V0TG9jYWxEZXNjcmlwdGlvblxuICB9KTtcblxuICB0cS5jcmVhdGVBbnN3ZXIgPSBlbnF1ZXVlKCdjcmVhdGVBbnN3ZXInLCBleGVjTWV0aG9kLCB7XG4gICAgcGFzczogdHEuc2V0TG9jYWxEZXNjcmlwdGlvblxuICB9KTtcblxuICByZXR1cm4gdHE7XG59O1xuIiwiLyoqXG4gKiBFeHBvc2UgYFByaW9yaXR5UXVldWVgLlxuICovXG5tb2R1bGUuZXhwb3J0cyA9IFByaW9yaXR5UXVldWU7XG5cbi8qKlxuICogSW5pdGlhbGl6ZXMgYSBuZXcgZW1wdHkgYFByaW9yaXR5UXVldWVgIHdpdGggdGhlIGdpdmVuIGBjb21wYXJhdG9yKGEsIGIpYFxuICogZnVuY3Rpb24sIHVzZXMgYC5ERUZBVUxUX0NPTVBBUkFUT1IoKWAgd2hlbiBubyBmdW5jdGlvbiBpcyBwcm92aWRlZC5cbiAqXG4gKiBUaGUgY29tcGFyYXRvciBmdW5jdGlvbiBtdXN0IHJldHVybiBhIHBvc2l0aXZlIG51bWJlciB3aGVuIGBhID4gYmAsIDAgd2hlblxuICogYGEgPT0gYmAgYW5kIGEgbmVnYXRpdmUgbnVtYmVyIHdoZW4gYGEgPCBiYC5cbiAqXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufVxuICogQHJldHVybiB7UHJpb3JpdHlRdWV1ZX1cbiAqIEBhcGkgcHVibGljXG4gKi9cbmZ1bmN0aW9uIFByaW9yaXR5UXVldWUoY29tcGFyYXRvcikge1xuICB0aGlzLl9jb21wYXJhdG9yID0gY29tcGFyYXRvciB8fCBQcmlvcml0eVF1ZXVlLkRFRkFVTFRfQ09NUEFSQVRPUjtcbiAgdGhpcy5fZWxlbWVudHMgPSBbXTtcbn1cblxuLyoqXG4gKiBDb21wYXJlcyBgYWAgYW5kIGBiYCwgd2hlbiBgYSA+IGJgIGl0IHJldHVybnMgYSBwb3NpdGl2ZSBudW1iZXIsIHdoZW5cbiAqIGl0IHJldHVybnMgMCBhbmQgd2hlbiBgYSA8IGJgIGl0IHJldHVybnMgYSBuZWdhdGl2ZSBudW1iZXIuXG4gKlxuICogQHBhcmFtIHtTdHJpbmd8TnVtYmVyfSBhXG4gKiBAcGFyYW0ge1N0cmluZ3xOdW1iZXJ9IGJcbiAqIEByZXR1cm4ge051bWJlcn1cbiAqIEBhcGkgcHVibGljXG4gKi9cblByaW9yaXR5UXVldWUuREVGQVVMVF9DT01QQVJBVE9SID0gZnVuY3Rpb24oYSwgYikge1xuICBpZiAodHlwZW9mIGEgPT09ICdudW1iZXInICYmIHR5cGVvZiBiID09PSAnbnVtYmVyJykge1xuICAgIHJldHVybiBhIC0gYjtcbiAgfSBlbHNlIHtcbiAgICBhID0gYS50b1N0cmluZygpO1xuICAgIGIgPSBiLnRvU3RyaW5nKCk7XG5cbiAgICBpZiAoYSA9PSBiKSByZXR1cm4gMDtcblxuICAgIHJldHVybiAoYSA+IGIpID8gMSA6IC0xO1xuICB9XG59O1xuXG4vKipcbiAqIFJldHVybnMgd2hldGhlciB0aGUgcHJpb3JpdHkgcXVldWUgaXMgZW1wdHkgb3Igbm90LlxuICpcbiAqIEByZXR1cm4ge0Jvb2xlYW59XG4gKiBAYXBpIHB1YmxpY1xuICovXG5Qcmlvcml0eVF1ZXVlLnByb3RvdHlwZS5pc0VtcHR5ID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiB0aGlzLnNpemUoKSA9PT0gMDtcbn07XG5cbi8qKlxuICogUGVla3MgYXQgdGhlIHRvcCBlbGVtZW50IG9mIHRoZSBwcmlvcml0eSBxdWV1ZS5cbiAqXG4gKiBAcmV0dXJuIHtPYmplY3R9XG4gKiBAdGhyb3dzIHtFcnJvcn0gd2hlbiB0aGUgcXVldWUgaXMgZW1wdHkuXG4gKiBAYXBpIHB1YmxpY1xuICovXG5Qcmlvcml0eVF1ZXVlLnByb3RvdHlwZS5wZWVrID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmlzRW1wdHkoKSkgdGhyb3cgbmV3IEVycm9yKCdQcmlvcml0eVF1ZXVlIGlzIGVtcHR5Jyk7XG5cbiAgcmV0dXJuIHRoaXMuX2VsZW1lbnRzWzBdO1xufTtcblxuLyoqXG4gKiBEZXF1ZXVlcyB0aGUgdG9wIGVsZW1lbnQgb2YgdGhlIHByaW9yaXR5IHF1ZXVlLlxuICpcbiAqIEByZXR1cm4ge09iamVjdH1cbiAqIEB0aHJvd3Mge0Vycm9yfSB3aGVuIHRoZSBxdWV1ZSBpcyBlbXB0eS5cbiAqIEBhcGkgcHVibGljXG4gKi9cblByaW9yaXR5UXVldWUucHJvdG90eXBlLmRlcSA9IGZ1bmN0aW9uKCkge1xuICB2YXIgZmlyc3QgPSB0aGlzLnBlZWsoKTtcbiAgdmFyIGxhc3QgPSB0aGlzLl9lbGVtZW50cy5wb3AoKTtcbiAgdmFyIHNpemUgPSB0aGlzLnNpemUoKTtcblxuICBpZiAoc2l6ZSA9PT0gMCkgcmV0dXJuIGZpcnN0O1xuXG4gIHRoaXMuX2VsZW1lbnRzWzBdID0gbGFzdDtcbiAgdmFyIGN1cnJlbnQgPSAwO1xuXG4gIHdoaWxlIChjdXJyZW50IDwgc2l6ZSkge1xuICAgIHZhciBsYXJnZXN0ID0gY3VycmVudDtcbiAgICB2YXIgbGVmdCA9ICgyICogY3VycmVudCkgKyAxO1xuICAgIHZhciByaWdodCA9ICgyICogY3VycmVudCkgKyAyO1xuXG4gICAgaWYgKGxlZnQgPCBzaXplICYmIHRoaXMuX2NvbXBhcmUobGVmdCwgbGFyZ2VzdCkgPj0gMCkge1xuICAgICAgbGFyZ2VzdCA9IGxlZnQ7XG4gICAgfVxuXG4gICAgaWYgKHJpZ2h0IDwgc2l6ZSAmJiB0aGlzLl9jb21wYXJlKHJpZ2h0LCBsYXJnZXN0KSA+PSAwKSB7XG4gICAgICBsYXJnZXN0ID0gcmlnaHQ7XG4gICAgfVxuXG4gICAgaWYgKGxhcmdlc3QgPT09IGN1cnJlbnQpIGJyZWFrO1xuXG4gICAgdGhpcy5fc3dhcChsYXJnZXN0LCBjdXJyZW50KTtcbiAgICBjdXJyZW50ID0gbGFyZ2VzdDtcbiAgfVxuXG4gIHJldHVybiBmaXJzdDtcbn07XG5cbi8qKlxuICogRW5xdWV1ZXMgdGhlIGBlbGVtZW50YCBhdCB0aGUgcHJpb3JpdHkgcXVldWUgYW5kIHJldHVybnMgaXRzIG5ldyBzaXplLlxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBlbGVtZW50XG4gKiBAcmV0dXJuIHtOdW1iZXJ9XG4gKiBAYXBpIHB1YmxpY1xuICovXG5Qcmlvcml0eVF1ZXVlLnByb3RvdHlwZS5lbnEgPSBmdW5jdGlvbihlbGVtZW50KSB7XG4gIHZhciBzaXplID0gdGhpcy5fZWxlbWVudHMucHVzaChlbGVtZW50KTtcbiAgdmFyIGN1cnJlbnQgPSBzaXplIC0gMTtcblxuICB3aGlsZSAoY3VycmVudCA+IDApIHtcbiAgICB2YXIgcGFyZW50ID0gTWF0aC5mbG9vcigoY3VycmVudCAtIDEpIC8gMik7XG5cbiAgICBpZiAodGhpcy5fY29tcGFyZShjdXJyZW50LCBwYXJlbnQpIDw9IDApIGJyZWFrO1xuXG4gICAgdGhpcy5fc3dhcChwYXJlbnQsIGN1cnJlbnQpO1xuICAgIGN1cnJlbnQgPSBwYXJlbnQ7XG4gIH1cblxuICByZXR1cm4gc2l6ZTtcbn07XG5cbi8qKlxuICogUmV0dXJucyB0aGUgc2l6ZSBvZiB0aGUgcHJpb3JpdHkgcXVldWUuXG4gKlxuICogQHJldHVybiB7TnVtYmVyfVxuICogQGFwaSBwdWJsaWNcbiAqL1xuUHJpb3JpdHlRdWV1ZS5wcm90b3R5cGUuc2l6ZSA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5fZWxlbWVudHMubGVuZ3RoO1xufTtcblxuLyoqXG4gKiAgSXRlcmF0ZXMgb3ZlciBxdWV1ZSBlbGVtZW50c1xuICpcbiAqICBAcGFyYW0ge0Z1bmN0aW9ufSBmblxuICovXG5Qcmlvcml0eVF1ZXVlLnByb3RvdHlwZS5mb3JFYWNoID0gZnVuY3Rpb24oZm4pIHtcbiAgcmV0dXJuIHRoaXMuX2VsZW1lbnRzLmZvckVhY2goZm4pO1xufTtcblxuLyoqXG4gKiBDb21wYXJlcyB0aGUgdmFsdWVzIGF0IHBvc2l0aW9uIGBhYCBhbmQgYGJgIGluIHRoZSBwcmlvcml0eSBxdWV1ZSB1c2luZyBpdHNcbiAqIGNvbXBhcmF0b3IgZnVuY3Rpb24uXG4gKlxuICogQHBhcmFtIHtOdW1iZXJ9IGFcbiAqIEBwYXJhbSB7TnVtYmVyfSBiXG4gKiBAcmV0dXJuIHtOdW1iZXJ9XG4gKiBAYXBpIHByaXZhdGVcbiAqL1xuUHJpb3JpdHlRdWV1ZS5wcm90b3R5cGUuX2NvbXBhcmUgPSBmdW5jdGlvbihhLCBiKSB7XG4gIHJldHVybiB0aGlzLl9jb21wYXJhdG9yKHRoaXMuX2VsZW1lbnRzW2FdLCB0aGlzLl9lbGVtZW50c1tiXSk7XG59O1xuXG4vKipcbiAqIFN3YXBzIHRoZSB2YWx1ZXMgYXQgcG9zaXRpb24gYGFgIGFuZCBgYmAgaW4gdGhlIHByaW9yaXR5IHF1ZXVlLlxuICpcbiAqIEBwYXJhbSB7TnVtYmVyfSBhXG4gKiBAcGFyYW0ge051bWJlcn0gYlxuICogQGFwaSBwcml2YXRlXG4gKi9cblByaW9yaXR5UXVldWUucHJvdG90eXBlLl9zd2FwID0gZnVuY3Rpb24oYSwgYikge1xuICB2YXIgYXV4ID0gdGhpcy5fZWxlbWVudHNbYV07XG4gIHRoaXMuX2VsZW1lbnRzW2FdID0gdGhpcy5fZWxlbWVudHNbYl07XG4gIHRoaXMuX2VsZW1lbnRzW2JdID0gYXV4O1xufTtcbiIsInZhciB2YWxpZGF0b3JzID0gW1xuICBbIC9eKGFcXD1jYW5kaWRhdGUuKikkLywgcmVxdWlyZSgncnRjLXZhbGlkYXRvci9jYW5kaWRhdGUnKSBdXG5dO1xuXG52YXIgcmVTZHBMaW5lQnJlYWsgPSAvKFxccj9cXG58XFxcXHJcXFxcbikvO1xuXG4vKipcbiAgIyBydGMtc2RwY2xlYW5cblxuICBSZW1vdmUgaW52YWxpZCBsaW5lcyBmcm9tIHlvdXIgU0RQLlxuXG4gICMjIFdoeT9cblxuICBUaGlzIG1vZHVsZSByZW1vdmVzIHRoZSBvY2Nhc2lvbmFsIFwiYmFkIGVnZ1wiIHRoYXQgd2lsbCBzbGlwIGludG8gU0RQIHdoZW4gaXRcbiAgaXMgZ2VuZXJhdGVkIGJ5IHRoZSBicm93c2VyLiAgSW4gcGFydGljdWxhciB0aGVzZSBzaXR1YXRpb25zIGFyZSBjYXRlcmVkIGZvcjpcblxuICAtIGludmFsaWQgSUNFIGNhbmRpZGF0ZXNcblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKGlucHV0LCBvcHRzKSB7XG4gIHZhciBsaW5lQnJlYWsgPSBkZXRlY3RMaW5lQnJlYWsoaW5wdXQpO1xuICB2YXIgbGluZXMgPSBpbnB1dC5zcGxpdChsaW5lQnJlYWspO1xuICB2YXIgY29sbGVjdG9yID0gKG9wdHMgfHwge30pLmNvbGxlY3RvcjtcblxuICAvLyBmaWx0ZXIgb3V0IGludmFsaWQgbGluZXNcbiAgbGluZXMgPSBsaW5lcy5maWx0ZXIoZnVuY3Rpb24obGluZSkge1xuICAgIC8vIGl0ZXJhdGUgdGhyb3VnaCB0aGUgdmFsaWRhdG9ycyBhbmQgdXNlIHRoZSBvbmUgdGhhdCBtYXRjaGVzXG4gICAgdmFyIHZhbGlkYXRvciA9IHZhbGlkYXRvcnMucmVkdWNlKGZ1bmN0aW9uKG1lbW8sIGRhdGEsIGlkeCkge1xuICAgICAgcmV0dXJuIHR5cGVvZiBtZW1vICE9ICd1bmRlZmluZWQnID8gbWVtbyA6IChkYXRhWzBdLmV4ZWMobGluZSkgJiYge1xuICAgICAgICBsaW5lOiBsaW5lLnJlcGxhY2UoZGF0YVswXSwgJyQxJyksXG4gICAgICAgIGZuOiBkYXRhWzFdXG4gICAgICB9KTtcbiAgICB9LCB1bmRlZmluZWQpO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSBhIHZhbGlkYXRvciwgZW5zdXJlIHdlIGhhdmUgbm8gZXJyb3JzXG4gICAgdmFyIGVycm9ycyA9IHZhbGlkYXRvciA/IHZhbGlkYXRvci5mbih2YWxpZGF0b3IubGluZSkgOiBbXTtcblxuICAgIC8vIGlmIHdlIGhhdmUgZXJyb3JzIGFuZCBhbiBlcnJvciBjb2xsZWN0b3IsIHRoZW4gYWRkIHRvIHRoZSBjb2xsZWN0b3JcbiAgICBpZiAoY29sbGVjdG9yKSB7XG4gICAgICBlcnJvcnMuZm9yRWFjaChmdW5jdGlvbihlcnIpIHtcbiAgICAgICAgY29sbGVjdG9yLnB1c2goZXJyKTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiBlcnJvcnMubGVuZ3RoID09PSAwO1xuICB9KTtcblxuICByZXR1cm4gbGluZXMuam9pbihsaW5lQnJlYWspO1xufTtcblxuZnVuY3Rpb24gZGV0ZWN0TGluZUJyZWFrKGlucHV0KSB7XG4gIHZhciBtYXRjaCA9IHJlU2RwTGluZUJyZWFrLmV4ZWMoaW5wdXQpO1xuXG4gIHJldHVybiBtYXRjaCAmJiBtYXRjaFswXTtcbn1cbiIsInZhciBkZWJ1ZyA9IHJlcXVpcmUoJ2NvZy9sb2dnZXInKSgncnRjLXZhbGlkYXRvcicpO1xudmFyIHJlUHJlZml4ID0gL14oPzphPSk/Y2FuZGlkYXRlOi87XG52YXIgcmVJUCA9IC9eKFxcZCtcXC4pezN9XFxkKyQvO1xuXG4vKlxuXG52YWxpZGF0aW9uIHJ1bGVzIGFzIHBlcjpcbmh0dHA6Ly90b29scy5pZXRmLm9yZy9odG1sL2RyYWZ0LWlldGYtbW11c2ljLWljZS1zaXAtc2RwLTAzI3NlY3Rpb24tOC4xXG5cbiAgIGNhbmRpZGF0ZS1hdHRyaWJ1dGUgICA9IFwiY2FuZGlkYXRlXCIgXCI6XCIgZm91bmRhdGlvbiBTUCBjb21wb25lbnQtaWQgU1BcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyYW5zcG9ydCBTUFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJpb3JpdHkgU1BcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3Rpb24tYWRkcmVzcyBTUCAgICAgO2Zyb20gUkZDIDQ1NjZcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIHBvcnQgICAgICAgICA7cG9ydCBmcm9tIFJGQyA0NTY2XG4gICAgICAgICAgICAgICAgICAgICAgICAgICBTUCBjYW5kLXR5cGVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIFtTUCByZWwtYWRkcl1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgIFtTUCByZWwtcG9ydF1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICooU1AgZXh0ZW5zaW9uLWF0dC1uYW1lIFNQXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dGVuc2lvbi1hdHQtdmFsdWUpXG5cbiAgIGZvdW5kYXRpb24gICAgICAgICAgICA9IDEqMzJpY2UtY2hhclxuICAgY29tcG9uZW50LWlkICAgICAgICAgID0gMSo1RElHSVRcbiAgIHRyYW5zcG9ydCAgICAgICAgICAgICA9IFwiVURQXCIgLyB0cmFuc3BvcnQtZXh0ZW5zaW9uXG4gICB0cmFuc3BvcnQtZXh0ZW5zaW9uICAgPSB0b2tlbiAgICAgICAgICAgICAgOyBmcm9tIFJGQyAzMjYxXG4gICBwcmlvcml0eSAgICAgICAgICAgICAgPSAxKjEwRElHSVRcbiAgIGNhbmQtdHlwZSAgICAgICAgICAgICA9IFwidHlwXCIgU1AgY2FuZGlkYXRlLXR5cGVzXG4gICBjYW5kaWRhdGUtdHlwZXMgICAgICAgPSBcImhvc3RcIiAvIFwic3JmbHhcIiAvIFwicHJmbHhcIiAvIFwicmVsYXlcIiAvIHRva2VuXG4gICByZWwtYWRkciAgICAgICAgICAgICAgPSBcInJhZGRyXCIgU1AgY29ubmVjdGlvbi1hZGRyZXNzXG4gICByZWwtcG9ydCAgICAgICAgICAgICAgPSBcInJwb3J0XCIgU1AgcG9ydFxuICAgZXh0ZW5zaW9uLWF0dC1uYW1lICAgID0gdG9rZW5cbiAgIGV4dGVuc2lvbi1hdHQtdmFsdWUgICA9ICpWQ0hBUlxuICAgaWNlLWNoYXIgICAgICAgICAgICAgID0gQUxQSEEgLyBESUdJVCAvIFwiK1wiIC8gXCIvXCJcbiovXG52YXIgcGFydFZhbGlkYXRpb24gPSBbXG4gIFsgLy4rLywgJ2ludmFsaWQgZm91bmRhdGlvbiBjb21wb25lbnQnLCAnZm91bmRhdGlvbicgXSxcbiAgWyAvXFxkKy8sICdpbnZhbGlkIGNvbXBvbmVudCBpZCcsICdjb21wb25lbnQtaWQnIF0sXG4gIFsgLyhVRFB8VENQKS9pLCAndHJhbnNwb3J0IG11c3QgYmUgVENQIG9yIFVEUCcsICd0cmFuc3BvcnQnIF0sXG4gIFsgL1xcZCsvLCAnbnVtZXJpYyBwcmlvcml0eSBleHBlY3RlZCcsICdwcmlvcml0eScgXSxcbiAgWyByZUlQLCAnaW52YWxpZCBjb25uZWN0aW9uIGFkZHJlc3MnLCAnY29ubmVjdGlvbi1hZGRyZXNzJyBdLFxuICBbIC9cXGQrLywgJ2ludmFsaWQgY29ubmVjdGlvbiBwb3J0JywgJ2Nvbm5lY3Rpb24tcG9ydCcgXSxcbiAgWyAvdHlwLywgJ0V4cGVjdGVkIFwidHlwXCIgaWRlbnRpZmllcicsICd0eXBlIGNsYXNzaWZpZXInIF0sXG4gIFsgLy4rLywgJ0ludmFsaWQgY2FuZGlkYXRlIHR5cGUgc3BlY2lmaWVkJywgJ2NhbmRpZGF0ZS10eXBlJyBdXG5dO1xuXG4vKipcbiAgIyMjIGBydGMtdmFsaWRhdG9yL2NhbmRpZGF0ZWBcblxuICBWYWxpZGF0ZSB0aGF0IGFuIGBSVENJY2VDYW5kaWRhdGVgIChvciBwbGFpbiBvbGQgb2JqZWN0IHdpdGggZGF0YSwgc2RwTWlkLFxuICBldGMgYXR0cmlidXRlcykgaXMgYSB2YWxpZCBpY2UgY2FuZGlkYXRlLlxuXG4gIFNwZWNzIHJldmlld2VkIGFzIHBhcnQgb2YgdGhlIHZhbGlkYXRpb24gaW1wbGVtZW50YXRpb246XG5cbiAgLSA8aHR0cDovL3Rvb2xzLmlldGYub3JnL2h0bWwvZHJhZnQtaWV0Zi1tbXVzaWMtaWNlLXNpcC1zZHAtMDMjc2VjdGlvbi04LjE+XG4gIC0gPGh0dHA6Ly90b29scy5pZXRmLm9yZy9odG1sL3JmYzUyNDU+XG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihkYXRhKSB7XG4gIHZhciBlcnJvcnMgPSBbXTtcbiAgdmFyIGNhbmRpZGF0ZSA9IGRhdGEgJiYgKGRhdGEuY2FuZGlkYXRlIHx8IGRhdGEpO1xuICB2YXIgcHJlZml4TWF0Y2ggPSBjYW5kaWRhdGUgJiYgcmVQcmVmaXguZXhlYyhjYW5kaWRhdGUpO1xuICB2YXIgcGFydHMgPSBwcmVmaXhNYXRjaCAmJiBjYW5kaWRhdGUuc2xpY2UocHJlZml4TWF0Y2hbMF0ubGVuZ3RoKS5zcGxpdCgvXFxzLyk7XG5cbiAgaWYgKCEgY2FuZGlkYXRlKSB7XG4gICAgcmV0dXJuIFsgbmV3IEVycm9yKCdlbXB0eSBjYW5kaWRhdGUnKSBdO1xuICB9XG5cbiAgLy8gY2hlY2sgdGhhdCB0aGUgcHJlZml4IG1hdGNoZXMgZXhwZWN0ZWRcbiAgaWYgKCEgcHJlZml4TWF0Y2gpIHtcbiAgICByZXR1cm4gWyBuZXcgRXJyb3IoJ2NhbmRpZGF0ZSBkaWQgbm90IG1hdGNoIGV4cGVjdGVkIHNkcCBsaW5lIGZvcm1hdCcpIF07XG4gIH1cblxuICAvLyBwZXJmb3JtIHRoZSBwYXJ0IHZhbGlkYXRpb25cbiAgZXJyb3JzID0gZXJyb3JzLmNvbmNhdChwYXJ0cy5tYXAodmFsaWRhdGVQYXJ0cykpLmZpbHRlcihCb29sZWFuKTtcblxuICByZXR1cm4gZXJyb3JzO1xufTtcblxuZnVuY3Rpb24gdmFsaWRhdGVQYXJ0cyhwYXJ0LCBpZHgpIHtcbiAgdmFyIHZhbGlkYXRvciA9IHBhcnRWYWxpZGF0aW9uW2lkeF07XG5cbiAgaWYgKHZhbGlkYXRvciAmJiAoISB2YWxpZGF0b3JbMF0udGVzdChwYXJ0KSkpIHtcbiAgICBkZWJ1Zyh2YWxpZGF0b3JbMl0gKyAnIHBhcnQgZmFpbGVkIHZhbGlkYXRpb246ICcgKyBwYXJ0KTtcbiAgICByZXR1cm4gbmV3IEVycm9yKHZhbGlkYXRvclsxXSk7XG4gIH1cbn1cbiJdfQ==
