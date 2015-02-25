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

},{"./messenger":2,"_process":9,"cog/defaults":3,"cog/extend":4,"cog/getable":5,"mbus":10,"rtc-core/genice":14,"rtc-core/plugin":16,"rtc-signaller":20,"rtc-tools":49,"rtc-tools/cleanup":45}],2:[function(require,module,exports){
module.exports = function(messenger) {
  if (typeof messenger == 'function') {
    return messenger;
  }

  return require('rtc-switchboard-messenger')(messenger);
};

},{"rtc-switchboard-messenger":36}],3:[function(require,module,exports){
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
var createTrie = require('array-trie');
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
  var registry = createTrie();
  var feeds = [];

  function bus(name) {
    var args = [].slice.call(arguments, 1);
    var parts = getNameParts(name);
    var delimited = parts.join('.');
    var handlers = registry.get(parts) || [];
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
        bus.parent.apply(scope || this, [namespace.concat(parts)].concat(args))
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
      registry.set(getNameParts(name), []);
    }
    // otherwise, reset the entire handler registry
    else {
      registry = createTrie();
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

  function getNameParts(name) {
    return Array.isArray(name) ? name : (name ? name.split(reDelim) : []);
  }

  /**
    ### `mbus#off(name, handler)`

    Deregister an event handler.
  **/
  function off(name, handler) {
    var handlers = registry.get(getNameParts(name));
    var idx = handlers ? handlers.indexOf(handler) : -1;

    if (idx >= 0) {
      handlers.splice(idx, 1);
    }
  }

  /**
    ### `mbus#on(name, handler)`

    Register an event handler for the event `name`.

  **/
  function on(name, handler) {
    var parts = getNameParts(name);
    var handlers = registry.get(parts);

    if (handlers) {
      handlers.push(handler);
    }
    else {
      registry.set(parts, [ handler ]);
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
    return on(name, function handleEvent() {
      var result = handler.apply(this, arguments);
      bus.off(name, handleEvent);

      return result;
    });
  }

  if (typeof namespace == 'function') {
    parent = namespace;
    namespace = '';
  }

  namespace = (namespace && namespace.split(reDelim)) || [];

  bus.clear = bus.removeAllListeners = clear;
  bus.feed = feed;
  bus.on = bus.addListener = on;
  bus.once = once;
  bus.off = bus.removeListener = off;
  bus.parent = parent || (namespace && namespace.length > 0 && createBus());

  return bus;
};

},{"array-trie":12}],11:[function(require,module,exports){
"use strict"

function compileSearch(funcName, predicate, reversed, extraArgs, useNdarray, earlyOut) {
  var code = [
    "function ", funcName, "(a,l,h,", extraArgs.join(","),  "){",
earlyOut ? "" : "var i=", (reversed ? "l-1" : "h+1"),
";while(l<=h){\
var m=(l+h)>>>1,x=a", useNdarray ? ".get(m)" : "[m]"]
  if(earlyOut) {
    if(predicate.indexOf("c") < 0) {
      code.push(";if(x===y){return m}else if(x<=y){")
    } else {
      code.push(";var p=c(x,y);if(p===0){return m}else if(p<=0){")
    }
  } else {
    code.push(";if(", predicate, "){i=m;")
  }
  if(reversed) {
    code.push("l=m+1}else{h=m-1}")
  } else {
    code.push("h=m-1}else{l=m+1}")
  }
  code.push("}")
  if(earlyOut) {
    code.push("return -1};")
  } else {
    code.push("return i};")
  }
  return code.join("")
}

function compileBoundsSearch(predicate, reversed, suffix, earlyOut) {
  var result = new Function([
  compileSearch("A", "x" + predicate + "y", reversed, ["y"], false, earlyOut),
  compileSearch("B", "x" + predicate + "y", reversed, ["y"], true, earlyOut),
  compileSearch("P", "c(x,y)" + predicate + "0", reversed, ["y", "c"], false, earlyOut),
  compileSearch("Q", "c(x,y)" + predicate + "0", reversed, ["y", "c"], true, earlyOut),
"function dispatchBsearch", suffix, "(a,y,c,l,h){\
if(a.shape){\
if(typeof(c)==='function'){\
return Q(a,(l===undefined)?0:l|0,(h===undefined)?a.shape[0]-1:h|0,y,c)\
}else{\
return B(a,(c===undefined)?0:c|0,(l===undefined)?a.shape[0]-1:l|0,y)\
}}else{\
if(typeof(c)==='function'){\
return P(a,(l===undefined)?0:l|0,(h===undefined)?a.length-1:h|0,y,c)\
}else{\
return A(a,(c===undefined)?0:c|0,(l===undefined)?a.length-1:l|0,y)\
}}}\
return dispatchBsearch", suffix].join(""))
  return result()
}

module.exports = {
  ge: compileBoundsSearch(">=", false, "GE"),
  gt: compileBoundsSearch(">", false, "GT"),
  lt: compileBoundsSearch("<", true, "LT"),
  le: compileBoundsSearch("<=", true, "LE"),
  eq: compileBoundsSearch("-", true, "EQ", true)
}

},{}],12:[function(require,module,exports){
"use strict"

var bounds = require("binary-search-bounds")

module.exports = createTrie

function Trie(symbols, children, value) {
  this.symbols = symbols
  this.children = children
  this.value = value
}

var proto = Trie.prototype

proto.set = function(s, value) {
  if(s.shape) {
    var v = this
    var n = s.shape[0]
    for(var i=0; i<n; ++i) {
      var c = s.get(i)
      var j = bounds.ge(v.symbols, c)
      if(j < v.symbols.length && v.symbols[j] === c) {
        v = v.children[j]
      } else {
        var l = new Trie([], [], value)
        for(var k=n-1; k>i; --k) {
          l = new Trie([s.get(k)], [l])
        }
        v.symbols.splice(j, 0, c)
        v.children.splice(j, 0, l)
        return value
      }
    }
    return v.value = value
  } else {
    var v = this
    var n = s.length
    for(var i=0; i<n; ++i) {
      var c = s[i]
      var j = bounds.ge(v.symbols, c)
      if(j < v.symbols.length && v.symbols[j] === c) {
        v = v.children[j]
      } else {
        var l = new Trie([], [], value)
        for(var k=n-1; k>i; --k) {
          l = new Trie([s[k]], [l])
        }
        v.symbols.splice(j, 0, c)
        v.children.splice(j, 0, l)
        return value
      }
    }
    return v.value = value
  }
}

proto.get = function(s) {
  if(s.shape) {
    var v = this
    var n = s.shape[0]
    for(var i=0; i<n; ++i) {
      var c = s.get(i)
      var j = bounds.eq(v.symbols, c)
      if(j < 0) {
        return
      }
      v = v.children[j]
    }
    return v.value
  } else {
    var v = this
    var n = s.length
    for(var i=0; i<n; ++i) {
      var c = s[i]
      var j = bounds.eq(v.symbols, c)
      if(j < 0) {
        return
      }
      v = v.children[j]
    }
    return v.value
  }
}

function createTrie() {
  return new Trie([],[])
}
},{"binary-search-bounds":11}],13:[function(require,module,exports){
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

},{"detect-browser":15}],14:[function(require,module,exports){
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

},{}],15:[function(require,module,exports){
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

},{}],16:[function(require,module,exports){
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

},{"./detect":13}],17:[function(require,module,exports){
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

},{}],18:[function(require,module,exports){
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

},{"cog/extend":4}],19:[function(require,module,exports){
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

},{"./announce":18}],20:[function(require,module,exports){
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
  version: '5.2.2'
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

},{"./defaults":17,"./processor":35,"cog/defaults":3,"cog/extend":4,"cog/getable":5,"cuid":21,"mbus":10,"pull-pushable":22,"pull-stream":29,"rtc-core/detect":13}],21:[function(require,module,exports){
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

},{}],22:[function(require,module,exports){
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


},{"pull-stream":23}],23:[function(require,module,exports){

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



},{"./maybe":24,"./sinks":26,"./sources":27,"./throughs":28,"pull-core":25}],24:[function(require,module,exports){
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

},{"pull-core":25}],25:[function(require,module,exports){
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


},{}],26:[function(require,module,exports){
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


},{}],27:[function(require,module,exports){

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


},{}],28:[function(require,module,exports){
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

},{"./sinks":26,"./sources":27,"_process":9,"pull-core":25}],29:[function(require,module,exports){
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



},{"./maybe":30,"./sinks":32,"./sources":33,"./throughs":34,"pull-core":31}],30:[function(require,module,exports){
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

},{"pull-core":31}],31:[function(require,module,exports){
arguments[4][25][0].apply(exports,arguments)
},{"dup":25}],32:[function(require,module,exports){
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


},{}],33:[function(require,module,exports){

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


},{}],34:[function(require,module,exports){
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

},{"./sinks":32,"./sources":33,"_process":9,"pull-core":31}],35:[function(require,module,exports){
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

},{"./handlers":19,"cog/jsonparse":6}],36:[function(require,module,exports){
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

},{"cog/extend":4,"messenger-ws":37}],37:[function(require,module,exports){
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

},{"cog/defaults":3,"pull-ws":38,"ws":43,"wsurl":44}],38:[function(require,module,exports){
exports = module.exports = duplex;

exports.source = require('./source');
exports.sink = require('./sink');

function duplex (ws, opts) {
  return {
    source: exports.source(ws),
    sink: exports.sink(ws, opts)
  };
};

},{"./sink":41,"./source":42}],39:[function(require,module,exports){
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


},{}],40:[function(require,module,exports){
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

},{}],41:[function(require,module,exports){
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

},{"./ready":40,"_process":9,"pull-core":39}],42:[function(require,module,exports){
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

},{"./ready":40,"pull-core":39}],43:[function(require,module,exports){

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

},{}],44:[function(require,module,exports){
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

},{}],45:[function(require,module,exports){
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

},{"cog/logger":7}],46:[function(require,module,exports){
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

},{"./cleanup":45,"./monitor":50,"cog/logger":7,"cog/throttle":8,"mbus":10,"rtc-taskqueue":51}],47:[function(require,module,exports){
/* jshint node: true */
'use strict';

/**
  ### rtc-tools/detect

  Provide the [rtc-core/detect](https://github.com/rtc-io/rtc-core#detect)
  functionality.
**/
module.exports = require('rtc-core/detect');

},{"rtc-core/detect":13}],48:[function(require,module,exports){
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

},{"./detect":47,"cog/defaults":3,"cog/logger":7}],49:[function(require,module,exports){
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

},{"./couple":46,"./detect":47,"./generators":48,"cog/logger":7,"rtc-core/plugin":16}],50:[function(require,module,exports){
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

},{"mbus":10}],51:[function(require,module,exports){
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

},{"mbus":10,"priorityqueuejs":52,"rtc-core/detect":13,"rtc-core/plugin":16,"rtc-sdpclean":53,"rtc-validator/candidate":54}],52:[function(require,module,exports){
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
  if (a instanceof Number && b instanceof Number) {
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

    if (left < size && this._compare(left, largest) > 0) {
      largest = left;
    }

    if (right < size && this._compare(right, largest) > 0) {
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

    if (this._compare(current, parent) < 0) break;

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

},{}],53:[function(require,module,exports){
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

},{"rtc-validator/candidate":54}],54:[function(require,module,exports){
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9ncnVudC1icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJpbmRleC5qcyIsIm1lc3Nlbmdlci5qcyIsIm5vZGVfbW9kdWxlcy9jb2cvZGVmYXVsdHMuanMiLCJub2RlX21vZHVsZXMvY29nL2V4dGVuZC5qcyIsIm5vZGVfbW9kdWxlcy9jb2cvZ2V0YWJsZS5qcyIsIm5vZGVfbW9kdWxlcy9jb2cvanNvbnBhcnNlLmpzIiwibm9kZV9tb2R1bGVzL2NvZy9sb2dnZXIuanMiLCJub2RlX21vZHVsZXMvY29nL3Rocm90dGxlLmpzIiwibm9kZV9tb2R1bGVzL2dydW50LWJyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3Byb2Nlc3MvYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy9tYnVzL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL21idXMvbm9kZV9tb2R1bGVzL2FycmF5LXRyaWUvbm9kZV9tb2R1bGVzL2JpbmFyeS1zZWFyY2gtYm91bmRzL3NlYXJjaC1ib3VuZHMuanMiLCJub2RlX21vZHVsZXMvbWJ1cy9ub2RlX21vZHVsZXMvYXJyYXktdHJpZS90cmllLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1jb3JlL2RldGVjdC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtY29yZS9nZW5pY2UuanMiLCJub2RlX21vZHVsZXMvcnRjLWNvcmUvbm9kZV9tb2R1bGVzL2RldGVjdC1icm93c2VyL2Jyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvcnRjLWNvcmUvcGx1Z2luLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvZGVmYXVsdHMuanMiLCJub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9oYW5kbGVycy9hbm5vdW5jZS5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL2hhbmRsZXJzL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvY3VpZC9kaXN0L2Jyb3dzZXItY3VpZC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXB1c2hhYmxlL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3B1bGwtcHVzaGFibGUvbm9kZV9tb2R1bGVzL3B1bGwtc3RyZWFtL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3B1bGwtcHVzaGFibGUvbm9kZV9tb2R1bGVzL3B1bGwtc3RyZWFtL21heWJlLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3B1bGwtcHVzaGFibGUvbm9kZV9tb2R1bGVzL3B1bGwtc3RyZWFtL25vZGVfbW9kdWxlcy9wdWxsLWNvcmUvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcHVsbC1wdXNoYWJsZS9ub2RlX21vZHVsZXMvcHVsbC1zdHJlYW0vc2lua3MuanMiLCJub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcHVsbC1wdXNoYWJsZS9ub2RlX21vZHVsZXMvcHVsbC1zdHJlYW0vc291cmNlcy5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXB1c2hhYmxlL25vZGVfbW9kdWxlcy9wdWxsLXN0cmVhbS90aHJvdWdocy5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXN0cmVhbS9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXN0cmVhbS9tYXliZS5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXN0cmVhbS9zaW5rcy5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXN0cmVhbS9zb3VyY2VzLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3B1bGwtc3RyZWFtL3Rocm91Z2hzLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvcHJvY2Vzc29yLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zd2l0Y2hib2FyZC1tZXNzZW5nZXIvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXN3aXRjaGJvYXJkLW1lc3Nlbmdlci9ub2RlX21vZHVsZXMvbWVzc2VuZ2VyLXdzL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zd2l0Y2hib2FyZC1tZXNzZW5nZXIvbm9kZV9tb2R1bGVzL21lc3Nlbmdlci13cy9ub2RlX21vZHVsZXMvcHVsbC13cy9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc3dpdGNoYm9hcmQtbWVzc2VuZ2VyL25vZGVfbW9kdWxlcy9tZXNzZW5nZXItd3Mvbm9kZV9tb2R1bGVzL3B1bGwtd3Mvbm9kZV9tb2R1bGVzL3B1bGwtY29yZS9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc3dpdGNoYm9hcmQtbWVzc2VuZ2VyL25vZGVfbW9kdWxlcy9tZXNzZW5nZXItd3Mvbm9kZV9tb2R1bGVzL3B1bGwtd3MvcmVhZHkuanMiLCJub2RlX21vZHVsZXMvcnRjLXN3aXRjaGJvYXJkLW1lc3Nlbmdlci9ub2RlX21vZHVsZXMvbWVzc2VuZ2VyLXdzL25vZGVfbW9kdWxlcy9wdWxsLXdzL3NpbmsuanMiLCJub2RlX21vZHVsZXMvcnRjLXN3aXRjaGJvYXJkLW1lc3Nlbmdlci9ub2RlX21vZHVsZXMvbWVzc2VuZ2VyLXdzL25vZGVfbW9kdWxlcy9wdWxsLXdzL3NvdXJjZS5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc3dpdGNoYm9hcmQtbWVzc2VuZ2VyL25vZGVfbW9kdWxlcy9tZXNzZW5nZXItd3Mvbm9kZV9tb2R1bGVzL3dzL2xpYi9icm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zd2l0Y2hib2FyZC1tZXNzZW5nZXIvbm9kZV9tb2R1bGVzL21lc3Nlbmdlci13cy9ub2RlX21vZHVsZXMvd3N1cmwvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL2NsZWFudXAuanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL2NvdXBsZS5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtdG9vbHMvZGV0ZWN0LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy10b29scy9nZW5lcmF0b3JzLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy10b29scy9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtdG9vbHMvbW9uaXRvci5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtdG9vbHMvbm9kZV9tb2R1bGVzL3J0Yy10YXNrcXVldWUvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL25vZGVfbW9kdWxlcy9ydGMtdGFza3F1ZXVlL25vZGVfbW9kdWxlcy9wcmlvcml0eXF1ZXVlanMvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL25vZGVfbW9kdWxlcy9ydGMtdGFza3F1ZXVlL25vZGVfbW9kdWxlcy9ydGMtc2RwY2xlYW4vaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL25vZGVfbW9kdWxlcy9ydGMtdGFza3F1ZXVlL25vZGVfbW9kdWxlcy9ydGMtdmFsaWRhdG9yL2NhbmRpZGF0ZS5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDOTFCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1BBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JJQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2S0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNURBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0VBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDYkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbmJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5R0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzFCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeERBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbkhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3RKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDcFNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMvREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQzVKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQ3ZVQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUMvQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUNuREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0VBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdk9BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDelZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUtBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dmFyIGY9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKTt0aHJvdyBmLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsZn12YXIgbD1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwobC5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxsLGwuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIHJ0YyA9IHJlcXVpcmUoJ3J0Yy10b29scycpO1xudmFyIG1idXMgPSByZXF1aXJlKCdtYnVzJyk7XG52YXIgY2xlYW51cCA9IHJlcXVpcmUoJ3J0Yy10b29scy9jbGVhbnVwJyk7XG52YXIgZGV0ZWN0UGx1Z2luID0gcmVxdWlyZSgncnRjLWNvcmUvcGx1Z2luJyk7XG52YXIgZGVidWcgPSBydGMubG9nZ2VyKCdydGMtcXVpY2tjb25uZWN0Jyk7XG52YXIgZGVmYXVsdHMgPSByZXF1aXJlKCdjb2cvZGVmYXVsdHMnKTtcbnZhciBleHRlbmQgPSByZXF1aXJlKCdjb2cvZXh0ZW5kJyk7XG52YXIgZ2V0YWJsZSA9IHJlcXVpcmUoJ2NvZy9nZXRhYmxlJyk7XG52YXIgbWVzc2VuZ2VyID0gcmVxdWlyZSgnLi9tZXNzZW5nZXInKTtcbnZhciByZVRyYWlsaW5nU2xhc2ggPSAvXFwvJC87XG5cbi8qKlxuICAjIHJ0Yy1xdWlja2Nvbm5lY3RcblxuICBUaGlzIGlzIGEgaGlnaCBsZXZlbCBoZWxwZXIgbW9kdWxlIGRlc2lnbmVkIHRvIGhlbHAgeW91IGdldCB1cFxuICBhbiBydW5uaW5nIHdpdGggV2ViUlRDIHJlYWxseSwgcmVhbGx5IHF1aWNrbHkuICBCeSB1c2luZyB0aGlzIG1vZHVsZSB5b3VcbiAgYXJlIHRyYWRpbmcgb2ZmIHNvbWUgZmxleGliaWxpdHksIHNvIGlmIHlvdSBuZWVkIGEgbW9yZSBmbGV4aWJsZVxuICBjb25maWd1cmF0aW9uIHlvdSBzaG91bGQgZHJpbGwgZG93biBpbnRvIGxvd2VyIGxldmVsIGNvbXBvbmVudHMgb2YgdGhlXG4gIFtydGMuaW9dKGh0dHA6Ly93d3cucnRjLmlvKSBzdWl0ZS4gIEluIHBhcnRpY3VsYXIgeW91IHNob3VsZCBjaGVjayBvdXRcbiAgW3J0Y10oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMpLlxuXG4gICMjIEV4YW1wbGUgVXNhZ2VcblxuICBJbiB0aGUgc2ltcGxlc3QgY2FzZSB5b3Ugc2ltcGx5IGNhbGwgcXVpY2tjb25uZWN0IHdpdGggYSBzaW5nbGUgc3RyaW5nXG4gIGFyZ3VtZW50IHdoaWNoIHRlbGxzIHF1aWNrY29ubmVjdCB3aGljaCBzZXJ2ZXIgdG8gdXNlIGZvciBzaWduYWxpbmc6XG5cbiAgPDw8IGV4YW1wbGVzL3NpbXBsZS5qc1xuXG4gIDw8PCBkb2NzL2V2ZW50cy5tZFxuXG4gIDw8PCBkb2NzL2V4YW1wbGVzLm1kXG5cbiAgIyMgUmVnYXJkaW5nIFNpZ25hbGxpbmcgYW5kIGEgU2lnbmFsbGluZyBTZXJ2ZXJcblxuICBTaWduYWxpbmcgaXMgYW4gaW1wb3J0YW50IHBhcnQgb2Ygc2V0dGluZyB1cCBhIFdlYlJUQyBjb25uZWN0aW9uIGFuZCBmb3JcbiAgb3VyIGV4YW1wbGVzIHdlIHVzZSBvdXIgb3duIHRlc3QgaW5zdGFuY2Ugb2YgdGhlXG4gIFtydGMtc3dpdGNoYm9hcmRdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLXN3aXRjaGJvYXJkKS4gRm9yIHlvdXJcbiAgdGVzdGluZyBhbmQgZGV2ZWxvcG1lbnQgeW91IGFyZSBtb3JlIHRoYW4gd2VsY29tZSB0byB1c2UgdGhpcyBhbHNvLCBidXRcbiAganVzdCBiZSBhd2FyZSB0aGF0IHdlIHVzZSB0aGlzIGZvciBvdXIgdGVzdGluZyBzbyBpdCBtYXkgZ28gdXAgYW5kIGRvd25cbiAgYSBsaXR0bGUuICBJZiB5b3UgbmVlZCBzb21ldGhpbmcgbW9yZSBzdGFibGUsIHdoeSBub3QgY29uc2lkZXIgZGVwbG95aW5nXG4gIGFuIGluc3RhbmNlIG9mIHRoZSBzd2l0Y2hib2FyZCB5b3Vyc2VsZiAtIGl0J3MgcHJldHR5IGVhc3kgOilcblxuICAjIyBSZWZlcmVuY2VcblxuICBgYGBcbiAgcXVpY2tjb25uZWN0KHNpZ25hbGhvc3QsIG9wdHM/KSA9PiBydGMtc2lnYWxsZXIgaW5zdGFuY2UgKCsgaGVscGVycylcbiAgYGBgXG5cbiAgIyMjIFZhbGlkIFF1aWNrIENvbm5lY3QgT3B0aW9uc1xuXG4gIFRoZSBvcHRpb25zIHByb3ZpZGVkIHRvIHRoZSBgcnRjLXF1aWNrY29ubmVjdGAgbW9kdWxlIGZ1bmN0aW9uIGluZmx1ZW5jZSB0aGVcbiAgYmVoYXZpb3VyIG9mIHNvbWUgb2YgdGhlIHVuZGVybHlpbmcgY29tcG9uZW50cyB1c2VkIGZyb20gdGhlIHJ0Yy5pbyBzdWl0ZS5cblxuICBMaXN0ZWQgYmVsb3cgYXJlIHNvbWUgb2YgdGhlIGNvbW1vbmx5IHVzZWQgb3B0aW9uczpcblxuICAtIGBuc2AgKGRlZmF1bHQ6ICcnKVxuXG4gICAgQW4gb3B0aW9uYWwgbmFtZXNwYWNlIGZvciB5b3VyIHNpZ25hbGxpbmcgcm9vbS4gIFdoaWxlIHF1aWNrY29ubmVjdFxuICAgIHdpbGwgZ2VuZXJhdGUgYSB1bmlxdWUgaGFzaCBmb3IgdGhlIHJvb20sIHRoaXMgY2FuIGJlIG1hZGUgdG8gYmUgbW9yZVxuICAgIHVuaXF1ZSBieSBwcm92aWRpbmcgYSBuYW1lc3BhY2UuICBVc2luZyBhIG5hbWVzcGFjZSBtZWFucyB0d28gZGVtb3NcbiAgICB0aGF0IGhhdmUgZ2VuZXJhdGVkIHRoZSBzYW1lIGhhc2ggYnV0IHVzZSBhIGRpZmZlcmVudCBuYW1lc3BhY2Ugd2lsbCBiZVxuICAgIGluIGRpZmZlcmVudCByb29tcy5cblxuICAtIGByb29tYCAoZGVmYXVsdDogbnVsbCkgX2FkZGVkIDAuNl9cblxuICAgIFJhdGhlciB0aGFuIHVzZSB0aGUgaW50ZXJuYWwgaGFzaCBnZW5lcmF0aW9uXG4gICAgKHBsdXMgb3B0aW9uYWwgbmFtZXNwYWNlKSBmb3Igcm9vbSBuYW1lIGdlbmVyYXRpb24sIHNpbXBseSB1c2UgdGhpcyByb29tXG4gICAgbmFtZSBpbnN0ZWFkLiAgX19OT1RFOl9fIFVzZSBvZiB0aGUgYHJvb21gIG9wdGlvbiB0YWtlcyBwcmVjZW5kZW5jZSBvdmVyXG4gICAgYG5zYC5cblxuICAtIGBkZWJ1Z2AgKGRlZmF1bHQ6IGZhbHNlKVxuXG4gIFdyaXRlIHJ0Yy5pbyBzdWl0ZSBkZWJ1ZyBvdXRwdXQgdG8gdGhlIGJyb3dzZXIgY29uc29sZS5cblxuICAtIGBleHBlY3RlZExvY2FsU3RyZWFtc2AgKGRlZmF1bHQ6IG5vdCBzcGVjaWZpZWQpIF9hZGRlZCAzLjBfXG5cbiAgICBCeSBwcm92aWRpbmcgYSBwb3NpdGl2ZSBpbnRlZ2VyIHZhbHVlIGZvciB0aGlzIG9wdGlvbiB3aWxsIG1lYW4gdGhhdFxuICAgIHRoZSBjcmVhdGVkIHF1aWNrY29ubmVjdCBpbnN0YW5jZSB3aWxsIHdhaXQgdW50aWwgdGhlIHNwZWNpZmllZCBudW1iZXIgb2ZcbiAgICBzdHJlYW1zIGhhdmUgYmVlbiBhZGRlZCB0byB0aGUgcXVpY2tjb25uZWN0IFwidGVtcGxhdGVcIiBiZWZvcmUgYW5ub3VuY2luZ1xuICAgIHRvIHRoZSBzaWduYWxpbmcgc2VydmVyLlxuXG4gIC0gYG1hbnVhbEpvaW5gIChkZWZhdWx0OiBgZmFsc2VgKVxuXG4gICAgU2V0IHRoaXMgdmFsdWUgdG8gYHRydWVgIGlmIHlvdSB3b3VsZCBwcmVmZXIgdG8gY2FsbCB0aGUgYGpvaW5gIGZ1bmN0aW9uXG4gICAgdG8gY29ubmVjdGluZyB0byB0aGUgc2lnbmFsbGluZyBzZXJ2ZXIsIHJhdGhlciB0aGFuIGhhdmluZyB0aGF0IGhhcHBlblxuICAgIGF1dG9tYXRpY2FsbHkgYXMgc29vbiBhcyBxdWlja2Nvbm5lY3QgaXMgcmVhZHkgdG8uXG5cbiAgIyMjIyBPcHRpb25zIGZvciBQZWVyIENvbm5lY3Rpb24gQ3JlYXRpb25cblxuICBPcHRpb25zIHRoYXQgYXJlIHBhc3NlZCBvbnRvIHRoZVxuICBbcnRjLmNyZWF0ZUNvbm5lY3Rpb25dKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjI2NyZWF0ZWNvbm5lY3Rpb25vcHRzLWNvbnN0cmFpbnRzKVxuICBmdW5jdGlvbjpcblxuICAtIGBpY2VTZXJ2ZXJzYFxuXG4gIFRoaXMgcHJvdmlkZXMgYSBsaXN0IG9mIGljZSBzZXJ2ZXJzIHRoYXQgY2FuIGJlIHVzZWQgdG8gaGVscCBuZWdvdGlhdGUgYVxuICBjb25uZWN0aW9uIGJldHdlZW4gcGVlcnMuXG5cbiAgIyMjIyBPcHRpb25zIGZvciBQMlAgbmVnb3RpYXRpb25cblxuICBVbmRlciB0aGUgaG9vZCwgcXVpY2tjb25uZWN0IHVzZXMgdGhlXG4gIFtydGMvY291cGxlXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0YyNydGNjb3VwbGUpIGxvZ2ljLCBhbmQgdGhlIG9wdGlvbnNcbiAgcGFzc2VkIHRvIHF1aWNrY29ubmVjdCBhcmUgYWxzbyBwYXNzZWQgb250byB0aGlzIGZ1bmN0aW9uLlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oc2lnbmFsaG9zdCwgb3B0cykge1xuICB2YXIgaGFzaCA9IHR5cGVvZiBsb2NhdGlvbiAhPSAndW5kZWZpbmVkJyAmJiBsb2NhdGlvbi5oYXNoLnNsaWNlKDEpO1xuICB2YXIgc2lnbmFsbGVyID0gcmVxdWlyZSgncnRjLXNpZ25hbGxlcicpKG1lc3NlbmdlcihzaWduYWxob3N0KSwgb3B0cyk7XG5cbiAgLy8gaW5pdCBjb25maWd1cmFibGUgdmFyc1xuICB2YXIgbnMgPSAob3B0cyB8fCB7fSkubnMgfHwgJyc7XG4gIHZhciByb29tID0gKG9wdHMgfHwge30pLnJvb207XG4gIHZhciBkZWJ1Z2dpbmcgPSAob3B0cyB8fCB7fSkuZGVidWc7XG4gIHZhciBhbGxvd0pvaW4gPSAhKG9wdHMgfHwge30pLm1hbnVhbEpvaW47XG4gIHZhciBoZWFydGJlYXQgPSAob3B0cyB8fCB7fSkuaGVhcnRiZWF0IHx8IDI1MDA7XG4gIHZhciBwcm9maWxlID0ge307XG4gIHZhciBhbm5vdW5jZWQgPSBmYWxzZTtcblxuICAvLyBpbml0aWFsaXNlIGljZVNlcnZlcnMgdG8gdW5kZWZpbmVkXG4gIC8vIHdlIHdpbGwgbm90IGFubm91bmNlIHVudGlsIHRoZXNlIGhhdmUgYmVlbiBwcm9wZXJseSBpbml0aWFsaXNlZFxuICB2YXIgaWNlU2VydmVycztcblxuICAvLyBjb2xsZWN0IHRoZSBsb2NhbCBzdHJlYW1zXG4gIHZhciBsb2NhbFN0cmVhbXMgPSBbXTtcblxuICAvLyBjcmVhdGUgdGhlIGNhbGxzIG1hcFxuICB2YXIgY2FsbHMgPSBzaWduYWxsZXIuY2FsbHMgPSBnZXRhYmxlKHt9KTtcblxuICAvLyBjcmVhdGUgdGhlIGtub3duIGRhdGEgY2hhbm5lbHMgcmVnaXN0cnlcbiAgdmFyIGNoYW5uZWxzID0ge307XG5cbiAgLy8gc2F2ZSB0aGUgcGx1Z2lucyBwYXNzZWQgdG8gdGhlIHNpZ25hbGxlclxuICB2YXIgcGx1Z2lucyA9IHNpZ25hbGxlci5wbHVnaW5zID0gKG9wdHMgfHwge30pLnBsdWdpbnMgfHwgW107XG4gIHZhciBwbHVnaW4gPSBkZXRlY3RQbHVnaW4oc2lnbmFsbGVyLnBsdWdpbnMpO1xuICB2YXIgcGx1Z2luUmVhZHk7XG5cbiAgLy8gY2hlY2sgaG93IG1hbnkgbG9jYWwgc3RyZWFtcyBoYXZlIGJlZW4gZXhwZWN0ZWQgKGRlZmF1bHQ6IDApXG4gIHZhciBleHBlY3RlZExvY2FsU3RyZWFtcyA9IHBhcnNlSW50KChvcHRzIHx8IHt9KS5leHBlY3RlZExvY2FsU3RyZWFtcywgMTApIHx8IDA7XG4gIHZhciBhbm5vdW5jZVRpbWVyID0gMDtcbiAgdmFyIGhlYXJ0YmVhdFRpbWVyID0gMDtcbiAgdmFyIHVwZGF0ZVRpbWVyID0gMDtcblxuICBmdW5jdGlvbiBjYWxsQ3JlYXRlKGlkLCBwYykge1xuICAgIGNhbGxzLnNldChpZCwge1xuICAgICAgYWN0aXZlOiBmYWxzZSxcbiAgICAgIHBjOiBwYyxcbiAgICAgIGNoYW5uZWxzOiBnZXRhYmxlKHt9KSxcbiAgICAgIHN0cmVhbXM6IFtdLFxuICAgICAgbGFzdHBpbmc6IERhdGUubm93KClcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNhbGxFbmQoaWQpIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChpZCk7XG5cbiAgICAvLyBpZiB3ZSBoYXZlIG5vIGRhdGEsIHRoZW4gZG8gbm90aGluZ1xuICAgIGlmICghIGNhbGwpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBkZWJ1ZygnZW5kaW5nIGNhbGwgdG86ICcgKyBpZCk7XG5cbiAgICAvLyBpZiB3ZSBoYXZlIG5vIGRhdGEsIHRoZW4gcmV0dXJuXG4gICAgY2FsbC5jaGFubmVscy5rZXlzKCkuZm9yRWFjaChmdW5jdGlvbihsYWJlbCkge1xuICAgICAgdmFyIGNoYW5uZWwgPSBjYWxsLmNoYW5uZWxzLmdldChsYWJlbCk7XG4gICAgICB2YXIgYXJncyA9IFtpZCwgY2hhbm5lbCwgbGFiZWxdO1xuXG4gICAgICAvLyBlbWl0IHRoZSBwbGFpbiBjaGFubmVsOmNsb3NlZCBldmVudFxuICAgICAgc2lnbmFsbGVyLmFwcGx5KHNpZ25hbGxlciwgWydjaGFubmVsOmNsb3NlZCddLmNvbmNhdChhcmdzKSk7XG5cbiAgICAgIC8vIGVtaXQgdGhlIGxhYmVsbGVkIHZlcnNpb24gb2YgdGhlIGV2ZW50XG4gICAgICBzaWduYWxsZXIuYXBwbHkoc2lnbmFsbGVyLCBbJ2NoYW5uZWw6Y2xvc2VkOicgKyBsYWJlbF0uY29uY2F0KGFyZ3MpKTtcblxuICAgICAgLy8gZGVjb3VwbGUgdGhlIGV2ZW50c1xuICAgICAgY2hhbm5lbC5vbm9wZW4gPSBudWxsO1xuICAgIH0pO1xuXG4gICAgLy8gdHJpZ2dlciBzdHJlYW06cmVtb3ZlZCBldmVudHMgZm9yIGVhY2ggb2YgdGhlIHJlbW90ZXN0cmVhbXMgaW4gdGhlIHBjXG4gICAgY2FsbC5zdHJlYW1zLmZvckVhY2goZnVuY3Rpb24oc3RyZWFtKSB7XG4gICAgICBzaWduYWxsZXIoJ3N0cmVhbTpyZW1vdmVkJywgaWQsIHN0cmVhbSk7XG4gICAgfSk7XG5cbiAgICAvLyBkZWxldGUgdGhlIGNhbGwgZGF0YVxuICAgIGNhbGxzLmRlbGV0ZShpZCk7XG5cbiAgICAvLyBpZiB3ZSBoYXZlIG5vIG1vcmUgY2FsbHMsIGRpc2FibGUgdGhlIGhlYXJ0YmVhdFxuICAgIGlmIChjYWxscy5rZXlzKCkubGVuZ3RoID09PSAwKSB7XG4gICAgICBoYlJlc2V0KCk7XG4gICAgfVxuXG4gICAgLy8gdHJpZ2dlciB0aGUgY2FsbDplbmRlZCBldmVudFxuICAgIHNpZ25hbGxlcignY2FsbDplbmRlZCcsIGlkLCBjYWxsLnBjKTtcblxuICAgIC8vIGVuc3VyZSB0aGUgcGVlciBjb25uZWN0aW9uIGlzIHByb3Blcmx5IGNsZWFuZWQgdXBcbiAgICBjbGVhbnVwKGNhbGwucGMpO1xuICB9XG5cbiAgZnVuY3Rpb24gY2FsbFN0YXJ0KGlkLCBwYywgZGF0YSkge1xuICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KGlkKTtcbiAgICB2YXIgc3RyZWFtcyA9IFtdLmNvbmNhdChwYy5nZXRSZW1vdGVTdHJlYW1zKCkpO1xuXG4gICAgLy8gZmxhZyB0aGUgY2FsbCBhcyBhY3RpdmVcbiAgICBjYWxsLmFjdGl2ZSA9IHRydWU7XG4gICAgY2FsbC5zdHJlYW1zID0gW10uY29uY2F0KHBjLmdldFJlbW90ZVN0cmVhbXMoKSk7XG5cbiAgICBwYy5vbmFkZHN0cmVhbSA9IGNyZWF0ZVN0cmVhbUFkZEhhbmRsZXIoaWQpO1xuICAgIHBjLm9ucmVtb3Zlc3RyZWFtID0gY3JlYXRlU3RyZWFtUmVtb3ZlSGFuZGxlcihpZCk7XG5cbiAgICBkZWJ1ZyhzaWduYWxsZXIuaWQgKyAnIC0gJyArIGlkICsgJyBjYWxsIHN0YXJ0OiAnICsgc3RyZWFtcy5sZW5ndGggKyAnIHN0cmVhbXMnKTtcbiAgICBzaWduYWxsZXIoJ2NhbGw6c3RhcnRlZCcsIGlkLCBwYywgZGF0YSk7XG5cbiAgICAvLyBjb25maWd1cmUgdGhlIGhlYXJ0YmVhdCB0aW1lclxuICAgIGhiSW5pdCgpO1xuXG4gICAgLy8gZXhhbWluZSB0aGUgZXhpc3RpbmcgcmVtb3RlIHN0cmVhbXMgYWZ0ZXIgYSBzaG9ydCBkZWxheVxuICAgIHByb2Nlc3MubmV4dFRpY2soZnVuY3Rpb24oKSB7XG4gICAgICAvLyBpdGVyYXRlIHRocm91Z2ggYW55IHJlbW90ZSBzdHJlYW1zXG4gICAgICBzdHJlYW1zLmZvckVhY2gocmVjZWl2ZVJlbW90ZVN0cmVhbShpZCkpO1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gY2hlY2tSZWFkeVRvQW5ub3VuY2UoKSB7XG4gICAgY2xlYXJUaW1lb3V0KGFubm91bmNlVGltZXIpO1xuICAgIC8vIGlmIHdlIGhhdmUgYWxyZWFkeSBhbm5vdW5jZWQgZG8gbm90aGluZyFcbiAgICBpZiAoYW5ub3VuY2VkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKCEgYWxsb3dKb2luKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gaWYgd2UgaGF2ZSBhIHBsdWdpbiBidXQgaXQncyBub3QgaW5pdGlhbGl6ZWQgd2UgYXJlbid0IHJlYWR5XG4gICAgaWYgKHBsdWdpbiAmJiAoISBwbHVnaW5SZWFkeSkpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBpZiB3ZSBoYXZlIG5vIGljZVNlcnZlcnMgd2UgYXJlbid0IHJlYWR5XG4gICAgaWYgKCEgaWNlU2VydmVycykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIGlmIHdlIGFyZSB3YWl0aW5nIGZvciBhIHNldCBudW1iZXIgb2Ygc3RyZWFtcywgdGhlbiB3YWl0IHVudGlsIHdlIGhhdmVcbiAgICAvLyB0aGUgcmVxdWlyZWQgbnVtYmVyXG4gICAgaWYgKGV4cGVjdGVkTG9jYWxTdHJlYW1zICYmIGxvY2FsU3RyZWFtcy5sZW5ndGggPCBleHBlY3RlZExvY2FsU3RyZWFtcykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIGFubm91bmNlIG91cnNlbHZlcyB0byBvdXIgbmV3IGZyaWVuZFxuICAgIGFubm91bmNlVGltZXIgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIGRhdGEgPSBleHRlbmQoeyByb29tOiByb29tIH0sIHByb2ZpbGUpO1xuXG4gICAgICAvLyBhbm5vdW5jZSBhbmQgZW1pdCB0aGUgbG9jYWwgYW5ub3VuY2UgZXZlbnRcbiAgICAgIHNpZ25hbGxlci5hbm5vdW5jZShkYXRhKTtcbiAgICAgIGFubm91bmNlZCA9IHRydWU7XG4gICAgfSwgMCk7XG4gIH1cblxuIGZ1bmN0aW9uIGNvbm5lY3QoaWQpIHtcbiAgICB2YXIgZGF0YSA9IGdldFBlZXJEYXRhKGlkKTtcbiAgICB2YXIgcGM7XG4gICAgdmFyIG1vbml0b3I7XG5cbiAgICAvLyBpZiB0aGUgcm9vbSBpcyBub3QgYSBtYXRjaCwgYWJvcnRcbiAgICBpZiAoZGF0YS5yb29tICE9PSByb29tKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gZW5kIGFueSBjYWxsIHRvIHRoaXMgaWQgc28gd2Uga25vdyB3ZSBhcmUgc3RhcnRpbmcgZnJlc2hcbiAgICBjYWxsRW5kKGlkKTtcblxuICAgIC8vIGNyZWF0ZSBhIHBlZXIgY29ubmVjdGlvblxuICAgIC8vIGljZVNlcnZlcnMgdGhhdCBoYXZlIGJlZW4gY3JlYXRlZCB1c2luZyBnZW5pY2UgdGFraW5nIHByZWNlbmRlbmNlXG4gICAgcGMgPSBydGMuY3JlYXRlQ29ubmVjdGlvbihcbiAgICAgIGV4dGVuZCh7fSwgb3B0cywgeyBpY2VTZXJ2ZXJzOiBpY2VTZXJ2ZXJzIH0pLFxuICAgICAgKG9wdHMgfHwge30pLmNvbnN0cmFpbnRzXG4gICAgKTtcblxuICAgIHNpZ25hbGxlcigncGVlcjpjb25uZWN0JywgZGF0YS5pZCwgcGMsIGRhdGEpO1xuXG4gICAgLy8gYWRkIHRoaXMgY29ubmVjdGlvbiB0byB0aGUgY2FsbHMgbGlzdFxuICAgIGNhbGxDcmVhdGUoZGF0YS5pZCwgcGMpO1xuXG4gICAgLy8gYWRkIHRoZSBsb2NhbCBzdHJlYW1zXG4gICAgbG9jYWxTdHJlYW1zLmZvckVhY2goZnVuY3Rpb24oc3RyZWFtLCBpZHgpIHtcbiAgICAgIHBjLmFkZFN0cmVhbShzdHJlYW0pO1xuICAgIH0pO1xuXG4gICAgLy8gYWRkIHRoZSBkYXRhIGNoYW5uZWxzXG4gICAgLy8gZG8gdGhpcyBkaWZmZXJlbnRseSBiYXNlZCBvbiB3aGV0aGVyIHRoZSBjb25uZWN0aW9uIGlzIGFcbiAgICAvLyBtYXN0ZXIgb3IgYSBzbGF2ZSBjb25uZWN0aW9uXG4gICAgaWYgKHNpZ25hbGxlci5pc01hc3RlcihkYXRhLmlkKSkge1xuICAgICAgZGVidWcoJ2lzIG1hc3RlciwgY3JlYXRpbmcgZGF0YSBjaGFubmVsczogJywgT2JqZWN0LmtleXMoY2hhbm5lbHMpKTtcblxuICAgICAgLy8gY3JlYXRlIHRoZSBjaGFubmVsc1xuICAgICAgT2JqZWN0LmtleXMoY2hhbm5lbHMpLmZvckVhY2goZnVuY3Rpb24obGFiZWwpIHtcbiAgICAgICBnb3RQZWVyQ2hhbm5lbChwYy5jcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCwgY2hhbm5lbHNbbGFiZWxdKSwgcGMsIGRhdGEpO1xuICAgICAgfSk7XG4gICAgfVxuICAgIGVsc2Uge1xuICAgICAgcGMub25kYXRhY2hhbm5lbCA9IGZ1bmN0aW9uKGV2dCkge1xuICAgICAgICB2YXIgY2hhbm5lbCA9IGV2dCAmJiBldnQuY2hhbm5lbDtcblxuICAgICAgICAvLyBpZiB3ZSBoYXZlIG5vIGNoYW5uZWwsIGFib3J0XG4gICAgICAgIGlmICghIGNoYW5uZWwpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY2hhbm5lbHNbY2hhbm5lbC5sYWJlbF0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGdvdFBlZXJDaGFubmVsKGNoYW5uZWwsIHBjLCBnZXRQZWVyRGF0YShpZCkpO1xuICAgICAgICB9XG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIGNvdXBsZSB0aGUgY29ubmVjdGlvbnNcbiAgICBkZWJ1ZygnY291cGxpbmcgJyArIHNpZ25hbGxlci5pZCArICcgdG8gJyArIGRhdGEuaWQpO1xuICAgIG1vbml0b3IgPSBydGMuY291cGxlKHBjLCBpZCwgc2lnbmFsbGVyLCBleHRlbmQoe30sIG9wdHMsIHtcbiAgICAgIGxvZ2dlcjogbWJ1cygncGMuJyArIGlkLCBzaWduYWxsZXIpXG4gICAgfSkpO1xuXG4gICAgc2lnbmFsbGVyKCdwZWVyOmNvdXBsZScsIGlkLCBwYywgZGF0YSwgbW9uaXRvcik7XG5cbiAgICAvLyBvbmNlIGFjdGl2ZSwgdHJpZ2dlciB0aGUgcGVlciBjb25uZWN0IGV2ZW50XG4gICAgbW9uaXRvci5vbmNlKCdjb25uZWN0ZWQnLCBjYWxsU3RhcnQuYmluZChudWxsLCBpZCwgcGMsIGRhdGEpKVxuICAgIG1vbml0b3Iub25jZSgnY2xvc2VkJywgY2FsbEVuZC5iaW5kKG51bGwsIGlkKSk7XG5cbiAgICAvLyBpZiB3ZSBhcmUgdGhlIG1hc3RlciBjb25ubmVjdGlvbiwgY3JlYXRlIHRoZSBvZmZlclxuICAgIC8vIE5PVEU6IHRoaXMgb25seSByZWFsbHkgZm9yIHRoZSBzYWtlIG9mIHBvbGl0ZW5lc3MsIGFzIHJ0YyBjb3VwbGVcbiAgICAvLyBpbXBsZW1lbnRhdGlvbiBoYW5kbGVzIHRoZSBzbGF2ZSBhdHRlbXB0aW5nIHRvIGNyZWF0ZSBhbiBvZmZlclxuICAgIGlmIChzaWduYWxsZXIuaXNNYXN0ZXIoaWQpKSB7XG4gICAgICBtb25pdG9yLmNyZWF0ZU9mZmVyKCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gY3JlYXRlU3RyZWFtQWRkSGFuZGxlcihpZCkge1xuICAgIHJldHVybiBmdW5jdGlvbihldnQpIHtcbiAgICAgIGRlYnVnKCdwZWVyICcgKyBpZCArICcgYWRkZWQgc3RyZWFtJyk7XG4gICAgICB1cGRhdGVSZW1vdGVTdHJlYW1zKGlkKTtcbiAgICAgIHJlY2VpdmVSZW1vdGVTdHJlYW0oaWQpKGV2dC5zdHJlYW0pO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGNyZWF0ZVN0cmVhbVJlbW92ZUhhbmRsZXIoaWQpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24oZXZ0KSB7XG4gICAgICBkZWJ1ZygncGVlciAnICsgaWQgKyAnIHJlbW92ZWQgc3RyZWFtJyk7XG4gICAgICB1cGRhdGVSZW1vdGVTdHJlYW1zKGlkKTtcbiAgICAgIHNpZ25hbGxlcignc3RyZWFtOnJlbW92ZWQnLCBpZCwgZXZ0LnN0cmVhbSk7XG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGdldEFjdGl2ZUNhbGwocGVlcklkKSB7XG4gICAgdmFyIGNhbGwgPSBjYWxscy5nZXQocGVlcklkKTtcblxuICAgIGlmICghIGNhbGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gYWN0aXZlIGNhbGwgZm9yIHBlZXI6ICcgKyBwZWVySWQpO1xuICAgIH1cblxuICAgIHJldHVybiBjYWxsO1xuICB9XG5cbiAgZnVuY3Rpb24gZ2V0UGVlckRhdGEoaWQpIHtcbiAgICB2YXIgcGVlciA9IHNpZ25hbGxlci5wZWVycy5nZXQoaWQpO1xuXG4gICAgcmV0dXJuIHBlZXIgJiYgcGVlci5kYXRhO1xuICB9XG5cbiAgZnVuY3Rpb24gZ290UGVlckNoYW5uZWwoY2hhbm5lbCwgcGMsIGRhdGEpIHtcbiAgICB2YXIgY2hhbm5lbE1vbml0b3I7XG5cbiAgICBmdW5jdGlvbiBjaGFubmVsUmVhZHkoKSB7XG4gICAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChkYXRhLmlkKTtcbiAgICAgIHZhciBhcmdzID0gWyBkYXRhLmlkLCBjaGFubmVsLCBkYXRhLCBwYyBdO1xuXG4gICAgICAvLyBkZWNvdXBsZSB0aGUgY2hhbm5lbC5vbm9wZW4gbGlzdGVuZXJcbiAgICAgIGRlYnVnKCdyZXBvcnRpbmcgY2hhbm5lbCBcIicgKyBjaGFubmVsLmxhYmVsICsgJ1wiIHJlYWR5LCBoYXZlIGNhbGw6ICcgKyAoISFjYWxsKSk7XG4gICAgICBjbGVhckludGVydmFsKGNoYW5uZWxNb25pdG9yKTtcbiAgICAgIGNoYW5uZWwub25vcGVuID0gbnVsbDtcblxuICAgICAgLy8gc2F2ZSB0aGUgY2hhbm5lbFxuICAgICAgaWYgKGNhbGwpIHtcbiAgICAgICAgY2FsbC5jaGFubmVscy5zZXQoY2hhbm5lbC5sYWJlbCwgY2hhbm5lbCk7XG4gICAgICB9XG5cbiAgICAgIC8vIHRyaWdnZXIgdGhlICVjaGFubmVsLmxhYmVsJTpvcGVuIGV2ZW50XG4gICAgICBkZWJ1ZygndHJpZ2dlcmluZyBjaGFubmVsOm9wZW5lZCBldmVudHMgZm9yIGNoYW5uZWw6ICcgKyBjaGFubmVsLmxhYmVsKTtcblxuICAgICAgLy8gZW1pdCB0aGUgcGxhaW4gY2hhbm5lbDpvcGVuZWQgZXZlbnRcbiAgICAgIHNpZ25hbGxlci5hcHBseShzaWduYWxsZXIsIFsnY2hhbm5lbDpvcGVuZWQnXS5jb25jYXQoYXJncykpO1xuXG4gICAgICAvLyBlbWl0IHRoZSBjaGFubmVsOm9wZW5lZDolbGFiZWwlIGV2ZVxuICAgICAgc2lnbmFsbGVyLmFwcGx5KFxuICAgICAgICBzaWduYWxsZXIsXG4gICAgICAgIFsnY2hhbm5lbDpvcGVuZWQ6JyArIGNoYW5uZWwubGFiZWxdLmNvbmNhdChhcmdzKVxuICAgICAgKTtcbiAgICB9XG5cbiAgICBkZWJ1ZygnY2hhbm5lbCAnICsgY2hhbm5lbC5sYWJlbCArICcgZGlzY292ZXJlZCBmb3IgcGVlcjogJyArIGRhdGEuaWQpO1xuICAgIGlmIChjaGFubmVsLnJlYWR5U3RhdGUgPT09ICdvcGVuJykge1xuICAgICAgcmV0dXJuIGNoYW5uZWxSZWFkeSgpO1xuICAgIH1cblxuICAgIGRlYnVnKCdjaGFubmVsIG5vdCByZWFkeSwgY3VycmVudCBzdGF0ZSA9ICcgKyBjaGFubmVsLnJlYWR5U3RhdGUpO1xuICAgIGNoYW5uZWwub25vcGVuID0gY2hhbm5lbFJlYWR5O1xuXG4gICAgLy8gbW9uaXRvciB0aGUgY2hhbm5lbCBvcGVuIChkb24ndCB0cnVzdCB0aGUgY2hhbm5lbCBvcGVuIGV2ZW50IGp1c3QgeWV0KVxuICAgIGNoYW5uZWxNb25pdG9yID0gc2V0SW50ZXJ2YWwoZnVuY3Rpb24oKSB7XG4gICAgICBkZWJ1ZygnY2hlY2tpbmcgY2hhbm5lbCBzdGF0ZSwgY3VycmVudCBzdGF0ZSA9ICcgKyBjaGFubmVsLnJlYWR5U3RhdGUpO1xuICAgICAgaWYgKGNoYW5uZWwucmVhZHlTdGF0ZSA9PT0gJ29wZW4nKSB7XG4gICAgICAgIGNoYW5uZWxSZWFkeSgpO1xuICAgICAgfVxuICAgIH0sIDUwMCk7XG4gIH1cblxuICBmdW5jdGlvbiBoYkluaXQoKSB7XG4gICAgLy8gaWYgdGhlIGhlYXJ0YmVhdCB0aW1lciBpcyBhY3RpdmUsIG9yIGhlYXJ0YmVhdCBoYXMgYmVlbiBkaXNhYmxlZCAoMCwgZmFsc2UsIGV0YykgcmV0dXJuXG4gICAgaWYgKGhlYXJ0YmVhdFRpbWVyIHx8ICghIGhlYXJ0YmVhdCkpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBoZWFydGJlYXRUaW1lciA9IHNldEludGVydmFsKGhiU2VuZCwgaGVhcnRiZWF0KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhiU2VuZCgpIHtcbiAgICB2YXIgdGlja0luYWN0aXZlID0gKERhdGUubm93KCkgLSAoaGVhcnRiZWF0ICogNCkpO1xuXG4gICAgLy8gaXRlcmF0ZSB0aHJvdWdoIG91ciBlc3RhYmxpc2hlZCBjYWxsc1xuICAgIGNhbGxzLmtleXMoKS5mb3JFYWNoKGZ1bmN0aW9uKGlkKSB7XG4gICAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChpZCk7XG5cbiAgICAgIC8vIGlmIHRoZSBjYWxsIHBpbmcgaXMgdG9vIG9sZCwgZW5kIHRoZSBjYWxsXG4gICAgICBpZiAoY2FsbC5sYXN0cGluZyA8IHRpY2tJbmFjdGl2ZSkge1xuICAgICAgICByZXR1cm4gY2FsbEVuZChpZCk7XG4gICAgICB9XG5cbiAgICAgIC8vIHNlbmQgYSBwaW5nIG1lc3NhZ2VcbiAgICAgIHNpZ25hbGxlci50byhpZCkuc2VuZCgnL3BpbmcnKTtcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhiUmVzZXQoKSB7XG4gICAgY2xlYXJJbnRlcnZhbChoZWFydGJlYXRUaW1lcik7XG4gICAgaGVhcnRiZWF0VGltZXIgPSAwO1xuICB9XG5cbiAgZnVuY3Rpb24gaW5pdFBsdWdpbigpIHtcbiAgICByZXR1cm4gcGx1Z2luICYmIHBsdWdpbi5pbml0KG9wdHMsIGZ1bmN0aW9uKGVycikge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICByZXR1cm4gY29uc29sZS5lcnJvcignQ291bGQgbm90IGluaXRpYWxpemUgcGx1Z2luOiAnLCBlcnIpO1xuICAgICAgfVxuXG4gICAgICBwbHVnaW5SZWFkeSA9IHRydWU7XG4gICAgICBjaGVja1JlYWR5VG9Bbm5vdW5jZSgpO1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlTG9jYWxBbm5vdW5jZShkYXRhKSB7XG4gICAgLy8gaWYgd2Ugc2VuZCBhbiBhbm5vdW5jZSB3aXRoIGFuIHVwZGF0ZWQgcm9vbSB0aGVuIHVwZGF0ZSBvdXIgbG9jYWwgcm9vbSBuYW1lXG4gICAgaWYgKGRhdGEgJiYgdHlwZW9mIGRhdGEucm9vbSAhPSAndW5kZWZpbmVkJykge1xuICAgICAgcm9vbSA9IGRhdGEucm9vbTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVQZWVyRmlsdGVyKGlkLCBkYXRhKSB7XG4gICAgLy8gb25seSBjb25uZWN0IHdpdGggdGhlIHBlZXIgaWYgd2UgYXJlIHJlYWR5XG4gICAgZGF0YS5hbGxvdyA9IGRhdGEuYWxsb3cgJiYgKGxvY2FsU3RyZWFtcy5sZW5ndGggPj0gZXhwZWN0ZWRMb2NhbFN0cmVhbXMpO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlUGVlclVwZGF0ZShkYXRhKSB7XG4gICAgdmFyIGlkID0gZGF0YSAmJiBkYXRhLmlkO1xuICAgIHZhciBhY3RpdmVDYWxsID0gaWQgJiYgY2FsbHMuZ2V0KGlkKTtcblxuICAgIC8vIGlmIHdlIGhhdmUgcmVjZWl2ZWQgYW4gdXBkYXRlIGZvciBhIHBlZXIgdGhhdCBoYXMgbm8gYWN0aXZlIGNhbGxzLFxuICAgIC8vIHRoZW4gcGFzcyB0aGlzIG9udG8gdGhlIGFubm91bmNlIGhhbmRsZXJcbiAgICBpZiAoaWQgJiYgKCEgYWN0aXZlQ2FsbCkpIHtcbiAgICAgIGRlYnVnKCdyZWNlaXZlZCBwZWVyIHVwZGF0ZSBmcm9tIHBlZXIgJyArIGlkICsgJywgbm8gYWN0aXZlIGNhbGxzJyk7XG4gICAgICBzaWduYWxsZXIudG8oaWQpLnNlbmQoJy9yZWNvbm5lY3QnKTtcbiAgICAgIHJldHVybiBjb25uZWN0KGlkKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVQaW5nKHNlbmRlcikge1xuICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KHNlbmRlciAmJiBzZW5kZXIuaWQpO1xuXG4gICAgLy8gc2V0IHRoZSBsYXN0IHBpbmcgZm9yIHRoZSBkYXRhXG4gICAgaWYgKGNhbGwpIHtcbiAgICAgIGNhbGwubGFzdHBpbmcgPSBEYXRlLm5vdygpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHJlY2VpdmVSZW1vdGVTdHJlYW0oaWQpIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChpZCk7XG5cbiAgICByZXR1cm4gZnVuY3Rpb24oc3RyZWFtKSB7XG4gICAgICBzaWduYWxsZXIoJ3N0cmVhbTphZGRlZCcsIGlkLCBzdHJlYW0sIGdldFBlZXJEYXRhKGlkKSk7XG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHVwZGF0ZVJlbW90ZVN0cmVhbXMoaWQpIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChpZCk7XG5cbiAgICBpZiAoY2FsbCAmJiBjYWxsLnBjKSB7XG4gICAgICBjYWxsLnN0cmVhbXMgPSBbXS5jb25jYXQoY2FsbC5wYy5nZXRSZW1vdGVTdHJlYW1zKCkpO1xuICAgIH1cbiAgfVxuXG4gIC8vIGlmIHRoZSByb29tIGlzIG5vdCBkZWZpbmVkLCB0aGVuIGdlbmVyYXRlIHRoZSByb29tIG5hbWVcbiAgaWYgKCEgcm9vbSkge1xuICAgIC8vIGlmIHRoZSBoYXNoIGlzIG5vdCBhc3NpZ25lZCwgdGhlbiBjcmVhdGUgYSByYW5kb20gaGFzaCB2YWx1ZVxuICAgIGlmICh0eXBlb2YgbG9jYXRpb24gIT0gJ3VuZGVmaW5lZCcgJiYgKCEgaGFzaCkpIHtcbiAgICAgIGhhc2ggPSBsb2NhdGlvbi5oYXNoID0gJycgKyAoTWF0aC5wb3coMiwgNTMpICogTWF0aC5yYW5kb20oKSk7XG4gICAgfVxuXG4gICAgcm9vbSA9IG5zICsgJyMnICsgaGFzaDtcbiAgfVxuXG4gIGlmIChkZWJ1Z2dpbmcpIHtcbiAgICBydGMubG9nZ2VyLmVuYWJsZS5hcHBseShydGMubG9nZ2VyLCBBcnJheS5pc0FycmF5KGRlYnVnKSA/IGRlYnVnZ2luZyA6IFsnKiddKTtcbiAgfVxuXG4gIHNpZ25hbGxlci5vbigncGVlcjphbm5vdW5jZScsIGZ1bmN0aW9uKGRhdGEpIHtcbiAgICBjb25uZWN0KGRhdGEuaWQpO1xuICB9KTtcblxuICBzaWduYWxsZXIub24oJ3BlZXI6dXBkYXRlJywgaGFuZGxlUGVlclVwZGF0ZSk7XG5cbiAgc2lnbmFsbGVyLm9uKCdtZXNzYWdlOnJlY29ubmVjdCcsIGZ1bmN0aW9uKHNlbmRlcikge1xuICAgIGNvbm5lY3Qoc2VuZGVyLmlkKTtcbiAgfSk7XG5cblxuXG4gIC8qKlxuICAgICMjIyBRdWlja2Nvbm5lY3QgQnJvYWRjYXN0IGFuZCBEYXRhIENoYW5uZWwgSGVscGVyIEZ1bmN0aW9uc1xuXG4gICAgVGhlIGZvbGxvd2luZyBhcmUgZnVuY3Rpb25zIHRoYXQgYXJlIHBhdGNoZWQgaW50byB0aGUgYHJ0Yy1zaWduYWxsZXJgXG4gICAgaW5zdGFuY2UgdGhhdCBtYWtlIHdvcmtpbmcgd2l0aCBhbmQgY3JlYXRpbmcgZnVuY3Rpb25hbCBXZWJSVEMgYXBwbGljYXRpb25zXG4gICAgYSBsb3Qgc2ltcGxlci5cblxuICAqKi9cblxuICAvKipcbiAgICAjIyMjIGFkZFN0cmVhbVxuXG4gICAgYGBgXG4gICAgYWRkU3RyZWFtKHN0cmVhbTpNZWRpYVN0cmVhbSkgPT4gcWNcbiAgICBgYGBcblxuICAgIEFkZCB0aGUgc3RyZWFtIHRvIGFjdGl2ZSBjYWxscyBhbmQgYWxzbyBzYXZlIHRoZSBzdHJlYW0gc28gdGhhdCBpdFxuICAgIGNhbiBiZSBhZGRlZCB0byBmdXR1cmUgY2FsbHMuXG5cbiAgKiovXG4gIHNpZ25hbGxlci5icm9hZGNhc3QgPSBzaWduYWxsZXIuYWRkU3RyZWFtID0gZnVuY3Rpb24oc3RyZWFtKSB7XG4gICAgbG9jYWxTdHJlYW1zLnB1c2goc3RyZWFtKTtcblxuICAgIC8vIGlmIHdlIGhhdmUgYW55IGFjdGl2ZSBjYWxscywgdGhlbiBhZGQgdGhlIHN0cmVhbVxuICAgIGNhbGxzLnZhbHVlcygpLmZvckVhY2goZnVuY3Rpb24oZGF0YSkge1xuICAgICAgZGF0YS5wYy5hZGRTdHJlYW0oc3RyZWFtKTtcbiAgICB9KTtcblxuICAgIGNoZWNrUmVhZHlUb0Fubm91bmNlKCk7XG4gICAgcmV0dXJuIHNpZ25hbGxlcjtcbiAgfTtcblxuICAvKipcbiAgICAjIyMjIGVuZENhbGxzKClcblxuICAgIFRoZSBgZW5kQ2FsbHNgIGZ1bmN0aW9uIHRlcm1pbmF0ZXMgYWxsIHRoZSBhY3RpdmUgY2FsbHMgdGhhdCBoYXZlIGJlZW5cbiAgICBjcmVhdGVkIGluIHRoaXMgcXVpY2tjb25uZWN0IGluc3RhbmNlLiAgQ2FsbGluZyBgZW5kQ2FsbHNgIGRvZXMgbm90XG4gICAga2lsbCB0aGUgY29ubmVjdGlvbiB3aXRoIHRoZSBzaWduYWxsaW5nIHNlcnZlci5cblxuICAqKi9cbiAgc2lnbmFsbGVyLmVuZENhbGxzID0gZnVuY3Rpb24oKSB7XG4gICAgY2FsbHMua2V5cygpLmZvckVhY2goY2FsbEVuZCk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyBjbG9zZSgpXG5cbiAgICBUaGUgYGNsb3NlYCBmdW5jdGlvbiBwcm92aWRlcyBhIGNvbnZlbmllbnQgd2F5IG9mIGNsb3NpbmcgYWxsIGFzc29jaWF0ZWRcbiAgICBwZWVyIGNvbm5lY3Rpb25zLiAgVGhpcyBmdW5jdGlvbiBzaW1wbHkgdXNlcyB0aGUgYGVuZENhbGxzYCBmdW5jdGlvbiBhbmRcbiAgICB0aGUgdW5kZXJseWluZyBgbGVhdmVgIGZ1bmN0aW9uIG9mIHRoZSBzaWduYWxsZXIgdG8gZG8gYSBcImZ1bGwgY2xlYW51cFwiXG4gICAgb2YgYWxsIGNvbm5lY3Rpb25zLlxuICAqKi9cbiAgc2lnbmFsbGVyLmNsb3NlID0gZnVuY3Rpb24oKSB7XG4gICAgc2lnbmFsbGVyLmVuZENhbGxzKCk7XG4gICAgc2lnbmFsbGVyLmxlYXZlKCk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyBjcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCwgY29uZmlnKVxuXG4gICAgUmVxdWVzdCB0aGF0IGEgZGF0YSBjaGFubmVsIHdpdGggdGhlIHNwZWNpZmllZCBgbGFiZWxgIGlzIGNyZWF0ZWQgb25cbiAgICB0aGUgcGVlciBjb25uZWN0aW9uLiAgV2hlbiB0aGUgZGF0YSBjaGFubmVsIGlzIG9wZW4gYW5kIGF2YWlsYWJsZSwgYW5cbiAgICBldmVudCB3aWxsIGJlIHRyaWdnZXJlZCB1c2luZyB0aGUgbGFiZWwgb2YgdGhlIGRhdGEgY2hhbm5lbC5cblxuICAgIEZvciBleGFtcGxlLCBpZiBhIG5ldyBkYXRhIGNoYW5uZWwgd2FzIHJlcXVlc3RlZCB1c2luZyB0aGUgZm9sbG93aW5nXG4gICAgY2FsbDpcblxuICAgIGBgYGpzXG4gICAgdmFyIHFjID0gcXVpY2tjb25uZWN0KCdodHRwczovL3N3aXRjaGJvYXJkLnJ0Yy5pby8nKS5jcmVhdGVEYXRhQ2hhbm5lbCgndGVzdCcpO1xuICAgIGBgYFxuXG4gICAgVGhlbiB3aGVuIHRoZSBkYXRhIGNoYW5uZWwgaXMgcmVhZHkgZm9yIHVzZSwgYSBgdGVzdDpvcGVuYCBldmVudCB3b3VsZFxuICAgIGJlIGVtaXR0ZWQgYnkgYHFjYC5cblxuICAqKi9cbiAgc2lnbmFsbGVyLmNyZWF0ZURhdGFDaGFubmVsID0gZnVuY3Rpb24obGFiZWwsIG9wdHMpIHtcbiAgICAvLyBjcmVhdGUgYSBjaGFubmVsIG9uIGFsbCBleGlzdGluZyBjYWxsc1xuICAgIGNhbGxzLmtleXMoKS5mb3JFYWNoKGZ1bmN0aW9uKHBlZXJJZCkge1xuICAgICAgdmFyIGNhbGwgPSBjYWxscy5nZXQocGVlcklkKTtcbiAgICAgIHZhciBkYztcblxuICAgICAgLy8gaWYgd2UgYXJlIHRoZSBtYXN0ZXIgY29ubmVjdGlvbiwgY3JlYXRlIHRoZSBkYXRhIGNoYW5uZWxcbiAgICAgIGlmIChjYWxsICYmIGNhbGwucGMgJiYgc2lnbmFsbGVyLmlzTWFzdGVyKHBlZXJJZCkpIHtcbiAgICAgICAgZGMgPSBjYWxsLnBjLmNyZWF0ZURhdGFDaGFubmVsKGxhYmVsLCBvcHRzKTtcbiAgICAgICAgZ290UGVlckNoYW5uZWwoZGMsIGNhbGwucGMsIGdldFBlZXJEYXRhKHBlZXJJZCkpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gc2F2ZSB0aGUgZGF0YSBjaGFubmVsIG9wdHMgaW4gdGhlIGxvY2FsIGNoYW5uZWxzIGRpY3Rpb25hcnlcbiAgICBjaGFubmVsc1tsYWJlbF0gPSBvcHRzIHx8IG51bGw7XG5cbiAgICByZXR1cm4gc2lnbmFsbGVyO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgam9pbigpXG5cbiAgICBUaGUgYGpvaW5gIGZ1bmN0aW9uIGlzIHVzZWQgd2hlbiBgbWFudWFsSm9pbmAgaXMgc2V0IHRvIHRydWUgd2hlbiBjcmVhdGluZ1xuICAgIGEgcXVpY2tjb25uZWN0IGluc3RhbmNlLiAgQ2FsbCB0aGUgYGpvaW5gIGZ1bmN0aW9uIG9uY2UgeW91IGFyZSByZWFkeSB0b1xuICAgIGpvaW4gdGhlIHNpZ25hbGxpbmcgc2VydmVyIGFuZCBpbml0aWF0ZSBjb25uZWN0aW9ucyB3aXRoIG90aGVyIHBlb3BsZS5cblxuICAqKi9cbiAgc2lnbmFsbGVyLmpvaW4gPSBmdW5jdGlvbigpIHtcbiAgICBhbGxvd0pvaW4gPSB0cnVlO1xuICAgIGNoZWNrUmVhZHlUb0Fubm91bmNlKCk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyBgZ2V0KG5hbWUpYFxuXG4gICAgVGhlIGBnZXRgIGZ1bmN0aW9uIHJldHVybnMgdGhlIHByb3BlcnR5IHZhbHVlIGZvciB0aGUgc3BlY2lmaWVkIHByb3BlcnR5IG5hbWUuXG4gICoqL1xuICBzaWduYWxsZXIuZ2V0ID0gZnVuY3Rpb24obmFtZSkge1xuICAgIHJldHVybiBwcm9maWxlW25hbWVdO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgYGdldExvY2FsU3RyZWFtcygpYFxuXG4gICAgUmV0dXJuIGEgY29weSBvZiB0aGUgbG9jYWwgc3RyZWFtcyB0aGF0IGhhdmUgY3VycmVudGx5IGJlZW4gY29uZmlndXJlZFxuICAqKi9cbiAgc2lnbmFsbGVyLmdldExvY2FsU3RyZWFtcyA9IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBbXS5jb25jYXQobG9jYWxTdHJlYW1zKTtcbiAgfTtcblxuICAvKipcbiAgICAjIyMjIHJlYWN0aXZlKClcblxuICAgIEZsYWcgdGhhdCB0aGlzIHNlc3Npb24gd2lsbCBiZSBhIHJlYWN0aXZlIGNvbm5lY3Rpb24uXG5cbiAgKiovXG4gIHNpZ25hbGxlci5yZWFjdGl2ZSA9IGZ1bmN0aW9uKCkge1xuICAgIC8vIGFkZCB0aGUgcmVhY3RpdmUgZmxhZ1xuICAgIG9wdHMgPSBvcHRzIHx8IHt9O1xuICAgIG9wdHMucmVhY3RpdmUgPSB0cnVlO1xuXG4gICAgLy8gY2hhaW5cbiAgICByZXR1cm4gc2lnbmFsbGVyO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgcmVtb3ZlU3RyZWFtXG5cbiAgICBgYGBcbiAgICByZW1vdmVTdHJlYW0oc3RyZWFtOk1lZGlhU3RyZWFtKVxuICAgIGBgYFxuXG4gICAgUmVtb3ZlIHRoZSBzcGVjaWZpZWQgc3RyZWFtIGZyb20gYm90aCB0aGUgbG9jYWwgc3RyZWFtcyB0aGF0IGFyZSB0b1xuICAgIGJlIGNvbm5lY3RlZCB0byBuZXcgcGVlcnMsIGFuZCBhbHNvIGZyb20gYW55IGFjdGl2ZSBjYWxscy5cblxuICAqKi9cbiAgc2lnbmFsbGVyLnJlbW92ZVN0cmVhbSA9IGZ1bmN0aW9uKHN0cmVhbSkge1xuICAgIHZhciBsb2NhbEluZGV4ID0gbG9jYWxTdHJlYW1zLmluZGV4T2Yoc3RyZWFtKTtcblxuICAgIC8vIHJlbW92ZSB0aGUgc3RyZWFtIGZyb20gYW55IGFjdGl2ZSBjYWxsc1xuICAgIGNhbGxzLnZhbHVlcygpLmZvckVhY2goZnVuY3Rpb24oY2FsbCkge1xuICAgICAgY2FsbC5wYy5yZW1vdmVTdHJlYW0oc3RyZWFtKTtcbiAgICB9KTtcblxuICAgIC8vIHJlbW92ZSB0aGUgc3RyZWFtIGZyb20gdGhlIGxvY2FsU3RyZWFtcyBhcnJheVxuICAgIGlmIChsb2NhbEluZGV4ID49IDApIHtcbiAgICAgIGxvY2FsU3RyZWFtcy5zcGxpY2UobG9jYWxJbmRleCwgMSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHNpZ25hbGxlcjtcbiAgfTtcblxuICAvKipcbiAgICAjIyMjIHJlcXVlc3RDaGFubmVsXG5cbiAgICBgYGBcbiAgICByZXF1ZXN0Q2hhbm5lbCh0YXJnZXRJZCwgbGFiZWwsIGNhbGxiYWNrKVxuICAgIGBgYFxuXG4gICAgVGhpcyBpcyBhIGZ1bmN0aW9uIHRoYXQgY2FuIGJlIHVzZWQgdG8gcmVzcG9uZCB0byByZW1vdGUgcGVlcnMgc3VwcGx5aW5nXG4gICAgYSBkYXRhIGNoYW5uZWwgYXMgcGFydCBvZiB0aGVpciBjb25maWd1cmF0aW9uLiAgQXMgcGVyIHRoZSBgcmVjZWl2ZVN0cmVhbWBcbiAgICBmdW5jdGlvbiB0aGlzIGZ1bmN0aW9uIHdpbGwgZWl0aGVyIGZpcmUgdGhlIGNhbGxiYWNrIGltbWVkaWF0ZWx5IGlmIHRoZVxuICAgIGNoYW5uZWwgaXMgYWxyZWFkeSBhdmFpbGFibGUsIG9yIG9uY2UgdGhlIGNoYW5uZWwgaGFzIGJlZW4gZGlzY292ZXJlZCBvblxuICAgIHRoZSBjYWxsLlxuXG4gICoqL1xuICBzaWduYWxsZXIucmVxdWVzdENoYW5uZWwgPSBmdW5jdGlvbih0YXJnZXRJZCwgbGFiZWwsIGNhbGxiYWNrKSB7XG4gICAgdmFyIGNhbGwgPSBnZXRBY3RpdmVDYWxsKHRhcmdldElkKTtcbiAgICB2YXIgY2hhbm5lbCA9IGNhbGwgJiYgY2FsbC5jaGFubmVscy5nZXQobGFiZWwpO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSB0aGVuIGNoYW5uZWwgdHJpZ2dlciB0aGUgY2FsbGJhY2sgaW1tZWRpYXRlbHlcbiAgICBpZiAoY2hhbm5lbCkge1xuICAgICAgY2FsbGJhY2sobnVsbCwgY2hhbm5lbCk7XG4gICAgICByZXR1cm4gc2lnbmFsbGVyO1xuICAgIH1cblxuICAgIC8vIGlmIG5vdCwgd2FpdCBmb3IgaXRcbiAgICBzaWduYWxsZXIub25jZSgnY2hhbm5lbDpvcGVuZWQ6JyArIGxhYmVsLCBmdW5jdGlvbihpZCwgZGMpIHtcbiAgICAgIGNhbGxiYWNrKG51bGwsIGRjKTtcbiAgICB9KTtcblxuICAgIHJldHVybiBzaWduYWxsZXI7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyByZXF1ZXN0U3RyZWFtXG5cbiAgICBgYGBcbiAgICByZXF1ZXN0U3RyZWFtKHRhcmdldElkLCBpZHgsIGNhbGxiYWNrKVxuICAgIGBgYFxuXG4gICAgVXNlZCB0byByZXF1ZXN0IGEgcmVtb3RlIHN0cmVhbSBmcm9tIGEgcXVpY2tjb25uZWN0IGluc3RhbmNlLiBJZiB0aGVcbiAgICBzdHJlYW0gaXMgYWxyZWFkeSBhdmFpbGFibGUgaW4gdGhlIGNhbGxzIHJlbW90ZSBzdHJlYW1zLCB0aGVuIHRoZSBjYWxsYmFja1xuICAgIHdpbGwgYmUgdHJpZ2dlcmVkIGltbWVkaWF0ZWx5LCBvdGhlcndpc2UgdGhpcyBmdW5jdGlvbiB3aWxsIG1vbml0b3JcbiAgICBgc3RyZWFtOmFkZGVkYCBldmVudHMgYW5kIHdhaXQgZm9yIGEgbWF0Y2guXG5cbiAgICBJbiB0aGUgY2FzZSB0aGF0IGFuIHVua25vd24gdGFyZ2V0IGlzIHJlcXVlc3RlZCwgdGhlbiBhbiBleGNlcHRpb24gd2lsbFxuICAgIGJlIHRocm93bi5cbiAgKiovXG4gIHNpZ25hbGxlci5yZXF1ZXN0U3RyZWFtID0gZnVuY3Rpb24odGFyZ2V0SWQsIGlkeCwgY2FsbGJhY2spIHtcbiAgICB2YXIgY2FsbCA9IGdldEFjdGl2ZUNhbGwodGFyZ2V0SWQpO1xuICAgIHZhciBzdHJlYW07XG5cbiAgICBmdW5jdGlvbiB3YWl0Rm9yU3RyZWFtKHBlZXJJZCkge1xuICAgICAgaWYgKHBlZXJJZCAhPT0gdGFyZ2V0SWQpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICAvLyBnZXQgdGhlIHN0cmVhbVxuICAgICAgc3RyZWFtID0gY2FsbC5wYy5nZXRSZW1vdGVTdHJlYW1zKClbaWR4XTtcblxuICAgICAgLy8gaWYgd2UgaGF2ZSB0aGUgc3RyZWFtLCB0aGVuIHJlbW92ZSB0aGUgbGlzdGVuZXIgYW5kIHRyaWdnZXIgdGhlIGNiXG4gICAgICBpZiAoc3RyZWFtKSB7XG4gICAgICAgIHNpZ25hbGxlci5yZW1vdmVMaXN0ZW5lcignc3RyZWFtOmFkZGVkJywgd2FpdEZvclN0cmVhbSk7XG4gICAgICAgIGNhbGxiYWNrKG51bGwsIHN0cmVhbSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gbG9vayBmb3IgdGhlIHN0cmVhbSBpbiB0aGUgcmVtb3RlIHN0cmVhbXMgb2YgdGhlIGNhbGxcbiAgICBzdHJlYW0gPSBjYWxsLnBjLmdldFJlbW90ZVN0cmVhbXMoKVtpZHhdO1xuXG4gICAgLy8gaWYgd2UgZm91bmQgdGhlIHN0cmVhbSB0aGVuIHRyaWdnZXIgdGhlIGNhbGxiYWNrXG4gICAgaWYgKHN0cmVhbSkge1xuICAgICAgY2FsbGJhY2sobnVsbCwgc3RyZWFtKTtcbiAgICAgIHJldHVybiBzaWduYWxsZXI7XG4gICAgfVxuXG4gICAgLy8gb3RoZXJ3aXNlIHdhaXQgZm9yIHRoZSBzdHJlYW1cbiAgICBzaWduYWxsZXIub24oJ3N0cmVhbTphZGRlZCcsIHdhaXRGb3JTdHJlYW0pO1xuICAgIHJldHVybiBzaWduYWxsZXI7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyBwcm9maWxlKGRhdGEpXG5cbiAgICBVcGRhdGUgdGhlIHByb2ZpbGUgZGF0YSB3aXRoIHRoZSBhdHRhY2hlZCBpbmZvcm1hdGlvbiwgc28gd2hlblxuICAgIHRoZSBzaWduYWxsZXIgYW5ub3VuY2VzIGl0IGluY2x1ZGVzIHRoaXMgZGF0YSBpbiBhZGRpdGlvbiB0byBhbnlcbiAgICByb29tIGFuZCBpZCBpbmZvcm1hdGlvbi5cblxuICAqKi9cbiAgc2lnbmFsbGVyLnByb2ZpbGUgPSBmdW5jdGlvbihkYXRhKSB7XG4gICAgZXh0ZW5kKHByb2ZpbGUsIGRhdGEpO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSBhbHJlYWR5IGFubm91bmNlZCwgdGhlbiByZWFubm91bmNlIG91ciBwcm9maWxlIHRvIHByb3ZpZGVcbiAgICAvLyBvdGhlcnMgYSBgcGVlcjp1cGRhdGVgIGV2ZW50XG4gICAgaWYgKGFubm91bmNlZCkge1xuICAgICAgY2xlYXJUaW1lb3V0KHVwZGF0ZVRpbWVyKTtcbiAgICAgIHVwZGF0ZVRpbWVyID0gc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgc2lnbmFsbGVyLmFubm91bmNlKHByb2ZpbGUpO1xuICAgICAgfSwgKG9wdHMgfHwge30pLnVwZGF0ZURlbGF5IHx8IDEwMDApO1xuICAgIH1cblxuICAgIHJldHVybiBzaWduYWxsZXI7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyB3YWl0Rm9yQ2FsbFxuXG4gICAgYGBgXG4gICAgd2FpdEZvckNhbGwodGFyZ2V0SWQsIGNhbGxiYWNrKVxuICAgIGBgYFxuXG4gICAgV2FpdCBmb3IgYSBjYWxsIGZyb20gdGhlIHNwZWNpZmllZCB0YXJnZXRJZC4gIElmIHRoZSBjYWxsIGlzIGFscmVhZHlcbiAgICBhY3RpdmUgdGhlIGNhbGxiYWNrIHdpbGwgYmUgZmlyZWQgaW1tZWRpYXRlbHksIG90aGVyd2lzZSB3ZSB3aWxsIHdhaXRcbiAgICBmb3IgYSBgY2FsbDpzdGFydGVkYCBldmVudCB0aGF0IG1hdGNoZXMgdGhlIHJlcXVlc3RlZCBgdGFyZ2V0SWRgXG5cbiAgKiovXG4gIHNpZ25hbGxlci53YWl0Rm9yQ2FsbCA9IGZ1bmN0aW9uKHRhcmdldElkLCBjYWxsYmFjaykge1xuICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KHRhcmdldElkKTtcblxuICAgIGlmIChjYWxsICYmIGNhbGwuYWN0aXZlKSB7XG4gICAgICBjYWxsYmFjayhudWxsLCBjYWxsLnBjKTtcbiAgICAgIHJldHVybiBzaWduYWxsZXI7XG4gICAgfVxuXG4gICAgc2lnbmFsbGVyLm9uKCdjYWxsOnN0YXJ0ZWQnLCBmdW5jdGlvbiBoYW5kbGVOZXdDYWxsKGlkKSB7XG4gICAgICBpZiAoaWQgPT09IHRhcmdldElkKSB7XG4gICAgICAgIHNpZ25hbGxlci5yZW1vdmVMaXN0ZW5lcignY2FsbDpzdGFydGVkJywgaGFuZGxlTmV3Q2FsbCk7XG4gICAgICAgIGNhbGxiYWNrKG51bGwsIGNhbGxzLmdldChpZCkucGMpO1xuICAgICAgfVxuICAgIH0pO1xuICB9O1xuXG4gIC8vIGlmIHdlIGhhdmUgYW4gZXhwZWN0ZWQgbnVtYmVyIG9mIGxvY2FsIHN0cmVhbXMsIHRoZW4gdXNlIGEgZmlsdGVyIHRvXG4gIC8vIGNoZWNrIGlmIHdlIHNob3VsZCByZXNwb25kXG4gIGlmIChleHBlY3RlZExvY2FsU3RyZWFtcykge1xuICAgIHNpZ25hbGxlci5vbigncGVlcjpmaWx0ZXInLCBoYW5kbGVQZWVyRmlsdGVyKTtcbiAgfVxuXG4gIC8vIHJlc3BvbmQgdG8gbG9jYWwgYW5ub3VuY2UgbWVzc2FnZXNcbiAgc2lnbmFsbGVyLm9uKCdsb2NhbDphbm5vdW5jZScsIGhhbmRsZUxvY2FsQW5ub3VuY2UpO1xuXG4gIC8vIGhhbmRsZSBwaW5nIG1lc3NhZ2VzXG4gIHNpZ25hbGxlci5vbignbWVzc2FnZTpwaW5nJywgaGFuZGxlUGluZyk7XG5cbiAgLy8gdXNlIGdlbmljZSB0byBmaW5kIG91ciBpY2VTZXJ2ZXJzXG4gIHJlcXVpcmUoJ3J0Yy1jb3JlL2dlbmljZScpKG9wdHMsIGZ1bmN0aW9uKGVyciwgc2VydmVycykge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIHJldHVybiBjb25zb2xlLmVycm9yKCdjb3VsZCBub3QgZmluZCBpY2VTZXJ2ZXJzOiAnLCBlcnIpO1xuICAgIH1cblxuICAgIGljZVNlcnZlcnMgPSBzZXJ2ZXJzO1xuICAgIGNoZWNrUmVhZHlUb0Fubm91bmNlKCk7XG4gIH0pO1xuXG4gIC8vIGlmIHdlIHBsdWdpbiBpcyBhY3RpdmUsIHRoZW4gaW5pdGlhbGl6ZSBpdFxuICBpZiAocGx1Z2luKSB7XG4gICAgaW5pdFBsdWdpbigpO1xuICB9XG5cbiAgLy8gcGFzcyB0aGUgc2lnbmFsbGVyIG9uXG4gIHJldHVybiBzaWduYWxsZXI7XG59O1xuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihtZXNzZW5nZXIpIHtcbiAgaWYgKHR5cGVvZiBtZXNzZW5nZXIgPT0gJ2Z1bmN0aW9uJykge1xuICAgIHJldHVybiBtZXNzZW5nZXI7XG4gIH1cblxuICByZXR1cm4gcmVxdWlyZSgncnRjLXN3aXRjaGJvYXJkLW1lc3NlbmdlcicpKG1lc3Nlbmdlcik7XG59O1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxuLyoqXG4jIyBjb2cvZGVmYXVsdHNcblxuYGBganNcbnZhciBkZWZhdWx0cyA9IHJlcXVpcmUoJ2NvZy9kZWZhdWx0cycpO1xuYGBgXG5cbiMjIyBkZWZhdWx0cyh0YXJnZXQsICopXG5cblNoYWxsb3cgY29weSBvYmplY3QgcHJvcGVydGllcyBmcm9tIHRoZSBzdXBwbGllZCBzb3VyY2Ugb2JqZWN0cyAoKikgaW50b1xudGhlIHRhcmdldCBvYmplY3QsIHJldHVybmluZyB0aGUgdGFyZ2V0IG9iamVjdCBvbmNlIGNvbXBsZXRlZC4gIERvIG5vdCxcbmhvd2V2ZXIsIG92ZXJ3cml0ZSBleGlzdGluZyBrZXlzIHdpdGggbmV3IHZhbHVlczpcblxuYGBganNcbmRlZmF1bHRzKHsgYTogMSwgYjogMiB9LCB7IGM6IDMgfSwgeyBkOiA0IH0sIHsgYjogNSB9KSk7XG5gYGBcblxuU2VlIGFuIGV4YW1wbGUgb24gW3JlcXVpcmViaW5dKGh0dHA6Ly9yZXF1aXJlYmluLmNvbS8/Z2lzdD02MDc5NDc1KS5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbih0YXJnZXQpIHtcbiAgLy8gZW5zdXJlIHdlIGhhdmUgYSB0YXJnZXRcbiAgdGFyZ2V0ID0gdGFyZ2V0IHx8IHt9O1xuXG4gIC8vIGl0ZXJhdGUgdGhyb3VnaCB0aGUgc291cmNlcyBhbmQgY29weSB0byB0aGUgdGFyZ2V0XG4gIFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKS5mb3JFYWNoKGZ1bmN0aW9uKHNvdXJjZSkge1xuICAgIGlmICghIHNvdXJjZSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGZvciAodmFyIHByb3AgaW4gc291cmNlKSB7XG4gICAgICBpZiAodGFyZ2V0W3Byb3BdID09PSB2b2lkIDApIHtcbiAgICAgICAgdGFyZ2V0W3Byb3BdID0gc291cmNlW3Byb3BdO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHRhcmdldDtcbn07IiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxuLyoqXG4jIyBjb2cvZXh0ZW5kXG5cbmBgYGpzXG52YXIgZXh0ZW5kID0gcmVxdWlyZSgnY29nL2V4dGVuZCcpO1xuYGBgXG5cbiMjIyBleHRlbmQodGFyZ2V0LCAqKVxuXG5TaGFsbG93IGNvcHkgb2JqZWN0IHByb3BlcnRpZXMgZnJvbSB0aGUgc3VwcGxpZWQgc291cmNlIG9iamVjdHMgKCopIGludG9cbnRoZSB0YXJnZXQgb2JqZWN0LCByZXR1cm5pbmcgdGhlIHRhcmdldCBvYmplY3Qgb25jZSBjb21wbGV0ZWQ6XG5cbmBgYGpzXG5leHRlbmQoeyBhOiAxLCBiOiAyIH0sIHsgYzogMyB9LCB7IGQ6IDQgfSwgeyBiOiA1IH0pKTtcbmBgYFxuXG5TZWUgYW4gZXhhbXBsZSBvbiBbcmVxdWlyZWJpbl0oaHR0cDovL3JlcXVpcmViaW4uY29tLz9naXN0PTYwNzk0NzUpLlxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHRhcmdldCkge1xuICBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSkuZm9yRWFjaChmdW5jdGlvbihzb3VyY2UpIHtcbiAgICBpZiAoISBzb3VyY2UpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBmb3IgKHZhciBwcm9wIGluIHNvdXJjZSkge1xuICAgICAgdGFyZ2V0W3Byb3BdID0gc291cmNlW3Byb3BdO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHRhcmdldDtcbn07IiwiLyoqXG4gICMjIGNvZy9nZXRhYmxlXG5cbiAgVGFrZSBhbiBvYmplY3QgYW5kIHByb3ZpZGUgYSB3cmFwcGVyIHRoYXQgYWxsb3dzIHlvdSB0byBgZ2V0YCBhbmRcbiAgYHNldGAgdmFsdWVzIG9uIHRoYXQgb2JqZWN0LlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24odGFyZ2V0KSB7XG4gIGZ1bmN0aW9uIGdldChrZXkpIHtcbiAgICByZXR1cm4gdGFyZ2V0W2tleV07XG4gIH1cblxuICBmdW5jdGlvbiBzZXQoa2V5LCB2YWx1ZSkge1xuICAgIHRhcmdldFtrZXldID0gdmFsdWU7XG4gIH1cblxuICBmdW5jdGlvbiByZW1vdmUoa2V5KSB7XG4gICAgcmV0dXJuIGRlbGV0ZSB0YXJnZXRba2V5XTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGtleXMoKSB7XG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHRhcmdldCk7XG4gIH07XG5cbiAgZnVuY3Rpb24gdmFsdWVzKCkge1xuICAgIHJldHVybiBPYmplY3Qua2V5cyh0YXJnZXQpLm1hcChmdW5jdGlvbihrZXkpIHtcbiAgICAgIHJldHVybiB0YXJnZXRba2V5XTtcbiAgICB9KTtcbiAgfTtcblxuICBpZiAodHlwZW9mIHRhcmdldCAhPSAnb2JqZWN0Jykge1xuICAgIHJldHVybiB0YXJnZXQ7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGdldDogZ2V0LFxuICAgIHNldDogc2V0LFxuICAgIHJlbW92ZTogcmVtb3ZlLFxuICAgIGRlbGV0ZTogcmVtb3ZlLFxuICAgIGtleXM6IGtleXMsXG4gICAgdmFsdWVzOiB2YWx1ZXNcbiAgfTtcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG4vKipcbiAgIyMgY29nL2pzb25wYXJzZVxuXG4gIGBgYGpzXG4gIHZhciBqc29ucGFyc2UgPSByZXF1aXJlKCdjb2cvanNvbnBhcnNlJyk7XG4gIGBgYFxuXG4gICMjIyBqc29ucGFyc2UoaW5wdXQpXG5cbiAgVGhpcyBmdW5jdGlvbiB3aWxsIGF0dGVtcHQgdG8gYXV0b21hdGljYWxseSBkZXRlY3Qgc3RyaW5naWZpZWQgSlNPTiwgYW5kXG4gIHdoZW4gZGV0ZWN0ZWQgd2lsbCBwYXJzZSBpbnRvIEpTT04gb2JqZWN0cy4gIFRoZSBmdW5jdGlvbiBsb29rcyBmb3Igc3RyaW5nc1xuICB0aGF0IGxvb2sgYW5kIHNtZWxsIGxpa2Ugc3RyaW5naWZpZWQgSlNPTiwgYW5kIGlmIGZvdW5kIGF0dGVtcHRzIHRvXG4gIGBKU09OLnBhcnNlYCB0aGUgaW5wdXQgaW50byBhIHZhbGlkIG9iamVjdC5cblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKGlucHV0KSB7XG4gIHZhciBpc1N0cmluZyA9IHR5cGVvZiBpbnB1dCA9PSAnc3RyaW5nJyB8fCAoaW5wdXQgaW5zdGFuY2VvZiBTdHJpbmcpO1xuICB2YXIgcmVOdW1lcmljID0gL15cXC0/XFxkK1xcLj9cXGQqJC87XG4gIHZhciBzaG91bGRQYXJzZSA7XG4gIHZhciBmaXJzdENoYXI7XG4gIHZhciBsYXN0Q2hhcjtcblxuICBpZiAoKCEgaXNTdHJpbmcpIHx8IGlucHV0Lmxlbmd0aCA8IDIpIHtcbiAgICBpZiAoaXNTdHJpbmcgJiYgcmVOdW1lcmljLnRlc3QoaW5wdXQpKSB7XG4gICAgICByZXR1cm4gcGFyc2VGbG9hdChpbnB1dCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGlucHV0O1xuICB9XG5cbiAgLy8gY2hlY2sgZm9yIHRydWUgb3IgZmFsc2VcbiAgaWYgKGlucHV0ID09PSAndHJ1ZScgfHwgaW5wdXQgPT09ICdmYWxzZScpIHtcbiAgICByZXR1cm4gaW5wdXQgPT09ICd0cnVlJztcbiAgfVxuXG4gIC8vIGNoZWNrIGZvciBudWxsXG4gIGlmIChpbnB1dCA9PT0gJ251bGwnKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvLyBnZXQgdGhlIGZpcnN0IGFuZCBsYXN0IGNoYXJhY3RlcnNcbiAgZmlyc3RDaGFyID0gaW5wdXQuY2hhckF0KDApO1xuICBsYXN0Q2hhciA9IGlucHV0LmNoYXJBdChpbnB1dC5sZW5ndGggLSAxKTtcblxuICAvLyBkZXRlcm1pbmUgd2hldGhlciB3ZSBzaG91bGQgSlNPTi5wYXJzZSB0aGUgaW5wdXRcbiAgc2hvdWxkUGFyc2UgPVxuICAgIChmaXJzdENoYXIgPT0gJ3snICYmIGxhc3RDaGFyID09ICd9JykgfHxcbiAgICAoZmlyc3RDaGFyID09ICdbJyAmJiBsYXN0Q2hhciA9PSAnXScpIHx8XG4gICAgKGZpcnN0Q2hhciA9PSAnXCInICYmIGxhc3RDaGFyID09ICdcIicpO1xuXG4gIGlmIChzaG91bGRQYXJzZSkge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShpbnB1dCk7XG4gICAgfVxuICAgIGNhdGNoIChlKSB7XG4gICAgICAvLyBhcHBhcmVudGx5IGl0IHdhc24ndCB2YWxpZCBqc29uLCBjYXJyeSBvbiB3aXRoIHJlZ3VsYXIgcHJvY2Vzc2luZ1xuICAgIH1cbiAgfVxuXG5cbiAgcmV0dXJuIHJlTnVtZXJpYy50ZXN0KGlucHV0KSA/IHBhcnNlRmxvYXQoaW5wdXQpIDogaW5wdXQ7XG59OyIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbi8qKlxuICAjIyBjb2cvbG9nZ2VyXG5cbiAgYGBganNcbiAgdmFyIGxvZ2dlciA9IHJlcXVpcmUoJ2NvZy9sb2dnZXInKTtcbiAgYGBgXG5cbiAgU2ltcGxlIGJyb3dzZXIgbG9nZ2luZyBvZmZlcmluZyBzaW1pbGFyIGZ1bmN0aW9uYWxpdHkgdG8gdGhlXG4gIFtkZWJ1Z10oaHR0cHM6Ly9naXRodWIuY29tL3Zpc2lvbm1lZGlhL2RlYnVnKSBtb2R1bGUuXG5cbiAgIyMjIFVzYWdlXG5cbiAgQ3JlYXRlIHlvdXIgc2VsZiBhIG5ldyBsb2dnaW5nIGluc3RhbmNlIGFuZCBnaXZlIGl0IGEgbmFtZTpcblxuICBgYGBqc1xuICB2YXIgZGVidWcgPSBsb2dnZXIoJ3BoaWwnKTtcbiAgYGBgXG5cbiAgTm93IGRvIHNvbWUgZGVidWdnaW5nOlxuXG4gIGBgYGpzXG4gIGRlYnVnKCdoZWxsbycpO1xuICBgYGBcblxuICBBdCB0aGlzIHN0YWdlLCBubyBsb2cgb3V0cHV0IHdpbGwgYmUgZ2VuZXJhdGVkIGJlY2F1c2UgeW91ciBsb2dnZXIgaXNcbiAgY3VycmVudGx5IGRpc2FibGVkLiAgRW5hYmxlIGl0OlxuXG4gIGBgYGpzXG4gIGxvZ2dlci5lbmFibGUoJ3BoaWwnKTtcbiAgYGBgXG5cbiAgTm93IGRvIHNvbWUgbW9yZSBsb2dnZXI6XG5cbiAgYGBganNcbiAgZGVidWcoJ09oIHRoaXMgaXMgc28gbXVjaCBuaWNlciA6KScpO1xuICAvLyAtLT4gcGhpbDogT2ggdGhpcyBpcyBzb21lIG11Y2ggbmljZXIgOilcbiAgYGBgXG5cbiAgIyMjIFJlZmVyZW5jZVxuKiovXG5cbnZhciBhY3RpdmUgPSBbXTtcbnZhciB1bmxlYXNoTGlzdGVuZXJzID0gW107XG52YXIgdGFyZ2V0cyA9IFsgY29uc29sZSBdO1xuXG4vKipcbiAgIyMjIyBsb2dnZXIobmFtZSlcblxuICBDcmVhdGUgYSBuZXcgbG9nZ2luZyBpbnN0YW5jZS5cbioqL1xudmFyIGxvZ2dlciA9IG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24obmFtZSkge1xuICAvLyBpbml0aWFsIGVuYWJsZWQgY2hlY2tcbiAgdmFyIGVuYWJsZWQgPSBjaGVja0FjdGl2ZSgpO1xuXG4gIGZ1bmN0aW9uIGNoZWNrQWN0aXZlKCkge1xuICAgIHJldHVybiBlbmFibGVkID0gYWN0aXZlLmluZGV4T2YoJyonKSA+PSAwIHx8IGFjdGl2ZS5pbmRleE9mKG5hbWUpID49IDA7XG4gIH1cblxuICAvLyByZWdpc3RlciB0aGUgY2hlY2sgYWN0aXZlIHdpdGggdGhlIGxpc3RlbmVycyBhcnJheVxuICB1bmxlYXNoTGlzdGVuZXJzW3VubGVhc2hMaXN0ZW5lcnMubGVuZ3RoXSA9IGNoZWNrQWN0aXZlO1xuXG4gIC8vIHJldHVybiB0aGUgYWN0dWFsIGxvZ2dpbmcgZnVuY3Rpb25cbiAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSBhIHN0cmluZyBtZXNzYWdlXG4gICAgaWYgKHR5cGVvZiBhcmdzWzBdID09ICdzdHJpbmcnIHx8IChhcmdzWzBdIGluc3RhbmNlb2YgU3RyaW5nKSkge1xuICAgICAgYXJnc1swXSA9IG5hbWUgKyAnOiAnICsgYXJnc1swXTtcbiAgICB9XG5cbiAgICAvLyBpZiBub3QgZW5hYmxlZCwgYmFpbFxuICAgIGlmICghIGVuYWJsZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBsb2dcbiAgICB0YXJnZXRzLmZvckVhY2goZnVuY3Rpb24odGFyZ2V0KSB7XG4gICAgICB0YXJnZXQubG9nLmFwcGx5KHRhcmdldCwgYXJncyk7XG4gICAgfSk7XG4gIH07XG59O1xuXG4vKipcbiAgIyMjIyBsb2dnZXIucmVzZXQoKVxuXG4gIFJlc2V0IGxvZ2dpbmcgKHJlbW92ZSB0aGUgZGVmYXVsdCBjb25zb2xlIGxvZ2dlciwgZmxhZyBhbGwgbG9nZ2VycyBhc1xuICBpbmFjdGl2ZSwgZXRjLCBldGMuXG4qKi9cbmxvZ2dlci5yZXNldCA9IGZ1bmN0aW9uKCkge1xuICAvLyByZXNldCB0YXJnZXRzIGFuZCBhY3RpdmUgc3RhdGVzXG4gIHRhcmdldHMgPSBbXTtcbiAgYWN0aXZlID0gW107XG5cbiAgcmV0dXJuIGxvZ2dlci5lbmFibGUoKTtcbn07XG5cbi8qKlxuICAjIyMjIGxvZ2dlci50byh0YXJnZXQpXG5cbiAgQWRkIGEgbG9nZ2luZyB0YXJnZXQuICBUaGUgbG9nZ2VyIG11c3QgaGF2ZSBhIGBsb2dgIG1ldGhvZCBhdHRhY2hlZC5cblxuKiovXG5sb2dnZXIudG8gPSBmdW5jdGlvbih0YXJnZXQpIHtcbiAgdGFyZ2V0cyA9IHRhcmdldHMuY29uY2F0KHRhcmdldCB8fCBbXSk7XG5cbiAgcmV0dXJuIGxvZ2dlcjtcbn07XG5cbi8qKlxuICAjIyMjIGxvZ2dlci5lbmFibGUobmFtZXMqKVxuXG4gIEVuYWJsZSBsb2dnaW5nIHZpYSB0aGUgbmFtZWQgbG9nZ2luZyBpbnN0YW5jZXMuICBUbyBlbmFibGUgbG9nZ2luZyB2aWEgYWxsXG4gIGluc3RhbmNlcywgeW91IGNhbiBwYXNzIGEgd2lsZGNhcmQ6XG5cbiAgYGBganNcbiAgbG9nZ2VyLmVuYWJsZSgnKicpO1xuICBgYGBcblxuICBfX1RPRE86X18gd2lsZGNhcmQgZW5hYmxlcnNcbioqL1xubG9nZ2VyLmVuYWJsZSA9IGZ1bmN0aW9uKCkge1xuICAvLyB1cGRhdGUgdGhlIGFjdGl2ZVxuICBhY3RpdmUgPSBhY3RpdmUuY29uY2F0KFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKSk7XG5cbiAgLy8gdHJpZ2dlciB0aGUgdW5sZWFzaCBsaXN0ZW5lcnNcbiAgdW5sZWFzaExpc3RlbmVycy5mb3JFYWNoKGZ1bmN0aW9uKGxpc3RlbmVyKSB7XG4gICAgbGlzdGVuZXIoKTtcbiAgfSk7XG5cbiAgcmV0dXJuIGxvZ2dlcjtcbn07IiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxuLyoqXG4gICMjIGNvZy90aHJvdHRsZVxuXG4gIGBgYGpzXG4gIHZhciB0aHJvdHRsZSA9IHJlcXVpcmUoJ2NvZy90aHJvdHRsZScpO1xuICBgYGBcblxuICAjIyMgdGhyb3R0bGUoZm4sIGRlbGF5LCBvcHRzKVxuXG4gIEEgY2hlcnJ5LXBpY2thYmxlIHRocm90dGxlIGZ1bmN0aW9uLiAgVXNlZCB0byB0aHJvdHRsZSBgZm5gIHRvIGVuc3VyZVxuICB0aGF0IGl0IGNhbiBiZSBjYWxsZWQgYXQgbW9zdCBvbmNlIGV2ZXJ5IGBkZWxheWAgbWlsbGlzZWNvbmRzLiAgV2lsbFxuICBmaXJlIGZpcnN0IGV2ZW50IGltbWVkaWF0ZWx5LCBlbnN1cmluZyB0aGUgbmV4dCBldmVudCBmaXJlZCB3aWxsIG9jY3VyXG4gIGF0IGxlYXN0IGBkZWxheWAgbWlsbGlzZWNvbmRzIGFmdGVyIHRoZSBmaXJzdCwgYW5kIHNvIG9uLlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oZm4sIGRlbGF5LCBvcHRzKSB7XG4gIHZhciBsYXN0RXhlYyA9IChvcHRzIHx8IHt9KS5sZWFkaW5nICE9PSBmYWxzZSA/IDAgOiBEYXRlLm5vdygpO1xuICB2YXIgdHJhaWxpbmcgPSAob3B0cyB8fCB7fSkudHJhaWxpbmc7XG4gIHZhciB0aW1lcjtcbiAgdmFyIHF1ZXVlZEFyZ3M7XG4gIHZhciBxdWV1ZWRTY29wZTtcblxuICAvLyB0cmFpbGluZyBkZWZhdWx0cyB0byB0cnVlXG4gIHRyYWlsaW5nID0gdHJhaWxpbmcgfHwgdHJhaWxpbmcgPT09IHVuZGVmaW5lZDtcbiAgXG4gIGZ1bmN0aW9uIGludm9rZURlZmVyZWQoKSB7XG4gICAgZm4uYXBwbHkocXVldWVkU2NvcGUsIHF1ZXVlZEFyZ3MgfHwgW10pO1xuICAgIGxhc3RFeGVjID0gRGF0ZS5ub3coKTtcbiAgfVxuXG4gIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICB2YXIgdGljayA9IERhdGUubm93KCk7XG4gICAgdmFyIGVsYXBzZWQgPSB0aWNrIC0gbGFzdEV4ZWM7XG5cbiAgICAvLyBhbHdheXMgY2xlYXIgdGhlIGRlZmVyZWQgdGltZXJcbiAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuXG4gICAgaWYgKGVsYXBzZWQgPCBkZWxheSkge1xuICAgICAgcXVldWVkQXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAwKTtcbiAgICAgIHF1ZXVlZFNjb3BlID0gdGhpcztcblxuICAgICAgcmV0dXJuIHRyYWlsaW5nICYmICh0aW1lciA9IHNldFRpbWVvdXQoaW52b2tlRGVmZXJlZCwgZGVsYXkgLSBlbGFwc2VkKSk7XG4gICAgfVxuXG4gICAgLy8gY2FsbCB0aGUgZnVuY3Rpb25cbiAgICBsYXN0RXhlYyA9IHRpY2s7XG4gICAgZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgfTtcbn07IiwiLy8gc2hpbSBmb3IgdXNpbmcgcHJvY2VzcyBpbiBicm93c2VyXG5cbnZhciBwcm9jZXNzID0gbW9kdWxlLmV4cG9ydHMgPSB7fTtcbnZhciBxdWV1ZSA9IFtdO1xudmFyIGRyYWluaW5nID0gZmFsc2U7XG5cbmZ1bmN0aW9uIGRyYWluUXVldWUoKSB7XG4gICAgaWYgKGRyYWluaW5nKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZHJhaW5pbmcgPSB0cnVlO1xuICAgIHZhciBjdXJyZW50UXVldWU7XG4gICAgdmFyIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB3aGlsZShsZW4pIHtcbiAgICAgICAgY3VycmVudFF1ZXVlID0gcXVldWU7XG4gICAgICAgIHF1ZXVlID0gW107XG4gICAgICAgIHZhciBpID0gLTE7XG4gICAgICAgIHdoaWxlICgrK2kgPCBsZW4pIHtcbiAgICAgICAgICAgIGN1cnJlbnRRdWV1ZVtpXSgpO1xuICAgICAgICB9XG4gICAgICAgIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB9XG4gICAgZHJhaW5pbmcgPSBmYWxzZTtcbn1cbnByb2Nlc3MubmV4dFRpY2sgPSBmdW5jdGlvbiAoZnVuKSB7XG4gICAgcXVldWUucHVzaChmdW4pO1xuICAgIGlmICghZHJhaW5pbmcpIHtcbiAgICAgICAgc2V0VGltZW91dChkcmFpblF1ZXVlLCAwKTtcbiAgICB9XG59O1xuXG5wcm9jZXNzLnRpdGxlID0gJ2Jyb3dzZXInO1xucHJvY2Vzcy5icm93c2VyID0gdHJ1ZTtcbnByb2Nlc3MuZW52ID0ge307XG5wcm9jZXNzLmFyZ3YgPSBbXTtcbnByb2Nlc3MudmVyc2lvbiA9ICcnOyAvLyBlbXB0eSBzdHJpbmcgdG8gYXZvaWQgcmVnZXhwIGlzc3Vlc1xuXG5mdW5jdGlvbiBub29wKCkge31cblxucHJvY2Vzcy5vbiA9IG5vb3A7XG5wcm9jZXNzLmFkZExpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3Mub25jZSA9IG5vb3A7XG5wcm9jZXNzLm9mZiA9IG5vb3A7XG5wcm9jZXNzLnJlbW92ZUxpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlQWxsTGlzdGVuZXJzID0gbm9vcDtcbnByb2Nlc3MuZW1pdCA9IG5vb3A7XG5cbnByb2Nlc3MuYmluZGluZyA9IGZ1bmN0aW9uIChuYW1lKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmJpbmRpbmcgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcblxuLy8gVE9ETyhzaHR5bG1hbilcbnByb2Nlc3MuY3dkID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gJy8nIH07XG5wcm9jZXNzLmNoZGlyID0gZnVuY3Rpb24gKGRpcikge1xuICAgIHRocm93IG5ldyBFcnJvcigncHJvY2Vzcy5jaGRpciBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xucHJvY2Vzcy51bWFzayA9IGZ1bmN0aW9uKCkgeyByZXR1cm4gMDsgfTtcbiIsInZhciBjcmVhdGVUcmllID0gcmVxdWlyZSgnYXJyYXktdHJpZScpO1xudmFyIHJlRGVsaW0gPSAvW1xcLlxcOl0vO1xuXG4vKipcbiAgIyBtYnVzXG5cbiAgSWYgTm9kZSdzIEV2ZW50RW1pdHRlciBhbmQgRXZlIHdlcmUgdG8gaGF2ZSBhIGNoaWxkLCBpdCBtaWdodCBsb29rIHNvbWV0aGluZyBsaWtlIHRoaXMuXG4gIE5vIHdpbGRjYXJkIHN1cHBvcnQgYXQgdGhpcyBzdGFnZSB0aG91Z2guLi5cblxuICAjIyBFeGFtcGxlIFVzYWdlXG5cbiAgPDw8IGRvY3MvdXNhZ2UubWRcblxuICAjIyBSZWZlcmVuY2VcblxuICAjIyMgYG1idXMobmFtZXNwYWNlPywgcGFyZW50Pywgc2NvcGU/KWBcblxuICBDcmVhdGUgYSBuZXcgbWVzc2FnZSBidXMgd2l0aCBgbmFtZXNwYWNlYCBpbmhlcml0aW5nIGZyb20gdGhlIGBwYXJlbnRgXG4gIG1idXMgaW5zdGFuY2UuICBJZiBldmVudHMgZnJvbSB0aGlzIG1lc3NhZ2UgYnVzIHNob3VsZCBiZSB0cmlnZ2VyZWQgd2l0aFxuICBhIHNwZWNpZmljIGB0aGlzYCBzY29wZSwgdGhlbiBzcGVjaWZ5IGl0IHVzaW5nIHRoZSBgc2NvcGVgIGFyZ3VtZW50LlxuXG4qKi9cblxudmFyIGNyZWF0ZUJ1cyA9IG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24obmFtZXNwYWNlLCBwYXJlbnQsIHNjb3BlKSB7XG4gIHZhciByZWdpc3RyeSA9IGNyZWF0ZVRyaWUoKTtcbiAgdmFyIGZlZWRzID0gW107XG5cbiAgZnVuY3Rpb24gYnVzKG5hbWUpIHtcbiAgICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKTtcbiAgICB2YXIgcGFydHMgPSBnZXROYW1lUGFydHMobmFtZSk7XG4gICAgdmFyIGRlbGltaXRlZCA9IHBhcnRzLmpvaW4oJy4nKTtcbiAgICB2YXIgaGFuZGxlcnMgPSByZWdpc3RyeS5nZXQocGFydHMpIHx8IFtdO1xuICAgIHZhciByZXN1bHRzO1xuXG4gICAgLy8gc2VuZCB0aHJvdWdoIHRoZSBmZWVkc1xuICAgIGZlZWRzLmZvckVhY2goZnVuY3Rpb24oZmVlZCkge1xuICAgICAgZmVlZCh7IG5hbWU6IGRlbGltaXRlZCwgYXJnczogYXJncyB9KTtcbiAgICB9KTtcblxuICAgIC8vIHJ1biB0aGUgcmVnaXN0ZXJlZCBoYW5kbGVyc1xuICAgIHJlc3VsdHMgPSBbXS5jb25jYXQoaGFuZGxlcnMpLm1hcChmdW5jdGlvbihoYW5kbGVyKSB7XG4gICAgICByZXR1cm4gaGFuZGxlci5hcHBseShzY29wZSB8fCB0aGlzLCBhcmdzKTtcbiAgICB9KTtcblxuICAgIC8vIHJ1biB0aGUgcGFyZW50IGhhbmRsZXJzXG4gICAgaWYgKGJ1cy5wYXJlbnQpIHtcbiAgICAgIHJlc3VsdHMgPSByZXN1bHRzLmNvbmNhdChcbiAgICAgICAgYnVzLnBhcmVudC5hcHBseShzY29wZSB8fCB0aGlzLCBbbmFtZXNwYWNlLmNvbmNhdChwYXJ0cyldLmNvbmNhdChhcmdzKSlcbiAgICAgICk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH1cblxuICAvKipcbiAgICAjIyMgYG1idXMjY2xlYXIoKWBcblxuICAgIFJlc2V0IHRoZSBoYW5kbGVyIHJlZ2lzdHJ5LCB3aGljaCBlc3NlbnRpYWwgZGVyZWdpc3RlcnMgYWxsIGV2ZW50IGxpc3RlbmVycy5cblxuICAgIF9BbGlhczpfIGByZW1vdmVBbGxMaXN0ZW5lcnNgXG4gICoqL1xuICBmdW5jdGlvbiBjbGVhcihuYW1lKSB7XG4gICAgLy8gaWYgd2UgaGF2ZSBhIG5hbWUsIHJlc2V0IGhhbmRsZXJzIGZvciB0aGF0IGhhbmRsZXJcbiAgICBpZiAobmFtZSkge1xuICAgICAgcmVnaXN0cnkuc2V0KGdldE5hbWVQYXJ0cyhuYW1lKSwgW10pO1xuICAgIH1cbiAgICAvLyBvdGhlcndpc2UsIHJlc2V0IHRoZSBlbnRpcmUgaGFuZGxlciByZWdpc3RyeVxuICAgIGVsc2Uge1xuICAgICAgcmVnaXN0cnkgPSBjcmVhdGVUcmllKCk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAgIyMjIGBtYnVzI2ZlZWQoaGFuZGxlcilgXG5cbiAgICBBdHRhY2ggYSBoYW5kbGVyIGZ1bmN0aW9uIHRoYXQgd2lsbCBzZWUgYWxsIGV2ZW50cyB0aGF0IGFyZSBzZW50IHRocm91Z2hcbiAgICB0aGlzIGJ1cyBpbiBhbiBcIm9iamVjdCBzdHJlYW1cIiBmb3JtYXQgdGhhdCBtYXRjaGVzIHRoZSBmb2xsb3dpbmcgZm9ybWF0OlxuXG4gICAgYGBgXG4gICAgeyBuYW1lOiAnZXZlbnQubmFtZScsIGFyZ3M6IFsgJ2V2ZW50JywgJ2FyZ3MnIF0gfVxuICAgIGBgYFxuXG4gICAgVGhlIGZlZWQgZnVuY3Rpb24gcmV0dXJucyBhIGZ1bmN0aW9uIHRoYXQgY2FuIGJlIGNhbGxlZCB0byBzdG9wIHRoZSBmZWVkXG4gICAgc2VuZGluZyBkYXRhLlxuXG4gICoqL1xuICBmdW5jdGlvbiBmZWVkKGhhbmRsZXIpIHtcbiAgICBmdW5jdGlvbiBzdG9wKCkge1xuICAgICAgZmVlZHMuc3BsaWNlKGZlZWRzLmluZGV4T2YoaGFuZGxlciksIDEpO1xuICAgIH1cblxuICAgIGZlZWRzLnB1c2goaGFuZGxlcik7XG4gICAgcmV0dXJuIHN0b3A7XG4gIH1cblxuICBmdW5jdGlvbiBnZXROYW1lUGFydHMobmFtZSkge1xuICAgIHJldHVybiBBcnJheS5pc0FycmF5KG5hbWUpID8gbmFtZSA6IChuYW1lID8gbmFtZS5zcGxpdChyZURlbGltKSA6IFtdKTtcbiAgfVxuXG4gIC8qKlxuICAgICMjIyBgbWJ1cyNvZmYobmFtZSwgaGFuZGxlcilgXG5cbiAgICBEZXJlZ2lzdGVyIGFuIGV2ZW50IGhhbmRsZXIuXG4gICoqL1xuICBmdW5jdGlvbiBvZmYobmFtZSwgaGFuZGxlcikge1xuICAgIHZhciBoYW5kbGVycyA9IHJlZ2lzdHJ5LmdldChnZXROYW1lUGFydHMobmFtZSkpO1xuICAgIHZhciBpZHggPSBoYW5kbGVycyA/IGhhbmRsZXJzLmluZGV4T2YoaGFuZGxlcikgOiAtMTtcblxuICAgIGlmIChpZHggPj0gMCkge1xuICAgICAgaGFuZGxlcnMuc3BsaWNlKGlkeCwgMSk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAgIyMjIGBtYnVzI29uKG5hbWUsIGhhbmRsZXIpYFxuXG4gICAgUmVnaXN0ZXIgYW4gZXZlbnQgaGFuZGxlciBmb3IgdGhlIGV2ZW50IGBuYW1lYC5cblxuICAqKi9cbiAgZnVuY3Rpb24gb24obmFtZSwgaGFuZGxlcikge1xuICAgIHZhciBwYXJ0cyA9IGdldE5hbWVQYXJ0cyhuYW1lKTtcbiAgICB2YXIgaGFuZGxlcnMgPSByZWdpc3RyeS5nZXQocGFydHMpO1xuXG4gICAgaWYgKGhhbmRsZXJzKSB7XG4gICAgICBoYW5kbGVycy5wdXNoKGhhbmRsZXIpO1xuICAgIH1cbiAgICBlbHNlIHtcbiAgICAgIHJlZ2lzdHJ5LnNldChwYXJ0cywgWyBoYW5kbGVyIF0pO1xuICAgIH1cblxuICAgIHJldHVybiBidXM7XG4gIH1cblxuXG4gIC8qKlxuICAgICMjIyBgbWJ1cyNvbmNlKG5hbWUsIGhhbmRsZXIpYFxuXG4gICAgUmVnaXN0ZXIgYW4gZXZlbnQgaGFuZGxlciBmb3IgdGhlIGV2ZW50IGBuYW1lYCB0aGF0IHdpbGwgb25seVxuICAgIHRyaWdnZXIgb25jZSAoaS5lLiB0aGUgaGFuZGxlciB3aWxsIGJlIGRlcmVnaXN0ZXJlZCBpbW1lZGlhdGVseSBhZnRlclxuICAgIGJlaW5nIHRyaWdnZXJlZCB0aGUgZmlyc3QgdGltZSkuXG5cbiAgKiovXG4gIGZ1bmN0aW9uIG9uY2UobmFtZSwgaGFuZGxlcikge1xuICAgIHJldHVybiBvbihuYW1lLCBmdW5jdGlvbiBoYW5kbGVFdmVudCgpIHtcbiAgICAgIHZhciByZXN1bHQgPSBoYW5kbGVyLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgICBidXMub2ZmKG5hbWUsIGhhbmRsZUV2ZW50KTtcblxuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9KTtcbiAgfVxuXG4gIGlmICh0eXBlb2YgbmFtZXNwYWNlID09ICdmdW5jdGlvbicpIHtcbiAgICBwYXJlbnQgPSBuYW1lc3BhY2U7XG4gICAgbmFtZXNwYWNlID0gJyc7XG4gIH1cblxuICBuYW1lc3BhY2UgPSAobmFtZXNwYWNlICYmIG5hbWVzcGFjZS5zcGxpdChyZURlbGltKSkgfHwgW107XG5cbiAgYnVzLmNsZWFyID0gYnVzLnJlbW92ZUFsbExpc3RlbmVycyA9IGNsZWFyO1xuICBidXMuZmVlZCA9IGZlZWQ7XG4gIGJ1cy5vbiA9IGJ1cy5hZGRMaXN0ZW5lciA9IG9uO1xuICBidXMub25jZSA9IG9uY2U7XG4gIGJ1cy5vZmYgPSBidXMucmVtb3ZlTGlzdGVuZXIgPSBvZmY7XG4gIGJ1cy5wYXJlbnQgPSBwYXJlbnQgfHwgKG5hbWVzcGFjZSAmJiBuYW1lc3BhY2UubGVuZ3RoID4gMCAmJiBjcmVhdGVCdXMoKSk7XG5cbiAgcmV0dXJuIGJ1cztcbn07XG4iLCJcInVzZSBzdHJpY3RcIlxuXG5mdW5jdGlvbiBjb21waWxlU2VhcmNoKGZ1bmNOYW1lLCBwcmVkaWNhdGUsIHJldmVyc2VkLCBleHRyYUFyZ3MsIHVzZU5kYXJyYXksIGVhcmx5T3V0KSB7XG4gIHZhciBjb2RlID0gW1xuICAgIFwiZnVuY3Rpb24gXCIsIGZ1bmNOYW1lLCBcIihhLGwsaCxcIiwgZXh0cmFBcmdzLmpvaW4oXCIsXCIpLCAgXCIpe1wiLFxuZWFybHlPdXQgPyBcIlwiIDogXCJ2YXIgaT1cIiwgKHJldmVyc2VkID8gXCJsLTFcIiA6IFwiaCsxXCIpLFxuXCI7d2hpbGUobDw9aCl7XFxcbnZhciBtPShsK2gpPj4+MSx4PWFcIiwgdXNlTmRhcnJheSA/IFwiLmdldChtKVwiIDogXCJbbV1cIl1cbiAgaWYoZWFybHlPdXQpIHtcbiAgICBpZihwcmVkaWNhdGUuaW5kZXhPZihcImNcIikgPCAwKSB7XG4gICAgICBjb2RlLnB1c2goXCI7aWYoeD09PXkpe3JldHVybiBtfWVsc2UgaWYoeDw9eSl7XCIpXG4gICAgfSBlbHNlIHtcbiAgICAgIGNvZGUucHVzaChcIjt2YXIgcD1jKHgseSk7aWYocD09PTApe3JldHVybiBtfWVsc2UgaWYocDw9MCl7XCIpXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGNvZGUucHVzaChcIjtpZihcIiwgcHJlZGljYXRlLCBcIil7aT1tO1wiKVxuICB9XG4gIGlmKHJldmVyc2VkKSB7XG4gICAgY29kZS5wdXNoKFwibD1tKzF9ZWxzZXtoPW0tMX1cIilcbiAgfSBlbHNlIHtcbiAgICBjb2RlLnB1c2goXCJoPW0tMX1lbHNle2w9bSsxfVwiKVxuICB9XG4gIGNvZGUucHVzaChcIn1cIilcbiAgaWYoZWFybHlPdXQpIHtcbiAgICBjb2RlLnB1c2goXCJyZXR1cm4gLTF9O1wiKVxuICB9IGVsc2Uge1xuICAgIGNvZGUucHVzaChcInJldHVybiBpfTtcIilcbiAgfVxuICByZXR1cm4gY29kZS5qb2luKFwiXCIpXG59XG5cbmZ1bmN0aW9uIGNvbXBpbGVCb3VuZHNTZWFyY2gocHJlZGljYXRlLCByZXZlcnNlZCwgc3VmZml4LCBlYXJseU91dCkge1xuICB2YXIgcmVzdWx0ID0gbmV3IEZ1bmN0aW9uKFtcbiAgY29tcGlsZVNlYXJjaChcIkFcIiwgXCJ4XCIgKyBwcmVkaWNhdGUgKyBcInlcIiwgcmV2ZXJzZWQsIFtcInlcIl0sIGZhbHNlLCBlYXJseU91dCksXG4gIGNvbXBpbGVTZWFyY2goXCJCXCIsIFwieFwiICsgcHJlZGljYXRlICsgXCJ5XCIsIHJldmVyc2VkLCBbXCJ5XCJdLCB0cnVlLCBlYXJseU91dCksXG4gIGNvbXBpbGVTZWFyY2goXCJQXCIsIFwiYyh4LHkpXCIgKyBwcmVkaWNhdGUgKyBcIjBcIiwgcmV2ZXJzZWQsIFtcInlcIiwgXCJjXCJdLCBmYWxzZSwgZWFybHlPdXQpLFxuICBjb21waWxlU2VhcmNoKFwiUVwiLCBcImMoeCx5KVwiICsgcHJlZGljYXRlICsgXCIwXCIsIHJldmVyc2VkLCBbXCJ5XCIsIFwiY1wiXSwgdHJ1ZSwgZWFybHlPdXQpLFxuXCJmdW5jdGlvbiBkaXNwYXRjaEJzZWFyY2hcIiwgc3VmZml4LCBcIihhLHksYyxsLGgpe1xcXG5pZihhLnNoYXBlKXtcXFxuaWYodHlwZW9mKGMpPT09J2Z1bmN0aW9uJyl7XFxcbnJldHVybiBRKGEsKGw9PT11bmRlZmluZWQpPzA6bHwwLChoPT09dW5kZWZpbmVkKT9hLnNoYXBlWzBdLTE6aHwwLHksYylcXFxufWVsc2V7XFxcbnJldHVybiBCKGEsKGM9PT11bmRlZmluZWQpPzA6Y3wwLChsPT09dW5kZWZpbmVkKT9hLnNoYXBlWzBdLTE6bHwwLHkpXFxcbn19ZWxzZXtcXFxuaWYodHlwZW9mKGMpPT09J2Z1bmN0aW9uJyl7XFxcbnJldHVybiBQKGEsKGw9PT11bmRlZmluZWQpPzA6bHwwLChoPT09dW5kZWZpbmVkKT9hLmxlbmd0aC0xOmh8MCx5LGMpXFxcbn1lbHNle1xcXG5yZXR1cm4gQShhLChjPT09dW5kZWZpbmVkKT8wOmN8MCwobD09PXVuZGVmaW5lZCk/YS5sZW5ndGgtMTpsfDAseSlcXFxufX19XFxcbnJldHVybiBkaXNwYXRjaEJzZWFyY2hcIiwgc3VmZml4XS5qb2luKFwiXCIpKVxuICByZXR1cm4gcmVzdWx0KClcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIGdlOiBjb21waWxlQm91bmRzU2VhcmNoKFwiPj1cIiwgZmFsc2UsIFwiR0VcIiksXG4gIGd0OiBjb21waWxlQm91bmRzU2VhcmNoKFwiPlwiLCBmYWxzZSwgXCJHVFwiKSxcbiAgbHQ6IGNvbXBpbGVCb3VuZHNTZWFyY2goXCI8XCIsIHRydWUsIFwiTFRcIiksXG4gIGxlOiBjb21waWxlQm91bmRzU2VhcmNoKFwiPD1cIiwgdHJ1ZSwgXCJMRVwiKSxcbiAgZXE6IGNvbXBpbGVCb3VuZHNTZWFyY2goXCItXCIsIHRydWUsIFwiRVFcIiwgdHJ1ZSlcbn1cbiIsIlwidXNlIHN0cmljdFwiXG5cbnZhciBib3VuZHMgPSByZXF1aXJlKFwiYmluYXJ5LXNlYXJjaC1ib3VuZHNcIilcblxubW9kdWxlLmV4cG9ydHMgPSBjcmVhdGVUcmllXG5cbmZ1bmN0aW9uIFRyaWUoc3ltYm9scywgY2hpbGRyZW4sIHZhbHVlKSB7XG4gIHRoaXMuc3ltYm9scyA9IHN5bWJvbHNcbiAgdGhpcy5jaGlsZHJlbiA9IGNoaWxkcmVuXG4gIHRoaXMudmFsdWUgPSB2YWx1ZVxufVxuXG52YXIgcHJvdG8gPSBUcmllLnByb3RvdHlwZVxuXG5wcm90by5zZXQgPSBmdW5jdGlvbihzLCB2YWx1ZSkge1xuICBpZihzLnNoYXBlKSB7XG4gICAgdmFyIHYgPSB0aGlzXG4gICAgdmFyIG4gPSBzLnNoYXBlWzBdXG4gICAgZm9yKHZhciBpPTA7IGk8bjsgKytpKSB7XG4gICAgICB2YXIgYyA9IHMuZ2V0KGkpXG4gICAgICB2YXIgaiA9IGJvdW5kcy5nZSh2LnN5bWJvbHMsIGMpXG4gICAgICBpZihqIDwgdi5zeW1ib2xzLmxlbmd0aCAmJiB2LnN5bWJvbHNbal0gPT09IGMpIHtcbiAgICAgICAgdiA9IHYuY2hpbGRyZW5bal1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZhciBsID0gbmV3IFRyaWUoW10sIFtdLCB2YWx1ZSlcbiAgICAgICAgZm9yKHZhciBrPW4tMTsgaz5pOyAtLWspIHtcbiAgICAgICAgICBsID0gbmV3IFRyaWUoW3MuZ2V0KGspXSwgW2xdKVxuICAgICAgICB9XG4gICAgICAgIHYuc3ltYm9scy5zcGxpY2UoaiwgMCwgYylcbiAgICAgICAgdi5jaGlsZHJlbi5zcGxpY2UoaiwgMCwgbClcbiAgICAgICAgcmV0dXJuIHZhbHVlXG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB2LnZhbHVlID0gdmFsdWVcbiAgfSBlbHNlIHtcbiAgICB2YXIgdiA9IHRoaXNcbiAgICB2YXIgbiA9IHMubGVuZ3RoXG4gICAgZm9yKHZhciBpPTA7IGk8bjsgKytpKSB7XG4gICAgICB2YXIgYyA9IHNbaV1cbiAgICAgIHZhciBqID0gYm91bmRzLmdlKHYuc3ltYm9scywgYylcbiAgICAgIGlmKGogPCB2LnN5bWJvbHMubGVuZ3RoICYmIHYuc3ltYm9sc1tqXSA9PT0gYykge1xuICAgICAgICB2ID0gdi5jaGlsZHJlbltqXVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIGwgPSBuZXcgVHJpZShbXSwgW10sIHZhbHVlKVxuICAgICAgICBmb3IodmFyIGs9bi0xOyBrPmk7IC0taykge1xuICAgICAgICAgIGwgPSBuZXcgVHJpZShbc1trXV0sIFtsXSlcbiAgICAgICAgfVxuICAgICAgICB2LnN5bWJvbHMuc3BsaWNlKGosIDAsIGMpXG4gICAgICAgIHYuY2hpbGRyZW4uc3BsaWNlKGosIDAsIGwpXG4gICAgICAgIHJldHVybiB2YWx1ZVxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdi52YWx1ZSA9IHZhbHVlXG4gIH1cbn1cblxucHJvdG8uZ2V0ID0gZnVuY3Rpb24ocykge1xuICBpZihzLnNoYXBlKSB7XG4gICAgdmFyIHYgPSB0aGlzXG4gICAgdmFyIG4gPSBzLnNoYXBlWzBdXG4gICAgZm9yKHZhciBpPTA7IGk8bjsgKytpKSB7XG4gICAgICB2YXIgYyA9IHMuZ2V0KGkpXG4gICAgICB2YXIgaiA9IGJvdW5kcy5lcSh2LnN5bWJvbHMsIGMpXG4gICAgICBpZihqIDwgMCkge1xuICAgICAgICByZXR1cm5cbiAgICAgIH1cbiAgICAgIHYgPSB2LmNoaWxkcmVuW2pdXG4gICAgfVxuICAgIHJldHVybiB2LnZhbHVlXG4gIH0gZWxzZSB7XG4gICAgdmFyIHYgPSB0aGlzXG4gICAgdmFyIG4gPSBzLmxlbmd0aFxuICAgIGZvcih2YXIgaT0wOyBpPG47ICsraSkge1xuICAgICAgdmFyIGMgPSBzW2ldXG4gICAgICB2YXIgaiA9IGJvdW5kcy5lcSh2LnN5bWJvbHMsIGMpXG4gICAgICBpZihqIDwgMCkge1xuICAgICAgICByZXR1cm5cbiAgICAgIH1cbiAgICAgIHYgPSB2LmNoaWxkcmVuW2pdXG4gICAgfVxuICAgIHJldHVybiB2LnZhbHVlXG4gIH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlVHJpZSgpIHtcbiAgcmV0dXJuIG5ldyBUcmllKFtdLFtdKVxufSIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4vKiBnbG9iYWwgd2luZG93OiBmYWxzZSAqL1xuLyogZ2xvYmFsIG5hdmlnYXRvcjogZmFsc2UgKi9cblxuJ3VzZSBzdHJpY3QnO1xuXG52YXIgYnJvd3NlciA9IHJlcXVpcmUoJ2RldGVjdC1icm93c2VyJyk7XG5cbi8qKlxuICAjIyMgYHJ0Yy1jb3JlL2RldGVjdGBcblxuICBBIGJyb3dzZXIgZGV0ZWN0aW9uIGhlbHBlciBmb3IgYWNjZXNzaW5nIHByZWZpeC1mcmVlIHZlcnNpb25zIG9mIHRoZSB2YXJpb3VzXG4gIFdlYlJUQyB0eXBlcy5cblxuICAjIyMgRXhhbXBsZSBVc2FnZVxuXG4gIElmIHlvdSB3YW50ZWQgdG8gZ2V0IHRoZSBuYXRpdmUgYFJUQ1BlZXJDb25uZWN0aW9uYCBwcm90b3R5cGUgaW4gYW55IGJyb3dzZXJcbiAgeW91IGNvdWxkIGRvIHRoZSBmb2xsb3dpbmc6XG5cbiAgYGBganNcbiAgdmFyIGRldGVjdCA9IHJlcXVpcmUoJ3J0Yy1jb3JlL2RldGVjdCcpOyAvLyBhbHNvIGF2YWlsYWJsZSBpbiBydGMvZGV0ZWN0XG4gIHZhciBSVENQZWVyQ29ubmVjdGlvbiA9IGRldGVjdCgnUlRDUGVlckNvbm5lY3Rpb24nKTtcbiAgYGBgXG5cbiAgVGhpcyB3b3VsZCBwcm92aWRlIHdoYXRldmVyIHRoZSBicm93c2VyIHByZWZpeGVkIHZlcnNpb24gb2YgdGhlXG4gIFJUQ1BlZXJDb25uZWN0aW9uIGlzIGF2YWlsYWJsZSAoYHdlYmtpdFJUQ1BlZXJDb25uZWN0aW9uYCxcbiAgYG1velJUQ1BlZXJDb25uZWN0aW9uYCwgZXRjKS5cbioqL1xudmFyIGRldGVjdCA9IG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24odGFyZ2V0LCBvcHRzKSB7XG4gIHZhciBhdHRhY2ggPSAob3B0cyB8fCB7fSkuYXR0YWNoO1xuICB2YXIgcHJlZml4SWR4O1xuICB2YXIgcHJlZml4O1xuICB2YXIgdGVzdE5hbWU7XG4gIHZhciBob3N0T2JqZWN0ID0gdGhpcyB8fCAodHlwZW9mIHdpbmRvdyAhPSAndW5kZWZpbmVkJyA/IHdpbmRvdyA6IHVuZGVmaW5lZCk7XG5cbiAgLy8gaW5pdGlhbGlzZSB0byBkZWZhdWx0IHByZWZpeGVzXG4gIC8vIChyZXZlcnNlIG9yZGVyIGFzIHdlIHVzZSBhIGRlY3JlbWVudGluZyBmb3IgbG9vcClcbiAgdmFyIHByZWZpeGVzID0gKChvcHRzIHx8IHt9KS5wcmVmaXhlcyB8fCBbJ21zJywgJ28nLCAnbW96JywgJ3dlYmtpdCddKS5jb25jYXQoJycpO1xuXG4gIC8vIGlmIHdlIGhhdmUgbm8gaG9zdCBvYmplY3QsIHRoZW4gYWJvcnRcbiAgaWYgKCEgaG9zdE9iamVjdCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIGl0ZXJhdGUgdGhyb3VnaCB0aGUgcHJlZml4ZXMgYW5kIHJldHVybiB0aGUgY2xhc3MgaWYgZm91bmQgaW4gZ2xvYmFsXG4gIGZvciAocHJlZml4SWR4ID0gcHJlZml4ZXMubGVuZ3RoOyBwcmVmaXhJZHgtLTsgKSB7XG4gICAgcHJlZml4ID0gcHJlZml4ZXNbcHJlZml4SWR4XTtcblxuICAgIC8vIGNvbnN0cnVjdCB0aGUgdGVzdCBjbGFzcyBuYW1lXG4gICAgLy8gaWYgd2UgaGF2ZSBhIHByZWZpeCBlbnN1cmUgdGhlIHRhcmdldCBoYXMgYW4gdXBwZXJjYXNlIGZpcnN0IGNoYXJhY3RlclxuICAgIC8vIHN1Y2ggdGhhdCBhIHRlc3QgZm9yIGdldFVzZXJNZWRpYSB3b3VsZCByZXN1bHQgaW4gYVxuICAgIC8vIHNlYXJjaCBmb3Igd2Via2l0R2V0VXNlck1lZGlhXG4gICAgdGVzdE5hbWUgPSBwcmVmaXggKyAocHJlZml4ID9cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXQuY2hhckF0KDApLnRvVXBwZXJDYXNlKCkgKyB0YXJnZXQuc2xpY2UoMSkgOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldCk7XG5cbiAgICBpZiAodHlwZW9mIGhvc3RPYmplY3RbdGVzdE5hbWVdICE9ICd1bmRlZmluZWQnKSB7XG4gICAgICAvLyB1cGRhdGUgdGhlIGxhc3QgdXNlZCBwcmVmaXhcbiAgICAgIGRldGVjdC5icm93c2VyID0gZGV0ZWN0LmJyb3dzZXIgfHwgcHJlZml4LnRvTG93ZXJDYXNlKCk7XG5cbiAgICAgIGlmIChhdHRhY2gpIHtcbiAgICAgICAgIGhvc3RPYmplY3RbdGFyZ2V0XSA9IGhvc3RPYmplY3RbdGVzdE5hbWVdO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gaG9zdE9iamVjdFt0ZXN0TmFtZV07XG4gICAgfVxuICB9XG59O1xuXG4vLyBkZXRlY3QgbW96aWxsYSAoeWVzLCB0aGlzIGZlZWxzIGRpcnR5KVxuZGV0ZWN0Lm1veiA9IHR5cGVvZiBuYXZpZ2F0b3IgIT0gJ3VuZGVmaW5lZCcgJiYgISFuYXZpZ2F0b3IubW96R2V0VXNlck1lZGlhO1xuXG4vLyBzZXQgdGhlIGJyb3dzZXIgYW5kIGJyb3dzZXIgdmVyc2lvblxuZGV0ZWN0LmJyb3dzZXIgPSBicm93c2VyLm5hbWU7XG5kZXRlY3QuYnJvd3NlclZlcnNpb24gPSBkZXRlY3QudmVyc2lvbiA9IGJyb3dzZXIudmVyc2lvbjtcbiIsIi8qKlxuICAjIyMgYHJ0Yy1jb3JlL2dlbmljZWBcblxuICBSZXNwb25kIGFwcHJvcHJpYXRlbHkgdG8gb3B0aW9ucyB0aGF0IGFyZSBwYXNzZWQgdG8gcGFja2FnZXMgbGlrZVxuICBgcnRjLXF1aWNrY29ubmVjdGAgYW5kIHRyaWdnZXIgYSBgY2FsbGJhY2tgIChlcnJvciBmaXJzdCkgd2l0aCBpY2VTZXJ2ZXJcbiAgdmFsdWVzLlxuXG4gIFRoZSBmdW5jdGlvbiBsb29rcyBmb3IgZWl0aGVyIG9mIHRoZSBmb2xsb3dpbmcga2V5cyBpbiB0aGUgb3B0aW9ucywgaW5cbiAgdGhlIGZvbGxvd2luZyBvcmRlciBvciBwcmVjZWRlbmNlOlxuXG4gIDEuIGBpY2VgIC0gdGhpcyBjYW4gZWl0aGVyIGJlIGFuIGFycmF5IG9mIGljZSBzZXJ2ZXIgdmFsdWVzIG9yIGEgZ2VuZXJhdG9yXG4gICAgIGZ1bmN0aW9uIChpbiB0aGUgc2FtZSBmb3JtYXQgYXMgdGhpcyBmdW5jdGlvbikuICBJZiB0aGlzIGtleSBjb250YWlucyBhXG4gICAgIHZhbHVlIHRoZW4gYW55IHNlcnZlcnMgc3BlY2lmaWVkIGluIHRoZSBgaWNlU2VydmVyc2Aga2V5ICgyKSB3aWxsIGJlXG4gICAgIGlnbm9yZWQuXG5cbiAgMi4gYGljZVNlcnZlcnNgIC0gYW4gYXJyYXkgb2YgaWNlIHNlcnZlciB2YWx1ZXMuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24ob3B0cywgY2FsbGJhY2spIHtcbiAgdmFyIGljZSA9IChvcHRzIHx8IHt9KS5pY2U7XG4gIHZhciBpY2VTZXJ2ZXJzID0gKG9wdHMgfHwge30pLmljZVNlcnZlcnM7XG5cbiAgaWYgKHR5cGVvZiBpY2UgPT0gJ2Z1bmN0aW9uJykge1xuICAgIHJldHVybiBpY2Uob3B0cywgY2FsbGJhY2spO1xuICB9XG4gIGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoaWNlKSkge1xuICAgIHJldHVybiBjYWxsYmFjayhudWxsLCBbXS5jb25jYXQoaWNlKSk7XG4gIH1cblxuICBjYWxsYmFjayhudWxsLCBbXS5jb25jYXQoaWNlU2VydmVycyB8fCBbXSkpO1xufTtcbiIsInZhciBicm93c2VycyA9IFtcbiAgWyAnY2hyb21lJywgL0Nocm9tKD86ZXxpdW0pXFwvKFswLTlcXC5dKykoOj9cXHN8JCkvIF0sXG4gIFsgJ2ZpcmVmb3gnLCAvRmlyZWZveFxcLyhbMC05XFwuXSspKD86XFxzfCQpLyBdLFxuICBbICdvcGVyYScsIC9PcGVyYVxcLyhbMC05XFwuXSspKD86XFxzfCQpLyBdLFxuICBbICdpZScsIC9UcmlkZW50XFwvN1xcLjAuKnJ2XFw6KFswLTlcXC5dKylcXCkuKkdlY2tvJC8gXSxcbiAgWyAnaWUnLCAvTVNJRVxccyhbMC05XFwuXSspOy4qVHJpZGVudFxcL1s0LTddLjAvIF0sXG4gIFsgJ2llJywgL01TSUVcXHMoN1xcLjApLyBdLFxuICBbICdiYjEwJywgL0JCMTA7XFxzVG91Y2guKlZlcnNpb25cXC8oWzAtOVxcLl0rKS8gXSxcbiAgWyAnYW5kcm9pZCcsIC9BbmRyb2lkXFxzKFswLTlcXC5dKykvIF0sXG4gIFsgJ2lvcycsIC9pUGFkXFw7XFxzQ1BVXFxzT1NcXHMoWzAtOVxcLl9dKykvIF0sXG4gIFsgJ2lvcycsICAvaVBob25lXFw7XFxzQ1BVXFxzaVBob25lXFxzT1NcXHMoWzAtOVxcLl9dKykvIF0sXG4gIFsgJ3NhZmFyaScsIC9TYWZhcmlcXC8oWzAtOVxcLl9dKykvIF1cbl07XG5cbnZhciBtYXRjaCA9IGJyb3dzZXJzLm1hcChtYXRjaCkuZmlsdGVyKGlzTWF0Y2gpWzBdO1xudmFyIHBhcnRzID0gbWF0Y2ggJiYgbWF0Y2hbM10uc3BsaXQoL1suX10vKS5zbGljZSgwLDMpO1xuXG53aGlsZSAocGFydHMgJiYgcGFydHMubGVuZ3RoIDwgMykge1xuICBwYXJ0cy5wdXNoKCcwJyk7XG59XG5cbi8vIHNldCB0aGUgbmFtZSBhbmQgdmVyc2lvblxuZXhwb3J0cy5uYW1lID0gbWF0Y2ggJiYgbWF0Y2hbMF07XG5leHBvcnRzLnZlcnNpb24gPSBwYXJ0cyAmJiBwYXJ0cy5qb2luKCcuJyk7XG5cbmZ1bmN0aW9uIG1hdGNoKHBhaXIpIHtcbiAgcmV0dXJuIHBhaXIuY29uY2F0KHBhaXJbMV0uZXhlYyhuYXZpZ2F0b3IudXNlckFnZW50KSk7XG59XG5cbmZ1bmN0aW9uIGlzTWF0Y2gocGFpcikge1xuICByZXR1cm4gISFwYWlyWzJdO1xufVxuIiwidmFyIGRldGVjdCA9IHJlcXVpcmUoJy4vZGV0ZWN0Jyk7XG52YXIgcmVxdWlyZWRGdW5jdGlvbnMgPSBbXG4gICdpbml0J1xuXTtcblxuZnVuY3Rpb24gaXNTdXBwb3J0ZWQocGx1Z2luKSB7XG4gIHJldHVybiBwbHVnaW4gJiYgdHlwZW9mIHBsdWdpbi5zdXBwb3J0ZWQgPT0gJ2Z1bmN0aW9uJyAmJiBwbHVnaW4uc3VwcG9ydGVkKGRldGVjdCk7XG59XG5cbmZ1bmN0aW9uIGlzVmFsaWQocGx1Z2luKSB7XG4gIHZhciBzdXBwb3J0ZWRGdW5jdGlvbnMgPSByZXF1aXJlZEZ1bmN0aW9ucy5maWx0ZXIoZnVuY3Rpb24oZm4pIHtcbiAgICByZXR1cm4gdHlwZW9mIHBsdWdpbltmbl0gPT0gJ2Z1bmN0aW9uJztcbiAgfSk7XG5cbiAgcmV0dXJuIHN1cHBvcnRlZEZ1bmN0aW9ucy5sZW5ndGggPT09IHJlcXVpcmVkRnVuY3Rpb25zLmxlbmd0aDtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihwbHVnaW5zKSB7XG4gIHJldHVybiBbXS5jb25jYXQocGx1Z2lucyB8fCBbXSkuZmlsdGVyKGlzU3VwcG9ydGVkKS5maWx0ZXIoaXNWYWxpZClbMF07XG59XG4iLCJtb2R1bGUuZXhwb3J0cyA9IHtcbiAgLy8gbWVzc2VuZ2VyIGV2ZW50c1xuICBkYXRhRXZlbnQ6ICdkYXRhJyxcbiAgb3BlbkV2ZW50OiAnb3BlbicsXG4gIGNsb3NlRXZlbnQ6ICdjbG9zZScsXG4gIGVycm9yRXZlbnQ6ICdlcnJvcicsXG5cbiAgLy8gbWVzc2VuZ2VyIGZ1bmN0aW9uc1xuICB3cml0ZU1ldGhvZDogJ3dyaXRlJyxcbiAgY2xvc2VNZXRob2Q6ICdjbG9zZScsXG5cbiAgLy8gbGVhdmUgdGltZW91dCAobXMpXG4gIGxlYXZlVGltZW91dDogMzAwMFxufTtcbiIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbnZhciBleHRlbmQgPSByZXF1aXJlKCdjb2cvZXh0ZW5kJyk7XG5cbi8qKlxuICAjIyMjIGFubm91bmNlXG5cbiAgYGBgXG4gIC9hbm5vdW5jZXwlbWV0YWRhdGElfHtcImlkXCI6IFwiLi4uXCIsIC4uLiB9XG4gIGBgYFxuXG4gIFdoZW4gYW4gYW5ub3VuY2UgbWVzc2FnZSBpcyByZWNlaXZlZCBieSB0aGUgc2lnbmFsbGVyLCB0aGUgYXR0YWNoZWRcbiAgb2JqZWN0IGRhdGEgaXMgZGVjb2RlZCBhbmQgdGhlIHNpZ25hbGxlciBlbWl0cyBhbiBgYW5ub3VuY2VgIG1lc3NhZ2UuXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihzaWduYWxsZXIpIHtcblxuICBmdW5jdGlvbiBkYXRhQWxsb3dlZChkYXRhKSB7XG4gICAgdmFyIGNsb25lZCA9IGV4dGVuZCh7IGFsbG93OiB0cnVlIH0sIGRhdGEpO1xuICAgIHNpZ25hbGxlcigncGVlcjpmaWx0ZXInLCBkYXRhLmlkLCBjbG9uZWQpO1xuXG4gICAgcmV0dXJuIGNsb25lZC5hbGxvdztcbiAgfVxuXG4gIHJldHVybiBmdW5jdGlvbihhcmdzLCBtZXNzYWdlVHlwZSwgc3JjRGF0YSwgc3JjU3RhdGUsIGlzRE0pIHtcbiAgICB2YXIgZGF0YSA9IGFyZ3NbMF07XG4gICAgdmFyIHBlZXI7XG5cbiAgICAvLyBpZiB3ZSBoYXZlIHZhbGlkIGRhdGEgdGhlbiBwcm9jZXNzXG4gICAgaWYgKGRhdGEgJiYgZGF0YS5pZCAmJiBkYXRhLmlkICE9PSBzaWduYWxsZXIuaWQpIHtcbiAgICAgIGlmICghIGRhdGFBbGxvd2VkKGRhdGEpKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIGNoZWNrIHRvIHNlZSBpZiB0aGlzIGlzIGEga25vd24gcGVlclxuICAgICAgcGVlciA9IHNpZ25hbGxlci5wZWVycy5nZXQoZGF0YS5pZCk7XG5cbiAgICAgIC8vIHRyaWdnZXIgdGhlIHBlZXIgY29ubmVjdGVkIGV2ZW50IHRvIGZsYWcgdGhhdCB3ZSBrbm93IGFib3V0IGFcbiAgICAgIC8vIHBlZXIgY29ubmVjdGlvbi4gVGhlIHBlZXIgaGFzIHBhc3NlZCB0aGUgXCJmaWx0ZXJcIiBjaGVjayBidXQgbWF5XG4gICAgICAvLyBiZSBhbm5vdW5jZWQgLyB1cGRhdGVkIGRlcGVuZGluZyBvbiBwcmV2aW91cyBjb25uZWN0aW9uIHN0YXR1c1xuICAgICAgc2lnbmFsbGVyKCdwZWVyOmNvbm5lY3RlZCcsIGRhdGEuaWQsIGRhdGEpO1xuXG4gICAgICAvLyBpZiB0aGUgcGVlciBpcyBleGlzdGluZywgdGhlbiB1cGRhdGUgdGhlIGRhdGFcbiAgICAgIGlmIChwZWVyICYmICghIHBlZXIuaW5hY3RpdmUpKSB7XG4gICAgICAgIC8vIHVwZGF0ZSB0aGUgZGF0YVxuICAgICAgICBleHRlbmQocGVlci5kYXRhLCBkYXRhKTtcblxuICAgICAgICAvLyB0cmlnZ2VyIHRoZSBwZWVyIHVwZGF0ZSBldmVudFxuICAgICAgICByZXR1cm4gc2lnbmFsbGVyKCdwZWVyOnVwZGF0ZScsIGRhdGEsIHNyY0RhdGEpO1xuICAgICAgfVxuXG4gICAgICAvLyBjcmVhdGUgYSBuZXcgcGVlclxuICAgICAgcGVlciA9IHtcbiAgICAgICAgaWQ6IGRhdGEuaWQsXG5cbiAgICAgICAgLy8gaW5pdGlhbGlzZSB0aGUgbG9jYWwgcm9sZSBpbmRleFxuICAgICAgICByb2xlSWR4OiBbZGF0YS5pZCwgc2lnbmFsbGVyLmlkXS5zb3J0KCkuaW5kZXhPZihkYXRhLmlkKSxcblxuICAgICAgICAvLyBpbml0aWFsaXNlIHRoZSBwZWVyIGRhdGFcbiAgICAgICAgZGF0YToge31cbiAgICAgIH07XG5cbiAgICAgIC8vIGluaXRpYWxpc2UgdGhlIHBlZXIgZGF0YVxuICAgICAgZXh0ZW5kKHBlZXIuZGF0YSwgZGF0YSk7XG5cbiAgICAgIC8vIHJlc2V0IGluYWN0aXZpdHkgc3RhdGVcbiAgICAgIGNsZWFyVGltZW91dChwZWVyLmxlYXZlVGltZXIpO1xuICAgICAgcGVlci5pbmFjdGl2ZSA9IGZhbHNlO1xuXG4gICAgICAvLyBzZXQgdGhlIHBlZXIgZGF0YVxuICAgICAgc2lnbmFsbGVyLnBlZXJzLnNldChkYXRhLmlkLCBwZWVyKTtcblxuICAgICAgLy8gaWYgdGhpcyBpcyBhbiBpbml0aWFsIGFubm91bmNlIG1lc3NhZ2UgKG5vIHZlY3RvciBjbG9jayBhdHRhY2hlZClcbiAgICAgIC8vIHRoZW4gc2VuZCBhIGFubm91bmNlIHJlcGx5XG4gICAgICBpZiAoc2lnbmFsbGVyLmF1dG9yZXBseSAmJiAoISBpc0RNKSkge1xuICAgICAgICBzaWduYWxsZXJcbiAgICAgICAgICAudG8oZGF0YS5pZClcbiAgICAgICAgICAuc2VuZCgnL2Fubm91bmNlJywgc2lnbmFsbGVyLmF0dHJpYnV0ZXMpO1xuICAgICAgfVxuXG4gICAgICAvLyBlbWl0IGEgbmV3IHBlZXIgYW5ub3VuY2UgZXZlbnRcbiAgICAgIHJldHVybiBzaWduYWxsZXIoJ3BlZXI6YW5ub3VuY2UnLCBkYXRhLCBwZWVyKTtcbiAgICB9XG4gIH07XG59O1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxuLyoqXG4gICMjIyBzaWduYWxsZXIgbWVzc2FnZSBoYW5kbGVyc1xuXG4qKi9cblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihzaWduYWxsZXIsIG9wdHMpIHtcbiAgcmV0dXJuIHtcbiAgICBhbm5vdW5jZTogcmVxdWlyZSgnLi9hbm5vdW5jZScpKHNpZ25hbGxlciwgb3B0cylcbiAgfTtcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG52YXIgZGV0ZWN0ID0gcmVxdWlyZSgncnRjLWNvcmUvZGV0ZWN0Jyk7XG52YXIgZGVmYXVsdHMgPSByZXF1aXJlKCdjb2cvZGVmYXVsdHMnKTtcbnZhciBleHRlbmQgPSByZXF1aXJlKCdjb2cvZXh0ZW5kJyk7XG52YXIgbWJ1cyA9IHJlcXVpcmUoJ21idXMnKTtcbnZhciBnZXRhYmxlID0gcmVxdWlyZSgnY29nL2dldGFibGUnKTtcbnZhciB1dWlkID0gcmVxdWlyZSgnY3VpZCcpO1xudmFyIHB1bGwgPSByZXF1aXJlKCdwdWxsLXN0cmVhbScpO1xudmFyIHB1c2hhYmxlID0gcmVxdWlyZSgncHVsbC1wdXNoYWJsZScpO1xuXG4vLyByZWFkeSBzdGF0ZSBjb25zdGFudHNcbnZhciBSU19ESVNDT05ORUNURUQgPSAwO1xudmFyIFJTX0NPTk5FQ1RJTkcgPSAxO1xudmFyIFJTX0NPTk5FQ1RFRCA9IDI7XG5cbi8vIGluaXRpYWxpc2Ugc2lnbmFsbGVyIG1ldGFkYXRhIHNvIHdlIGRvbid0IGhhdmUgdG8gaW5jbHVkZSB0aGUgcGFja2FnZS5qc29uXG4vLyBUT0RPOiBtYWtlIHRoaXMgY2hlY2thYmxlIHdpdGggc29tZSBraW5kIG9mIHByZXB1Ymxpc2ggc2NyaXB0XG52YXIgbWV0YWRhdGEgPSB7XG4gIHZlcnNpb246ICc1LjIuMidcbn07XG5cbi8qKlxuICAjIHJ0Yy1zaWduYWxsZXJcblxuICBUaGUgYHJ0Yy1zaWduYWxsZXJgIG1vZHVsZSBwcm92aWRlcyBhIHRyYW5zcG9ydGxlc3Mgc2lnbmFsbGluZ1xuICBtZWNoYW5pc20gZm9yIFdlYlJUQy5cblxuICAjIyBQdXJwb3NlXG5cbiAgPDw8IGRvY3MvcHVycG9zZS5tZFxuXG4gICMjIEdldHRpbmcgU3RhcnRlZFxuXG4gIFdoaWxlIHRoZSBzaWduYWxsZXIgaXMgY2FwYWJsZSBvZiBjb21tdW5pY2F0aW5nIGJ5IGEgbnVtYmVyIG9mIGRpZmZlcmVudFxuICBtZXNzZW5nZXJzIChpLmUuIGFueXRoaW5nIHRoYXQgY2FuIHNlbmQgYW5kIHJlY2VpdmUgbWVzc2FnZXMgb3ZlciBhIHdpcmUpXG4gIGl0IGNvbWVzIHdpdGggc3VwcG9ydCBmb3IgdW5kZXJzdGFuZGluZyBob3cgdG8gY29ubmVjdCB0byBhblxuICBbcnRjLXN3aXRjaGJvYXJkXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0Yy1zd2l0Y2hib2FyZCkgb3V0IG9mIHRoZSBib3guXG5cbiAgVGhlIGZvbGxvd2luZyBjb2RlIHNhbXBsZSBkZW1vbnN0cmF0ZXMgaG93OlxuXG4gIDw8PCBleGFtcGxlcy9nZXR0aW5nLXN0YXJ0ZWQuanNcblxuICA8PDwgZG9jcy9ldmVudHMubWRcblxuICA8PDwgZG9jcy9zaWduYWxmbG93LWRpYWdyYW1zLm1kXG5cbiAgIyMgUmVmZXJlbmNlXG5cbiAgVGhlIGBydGMtc2lnbmFsbGVyYCBtb2R1bGUgaXMgZGVzaWduZWQgdG8gYmUgdXNlZCBwcmltYXJpbHkgaW4gYSBmdW5jdGlvbmFsXG4gIHdheSBhbmQgd2hlbiBjYWxsZWQgaXQgY3JlYXRlcyBhIG5ldyBzaWduYWxsZXIgdGhhdCB3aWxsIGVuYWJsZVxuICB5b3UgdG8gY29tbXVuaWNhdGUgd2l0aCBvdGhlciBwZWVycyB2aWEgeW91ciBtZXNzYWdpbmcgbmV0d29yay5cblxuICBgYGBqc1xuICAvLyBjcmVhdGUgYSBzaWduYWxsZXIgZnJvbSBzb21ldGhpbmcgdGhhdCBrbm93cyBob3cgdG8gc2VuZCBtZXNzYWdlc1xuICB2YXIgc2lnbmFsbGVyID0gcmVxdWlyZSgncnRjLXNpZ25hbGxlcicpKG1lc3Nlbmdlcik7XG4gIGBgYFxuXG4gIEFzIGRlbW9uc3RyYXRlZCBpbiB0aGUgZ2V0dGluZyBzdGFydGVkIGd1aWRlLCB5b3UgY2FuIGFsc28gcGFzcyB0aHJvdWdoXG4gIGEgc3RyaW5nIHZhbHVlIGluc3RlYWQgb2YgYSBtZXNzZW5nZXIgaW5zdGFuY2UgaWYgeW91IHNpbXBseSB3YW50IHRvXG4gIGNvbm5lY3QgdG8gYW4gZXhpc3RpbmcgYHJ0Yy1zd2l0Y2hib2FyZGAgaW5zdGFuY2UuXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihtZXNzZW5nZXIsIG9wdHMpIHtcbiAgLy8gZ2V0IHRoZSBhdXRvcmVwbHkgc2V0dGluZ1xuICB2YXIgYXV0b3JlcGx5ID0gKG9wdHMgfHwge30pLmF1dG9yZXBseTtcbiAgdmFyIGF1dG9jb25uZWN0ID0gKG9wdHMgfHwge30pLmF1dG9jb25uZWN0O1xuICB2YXIgcmVjb25uZWN0ID0gKG9wdHMgfHwge30pLnJlY29ubmVjdDtcblxuICAvLyBpbml0aWFsaXNlIHRoZSBtZXRhZGF0YVxuICB2YXIgbG9jYWxNZXRhID0ge307XG5cbiAgLy8gY3JlYXRlIHRoZSBzaWduYWxsZXJcbiAgdmFyIHNpZ25hbGxlciA9IG1idXMoJycsIChvcHRzIHx8IHt9KS5sb2dnZXIpO1xuXG4gIC8vIGluaXRpYWxpc2UgdGhlIGlkXG4gIHZhciBpZCA9IHNpZ25hbGxlci5pZCA9IChvcHRzIHx8IHt9KS5pZCB8fCB1dWlkKCk7XG5cbiAgLy8gaW5pdGlhbGlzZSB0aGUgYXR0cmlidXRlc1xuICB2YXIgYXR0cmlidXRlcyA9IHNpZ25hbGxlci5hdHRyaWJ1dGVzID0ge1xuICAgIGJyb3dzZXI6IGRldGVjdC5icm93c2VyLFxuICAgIGJyb3dzZXJWZXJzaW9uOiBkZXRlY3QuYnJvd3NlclZlcnNpb24sXG4gICAgaWQ6IGlkLFxuICAgIGFnZW50OiAnc2lnbmFsbGVyQCcgKyBtZXRhZGF0YS52ZXJzaW9uXG4gIH07XG5cbiAgLy8gY3JlYXRlIHRoZSBwZWVycyBtYXBcbiAgdmFyIHBlZXJzID0gc2lnbmFsbGVyLnBlZXJzID0gZ2V0YWJsZSh7fSk7XG5cbiAgLy8gY3JlYXRlIHRoZSBvdXRib3VuZCBtZXNzYWdlIHF1ZXVlXG4gIHZhciBxdWV1ZSA9IHJlcXVpcmUoJ3B1bGwtcHVzaGFibGUnKSgpO1xuXG4gIHZhciBwcm9jZXNzb3I7XG4gIHZhciBhbm5vdW5jZVRpbWVyID0gMDtcbiAgdmFyIHJlYWR5U3RhdGUgPSBSU19ESVNDT05ORUNURUQ7XG5cbiAgZnVuY3Rpb24gYW5ub3VuY2VPblJlY29ubmVjdCgpIHtcbiAgICBzaWduYWxsZXIuYW5ub3VuY2UoKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGJ1ZmZlck1lc3NhZ2UoYXJncykge1xuICAgIHF1ZXVlLnB1c2goY3JlYXRlRGF0YUxpbmUoYXJncykpO1xuXG4gICAgLy8gaWYgd2UgYXJlIG5vdCBjb25uZWN0ZWQgKGFuZCBzaG91bGQgYXV0b2Nvbm5lY3QpLCB0aGVuIGF0dGVtcHQgY29ubmVjdGlvblxuICAgIGlmIChyZWFkeVN0YXRlID09PSBSU19ESVNDT05ORUNURUQgJiYgKGF1dG9jb25uZWN0ID09PSB1bmRlZmluZWQgfHwgYXV0b2Nvbm5lY3QpKSB7XG4gICAgICBjb25uZWN0KCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gY3JlYXRlRGF0YUxpbmUoYXJncykge1xuICAgIHJldHVybiBhcmdzLm1hcChwcmVwYXJlQXJnKS5qb2luKCd8Jyk7XG4gIH1cblxuICBmdW5jdGlvbiBjcmVhdGVNZXRhZGF0YSgpIHtcbiAgICByZXR1cm4gZXh0ZW5kKHt9LCBsb2NhbE1ldGEsIHsgaWQ6IHNpZ25hbGxlci5pZCB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZURpc2Nvbm5lY3QoKSB7XG4gICAgaWYgKHJlY29ubmVjdCA9PT0gdW5kZWZpbmVkIHx8IHJlY29ubmVjdCkge1xuICAgICAgc2V0VGltZW91dChjb25uZWN0LCA1MCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gcHJlcGFyZUFyZyhhcmcpIHtcbiAgICBpZiAodHlwZW9mIGFyZyA9PSAnb2JqZWN0JyAmJiAoISAoYXJnIGluc3RhbmNlb2YgU3RyaW5nKSkpIHtcbiAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShhcmcpO1xuICAgIH1cbiAgICBlbHNlIGlmICh0eXBlb2YgYXJnID09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIHJldHVybiBhcmc7XG4gIH1cblxuICAvKipcbiAgICAjIyMgYHNpZ25hbGxlci5jb25uZWN0KClgXG5cbiAgICBNYW51YWxseSBjb25uZWN0IHRoZSBzaWduYWxsZXIgdXNpbmcgdGhlIHN1cHBsaWVkIG1lc3Nlbmdlci5cblxuICAgIF9fTk9URTpfXyBUaGlzIHNob3VsZCBuZXZlciBoYXZlIHRvIGJlIGNhbGxlZCBpZiB0aGUgZGVmYXVsdCBzZXR0aW5nXG4gICAgZm9yIGBhdXRvY29ubmVjdGAgaXMgdXNlZC5cbiAgKiovXG4gIHZhciBjb25uZWN0ID0gc2lnbmFsbGVyLmNvbm5lY3QgPSBmdW5jdGlvbigpIHtcbiAgICAvLyBpZiB3ZSBhcmUgYWxyZWFkeSBjb25uZWN0aW5nIHRoZW4gZG8gbm90aGluZ1xuICAgIGlmIChyZWFkeVN0YXRlID09PSBSU19DT05ORUNUSU5HKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gaW5pdGlhdGUgdGhlIG1lc3NlbmdlclxuICAgIHJlYWR5U3RhdGUgPSBSU19DT05ORUNUSU5HO1xuICAgIG1lc3NlbmdlcihmdW5jdGlvbihlcnIsIHNvdXJjZSwgc2luaykge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICByZWFkeVN0YXRlID0gUlNfRElTQ09OTkVDVEVEO1xuICAgICAgICByZXR1cm4gc2lnbmFsbGVyKCdlcnJvcicsIGVycik7XG4gICAgICB9XG5cbiAgICAgIC8vIGZsYWcgYXMgY29ubmVjdGVkXG4gICAgICByZWFkeVN0YXRlID0gUlNfQ09OTkVDVEVEO1xuXG4gICAgICAvLyBwYXNzIG1lc3NhZ2VzIHRvIHRoZSBwcm9jZXNzb3JcbiAgICAgIHB1bGwoXG4gICAgICAgIHNvdXJjZSxcblxuICAgICAgICAvLyBtb25pdG9yIGRpc2Nvbm5lY3Rpb25cbiAgICAgICAgcHVsbC50aHJvdWdoKG51bGwsIGZ1bmN0aW9uKCkge1xuICAgICAgICAgIHJlYWR5U3RhdGUgPSBSU19ESVNDT05ORUNURUQ7XG4gICAgICAgICAgc2lnbmFsbGVyKCdkaXNjb25uZWN0ZWQnKTtcbiAgICAgICAgfSksXG4gICAgICAgIHB1bGwuZHJhaW4ocHJvY2Vzc29yKVxuICAgICAgKTtcblxuICAgICAgLy8gcGFzcyB0aGUgcXVldWUgdG8gdGhlIHNpbmtcbiAgICAgIHB1bGwocXVldWUsIHNpbmspO1xuXG4gICAgICAvLyBoYW5kbGUgZGlzY29ubmVjdGlvblxuICAgICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdkaXNjb25uZWN0ZWQnLCBoYW5kbGVEaXNjb25uZWN0KTtcbiAgICAgIHNpZ25hbGxlci5vbignZGlzY29ubmVjdGVkJywgaGFuZGxlRGlzY29ubmVjdCk7XG5cbiAgICAgIC8vIHRyaWdnZXIgdGhlIGNvbm5lY3RlZCBldmVudFxuICAgICAgc2lnbmFsbGVyKCdjb25uZWN0ZWQnKTtcbiAgICB9KTtcbiAgfTtcblxuICAvKipcbiAgICAjIyMgc2lnbmFsbGVyI3NlbmQobWVzc2FnZSwgZGF0YSopXG5cbiAgICBVc2UgdGhlIHNlbmQgZnVuY3Rpb24gdG8gc2VuZCBhIG1lc3NhZ2UgdG8gb3RoZXIgcGVlcnMgaW4gdGhlIGN1cnJlbnRcbiAgICBzaWduYWxsaW5nIHNjb3BlIChpZiBhbm5vdW5jZWQgaW4gYSByb29tIHRoaXMgd2lsbCBiZSBhIHJvb20sIG90aGVyd2lzZVxuICAgIGJyb2FkY2FzdCB0byBhbGwgcGVlcnMgY29ubmVjdGVkIHRvIHRoZSBzaWduYWxsaW5nIHNlcnZlcikuXG5cbiAgKiovXG4gIHZhciBzZW5kID0gc2lnbmFsbGVyLnNlbmQgPSBmdW5jdGlvbigpIHtcbiAgICAvLyBpdGVyYXRlIG92ZXIgdGhlIGFyZ3VtZW50cyBhbmQgc3RyaW5naWZ5IGFzIHJlcXVpcmVkXG4gICAgLy8gdmFyIG1ldGFkYXRhID0geyBpZDogc2lnbmFsbGVyLmlkIH07XG4gICAgdmFyIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG5cbiAgICAvLyBpbmplY3QgdGhlIG1ldGFkYXRhXG4gICAgYXJncy5zcGxpY2UoMSwgMCwgY3JlYXRlTWV0YWRhdGEoKSk7XG4gICAgYnVmZmVyTWVzc2FnZShhcmdzKTtcbiAgfTtcblxuICAvKipcbiAgICAjIyMgYW5ub3VuY2UoZGF0YT8pXG5cbiAgICBUaGUgYGFubm91bmNlYCBmdW5jdGlvbiBvZiB0aGUgc2lnbmFsbGVyIHdpbGwgcGFzcyBhbiBgL2Fubm91bmNlYCBtZXNzYWdlXG4gICAgdGhyb3VnaCB0aGUgbWVzc2VuZ2VyIG5ldHdvcmsuICBXaGVuIG5vIGFkZGl0aW9uYWwgZGF0YSBpcyBzdXBwbGllZCB0b1xuICAgIHRoaXMgZnVuY3Rpb24gdGhlbiBvbmx5IHRoZSBpZCBvZiB0aGUgc2lnbmFsbGVyIGlzIHNlbnQgdG8gYWxsIGFjdGl2ZVxuICAgIG1lbWJlcnMgb2YgdGhlIG1lc3NlbmdpbmcgbmV0d29yay5cblxuICAgICMjIyMgSm9pbmluZyBSb29tc1xuXG4gICAgVG8gam9pbiBhIHJvb20gdXNpbmcgYW4gYW5ub3VuY2UgY2FsbCB5b3Ugc2ltcGx5IHByb3ZpZGUgdGhlIG5hbWUgb2YgdGhlXG4gICAgcm9vbSB5b3Ugd2lzaCB0byBqb2luIGFzIHBhcnQgb2YgdGhlIGRhdGEgYmxvY2sgdGhhdCB5b3UgYW5ub3VjZSwgZm9yXG4gICAgZXhhbXBsZTpcblxuICAgIGBgYGpzXG4gICAgc2lnbmFsbGVyLmFubm91bmNlKHsgcm9vbTogJ3Rlc3Ryb29tJyB9KTtcbiAgICBgYGBcblxuICAgIFNpZ25hbGxpbmcgc2VydmVycyAoc3VjaCBhc1xuICAgIFtydGMtc3dpdGNoYm9hcmRdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLXN3aXRjaGJvYXJkKSkgd2lsbCB0aGVuXG4gICAgcGxhY2UgeW91ciBwZWVyIGNvbm5lY3Rpb24gaW50byBhIHJvb20gd2l0aCBvdGhlciBwZWVycyB0aGF0IGhhdmUgYWxzb1xuICAgIGFubm91bmNlZCBpbiB0aGlzIHJvb20uXG5cbiAgICBPbmNlIHlvdSBoYXZlIGpvaW5lZCBhIHJvb20sIHRoZSBzZXJ2ZXIgd2lsbCBvbmx5IGRlbGl2ZXIgbWVzc2FnZXMgdGhhdFxuICAgIHlvdSBgc2VuZGAgdG8gb3RoZXIgcGVlcnMgd2l0aGluIHRoYXQgcm9vbS5cblxuICAgICMjIyMgUHJvdmlkaW5nIEFkZGl0aW9uYWwgQW5ub3VuY2UgRGF0YVxuXG4gICAgVGhlcmUgbWF5IGJlIGluc3RhbmNlcyB3aGVyZSB5b3Ugd2lzaCB0byBzZW5kIGFkZGl0aW9uYWwgZGF0YSBhcyBwYXJ0IG9mXG4gICAgeW91ciBhbm5vdW5jZSBtZXNzYWdlIGluIHlvdXIgYXBwbGljYXRpb24uICBGb3IgaW5zdGFuY2UsIG1heWJlIHlvdSB3YW50XG4gICAgdG8gc2VuZCBhbiBhbGlhcyBvciBuaWNrIGFzIHBhcnQgb2YgeW91ciBhbm5vdW5jZSBtZXNzYWdlIHJhdGhlciB0aGFuIGp1c3RcbiAgICB1c2UgdGhlIHNpZ25hbGxlcidzIGdlbmVyYXRlZCBpZC5cblxuICAgIElmIGZvciBpbnN0YW5jZSB5b3Ugd2VyZSB3cml0aW5nIGEgc2ltcGxlIGNoYXQgYXBwbGljYXRpb24geW91IGNvdWxkIGpvaW5cbiAgICB0aGUgYHdlYnJ0Y2Agcm9vbSBhbmQgdGVsbCBldmVyeW9uZSB5b3VyIG5hbWUgd2l0aCB0aGUgZm9sbG93aW5nIGFubm91bmNlXG4gICAgY2FsbDpcblxuICAgIGBgYGpzXG4gICAgc2lnbmFsbGVyLmFubm91bmNlKHtcbiAgICAgIHJvb206ICd3ZWJydGMnLFxuICAgICAgbmljazogJ0RhbW9uJ1xuICAgIH0pO1xuICAgIGBgYFxuXG4gICAgIyMjIyBBbm5vdW5jaW5nIFVwZGF0ZXNcblxuICAgIFRoZSBzaWduYWxsZXIgaXMgd3JpdHRlbiB0byBkaXN0aW5ndWlzaCBiZXR3ZWVuIGluaXRpYWwgcGVlciBhbm5vdW5jZW1lbnRzXG4gICAgYW5kIHBlZXIgZGF0YSB1cGRhdGVzIChzZWUgdGhlIGRvY3Mgb24gdGhlIGFubm91bmNlIGhhbmRsZXIgYmVsb3cpLiBBc1xuICAgIHN1Y2ggaXQgaXMgb2sgdG8gcHJvdmlkZSBhbnkgZGF0YSB1cGRhdGVzIHVzaW5nIHRoZSBhbm5vdW5jZSBtZXRob2QgYWxzby5cblxuICAgIEZvciBpbnN0YW5jZSwgSSBjb3VsZCBzZW5kIGEgc3RhdHVzIHVwZGF0ZSBhcyBhbiBhbm5vdW5jZSBtZXNzYWdlIHRvIGZsYWdcbiAgICB0aGF0IEkgYW0gZ29pbmcgb2ZmbGluZTpcblxuICAgIGBgYGpzXG4gICAgc2lnbmFsbGVyLmFubm91bmNlKHsgc3RhdHVzOiAnb2ZmbGluZScgfSk7XG4gICAgYGBgXG5cbiAgKiovXG4gIHNpZ25hbGxlci5hbm5vdW5jZSA9IGZ1bmN0aW9uKGRhdGEsIHNlbmRlcikge1xuXG4gICAgZnVuY3Rpb24gc2VuZEFubm91bmNlKCkge1xuICAgICAgKHNlbmRlciB8fCBzZW5kKSgnL2Fubm91bmNlJywgYXR0cmlidXRlcyk7XG4gICAgICBzaWduYWxsZXIoJ2xvY2FsOmFubm91bmNlJywgYXR0cmlidXRlcyk7XG4gICAgfVxuXG4gICAgLy8gaWYgd2UgYXJlIGFscmVhZHkgY29ubmVjdGVkLCB0aGVuIGVuc3VyZSB3ZSBhbm5vdW5jZSBvbiByZWNvbm5lY3RcbiAgICBpZiAocmVhZHlTdGF0ZSA9PT0gUlNfQ09OTkVDVEVEKSB7XG4gICAgICAvLyBhbHdheXMgYW5ub3VuY2Ugb24gcmVjb25uZWN0XG4gICAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ2Nvbm5lY3RlZCcsIGFubm91bmNlT25SZWNvbm5lY3QpO1xuICAgICAgc2lnbmFsbGVyLm9uKCdjb25uZWN0ZWQnLCBhbm5vdW5jZU9uUmVjb25uZWN0KTtcbiAgICB9XG5cbiAgICBjbGVhclRpbWVvdXQoYW5ub3VuY2VUaW1lcik7XG5cbiAgICAvLyB1cGRhdGUgaW50ZXJuYWwgYXR0cmlidXRlc1xuICAgIGV4dGVuZChhdHRyaWJ1dGVzLCBkYXRhLCB7IGlkOiBzaWduYWxsZXIuaWQgfSk7XG5cbiAgICAvLyBzZW5kIHRoZSBhdHRyaWJ1dGVzIG92ZXIgdGhlIG5ldHdvcmtcbiAgICByZXR1cm4gYW5ub3VuY2VUaW1lciA9IHNldFRpbWVvdXQoc2VuZEFubm91bmNlLCAob3B0cyB8fCB7fSkuYW5ub3VuY2VEZWxheSB8fCAxMCk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIGlzTWFzdGVyKHRhcmdldElkKVxuXG4gICAgQSBzaW1wbGUgZnVuY3Rpb24gdGhhdCBpbmRpY2F0ZXMgd2hldGhlciB0aGUgbG9jYWwgc2lnbmFsbGVyIGlzIHRoZSBtYXN0ZXJcbiAgICBmb3IgaXQncyByZWxhdGlvbnNoaXAgd2l0aCBwZWVyIHNpZ25hbGxlciBpbmRpY2F0ZWQgYnkgYHRhcmdldElkYC4gIFJvbGVzXG4gICAgYXJlIGRldGVybWluZWQgYXQgdGhlIHBvaW50IGF0IHdoaWNoIHNpZ25hbGxpbmcgcGVlcnMgZGlzY292ZXIgZWFjaCBvdGhlcixcbiAgICBhbmQgYXJlIHNpbXBseSB3b3JrZWQgb3V0IGJ5IHdoaWNoZXZlciBwZWVyIGhhcyB0aGUgbG93ZXN0IHNpZ25hbGxlciBpZFxuICAgIHdoZW4gbGV4aWdyYXBoaWNhbGx5IHNvcnRlZC5cblxuICAgIEZvciBleGFtcGxlLCBpZiB3ZSBoYXZlIHR3byBzaWduYWxsZXIgcGVlcnMgdGhhdCBoYXZlIGRpc2NvdmVyZWQgZWFjaFxuICAgIG90aGVycyB3aXRoIHRoZSBmb2xsb3dpbmcgaWRzOlxuXG4gICAgLSBgYjExZjRmZDAtZmViNS00NDdjLTgwYzgtYzUxZDhjM2NjZWQyYFxuICAgIC0gYDhhMDdmODJlLTQ5YTUtNGI5Yi1hMDJlLTQzZDkxMTM4MmJlNmBcblxuICAgIFRoZXkgd291bGQgYmUgYXNzaWduZWQgcm9sZXM6XG5cbiAgICAtIGBiMTFmNGZkMC1mZWI1LTQ0N2MtODBjOC1jNTFkOGMzY2NlZDJgXG4gICAgLSBgOGEwN2Y4MmUtNDlhNS00YjliLWEwMmUtNDNkOTExMzgyYmU2YCAobWFzdGVyKVxuXG4gICoqL1xuICBzaWduYWxsZXIuaXNNYXN0ZXIgPSBmdW5jdGlvbih0YXJnZXRJZCkge1xuICAgIHZhciBwZWVyID0gcGVlcnMuZ2V0KHRhcmdldElkKTtcblxuICAgIHJldHVybiBwZWVyICYmIHBlZXIucm9sZUlkeCAhPT0gMDtcbiAgfTtcblxuICAvKipcbiAgICAjIyMgbGVhdmUoKVxuXG4gICAgVGVsbCB0aGUgc2lnbmFsbGluZyBzZXJ2ZXIgd2UgYXJlIGxlYXZpbmcuICBDYWxsaW5nIHRoaXMgZnVuY3Rpb24gaXNcbiAgICB1c3VhbGx5IG5vdCByZXF1aXJlZCB0aG91Z2ggYXMgdGhlIHNpZ25hbGxpbmcgc2VydmVyIHNob3VsZCBpc3N1ZSBjb3JyZWN0XG4gICAgYC9sZWF2ZWAgbWVzc2FnZXMgd2hlbiBpdCBkZXRlY3RzIGEgZGlzY29ubmVjdCBldmVudC5cblxuICAqKi9cbiAgc2lnbmFsbGVyLmxlYXZlID0gc2lnbmFsbGVyLmNsb3NlID0gZnVuY3Rpb24oKSB7XG4gICAgLy8gc2VuZCB0aGUgbGVhdmUgc2lnbmFsXG4gICAgc2VuZCgnL2xlYXZlJywgeyBpZDogaWQgfSk7XG5cbiAgICAvLyBzdG9wIGFubm91bmNpbmcgb24gcmVjb25uZWN0XG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdkaXNjb25uZWN0ZWQnLCBoYW5kbGVEaXNjb25uZWN0KTtcbiAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ2Nvbm5lY3RlZCcsIGFubm91bmNlT25SZWNvbm5lY3QpO1xuXG4gICAgLy8gZW5kIG91ciBjdXJyZW50IHF1ZXVlXG4gICAgcXVldWUuZW5kKCk7XG5cbiAgICAvLyBjcmVhdGUgYSBuZXcgcXVldWUgdG8gYnVmZmVyIG5ldyBtZXNzYWdlc1xuICAgIHF1ZXVlID0gcHVzaGFibGUoKTtcblxuICAgIC8vIHNldCBjb25uZWN0ZWQgdG8gZmFsc2VcbiAgICByZWFkeVN0YXRlID0gUlNfRElTQ09OTkVDVEVEO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyBtZXRhZGF0YShkYXRhPylcblxuICAgIEdldCAocGFzcyBubyBkYXRhKSBvciBzZXQgdGhlIG1ldGFkYXRhIHRoYXQgaXMgcGFzc2VkIHRocm91Z2ggd2l0aCBlYWNoXG4gICAgcmVxdWVzdCBzZW50IGJ5IHRoZSBzaWduYWxsZXIuXG5cbiAgICBfX05PVEU6X18gUmVnYXJkbGVzcyBvZiB3aGF0IGlzIHBhc3NlZCB0byB0aGlzIGZ1bmN0aW9uLCBtZXRhZGF0YVxuICAgIGdlbmVyYXRlZCBieSB0aGUgc2lnbmFsbGVyIHdpbGwgKiphbHdheXMqKiBpbmNsdWRlIHRoZSBpZCBvZiB0aGUgc2lnbmFsbGVyXG4gICAgYW5kIHRoaXMgY2Fubm90IGJlIG1vZGlmaWVkLlxuICAqKi9cbiAgc2lnbmFsbGVyLm1ldGFkYXRhID0gZnVuY3Rpb24oZGF0YSkge1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm4gZXh0ZW5kKHt9LCBsb2NhbE1ldGEpO1xuICAgIH1cblxuICAgIGxvY2FsTWV0YSA9IGV4dGVuZCh7fSwgZGF0YSk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIHRvKHRhcmdldElkKVxuXG4gICAgVXNlIHRoZSBgdG9gIGZ1bmN0aW9uIHRvIHNlbmQgYSBtZXNzYWdlIHRvIHRoZSBzcGVjaWZpZWQgdGFyZ2V0IHBlZXIuXG4gICAgQSBsYXJnZSBwYXJnZSBvZiBuZWdvdGlhdGluZyBhIFdlYlJUQyBwZWVyIGNvbm5lY3Rpb24gaW52b2x2ZXMgZGlyZWN0XG4gICAgY29tbXVuaWNhdGlvbiBiZXR3ZWVuIHR3byBwYXJ0aWVzIHdoaWNoIG11c3QgYmUgZG9uZSBieSB0aGUgc2lnbmFsbGluZ1xuICAgIHNlcnZlci4gIFRoZSBgdG9gIGZ1bmN0aW9uIHByb3ZpZGVzIGEgc2ltcGxlIHdheSB0byBwcm92aWRlIGEgbG9naWNhbFxuICAgIGNvbW11bmljYXRpb24gY2hhbm5lbCBiZXR3ZWVuIHRoZSB0d28gcGFydGllczpcblxuICAgIGBgYGpzXG4gICAgdmFyIHNlbmQgPSBzaWduYWxsZXIudG8oJ2U5NWZhMDViLTkwNjItNDVjNi1iZmEyLTUwNTViZjY2MjVmNCcpLnNlbmQ7XG5cbiAgICAvLyBjcmVhdGUgYW4gb2ZmZXIgb24gYSBsb2NhbCBwZWVyIGNvbm5lY3Rpb25cbiAgICBwYy5jcmVhdGVPZmZlcihcbiAgICAgIGZ1bmN0aW9uKGRlc2MpIHtcbiAgICAgICAgLy8gc2V0IHRoZSBsb2NhbCBkZXNjcmlwdGlvbiB1c2luZyB0aGUgb2ZmZXIgc2RwXG4gICAgICAgIC8vIGlmIHRoaXMgb2NjdXJzIHN1Y2Nlc3NmdWxseSBzZW5kIHRoaXMgdG8gb3VyIHBlZXJcbiAgICAgICAgcGMuc2V0TG9jYWxEZXNjcmlwdGlvbihcbiAgICAgICAgICBkZXNjLFxuICAgICAgICAgIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgc2VuZCgnL3NkcCcsIGRlc2MpO1xuICAgICAgICAgIH0sXG4gICAgICAgICAgaGFuZGxlRmFpbFxuICAgICAgICApO1xuICAgICAgfSxcbiAgICAgIGhhbmRsZUZhaWxcbiAgICApO1xuICAgIGBgYFxuXG4gICoqL1xuICBzaWduYWxsZXIudG8gPSBmdW5jdGlvbih0YXJnZXRJZCkge1xuICAgIC8vIGNyZWF0ZSBhIHNlbmRlciB0aGF0IHdpbGwgcHJlcGVuZCBtZXNzYWdlcyB3aXRoIC90b3x0YXJnZXRJZHxcbiAgICB2YXIgc2VuZGVyID0gZnVuY3Rpb24oKSB7XG4gICAgICAvLyBnZXQgdGhlIHBlZXIgKHllcyB3aGVuIHNlbmQgaXMgY2FsbGVkIHRvIG1ha2Ugc3VyZSBpdCBoYXNuJ3QgbGVmdClcbiAgICAgIHZhciBwZWVyID0gc2lnbmFsbGVyLnBlZXJzLmdldCh0YXJnZXRJZCk7XG4gICAgICB2YXIgYXJncztcblxuICAgICAgaWYgKCEgcGVlcikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gcGVlcjogJyArIHRhcmdldElkKTtcbiAgICAgIH1cblxuICAgICAgLy8gaWYgdGhlIHBlZXIgaXMgaW5hY3RpdmUsIHRoZW4gYWJvcnRcbiAgICAgIGlmIChwZWVyLmluYWN0aXZlKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgYXJncyA9IFtcbiAgICAgICAgJy90bycsXG4gICAgICAgIHRhcmdldElkXG4gICAgICBdLmNvbmNhdChbXS5zbGljZS5jYWxsKGFyZ3VtZW50cykpO1xuXG4gICAgICAvLyBpbmplY3QgbWV0YWRhdGFcbiAgICAgIGFyZ3Muc3BsaWNlKDMsIDAsIGNyZWF0ZU1ldGFkYXRhKCkpO1xuICAgICAgYnVmZmVyTWVzc2FnZShhcmdzKTtcbiAgICB9O1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIGFubm91bmNlOiBmdW5jdGlvbihkYXRhKSB7XG4gICAgICAgIHJldHVybiBzaWduYWxsZXIuYW5ub3VuY2UoZGF0YSwgc2VuZGVyKTtcbiAgICAgIH0sXG5cbiAgICAgIHNlbmQ6IHNlbmRlcixcbiAgICB9O1xuICB9O1xuXG4gIC8vIGluaXRpYWxpc2Ugb3B0cyBkZWZhdWx0c1xuICBvcHRzID0gZGVmYXVsdHMoe30sIG9wdHMsIHJlcXVpcmUoJy4vZGVmYXVsdHMnKSk7XG5cbiAgLy8gc2V0IHRoZSBhdXRvcmVwbHkgZmxhZ1xuICBzaWduYWxsZXIuYXV0b3JlcGx5ID0gYXV0b3JlcGx5ID09PSB1bmRlZmluZWQgfHwgYXV0b3JlcGx5O1xuXG4gIC8vIGNyZWF0ZSB0aGUgcHJvY2Vzc29yXG4gIHNpZ25hbGxlci5wcm9jZXNzID0gcHJvY2Vzc29yID0gcmVxdWlyZSgnLi9wcm9jZXNzb3InKShzaWduYWxsZXIsIG9wdHMpO1xuXG4gIC8vIGF1dG9jb25uZWN0XG4gIGlmIChhdXRvY29ubmVjdCA9PT0gdW5kZWZpbmVkIHx8IGF1dG9jb25uZWN0KSB7XG4gICAgY29ubmVjdCgpO1xuICB9XG5cbiAgcmV0dXJuIHNpZ25hbGxlcjtcbn07XG4iLCIvKipcbiAqIGN1aWQuanNcbiAqIENvbGxpc2lvbi1yZXNpc3RhbnQgVUlEIGdlbmVyYXRvciBmb3IgYnJvd3NlcnMgYW5kIG5vZGUuXG4gKiBTZXF1ZW50aWFsIGZvciBmYXN0IGRiIGxvb2t1cHMgYW5kIHJlY2VuY3kgc29ydGluZy5cbiAqIFNhZmUgZm9yIGVsZW1lbnQgSURzIGFuZCBzZXJ2ZXItc2lkZSBsb29rdXBzLlxuICpcbiAqIEV4dHJhY3RlZCBmcm9tIENMQ1RSXG4gKiBcbiAqIENvcHlyaWdodCAoYykgRXJpYyBFbGxpb3R0IDIwMTJcbiAqIE1JVCBMaWNlbnNlXG4gKi9cblxuLypnbG9iYWwgd2luZG93LCBuYXZpZ2F0b3IsIGRvY3VtZW50LCByZXF1aXJlLCBwcm9jZXNzLCBtb2R1bGUgKi9cbihmdW5jdGlvbiAoYXBwKSB7XG4gICd1c2Ugc3RyaWN0JztcbiAgdmFyIG5hbWVzcGFjZSA9ICdjdWlkJyxcbiAgICBjID0gMCxcbiAgICBibG9ja1NpemUgPSA0LFxuICAgIGJhc2UgPSAzNixcbiAgICBkaXNjcmV0ZVZhbHVlcyA9IE1hdGgucG93KGJhc2UsIGJsb2NrU2l6ZSksXG5cbiAgICBwYWQgPSBmdW5jdGlvbiBwYWQobnVtLCBzaXplKSB7XG4gICAgICB2YXIgcyA9IFwiMDAwMDAwMDAwXCIgKyBudW07XG4gICAgICByZXR1cm4gcy5zdWJzdHIocy5sZW5ndGgtc2l6ZSk7XG4gICAgfSxcblxuICAgIHJhbmRvbUJsb2NrID0gZnVuY3Rpb24gcmFuZG9tQmxvY2soKSB7XG4gICAgICByZXR1cm4gcGFkKChNYXRoLnJhbmRvbSgpICpcbiAgICAgICAgICAgIGRpc2NyZXRlVmFsdWVzIDw8IDApXG4gICAgICAgICAgICAudG9TdHJpbmcoYmFzZSksIGJsb2NrU2l6ZSk7XG4gICAgfSxcblxuICAgIHNhZmVDb3VudGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgYyA9IChjIDwgZGlzY3JldGVWYWx1ZXMpID8gYyA6IDA7XG4gICAgICBjKys7IC8vIHRoaXMgaXMgbm90IHN1YmxpbWluYWxcbiAgICAgIHJldHVybiBjIC0gMTtcbiAgICB9LFxuXG4gICAgYXBpID0gZnVuY3Rpb24gY3VpZCgpIHtcbiAgICAgIC8vIFN0YXJ0aW5nIHdpdGggYSBsb3dlcmNhc2UgbGV0dGVyIG1ha2VzXG4gICAgICAvLyBpdCBIVE1MIGVsZW1lbnQgSUQgZnJpZW5kbHkuXG4gICAgICB2YXIgbGV0dGVyID0gJ2MnLCAvLyBoYXJkLWNvZGVkIGFsbG93cyBmb3Igc2VxdWVudGlhbCBhY2Nlc3NcblxuICAgICAgICAvLyB0aW1lc3RhbXBcbiAgICAgICAgLy8gd2FybmluZzogdGhpcyBleHBvc2VzIHRoZSBleGFjdCBkYXRlIGFuZCB0aW1lXG4gICAgICAgIC8vIHRoYXQgdGhlIHVpZCB3YXMgY3JlYXRlZC5cbiAgICAgICAgdGltZXN0YW1wID0gKG5ldyBEYXRlKCkuZ2V0VGltZSgpKS50b1N0cmluZyhiYXNlKSxcblxuICAgICAgICAvLyBQcmV2ZW50IHNhbWUtbWFjaGluZSBjb2xsaXNpb25zLlxuICAgICAgICBjb3VudGVyLFxuXG4gICAgICAgIC8vIEEgZmV3IGNoYXJzIHRvIGdlbmVyYXRlIGRpc3RpbmN0IGlkcyBmb3IgZGlmZmVyZW50XG4gICAgICAgIC8vIGNsaWVudHMgKHNvIGRpZmZlcmVudCBjb21wdXRlcnMgYXJlIGZhciBsZXNzXG4gICAgICAgIC8vIGxpa2VseSB0byBnZW5lcmF0ZSB0aGUgc2FtZSBpZClcbiAgICAgICAgZmluZ2VycHJpbnQgPSBhcGkuZmluZ2VycHJpbnQoKSxcblxuICAgICAgICAvLyBHcmFiIHNvbWUgbW9yZSBjaGFycyBmcm9tIE1hdGgucmFuZG9tKClcbiAgICAgICAgcmFuZG9tID0gcmFuZG9tQmxvY2soKSArIHJhbmRvbUJsb2NrKCk7XG5cbiAgICAgICAgY291bnRlciA9IHBhZChzYWZlQ291bnRlcigpLnRvU3RyaW5nKGJhc2UpLCBibG9ja1NpemUpO1xuXG4gICAgICByZXR1cm4gIChsZXR0ZXIgKyB0aW1lc3RhbXAgKyBjb3VudGVyICsgZmluZ2VycHJpbnQgKyByYW5kb20pO1xuICAgIH07XG5cbiAgYXBpLnNsdWcgPSBmdW5jdGlvbiBzbHVnKCkge1xuICAgIHZhciBkYXRlID0gbmV3IERhdGUoKS5nZXRUaW1lKCkudG9TdHJpbmcoMzYpLFxuICAgICAgY291bnRlcixcbiAgICAgIHByaW50ID0gYXBpLmZpbmdlcnByaW50KCkuc2xpY2UoMCwxKSArXG4gICAgICAgIGFwaS5maW5nZXJwcmludCgpLnNsaWNlKC0xKSxcbiAgICAgIHJhbmRvbSA9IHJhbmRvbUJsb2NrKCkuc2xpY2UoLTIpO1xuXG4gICAgICBjb3VudGVyID0gc2FmZUNvdW50ZXIoKS50b1N0cmluZygzNikuc2xpY2UoLTQpO1xuXG4gICAgcmV0dXJuIGRhdGUuc2xpY2UoLTIpICsgXG4gICAgICBjb3VudGVyICsgcHJpbnQgKyByYW5kb207XG4gIH07XG5cbiAgYXBpLmdsb2JhbENvdW50ID0gZnVuY3Rpb24gZ2xvYmFsQ291bnQoKSB7XG4gICAgLy8gV2Ugd2FudCB0byBjYWNoZSB0aGUgcmVzdWx0cyBvZiB0aGlzXG4gICAgdmFyIGNhY2hlID0gKGZ1bmN0aW9uIGNhbGMoKSB7XG4gICAgICAgIHZhciBpLFxuICAgICAgICAgIGNvdW50ID0gMDtcblxuICAgICAgICBmb3IgKGkgaW4gd2luZG93KSB7XG4gICAgICAgICAgY291bnQrKztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb3VudDtcbiAgICAgIH0oKSk7XG5cbiAgICBhcGkuZ2xvYmFsQ291bnQgPSBmdW5jdGlvbiAoKSB7IHJldHVybiBjYWNoZTsgfTtcbiAgICByZXR1cm4gY2FjaGU7XG4gIH07XG5cbiAgYXBpLmZpbmdlcnByaW50ID0gZnVuY3Rpb24gYnJvd3NlclByaW50KCkge1xuICAgIHJldHVybiBwYWQoKG5hdmlnYXRvci5taW1lVHlwZXMubGVuZ3RoICtcbiAgICAgIG5hdmlnYXRvci51c2VyQWdlbnQubGVuZ3RoKS50b1N0cmluZygzNikgK1xuICAgICAgYXBpLmdsb2JhbENvdW50KCkudG9TdHJpbmcoMzYpLCA0KTtcbiAgfTtcblxuICAvLyBkb24ndCBjaGFuZ2UgYW55dGhpbmcgZnJvbSBoZXJlIGRvd24uXG4gIGlmIChhcHAucmVnaXN0ZXIpIHtcbiAgICBhcHAucmVnaXN0ZXIobmFtZXNwYWNlLCBhcGkpO1xuICB9IGVsc2UgaWYgKHR5cGVvZiBtb2R1bGUgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgbW9kdWxlLmV4cG9ydHMgPSBhcGk7XG4gIH0gZWxzZSB7XG4gICAgYXBwW25hbWVzcGFjZV0gPSBhcGk7XG4gIH1cblxufSh0aGlzLmFwcGxpdHVkZSB8fCB0aGlzKSk7XG4iLCJ2YXIgcHVsbCA9IHJlcXVpcmUoJ3B1bGwtc3RyZWFtJylcblxubW9kdWxlLmV4cG9ydHMgPSBwdWxsLlNvdXJjZShmdW5jdGlvbiAob25DbG9zZSkge1xuICB2YXIgYnVmZmVyID0gW10sIGNicyA9IFtdLCB3YWl0aW5nID0gW10sIGVuZGVkXG5cbiAgZnVuY3Rpb24gZHJhaW4oKSB7XG4gICAgdmFyIGxcbiAgICB3aGlsZSh3YWl0aW5nLmxlbmd0aCAmJiAoKGwgPSBidWZmZXIubGVuZ3RoKSB8fCBlbmRlZCkpIHtcbiAgICAgIHZhciBkYXRhID0gYnVmZmVyLnNoaWZ0KClcbiAgICAgIHZhciBjYiAgID0gY2JzLnNoaWZ0KClcbiAgICAgIHdhaXRpbmcuc2hpZnQoKShsID8gbnVsbCA6IGVuZGVkLCBkYXRhKVxuICAgICAgY2IgJiYgY2IoZW5kZWQgPT09IHRydWUgPyBudWxsIDogZW5kZWQpXG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gcmVhZCAoZW5kLCBjYikge1xuICAgIGVuZGVkID0gZW5kZWQgfHwgZW5kXG4gICAgd2FpdGluZy5wdXNoKGNiKVxuICAgIGRyYWluKClcbiAgICBpZihlbmRlZClcbiAgICAgIG9uQ2xvc2UgJiYgb25DbG9zZShlbmRlZCA9PT0gdHJ1ZSA/IG51bGwgOiBlbmRlZClcbiAgfVxuXG4gIHJlYWQucHVzaCA9IGZ1bmN0aW9uIChkYXRhLCBjYikge1xuICAgIGlmKGVuZGVkKVxuICAgICAgcmV0dXJuIGNiICYmIGNiKGVuZGVkID09PSB0cnVlID8gbnVsbCA6IGVuZGVkKVxuICAgIGJ1ZmZlci5wdXNoKGRhdGEpOyBjYnMucHVzaChjYilcbiAgICBkcmFpbigpXG4gIH1cblxuICByZWFkLmVuZCA9IGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIGVuZClcbiAgICAgIGNiID0gZW5kLCBlbmQgPSB0cnVlXG4gICAgZW5kZWQgPSBlbmRlZCB8fCBlbmQgfHwgdHJ1ZTtcbiAgICBpZihjYikgY2JzLnB1c2goY2IpXG4gICAgZHJhaW4oKVxuICAgIGlmKGVuZGVkKVxuICAgICAgb25DbG9zZSAmJiBvbkNsb3NlKGVuZGVkID09PSB0cnVlID8gbnVsbCA6IGVuZGVkKVxuICB9XG5cbiAgcmV0dXJuIHJlYWRcbn0pXG5cbiIsIlxudmFyIHNvdXJjZXMgID0gcmVxdWlyZSgnLi9zb3VyY2VzJylcbnZhciBzaW5rcyAgICA9IHJlcXVpcmUoJy4vc2lua3MnKVxudmFyIHRocm91Z2hzID0gcmVxdWlyZSgnLi90aHJvdWdocycpXG52YXIgdSAgICAgICAgPSByZXF1aXJlKCdwdWxsLWNvcmUnKVxuXG5mb3IodmFyIGsgaW4gc291cmNlcylcbiAgZXhwb3J0c1trXSA9IHUuU291cmNlKHNvdXJjZXNba10pXG5cbmZvcih2YXIgayBpbiB0aHJvdWdocylcbiAgZXhwb3J0c1trXSA9IHUuVGhyb3VnaCh0aHJvdWdoc1trXSlcblxuZm9yKHZhciBrIGluIHNpbmtzKVxuICBleHBvcnRzW2tdID0gdS5TaW5rKHNpbmtzW2tdKVxuXG52YXIgbWF5YmUgPSByZXF1aXJlKCcuL21heWJlJykoZXhwb3J0cylcblxuZm9yKHZhciBrIGluIG1heWJlKVxuICBleHBvcnRzW2tdID0gbWF5YmVba11cblxuZXhwb3J0cy5EdXBsZXggID0gXG5leHBvcnRzLlRocm91Z2ggPSBleHBvcnRzLnBpcGVhYmxlICAgICAgID0gdS5UaHJvdWdoXG5leHBvcnRzLlNvdXJjZSAgPSBleHBvcnRzLnBpcGVhYmxlU291cmNlID0gdS5Tb3VyY2VcbmV4cG9ydHMuU2luayAgICA9IGV4cG9ydHMucGlwZWFibGVTaW5rICAgPSB1LlNpbmtcblxuXG4iLCJ2YXIgdSA9IHJlcXVpcmUoJ3B1bGwtY29yZScpXG52YXIgcHJvcCA9IHUucHJvcFxudmFyIGlkICAgPSB1LmlkXG52YXIgbWF5YmVTaW5rID0gdS5tYXliZVNpbmtcblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAocHVsbCkge1xuXG4gIHZhciBleHBvcnRzID0ge31cbiAgdmFyIGRyYWluID0gcHVsbC5kcmFpblxuXG4gIHZhciBmaW5kID0gXG4gIGV4cG9ydHMuZmluZCA9IGZ1bmN0aW9uICh0ZXN0LCBjYikge1xuICAgIHJldHVybiBtYXliZVNpbmsoZnVuY3Rpb24gKGNiKSB7XG4gICAgICB2YXIgZW5kZWQgPSBmYWxzZVxuICAgICAgaWYoIWNiKVxuICAgICAgICBjYiA9IHRlc3QsIHRlc3QgPSBpZFxuICAgICAgZWxzZVxuICAgICAgICB0ZXN0ID0gcHJvcCh0ZXN0KSB8fCBpZFxuXG4gICAgICByZXR1cm4gZHJhaW4oZnVuY3Rpb24gKGRhdGEpIHtcbiAgICAgICAgaWYodGVzdChkYXRhKSkge1xuICAgICAgICAgIGVuZGVkID0gdHJ1ZVxuICAgICAgICAgIGNiKG51bGwsIGRhdGEpXG4gICAgICAgIHJldHVybiBmYWxzZVxuICAgICAgICB9XG4gICAgICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgIGlmKGVuZGVkKSByZXR1cm4gLy9hbHJlYWR5IGNhbGxlZCBiYWNrXG4gICAgICAgIGNiKGVyciA9PT0gdHJ1ZSA/IG51bGwgOiBlcnIsIG51bGwpXG4gICAgICB9KVxuXG4gICAgfSwgY2IpXG4gIH1cblxuICB2YXIgcmVkdWNlID0gZXhwb3J0cy5yZWR1Y2UgPSBcbiAgZnVuY3Rpb24gKHJlZHVjZSwgYWNjLCBjYikge1xuICAgIFxuICAgIHJldHVybiBtYXliZVNpbmsoZnVuY3Rpb24gKGNiKSB7XG4gICAgICByZXR1cm4gZHJhaW4oZnVuY3Rpb24gKGRhdGEpIHtcbiAgICAgICAgYWNjID0gcmVkdWNlKGFjYywgZGF0YSlcbiAgICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgY2IoZXJyLCBhY2MpXG4gICAgICB9KVxuXG4gICAgfSwgY2IpXG4gIH1cblxuICB2YXIgY29sbGVjdCA9IGV4cG9ydHMuY29sbGVjdCA9IGV4cG9ydHMud3JpdGVBcnJheSA9XG4gIGZ1bmN0aW9uIChjYikge1xuICAgIHJldHVybiByZWR1Y2UoZnVuY3Rpb24gKGFyciwgaXRlbSkge1xuICAgICAgYXJyLnB1c2goaXRlbSlcbiAgICAgIHJldHVybiBhcnJcbiAgICB9LCBbXSwgY2IpXG4gIH1cblxuICByZXR1cm4gZXhwb3J0c1xufVxuIiwiZXhwb3J0cy5pZCA9IFxuZnVuY3Rpb24gKGl0ZW0pIHtcbiAgcmV0dXJuIGl0ZW1cbn1cblxuZXhwb3J0cy5wcm9wID0gXG5mdW5jdGlvbiAobWFwKSB7ICBcbiAgaWYoJ3N0cmluZycgPT0gdHlwZW9mIG1hcCkge1xuICAgIHZhciBrZXkgPSBtYXBcbiAgICByZXR1cm4gZnVuY3Rpb24gKGRhdGEpIHsgcmV0dXJuIGRhdGFba2V5XSB9XG4gIH1cbiAgcmV0dXJuIG1hcFxufVxuXG5leHBvcnRzLnRlc3RlciA9IGZ1bmN0aW9uICh0ZXN0KSB7XG4gIGlmKCF0ZXN0KSByZXR1cm4gZXhwb3J0cy5pZFxuICBpZignb2JqZWN0JyA9PT0gdHlwZW9mIHRlc3RcbiAgICAmJiAnZnVuY3Rpb24nID09PSB0eXBlb2YgdGVzdC50ZXN0KVxuICAgICAgcmV0dXJuIHRlc3QudGVzdC5iaW5kKHRlc3QpXG4gIHJldHVybiBleHBvcnRzLnByb3AodGVzdCkgfHwgZXhwb3J0cy5pZFxufVxuXG5leHBvcnRzLmFkZFBpcGUgPSBhZGRQaXBlXG5cbmZ1bmN0aW9uIGFkZFBpcGUocmVhZCkge1xuICBpZignZnVuY3Rpb24nICE9PSB0eXBlb2YgcmVhZClcbiAgICByZXR1cm4gcmVhZFxuXG4gIHJlYWQucGlwZSA9IHJlYWQucGlwZSB8fCBmdW5jdGlvbiAocmVhZGVyKSB7XG4gICAgaWYoJ2Z1bmN0aW9uJyAhPSB0eXBlb2YgcmVhZGVyKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKCdtdXN0IHBpcGUgdG8gcmVhZGVyJylcbiAgICByZXR1cm4gYWRkUGlwZShyZWFkZXIocmVhZCkpXG4gIH1cbiAgcmVhZC50eXBlID0gJ1NvdXJjZSdcbiAgcmV0dXJuIHJlYWRcbn1cblxudmFyIFNvdXJjZSA9XG5leHBvcnRzLlNvdXJjZSA9XG5mdW5jdGlvbiBTb3VyY2UgKGNyZWF0ZVJlYWQpIHtcbiAgZnVuY3Rpb24gcygpIHtcbiAgICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKVxuICAgIHJldHVybiBhZGRQaXBlKGNyZWF0ZVJlYWQuYXBwbHkobnVsbCwgYXJncykpXG4gIH1cbiAgcy50eXBlID0gJ1NvdXJjZSdcbiAgcmV0dXJuIHNcbn1cblxuXG52YXIgVGhyb3VnaCA9XG5leHBvcnRzLlRocm91Z2ggPSBcbmZ1bmN0aW9uIChjcmVhdGVSZWFkKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cylcbiAgICB2YXIgcGlwZWQgPSBbXVxuICAgIGZ1bmN0aW9uIHJlYWRlciAocmVhZCkge1xuICAgICAgYXJncy51bnNoaWZ0KHJlYWQpXG4gICAgICByZWFkID0gY3JlYXRlUmVhZC5hcHBseShudWxsLCBhcmdzKVxuICAgICAgd2hpbGUocGlwZWQubGVuZ3RoKVxuICAgICAgICByZWFkID0gcGlwZWQuc2hpZnQoKShyZWFkKVxuICAgICAgcmV0dXJuIHJlYWRcbiAgICAgIC8vcGlwZWluZyB0byBmcm9tIHRoaXMgcmVhZGVyIHNob3VsZCBjb21wb3NlLi4uXG4gICAgfVxuICAgIHJlYWRlci5waXBlID0gZnVuY3Rpb24gKHJlYWQpIHtcbiAgICAgIHBpcGVkLnB1c2gocmVhZCkgXG4gICAgICBpZihyZWFkLnR5cGUgPT09ICdTb3VyY2UnKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ2Nhbm5vdCBwaXBlICcgKyByZWFkZXIudHlwZSArICcgdG8gU291cmNlJylcbiAgICAgIHJlYWRlci50eXBlID0gcmVhZC50eXBlID09PSAnU2luaycgPyAnU2luaycgOiAnVGhyb3VnaCdcbiAgICAgIHJldHVybiByZWFkZXJcbiAgICB9XG4gICAgcmVhZGVyLnR5cGUgPSAnVGhyb3VnaCdcbiAgICByZXR1cm4gcmVhZGVyXG4gIH1cbn1cblxudmFyIFNpbmsgPVxuZXhwb3J0cy5TaW5rID0gXG5mdW5jdGlvbiBTaW5rKGNyZWF0ZVJlYWRlcikge1xuICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpXG4gICAgaWYoIWNyZWF0ZVJlYWRlcilcbiAgICAgIHRocm93IG5ldyBFcnJvcignbXVzdCBiZSBjcmVhdGVSZWFkZXIgZnVuY3Rpb24nKVxuICAgIGZ1bmN0aW9uIHMgKHJlYWQpIHtcbiAgICAgIGFyZ3MudW5zaGlmdChyZWFkKVxuICAgICAgcmV0dXJuIGNyZWF0ZVJlYWRlci5hcHBseShudWxsLCBhcmdzKVxuICAgIH1cbiAgICBzLnR5cGUgPSAnU2luaydcbiAgICByZXR1cm4gc1xuICB9XG59XG5cblxuZXhwb3J0cy5tYXliZVNpbmsgPSBcbmV4cG9ydHMubWF5YmVEcmFpbiA9IFxuZnVuY3Rpb24gKGNyZWF0ZVNpbmssIGNiKSB7XG4gIGlmKCFjYilcbiAgICByZXR1cm4gVGhyb3VnaChmdW5jdGlvbiAocmVhZCkge1xuICAgICAgdmFyIGVuZGVkXG4gICAgICByZXR1cm4gZnVuY3Rpb24gKGNsb3NlLCBjYikge1xuICAgICAgICBpZihjbG9zZSkgcmV0dXJuIHJlYWQoY2xvc2UsIGNiKVxuICAgICAgICBpZihlbmRlZCkgcmV0dXJuIGNiKGVuZGVkKVxuXG4gICAgICAgIGNyZWF0ZVNpbmsoZnVuY3Rpb24gKGVyciwgZGF0YSkge1xuICAgICAgICAgIGVuZGVkID0gZXJyIHx8IHRydWVcbiAgICAgICAgICBpZighZXJyKSBjYihudWxsLCBkYXRhKVxuICAgICAgICAgIGVsc2UgICAgIGNiKGVuZGVkKVxuICAgICAgICB9KSAocmVhZClcbiAgICAgIH1cbiAgICB9KSgpXG5cbiAgcmV0dXJuIFNpbmsoZnVuY3Rpb24gKHJlYWQpIHtcbiAgICByZXR1cm4gY3JlYXRlU2luayhjYikgKHJlYWQpXG4gIH0pKClcbn1cblxuIiwidmFyIGRyYWluID0gZXhwb3J0cy5kcmFpbiA9IGZ1bmN0aW9uIChyZWFkLCBvcCwgZG9uZSkge1xuXG4gIDsoZnVuY3Rpb24gbmV4dCgpIHtcbiAgICB2YXIgbG9vcCA9IHRydWUsIGNiZWQgPSBmYWxzZVxuICAgIHdoaWxlKGxvb3ApIHtcbiAgICAgIGNiZWQgPSBmYWxzZVxuICAgICAgcmVhZChudWxsLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICAgIGNiZWQgPSB0cnVlXG4gICAgICAgIGlmKGVuZCkge1xuICAgICAgICAgIGxvb3AgPSBmYWxzZVxuICAgICAgICAgIGRvbmUgJiYgZG9uZShlbmQgPT09IHRydWUgPyBudWxsIDogZW5kKVxuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYob3AgJiYgZmFsc2UgPT09IG9wKGRhdGEpKSB7XG4gICAgICAgICAgbG9vcCA9IGZhbHNlXG4gICAgICAgICAgcmVhZCh0cnVlLCBkb25lIHx8IGZ1bmN0aW9uICgpIHt9KVxuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYoIWxvb3Ape1xuICAgICAgICAgIG5leHQoKVxuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgaWYoIWNiZWQpIHtcbiAgICAgICAgbG9vcCA9IGZhbHNlXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuICAgIH1cbiAgfSkoKVxufVxuXG52YXIgb25FbmQgPSBleHBvcnRzLm9uRW5kID0gZnVuY3Rpb24gKHJlYWQsIGRvbmUpIHtcbiAgcmV0dXJuIGRyYWluKHJlYWQsIG51bGwsIGRvbmUpXG59XG5cbnZhciBsb2cgPSBleHBvcnRzLmxvZyA9IGZ1bmN0aW9uIChyZWFkLCBkb25lKSB7XG4gIHJldHVybiBkcmFpbihyZWFkLCBmdW5jdGlvbiAoZGF0YSkge1xuICAgIGNvbnNvbGUubG9nKGRhdGEpXG4gIH0sIGRvbmUpXG59XG5cbiIsIlxudmFyIGtleXMgPSBleHBvcnRzLmtleXMgPVxuZnVuY3Rpb24gKG9iamVjdCkge1xuICByZXR1cm4gdmFsdWVzKE9iamVjdC5rZXlzKG9iamVjdCkpXG59XG5cbnZhciBvbmNlID0gZXhwb3J0cy5vbmNlID1cbmZ1bmN0aW9uICh2YWx1ZSkge1xuICByZXR1cm4gZnVuY3Rpb24gKGFib3J0LCBjYikge1xuICAgIGlmKGFib3J0KSByZXR1cm4gY2IoYWJvcnQpXG4gICAgaWYodmFsdWUgIT0gbnVsbCkge1xuICAgICAgdmFyIF92YWx1ZSA9IHZhbHVlOyB2YWx1ZSA9IG51bGxcbiAgICAgIGNiKG51bGwsIF92YWx1ZSlcbiAgICB9IGVsc2VcbiAgICAgIGNiKHRydWUpXG4gIH1cbn1cblxudmFyIHZhbHVlcyA9IGV4cG9ydHMudmFsdWVzID0gZXhwb3J0cy5yZWFkQXJyYXkgPVxuZnVuY3Rpb24gKGFycmF5KSB7XG4gIGlmKCFBcnJheS5pc0FycmF5KGFycmF5KSlcbiAgICBhcnJheSA9IE9iamVjdC5rZXlzKGFycmF5KS5tYXAoZnVuY3Rpb24gKGspIHtcbiAgICAgIHJldHVybiBhcnJheVtrXVxuICAgIH0pXG4gIHZhciBpID0gMFxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmQpXG4gICAgICByZXR1cm4gY2IgJiYgY2IoZW5kKSAgXG4gICAgY2IoaSA+PSBhcnJheS5sZW5ndGggfHwgbnVsbCwgYXJyYXlbaSsrXSlcbiAgfVxufVxuXG5cbnZhciBjb3VudCA9IGV4cG9ydHMuY291bnQgPSBcbmZ1bmN0aW9uIChtYXgpIHtcbiAgdmFyIGkgPSAwOyBtYXggPSBtYXggfHwgSW5maW5pdHlcbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoZW5kKSByZXR1cm4gY2IgJiYgY2IoZW5kKVxuICAgIGlmKGkgPiBtYXgpXG4gICAgICByZXR1cm4gY2IodHJ1ZSlcbiAgICBjYihudWxsLCBpKyspXG4gIH1cbn1cblxudmFyIGluZmluaXRlID0gZXhwb3J0cy5pbmZpbml0ZSA9IFxuZnVuY3Rpb24gKGdlbmVyYXRlKSB7XG4gIGdlbmVyYXRlID0gZ2VuZXJhdGUgfHwgTWF0aC5yYW5kb21cbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoZW5kKSByZXR1cm4gY2IgJiYgY2IoZW5kKVxuICAgIHJldHVybiBjYihudWxsLCBnZW5lcmF0ZSgpKVxuICB9XG59XG5cbnZhciBkZWZlciA9IGV4cG9ydHMuZGVmZXIgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBfcmVhZCwgY2JzID0gW10sIF9lbmRcblxuICB2YXIgcmVhZCA9IGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoIV9yZWFkKSB7XG4gICAgICBfZW5kID0gZW5kXG4gICAgICBjYnMucHVzaChjYilcbiAgICB9IFxuICAgIGVsc2UgX3JlYWQoZW5kLCBjYilcbiAgfVxuICByZWFkLnJlc29sdmUgPSBmdW5jdGlvbiAocmVhZCkge1xuICAgIGlmKF9yZWFkKSB0aHJvdyBuZXcgRXJyb3IoJ2FscmVhZHkgcmVzb2x2ZWQnKVxuICAgIF9yZWFkID0gcmVhZFxuICAgIGlmKCFfcmVhZCkgdGhyb3cgbmV3IEVycm9yKCdubyByZWFkIGNhbm5vdCByZXNvbHZlIScgKyBfcmVhZClcbiAgICB3aGlsZShjYnMubGVuZ3RoKVxuICAgICAgX3JlYWQoX2VuZCwgY2JzLnNoaWZ0KCkpXG4gIH1cbiAgcmVhZC5hYm9ydCA9IGZ1bmN0aW9uKGVycikge1xuICAgIHJlYWQucmVzb2x2ZShmdW5jdGlvbiAoXywgY2IpIHtcbiAgICAgIGNiKGVyciB8fCB0cnVlKVxuICAgIH0pXG4gIH1cbiAgcmV0dXJuIHJlYWRcbn1cblxudmFyIGVtcHR5ID0gZXhwb3J0cy5lbXB0eSA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIChhYm9ydCwgY2IpIHtcbiAgICBjYih0cnVlKVxuICB9XG59XG5cbnZhciBkZXB0aEZpcnN0ID0gZXhwb3J0cy5kZXB0aEZpcnN0ID1cbmZ1bmN0aW9uIChzdGFydCwgY3JlYXRlU3RyZWFtKSB7XG4gIHZhciByZWFkcyA9IFtdXG5cbiAgcmVhZHMudW5zaGlmdChvbmNlKHN0YXJ0KSlcblxuICByZXR1cm4gZnVuY3Rpb24gbmV4dCAoZW5kLCBjYikge1xuICAgIGlmKCFyZWFkcy5sZW5ndGgpXG4gICAgICByZXR1cm4gY2IodHJ1ZSlcbiAgICByZWFkc1swXShlbmQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZCkge1xuICAgICAgICAvL2lmIHRoaXMgc3RyZWFtIGhhcyBlbmRlZCwgZ28gdG8gdGhlIG5leHQgcXVldWVcbiAgICAgICAgcmVhZHMuc2hpZnQoKVxuICAgICAgICByZXR1cm4gbmV4dChudWxsLCBjYilcbiAgICAgIH1cbiAgICAgIHJlYWRzLnVuc2hpZnQoY3JlYXRlU3RyZWFtKGRhdGEpKVxuICAgICAgY2IoZW5kLCBkYXRhKVxuICAgIH0pXG4gIH1cbn1cbi8vd2lkdGggZmlyc3QgaXMganVzdCBsaWtlIGRlcHRoIGZpcnN0LFxuLy9idXQgcHVzaCBlYWNoIG5ldyBzdHJlYW0gb250byB0aGUgZW5kIG9mIHRoZSBxdWV1ZVxudmFyIHdpZHRoRmlyc3QgPSBleHBvcnRzLndpZHRoRmlyc3QgPSBcbmZ1bmN0aW9uIChzdGFydCwgY3JlYXRlU3RyZWFtKSB7XG4gIHZhciByZWFkcyA9IFtdXG5cbiAgcmVhZHMucHVzaChvbmNlKHN0YXJ0KSlcblxuICByZXR1cm4gZnVuY3Rpb24gbmV4dCAoZW5kLCBjYikge1xuICAgIGlmKCFyZWFkcy5sZW5ndGgpXG4gICAgICByZXR1cm4gY2IodHJ1ZSlcbiAgICByZWFkc1swXShlbmQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZCkge1xuICAgICAgICByZWFkcy5zaGlmdCgpXG4gICAgICAgIHJldHVybiBuZXh0KG51bGwsIGNiKVxuICAgICAgfVxuICAgICAgcmVhZHMucHVzaChjcmVhdGVTdHJlYW0oZGF0YSkpXG4gICAgICBjYihlbmQsIGRhdGEpXG4gICAgfSlcbiAgfVxufVxuXG4vL3RoaXMgY2FtZSBvdXQgZGlmZmVyZW50IHRvIHRoZSBmaXJzdCAoc3RybSlcbi8vYXR0ZW1wdCBhdCBsZWFmRmlyc3QsIGJ1dCBpdCdzIHN0aWxsIGEgdmFsaWRcbi8vdG9wb2xvZ2ljYWwgc29ydC5cbnZhciBsZWFmRmlyc3QgPSBleHBvcnRzLmxlYWZGaXJzdCA9IFxuZnVuY3Rpb24gKHN0YXJ0LCBjcmVhdGVTdHJlYW0pIHtcbiAgdmFyIHJlYWRzID0gW11cbiAgdmFyIG91dHB1dCA9IFtdXG4gIHJlYWRzLnB1c2gob25jZShzdGFydCkpXG4gIFxuICByZXR1cm4gZnVuY3Rpb24gbmV4dCAoZW5kLCBjYikge1xuICAgIHJlYWRzWzBdKGVuZCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kKSB7XG4gICAgICAgIHJlYWRzLnNoaWZ0KClcbiAgICAgICAgaWYoIW91dHB1dC5sZW5ndGgpXG4gICAgICAgICAgcmV0dXJuIGNiKHRydWUpXG4gICAgICAgIHJldHVybiBjYihudWxsLCBvdXRwdXQuc2hpZnQoKSlcbiAgICAgIH1cbiAgICAgIHJlYWRzLnVuc2hpZnQoY3JlYXRlU3RyZWFtKGRhdGEpKVxuICAgICAgb3V0cHV0LnVuc2hpZnQoZGF0YSlcbiAgICAgIG5leHQobnVsbCwgY2IpXG4gICAgfSlcbiAgfVxufVxuXG4iLCJ2YXIgdSAgICAgID0gcmVxdWlyZSgncHVsbC1jb3JlJylcbnZhciBzb3VyY2VzID0gcmVxdWlyZSgnLi9zb3VyY2VzJylcbnZhciBzaW5rcyA9IHJlcXVpcmUoJy4vc2lua3MnKVxuXG52YXIgcHJvcCAgID0gdS5wcm9wXG52YXIgaWQgICAgID0gdS5pZFxudmFyIHRlc3RlciA9IHUudGVzdGVyXG5cbnZhciBtYXAgPSBleHBvcnRzLm1hcCA9IFxuZnVuY3Rpb24gKHJlYWQsIG1hcCkge1xuICBtYXAgPSBwcm9wKG1hcCkgfHwgaWRcbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgcmVhZChlbmQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIHZhciBkYXRhID0gIWVuZCA/IG1hcChkYXRhKSA6IG51bGxcbiAgICAgIGNiKGVuZCwgZGF0YSlcbiAgICB9KVxuICB9XG59XG5cbnZhciBhc3luY01hcCA9IGV4cG9ydHMuYXN5bmNNYXAgPVxuZnVuY3Rpb24gKHJlYWQsIG1hcCkge1xuICBpZighbWFwKSByZXR1cm4gcmVhZFxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmQpIHJldHVybiByZWFkKGVuZCwgY2IpIC8vYWJvcnRcbiAgICByZWFkKG51bGwsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZCkgcmV0dXJuIGNiKGVuZCwgZGF0YSlcbiAgICAgIG1hcChkYXRhLCBjYilcbiAgICB9KVxuICB9XG59XG5cbnZhciBwYXJhTWFwID0gZXhwb3J0cy5wYXJhTWFwID1cbmZ1bmN0aW9uIChyZWFkLCBtYXAsIHdpZHRoKSB7XG4gIGlmKCFtYXApIHJldHVybiByZWFkXG4gIHZhciBlbmRlZCA9IGZhbHNlLCBxdWV1ZSA9IFtdLCBfY2JcblxuICBmdW5jdGlvbiBkcmFpbiAoKSB7XG4gICAgaWYoIV9jYikgcmV0dXJuXG4gICAgdmFyIGNiID0gX2NiXG4gICAgX2NiID0gbnVsbFxuICAgIGlmKHF1ZXVlLmxlbmd0aClcbiAgICAgIHJldHVybiBjYihudWxsLCBxdWV1ZS5zaGlmdCgpKVxuICAgIGVsc2UgaWYoZW5kZWQgJiYgIW4pXG4gICAgICByZXR1cm4gY2IoZW5kZWQpXG4gICAgX2NiID0gY2JcbiAgfVxuXG4gIGZ1bmN0aW9uIHB1bGwgKCkge1xuICAgIHJlYWQobnVsbCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kKSB7XG4gICAgICAgIGVuZGVkID0gZW5kXG4gICAgICAgIHJldHVybiBkcmFpbigpXG4gICAgICB9XG4gICAgICBuKytcbiAgICAgIG1hcChkYXRhLCBmdW5jdGlvbiAoZXJyLCBkYXRhKSB7XG4gICAgICAgIG4tLVxuXG4gICAgICAgIHF1ZXVlLnB1c2goZGF0YSlcbiAgICAgICAgZHJhaW4oKVxuICAgICAgfSlcblxuICAgICAgaWYobiA8IHdpZHRoICYmICFlbmRlZClcbiAgICAgICAgcHVsbCgpXG4gICAgfSlcbiAgfVxuXG4gIHZhciBuID0gMFxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmQpIHJldHVybiByZWFkKGVuZCwgY2IpIC8vYWJvcnRcbiAgICAvL2NvbnRpbnVlIHRvIHJlYWQgd2hpbGUgdGhlcmUgYXJlIGxlc3MgdGhhbiAzIG1hcHMgaW4gZmxpZ2h0XG4gICAgX2NiID0gY2JcbiAgICBpZihxdWV1ZS5sZW5ndGggfHwgZW5kZWQpXG4gICAgICBwdWxsKCksIGRyYWluKClcbiAgICBlbHNlIHB1bGwoKVxuICB9XG4gIHJldHVybiBoaWdoV2F0ZXJNYXJrKGFzeW5jTWFwKHJlYWQsIG1hcCksIHdpZHRoKVxufVxuXG52YXIgZmlsdGVyID0gZXhwb3J0cy5maWx0ZXIgPVxuZnVuY3Rpb24gKHJlYWQsIHRlc3QpIHtcbiAgLy9yZWdleHBcbiAgdGVzdCA9IHRlc3Rlcih0ZXN0KVxuICByZXR1cm4gZnVuY3Rpb24gbmV4dCAoZW5kLCBjYikge1xuICAgIHJlYWQoZW5kLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICBpZighZW5kICYmICF0ZXN0KGRhdGEpKVxuICAgICAgICByZXR1cm4gbmV4dChlbmQsIGNiKVxuICAgICAgY2IoZW5kLCBkYXRhKVxuICAgIH0pXG4gIH1cbn1cblxudmFyIGZpbHRlck5vdCA9IGV4cG9ydHMuZmlsdGVyTm90ID1cbmZ1bmN0aW9uIChyZWFkLCB0ZXN0KSB7XG4gIHRlc3QgPSB0ZXN0ZXIodGVzdClcbiAgcmV0dXJuIGZpbHRlcihyZWFkLCBmdW5jdGlvbiAoZSkge1xuICAgIHJldHVybiAhdGVzdChlKVxuICB9KVxufVxuXG52YXIgdGhyb3VnaCA9IGV4cG9ydHMudGhyb3VnaCA9IFxuZnVuY3Rpb24gKHJlYWQsIG9wLCBvbkVuZCkge1xuICB2YXIgYSA9IGZhbHNlXG4gIGZ1bmN0aW9uIG9uY2UgKGFib3J0KSB7XG4gICAgaWYoYSB8fCAhb25FbmQpIHJldHVyblxuICAgIGEgPSB0cnVlXG4gICAgb25FbmQoYWJvcnQgPT09IHRydWUgPyBudWxsIDogYWJvcnQpXG4gIH1cblxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmQpIG9uY2UoZW5kKVxuICAgIHJldHVybiByZWFkKGVuZCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoIWVuZCkgb3AgJiYgb3AoZGF0YSlcbiAgICAgIGVsc2Ugb25jZShlbmQpXG4gICAgICBjYihlbmQsIGRhdGEpXG4gICAgfSlcbiAgfVxufVxuXG52YXIgdGFrZSA9IGV4cG9ydHMudGFrZSA9XG5mdW5jdGlvbiAocmVhZCwgdGVzdCkge1xuICB2YXIgZW5kZWQgPSBmYWxzZVxuICBpZignbnVtYmVyJyA9PT0gdHlwZW9mIHRlc3QpIHtcbiAgICB2YXIgbiA9IHRlc3Q7IHRlc3QgPSBmdW5jdGlvbiAoKSB7XG4gICAgICByZXR1cm4gbiAtLVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGlmKGVuZGVkKSByZXR1cm4gY2IoZW5kZWQpXG4gICAgaWYoZW5kZWQgPSBlbmQpIHJldHVybiByZWFkKGVuZGVkLCBjYilcblxuICAgIHJlYWQobnVsbCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kZWQgPSBlbmRlZCB8fCBlbmQpIHJldHVybiBjYihlbmRlZClcbiAgICAgIGlmKCF0ZXN0KGRhdGEpKSB7XG4gICAgICAgIGVuZGVkID0gdHJ1ZVxuICAgICAgICByZWFkKHRydWUsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgICAgICBjYihlbmRlZCwgZGF0YSlcbiAgICAgICAgfSlcbiAgICAgIH1cbiAgICAgIGVsc2VcbiAgICAgICAgY2IobnVsbCwgZGF0YSlcbiAgICB9KVxuICB9XG59XG5cbnZhciB1bmlxdWUgPSBleHBvcnRzLnVuaXF1ZSA9IGZ1bmN0aW9uIChyZWFkLCBmaWVsZCwgaW52ZXJ0KSB7XG4gIGZpZWxkID0gcHJvcChmaWVsZCkgfHwgaWRcbiAgdmFyIHNlZW4gPSB7fVxuICByZXR1cm4gZmlsdGVyKHJlYWQsIGZ1bmN0aW9uIChkYXRhKSB7XG4gICAgdmFyIGtleSA9IGZpZWxkKGRhdGEpXG4gICAgaWYoc2VlbltrZXldKSByZXR1cm4gISFpbnZlcnQgLy9mYWxzZSwgYnkgZGVmYXVsdFxuICAgIGVsc2Ugc2VlbltrZXldID0gdHJ1ZVxuICAgIHJldHVybiAhaW52ZXJ0IC8vdHJ1ZSBieSBkZWZhdWx0XG4gIH0pXG59XG5cbnZhciBub25VbmlxdWUgPSBleHBvcnRzLm5vblVuaXF1ZSA9IGZ1bmN0aW9uIChyZWFkLCBmaWVsZCkge1xuICByZXR1cm4gdW5pcXVlKHJlYWQsIGZpZWxkLCB0cnVlKVxufVxuXG52YXIgZ3JvdXAgPSBleHBvcnRzLmdyb3VwID1cbmZ1bmN0aW9uIChyZWFkLCBzaXplKSB7XG4gIHZhciBlbmRlZDsgc2l6ZSA9IHNpemUgfHwgNVxuICB2YXIgcXVldWUgPSBbXVxuXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIC8vdGhpcyBtZWFucyB0aGF0IHRoZSB1cHN0cmVhbSBpcyBzZW5kaW5nIGFuIGVycm9yLlxuICAgIGlmKGVuZCkgcmV0dXJuIHJlYWQoZW5kZWQgPSBlbmQsIGNiKVxuICAgIC8vdGhpcyBtZWFucyB0aGF0IHdlIHJlYWQgYW4gZW5kIGJlZm9yZS5cbiAgICBpZihlbmRlZCkgcmV0dXJuIGNiKGVuZGVkKVxuXG4gICAgcmVhZChudWxsLCBmdW5jdGlvbiBuZXh0KGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kZWQgPSBlbmRlZCB8fCBlbmQpIHtcbiAgICAgICAgaWYoIXF1ZXVlLmxlbmd0aClcbiAgICAgICAgICByZXR1cm4gY2IoZW5kZWQpXG5cbiAgICAgICAgdmFyIF9xdWV1ZSA9IHF1ZXVlOyBxdWV1ZSA9IFtdXG4gICAgICAgIHJldHVybiBjYihudWxsLCBfcXVldWUpXG4gICAgICB9XG4gICAgICBxdWV1ZS5wdXNoKGRhdGEpXG4gICAgICBpZihxdWV1ZS5sZW5ndGggPCBzaXplKVxuICAgICAgICByZXR1cm4gcmVhZChudWxsLCBuZXh0KVxuXG4gICAgICB2YXIgX3F1ZXVlID0gcXVldWU7IHF1ZXVlID0gW11cbiAgICAgIGNiKG51bGwsIF9xdWV1ZSlcbiAgICB9KVxuICB9XG59XG5cbnZhciBmbGF0dGVuID0gZXhwb3J0cy5mbGF0dGVuID0gZnVuY3Rpb24gKHJlYWQpIHtcbiAgdmFyIF9yZWFkXG4gIHJldHVybiBmdW5jdGlvbiAoYWJvcnQsIGNiKSB7XG4gICAgaWYoX3JlYWQpIG5leHRDaHVuaygpXG4gICAgZWxzZSAgICAgIG5leHRTdHJlYW0oKVxuXG4gICAgZnVuY3Rpb24gbmV4dENodW5rICgpIHtcbiAgICAgIF9yZWFkKG51bGwsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgICAgaWYoZW5kKSBuZXh0U3RyZWFtKClcbiAgICAgICAgZWxzZSAgICBjYihudWxsLCBkYXRhKVxuICAgICAgfSlcbiAgICB9XG4gICAgZnVuY3Rpb24gbmV4dFN0cmVhbSAoKSB7XG4gICAgICByZWFkKG51bGwsIGZ1bmN0aW9uIChlbmQsIHN0cmVhbSkge1xuICAgICAgICBpZihlbmQpXG4gICAgICAgICAgcmV0dXJuIGNiKGVuZClcbiAgICAgICAgaWYoQXJyYXkuaXNBcnJheShzdHJlYW0pKVxuICAgICAgICAgIHN0cmVhbSA9IHNvdXJjZXMudmFsdWVzKHN0cmVhbSlcbiAgICAgICAgZWxzZSBpZignZnVuY3Rpb24nICE9IHR5cGVvZiBzdHJlYW0pXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdleHBlY3RlZCBzdHJlYW0gb2Ygc3RyZWFtcycpXG4gICAgICAgIFxuICAgICAgICBfcmVhZCA9IHN0cmVhbVxuICAgICAgICBuZXh0Q2h1bmsoKVxuICAgICAgfSlcbiAgICB9XG4gIH1cbn1cblxudmFyIHByZXBlbmQgPVxuZXhwb3J0cy5wcmVwZW5kID1cbmZ1bmN0aW9uIChyZWFkLCBoZWFkKSB7XG5cbiAgcmV0dXJuIGZ1bmN0aW9uIChhYm9ydCwgY2IpIHtcbiAgICBpZihoZWFkICE9PSBudWxsKSB7XG4gICAgICBpZihhYm9ydClcbiAgICAgICAgcmV0dXJuIHJlYWQoYWJvcnQsIGNiKVxuICAgICAgdmFyIF9oZWFkID0gaGVhZFxuICAgICAgaGVhZCA9IG51bGxcbiAgICAgIGNiKG51bGwsIF9oZWFkKVxuICAgIH0gZWxzZSB7XG4gICAgICByZWFkKGFib3J0LCBjYilcbiAgICB9XG4gIH1cblxufVxuXG4vL3ZhciBkcmFpbklmID0gZXhwb3J0cy5kcmFpbklmID0gZnVuY3Rpb24gKG9wLCBkb25lKSB7XG4vLyAgc2lua3MuZHJhaW4oXG4vL31cblxudmFyIF9yZWR1Y2UgPSBleHBvcnRzLl9yZWR1Y2UgPSBmdW5jdGlvbiAocmVhZCwgcmVkdWNlLCBpbml0aWFsKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoY2xvc2UsIGNiKSB7XG4gICAgaWYoY2xvc2UpIHJldHVybiByZWFkKGNsb3NlLCBjYilcbiAgICBpZihlbmRlZCkgcmV0dXJuIGNiKGVuZGVkKVxuXG4gICAgc2lua3MuZHJhaW4oZnVuY3Rpb24gKGl0ZW0pIHtcbiAgICAgIGluaXRpYWwgPSByZWR1Y2UoaW5pdGlhbCwgaXRlbSlcbiAgICB9LCBmdW5jdGlvbiAoZXJyLCBkYXRhKSB7XG4gICAgICBlbmRlZCA9IGVyciB8fCB0cnVlXG4gICAgICBpZighZXJyKSBjYihudWxsLCBpbml0aWFsKVxuICAgICAgZWxzZSAgICAgY2IoZW5kZWQpXG4gICAgfSlcbiAgICAocmVhZClcbiAgfVxufVxuXG52YXIgbmV4dFRpY2sgPSBwcm9jZXNzLm5leHRUaWNrXG5cbnZhciBoaWdoV2F0ZXJNYXJrID0gZXhwb3J0cy5oaWdoV2F0ZXJNYXJrID0gXG5mdW5jdGlvbiAocmVhZCwgaGlnaFdhdGVyTWFyaykge1xuICB2YXIgYnVmZmVyID0gW10sIHdhaXRpbmcgPSBbXSwgZW5kZWQsIHJlYWRpbmcgPSBmYWxzZVxuICBoaWdoV2F0ZXJNYXJrID0gaGlnaFdhdGVyTWFyayB8fCAxMFxuXG4gIGZ1bmN0aW9uIHJlYWRBaGVhZCAoKSB7XG4gICAgd2hpbGUod2FpdGluZy5sZW5ndGggJiYgKGJ1ZmZlci5sZW5ndGggfHwgZW5kZWQpKVxuICAgICAgd2FpdGluZy5zaGlmdCgpKGVuZGVkLCBlbmRlZCA/IG51bGwgOiBidWZmZXIuc2hpZnQoKSlcbiAgfVxuXG4gIGZ1bmN0aW9uIG5leHQgKCkge1xuICAgIGlmKGVuZGVkIHx8IHJlYWRpbmcgfHwgYnVmZmVyLmxlbmd0aCA+PSBoaWdoV2F0ZXJNYXJrKVxuICAgICAgcmV0dXJuXG4gICAgcmVhZGluZyA9IHRydWVcbiAgICByZXR1cm4gcmVhZChlbmRlZCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgcmVhZGluZyA9IGZhbHNlXG4gICAgICBlbmRlZCA9IGVuZGVkIHx8IGVuZFxuICAgICAgaWYoZGF0YSAhPSBudWxsKSBidWZmZXIucHVzaChkYXRhKVxuICAgICAgXG4gICAgICBuZXh0KCk7IHJlYWRBaGVhZCgpXG4gICAgfSlcbiAgfVxuXG4gIG5leHRUaWNrKG5leHQpXG5cbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgZW5kZWQgPSBlbmRlZCB8fCBlbmRcbiAgICB3YWl0aW5nLnB1c2goY2IpXG5cbiAgICBuZXh0KCk7IHJlYWRBaGVhZCgpXG4gIH1cbn1cblxuXG5cbiIsInZhciBzb3VyY2VzICA9IHJlcXVpcmUoJy4vc291cmNlcycpXG52YXIgc2lua3MgICAgPSByZXF1aXJlKCcuL3NpbmtzJylcbnZhciB0aHJvdWdocyA9IHJlcXVpcmUoJy4vdGhyb3VnaHMnKVxudmFyIHUgICAgICAgID0gcmVxdWlyZSgncHVsbC1jb3JlJylcblxuZnVuY3Rpb24gaXNGdW5jdGlvbiAoZnVuKSB7XG4gIHJldHVybiAnZnVuY3Rpb24nID09PSB0eXBlb2YgZnVuXG59XG5cbmZ1bmN0aW9uIGlzUmVhZGVyIChmdW4pIHtcbiAgcmV0dXJuIGZ1biAmJiAoZnVuLnR5cGUgPT09IFwiVGhyb3VnaFwiIHx8IGZ1bi5sZW5ndGggPT09IDEpXG59XG52YXIgZXhwb3J0cyA9IG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gcHVsbCAoKSB7XG4gIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpXG5cbiAgaWYoaXNSZWFkZXIoYXJnc1swXSkpXG4gICAgcmV0dXJuIGZ1bmN0aW9uIChyZWFkKSB7XG4gICAgICBhcmdzLnVuc2hpZnQocmVhZClcbiAgICAgIHJldHVybiBwdWxsLmFwcGx5KG51bGwsIGFyZ3MpXG4gICAgfVxuXG4gIHZhciByZWFkID0gYXJncy5zaGlmdCgpXG5cbiAgLy9pZiB0aGUgZmlyc3QgZnVuY3Rpb24gaXMgYSBkdXBsZXggc3RyZWFtLFxuICAvL3BpcGUgZnJvbSB0aGUgc291cmNlLlxuICBpZihpc0Z1bmN0aW9uKHJlYWQuc291cmNlKSlcbiAgICByZWFkID0gcmVhZC5zb3VyY2VcblxuICBmdW5jdGlvbiBuZXh0ICgpIHtcbiAgICB2YXIgcyA9IGFyZ3Muc2hpZnQoKVxuXG4gICAgaWYobnVsbCA9PSBzKVxuICAgICAgcmV0dXJuIG5leHQoKVxuXG4gICAgaWYoaXNGdW5jdGlvbihzKSkgcmV0dXJuIHNcblxuICAgIHJldHVybiBmdW5jdGlvbiAocmVhZCkge1xuICAgICAgcy5zaW5rKHJlYWQpXG4gICAgICAvL3RoaXMgc3VwcG9ydHMgcGlwZWluZyB0aHJvdWdoIGEgZHVwbGV4IHN0cmVhbVxuICAgICAgLy9wdWxsKGEsIGIsIGEpIFwidGVsZXBob25lIHN0eWxlXCIuXG4gICAgICAvL2lmIHRoaXMgc3RyZWFtIGlzIGluIHRoZSBhIChmaXJzdCAmIGxhc3QgcG9zaXRpb24pXG4gICAgICAvL3Muc291cmNlIHdpbGwgaGF2ZSBhbHJlYWR5IGJlZW4gdXNlZCwgYnV0IHRoaXMgc2hvdWxkIG5ldmVyIGJlIGNhbGxlZFxuICAgICAgLy9zbyB0aGF0IGlzIG9rYXkuXG4gICAgICByZXR1cm4gcy5zb3VyY2VcbiAgICB9XG4gIH1cblxuICB3aGlsZShhcmdzLmxlbmd0aClcbiAgICByZWFkID0gbmV4dCgpIChyZWFkKVxuXG4gIHJldHVybiByZWFkXG59XG5cblxuZm9yKHZhciBrIGluIHNvdXJjZXMpXG4gIGV4cG9ydHNba10gPSB1LlNvdXJjZShzb3VyY2VzW2tdKVxuXG5mb3IodmFyIGsgaW4gdGhyb3VnaHMpXG4gIGV4cG9ydHNba10gPSB1LlRocm91Z2godGhyb3VnaHNba10pXG5cbmZvcih2YXIgayBpbiBzaW5rcylcbiAgZXhwb3J0c1trXSA9IHUuU2luayhzaW5rc1trXSlcblxudmFyIG1heWJlID0gcmVxdWlyZSgnLi9tYXliZScpKGV4cG9ydHMpXG5cbmZvcih2YXIgayBpbiBtYXliZSlcbiAgZXhwb3J0c1trXSA9IG1heWJlW2tdXG5cbmV4cG9ydHMuRHVwbGV4ICA9IFxuZXhwb3J0cy5UaHJvdWdoID0gZXhwb3J0cy5waXBlYWJsZSAgICAgICA9IHUuVGhyb3VnaFxuZXhwb3J0cy5Tb3VyY2UgID0gZXhwb3J0cy5waXBlYWJsZVNvdXJjZSA9IHUuU291cmNlXG5leHBvcnRzLlNpbmsgICAgPSBleHBvcnRzLnBpcGVhYmxlU2luayAgID0gdS5TaW5rXG5cblxuIiwidmFyIHUgPSByZXF1aXJlKCdwdWxsLWNvcmUnKVxudmFyIHByb3AgPSB1LnByb3BcbnZhciBpZCAgID0gdS5pZFxudmFyIG1heWJlU2luayA9IHUubWF5YmVTaW5rXG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKHB1bGwpIHtcblxuICB2YXIgZXhwb3J0cyA9IHt9XG4gIHZhciBkcmFpbiA9IHB1bGwuZHJhaW5cblxuICB2YXIgZmluZCA9XG4gIGV4cG9ydHMuZmluZCA9IGZ1bmN0aW9uICh0ZXN0LCBjYikge1xuICAgIHJldHVybiBtYXliZVNpbmsoZnVuY3Rpb24gKGNiKSB7XG4gICAgICB2YXIgZW5kZWQgPSBmYWxzZVxuICAgICAgaWYoIWNiKVxuICAgICAgICBjYiA9IHRlc3QsIHRlc3QgPSBpZFxuICAgICAgZWxzZVxuICAgICAgICB0ZXN0ID0gcHJvcCh0ZXN0KSB8fCBpZFxuXG4gICAgICByZXR1cm4gZHJhaW4oZnVuY3Rpb24gKGRhdGEpIHtcbiAgICAgICAgaWYodGVzdChkYXRhKSkge1xuICAgICAgICAgIGVuZGVkID0gdHJ1ZVxuICAgICAgICAgIGNiKG51bGwsIGRhdGEpXG4gICAgICAgIHJldHVybiBmYWxzZVxuICAgICAgICB9XG4gICAgICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgIGlmKGVuZGVkKSByZXR1cm4gLy9hbHJlYWR5IGNhbGxlZCBiYWNrXG4gICAgICAgIGNiKGVyciA9PT0gdHJ1ZSA/IG51bGwgOiBlcnIsIG51bGwpXG4gICAgICB9KVxuXG4gICAgfSwgY2IpXG4gIH1cblxuICB2YXIgcmVkdWNlID0gZXhwb3J0cy5yZWR1Y2UgPVxuICBmdW5jdGlvbiAocmVkdWNlLCBhY2MsIGNiKSB7XG5cbiAgICByZXR1cm4gbWF5YmVTaW5rKGZ1bmN0aW9uIChjYikge1xuICAgICAgcmV0dXJuIGRyYWluKGZ1bmN0aW9uIChkYXRhKSB7XG4gICAgICAgIGFjYyA9IHJlZHVjZShhY2MsIGRhdGEpXG4gICAgICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgIGNiKGVyciwgYWNjKVxuICAgICAgfSlcblxuICAgIH0sIGNiKVxuICB9XG5cbiAgdmFyIGNvbGxlY3QgPSBleHBvcnRzLmNvbGxlY3QgPSBleHBvcnRzLndyaXRlQXJyYXkgPVxuICBmdW5jdGlvbiAoY2IpIHtcbiAgICByZXR1cm4gcmVkdWNlKGZ1bmN0aW9uIChhcnIsIGl0ZW0pIHtcbiAgICAgIGFyci5wdXNoKGl0ZW0pXG4gICAgICByZXR1cm4gYXJyXG4gICAgfSwgW10sIGNiKVxuICB9XG5cbiAgdmFyIGNvbmNhdCA9IGV4cG9ydHMuY29uY2F0ID1cbiAgZnVuY3Rpb24gKGNiKSB7XG4gICAgcmV0dXJuIHJlZHVjZShmdW5jdGlvbiAoYSwgYikge1xuICAgICAgcmV0dXJuIGEgKyBiXG4gICAgfSwgJycsIGNiKVxuICB9XG5cbiAgcmV0dXJuIGV4cG9ydHNcbn1cbiIsInZhciBkcmFpbiA9IGV4cG9ydHMuZHJhaW4gPSBmdW5jdGlvbiAocmVhZCwgb3AsIGRvbmUpIHtcblxuICA7KGZ1bmN0aW9uIG5leHQoKSB7XG4gICAgdmFyIGxvb3AgPSB0cnVlLCBjYmVkID0gZmFsc2VcbiAgICB3aGlsZShsb29wKSB7XG4gICAgICBjYmVkID0gZmFsc2VcbiAgICAgIHJlYWQobnVsbCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgICBjYmVkID0gdHJ1ZVxuICAgICAgICBpZihlbmQpIHtcbiAgICAgICAgICBsb29wID0gZmFsc2VcbiAgICAgICAgICBpZihkb25lKSBkb25lKGVuZCA9PT0gdHJ1ZSA/IG51bGwgOiBlbmQpXG4gICAgICAgICAgZWxzZSBpZihlbmQgJiYgZW5kICE9PSB0cnVlKVxuICAgICAgICAgICAgdGhyb3cgZW5kXG4gICAgICAgIH1cbiAgICAgICAgZWxzZSBpZihvcCAmJiBmYWxzZSA9PT0gb3AoZGF0YSkpIHtcbiAgICAgICAgICBsb29wID0gZmFsc2VcbiAgICAgICAgICByZWFkKHRydWUsIGRvbmUgfHwgZnVuY3Rpb24gKCkge30pXG4gICAgICAgIH1cbiAgICAgICAgZWxzZSBpZighbG9vcCl7XG4gICAgICAgICAgbmV4dCgpXG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgICBpZighY2JlZCkge1xuICAgICAgICBsb29wID0gZmFsc2VcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG4gICAgfVxuICB9KSgpXG59XG5cbnZhciBvbkVuZCA9IGV4cG9ydHMub25FbmQgPSBmdW5jdGlvbiAocmVhZCwgZG9uZSkge1xuICByZXR1cm4gZHJhaW4ocmVhZCwgbnVsbCwgZG9uZSlcbn1cblxudmFyIGxvZyA9IGV4cG9ydHMubG9nID0gZnVuY3Rpb24gKHJlYWQsIGRvbmUpIHtcbiAgcmV0dXJuIGRyYWluKHJlYWQsIGZ1bmN0aW9uIChkYXRhKSB7XG4gICAgY29uc29sZS5sb2coZGF0YSlcbiAgfSwgZG9uZSlcbn1cblxuIiwiXG52YXIga2V5cyA9IGV4cG9ydHMua2V5cyA9XG5mdW5jdGlvbiAob2JqZWN0KSB7XG4gIHJldHVybiB2YWx1ZXMoT2JqZWN0LmtleXMob2JqZWN0KSlcbn1cblxudmFyIG9uY2UgPSBleHBvcnRzLm9uY2UgPVxuZnVuY3Rpb24gKHZhbHVlKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoYWJvcnQsIGNiKSB7XG4gICAgaWYoYWJvcnQpIHJldHVybiBjYihhYm9ydClcbiAgICBpZih2YWx1ZSAhPSBudWxsKSB7XG4gICAgICB2YXIgX3ZhbHVlID0gdmFsdWU7IHZhbHVlID0gbnVsbFxuICAgICAgY2IobnVsbCwgX3ZhbHVlKVxuICAgIH0gZWxzZVxuICAgICAgY2IodHJ1ZSlcbiAgfVxufVxuXG52YXIgdmFsdWVzID0gZXhwb3J0cy52YWx1ZXMgPSBleHBvcnRzLnJlYWRBcnJheSA9XG5mdW5jdGlvbiAoYXJyYXkpIHtcbiAgaWYoIUFycmF5LmlzQXJyYXkoYXJyYXkpKVxuICAgIGFycmF5ID0gT2JqZWN0LmtleXMoYXJyYXkpLm1hcChmdW5jdGlvbiAoaykge1xuICAgICAgcmV0dXJuIGFycmF5W2tdXG4gICAgfSlcbiAgdmFyIGkgPSAwXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGlmKGVuZClcbiAgICAgIHJldHVybiBjYiAmJiBjYihlbmQpXG4gICAgY2IoaSA+PSBhcnJheS5sZW5ndGggfHwgbnVsbCwgYXJyYXlbaSsrXSlcbiAgfVxufVxuXG5cbnZhciBjb3VudCA9IGV4cG9ydHMuY291bnQgPVxuZnVuY3Rpb24gKG1heCkge1xuICB2YXIgaSA9IDA7IG1heCA9IG1heCB8fCBJbmZpbml0eVxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmQpIHJldHVybiBjYiAmJiBjYihlbmQpXG4gICAgaWYoaSA+IG1heClcbiAgICAgIHJldHVybiBjYih0cnVlKVxuICAgIGNiKG51bGwsIGkrKylcbiAgfVxufVxuXG52YXIgaW5maW5pdGUgPSBleHBvcnRzLmluZmluaXRlID1cbmZ1bmN0aW9uIChnZW5lcmF0ZSkge1xuICBnZW5lcmF0ZSA9IGdlbmVyYXRlIHx8IE1hdGgucmFuZG9tXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGlmKGVuZCkgcmV0dXJuIGNiICYmIGNiKGVuZClcbiAgICByZXR1cm4gY2IobnVsbCwgZ2VuZXJhdGUoKSlcbiAgfVxufVxuXG52YXIgZGVmZXIgPSBleHBvcnRzLmRlZmVyID0gZnVuY3Rpb24gKCkge1xuICB2YXIgX3JlYWQsIGNicyA9IFtdLCBfZW5kXG5cbiAgdmFyIHJlYWQgPSBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGlmKCFfcmVhZCkge1xuICAgICAgX2VuZCA9IGVuZFxuICAgICAgY2JzLnB1c2goY2IpXG4gICAgfSBcbiAgICBlbHNlIF9yZWFkKGVuZCwgY2IpXG4gIH1cbiAgcmVhZC5yZXNvbHZlID0gZnVuY3Rpb24gKHJlYWQpIHtcbiAgICBpZihfcmVhZCkgdGhyb3cgbmV3IEVycm9yKCdhbHJlYWR5IHJlc29sdmVkJylcbiAgICBfcmVhZCA9IHJlYWRcbiAgICBpZighX3JlYWQpIHRocm93IG5ldyBFcnJvcignbm8gcmVhZCBjYW5ub3QgcmVzb2x2ZSEnICsgX3JlYWQpXG4gICAgd2hpbGUoY2JzLmxlbmd0aClcbiAgICAgIF9yZWFkKF9lbmQsIGNicy5zaGlmdCgpKVxuICB9XG4gIHJlYWQuYWJvcnQgPSBmdW5jdGlvbihlcnIpIHtcbiAgICByZWFkLnJlc29sdmUoZnVuY3Rpb24gKF8sIGNiKSB7XG4gICAgICBjYihlcnIgfHwgdHJ1ZSlcbiAgICB9KVxuICB9XG4gIHJldHVybiByZWFkXG59XG5cbnZhciBlbXB0eSA9IGV4cG9ydHMuZW1wdHkgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoYWJvcnQsIGNiKSB7XG4gICAgY2IodHJ1ZSlcbiAgfVxufVxuXG52YXIgZXJyb3IgPSBleHBvcnRzLmVycm9yID0gZnVuY3Rpb24gKGVycikge1xuICByZXR1cm4gZnVuY3Rpb24gKGFib3J0LCBjYikge1xuICAgIGNiKGVycilcbiAgfVxufVxuXG52YXIgZGVwdGhGaXJzdCA9IGV4cG9ydHMuZGVwdGhGaXJzdCA9XG5mdW5jdGlvbiAoc3RhcnQsIGNyZWF0ZVN0cmVhbSkge1xuICB2YXIgcmVhZHMgPSBbXVxuXG4gIHJlYWRzLnVuc2hpZnQob25jZShzdGFydCkpXG5cbiAgcmV0dXJuIGZ1bmN0aW9uIG5leHQgKGVuZCwgY2IpIHtcbiAgICBpZighcmVhZHMubGVuZ3RoKVxuICAgICAgcmV0dXJuIGNiKHRydWUpXG4gICAgcmVhZHNbMF0oZW5kLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICBpZihlbmQpIHtcbiAgICAgICAgLy9pZiB0aGlzIHN0cmVhbSBoYXMgZW5kZWQsIGdvIHRvIHRoZSBuZXh0IHF1ZXVlXG4gICAgICAgIHJlYWRzLnNoaWZ0KClcbiAgICAgICAgcmV0dXJuIG5leHQobnVsbCwgY2IpXG4gICAgICB9XG4gICAgICByZWFkcy51bnNoaWZ0KGNyZWF0ZVN0cmVhbShkYXRhKSlcbiAgICAgIGNiKGVuZCwgZGF0YSlcbiAgICB9KVxuICB9XG59XG4vL3dpZHRoIGZpcnN0IGlzIGp1c3QgbGlrZSBkZXB0aCBmaXJzdCxcbi8vYnV0IHB1c2ggZWFjaCBuZXcgc3RyZWFtIG9udG8gdGhlIGVuZCBvZiB0aGUgcXVldWVcbnZhciB3aWR0aEZpcnN0ID0gZXhwb3J0cy53aWR0aEZpcnN0ID1cbmZ1bmN0aW9uIChzdGFydCwgY3JlYXRlU3RyZWFtKSB7XG4gIHZhciByZWFkcyA9IFtdXG5cbiAgcmVhZHMucHVzaChvbmNlKHN0YXJ0KSlcblxuICByZXR1cm4gZnVuY3Rpb24gbmV4dCAoZW5kLCBjYikge1xuICAgIGlmKCFyZWFkcy5sZW5ndGgpXG4gICAgICByZXR1cm4gY2IodHJ1ZSlcbiAgICByZWFkc1swXShlbmQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZCkge1xuICAgICAgICByZWFkcy5zaGlmdCgpXG4gICAgICAgIHJldHVybiBuZXh0KG51bGwsIGNiKVxuICAgICAgfVxuICAgICAgcmVhZHMucHVzaChjcmVhdGVTdHJlYW0oZGF0YSkpXG4gICAgICBjYihlbmQsIGRhdGEpXG4gICAgfSlcbiAgfVxufVxuXG4vL3RoaXMgY2FtZSBvdXQgZGlmZmVyZW50IHRvIHRoZSBmaXJzdCAoc3RybSlcbi8vYXR0ZW1wdCBhdCBsZWFmRmlyc3QsIGJ1dCBpdCdzIHN0aWxsIGEgdmFsaWRcbi8vdG9wb2xvZ2ljYWwgc29ydC5cbnZhciBsZWFmRmlyc3QgPSBleHBvcnRzLmxlYWZGaXJzdCA9XG5mdW5jdGlvbiAoc3RhcnQsIGNyZWF0ZVN0cmVhbSkge1xuICB2YXIgcmVhZHMgPSBbXVxuICB2YXIgb3V0cHV0ID0gW11cbiAgcmVhZHMucHVzaChvbmNlKHN0YXJ0KSlcblxuICByZXR1cm4gZnVuY3Rpb24gbmV4dCAoZW5kLCBjYikge1xuICAgIHJlYWRzWzBdKGVuZCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kKSB7XG4gICAgICAgIHJlYWRzLnNoaWZ0KClcbiAgICAgICAgaWYoIW91dHB1dC5sZW5ndGgpXG4gICAgICAgICAgcmV0dXJuIGNiKHRydWUpXG4gICAgICAgIHJldHVybiBjYihudWxsLCBvdXRwdXQuc2hpZnQoKSlcbiAgICAgIH1cbiAgICAgIHJlYWRzLnVuc2hpZnQoY3JlYXRlU3RyZWFtKGRhdGEpKVxuICAgICAgb3V0cHV0LnVuc2hpZnQoZGF0YSlcbiAgICAgIG5leHQobnVsbCwgY2IpXG4gICAgfSlcbiAgfVxufVxuXG4iLCJ2YXIgdSAgICAgID0gcmVxdWlyZSgncHVsbC1jb3JlJylcbnZhciBzb3VyY2VzID0gcmVxdWlyZSgnLi9zb3VyY2VzJylcbnZhciBzaW5rcyA9IHJlcXVpcmUoJy4vc2lua3MnKVxuXG52YXIgcHJvcCAgID0gdS5wcm9wXG52YXIgaWQgICAgID0gdS5pZFxudmFyIHRlc3RlciA9IHUudGVzdGVyXG5cbnZhciBtYXAgPSBleHBvcnRzLm1hcCA9XG5mdW5jdGlvbiAocmVhZCwgbWFwKSB7XG4gIG1hcCA9IHByb3AobWFwKSB8fCBpZFxuICByZXR1cm4gZnVuY3Rpb24gKGFib3J0LCBjYikge1xuICAgIHJlYWQoYWJvcnQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIHRyeSB7XG4gICAgICBkYXRhID0gIWVuZCA/IG1hcChkYXRhKSA6IG51bGxcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gcmVhZChlcnIsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICByZXR1cm4gY2IoZXJyKVxuICAgICAgICB9KVxuICAgICAgfVxuICAgICAgY2IoZW5kLCBkYXRhKVxuICAgIH0pXG4gIH1cbn1cblxudmFyIGFzeW5jTWFwID0gZXhwb3J0cy5hc3luY01hcCA9XG5mdW5jdGlvbiAocmVhZCwgbWFwKSB7XG4gIGlmKCFtYXApIHJldHVybiByZWFkXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGlmKGVuZCkgcmV0dXJuIHJlYWQoZW5kLCBjYikgLy9hYm9ydFxuICAgIHJlYWQobnVsbCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kKSByZXR1cm4gY2IoZW5kLCBkYXRhKVxuICAgICAgbWFwKGRhdGEsIGNiKVxuICAgIH0pXG4gIH1cbn1cblxudmFyIHBhcmFNYXAgPSBleHBvcnRzLnBhcmFNYXAgPVxuZnVuY3Rpb24gKHJlYWQsIG1hcCwgd2lkdGgpIHtcbiAgaWYoIW1hcCkgcmV0dXJuIHJlYWRcbiAgdmFyIGVuZGVkID0gZmFsc2UsIHF1ZXVlID0gW10sIF9jYlxuXG4gIGZ1bmN0aW9uIGRyYWluICgpIHtcbiAgICBpZighX2NiKSByZXR1cm5cbiAgICB2YXIgY2IgPSBfY2JcbiAgICBfY2IgPSBudWxsXG4gICAgaWYocXVldWUubGVuZ3RoKVxuICAgICAgcmV0dXJuIGNiKG51bGwsIHF1ZXVlLnNoaWZ0KCkpXG4gICAgZWxzZSBpZihlbmRlZCAmJiAhbilcbiAgICAgIHJldHVybiBjYihlbmRlZClcbiAgICBfY2IgPSBjYlxuICB9XG5cbiAgZnVuY3Rpb24gcHVsbCAoKSB7XG4gICAgcmVhZChudWxsLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICBpZihlbmQpIHtcbiAgICAgICAgZW5kZWQgPSBlbmRcbiAgICAgICAgcmV0dXJuIGRyYWluKClcbiAgICAgIH1cbiAgICAgIG4rK1xuICAgICAgbWFwKGRhdGEsIGZ1bmN0aW9uIChlcnIsIGRhdGEpIHtcbiAgICAgICAgbi0tXG5cbiAgICAgICAgcXVldWUucHVzaChkYXRhKVxuICAgICAgICBkcmFpbigpXG4gICAgICB9KVxuXG4gICAgICBpZihuIDwgd2lkdGggJiYgIWVuZGVkKVxuICAgICAgICBwdWxsKClcbiAgICB9KVxuICB9XG5cbiAgdmFyIG4gPSAwXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGlmKGVuZCkgcmV0dXJuIHJlYWQoZW5kLCBjYikgLy9hYm9ydFxuICAgIC8vY29udGludWUgdG8gcmVhZCB3aGlsZSB0aGVyZSBhcmUgbGVzcyB0aGFuIDMgbWFwcyBpbiBmbGlnaHRcbiAgICBfY2IgPSBjYlxuICAgIGlmKHF1ZXVlLmxlbmd0aCB8fCBlbmRlZClcbiAgICAgIHB1bGwoKSwgZHJhaW4oKVxuICAgIGVsc2UgcHVsbCgpXG4gIH1cbiAgcmV0dXJuIGhpZ2hXYXRlck1hcmsoYXN5bmNNYXAocmVhZCwgbWFwKSwgd2lkdGgpXG59XG5cbnZhciBmaWx0ZXIgPSBleHBvcnRzLmZpbHRlciA9XG5mdW5jdGlvbiAocmVhZCwgdGVzdCkge1xuICAvL3JlZ2V4cFxuICB0ZXN0ID0gdGVzdGVyKHRlc3QpXG4gIHJldHVybiBmdW5jdGlvbiBuZXh0IChlbmQsIGNiKSB7XG4gICAgdmFyIHN5bmMsIGxvb3AgPSB0cnVlXG4gICAgd2hpbGUobG9vcCkge1xuICAgICAgbG9vcCA9IGZhbHNlXG4gICAgICBzeW5jID0gdHJ1ZVxuICAgICAgcmVhZChlbmQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgICAgaWYoIWVuZCAmJiAhdGVzdChkYXRhKSlcbiAgICAgICAgICByZXR1cm4gc3luYyA/IGxvb3AgPSB0cnVlIDogbmV4dChlbmQsIGNiKVxuICAgICAgICBjYihlbmQsIGRhdGEpXG4gICAgICB9KVxuICAgICAgc3luYyA9IGZhbHNlXG4gICAgfVxuICB9XG59XG5cbnZhciBmaWx0ZXJOb3QgPSBleHBvcnRzLmZpbHRlck5vdCA9XG5mdW5jdGlvbiAocmVhZCwgdGVzdCkge1xuICB0ZXN0ID0gdGVzdGVyKHRlc3QpXG4gIHJldHVybiBmaWx0ZXIocmVhZCwgZnVuY3Rpb24gKGUpIHtcbiAgICByZXR1cm4gIXRlc3QoZSlcbiAgfSlcbn1cblxudmFyIHRocm91Z2ggPSBleHBvcnRzLnRocm91Z2ggPVxuZnVuY3Rpb24gKHJlYWQsIG9wLCBvbkVuZCkge1xuICB2YXIgYSA9IGZhbHNlXG4gIGZ1bmN0aW9uIG9uY2UgKGFib3J0KSB7XG4gICAgaWYoYSB8fCAhb25FbmQpIHJldHVyblxuICAgIGEgPSB0cnVlXG4gICAgb25FbmQoYWJvcnQgPT09IHRydWUgPyBudWxsIDogYWJvcnQpXG4gIH1cblxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmQpIG9uY2UoZW5kKVxuICAgIHJldHVybiByZWFkKGVuZCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoIWVuZCkgb3AgJiYgb3AoZGF0YSlcbiAgICAgIGVsc2Ugb25jZShlbmQpXG4gICAgICBjYihlbmQsIGRhdGEpXG4gICAgfSlcbiAgfVxufVxuXG52YXIgdGFrZSA9IGV4cG9ydHMudGFrZSA9XG5mdW5jdGlvbiAocmVhZCwgdGVzdCkge1xuICB2YXIgZW5kZWQgPSBmYWxzZVxuICBpZignbnVtYmVyJyA9PT0gdHlwZW9mIHRlc3QpIHtcbiAgICB2YXIgbiA9IHRlc3Q7IHRlc3QgPSBmdW5jdGlvbiAoKSB7XG4gICAgICByZXR1cm4gbiAtLVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGlmKGVuZGVkKSByZXR1cm4gY2IoZW5kZWQpXG4gICAgaWYoZW5kZWQgPSBlbmQpIHJldHVybiByZWFkKGVuZGVkLCBjYilcblxuICAgIHJlYWQobnVsbCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kZWQgPSBlbmRlZCB8fCBlbmQpIHJldHVybiBjYihlbmRlZClcbiAgICAgIGlmKCF0ZXN0KGRhdGEpKSB7XG4gICAgICAgIGVuZGVkID0gdHJ1ZVxuICAgICAgICByZWFkKHRydWUsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgICAgICBjYihlbmRlZCwgZGF0YSlcbiAgICAgICAgfSlcbiAgICAgIH1cbiAgICAgIGVsc2VcbiAgICAgICAgY2IobnVsbCwgZGF0YSlcbiAgICB9KVxuICB9XG59XG5cbnZhciB1bmlxdWUgPSBleHBvcnRzLnVuaXF1ZSA9IGZ1bmN0aW9uIChyZWFkLCBmaWVsZCwgaW52ZXJ0KSB7XG4gIGZpZWxkID0gcHJvcChmaWVsZCkgfHwgaWRcbiAgdmFyIHNlZW4gPSB7fVxuICByZXR1cm4gZmlsdGVyKHJlYWQsIGZ1bmN0aW9uIChkYXRhKSB7XG4gICAgdmFyIGtleSA9IGZpZWxkKGRhdGEpXG4gICAgaWYoc2VlbltrZXldKSByZXR1cm4gISFpbnZlcnQgLy9mYWxzZSwgYnkgZGVmYXVsdFxuICAgIGVsc2Ugc2VlbltrZXldID0gdHJ1ZVxuICAgIHJldHVybiAhaW52ZXJ0IC8vdHJ1ZSBieSBkZWZhdWx0XG4gIH0pXG59XG5cbnZhciBub25VbmlxdWUgPSBleHBvcnRzLm5vblVuaXF1ZSA9IGZ1bmN0aW9uIChyZWFkLCBmaWVsZCkge1xuICByZXR1cm4gdW5pcXVlKHJlYWQsIGZpZWxkLCB0cnVlKVxufVxuXG52YXIgZ3JvdXAgPSBleHBvcnRzLmdyb3VwID1cbmZ1bmN0aW9uIChyZWFkLCBzaXplKSB7XG4gIHZhciBlbmRlZDsgc2l6ZSA9IHNpemUgfHwgNVxuICB2YXIgcXVldWUgPSBbXVxuXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIC8vdGhpcyBtZWFucyB0aGF0IHRoZSB1cHN0cmVhbSBpcyBzZW5kaW5nIGFuIGVycm9yLlxuICAgIGlmKGVuZCkgcmV0dXJuIHJlYWQoZW5kZWQgPSBlbmQsIGNiKVxuICAgIC8vdGhpcyBtZWFucyB0aGF0IHdlIHJlYWQgYW4gZW5kIGJlZm9yZS5cbiAgICBpZihlbmRlZCkgcmV0dXJuIGNiKGVuZGVkKVxuXG4gICAgcmVhZChudWxsLCBmdW5jdGlvbiBuZXh0KGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kZWQgPSBlbmRlZCB8fCBlbmQpIHtcbiAgICAgICAgaWYoIXF1ZXVlLmxlbmd0aClcbiAgICAgICAgICByZXR1cm4gY2IoZW5kZWQpXG5cbiAgICAgICAgdmFyIF9xdWV1ZSA9IHF1ZXVlOyBxdWV1ZSA9IFtdXG4gICAgICAgIHJldHVybiBjYihudWxsLCBfcXVldWUpXG4gICAgICB9XG4gICAgICBxdWV1ZS5wdXNoKGRhdGEpXG4gICAgICBpZihxdWV1ZS5sZW5ndGggPCBzaXplKVxuICAgICAgICByZXR1cm4gcmVhZChudWxsLCBuZXh0KVxuXG4gICAgICB2YXIgX3F1ZXVlID0gcXVldWU7IHF1ZXVlID0gW11cbiAgICAgIGNiKG51bGwsIF9xdWV1ZSlcbiAgICB9KVxuICB9XG59XG5cbnZhciBmbGF0dGVuID0gZXhwb3J0cy5mbGF0dGVuID0gZnVuY3Rpb24gKHJlYWQpIHtcbiAgdmFyIF9yZWFkXG4gIHJldHVybiBmdW5jdGlvbiAoYWJvcnQsIGNiKSB7XG4gICAgaWYoX3JlYWQpIG5leHRDaHVuaygpXG4gICAgZWxzZSAgICAgIG5leHRTdHJlYW0oKVxuXG4gICAgZnVuY3Rpb24gbmV4dENodW5rICgpIHtcbiAgICAgIF9yZWFkKG51bGwsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgICAgaWYoZW5kKSBuZXh0U3RyZWFtKClcbiAgICAgICAgZWxzZSAgICBjYihudWxsLCBkYXRhKVxuICAgICAgfSlcbiAgICB9XG4gICAgZnVuY3Rpb24gbmV4dFN0cmVhbSAoKSB7XG4gICAgICByZWFkKG51bGwsIGZ1bmN0aW9uIChlbmQsIHN0cmVhbSkge1xuICAgICAgICBpZihlbmQpXG4gICAgICAgICAgcmV0dXJuIGNiKGVuZClcbiAgICAgICAgaWYoQXJyYXkuaXNBcnJheShzdHJlYW0pIHx8IHN0cmVhbSAmJiAnb2JqZWN0JyA9PT0gdHlwZW9mIHN0cmVhbSlcbiAgICAgICAgICBzdHJlYW0gPSBzb3VyY2VzLnZhbHVlcyhzdHJlYW0pXG4gICAgICAgIGVsc2UgaWYoJ2Z1bmN0aW9uJyAhPSB0eXBlb2Ygc3RyZWFtKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcignZXhwZWN0ZWQgc3RyZWFtIG9mIHN0cmVhbXMnKVxuICAgICAgICBfcmVhZCA9IHN0cmVhbVxuICAgICAgICBuZXh0Q2h1bmsoKVxuICAgICAgfSlcbiAgICB9XG4gIH1cbn1cblxudmFyIHByZXBlbmQgPVxuZXhwb3J0cy5wcmVwZW5kID1cbmZ1bmN0aW9uIChyZWFkLCBoZWFkKSB7XG5cbiAgcmV0dXJuIGZ1bmN0aW9uIChhYm9ydCwgY2IpIHtcbiAgICBpZihoZWFkICE9PSBudWxsKSB7XG4gICAgICBpZihhYm9ydClcbiAgICAgICAgcmV0dXJuIHJlYWQoYWJvcnQsIGNiKVxuICAgICAgdmFyIF9oZWFkID0gaGVhZFxuICAgICAgaGVhZCA9IG51bGxcbiAgICAgIGNiKG51bGwsIF9oZWFkKVxuICAgIH0gZWxzZSB7XG4gICAgICByZWFkKGFib3J0LCBjYilcbiAgICB9XG4gIH1cblxufVxuXG4vL3ZhciBkcmFpbklmID0gZXhwb3J0cy5kcmFpbklmID0gZnVuY3Rpb24gKG9wLCBkb25lKSB7XG4vLyAgc2lua3MuZHJhaW4oXG4vL31cblxudmFyIF9yZWR1Y2UgPSBleHBvcnRzLl9yZWR1Y2UgPSBmdW5jdGlvbiAocmVhZCwgcmVkdWNlLCBpbml0aWFsKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoY2xvc2UsIGNiKSB7XG4gICAgaWYoY2xvc2UpIHJldHVybiByZWFkKGNsb3NlLCBjYilcbiAgICBpZihlbmRlZCkgcmV0dXJuIGNiKGVuZGVkKVxuXG4gICAgc2lua3MuZHJhaW4oZnVuY3Rpb24gKGl0ZW0pIHtcbiAgICAgIGluaXRpYWwgPSByZWR1Y2UoaW5pdGlhbCwgaXRlbSlcbiAgICB9LCBmdW5jdGlvbiAoZXJyLCBkYXRhKSB7XG4gICAgICBlbmRlZCA9IGVyciB8fCB0cnVlXG4gICAgICBpZighZXJyKSBjYihudWxsLCBpbml0aWFsKVxuICAgICAgZWxzZSAgICAgY2IoZW5kZWQpXG4gICAgfSlcbiAgICAocmVhZClcbiAgfVxufVxuXG52YXIgbmV4dFRpY2sgPSBwcm9jZXNzLm5leHRUaWNrXG5cbnZhciBoaWdoV2F0ZXJNYXJrID0gZXhwb3J0cy5oaWdoV2F0ZXJNYXJrID1cbmZ1bmN0aW9uIChyZWFkLCBoaWdoV2F0ZXJNYXJrKSB7XG4gIHZhciBidWZmZXIgPSBbXSwgd2FpdGluZyA9IFtdLCBlbmRlZCwgZW5kaW5nLCByZWFkaW5nID0gZmFsc2VcbiAgaGlnaFdhdGVyTWFyayA9IGhpZ2hXYXRlck1hcmsgfHwgMTBcblxuICBmdW5jdGlvbiByZWFkQWhlYWQgKCkge1xuICAgIHdoaWxlKHdhaXRpbmcubGVuZ3RoICYmIChidWZmZXIubGVuZ3RoIHx8IGVuZGVkKSlcbiAgICAgIHdhaXRpbmcuc2hpZnQoKShlbmRlZCwgZW5kZWQgPyBudWxsIDogYnVmZmVyLnNoaWZ0KCkpXG5cbiAgICBpZiAoIWJ1ZmZlci5sZW5ndGggJiYgZW5kaW5nKSBlbmRlZCA9IGVuZGluZztcbiAgfVxuXG4gIGZ1bmN0aW9uIG5leHQgKCkge1xuICAgIGlmKGVuZGVkIHx8IGVuZGluZyB8fCByZWFkaW5nIHx8IGJ1ZmZlci5sZW5ndGggPj0gaGlnaFdhdGVyTWFyaylcbiAgICAgIHJldHVyblxuICAgIHJlYWRpbmcgPSB0cnVlXG4gICAgcmV0dXJuIHJlYWQoZW5kZWQgfHwgZW5kaW5nLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICByZWFkaW5nID0gZmFsc2VcbiAgICAgIGVuZGluZyA9IGVuZGluZyB8fCBlbmRcbiAgICAgIGlmKGRhdGEgIT0gbnVsbCkgYnVmZmVyLnB1c2goZGF0YSlcblxuICAgICAgbmV4dCgpOyByZWFkQWhlYWQoKVxuICAgIH0pXG4gIH1cblxuICBwcm9jZXNzLm5leHRUaWNrKG5leHQpXG5cbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgZW5kZWQgPSBlbmRlZCB8fCBlbmRcbiAgICB3YWl0aW5nLnB1c2goY2IpXG5cbiAgICBuZXh0KCk7IHJlYWRBaGVhZCgpXG4gIH1cbn1cblxudmFyIGZsYXRNYXAgPSBleHBvcnRzLmZsYXRNYXAgPVxuZnVuY3Rpb24gKHJlYWQsIG1hcHBlcikge1xuICBtYXBwZXIgPSBtYXBwZXIgfHwgaWRcbiAgdmFyIHF1ZXVlID0gW10sIGVuZGVkXG5cbiAgcmV0dXJuIGZ1bmN0aW9uIChhYm9ydCwgY2IpIHtcbiAgICBpZihxdWV1ZS5sZW5ndGgpIHJldHVybiBjYihudWxsLCBxdWV1ZS5zaGlmdCgpKVxuICAgIGVsc2UgaWYoZW5kZWQpICAgcmV0dXJuIGNiKGVuZGVkKVxuXG4gICAgcmVhZChhYm9ydCwgZnVuY3Rpb24gbmV4dCAoZW5kLCBkYXRhKSB7XG4gICAgICBpZihlbmQpIGVuZGVkID0gZW5kXG4gICAgICBlbHNlIHtcbiAgICAgICAgdmFyIGFkZCA9IG1hcHBlcihkYXRhKVxuICAgICAgICB3aGlsZShhZGQgJiYgYWRkLmxlbmd0aClcbiAgICAgICAgICBxdWV1ZS5wdXNoKGFkZC5zaGlmdCgpKVxuICAgICAgfVxuXG4gICAgICBpZihxdWV1ZS5sZW5ndGgpIGNiKG51bGwsIHF1ZXVlLnNoaWZ0KCkpXG4gICAgICBlbHNlIGlmKGVuZGVkKSAgIGNiKGVuZGVkKVxuICAgICAgZWxzZSAgICAgICAgICAgICByZWFkKG51bGwsIG5leHQpXG4gICAgfSlcbiAgfVxufVxuXG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG52YXIganNvbnBhcnNlID0gcmVxdWlyZSgnY29nL2pzb25wYXJzZScpO1xuXG4vKipcbiAgIyMjIHNpZ25hbGxlciBwcm9jZXNzIGhhbmRsaW5nXG5cbiAgV2hlbiBhIHNpZ25hbGxlcidzIHVuZGVybGluZyBtZXNzZW5nZXIgZW1pdHMgYSBgZGF0YWAgZXZlbnQgdGhpcyBpc1xuICBkZWxlZ2F0ZWQgdG8gYSBzaW1wbGUgbWVzc2FnZSBwYXJzZXIsIHdoaWNoIGFwcGxpZXMgdGhlIGZvbGxvd2luZyBzaW1wbGVcbiAgbG9naWM6XG5cbiAgLSBJcyB0aGUgbWVzc2FnZSBhIGAvdG9gIG1lc3NhZ2UuIElmIHNvLCBzZWUgaWYgdGhlIG1lc3NhZ2UgaXMgZm9yIHRoaXNcbiAgICBzaWduYWxsZXIgKGNoZWNraW5nIHRoZSB0YXJnZXQgaWQgLSAybmQgYXJnKS4gIElmIHNvIHBhc3MgdGhlXG4gICAgcmVtYWluZGVyIG9mIHRoZSBtZXNzYWdlIG9udG8gdGhlIHN0YW5kYXJkIHByb2Nlc3NpbmcgY2hhaW4uICBJZiBub3QsXG4gICAgZGlzY2FyZCB0aGUgbWVzc2FnZS5cblxuICAtIElzIHRoZSBtZXNzYWdlIGEgY29tbWFuZCBtZXNzYWdlIChwcmVmaXhlZCB3aXRoIGEgZm9yd2FyZCBzbGFzaCkuIElmIHNvLFxuICAgIGxvb2sgZm9yIGFuIGFwcHJvcHJpYXRlIG1lc3NhZ2UgaGFuZGxlciBhbmQgcGFzcyB0aGUgbWVzc2FnZSBwYXlsb2FkIG9uXG4gICAgdG8gaXQuXG5cbiAgLSBGaW5hbGx5LCBkb2VzIHRoZSBtZXNzYWdlIG1hdGNoIGFueSBwYXR0ZXJucyB0aGF0IHdlIGFyZSBsaXN0ZW5pbmcgZm9yP1xuICAgIElmIHNvLCB0aGVuIHBhc3MgdGhlIGVudGlyZSBtZXNzYWdlIGNvbnRlbnRzIG9udG8gdGhlIHJlZ2lzdGVyZWQgaGFuZGxlci5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihzaWduYWxsZXIsIG9wdHMpIHtcbiAgdmFyIGhhbmRsZXJzID0gcmVxdWlyZSgnLi9oYW5kbGVycycpKHNpZ25hbGxlciwgb3B0cyk7XG5cbiAgZnVuY3Rpb24gc2VuZEV2ZW50KHBhcnRzLCBzcmNTdGF0ZSwgZGF0YSkge1xuICAgIC8vIGluaXRpYWxpc2UgdGhlIGV2ZW50IG5hbWVcbiAgICB2YXIgZXZ0TmFtZSA9ICdtZXNzYWdlOicgKyBwYXJ0c1swXS5zbGljZSgxKTtcblxuICAgIC8vIGNvbnZlcnQgYW55IHZhbGlkIGpzb24gb2JqZWN0cyB0byBqc29uXG4gICAgdmFyIGFyZ3MgPSBwYXJ0cy5zbGljZSgyKS5tYXAoanNvbnBhcnNlKTtcblxuICAgIHNpZ25hbGxlci5hcHBseShcbiAgICAgIHNpZ25hbGxlcixcbiAgICAgIFtldnROYW1lXS5jb25jYXQoYXJncykuY29uY2F0KFtzcmNTdGF0ZSwgZGF0YV0pXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiBmdW5jdGlvbihvcmlnaW5hbERhdGEpIHtcbiAgICB2YXIgZGF0YSA9IG9yaWdpbmFsRGF0YTtcbiAgICB2YXIgaXNNYXRjaCA9IHRydWU7XG4gICAgdmFyIHBhcnRzO1xuICAgIHZhciBoYW5kbGVyO1xuICAgIHZhciBzcmNEYXRhO1xuICAgIHZhciBzcmNTdGF0ZTtcbiAgICB2YXIgaXNEaXJlY3RNZXNzYWdlID0gZmFsc2U7XG5cbiAgICAvLyBkaXNjYXJkIHByaW11cyBtZXNzYWdlc1xuICAgIGlmIChkYXRhICYmIGRhdGEuc2xpY2UoMCwgNikgPT09ICdwcmltdXMnKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gZm9yY2UgdGhlIGlkIGludG8gc3RyaW5nIGZvcm1hdCBzbyB3ZSBjYW4gcnVuIGxlbmd0aCBhbmQgY29tcGFyaXNvbiB0ZXN0cyBvbiBpdFxuICAgIHZhciBpZCA9IHNpZ25hbGxlci5pZCArICcnO1xuXG4gICAgLy8gcHJvY2VzcyAvdG8gbWVzc2FnZXNcbiAgICBpZiAoZGF0YS5zbGljZSgwLCAzKSA9PT0gJy90bycpIHtcbiAgICAgIGlzTWF0Y2ggPSBkYXRhLnNsaWNlKDQsIGlkLmxlbmd0aCArIDQpID09PSBpZDtcbiAgICAgIGlmIChpc01hdGNoKSB7XG4gICAgICAgIHBhcnRzID0gZGF0YS5zbGljZSg1ICsgaWQubGVuZ3RoKS5zcGxpdCgnfCcpLm1hcChqc29ucGFyc2UpO1xuXG4gICAgICAgIC8vIGdldCB0aGUgc291cmNlIGRhdGFcbiAgICAgICAgaXNEaXJlY3RNZXNzYWdlID0gdHJ1ZTtcblxuICAgICAgICAvLyBleHRyYWN0IHRoZSB2ZWN0b3IgY2xvY2sgYW5kIHVwZGF0ZSB0aGUgcGFydHNcbiAgICAgICAgcGFydHMgPSBwYXJ0cy5tYXAoanNvbnBhcnNlKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBpZiB0aGlzIGlzIG5vdCBhIG1hdGNoLCB0aGVuIGJhaWxcbiAgICBpZiAoISBpc01hdGNoKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gY2hvcCB0aGUgZGF0YSBpbnRvIHBhcnRzXG4gICAgc2lnbmFsbGVyKCdyYXdkYXRhJywgZGF0YSk7XG4gICAgcGFydHMgPSBwYXJ0cyB8fCBkYXRhLnNwbGl0KCd8JykubWFwKGpzb25wYXJzZSk7XG5cbiAgICAvLyBpZiB3ZSBoYXZlIGEgc3BlY2lmaWMgaGFuZGxlciBmb3IgdGhlIGFjdGlvbiwgdGhlbiBpbnZva2VcbiAgICBpZiAodHlwZW9mIHBhcnRzWzBdID09ICdzdHJpbmcnKSB7XG4gICAgICAvLyBleHRyYWN0IHRoZSBtZXRhZGF0YSBmcm9tIHRoZSBpbnB1dCBkYXRhXG4gICAgICBzcmNEYXRhID0gcGFydHNbMV07XG5cbiAgICAgIC8vIGlmIHdlIGdvdCBkYXRhIGZyb20gb3Vyc2VsZiwgdGhlbiB0aGlzIGlzIHByZXR0eSBkdW1iXG4gICAgICAvLyBidXQgaWYgd2UgaGF2ZSB0aGVuIHRocm93IGl0IGF3YXlcbiAgICAgIGlmIChzcmNEYXRhICYmIHNyY0RhdGEuaWQgPT09IHNpZ25hbGxlci5pZCkge1xuICAgICAgICByZXR1cm4gY29uc29sZS53YXJuKCdnb3QgZGF0YSBmcm9tIG91cnNlbGYsIGRpc2NhcmRpbmcnKTtcbiAgICAgIH1cblxuICAgICAgLy8gZ2V0IHRoZSBzb3VyY2Ugc3RhdGVcbiAgICAgIHNyY1N0YXRlID0gc2lnbmFsbGVyLnBlZXJzLmdldChzcmNEYXRhICYmIHNyY0RhdGEuaWQpIHx8IHNyY0RhdGE7XG5cbiAgICAgIC8vIGhhbmRsZSBjb21tYW5kc1xuICAgICAgaWYgKHBhcnRzWzBdLmNoYXJBdCgwKSA9PT0gJy8nKSB7XG4gICAgICAgIC8vIGxvb2sgZm9yIGEgaGFuZGxlciBmb3IgdGhlIG1lc3NhZ2UgdHlwZVxuICAgICAgICBoYW5kbGVyID0gaGFuZGxlcnNbcGFydHNbMF0uc2xpY2UoMSldO1xuXG4gICAgICAgIGlmICh0eXBlb2YgaGFuZGxlciA9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgaGFuZGxlcihcbiAgICAgICAgICAgIHBhcnRzLnNsaWNlKDIpLFxuICAgICAgICAgICAgcGFydHNbMF0uc2xpY2UoMSksXG4gICAgICAgICAgICBzcmNEYXRhLFxuICAgICAgICAgICAgc3JjU3RhdGUsXG4gICAgICAgICAgICBpc0RpcmVjdE1lc3NhZ2VcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIHNlbmRFdmVudChwYXJ0cywgc3JjU3RhdGUsIG9yaWdpbmFsRGF0YSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIG90aGVyd2lzZSwgZW1pdCBkYXRhXG4gICAgICBlbHNlIHtcbiAgICAgICAgc2lnbmFsbGVyKFxuICAgICAgICAgICdkYXRhJyxcbiAgICAgICAgICBwYXJ0cy5zbGljZSgwLCAxKS5jb25jYXQocGFydHMuc2xpY2UoMikpLFxuICAgICAgICAgIHNyY0RhdGEsXG4gICAgICAgICAgc3JjU3RhdGUsXG4gICAgICAgICAgaXNEaXJlY3RNZXNzYWdlXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9O1xufTtcbiIsInZhciBleHRlbmQgPSByZXF1aXJlKCdjb2cvZXh0ZW5kJyk7XG5cbi8qKlxuICAjIHJ0Yy1zd2l0Y2hib2FyZC1tZXNzZW5nZXJcblxuICBBIHNwZWNpYWxpc2VkIHZlcnNpb24gb2ZcbiAgW2BtZXNzZW5nZXItd3NgXShodHRwczovL2dpdGh1Yi5jb20vRGFtb25PZWhsbWFuL21lc3Nlbmdlci13cykgZGVzaWduZWQgdG9cbiAgY29ubmVjdCB0byBbYHJ0Yy1zd2l0Y2hib2FyZGBdKGh0dHA6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMtc3dpdGNoYm9hcmQpXG4gIGluc3RhbmNlcy5cblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHN3aXRjaGJvYXJkLCBvcHRzKSB7XG4gIHJldHVybiByZXF1aXJlKCdtZXNzZW5nZXItd3MnKShzd2l0Y2hib2FyZCwgZXh0ZW5kKHtcbiAgICBlbmRwb2ludHM6IFsnL3ByaW11cycsICcvJ11cbiAgfSwgb3B0cykpO1xufTtcbiIsInZhciBXZWJTb2NrZXQgPSByZXF1aXJlKCd3cycpO1xudmFyIHdzdXJsID0gcmVxdWlyZSgnd3N1cmwnKTtcbnZhciBwcyA9IHJlcXVpcmUoJ3B1bGwtd3MnKTtcbnZhciBkZWZhdWx0cyA9IHJlcXVpcmUoJ2NvZy9kZWZhdWx0cycpO1xudmFyIHJlVHJhaWxpbmdTbGFzaCA9IC9cXC8kLztcblxuLyoqXG4gICMgbWVzc2VuZ2VyLXdzXG5cbiAgVGhpcyBpcyBhIHNpbXBsZSBtZXNzYWdpbmcgaW1wbGVtZW50YXRpb24gZm9yIHNlbmRpbmcgYW5kIHJlY2VpdmluZyBkYXRhXG4gIHZpYSB3ZWJzb2NrZXRzLlxuXG4gIEZvbGxvd3MgdGhlIFttZXNzZW5nZXItYXJjaGV0eXBlXShodHRwczovL2dpdGh1Yi5jb20vRGFtb25PZWhsbWFuL21lc3Nlbmdlci1hcmNoZXR5cGUpXG5cbiAgIyMgRXhhbXBsZSBVc2FnZVxuXG4gIDw8PCBleGFtcGxlcy9zaW1wbGUuanNcblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHVybCwgb3B0cykge1xuICB2YXIgdGltZW91dCA9IChvcHRzIHx8IHt9KS50aW1lb3V0IHx8IDEwMDA7XG4gIHZhciBlbmRwb2ludHMgPSAoKG9wdHMgfHwge30pLmVuZHBvaW50cyB8fCBbJy8nXSkubWFwKGZ1bmN0aW9uKGVuZHBvaW50KSB7XG4gICAgcmV0dXJuIHVybC5yZXBsYWNlKHJlVHJhaWxpbmdTbGFzaCwgJycpICsgZW5kcG9pbnQ7XG4gIH0pO1xuXG4gIGZ1bmN0aW9uIGNvbm5lY3QoY2FsbGJhY2spIHtcbiAgICB2YXIgcXVldWUgPSBbXS5jb25jYXQoZW5kcG9pbnRzKTtcbiAgICB2YXIgcmVjZWl2ZWREYXRhID0gZmFsc2U7XG4gICAgdmFyIGZhaWxUaW1lcjtcbiAgICB2YXIgc3VjY2Vzc1RpbWVyO1xuXG4gICAgZnVuY3Rpb24gYXR0ZW1wdE5leHQoKSB7XG4gICAgICB2YXIgc29ja2V0O1xuXG4gICAgICBmdW5jdGlvbiByZWdpc3Rlck1lc3NhZ2UoZXZ0KSB7XG4gICAgICAgIHJlY2VpdmVkRGF0YSA9IHRydWU7XG4gICAgICAgIChzb2NrZXQucmVtb3ZlRXZlbnRMaXN0ZW5lciB8fCBzb2NrZXQucmVtb3ZlTGlzdGVuZXIpKCdtZXNzYWdlJywgcmVnaXN0ZXJNZXNzYWdlKTtcbiAgICAgIH1cblxuICAgICAgLy8gaWYgd2UgaGF2ZSBubyBtb3JlIHZhbGlkIGVuZHBvaW50cywgdGhlbiBlcm9yciBvdXRcbiAgICAgIGlmIChxdWV1ZS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgcmV0dXJuIGNhbGxiYWNrKG5ldyBFcnJvcignVW5hYmxlIHRvIGNvbm5lY3QgdG8gdXJsOiAnICsgdXJsKSk7XG4gICAgICB9XG5cbiAgICAgIHNvY2tldCA9IG5ldyBXZWJTb2NrZXQod3N1cmwocXVldWUuc2hpZnQoKSkpO1xuICAgICAgc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgaGFuZGxlRXJyb3IpO1xuICAgICAgc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2Nsb3NlJywgaGFuZGxlQWJub3JtYWxDbG9zZSk7XG4gICAgICBzb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignb3BlbicsIGZ1bmN0aW9uKCkge1xuICAgICAgICAvLyBjcmVhdGUgdGhlIHNvdXJjZSBpbW1lZGlhdGVseSB0byBidWZmZXIgYW55IGRhdGFcbiAgICAgICAgdmFyIHNvdXJjZSA9IHBzLnNvdXJjZShzb2NrZXQsIG9wdHMpO1xuXG4gICAgICAgIC8vIG1vbml0b3IgZGF0YSBmbG93aW5nIGZyb20gdGhlIHNvY2tldFxuICAgICAgICBzb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignbWVzc2FnZScsIHJlZ2lzdGVyTWVzc2FnZSk7XG5cbiAgICAgICAgc3VjY2Vzc1RpbWVyID0gc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgICBjbGVhclRpbWVvdXQoZmFpbFRpbWVyKTtcbiAgICAgICAgICBjYWxsYmFjayhudWxsLCBzb3VyY2UsIHBzLnNpbmsoc29ja2V0LCBvcHRzKSk7XG4gICAgICAgIH0sIDEwMCk7XG4gICAgICB9KTtcblxuICAgICAgZmFpbFRpbWVyID0gc2V0VGltZW91dChhdHRlbXB0TmV4dCwgdGltZW91dCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gaGFuZGxlQWJub3JtYWxDbG9zZShldnQpIHtcbiAgICAgIC8vIGlmIHRoaXMgd2FzIGEgY2xlYW4gY2xvc2UgZG8gbm90aGluZ1xuICAgICAgaWYgKGV2dC53YXNDbGVhbiAmJiByZWNlaXZlZERhdGEgJiYgcXVldWUubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGhhbmRsZUVycm9yKCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gaGFuZGxlRXJyb3IoKSB7XG4gICAgICBjbGVhclRpbWVvdXQoc3VjY2Vzc1RpbWVyKTtcbiAgICAgIGNsZWFyVGltZW91dChmYWlsVGltZXIpO1xuICAgICAgYXR0ZW1wdE5leHQoKTtcbiAgICB9XG5cbiAgICBhdHRlbXB0TmV4dCgpO1xuICB9XG5cbiAgcmV0dXJuIGNvbm5lY3Q7XG59O1xuIiwiZXhwb3J0cyA9IG1vZHVsZS5leHBvcnRzID0gZHVwbGV4O1xuXG5leHBvcnRzLnNvdXJjZSA9IHJlcXVpcmUoJy4vc291cmNlJyk7XG5leHBvcnRzLnNpbmsgPSByZXF1aXJlKCcuL3NpbmsnKTtcblxuZnVuY3Rpb24gZHVwbGV4ICh3cywgb3B0cykge1xuICByZXR1cm4ge1xuICAgIHNvdXJjZTogZXhwb3J0cy5zb3VyY2Uod3MpLFxuICAgIHNpbms6IGV4cG9ydHMuc2luayh3cywgb3B0cylcbiAgfTtcbn07XG4iLCJleHBvcnRzLmlkID0gXG5mdW5jdGlvbiAoaXRlbSkge1xuICByZXR1cm4gaXRlbVxufVxuXG5leHBvcnRzLnByb3AgPSBcbmZ1bmN0aW9uIChtYXApIHsgIFxuICBpZignc3RyaW5nJyA9PSB0eXBlb2YgbWFwKSB7XG4gICAgdmFyIGtleSA9IG1hcFxuICAgIHJldHVybiBmdW5jdGlvbiAoZGF0YSkgeyByZXR1cm4gZGF0YVtrZXldIH1cbiAgfVxuICByZXR1cm4gbWFwXG59XG5cbmV4cG9ydHMudGVzdGVyID0gZnVuY3Rpb24gKHRlc3QpIHtcbiAgaWYoIXRlc3QpIHJldHVybiBleHBvcnRzLmlkXG4gIGlmKCdvYmplY3QnID09PSB0eXBlb2YgdGVzdFxuICAgICYmICdmdW5jdGlvbicgPT09IHR5cGVvZiB0ZXN0LnRlc3QpXG4gICAgICByZXR1cm4gdGVzdC50ZXN0LmJpbmQodGVzdClcbiAgcmV0dXJuIGV4cG9ydHMucHJvcCh0ZXN0KSB8fCBleHBvcnRzLmlkXG59XG5cbmV4cG9ydHMuYWRkUGlwZSA9IGFkZFBpcGVcblxuZnVuY3Rpb24gYWRkUGlwZShyZWFkKSB7XG4gIGlmKCdmdW5jdGlvbicgIT09IHR5cGVvZiByZWFkKVxuICAgIHJldHVybiByZWFkXG5cbiAgcmVhZC5waXBlID0gcmVhZC5waXBlIHx8IGZ1bmN0aW9uIChyZWFkZXIpIHtcbiAgICBpZignZnVuY3Rpb24nICE9IHR5cGVvZiByZWFkZXIgJiYgJ2Z1bmN0aW9uJyAhPSB0eXBlb2YgcmVhZGVyLnNpbmspXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ211c3QgcGlwZSB0byByZWFkZXInKVxuICAgIHZhciBwaXBlID0gYWRkUGlwZShyZWFkZXIuc2luayA/IHJlYWRlci5zaW5rKHJlYWQpIDogcmVhZGVyKHJlYWQpKVxuICAgIHJldHVybiByZWFkZXIuc291cmNlIHx8IHBpcGU7XG4gIH1cbiAgXG4gIHJlYWQudHlwZSA9ICdTb3VyY2UnXG4gIHJldHVybiByZWFkXG59XG5cbnZhciBTb3VyY2UgPVxuZXhwb3J0cy5Tb3VyY2UgPVxuZnVuY3Rpb24gU291cmNlIChjcmVhdGVSZWFkKSB7XG4gIGZ1bmN0aW9uIHMoKSB7XG4gICAgdmFyIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cylcbiAgICByZXR1cm4gYWRkUGlwZShjcmVhdGVSZWFkLmFwcGx5KG51bGwsIGFyZ3MpKVxuICB9XG4gIHMudHlwZSA9ICdTb3VyY2UnXG4gIHJldHVybiBzXG59XG5cblxudmFyIFRocm91Z2ggPVxuZXhwb3J0cy5UaHJvdWdoID0gXG5mdW5jdGlvbiAoY3JlYXRlUmVhZCkge1xuICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpXG4gICAgdmFyIHBpcGVkID0gW11cbiAgICBmdW5jdGlvbiByZWFkZXIgKHJlYWQpIHtcbiAgICAgIGFyZ3MudW5zaGlmdChyZWFkKVxuICAgICAgcmVhZCA9IGNyZWF0ZVJlYWQuYXBwbHkobnVsbCwgYXJncylcbiAgICAgIHdoaWxlKHBpcGVkLmxlbmd0aClcbiAgICAgICAgcmVhZCA9IHBpcGVkLnNoaWZ0KCkocmVhZClcbiAgICAgIHJldHVybiByZWFkXG4gICAgICAvL3BpcGVpbmcgdG8gZnJvbSB0aGlzIHJlYWRlciBzaG91bGQgY29tcG9zZS4uLlxuICAgIH1cbiAgICByZWFkZXIucGlwZSA9IGZ1bmN0aW9uIChyZWFkKSB7XG4gICAgICBwaXBlZC5wdXNoKHJlYWQpIFxuICAgICAgaWYocmVhZC50eXBlID09PSAnU291cmNlJylcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdjYW5ub3QgcGlwZSAnICsgcmVhZGVyLnR5cGUgKyAnIHRvIFNvdXJjZScpXG4gICAgICByZWFkZXIudHlwZSA9IHJlYWQudHlwZSA9PT0gJ1NpbmsnID8gJ1NpbmsnIDogJ1Rocm91Z2gnXG4gICAgICByZXR1cm4gcmVhZGVyXG4gICAgfVxuICAgIHJlYWRlci50eXBlID0gJ1Rocm91Z2gnXG4gICAgcmV0dXJuIHJlYWRlclxuICB9XG59XG5cbnZhciBTaW5rID1cbmV4cG9ydHMuU2luayA9IFxuZnVuY3Rpb24gU2luayhjcmVhdGVSZWFkZXIpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKVxuICAgIGlmKCFjcmVhdGVSZWFkZXIpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ211c3QgYmUgY3JlYXRlUmVhZGVyIGZ1bmN0aW9uJylcbiAgICBmdW5jdGlvbiBzIChyZWFkKSB7XG4gICAgICBhcmdzLnVuc2hpZnQocmVhZClcbiAgICAgIHJldHVybiBjcmVhdGVSZWFkZXIuYXBwbHkobnVsbCwgYXJncylcbiAgICB9XG4gICAgcy50eXBlID0gJ1NpbmsnXG4gICAgcmV0dXJuIHNcbiAgfVxufVxuXG5cbmV4cG9ydHMubWF5YmVTaW5rID0gXG5leHBvcnRzLm1heWJlRHJhaW4gPSBcbmZ1bmN0aW9uIChjcmVhdGVTaW5rLCBjYikge1xuICBpZighY2IpXG4gICAgcmV0dXJuIFRocm91Z2goZnVuY3Rpb24gKHJlYWQpIHtcbiAgICAgIHZhciBlbmRlZFxuICAgICAgcmV0dXJuIGZ1bmN0aW9uIChjbG9zZSwgY2IpIHtcbiAgICAgICAgaWYoY2xvc2UpIHJldHVybiByZWFkKGNsb3NlLCBjYilcbiAgICAgICAgaWYoZW5kZWQpIHJldHVybiBjYihlbmRlZClcblxuICAgICAgICBjcmVhdGVTaW5rKGZ1bmN0aW9uIChlcnIsIGRhdGEpIHtcbiAgICAgICAgICBlbmRlZCA9IGVyciB8fCB0cnVlXG4gICAgICAgICAgaWYoIWVycikgY2IobnVsbCwgZGF0YSlcbiAgICAgICAgICBlbHNlICAgICBjYihlbmRlZClcbiAgICAgICAgfSkgKHJlYWQpXG4gICAgICB9XG4gICAgfSkoKVxuXG4gIHJldHVybiBTaW5rKGZ1bmN0aW9uIChyZWFkKSB7XG4gICAgcmV0dXJuIGNyZWF0ZVNpbmsoY2IpIChyZWFkKVxuICB9KSgpXG59XG5cbiIsIm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oc29ja2V0LCBjYWxsYmFjaykge1xuICB2YXIgcmVtb3ZlID0gc29ja2V0ICYmIChzb2NrZXQucmVtb3ZlRXZlbnRMaXN0ZW5lciB8fCBzb2NrZXQucmVtb3ZlTGlzdGVuZXIpO1xuXG4gIGZ1bmN0aW9uIGNsZWFudXAgKCkge1xuICAgIGlmICh0eXBlb2YgcmVtb3ZlID09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJlbW92ZS5jYWxsKHNvY2tldCwgJ29wZW4nLCBoYW5kbGVPcGVuKTtcbiAgICAgIHJlbW92ZS5jYWxsKHNvY2tldCwgJ2Vycm9yJywgaGFuZGxlRXJyKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVPcGVuKGV2dCkge1xuICAgIGNsZWFudXAoKTsgY2FsbGJhY2soKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZUVyciAoZXZ0KSB7XG4gICAgY2xlYW51cCgpOyBjYWxsYmFjayhldnQpO1xuICB9XG5cbiAgLy8gaWYgdGhlIHNvY2tldCBpcyBjbG9zaW5nIG9yIGNsb3NlZCwgcmV0dXJuIGVuZFxuICBpZiAoc29ja2V0LnJlYWR5U3RhdGUgPj0gMikge1xuICAgIHJldHVybiBjYWxsYmFjayh0cnVlKTtcbiAgfVxuXG4gIC8vIGlmIG9wZW4sIHRyaWdnZXIgdGhlIGNhbGxiYWNrXG4gIGlmIChzb2NrZXQucmVhZHlTdGF0ZSA9PT0gMSkge1xuICAgIHJldHVybiBjYWxsYmFjaygpO1xuICB9XG5cbiAgc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ29wZW4nLCBoYW5kbGVPcGVuKTtcbiAgc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgaGFuZGxlRXJyKTtcbn07XG4iLCJ2YXIgcHVsbCA9IHJlcXVpcmUoJ3B1bGwtY29yZScpO1xudmFyIHJlYWR5ID0gcmVxdWlyZSgnLi9yZWFkeScpO1xuXG4vKipcbiAgIyMjIGBzaW5rKHNvY2tldCwgb3B0cz8pYFxuXG4gIENyZWF0ZSBhIHB1bGwtc3RyZWFtIGBTaW5rYCB0aGF0IHdpbGwgd3JpdGUgZGF0YSB0byB0aGUgYHNvY2tldGAuXG5cbiAgPDw8IGV4YW1wbGVzL3dyaXRlLmpzXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBwdWxsLlNpbmsoZnVuY3Rpb24ocmVhZCwgc29ja2V0LCBvcHRzKSB7XG4gIG9wdHMgPSBvcHRzIHx8IHt9XG4gIHZhciBjbG9zZU9uRW5kID0gb3B0cy5jbG9zZU9uRW5kICE9PSBmYWxzZTtcbiAgdmFyIG9uQ2xvc2UgPSAnZnVuY3Rpb24nID09PSB0eXBlb2Ygb3B0cyA/IG9wdHMgOiBvcHRzLm9uQ2xvc2U7XG5cbiAgZnVuY3Rpb24gbmV4dChlbmQsIGRhdGEpIHtcbiAgICAvLyBpZiB0aGUgc3RyZWFtIGhhcyBlbmRlZCwgc2ltcGx5IHJldHVyblxuICAgIGlmIChlbmQpIHtcbiAgICAgIGlmIChjbG9zZU9uRW5kICYmIHNvY2tldC5yZWFkeVN0YXRlIDw9IDEpIHtcbiAgICAgICAgaWYob25DbG9zZSlcbiAgICAgICAgICBzb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignY2xvc2UnLCBmdW5jdGlvbiAoZXYpIHtcbiAgICAgICAgICAgIGlmKGV2Lndhc0NsZWFuKSBvbkNsb3NlKClcbiAgICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgICB2YXIgZXJyID0gbmV3IEVycm9yKCd3cyBlcnJvcicpXG4gICAgICAgICAgICAgIGVyci5ldmVudCA9IGV2XG4gICAgICAgICAgICAgIG9uQ2xvc2UoZXJyKVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuXG4gICAgICAgIHNvY2tldC5jbG9zZSgpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gc29ja2V0IHJlYWR5P1xuICAgIHJlYWR5KHNvY2tldCwgZnVuY3Rpb24oZW5kKSB7XG4gICAgICBpZiAoZW5kKSB7XG4gICAgICAgIHJldHVybiByZWFkKGVuZCwgZnVuY3Rpb24gKCkge30pO1xuICAgICAgfVxuXG4gICAgICBzb2NrZXQuc2VuZChkYXRhKTtcbiAgICAgIHByb2Nlc3MubmV4dFRpY2soZnVuY3Rpb24oKSB7XG4gICAgICAgIHJlYWQobnVsbCwgbmV4dCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIHJlYWQobnVsbCwgbmV4dCk7XG59KTtcbiIsInZhciBwdWxsID0gcmVxdWlyZSgncHVsbC1jb3JlJyk7XG52YXIgcmVhZHkgPSByZXF1aXJlKCcuL3JlYWR5Jyk7XG5cbi8qKlxuICAjIyMgYHNvdXJjZShzb2NrZXQpYFxuXG4gIENyZWF0ZSBhIHB1bGwtc3RyZWFtIGBTb3VyY2VgIHRoYXQgd2lsbCByZWFkIGRhdGEgZnJvbSB0aGUgYHNvY2tldGAuXG5cbiAgPDw8IGV4YW1wbGVzL3JlYWQuanNcblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IHB1bGwuU291cmNlKGZ1bmN0aW9uKHNvY2tldCkge1xuICB2YXIgYnVmZmVyID0gW107XG4gIHZhciByZWNlaXZlcjtcbiAgdmFyIGVuZGVkO1xuXG4gIHNvY2tldC5hZGRFdmVudExpc3RlbmVyKCdtZXNzYWdlJywgZnVuY3Rpb24oZXZ0KSB7XG4gICAgaWYgKHJlY2VpdmVyKSB7XG4gICAgICByZXR1cm4gcmVjZWl2ZXIobnVsbCwgZXZ0LmRhdGEpO1xuICAgIH1cblxuICAgIGJ1ZmZlci5wdXNoKGV2dC5kYXRhKTtcbiAgfSk7XG5cbiAgc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2Nsb3NlJywgZnVuY3Rpb24oZXZ0KSB7XG4gICAgaWYgKGVuZGVkKSByZXR1cm47XG4gICAgaWYgKHJlY2VpdmVyKSB7XG4gICAgICByZXR1cm4gcmVjZWl2ZXIoZW5kZWQgPSB0cnVlKTtcbiAgICB9XG4gIH0pO1xuXG4gIHNvY2tldC5hZGRFdmVudExpc3RlbmVyKCdlcnJvcicsIGZ1bmN0aW9uIChldnQpIHtcbiAgICBpZiAoZW5kZWQpIHJldHVybjtcbiAgICBlbmRlZCA9IGV2dDtcbiAgICBpZiAocmVjZWl2ZXIpIHtcbiAgICAgIHJlY2VpdmVyKGVuZGVkKTtcbiAgICB9XG4gIH0pO1xuXG4gIGZ1bmN0aW9uIHJlYWQoYWJvcnQsIGNiKSB7XG4gICAgcmVjZWl2ZXIgPSBudWxsO1xuXG4gICAgLy9pZiBzdHJlYW0gaGFzIGFscmVhZHkgZW5kZWQuXG4gICAgaWYgKGVuZGVkKVxuICAgICAgcmV0dXJuIGNiKGVuZGVkKVxuXG4gICAgLy8gaWYgZW5kZWQsIGFib3J0XG4gICAgaWYgKGFib3J0KSB7XG4gICAgICAvL3RoaXMgd2lsbCBjYWxsYmFjayB3aGVuIHNvY2tldCBjbG9zZXNcbiAgICAgIHJlY2VpdmVyID0gY2JcbiAgICAgIHJldHVybiBzb2NrZXQuY2xvc2UoKVxuICAgIH1cblxuICAgIHJlYWR5KHNvY2tldCwgZnVuY3Rpb24oZW5kKSB7XG4gICAgICBpZiAoZW5kKSB7XG4gICAgICAgIHJldHVybiBjYihlbmRlZCA9IGVuZCk7XG4gICAgICB9XG5cbiAgICAgIC8vIHJlYWQgZnJvbSB0aGUgc29ja2V0XG4gICAgICBpZiAoZW5kZWQgJiYgZW5kZWQgIT09IHRydWUpIHtcbiAgICAgICAgcmV0dXJuIGNiKGVuZGVkKTtcbiAgICAgIH1cbiAgICAgIGVsc2UgaWYgKGJ1ZmZlci5sZW5ndGggPiAwKSB7XG4gICAgICAgIHJldHVybiBjYihudWxsLCBidWZmZXIuc2hpZnQoKSk7XG4gICAgICB9XG4gICAgICBlbHNlIGlmIChlbmRlZCkge1xuICAgICAgICByZXR1cm4gY2IodHJ1ZSk7XG4gICAgICB9XG5cbiAgICAgIHJlY2VpdmVyID0gY2I7XG4gICAgfSk7XG4gIH07XG5cbiAgcmV0dXJuIHJlYWQ7XG59KTtcbiIsIlxuLyoqXG4gKiBNb2R1bGUgZGVwZW5kZW5jaWVzLlxuICovXG5cbnZhciBnbG9iYWwgPSAoZnVuY3Rpb24oKSB7IHJldHVybiB0aGlzOyB9KSgpO1xuXG4vKipcbiAqIFdlYlNvY2tldCBjb25zdHJ1Y3Rvci5cbiAqL1xuXG52YXIgV2ViU29ja2V0ID0gZ2xvYmFsLldlYlNvY2tldCB8fCBnbG9iYWwuTW96V2ViU29ja2V0O1xuXG4vKipcbiAqIE1vZHVsZSBleHBvcnRzLlxuICovXG5cbm1vZHVsZS5leHBvcnRzID0gV2ViU29ja2V0ID8gd3MgOiBudWxsO1xuXG4vKipcbiAqIFdlYlNvY2tldCBjb25zdHJ1Y3Rvci5cbiAqXG4gKiBUaGUgdGhpcmQgYG9wdHNgIG9wdGlvbnMgb2JqZWN0IGdldHMgaWdub3JlZCBpbiB3ZWIgYnJvd3NlcnMsIHNpbmNlIGl0J3NcbiAqIG5vbi1zdGFuZGFyZCwgYW5kIHRocm93cyBhIFR5cGVFcnJvciBpZiBwYXNzZWQgdG8gdGhlIGNvbnN0cnVjdG9yLlxuICogU2VlOiBodHRwczovL2dpdGh1Yi5jb20vZWluYXJvcy93cy9pc3N1ZXMvMjI3XG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IHVyaVxuICogQHBhcmFtIHtBcnJheX0gcHJvdG9jb2xzIChvcHRpb25hbClcbiAqIEBwYXJhbSB7T2JqZWN0KSBvcHRzIChvcHRpb25hbClcbiAqIEBhcGkgcHVibGljXG4gKi9cblxuZnVuY3Rpb24gd3ModXJpLCBwcm90b2NvbHMsIG9wdHMpIHtcbiAgdmFyIGluc3RhbmNlO1xuICBpZiAocHJvdG9jb2xzKSB7XG4gICAgaW5zdGFuY2UgPSBuZXcgV2ViU29ja2V0KHVyaSwgcHJvdG9jb2xzKTtcbiAgfSBlbHNlIHtcbiAgICBpbnN0YW5jZSA9IG5ldyBXZWJTb2NrZXQodXJpKTtcbiAgfVxuICByZXR1cm4gaW5zdGFuY2U7XG59XG5cbmlmIChXZWJTb2NrZXQpIHdzLnByb3RvdHlwZSA9IFdlYlNvY2tldC5wcm90b3R5cGU7XG4iLCJ2YXIgcmVIdHRwVXJsID0gL15odHRwKC4qKSQvO1xuXG4vKipcbiAgIyB3c3VybFxuXG4gIEdpdmVuIGEgdXJsIChpbmNsdWRpbmcgcHJvdG9jb2wgcmVsYXRpdmUgdXJscyAtIGkuZS4gYC8vYCksIGdlbmVyYXRlIGFuIGFwcHJvcHJpYXRlXG4gIHVybCBmb3IgYSBXZWJTb2NrZXQgZW5kcG9pbnQgKGB3c2Agb3IgYHdzc2ApLlxuXG4gICMjIEV4YW1wbGUgVXNhZ2VcblxuICA8PDwgZXhhbXBsZXMvcmVsYXRpdmUuanNcblxuKiovXG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24odXJsLCBvcHRzKSB7XG4gIHZhciBjdXJyZW50ID0gKG9wdHMgfHwge30pLmN1cnJlbnQgfHwgKHR5cGVvZiBsb2NhdGlvbiAhPSAndW5kZWZpbmVkJyAmJiBsb2NhdGlvbi5ocmVmKTtcbiAgdmFyIGN1cnJlbnRQcm90b2NvbCA9IGN1cnJlbnQgJiYgY3VycmVudC5zbGljZSgwLCBjdXJyZW50LmluZGV4T2YoJzonKSk7XG4gIHZhciBpbnNlY3VyZSA9IChvcHRzIHx8IHt9KS5pbnNlY3VyZTtcbiAgdmFyIGlzUmVsYXRpdmUgPSB1cmwuc2xpY2UoMCwgMikgPT0gJy8vJztcbiAgdmFyIGZvcmNlV1MgPSAoISBjdXJyZW50UHJvdG9jb2wpIHx8IGN1cnJlbnRQcm90b2NvbCA9PT0gJ2ZpbGU6JztcblxuICBpZiAoaXNSZWxhdGl2ZSkge1xuICAgIHJldHVybiBmb3JjZVdTID9cbiAgICAgICgoaW5zZWN1cmUgPyAnd3M6JyA6ICd3c3M6JykgKyB1cmwpIDpcbiAgICAgIChjdXJyZW50UHJvdG9jb2wucmVwbGFjZShyZUh0dHBVcmwsICd3cyQxJykgKyAnOicgKyB1cmwpO1xuICB9XG5cbiAgcmV0dXJuIHVybC5yZXBsYWNlKHJlSHR0cFVybCwgJ3dzJDEnKTtcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG52YXIgZGVidWcgPSByZXF1aXJlKCdjb2cvbG9nZ2VyJykoJ3J0Yy9jbGVhbnVwJyk7XG5cbnZhciBDQU5OT1RfQ0xPU0VfU1RBVEVTID0gW1xuICAnY2xvc2VkJ1xuXTtcblxudmFyIEVWRU5UU19ERUNPVVBMRV9CQyA9IFtcbiAgJ2FkZHN0cmVhbScsXG4gICdkYXRhY2hhbm5lbCcsXG4gICdpY2VjYW5kaWRhdGUnLFxuICAnbmVnb3RpYXRpb25uZWVkZWQnLFxuICAncmVtb3Zlc3RyZWFtJyxcbiAgJ3NpZ25hbGluZ3N0YXRlY2hhbmdlJ1xuXTtcblxudmFyIEVWRU5UU19ERUNPVVBMRV9BQyA9IFtcbiAgJ2ljZWNvbm5lY3Rpb25zdGF0ZWNoYW5nZSdcbl07XG5cbi8qKlxuICAjIyMgcnRjLXRvb2xzL2NsZWFudXBcblxuICBgYGBcbiAgY2xlYW51cChwYylcbiAgYGBgXG5cbiAgVGhlIGBjbGVhbnVwYCBmdW5jdGlvbiBpcyB1c2VkIHRvIGVuc3VyZSB0aGF0IGEgcGVlciBjb25uZWN0aW9uIGlzIHByb3Blcmx5XG4gIGNsb3NlZCBhbmQgcmVhZHkgdG8gYmUgY2xlYW5lZCB1cCBieSB0aGUgYnJvd3Nlci5cblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHBjKSB7XG4gIC8vIHNlZSBpZiB3ZSBjYW4gY2xvc2UgdGhlIGNvbm5lY3Rpb25cbiAgdmFyIGN1cnJlbnRTdGF0ZSA9IHBjLmljZUNvbm5lY3Rpb25TdGF0ZTtcbiAgdmFyIGNhbkNsb3NlID0gQ0FOTk9UX0NMT1NFX1NUQVRFUy5pbmRleE9mKGN1cnJlbnRTdGF0ZSkgPCAwO1xuXG4gIGZ1bmN0aW9uIGRlY291cGxlKGV2ZW50cykge1xuICAgIGV2ZW50cy5mb3JFYWNoKGZ1bmN0aW9uKGV2dE5hbWUpIHtcbiAgICAgIGlmIChwY1snb24nICsgZXZ0TmFtZV0pIHtcbiAgICAgICAgcGNbJ29uJyArIGV2dE5hbWVdID0gbnVsbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8vIGRlY291cGxlIFwiYmVmb3JlIGNsb3NlXCIgZXZlbnRzXG4gIGRlY291cGxlKEVWRU5UU19ERUNPVVBMRV9CQyk7XG5cbiAgaWYgKGNhbkNsb3NlKSB7XG4gICAgZGVidWcoJ2F0dGVtcHRpbmcgY29ubmVjdGlvbiBjbG9zZSwgY3VycmVudCBzdGF0ZTogJysgcGMuaWNlQ29ubmVjdGlvblN0YXRlKTtcbiAgICBwYy5jbG9zZSgpO1xuICB9XG5cbiAgLy8gcmVtb3ZlIHRoZSBldmVudCBsaXN0ZW5lcnNcbiAgLy8gYWZ0ZXIgYSBzaG9ydCBkZWxheSBnaXZpbmcgdGhlIGNvbm5lY3Rpb24gdGltZSB0byB0cmlnZ2VyXG4gIC8vIGNsb3NlIGFuZCBpY2Vjb25uZWN0aW9uc3RhdGVjaGFuZ2UgZXZlbnRzXG4gIHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgZGVjb3VwbGUoRVZFTlRTX0RFQ09VUExFX0FDKTtcbiAgfSwgMTAwKTtcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG52YXIgbWJ1cyA9IHJlcXVpcmUoJ21idXMnKTtcbnZhciBxdWV1ZSA9IHJlcXVpcmUoJ3J0Yy10YXNrcXVldWUnKTtcbnZhciBjbGVhbnVwID0gcmVxdWlyZSgnLi9jbGVhbnVwJyk7XG52YXIgbW9uaXRvciA9IHJlcXVpcmUoJy4vbW9uaXRvcicpO1xudmFyIHRocm90dGxlID0gcmVxdWlyZSgnY29nL3Rocm90dGxlJyk7XG52YXIgQ0xPU0VEX1NUQVRFUyA9IFsgJ2Nsb3NlZCcsICdmYWlsZWQnIF07XG52YXIgQ0hFQ0tJTkdfU1RBVEVTID0gWyAnY2hlY2tpbmcnIF07XG5cbi8qKlxuICAjIyMgcnRjLXRvb2xzL2NvdXBsZVxuXG4gICMjIyMgY291cGxlKHBjLCB0YXJnZXRJZCwgc2lnbmFsbGVyLCBvcHRzPylcblxuICBDb3VwbGUgYSBXZWJSVEMgY29ubmVjdGlvbiB3aXRoIGFub3RoZXIgd2VicnRjIGNvbm5lY3Rpb24gaWRlbnRpZmllZCBieVxuICBgdGFyZ2V0SWRgIHZpYSB0aGUgc2lnbmFsbGVyLlxuXG4gIFRoZSBmb2xsb3dpbmcgb3B0aW9ucyBjYW4gYmUgcHJvdmlkZWQgaW4gdGhlIGBvcHRzYCBhcmd1bWVudDpcblxuICAtIGBzZHBmaWx0ZXJgIChkZWZhdWx0OiBudWxsKVxuXG4gICAgQSBzaW1wbGUgZnVuY3Rpb24gZm9yIGZpbHRlcmluZyBTRFAgYXMgcGFydCBvZiB0aGUgcGVlclxuICAgIGNvbm5lY3Rpb24gaGFuZHNoYWtlIChzZWUgdGhlIFVzaW5nIEZpbHRlcnMgZGV0YWlscyBiZWxvdykuXG5cbiAgIyMjIyMgRXhhbXBsZSBVc2FnZVxuXG4gIGBgYGpzXG4gIHZhciBjb3VwbGUgPSByZXF1aXJlKCdydGMvY291cGxlJyk7XG5cbiAgY291cGxlKHBjLCAnNTQ4Nzk5NjUtY2U0My00MjZlLWE4ZWYtMDlhYzFlMzlhMTZkJywgc2lnbmFsbGVyKTtcbiAgYGBgXG5cbiAgIyMjIyMgVXNpbmcgRmlsdGVyc1xuXG4gIEluIGNlcnRhaW4gaW5zdGFuY2VzIHlvdSBtYXkgd2lzaCB0byBtb2RpZnkgdGhlIHJhdyBTRFAgdGhhdCBpcyBwcm92aWRlZFxuICBieSB0aGUgYGNyZWF0ZU9mZmVyYCBhbmQgYGNyZWF0ZUFuc3dlcmAgY2FsbHMuICBUaGlzIGNhbiBiZSBkb25lIGJ5IHBhc3NpbmdcbiAgYSBgc2RwZmlsdGVyYCBmdW5jdGlvbiAob3IgYXJyYXkpIGluIHRoZSBvcHRpb25zLiAgRm9yIGV4YW1wbGU6XG5cbiAgYGBganNcbiAgLy8gcnVuIHRoZSBzZHAgZnJvbSB0aHJvdWdoIGEgbG9jYWwgdHdlYWtTZHAgZnVuY3Rpb24uXG4gIGNvdXBsZShwYywgJzU0ODc5OTY1LWNlNDMtNDI2ZS1hOGVmLTA5YWMxZTM5YTE2ZCcsIHNpZ25hbGxlciwge1xuICAgIHNkcGZpbHRlcjogdHdlYWtTZHBcbiAgfSk7XG4gIGBgYFxuXG4qKi9cbmZ1bmN0aW9uIGNvdXBsZShwYywgdGFyZ2V0SWQsIHNpZ25hbGxlciwgb3B0cykge1xuICB2YXIgZGVidWdMYWJlbCA9IChvcHRzIHx8IHt9KS5kZWJ1Z0xhYmVsIHx8ICdydGMnO1xuICB2YXIgZGVidWcgPSByZXF1aXJlKCdjb2cvbG9nZ2VyJykoZGVidWdMYWJlbCArICcvY291cGxlJyk7XG5cbiAgLy8gY3JlYXRlIGEgbW9uaXRvciBmb3IgdGhlIGNvbm5lY3Rpb25cbiAgdmFyIG1vbiA9IG1vbml0b3IocGMsIHRhcmdldElkLCBzaWduYWxsZXIsIChvcHRzIHx8IHt9KS5sb2dnZXIpO1xuICB2YXIgZW1pdCA9IG1idXMoJycsIG1vbik7XG4gIHZhciByZWFjdGl2ZSA9IChvcHRzIHx8IHt9KS5yZWFjdGl2ZTtcbiAgdmFyIGVuZE9mQ2FuZGlkYXRlcyA9IHRydWU7XG5cbiAgLy8gY29uZmlndXJlIHRoZSB0aW1lIHRvIHdhaXQgYmV0d2VlbiByZWNlaXZpbmcgYSAnZGlzY29ubmVjdCdcbiAgLy8gaWNlQ29ubmVjdGlvblN0YXRlIGFuZCBkZXRlcm1pbmluZyB0aGF0IHdlIGFyZSBjbG9zZWRcbiAgdmFyIGRpc2Nvbm5lY3RUaW1lb3V0ID0gKG9wdHMgfHwge30pLmRpc2Nvbm5lY3RUaW1lb3V0IHx8IDEwMDAwO1xuICB2YXIgZGlzY29ubmVjdFRpbWVyO1xuXG4gIC8vIGluaXRpbGFpc2UgdGhlIG5lZ290aWF0aW9uIGhlbHBlcnNcbiAgdmFyIGlzTWFzdGVyID0gc2lnbmFsbGVyLmlzTWFzdGVyKHRhcmdldElkKTtcblxuICAvLyBpbml0aWFsaXNlIHRoZSBwcm9jZXNzaW5nIHF1ZXVlIChvbmUgYXQgYSB0aW1lIHBsZWFzZSlcbiAgdmFyIHEgPSBxdWV1ZShwYywgb3B0cyk7XG5cbiAgdmFyIGNyZWF0ZU9yUmVxdWVzdE9mZmVyID0gdGhyb3R0bGUoZnVuY3Rpb24oKSB7XG4gICAgaWYgKCEgaXNNYXN0ZXIpIHtcbiAgICAgIHJldHVybiBzaWduYWxsZXIudG8odGFyZ2V0SWQpLnNlbmQoJy9uZWdvdGlhdGUnKTtcbiAgICB9XG5cbiAgICBxLmNyZWF0ZU9mZmVyKCk7XG4gIH0sIDEwMCwgeyBsZWFkaW5nOiBmYWxzZSB9KTtcblxuICB2YXIgZGVib3VuY2VPZmZlciA9IHRocm90dGxlKHEuY3JlYXRlT2ZmZXIsIDEwMCwgeyBsZWFkaW5nOiBmYWxzZSB9KTtcblxuICBmdW5jdGlvbiBkZWNvdXBsZSgpIHtcbiAgICBkZWJ1ZygnZGVjb3VwbGluZyAnICsgc2lnbmFsbGVyLmlkICsgJyBmcm9tICcgKyB0YXJnZXRJZCk7XG5cbiAgICAvLyBzdG9wIHRoZSBtb25pdG9yXG4vLyAgICAgbW9uLnJlbW92ZUFsbExpc3RlbmVycygpO1xuICAgIG1vbi5zdG9wKCk7XG5cbiAgICAvLyBjbGVhbnVwIHRoZSBwZWVyY29ubmVjdGlvblxuICAgIGNsZWFudXAocGMpO1xuXG4gICAgLy8gcmVtb3ZlIGxpc3RlbmVyc1xuICAgIHNpZ25hbGxlci5yZW1vdmVMaXN0ZW5lcignc2RwJywgaGFuZGxlU2RwKTtcbiAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ2NhbmRpZGF0ZScsIGhhbmRsZUNhbmRpZGF0ZSk7XG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCduZWdvdGlhdGUnLCBoYW5kbGVOZWdvdGlhdGVSZXF1ZXN0KTtcblxuICAgIC8vIHJlbW92ZSBsaXN0ZW5lcnMgKHZlcnNpb24gPj0gNSlcbiAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ21lc3NhZ2U6c2RwJywgaGFuZGxlU2RwKTtcbiAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ21lc3NhZ2U6Y2FuZGlkYXRlJywgaGFuZGxlQ2FuZGlkYXRlKTtcbiAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ21lc3NhZ2U6bmVnb3RpYXRlJywgaGFuZGxlTmVnb3RpYXRlUmVxdWVzdCk7XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVDYW5kaWRhdGUoZGF0YSkge1xuICAgIHEuYWRkSWNlQ2FuZGlkYXRlKGRhdGEpO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlU2RwKHNkcCwgc3JjKSB7XG4gICAgZW1pdCgnc2RwLnJlbW90ZScsIHNkcCk7XG5cbiAgICAvLyBpZiB0aGUgc291cmNlIGlzIHVua25vd24gb3Igbm90IGEgbWF0Y2gsIHRoZW4gZG9uJ3QgcHJvY2Vzc1xuICAgIGlmICgoISBzcmMpIHx8IChzcmMuaWQgIT09IHRhcmdldElkKSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHEuc2V0UmVtb3RlRGVzY3JpcHRpb24oc2RwKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZUNvbm5lY3Rpb25DbG9zZSgpIHtcbiAgICBkZWJ1ZygnY2FwdHVyZWQgcGMgY2xvc2UsIGljZUNvbm5lY3Rpb25TdGF0ZSA9ICcgKyBwYy5pY2VDb25uZWN0aW9uU3RhdGUpO1xuICAgIGRlY291cGxlKCk7XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVEaXNjb25uZWN0KCkge1xuICAgIGRlYnVnKCdjYXB0dXJlZCBwYyBkaXNjb25uZWN0LCBtb25pdG9yaW5nIGNvbm5lY3Rpb24gc3RhdHVzJyk7XG5cbiAgICAvLyBzdGFydCB0aGUgZGlzY29ubmVjdCB0aW1lclxuICAgIGRpc2Nvbm5lY3RUaW1lciA9IHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICBkZWJ1ZygnbWFudWFsbHkgY2xvc2luZyBjb25uZWN0aW9uIGFmdGVyIGRpc2Nvbm5lY3QgdGltZW91dCcpO1xuICAgICAgY2xlYW51cChwYyk7XG4gICAgfSwgZGlzY29ubmVjdFRpbWVvdXQpO1xuXG4gICAgbW9uLm9uKCdzdGF0ZWNoYW5nZScsIGhhbmRsZURpc2Nvbm5lY3RBYm9ydCk7XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVEaXNjb25uZWN0QWJvcnQoKSB7XG4gICAgZGVidWcoJ2Nvbm5lY3Rpb24gc3RhdGUgY2hhbmdlZCB0bzogJyArIHBjLmljZUNvbm5lY3Rpb25TdGF0ZSk7XG5cbiAgICAvLyBpZiB0aGUgc3RhdGUgaXMgY2hlY2tpbmcsIHRoZW4gZG8gbm90IHJlc2V0IHRoZSBkaXNjb25uZWN0IHRpbWVyIGFzXG4gICAgLy8gd2UgYXJlIGRvaW5nIG91ciBvd24gY2hlY2tpbmdcbiAgICBpZiAoQ0hFQ0tJTkdfU1RBVEVTLmluZGV4T2YocGMuaWNlQ29ubmVjdGlvblN0YXRlKSA+PSAwKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgcmVzZXREaXNjb25uZWN0VGltZXIoKTtcblxuICAgIC8vIGlmIHdlIGhhdmUgYSBjbG9zZWQgb3IgZmFpbGVkIHN0YXR1cywgdGhlbiBjbG9zZSB0aGUgY29ubmVjdGlvblxuICAgIGlmIChDTE9TRURfU1RBVEVTLmluZGV4T2YocGMuaWNlQ29ubmVjdGlvblN0YXRlKSA+PSAwKSB7XG4gICAgICByZXR1cm4gbW9uKCdjbG9zZWQnKTtcbiAgICB9XG5cbiAgICBtb24ub25jZSgnZGlzY29ubmVjdCcsIGhhbmRsZURpc2Nvbm5lY3QpO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlTG9jYWxDYW5kaWRhdGUoZXZ0KSB7XG4gICAgdmFyIGRhdGE7XG5cbiAgICBpZiAoZXZ0LmNhbmRpZGF0ZSkge1xuICAgICAgcmVzZXREaXNjb25uZWN0VGltZXIoKTtcblxuICAgICAgLy8gZm9ybXVsYXRlIGludG8gYSBzcGVjaWZpYyBkYXRhIG9iamVjdCBzbyB3ZSB3b24ndCBiZSB1cHNldCBieSBwbHVnaW5cbiAgICAgIC8vIHNwZWNpZmljIGltcGxlbWVudGF0aW9ucyBvZiB0aGUgY2FuZGlkYXRlIGRhdGEgZm9ybWF0IChpLmUuIGV4dHJhIGZpZWxkcylcbiAgICAgIGRhdGEgPSB7XG4gICAgICAgIGNhbmRpZGF0ZTogZXZ0LmNhbmRpZGF0ZS5jYW5kaWRhdGUsXG4gICAgICAgIHNkcE1pZDogZXZ0LmNhbmRpZGF0ZS5zZHBNaWQsXG4gICAgICAgIHNkcE1MaW5lSW5kZXg6IGV2dC5jYW5kaWRhdGUuc2RwTUxpbmVJbmRleFxuICAgICAgfTtcblxuICAgICAgZW1pdCgnaWNlLmxvY2FsJywgZGF0YSk7XG4gICAgICBzaWduYWxsZXIudG8odGFyZ2V0SWQpLnNlbmQoJy9jYW5kaWRhdGUnLCBkYXRhKTtcbiAgICAgIGVuZE9mQ2FuZGlkYXRlcyA9IGZhbHNlO1xuICAgIH1cbiAgICBlbHNlIGlmICghIGVuZE9mQ2FuZGlkYXRlcykge1xuICAgICAgZW5kT2ZDYW5kaWRhdGVzID0gdHJ1ZTtcbiAgICAgIGVtaXQoJ2ljZS5nYXRoZXJjb21wbGV0ZScpO1xuICAgICAgc2lnbmFsbGVyLnRvKHRhcmdldElkKS5zZW5kKCcvZW5kb2ZjYW5kaWRhdGVzJywge30pO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZU5lZ290aWF0ZVJlcXVlc3Qoc3JjKSB7XG4gICAgaWYgKHNyYy5pZCA9PT0gdGFyZ2V0SWQpIHtcbiAgICAgIGVtaXQoJ25lZ290aWF0ZS5yZXF1ZXN0Jywgc3JjLmlkKTtcbiAgICAgIGRlYm91bmNlT2ZmZXIoKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiByZXNldERpc2Nvbm5lY3RUaW1lcigpIHtcbiAgICBtb24ub2ZmKCdzdGF0ZWNoYW5nZScsIGhhbmRsZURpc2Nvbm5lY3RBYm9ydCk7XG5cbiAgICAvLyBjbGVhciB0aGUgZGlzY29ubmVjdCB0aW1lclxuICAgIGRlYnVnKCdyZXNldCBkaXNjb25uZWN0IHRpbWVyLCBzdGF0ZTogJyArIHBjLmljZUNvbm5lY3Rpb25TdGF0ZSk7XG4gICAgY2xlYXJUaW1lb3V0KGRpc2Nvbm5lY3RUaW1lcik7XG4gIH1cblxuICAvLyB3aGVuIHJlZ290aWF0aW9uIGlzIG5lZWRlZCBsb29rIGZvciB0aGUgcGVlclxuICBpZiAocmVhY3RpdmUpIHtcbiAgICBwYy5vbm5lZ290aWF0aW9ubmVlZGVkID0gZnVuY3Rpb24oKSB7XG4gICAgICBlbWl0KCduZWdvdGlhdGUucmVuZWdvdGlhdGUnKTtcbiAgICAgIGNyZWF0ZU9yUmVxdWVzdE9mZmVyKCk7XG4gICAgfTtcbiAgfVxuXG4gIHBjLm9uaWNlY2FuZGlkYXRlID0gaGFuZGxlTG9jYWxDYW5kaWRhdGU7XG5cbiAgLy8gd2hlbiB0aGUgdGFzayBxdWV1ZSB0ZWxscyB1cyB3ZSBoYXZlIHNkcCBhdmFpbGFibGUsIHNlbmQgdGhhdCBvdmVyIHRoZSB3aXJlXG4gIHEub24oJ3NkcC5sb2NhbCcsIGZ1bmN0aW9uKGRlc2MpIHtcbiAgICBzaWduYWxsZXIudG8odGFyZ2V0SWQpLnNlbmQoJy9zZHAnLCBkZXNjKTtcbiAgfSk7XG5cbiAgLy8gd2hlbiB3ZSByZWNlaXZlIHNkcCwgdGhlblxuICBzaWduYWxsZXIub24oJ3NkcCcsIGhhbmRsZVNkcCk7XG4gIHNpZ25hbGxlci5vbignY2FuZGlkYXRlJywgaGFuZGxlQ2FuZGlkYXRlKTtcblxuICAvLyBsaXN0ZW5lcnMgKHNpZ25hbGxlciA+PSA1KVxuICBzaWduYWxsZXIub24oJ21lc3NhZ2U6c2RwJywgaGFuZGxlU2RwKTtcbiAgc2lnbmFsbGVyLm9uKCdtZXNzYWdlOmNhbmRpZGF0ZScsIGhhbmRsZUNhbmRpZGF0ZSk7XG5cbiAgLy8gaWYgdGhpcyBpcyBhIG1hc3RlciBjb25uZWN0aW9uLCBsaXN0ZW4gZm9yIG5lZ290aWF0ZSBldmVudHNcbiAgaWYgKGlzTWFzdGVyKSB7XG4gICAgc2lnbmFsbGVyLm9uKCduZWdvdGlhdGUnLCBoYW5kbGVOZWdvdGlhdGVSZXF1ZXN0KTtcbiAgICBzaWduYWxsZXIub24oJ21lc3NhZ2U6bmVnb3RpYXRlJywgaGFuZGxlTmVnb3RpYXRlUmVxdWVzdCk7IC8vIHNpZ25hbGxlciA+PSA1XG4gIH1cblxuICAvLyB3aGVuIHRoZSBjb25uZWN0aW9uIGNsb3NlcywgcmVtb3ZlIGV2ZW50IGhhbmRsZXJzXG4gIG1vbi5vbmNlKCdjbG9zZWQnLCBoYW5kbGVDb25uZWN0aW9uQ2xvc2UpO1xuICBtb24ub25jZSgnZGlzY29ubmVjdGVkJywgaGFuZGxlRGlzY29ubmVjdCk7XG5cbiAgLy8gcGF0Y2ggaW4gdGhlIGNyZWF0ZSBvZmZlciBmdW5jdGlvbnNcbiAgbW9uLmNyZWF0ZU9mZmVyID0gY3JlYXRlT3JSZXF1ZXN0T2ZmZXI7XG5cbiAgcmV0dXJuIG1vbjtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBjb3VwbGU7XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG4vKipcbiAgIyMjIHJ0Yy10b29scy9kZXRlY3RcblxuICBQcm92aWRlIHRoZSBbcnRjLWNvcmUvZGV0ZWN0XShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0Yy1jb3JlI2RldGVjdClcbiAgZnVuY3Rpb25hbGl0eS5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSByZXF1aXJlKCdydGMtY29yZS9kZXRlY3QnKTtcbiIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbnZhciBkZWJ1ZyA9IHJlcXVpcmUoJ2NvZy9sb2dnZXInKSgnZ2VuZXJhdG9ycycpO1xudmFyIGRldGVjdCA9IHJlcXVpcmUoJy4vZGV0ZWN0Jyk7XG52YXIgZGVmYXVsdHMgPSByZXF1aXJlKCdjb2cvZGVmYXVsdHMnKTtcblxudmFyIG1hcHBpbmdzID0ge1xuICBjcmVhdGU6IHtcbiAgICBkdGxzOiBmdW5jdGlvbihjKSB7XG4gICAgICBpZiAoISBkZXRlY3QubW96KSB7XG4gICAgICAgIGMub3B0aW9uYWwgPSAoYy5vcHRpb25hbCB8fCBbXSkuY29uY2F0KHsgRHRsc1NydHBLZXlBZ3JlZW1lbnQ6IHRydWUgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG4vKipcbiAgIyMjIHJ0Yy10b29scy9nZW5lcmF0b3JzXG5cbiAgVGhlIGdlbmVyYXRvcnMgcGFja2FnZSBwcm92aWRlcyBzb21lIHV0aWxpdHkgbWV0aG9kcyBmb3IgZ2VuZXJhdGluZ1xuICBjb25zdHJhaW50IG9iamVjdHMgYW5kIHNpbWlsYXIgY29uc3RydWN0cy5cblxuICBgYGBqc1xuICB2YXIgZ2VuZXJhdG9ycyA9IHJlcXVpcmUoJ3J0Yy9nZW5lcmF0b3JzJyk7XG4gIGBgYFxuXG4qKi9cblxuLyoqXG4gICMjIyMgZ2VuZXJhdG9ycy5jb25maWcoY29uZmlnKVxuXG4gIEdlbmVyYXRlIGEgY29uZmlndXJhdGlvbiBvYmplY3Qgc3VpdGFibGUgZm9yIHBhc3NpbmcgaW50byBhbiBXM0NcbiAgUlRDUGVlckNvbm5lY3Rpb24gY29uc3RydWN0b3IgZmlyc3QgYXJndW1lbnQsIGJhc2VkIG9uIG91ciBjdXN0b20gY29uZmlnLlxuXG4gIEluIHRoZSBldmVudCB0aGF0IHlvdSB1c2Ugc2hvcnQgdGVybSBhdXRoZW50aWNhdGlvbiBmb3IgVFVSTiwgYW5kIHlvdSB3YW50XG4gIHRvIGdlbmVyYXRlIG5ldyBgaWNlU2VydmVyc2AgcmVndWxhcmx5LCB5b3UgY2FuIHNwZWNpZnkgYW4gaWNlU2VydmVyR2VuZXJhdG9yXG4gIHRoYXQgd2lsbCBiZSB1c2VkIHByaW9yIHRvIGNvdXBsaW5nLiBUaGlzIGdlbmVyYXRvciBzaG91bGQgcmV0dXJuIGEgZnVsbHlcbiAgY29tcGxpYW50IFczQyAoUlRDSWNlU2VydmVyIGRpY3Rpb25hcnkpW2h0dHA6Ly93d3cudzMub3JnL1RSL3dlYnJ0Yy8jaWRsLWRlZi1SVENJY2VTZXJ2ZXJdLlxuXG4gIElmIHlvdSBwYXNzIGluIGJvdGggYSBnZW5lcmF0b3IgYW5kIGljZVNlcnZlcnMsIHRoZSBpY2VTZXJ2ZXJzIF93aWxsIGJlXG4gIGlnbm9yZWQgYW5kIHRoZSBnZW5lcmF0b3IgdXNlZCBpbnN0ZWFkLlxuKiovXG5cbmV4cG9ydHMuY29uZmlnID0gZnVuY3Rpb24oY29uZmlnKSB7XG4gIHZhciBpY2VTZXJ2ZXJHZW5lcmF0b3IgPSAoY29uZmlnIHx8IHt9KS5pY2VTZXJ2ZXJHZW5lcmF0b3I7XG5cbiAgcmV0dXJuIGRlZmF1bHRzKHt9LCBjb25maWcsIHtcbiAgICBpY2VTZXJ2ZXJzOiB0eXBlb2YgaWNlU2VydmVyR2VuZXJhdG9yID09ICdmdW5jdGlvbicgPyBpY2VTZXJ2ZXJHZW5lcmF0b3IoKSA6IFtdXG4gIH0pO1xufTtcblxuLyoqXG4gICMjIyMgZ2VuZXJhdG9ycy5jb25uZWN0aW9uQ29uc3RyYWludHMoZmxhZ3MsIGNvbnN0cmFpbnRzKVxuXG4gIFRoaXMgaXMgYSBoZWxwZXIgZnVuY3Rpb24gdGhhdCB3aWxsIGdlbmVyYXRlIGFwcHJvcHJpYXRlIGNvbm5lY3Rpb25cbiAgY29uc3RyYWludHMgZm9yIGEgbmV3IGBSVENQZWVyQ29ubmVjdGlvbmAgb2JqZWN0IHdoaWNoIGlzIGNvbnN0cnVjdGVkXG4gIGluIHRoZSBmb2xsb3dpbmcgd2F5OlxuXG4gIGBgYGpzXG4gIHZhciBjb25uID0gbmV3IFJUQ1BlZXJDb25uZWN0aW9uKGZsYWdzLCBjb25zdHJhaW50cyk7XG4gIGBgYFxuXG4gIEluIG1vc3QgY2FzZXMgdGhlIGNvbnN0cmFpbnRzIG9iamVjdCBjYW4gYmUgbGVmdCBlbXB0eSwgYnV0IHdoZW4gY3JlYXRpbmdcbiAgZGF0YSBjaGFubmVscyBzb21lIGFkZGl0aW9uYWwgb3B0aW9ucyBhcmUgcmVxdWlyZWQuICBUaGlzIGZ1bmN0aW9uXG4gIGNhbiBnZW5lcmF0ZSB0aG9zZSBhZGRpdGlvbmFsIG9wdGlvbnMgYW5kIGludGVsbGlnZW50bHkgY29tYmluZSBhbnlcbiAgdXNlciBkZWZpbmVkIGNvbnN0cmFpbnRzIChpbiBgY29uc3RyYWludHNgKSB3aXRoIHNob3J0aGFuZCBmbGFncyB0aGF0XG4gIG1pZ2h0IGJlIHBhc3NlZCB3aGlsZSB1c2luZyB0aGUgYHJ0Yy5jcmVhdGVDb25uZWN0aW9uYCBoZWxwZXIuXG4qKi9cbmV4cG9ydHMuY29ubmVjdGlvbkNvbnN0cmFpbnRzID0gZnVuY3Rpb24oZmxhZ3MsIGNvbnN0cmFpbnRzKSB7XG4gIHZhciBnZW5lcmF0ZWQgPSB7fTtcbiAgdmFyIG0gPSBtYXBwaW5ncy5jcmVhdGU7XG4gIHZhciBvdXQ7XG5cbiAgLy8gaXRlcmF0ZSB0aHJvdWdoIHRoZSBmbGFncyBhbmQgYXBwbHkgdGhlIGNyZWF0ZSBtYXBwaW5nc1xuICBPYmplY3Qua2V5cyhmbGFncyB8fCB7fSkuZm9yRWFjaChmdW5jdGlvbihrZXkpIHtcbiAgICBpZiAobVtrZXldKSB7XG4gICAgICBtW2tleV0oZ2VuZXJhdGVkKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIGdlbmVyYXRlIHRoZSBjb25uZWN0aW9uIGNvbnN0cmFpbnRzXG4gIG91dCA9IGRlZmF1bHRzKHt9LCBjb25zdHJhaW50cywgZ2VuZXJhdGVkKTtcbiAgZGVidWcoJ2dlbmVyYXRlZCBjb25uZWN0aW9uIGNvbnN0cmFpbnRzOiAnLCBvdXQpO1xuXG4gIHJldHVybiBvdXQ7XG59O1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cblxuJ3VzZSBzdHJpY3QnO1xuXG4vKipcbiAgIyBydGMtdG9vbHNcblxuICBUaGUgYHJ0Yy10b29sc2AgbW9kdWxlIGRvZXMgbW9zdCBvZiB0aGUgaGVhdnkgbGlmdGluZyB3aXRoaW4gdGhlXG4gIFtydGMuaW9dKGh0dHA6Ly9ydGMuaW8pIHN1aXRlLiAgUHJpbWFyaWx5IGl0IGhhbmRsZXMgdGhlIGxvZ2ljIG9mIGNvdXBsaW5nXG4gIGEgbG9jYWwgYFJUQ1BlZXJDb25uZWN0aW9uYCB3aXRoIGl0J3MgcmVtb3RlIGNvdW50ZXJwYXJ0IHZpYSBhblxuICBbcnRjLXNpZ25hbGxlcl0oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMtc2lnbmFsbGVyKSBzaWduYWxsaW5nXG4gIGNoYW5uZWwuXG5cbiAgIyMgR2V0dGluZyBTdGFydGVkXG5cbiAgSWYgeW91IGRlY2lkZSB0aGF0IHRoZSBgcnRjLXRvb2xzYCBtb2R1bGUgaXMgYSBiZXR0ZXIgZml0IGZvciB5b3UgdGhhbiBlaXRoZXJcbiAgW3J0Yy1xdWlja2Nvbm5lY3RdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLXF1aWNrY29ubmVjdCkgb3JcbiAgW3J0Y10oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMpIHRoZW4gdGhlIGNvZGUgc25pcHBldCBiZWxvd1xuICB3aWxsIHByb3ZpZGUgeW91IGEgZ3VpZGUgb24gaG93IHRvIGdldCBzdGFydGVkIHVzaW5nIGl0IGluIGNvbmp1bmN0aW9uIHdpdGhcbiAgdGhlIFtydGMtc2lnbmFsbGVyXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0Yy1zaWduYWxsZXIpICh2ZXJzaW9uIDUuMCBhbmQgYWJvdmUpXG4gIGFuZCBbcnRjLW1lZGlhXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0Yy1tZWRpYSkgbW9kdWxlczpcblxuICA8PDwgZXhhbXBsZXMvZ2V0dGluZy1zdGFydGVkLmpzXG5cbiAgVGhpcyBjb2RlIGRlZmluaXRlbHkgZG9lc24ndCBjb3ZlciBhbGwgdGhlIGNhc2VzIHRoYXQgeW91IG5lZWQgdG8gY29uc2lkZXJcbiAgKGkuZS4gcGVlcnMgbGVhdmluZywgZXRjKSBidXQgaXQgc2hvdWxkIGRlbW9uc3RyYXRlIGhvdyB0bzpcblxuICAxLiBDYXB0dXJlIHZpZGVvIGFuZCBhZGQgaXQgdG8gYSBwZWVyIGNvbm5lY3Rpb25cbiAgMi4gQ291cGxlIGEgbG9jYWwgcGVlciBjb25uZWN0aW9uIHdpdGggYSByZW1vdGUgcGVlciBjb25uZWN0aW9uXG4gIDMuIERlYWwgd2l0aCB0aGUgcmVtb3RlIHN0ZWFtIGJlaW5nIGRpc2NvdmVyZWQgYW5kIGhvdyB0byByZW5kZXJcbiAgICAgdGhhdCB0byB0aGUgbG9jYWwgaW50ZXJmYWNlLlxuXG4gICMjIFJlZmVyZW5jZVxuXG4qKi9cblxudmFyIGdlbiA9IHJlcXVpcmUoJy4vZ2VuZXJhdG9ycycpO1xuXG4vLyBleHBvcnQgZGV0ZWN0XG52YXIgZGV0ZWN0ID0gZXhwb3J0cy5kZXRlY3QgPSByZXF1aXJlKCcuL2RldGVjdCcpO1xudmFyIGZpbmRQbHVnaW4gPSByZXF1aXJlKCdydGMtY29yZS9wbHVnaW4nKTtcblxuLy8gZXhwb3J0IGNvZyBsb2dnZXIgZm9yIGNvbnZlbmllbmNlXG5leHBvcnRzLmxvZ2dlciA9IHJlcXVpcmUoJ2NvZy9sb2dnZXInKTtcblxuLy8gZXhwb3J0IHBlZXIgY29ubmVjdGlvblxudmFyIFJUQ1BlZXJDb25uZWN0aW9uID1cbmV4cG9ydHMuUlRDUGVlckNvbm5lY3Rpb24gPSBkZXRlY3QoJ1JUQ1BlZXJDb25uZWN0aW9uJyk7XG5cbi8vIGFkZCB0aGUgY291cGxlIHV0aWxpdHlcbmV4cG9ydHMuY291cGxlID0gcmVxdWlyZSgnLi9jb3VwbGUnKTtcblxuLyoqXG4gICMjIyBjcmVhdGVDb25uZWN0aW9uXG5cbiAgYGBgXG4gIGNyZWF0ZUNvbm5lY3Rpb24ob3B0cz8sIGNvbnN0cmFpbnRzPykgPT4gUlRDUGVlckNvbm5lY3Rpb25cbiAgYGBgXG5cbiAgQ3JlYXRlIGEgbmV3IGBSVENQZWVyQ29ubmVjdGlvbmAgYXV0byBnZW5lcmF0aW5nIGRlZmF1bHQgb3B0cyBhcyByZXF1aXJlZC5cblxuICBgYGBqc1xuICB2YXIgY29ubjtcblxuICAvLyB0aGlzIGlzIG9rXG4gIGNvbm4gPSBydGMuY3JlYXRlQ29ubmVjdGlvbigpO1xuXG4gIC8vIGFuZCBzbyBpcyB0aGlzXG4gIGNvbm4gPSBydGMuY3JlYXRlQ29ubmVjdGlvbih7XG4gICAgaWNlU2VydmVyczogW11cbiAgfSk7XG4gIGBgYFxuKiovXG5leHBvcnRzLmNyZWF0ZUNvbm5lY3Rpb24gPSBmdW5jdGlvbihvcHRzLCBjb25zdHJhaW50cykge1xuICB2YXIgcGx1Z2luID0gZmluZFBsdWdpbigob3B0cyB8fCB7fSkucGx1Z2lucyk7XG4gIHZhciBQZWVyQ29ubmVjdGlvbiA9IChvcHRzIHx8IHt9KS5SVENQZWVyQ29ubmVjdGlvbiB8fCBSVENQZWVyQ29ubmVjdGlvbjtcblxuICAvLyBnZW5lcmF0ZSB0aGUgY29uZmlnIGJhc2VkIG9uIG9wdGlvbnMgcHJvdmlkZWRcbiAgdmFyIGNvbmZpZyA9IGdlbi5jb25maWcob3B0cyk7XG5cbiAgLy8gZ2VuZXJhdGUgYXBwcm9wcmlhdGUgY29ubmVjdGlvbiBjb25zdHJhaW50c1xuICBjb25zdHJhaW50cyA9IGdlbi5jb25uZWN0aW9uQ29uc3RyYWludHMob3B0cywgY29uc3RyYWludHMpO1xuXG4gIGlmIChwbHVnaW4gJiYgdHlwZW9mIHBsdWdpbi5jcmVhdGVDb25uZWN0aW9uID09ICdmdW5jdGlvbicpIHtcbiAgICByZXR1cm4gcGx1Z2luLmNyZWF0ZUNvbm5lY3Rpb24oY29uZmlnLCBjb25zdHJhaW50cyk7XG4gIH1cblxuICByZXR1cm4gbmV3IFBlZXJDb25uZWN0aW9uKGNvbmZpZywgY29uc3RyYWludHMpO1xufTtcbiIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbnZhciBtYnVzID0gcmVxdWlyZSgnbWJ1cycpO1xuXG4vLyBkZWZpbmUgc29tZSBzdGF0ZSBtYXBwaW5ncyB0byBzaW1wbGlmeSB0aGUgZXZlbnRzIHdlIGdlbmVyYXRlXG52YXIgc3RhdGVNYXBwaW5ncyA9IHtcbiAgY29tcGxldGVkOiAnY29ubmVjdGVkJ1xufTtcblxuLy8gZGVmaW5lIHRoZSBldmVudHMgdGhhdCB3ZSBuZWVkIHRvIHdhdGNoIGZvciBwZWVyIGNvbm5lY3Rpb25cbi8vIHN0YXRlIGNoYW5nZXNcbnZhciBwZWVyU3RhdGVFdmVudHMgPSBbXG4gICdzaWduYWxpbmdzdGF0ZWNoYW5nZScsXG4gICdpY2Vjb25uZWN0aW9uc3RhdGVjaGFuZ2UnLFxuXTtcblxuLyoqXG4gICMjIyBydGMtdG9vbHMvbW9uaXRvclxuXG4gIGBgYFxuICBtb25pdG9yKHBjLCB0YXJnZXRJZCwgc2lnbmFsbGVyLCBwYXJlbnRCdXMpID0+IG1idXNcbiAgYGBgXG5cbiAgVGhlIG1vbml0b3IgaXMgYSB1c2VmdWwgdG9vbCBmb3IgZGV0ZXJtaW5pbmcgdGhlIHN0YXRlIG9mIGBwY2AgKGFuXG4gIGBSVENQZWVyQ29ubmVjdGlvbmApIGluc3RhbmNlIGluIHRoZSBjb250ZXh0IG9mIHlvdXIgYXBwbGljYXRpb24uIFRoZVxuICBtb25pdG9yIHVzZXMgYm90aCB0aGUgYGljZUNvbm5lY3Rpb25TdGF0ZWAgaW5mb3JtYXRpb24gb2YgdGhlIHBlZXJcbiAgY29ubmVjdGlvbiBhbmQgYWxzbyB0aGUgdmFyaW91c1xuICBbc2lnbmFsbGVyIGV2ZW50c10oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMtc2lnbmFsbGVyI3NpZ25hbGxlci1ldmVudHMpXG4gIHRvIGRldGVybWluZSB3aGVuIHRoZSBjb25uZWN0aW9uIGhhcyBiZWVuIGBjb25uZWN0ZWRgIGFuZCB3aGVuIGl0IGhhc1xuICBiZWVuIGBkaXNjb25uZWN0ZWRgLlxuXG4gIEEgbW9uaXRvciBjcmVhdGVkIGBtYnVzYCBpcyByZXR1cm5lZCBhcyB0aGUgcmVzdWx0IG9mIGFcbiAgW2NvdXBsZV0oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMjcnRjY291cGxlKSBiZXR3ZWVuIGEgbG9jYWwgcGVlclxuICBjb25uZWN0aW9uIGFuZCBpdCdzIHJlbW90ZSBjb3VudGVycGFydC5cblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHBjLCB0YXJnZXRJZCwgc2lnbmFsbGVyLCBwYXJlbnRCdXMpIHtcbiAgdmFyIG1vbml0b3IgPSBtYnVzKCcnLCBwYXJlbnRCdXMpO1xuICB2YXIgc3RhdGU7XG5cbiAgZnVuY3Rpb24gY2hlY2tTdGF0ZSgpIHtcbiAgICB2YXIgbmV3U3RhdGUgPSBnZXRNYXBwZWRTdGF0ZShwYy5pY2VDb25uZWN0aW9uU3RhdGUpO1xuXG4gICAgLy8gZmxhZyB0aGUgd2UgaGFkIGEgc3RhdGUgY2hhbmdlXG4gICAgbW9uaXRvcignc3RhdGVjaGFuZ2UnLCBwYywgbmV3U3RhdGUpO1xuXG4gICAgLy8gaWYgdGhlIGFjdGl2ZSBzdGF0ZSBoYXMgY2hhbmdlZCwgdGhlbiBzZW5kIHRoZSBhcHBvcHJpYXRlIG1lc3NhZ2VcbiAgICBpZiAoc3RhdGUgIT09IG5ld1N0YXRlKSB7XG4gICAgICBtb25pdG9yKG5ld1N0YXRlKTtcbiAgICAgIHN0YXRlID0gbmV3U3RhdGU7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlQ2xvc2UoKSB7XG4gICAgbW9uaXRvcignY2xvc2VkJyk7XG4gIH1cblxuICBwYy5vbmNsb3NlID0gaGFuZGxlQ2xvc2U7XG4gIHBlZXJTdGF0ZUV2ZW50cy5mb3JFYWNoKGZ1bmN0aW9uKGV2dE5hbWUpIHtcbiAgICBwY1snb24nICsgZXZ0TmFtZV0gPSBjaGVja1N0YXRlO1xuICB9KTtcblxuICBtb25pdG9yLnN0b3AgPSBmdW5jdGlvbigpIHtcbiAgICBwYy5vbmNsb3NlID0gbnVsbDtcbiAgICBwZWVyU3RhdGVFdmVudHMuZm9yRWFjaChmdW5jdGlvbihldnROYW1lKSB7XG4gICAgICBwY1snb24nICsgZXZ0TmFtZV0gPSBudWxsO1xuICAgIH0pO1xuICB9O1xuXG4gIG1vbml0b3IuY2hlY2tTdGF0ZSA9IGNoZWNrU3RhdGU7XG5cbiAgLy8gaWYgd2UgaGF2ZW4ndCBiZWVuIHByb3ZpZGVkIGEgdmFsaWQgcGVlciBjb25uZWN0aW9uLCBhYm9ydFxuICBpZiAoISBwYykge1xuICAgIHJldHVybiBtb25pdG9yO1xuICB9XG5cbiAgLy8gZGV0ZXJtaW5lIHRoZSBpbml0aWFsIGlzIGFjdGl2ZSBzdGF0ZVxuICBzdGF0ZSA9IGdldE1hcHBlZFN0YXRlKHBjLmljZUNvbm5lY3Rpb25TdGF0ZSk7XG5cbiAgcmV0dXJuIG1vbml0b3I7XG59O1xuXG4vKiBpbnRlcm5hbCBoZWxwZXJzICovXG5cbmZ1bmN0aW9uIGdldE1hcHBlZFN0YXRlKHN0YXRlKSB7XG4gIHJldHVybiBzdGF0ZU1hcHBpbmdzW3N0YXRlXSB8fCBzdGF0ZTtcbn1cbiIsInZhciBkZXRlY3QgPSByZXF1aXJlKCdydGMtY29yZS9kZXRlY3QnKTtcbnZhciBmaW5kUGx1Z2luID0gcmVxdWlyZSgncnRjLWNvcmUvcGx1Z2luJyk7XG52YXIgUHJpb3JpdHlRdWV1ZSA9IHJlcXVpcmUoJ3ByaW9yaXR5cXVldWVqcycpO1xuXG4vLyBzb21lIHZhbGlkYXRpb24gcm91dGluZXNcbnZhciBjaGVja0NhbmRpZGF0ZSA9IHJlcXVpcmUoJ3J0Yy12YWxpZGF0b3IvY2FuZGlkYXRlJyk7XG5cbi8vIHRoZSBzZHAgY2xlYW5lclxudmFyIHNkcGNsZWFuID0gcmVxdWlyZSgncnRjLXNkcGNsZWFuJyk7XG5cbnZhciBQUklPUklUWV9MT1cgPSAxMDA7XG52YXIgUFJJT1JJVFlfV0FJVCA9IDEwMDA7XG5cbi8vIHByaW9yaXR5IG9yZGVyIChsb3dlciBpcyBiZXR0ZXIpXG52YXIgREVGQVVMVF9QUklPUklUSUVTID0gW1xuICAnY2FuZGlkYXRlJyxcbiAgJ3NldExvY2FsRGVzY3JpcHRpb24nLFxuICAnc2V0UmVtb3RlRGVzY3JpcHRpb24nLFxuICAnY3JlYXRlQW5zd2VyJyxcbiAgJ2NyZWF0ZU9mZmVyJ1xuXTtcblxuLy8gZGVmaW5lIGV2ZW50IG1hcHBpbmdzXG52YXIgTUVUSE9EX0VWRU5UUyA9IHtcbiAgc2V0TG9jYWxEZXNjcmlwdGlvbjogJ3NldGxvY2FsZGVzYycsXG4gIHNldFJlbW90ZURlc2NyaXB0aW9uOiAnc2V0cmVtb3RlZGVzYycsXG4gIGNyZWF0ZU9mZmVyOiAnb2ZmZXInLFxuICBjcmVhdGVBbnN3ZXI6ICdhbnN3ZXInXG59O1xuXG4vLyBkZWZpbmUgc3RhdGVzIGluIHdoaWNoIHdlIHdpbGwgYXR0ZW1wdCB0byBmaW5hbGl6ZSBhIGNvbm5lY3Rpb24gb24gcmVjZWl2aW5nIGEgcmVtb3RlIG9mZmVyXG52YXIgVkFMSURfUkVTUE9OU0VfU1RBVEVTID0gWydoYXZlLXJlbW90ZS1vZmZlcicsICdoYXZlLWxvY2FsLXByYW5zd2VyJ107XG5cbi8qKlxuICAjIHJ0Yy10YXNrcXVldWVcblxuICBUaGlzIGlzIGEgcGFja2FnZSB0aGF0IGFzc2lzdHMgd2l0aCBhcHBseWluZyBhY3Rpb25zIHRvIGFuIGBSVENQZWVyQ29ubmVjdGlvbmBcbiAgaW4gYXMgcmVsaWFibGUgb3JkZXIgYXMgcG9zc2libGUuIEl0IGlzIHByaW1hcmlseSB1c2VkIGJ5IHRoZSBjb3VwbGluZyBsb2dpY1xuICBvZiB0aGUgW2BydGMtdG9vbHNgXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0Yy10b29scykuXG5cbiAgIyMgRXhhbXBsZSBVc2FnZVxuXG4gIEZvciB0aGUgbW9tZW50LCByZWZlciB0byB0aGUgc2ltcGxlIGNvdXBsaW5nIHRlc3QgYXMgYW4gZXhhbXBsZSBvZiBob3cgdG8gdXNlXG4gIHRoaXMgcGFja2FnZSAoc2VlIGJlbG93KTpcblxuICA8PDwgdGVzdC9jb3VwbGUuanNcblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHBjLCBvcHRzKSB7XG4gIC8vIGNyZWF0ZSB0aGUgdGFzayBxdWV1ZVxuICB2YXIgcXVldWUgPSBuZXcgUHJpb3JpdHlRdWV1ZShvcmRlclRhc2tzKTtcbiAgdmFyIHRxID0gcmVxdWlyZSgnbWJ1cycpKCcnLCAob3B0cyB8fCB7fSkubG9nZ2VyKTtcblxuICAvLyBpbml0aWFsaXNlIHRhc2sgaW1wb3J0YW5jZVxuICB2YXIgcHJpb3JpdGllcyA9IChvcHRzIHx8IHt9KS5wcmlvcml0aWVzIHx8IERFRkFVTFRfUFJJT1JJVElFUztcblxuICAvLyBjaGVjayBmb3IgcGx1Z2luIHVzYWdlXG4gIHZhciBwbHVnaW4gPSBmaW5kUGx1Z2luKChvcHRzIHx8IHt9KS5wbHVnaW5zKTtcblxuICAvLyBpbml0aWFsaXNlIHN0YXRlIHRyYWNraW5nXG4gIHZhciBjaGVja1F1ZXVlVGltZXIgPSAwO1xuICB2YXIgY3VycmVudFRhc2s7XG4gIHZhciBkZWZhdWx0RmFpbCA9IHRxLmJpbmQodHEsICdmYWlsJyk7XG5cbiAgLy8gbG9vayBmb3IgYW4gc2RwZmlsdGVyIGZ1bmN0aW9uIChhbGxvdyBzbGlnaHQgbWlzLXNwZWxsaW5ncylcbiAgdmFyIHNkcEZpbHRlciA9IChvcHRzIHx8IHt9KS5zZHBmaWx0ZXIgfHwgKG9wdHMgfHwge30pLnNkcEZpbHRlcjtcblxuICAvLyBpbml0aWFsaXNlIHNlc3Npb24gZGVzY3JpcHRpb24gYW5kIGljZWNhbmRpZGF0ZSBvYmplY3RzXG4gIHZhciBSVENTZXNzaW9uRGVzY3JpcHRpb24gPSAob3B0cyB8fCB7fSkuUlRDU2Vzc2lvbkRlc2NyaXB0aW9uIHx8XG4gICAgZGV0ZWN0KCdSVENTZXNzaW9uRGVzY3JpcHRpb24nKTtcblxuICB2YXIgUlRDSWNlQ2FuZGlkYXRlID0gKG9wdHMgfHwge30pLlJUQ0ljZUNhbmRpZGF0ZSB8fFxuICAgIGRldGVjdCgnUlRDSWNlQ2FuZGlkYXRlJyk7XG5cbiAgZnVuY3Rpb24gYWJvcnRRdWV1ZShlcnIpIHtcbiAgICBjb25zb2xlLmVycm9yKGVycik7XG4gIH1cblxuICBmdW5jdGlvbiBhcHBseUNhbmRpZGF0ZSh0YXNrLCBuZXh0KSB7XG4gICAgdmFyIGRhdGEgPSB0YXNrLmFyZ3NbMF07XG4gICAgdmFyIGNhbmRpZGF0ZSA9IGRhdGEgJiYgZGF0YS5jYW5kaWRhdGUgJiYgY3JlYXRlSWNlQ2FuZGlkYXRlKGRhdGEpO1xuXG4gICAgZnVuY3Rpb24gaGFuZGxlT2soKSB7XG4gICAgICB0cSgnaWNlLnJlbW90ZS5hcHBsaWVkJywgY2FuZGlkYXRlKTtcbiAgICAgIG5leHQoKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBoYW5kbGVGYWlsKGVycikge1xuICAgICAgdHEoJ2ljZS5yZW1vdGUuaW52YWxpZCcsIGNhbmRpZGF0ZSk7XG4gICAgICBuZXh0KGVycik7XG4gICAgfVxuXG4gICAgLy8gd2UgaGF2ZSBhIG51bGwgY2FuZGlkYXRlLCB3ZSBoYXZlIGZpbmlzaGVkIGdhdGhlcmluZyBjYW5kaWRhdGVzXG4gICAgaWYgKCEgY2FuZGlkYXRlKSB7XG4gICAgICByZXR1cm4gbmV4dCgpO1xuICAgIH1cblxuICAgIHBjLmFkZEljZUNhbmRpZGF0ZShjYW5kaWRhdGUsIGhhbmRsZU9rLCBoYW5kbGVGYWlsKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNoZWNrUXVldWUoKSB7XG4gICAgLy8gcGVlayBhdCB0aGUgbmV4dCBpdGVtIG9uIHRoZSBxdWV1ZVxuICAgIHZhciBuZXh0ID0gKCEgcXVldWUuaXNFbXB0eSgpKSAmJiAoISBjdXJyZW50VGFzaykgJiYgcXVldWUucGVlaygpO1xuICAgIHZhciByZWFkeSA9IG5leHQgJiYgdGVzdFJlYWR5KG5leHQpO1xuICAgIHZhciByZXRyeSA9ICghIHF1ZXVlLmlzRW1wdHkoKSkgJiYgaXNOb3RDbG9zZWQocGMpO1xuXG4gICAgLy8gcmVzZXQgdGhlIHF1ZXVlIHRpbWVyXG4gICAgY2hlY2tRdWV1ZVRpbWVyID0gMDtcblxuICAgIC8vIGlmIHdlIGRvbid0IGhhdmUgYSB0YXNrIHJlYWR5LCB0aGVuIGFib3J0XG4gICAgaWYgKCEgcmVhZHkpIHtcbiAgICAgIHJldHVybiByZXRyeSAmJiB0cmlnZ2VyUXVldWVDaGVjaygpO1xuICAgIH1cblxuICAgIC8vIHVwZGF0ZSB0aGUgY3VycmVudCB0YXNrIChkZXF1ZXVlKVxuICAgIGN1cnJlbnRUYXNrID0gcXVldWUuZGVxKCk7XG5cbiAgICAvLyBwcm9jZXNzIHRoZSB0YXNrXG4gICAgY3VycmVudFRhc2suZm4oY3VycmVudFRhc2ssIGZ1bmN0aW9uKGVycikge1xuICAgICAgdmFyIGZhaWwgPSBjdXJyZW50VGFzay5mYWlsIHx8IGRlZmF1bHRGYWlsO1xuICAgICAgdmFyIHBhc3MgPSBjdXJyZW50VGFzay5wYXNzO1xuICAgICAgdmFyIHRhc2tOYW1lID0gY3VycmVudFRhc2submFtZTtcblxuICAgICAgLy8gaWYgZXJyb3JlZCwgZmFpbFxuICAgICAgaWYgKGVycikge1xuICAgICAgICBjb25zb2xlLmVycm9yKHRhc2tOYW1lICsgJyB0YXNrIGZhaWxlZDogJywgZXJyKTtcbiAgICAgICAgcmV0dXJuIGZhaWwoZXJyKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHR5cGVvZiBwYXNzID09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgcGFzcy5hcHBseShjdXJyZW50VGFzaywgW10uc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpKTtcbiAgICAgIH1cblxuICAgICAgc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgY3VycmVudFRhc2sgPSBudWxsO1xuICAgICAgICB0cmlnZ2VyUXVldWVDaGVjaygpO1xuICAgICAgfSwgMCk7XG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBjbGVhbnNkcChkZXNjKSB7XG4gICAgLy8gZW5zdXJlIHdlIGhhdmUgY2xlYW4gc2RwXG4gICAgdmFyIHNkcEVycm9ycyA9IFtdO1xuICAgIHZhciBzZHAgPSBkZXNjICYmIHNkcGNsZWFuKGRlc2Muc2RwLCB7IGNvbGxlY3Rvcjogc2RwRXJyb3JzIH0pO1xuXG4gICAgLy8gaWYgd2UgZG9uJ3QgaGF2ZSBhIG1hdGNoLCBsb2cgc29tZSBpbmZvXG4gICAgaWYgKGRlc2MgJiYgc2RwICE9PSBkZXNjLnNkcCkge1xuICAgICAgY29uc29sZS5pbmZvKCdpbnZhbGlkIGxpbmVzIHJlbW92ZWQgZnJvbSBzZHA6ICcsIHNkcEVycm9ycyk7XG4gICAgICBkZXNjLnNkcCA9IHNkcDtcbiAgICB9XG5cbiAgICAvLyBpZiBhIGZpbHRlciBoYXMgYmVlbiBzcGVjaWZpZWQsIHRoZW4gYXBwbHkgdGhlIGZpbHRlclxuICAgIGlmICh0eXBlb2Ygc2RwRmlsdGVyID09ICdmdW5jdGlvbicpIHtcbiAgICAgIGRlc2Muc2RwID0gc2RwRmlsdGVyKGRlc2Muc2RwLCBwYyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGRlc2M7XG4gIH1cblxuICBmdW5jdGlvbiBjb21wbGV0ZUNvbm5lY3Rpb24oKSB7XG4gICAgaWYgKFZBTElEX1JFU1BPTlNFX1NUQVRFUy5pbmRleE9mKHBjLnNpZ25hbGluZ1N0YXRlKSA+PSAwKSB7XG4gICAgICByZXR1cm4gdHEuY3JlYXRlQW5zd2VyKCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gY3JlYXRlSWNlQ2FuZGlkYXRlKGRhdGEpIHtcbiAgICBpZiAocGx1Z2luICYmIHR5cGVvZiBwbHVnaW4uY3JlYXRlSWNlQ2FuZGlkYXRlID09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiBwbHVnaW4uY3JlYXRlSWNlQ2FuZGlkYXRlKGRhdGEpO1xuICAgIH1cblxuICAgIHJldHVybiBuZXcgUlRDSWNlQ2FuZGlkYXRlKGRhdGEpO1xuICB9XG5cbiAgZnVuY3Rpb24gY3JlYXRlU2Vzc2lvbkRlc2NyaXB0aW9uKGRhdGEpIHtcbiAgICBpZiAocGx1Z2luICYmIHR5cGVvZiBwbHVnaW4uY3JlYXRlU2Vzc2lvbkRlc2NyaXB0aW9uID09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiBwbHVnaW4uY3JlYXRlU2Vzc2lvbkRlc2NyaXB0aW9uKGRhdGEpO1xuICAgIH1cblxuICAgIHJldHVybiBuZXcgUlRDU2Vzc2lvbkRlc2NyaXB0aW9uKGRhdGEpO1xuICB9XG5cbiAgZnVuY3Rpb24gZW1pdFNkcCgpIHtcbiAgICB0cSgnc2RwLmxvY2FsJywgdGhpcy5hcmdzWzBdKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGVucXVldWUobmFtZSwgaGFuZGxlciwgb3B0cykge1xuICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpO1xuXG4gICAgICBpZiAob3B0cyAmJiB0eXBlb2Ygb3B0cy5wcm9jZXNzQXJncyA9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGFyZ3MgPSBhcmdzLm1hcChvcHRzLnByb2Nlc3NBcmdzKTtcbiAgICAgIH1cblxuICAgICAgcXVldWUuZW5xKHtcbiAgICAgICAgYXJnczogYXJncyxcbiAgICAgICAgbmFtZTogbmFtZSxcbiAgICAgICAgZm46IGhhbmRsZXIsXG5cbiAgICAgICAgLy8gaW5pdGlsYWlzZSBhbnkgY2hlY2tzIHRoYXQgbmVlZCB0byBiZSBkb25lIHByaW9yXG4gICAgICAgIC8vIHRvIHRoZSB0YXNrIGV4ZWN1dGluZ1xuICAgICAgICBjaGVja3M6IFsgaXNOb3RDbG9zZWQgXS5jb25jYXQoKG9wdHMgfHwge30pLmNoZWNrcyB8fCBbXSksXG5cbiAgICAgICAgLy8gaW5pdGlhbGlzZSB0aGUgcGFzcyBhbmQgZmFpbCBoYW5kbGVyc1xuICAgICAgICBwYXNzOiAob3B0cyB8fCB7fSkucGFzcyxcbiAgICAgICAgZmFpbDogKG9wdHMgfHwge30pLmZhaWxcbiAgICAgIH0pO1xuXG4gICAgICB0cmlnZ2VyUXVldWVDaGVjaygpO1xuICAgIH07XG4gIH1cblxuICBmdW5jdGlvbiBleGVjTWV0aG9kKHRhc2ssIG5leHQpIHtcbiAgICB2YXIgZm4gPSBwY1t0YXNrLm5hbWVdO1xuICAgIHZhciBldmVudE5hbWUgPSBNRVRIT0RfRVZFTlRTW3Rhc2submFtZV0gfHwgKHRhc2submFtZSB8fCAnJykudG9Mb3dlckNhc2UoKTtcbiAgICB2YXIgY2JBcmdzID0gWyBzdWNjZXNzLCBmYWlsIF07XG4gICAgdmFyIGlzT2ZmZXIgPSB0YXNrLm5hbWUgPT09ICdjcmVhdGVPZmZlcic7XG5cbiAgICBmdW5jdGlvbiBmYWlsKGVycikge1xuICAgICAgdHEuYXBwbHkodHEsIFsgJ25lZ290aWF0ZS5lcnJvcicsIHRhc2submFtZSwgZXJyIF0uY29uY2F0KHRhc2suYXJncykpO1xuICAgICAgbmV4dChlcnIpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHN1Y2Nlc3MoKSB7XG4gICAgICB0cS5hcHBseSh0cSwgWyBbJ25lZ290aWF0ZScsIGV2ZW50TmFtZSwgJ29rJ10sIHRhc2submFtZSBdLmNvbmNhdCh0YXNrLmFyZ3MpKTtcbiAgICAgIG5leHQuYXBwbHkobnVsbCwgW251bGxdLmNvbmNhdChbXS5zbGljZS5jYWxsKGFyZ3VtZW50cykpKTtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIGZuICE9ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiBuZXh0KG5ldyBFcnJvcignY2Fubm90IGNhbGwgXCInICsgdGFzay5uYW1lICsgJ1wiIG9uIFJUQ1BlZXJDb25uZWN0aW9uJykpO1xuICAgIH1cblxuICAgIC8vIGludm9rZSB0aGUgZnVuY3Rpb25cbiAgICB0cS5hcHBseSh0cSwgWyduZWdvdGlhdGUuJyArIGV2ZW50TmFtZV0uY29uY2F0KHRhc2suYXJncykpO1xuICAgIGZuLmFwcGx5KFxuICAgICAgcGMsXG4gICAgICB0YXNrLmFyZ3MuY29uY2F0KGNiQXJncykuY29uY2F0KGlzT2ZmZXIgPyBnZW5lcmF0ZUNvbnN0cmFpbnRzKCkgOiBbXSlcbiAgICApO1xuICB9XG5cbiAgZnVuY3Rpb24gZXh0cmFjdENhbmRpZGF0ZUV2ZW50RGF0YShkYXRhKSB7XG4gICAgLy8gZXh0cmFjdCBuZXN0ZWQgY2FuZGlkYXRlIGRhdGEgKGxpa2Ugd2Ugd2lsbCBzZWUgaW4gYW4gZXZlbnQgYmVpbmcgcGFzc2VkIHRvIHRoaXMgZnVuY3Rpb24pXG4gICAgd2hpbGUgKGRhdGEgJiYgZGF0YS5jYW5kaWRhdGUgJiYgZGF0YS5jYW5kaWRhdGUuY2FuZGlkYXRlKSB7XG4gICAgICBkYXRhID0gZGF0YS5jYW5kaWRhdGU7XG4gICAgfVxuXG4gICAgcmV0dXJuIGRhdGE7XG4gIH1cblxuICBmdW5jdGlvbiBnZW5lcmF0ZUNvbnN0cmFpbnRzKCkge1xuICAgIHZhciBhbGxvd2VkS2V5cyA9IHtcbiAgICAgIG9mZmVydG9yZWNlaXZldmlkZW86ICdPZmZlclRvUmVjZWl2ZVZpZGVvJyxcbiAgICAgIG9mZmVydG9yZWNlaXZlYXVkaW86ICdPZmZlclRvUmVjZWl2ZUF1ZGlvJyxcbiAgICAgIGljZXJlc3RhcnQ6ICdJY2VSZXN0YXJ0JyxcbiAgICAgIHZvaWNlYWN0aXZpdHlkZXRlY3Rpb246ICdWb2ljZUFjdGl2aXR5RGV0ZWN0aW9uJ1xuICAgIH07XG5cbiAgICB2YXIgY29uc3RyYWludHMgPSB7XG4gICAgICBPZmZlclRvUmVjZWl2ZVZpZGVvOiB0cnVlLFxuICAgICAgT2ZmZXJUb1JlY2VpdmVBdWRpbzogdHJ1ZVxuICAgIH07XG5cbiAgICAvLyB1cGRhdGUga25vd24ga2V5cyB0byBtYXRjaFxuICAgIE9iamVjdC5rZXlzKG9wdHMgfHwge30pLmZvckVhY2goZnVuY3Rpb24oa2V5KSB7XG4gICAgICBpZiAoYWxsb3dlZEtleXNba2V5LnRvTG93ZXJDYXNlKCldKSB7XG4gICAgICAgIGNvbnN0cmFpbnRzW2FsbG93ZWRLZXlzW2tleS50b0xvd2VyQ2FzZSgpXV0gPSBvcHRzW2tleV07XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBtYW5kYXRvcnk6IGNvbnN0cmFpbnRzIH07XG4gIH1cblxuICBmdW5jdGlvbiBoYXNMb2NhbE9yUmVtb3RlRGVzYyhwYywgdGFzaykge1xuICAgIHJldHVybiBwYy5fX2hhc0Rlc2MgfHwgKHBjLl9faGFzRGVzYyA9ICEhcGMucmVtb3RlRGVzY3JpcHRpb24pO1xuICB9XG5cbiAgZnVuY3Rpb24gaXNOb3ROZWdvdGlhdGluZyhwYykge1xuICAgIHJldHVybiBwYy5zaWduYWxpbmdTdGF0ZSAhPT0gJ2hhdmUtbG9jYWwtb2ZmZXInO1xuICB9XG5cbiAgZnVuY3Rpb24gaXNOb3RDbG9zZWQocGMpIHtcbiAgICByZXR1cm4gcGMuc2lnbmFsaW5nU3RhdGUgIT09ICdjbG9zZWQnO1xuICB9XG5cbiAgZnVuY3Rpb24gaXNTdGFibGUocGMpIHtcbiAgICByZXR1cm4gcGMuc2lnbmFsaW5nU3RhdGUgPT09ICdzdGFibGUnO1xuICB9XG5cbiAgZnVuY3Rpb24gaXNWYWxpZENhbmRpZGF0ZShwYywgZGF0YSkge1xuICAgIHJldHVybiBkYXRhLl9fdmFsaWQgfHxcbiAgICAgIChkYXRhLl9fdmFsaWQgPSBjaGVja0NhbmRpZGF0ZShkYXRhLmFyZ3NbMF0pLmxlbmd0aCA9PT0gMCk7XG4gIH1cblxuICBmdW5jdGlvbiBvcmRlclRhc2tzKGEsIGIpIHtcbiAgICAvLyBhcHBseSBlYWNoIG9mIHRoZSBjaGVja3MgZm9yIGVhY2ggdGFza1xuICAgIHZhciB0YXNrcyA9IFthLGJdO1xuICAgIHZhciByZWFkaW5lc3MgPSB0YXNrcy5tYXAodGVzdFJlYWR5KTtcbiAgICB2YXIgdGFza1ByaW9yaXRpZXMgPSB0YXNrcy5tYXAoZnVuY3Rpb24odGFzaywgaWR4KSB7XG4gICAgICB2YXIgcmVhZHkgPSByZWFkaW5lc3NbaWR4XTtcbiAgICAgIHZhciBwcmlvcml0eSA9IHJlYWR5ICYmIHByaW9yaXRpZXMuaW5kZXhPZih0YXNrLm5hbWUpO1xuXG4gICAgICByZXR1cm4gcmVhZHkgPyAocHJpb3JpdHkgPj0gMCA/IHByaW9yaXR5IDogUFJJT1JJVFlfTE9XKSA6IFBSSU9SSVRZX1dBSVQ7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gdGFza1ByaW9yaXRpZXNbMV0gLSB0YXNrUHJpb3JpdGllc1swXTtcbiAgfVxuXG4gIC8vIGNoZWNrIHdoZXRoZXIgYSB0YXNrIGlzIHJlYWR5IChkb2VzIGl0IHBhc3MgYWxsIHRoZSBjaGVja3MpXG4gIGZ1bmN0aW9uIHRlc3RSZWFkeSh0YXNrKSB7XG4gICAgcmV0dXJuICh0YXNrLmNoZWNrcyB8fCBbXSkucmVkdWNlKGZ1bmN0aW9uKG1lbW8sIGNoZWNrKSB7XG4gICAgICByZXR1cm4gbWVtbyAmJiBjaGVjayhwYywgdGFzayk7XG4gICAgfSwgdHJ1ZSk7XG4gIH1cblxuICBmdW5jdGlvbiB0cmlnZ2VyUXVldWVDaGVjaygpIHtcbiAgICBpZiAoY2hlY2tRdWV1ZVRpbWVyKSByZXR1cm47XG4gICAgY2hlY2tRdWV1ZVRpbWVyID0gc2V0VGltZW91dChjaGVja1F1ZXVlLCA1MCk7XG4gIH1cblxuICAvLyBwYXRjaCBpbiB0aGUgcXVldWUgaGVscGVyIG1ldGhvZHNcbiAgdHEuYWRkSWNlQ2FuZGlkYXRlID0gZW5xdWV1ZSgnYWRkSWNlQ2FuZGlkYXRlJywgYXBwbHlDYW5kaWRhdGUsIHtcbiAgICBwcm9jZXNzQXJnczogZXh0cmFjdENhbmRpZGF0ZUV2ZW50RGF0YSxcbiAgICBjaGVja3M6IFsgaGFzTG9jYWxPclJlbW90ZURlc2MsIGlzVmFsaWRDYW5kaWRhdGUgXVxuICB9KTtcblxuICB0cS5zZXRMb2NhbERlc2NyaXB0aW9uID0gZW5xdWV1ZSgnc2V0TG9jYWxEZXNjcmlwdGlvbicsIGV4ZWNNZXRob2QsIHtcbiAgICBwcm9jZXNzQXJnczogY2xlYW5zZHAsXG4gICAgcGFzczogZW1pdFNkcFxuICB9KTtcblxuICB0cS5zZXRSZW1vdGVEZXNjcmlwdGlvbiA9IGVucXVldWUoJ3NldFJlbW90ZURlc2NyaXB0aW9uJywgZXhlY01ldGhvZCwge1xuICAgIHByb2Nlc3NBcmdzOiBjcmVhdGVTZXNzaW9uRGVzY3JpcHRpb24sXG4gICAgcGFzczogY29tcGxldGVDb25uZWN0aW9uXG4gIH0pO1xuXG4gIHRxLmNyZWF0ZU9mZmVyID0gZW5xdWV1ZSgnY3JlYXRlT2ZmZXInLCBleGVjTWV0aG9kLCB7XG4gICAgY2hlY2tzOiBbIGlzTm90TmVnb3RpYXRpbmcgXSxcbiAgICBwYXNzOiB0cS5zZXRMb2NhbERlc2NyaXB0aW9uXG4gIH0pO1xuXG4gIHRxLmNyZWF0ZUFuc3dlciA9IGVucXVldWUoJ2NyZWF0ZUFuc3dlcicsIGV4ZWNNZXRob2QsIHtcbiAgICBwYXNzOiB0cS5zZXRMb2NhbERlc2NyaXB0aW9uXG4gIH0pO1xuXG4gIHJldHVybiB0cTtcbn07XG4iLCIvKipcbiAqIEV4cG9zZSBgUHJpb3JpdHlRdWV1ZWAuXG4gKi9cbm1vZHVsZS5leHBvcnRzID0gUHJpb3JpdHlRdWV1ZTtcblxuLyoqXG4gKiBJbml0aWFsaXplcyBhIG5ldyBlbXB0eSBgUHJpb3JpdHlRdWV1ZWAgd2l0aCB0aGUgZ2l2ZW4gYGNvbXBhcmF0b3IoYSwgYilgXG4gKiBmdW5jdGlvbiwgdXNlcyBgLkRFRkFVTFRfQ09NUEFSQVRPUigpYCB3aGVuIG5vIGZ1bmN0aW9uIGlzIHByb3ZpZGVkLlxuICpcbiAqIFRoZSBjb21wYXJhdG9yIGZ1bmN0aW9uIG11c3QgcmV0dXJuIGEgcG9zaXRpdmUgbnVtYmVyIHdoZW4gYGEgPiBiYCwgMCB3aGVuXG4gKiBgYSA9PSBiYCBhbmQgYSBuZWdhdGl2ZSBudW1iZXIgd2hlbiBgYSA8IGJgLlxuICpcbiAqIEBwYXJhbSB7RnVuY3Rpb259XG4gKiBAcmV0dXJuIHtQcmlvcml0eVF1ZXVlfVxuICogQGFwaSBwdWJsaWNcbiAqL1xuZnVuY3Rpb24gUHJpb3JpdHlRdWV1ZShjb21wYXJhdG9yKSB7XG4gIHRoaXMuX2NvbXBhcmF0b3IgPSBjb21wYXJhdG9yIHx8IFByaW9yaXR5UXVldWUuREVGQVVMVF9DT01QQVJBVE9SO1xuICB0aGlzLl9lbGVtZW50cyA9IFtdO1xufVxuXG4vKipcbiAqIENvbXBhcmVzIGBhYCBhbmQgYGJgLCB3aGVuIGBhID4gYmAgaXQgcmV0dXJucyBhIHBvc2l0aXZlIG51bWJlciwgd2hlblxuICogaXQgcmV0dXJucyAwIGFuZCB3aGVuIGBhIDwgYmAgaXQgcmV0dXJucyBhIG5lZ2F0aXZlIG51bWJlci5cbiAqXG4gKiBAcGFyYW0ge1N0cmluZ3xOdW1iZXJ9IGFcbiAqIEBwYXJhbSB7U3RyaW5nfE51bWJlcn0gYlxuICogQHJldHVybiB7TnVtYmVyfVxuICogQGFwaSBwdWJsaWNcbiAqL1xuUHJpb3JpdHlRdWV1ZS5ERUZBVUxUX0NPTVBBUkFUT1IgPSBmdW5jdGlvbihhLCBiKSB7XG4gIGlmIChhIGluc3RhbmNlb2YgTnVtYmVyICYmIGIgaW5zdGFuY2VvZiBOdW1iZXIpIHtcbiAgICByZXR1cm4gYSAtIGI7XG4gIH0gZWxzZSB7XG4gICAgYSA9IGEudG9TdHJpbmcoKTtcbiAgICBiID0gYi50b1N0cmluZygpO1xuXG4gICAgaWYgKGEgPT0gYikgcmV0dXJuIDA7XG5cbiAgICByZXR1cm4gKGEgPiBiKSA/IDEgOiAtMTtcbiAgfVxufTtcblxuLyoqXG4gKiBSZXR1cm5zIHdoZXRoZXIgdGhlIHByaW9yaXR5IHF1ZXVlIGlzIGVtcHR5IG9yIG5vdC5cbiAqXG4gKiBAcmV0dXJuIHtCb29sZWFufVxuICogQGFwaSBwdWJsaWNcbiAqL1xuUHJpb3JpdHlRdWV1ZS5wcm90b3R5cGUuaXNFbXB0eSA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5zaXplKCkgPT09IDA7XG59O1xuXG4vKipcbiAqIFBlZWtzIGF0IHRoZSB0b3AgZWxlbWVudCBvZiB0aGUgcHJpb3JpdHkgcXVldWUuXG4gKlxuICogQHJldHVybiB7T2JqZWN0fVxuICogQHRocm93cyB7RXJyb3J9IHdoZW4gdGhlIHF1ZXVlIGlzIGVtcHR5LlxuICogQGFwaSBwdWJsaWNcbiAqL1xuUHJpb3JpdHlRdWV1ZS5wcm90b3R5cGUucGVlayA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5pc0VtcHR5KCkpIHRocm93IG5ldyBFcnJvcignUHJpb3JpdHlRdWV1ZSBpcyBlbXB0eScpO1xuXG4gIHJldHVybiB0aGlzLl9lbGVtZW50c1swXTtcbn07XG5cbi8qKlxuICogRGVxdWV1ZXMgdGhlIHRvcCBlbGVtZW50IG9mIHRoZSBwcmlvcml0eSBxdWV1ZS5cbiAqXG4gKiBAcmV0dXJuIHtPYmplY3R9XG4gKiBAdGhyb3dzIHtFcnJvcn0gd2hlbiB0aGUgcXVldWUgaXMgZW1wdHkuXG4gKiBAYXBpIHB1YmxpY1xuICovXG5Qcmlvcml0eVF1ZXVlLnByb3RvdHlwZS5kZXEgPSBmdW5jdGlvbigpIHtcbiAgdmFyIGZpcnN0ID0gdGhpcy5wZWVrKCk7XG4gIHZhciBsYXN0ID0gdGhpcy5fZWxlbWVudHMucG9wKCk7XG4gIHZhciBzaXplID0gdGhpcy5zaXplKCk7XG5cbiAgaWYgKHNpemUgPT09IDApIHJldHVybiBmaXJzdDtcblxuICB0aGlzLl9lbGVtZW50c1swXSA9IGxhc3Q7XG4gIHZhciBjdXJyZW50ID0gMDtcblxuICB3aGlsZSAoY3VycmVudCA8IHNpemUpIHtcbiAgICB2YXIgbGFyZ2VzdCA9IGN1cnJlbnQ7XG4gICAgdmFyIGxlZnQgPSAoMiAqIGN1cnJlbnQpICsgMTtcbiAgICB2YXIgcmlnaHQgPSAoMiAqIGN1cnJlbnQpICsgMjtcblxuICAgIGlmIChsZWZ0IDwgc2l6ZSAmJiB0aGlzLl9jb21wYXJlKGxlZnQsIGxhcmdlc3QpID4gMCkge1xuICAgICAgbGFyZ2VzdCA9IGxlZnQ7XG4gICAgfVxuXG4gICAgaWYgKHJpZ2h0IDwgc2l6ZSAmJiB0aGlzLl9jb21wYXJlKHJpZ2h0LCBsYXJnZXN0KSA+IDApIHtcbiAgICAgIGxhcmdlc3QgPSByaWdodDtcbiAgICB9XG5cbiAgICBpZiAobGFyZ2VzdCA9PT0gY3VycmVudCkgYnJlYWs7XG5cbiAgICB0aGlzLl9zd2FwKGxhcmdlc3QsIGN1cnJlbnQpO1xuICAgIGN1cnJlbnQgPSBsYXJnZXN0O1xuICB9XG5cbiAgcmV0dXJuIGZpcnN0O1xufTtcblxuLyoqXG4gKiBFbnF1ZXVlcyB0aGUgYGVsZW1lbnRgIGF0IHRoZSBwcmlvcml0eSBxdWV1ZSBhbmQgcmV0dXJucyBpdHMgbmV3IHNpemUuXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGVsZW1lbnRcbiAqIEByZXR1cm4ge051bWJlcn1cbiAqIEBhcGkgcHVibGljXG4gKi9cblByaW9yaXR5UXVldWUucHJvdG90eXBlLmVucSA9IGZ1bmN0aW9uKGVsZW1lbnQpIHtcbiAgdmFyIHNpemUgPSB0aGlzLl9lbGVtZW50cy5wdXNoKGVsZW1lbnQpO1xuICB2YXIgY3VycmVudCA9IHNpemUgLSAxO1xuXG4gIHdoaWxlIChjdXJyZW50ID4gMCkge1xuICAgIHZhciBwYXJlbnQgPSBNYXRoLmZsb29yKChjdXJyZW50IC0gMSkgLyAyKTtcblxuICAgIGlmICh0aGlzLl9jb21wYXJlKGN1cnJlbnQsIHBhcmVudCkgPCAwKSBicmVhaztcblxuICAgIHRoaXMuX3N3YXAocGFyZW50LCBjdXJyZW50KTtcbiAgICBjdXJyZW50ID0gcGFyZW50O1xuICB9XG5cbiAgcmV0dXJuIHNpemU7XG59O1xuXG4vKipcbiAqIFJldHVybnMgdGhlIHNpemUgb2YgdGhlIHByaW9yaXR5IHF1ZXVlLlxuICpcbiAqIEByZXR1cm4ge051bWJlcn1cbiAqIEBhcGkgcHVibGljXG4gKi9cblByaW9yaXR5UXVldWUucHJvdG90eXBlLnNpemUgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuX2VsZW1lbnRzLmxlbmd0aDtcbn07XG5cbi8qKlxuICogIEl0ZXJhdGVzIG92ZXIgcXVldWUgZWxlbWVudHNcbiAqXG4gKiAgQHBhcmFtIHtGdW5jdGlvbn0gZm5cbiAqL1xuUHJpb3JpdHlRdWV1ZS5wcm90b3R5cGUuZm9yRWFjaCA9IGZ1bmN0aW9uKGZuKSB7XG4gIHJldHVybiB0aGlzLl9lbGVtZW50cy5mb3JFYWNoKGZuKTtcbn07XG5cbi8qKlxuICogQ29tcGFyZXMgdGhlIHZhbHVlcyBhdCBwb3NpdGlvbiBgYWAgYW5kIGBiYCBpbiB0aGUgcHJpb3JpdHkgcXVldWUgdXNpbmcgaXRzXG4gKiBjb21wYXJhdG9yIGZ1bmN0aW9uLlxuICpcbiAqIEBwYXJhbSB7TnVtYmVyfSBhXG4gKiBAcGFyYW0ge051bWJlcn0gYlxuICogQHJldHVybiB7TnVtYmVyfVxuICogQGFwaSBwcml2YXRlXG4gKi9cblByaW9yaXR5UXVldWUucHJvdG90eXBlLl9jb21wYXJlID0gZnVuY3Rpb24oYSwgYikge1xuICByZXR1cm4gdGhpcy5fY29tcGFyYXRvcih0aGlzLl9lbGVtZW50c1thXSwgdGhpcy5fZWxlbWVudHNbYl0pO1xufTtcblxuLyoqXG4gKiBTd2FwcyB0aGUgdmFsdWVzIGF0IHBvc2l0aW9uIGBhYCBhbmQgYGJgIGluIHRoZSBwcmlvcml0eSBxdWV1ZS5cbiAqXG4gKiBAcGFyYW0ge051bWJlcn0gYVxuICogQHBhcmFtIHtOdW1iZXJ9IGJcbiAqIEBhcGkgcHJpdmF0ZVxuICovXG5Qcmlvcml0eVF1ZXVlLnByb3RvdHlwZS5fc3dhcCA9IGZ1bmN0aW9uKGEsIGIpIHtcbiAgdmFyIGF1eCA9IHRoaXMuX2VsZW1lbnRzW2FdO1xuICB0aGlzLl9lbGVtZW50c1thXSA9IHRoaXMuX2VsZW1lbnRzW2JdO1xuICB0aGlzLl9lbGVtZW50c1tiXSA9IGF1eDtcbn07XG4iLCJ2YXIgdmFsaWRhdG9ycyA9IFtcbiAgWyAvXihhXFw9Y2FuZGlkYXRlLiopJC8sIHJlcXVpcmUoJ3J0Yy12YWxpZGF0b3IvY2FuZGlkYXRlJykgXVxuXTtcblxudmFyIHJlU2RwTGluZUJyZWFrID0gLyhcXHI/XFxufFxcXFxyXFxcXG4pLztcblxuLyoqXG4gICMgcnRjLXNkcGNsZWFuXG5cbiAgUmVtb3ZlIGludmFsaWQgbGluZXMgZnJvbSB5b3VyIFNEUC5cblxuICAjIyBXaHk/XG5cbiAgVGhpcyBtb2R1bGUgcmVtb3ZlcyB0aGUgb2NjYXNpb25hbCBcImJhZCBlZ2dcIiB0aGF0IHdpbGwgc2xpcCBpbnRvIFNEUCB3aGVuIGl0XG4gIGlzIGdlbmVyYXRlZCBieSB0aGUgYnJvd3Nlci4gIEluIHBhcnRpY3VsYXIgdGhlc2Ugc2l0dWF0aW9ucyBhcmUgY2F0ZXJlZCBmb3I6XG5cbiAgLSBpbnZhbGlkIElDRSBjYW5kaWRhdGVzXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihpbnB1dCwgb3B0cykge1xuICB2YXIgbGluZUJyZWFrID0gZGV0ZWN0TGluZUJyZWFrKGlucHV0KTtcbiAgdmFyIGxpbmVzID0gaW5wdXQuc3BsaXQobGluZUJyZWFrKTtcbiAgdmFyIGNvbGxlY3RvciA9IChvcHRzIHx8IHt9KS5jb2xsZWN0b3I7XG5cbiAgLy8gZmlsdGVyIG91dCBpbnZhbGlkIGxpbmVzXG4gIGxpbmVzID0gbGluZXMuZmlsdGVyKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAvLyBpdGVyYXRlIHRocm91Z2ggdGhlIHZhbGlkYXRvcnMgYW5kIHVzZSB0aGUgb25lIHRoYXQgbWF0Y2hlc1xuICAgIHZhciB2YWxpZGF0b3IgPSB2YWxpZGF0b3JzLnJlZHVjZShmdW5jdGlvbihtZW1vLCBkYXRhLCBpZHgpIHtcbiAgICAgIHJldHVybiB0eXBlb2YgbWVtbyAhPSAndW5kZWZpbmVkJyA/IG1lbW8gOiAoZGF0YVswXS5leGVjKGxpbmUpICYmIHtcbiAgICAgICAgbGluZTogbGluZS5yZXBsYWNlKGRhdGFbMF0sICckMScpLFxuICAgICAgICBmbjogZGF0YVsxXVxuICAgICAgfSk7XG4gICAgfSwgdW5kZWZpbmVkKTtcblxuICAgIC8vIGlmIHdlIGhhdmUgYSB2YWxpZGF0b3IsIGVuc3VyZSB3ZSBoYXZlIG5vIGVycm9yc1xuICAgIHZhciBlcnJvcnMgPSB2YWxpZGF0b3IgPyB2YWxpZGF0b3IuZm4odmFsaWRhdG9yLmxpbmUpIDogW107XG5cbiAgICAvLyBpZiB3ZSBoYXZlIGVycm9ycyBhbmQgYW4gZXJyb3IgY29sbGVjdG9yLCB0aGVuIGFkZCB0byB0aGUgY29sbGVjdG9yXG4gICAgaWYgKGNvbGxlY3Rvcikge1xuICAgICAgZXJyb3JzLmZvckVhY2goZnVuY3Rpb24oZXJyKSB7XG4gICAgICAgIGNvbGxlY3Rvci5wdXNoKGVycik7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gZXJyb3JzLmxlbmd0aCA9PT0gMDtcbiAgfSk7XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4obGluZUJyZWFrKTtcbn07XG5cbmZ1bmN0aW9uIGRldGVjdExpbmVCcmVhayhpbnB1dCkge1xuICB2YXIgbWF0Y2ggPSByZVNkcExpbmVCcmVhay5leGVjKGlucHV0KTtcblxuICByZXR1cm4gbWF0Y2ggJiYgbWF0Y2hbMF07XG59XG4iLCJ2YXIgZGVidWcgPSByZXF1aXJlKCdjb2cvbG9nZ2VyJykoJ3J0Yy12YWxpZGF0b3InKTtcbnZhciByZVByZWZpeCA9IC9eKD86YT0pP2NhbmRpZGF0ZTovO1xudmFyIHJlSVAgPSAvXihcXGQrXFwuKXszfVxcZCskLztcblxuLypcblxudmFsaWRhdGlvbiBydWxlcyBhcyBwZXI6XG5odHRwOi8vdG9vbHMuaWV0Zi5vcmcvaHRtbC9kcmFmdC1pZXRmLW1tdXNpYy1pY2Utc2lwLXNkcC0wMyNzZWN0aW9uLTguMVxuXG4gICBjYW5kaWRhdGUtYXR0cmlidXRlICAgPSBcImNhbmRpZGF0ZVwiIFwiOlwiIGZvdW5kYXRpb24gU1AgY29tcG9uZW50LWlkIFNQXG4gICAgICAgICAgICAgICAgICAgICAgICAgICB0cmFuc3BvcnQgU1BcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIHByaW9yaXR5IFNQXG4gICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0aW9uLWFkZHJlc3MgU1AgICAgIDtmcm9tIFJGQyA0NTY2XG4gICAgICAgICAgICAgICAgICAgICAgICAgICBwb3J0ICAgICAgICAgO3BvcnQgZnJvbSBSRkMgNDU2NlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgU1AgY2FuZC10eXBlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICBbU1AgcmVsLWFkZHJdXG4gICAgICAgICAgICAgICAgICAgICAgICAgICBbU1AgcmVsLXBvcnRdXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAqKFNQIGV4dGVuc2lvbi1hdHQtbmFtZSBTUFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHRlbnNpb24tYXR0LXZhbHVlKVxuXG4gICBmb3VuZGF0aW9uICAgICAgICAgICAgPSAxKjMyaWNlLWNoYXJcbiAgIGNvbXBvbmVudC1pZCAgICAgICAgICA9IDEqNURJR0lUXG4gICB0cmFuc3BvcnQgICAgICAgICAgICAgPSBcIlVEUFwiIC8gdHJhbnNwb3J0LWV4dGVuc2lvblxuICAgdHJhbnNwb3J0LWV4dGVuc2lvbiAgID0gdG9rZW4gICAgICAgICAgICAgIDsgZnJvbSBSRkMgMzI2MVxuICAgcHJpb3JpdHkgICAgICAgICAgICAgID0gMSoxMERJR0lUXG4gICBjYW5kLXR5cGUgICAgICAgICAgICAgPSBcInR5cFwiIFNQIGNhbmRpZGF0ZS10eXBlc1xuICAgY2FuZGlkYXRlLXR5cGVzICAgICAgID0gXCJob3N0XCIgLyBcInNyZmx4XCIgLyBcInByZmx4XCIgLyBcInJlbGF5XCIgLyB0b2tlblxuICAgcmVsLWFkZHIgICAgICAgICAgICAgID0gXCJyYWRkclwiIFNQIGNvbm5lY3Rpb24tYWRkcmVzc1xuICAgcmVsLXBvcnQgICAgICAgICAgICAgID0gXCJycG9ydFwiIFNQIHBvcnRcbiAgIGV4dGVuc2lvbi1hdHQtbmFtZSAgICA9IHRva2VuXG4gICBleHRlbnNpb24tYXR0LXZhbHVlICAgPSAqVkNIQVJcbiAgIGljZS1jaGFyICAgICAgICAgICAgICA9IEFMUEhBIC8gRElHSVQgLyBcIitcIiAvIFwiL1wiXG4qL1xudmFyIHBhcnRWYWxpZGF0aW9uID0gW1xuICBbIC8uKy8sICdpbnZhbGlkIGZvdW5kYXRpb24gY29tcG9uZW50JywgJ2ZvdW5kYXRpb24nIF0sXG4gIFsgL1xcZCsvLCAnaW52YWxpZCBjb21wb25lbnQgaWQnLCAnY29tcG9uZW50LWlkJyBdLFxuICBbIC8oVURQfFRDUCkvaSwgJ3RyYW5zcG9ydCBtdXN0IGJlIFRDUCBvciBVRFAnLCAndHJhbnNwb3J0JyBdLFxuICBbIC9cXGQrLywgJ251bWVyaWMgcHJpb3JpdHkgZXhwZWN0ZWQnLCAncHJpb3JpdHknIF0sXG4gIFsgcmVJUCwgJ2ludmFsaWQgY29ubmVjdGlvbiBhZGRyZXNzJywgJ2Nvbm5lY3Rpb24tYWRkcmVzcycgXSxcbiAgWyAvXFxkKy8sICdpbnZhbGlkIGNvbm5lY3Rpb24gcG9ydCcsICdjb25uZWN0aW9uLXBvcnQnIF0sXG4gIFsgL3R5cC8sICdFeHBlY3RlZCBcInR5cFwiIGlkZW50aWZpZXInLCAndHlwZSBjbGFzc2lmaWVyJyBdLFxuICBbIC8uKy8sICdJbnZhbGlkIGNhbmRpZGF0ZSB0eXBlIHNwZWNpZmllZCcsICdjYW5kaWRhdGUtdHlwZScgXVxuXTtcblxuLyoqXG4gICMjIyBgcnRjLXZhbGlkYXRvci9jYW5kaWRhdGVgXG5cbiAgVmFsaWRhdGUgdGhhdCBhbiBgUlRDSWNlQ2FuZGlkYXRlYCAob3IgcGxhaW4gb2xkIG9iamVjdCB3aXRoIGRhdGEsIHNkcE1pZCxcbiAgZXRjIGF0dHJpYnV0ZXMpIGlzIGEgdmFsaWQgaWNlIGNhbmRpZGF0ZS5cblxuICBTcGVjcyByZXZpZXdlZCBhcyBwYXJ0IG9mIHRoZSB2YWxpZGF0aW9uIGltcGxlbWVudGF0aW9uOlxuXG4gIC0gPGh0dHA6Ly90b29scy5pZXRmLm9yZy9odG1sL2RyYWZ0LWlldGYtbW11c2ljLWljZS1zaXAtc2RwLTAzI3NlY3Rpb24tOC4xPlxuICAtIDxodHRwOi8vdG9vbHMuaWV0Zi5vcmcvaHRtbC9yZmM1MjQ1PlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oZGF0YSkge1xuICB2YXIgZXJyb3JzID0gW107XG4gIHZhciBjYW5kaWRhdGUgPSBkYXRhICYmIChkYXRhLmNhbmRpZGF0ZSB8fCBkYXRhKTtcbiAgdmFyIHByZWZpeE1hdGNoID0gY2FuZGlkYXRlICYmIHJlUHJlZml4LmV4ZWMoY2FuZGlkYXRlKTtcbiAgdmFyIHBhcnRzID0gcHJlZml4TWF0Y2ggJiYgY2FuZGlkYXRlLnNsaWNlKHByZWZpeE1hdGNoWzBdLmxlbmd0aCkuc3BsaXQoL1xccy8pO1xuXG4gIGlmICghIGNhbmRpZGF0ZSkge1xuICAgIHJldHVybiBbIG5ldyBFcnJvcignZW1wdHkgY2FuZGlkYXRlJykgXTtcbiAgfVxuXG4gIC8vIGNoZWNrIHRoYXQgdGhlIHByZWZpeCBtYXRjaGVzIGV4cGVjdGVkXG4gIGlmICghIHByZWZpeE1hdGNoKSB7XG4gICAgcmV0dXJuIFsgbmV3IEVycm9yKCdjYW5kaWRhdGUgZGlkIG5vdCBtYXRjaCBleHBlY3RlZCBzZHAgbGluZSBmb3JtYXQnKSBdO1xuICB9XG5cbiAgLy8gcGVyZm9ybSB0aGUgcGFydCB2YWxpZGF0aW9uXG4gIGVycm9ycyA9IGVycm9ycy5jb25jYXQocGFydHMubWFwKHZhbGlkYXRlUGFydHMpKS5maWx0ZXIoQm9vbGVhbik7XG5cbiAgcmV0dXJuIGVycm9ycztcbn07XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUGFydHMocGFydCwgaWR4KSB7XG4gIHZhciB2YWxpZGF0b3IgPSBwYXJ0VmFsaWRhdGlvbltpZHhdO1xuXG4gIGlmICh2YWxpZGF0b3IgJiYgKCEgdmFsaWRhdG9yWzBdLnRlc3QocGFydCkpKSB7XG4gICAgZGVidWcodmFsaWRhdG9yWzJdICsgJyBwYXJ0IGZhaWxlZCB2YWxpZGF0aW9uOiAnICsgcGFydCk7XG4gICAgcmV0dXJuIG5ldyBFcnJvcih2YWxpZGF0b3JbMV0pO1xuICB9XG59XG4iXX0=
