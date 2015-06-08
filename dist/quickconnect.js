(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.quickconnect = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/* jshint node: true */
/* global location */
'use strict';

var rtc = require('rtc-tools');
var mbus = require('mbus');
var detectPlugin = require('rtc-core/plugin');
var debug = rtc.logger('rtc-quickconnect');
var extend = require('cog/extend');

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
  var signaller = require('rtc-pluggable-signaller')(extend({
    signaller: signalhost,

    // use the primus endpoint as a fallback in case we are talking to an
    // older switchboard instance
    endpoints: ['/', '/primus']
  }, opts));
  var getPeerData = require('./lib/getpeerdata')(signaller.peers);

  // init configurable vars
  var ns = (opts || {}).ns || '';
  var room = (opts || {}).room;
  var debugging = (opts || {}).debug;
  var allowJoin = !(opts || {}).manualJoin;
  var profile = {};
  var announced = false;

  // initialise iceServers to undefined
  // we will not announce until these have been properly initialised
  var iceServers;

  // collect the local streams
  var localStreams = [];

  // create the calls map
  var calls = signaller.calls = require('./lib/calls')(signaller, opts);

  // create the known data channels registry
  var channels = {};

  // save the plugins passed to the signaller
  var plugins = signaller.plugins = (opts || {}).plugins || [];
  var plugin = detectPlugin(plugins);
  var pluginReady;

  // check how many local streams have been expected (default: 0)
  var expectedLocalStreams = parseInt((opts || {}).expectedLocalStreams, 10) || 0;
  var announceTimer = 0;
  var updateTimer = 0;

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
    calls.end(id);

    // create a peer connection
    // iceServers that have been created using genice taking precendence
    pc = rtc.createConnection(
      extend({}, opts, { iceServers: iceServers }),
      (opts || {}).constraints
    );

    signaller('peer:connect', data.id, pc, data);

    // add this connection to the calls list
    calls.create(data.id, pc);

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
    monitor.once('connected', calls.start.bind(null, id, pc, data));
    monitor.once('closed', calls.end.bind(null, id));

    // if we are the master connnection, create the offer
    // NOTE: this only really for the sake of politeness, as rtc couple
    // implementation handles the slave attempting to create an offer
    if (signaller.isMaster(id)) {
      monitor.createOffer();
    }
  }

  function getActiveCall(peerId) {
    var call = calls.get(peerId);

    if (! call) {
      throw new Error('No active call for peer: ' + peerId);
    }

    return call;
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
    calls.keys().forEach(calls.end);
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
  signaller.on('message:ping', calls.ping);

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

},{"./lib/calls":2,"./lib/getpeerdata":3,"cog/extend":6,"mbus":12,"rtc-core/genice":14,"rtc-core/plugin":16,"rtc-pluggable-signaller":17,"rtc-tools":50}],2:[function(require,module,exports){
(function (process){
var rtc = require('rtc-tools');
var debug = rtc.logger('rtc-quickconnect');
var cleanup = require('rtc-tools/cleanup');
var getable = require('cog/getable');

module.exports = function(signaller, opts) {
  var calls = getable({});
  var getPeerData = require('./getpeerdata')(signaller.peers);
  var heartbeat;

  function create(id, pc) {
    calls.set(id, {
      active: false,
      pc: pc,
      channels: getable({}),
      streams: [],
      lastping: Date.now()
    });
  }

  function createStreamAddHandler(id) {
    return function(evt) {
      debug('peer ' + id + ' added stream');
      updateRemoteStreams(id);
      receiveRemoteStream(id)(evt.stream);
    };
  }

  function createStreamRemoveHandler(id) {
    return function(evt) {
      debug('peer ' + id + ' removed stream');
      updateRemoteStreams(id);
      signaller('stream:removed', id, evt.stream);
    };
  }

  function end(id) {
    var call = calls.get(id);

    // if we have no data, then do nothing
    if (! call) {
      return;
    }

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
      resetHeartbeat();
    }

    // trigger the call:ended event
    signaller('call:ended', id, call.pc);

    // ensure the peer connection is properly cleaned up
    cleanup(call.pc);
  }

  function ping(sender) {
    var call = calls.get(sender && sender.id);

    // set the last ping for the data
    if (call) {
      call.lastping = Date.now();
    }
  }

  function receiveRemoteStream(id) {
    return function(stream) {
      signaller('stream:added', id, stream, getPeerData(id));
    };
  }

  function resetHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = 0;
  }

  function start(id, pc, data) {
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
    heartbeat = heartbeat || require('./heartbeat')(signaller, calls, opts);

    // examine the existing remote streams after a short delay
    process.nextTick(function() {
      // iterate through any remote streams
      streams.forEach(receiveRemoteStream(id));
    });
  }

  function updateRemoteStreams(id) {
    var call = calls.get(id);

    if (call && call.pc) {
      call.streams = [].concat(call.pc.getRemoteStreams());
    }
  }

  calls.create = create;
  calls.end = end;
  calls.ping = ping;
  calls.start = start;

  return calls;
};

}).call(this,require('_process'))

},{"./getpeerdata":3,"./heartbeat":4,"_process":11,"cog/getable":7,"rtc-tools":50,"rtc-tools/cleanup":46}],3:[function(require,module,exports){
module.exports = function(peers) {
  return function(id) {
    var peer = peers.get(id);
    return peer && peer.data;
  };
};

},{}],4:[function(require,module,exports){
module.exports = function(signaller, calls, opts) {
  var heartbeat = (opts || {}).heartbeat || 2500;
  var heartbeatTimer = 0;

  function send() {
    var tickInactive = (Date.now() - (heartbeat * 4));

    // iterate through our established calls
    calls.keys().forEach(function(id) {
      var call = calls.get(id);

      // if the call ping is too old, end the call
      if (call.lastping < tickInactive) {
        return calls.end(id);
      }

      // send a ping message
      signaller.to(id).send('/ping');
    });
  }

  if (! heartbeat) {
    return;
  }

  return setInterval(send, heartbeat);
};

},{}],5:[function(require,module,exports){
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
},{}],6:[function(require,module,exports){
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
},{}],7:[function(require,module,exports){
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

},{}],8:[function(require,module,exports){
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
},{}],9:[function(require,module,exports){
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
},{}],10:[function(require,module,exports){
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
},{}],11:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            currentQueue[queueIndex].run();
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        setTimeout(drainQueue, 0);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

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

},{}],12:[function(require,module,exports){
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

},{}],13:[function(require,module,exports){
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
/**
  # rtc-pluggable-signaller

  By using `rtc-pluggable-signaller` in your code, you provide the ability
  for your package to customize which signalling client it uses (and
  thus have significant control) over how signalling operates in your
  environment.

  ## How it Works

  The pluggable signaller looks in the provided `opts` for a `signaller`
  attribute.  If the value of this attribute is a string, then it is
  assumed that you wish to use the default
  [`rtc-signaller`](https://github.com/rtc-io/rtc-signaller) in your
  package.  If, however, it is not a string value then it will be passed
  straight back as the signaller (assuming that you have provided an
  object that is compliant with the rtc.io signalling API).

**/
module.exports = function(opts) {
  var signaller = (opts || {}).signaller;
  var messenger = (opts || {}).messenger || require('rtc-switchboard-messenger');

  if (typeof signaller == 'string' || (signaller instanceof String)) {
    return require('rtc-signaller')(messenger(signaller, opts), opts);
  }

  return signaller;
};

},{"rtc-signaller":18,"rtc-switchboard-messenger":37}],18:[function(require,module,exports){
/* jshint node: true */
'use strict';

var detect = require('rtc-core/detect');
var extend = require('cog/extend');
var mbus = require('mbus');
var getable = require('cog/getable');
var uuid = require('cuid');
var pull = require('pull-stream');
var pushable = require('pull-pushable');
var prepare = require('rtc-signal/prepare');
var createQueue = require('pull-pushable');

// ready state constants
var RS_DISCONNECTED = 0;
var RS_CONNECTING = 1;
var RS_CONNECTED = 2;

// initialise signaller metadata so we don't have to include the package.json
// TODO: make this checkable with some kind of prepublish script
var metadata = {
  version: '6.2.1'
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

  <<< docs/identifying-participants.md

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
  var autoconnect = (opts || {}).autoconnect;
  var reconnect = (opts || {}).reconnect;
  var queue = createQueue();
  var connectionCount = 0;

  // create the signaller
  var signaller = require('rtc-signal/signaller')(opts, bufferMessage);

  var announced = false;
  var announceTimer = 0;
  var readyState = RS_DISCONNECTED;

  function bufferMessage(message) {
    queue.push(message);

    // if we are not connected (and should autoconnect), then attempt connection
    if (readyState === RS_DISCONNECTED && (autoconnect === undefined || autoconnect)) {
      connect();
    }
  }

  function handleDisconnect() {
    if (reconnect === undefined || reconnect) {
      setTimeout(connect, 50);
    }
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

      // increment the connection count
      connectionCount += 1;

      // flag as connected
      readyState = RS_CONNECTED;

      // pass messages to the processor
      pull(
        source,

        // monitor disconnection
        pull.through(null, function() {
          queue = createQueue();
          readyState = RS_DISCONNECTED;
          signaller('disconnected');
        }),
        pull.drain(signaller._process)
      );

      // pass the queue to the sink
      pull(queue, sink);

      // handle disconnection
      signaller.removeListener('disconnected', handleDisconnect);
      signaller.on('disconnected', handleDisconnect);

      // trigger the connected event
      signaller('connected');

      // if this is a reconnection, then reannounce
      if (announced && connectionCount > 1) {
        signaller._announce();
      }
    });
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
  signaller.announce = function(data) {
    announced = true;
    signaller._update(data);
    clearTimeout(announceTimer);

    // send the attributes over the network
    return announceTimer = setTimeout(signaller._announce, (opts || {}).announceDelay || 10);
  };

  /**
    ### leave()

    Tell the signalling server we are leaving.  Calling this function is
    usually not required though as the signalling server should issue correct
    `/leave` messages when it detects a disconnect event.

  **/
  signaller.leave = signaller.close = function() {
    // send the leave signal
    signaller.send('/leave', { id: signaller.id });

    // stop announcing on reconnect
    signaller.removeListener('disconnected', handleDisconnect);
    signaller.removeListener('connected', signaller._announce);

    // end our current queue
    queue.end();

    // set connected to false
    readyState = RS_DISCONNECTED;
  };

  // update the signaller agent
  signaller._update({ agent: 'signaller@' + metadata.version });

  // autoconnect
  if (autoconnect === undefined || autoconnect) {
    connect();
  }

  return signaller;
};

},{"cog/extend":6,"cog/getable":7,"cuid":19,"mbus":12,"pull-pushable":20,"pull-stream":27,"rtc-core/detect":13,"rtc-signal/prepare":34,"rtc-signal/signaller":36}],19:[function(require,module,exports){
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

},{"./sinks":24,"./sources":25,"_process":11,"pull-core":23}],27:[function(require,module,exports){
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


},{}],30:[function(require,module,exports){
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

function abortCb(cb, abort, onAbort) {
  cb(abort)
  onAbort && onAbort(abort === true ? null: abort)
  return
}

var once = exports.once =
function (value, onAbort) {
  return function (abort, cb) {
    if(abort)
      return abortCb(cb, abort, onAbort)
    if(value != null) {
      var _value = value; value = null
      cb(null, _value)
    } else
      cb(true)
  }
}

var values = exports.values = exports.readArray =
function (array, onAbort) {
  if(!array)
    return function (abort, cb) {
      if(abort) return abortCb(cb, abort, onAbort)
      return cb(true)
    }
  if(!Array.isArray(array))
    array = Object.keys(array).map(function (k) {
      return array[k]
    })
  var i = 0
  return function (abort, cb) {
    if(abort)
      return abortCb(cb, abort, onAbort)
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

},{"./sinks":30,"./sources":31,"_process":11,"pull-core":29}],33:[function(require,module,exports){
var extend = require('cog/extend');

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
      if (peer) {
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

},{"cog/extend":6}],34:[function(require,module,exports){
/**
  ### prepare

  ```
  fn(args) => String
  ```

  Convert an array of values into a pipe-delimited string.

**/
module.exports = function(args) {
  return args.map(prepareArg).join('|');
};

function prepareArg(arg) {
  if (typeof arg == 'object' && (! (arg instanceof String))) {
    return JSON.stringify(arg);
  }
  else if (typeof arg == 'function') {
    return null;
  }

  return arg;
}

},{}],35:[function(require,module,exports){
var jsonparse = require('cog/jsonparse');

/**
  ### process

  ```
  fn(signaller, opts) => fn(message)
  ```

  The core processing logic that is used to respond to incoming signaling
  messages.

**/
module.exports = function(signaller, opts) {
  var handlers = {
    announce: require('./handlers/announce')(signaller, opts)
  };

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
      if (srcData === signaller.id) {
        return console.warn('got data from ourself, discarding');
      }

      // get the source state
      srcState = signaller.peers.get(srcData) || srcData;

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

},{"./handlers/announce":33,"cog/jsonparse":8}],36:[function(require,module,exports){
var detect = require('rtc-core/detect');
var extend = require('cog/extend');
var getable = require('cog/getable');
var cuid = require('cuid');
var mbus = require('mbus');
var prepare = require('./prepare');

/**
  ## `signaller(opts, bufferMessage) => mbus`

  Create a base level signaller which is capable of processing
  messages from an incoming source.  The signaller is capable of
  sending messages outbound using the `bufferMessage` function
  that is supplied to the signaller.

**/
module.exports = function(opts, bufferMessage) {
  // get the autoreply setting
  var autoreply = (opts || {}).autoreply;

  // create the signaller mbus
  var signaller = mbus('', (opts || {}).logger);

  // initialise the peers
  var peers = signaller.peers = getable({});

  // initialise the signaller attributes
  var attributes = signaller.attributes = {
    browser: detect.browser,
    browserVersion: detect.browserVersion,
    agent: 'unknown'
  };

  function createToMessage(header) {
    return function() {
      var args = header.concat([].slice.call(arguments));

      // inject the signaller.id
      args.splice(3, 0, signaller.id);
      bufferMessage(prepare(args));
    }
  }

  // initialise the signaller id
  signaller.id = (opts || {}).id || cuid();

  /**
    #### `isMaster(targetId) => Boolean`

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
    #### `send(args*)`

    Prepare a message for sending, e.g.:

    ```js
    signaller.send('/foo', 'bar');
    ```

  **/
  signaller.send = function() {
    var args = [].slice.call(arguments);

    // inject the metadata
    args.splice(1, 0, signaller.id);

    // send the message
    bufferMessage(prepare(args));
  };


  /**
    #### `to(targetId)`

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
    return {
      send: createToMessage(['/to', targetId])
    };
  };

  /**
    ### Signaller Internals

    The following functions are designed for use by signallers that are built
    on top of this base signaller.
  **/

  /**
    #### `_announce()`

    The internal function that constructs the `/announce` message and triggers
    the `local:announce` event.

  **/
  signaller._announce = function() {
    signaller.send('/announce', attributes);
    signaller('local:announce', attributes);
  };

  /**
    #### `_process(data)`


  **/
  signaller._process = require('./process')(signaller);

  /**
    #### `_update`

    Internal function that updates core announce attributes with
    updated data.

**/
  signaller._update = function(data) {
    extend(attributes, data, { id: signaller.id });
  };

  // set the autoreply flag
  signaller.autoreply = autoreply === undefined || autoreply;

  return signaller;
};

},{"./prepare":34,"./process":35,"cog/extend":6,"cog/getable":7,"cuid":19,"mbus":12,"rtc-core/detect":13}],37:[function(require,module,exports){
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
    endpoints: (opts || {}).endpoints || ['/']
  }, opts));
};

},{"cog/extend":6,"messenger-ws":38}],38:[function(require,module,exports){
var WebSocket = require('ws');
var wsurl = require('wsurl');
var ps = require('pull-ws');
var defaults = require('cog/defaults');
var reTrailingSlash = /\/$/;
var DEFAULT_FAILCODES = [];

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
  var failcodes = (opts || {}).failcodes || DEFAULT_FAILCODES;
  var endpoints = ((opts || {}).endpoints || ['/']).map(function(endpoint) {
    return url.replace(reTrailingSlash, '') + endpoint;
  });

  function connect(callback) {
    var queue = [].concat(endpoints);
    var isConnected = false;
    var socket;
    var failTimer;
    var successTimer;
    var removeListener;
    var source;

    function attemptNext() {
      // if we have already connected, do nothing
      // NOTE: workaround for websockets/ws#489
      if (isConnected) {
        return;
      }

      // if we have no more valid endpoints, then erorr out
      if (queue.length === 0) {
        return callback(new Error('Unable to connect to url: ' + url));
      }

      socket = new WebSocket(wsurl(queue.shift()));
      socket.addEventListener('message', connect);
      socket.addEventListener('error', handleError);
      socket.addEventListener('close', handleClose);
      socket.addEventListener('open', handleOpen);

      removeListener = socket.removeEventListener || socket.removeListener;
      failTimer = setTimeout(attemptNext, timeout);
    }

    function connect() {
      // if we are already connected, abort
      // NOTE: workaround for websockets/ws#489
      if (isConnected) {
        return;
      }

      // clear any monitors
      clearTimeout(failTimer);
      clearTimeout(successTimer);

      // remove the close and error listeners as messenger-ws has done
      // what it set out to do and that is create a connection
      // NOTE: issue websockets/ws#489 causes means this fails in ws
      removeListener.call(socket, 'open', handleOpen);
      removeListener.call(socket, 'close', handleClose);
      removeListener.call(socket, 'error', handleError);
      removeListener.call(socket, 'message', connect);

      // trigger the callback
      isConnected = true;
      callback(null, source, ps.sink(socket, opts));
    }

    function handleClose(evt) {
      var clean = evt.wasClean && (
        evt.code === undefined || failcodes.indexOf(evt.code) < 0
      );

      // if this was not a clean close, then handle error
      if (! clean) {
        return handleError();
      }

      clearTimeout(successTimer);
      clearTimeout(failTimer);
    }

    function handleError() {
      clearTimeout(successTimer);
      clearTimeout(failTimer);
      attemptNext();
    }

    function handleOpen() {
      // create the source immediately to buffer any data
      source = ps.source(socket, opts);

      // monitor data flowing from the socket
      successTimer = setTimeout(connect, 100);
    }

    attemptNext();
  }

  return connect;
};

},{"cog/defaults":5,"pull-ws":39,"ws":44,"wsurl":45}],39:[function(require,module,exports){
exports = module.exports = duplex;

exports.source = require('./source');
exports.sink = require('./sink');

function duplex (ws, opts) {
  return {
    source: exports.source(ws),
    sink: exports.sink(ws, opts)
  };
};

},{"./sink":42,"./source":43}],40:[function(require,module,exports){
arguments[4][29][0].apply(exports,arguments)
},{"dup":29}],41:[function(require,module,exports){
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

},{}],42:[function(require,module,exports){
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

},{"./ready":41,"_process":11,"pull-core":40}],43:[function(require,module,exports){
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

},{"./ready":41,"pull-core":40}],44:[function(require,module,exports){

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

},{}],45:[function(require,module,exports){
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

},{}],46:[function(require,module,exports){
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

},{"cog/logger":9}],47:[function(require,module,exports){
/* jshint node: true */
'use strict';

var mbus = require('mbus');
var queue = require('rtc-taskqueue');
var cleanup = require('./cleanup');
var monitor = require('./monitor');
var throttle = require('cog/throttle');
var pluck = require('whisk/pluck');
var pluckCandidate = pluck('candidate', 'sdpMid', 'sdpMLineIndex');
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
    var data = evt.candidate && pluckCandidate(evt.candidate);

    if (evt.candidate) {
      resetDisconnectTimer();
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

},{"./cleanup":46,"./monitor":51,"cog/logger":9,"cog/throttle":10,"mbus":12,"rtc-taskqueue":52,"whisk/pluck":63}],48:[function(require,module,exports){
/* jshint node: true */
'use strict';

/**
  ### rtc-tools/detect

  Provide the [rtc-core/detect](https://github.com/rtc-io/rtc-core#detect)
  functionality.
**/
module.exports = require('rtc-core/detect');

},{"rtc-core/detect":13}],49:[function(require,module,exports){
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

},{"./detect":48,"cog/defaults":5,"cog/logger":9}],50:[function(require,module,exports){
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

},{"./couple":47,"./detect":48,"./generators":49,"cog/logger":9,"rtc-core/plugin":16}],51:[function(require,module,exports){
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

},{"mbus":12}],52:[function(require,module,exports){
var detect = require('rtc-core/detect');
var findPlugin = require('rtc-core/plugin');
var PriorityQueue = require('priorityqueuejs');
var pluck = require('whisk/pluck');
var pluckSessionDesc = pluck('sdp', 'type');

// some validation routines
var checkCandidate = require('rtc-validator/candidate');

// the sdp cleaner
var sdpclean = require('rtc-sdpclean');
var parseSdp = require('rtc-sdp');

var PRIORITY_LOW = 100;
var PRIORITY_WAIT = 1000;

// priority order (lower is better)
var DEFAULT_PRIORITIES = [
  'addIceCandidate',
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

var MEDIA_MAPPINGS = {
  data: 'application'
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
  var queueInterval = (opts || {}).interval || 50;

  // check for plugin usage
  var plugin = findPlugin((opts || {}).plugins);

  // initialise state tracking
  var checkQueueTimer = 0;
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
    // Allow selective filtering of ICE candidates
    if (opts && opts.filterCandidate && !opts.filterCandidate(data)) {
      tq('ice.remote.filtered', candidate);
      return next();
    }
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
    var next = (! queue.isEmpty()) && queue.peek();
    var ready = next && testReady(next);

    // reset the queue timer
    checkQueueTimer = 0;

    // if we don't have a task ready, then abort
    if (! ready) {
      // if we have a task and it has expired then dequeue it
      if (next && expired(next)) {
        tq('task.expire', next);
        queue.deq();
      }

      return (! queue.isEmpty()) && isNotClosed(pc) && triggerQueueCheck();
    }

    // properly dequeue task
    next = queue.deq();

    // process the task
    next.fn(next, function(err) {
      var fail = next.fail || defaultFail;
      var pass = next.pass;
      var taskName = next.name;

      // if errored, fail
      if (err) {
        console.error(taskName + ' task failed: ', err);
        return fail(err);
      }

      if (typeof pass == 'function') {
        pass.apply(next, [].slice.call(arguments, 1));
      }

      triggerQueueCheck();
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
    tq('sdp.local', pluckSessionDesc(this.args[0]));
  }

  function enqueue(name, handler, opts) {
    return function() {
      var args = [].slice.call(arguments);

      if (opts && typeof opts.processArgs == 'function') {
        args = args.map(opts.processArgs);
      }

      var priority = priorities.indexOf(name);

      queue.enq({
        args: args,
        name: name,
        fn: handler,
        priority: priority >= 0 ? priority : PRIORITY_LOW,

        // record the time at which the task was queued
        start: Date.now(),

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

    if (! fn) {
      return next(new Error('cannot call "' + task.name + '" on RTCPeerConnection'));
    }

    // invoke the function
    tq.apply(tq, ['negotiate.' + eventName].concat(task.args));
    fn.apply(
      pc,
      task.args.concat(cbArgs).concat(isOffer ? generateConstraints() : [])
    );
  }

  function expired(task) {
    return (typeof task.ttl == 'number') && (task.start + task.ttl < Date.now());
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

  function isConnReadyForCandidate(pc, data) {
    var sdpMid = data.args[0] && data.args[0].sdpMid;

    // remap media types as appropriate
    sdpMid = MEDIA_MAPPINGS[sdpMid] || sdpMid;

    if (sdpMid === '')
      return true;

    if (!pc.__mediaTypes) {
      var sdp = parseSdp(pc.remoteDescription && pc.remoteDescription.sdp);
      pc.__mediaTypes = sdp.getMediaTypes();
    }

    // the candidate is valid if we know about the media type
    return pc.__mediaTypes.indexOf(sdpMid) >= 0;
  }

  function orderTasks(a, b) {
    // apply each of the checks for each task
    var tasks = [a,b];
    var readiness = tasks.map(testReady);
    var taskPriorities = tasks.map(function(task, idx) {
      var ready = readiness[idx];
      return ready ? task.priority : PRIORITY_WAIT;
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
    checkQueueTimer = setTimeout(checkQueue, queueInterval);
  }

  // patch in the queue helper methods
  tq.addIceCandidate = enqueue('addIceCandidate', applyCandidate, {
    processArgs: extractCandidateEventData,
    checks: [hasLocalOrRemoteDesc, isValidCandidate, isConnReadyForCandidate ],

    // set ttl to 5s
    ttl: 5000
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

},{"mbus":12,"priorityqueuejs":53,"rtc-core/detect":13,"rtc-core/plugin":16,"rtc-sdp":54,"rtc-sdpclean":56,"rtc-validator/candidate":57,"whisk/pluck":63}],53:[function(require,module,exports){
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

},{}],54:[function(require,module,exports){
/* jshint node: true */
'use strict';

var nub = require('whisk/nub');
var pluck = require('whisk/pluck');
var flatten = require('whisk/flatten');
var reLineBreak = /\r?\n/;
var reTrailingNewlines = /\r?\n$/;

// list sdp line types that are not "significant"
var nonHeaderLines = [ 'a', 'c', 'b', 'k' ];
var parsers = require('./parsers');

/**
  # rtc-sdp

  This is a utility module for intepreting and patching sdp.

  ## Usage

  The `rtc-sdp` main module exposes a single function that is capable of
  parsing lines of SDP, and providing an object allowing you to perform
  operations on those parsed lines:

  ```js
  var sdp = require('rtc-sdp')(lines);
  ```

  The currently supported operations are listed below:

**/
module.exports = function(sdp) {
  var ops = {};
  var parsed = [];
  var activeCollector;

  // initialise the lines
  var lines = sdp.split(reLineBreak).filter(Boolean).map(function(line) {
    return line.split('=');
  });

  var inputOrder = nub(lines.filter(function(line) {
    return line[0] && nonHeaderLines.indexOf(line[0]) < 0;
  }).map(pluck(0)));

  var findLine = ops.findLine = function(type, index) {
    var lineData = parsed.filter(function(line) {
      return line[0] === type;
    })[index || 0];

    return lineData && lineData[1];
  };

  // push into parsed sections
  lines.forEach(function(line) {
    var customParser = parsers[line[0]];

    if (customParser) {
      activeCollector = customParser(parsed, line);
    }
    else if (activeCollector) {
      activeCollector = activeCollector(line);
    }
    else {
      parsed.push(line);
    }
  });

  /**
    ### `sdp.addIceCandidate(data)`

    Modify the sdp to include candidates as denoted by the data.

**/
  ops.addIceCandidate = function(data) {
    var lineIndex = (data || {}).lineIndex || (data || {}).sdpMLineIndex;
    var mLine = typeof lineIndex != 'undefined' && findLine('m', lineIndex);
    var candidate = (data || {}).candidate;

    // if we have the mLine add the new candidate
    if (mLine && candidate) {
      mLine.childlines.push(candidate.replace(reTrailingNewlines, '').split('='));
    }
  };

  /**
    ### `sdp.getMediaTypes() => []`

    Retrieve the list of media types that have been defined in the sdp via
    `m=` lines.
  **/
  ops.getMediaTypes = function() {
    function getMediaType(data) {
      return data[1].def.split(/\s/)[0];
    }

    return parsed.filter(function(parts) {
      return parts[0] === 'm' && parts[1] && parts[1].def;
    }).map(getMediaType);
  };

  /**
    ### `sdp.toString()`

    Convert the SDP structure that is currently retained in memory, into a string
    that can be provided to a `setLocalDescription` (or `setRemoteDescription`)
    WebRTC call.

  **/
  ops.toString = function() {
    return parsed.map(function(line) {
      return typeof line[1].toArray == 'function' ? line[1].toArray() : [ line ];
    }).reduce(flatten).map(function(line) {
      return line.join('=');
    }).join('\n');
  };

  /**
    ## SDP Filtering / Munging Functions

    There are additional functions included in the module to assign with
    performing "single-shot" SDP filtering (or munging) operations:

  **/

  return ops;
};

},{"./parsers":55,"whisk/flatten":60,"whisk/nub":62,"whisk/pluck":63}],55:[function(require,module,exports){
/* jshint node: true */
'use strict';

exports.m = function(parsed, line) {
  var media = {
    def: line[1],
    childlines: [],

    toArray: function() {
      return [
        ['m', media.def ]
      ].concat(media.childlines);
    }
  };

  function addChildLine(childLine) {
    media.childlines.push(childLine);
    return addChildLine;
  }

  parsed.push([ 'm', media ]);

  return addChildLine;
};
},{}],56:[function(require,module,exports){
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

},{"rtc-validator/candidate":57}],57:[function(require,module,exports){
var debug = require('cog/logger')('rtc-validator');
var rePrefix = /^(?:a=)?candidate:/;

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
  [ require('reu/ip'), 'invalid connection address', 'connection-address' ],
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

},{"cog/logger":9,"reu/ip":58}],58:[function(require,module,exports){
/**
  ### `reu/ip`

  A regular expression that will match both IPv4 and IPv6 addresses.  This is a modified
  regex (remove hostname matching) that was implemented by @Mikulas in
  [this stackoverflow answer](http://stackoverflow.com/a/9209720/96656).

**/
module.exports = /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$|^(?:(?:(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):){6})(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:::(?:(?:(?:[0-9a-fA-F]{1,4})):){5})(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})))?::(?:(?:(?:[0-9a-fA-F]{1,4})):){4})(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):){0,1}(?:(?:[0-9a-fA-F]{1,4})))?::(?:(?:(?:[0-9a-fA-F]{1,4})):){3})(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):){0,2}(?:(?:[0-9a-fA-F]{1,4})))?::(?:(?:(?:[0-9a-fA-F]{1,4})):){2})(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):){0,3}(?:(?:[0-9a-fA-F]{1,4})))?::(?:(?:[0-9a-fA-F]{1,4})):)(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):){0,4}(?:(?:[0-9a-fA-F]{1,4})))?::)(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):){0,5}(?:(?:[0-9a-fA-F]{1,4})))?::)(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):){0,6}(?:(?:[0-9a-fA-F]{1,4})))?::))))$/;

},{}],59:[function(require,module,exports){
module.exports = function(a, b) {
  return arguments.length > 1 ? a === b : function(b) {
    return a === b;
  };
};

},{}],60:[function(require,module,exports){
/**
  ## flatten

  Flatten an array using `[].reduce`

  <<< examples/flatten.js

**/

module.exports = function(a, b) {
  // if a is not already an array, make it one
  a = Array.isArray(a) ? a : [a];

  // concat b with a
  return a.concat(b);
};
},{}],61:[function(require,module,exports){
module.exports = function(comparator) {
  return function(input) {
    var output = [];
    for (var ii = 0, count = input.length; ii < count; ii++) {
      var found = false;
      for (var jj = output.length; jj--; ) {
        found = found || comparator(input[ii], output[jj]);
      }

      if (found) {
        continue;
      }

      output[output.length] = input[ii];
    }

    return output;
  };
}
},{}],62:[function(require,module,exports){
/**
  ## nub

  Return only the unique elements of the list.

  <<< examples/nub.js

**/

module.exports = require('./nub-by')(require('./equality'));
},{"./equality":59,"./nub-by":61}],63:[function(require,module,exports){
/**
  ## pluck

  Extract targeted properties from a source object. When a single property
  value is requested, then just that value is returned.

  In the case where multiple properties are requested (in a varargs calling
  style) a new object will be created with the requested properties copied
  across.

  __NOTE:__ In the second form extraction of nested properties is
  not supported.

  <<< examples/pluck.js

**/
module.exports = function() {
  var fields = [];

  function extractor(parts, maxIdx) {
    return function(item) {
      var partIdx = 0;
      var val = item;

      do {
        val = val && val[parts[partIdx++]];
      } while (val && partIdx <= maxIdx);

      return val;
    };
  }

  [].slice.call(arguments).forEach(function(path) {
    var parts = typeof path == 'number' ? [ path ] : (path || '').split('.');

    fields[fields.length] = {
      name: parts[0],
      parts: parts,
      maxIdx: parts.length - 1
    };
  });

  if (fields.length <= 1) {
    return extractor(fields[0].parts, fields[0].maxIdx);
  }
  else {
    return function(item) {
      var data = {};

      for (var ii = 0, len = fields.length; ii < len; ii++) {
        data[fields[ii].name] = extractor([fields[ii].parts[0]], 0)(item);
      }

      return data;
    };
  }
};
},{}]},{},[1])(1)
});
//# sourceMappingURL=data:application/json;charset:utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9ncnVudC1icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJpbmRleC5qcyIsImxpYi9jYWxscy5qcyIsImxpYi9nZXRwZWVyZGF0YS5qcyIsImxpYi9oZWFydGJlYXQuanMiLCJub2RlX21vZHVsZXMvY29nL2RlZmF1bHRzLmpzIiwibm9kZV9tb2R1bGVzL2NvZy9leHRlbmQuanMiLCJub2RlX21vZHVsZXMvY29nL2dldGFibGUuanMiLCJub2RlX21vZHVsZXMvY29nL2pzb25wYXJzZS5qcyIsIm5vZGVfbW9kdWxlcy9jb2cvbG9nZ2VyLmpzIiwibm9kZV9tb2R1bGVzL2NvZy90aHJvdHRsZS5qcyIsIm5vZGVfbW9kdWxlcy9ncnVudC1icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9wcm9jZXNzL2Jyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvbWJ1cy9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtY29yZS9kZXRlY3QuanMiLCJub2RlX21vZHVsZXMvcnRjLWNvcmUvZ2VuaWNlLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1jb3JlL25vZGVfbW9kdWxlcy9kZXRlY3QtYnJvd3Nlci9icm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1jb3JlL3BsdWdpbi5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtcGx1Z2dhYmxlLXNpZ25hbGxlci9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtcGx1Z2dhYmxlLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtcGx1Z2dhYmxlLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvY3VpZC9kaXN0L2Jyb3dzZXItY3VpZC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtcGx1Z2dhYmxlLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcHVsbC1wdXNoYWJsZS9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtcGx1Z2dhYmxlLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcHVsbC1wdXNoYWJsZS9ub2RlX21vZHVsZXMvcHVsbC1zdHJlYW0vaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXBsdWdnYWJsZS1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3B1bGwtcHVzaGFibGUvbm9kZV9tb2R1bGVzL3B1bGwtc3RyZWFtL21heWJlLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1wbHVnZ2FibGUtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXB1c2hhYmxlL25vZGVfbW9kdWxlcy9wdWxsLXN0cmVhbS9ub2RlX21vZHVsZXMvcHVsbC1jb3JlL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1wbHVnZ2FibGUtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXB1c2hhYmxlL25vZGVfbW9kdWxlcy9wdWxsLXN0cmVhbS9zaW5rcy5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtcGx1Z2dhYmxlLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcHVsbC1wdXNoYWJsZS9ub2RlX21vZHVsZXMvcHVsbC1zdHJlYW0vc291cmNlcy5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtcGx1Z2dhYmxlLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcHVsbC1wdXNoYWJsZS9ub2RlX21vZHVsZXMvcHVsbC1zdHJlYW0vdGhyb3VnaHMuanMiLCJub2RlX21vZHVsZXMvcnRjLXBsdWdnYWJsZS1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3B1bGwtc3RyZWFtL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1wbHVnZ2FibGUtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9wdWxsLXN0cmVhbS9tYXliZS5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtcGx1Z2dhYmxlLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcHVsbC1zdHJlYW0vbm9kZV9tb2R1bGVzL3B1bGwtY29yZS9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtcGx1Z2dhYmxlLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcHVsbC1zdHJlYW0vc2lua3MuanMiLCJub2RlX21vZHVsZXMvcnRjLXBsdWdnYWJsZS1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3B1bGwtc3RyZWFtL3NvdXJjZXMuanMiLCJub2RlX21vZHVsZXMvcnRjLXBsdWdnYWJsZS1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3B1bGwtc3RyZWFtL3Rocm91Z2hzLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1wbHVnZ2FibGUtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9ydGMtc2lnbmFsL2hhbmRsZXJzL2Fubm91bmNlLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1wbHVnZ2FibGUtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9ydGMtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9ydGMtc2lnbmFsL3ByZXBhcmUuanMiLCJub2RlX21vZHVsZXMvcnRjLXBsdWdnYWJsZS1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3J0Yy1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3J0Yy1zaWduYWwvcHJvY2Vzcy5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtcGx1Z2dhYmxlLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcnRjLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcnRjLXNpZ25hbC9zaWduYWxsZXIuanMiLCJub2RlX21vZHVsZXMvcnRjLXBsdWdnYWJsZS1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3J0Yy1zd2l0Y2hib2FyZC1tZXNzZW5nZXIvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXBsdWdnYWJsZS1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3J0Yy1zd2l0Y2hib2FyZC1tZXNzZW5nZXIvbm9kZV9tb2R1bGVzL21lc3Nlbmdlci13cy9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtcGx1Z2dhYmxlLXNpZ25hbGxlci9ub2RlX21vZHVsZXMvcnRjLXN3aXRjaGJvYXJkLW1lc3Nlbmdlci9ub2RlX21vZHVsZXMvbWVzc2VuZ2VyLXdzL25vZGVfbW9kdWxlcy9wdWxsLXdzL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1wbHVnZ2FibGUtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9ydGMtc3dpdGNoYm9hcmQtbWVzc2VuZ2VyL25vZGVfbW9kdWxlcy9tZXNzZW5nZXItd3Mvbm9kZV9tb2R1bGVzL3B1bGwtd3MvcmVhZHkuanMiLCJub2RlX21vZHVsZXMvcnRjLXBsdWdnYWJsZS1zaWduYWxsZXIvbm9kZV9tb2R1bGVzL3J0Yy1zd2l0Y2hib2FyZC1tZXNzZW5nZXIvbm9kZV9tb2R1bGVzL21lc3Nlbmdlci13cy9ub2RlX21vZHVsZXMvcHVsbC13cy9zaW5rLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1wbHVnZ2FibGUtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9ydGMtc3dpdGNoYm9hcmQtbWVzc2VuZ2VyL25vZGVfbW9kdWxlcy9tZXNzZW5nZXItd3Mvbm9kZV9tb2R1bGVzL3B1bGwtd3Mvc291cmNlLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1wbHVnZ2FibGUtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9ydGMtc3dpdGNoYm9hcmQtbWVzc2VuZ2VyL25vZGVfbW9kdWxlcy9tZXNzZW5nZXItd3Mvbm9kZV9tb2R1bGVzL3dzL2xpYi9icm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1wbHVnZ2FibGUtc2lnbmFsbGVyL25vZGVfbW9kdWxlcy9ydGMtc3dpdGNoYm9hcmQtbWVzc2VuZ2VyL25vZGVfbW9kdWxlcy9tZXNzZW5nZXItd3Mvbm9kZV9tb2R1bGVzL3dzdXJsL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy10b29scy9jbGVhbnVwLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy10b29scy9jb3VwbGUuanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL2RldGVjdC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtdG9vbHMvZ2VuZXJhdG9ycy5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtdG9vbHMvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL21vbml0b3IuanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL25vZGVfbW9kdWxlcy9ydGMtdGFza3F1ZXVlL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy10b29scy9ub2RlX21vZHVsZXMvcnRjLXRhc2txdWV1ZS9ub2RlX21vZHVsZXMvcHJpb3JpdHlxdWV1ZWpzL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy10b29scy9ub2RlX21vZHVsZXMvcnRjLXRhc2txdWV1ZS9ub2RlX21vZHVsZXMvcnRjLXNkcC9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtdG9vbHMvbm9kZV9tb2R1bGVzL3J0Yy10YXNrcXVldWUvbm9kZV9tb2R1bGVzL3J0Yy1zZHAvcGFyc2Vycy5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtdG9vbHMvbm9kZV9tb2R1bGVzL3J0Yy10YXNrcXVldWUvbm9kZV9tb2R1bGVzL3J0Yy1zZHBjbGVhbi9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtdG9vbHMvbm9kZV9tb2R1bGVzL3J0Yy10YXNrcXVldWUvbm9kZV9tb2R1bGVzL3J0Yy12YWxpZGF0b3IvY2FuZGlkYXRlLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy10b29scy9ub2RlX21vZHVsZXMvcnRjLXRhc2txdWV1ZS9ub2RlX21vZHVsZXMvcnRjLXZhbGlkYXRvci9ub2RlX21vZHVsZXMvcmV1L2lwLmpzIiwibm9kZV9tb2R1bGVzL3doaXNrL2VxdWFsaXR5LmpzIiwibm9kZV9tb2R1bGVzL3doaXNrL2ZsYXR0ZW4uanMiLCJub2RlX21vZHVsZXMvd2hpc2svbnViLWJ5LmpzIiwibm9kZV9tb2R1bGVzL3doaXNrL251Yi5qcyIsIm5vZGVfbW9kdWxlcy93aGlzay9wbHVjay5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ2xzQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMxSUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JJQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMUZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3S0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0VBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdQQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOUdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25IQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUN0SkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQ3BTQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9EQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNySEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3hLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQ3ZVQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25FQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25IQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUNYQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUMvQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUNuREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0VBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hPQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeEZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcFlBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUtBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNmQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIik7dGhyb3cgZi5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGZ9dmFyIGw9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGwuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sbCxsLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4vKiBnbG9iYWwgbG9jYXRpb24gKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIHJ0YyA9IHJlcXVpcmUoJ3J0Yy10b29scycpO1xudmFyIG1idXMgPSByZXF1aXJlKCdtYnVzJyk7XG52YXIgZGV0ZWN0UGx1Z2luID0gcmVxdWlyZSgncnRjLWNvcmUvcGx1Z2luJyk7XG52YXIgZGVidWcgPSBydGMubG9nZ2VyKCdydGMtcXVpY2tjb25uZWN0Jyk7XG52YXIgZXh0ZW5kID0gcmVxdWlyZSgnY29nL2V4dGVuZCcpO1xuXG4vKipcbiAgIyBydGMtcXVpY2tjb25uZWN0XG5cbiAgVGhpcyBpcyBhIGhpZ2ggbGV2ZWwgaGVscGVyIG1vZHVsZSBkZXNpZ25lZCB0byBoZWxwIHlvdSBnZXQgdXBcbiAgYW4gcnVubmluZyB3aXRoIFdlYlJUQyByZWFsbHksIHJlYWxseSBxdWlja2x5LiAgQnkgdXNpbmcgdGhpcyBtb2R1bGUgeW91XG4gIGFyZSB0cmFkaW5nIG9mZiBzb21lIGZsZXhpYmlsaXR5LCBzbyBpZiB5b3UgbmVlZCBhIG1vcmUgZmxleGlibGVcbiAgY29uZmlndXJhdGlvbiB5b3Ugc2hvdWxkIGRyaWxsIGRvd24gaW50byBsb3dlciBsZXZlbCBjb21wb25lbnRzIG9mIHRoZVxuICBbcnRjLmlvXShodHRwOi8vd3d3LnJ0Yy5pbykgc3VpdGUuICBJbiBwYXJ0aWN1bGFyIHlvdSBzaG91bGQgY2hlY2sgb3V0XG4gIFtydGNdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjKS5cblxuICAjIyBFeGFtcGxlIFVzYWdlXG5cbiAgSW4gdGhlIHNpbXBsZXN0IGNhc2UgeW91IHNpbXBseSBjYWxsIHF1aWNrY29ubmVjdCB3aXRoIGEgc2luZ2xlIHN0cmluZ1xuICBhcmd1bWVudCB3aGljaCB0ZWxscyBxdWlja2Nvbm5lY3Qgd2hpY2ggc2VydmVyIHRvIHVzZSBmb3Igc2lnbmFsaW5nOlxuXG4gIDw8PCBleGFtcGxlcy9zaW1wbGUuanNcblxuICA8PDwgZG9jcy9ldmVudHMubWRcblxuICA8PDwgZG9jcy9leGFtcGxlcy5tZFxuXG4gICMjIFJlZ2FyZGluZyBTaWduYWxsaW5nIGFuZCBhIFNpZ25hbGxpbmcgU2VydmVyXG5cbiAgU2lnbmFsaW5nIGlzIGFuIGltcG9ydGFudCBwYXJ0IG9mIHNldHRpbmcgdXAgYSBXZWJSVEMgY29ubmVjdGlvbiBhbmQgZm9yXG4gIG91ciBleGFtcGxlcyB3ZSB1c2Ugb3VyIG93biB0ZXN0IGluc3RhbmNlIG9mIHRoZVxuICBbcnRjLXN3aXRjaGJvYXJkXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0Yy1zd2l0Y2hib2FyZCkuIEZvciB5b3VyXG4gIHRlc3RpbmcgYW5kIGRldmVsb3BtZW50IHlvdSBhcmUgbW9yZSB0aGFuIHdlbGNvbWUgdG8gdXNlIHRoaXMgYWxzbywgYnV0XG4gIGp1c3QgYmUgYXdhcmUgdGhhdCB3ZSB1c2UgdGhpcyBmb3Igb3VyIHRlc3Rpbmcgc28gaXQgbWF5IGdvIHVwIGFuZCBkb3duXG4gIGEgbGl0dGxlLiAgSWYgeW91IG5lZWQgc29tZXRoaW5nIG1vcmUgc3RhYmxlLCB3aHkgbm90IGNvbnNpZGVyIGRlcGxveWluZ1xuICBhbiBpbnN0YW5jZSBvZiB0aGUgc3dpdGNoYm9hcmQgeW91cnNlbGYgLSBpdCdzIHByZXR0eSBlYXN5IDopXG5cbiAgIyMgUmVmZXJlbmNlXG5cbiAgYGBgXG4gIHF1aWNrY29ubmVjdChzaWduYWxob3N0LCBvcHRzPykgPT4gcnRjLXNpZ2FsbGVyIGluc3RhbmNlICgrIGhlbHBlcnMpXG4gIGBgYFxuXG4gICMjIyBWYWxpZCBRdWljayBDb25uZWN0IE9wdGlvbnNcblxuICBUaGUgb3B0aW9ucyBwcm92aWRlZCB0byB0aGUgYHJ0Yy1xdWlja2Nvbm5lY3RgIG1vZHVsZSBmdW5jdGlvbiBpbmZsdWVuY2UgdGhlXG4gIGJlaGF2aW91ciBvZiBzb21lIG9mIHRoZSB1bmRlcmx5aW5nIGNvbXBvbmVudHMgdXNlZCBmcm9tIHRoZSBydGMuaW8gc3VpdGUuXG5cbiAgTGlzdGVkIGJlbG93IGFyZSBzb21lIG9mIHRoZSBjb21tb25seSB1c2VkIG9wdGlvbnM6XG5cbiAgLSBgbnNgIChkZWZhdWx0OiAnJylcblxuICAgIEFuIG9wdGlvbmFsIG5hbWVzcGFjZSBmb3IgeW91ciBzaWduYWxsaW5nIHJvb20uICBXaGlsZSBxdWlja2Nvbm5lY3RcbiAgICB3aWxsIGdlbmVyYXRlIGEgdW5pcXVlIGhhc2ggZm9yIHRoZSByb29tLCB0aGlzIGNhbiBiZSBtYWRlIHRvIGJlIG1vcmVcbiAgICB1bmlxdWUgYnkgcHJvdmlkaW5nIGEgbmFtZXNwYWNlLiAgVXNpbmcgYSBuYW1lc3BhY2UgbWVhbnMgdHdvIGRlbW9zXG4gICAgdGhhdCBoYXZlIGdlbmVyYXRlZCB0aGUgc2FtZSBoYXNoIGJ1dCB1c2UgYSBkaWZmZXJlbnQgbmFtZXNwYWNlIHdpbGwgYmVcbiAgICBpbiBkaWZmZXJlbnQgcm9vbXMuXG5cbiAgLSBgcm9vbWAgKGRlZmF1bHQ6IG51bGwpIF9hZGRlZCAwLjZfXG5cbiAgICBSYXRoZXIgdGhhbiB1c2UgdGhlIGludGVybmFsIGhhc2ggZ2VuZXJhdGlvblxuICAgIChwbHVzIG9wdGlvbmFsIG5hbWVzcGFjZSkgZm9yIHJvb20gbmFtZSBnZW5lcmF0aW9uLCBzaW1wbHkgdXNlIHRoaXMgcm9vbVxuICAgIG5hbWUgaW5zdGVhZC4gIF9fTk9URTpfXyBVc2Ugb2YgdGhlIGByb29tYCBvcHRpb24gdGFrZXMgcHJlY2VuZGVuY2Ugb3ZlclxuICAgIGBuc2AuXG5cbiAgLSBgZGVidWdgIChkZWZhdWx0OiBmYWxzZSlcblxuICBXcml0ZSBydGMuaW8gc3VpdGUgZGVidWcgb3V0cHV0IHRvIHRoZSBicm93c2VyIGNvbnNvbGUuXG5cbiAgLSBgZXhwZWN0ZWRMb2NhbFN0cmVhbXNgIChkZWZhdWx0OiBub3Qgc3BlY2lmaWVkKSBfYWRkZWQgMy4wX1xuXG4gICAgQnkgcHJvdmlkaW5nIGEgcG9zaXRpdmUgaW50ZWdlciB2YWx1ZSBmb3IgdGhpcyBvcHRpb24gd2lsbCBtZWFuIHRoYXRcbiAgICB0aGUgY3JlYXRlZCBxdWlja2Nvbm5lY3QgaW5zdGFuY2Ugd2lsbCB3YWl0IHVudGlsIHRoZSBzcGVjaWZpZWQgbnVtYmVyIG9mXG4gICAgc3RyZWFtcyBoYXZlIGJlZW4gYWRkZWQgdG8gdGhlIHF1aWNrY29ubmVjdCBcInRlbXBsYXRlXCIgYmVmb3JlIGFubm91bmNpbmdcbiAgICB0byB0aGUgc2lnbmFsaW5nIHNlcnZlci5cblxuICAtIGBtYW51YWxKb2luYCAoZGVmYXVsdDogYGZhbHNlYClcblxuICAgIFNldCB0aGlzIHZhbHVlIHRvIGB0cnVlYCBpZiB5b3Ugd291bGQgcHJlZmVyIHRvIGNhbGwgdGhlIGBqb2luYCBmdW5jdGlvblxuICAgIHRvIGNvbm5lY3RpbmcgdG8gdGhlIHNpZ25hbGxpbmcgc2VydmVyLCByYXRoZXIgdGhhbiBoYXZpbmcgdGhhdCBoYXBwZW5cbiAgICBhdXRvbWF0aWNhbGx5IGFzIHNvb24gYXMgcXVpY2tjb25uZWN0IGlzIHJlYWR5IHRvLlxuXG4gICMjIyMgT3B0aW9ucyBmb3IgUGVlciBDb25uZWN0aW9uIENyZWF0aW9uXG5cbiAgT3B0aW9ucyB0aGF0IGFyZSBwYXNzZWQgb250byB0aGVcbiAgW3J0Yy5jcmVhdGVDb25uZWN0aW9uXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0YyNjcmVhdGVjb25uZWN0aW9ub3B0cy1jb25zdHJhaW50cylcbiAgZnVuY3Rpb246XG5cbiAgLSBgaWNlU2VydmVyc2BcblxuICBUaGlzIHByb3ZpZGVzIGEgbGlzdCBvZiBpY2Ugc2VydmVycyB0aGF0IGNhbiBiZSB1c2VkIHRvIGhlbHAgbmVnb3RpYXRlIGFcbiAgY29ubmVjdGlvbiBiZXR3ZWVuIHBlZXJzLlxuXG4gICMjIyMgT3B0aW9ucyBmb3IgUDJQIG5lZ290aWF0aW9uXG5cbiAgVW5kZXIgdGhlIGhvb2QsIHF1aWNrY29ubmVjdCB1c2VzIHRoZVxuICBbcnRjL2NvdXBsZV0oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMjcnRjY291cGxlKSBsb2dpYywgYW5kIHRoZSBvcHRpb25zXG4gIHBhc3NlZCB0byBxdWlja2Nvbm5lY3QgYXJlIGFsc28gcGFzc2VkIG9udG8gdGhpcyBmdW5jdGlvbi5cblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHNpZ25hbGhvc3QsIG9wdHMpIHtcbiAgdmFyIGhhc2ggPSB0eXBlb2YgbG9jYXRpb24gIT0gJ3VuZGVmaW5lZCcgJiYgbG9jYXRpb24uaGFzaC5zbGljZSgxKTtcbiAgdmFyIHNpZ25hbGxlciA9IHJlcXVpcmUoJ3J0Yy1wbHVnZ2FibGUtc2lnbmFsbGVyJykoZXh0ZW5kKHtcbiAgICBzaWduYWxsZXI6IHNpZ25hbGhvc3QsXG5cbiAgICAvLyB1c2UgdGhlIHByaW11cyBlbmRwb2ludCBhcyBhIGZhbGxiYWNrIGluIGNhc2Ugd2UgYXJlIHRhbGtpbmcgdG8gYW5cbiAgICAvLyBvbGRlciBzd2l0Y2hib2FyZCBpbnN0YW5jZVxuICAgIGVuZHBvaW50czogWycvJywgJy9wcmltdXMnXVxuICB9LCBvcHRzKSk7XG4gIHZhciBnZXRQZWVyRGF0YSA9IHJlcXVpcmUoJy4vbGliL2dldHBlZXJkYXRhJykoc2lnbmFsbGVyLnBlZXJzKTtcblxuICAvLyBpbml0IGNvbmZpZ3VyYWJsZSB2YXJzXG4gIHZhciBucyA9IChvcHRzIHx8IHt9KS5ucyB8fCAnJztcbiAgdmFyIHJvb20gPSAob3B0cyB8fCB7fSkucm9vbTtcbiAgdmFyIGRlYnVnZ2luZyA9IChvcHRzIHx8IHt9KS5kZWJ1ZztcbiAgdmFyIGFsbG93Sm9pbiA9ICEob3B0cyB8fCB7fSkubWFudWFsSm9pbjtcbiAgdmFyIHByb2ZpbGUgPSB7fTtcbiAgdmFyIGFubm91bmNlZCA9IGZhbHNlO1xuXG4gIC8vIGluaXRpYWxpc2UgaWNlU2VydmVycyB0byB1bmRlZmluZWRcbiAgLy8gd2Ugd2lsbCBub3QgYW5ub3VuY2UgdW50aWwgdGhlc2UgaGF2ZSBiZWVuIHByb3Blcmx5IGluaXRpYWxpc2VkXG4gIHZhciBpY2VTZXJ2ZXJzO1xuXG4gIC8vIGNvbGxlY3QgdGhlIGxvY2FsIHN0cmVhbXNcbiAgdmFyIGxvY2FsU3RyZWFtcyA9IFtdO1xuXG4gIC8vIGNyZWF0ZSB0aGUgY2FsbHMgbWFwXG4gIHZhciBjYWxscyA9IHNpZ25hbGxlci5jYWxscyA9IHJlcXVpcmUoJy4vbGliL2NhbGxzJykoc2lnbmFsbGVyLCBvcHRzKTtcblxuICAvLyBjcmVhdGUgdGhlIGtub3duIGRhdGEgY2hhbm5lbHMgcmVnaXN0cnlcbiAgdmFyIGNoYW5uZWxzID0ge307XG5cbiAgLy8gc2F2ZSB0aGUgcGx1Z2lucyBwYXNzZWQgdG8gdGhlIHNpZ25hbGxlclxuICB2YXIgcGx1Z2lucyA9IHNpZ25hbGxlci5wbHVnaW5zID0gKG9wdHMgfHwge30pLnBsdWdpbnMgfHwgW107XG4gIHZhciBwbHVnaW4gPSBkZXRlY3RQbHVnaW4ocGx1Z2lucyk7XG4gIHZhciBwbHVnaW5SZWFkeTtcblxuICAvLyBjaGVjayBob3cgbWFueSBsb2NhbCBzdHJlYW1zIGhhdmUgYmVlbiBleHBlY3RlZCAoZGVmYXVsdDogMClcbiAgdmFyIGV4cGVjdGVkTG9jYWxTdHJlYW1zID0gcGFyc2VJbnQoKG9wdHMgfHwge30pLmV4cGVjdGVkTG9jYWxTdHJlYW1zLCAxMCkgfHwgMDtcbiAgdmFyIGFubm91bmNlVGltZXIgPSAwO1xuICB2YXIgdXBkYXRlVGltZXIgPSAwO1xuXG4gIGZ1bmN0aW9uIGNoZWNrUmVhZHlUb0Fubm91bmNlKCkge1xuICAgIGNsZWFyVGltZW91dChhbm5vdW5jZVRpbWVyKTtcbiAgICAvLyBpZiB3ZSBoYXZlIGFscmVhZHkgYW5ub3VuY2VkIGRvIG5vdGhpbmchXG4gICAgaWYgKGFubm91bmNlZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmICghIGFsbG93Sm9pbikge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIGlmIHdlIGhhdmUgYSBwbHVnaW4gYnV0IGl0J3Mgbm90IGluaXRpYWxpemVkIHdlIGFyZW4ndCByZWFkeVxuICAgIGlmIChwbHVnaW4gJiYgKCEgcGx1Z2luUmVhZHkpKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gaWYgd2UgaGF2ZSBubyBpY2VTZXJ2ZXJzIHdlIGFyZW4ndCByZWFkeVxuICAgIGlmICghIGljZVNlcnZlcnMpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBpZiB3ZSBhcmUgd2FpdGluZyBmb3IgYSBzZXQgbnVtYmVyIG9mIHN0cmVhbXMsIHRoZW4gd2FpdCB1bnRpbCB3ZSBoYXZlXG4gICAgLy8gdGhlIHJlcXVpcmVkIG51bWJlclxuICAgIGlmIChleHBlY3RlZExvY2FsU3RyZWFtcyAmJiBsb2NhbFN0cmVhbXMubGVuZ3RoIDwgZXhwZWN0ZWRMb2NhbFN0cmVhbXMpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBhbm5vdW5jZSBvdXJzZWx2ZXMgdG8gb3VyIG5ldyBmcmllbmRcbiAgICBhbm5vdW5jZVRpbWVyID0gc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgIHZhciBkYXRhID0gZXh0ZW5kKHsgcm9vbTogcm9vbSB9LCBwcm9maWxlKTtcblxuICAgICAgLy8gYW5ub3VuY2UgYW5kIGVtaXQgdGhlIGxvY2FsIGFubm91bmNlIGV2ZW50XG4gICAgICBzaWduYWxsZXIuYW5ub3VuY2UoZGF0YSk7XG4gICAgICBhbm5vdW5jZWQgPSB0cnVlO1xuICAgIH0sIDApO1xuICB9XG5cbiAgZnVuY3Rpb24gY29ubmVjdChpZCkge1xuICAgIHZhciBkYXRhID0gZ2V0UGVlckRhdGEoaWQpO1xuICAgIHZhciBwYztcbiAgICB2YXIgbW9uaXRvcjtcblxuICAgIC8vIGlmIHRoZSByb29tIGlzIG5vdCBhIG1hdGNoLCBhYm9ydFxuICAgIGlmIChkYXRhLnJvb20gIT09IHJvb20pIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBlbmQgYW55IGNhbGwgdG8gdGhpcyBpZCBzbyB3ZSBrbm93IHdlIGFyZSBzdGFydGluZyBmcmVzaFxuICAgIGNhbGxzLmVuZChpZCk7XG5cbiAgICAvLyBjcmVhdGUgYSBwZWVyIGNvbm5lY3Rpb25cbiAgICAvLyBpY2VTZXJ2ZXJzIHRoYXQgaGF2ZSBiZWVuIGNyZWF0ZWQgdXNpbmcgZ2VuaWNlIHRha2luZyBwcmVjZW5kZW5jZVxuICAgIHBjID0gcnRjLmNyZWF0ZUNvbm5lY3Rpb24oXG4gICAgICBleHRlbmQoe30sIG9wdHMsIHsgaWNlU2VydmVyczogaWNlU2VydmVycyB9KSxcbiAgICAgIChvcHRzIHx8IHt9KS5jb25zdHJhaW50c1xuICAgICk7XG5cbiAgICBzaWduYWxsZXIoJ3BlZXI6Y29ubmVjdCcsIGRhdGEuaWQsIHBjLCBkYXRhKTtcblxuICAgIC8vIGFkZCB0aGlzIGNvbm5lY3Rpb24gdG8gdGhlIGNhbGxzIGxpc3RcbiAgICBjYWxscy5jcmVhdGUoZGF0YS5pZCwgcGMpO1xuXG4gICAgLy8gYWRkIHRoZSBsb2NhbCBzdHJlYW1zXG4gICAgbG9jYWxTdHJlYW1zLmZvckVhY2goZnVuY3Rpb24oc3RyZWFtKSB7XG4gICAgICBwYy5hZGRTdHJlYW0oc3RyZWFtKTtcbiAgICB9KTtcblxuICAgIC8vIGFkZCB0aGUgZGF0YSBjaGFubmVsc1xuICAgIC8vIGRvIHRoaXMgZGlmZmVyZW50bHkgYmFzZWQgb24gd2hldGhlciB0aGUgY29ubmVjdGlvbiBpcyBhXG4gICAgLy8gbWFzdGVyIG9yIGEgc2xhdmUgY29ubmVjdGlvblxuICAgIGlmIChzaWduYWxsZXIuaXNNYXN0ZXIoZGF0YS5pZCkpIHtcbiAgICAgIGRlYnVnKCdpcyBtYXN0ZXIsIGNyZWF0aW5nIGRhdGEgY2hhbm5lbHM6ICcsIE9iamVjdC5rZXlzKGNoYW5uZWxzKSk7XG5cbiAgICAgIC8vIGNyZWF0ZSB0aGUgY2hhbm5lbHNcbiAgICAgIE9iamVjdC5rZXlzKGNoYW5uZWxzKS5mb3JFYWNoKGZ1bmN0aW9uKGxhYmVsKSB7XG4gICAgICAgZ290UGVlckNoYW5uZWwocGMuY3JlYXRlRGF0YUNoYW5uZWwobGFiZWwsIGNoYW5uZWxzW2xhYmVsXSksIHBjLCBkYXRhKTtcbiAgICAgIH0pO1xuICAgIH1cbiAgICBlbHNlIHtcbiAgICAgIHBjLm9uZGF0YWNoYW5uZWwgPSBmdW5jdGlvbihldnQpIHtcbiAgICAgICAgdmFyIGNoYW5uZWwgPSBldnQgJiYgZXZ0LmNoYW5uZWw7XG5cbiAgICAgICAgLy8gaWYgd2UgaGF2ZSBubyBjaGFubmVsLCBhYm9ydFxuICAgICAgICBpZiAoISBjaGFubmVsKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNoYW5uZWxzW2NoYW5uZWwubGFiZWxdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBnb3RQZWVyQ2hhbm5lbChjaGFubmVsLCBwYywgZ2V0UGVlckRhdGEoaWQpKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBjb3VwbGUgdGhlIGNvbm5lY3Rpb25zXG4gICAgZGVidWcoJ2NvdXBsaW5nICcgKyBzaWduYWxsZXIuaWQgKyAnIHRvICcgKyBkYXRhLmlkKTtcbiAgICBtb25pdG9yID0gcnRjLmNvdXBsZShwYywgaWQsIHNpZ25hbGxlciwgZXh0ZW5kKHt9LCBvcHRzLCB7XG4gICAgICBsb2dnZXI6IG1idXMoJ3BjLicgKyBpZCwgc2lnbmFsbGVyKVxuICAgIH0pKTtcblxuICAgIHNpZ25hbGxlcigncGVlcjpjb3VwbGUnLCBpZCwgcGMsIGRhdGEsIG1vbml0b3IpO1xuXG4gICAgLy8gb25jZSBhY3RpdmUsIHRyaWdnZXIgdGhlIHBlZXIgY29ubmVjdCBldmVudFxuICAgIG1vbml0b3Iub25jZSgnY29ubmVjdGVkJywgY2FsbHMuc3RhcnQuYmluZChudWxsLCBpZCwgcGMsIGRhdGEpKTtcbiAgICBtb25pdG9yLm9uY2UoJ2Nsb3NlZCcsIGNhbGxzLmVuZC5iaW5kKG51bGwsIGlkKSk7XG5cbiAgICAvLyBpZiB3ZSBhcmUgdGhlIG1hc3RlciBjb25ubmVjdGlvbiwgY3JlYXRlIHRoZSBvZmZlclxuICAgIC8vIE5PVEU6IHRoaXMgb25seSByZWFsbHkgZm9yIHRoZSBzYWtlIG9mIHBvbGl0ZW5lc3MsIGFzIHJ0YyBjb3VwbGVcbiAgICAvLyBpbXBsZW1lbnRhdGlvbiBoYW5kbGVzIHRoZSBzbGF2ZSBhdHRlbXB0aW5nIHRvIGNyZWF0ZSBhbiBvZmZlclxuICAgIGlmIChzaWduYWxsZXIuaXNNYXN0ZXIoaWQpKSB7XG4gICAgICBtb25pdG9yLmNyZWF0ZU9mZmVyKCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gZ2V0QWN0aXZlQ2FsbChwZWVySWQpIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChwZWVySWQpO1xuXG4gICAgaWYgKCEgY2FsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdObyBhY3RpdmUgY2FsbCBmb3IgcGVlcjogJyArIHBlZXJJZCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGNhbGw7XG4gIH1cblxuICBmdW5jdGlvbiBnb3RQZWVyQ2hhbm5lbChjaGFubmVsLCBwYywgZGF0YSkge1xuICAgIHZhciBjaGFubmVsTW9uaXRvcjtcblxuICAgIGZ1bmN0aW9uIGNoYW5uZWxSZWFkeSgpIHtcbiAgICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KGRhdGEuaWQpO1xuICAgICAgdmFyIGFyZ3MgPSBbIGRhdGEuaWQsIGNoYW5uZWwsIGRhdGEsIHBjIF07XG5cbiAgICAgIC8vIGRlY291cGxlIHRoZSBjaGFubmVsLm9ub3BlbiBsaXN0ZW5lclxuICAgICAgZGVidWcoJ3JlcG9ydGluZyBjaGFubmVsIFwiJyArIGNoYW5uZWwubGFiZWwgKyAnXCIgcmVhZHksIGhhdmUgY2FsbDogJyArICghIWNhbGwpKTtcbiAgICAgIGNsZWFySW50ZXJ2YWwoY2hhbm5lbE1vbml0b3IpO1xuICAgICAgY2hhbm5lbC5vbm9wZW4gPSBudWxsO1xuXG4gICAgICAvLyBzYXZlIHRoZSBjaGFubmVsXG4gICAgICBpZiAoY2FsbCkge1xuICAgICAgICBjYWxsLmNoYW5uZWxzLnNldChjaGFubmVsLmxhYmVsLCBjaGFubmVsKTtcbiAgICAgIH1cblxuICAgICAgLy8gdHJpZ2dlciB0aGUgJWNoYW5uZWwubGFiZWwlOm9wZW4gZXZlbnRcbiAgICAgIGRlYnVnKCd0cmlnZ2VyaW5nIGNoYW5uZWw6b3BlbmVkIGV2ZW50cyBmb3IgY2hhbm5lbDogJyArIGNoYW5uZWwubGFiZWwpO1xuXG4gICAgICAvLyBlbWl0IHRoZSBwbGFpbiBjaGFubmVsOm9wZW5lZCBldmVudFxuICAgICAgc2lnbmFsbGVyLmFwcGx5KHNpZ25hbGxlciwgWydjaGFubmVsOm9wZW5lZCddLmNvbmNhdChhcmdzKSk7XG5cbiAgICAgIC8vIGVtaXQgdGhlIGNoYW5uZWw6b3BlbmVkOiVsYWJlbCUgZXZlXG4gICAgICBzaWduYWxsZXIuYXBwbHkoXG4gICAgICAgIHNpZ25hbGxlcixcbiAgICAgICAgWydjaGFubmVsOm9wZW5lZDonICsgY2hhbm5lbC5sYWJlbF0uY29uY2F0KGFyZ3MpXG4gICAgICApO1xuICAgIH1cblxuICAgIGRlYnVnKCdjaGFubmVsICcgKyBjaGFubmVsLmxhYmVsICsgJyBkaXNjb3ZlcmVkIGZvciBwZWVyOiAnICsgZGF0YS5pZCk7XG4gICAgaWYgKGNoYW5uZWwucmVhZHlTdGF0ZSA9PT0gJ29wZW4nKSB7XG4gICAgICByZXR1cm4gY2hhbm5lbFJlYWR5KCk7XG4gICAgfVxuXG4gICAgZGVidWcoJ2NoYW5uZWwgbm90IHJlYWR5LCBjdXJyZW50IHN0YXRlID0gJyArIGNoYW5uZWwucmVhZHlTdGF0ZSk7XG4gICAgY2hhbm5lbC5vbm9wZW4gPSBjaGFubmVsUmVhZHk7XG5cbiAgICAvLyBtb25pdG9yIHRoZSBjaGFubmVsIG9wZW4gKGRvbid0IHRydXN0IHRoZSBjaGFubmVsIG9wZW4gZXZlbnQganVzdCB5ZXQpXG4gICAgY2hhbm5lbE1vbml0b3IgPSBzZXRJbnRlcnZhbChmdW5jdGlvbigpIHtcbiAgICAgIGRlYnVnKCdjaGVja2luZyBjaGFubmVsIHN0YXRlLCBjdXJyZW50IHN0YXRlID0gJyArIGNoYW5uZWwucmVhZHlTdGF0ZSk7XG4gICAgICBpZiAoY2hhbm5lbC5yZWFkeVN0YXRlID09PSAnb3BlbicpIHtcbiAgICAgICAgY2hhbm5lbFJlYWR5KCk7XG4gICAgICB9XG4gICAgfSwgNTAwKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGluaXRQbHVnaW4oKSB7XG4gICAgcmV0dXJuIHBsdWdpbiAmJiBwbHVnaW4uaW5pdChvcHRzLCBmdW5jdGlvbihlcnIpIHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIGNvbnNvbGUuZXJyb3IoJ0NvdWxkIG5vdCBpbml0aWFsaXplIHBsdWdpbjogJywgZXJyKTtcbiAgICAgIH1cblxuICAgICAgcGx1Z2luUmVhZHkgPSB0cnVlO1xuICAgICAgY2hlY2tSZWFkeVRvQW5ub3VuY2UoKTtcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZUxvY2FsQW5ub3VuY2UoZGF0YSkge1xuICAgIC8vIGlmIHdlIHNlbmQgYW4gYW5ub3VuY2Ugd2l0aCBhbiB1cGRhdGVkIHJvb20gdGhlbiB1cGRhdGUgb3VyIGxvY2FsIHJvb20gbmFtZVxuICAgIGlmIChkYXRhICYmIHR5cGVvZiBkYXRhLnJvb20gIT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIHJvb20gPSBkYXRhLnJvb207XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlUGVlckZpbHRlcihpZCwgZGF0YSkge1xuICAgIC8vIG9ubHkgY29ubmVjdCB3aXRoIHRoZSBwZWVyIGlmIHdlIGFyZSByZWFkeVxuICAgIGRhdGEuYWxsb3cgPSBkYXRhLmFsbG93ICYmIChsb2NhbFN0cmVhbXMubGVuZ3RoID49IGV4cGVjdGVkTG9jYWxTdHJlYW1zKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZVBlZXJVcGRhdGUoZGF0YSkge1xuICAgIHZhciBpZCA9IGRhdGEgJiYgZGF0YS5pZDtcbiAgICB2YXIgYWN0aXZlQ2FsbCA9IGlkICYmIGNhbGxzLmdldChpZCk7XG5cbiAgICAvLyBpZiB3ZSBoYXZlIHJlY2VpdmVkIGFuIHVwZGF0ZSBmb3IgYSBwZWVyIHRoYXQgaGFzIG5vIGFjdGl2ZSBjYWxscyxcbiAgICAvLyB0aGVuIHBhc3MgdGhpcyBvbnRvIHRoZSBhbm5vdW5jZSBoYW5kbGVyXG4gICAgaWYgKGlkICYmICghIGFjdGl2ZUNhbGwpKSB7XG4gICAgICBkZWJ1ZygncmVjZWl2ZWQgcGVlciB1cGRhdGUgZnJvbSBwZWVyICcgKyBpZCArICcsIG5vIGFjdGl2ZSBjYWxscycpO1xuICAgICAgc2lnbmFsbGVyLnRvKGlkKS5zZW5kKCcvcmVjb25uZWN0Jyk7XG4gICAgICByZXR1cm4gY29ubmVjdChpZCk7XG4gICAgfVxuICB9XG5cbiAgLy8gaWYgdGhlIHJvb20gaXMgbm90IGRlZmluZWQsIHRoZW4gZ2VuZXJhdGUgdGhlIHJvb20gbmFtZVxuICBpZiAoISByb29tKSB7XG4gICAgLy8gaWYgdGhlIGhhc2ggaXMgbm90IGFzc2lnbmVkLCB0aGVuIGNyZWF0ZSBhIHJhbmRvbSBoYXNoIHZhbHVlXG4gICAgaWYgKHR5cGVvZiBsb2NhdGlvbiAhPSAndW5kZWZpbmVkJyAmJiAoISBoYXNoKSkge1xuICAgICAgaGFzaCA9IGxvY2F0aW9uLmhhc2ggPSAnJyArIChNYXRoLnBvdygyLCA1MykgKiBNYXRoLnJhbmRvbSgpKTtcbiAgICB9XG5cbiAgICByb29tID0gbnMgKyAnIycgKyBoYXNoO1xuICB9XG5cbiAgaWYgKGRlYnVnZ2luZykge1xuICAgIHJ0Yy5sb2dnZXIuZW5hYmxlLmFwcGx5KHJ0Yy5sb2dnZXIsIEFycmF5LmlzQXJyYXkoZGVidWcpID8gZGVidWdnaW5nIDogWycqJ10pO1xuICB9XG5cbiAgc2lnbmFsbGVyLm9uKCdwZWVyOmFubm91bmNlJywgZnVuY3Rpb24oZGF0YSkge1xuICAgIGNvbm5lY3QoZGF0YS5pZCk7XG4gIH0pO1xuXG4gIHNpZ25hbGxlci5vbigncGVlcjp1cGRhdGUnLCBoYW5kbGVQZWVyVXBkYXRlKTtcblxuICBzaWduYWxsZXIub24oJ21lc3NhZ2U6cmVjb25uZWN0JywgZnVuY3Rpb24oc2VuZGVyKSB7XG4gICAgY29ubmVjdChzZW5kZXIuaWQpO1xuICB9KTtcblxuXG5cbiAgLyoqXG4gICAgIyMjIFF1aWNrY29ubmVjdCBCcm9hZGNhc3QgYW5kIERhdGEgQ2hhbm5lbCBIZWxwZXIgRnVuY3Rpb25zXG5cbiAgICBUaGUgZm9sbG93aW5nIGFyZSBmdW5jdGlvbnMgdGhhdCBhcmUgcGF0Y2hlZCBpbnRvIHRoZSBgcnRjLXNpZ25hbGxlcmBcbiAgICBpbnN0YW5jZSB0aGF0IG1ha2Ugd29ya2luZyB3aXRoIGFuZCBjcmVhdGluZyBmdW5jdGlvbmFsIFdlYlJUQyBhcHBsaWNhdGlvbnNcbiAgICBhIGxvdCBzaW1wbGVyLlxuXG4gICoqL1xuXG4gIC8qKlxuICAgICMjIyMgYWRkU3RyZWFtXG5cbiAgICBgYGBcbiAgICBhZGRTdHJlYW0oc3RyZWFtOk1lZGlhU3RyZWFtKSA9PiBxY1xuICAgIGBgYFxuXG4gICAgQWRkIHRoZSBzdHJlYW0gdG8gYWN0aXZlIGNhbGxzIGFuZCBhbHNvIHNhdmUgdGhlIHN0cmVhbSBzbyB0aGF0IGl0XG4gICAgY2FuIGJlIGFkZGVkIHRvIGZ1dHVyZSBjYWxscy5cblxuICAqKi9cbiAgc2lnbmFsbGVyLmJyb2FkY2FzdCA9IHNpZ25hbGxlci5hZGRTdHJlYW0gPSBmdW5jdGlvbihzdHJlYW0pIHtcbiAgICBsb2NhbFN0cmVhbXMucHVzaChzdHJlYW0pO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSBhbnkgYWN0aXZlIGNhbGxzLCB0aGVuIGFkZCB0aGUgc3RyZWFtXG4gICAgY2FsbHMudmFsdWVzKCkuZm9yRWFjaChmdW5jdGlvbihkYXRhKSB7XG4gICAgICBkYXRhLnBjLmFkZFN0cmVhbShzdHJlYW0pO1xuICAgIH0pO1xuXG4gICAgY2hlY2tSZWFkeVRvQW5ub3VuY2UoKTtcbiAgICByZXR1cm4gc2lnbmFsbGVyO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgZW5kQ2FsbHMoKVxuXG4gICAgVGhlIGBlbmRDYWxsc2AgZnVuY3Rpb24gdGVybWluYXRlcyBhbGwgdGhlIGFjdGl2ZSBjYWxscyB0aGF0IGhhdmUgYmVlblxuICAgIGNyZWF0ZWQgaW4gdGhpcyBxdWlja2Nvbm5lY3QgaW5zdGFuY2UuICBDYWxsaW5nIGBlbmRDYWxsc2AgZG9lcyBub3RcbiAgICBraWxsIHRoZSBjb25uZWN0aW9uIHdpdGggdGhlIHNpZ25hbGxpbmcgc2VydmVyLlxuXG4gICoqL1xuICBzaWduYWxsZXIuZW5kQ2FsbHMgPSBmdW5jdGlvbigpIHtcbiAgICBjYWxscy5rZXlzKCkuZm9yRWFjaChjYWxscy5lbmQpO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgY2xvc2UoKVxuXG4gICAgVGhlIGBjbG9zZWAgZnVuY3Rpb24gcHJvdmlkZXMgYSBjb252ZW5pZW50IHdheSBvZiBjbG9zaW5nIGFsbCBhc3NvY2lhdGVkXG4gICAgcGVlciBjb25uZWN0aW9ucy4gIFRoaXMgZnVuY3Rpb24gc2ltcGx5IHVzZXMgdGhlIGBlbmRDYWxsc2AgZnVuY3Rpb24gYW5kXG4gICAgdGhlIHVuZGVybHlpbmcgYGxlYXZlYCBmdW5jdGlvbiBvZiB0aGUgc2lnbmFsbGVyIHRvIGRvIGEgXCJmdWxsIGNsZWFudXBcIlxuICAgIG9mIGFsbCBjb25uZWN0aW9ucy5cbiAgKiovXG4gIHNpZ25hbGxlci5jbG9zZSA9IGZ1bmN0aW9uKCkge1xuICAgIHNpZ25hbGxlci5lbmRDYWxscygpO1xuICAgIHNpZ25hbGxlci5sZWF2ZSgpO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgY3JlYXRlRGF0YUNoYW5uZWwobGFiZWwsIGNvbmZpZylcblxuICAgIFJlcXVlc3QgdGhhdCBhIGRhdGEgY2hhbm5lbCB3aXRoIHRoZSBzcGVjaWZpZWQgYGxhYmVsYCBpcyBjcmVhdGVkIG9uXG4gICAgdGhlIHBlZXIgY29ubmVjdGlvbi4gIFdoZW4gdGhlIGRhdGEgY2hhbm5lbCBpcyBvcGVuIGFuZCBhdmFpbGFibGUsIGFuXG4gICAgZXZlbnQgd2lsbCBiZSB0cmlnZ2VyZWQgdXNpbmcgdGhlIGxhYmVsIG9mIHRoZSBkYXRhIGNoYW5uZWwuXG5cbiAgICBGb3IgZXhhbXBsZSwgaWYgYSBuZXcgZGF0YSBjaGFubmVsIHdhcyByZXF1ZXN0ZWQgdXNpbmcgdGhlIGZvbGxvd2luZ1xuICAgIGNhbGw6XG5cbiAgICBgYGBqc1xuICAgIHZhciBxYyA9IHF1aWNrY29ubmVjdCgnaHR0cHM6Ly9zd2l0Y2hib2FyZC5ydGMuaW8vJykuY3JlYXRlRGF0YUNoYW5uZWwoJ3Rlc3QnKTtcbiAgICBgYGBcblxuICAgIFRoZW4gd2hlbiB0aGUgZGF0YSBjaGFubmVsIGlzIHJlYWR5IGZvciB1c2UsIGEgYHRlc3Q6b3BlbmAgZXZlbnQgd291bGRcbiAgICBiZSBlbWl0dGVkIGJ5IGBxY2AuXG5cbiAgKiovXG4gIHNpZ25hbGxlci5jcmVhdGVEYXRhQ2hhbm5lbCA9IGZ1bmN0aW9uKGxhYmVsLCBvcHRzKSB7XG4gICAgLy8gY3JlYXRlIGEgY2hhbm5lbCBvbiBhbGwgZXhpc3RpbmcgY2FsbHNcbiAgICBjYWxscy5rZXlzKCkuZm9yRWFjaChmdW5jdGlvbihwZWVySWQpIHtcbiAgICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KHBlZXJJZCk7XG4gICAgICB2YXIgZGM7XG5cbiAgICAgIC8vIGlmIHdlIGFyZSB0aGUgbWFzdGVyIGNvbm5lY3Rpb24sIGNyZWF0ZSB0aGUgZGF0YSBjaGFubmVsXG4gICAgICBpZiAoY2FsbCAmJiBjYWxsLnBjICYmIHNpZ25hbGxlci5pc01hc3RlcihwZWVySWQpKSB7XG4gICAgICAgIGRjID0gY2FsbC5wYy5jcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCwgb3B0cyk7XG4gICAgICAgIGdvdFBlZXJDaGFubmVsKGRjLCBjYWxsLnBjLCBnZXRQZWVyRGF0YShwZWVySWQpKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIHNhdmUgdGhlIGRhdGEgY2hhbm5lbCBvcHRzIGluIHRoZSBsb2NhbCBjaGFubmVscyBkaWN0aW9uYXJ5XG4gICAgY2hhbm5lbHNbbGFiZWxdID0gb3B0cyB8fCBudWxsO1xuXG4gICAgcmV0dXJuIHNpZ25hbGxlcjtcbiAgfTtcblxuICAvKipcbiAgICAjIyMjIGpvaW4oKVxuXG4gICAgVGhlIGBqb2luYCBmdW5jdGlvbiBpcyB1c2VkIHdoZW4gYG1hbnVhbEpvaW5gIGlzIHNldCB0byB0cnVlIHdoZW4gY3JlYXRpbmdcbiAgICBhIHF1aWNrY29ubmVjdCBpbnN0YW5jZS4gIENhbGwgdGhlIGBqb2luYCBmdW5jdGlvbiBvbmNlIHlvdSBhcmUgcmVhZHkgdG9cbiAgICBqb2luIHRoZSBzaWduYWxsaW5nIHNlcnZlciBhbmQgaW5pdGlhdGUgY29ubmVjdGlvbnMgd2l0aCBvdGhlciBwZW9wbGUuXG5cbiAgKiovXG4gIHNpZ25hbGxlci5qb2luID0gZnVuY3Rpb24oKSB7XG4gICAgYWxsb3dKb2luID0gdHJ1ZTtcbiAgICBjaGVja1JlYWR5VG9Bbm5vdW5jZSgpO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgYGdldChuYW1lKWBcblxuICAgIFRoZSBgZ2V0YCBmdW5jdGlvbiByZXR1cm5zIHRoZSBwcm9wZXJ0eSB2YWx1ZSBmb3IgdGhlIHNwZWNpZmllZCBwcm9wZXJ0eSBuYW1lLlxuICAqKi9cbiAgc2lnbmFsbGVyLmdldCA9IGZ1bmN0aW9uKG5hbWUpIHtcbiAgICByZXR1cm4gcHJvZmlsZVtuYW1lXTtcbiAgfTtcblxuICAvKipcbiAgICAjIyMjIGBnZXRMb2NhbFN0cmVhbXMoKWBcblxuICAgIFJldHVybiBhIGNvcHkgb2YgdGhlIGxvY2FsIHN0cmVhbXMgdGhhdCBoYXZlIGN1cnJlbnRseSBiZWVuIGNvbmZpZ3VyZWRcbiAgKiovXG4gIHNpZ25hbGxlci5nZXRMb2NhbFN0cmVhbXMgPSBmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gW10uY29uY2F0KGxvY2FsU3RyZWFtcyk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyByZWFjdGl2ZSgpXG5cbiAgICBGbGFnIHRoYXQgdGhpcyBzZXNzaW9uIHdpbGwgYmUgYSByZWFjdGl2ZSBjb25uZWN0aW9uLlxuXG4gICoqL1xuICBzaWduYWxsZXIucmVhY3RpdmUgPSBmdW5jdGlvbigpIHtcbiAgICAvLyBhZGQgdGhlIHJlYWN0aXZlIGZsYWdcbiAgICBvcHRzID0gb3B0cyB8fCB7fTtcbiAgICBvcHRzLnJlYWN0aXZlID0gdHJ1ZTtcblxuICAgIC8vIGNoYWluXG4gICAgcmV0dXJuIHNpZ25hbGxlcjtcbiAgfTtcblxuICAvKipcbiAgICAjIyMjIHJlbW92ZVN0cmVhbVxuXG4gICAgYGBgXG4gICAgcmVtb3ZlU3RyZWFtKHN0cmVhbTpNZWRpYVN0cmVhbSlcbiAgICBgYGBcblxuICAgIFJlbW92ZSB0aGUgc3BlY2lmaWVkIHN0cmVhbSBmcm9tIGJvdGggdGhlIGxvY2FsIHN0cmVhbXMgdGhhdCBhcmUgdG9cbiAgICBiZSBjb25uZWN0ZWQgdG8gbmV3IHBlZXJzLCBhbmQgYWxzbyBmcm9tIGFueSBhY3RpdmUgY2FsbHMuXG5cbiAgKiovXG4gIHNpZ25hbGxlci5yZW1vdmVTdHJlYW0gPSBmdW5jdGlvbihzdHJlYW0pIHtcbiAgICB2YXIgbG9jYWxJbmRleCA9IGxvY2FsU3RyZWFtcy5pbmRleE9mKHN0cmVhbSk7XG5cbiAgICAvLyByZW1vdmUgdGhlIHN0cmVhbSBmcm9tIGFueSBhY3RpdmUgY2FsbHNcbiAgICBjYWxscy52YWx1ZXMoKS5mb3JFYWNoKGZ1bmN0aW9uKGNhbGwpIHtcbiAgICAgIGNhbGwucGMucmVtb3ZlU3RyZWFtKHN0cmVhbSk7XG4gICAgfSk7XG5cbiAgICAvLyByZW1vdmUgdGhlIHN0cmVhbSBmcm9tIHRoZSBsb2NhbFN0cmVhbXMgYXJyYXlcbiAgICBpZiAobG9jYWxJbmRleCA+PSAwKSB7XG4gICAgICBsb2NhbFN0cmVhbXMuc3BsaWNlKGxvY2FsSW5kZXgsIDEpO1xuICAgIH1cblxuICAgIHJldHVybiBzaWduYWxsZXI7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyByZXF1ZXN0Q2hhbm5lbFxuXG4gICAgYGBgXG4gICAgcmVxdWVzdENoYW5uZWwodGFyZ2V0SWQsIGxhYmVsLCBjYWxsYmFjaylcbiAgICBgYGBcblxuICAgIFRoaXMgaXMgYSBmdW5jdGlvbiB0aGF0IGNhbiBiZSB1c2VkIHRvIHJlc3BvbmQgdG8gcmVtb3RlIHBlZXJzIHN1cHBseWluZ1xuICAgIGEgZGF0YSBjaGFubmVsIGFzIHBhcnQgb2YgdGhlaXIgY29uZmlndXJhdGlvbi4gIEFzIHBlciB0aGUgYHJlY2VpdmVTdHJlYW1gXG4gICAgZnVuY3Rpb24gdGhpcyBmdW5jdGlvbiB3aWxsIGVpdGhlciBmaXJlIHRoZSBjYWxsYmFjayBpbW1lZGlhdGVseSBpZiB0aGVcbiAgICBjaGFubmVsIGlzIGFscmVhZHkgYXZhaWxhYmxlLCBvciBvbmNlIHRoZSBjaGFubmVsIGhhcyBiZWVuIGRpc2NvdmVyZWQgb25cbiAgICB0aGUgY2FsbC5cblxuICAqKi9cbiAgc2lnbmFsbGVyLnJlcXVlc3RDaGFubmVsID0gZnVuY3Rpb24odGFyZ2V0SWQsIGxhYmVsLCBjYWxsYmFjaykge1xuICAgIHZhciBjYWxsID0gZ2V0QWN0aXZlQ2FsbCh0YXJnZXRJZCk7XG4gICAgdmFyIGNoYW5uZWwgPSBjYWxsICYmIGNhbGwuY2hhbm5lbHMuZ2V0KGxhYmVsKTtcblxuICAgIC8vIGlmIHdlIGhhdmUgdGhlbiBjaGFubmVsIHRyaWdnZXIgdGhlIGNhbGxiYWNrIGltbWVkaWF0ZWx5XG4gICAgaWYgKGNoYW5uZWwpIHtcbiAgICAgIGNhbGxiYWNrKG51bGwsIGNoYW5uZWwpO1xuICAgICAgcmV0dXJuIHNpZ25hbGxlcjtcbiAgICB9XG5cbiAgICAvLyBpZiBub3QsIHdhaXQgZm9yIGl0XG4gICAgc2lnbmFsbGVyLm9uY2UoJ2NoYW5uZWw6b3BlbmVkOicgKyBsYWJlbCwgZnVuY3Rpb24oaWQsIGRjKSB7XG4gICAgICBjYWxsYmFjayhudWxsLCBkYyk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gc2lnbmFsbGVyO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgcmVxdWVzdFN0cmVhbVxuXG4gICAgYGBgXG4gICAgcmVxdWVzdFN0cmVhbSh0YXJnZXRJZCwgaWR4LCBjYWxsYmFjaylcbiAgICBgYGBcblxuICAgIFVzZWQgdG8gcmVxdWVzdCBhIHJlbW90ZSBzdHJlYW0gZnJvbSBhIHF1aWNrY29ubmVjdCBpbnN0YW5jZS4gSWYgdGhlXG4gICAgc3RyZWFtIGlzIGFscmVhZHkgYXZhaWxhYmxlIGluIHRoZSBjYWxscyByZW1vdGUgc3RyZWFtcywgdGhlbiB0aGUgY2FsbGJhY2tcbiAgICB3aWxsIGJlIHRyaWdnZXJlZCBpbW1lZGlhdGVseSwgb3RoZXJ3aXNlIHRoaXMgZnVuY3Rpb24gd2lsbCBtb25pdG9yXG4gICAgYHN0cmVhbTphZGRlZGAgZXZlbnRzIGFuZCB3YWl0IGZvciBhIG1hdGNoLlxuXG4gICAgSW4gdGhlIGNhc2UgdGhhdCBhbiB1bmtub3duIHRhcmdldCBpcyByZXF1ZXN0ZWQsIHRoZW4gYW4gZXhjZXB0aW9uIHdpbGxcbiAgICBiZSB0aHJvd24uXG4gICoqL1xuICBzaWduYWxsZXIucmVxdWVzdFN0cmVhbSA9IGZ1bmN0aW9uKHRhcmdldElkLCBpZHgsIGNhbGxiYWNrKSB7XG4gICAgdmFyIGNhbGwgPSBnZXRBY3RpdmVDYWxsKHRhcmdldElkKTtcbiAgICB2YXIgc3RyZWFtO1xuXG4gICAgZnVuY3Rpb24gd2FpdEZvclN0cmVhbShwZWVySWQpIHtcbiAgICAgIGlmIChwZWVySWQgIT09IHRhcmdldElkKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgLy8gZ2V0IHRoZSBzdHJlYW1cbiAgICAgIHN0cmVhbSA9IGNhbGwucGMuZ2V0UmVtb3RlU3RyZWFtcygpW2lkeF07XG5cbiAgICAgIC8vIGlmIHdlIGhhdmUgdGhlIHN0cmVhbSwgdGhlbiByZW1vdmUgdGhlIGxpc3RlbmVyIGFuZCB0cmlnZ2VyIHRoZSBjYlxuICAgICAgaWYgKHN0cmVhbSkge1xuICAgICAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ3N0cmVhbTphZGRlZCcsIHdhaXRGb3JTdHJlYW0pO1xuICAgICAgICBjYWxsYmFjayhudWxsLCBzdHJlYW0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIGxvb2sgZm9yIHRoZSBzdHJlYW0gaW4gdGhlIHJlbW90ZSBzdHJlYW1zIG9mIHRoZSBjYWxsXG4gICAgc3RyZWFtID0gY2FsbC5wYy5nZXRSZW1vdGVTdHJlYW1zKClbaWR4XTtcblxuICAgIC8vIGlmIHdlIGZvdW5kIHRoZSBzdHJlYW0gdGhlbiB0cmlnZ2VyIHRoZSBjYWxsYmFja1xuICAgIGlmIChzdHJlYW0pIHtcbiAgICAgIGNhbGxiYWNrKG51bGwsIHN0cmVhbSk7XG4gICAgICByZXR1cm4gc2lnbmFsbGVyO1xuICAgIH1cblxuICAgIC8vIG90aGVyd2lzZSB3YWl0IGZvciB0aGUgc3RyZWFtXG4gICAgc2lnbmFsbGVyLm9uKCdzdHJlYW06YWRkZWQnLCB3YWl0Rm9yU3RyZWFtKTtcbiAgICByZXR1cm4gc2lnbmFsbGVyO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgcHJvZmlsZShkYXRhKVxuXG4gICAgVXBkYXRlIHRoZSBwcm9maWxlIGRhdGEgd2l0aCB0aGUgYXR0YWNoZWQgaW5mb3JtYXRpb24sIHNvIHdoZW5cbiAgICB0aGUgc2lnbmFsbGVyIGFubm91bmNlcyBpdCBpbmNsdWRlcyB0aGlzIGRhdGEgaW4gYWRkaXRpb24gdG8gYW55XG4gICAgcm9vbSBhbmQgaWQgaW5mb3JtYXRpb24uXG5cbiAgKiovXG4gIHNpZ25hbGxlci5wcm9maWxlID0gZnVuY3Rpb24oZGF0YSkge1xuICAgIGV4dGVuZChwcm9maWxlLCBkYXRhKTtcblxuICAgIC8vIGlmIHdlIGhhdmUgYWxyZWFkeSBhbm5vdW5jZWQsIHRoZW4gcmVhbm5vdW5jZSBvdXIgcHJvZmlsZSB0byBwcm92aWRlXG4gICAgLy8gb3RoZXJzIGEgYHBlZXI6dXBkYXRlYCBldmVudFxuICAgIGlmIChhbm5vdW5jZWQpIHtcbiAgICAgIGNsZWFyVGltZW91dCh1cGRhdGVUaW1lcik7XG4gICAgICB1cGRhdGVUaW1lciA9IHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICAgIHNpZ25hbGxlci5hbm5vdW5jZShwcm9maWxlKTtcbiAgICAgIH0sIChvcHRzIHx8IHt9KS51cGRhdGVEZWxheSB8fCAxMDAwKTtcbiAgICB9XG5cbiAgICByZXR1cm4gc2lnbmFsbGVyO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgd2FpdEZvckNhbGxcblxuICAgIGBgYFxuICAgIHdhaXRGb3JDYWxsKHRhcmdldElkLCBjYWxsYmFjaylcbiAgICBgYGBcblxuICAgIFdhaXQgZm9yIGEgY2FsbCBmcm9tIHRoZSBzcGVjaWZpZWQgdGFyZ2V0SWQuICBJZiB0aGUgY2FsbCBpcyBhbHJlYWR5XG4gICAgYWN0aXZlIHRoZSBjYWxsYmFjayB3aWxsIGJlIGZpcmVkIGltbWVkaWF0ZWx5LCBvdGhlcndpc2Ugd2Ugd2lsbCB3YWl0XG4gICAgZm9yIGEgYGNhbGw6c3RhcnRlZGAgZXZlbnQgdGhhdCBtYXRjaGVzIHRoZSByZXF1ZXN0ZWQgYHRhcmdldElkYFxuXG4gICoqL1xuICBzaWduYWxsZXIud2FpdEZvckNhbGwgPSBmdW5jdGlvbih0YXJnZXRJZCwgY2FsbGJhY2spIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldCh0YXJnZXRJZCk7XG5cbiAgICBpZiAoY2FsbCAmJiBjYWxsLmFjdGl2ZSkge1xuICAgICAgY2FsbGJhY2sobnVsbCwgY2FsbC5wYyk7XG4gICAgICByZXR1cm4gc2lnbmFsbGVyO1xuICAgIH1cblxuICAgIHNpZ25hbGxlci5vbignY2FsbDpzdGFydGVkJywgZnVuY3Rpb24gaGFuZGxlTmV3Q2FsbChpZCkge1xuICAgICAgaWYgKGlkID09PSB0YXJnZXRJZCkge1xuICAgICAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ2NhbGw6c3RhcnRlZCcsIGhhbmRsZU5ld0NhbGwpO1xuICAgICAgICBjYWxsYmFjayhudWxsLCBjYWxscy5nZXQoaWQpLnBjKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcblxuICAvLyBpZiB3ZSBoYXZlIGFuIGV4cGVjdGVkIG51bWJlciBvZiBsb2NhbCBzdHJlYW1zLCB0aGVuIHVzZSBhIGZpbHRlciB0b1xuICAvLyBjaGVjayBpZiB3ZSBzaG91bGQgcmVzcG9uZFxuICBpZiAoZXhwZWN0ZWRMb2NhbFN0cmVhbXMpIHtcbiAgICBzaWduYWxsZXIub24oJ3BlZXI6ZmlsdGVyJywgaGFuZGxlUGVlckZpbHRlcik7XG4gIH1cblxuICAvLyByZXNwb25kIHRvIGxvY2FsIGFubm91bmNlIG1lc3NhZ2VzXG4gIHNpZ25hbGxlci5vbignbG9jYWw6YW5ub3VuY2UnLCBoYW5kbGVMb2NhbEFubm91bmNlKTtcblxuICAvLyBoYW5kbGUgcGluZyBtZXNzYWdlc1xuICBzaWduYWxsZXIub24oJ21lc3NhZ2U6cGluZycsIGNhbGxzLnBpbmcpO1xuXG4gIC8vIHVzZSBnZW5pY2UgdG8gZmluZCBvdXIgaWNlU2VydmVyc1xuICByZXF1aXJlKCdydGMtY29yZS9nZW5pY2UnKShvcHRzLCBmdW5jdGlvbihlcnIsIHNlcnZlcnMpIHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICByZXR1cm4gY29uc29sZS5lcnJvcignY291bGQgbm90IGZpbmQgaWNlU2VydmVyczogJywgZXJyKTtcbiAgICB9XG5cbiAgICBpY2VTZXJ2ZXJzID0gc2VydmVycztcbiAgICBjaGVja1JlYWR5VG9Bbm5vdW5jZSgpO1xuICB9KTtcblxuICAvLyBpZiB3ZSBwbHVnaW4gaXMgYWN0aXZlLCB0aGVuIGluaXRpYWxpemUgaXRcbiAgaWYgKHBsdWdpbikge1xuICAgIGluaXRQbHVnaW4oKTtcbiAgfVxuXG4gIC8vIHBhc3MgdGhlIHNpZ25hbGxlciBvblxuICByZXR1cm4gc2lnbmFsbGVyO1xufTtcbiIsInZhciBydGMgPSByZXF1aXJlKCdydGMtdG9vbHMnKTtcbnZhciBkZWJ1ZyA9IHJ0Yy5sb2dnZXIoJ3J0Yy1xdWlja2Nvbm5lY3QnKTtcbnZhciBjbGVhbnVwID0gcmVxdWlyZSgncnRjLXRvb2xzL2NsZWFudXAnKTtcbnZhciBnZXRhYmxlID0gcmVxdWlyZSgnY29nL2dldGFibGUnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihzaWduYWxsZXIsIG9wdHMpIHtcbiAgdmFyIGNhbGxzID0gZ2V0YWJsZSh7fSk7XG4gIHZhciBnZXRQZWVyRGF0YSA9IHJlcXVpcmUoJy4vZ2V0cGVlcmRhdGEnKShzaWduYWxsZXIucGVlcnMpO1xuICB2YXIgaGVhcnRiZWF0O1xuXG4gIGZ1bmN0aW9uIGNyZWF0ZShpZCwgcGMpIHtcbiAgICBjYWxscy5zZXQoaWQsIHtcbiAgICAgIGFjdGl2ZTogZmFsc2UsXG4gICAgICBwYzogcGMsXG4gICAgICBjaGFubmVsczogZ2V0YWJsZSh7fSksXG4gICAgICBzdHJlYW1zOiBbXSxcbiAgICAgIGxhc3RwaW5nOiBEYXRlLm5vdygpXG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBjcmVhdGVTdHJlYW1BZGRIYW5kbGVyKGlkKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKGV2dCkge1xuICAgICAgZGVidWcoJ3BlZXIgJyArIGlkICsgJyBhZGRlZCBzdHJlYW0nKTtcbiAgICAgIHVwZGF0ZVJlbW90ZVN0cmVhbXMoaWQpO1xuICAgICAgcmVjZWl2ZVJlbW90ZVN0cmVhbShpZCkoZXZ0LnN0cmVhbSk7XG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNyZWF0ZVN0cmVhbVJlbW92ZUhhbmRsZXIoaWQpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24oZXZ0KSB7XG4gICAgICBkZWJ1ZygncGVlciAnICsgaWQgKyAnIHJlbW92ZWQgc3RyZWFtJyk7XG4gICAgICB1cGRhdGVSZW1vdGVTdHJlYW1zKGlkKTtcbiAgICAgIHNpZ25hbGxlcignc3RyZWFtOnJlbW92ZWQnLCBpZCwgZXZ0LnN0cmVhbSk7XG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGVuZChpZCkge1xuICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KGlkKTtcblxuICAgIC8vIGlmIHdlIGhhdmUgbm8gZGF0YSwgdGhlbiBkbyBub3RoaW5nXG4gICAgaWYgKCEgY2FsbCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIGlmIHdlIGhhdmUgbm8gZGF0YSwgdGhlbiByZXR1cm5cbiAgICBjYWxsLmNoYW5uZWxzLmtleXMoKS5mb3JFYWNoKGZ1bmN0aW9uKGxhYmVsKSB7XG4gICAgICB2YXIgY2hhbm5lbCA9IGNhbGwuY2hhbm5lbHMuZ2V0KGxhYmVsKTtcbiAgICAgIHZhciBhcmdzID0gW2lkLCBjaGFubmVsLCBsYWJlbF07XG5cbiAgICAgIC8vIGVtaXQgdGhlIHBsYWluIGNoYW5uZWw6Y2xvc2VkIGV2ZW50XG4gICAgICBzaWduYWxsZXIuYXBwbHkoc2lnbmFsbGVyLCBbJ2NoYW5uZWw6Y2xvc2VkJ10uY29uY2F0KGFyZ3MpKTtcblxuICAgICAgLy8gZW1pdCB0aGUgbGFiZWxsZWQgdmVyc2lvbiBvZiB0aGUgZXZlbnRcbiAgICAgIHNpZ25hbGxlci5hcHBseShzaWduYWxsZXIsIFsnY2hhbm5lbDpjbG9zZWQ6JyArIGxhYmVsXS5jb25jYXQoYXJncykpO1xuXG4gICAgICAvLyBkZWNvdXBsZSB0aGUgZXZlbnRzXG4gICAgICBjaGFubmVsLm9ub3BlbiA9IG51bGw7XG4gICAgfSk7XG5cbiAgICAvLyB0cmlnZ2VyIHN0cmVhbTpyZW1vdmVkIGV2ZW50cyBmb3IgZWFjaCBvZiB0aGUgcmVtb3Rlc3RyZWFtcyBpbiB0aGUgcGNcbiAgICBjYWxsLnN0cmVhbXMuZm9yRWFjaChmdW5jdGlvbihzdHJlYW0pIHtcbiAgICAgIHNpZ25hbGxlcignc3RyZWFtOnJlbW92ZWQnLCBpZCwgc3RyZWFtKTtcbiAgICB9KTtcblxuICAgIC8vIGRlbGV0ZSB0aGUgY2FsbCBkYXRhXG4gICAgY2FsbHMuZGVsZXRlKGlkKTtcblxuICAgIC8vIGlmIHdlIGhhdmUgbm8gbW9yZSBjYWxscywgZGlzYWJsZSB0aGUgaGVhcnRiZWF0XG4gICAgaWYgKGNhbGxzLmtleXMoKS5sZW5ndGggPT09IDApIHtcbiAgICAgIHJlc2V0SGVhcnRiZWF0KCk7XG4gICAgfVxuXG4gICAgLy8gdHJpZ2dlciB0aGUgY2FsbDplbmRlZCBldmVudFxuICAgIHNpZ25hbGxlcignY2FsbDplbmRlZCcsIGlkLCBjYWxsLnBjKTtcblxuICAgIC8vIGVuc3VyZSB0aGUgcGVlciBjb25uZWN0aW9uIGlzIHByb3Blcmx5IGNsZWFuZWQgdXBcbiAgICBjbGVhbnVwKGNhbGwucGMpO1xuICB9XG5cbiAgZnVuY3Rpb24gcGluZyhzZW5kZXIpIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChzZW5kZXIgJiYgc2VuZGVyLmlkKTtcblxuICAgIC8vIHNldCB0aGUgbGFzdCBwaW5nIGZvciB0aGUgZGF0YVxuICAgIGlmIChjYWxsKSB7XG4gICAgICBjYWxsLmxhc3RwaW5nID0gRGF0ZS5ub3coKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiByZWNlaXZlUmVtb3RlU3RyZWFtKGlkKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKHN0cmVhbSkge1xuICAgICAgc2lnbmFsbGVyKCdzdHJlYW06YWRkZWQnLCBpZCwgc3RyZWFtLCBnZXRQZWVyRGF0YShpZCkpO1xuICAgIH07XG4gIH1cblxuICBmdW5jdGlvbiByZXNldEhlYXJ0YmVhdCgpIHtcbiAgICBjbGVhckludGVydmFsKGhlYXJ0YmVhdCk7XG4gICAgaGVhcnRiZWF0ID0gMDtcbiAgfVxuXG4gIGZ1bmN0aW9uIHN0YXJ0KGlkLCBwYywgZGF0YSkge1xuICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KGlkKTtcbiAgICB2YXIgc3RyZWFtcyA9IFtdLmNvbmNhdChwYy5nZXRSZW1vdGVTdHJlYW1zKCkpO1xuXG4gICAgLy8gZmxhZyB0aGUgY2FsbCBhcyBhY3RpdmVcbiAgICBjYWxsLmFjdGl2ZSA9IHRydWU7XG4gICAgY2FsbC5zdHJlYW1zID0gW10uY29uY2F0KHBjLmdldFJlbW90ZVN0cmVhbXMoKSk7XG5cbiAgICBwYy5vbmFkZHN0cmVhbSA9IGNyZWF0ZVN0cmVhbUFkZEhhbmRsZXIoaWQpO1xuICAgIHBjLm9ucmVtb3Zlc3RyZWFtID0gY3JlYXRlU3RyZWFtUmVtb3ZlSGFuZGxlcihpZCk7XG5cbiAgICBkZWJ1ZyhzaWduYWxsZXIuaWQgKyAnIC0gJyArIGlkICsgJyBjYWxsIHN0YXJ0OiAnICsgc3RyZWFtcy5sZW5ndGggKyAnIHN0cmVhbXMnKTtcbiAgICBzaWduYWxsZXIoJ2NhbGw6c3RhcnRlZCcsIGlkLCBwYywgZGF0YSk7XG5cbiAgICAvLyBjb25maWd1cmUgdGhlIGhlYXJ0YmVhdCB0aW1lclxuICAgIGhlYXJ0YmVhdCA9IGhlYXJ0YmVhdCB8fCByZXF1aXJlKCcuL2hlYXJ0YmVhdCcpKHNpZ25hbGxlciwgY2FsbHMsIG9wdHMpO1xuXG4gICAgLy8gZXhhbWluZSB0aGUgZXhpc3RpbmcgcmVtb3RlIHN0cmVhbXMgYWZ0ZXIgYSBzaG9ydCBkZWxheVxuICAgIHByb2Nlc3MubmV4dFRpY2soZnVuY3Rpb24oKSB7XG4gICAgICAvLyBpdGVyYXRlIHRocm91Z2ggYW55IHJlbW90ZSBzdHJlYW1zXG4gICAgICBzdHJlYW1zLmZvckVhY2gocmVjZWl2ZVJlbW90ZVN0cmVhbShpZCkpO1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gdXBkYXRlUmVtb3RlU3RyZWFtcyhpZCkge1xuICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KGlkKTtcblxuICAgIGlmIChjYWxsICYmIGNhbGwucGMpIHtcbiAgICAgIGNhbGwuc3RyZWFtcyA9IFtdLmNvbmNhdChjYWxsLnBjLmdldFJlbW90ZVN0cmVhbXMoKSk7XG4gICAgfVxuICB9XG5cbiAgY2FsbHMuY3JlYXRlID0gY3JlYXRlO1xuICBjYWxscy5lbmQgPSBlbmQ7XG4gIGNhbGxzLnBpbmcgPSBwaW5nO1xuICBjYWxscy5zdGFydCA9IHN0YXJ0O1xuXG4gIHJldHVybiBjYWxscztcbn07XG4iLCJtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHBlZXJzKSB7XG4gIHJldHVybiBmdW5jdGlvbihpZCkge1xuICAgIHZhciBwZWVyID0gcGVlcnMuZ2V0KGlkKTtcbiAgICByZXR1cm4gcGVlciAmJiBwZWVyLmRhdGE7XG4gIH07XG59O1xuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihzaWduYWxsZXIsIGNhbGxzLCBvcHRzKSB7XG4gIHZhciBoZWFydGJlYXQgPSAob3B0cyB8fCB7fSkuaGVhcnRiZWF0IHx8IDI1MDA7XG4gIHZhciBoZWFydGJlYXRUaW1lciA9IDA7XG5cbiAgZnVuY3Rpb24gc2VuZCgpIHtcbiAgICB2YXIgdGlja0luYWN0aXZlID0gKERhdGUubm93KCkgLSAoaGVhcnRiZWF0ICogNCkpO1xuXG4gICAgLy8gaXRlcmF0ZSB0aHJvdWdoIG91ciBlc3RhYmxpc2hlZCBjYWxsc1xuICAgIGNhbGxzLmtleXMoKS5mb3JFYWNoKGZ1bmN0aW9uKGlkKSB7XG4gICAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChpZCk7XG5cbiAgICAgIC8vIGlmIHRoZSBjYWxsIHBpbmcgaXMgdG9vIG9sZCwgZW5kIHRoZSBjYWxsXG4gICAgICBpZiAoY2FsbC5sYXN0cGluZyA8IHRpY2tJbmFjdGl2ZSkge1xuICAgICAgICByZXR1cm4gY2FsbHMuZW5kKGlkKTtcbiAgICAgIH1cblxuICAgICAgLy8gc2VuZCBhIHBpbmcgbWVzc2FnZVxuICAgICAgc2lnbmFsbGVyLnRvKGlkKS5zZW5kKCcvcGluZycpO1xuICAgIH0pO1xuICB9XG5cbiAgaWYgKCEgaGVhcnRiZWF0KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgcmV0dXJuIHNldEludGVydmFsKHNlbmQsIGhlYXJ0YmVhdCk7XG59O1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxuLyoqXG4jIyBjb2cvZGVmYXVsdHNcblxuYGBganNcbnZhciBkZWZhdWx0cyA9IHJlcXVpcmUoJ2NvZy9kZWZhdWx0cycpO1xuYGBgXG5cbiMjIyBkZWZhdWx0cyh0YXJnZXQsICopXG5cblNoYWxsb3cgY29weSBvYmplY3QgcHJvcGVydGllcyBmcm9tIHRoZSBzdXBwbGllZCBzb3VyY2Ugb2JqZWN0cyAoKikgaW50b1xudGhlIHRhcmdldCBvYmplY3QsIHJldHVybmluZyB0aGUgdGFyZ2V0IG9iamVjdCBvbmNlIGNvbXBsZXRlZC4gIERvIG5vdCxcbmhvd2V2ZXIsIG92ZXJ3cml0ZSBleGlzdGluZyBrZXlzIHdpdGggbmV3IHZhbHVlczpcblxuYGBganNcbmRlZmF1bHRzKHsgYTogMSwgYjogMiB9LCB7IGM6IDMgfSwgeyBkOiA0IH0sIHsgYjogNSB9KSk7XG5gYGBcblxuU2VlIGFuIGV4YW1wbGUgb24gW3JlcXVpcmViaW5dKGh0dHA6Ly9yZXF1aXJlYmluLmNvbS8/Z2lzdD02MDc5NDc1KS5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbih0YXJnZXQpIHtcbiAgLy8gZW5zdXJlIHdlIGhhdmUgYSB0YXJnZXRcbiAgdGFyZ2V0ID0gdGFyZ2V0IHx8IHt9O1xuXG4gIC8vIGl0ZXJhdGUgdGhyb3VnaCB0aGUgc291cmNlcyBhbmQgY29weSB0byB0aGUgdGFyZ2V0XG4gIFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKS5mb3JFYWNoKGZ1bmN0aW9uKHNvdXJjZSkge1xuICAgIGlmICghIHNvdXJjZSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGZvciAodmFyIHByb3AgaW4gc291cmNlKSB7XG4gICAgICBpZiAodGFyZ2V0W3Byb3BdID09PSB2b2lkIDApIHtcbiAgICAgICAgdGFyZ2V0W3Byb3BdID0gc291cmNlW3Byb3BdO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHRhcmdldDtcbn07IiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxuLyoqXG4jIyBjb2cvZXh0ZW5kXG5cbmBgYGpzXG52YXIgZXh0ZW5kID0gcmVxdWlyZSgnY29nL2V4dGVuZCcpO1xuYGBgXG5cbiMjIyBleHRlbmQodGFyZ2V0LCAqKVxuXG5TaGFsbG93IGNvcHkgb2JqZWN0IHByb3BlcnRpZXMgZnJvbSB0aGUgc3VwcGxpZWQgc291cmNlIG9iamVjdHMgKCopIGludG9cbnRoZSB0YXJnZXQgb2JqZWN0LCByZXR1cm5pbmcgdGhlIHRhcmdldCBvYmplY3Qgb25jZSBjb21wbGV0ZWQ6XG5cbmBgYGpzXG5leHRlbmQoeyBhOiAxLCBiOiAyIH0sIHsgYzogMyB9LCB7IGQ6IDQgfSwgeyBiOiA1IH0pKTtcbmBgYFxuXG5TZWUgYW4gZXhhbXBsZSBvbiBbcmVxdWlyZWJpbl0oaHR0cDovL3JlcXVpcmViaW4uY29tLz9naXN0PTYwNzk0NzUpLlxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHRhcmdldCkge1xuICBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSkuZm9yRWFjaChmdW5jdGlvbihzb3VyY2UpIHtcbiAgICBpZiAoISBzb3VyY2UpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBmb3IgKHZhciBwcm9wIGluIHNvdXJjZSkge1xuICAgICAgdGFyZ2V0W3Byb3BdID0gc291cmNlW3Byb3BdO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHRhcmdldDtcbn07IiwiLyoqXG4gICMjIGNvZy9nZXRhYmxlXG5cbiAgVGFrZSBhbiBvYmplY3QgYW5kIHByb3ZpZGUgYSB3cmFwcGVyIHRoYXQgYWxsb3dzIHlvdSB0byBgZ2V0YCBhbmRcbiAgYHNldGAgdmFsdWVzIG9uIHRoYXQgb2JqZWN0LlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24odGFyZ2V0KSB7XG4gIGZ1bmN0aW9uIGdldChrZXkpIHtcbiAgICByZXR1cm4gdGFyZ2V0W2tleV07XG4gIH1cblxuICBmdW5jdGlvbiBzZXQoa2V5LCB2YWx1ZSkge1xuICAgIHRhcmdldFtrZXldID0gdmFsdWU7XG4gIH1cblxuICBmdW5jdGlvbiByZW1vdmUoa2V5KSB7XG4gICAgcmV0dXJuIGRlbGV0ZSB0YXJnZXRba2V5XTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGtleXMoKSB7XG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHRhcmdldCk7XG4gIH07XG5cbiAgZnVuY3Rpb24gdmFsdWVzKCkge1xuICAgIHJldHVybiBPYmplY3Qua2V5cyh0YXJnZXQpLm1hcChmdW5jdGlvbihrZXkpIHtcbiAgICAgIHJldHVybiB0YXJnZXRba2V5XTtcbiAgICB9KTtcbiAgfTtcblxuICBpZiAodHlwZW9mIHRhcmdldCAhPSAnb2JqZWN0Jykge1xuICAgIHJldHVybiB0YXJnZXQ7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGdldDogZ2V0LFxuICAgIHNldDogc2V0LFxuICAgIHJlbW92ZTogcmVtb3ZlLFxuICAgIGRlbGV0ZTogcmVtb3ZlLFxuICAgIGtleXM6IGtleXMsXG4gICAgdmFsdWVzOiB2YWx1ZXNcbiAgfTtcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG4vKipcbiAgIyMgY29nL2pzb25wYXJzZVxuXG4gIGBgYGpzXG4gIHZhciBqc29ucGFyc2UgPSByZXF1aXJlKCdjb2cvanNvbnBhcnNlJyk7XG4gIGBgYFxuXG4gICMjIyBqc29ucGFyc2UoaW5wdXQpXG5cbiAgVGhpcyBmdW5jdGlvbiB3aWxsIGF0dGVtcHQgdG8gYXV0b21hdGljYWxseSBkZXRlY3Qgc3RyaW5naWZpZWQgSlNPTiwgYW5kXG4gIHdoZW4gZGV0ZWN0ZWQgd2lsbCBwYXJzZSBpbnRvIEpTT04gb2JqZWN0cy4gIFRoZSBmdW5jdGlvbiBsb29rcyBmb3Igc3RyaW5nc1xuICB0aGF0IGxvb2sgYW5kIHNtZWxsIGxpa2Ugc3RyaW5naWZpZWQgSlNPTiwgYW5kIGlmIGZvdW5kIGF0dGVtcHRzIHRvXG4gIGBKU09OLnBhcnNlYCB0aGUgaW5wdXQgaW50byBhIHZhbGlkIG9iamVjdC5cblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKGlucHV0KSB7XG4gIHZhciBpc1N0cmluZyA9IHR5cGVvZiBpbnB1dCA9PSAnc3RyaW5nJyB8fCAoaW5wdXQgaW5zdGFuY2VvZiBTdHJpbmcpO1xuICB2YXIgcmVOdW1lcmljID0gL15cXC0/XFxkK1xcLj9cXGQqJC87XG4gIHZhciBzaG91bGRQYXJzZSA7XG4gIHZhciBmaXJzdENoYXI7XG4gIHZhciBsYXN0Q2hhcjtcblxuICBpZiAoKCEgaXNTdHJpbmcpIHx8IGlucHV0Lmxlbmd0aCA8IDIpIHtcbiAgICBpZiAoaXNTdHJpbmcgJiYgcmVOdW1lcmljLnRlc3QoaW5wdXQpKSB7XG4gICAgICByZXR1cm4gcGFyc2VGbG9hdChpbnB1dCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGlucHV0O1xuICB9XG5cbiAgLy8gY2hlY2sgZm9yIHRydWUgb3IgZmFsc2VcbiAgaWYgKGlucHV0ID09PSAndHJ1ZScgfHwgaW5wdXQgPT09ICdmYWxzZScpIHtcbiAgICByZXR1cm4gaW5wdXQgPT09ICd0cnVlJztcbiAgfVxuXG4gIC8vIGNoZWNrIGZvciBudWxsXG4gIGlmIChpbnB1dCA9PT0gJ251bGwnKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvLyBnZXQgdGhlIGZpcnN0IGFuZCBsYXN0IGNoYXJhY3RlcnNcbiAgZmlyc3RDaGFyID0gaW5wdXQuY2hhckF0KDApO1xuICBsYXN0Q2hhciA9IGlucHV0LmNoYXJBdChpbnB1dC5sZW5ndGggLSAxKTtcblxuICAvLyBkZXRlcm1pbmUgd2hldGhlciB3ZSBzaG91bGQgSlNPTi5wYXJzZSB0aGUgaW5wdXRcbiAgc2hvdWxkUGFyc2UgPVxuICAgIChmaXJzdENoYXIgPT0gJ3snICYmIGxhc3RDaGFyID09ICd9JykgfHxcbiAgICAoZmlyc3RDaGFyID09ICdbJyAmJiBsYXN0Q2hhciA9PSAnXScpIHx8XG4gICAgKGZpcnN0Q2hhciA9PSAnXCInICYmIGxhc3RDaGFyID09ICdcIicpO1xuXG4gIGlmIChzaG91bGRQYXJzZSkge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShpbnB1dCk7XG4gICAgfVxuICAgIGNhdGNoIChlKSB7XG4gICAgICAvLyBhcHBhcmVudGx5IGl0IHdhc24ndCB2YWxpZCBqc29uLCBjYXJyeSBvbiB3aXRoIHJlZ3VsYXIgcHJvY2Vzc2luZ1xuICAgIH1cbiAgfVxuXG5cbiAgcmV0dXJuIHJlTnVtZXJpYy50ZXN0KGlucHV0KSA/IHBhcnNlRmxvYXQoaW5wdXQpIDogaW5wdXQ7XG59OyIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbi8qKlxuICAjIyBjb2cvbG9nZ2VyXG5cbiAgYGBganNcbiAgdmFyIGxvZ2dlciA9IHJlcXVpcmUoJ2NvZy9sb2dnZXInKTtcbiAgYGBgXG5cbiAgU2ltcGxlIGJyb3dzZXIgbG9nZ2luZyBvZmZlcmluZyBzaW1pbGFyIGZ1bmN0aW9uYWxpdHkgdG8gdGhlXG4gIFtkZWJ1Z10oaHR0cHM6Ly9naXRodWIuY29tL3Zpc2lvbm1lZGlhL2RlYnVnKSBtb2R1bGUuXG5cbiAgIyMjIFVzYWdlXG5cbiAgQ3JlYXRlIHlvdXIgc2VsZiBhIG5ldyBsb2dnaW5nIGluc3RhbmNlIGFuZCBnaXZlIGl0IGEgbmFtZTpcblxuICBgYGBqc1xuICB2YXIgZGVidWcgPSBsb2dnZXIoJ3BoaWwnKTtcbiAgYGBgXG5cbiAgTm93IGRvIHNvbWUgZGVidWdnaW5nOlxuXG4gIGBgYGpzXG4gIGRlYnVnKCdoZWxsbycpO1xuICBgYGBcblxuICBBdCB0aGlzIHN0YWdlLCBubyBsb2cgb3V0cHV0IHdpbGwgYmUgZ2VuZXJhdGVkIGJlY2F1c2UgeW91ciBsb2dnZXIgaXNcbiAgY3VycmVudGx5IGRpc2FibGVkLiAgRW5hYmxlIGl0OlxuXG4gIGBgYGpzXG4gIGxvZ2dlci5lbmFibGUoJ3BoaWwnKTtcbiAgYGBgXG5cbiAgTm93IGRvIHNvbWUgbW9yZSBsb2dnZXI6XG5cbiAgYGBganNcbiAgZGVidWcoJ09oIHRoaXMgaXMgc28gbXVjaCBuaWNlciA6KScpO1xuICAvLyAtLT4gcGhpbDogT2ggdGhpcyBpcyBzb21lIG11Y2ggbmljZXIgOilcbiAgYGBgXG5cbiAgIyMjIFJlZmVyZW5jZVxuKiovXG5cbnZhciBhY3RpdmUgPSBbXTtcbnZhciB1bmxlYXNoTGlzdGVuZXJzID0gW107XG52YXIgdGFyZ2V0cyA9IFsgY29uc29sZSBdO1xuXG4vKipcbiAgIyMjIyBsb2dnZXIobmFtZSlcblxuICBDcmVhdGUgYSBuZXcgbG9nZ2luZyBpbnN0YW5jZS5cbioqL1xudmFyIGxvZ2dlciA9IG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24obmFtZSkge1xuICAvLyBpbml0aWFsIGVuYWJsZWQgY2hlY2tcbiAgdmFyIGVuYWJsZWQgPSBjaGVja0FjdGl2ZSgpO1xuXG4gIGZ1bmN0aW9uIGNoZWNrQWN0aXZlKCkge1xuICAgIHJldHVybiBlbmFibGVkID0gYWN0aXZlLmluZGV4T2YoJyonKSA+PSAwIHx8IGFjdGl2ZS5pbmRleE9mKG5hbWUpID49IDA7XG4gIH1cblxuICAvLyByZWdpc3RlciB0aGUgY2hlY2sgYWN0aXZlIHdpdGggdGhlIGxpc3RlbmVycyBhcnJheVxuICB1bmxlYXNoTGlzdGVuZXJzW3VubGVhc2hMaXN0ZW5lcnMubGVuZ3RoXSA9IGNoZWNrQWN0aXZlO1xuXG4gIC8vIHJldHVybiB0aGUgYWN0dWFsIGxvZ2dpbmcgZnVuY3Rpb25cbiAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSBhIHN0cmluZyBtZXNzYWdlXG4gICAgaWYgKHR5cGVvZiBhcmdzWzBdID09ICdzdHJpbmcnIHx8IChhcmdzWzBdIGluc3RhbmNlb2YgU3RyaW5nKSkge1xuICAgICAgYXJnc1swXSA9IG5hbWUgKyAnOiAnICsgYXJnc1swXTtcbiAgICB9XG5cbiAgICAvLyBpZiBub3QgZW5hYmxlZCwgYmFpbFxuICAgIGlmICghIGVuYWJsZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBsb2dcbiAgICB0YXJnZXRzLmZvckVhY2goZnVuY3Rpb24odGFyZ2V0KSB7XG4gICAgICB0YXJnZXQubG9nLmFwcGx5KHRhcmdldCwgYXJncyk7XG4gICAgfSk7XG4gIH07XG59O1xuXG4vKipcbiAgIyMjIyBsb2dnZXIucmVzZXQoKVxuXG4gIFJlc2V0IGxvZ2dpbmcgKHJlbW92ZSB0aGUgZGVmYXVsdCBjb25zb2xlIGxvZ2dlciwgZmxhZyBhbGwgbG9nZ2VycyBhc1xuICBpbmFjdGl2ZSwgZXRjLCBldGMuXG4qKi9cbmxvZ2dlci5yZXNldCA9IGZ1bmN0aW9uKCkge1xuICAvLyByZXNldCB0YXJnZXRzIGFuZCBhY3RpdmUgc3RhdGVzXG4gIHRhcmdldHMgPSBbXTtcbiAgYWN0aXZlID0gW107XG5cbiAgcmV0dXJuIGxvZ2dlci5lbmFibGUoKTtcbn07XG5cbi8qKlxuICAjIyMjIGxvZ2dlci50byh0YXJnZXQpXG5cbiAgQWRkIGEgbG9nZ2luZyB0YXJnZXQuICBUaGUgbG9nZ2VyIG11c3QgaGF2ZSBhIGBsb2dgIG1ldGhvZCBhdHRhY2hlZC5cblxuKiovXG5sb2dnZXIudG8gPSBmdW5jdGlvbih0YXJnZXQpIHtcbiAgdGFyZ2V0cyA9IHRhcmdldHMuY29uY2F0KHRhcmdldCB8fCBbXSk7XG5cbiAgcmV0dXJuIGxvZ2dlcjtcbn07XG5cbi8qKlxuICAjIyMjIGxvZ2dlci5lbmFibGUobmFtZXMqKVxuXG4gIEVuYWJsZSBsb2dnaW5nIHZpYSB0aGUgbmFtZWQgbG9nZ2luZyBpbnN0YW5jZXMuICBUbyBlbmFibGUgbG9nZ2luZyB2aWEgYWxsXG4gIGluc3RhbmNlcywgeW91IGNhbiBwYXNzIGEgd2lsZGNhcmQ6XG5cbiAgYGBganNcbiAgbG9nZ2VyLmVuYWJsZSgnKicpO1xuICBgYGBcblxuICBfX1RPRE86X18gd2lsZGNhcmQgZW5hYmxlcnNcbioqL1xubG9nZ2VyLmVuYWJsZSA9IGZ1bmN0aW9uKCkge1xuICAvLyB1cGRhdGUgdGhlIGFjdGl2ZVxuICBhY3RpdmUgPSBhY3RpdmUuY29uY2F0KFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKSk7XG5cbiAgLy8gdHJpZ2dlciB0aGUgdW5sZWFzaCBsaXN0ZW5lcnNcbiAgdW5sZWFzaExpc3RlbmVycy5mb3JFYWNoKGZ1bmN0aW9uKGxpc3RlbmVyKSB7XG4gICAgbGlzdGVuZXIoKTtcbiAgfSk7XG5cbiAgcmV0dXJuIGxvZ2dlcjtcbn07IiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxuLyoqXG4gICMjIGNvZy90aHJvdHRsZVxuXG4gIGBgYGpzXG4gIHZhciB0aHJvdHRsZSA9IHJlcXVpcmUoJ2NvZy90aHJvdHRsZScpO1xuICBgYGBcblxuICAjIyMgdGhyb3R0bGUoZm4sIGRlbGF5LCBvcHRzKVxuXG4gIEEgY2hlcnJ5LXBpY2thYmxlIHRocm90dGxlIGZ1bmN0aW9uLiAgVXNlZCB0byB0aHJvdHRsZSBgZm5gIHRvIGVuc3VyZVxuICB0aGF0IGl0IGNhbiBiZSBjYWxsZWQgYXQgbW9zdCBvbmNlIGV2ZXJ5IGBkZWxheWAgbWlsbGlzZWNvbmRzLiAgV2lsbFxuICBmaXJlIGZpcnN0IGV2ZW50IGltbWVkaWF0ZWx5LCBlbnN1cmluZyB0aGUgbmV4dCBldmVudCBmaXJlZCB3aWxsIG9jY3VyXG4gIGF0IGxlYXN0IGBkZWxheWAgbWlsbGlzZWNvbmRzIGFmdGVyIHRoZSBmaXJzdCwgYW5kIHNvIG9uLlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oZm4sIGRlbGF5LCBvcHRzKSB7XG4gIHZhciBsYXN0RXhlYyA9IChvcHRzIHx8IHt9KS5sZWFkaW5nICE9PSBmYWxzZSA/IDAgOiBEYXRlLm5vdygpO1xuICB2YXIgdHJhaWxpbmcgPSAob3B0cyB8fCB7fSkudHJhaWxpbmc7XG4gIHZhciB0aW1lcjtcbiAgdmFyIHF1ZXVlZEFyZ3M7XG4gIHZhciBxdWV1ZWRTY29wZTtcblxuICAvLyB0cmFpbGluZyBkZWZhdWx0cyB0byB0cnVlXG4gIHRyYWlsaW5nID0gdHJhaWxpbmcgfHwgdHJhaWxpbmcgPT09IHVuZGVmaW5lZDtcbiAgXG4gIGZ1bmN0aW9uIGludm9rZURlZmVyZWQoKSB7XG4gICAgZm4uYXBwbHkocXVldWVkU2NvcGUsIHF1ZXVlZEFyZ3MgfHwgW10pO1xuICAgIGxhc3RFeGVjID0gRGF0ZS5ub3coKTtcbiAgfVxuXG4gIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICB2YXIgdGljayA9IERhdGUubm93KCk7XG4gICAgdmFyIGVsYXBzZWQgPSB0aWNrIC0gbGFzdEV4ZWM7XG5cbiAgICAvLyBhbHdheXMgY2xlYXIgdGhlIGRlZmVyZWQgdGltZXJcbiAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuXG4gICAgaWYgKGVsYXBzZWQgPCBkZWxheSkge1xuICAgICAgcXVldWVkQXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAwKTtcbiAgICAgIHF1ZXVlZFNjb3BlID0gdGhpcztcblxuICAgICAgcmV0dXJuIHRyYWlsaW5nICYmICh0aW1lciA9IHNldFRpbWVvdXQoaW52b2tlRGVmZXJlZCwgZGVsYXkgLSBlbGFwc2VkKSk7XG4gICAgfVxuXG4gICAgLy8gY2FsbCB0aGUgZnVuY3Rpb25cbiAgICBsYXN0RXhlYyA9IHRpY2s7XG4gICAgZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgfTtcbn07IiwiLy8gc2hpbSBmb3IgdXNpbmcgcHJvY2VzcyBpbiBicm93c2VyXG5cbnZhciBwcm9jZXNzID0gbW9kdWxlLmV4cG9ydHMgPSB7fTtcbnZhciBxdWV1ZSA9IFtdO1xudmFyIGRyYWluaW5nID0gZmFsc2U7XG52YXIgY3VycmVudFF1ZXVlO1xudmFyIHF1ZXVlSW5kZXggPSAtMTtcblxuZnVuY3Rpb24gY2xlYW5VcE5leHRUaWNrKCkge1xuICAgIGRyYWluaW5nID0gZmFsc2U7XG4gICAgaWYgKGN1cnJlbnRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgcXVldWUgPSBjdXJyZW50UXVldWUuY29uY2F0KHF1ZXVlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgfVxuICAgIGlmIChxdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgZHJhaW5RdWV1ZSgpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gZHJhaW5RdWV1ZSgpIHtcbiAgICBpZiAoZHJhaW5pbmcpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2YXIgdGltZW91dCA9IHNldFRpbWVvdXQoY2xlYW5VcE5leHRUaWNrKTtcbiAgICBkcmFpbmluZyA9IHRydWU7XG5cbiAgICB2YXIgbGVuID0gcXVldWUubGVuZ3RoO1xuICAgIHdoaWxlKGxlbikge1xuICAgICAgICBjdXJyZW50UXVldWUgPSBxdWV1ZTtcbiAgICAgICAgcXVldWUgPSBbXTtcbiAgICAgICAgd2hpbGUgKCsrcXVldWVJbmRleCA8IGxlbikge1xuICAgICAgICAgICAgY3VycmVudFF1ZXVlW3F1ZXVlSW5kZXhdLnJ1bigpO1xuICAgICAgICB9XG4gICAgICAgIHF1ZXVlSW5kZXggPSAtMTtcbiAgICAgICAgbGVuID0gcXVldWUubGVuZ3RoO1xuICAgIH1cbiAgICBjdXJyZW50UXVldWUgPSBudWxsO1xuICAgIGRyYWluaW5nID0gZmFsc2U7XG4gICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xufVxuXG5wcm9jZXNzLm5leHRUaWNrID0gZnVuY3Rpb24gKGZ1bikge1xuICAgIHZhciBhcmdzID0gbmV3IEFycmF5KGFyZ3VtZW50cy5sZW5ndGggLSAxKTtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgZm9yICh2YXIgaSA9IDE7IGkgPCBhcmd1bWVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIGFyZ3NbaSAtIDFdID0gYXJndW1lbnRzW2ldO1xuICAgICAgICB9XG4gICAgfVxuICAgIHF1ZXVlLnB1c2gobmV3IEl0ZW0oZnVuLCBhcmdzKSk7XG4gICAgaWYgKHF1ZXVlLmxlbmd0aCA9PT0gMSAmJiAhZHJhaW5pbmcpIHtcbiAgICAgICAgc2V0VGltZW91dChkcmFpblF1ZXVlLCAwKTtcbiAgICB9XG59O1xuXG4vLyB2OCBsaWtlcyBwcmVkaWN0aWJsZSBvYmplY3RzXG5mdW5jdGlvbiBJdGVtKGZ1biwgYXJyYXkpIHtcbiAgICB0aGlzLmZ1biA9IGZ1bjtcbiAgICB0aGlzLmFycmF5ID0gYXJyYXk7XG59XG5JdGVtLnByb3RvdHlwZS5ydW4gPSBmdW5jdGlvbiAoKSB7XG4gICAgdGhpcy5mdW4uYXBwbHkobnVsbCwgdGhpcy5hcnJheSk7XG59O1xucHJvY2Vzcy50aXRsZSA9ICdicm93c2VyJztcbnByb2Nlc3MuYnJvd3NlciA9IHRydWU7XG5wcm9jZXNzLmVudiA9IHt9O1xucHJvY2Vzcy5hcmd2ID0gW107XG5wcm9jZXNzLnZlcnNpb24gPSAnJzsgLy8gZW1wdHkgc3RyaW5nIHRvIGF2b2lkIHJlZ2V4cCBpc3N1ZXNcbnByb2Nlc3MudmVyc2lvbnMgPSB7fTtcblxuZnVuY3Rpb24gbm9vcCgpIHt9XG5cbnByb2Nlc3Mub24gPSBub29wO1xucHJvY2Vzcy5hZGRMaXN0ZW5lciA9IG5vb3A7XG5wcm9jZXNzLm9uY2UgPSBub29wO1xucHJvY2Vzcy5vZmYgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVMaXN0ZW5lciA9IG5vb3A7XG5wcm9jZXNzLnJlbW92ZUFsbExpc3RlbmVycyA9IG5vb3A7XG5wcm9jZXNzLmVtaXQgPSBub29wO1xuXG5wcm9jZXNzLmJpbmRpbmcgPSBmdW5jdGlvbiAobmFtZSkge1xuICAgIHRocm93IG5ldyBFcnJvcigncHJvY2Vzcy5iaW5kaW5nIGlzIG5vdCBzdXBwb3J0ZWQnKTtcbn07XG5cbi8vIFRPRE8oc2h0eWxtYW4pXG5wcm9jZXNzLmN3ZCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICcvJyB9O1xucHJvY2Vzcy5jaGRpciA9IGZ1bmN0aW9uIChkaXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuY2hkaXIgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcbnByb2Nlc3MudW1hc2sgPSBmdW5jdGlvbigpIHsgcmV0dXJuIDA7IH07XG4iLCJ2YXIgcmVEZWxpbSA9IC9bXFwuXFw6XS87XG5cbi8qKlxuICAjIG1idXNcblxuICBJZiBOb2RlJ3MgRXZlbnRFbWl0dGVyIGFuZCBFdmUgd2VyZSB0byBoYXZlIGEgY2hpbGQsIGl0IG1pZ2h0IGxvb2sgc29tZXRoaW5nIGxpa2UgdGhpcy5cbiAgTm8gd2lsZGNhcmQgc3VwcG9ydCBhdCB0aGlzIHN0YWdlIHRob3VnaC4uLlxuXG4gICMjIEV4YW1wbGUgVXNhZ2VcblxuICA8PDwgZG9jcy91c2FnZS5tZFxuXG4gICMjIFJlZmVyZW5jZVxuXG4gICMjIyBgbWJ1cyhuYW1lc3BhY2U/LCBwYXJlbnQ/LCBzY29wZT8pYFxuXG4gIENyZWF0ZSBhIG5ldyBtZXNzYWdlIGJ1cyB3aXRoIGBuYW1lc3BhY2VgIGluaGVyaXRpbmcgZnJvbSB0aGUgYHBhcmVudGBcbiAgbWJ1cyBpbnN0YW5jZS4gIElmIGV2ZW50cyBmcm9tIHRoaXMgbWVzc2FnZSBidXMgc2hvdWxkIGJlIHRyaWdnZXJlZCB3aXRoXG4gIGEgc3BlY2lmaWMgYHRoaXNgIHNjb3BlLCB0aGVuIHNwZWNpZnkgaXQgdXNpbmcgdGhlIGBzY29wZWAgYXJndW1lbnQuXG5cbioqL1xuXG52YXIgY3JlYXRlQnVzID0gbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihuYW1lc3BhY2UsIHBhcmVudCwgc2NvcGUpIHtcbiAgdmFyIHJlZ2lzdHJ5ID0ge307XG4gIHZhciBmZWVkcyA9IFtdO1xuXG4gIGZ1bmN0aW9uIGJ1cyhuYW1lKSB7XG4gICAgdmFyIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG4gICAgdmFyIGRlbGltaXRlZCA9IG5vcm1hbGl6ZShuYW1lKTtcbiAgICB2YXIgaGFuZGxlcnMgPSByZWdpc3RyeVtkZWxpbWl0ZWRdIHx8IFtdO1xuICAgIHZhciByZXN1bHRzO1xuXG4gICAgLy8gc2VuZCB0aHJvdWdoIHRoZSBmZWVkc1xuICAgIGZlZWRzLmZvckVhY2goZnVuY3Rpb24oZmVlZCkge1xuICAgICAgZmVlZCh7IG5hbWU6IGRlbGltaXRlZCwgYXJnczogYXJncyB9KTtcbiAgICB9KTtcblxuICAgIC8vIHJ1biB0aGUgcmVnaXN0ZXJlZCBoYW5kbGVyc1xuICAgIHJlc3VsdHMgPSBbXS5jb25jYXQoaGFuZGxlcnMpLm1hcChmdW5jdGlvbihoYW5kbGVyKSB7XG4gICAgICByZXR1cm4gaGFuZGxlci5hcHBseShzY29wZSB8fCB0aGlzLCBhcmdzKTtcbiAgICB9KTtcblxuICAgIC8vIHJ1biB0aGUgcGFyZW50IGhhbmRsZXJzXG4gICAgaWYgKGJ1cy5wYXJlbnQpIHtcbiAgICAgIHJlc3VsdHMgPSByZXN1bHRzLmNvbmNhdChcbiAgICAgICAgYnVzLnBhcmVudC5hcHBseShcbiAgICAgICAgICBzY29wZSB8fCB0aGlzLFxuICAgICAgICAgIFsobmFtZXNwYWNlID8gbmFtZXNwYWNlICsgJy4nIDogJycpICsgZGVsaW1pdGVkXS5jb25jYXQoYXJncylcbiAgICAgICAgKVxuICAgICAgKTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0cztcbiAgfVxuXG4gIC8qKlxuICAgICMjIyBgbWJ1cyNjbGVhcigpYFxuXG4gICAgUmVzZXQgdGhlIGhhbmRsZXIgcmVnaXN0cnksIHdoaWNoIGVzc2VudGlhbCBkZXJlZ2lzdGVycyBhbGwgZXZlbnQgbGlzdGVuZXJzLlxuXG4gICAgX0FsaWFzOl8gYHJlbW92ZUFsbExpc3RlbmVyc2BcbiAgKiovXG4gIGZ1bmN0aW9uIGNsZWFyKG5hbWUpIHtcbiAgICAvLyBpZiB3ZSBoYXZlIGEgbmFtZSwgcmVzZXQgaGFuZGxlcnMgZm9yIHRoYXQgaGFuZGxlclxuICAgIGlmIChuYW1lKSB7XG4gICAgICBkZWxldGUgcmVnaXN0cnlbbm9ybWFsaXplKG5hbWUpXTtcbiAgICB9XG4gICAgLy8gb3RoZXJ3aXNlLCByZXNldCB0aGUgZW50aXJlIGhhbmRsZXIgcmVnaXN0cnlcbiAgICBlbHNlIHtcbiAgICAgIHJlZ2lzdHJ5ID0ge307XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAgIyMjIGBtYnVzI2ZlZWQoaGFuZGxlcilgXG5cbiAgICBBdHRhY2ggYSBoYW5kbGVyIGZ1bmN0aW9uIHRoYXQgd2lsbCBzZWUgYWxsIGV2ZW50cyB0aGF0IGFyZSBzZW50IHRocm91Z2hcbiAgICB0aGlzIGJ1cyBpbiBhbiBcIm9iamVjdCBzdHJlYW1cIiBmb3JtYXQgdGhhdCBtYXRjaGVzIHRoZSBmb2xsb3dpbmcgZm9ybWF0OlxuXG4gICAgYGBgXG4gICAgeyBuYW1lOiAnZXZlbnQubmFtZScsIGFyZ3M6IFsgJ2V2ZW50JywgJ2FyZ3MnIF0gfVxuICAgIGBgYFxuXG4gICAgVGhlIGZlZWQgZnVuY3Rpb24gcmV0dXJucyBhIGZ1bmN0aW9uIHRoYXQgY2FuIGJlIGNhbGxlZCB0byBzdG9wIHRoZSBmZWVkXG4gICAgc2VuZGluZyBkYXRhLlxuXG4gICoqL1xuICBmdW5jdGlvbiBmZWVkKGhhbmRsZXIpIHtcbiAgICBmdW5jdGlvbiBzdG9wKCkge1xuICAgICAgZmVlZHMuc3BsaWNlKGZlZWRzLmluZGV4T2YoaGFuZGxlciksIDEpO1xuICAgIH1cblxuICAgIGZlZWRzLnB1c2goaGFuZGxlcik7XG4gICAgcmV0dXJuIHN0b3A7XG4gIH1cblxuICBmdW5jdGlvbiBub3JtYWxpemUobmFtZSkge1xuICAgIHJldHVybiAoQXJyYXkuaXNBcnJheShuYW1lKSA/IG5hbWUgOiBuYW1lLnNwbGl0KHJlRGVsaW0pKS5qb2luKCcuJyk7XG4gIH1cblxuICAvKipcbiAgICAjIyMgYG1idXMjb2ZmKG5hbWUsIGhhbmRsZXIpYFxuXG4gICAgRGVyZWdpc3RlciBhbiBldmVudCBoYW5kbGVyLlxuICAqKi9cbiAgZnVuY3Rpb24gb2ZmKG5hbWUsIGhhbmRsZXIpIHtcbiAgICB2YXIgaGFuZGxlcnMgPSByZWdpc3RyeVtub3JtYWxpemUobmFtZSldIHx8IFtdO1xuICAgIHZhciBpZHggPSBoYW5kbGVycyA/IGhhbmRsZXJzLmluZGV4T2YoaGFuZGxlci5fYWN0dWFsIHx8IGhhbmRsZXIpIDogLTE7XG5cbiAgICBpZiAoaWR4ID49IDApIHtcbiAgICAgIGhhbmRsZXJzLnNwbGljZShpZHgsIDEpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgICMjIyBgbWJ1cyNvbihuYW1lLCBoYW5kbGVyKWBcblxuICAgIFJlZ2lzdGVyIGFuIGV2ZW50IGhhbmRsZXIgZm9yIHRoZSBldmVudCBgbmFtZWAuXG5cbiAgKiovXG4gIGZ1bmN0aW9uIG9uKG5hbWUsIGhhbmRsZXIpIHtcbiAgICB2YXIgaGFuZGxlcnM7XG5cbiAgICBuYW1lID0gbm9ybWFsaXplKG5hbWUpO1xuICAgIGhhbmRsZXJzID0gcmVnaXN0cnlbbmFtZV07XG5cbiAgICBpZiAoaGFuZGxlcnMpIHtcbiAgICAgIGhhbmRsZXJzLnB1c2goaGFuZGxlcik7XG4gICAgfVxuICAgIGVsc2Uge1xuICAgICAgcmVnaXN0cnlbbmFtZV0gPSBbIGhhbmRsZXIgXTtcbiAgICB9XG5cbiAgICByZXR1cm4gYnVzO1xuICB9XG5cblxuICAvKipcbiAgICAjIyMgYG1idXMjb25jZShuYW1lLCBoYW5kbGVyKWBcblxuICAgIFJlZ2lzdGVyIGFuIGV2ZW50IGhhbmRsZXIgZm9yIHRoZSBldmVudCBgbmFtZWAgdGhhdCB3aWxsIG9ubHlcbiAgICB0cmlnZ2VyIG9uY2UgKGkuZS4gdGhlIGhhbmRsZXIgd2lsbCBiZSBkZXJlZ2lzdGVyZWQgaW1tZWRpYXRlbHkgYWZ0ZXJcbiAgICBiZWluZyB0cmlnZ2VyZWQgdGhlIGZpcnN0IHRpbWUpLlxuXG4gICoqL1xuICBmdW5jdGlvbiBvbmNlKG5hbWUsIGhhbmRsZXIpIHtcbiAgICBmdW5jdGlvbiBoYW5kbGVFdmVudCgpIHtcbiAgICAgIHZhciByZXN1bHQgPSBoYW5kbGVyLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG5cbiAgICAgIGJ1cy5vZmYobmFtZSwgaGFuZGxlRXZlbnQpO1xuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBoYW5kbGVyLl9hY3R1YWwgPSBoYW5kbGVFdmVudDtcbiAgICByZXR1cm4gb24obmFtZSwgaGFuZGxlRXZlbnQpO1xuICB9XG5cbiAgaWYgKHR5cGVvZiBuYW1lc3BhY2UgPT0gJ2Z1bmN0aW9uJykge1xuICAgIHBhcmVudCA9IG5hbWVzcGFjZTtcbiAgICBuYW1lc3BhY2UgPSAnJztcbiAgfVxuXG4gIG5hbWVzcGFjZSA9IG5vcm1hbGl6ZShuYW1lc3BhY2UgfHwgJycpO1xuXG4gIGJ1cy5jbGVhciA9IGJ1cy5yZW1vdmVBbGxMaXN0ZW5lcnMgPSBjbGVhcjtcbiAgYnVzLmZlZWQgPSBmZWVkO1xuICBidXMub24gPSBidXMuYWRkTGlzdGVuZXIgPSBvbjtcbiAgYnVzLm9uY2UgPSBvbmNlO1xuICBidXMub2ZmID0gYnVzLnJlbW92ZUxpc3RlbmVyID0gb2ZmO1xuICBidXMucGFyZW50ID0gcGFyZW50IHx8IChuYW1lc3BhY2UgJiYgY3JlYXRlQnVzKCkpO1xuXG4gIHJldHVybiBidXM7XG59O1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbi8qIGdsb2JhbCB3aW5kb3c6IGZhbHNlICovXG4vKiBnbG9iYWwgbmF2aWdhdG9yOiBmYWxzZSAqL1xuXG4ndXNlIHN0cmljdCc7XG5cbnZhciBicm93c2VyID0gcmVxdWlyZSgnZGV0ZWN0LWJyb3dzZXInKTtcblxuLyoqXG4gICMjIyBgcnRjLWNvcmUvZGV0ZWN0YFxuXG4gIEEgYnJvd3NlciBkZXRlY3Rpb24gaGVscGVyIGZvciBhY2Nlc3NpbmcgcHJlZml4LWZyZWUgdmVyc2lvbnMgb2YgdGhlIHZhcmlvdXNcbiAgV2ViUlRDIHR5cGVzLlxuXG4gICMjIyBFeGFtcGxlIFVzYWdlXG5cbiAgSWYgeW91IHdhbnRlZCB0byBnZXQgdGhlIG5hdGl2ZSBgUlRDUGVlckNvbm5lY3Rpb25gIHByb3RvdHlwZSBpbiBhbnkgYnJvd3NlclxuICB5b3UgY291bGQgZG8gdGhlIGZvbGxvd2luZzpcblxuICBgYGBqc1xuICB2YXIgZGV0ZWN0ID0gcmVxdWlyZSgncnRjLWNvcmUvZGV0ZWN0Jyk7IC8vIGFsc28gYXZhaWxhYmxlIGluIHJ0Yy9kZXRlY3RcbiAgdmFyIFJUQ1BlZXJDb25uZWN0aW9uID0gZGV0ZWN0KCdSVENQZWVyQ29ubmVjdGlvbicpO1xuICBgYGBcblxuICBUaGlzIHdvdWxkIHByb3ZpZGUgd2hhdGV2ZXIgdGhlIGJyb3dzZXIgcHJlZml4ZWQgdmVyc2lvbiBvZiB0aGVcbiAgUlRDUGVlckNvbm5lY3Rpb24gaXMgYXZhaWxhYmxlIChgd2Via2l0UlRDUGVlckNvbm5lY3Rpb25gLFxuICBgbW96UlRDUGVlckNvbm5lY3Rpb25gLCBldGMpLlxuKiovXG52YXIgZGV0ZWN0ID0gbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbih0YXJnZXQsIG9wdHMpIHtcbiAgdmFyIGF0dGFjaCA9IChvcHRzIHx8IHt9KS5hdHRhY2g7XG4gIHZhciBwcmVmaXhJZHg7XG4gIHZhciBwcmVmaXg7XG4gIHZhciB0ZXN0TmFtZTtcbiAgdmFyIGhvc3RPYmplY3QgPSB0aGlzIHx8ICh0eXBlb2Ygd2luZG93ICE9ICd1bmRlZmluZWQnID8gd2luZG93IDogdW5kZWZpbmVkKTtcblxuICAvLyBpbml0aWFsaXNlIHRvIGRlZmF1bHQgcHJlZml4ZXNcbiAgLy8gKHJldmVyc2Ugb3JkZXIgYXMgd2UgdXNlIGEgZGVjcmVtZW50aW5nIGZvciBsb29wKVxuICB2YXIgcHJlZml4ZXMgPSAoKG9wdHMgfHwge30pLnByZWZpeGVzIHx8IFsnbXMnLCAnbycsICdtb3onLCAnd2Via2l0J10pLmNvbmNhdCgnJyk7XG5cbiAgLy8gaWYgd2UgaGF2ZSBubyBob3N0IG9iamVjdCwgdGhlbiBhYm9ydFxuICBpZiAoISBob3N0T2JqZWN0KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gaXRlcmF0ZSB0aHJvdWdoIHRoZSBwcmVmaXhlcyBhbmQgcmV0dXJuIHRoZSBjbGFzcyBpZiBmb3VuZCBpbiBnbG9iYWxcbiAgZm9yIChwcmVmaXhJZHggPSBwcmVmaXhlcy5sZW5ndGg7IHByZWZpeElkeC0tOyApIHtcbiAgICBwcmVmaXggPSBwcmVmaXhlc1twcmVmaXhJZHhdO1xuXG4gICAgLy8gY29uc3RydWN0IHRoZSB0ZXN0IGNsYXNzIG5hbWVcbiAgICAvLyBpZiB3ZSBoYXZlIGEgcHJlZml4IGVuc3VyZSB0aGUgdGFyZ2V0IGhhcyBhbiB1cHBlcmNhc2UgZmlyc3QgY2hhcmFjdGVyXG4gICAgLy8gc3VjaCB0aGF0IGEgdGVzdCBmb3IgZ2V0VXNlck1lZGlhIHdvdWxkIHJlc3VsdCBpbiBhXG4gICAgLy8gc2VhcmNoIGZvciB3ZWJraXRHZXRVc2VyTWVkaWFcbiAgICB0ZXN0TmFtZSA9IHByZWZpeCArIChwcmVmaXggP1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldC5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIHRhcmdldC5zbGljZSgxKSA6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0KTtcblxuICAgIGlmICh0eXBlb2YgaG9zdE9iamVjdFt0ZXN0TmFtZV0gIT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIC8vIHVwZGF0ZSB0aGUgbGFzdCB1c2VkIHByZWZpeFxuICAgICAgZGV0ZWN0LmJyb3dzZXIgPSBkZXRlY3QuYnJvd3NlciB8fCBwcmVmaXgudG9Mb3dlckNhc2UoKTtcblxuICAgICAgaWYgKGF0dGFjaCkge1xuICAgICAgICAgaG9zdE9iamVjdFt0YXJnZXRdID0gaG9zdE9iamVjdFt0ZXN0TmFtZV07XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBob3N0T2JqZWN0W3Rlc3ROYW1lXTtcbiAgICB9XG4gIH1cbn07XG5cbi8vIGRldGVjdCBtb3ppbGxhICh5ZXMsIHRoaXMgZmVlbHMgZGlydHkpXG5kZXRlY3QubW96ID0gdHlwZW9mIG5hdmlnYXRvciAhPSAndW5kZWZpbmVkJyAmJiAhIW5hdmlnYXRvci5tb3pHZXRVc2VyTWVkaWE7XG5cbi8vIHNldCB0aGUgYnJvd3NlciBhbmQgYnJvd3NlciB2ZXJzaW9uXG5kZXRlY3QuYnJvd3NlciA9IGJyb3dzZXIubmFtZTtcbmRldGVjdC5icm93c2VyVmVyc2lvbiA9IGRldGVjdC52ZXJzaW9uID0gYnJvd3Nlci52ZXJzaW9uO1xuIiwiLyoqXG4gICMjIyBgcnRjLWNvcmUvZ2VuaWNlYFxuXG4gIFJlc3BvbmQgYXBwcm9wcmlhdGVseSB0byBvcHRpb25zIHRoYXQgYXJlIHBhc3NlZCB0byBwYWNrYWdlcyBsaWtlXG4gIGBydGMtcXVpY2tjb25uZWN0YCBhbmQgdHJpZ2dlciBhIGBjYWxsYmFja2AgKGVycm9yIGZpcnN0KSB3aXRoIGljZVNlcnZlclxuICB2YWx1ZXMuXG5cbiAgVGhlIGZ1bmN0aW9uIGxvb2tzIGZvciBlaXRoZXIgb2YgdGhlIGZvbGxvd2luZyBrZXlzIGluIHRoZSBvcHRpb25zLCBpblxuICB0aGUgZm9sbG93aW5nIG9yZGVyIG9yIHByZWNlZGVuY2U6XG5cbiAgMS4gYGljZWAgLSB0aGlzIGNhbiBlaXRoZXIgYmUgYW4gYXJyYXkgb2YgaWNlIHNlcnZlciB2YWx1ZXMgb3IgYSBnZW5lcmF0b3JcbiAgICAgZnVuY3Rpb24gKGluIHRoZSBzYW1lIGZvcm1hdCBhcyB0aGlzIGZ1bmN0aW9uKS4gIElmIHRoaXMga2V5IGNvbnRhaW5zIGFcbiAgICAgdmFsdWUgdGhlbiBhbnkgc2VydmVycyBzcGVjaWZpZWQgaW4gdGhlIGBpY2VTZXJ2ZXJzYCBrZXkgKDIpIHdpbGwgYmVcbiAgICAgaWdub3JlZC5cblxuICAyLiBgaWNlU2VydmVyc2AgLSBhbiBhcnJheSBvZiBpY2Ugc2VydmVyIHZhbHVlcy5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihvcHRzLCBjYWxsYmFjaykge1xuICB2YXIgaWNlID0gKG9wdHMgfHwge30pLmljZTtcbiAgdmFyIGljZVNlcnZlcnMgPSAob3B0cyB8fCB7fSkuaWNlU2VydmVycztcblxuICBpZiAodHlwZW9mIGljZSA9PSAnZnVuY3Rpb24nKSB7XG4gICAgcmV0dXJuIGljZShvcHRzLCBjYWxsYmFjayk7XG4gIH1cbiAgZWxzZSBpZiAoQXJyYXkuaXNBcnJheShpY2UpKSB7XG4gICAgcmV0dXJuIGNhbGxiYWNrKG51bGwsIFtdLmNvbmNhdChpY2UpKTtcbiAgfVxuXG4gIGNhbGxiYWNrKG51bGwsIFtdLmNvbmNhdChpY2VTZXJ2ZXJzIHx8IFtdKSk7XG59O1xuIiwidmFyIGJyb3dzZXJzID0gW1xuICBbICdjaHJvbWUnLCAvQ2hyb20oPzplfGl1bSlcXC8oWzAtOVxcLl0rKSg6P1xcc3wkKS8gXSxcbiAgWyAnZmlyZWZveCcsIC9GaXJlZm94XFwvKFswLTlcXC5dKykoPzpcXHN8JCkvIF0sXG4gIFsgJ29wZXJhJywgL09wZXJhXFwvKFswLTlcXC5dKykoPzpcXHN8JCkvIF0sXG4gIFsgJ2llJywgL1RyaWRlbnRcXC83XFwuMC4qcnZcXDooWzAtOVxcLl0rKVxcKS4qR2Vja28kLyBdLFxuICBbICdpZScsIC9NU0lFXFxzKFswLTlcXC5dKyk7LipUcmlkZW50XFwvWzQtN10uMC8gXSxcbiAgWyAnaWUnLCAvTVNJRVxccyg3XFwuMCkvIF0sXG4gIFsgJ2JiMTAnLCAvQkIxMDtcXHNUb3VjaC4qVmVyc2lvblxcLyhbMC05XFwuXSspLyBdLFxuICBbICdhbmRyb2lkJywgL0FuZHJvaWRcXHMoWzAtOVxcLl0rKS8gXSxcbiAgWyAnaW9zJywgL2lQYWRcXDtcXHNDUFVcXHNPU1xccyhbMC05XFwuX10rKS8gXSxcbiAgWyAnaW9zJywgIC9pUGhvbmVcXDtcXHNDUFVcXHNpUGhvbmVcXHNPU1xccyhbMC05XFwuX10rKS8gXSxcbiAgWyAnc2FmYXJpJywgL1NhZmFyaVxcLyhbMC05XFwuX10rKS8gXVxuXTtcblxudmFyIG1hdGNoID0gYnJvd3NlcnMubWFwKG1hdGNoKS5maWx0ZXIoaXNNYXRjaClbMF07XG52YXIgcGFydHMgPSBtYXRjaCAmJiBtYXRjaFszXS5zcGxpdCgvWy5fXS8pLnNsaWNlKDAsMyk7XG5cbndoaWxlIChwYXJ0cyAmJiBwYXJ0cy5sZW5ndGggPCAzKSB7XG4gIHBhcnRzLnB1c2goJzAnKTtcbn1cblxuLy8gc2V0IHRoZSBuYW1lIGFuZCB2ZXJzaW9uXG5leHBvcnRzLm5hbWUgPSBtYXRjaCAmJiBtYXRjaFswXTtcbmV4cG9ydHMudmVyc2lvbiA9IHBhcnRzICYmIHBhcnRzLmpvaW4oJy4nKTtcblxuZnVuY3Rpb24gbWF0Y2gocGFpcikge1xuICByZXR1cm4gcGFpci5jb25jYXQocGFpclsxXS5leGVjKG5hdmlnYXRvci51c2VyQWdlbnQpKTtcbn1cblxuZnVuY3Rpb24gaXNNYXRjaChwYWlyKSB7XG4gIHJldHVybiAhIXBhaXJbMl07XG59XG4iLCJ2YXIgZGV0ZWN0ID0gcmVxdWlyZSgnLi9kZXRlY3QnKTtcbnZhciByZXF1aXJlZEZ1bmN0aW9ucyA9IFtcbiAgJ2luaXQnXG5dO1xuXG5mdW5jdGlvbiBpc1N1cHBvcnRlZChwbHVnaW4pIHtcbiAgcmV0dXJuIHBsdWdpbiAmJiB0eXBlb2YgcGx1Z2luLnN1cHBvcnRlZCA9PSAnZnVuY3Rpb24nICYmIHBsdWdpbi5zdXBwb3J0ZWQoZGV0ZWN0KTtcbn1cblxuZnVuY3Rpb24gaXNWYWxpZChwbHVnaW4pIHtcbiAgdmFyIHN1cHBvcnRlZEZ1bmN0aW9ucyA9IHJlcXVpcmVkRnVuY3Rpb25zLmZpbHRlcihmdW5jdGlvbihmbikge1xuICAgIHJldHVybiB0eXBlb2YgcGx1Z2luW2ZuXSA9PSAnZnVuY3Rpb24nO1xuICB9KTtcblxuICByZXR1cm4gc3VwcG9ydGVkRnVuY3Rpb25zLmxlbmd0aCA9PT0gcmVxdWlyZWRGdW5jdGlvbnMubGVuZ3RoO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHBsdWdpbnMpIHtcbiAgcmV0dXJuIFtdLmNvbmNhdChwbHVnaW5zIHx8IFtdKS5maWx0ZXIoaXNTdXBwb3J0ZWQpLmZpbHRlcihpc1ZhbGlkKVswXTtcbn1cbiIsIi8qKlxuICAjIHJ0Yy1wbHVnZ2FibGUtc2lnbmFsbGVyXG5cbiAgQnkgdXNpbmcgYHJ0Yy1wbHVnZ2FibGUtc2lnbmFsbGVyYCBpbiB5b3VyIGNvZGUsIHlvdSBwcm92aWRlIHRoZSBhYmlsaXR5XG4gIGZvciB5b3VyIHBhY2thZ2UgdG8gY3VzdG9taXplIHdoaWNoIHNpZ25hbGxpbmcgY2xpZW50IGl0IHVzZXMgKGFuZFxuICB0aHVzIGhhdmUgc2lnbmlmaWNhbnQgY29udHJvbCkgb3ZlciBob3cgc2lnbmFsbGluZyBvcGVyYXRlcyBpbiB5b3VyXG4gIGVudmlyb25tZW50LlxuXG4gICMjIEhvdyBpdCBXb3Jrc1xuXG4gIFRoZSBwbHVnZ2FibGUgc2lnbmFsbGVyIGxvb2tzIGluIHRoZSBwcm92aWRlZCBgb3B0c2AgZm9yIGEgYHNpZ25hbGxlcmBcbiAgYXR0cmlidXRlLiAgSWYgdGhlIHZhbHVlIG9mIHRoaXMgYXR0cmlidXRlIGlzIGEgc3RyaW5nLCB0aGVuIGl0IGlzXG4gIGFzc3VtZWQgdGhhdCB5b3Ugd2lzaCB0byB1c2UgdGhlIGRlZmF1bHRcbiAgW2BydGMtc2lnbmFsbGVyYF0oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMtc2lnbmFsbGVyKSBpbiB5b3VyXG4gIHBhY2thZ2UuICBJZiwgaG93ZXZlciwgaXQgaXMgbm90IGEgc3RyaW5nIHZhbHVlIHRoZW4gaXQgd2lsbCBiZSBwYXNzZWRcbiAgc3RyYWlnaHQgYmFjayBhcyB0aGUgc2lnbmFsbGVyIChhc3N1bWluZyB0aGF0IHlvdSBoYXZlIHByb3ZpZGVkIGFuXG4gIG9iamVjdCB0aGF0IGlzIGNvbXBsaWFudCB3aXRoIHRoZSBydGMuaW8gc2lnbmFsbGluZyBBUEkpLlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24ob3B0cykge1xuICB2YXIgc2lnbmFsbGVyID0gKG9wdHMgfHwge30pLnNpZ25hbGxlcjtcbiAgdmFyIG1lc3NlbmdlciA9IChvcHRzIHx8IHt9KS5tZXNzZW5nZXIgfHwgcmVxdWlyZSgncnRjLXN3aXRjaGJvYXJkLW1lc3NlbmdlcicpO1xuXG4gIGlmICh0eXBlb2Ygc2lnbmFsbGVyID09ICdzdHJpbmcnIHx8IChzaWduYWxsZXIgaW5zdGFuY2VvZiBTdHJpbmcpKSB7XG4gICAgcmV0dXJuIHJlcXVpcmUoJ3J0Yy1zaWduYWxsZXInKShtZXNzZW5nZXIoc2lnbmFsbGVyLCBvcHRzKSwgb3B0cyk7XG4gIH1cblxuICByZXR1cm4gc2lnbmFsbGVyO1xufTtcbiIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbnZhciBkZXRlY3QgPSByZXF1aXJlKCdydGMtY29yZS9kZXRlY3QnKTtcbnZhciBleHRlbmQgPSByZXF1aXJlKCdjb2cvZXh0ZW5kJyk7XG52YXIgbWJ1cyA9IHJlcXVpcmUoJ21idXMnKTtcbnZhciBnZXRhYmxlID0gcmVxdWlyZSgnY29nL2dldGFibGUnKTtcbnZhciB1dWlkID0gcmVxdWlyZSgnY3VpZCcpO1xudmFyIHB1bGwgPSByZXF1aXJlKCdwdWxsLXN0cmVhbScpO1xudmFyIHB1c2hhYmxlID0gcmVxdWlyZSgncHVsbC1wdXNoYWJsZScpO1xudmFyIHByZXBhcmUgPSByZXF1aXJlKCdydGMtc2lnbmFsL3ByZXBhcmUnKTtcbnZhciBjcmVhdGVRdWV1ZSA9IHJlcXVpcmUoJ3B1bGwtcHVzaGFibGUnKTtcblxuLy8gcmVhZHkgc3RhdGUgY29uc3RhbnRzXG52YXIgUlNfRElTQ09OTkVDVEVEID0gMDtcbnZhciBSU19DT05ORUNUSU5HID0gMTtcbnZhciBSU19DT05ORUNURUQgPSAyO1xuXG4vLyBpbml0aWFsaXNlIHNpZ25hbGxlciBtZXRhZGF0YSBzbyB3ZSBkb24ndCBoYXZlIHRvIGluY2x1ZGUgdGhlIHBhY2thZ2UuanNvblxuLy8gVE9ETzogbWFrZSB0aGlzIGNoZWNrYWJsZSB3aXRoIHNvbWUga2luZCBvZiBwcmVwdWJsaXNoIHNjcmlwdFxudmFyIG1ldGFkYXRhID0ge1xuICB2ZXJzaW9uOiAnNi4yLjEnXG59O1xuXG4vKipcbiAgIyBydGMtc2lnbmFsbGVyXG5cbiAgVGhlIGBydGMtc2lnbmFsbGVyYCBtb2R1bGUgcHJvdmlkZXMgYSB0cmFuc3BvcnRsZXNzIHNpZ25hbGxpbmdcbiAgbWVjaGFuaXNtIGZvciBXZWJSVEMuXG5cbiAgIyMgUHVycG9zZVxuXG4gIDw8PCBkb2NzL3B1cnBvc2UubWRcblxuICAjIyBHZXR0aW5nIFN0YXJ0ZWRcblxuICBXaGlsZSB0aGUgc2lnbmFsbGVyIGlzIGNhcGFibGUgb2YgY29tbXVuaWNhdGluZyBieSBhIG51bWJlciBvZiBkaWZmZXJlbnRcbiAgbWVzc2VuZ2VycyAoaS5lLiBhbnl0aGluZyB0aGF0IGNhbiBzZW5kIGFuZCByZWNlaXZlIG1lc3NhZ2VzIG92ZXIgYSB3aXJlKVxuICBpdCBjb21lcyB3aXRoIHN1cHBvcnQgZm9yIHVuZGVyc3RhbmRpbmcgaG93IHRvIGNvbm5lY3QgdG8gYW5cbiAgW3J0Yy1zd2l0Y2hib2FyZF0oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMtc3dpdGNoYm9hcmQpIG91dCBvZiB0aGUgYm94LlxuXG4gIFRoZSBmb2xsb3dpbmcgY29kZSBzYW1wbGUgZGVtb25zdHJhdGVzIGhvdzpcblxuICA8PDwgZXhhbXBsZXMvZ2V0dGluZy1zdGFydGVkLmpzXG5cbiAgPDw8IGRvY3MvZXZlbnRzLm1kXG5cbiAgPDw8IGRvY3Mvc2lnbmFsZmxvdy1kaWFncmFtcy5tZFxuXG4gIDw8PCBkb2NzL2lkZW50aWZ5aW5nLXBhcnRpY2lwYW50cy5tZFxuXG4gICMjIFJlZmVyZW5jZVxuXG4gIFRoZSBgcnRjLXNpZ25hbGxlcmAgbW9kdWxlIGlzIGRlc2lnbmVkIHRvIGJlIHVzZWQgcHJpbWFyaWx5IGluIGEgZnVuY3Rpb25hbFxuICB3YXkgYW5kIHdoZW4gY2FsbGVkIGl0IGNyZWF0ZXMgYSBuZXcgc2lnbmFsbGVyIHRoYXQgd2lsbCBlbmFibGVcbiAgeW91IHRvIGNvbW11bmljYXRlIHdpdGggb3RoZXIgcGVlcnMgdmlhIHlvdXIgbWVzc2FnaW5nIG5ldHdvcmsuXG5cbiAgYGBganNcbiAgLy8gY3JlYXRlIGEgc2lnbmFsbGVyIGZyb20gc29tZXRoaW5nIHRoYXQga25vd3MgaG93IHRvIHNlbmQgbWVzc2FnZXNcbiAgdmFyIHNpZ25hbGxlciA9IHJlcXVpcmUoJ3J0Yy1zaWduYWxsZXInKShtZXNzZW5nZXIpO1xuICBgYGBcblxuICBBcyBkZW1vbnN0cmF0ZWQgaW4gdGhlIGdldHRpbmcgc3RhcnRlZCBndWlkZSwgeW91IGNhbiBhbHNvIHBhc3MgdGhyb3VnaFxuICBhIHN0cmluZyB2YWx1ZSBpbnN0ZWFkIG9mIGEgbWVzc2VuZ2VyIGluc3RhbmNlIGlmIHlvdSBzaW1wbHkgd2FudCB0b1xuICBjb25uZWN0IHRvIGFuIGV4aXN0aW5nIGBydGMtc3dpdGNoYm9hcmRgIGluc3RhbmNlLlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24obWVzc2VuZ2VyLCBvcHRzKSB7XG4gIHZhciBhdXRvY29ubmVjdCA9IChvcHRzIHx8IHt9KS5hdXRvY29ubmVjdDtcbiAgdmFyIHJlY29ubmVjdCA9IChvcHRzIHx8IHt9KS5yZWNvbm5lY3Q7XG4gIHZhciBxdWV1ZSA9IGNyZWF0ZVF1ZXVlKCk7XG4gIHZhciBjb25uZWN0aW9uQ291bnQgPSAwO1xuXG4gIC8vIGNyZWF0ZSB0aGUgc2lnbmFsbGVyXG4gIHZhciBzaWduYWxsZXIgPSByZXF1aXJlKCdydGMtc2lnbmFsL3NpZ25hbGxlcicpKG9wdHMsIGJ1ZmZlck1lc3NhZ2UpO1xuXG4gIHZhciBhbm5vdW5jZWQgPSBmYWxzZTtcbiAgdmFyIGFubm91bmNlVGltZXIgPSAwO1xuICB2YXIgcmVhZHlTdGF0ZSA9IFJTX0RJU0NPTk5FQ1RFRDtcblxuICBmdW5jdGlvbiBidWZmZXJNZXNzYWdlKG1lc3NhZ2UpIHtcbiAgICBxdWV1ZS5wdXNoKG1lc3NhZ2UpO1xuXG4gICAgLy8gaWYgd2UgYXJlIG5vdCBjb25uZWN0ZWQgKGFuZCBzaG91bGQgYXV0b2Nvbm5lY3QpLCB0aGVuIGF0dGVtcHQgY29ubmVjdGlvblxuICAgIGlmIChyZWFkeVN0YXRlID09PSBSU19ESVNDT05ORUNURUQgJiYgKGF1dG9jb25uZWN0ID09PSB1bmRlZmluZWQgfHwgYXV0b2Nvbm5lY3QpKSB7XG4gICAgICBjb25uZWN0KCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlRGlzY29ubmVjdCgpIHtcbiAgICBpZiAocmVjb25uZWN0ID09PSB1bmRlZmluZWQgfHwgcmVjb25uZWN0KSB7XG4gICAgICBzZXRUaW1lb3V0KGNvbm5lY3QsIDUwKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICAjIyMgYHNpZ25hbGxlci5jb25uZWN0KClgXG5cbiAgICBNYW51YWxseSBjb25uZWN0IHRoZSBzaWduYWxsZXIgdXNpbmcgdGhlIHN1cHBsaWVkIG1lc3Nlbmdlci5cblxuICAgIF9fTk9URTpfXyBUaGlzIHNob3VsZCBuZXZlciBoYXZlIHRvIGJlIGNhbGxlZCBpZiB0aGUgZGVmYXVsdCBzZXR0aW5nXG4gICAgZm9yIGBhdXRvY29ubmVjdGAgaXMgdXNlZC5cbiAgKiovXG4gIHZhciBjb25uZWN0ID0gc2lnbmFsbGVyLmNvbm5lY3QgPSBmdW5jdGlvbigpIHtcbiAgICAvLyBpZiB3ZSBhcmUgYWxyZWFkeSBjb25uZWN0aW5nIHRoZW4gZG8gbm90aGluZ1xuICAgIGlmIChyZWFkeVN0YXRlID09PSBSU19DT05ORUNUSU5HKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gaW5pdGlhdGUgdGhlIG1lc3NlbmdlclxuICAgIHJlYWR5U3RhdGUgPSBSU19DT05ORUNUSU5HO1xuICAgIG1lc3NlbmdlcihmdW5jdGlvbihlcnIsIHNvdXJjZSwgc2luaykge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICByZWFkeVN0YXRlID0gUlNfRElTQ09OTkVDVEVEO1xuICAgICAgICByZXR1cm4gc2lnbmFsbGVyKCdlcnJvcicsIGVycik7XG4gICAgICB9XG5cbiAgICAgIC8vIGluY3JlbWVudCB0aGUgY29ubmVjdGlvbiBjb3VudFxuICAgICAgY29ubmVjdGlvbkNvdW50ICs9IDE7XG5cbiAgICAgIC8vIGZsYWcgYXMgY29ubmVjdGVkXG4gICAgICByZWFkeVN0YXRlID0gUlNfQ09OTkVDVEVEO1xuXG4gICAgICAvLyBwYXNzIG1lc3NhZ2VzIHRvIHRoZSBwcm9jZXNzb3JcbiAgICAgIHB1bGwoXG4gICAgICAgIHNvdXJjZSxcblxuICAgICAgICAvLyBtb25pdG9yIGRpc2Nvbm5lY3Rpb25cbiAgICAgICAgcHVsbC50aHJvdWdoKG51bGwsIGZ1bmN0aW9uKCkge1xuICAgICAgICAgIHF1ZXVlID0gY3JlYXRlUXVldWUoKTtcbiAgICAgICAgICByZWFkeVN0YXRlID0gUlNfRElTQ09OTkVDVEVEO1xuICAgICAgICAgIHNpZ25hbGxlcignZGlzY29ubmVjdGVkJyk7XG4gICAgICAgIH0pLFxuICAgICAgICBwdWxsLmRyYWluKHNpZ25hbGxlci5fcHJvY2VzcylcbiAgICAgICk7XG5cbiAgICAgIC8vIHBhc3MgdGhlIHF1ZXVlIHRvIHRoZSBzaW5rXG4gICAgICBwdWxsKHF1ZXVlLCBzaW5rKTtcblxuICAgICAgLy8gaGFuZGxlIGRpc2Nvbm5lY3Rpb25cbiAgICAgIHNpZ25hbGxlci5yZW1vdmVMaXN0ZW5lcignZGlzY29ubmVjdGVkJywgaGFuZGxlRGlzY29ubmVjdCk7XG4gICAgICBzaWduYWxsZXIub24oJ2Rpc2Nvbm5lY3RlZCcsIGhhbmRsZURpc2Nvbm5lY3QpO1xuXG4gICAgICAvLyB0cmlnZ2VyIHRoZSBjb25uZWN0ZWQgZXZlbnRcbiAgICAgIHNpZ25hbGxlcignY29ubmVjdGVkJyk7XG5cbiAgICAgIC8vIGlmIHRoaXMgaXMgYSByZWNvbm5lY3Rpb24sIHRoZW4gcmVhbm5vdW5jZVxuICAgICAgaWYgKGFubm91bmNlZCAmJiBjb25uZWN0aW9uQ291bnQgPiAxKSB7XG4gICAgICAgIHNpZ25hbGxlci5fYW5ub3VuY2UoKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcblxuICAvKipcbiAgICAjIyMgYW5ub3VuY2UoZGF0YT8pXG5cbiAgICBUaGUgYGFubm91bmNlYCBmdW5jdGlvbiBvZiB0aGUgc2lnbmFsbGVyIHdpbGwgcGFzcyBhbiBgL2Fubm91bmNlYCBtZXNzYWdlXG4gICAgdGhyb3VnaCB0aGUgbWVzc2VuZ2VyIG5ldHdvcmsuICBXaGVuIG5vIGFkZGl0aW9uYWwgZGF0YSBpcyBzdXBwbGllZCB0b1xuICAgIHRoaXMgZnVuY3Rpb24gdGhlbiBvbmx5IHRoZSBpZCBvZiB0aGUgc2lnbmFsbGVyIGlzIHNlbnQgdG8gYWxsIGFjdGl2ZVxuICAgIG1lbWJlcnMgb2YgdGhlIG1lc3NlbmdpbmcgbmV0d29yay5cblxuICAgICMjIyMgSm9pbmluZyBSb29tc1xuXG4gICAgVG8gam9pbiBhIHJvb20gdXNpbmcgYW4gYW5ub3VuY2UgY2FsbCB5b3Ugc2ltcGx5IHByb3ZpZGUgdGhlIG5hbWUgb2YgdGhlXG4gICAgcm9vbSB5b3Ugd2lzaCB0byBqb2luIGFzIHBhcnQgb2YgdGhlIGRhdGEgYmxvY2sgdGhhdCB5b3UgYW5ub3VjZSwgZm9yXG4gICAgZXhhbXBsZTpcblxuICAgIGBgYGpzXG4gICAgc2lnbmFsbGVyLmFubm91bmNlKHsgcm9vbTogJ3Rlc3Ryb29tJyB9KTtcbiAgICBgYGBcblxuICAgIFNpZ25hbGxpbmcgc2VydmVycyAoc3VjaCBhc1xuICAgIFtydGMtc3dpdGNoYm9hcmRdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLXN3aXRjaGJvYXJkKSkgd2lsbCB0aGVuXG4gICAgcGxhY2UgeW91ciBwZWVyIGNvbm5lY3Rpb24gaW50byBhIHJvb20gd2l0aCBvdGhlciBwZWVycyB0aGF0IGhhdmUgYWxzb1xuICAgIGFubm91bmNlZCBpbiB0aGlzIHJvb20uXG5cbiAgICBPbmNlIHlvdSBoYXZlIGpvaW5lZCBhIHJvb20sIHRoZSBzZXJ2ZXIgd2lsbCBvbmx5IGRlbGl2ZXIgbWVzc2FnZXMgdGhhdFxuICAgIHlvdSBgc2VuZGAgdG8gb3RoZXIgcGVlcnMgd2l0aGluIHRoYXQgcm9vbS5cblxuICAgICMjIyMgUHJvdmlkaW5nIEFkZGl0aW9uYWwgQW5ub3VuY2UgRGF0YVxuXG4gICAgVGhlcmUgbWF5IGJlIGluc3RhbmNlcyB3aGVyZSB5b3Ugd2lzaCB0byBzZW5kIGFkZGl0aW9uYWwgZGF0YSBhcyBwYXJ0IG9mXG4gICAgeW91ciBhbm5vdW5jZSBtZXNzYWdlIGluIHlvdXIgYXBwbGljYXRpb24uICBGb3IgaW5zdGFuY2UsIG1heWJlIHlvdSB3YW50XG4gICAgdG8gc2VuZCBhbiBhbGlhcyBvciBuaWNrIGFzIHBhcnQgb2YgeW91ciBhbm5vdW5jZSBtZXNzYWdlIHJhdGhlciB0aGFuIGp1c3RcbiAgICB1c2UgdGhlIHNpZ25hbGxlcidzIGdlbmVyYXRlZCBpZC5cblxuICAgIElmIGZvciBpbnN0YW5jZSB5b3Ugd2VyZSB3cml0aW5nIGEgc2ltcGxlIGNoYXQgYXBwbGljYXRpb24geW91IGNvdWxkIGpvaW5cbiAgICB0aGUgYHdlYnJ0Y2Agcm9vbSBhbmQgdGVsbCBldmVyeW9uZSB5b3VyIG5hbWUgd2l0aCB0aGUgZm9sbG93aW5nIGFubm91bmNlXG4gICAgY2FsbDpcblxuICAgIGBgYGpzXG4gICAgc2lnbmFsbGVyLmFubm91bmNlKHtcbiAgICAgIHJvb206ICd3ZWJydGMnLFxuICAgICAgbmljazogJ0RhbW9uJ1xuICAgIH0pO1xuICAgIGBgYFxuXG4gICAgIyMjIyBBbm5vdW5jaW5nIFVwZGF0ZXNcblxuICAgIFRoZSBzaWduYWxsZXIgaXMgd3JpdHRlbiB0byBkaXN0aW5ndWlzaCBiZXR3ZWVuIGluaXRpYWwgcGVlciBhbm5vdW5jZW1lbnRzXG4gICAgYW5kIHBlZXIgZGF0YSB1cGRhdGVzIChzZWUgdGhlIGRvY3Mgb24gdGhlIGFubm91bmNlIGhhbmRsZXIgYmVsb3cpLiBBc1xuICAgIHN1Y2ggaXQgaXMgb2sgdG8gcHJvdmlkZSBhbnkgZGF0YSB1cGRhdGVzIHVzaW5nIHRoZSBhbm5vdW5jZSBtZXRob2QgYWxzby5cblxuICAgIEZvciBpbnN0YW5jZSwgSSBjb3VsZCBzZW5kIGEgc3RhdHVzIHVwZGF0ZSBhcyBhbiBhbm5vdW5jZSBtZXNzYWdlIHRvIGZsYWdcbiAgICB0aGF0IEkgYW0gZ29pbmcgb2ZmbGluZTpcblxuICAgIGBgYGpzXG4gICAgc2lnbmFsbGVyLmFubm91bmNlKHsgc3RhdHVzOiAnb2ZmbGluZScgfSk7XG4gICAgYGBgXG5cbiAgKiovXG4gIHNpZ25hbGxlci5hbm5vdW5jZSA9IGZ1bmN0aW9uKGRhdGEpIHtcbiAgICBhbm5vdW5jZWQgPSB0cnVlO1xuICAgIHNpZ25hbGxlci5fdXBkYXRlKGRhdGEpO1xuICAgIGNsZWFyVGltZW91dChhbm5vdW5jZVRpbWVyKTtcblxuICAgIC8vIHNlbmQgdGhlIGF0dHJpYnV0ZXMgb3ZlciB0aGUgbmV0d29ya1xuICAgIHJldHVybiBhbm5vdW5jZVRpbWVyID0gc2V0VGltZW91dChzaWduYWxsZXIuX2Fubm91bmNlLCAob3B0cyB8fCB7fSkuYW5ub3VuY2VEZWxheSB8fCAxMCk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIGxlYXZlKClcblxuICAgIFRlbGwgdGhlIHNpZ25hbGxpbmcgc2VydmVyIHdlIGFyZSBsZWF2aW5nLiAgQ2FsbGluZyB0aGlzIGZ1bmN0aW9uIGlzXG4gICAgdXN1YWxseSBub3QgcmVxdWlyZWQgdGhvdWdoIGFzIHRoZSBzaWduYWxsaW5nIHNlcnZlciBzaG91bGQgaXNzdWUgY29ycmVjdFxuICAgIGAvbGVhdmVgIG1lc3NhZ2VzIHdoZW4gaXQgZGV0ZWN0cyBhIGRpc2Nvbm5lY3QgZXZlbnQuXG5cbiAgKiovXG4gIHNpZ25hbGxlci5sZWF2ZSA9IHNpZ25hbGxlci5jbG9zZSA9IGZ1bmN0aW9uKCkge1xuICAgIC8vIHNlbmQgdGhlIGxlYXZlIHNpZ25hbFxuICAgIHNpZ25hbGxlci5zZW5kKCcvbGVhdmUnLCB7IGlkOiBzaWduYWxsZXIuaWQgfSk7XG5cbiAgICAvLyBzdG9wIGFubm91bmNpbmcgb24gcmVjb25uZWN0XG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdkaXNjb25uZWN0ZWQnLCBoYW5kbGVEaXNjb25uZWN0KTtcbiAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ2Nvbm5lY3RlZCcsIHNpZ25hbGxlci5fYW5ub3VuY2UpO1xuXG4gICAgLy8gZW5kIG91ciBjdXJyZW50IHF1ZXVlXG4gICAgcXVldWUuZW5kKCk7XG5cbiAgICAvLyBzZXQgY29ubmVjdGVkIHRvIGZhbHNlXG4gICAgcmVhZHlTdGF0ZSA9IFJTX0RJU0NPTk5FQ1RFRDtcbiAgfTtcblxuICAvLyB1cGRhdGUgdGhlIHNpZ25hbGxlciBhZ2VudFxuICBzaWduYWxsZXIuX3VwZGF0ZSh7IGFnZW50OiAnc2lnbmFsbGVyQCcgKyBtZXRhZGF0YS52ZXJzaW9uIH0pO1xuXG4gIC8vIGF1dG9jb25uZWN0XG4gIGlmIChhdXRvY29ubmVjdCA9PT0gdW5kZWZpbmVkIHx8IGF1dG9jb25uZWN0KSB7XG4gICAgY29ubmVjdCgpO1xuICB9XG5cbiAgcmV0dXJuIHNpZ25hbGxlcjtcbn07XG4iLCIvKipcbiAqIGN1aWQuanNcbiAqIENvbGxpc2lvbi1yZXNpc3RhbnQgVUlEIGdlbmVyYXRvciBmb3IgYnJvd3NlcnMgYW5kIG5vZGUuXG4gKiBTZXF1ZW50aWFsIGZvciBmYXN0IGRiIGxvb2t1cHMgYW5kIHJlY2VuY3kgc29ydGluZy5cbiAqIFNhZmUgZm9yIGVsZW1lbnQgSURzIGFuZCBzZXJ2ZXItc2lkZSBsb29rdXBzLlxuICpcbiAqIEV4dHJhY3RlZCBmcm9tIENMQ1RSXG4gKiBcbiAqIENvcHlyaWdodCAoYykgRXJpYyBFbGxpb3R0IDIwMTJcbiAqIE1JVCBMaWNlbnNlXG4gKi9cblxuLypnbG9iYWwgd2luZG93LCBuYXZpZ2F0b3IsIGRvY3VtZW50LCByZXF1aXJlLCBwcm9jZXNzLCBtb2R1bGUgKi9cbihmdW5jdGlvbiAoYXBwKSB7XG4gICd1c2Ugc3RyaWN0JztcbiAgdmFyIG5hbWVzcGFjZSA9ICdjdWlkJyxcbiAgICBjID0gMCxcbiAgICBibG9ja1NpemUgPSA0LFxuICAgIGJhc2UgPSAzNixcbiAgICBkaXNjcmV0ZVZhbHVlcyA9IE1hdGgucG93KGJhc2UsIGJsb2NrU2l6ZSksXG5cbiAgICBwYWQgPSBmdW5jdGlvbiBwYWQobnVtLCBzaXplKSB7XG4gICAgICB2YXIgcyA9IFwiMDAwMDAwMDAwXCIgKyBudW07XG4gICAgICByZXR1cm4gcy5zdWJzdHIocy5sZW5ndGgtc2l6ZSk7XG4gICAgfSxcblxuICAgIHJhbmRvbUJsb2NrID0gZnVuY3Rpb24gcmFuZG9tQmxvY2soKSB7XG4gICAgICByZXR1cm4gcGFkKChNYXRoLnJhbmRvbSgpICpcbiAgICAgICAgICAgIGRpc2NyZXRlVmFsdWVzIDw8IDApXG4gICAgICAgICAgICAudG9TdHJpbmcoYmFzZSksIGJsb2NrU2l6ZSk7XG4gICAgfSxcblxuICAgIHNhZmVDb3VudGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgYyA9IChjIDwgZGlzY3JldGVWYWx1ZXMpID8gYyA6IDA7XG4gICAgICBjKys7IC8vIHRoaXMgaXMgbm90IHN1YmxpbWluYWxcbiAgICAgIHJldHVybiBjIC0gMTtcbiAgICB9LFxuXG4gICAgYXBpID0gZnVuY3Rpb24gY3VpZCgpIHtcbiAgICAgIC8vIFN0YXJ0aW5nIHdpdGggYSBsb3dlcmNhc2UgbGV0dGVyIG1ha2VzXG4gICAgICAvLyBpdCBIVE1MIGVsZW1lbnQgSUQgZnJpZW5kbHkuXG4gICAgICB2YXIgbGV0dGVyID0gJ2MnLCAvLyBoYXJkLWNvZGVkIGFsbG93cyBmb3Igc2VxdWVudGlhbCBhY2Nlc3NcblxuICAgICAgICAvLyB0aW1lc3RhbXBcbiAgICAgICAgLy8gd2FybmluZzogdGhpcyBleHBvc2VzIHRoZSBleGFjdCBkYXRlIGFuZCB0aW1lXG4gICAgICAgIC8vIHRoYXQgdGhlIHVpZCB3YXMgY3JlYXRlZC5cbiAgICAgICAgdGltZXN0YW1wID0gKG5ldyBEYXRlKCkuZ2V0VGltZSgpKS50b1N0cmluZyhiYXNlKSxcblxuICAgICAgICAvLyBQcmV2ZW50IHNhbWUtbWFjaGluZSBjb2xsaXNpb25zLlxuICAgICAgICBjb3VudGVyLFxuXG4gICAgICAgIC8vIEEgZmV3IGNoYXJzIHRvIGdlbmVyYXRlIGRpc3RpbmN0IGlkcyBmb3IgZGlmZmVyZW50XG4gICAgICAgIC8vIGNsaWVudHMgKHNvIGRpZmZlcmVudCBjb21wdXRlcnMgYXJlIGZhciBsZXNzXG4gICAgICAgIC8vIGxpa2VseSB0byBnZW5lcmF0ZSB0aGUgc2FtZSBpZClcbiAgICAgICAgZmluZ2VycHJpbnQgPSBhcGkuZmluZ2VycHJpbnQoKSxcblxuICAgICAgICAvLyBHcmFiIHNvbWUgbW9yZSBjaGFycyBmcm9tIE1hdGgucmFuZG9tKClcbiAgICAgICAgcmFuZG9tID0gcmFuZG9tQmxvY2soKSArIHJhbmRvbUJsb2NrKCk7XG5cbiAgICAgICAgY291bnRlciA9IHBhZChzYWZlQ291bnRlcigpLnRvU3RyaW5nKGJhc2UpLCBibG9ja1NpemUpO1xuXG4gICAgICByZXR1cm4gIChsZXR0ZXIgKyB0aW1lc3RhbXAgKyBjb3VudGVyICsgZmluZ2VycHJpbnQgKyByYW5kb20pO1xuICAgIH07XG5cbiAgYXBpLnNsdWcgPSBmdW5jdGlvbiBzbHVnKCkge1xuICAgIHZhciBkYXRlID0gbmV3IERhdGUoKS5nZXRUaW1lKCkudG9TdHJpbmcoMzYpLFxuICAgICAgY291bnRlcixcbiAgICAgIHByaW50ID0gYXBpLmZpbmdlcnByaW50KCkuc2xpY2UoMCwxKSArXG4gICAgICAgIGFwaS5maW5nZXJwcmludCgpLnNsaWNlKC0xKSxcbiAgICAgIHJhbmRvbSA9IHJhbmRvbUJsb2NrKCkuc2xpY2UoLTIpO1xuXG4gICAgICBjb3VudGVyID0gc2FmZUNvdW50ZXIoKS50b1N0cmluZygzNikuc2xpY2UoLTQpO1xuXG4gICAgcmV0dXJuIGRhdGUuc2xpY2UoLTIpICsgXG4gICAgICBjb3VudGVyICsgcHJpbnQgKyByYW5kb207XG4gIH07XG5cbiAgYXBpLmdsb2JhbENvdW50ID0gZnVuY3Rpb24gZ2xvYmFsQ291bnQoKSB7XG4gICAgLy8gV2Ugd2FudCB0byBjYWNoZSB0aGUgcmVzdWx0cyBvZiB0aGlzXG4gICAgdmFyIGNhY2hlID0gKGZ1bmN0aW9uIGNhbGMoKSB7XG4gICAgICAgIHZhciBpLFxuICAgICAgICAgIGNvdW50ID0gMDtcblxuICAgICAgICBmb3IgKGkgaW4gd2luZG93KSB7XG4gICAgICAgICAgY291bnQrKztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb3VudDtcbiAgICAgIH0oKSk7XG5cbiAgICBhcGkuZ2xvYmFsQ291bnQgPSBmdW5jdGlvbiAoKSB7IHJldHVybiBjYWNoZTsgfTtcbiAgICByZXR1cm4gY2FjaGU7XG4gIH07XG5cbiAgYXBpLmZpbmdlcnByaW50ID0gZnVuY3Rpb24gYnJvd3NlclByaW50KCkge1xuICAgIHJldHVybiBwYWQoKG5hdmlnYXRvci5taW1lVHlwZXMubGVuZ3RoICtcbiAgICAgIG5hdmlnYXRvci51c2VyQWdlbnQubGVuZ3RoKS50b1N0cmluZygzNikgK1xuICAgICAgYXBpLmdsb2JhbENvdW50KCkudG9TdHJpbmcoMzYpLCA0KTtcbiAgfTtcblxuICAvLyBkb24ndCBjaGFuZ2UgYW55dGhpbmcgZnJvbSBoZXJlIGRvd24uXG4gIGlmIChhcHAucmVnaXN0ZXIpIHtcbiAgICBhcHAucmVnaXN0ZXIobmFtZXNwYWNlLCBhcGkpO1xuICB9IGVsc2UgaWYgKHR5cGVvZiBtb2R1bGUgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgbW9kdWxlLmV4cG9ydHMgPSBhcGk7XG4gIH0gZWxzZSB7XG4gICAgYXBwW25hbWVzcGFjZV0gPSBhcGk7XG4gIH1cblxufSh0aGlzLmFwcGxpdHVkZSB8fCB0aGlzKSk7XG4iLCJ2YXIgcHVsbCA9IHJlcXVpcmUoJ3B1bGwtc3RyZWFtJylcblxubW9kdWxlLmV4cG9ydHMgPSBwdWxsLlNvdXJjZShmdW5jdGlvbiAob25DbG9zZSkge1xuICB2YXIgYnVmZmVyID0gW10sIGNicyA9IFtdLCB3YWl0aW5nID0gW10sIGVuZGVkXG5cbiAgZnVuY3Rpb24gZHJhaW4oKSB7XG4gICAgdmFyIGxcbiAgICB3aGlsZSh3YWl0aW5nLmxlbmd0aCAmJiAoKGwgPSBidWZmZXIubGVuZ3RoKSB8fCBlbmRlZCkpIHtcbiAgICAgIHZhciBkYXRhID0gYnVmZmVyLnNoaWZ0KClcbiAgICAgIHZhciBjYiAgID0gY2JzLnNoaWZ0KClcbiAgICAgIHdhaXRpbmcuc2hpZnQoKShsID8gbnVsbCA6IGVuZGVkLCBkYXRhKVxuICAgICAgY2IgJiYgY2IoZW5kZWQgPT09IHRydWUgPyBudWxsIDogZW5kZWQpXG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gcmVhZCAoZW5kLCBjYikge1xuICAgIGVuZGVkID0gZW5kZWQgfHwgZW5kXG4gICAgd2FpdGluZy5wdXNoKGNiKVxuICAgIGRyYWluKClcbiAgICBpZihlbmRlZClcbiAgICAgIG9uQ2xvc2UgJiYgb25DbG9zZShlbmRlZCA9PT0gdHJ1ZSA/IG51bGwgOiBlbmRlZClcbiAgfVxuXG4gIHJlYWQucHVzaCA9IGZ1bmN0aW9uIChkYXRhLCBjYikge1xuICAgIGlmKGVuZGVkKVxuICAgICAgcmV0dXJuIGNiICYmIGNiKGVuZGVkID09PSB0cnVlID8gbnVsbCA6IGVuZGVkKVxuICAgIGJ1ZmZlci5wdXNoKGRhdGEpOyBjYnMucHVzaChjYilcbiAgICBkcmFpbigpXG4gIH1cblxuICByZWFkLmVuZCA9IGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIGVuZClcbiAgICAgIGNiID0gZW5kLCBlbmQgPSB0cnVlXG4gICAgZW5kZWQgPSBlbmRlZCB8fCBlbmQgfHwgdHJ1ZTtcbiAgICBpZihjYikgY2JzLnB1c2goY2IpXG4gICAgZHJhaW4oKVxuICAgIGlmKGVuZGVkKVxuICAgICAgb25DbG9zZSAmJiBvbkNsb3NlKGVuZGVkID09PSB0cnVlID8gbnVsbCA6IGVuZGVkKVxuICB9XG5cbiAgcmV0dXJuIHJlYWRcbn0pXG5cbiIsIlxudmFyIHNvdXJjZXMgID0gcmVxdWlyZSgnLi9zb3VyY2VzJylcbnZhciBzaW5rcyAgICA9IHJlcXVpcmUoJy4vc2lua3MnKVxudmFyIHRocm91Z2hzID0gcmVxdWlyZSgnLi90aHJvdWdocycpXG52YXIgdSAgICAgICAgPSByZXF1aXJlKCdwdWxsLWNvcmUnKVxuXG5mb3IodmFyIGsgaW4gc291cmNlcylcbiAgZXhwb3J0c1trXSA9IHUuU291cmNlKHNvdXJjZXNba10pXG5cbmZvcih2YXIgayBpbiB0aHJvdWdocylcbiAgZXhwb3J0c1trXSA9IHUuVGhyb3VnaCh0aHJvdWdoc1trXSlcblxuZm9yKHZhciBrIGluIHNpbmtzKVxuICBleHBvcnRzW2tdID0gdS5TaW5rKHNpbmtzW2tdKVxuXG52YXIgbWF5YmUgPSByZXF1aXJlKCcuL21heWJlJykoZXhwb3J0cylcblxuZm9yKHZhciBrIGluIG1heWJlKVxuICBleHBvcnRzW2tdID0gbWF5YmVba11cblxuZXhwb3J0cy5EdXBsZXggID0gXG5leHBvcnRzLlRocm91Z2ggPSBleHBvcnRzLnBpcGVhYmxlICAgICAgID0gdS5UaHJvdWdoXG5leHBvcnRzLlNvdXJjZSAgPSBleHBvcnRzLnBpcGVhYmxlU291cmNlID0gdS5Tb3VyY2VcbmV4cG9ydHMuU2luayAgICA9IGV4cG9ydHMucGlwZWFibGVTaW5rICAgPSB1LlNpbmtcblxuXG4iLCJ2YXIgdSA9IHJlcXVpcmUoJ3B1bGwtY29yZScpXG52YXIgcHJvcCA9IHUucHJvcFxudmFyIGlkICAgPSB1LmlkXG52YXIgbWF5YmVTaW5rID0gdS5tYXliZVNpbmtcblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAocHVsbCkge1xuXG4gIHZhciBleHBvcnRzID0ge31cbiAgdmFyIGRyYWluID0gcHVsbC5kcmFpblxuXG4gIHZhciBmaW5kID0gXG4gIGV4cG9ydHMuZmluZCA9IGZ1bmN0aW9uICh0ZXN0LCBjYikge1xuICAgIHJldHVybiBtYXliZVNpbmsoZnVuY3Rpb24gKGNiKSB7XG4gICAgICB2YXIgZW5kZWQgPSBmYWxzZVxuICAgICAgaWYoIWNiKVxuICAgICAgICBjYiA9IHRlc3QsIHRlc3QgPSBpZFxuICAgICAgZWxzZVxuICAgICAgICB0ZXN0ID0gcHJvcCh0ZXN0KSB8fCBpZFxuXG4gICAgICByZXR1cm4gZHJhaW4oZnVuY3Rpb24gKGRhdGEpIHtcbiAgICAgICAgaWYodGVzdChkYXRhKSkge1xuICAgICAgICAgIGVuZGVkID0gdHJ1ZVxuICAgICAgICAgIGNiKG51bGwsIGRhdGEpXG4gICAgICAgIHJldHVybiBmYWxzZVxuICAgICAgICB9XG4gICAgICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgIGlmKGVuZGVkKSByZXR1cm4gLy9hbHJlYWR5IGNhbGxlZCBiYWNrXG4gICAgICAgIGNiKGVyciA9PT0gdHJ1ZSA/IG51bGwgOiBlcnIsIG51bGwpXG4gICAgICB9KVxuXG4gICAgfSwgY2IpXG4gIH1cblxuICB2YXIgcmVkdWNlID0gZXhwb3J0cy5yZWR1Y2UgPSBcbiAgZnVuY3Rpb24gKHJlZHVjZSwgYWNjLCBjYikge1xuICAgIFxuICAgIHJldHVybiBtYXliZVNpbmsoZnVuY3Rpb24gKGNiKSB7XG4gICAgICByZXR1cm4gZHJhaW4oZnVuY3Rpb24gKGRhdGEpIHtcbiAgICAgICAgYWNjID0gcmVkdWNlKGFjYywgZGF0YSlcbiAgICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgY2IoZXJyLCBhY2MpXG4gICAgICB9KVxuXG4gICAgfSwgY2IpXG4gIH1cblxuICB2YXIgY29sbGVjdCA9IGV4cG9ydHMuY29sbGVjdCA9IGV4cG9ydHMud3JpdGVBcnJheSA9XG4gIGZ1bmN0aW9uIChjYikge1xuICAgIHJldHVybiByZWR1Y2UoZnVuY3Rpb24gKGFyciwgaXRlbSkge1xuICAgICAgYXJyLnB1c2goaXRlbSlcbiAgICAgIHJldHVybiBhcnJcbiAgICB9LCBbXSwgY2IpXG4gIH1cblxuICByZXR1cm4gZXhwb3J0c1xufVxuIiwiZXhwb3J0cy5pZCA9IFxuZnVuY3Rpb24gKGl0ZW0pIHtcbiAgcmV0dXJuIGl0ZW1cbn1cblxuZXhwb3J0cy5wcm9wID0gXG5mdW5jdGlvbiAobWFwKSB7ICBcbiAgaWYoJ3N0cmluZycgPT0gdHlwZW9mIG1hcCkge1xuICAgIHZhciBrZXkgPSBtYXBcbiAgICByZXR1cm4gZnVuY3Rpb24gKGRhdGEpIHsgcmV0dXJuIGRhdGFba2V5XSB9XG4gIH1cbiAgcmV0dXJuIG1hcFxufVxuXG5leHBvcnRzLnRlc3RlciA9IGZ1bmN0aW9uICh0ZXN0KSB7XG4gIGlmKCF0ZXN0KSByZXR1cm4gZXhwb3J0cy5pZFxuICBpZignb2JqZWN0JyA9PT0gdHlwZW9mIHRlc3RcbiAgICAmJiAnZnVuY3Rpb24nID09PSB0eXBlb2YgdGVzdC50ZXN0KVxuICAgICAgcmV0dXJuIHRlc3QudGVzdC5iaW5kKHRlc3QpXG4gIHJldHVybiBleHBvcnRzLnByb3AodGVzdCkgfHwgZXhwb3J0cy5pZFxufVxuXG5leHBvcnRzLmFkZFBpcGUgPSBhZGRQaXBlXG5cbmZ1bmN0aW9uIGFkZFBpcGUocmVhZCkge1xuICBpZignZnVuY3Rpb24nICE9PSB0eXBlb2YgcmVhZClcbiAgICByZXR1cm4gcmVhZFxuXG4gIHJlYWQucGlwZSA9IHJlYWQucGlwZSB8fCBmdW5jdGlvbiAocmVhZGVyKSB7XG4gICAgaWYoJ2Z1bmN0aW9uJyAhPSB0eXBlb2YgcmVhZGVyKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKCdtdXN0IHBpcGUgdG8gcmVhZGVyJylcbiAgICByZXR1cm4gYWRkUGlwZShyZWFkZXIocmVhZCkpXG4gIH1cbiAgcmVhZC50eXBlID0gJ1NvdXJjZSdcbiAgcmV0dXJuIHJlYWRcbn1cblxudmFyIFNvdXJjZSA9XG5leHBvcnRzLlNvdXJjZSA9XG5mdW5jdGlvbiBTb3VyY2UgKGNyZWF0ZVJlYWQpIHtcbiAgZnVuY3Rpb24gcygpIHtcbiAgICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKVxuICAgIHJldHVybiBhZGRQaXBlKGNyZWF0ZVJlYWQuYXBwbHkobnVsbCwgYXJncykpXG4gIH1cbiAgcy50eXBlID0gJ1NvdXJjZSdcbiAgcmV0dXJuIHNcbn1cblxuXG52YXIgVGhyb3VnaCA9XG5leHBvcnRzLlRocm91Z2ggPSBcbmZ1bmN0aW9uIChjcmVhdGVSZWFkKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cylcbiAgICB2YXIgcGlwZWQgPSBbXVxuICAgIGZ1bmN0aW9uIHJlYWRlciAocmVhZCkge1xuICAgICAgYXJncy51bnNoaWZ0KHJlYWQpXG4gICAgICByZWFkID0gY3JlYXRlUmVhZC5hcHBseShudWxsLCBhcmdzKVxuICAgICAgd2hpbGUocGlwZWQubGVuZ3RoKVxuICAgICAgICByZWFkID0gcGlwZWQuc2hpZnQoKShyZWFkKVxuICAgICAgcmV0dXJuIHJlYWRcbiAgICAgIC8vcGlwZWluZyB0byBmcm9tIHRoaXMgcmVhZGVyIHNob3VsZCBjb21wb3NlLi4uXG4gICAgfVxuICAgIHJlYWRlci5waXBlID0gZnVuY3Rpb24gKHJlYWQpIHtcbiAgICAgIHBpcGVkLnB1c2gocmVhZCkgXG4gICAgICBpZihyZWFkLnR5cGUgPT09ICdTb3VyY2UnKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ2Nhbm5vdCBwaXBlICcgKyByZWFkZXIudHlwZSArICcgdG8gU291cmNlJylcbiAgICAgIHJlYWRlci50eXBlID0gcmVhZC50eXBlID09PSAnU2luaycgPyAnU2luaycgOiAnVGhyb3VnaCdcbiAgICAgIHJldHVybiByZWFkZXJcbiAgICB9XG4gICAgcmVhZGVyLnR5cGUgPSAnVGhyb3VnaCdcbiAgICByZXR1cm4gcmVhZGVyXG4gIH1cbn1cblxudmFyIFNpbmsgPVxuZXhwb3J0cy5TaW5rID0gXG5mdW5jdGlvbiBTaW5rKGNyZWF0ZVJlYWRlcikge1xuICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpXG4gICAgaWYoIWNyZWF0ZVJlYWRlcilcbiAgICAgIHRocm93IG5ldyBFcnJvcignbXVzdCBiZSBjcmVhdGVSZWFkZXIgZnVuY3Rpb24nKVxuICAgIGZ1bmN0aW9uIHMgKHJlYWQpIHtcbiAgICAgIGFyZ3MudW5zaGlmdChyZWFkKVxuICAgICAgcmV0dXJuIGNyZWF0ZVJlYWRlci5hcHBseShudWxsLCBhcmdzKVxuICAgIH1cbiAgICBzLnR5cGUgPSAnU2luaydcbiAgICByZXR1cm4gc1xuICB9XG59XG5cblxuZXhwb3J0cy5tYXliZVNpbmsgPSBcbmV4cG9ydHMubWF5YmVEcmFpbiA9IFxuZnVuY3Rpb24gKGNyZWF0ZVNpbmssIGNiKSB7XG4gIGlmKCFjYilcbiAgICByZXR1cm4gVGhyb3VnaChmdW5jdGlvbiAocmVhZCkge1xuICAgICAgdmFyIGVuZGVkXG4gICAgICByZXR1cm4gZnVuY3Rpb24gKGNsb3NlLCBjYikge1xuICAgICAgICBpZihjbG9zZSkgcmV0dXJuIHJlYWQoY2xvc2UsIGNiKVxuICAgICAgICBpZihlbmRlZCkgcmV0dXJuIGNiKGVuZGVkKVxuXG4gICAgICAgIGNyZWF0ZVNpbmsoZnVuY3Rpb24gKGVyciwgZGF0YSkge1xuICAgICAgICAgIGVuZGVkID0gZXJyIHx8IHRydWVcbiAgICAgICAgICBpZighZXJyKSBjYihudWxsLCBkYXRhKVxuICAgICAgICAgIGVsc2UgICAgIGNiKGVuZGVkKVxuICAgICAgICB9KSAocmVhZClcbiAgICAgIH1cbiAgICB9KSgpXG5cbiAgcmV0dXJuIFNpbmsoZnVuY3Rpb24gKHJlYWQpIHtcbiAgICByZXR1cm4gY3JlYXRlU2luayhjYikgKHJlYWQpXG4gIH0pKClcbn1cblxuIiwidmFyIGRyYWluID0gZXhwb3J0cy5kcmFpbiA9IGZ1bmN0aW9uIChyZWFkLCBvcCwgZG9uZSkge1xuXG4gIDsoZnVuY3Rpb24gbmV4dCgpIHtcbiAgICB2YXIgbG9vcCA9IHRydWUsIGNiZWQgPSBmYWxzZVxuICAgIHdoaWxlKGxvb3ApIHtcbiAgICAgIGNiZWQgPSBmYWxzZVxuICAgICAgcmVhZChudWxsLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICAgIGNiZWQgPSB0cnVlXG4gICAgICAgIGlmKGVuZCkge1xuICAgICAgICAgIGxvb3AgPSBmYWxzZVxuICAgICAgICAgIGRvbmUgJiYgZG9uZShlbmQgPT09IHRydWUgPyBudWxsIDogZW5kKVxuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYob3AgJiYgZmFsc2UgPT09IG9wKGRhdGEpKSB7XG4gICAgICAgICAgbG9vcCA9IGZhbHNlXG4gICAgICAgICAgcmVhZCh0cnVlLCBkb25lIHx8IGZ1bmN0aW9uICgpIHt9KVxuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYoIWxvb3Ape1xuICAgICAgICAgIG5leHQoKVxuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgaWYoIWNiZWQpIHtcbiAgICAgICAgbG9vcCA9IGZhbHNlXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuICAgIH1cbiAgfSkoKVxufVxuXG52YXIgb25FbmQgPSBleHBvcnRzLm9uRW5kID0gZnVuY3Rpb24gKHJlYWQsIGRvbmUpIHtcbiAgcmV0dXJuIGRyYWluKHJlYWQsIG51bGwsIGRvbmUpXG59XG5cbnZhciBsb2cgPSBleHBvcnRzLmxvZyA9IGZ1bmN0aW9uIChyZWFkLCBkb25lKSB7XG4gIHJldHVybiBkcmFpbihyZWFkLCBmdW5jdGlvbiAoZGF0YSkge1xuICAgIGNvbnNvbGUubG9nKGRhdGEpXG4gIH0sIGRvbmUpXG59XG5cbiIsIlxudmFyIGtleXMgPSBleHBvcnRzLmtleXMgPVxuZnVuY3Rpb24gKG9iamVjdCkge1xuICByZXR1cm4gdmFsdWVzKE9iamVjdC5rZXlzKG9iamVjdCkpXG59XG5cbnZhciBvbmNlID0gZXhwb3J0cy5vbmNlID1cbmZ1bmN0aW9uICh2YWx1ZSkge1xuICByZXR1cm4gZnVuY3Rpb24gKGFib3J0LCBjYikge1xuICAgIGlmKGFib3J0KSByZXR1cm4gY2IoYWJvcnQpXG4gICAgaWYodmFsdWUgIT0gbnVsbCkge1xuICAgICAgdmFyIF92YWx1ZSA9IHZhbHVlOyB2YWx1ZSA9IG51bGxcbiAgICAgIGNiKG51bGwsIF92YWx1ZSlcbiAgICB9IGVsc2VcbiAgICAgIGNiKHRydWUpXG4gIH1cbn1cblxudmFyIHZhbHVlcyA9IGV4cG9ydHMudmFsdWVzID0gZXhwb3J0cy5yZWFkQXJyYXkgPVxuZnVuY3Rpb24gKGFycmF5KSB7XG4gIGlmKCFBcnJheS5pc0FycmF5KGFycmF5KSlcbiAgICBhcnJheSA9IE9iamVjdC5rZXlzKGFycmF5KS5tYXAoZnVuY3Rpb24gKGspIHtcbiAgICAgIHJldHVybiBhcnJheVtrXVxuICAgIH0pXG4gIHZhciBpID0gMFxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmQpXG4gICAgICByZXR1cm4gY2IgJiYgY2IoZW5kKSAgXG4gICAgY2IoaSA+PSBhcnJheS5sZW5ndGggfHwgbnVsbCwgYXJyYXlbaSsrXSlcbiAgfVxufVxuXG5cbnZhciBjb3VudCA9IGV4cG9ydHMuY291bnQgPSBcbmZ1bmN0aW9uIChtYXgpIHtcbiAgdmFyIGkgPSAwOyBtYXggPSBtYXggfHwgSW5maW5pdHlcbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoZW5kKSByZXR1cm4gY2IgJiYgY2IoZW5kKVxuICAgIGlmKGkgPiBtYXgpXG4gICAgICByZXR1cm4gY2IodHJ1ZSlcbiAgICBjYihudWxsLCBpKyspXG4gIH1cbn1cblxudmFyIGluZmluaXRlID0gZXhwb3J0cy5pbmZpbml0ZSA9IFxuZnVuY3Rpb24gKGdlbmVyYXRlKSB7XG4gIGdlbmVyYXRlID0gZ2VuZXJhdGUgfHwgTWF0aC5yYW5kb21cbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoZW5kKSByZXR1cm4gY2IgJiYgY2IoZW5kKVxuICAgIHJldHVybiBjYihudWxsLCBnZW5lcmF0ZSgpKVxuICB9XG59XG5cbnZhciBkZWZlciA9IGV4cG9ydHMuZGVmZXIgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBfcmVhZCwgY2JzID0gW10sIF9lbmRcblxuICB2YXIgcmVhZCA9IGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoIV9yZWFkKSB7XG4gICAgICBfZW5kID0gZW5kXG4gICAgICBjYnMucHVzaChjYilcbiAgICB9IFxuICAgIGVsc2UgX3JlYWQoZW5kLCBjYilcbiAgfVxuICByZWFkLnJlc29sdmUgPSBmdW5jdGlvbiAocmVhZCkge1xuICAgIGlmKF9yZWFkKSB0aHJvdyBuZXcgRXJyb3IoJ2FscmVhZHkgcmVzb2x2ZWQnKVxuICAgIF9yZWFkID0gcmVhZFxuICAgIGlmKCFfcmVhZCkgdGhyb3cgbmV3IEVycm9yKCdubyByZWFkIGNhbm5vdCByZXNvbHZlIScgKyBfcmVhZClcbiAgICB3aGlsZShjYnMubGVuZ3RoKVxuICAgICAgX3JlYWQoX2VuZCwgY2JzLnNoaWZ0KCkpXG4gIH1cbiAgcmVhZC5hYm9ydCA9IGZ1bmN0aW9uKGVycikge1xuICAgIHJlYWQucmVzb2x2ZShmdW5jdGlvbiAoXywgY2IpIHtcbiAgICAgIGNiKGVyciB8fCB0cnVlKVxuICAgIH0pXG4gIH1cbiAgcmV0dXJuIHJlYWRcbn1cblxudmFyIGVtcHR5ID0gZXhwb3J0cy5lbXB0eSA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIChhYm9ydCwgY2IpIHtcbiAgICBjYih0cnVlKVxuICB9XG59XG5cbnZhciBkZXB0aEZpcnN0ID0gZXhwb3J0cy5kZXB0aEZpcnN0ID1cbmZ1bmN0aW9uIChzdGFydCwgY3JlYXRlU3RyZWFtKSB7XG4gIHZhciByZWFkcyA9IFtdXG5cbiAgcmVhZHMudW5zaGlmdChvbmNlKHN0YXJ0KSlcblxuICByZXR1cm4gZnVuY3Rpb24gbmV4dCAoZW5kLCBjYikge1xuICAgIGlmKCFyZWFkcy5sZW5ndGgpXG4gICAgICByZXR1cm4gY2IodHJ1ZSlcbiAgICByZWFkc1swXShlbmQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZCkge1xuICAgICAgICAvL2lmIHRoaXMgc3RyZWFtIGhhcyBlbmRlZCwgZ28gdG8gdGhlIG5leHQgcXVldWVcbiAgICAgICAgcmVhZHMuc2hpZnQoKVxuICAgICAgICByZXR1cm4gbmV4dChudWxsLCBjYilcbiAgICAgIH1cbiAgICAgIHJlYWRzLnVuc2hpZnQoY3JlYXRlU3RyZWFtKGRhdGEpKVxuICAgICAgY2IoZW5kLCBkYXRhKVxuICAgIH0pXG4gIH1cbn1cbi8vd2lkdGggZmlyc3QgaXMganVzdCBsaWtlIGRlcHRoIGZpcnN0LFxuLy9idXQgcHVzaCBlYWNoIG5ldyBzdHJlYW0gb250byB0aGUgZW5kIG9mIHRoZSBxdWV1ZVxudmFyIHdpZHRoRmlyc3QgPSBleHBvcnRzLndpZHRoRmlyc3QgPSBcbmZ1bmN0aW9uIChzdGFydCwgY3JlYXRlU3RyZWFtKSB7XG4gIHZhciByZWFkcyA9IFtdXG5cbiAgcmVhZHMucHVzaChvbmNlKHN0YXJ0KSlcblxuICByZXR1cm4gZnVuY3Rpb24gbmV4dCAoZW5kLCBjYikge1xuICAgIGlmKCFyZWFkcy5sZW5ndGgpXG4gICAgICByZXR1cm4gY2IodHJ1ZSlcbiAgICByZWFkc1swXShlbmQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZCkge1xuICAgICAgICByZWFkcy5zaGlmdCgpXG4gICAgICAgIHJldHVybiBuZXh0KG51bGwsIGNiKVxuICAgICAgfVxuICAgICAgcmVhZHMucHVzaChjcmVhdGVTdHJlYW0oZGF0YSkpXG4gICAgICBjYihlbmQsIGRhdGEpXG4gICAgfSlcbiAgfVxufVxuXG4vL3RoaXMgY2FtZSBvdXQgZGlmZmVyZW50IHRvIHRoZSBmaXJzdCAoc3RybSlcbi8vYXR0ZW1wdCBhdCBsZWFmRmlyc3QsIGJ1dCBpdCdzIHN0aWxsIGEgdmFsaWRcbi8vdG9wb2xvZ2ljYWwgc29ydC5cbnZhciBsZWFmRmlyc3QgPSBleHBvcnRzLmxlYWZGaXJzdCA9IFxuZnVuY3Rpb24gKHN0YXJ0LCBjcmVhdGVTdHJlYW0pIHtcbiAgdmFyIHJlYWRzID0gW11cbiAgdmFyIG91dHB1dCA9IFtdXG4gIHJlYWRzLnB1c2gob25jZShzdGFydCkpXG4gIFxuICByZXR1cm4gZnVuY3Rpb24gbmV4dCAoZW5kLCBjYikge1xuICAgIHJlYWRzWzBdKGVuZCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kKSB7XG4gICAgICAgIHJlYWRzLnNoaWZ0KClcbiAgICAgICAgaWYoIW91dHB1dC5sZW5ndGgpXG4gICAgICAgICAgcmV0dXJuIGNiKHRydWUpXG4gICAgICAgIHJldHVybiBjYihudWxsLCBvdXRwdXQuc2hpZnQoKSlcbiAgICAgIH1cbiAgICAgIHJlYWRzLnVuc2hpZnQoY3JlYXRlU3RyZWFtKGRhdGEpKVxuICAgICAgb3V0cHV0LnVuc2hpZnQoZGF0YSlcbiAgICAgIG5leHQobnVsbCwgY2IpXG4gICAgfSlcbiAgfVxufVxuXG4iLCJ2YXIgdSAgICAgID0gcmVxdWlyZSgncHVsbC1jb3JlJylcbnZhciBzb3VyY2VzID0gcmVxdWlyZSgnLi9zb3VyY2VzJylcbnZhciBzaW5rcyA9IHJlcXVpcmUoJy4vc2lua3MnKVxuXG52YXIgcHJvcCAgID0gdS5wcm9wXG52YXIgaWQgICAgID0gdS5pZFxudmFyIHRlc3RlciA9IHUudGVzdGVyXG5cbnZhciBtYXAgPSBleHBvcnRzLm1hcCA9IFxuZnVuY3Rpb24gKHJlYWQsIG1hcCkge1xuICBtYXAgPSBwcm9wKG1hcCkgfHwgaWRcbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgcmVhZChlbmQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIHZhciBkYXRhID0gIWVuZCA/IG1hcChkYXRhKSA6IG51bGxcbiAgICAgIGNiKGVuZCwgZGF0YSlcbiAgICB9KVxuICB9XG59XG5cbnZhciBhc3luY01hcCA9IGV4cG9ydHMuYXN5bmNNYXAgPVxuZnVuY3Rpb24gKHJlYWQsIG1hcCkge1xuICBpZighbWFwKSByZXR1cm4gcmVhZFxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmQpIHJldHVybiByZWFkKGVuZCwgY2IpIC8vYWJvcnRcbiAgICByZWFkKG51bGwsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZCkgcmV0dXJuIGNiKGVuZCwgZGF0YSlcbiAgICAgIG1hcChkYXRhLCBjYilcbiAgICB9KVxuICB9XG59XG5cbnZhciBwYXJhTWFwID0gZXhwb3J0cy5wYXJhTWFwID1cbmZ1bmN0aW9uIChyZWFkLCBtYXAsIHdpZHRoKSB7XG4gIGlmKCFtYXApIHJldHVybiByZWFkXG4gIHZhciBlbmRlZCA9IGZhbHNlLCBxdWV1ZSA9IFtdLCBfY2JcblxuICBmdW5jdGlvbiBkcmFpbiAoKSB7XG4gICAgaWYoIV9jYikgcmV0dXJuXG4gICAgdmFyIGNiID0gX2NiXG4gICAgX2NiID0gbnVsbFxuICAgIGlmKHF1ZXVlLmxlbmd0aClcbiAgICAgIHJldHVybiBjYihudWxsLCBxdWV1ZS5zaGlmdCgpKVxuICAgIGVsc2UgaWYoZW5kZWQgJiYgIW4pXG4gICAgICByZXR1cm4gY2IoZW5kZWQpXG4gICAgX2NiID0gY2JcbiAgfVxuXG4gIGZ1bmN0aW9uIHB1bGwgKCkge1xuICAgIHJlYWQobnVsbCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kKSB7XG4gICAgICAgIGVuZGVkID0gZW5kXG4gICAgICAgIHJldHVybiBkcmFpbigpXG4gICAgICB9XG4gICAgICBuKytcbiAgICAgIG1hcChkYXRhLCBmdW5jdGlvbiAoZXJyLCBkYXRhKSB7XG4gICAgICAgIG4tLVxuXG4gICAgICAgIHF1ZXVlLnB1c2goZGF0YSlcbiAgICAgICAgZHJhaW4oKVxuICAgICAgfSlcblxuICAgICAgaWYobiA8IHdpZHRoICYmICFlbmRlZClcbiAgICAgICAgcHVsbCgpXG4gICAgfSlcbiAgfVxuXG4gIHZhciBuID0gMFxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmQpIHJldHVybiByZWFkKGVuZCwgY2IpIC8vYWJvcnRcbiAgICAvL2NvbnRpbnVlIHRvIHJlYWQgd2hpbGUgdGhlcmUgYXJlIGxlc3MgdGhhbiAzIG1hcHMgaW4gZmxpZ2h0XG4gICAgX2NiID0gY2JcbiAgICBpZihxdWV1ZS5sZW5ndGggfHwgZW5kZWQpXG4gICAgICBwdWxsKCksIGRyYWluKClcbiAgICBlbHNlIHB1bGwoKVxuICB9XG4gIHJldHVybiBoaWdoV2F0ZXJNYXJrKGFzeW5jTWFwKHJlYWQsIG1hcCksIHdpZHRoKVxufVxuXG52YXIgZmlsdGVyID0gZXhwb3J0cy5maWx0ZXIgPVxuZnVuY3Rpb24gKHJlYWQsIHRlc3QpIHtcbiAgLy9yZWdleHBcbiAgdGVzdCA9IHRlc3Rlcih0ZXN0KVxuICByZXR1cm4gZnVuY3Rpb24gbmV4dCAoZW5kLCBjYikge1xuICAgIHJlYWQoZW5kLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICBpZighZW5kICYmICF0ZXN0KGRhdGEpKVxuICAgICAgICByZXR1cm4gbmV4dChlbmQsIGNiKVxuICAgICAgY2IoZW5kLCBkYXRhKVxuICAgIH0pXG4gIH1cbn1cblxudmFyIGZpbHRlck5vdCA9IGV4cG9ydHMuZmlsdGVyTm90ID1cbmZ1bmN0aW9uIChyZWFkLCB0ZXN0KSB7XG4gIHRlc3QgPSB0ZXN0ZXIodGVzdClcbiAgcmV0dXJuIGZpbHRlcihyZWFkLCBmdW5jdGlvbiAoZSkge1xuICAgIHJldHVybiAhdGVzdChlKVxuICB9KVxufVxuXG52YXIgdGhyb3VnaCA9IGV4cG9ydHMudGhyb3VnaCA9IFxuZnVuY3Rpb24gKHJlYWQsIG9wLCBvbkVuZCkge1xuICB2YXIgYSA9IGZhbHNlXG4gIGZ1bmN0aW9uIG9uY2UgKGFib3J0KSB7XG4gICAgaWYoYSB8fCAhb25FbmQpIHJldHVyblxuICAgIGEgPSB0cnVlXG4gICAgb25FbmQoYWJvcnQgPT09IHRydWUgPyBudWxsIDogYWJvcnQpXG4gIH1cblxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBpZihlbmQpIG9uY2UoZW5kKVxuICAgIHJldHVybiByZWFkKGVuZCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoIWVuZCkgb3AgJiYgb3AoZGF0YSlcbiAgICAgIGVsc2Ugb25jZShlbmQpXG4gICAgICBjYihlbmQsIGRhdGEpXG4gICAgfSlcbiAgfVxufVxuXG52YXIgdGFrZSA9IGV4cG9ydHMudGFrZSA9XG5mdW5jdGlvbiAocmVhZCwgdGVzdCkge1xuICB2YXIgZW5kZWQgPSBmYWxzZVxuICBpZignbnVtYmVyJyA9PT0gdHlwZW9mIHRlc3QpIHtcbiAgICB2YXIgbiA9IHRlc3Q7IHRlc3QgPSBmdW5jdGlvbiAoKSB7XG4gICAgICByZXR1cm4gbiAtLVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGlmKGVuZGVkKSByZXR1cm4gY2IoZW5kZWQpXG4gICAgaWYoZW5kZWQgPSBlbmQpIHJldHVybiByZWFkKGVuZGVkLCBjYilcblxuICAgIHJlYWQobnVsbCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kZWQgPSBlbmRlZCB8fCBlbmQpIHJldHVybiBjYihlbmRlZClcbiAgICAgIGlmKCF0ZXN0KGRhdGEpKSB7XG4gICAgICAgIGVuZGVkID0gdHJ1ZVxuICAgICAgICByZWFkKHRydWUsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgICAgICBjYihlbmRlZCwgZGF0YSlcbiAgICAgICAgfSlcbiAgICAgIH1cbiAgICAgIGVsc2VcbiAgICAgICAgY2IobnVsbCwgZGF0YSlcbiAgICB9KVxuICB9XG59XG5cbnZhciB1bmlxdWUgPSBleHBvcnRzLnVuaXF1ZSA9IGZ1bmN0aW9uIChyZWFkLCBmaWVsZCwgaW52ZXJ0KSB7XG4gIGZpZWxkID0gcHJvcChmaWVsZCkgfHwgaWRcbiAgdmFyIHNlZW4gPSB7fVxuICByZXR1cm4gZmlsdGVyKHJlYWQsIGZ1bmN0aW9uIChkYXRhKSB7XG4gICAgdmFyIGtleSA9IGZpZWxkKGRhdGEpXG4gICAgaWYoc2VlbltrZXldKSByZXR1cm4gISFpbnZlcnQgLy9mYWxzZSwgYnkgZGVmYXVsdFxuICAgIGVsc2Ugc2VlbltrZXldID0gdHJ1ZVxuICAgIHJldHVybiAhaW52ZXJ0IC8vdHJ1ZSBieSBkZWZhdWx0XG4gIH0pXG59XG5cbnZhciBub25VbmlxdWUgPSBleHBvcnRzLm5vblVuaXF1ZSA9IGZ1bmN0aW9uIChyZWFkLCBmaWVsZCkge1xuICByZXR1cm4gdW5pcXVlKHJlYWQsIGZpZWxkLCB0cnVlKVxufVxuXG52YXIgZ3JvdXAgPSBleHBvcnRzLmdyb3VwID1cbmZ1bmN0aW9uIChyZWFkLCBzaXplKSB7XG4gIHZhciBlbmRlZDsgc2l6ZSA9IHNpemUgfHwgNVxuICB2YXIgcXVldWUgPSBbXVxuXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIC8vdGhpcyBtZWFucyB0aGF0IHRoZSB1cHN0cmVhbSBpcyBzZW5kaW5nIGFuIGVycm9yLlxuICAgIGlmKGVuZCkgcmV0dXJuIHJlYWQoZW5kZWQgPSBlbmQsIGNiKVxuICAgIC8vdGhpcyBtZWFucyB0aGF0IHdlIHJlYWQgYW4gZW5kIGJlZm9yZS5cbiAgICBpZihlbmRlZCkgcmV0dXJuIGNiKGVuZGVkKVxuXG4gICAgcmVhZChudWxsLCBmdW5jdGlvbiBuZXh0KGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kZWQgPSBlbmRlZCB8fCBlbmQpIHtcbiAgICAgICAgaWYoIXF1ZXVlLmxlbmd0aClcbiAgICAgICAgICByZXR1cm4gY2IoZW5kZWQpXG5cbiAgICAgICAgdmFyIF9xdWV1ZSA9IHF1ZXVlOyBxdWV1ZSA9IFtdXG4gICAgICAgIHJldHVybiBjYihudWxsLCBfcXVldWUpXG4gICAgICB9XG4gICAgICBxdWV1ZS5wdXNoKGRhdGEpXG4gICAgICBpZihxdWV1ZS5sZW5ndGggPCBzaXplKVxuICAgICAgICByZXR1cm4gcmVhZChudWxsLCBuZXh0KVxuXG4gICAgICB2YXIgX3F1ZXVlID0gcXVldWU7IHF1ZXVlID0gW11cbiAgICAgIGNiKG51bGwsIF9xdWV1ZSlcbiAgICB9KVxuICB9XG59XG5cbnZhciBmbGF0dGVuID0gZXhwb3J0cy5mbGF0dGVuID0gZnVuY3Rpb24gKHJlYWQpIHtcbiAgdmFyIF9yZWFkXG4gIHJldHVybiBmdW5jdGlvbiAoYWJvcnQsIGNiKSB7XG4gICAgaWYoX3JlYWQpIG5leHRDaHVuaygpXG4gICAgZWxzZSAgICAgIG5leHRTdHJlYW0oKVxuXG4gICAgZnVuY3Rpb24gbmV4dENodW5rICgpIHtcbiAgICAgIF9yZWFkKG51bGwsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgICAgaWYoZW5kKSBuZXh0U3RyZWFtKClcbiAgICAgICAgZWxzZSAgICBjYihudWxsLCBkYXRhKVxuICAgICAgfSlcbiAgICB9XG4gICAgZnVuY3Rpb24gbmV4dFN0cmVhbSAoKSB7XG4gICAgICByZWFkKG51bGwsIGZ1bmN0aW9uIChlbmQsIHN0cmVhbSkge1xuICAgICAgICBpZihlbmQpXG4gICAgICAgICAgcmV0dXJuIGNiKGVuZClcbiAgICAgICAgaWYoQXJyYXkuaXNBcnJheShzdHJlYW0pKVxuICAgICAgICAgIHN0cmVhbSA9IHNvdXJjZXMudmFsdWVzKHN0cmVhbSlcbiAgICAgICAgZWxzZSBpZignZnVuY3Rpb24nICE9IHR5cGVvZiBzdHJlYW0pXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdleHBlY3RlZCBzdHJlYW0gb2Ygc3RyZWFtcycpXG4gICAgICAgIFxuICAgICAgICBfcmVhZCA9IHN0cmVhbVxuICAgICAgICBuZXh0Q2h1bmsoKVxuICAgICAgfSlcbiAgICB9XG4gIH1cbn1cblxudmFyIHByZXBlbmQgPVxuZXhwb3J0cy5wcmVwZW5kID1cbmZ1bmN0aW9uIChyZWFkLCBoZWFkKSB7XG5cbiAgcmV0dXJuIGZ1bmN0aW9uIChhYm9ydCwgY2IpIHtcbiAgICBpZihoZWFkICE9PSBudWxsKSB7XG4gICAgICBpZihhYm9ydClcbiAgICAgICAgcmV0dXJuIHJlYWQoYWJvcnQsIGNiKVxuICAgICAgdmFyIF9oZWFkID0gaGVhZFxuICAgICAgaGVhZCA9IG51bGxcbiAgICAgIGNiKG51bGwsIF9oZWFkKVxuICAgIH0gZWxzZSB7XG4gICAgICByZWFkKGFib3J0LCBjYilcbiAgICB9XG4gIH1cblxufVxuXG4vL3ZhciBkcmFpbklmID0gZXhwb3J0cy5kcmFpbklmID0gZnVuY3Rpb24gKG9wLCBkb25lKSB7XG4vLyAgc2lua3MuZHJhaW4oXG4vL31cblxudmFyIF9yZWR1Y2UgPSBleHBvcnRzLl9yZWR1Y2UgPSBmdW5jdGlvbiAocmVhZCwgcmVkdWNlLCBpbml0aWFsKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoY2xvc2UsIGNiKSB7XG4gICAgaWYoY2xvc2UpIHJldHVybiByZWFkKGNsb3NlLCBjYilcbiAgICBpZihlbmRlZCkgcmV0dXJuIGNiKGVuZGVkKVxuXG4gICAgc2lua3MuZHJhaW4oZnVuY3Rpb24gKGl0ZW0pIHtcbiAgICAgIGluaXRpYWwgPSByZWR1Y2UoaW5pdGlhbCwgaXRlbSlcbiAgICB9LCBmdW5jdGlvbiAoZXJyLCBkYXRhKSB7XG4gICAgICBlbmRlZCA9IGVyciB8fCB0cnVlXG4gICAgICBpZighZXJyKSBjYihudWxsLCBpbml0aWFsKVxuICAgICAgZWxzZSAgICAgY2IoZW5kZWQpXG4gICAgfSlcbiAgICAocmVhZClcbiAgfVxufVxuXG52YXIgbmV4dFRpY2sgPSBwcm9jZXNzLm5leHRUaWNrXG5cbnZhciBoaWdoV2F0ZXJNYXJrID0gZXhwb3J0cy5oaWdoV2F0ZXJNYXJrID0gXG5mdW5jdGlvbiAocmVhZCwgaGlnaFdhdGVyTWFyaykge1xuICB2YXIgYnVmZmVyID0gW10sIHdhaXRpbmcgPSBbXSwgZW5kZWQsIHJlYWRpbmcgPSBmYWxzZVxuICBoaWdoV2F0ZXJNYXJrID0gaGlnaFdhdGVyTWFyayB8fCAxMFxuXG4gIGZ1bmN0aW9uIHJlYWRBaGVhZCAoKSB7XG4gICAgd2hpbGUod2FpdGluZy5sZW5ndGggJiYgKGJ1ZmZlci5sZW5ndGggfHwgZW5kZWQpKVxuICAgICAgd2FpdGluZy5zaGlmdCgpKGVuZGVkLCBlbmRlZCA/IG51bGwgOiBidWZmZXIuc2hpZnQoKSlcbiAgfVxuXG4gIGZ1bmN0aW9uIG5leHQgKCkge1xuICAgIGlmKGVuZGVkIHx8IHJlYWRpbmcgfHwgYnVmZmVyLmxlbmd0aCA+PSBoaWdoV2F0ZXJNYXJrKVxuICAgICAgcmV0dXJuXG4gICAgcmVhZGluZyA9IHRydWVcbiAgICByZXR1cm4gcmVhZChlbmRlZCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgcmVhZGluZyA9IGZhbHNlXG4gICAgICBlbmRlZCA9IGVuZGVkIHx8IGVuZFxuICAgICAgaWYoZGF0YSAhPSBudWxsKSBidWZmZXIucHVzaChkYXRhKVxuICAgICAgXG4gICAgICBuZXh0KCk7IHJlYWRBaGVhZCgpXG4gICAgfSlcbiAgfVxuXG4gIG5leHRUaWNrKG5leHQpXG5cbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgZW5kZWQgPSBlbmRlZCB8fCBlbmRcbiAgICB3YWl0aW5nLnB1c2goY2IpXG5cbiAgICBuZXh0KCk7IHJlYWRBaGVhZCgpXG4gIH1cbn1cblxuXG5cbiIsInZhciBzb3VyY2VzICA9IHJlcXVpcmUoJy4vc291cmNlcycpXG52YXIgc2lua3MgICAgPSByZXF1aXJlKCcuL3NpbmtzJylcbnZhciB0aHJvdWdocyA9IHJlcXVpcmUoJy4vdGhyb3VnaHMnKVxudmFyIHUgICAgICAgID0gcmVxdWlyZSgncHVsbC1jb3JlJylcblxuZnVuY3Rpb24gaXNGdW5jdGlvbiAoZnVuKSB7XG4gIHJldHVybiAnZnVuY3Rpb24nID09PSB0eXBlb2YgZnVuXG59XG5cbmZ1bmN0aW9uIGlzUmVhZGVyIChmdW4pIHtcbiAgcmV0dXJuIGZ1biAmJiAoZnVuLnR5cGUgPT09IFwiVGhyb3VnaFwiIHx8IGZ1bi5sZW5ndGggPT09IDEpXG59XG52YXIgZXhwb3J0cyA9IG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gcHVsbCAoKSB7XG4gIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpXG5cbiAgaWYoaXNSZWFkZXIoYXJnc1swXSkpXG4gICAgcmV0dXJuIGZ1bmN0aW9uIChyZWFkKSB7XG4gICAgICBhcmdzLnVuc2hpZnQocmVhZClcbiAgICAgIHJldHVybiBwdWxsLmFwcGx5KG51bGwsIGFyZ3MpXG4gICAgfVxuXG4gIHZhciByZWFkID0gYXJncy5zaGlmdCgpXG5cbiAgLy9pZiB0aGUgZmlyc3QgZnVuY3Rpb24gaXMgYSBkdXBsZXggc3RyZWFtLFxuICAvL3BpcGUgZnJvbSB0aGUgc291cmNlLlxuICBpZihpc0Z1bmN0aW9uKHJlYWQuc291cmNlKSlcbiAgICByZWFkID0gcmVhZC5zb3VyY2VcblxuICBmdW5jdGlvbiBuZXh0ICgpIHtcbiAgICB2YXIgcyA9IGFyZ3Muc2hpZnQoKVxuXG4gICAgaWYobnVsbCA9PSBzKVxuICAgICAgcmV0dXJuIG5leHQoKVxuXG4gICAgaWYoaXNGdW5jdGlvbihzKSkgcmV0dXJuIHNcblxuICAgIHJldHVybiBmdW5jdGlvbiAocmVhZCkge1xuICAgICAgcy5zaW5rKHJlYWQpXG4gICAgICAvL3RoaXMgc3VwcG9ydHMgcGlwZWluZyB0aHJvdWdoIGEgZHVwbGV4IHN0cmVhbVxuICAgICAgLy9wdWxsKGEsIGIsIGEpIFwidGVsZXBob25lIHN0eWxlXCIuXG4gICAgICAvL2lmIHRoaXMgc3RyZWFtIGlzIGluIHRoZSBhIChmaXJzdCAmIGxhc3QgcG9zaXRpb24pXG4gICAgICAvL3Muc291cmNlIHdpbGwgaGF2ZSBhbHJlYWR5IGJlZW4gdXNlZCwgYnV0IHRoaXMgc2hvdWxkIG5ldmVyIGJlIGNhbGxlZFxuICAgICAgLy9zbyB0aGF0IGlzIG9rYXkuXG4gICAgICByZXR1cm4gcy5zb3VyY2VcbiAgICB9XG4gIH1cblxuICB3aGlsZShhcmdzLmxlbmd0aClcbiAgICByZWFkID0gbmV4dCgpIChyZWFkKVxuXG4gIHJldHVybiByZWFkXG59XG5cblxuZm9yKHZhciBrIGluIHNvdXJjZXMpXG4gIGV4cG9ydHNba10gPSB1LlNvdXJjZShzb3VyY2VzW2tdKVxuXG5mb3IodmFyIGsgaW4gdGhyb3VnaHMpXG4gIGV4cG9ydHNba10gPSB1LlRocm91Z2godGhyb3VnaHNba10pXG5cbmZvcih2YXIgayBpbiBzaW5rcylcbiAgZXhwb3J0c1trXSA9IHUuU2luayhzaW5rc1trXSlcblxudmFyIG1heWJlID0gcmVxdWlyZSgnLi9tYXliZScpKGV4cG9ydHMpXG5cbmZvcih2YXIgayBpbiBtYXliZSlcbiAgZXhwb3J0c1trXSA9IG1heWJlW2tdXG5cbmV4cG9ydHMuRHVwbGV4ICA9IFxuZXhwb3J0cy5UaHJvdWdoID0gZXhwb3J0cy5waXBlYWJsZSAgICAgICA9IHUuVGhyb3VnaFxuZXhwb3J0cy5Tb3VyY2UgID0gZXhwb3J0cy5waXBlYWJsZVNvdXJjZSA9IHUuU291cmNlXG5leHBvcnRzLlNpbmsgICAgPSBleHBvcnRzLnBpcGVhYmxlU2luayAgID0gdS5TaW5rXG5cblxuIiwidmFyIHUgPSByZXF1aXJlKCdwdWxsLWNvcmUnKVxudmFyIHByb3AgPSB1LnByb3BcbnZhciBpZCAgID0gdS5pZFxudmFyIG1heWJlU2luayA9IHUubWF5YmVTaW5rXG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKHB1bGwpIHtcblxuICB2YXIgZXhwb3J0cyA9IHt9XG4gIHZhciBkcmFpbiA9IHB1bGwuZHJhaW5cblxuICB2YXIgZmluZCA9XG4gIGV4cG9ydHMuZmluZCA9IGZ1bmN0aW9uICh0ZXN0LCBjYikge1xuICAgIHJldHVybiBtYXliZVNpbmsoZnVuY3Rpb24gKGNiKSB7XG4gICAgICB2YXIgZW5kZWQgPSBmYWxzZVxuICAgICAgaWYoIWNiKVxuICAgICAgICBjYiA9IHRlc3QsIHRlc3QgPSBpZFxuICAgICAgZWxzZVxuICAgICAgICB0ZXN0ID0gcHJvcCh0ZXN0KSB8fCBpZFxuXG4gICAgICByZXR1cm4gZHJhaW4oZnVuY3Rpb24gKGRhdGEpIHtcbiAgICAgICAgaWYodGVzdChkYXRhKSkge1xuICAgICAgICAgIGVuZGVkID0gdHJ1ZVxuICAgICAgICAgIGNiKG51bGwsIGRhdGEpXG4gICAgICAgIHJldHVybiBmYWxzZVxuICAgICAgICB9XG4gICAgICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgIGlmKGVuZGVkKSByZXR1cm4gLy9hbHJlYWR5IGNhbGxlZCBiYWNrXG4gICAgICAgIGNiKGVyciA9PT0gdHJ1ZSA/IG51bGwgOiBlcnIsIG51bGwpXG4gICAgICB9KVxuXG4gICAgfSwgY2IpXG4gIH1cblxuICB2YXIgcmVkdWNlID0gZXhwb3J0cy5yZWR1Y2UgPVxuICBmdW5jdGlvbiAocmVkdWNlLCBhY2MsIGNiKSB7XG5cbiAgICByZXR1cm4gbWF5YmVTaW5rKGZ1bmN0aW9uIChjYikge1xuICAgICAgcmV0dXJuIGRyYWluKGZ1bmN0aW9uIChkYXRhKSB7XG4gICAgICAgIGFjYyA9IHJlZHVjZShhY2MsIGRhdGEpXG4gICAgICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgIGNiKGVyciwgYWNjKVxuICAgICAgfSlcblxuICAgIH0sIGNiKVxuICB9XG5cbiAgdmFyIGNvbGxlY3QgPSBleHBvcnRzLmNvbGxlY3QgPSBleHBvcnRzLndyaXRlQXJyYXkgPVxuICBmdW5jdGlvbiAoY2IpIHtcbiAgICByZXR1cm4gcmVkdWNlKGZ1bmN0aW9uIChhcnIsIGl0ZW0pIHtcbiAgICAgIGFyci5wdXNoKGl0ZW0pXG4gICAgICByZXR1cm4gYXJyXG4gICAgfSwgW10sIGNiKVxuICB9XG5cbiAgdmFyIGNvbmNhdCA9IGV4cG9ydHMuY29uY2F0ID1cbiAgZnVuY3Rpb24gKGNiKSB7XG4gICAgcmV0dXJuIHJlZHVjZShmdW5jdGlvbiAoYSwgYikge1xuICAgICAgcmV0dXJuIGEgKyBiXG4gICAgfSwgJycsIGNiKVxuICB9XG5cbiAgcmV0dXJuIGV4cG9ydHNcbn1cbiIsImV4cG9ydHMuaWQgPSBcbmZ1bmN0aW9uIChpdGVtKSB7XG4gIHJldHVybiBpdGVtXG59XG5cbmV4cG9ydHMucHJvcCA9IFxuZnVuY3Rpb24gKG1hcCkgeyAgXG4gIGlmKCdzdHJpbmcnID09IHR5cGVvZiBtYXApIHtcbiAgICB2YXIga2V5ID0gbWFwXG4gICAgcmV0dXJuIGZ1bmN0aW9uIChkYXRhKSB7IHJldHVybiBkYXRhW2tleV0gfVxuICB9XG4gIHJldHVybiBtYXBcbn1cblxuZXhwb3J0cy50ZXN0ZXIgPSBmdW5jdGlvbiAodGVzdCkge1xuICBpZighdGVzdCkgcmV0dXJuIGV4cG9ydHMuaWRcbiAgaWYoJ29iamVjdCcgPT09IHR5cGVvZiB0ZXN0XG4gICAgJiYgJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIHRlc3QudGVzdClcbiAgICAgIHJldHVybiB0ZXN0LnRlc3QuYmluZCh0ZXN0KVxuICByZXR1cm4gZXhwb3J0cy5wcm9wKHRlc3QpIHx8IGV4cG9ydHMuaWRcbn1cblxuZXhwb3J0cy5hZGRQaXBlID0gYWRkUGlwZVxuXG5mdW5jdGlvbiBhZGRQaXBlKHJlYWQpIHtcbiAgaWYoJ2Z1bmN0aW9uJyAhPT0gdHlwZW9mIHJlYWQpXG4gICAgcmV0dXJuIHJlYWRcblxuICByZWFkLnBpcGUgPSByZWFkLnBpcGUgfHwgZnVuY3Rpb24gKHJlYWRlcikge1xuICAgIGlmKCdmdW5jdGlvbicgIT0gdHlwZW9mIHJlYWRlciAmJiAnZnVuY3Rpb24nICE9IHR5cGVvZiByZWFkZXIuc2luaylcbiAgICAgIHRocm93IG5ldyBFcnJvcignbXVzdCBwaXBlIHRvIHJlYWRlcicpXG4gICAgdmFyIHBpcGUgPSBhZGRQaXBlKHJlYWRlci5zaW5rID8gcmVhZGVyLnNpbmsocmVhZCkgOiByZWFkZXIocmVhZCkpXG4gICAgcmV0dXJuIHJlYWRlci5zb3VyY2UgfHwgcGlwZTtcbiAgfVxuICBcbiAgcmVhZC50eXBlID0gJ1NvdXJjZSdcbiAgcmV0dXJuIHJlYWRcbn1cblxudmFyIFNvdXJjZSA9XG5leHBvcnRzLlNvdXJjZSA9XG5mdW5jdGlvbiBTb3VyY2UgKGNyZWF0ZVJlYWQpIHtcbiAgZnVuY3Rpb24gcygpIHtcbiAgICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKVxuICAgIHJldHVybiBhZGRQaXBlKGNyZWF0ZVJlYWQuYXBwbHkobnVsbCwgYXJncykpXG4gIH1cbiAgcy50eXBlID0gJ1NvdXJjZSdcbiAgcmV0dXJuIHNcbn1cblxuXG52YXIgVGhyb3VnaCA9XG5leHBvcnRzLlRocm91Z2ggPSBcbmZ1bmN0aW9uIChjcmVhdGVSZWFkKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cylcbiAgICB2YXIgcGlwZWQgPSBbXVxuICAgIGZ1bmN0aW9uIHJlYWRlciAocmVhZCkge1xuICAgICAgYXJncy51bnNoaWZ0KHJlYWQpXG4gICAgICByZWFkID0gY3JlYXRlUmVhZC5hcHBseShudWxsLCBhcmdzKVxuICAgICAgd2hpbGUocGlwZWQubGVuZ3RoKVxuICAgICAgICByZWFkID0gcGlwZWQuc2hpZnQoKShyZWFkKVxuICAgICAgcmV0dXJuIHJlYWRcbiAgICAgIC8vcGlwZWluZyB0byBmcm9tIHRoaXMgcmVhZGVyIHNob3VsZCBjb21wb3NlLi4uXG4gICAgfVxuICAgIHJlYWRlci5waXBlID0gZnVuY3Rpb24gKHJlYWQpIHtcbiAgICAgIHBpcGVkLnB1c2gocmVhZCkgXG4gICAgICBpZihyZWFkLnR5cGUgPT09ICdTb3VyY2UnKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ2Nhbm5vdCBwaXBlICcgKyByZWFkZXIudHlwZSArICcgdG8gU291cmNlJylcbiAgICAgIHJlYWRlci50eXBlID0gcmVhZC50eXBlID09PSAnU2luaycgPyAnU2luaycgOiAnVGhyb3VnaCdcbiAgICAgIHJldHVybiByZWFkZXJcbiAgICB9XG4gICAgcmVhZGVyLnR5cGUgPSAnVGhyb3VnaCdcbiAgICByZXR1cm4gcmVhZGVyXG4gIH1cbn1cblxudmFyIFNpbmsgPVxuZXhwb3J0cy5TaW5rID0gXG5mdW5jdGlvbiBTaW5rKGNyZWF0ZVJlYWRlcikge1xuICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpXG4gICAgaWYoIWNyZWF0ZVJlYWRlcilcbiAgICAgIHRocm93IG5ldyBFcnJvcignbXVzdCBiZSBjcmVhdGVSZWFkZXIgZnVuY3Rpb24nKVxuICAgIGZ1bmN0aW9uIHMgKHJlYWQpIHtcbiAgICAgIGFyZ3MudW5zaGlmdChyZWFkKVxuICAgICAgcmV0dXJuIGNyZWF0ZVJlYWRlci5hcHBseShudWxsLCBhcmdzKVxuICAgIH1cbiAgICBzLnR5cGUgPSAnU2luaydcbiAgICByZXR1cm4gc1xuICB9XG59XG5cblxuZXhwb3J0cy5tYXliZVNpbmsgPSBcbmV4cG9ydHMubWF5YmVEcmFpbiA9IFxuZnVuY3Rpb24gKGNyZWF0ZVNpbmssIGNiKSB7XG4gIGlmKCFjYilcbiAgICByZXR1cm4gVGhyb3VnaChmdW5jdGlvbiAocmVhZCkge1xuICAgICAgdmFyIGVuZGVkXG4gICAgICByZXR1cm4gZnVuY3Rpb24gKGNsb3NlLCBjYikge1xuICAgICAgICBpZihjbG9zZSkgcmV0dXJuIHJlYWQoY2xvc2UsIGNiKVxuICAgICAgICBpZihlbmRlZCkgcmV0dXJuIGNiKGVuZGVkKVxuXG4gICAgICAgIGNyZWF0ZVNpbmsoZnVuY3Rpb24gKGVyciwgZGF0YSkge1xuICAgICAgICAgIGVuZGVkID0gZXJyIHx8IHRydWVcbiAgICAgICAgICBpZighZXJyKSBjYihudWxsLCBkYXRhKVxuICAgICAgICAgIGVsc2UgICAgIGNiKGVuZGVkKVxuICAgICAgICB9KSAocmVhZClcbiAgICAgIH1cbiAgICB9KSgpXG5cbiAgcmV0dXJuIFNpbmsoZnVuY3Rpb24gKHJlYWQpIHtcbiAgICByZXR1cm4gY3JlYXRlU2luayhjYikgKHJlYWQpXG4gIH0pKClcbn1cblxuIiwidmFyIGRyYWluID0gZXhwb3J0cy5kcmFpbiA9IGZ1bmN0aW9uIChyZWFkLCBvcCwgZG9uZSkge1xuXG4gIDsoZnVuY3Rpb24gbmV4dCgpIHtcbiAgICB2YXIgbG9vcCA9IHRydWUsIGNiZWQgPSBmYWxzZVxuICAgIHdoaWxlKGxvb3ApIHtcbiAgICAgIGNiZWQgPSBmYWxzZVxuICAgICAgcmVhZChudWxsLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICAgIGNiZWQgPSB0cnVlXG4gICAgICAgIGlmKGVuZCkge1xuICAgICAgICAgIGxvb3AgPSBmYWxzZVxuICAgICAgICAgIGlmKGRvbmUpIGRvbmUoZW5kID09PSB0cnVlID8gbnVsbCA6IGVuZClcbiAgICAgICAgICBlbHNlIGlmKGVuZCAmJiBlbmQgIT09IHRydWUpXG4gICAgICAgICAgICB0aHJvdyBlbmRcbiAgICAgICAgfVxuICAgICAgICBlbHNlIGlmKG9wICYmIGZhbHNlID09PSBvcChkYXRhKSkge1xuICAgICAgICAgIGxvb3AgPSBmYWxzZVxuICAgICAgICAgIHJlYWQodHJ1ZSwgZG9uZSB8fCBmdW5jdGlvbiAoKSB7fSlcbiAgICAgICAgfVxuICAgICAgICBlbHNlIGlmKCFsb29wKXtcbiAgICAgICAgICBuZXh0KClcbiAgICAgICAgfVxuICAgICAgfSlcbiAgICAgIGlmKCFjYmVkKSB7XG4gICAgICAgIGxvb3AgPSBmYWxzZVxuICAgICAgICByZXR1cm5cbiAgICAgIH1cbiAgICB9XG4gIH0pKClcbn1cblxudmFyIG9uRW5kID0gZXhwb3J0cy5vbkVuZCA9IGZ1bmN0aW9uIChyZWFkLCBkb25lKSB7XG4gIHJldHVybiBkcmFpbihyZWFkLCBudWxsLCBkb25lKVxufVxuXG52YXIgbG9nID0gZXhwb3J0cy5sb2cgPSBmdW5jdGlvbiAocmVhZCwgZG9uZSkge1xuICByZXR1cm4gZHJhaW4ocmVhZCwgZnVuY3Rpb24gKGRhdGEpIHtcbiAgICBjb25zb2xlLmxvZyhkYXRhKVxuICB9LCBkb25lKVxufVxuXG4iLCJcbnZhciBrZXlzID0gZXhwb3J0cy5rZXlzID1cbmZ1bmN0aW9uIChvYmplY3QpIHtcbiAgcmV0dXJuIHZhbHVlcyhPYmplY3Qua2V5cyhvYmplY3QpKVxufVxuXG5mdW5jdGlvbiBhYm9ydENiKGNiLCBhYm9ydCwgb25BYm9ydCkge1xuICBjYihhYm9ydClcbiAgb25BYm9ydCAmJiBvbkFib3J0KGFib3J0ID09PSB0cnVlID8gbnVsbDogYWJvcnQpXG4gIHJldHVyblxufVxuXG52YXIgb25jZSA9IGV4cG9ydHMub25jZSA9XG5mdW5jdGlvbiAodmFsdWUsIG9uQWJvcnQpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIChhYm9ydCwgY2IpIHtcbiAgICBpZihhYm9ydClcbiAgICAgIHJldHVybiBhYm9ydENiKGNiLCBhYm9ydCwgb25BYm9ydClcbiAgICBpZih2YWx1ZSAhPSBudWxsKSB7XG4gICAgICB2YXIgX3ZhbHVlID0gdmFsdWU7IHZhbHVlID0gbnVsbFxuICAgICAgY2IobnVsbCwgX3ZhbHVlKVxuICAgIH0gZWxzZVxuICAgICAgY2IodHJ1ZSlcbiAgfVxufVxuXG52YXIgdmFsdWVzID0gZXhwb3J0cy52YWx1ZXMgPSBleHBvcnRzLnJlYWRBcnJheSA9XG5mdW5jdGlvbiAoYXJyYXksIG9uQWJvcnQpIHtcbiAgaWYoIWFycmF5KVxuICAgIHJldHVybiBmdW5jdGlvbiAoYWJvcnQsIGNiKSB7XG4gICAgICBpZihhYm9ydCkgcmV0dXJuIGFib3J0Q2IoY2IsIGFib3J0LCBvbkFib3J0KVxuICAgICAgcmV0dXJuIGNiKHRydWUpXG4gICAgfVxuICBpZighQXJyYXkuaXNBcnJheShhcnJheSkpXG4gICAgYXJyYXkgPSBPYmplY3Qua2V5cyhhcnJheSkubWFwKGZ1bmN0aW9uIChrKSB7XG4gICAgICByZXR1cm4gYXJyYXlba11cbiAgICB9KVxuICB2YXIgaSA9IDBcbiAgcmV0dXJuIGZ1bmN0aW9uIChhYm9ydCwgY2IpIHtcbiAgICBpZihhYm9ydClcbiAgICAgIHJldHVybiBhYm9ydENiKGNiLCBhYm9ydCwgb25BYm9ydClcbiAgICBjYihpID49IGFycmF5Lmxlbmd0aCB8fCBudWxsLCBhcnJheVtpKytdKVxuICB9XG59XG5cblxudmFyIGNvdW50ID0gZXhwb3J0cy5jb3VudCA9XG5mdW5jdGlvbiAobWF4KSB7XG4gIHZhciBpID0gMDsgbWF4ID0gbWF4IHx8IEluZmluaXR5XG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGlmKGVuZCkgcmV0dXJuIGNiICYmIGNiKGVuZClcbiAgICBpZihpID4gbWF4KVxuICAgICAgcmV0dXJuIGNiKHRydWUpXG4gICAgY2IobnVsbCwgaSsrKVxuICB9XG59XG5cbnZhciBpbmZpbml0ZSA9IGV4cG9ydHMuaW5maW5pdGUgPVxuZnVuY3Rpb24gKGdlbmVyYXRlKSB7XG4gIGdlbmVyYXRlID0gZ2VuZXJhdGUgfHwgTWF0aC5yYW5kb21cbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoZW5kKSByZXR1cm4gY2IgJiYgY2IoZW5kKVxuICAgIHJldHVybiBjYihudWxsLCBnZW5lcmF0ZSgpKVxuICB9XG59XG5cbnZhciBkZWZlciA9IGV4cG9ydHMuZGVmZXIgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBfcmVhZCwgY2JzID0gW10sIF9lbmRcblxuICB2YXIgcmVhZCA9IGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoIV9yZWFkKSB7XG4gICAgICBfZW5kID0gZW5kXG4gICAgICBjYnMucHVzaChjYilcbiAgICB9IFxuICAgIGVsc2UgX3JlYWQoZW5kLCBjYilcbiAgfVxuICByZWFkLnJlc29sdmUgPSBmdW5jdGlvbiAocmVhZCkge1xuICAgIGlmKF9yZWFkKSB0aHJvdyBuZXcgRXJyb3IoJ2FscmVhZHkgcmVzb2x2ZWQnKVxuICAgIF9yZWFkID0gcmVhZFxuICAgIGlmKCFfcmVhZCkgdGhyb3cgbmV3IEVycm9yKCdubyByZWFkIGNhbm5vdCByZXNvbHZlIScgKyBfcmVhZClcbiAgICB3aGlsZShjYnMubGVuZ3RoKVxuICAgICAgX3JlYWQoX2VuZCwgY2JzLnNoaWZ0KCkpXG4gIH1cbiAgcmVhZC5hYm9ydCA9IGZ1bmN0aW9uKGVycikge1xuICAgIHJlYWQucmVzb2x2ZShmdW5jdGlvbiAoXywgY2IpIHtcbiAgICAgIGNiKGVyciB8fCB0cnVlKVxuICAgIH0pXG4gIH1cbiAgcmV0dXJuIHJlYWRcbn1cblxudmFyIGVtcHR5ID0gZXhwb3J0cy5lbXB0eSA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIChhYm9ydCwgY2IpIHtcbiAgICBjYih0cnVlKVxuICB9XG59XG5cbnZhciBlcnJvciA9IGV4cG9ydHMuZXJyb3IgPSBmdW5jdGlvbiAoZXJyKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoYWJvcnQsIGNiKSB7XG4gICAgY2IoZXJyKVxuICB9XG59XG5cbnZhciBkZXB0aEZpcnN0ID0gZXhwb3J0cy5kZXB0aEZpcnN0ID1cbmZ1bmN0aW9uIChzdGFydCwgY3JlYXRlU3RyZWFtKSB7XG4gIHZhciByZWFkcyA9IFtdXG5cbiAgcmVhZHMudW5zaGlmdChvbmNlKHN0YXJ0KSlcblxuICByZXR1cm4gZnVuY3Rpb24gbmV4dCAoZW5kLCBjYikge1xuICAgIGlmKCFyZWFkcy5sZW5ndGgpXG4gICAgICByZXR1cm4gY2IodHJ1ZSlcbiAgICByZWFkc1swXShlbmQsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZCkge1xuICAgICAgICAvL2lmIHRoaXMgc3RyZWFtIGhhcyBlbmRlZCwgZ28gdG8gdGhlIG5leHQgcXVldWVcbiAgICAgICAgcmVhZHMuc2hpZnQoKVxuICAgICAgICByZXR1cm4gbmV4dChudWxsLCBjYilcbiAgICAgIH1cbiAgICAgIHJlYWRzLnVuc2hpZnQoY3JlYXRlU3RyZWFtKGRhdGEpKVxuICAgICAgY2IoZW5kLCBkYXRhKVxuICAgIH0pXG4gIH1cbn1cbi8vd2lkdGggZmlyc3QgaXMganVzdCBsaWtlIGRlcHRoIGZpcnN0LFxuLy9idXQgcHVzaCBlYWNoIG5ldyBzdHJlYW0gb250byB0aGUgZW5kIG9mIHRoZSBxdWV1ZVxudmFyIHdpZHRoRmlyc3QgPSBleHBvcnRzLndpZHRoRmlyc3QgPVxuZnVuY3Rpb24gKHN0YXJ0LCBjcmVhdGVTdHJlYW0pIHtcbiAgdmFyIHJlYWRzID0gW11cblxuICByZWFkcy5wdXNoKG9uY2Uoc3RhcnQpKVxuXG4gIHJldHVybiBmdW5jdGlvbiBuZXh0IChlbmQsIGNiKSB7XG4gICAgaWYoIXJlYWRzLmxlbmd0aClcbiAgICAgIHJldHVybiBjYih0cnVlKVxuICAgIHJlYWRzWzBdKGVuZCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgaWYoZW5kKSB7XG4gICAgICAgIHJlYWRzLnNoaWZ0KClcbiAgICAgICAgcmV0dXJuIG5leHQobnVsbCwgY2IpXG4gICAgICB9XG4gICAgICByZWFkcy5wdXNoKGNyZWF0ZVN0cmVhbShkYXRhKSlcbiAgICAgIGNiKGVuZCwgZGF0YSlcbiAgICB9KVxuICB9XG59XG5cbi8vdGhpcyBjYW1lIG91dCBkaWZmZXJlbnQgdG8gdGhlIGZpcnN0IChzdHJtKVxuLy9hdHRlbXB0IGF0IGxlYWZGaXJzdCwgYnV0IGl0J3Mgc3RpbGwgYSB2YWxpZFxuLy90b3BvbG9naWNhbCBzb3J0LlxudmFyIGxlYWZGaXJzdCA9IGV4cG9ydHMubGVhZkZpcnN0ID1cbmZ1bmN0aW9uIChzdGFydCwgY3JlYXRlU3RyZWFtKSB7XG4gIHZhciByZWFkcyA9IFtdXG4gIHZhciBvdXRwdXQgPSBbXVxuICByZWFkcy5wdXNoKG9uY2Uoc3RhcnQpKVxuXG4gIHJldHVybiBmdW5jdGlvbiBuZXh0IChlbmQsIGNiKSB7XG4gICAgcmVhZHNbMF0oZW5kLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICBpZihlbmQpIHtcbiAgICAgICAgcmVhZHMuc2hpZnQoKVxuICAgICAgICBpZighb3V0cHV0Lmxlbmd0aClcbiAgICAgICAgICByZXR1cm4gY2IodHJ1ZSlcbiAgICAgICAgcmV0dXJuIGNiKG51bGwsIG91dHB1dC5zaGlmdCgpKVxuICAgICAgfVxuICAgICAgcmVhZHMudW5zaGlmdChjcmVhdGVTdHJlYW0oZGF0YSkpXG4gICAgICBvdXRwdXQudW5zaGlmdChkYXRhKVxuICAgICAgbmV4dChudWxsLCBjYilcbiAgICB9KVxuICB9XG59XG5cbiIsInZhciB1ICAgICAgPSByZXF1aXJlKCdwdWxsLWNvcmUnKVxudmFyIHNvdXJjZXMgPSByZXF1aXJlKCcuL3NvdXJjZXMnKVxudmFyIHNpbmtzID0gcmVxdWlyZSgnLi9zaW5rcycpXG5cbnZhciBwcm9wICAgPSB1LnByb3BcbnZhciBpZCAgICAgPSB1LmlkXG52YXIgdGVzdGVyID0gdS50ZXN0ZXJcblxudmFyIG1hcCA9IGV4cG9ydHMubWFwID1cbmZ1bmN0aW9uIChyZWFkLCBtYXApIHtcbiAgbWFwID0gcHJvcChtYXApIHx8IGlkXG4gIHJldHVybiBmdW5jdGlvbiAoYWJvcnQsIGNiKSB7XG4gICAgcmVhZChhYm9ydCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgdHJ5IHtcbiAgICAgIGRhdGEgPSAhZW5kID8gbWFwKGRhdGEpIDogbnVsbFxuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiByZWFkKGVyciwgZnVuY3Rpb24gKCkge1xuICAgICAgICAgIHJldHVybiBjYihlcnIpXG4gICAgICAgIH0pXG4gICAgICB9XG4gICAgICBjYihlbmQsIGRhdGEpXG4gICAgfSlcbiAgfVxufVxuXG52YXIgYXN5bmNNYXAgPSBleHBvcnRzLmFzeW5jTWFwID1cbmZ1bmN0aW9uIChyZWFkLCBtYXApIHtcbiAgaWYoIW1hcCkgcmV0dXJuIHJlYWRcbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoZW5kKSByZXR1cm4gcmVhZChlbmQsIGNiKSAvL2Fib3J0XG4gICAgcmVhZChudWxsLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICBpZihlbmQpIHJldHVybiBjYihlbmQsIGRhdGEpXG4gICAgICBtYXAoZGF0YSwgY2IpXG4gICAgfSlcbiAgfVxufVxuXG52YXIgcGFyYU1hcCA9IGV4cG9ydHMucGFyYU1hcCA9XG5mdW5jdGlvbiAocmVhZCwgbWFwLCB3aWR0aCkge1xuICBpZighbWFwKSByZXR1cm4gcmVhZFxuICB2YXIgZW5kZWQgPSBmYWxzZSwgcXVldWUgPSBbXSwgX2NiXG5cbiAgZnVuY3Rpb24gZHJhaW4gKCkge1xuICAgIGlmKCFfY2IpIHJldHVyblxuICAgIHZhciBjYiA9IF9jYlxuICAgIF9jYiA9IG51bGxcbiAgICBpZihxdWV1ZS5sZW5ndGgpXG4gICAgICByZXR1cm4gY2IobnVsbCwgcXVldWUuc2hpZnQoKSlcbiAgICBlbHNlIGlmKGVuZGVkICYmICFuKVxuICAgICAgcmV0dXJuIGNiKGVuZGVkKVxuICAgIF9jYiA9IGNiXG4gIH1cblxuICBmdW5jdGlvbiBwdWxsICgpIHtcbiAgICByZWFkKG51bGwsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZCkge1xuICAgICAgICBlbmRlZCA9IGVuZFxuICAgICAgICByZXR1cm4gZHJhaW4oKVxuICAgICAgfVxuICAgICAgbisrXG4gICAgICBtYXAoZGF0YSwgZnVuY3Rpb24gKGVyciwgZGF0YSkge1xuICAgICAgICBuLS1cblxuICAgICAgICBxdWV1ZS5wdXNoKGRhdGEpXG4gICAgICAgIGRyYWluKClcbiAgICAgIH0pXG5cbiAgICAgIGlmKG4gPCB3aWR0aCAmJiAhZW5kZWQpXG4gICAgICAgIHB1bGwoKVxuICAgIH0pXG4gIH1cblxuICB2YXIgbiA9IDBcbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoZW5kKSByZXR1cm4gcmVhZChlbmQsIGNiKSAvL2Fib3J0XG4gICAgLy9jb250aW51ZSB0byByZWFkIHdoaWxlIHRoZXJlIGFyZSBsZXNzIHRoYW4gMyBtYXBzIGluIGZsaWdodFxuICAgIF9jYiA9IGNiXG4gICAgaWYocXVldWUubGVuZ3RoIHx8IGVuZGVkKVxuICAgICAgcHVsbCgpLCBkcmFpbigpXG4gICAgZWxzZSBwdWxsKClcbiAgfVxuICByZXR1cm4gaGlnaFdhdGVyTWFyayhhc3luY01hcChyZWFkLCBtYXApLCB3aWR0aClcbn1cblxudmFyIGZpbHRlciA9IGV4cG9ydHMuZmlsdGVyID1cbmZ1bmN0aW9uIChyZWFkLCB0ZXN0KSB7XG4gIC8vcmVnZXhwXG4gIHRlc3QgPSB0ZXN0ZXIodGVzdClcbiAgcmV0dXJuIGZ1bmN0aW9uIG5leHQgKGVuZCwgY2IpIHtcbiAgICB2YXIgc3luYywgbG9vcCA9IHRydWVcbiAgICB3aGlsZShsb29wKSB7XG4gICAgICBsb29wID0gZmFsc2VcbiAgICAgIHN5bmMgPSB0cnVlXG4gICAgICByZWFkKGVuZCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgICBpZighZW5kICYmICF0ZXN0KGRhdGEpKVxuICAgICAgICAgIHJldHVybiBzeW5jID8gbG9vcCA9IHRydWUgOiBuZXh0KGVuZCwgY2IpXG4gICAgICAgIGNiKGVuZCwgZGF0YSlcbiAgICAgIH0pXG4gICAgICBzeW5jID0gZmFsc2VcbiAgICB9XG4gIH1cbn1cblxudmFyIGZpbHRlck5vdCA9IGV4cG9ydHMuZmlsdGVyTm90ID1cbmZ1bmN0aW9uIChyZWFkLCB0ZXN0KSB7XG4gIHRlc3QgPSB0ZXN0ZXIodGVzdClcbiAgcmV0dXJuIGZpbHRlcihyZWFkLCBmdW5jdGlvbiAoZSkge1xuICAgIHJldHVybiAhdGVzdChlKVxuICB9KVxufVxuXG52YXIgdGhyb3VnaCA9IGV4cG9ydHMudGhyb3VnaCA9XG5mdW5jdGlvbiAocmVhZCwgb3AsIG9uRW5kKSB7XG4gIHZhciBhID0gZmFsc2VcbiAgZnVuY3Rpb24gb25jZSAoYWJvcnQpIHtcbiAgICBpZihhIHx8ICFvbkVuZCkgcmV0dXJuXG4gICAgYSA9IHRydWVcbiAgICBvbkVuZChhYm9ydCA9PT0gdHJ1ZSA/IG51bGwgOiBhYm9ydClcbiAgfVxuXG4gIHJldHVybiBmdW5jdGlvbiAoZW5kLCBjYikge1xuICAgIGlmKGVuZCkgb25jZShlbmQpXG4gICAgcmV0dXJuIHJlYWQoZW5kLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICBpZighZW5kKSBvcCAmJiBvcChkYXRhKVxuICAgICAgZWxzZSBvbmNlKGVuZClcbiAgICAgIGNiKGVuZCwgZGF0YSlcbiAgICB9KVxuICB9XG59XG5cbnZhciB0YWtlID0gZXhwb3J0cy50YWtlID1cbmZ1bmN0aW9uIChyZWFkLCB0ZXN0KSB7XG4gIHZhciBlbmRlZCA9IGZhbHNlXG4gIGlmKCdudW1iZXInID09PSB0eXBlb2YgdGVzdCkge1xuICAgIHZhciBuID0gdGVzdDsgdGVzdCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgIHJldHVybiBuIC0tXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgaWYoZW5kZWQpIHJldHVybiBjYihlbmRlZClcbiAgICBpZihlbmRlZCA9IGVuZCkgcmV0dXJuIHJlYWQoZW5kZWQsIGNiKVxuXG4gICAgcmVhZChudWxsLCBmdW5jdGlvbiAoZW5kLCBkYXRhKSB7XG4gICAgICBpZihlbmRlZCA9IGVuZGVkIHx8IGVuZCkgcmV0dXJuIGNiKGVuZGVkKVxuICAgICAgaWYoIXRlc3QoZGF0YSkpIHtcbiAgICAgICAgZW5kZWQgPSB0cnVlXG4gICAgICAgIHJlYWQodHJ1ZSwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgICAgIGNiKGVuZGVkLCBkYXRhKVxuICAgICAgICB9KVxuICAgICAgfVxuICAgICAgZWxzZVxuICAgICAgICBjYihudWxsLCBkYXRhKVxuICAgIH0pXG4gIH1cbn1cblxudmFyIHVuaXF1ZSA9IGV4cG9ydHMudW5pcXVlID0gZnVuY3Rpb24gKHJlYWQsIGZpZWxkLCBpbnZlcnQpIHtcbiAgZmllbGQgPSBwcm9wKGZpZWxkKSB8fCBpZFxuICB2YXIgc2VlbiA9IHt9XG4gIHJldHVybiBmaWx0ZXIocmVhZCwgZnVuY3Rpb24gKGRhdGEpIHtcbiAgICB2YXIga2V5ID0gZmllbGQoZGF0YSlcbiAgICBpZihzZWVuW2tleV0pIHJldHVybiAhIWludmVydCAvL2ZhbHNlLCBieSBkZWZhdWx0XG4gICAgZWxzZSBzZWVuW2tleV0gPSB0cnVlXG4gICAgcmV0dXJuICFpbnZlcnQgLy90cnVlIGJ5IGRlZmF1bHRcbiAgfSlcbn1cblxudmFyIG5vblVuaXF1ZSA9IGV4cG9ydHMubm9uVW5pcXVlID0gZnVuY3Rpb24gKHJlYWQsIGZpZWxkKSB7XG4gIHJldHVybiB1bmlxdWUocmVhZCwgZmllbGQsIHRydWUpXG59XG5cbnZhciBncm91cCA9IGV4cG9ydHMuZ3JvdXAgPVxuZnVuY3Rpb24gKHJlYWQsIHNpemUpIHtcbiAgdmFyIGVuZGVkOyBzaXplID0gc2l6ZSB8fCA1XG4gIHZhciBxdWV1ZSA9IFtdXG5cbiAgcmV0dXJuIGZ1bmN0aW9uIChlbmQsIGNiKSB7XG4gICAgLy90aGlzIG1lYW5zIHRoYXQgdGhlIHVwc3RyZWFtIGlzIHNlbmRpbmcgYW4gZXJyb3IuXG4gICAgaWYoZW5kKSByZXR1cm4gcmVhZChlbmRlZCA9IGVuZCwgY2IpXG4gICAgLy90aGlzIG1lYW5zIHRoYXQgd2UgcmVhZCBhbiBlbmQgYmVmb3JlLlxuICAgIGlmKGVuZGVkKSByZXR1cm4gY2IoZW5kZWQpXG5cbiAgICByZWFkKG51bGwsIGZ1bmN0aW9uIG5leHQoZW5kLCBkYXRhKSB7XG4gICAgICBpZihlbmRlZCA9IGVuZGVkIHx8IGVuZCkge1xuICAgICAgICBpZighcXVldWUubGVuZ3RoKVxuICAgICAgICAgIHJldHVybiBjYihlbmRlZClcblxuICAgICAgICB2YXIgX3F1ZXVlID0gcXVldWU7IHF1ZXVlID0gW11cbiAgICAgICAgcmV0dXJuIGNiKG51bGwsIF9xdWV1ZSlcbiAgICAgIH1cbiAgICAgIHF1ZXVlLnB1c2goZGF0YSlcbiAgICAgIGlmKHF1ZXVlLmxlbmd0aCA8IHNpemUpXG4gICAgICAgIHJldHVybiByZWFkKG51bGwsIG5leHQpXG5cbiAgICAgIHZhciBfcXVldWUgPSBxdWV1ZTsgcXVldWUgPSBbXVxuICAgICAgY2IobnVsbCwgX3F1ZXVlKVxuICAgIH0pXG4gIH1cbn1cblxudmFyIGZsYXR0ZW4gPSBleHBvcnRzLmZsYXR0ZW4gPSBmdW5jdGlvbiAocmVhZCkge1xuICB2YXIgX3JlYWRcbiAgcmV0dXJuIGZ1bmN0aW9uIChhYm9ydCwgY2IpIHtcbiAgICBpZihfcmVhZCkgbmV4dENodW5rKClcbiAgICBlbHNlICAgICAgbmV4dFN0cmVhbSgpXG5cbiAgICBmdW5jdGlvbiBuZXh0Q2h1bmsgKCkge1xuICAgICAgX3JlYWQobnVsbCwgZnVuY3Rpb24gKGVuZCwgZGF0YSkge1xuICAgICAgICBpZihlbmQpIG5leHRTdHJlYW0oKVxuICAgICAgICBlbHNlICAgIGNiKG51bGwsIGRhdGEpXG4gICAgICB9KVxuICAgIH1cbiAgICBmdW5jdGlvbiBuZXh0U3RyZWFtICgpIHtcbiAgICAgIHJlYWQobnVsbCwgZnVuY3Rpb24gKGVuZCwgc3RyZWFtKSB7XG4gICAgICAgIGlmKGVuZClcbiAgICAgICAgICByZXR1cm4gY2IoZW5kKVxuICAgICAgICBpZihBcnJheS5pc0FycmF5KHN0cmVhbSkgfHwgc3RyZWFtICYmICdvYmplY3QnID09PSB0eXBlb2Ygc3RyZWFtKVxuICAgICAgICAgIHN0cmVhbSA9IHNvdXJjZXMudmFsdWVzKHN0cmVhbSlcbiAgICAgICAgZWxzZSBpZignZnVuY3Rpb24nICE9IHR5cGVvZiBzdHJlYW0pXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdleHBlY3RlZCBzdHJlYW0gb2Ygc3RyZWFtcycpXG4gICAgICAgIF9yZWFkID0gc3RyZWFtXG4gICAgICAgIG5leHRDaHVuaygpXG4gICAgICB9KVxuICAgIH1cbiAgfVxufVxuXG52YXIgcHJlcGVuZCA9XG5leHBvcnRzLnByZXBlbmQgPVxuZnVuY3Rpb24gKHJlYWQsIGhlYWQpIHtcblxuICByZXR1cm4gZnVuY3Rpb24gKGFib3J0LCBjYikge1xuICAgIGlmKGhlYWQgIT09IG51bGwpIHtcbiAgICAgIGlmKGFib3J0KVxuICAgICAgICByZXR1cm4gcmVhZChhYm9ydCwgY2IpXG4gICAgICB2YXIgX2hlYWQgPSBoZWFkXG4gICAgICBoZWFkID0gbnVsbFxuICAgICAgY2IobnVsbCwgX2hlYWQpXG4gICAgfSBlbHNlIHtcbiAgICAgIHJlYWQoYWJvcnQsIGNiKVxuICAgIH1cbiAgfVxuXG59XG5cbi8vdmFyIGRyYWluSWYgPSBleHBvcnRzLmRyYWluSWYgPSBmdW5jdGlvbiAob3AsIGRvbmUpIHtcbi8vICBzaW5rcy5kcmFpbihcbi8vfVxuXG52YXIgX3JlZHVjZSA9IGV4cG9ydHMuX3JlZHVjZSA9IGZ1bmN0aW9uIChyZWFkLCByZWR1Y2UsIGluaXRpYWwpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIChjbG9zZSwgY2IpIHtcbiAgICBpZihjbG9zZSkgcmV0dXJuIHJlYWQoY2xvc2UsIGNiKVxuICAgIGlmKGVuZGVkKSByZXR1cm4gY2IoZW5kZWQpXG5cbiAgICBzaW5rcy5kcmFpbihmdW5jdGlvbiAoaXRlbSkge1xuICAgICAgaW5pdGlhbCA9IHJlZHVjZShpbml0aWFsLCBpdGVtKVxuICAgIH0sIGZ1bmN0aW9uIChlcnIsIGRhdGEpIHtcbiAgICAgIGVuZGVkID0gZXJyIHx8IHRydWVcbiAgICAgIGlmKCFlcnIpIGNiKG51bGwsIGluaXRpYWwpXG4gICAgICBlbHNlICAgICBjYihlbmRlZClcbiAgICB9KVxuICAgIChyZWFkKVxuICB9XG59XG5cbnZhciBuZXh0VGljayA9IHByb2Nlc3MubmV4dFRpY2tcblxudmFyIGhpZ2hXYXRlck1hcmsgPSBleHBvcnRzLmhpZ2hXYXRlck1hcmsgPVxuZnVuY3Rpb24gKHJlYWQsIGhpZ2hXYXRlck1hcmspIHtcbiAgdmFyIGJ1ZmZlciA9IFtdLCB3YWl0aW5nID0gW10sIGVuZGVkLCBlbmRpbmcsIHJlYWRpbmcgPSBmYWxzZVxuICBoaWdoV2F0ZXJNYXJrID0gaGlnaFdhdGVyTWFyayB8fCAxMFxuXG4gIGZ1bmN0aW9uIHJlYWRBaGVhZCAoKSB7XG4gICAgd2hpbGUod2FpdGluZy5sZW5ndGggJiYgKGJ1ZmZlci5sZW5ndGggfHwgZW5kZWQpKVxuICAgICAgd2FpdGluZy5zaGlmdCgpKGVuZGVkLCBlbmRlZCA/IG51bGwgOiBidWZmZXIuc2hpZnQoKSlcblxuICAgIGlmICghYnVmZmVyLmxlbmd0aCAmJiBlbmRpbmcpIGVuZGVkID0gZW5kaW5nO1xuICB9XG5cbiAgZnVuY3Rpb24gbmV4dCAoKSB7XG4gICAgaWYoZW5kZWQgfHwgZW5kaW5nIHx8IHJlYWRpbmcgfHwgYnVmZmVyLmxlbmd0aCA+PSBoaWdoV2F0ZXJNYXJrKVxuICAgICAgcmV0dXJuXG4gICAgcmVhZGluZyA9IHRydWVcbiAgICByZXR1cm4gcmVhZChlbmRlZCB8fCBlbmRpbmcsIGZ1bmN0aW9uIChlbmQsIGRhdGEpIHtcbiAgICAgIHJlYWRpbmcgPSBmYWxzZVxuICAgICAgZW5kaW5nID0gZW5kaW5nIHx8IGVuZFxuICAgICAgaWYoZGF0YSAhPSBudWxsKSBidWZmZXIucHVzaChkYXRhKVxuXG4gICAgICBuZXh0KCk7IHJlYWRBaGVhZCgpXG4gICAgfSlcbiAgfVxuXG4gIHByb2Nlc3MubmV4dFRpY2sobmV4dClcblxuICByZXR1cm4gZnVuY3Rpb24gKGVuZCwgY2IpIHtcbiAgICBlbmRlZCA9IGVuZGVkIHx8IGVuZFxuICAgIHdhaXRpbmcucHVzaChjYilcblxuICAgIG5leHQoKTsgcmVhZEFoZWFkKClcbiAgfVxufVxuXG52YXIgZmxhdE1hcCA9IGV4cG9ydHMuZmxhdE1hcCA9XG5mdW5jdGlvbiAocmVhZCwgbWFwcGVyKSB7XG4gIG1hcHBlciA9IG1hcHBlciB8fCBpZFxuICB2YXIgcXVldWUgPSBbXSwgZW5kZWRcblxuICByZXR1cm4gZnVuY3Rpb24gKGFib3J0LCBjYikge1xuICAgIGlmKHF1ZXVlLmxlbmd0aCkgcmV0dXJuIGNiKG51bGwsIHF1ZXVlLnNoaWZ0KCkpXG4gICAgZWxzZSBpZihlbmRlZCkgICByZXR1cm4gY2IoZW5kZWQpXG5cbiAgICByZWFkKGFib3J0LCBmdW5jdGlvbiBuZXh0IChlbmQsIGRhdGEpIHtcbiAgICAgIGlmKGVuZCkgZW5kZWQgPSBlbmRcbiAgICAgIGVsc2Uge1xuICAgICAgICB2YXIgYWRkID0gbWFwcGVyKGRhdGEpXG4gICAgICAgIHdoaWxlKGFkZCAmJiBhZGQubGVuZ3RoKVxuICAgICAgICAgIHF1ZXVlLnB1c2goYWRkLnNoaWZ0KCkpXG4gICAgICB9XG5cbiAgICAgIGlmKHF1ZXVlLmxlbmd0aCkgY2IobnVsbCwgcXVldWUuc2hpZnQoKSlcbiAgICAgIGVsc2UgaWYoZW5kZWQpICAgY2IoZW5kZWQpXG4gICAgICBlbHNlICAgICAgICAgICAgIHJlYWQobnVsbCwgbmV4dClcbiAgICB9KVxuICB9XG59XG5cbiIsInZhciBleHRlbmQgPSByZXF1aXJlKCdjb2cvZXh0ZW5kJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oc2lnbmFsbGVyKSB7XG5cbiAgZnVuY3Rpb24gZGF0YUFsbG93ZWQoZGF0YSkge1xuICAgIHZhciBjbG9uZWQgPSBleHRlbmQoeyBhbGxvdzogdHJ1ZSB9LCBkYXRhKTtcbiAgICBzaWduYWxsZXIoJ3BlZXI6ZmlsdGVyJywgZGF0YS5pZCwgY2xvbmVkKTtcblxuICAgIHJldHVybiBjbG9uZWQuYWxsb3c7XG4gIH1cblxuICByZXR1cm4gZnVuY3Rpb24oYXJncywgbWVzc2FnZVR5cGUsIHNyY0RhdGEsIHNyY1N0YXRlLCBpc0RNKSB7XG4gICAgdmFyIGRhdGEgPSBhcmdzWzBdO1xuICAgIHZhciBwZWVyO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSB2YWxpZCBkYXRhIHRoZW4gcHJvY2Vzc1xuICAgIGlmIChkYXRhICYmIGRhdGEuaWQgJiYgZGF0YS5pZCAhPT0gc2lnbmFsbGVyLmlkKSB7XG4gICAgICBpZiAoISBkYXRhQWxsb3dlZChkYXRhKSkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBjaGVjayB0byBzZWUgaWYgdGhpcyBpcyBhIGtub3duIHBlZXJcbiAgICAgIHBlZXIgPSBzaWduYWxsZXIucGVlcnMuZ2V0KGRhdGEuaWQpO1xuXG4gICAgICAvLyB0cmlnZ2VyIHRoZSBwZWVyIGNvbm5lY3RlZCBldmVudCB0byBmbGFnIHRoYXQgd2Uga25vdyBhYm91dCBhXG4gICAgICAvLyBwZWVyIGNvbm5lY3Rpb24uIFRoZSBwZWVyIGhhcyBwYXNzZWQgdGhlIFwiZmlsdGVyXCIgY2hlY2sgYnV0IG1heVxuICAgICAgLy8gYmUgYW5ub3VuY2VkIC8gdXBkYXRlZCBkZXBlbmRpbmcgb24gcHJldmlvdXMgY29ubmVjdGlvbiBzdGF0dXNcbiAgICAgIHNpZ25hbGxlcigncGVlcjpjb25uZWN0ZWQnLCBkYXRhLmlkLCBkYXRhKTtcblxuICAgICAgLy8gaWYgdGhlIHBlZXIgaXMgZXhpc3RpbmcsIHRoZW4gdXBkYXRlIHRoZSBkYXRhXG4gICAgICBpZiAocGVlcikge1xuICAgICAgICAvLyB1cGRhdGUgdGhlIGRhdGFcbiAgICAgICAgZXh0ZW5kKHBlZXIuZGF0YSwgZGF0YSk7XG5cbiAgICAgICAgLy8gdHJpZ2dlciB0aGUgcGVlciB1cGRhdGUgZXZlbnRcbiAgICAgICAgcmV0dXJuIHNpZ25hbGxlcigncGVlcjp1cGRhdGUnLCBkYXRhLCBzcmNEYXRhKTtcbiAgICAgIH1cblxuICAgICAgLy8gY3JlYXRlIGEgbmV3IHBlZXJcbiAgICAgIHBlZXIgPSB7XG4gICAgICAgIGlkOiBkYXRhLmlkLFxuXG4gICAgICAgIC8vIGluaXRpYWxpc2UgdGhlIGxvY2FsIHJvbGUgaW5kZXhcbiAgICAgICAgcm9sZUlkeDogW2RhdGEuaWQsIHNpZ25hbGxlci5pZF0uc29ydCgpLmluZGV4T2YoZGF0YS5pZCksXG5cbiAgICAgICAgLy8gaW5pdGlhbGlzZSB0aGUgcGVlciBkYXRhXG4gICAgICAgIGRhdGE6IHt9XG4gICAgICB9O1xuXG4gICAgICAvLyBpbml0aWFsaXNlIHRoZSBwZWVyIGRhdGFcbiAgICAgIGV4dGVuZChwZWVyLmRhdGEsIGRhdGEpO1xuXG4gICAgICAvLyBzZXQgdGhlIHBlZXIgZGF0YVxuICAgICAgc2lnbmFsbGVyLnBlZXJzLnNldChkYXRhLmlkLCBwZWVyKTtcblxuICAgICAgLy8gaWYgdGhpcyBpcyBhbiBpbml0aWFsIGFubm91bmNlIG1lc3NhZ2UgKG5vIHZlY3RvciBjbG9jayBhdHRhY2hlZClcbiAgICAgIC8vIHRoZW4gc2VuZCBhIGFubm91bmNlIHJlcGx5XG4gICAgICBpZiAoc2lnbmFsbGVyLmF1dG9yZXBseSAmJiAoISBpc0RNKSkge1xuICAgICAgICBzaWduYWxsZXJcbiAgICAgICAgICAudG8oZGF0YS5pZClcbiAgICAgICAgICAuc2VuZCgnL2Fubm91bmNlJywgc2lnbmFsbGVyLmF0dHJpYnV0ZXMpO1xuICAgICAgfVxuXG4gICAgICAvLyBlbWl0IGEgbmV3IHBlZXIgYW5ub3VuY2UgZXZlbnRcbiAgICAgIHJldHVybiBzaWduYWxsZXIoJ3BlZXI6YW5ub3VuY2UnLCBkYXRhLCBwZWVyKTtcbiAgICB9XG4gIH07XG59O1xuIiwiLyoqXG4gICMjIyBwcmVwYXJlXG5cbiAgYGBgXG4gIGZuKGFyZ3MpID0+IFN0cmluZ1xuICBgYGBcblxuICBDb252ZXJ0IGFuIGFycmF5IG9mIHZhbHVlcyBpbnRvIGEgcGlwZS1kZWxpbWl0ZWQgc3RyaW5nLlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oYXJncykge1xuICByZXR1cm4gYXJncy5tYXAocHJlcGFyZUFyZykuam9pbignfCcpO1xufTtcblxuZnVuY3Rpb24gcHJlcGFyZUFyZyhhcmcpIHtcbiAgaWYgKHR5cGVvZiBhcmcgPT0gJ29iamVjdCcgJiYgKCEgKGFyZyBpbnN0YW5jZW9mIFN0cmluZykpKSB7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGFyZyk7XG4gIH1cbiAgZWxzZSBpZiAodHlwZW9mIGFyZyA9PSAnZnVuY3Rpb24nKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICByZXR1cm4gYXJnO1xufVxuIiwidmFyIGpzb25wYXJzZSA9IHJlcXVpcmUoJ2NvZy9qc29ucGFyc2UnKTtcblxuLyoqXG4gICMjIyBwcm9jZXNzXG5cbiAgYGBgXG4gIGZuKHNpZ25hbGxlciwgb3B0cykgPT4gZm4obWVzc2FnZSlcbiAgYGBgXG5cbiAgVGhlIGNvcmUgcHJvY2Vzc2luZyBsb2dpYyB0aGF0IGlzIHVzZWQgdG8gcmVzcG9uZCB0byBpbmNvbWluZyBzaWduYWxpbmdcbiAgbWVzc2FnZXMuXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihzaWduYWxsZXIsIG9wdHMpIHtcbiAgdmFyIGhhbmRsZXJzID0ge1xuICAgIGFubm91bmNlOiByZXF1aXJlKCcuL2hhbmRsZXJzL2Fubm91bmNlJykoc2lnbmFsbGVyLCBvcHRzKVxuICB9O1xuXG4gIGZ1bmN0aW9uIHNlbmRFdmVudChwYXJ0cywgc3JjU3RhdGUsIGRhdGEpIHtcbiAgICAvLyBpbml0aWFsaXNlIHRoZSBldmVudCBuYW1lXG4gICAgdmFyIGV2dE5hbWUgPSAnbWVzc2FnZTonICsgcGFydHNbMF0uc2xpY2UoMSk7XG5cbiAgICAvLyBjb252ZXJ0IGFueSB2YWxpZCBqc29uIG9iamVjdHMgdG8ganNvblxuICAgIHZhciBhcmdzID0gcGFydHMuc2xpY2UoMikubWFwKGpzb25wYXJzZSk7XG5cbiAgICBzaWduYWxsZXIuYXBwbHkoXG4gICAgICBzaWduYWxsZXIsXG4gICAgICBbZXZ0TmFtZV0uY29uY2F0KGFyZ3MpLmNvbmNhdChbc3JjU3RhdGUsIGRhdGFdKVxuICAgICk7XG4gIH1cblxuICByZXR1cm4gZnVuY3Rpb24ob3JpZ2luYWxEYXRhKSB7XG4gICAgdmFyIGRhdGEgPSBvcmlnaW5hbERhdGE7XG4gICAgdmFyIGlzTWF0Y2ggPSB0cnVlO1xuICAgIHZhciBwYXJ0cztcbiAgICB2YXIgaGFuZGxlcjtcbiAgICB2YXIgc3JjRGF0YTtcbiAgICB2YXIgc3JjU3RhdGU7XG4gICAgdmFyIGlzRGlyZWN0TWVzc2FnZSA9IGZhbHNlO1xuXG4gICAgLy8gZGlzY2FyZCBwcmltdXMgbWVzc2FnZXNcbiAgICBpZiAoZGF0YSAmJiBkYXRhLnNsaWNlKDAsIDYpID09PSAncHJpbXVzJykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIGZvcmNlIHRoZSBpZCBpbnRvIHN0cmluZyBmb3JtYXQgc28gd2UgY2FuIHJ1biBsZW5ndGggYW5kIGNvbXBhcmlzb24gdGVzdHMgb24gaXRcbiAgICB2YXIgaWQgPSBzaWduYWxsZXIuaWQgKyAnJztcblxuICAgIC8vIHByb2Nlc3MgL3RvIG1lc3NhZ2VzXG4gICAgaWYgKGRhdGEuc2xpY2UoMCwgMykgPT09ICcvdG8nKSB7XG4gICAgICBpc01hdGNoID0gZGF0YS5zbGljZSg0LCBpZC5sZW5ndGggKyA0KSA9PT0gaWQ7XG4gICAgICBpZiAoaXNNYXRjaCkge1xuICAgICAgICBwYXJ0cyA9IGRhdGEuc2xpY2UoNSArIGlkLmxlbmd0aCkuc3BsaXQoJ3wnKS5tYXAoanNvbnBhcnNlKTtcblxuICAgICAgICAvLyBnZXQgdGhlIHNvdXJjZSBkYXRhXG4gICAgICAgIGlzRGlyZWN0TWVzc2FnZSA9IHRydWU7XG5cbiAgICAgICAgLy8gZXh0cmFjdCB0aGUgdmVjdG9yIGNsb2NrIGFuZCB1cGRhdGUgdGhlIHBhcnRzXG4gICAgICAgIHBhcnRzID0gcGFydHMubWFwKGpzb25wYXJzZSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gaWYgdGhpcyBpcyBub3QgYSBtYXRjaCwgdGhlbiBiYWlsXG4gICAgaWYgKCEgaXNNYXRjaCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIGNob3AgdGhlIGRhdGEgaW50byBwYXJ0c1xuICAgIHNpZ25hbGxlcigncmF3ZGF0YScsIGRhdGEpO1xuICAgIHBhcnRzID0gcGFydHMgfHwgZGF0YS5zcGxpdCgnfCcpLm1hcChqc29ucGFyc2UpO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSBhIHNwZWNpZmljIGhhbmRsZXIgZm9yIHRoZSBhY3Rpb24sIHRoZW4gaW52b2tlXG4gICAgaWYgKHR5cGVvZiBwYXJ0c1swXSA9PSAnc3RyaW5nJykge1xuICAgICAgLy8gZXh0cmFjdCB0aGUgbWV0YWRhdGEgZnJvbSB0aGUgaW5wdXQgZGF0YVxuICAgICAgc3JjRGF0YSA9IHBhcnRzWzFdO1xuXG4gICAgICAvLyBpZiB3ZSBnb3QgZGF0YSBmcm9tIG91cnNlbGYsIHRoZW4gdGhpcyBpcyBwcmV0dHkgZHVtYlxuICAgICAgLy8gYnV0IGlmIHdlIGhhdmUgdGhlbiB0aHJvdyBpdCBhd2F5XG4gICAgICBpZiAoc3JjRGF0YSA9PT0gc2lnbmFsbGVyLmlkKSB7XG4gICAgICAgIHJldHVybiBjb25zb2xlLndhcm4oJ2dvdCBkYXRhIGZyb20gb3Vyc2VsZiwgZGlzY2FyZGluZycpO1xuICAgICAgfVxuXG4gICAgICAvLyBnZXQgdGhlIHNvdXJjZSBzdGF0ZVxuICAgICAgc3JjU3RhdGUgPSBzaWduYWxsZXIucGVlcnMuZ2V0KHNyY0RhdGEpIHx8IHNyY0RhdGE7XG5cbiAgICAgIC8vIGhhbmRsZSBjb21tYW5kc1xuICAgICAgaWYgKHBhcnRzWzBdLmNoYXJBdCgwKSA9PT0gJy8nKSB7XG4gICAgICAgIC8vIGxvb2sgZm9yIGEgaGFuZGxlciBmb3IgdGhlIG1lc3NhZ2UgdHlwZVxuICAgICAgICBoYW5kbGVyID0gaGFuZGxlcnNbcGFydHNbMF0uc2xpY2UoMSldO1xuXG4gICAgICAgIGlmICh0eXBlb2YgaGFuZGxlciA9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgaGFuZGxlcihcbiAgICAgICAgICAgIHBhcnRzLnNsaWNlKDIpLFxuICAgICAgICAgICAgcGFydHNbMF0uc2xpY2UoMSksXG4gICAgICAgICAgICBzcmNEYXRhLFxuICAgICAgICAgICAgc3JjU3RhdGUsXG4gICAgICAgICAgICBpc0RpcmVjdE1lc3NhZ2VcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIHNlbmRFdmVudChwYXJ0cywgc3JjU3RhdGUsIG9yaWdpbmFsRGF0YSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIG90aGVyd2lzZSwgZW1pdCBkYXRhXG4gICAgICBlbHNlIHtcbiAgICAgICAgc2lnbmFsbGVyKFxuICAgICAgICAgICdkYXRhJyxcbiAgICAgICAgICBwYXJ0cy5zbGljZSgwLCAxKS5jb25jYXQocGFydHMuc2xpY2UoMikpLFxuICAgICAgICAgIHNyY0RhdGEsXG4gICAgICAgICAgc3JjU3RhdGUsXG4gICAgICAgICAgaXNEaXJlY3RNZXNzYWdlXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9O1xufTtcbiIsInZhciBkZXRlY3QgPSByZXF1aXJlKCdydGMtY29yZS9kZXRlY3QnKTtcbnZhciBleHRlbmQgPSByZXF1aXJlKCdjb2cvZXh0ZW5kJyk7XG52YXIgZ2V0YWJsZSA9IHJlcXVpcmUoJ2NvZy9nZXRhYmxlJyk7XG52YXIgY3VpZCA9IHJlcXVpcmUoJ2N1aWQnKTtcbnZhciBtYnVzID0gcmVxdWlyZSgnbWJ1cycpO1xudmFyIHByZXBhcmUgPSByZXF1aXJlKCcuL3ByZXBhcmUnKTtcblxuLyoqXG4gICMjIGBzaWduYWxsZXIob3B0cywgYnVmZmVyTWVzc2FnZSkgPT4gbWJ1c2BcblxuICBDcmVhdGUgYSBiYXNlIGxldmVsIHNpZ25hbGxlciB3aGljaCBpcyBjYXBhYmxlIG9mIHByb2Nlc3NpbmdcbiAgbWVzc2FnZXMgZnJvbSBhbiBpbmNvbWluZyBzb3VyY2UuICBUaGUgc2lnbmFsbGVyIGlzIGNhcGFibGUgb2ZcbiAgc2VuZGluZyBtZXNzYWdlcyBvdXRib3VuZCB1c2luZyB0aGUgYGJ1ZmZlck1lc3NhZ2VgIGZ1bmN0aW9uXG4gIHRoYXQgaXMgc3VwcGxpZWQgdG8gdGhlIHNpZ25hbGxlci5cblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKG9wdHMsIGJ1ZmZlck1lc3NhZ2UpIHtcbiAgLy8gZ2V0IHRoZSBhdXRvcmVwbHkgc2V0dGluZ1xuICB2YXIgYXV0b3JlcGx5ID0gKG9wdHMgfHwge30pLmF1dG9yZXBseTtcblxuICAvLyBjcmVhdGUgdGhlIHNpZ25hbGxlciBtYnVzXG4gIHZhciBzaWduYWxsZXIgPSBtYnVzKCcnLCAob3B0cyB8fCB7fSkubG9nZ2VyKTtcblxuICAvLyBpbml0aWFsaXNlIHRoZSBwZWVyc1xuICB2YXIgcGVlcnMgPSBzaWduYWxsZXIucGVlcnMgPSBnZXRhYmxlKHt9KTtcblxuICAvLyBpbml0aWFsaXNlIHRoZSBzaWduYWxsZXIgYXR0cmlidXRlc1xuICB2YXIgYXR0cmlidXRlcyA9IHNpZ25hbGxlci5hdHRyaWJ1dGVzID0ge1xuICAgIGJyb3dzZXI6IGRldGVjdC5icm93c2VyLFxuICAgIGJyb3dzZXJWZXJzaW9uOiBkZXRlY3QuYnJvd3NlclZlcnNpb24sXG4gICAgYWdlbnQ6ICd1bmtub3duJ1xuICB9O1xuXG4gIGZ1bmN0aW9uIGNyZWF0ZVRvTWVzc2FnZShoZWFkZXIpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICB2YXIgYXJncyA9IGhlYWRlci5jb25jYXQoW10uc2xpY2UuY2FsbChhcmd1bWVudHMpKTtcblxuICAgICAgLy8gaW5qZWN0IHRoZSBzaWduYWxsZXIuaWRcbiAgICAgIGFyZ3Muc3BsaWNlKDMsIDAsIHNpZ25hbGxlci5pZCk7XG4gICAgICBidWZmZXJNZXNzYWdlKHByZXBhcmUoYXJncykpO1xuICAgIH1cbiAgfVxuXG4gIC8vIGluaXRpYWxpc2UgdGhlIHNpZ25hbGxlciBpZFxuICBzaWduYWxsZXIuaWQgPSAob3B0cyB8fCB7fSkuaWQgfHwgY3VpZCgpO1xuXG4gIC8qKlxuICAgICMjIyMgYGlzTWFzdGVyKHRhcmdldElkKSA9PiBCb29sZWFuYFxuXG4gICAgQSBzaW1wbGUgZnVuY3Rpb24gdGhhdCBpbmRpY2F0ZXMgd2hldGhlciB0aGUgbG9jYWwgc2lnbmFsbGVyIGlzIHRoZSBtYXN0ZXJcbiAgICBmb3IgaXQncyByZWxhdGlvbnNoaXAgd2l0aCBwZWVyIHNpZ25hbGxlciBpbmRpY2F0ZWQgYnkgYHRhcmdldElkYC4gIFJvbGVzXG4gICAgYXJlIGRldGVybWluZWQgYXQgdGhlIHBvaW50IGF0IHdoaWNoIHNpZ25hbGxpbmcgcGVlcnMgZGlzY292ZXIgZWFjaCBvdGhlcixcbiAgICBhbmQgYXJlIHNpbXBseSB3b3JrZWQgb3V0IGJ5IHdoaWNoZXZlciBwZWVyIGhhcyB0aGUgbG93ZXN0IHNpZ25hbGxlciBpZFxuICAgIHdoZW4gbGV4aWdyYXBoaWNhbGx5IHNvcnRlZC5cblxuICAgIEZvciBleGFtcGxlLCBpZiB3ZSBoYXZlIHR3byBzaWduYWxsZXIgcGVlcnMgdGhhdCBoYXZlIGRpc2NvdmVyZWQgZWFjaFxuICAgIG90aGVycyB3aXRoIHRoZSBmb2xsb3dpbmcgaWRzOlxuXG4gICAgLSBgYjExZjRmZDAtZmViNS00NDdjLTgwYzgtYzUxZDhjM2NjZWQyYFxuICAgIC0gYDhhMDdmODJlLTQ5YTUtNGI5Yi1hMDJlLTQzZDkxMTM4MmJlNmBcblxuICAgIFRoZXkgd291bGQgYmUgYXNzaWduZWQgcm9sZXM6XG5cbiAgICAtIGBiMTFmNGZkMC1mZWI1LTQ0N2MtODBjOC1jNTFkOGMzY2NlZDJgXG4gICAgLSBgOGEwN2Y4MmUtNDlhNS00YjliLWEwMmUtNDNkOTExMzgyYmU2YCAobWFzdGVyKVxuXG4gICoqL1xuICBzaWduYWxsZXIuaXNNYXN0ZXIgPSBmdW5jdGlvbih0YXJnZXRJZCkge1xuICAgIHZhciBwZWVyID0gcGVlcnMuZ2V0KHRhcmdldElkKTtcblxuICAgIHJldHVybiBwZWVyICYmIHBlZXIucm9sZUlkeCAhPT0gMDtcbiAgfTtcblxuICAvKipcbiAgICAjIyMjIGBzZW5kKGFyZ3MqKWBcblxuICAgIFByZXBhcmUgYSBtZXNzYWdlIGZvciBzZW5kaW5nLCBlLmcuOlxuXG4gICAgYGBganNcbiAgICBzaWduYWxsZXIuc2VuZCgnL2ZvbycsICdiYXInKTtcbiAgICBgYGBcblxuICAqKi9cbiAgc2lnbmFsbGVyLnNlbmQgPSBmdW5jdGlvbigpIHtcbiAgICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKTtcblxuICAgIC8vIGluamVjdCB0aGUgbWV0YWRhdGFcbiAgICBhcmdzLnNwbGljZSgxLCAwLCBzaWduYWxsZXIuaWQpO1xuXG4gICAgLy8gc2VuZCB0aGUgbWVzc2FnZVxuICAgIGJ1ZmZlck1lc3NhZ2UocHJlcGFyZShhcmdzKSk7XG4gIH07XG5cblxuICAvKipcbiAgICAjIyMjIGB0byh0YXJnZXRJZClgXG5cbiAgICBVc2UgdGhlIGB0b2AgZnVuY3Rpb24gdG8gc2VuZCBhIG1lc3NhZ2UgdG8gdGhlIHNwZWNpZmllZCB0YXJnZXQgcGVlci5cbiAgICBBIGxhcmdlIHBhcmdlIG9mIG5lZ290aWF0aW5nIGEgV2ViUlRDIHBlZXIgY29ubmVjdGlvbiBpbnZvbHZlcyBkaXJlY3RcbiAgICBjb21tdW5pY2F0aW9uIGJldHdlZW4gdHdvIHBhcnRpZXMgd2hpY2ggbXVzdCBiZSBkb25lIGJ5IHRoZSBzaWduYWxsaW5nXG4gICAgc2VydmVyLiAgVGhlIGB0b2AgZnVuY3Rpb24gcHJvdmlkZXMgYSBzaW1wbGUgd2F5IHRvIHByb3ZpZGUgYSBsb2dpY2FsXG4gICAgY29tbXVuaWNhdGlvbiBjaGFubmVsIGJldHdlZW4gdGhlIHR3byBwYXJ0aWVzOlxuXG4gICAgYGBganNcbiAgICB2YXIgc2VuZCA9IHNpZ25hbGxlci50bygnZTk1ZmEwNWItOTA2Mi00NWM2LWJmYTItNTA1NWJmNjYyNWY0Jykuc2VuZDtcblxuICAgIC8vIGNyZWF0ZSBhbiBvZmZlciBvbiBhIGxvY2FsIHBlZXIgY29ubmVjdGlvblxuICAgIHBjLmNyZWF0ZU9mZmVyKFxuICAgICAgZnVuY3Rpb24oZGVzYykge1xuICAgICAgICAvLyBzZXQgdGhlIGxvY2FsIGRlc2NyaXB0aW9uIHVzaW5nIHRoZSBvZmZlciBzZHBcbiAgICAgICAgLy8gaWYgdGhpcyBvY2N1cnMgc3VjY2Vzc2Z1bGx5IHNlbmQgdGhpcyB0byBvdXIgcGVlclxuICAgICAgICBwYy5zZXRMb2NhbERlc2NyaXB0aW9uKFxuICAgICAgICAgIGRlc2MsXG4gICAgICAgICAgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICBzZW5kKCcvc2RwJywgZGVzYyk7XG4gICAgICAgICAgfSxcbiAgICAgICAgICBoYW5kbGVGYWlsXG4gICAgICAgICk7XG4gICAgICB9LFxuICAgICAgaGFuZGxlRmFpbFxuICAgICk7XG4gICAgYGBgXG5cbiAgKiovXG4gIHNpZ25hbGxlci50byA9IGZ1bmN0aW9uKHRhcmdldElkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNlbmQ6IGNyZWF0ZVRvTWVzc2FnZShbJy90bycsIHRhcmdldElkXSlcbiAgICB9O1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyBTaWduYWxsZXIgSW50ZXJuYWxzXG5cbiAgICBUaGUgZm9sbG93aW5nIGZ1bmN0aW9ucyBhcmUgZGVzaWduZWQgZm9yIHVzZSBieSBzaWduYWxsZXJzIHRoYXQgYXJlIGJ1aWx0XG4gICAgb24gdG9wIG9mIHRoaXMgYmFzZSBzaWduYWxsZXIuXG4gICoqL1xuXG4gIC8qKlxuICAgICMjIyMgYF9hbm5vdW5jZSgpYFxuXG4gICAgVGhlIGludGVybmFsIGZ1bmN0aW9uIHRoYXQgY29uc3RydWN0cyB0aGUgYC9hbm5vdW5jZWAgbWVzc2FnZSBhbmQgdHJpZ2dlcnNcbiAgICB0aGUgYGxvY2FsOmFubm91bmNlYCBldmVudC5cblxuICAqKi9cbiAgc2lnbmFsbGVyLl9hbm5vdW5jZSA9IGZ1bmN0aW9uKCkge1xuICAgIHNpZ25hbGxlci5zZW5kKCcvYW5ub3VuY2UnLCBhdHRyaWJ1dGVzKTtcbiAgICBzaWduYWxsZXIoJ2xvY2FsOmFubm91bmNlJywgYXR0cmlidXRlcyk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyBgX3Byb2Nlc3MoZGF0YSlgXG5cblxuICAqKi9cbiAgc2lnbmFsbGVyLl9wcm9jZXNzID0gcmVxdWlyZSgnLi9wcm9jZXNzJykoc2lnbmFsbGVyKTtcblxuICAvKipcbiAgICAjIyMjIGBfdXBkYXRlYFxuXG4gICAgSW50ZXJuYWwgZnVuY3Rpb24gdGhhdCB1cGRhdGVzIGNvcmUgYW5ub3VuY2UgYXR0cmlidXRlcyB3aXRoXG4gICAgdXBkYXRlZCBkYXRhLlxuXG4qKi9cbiAgc2lnbmFsbGVyLl91cGRhdGUgPSBmdW5jdGlvbihkYXRhKSB7XG4gICAgZXh0ZW5kKGF0dHJpYnV0ZXMsIGRhdGEsIHsgaWQ6IHNpZ25hbGxlci5pZCB9KTtcbiAgfTtcblxuICAvLyBzZXQgdGhlIGF1dG9yZXBseSBmbGFnXG4gIHNpZ25hbGxlci5hdXRvcmVwbHkgPSBhdXRvcmVwbHkgPT09IHVuZGVmaW5lZCB8fCBhdXRvcmVwbHk7XG5cbiAgcmV0dXJuIHNpZ25hbGxlcjtcbn07XG4iLCJ2YXIgZXh0ZW5kID0gcmVxdWlyZSgnY29nL2V4dGVuZCcpO1xuXG4vKipcbiAgIyBydGMtc3dpdGNoYm9hcmQtbWVzc2VuZ2VyXG5cbiAgQSBzcGVjaWFsaXNlZCB2ZXJzaW9uIG9mXG4gIFtgbWVzc2VuZ2VyLXdzYF0oaHR0cHM6Ly9naXRodWIuY29tL0RhbW9uT2VobG1hbi9tZXNzZW5nZXItd3MpIGRlc2lnbmVkIHRvXG4gIGNvbm5lY3QgdG8gW2BydGMtc3dpdGNoYm9hcmRgXShodHRwOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLXN3aXRjaGJvYXJkKVxuICBpbnN0YW5jZXMuXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihzd2l0Y2hib2FyZCwgb3B0cykge1xuICByZXR1cm4gcmVxdWlyZSgnbWVzc2VuZ2VyLXdzJykoc3dpdGNoYm9hcmQsIGV4dGVuZCh7XG4gICAgZW5kcG9pbnRzOiAob3B0cyB8fCB7fSkuZW5kcG9pbnRzIHx8IFsnLyddXG4gIH0sIG9wdHMpKTtcbn07XG4iLCJ2YXIgV2ViU29ja2V0ID0gcmVxdWlyZSgnd3MnKTtcbnZhciB3c3VybCA9IHJlcXVpcmUoJ3dzdXJsJyk7XG52YXIgcHMgPSByZXF1aXJlKCdwdWxsLXdzJyk7XG52YXIgZGVmYXVsdHMgPSByZXF1aXJlKCdjb2cvZGVmYXVsdHMnKTtcbnZhciByZVRyYWlsaW5nU2xhc2ggPSAvXFwvJC87XG52YXIgREVGQVVMVF9GQUlMQ09ERVMgPSBbXTtcblxuLyoqXG4gICMgbWVzc2VuZ2VyLXdzXG5cbiAgVGhpcyBpcyBhIHNpbXBsZSBtZXNzYWdpbmcgaW1wbGVtZW50YXRpb24gZm9yIHNlbmRpbmcgYW5kIHJlY2VpdmluZyBkYXRhXG4gIHZpYSB3ZWJzb2NrZXRzLlxuXG4gIEZvbGxvd3MgdGhlIFttZXNzZW5nZXItYXJjaGV0eXBlXShodHRwczovL2dpdGh1Yi5jb20vRGFtb25PZWhsbWFuL21lc3Nlbmdlci1hcmNoZXR5cGUpXG5cbiAgIyMgRXhhbXBsZSBVc2FnZVxuXG4gIDw8PCBleGFtcGxlcy9zaW1wbGUuanNcblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHVybCwgb3B0cykge1xuICB2YXIgdGltZW91dCA9IChvcHRzIHx8IHt9KS50aW1lb3V0IHx8IDEwMDA7XG4gIHZhciBmYWlsY29kZXMgPSAob3B0cyB8fCB7fSkuZmFpbGNvZGVzIHx8IERFRkFVTFRfRkFJTENPREVTO1xuICB2YXIgZW5kcG9pbnRzID0gKChvcHRzIHx8IHt9KS5lbmRwb2ludHMgfHwgWycvJ10pLm1hcChmdW5jdGlvbihlbmRwb2ludCkge1xuICAgIHJldHVybiB1cmwucmVwbGFjZShyZVRyYWlsaW5nU2xhc2gsICcnKSArIGVuZHBvaW50O1xuICB9KTtcblxuICBmdW5jdGlvbiBjb25uZWN0KGNhbGxiYWNrKSB7XG4gICAgdmFyIHF1ZXVlID0gW10uY29uY2F0KGVuZHBvaW50cyk7XG4gICAgdmFyIGlzQ29ubmVjdGVkID0gZmFsc2U7XG4gICAgdmFyIHNvY2tldDtcbiAgICB2YXIgZmFpbFRpbWVyO1xuICAgIHZhciBzdWNjZXNzVGltZXI7XG4gICAgdmFyIHJlbW92ZUxpc3RlbmVyO1xuICAgIHZhciBzb3VyY2U7XG5cbiAgICBmdW5jdGlvbiBhdHRlbXB0TmV4dCgpIHtcbiAgICAgIC8vIGlmIHdlIGhhdmUgYWxyZWFkeSBjb25uZWN0ZWQsIGRvIG5vdGhpbmdcbiAgICAgIC8vIE5PVEU6IHdvcmthcm91bmQgZm9yIHdlYnNvY2tldHMvd3MjNDg5XG4gICAgICBpZiAoaXNDb25uZWN0ZWQpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICAvLyBpZiB3ZSBoYXZlIG5vIG1vcmUgdmFsaWQgZW5kcG9pbnRzLCB0aGVuIGVyb3JyIG91dFxuICAgICAgaWYgKHF1ZXVlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICByZXR1cm4gY2FsbGJhY2sobmV3IEVycm9yKCdVbmFibGUgdG8gY29ubmVjdCB0byB1cmw6ICcgKyB1cmwpKTtcbiAgICAgIH1cblxuICAgICAgc29ja2V0ID0gbmV3IFdlYlNvY2tldCh3c3VybChxdWV1ZS5zaGlmdCgpKSk7XG4gICAgICBzb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignbWVzc2FnZScsIGNvbm5lY3QpO1xuICAgICAgc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgaGFuZGxlRXJyb3IpO1xuICAgICAgc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2Nsb3NlJywgaGFuZGxlQ2xvc2UpO1xuICAgICAgc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ29wZW4nLCBoYW5kbGVPcGVuKTtcblxuICAgICAgcmVtb3ZlTGlzdGVuZXIgPSBzb2NrZXQucmVtb3ZlRXZlbnRMaXN0ZW5lciB8fCBzb2NrZXQucmVtb3ZlTGlzdGVuZXI7XG4gICAgICBmYWlsVGltZXIgPSBzZXRUaW1lb3V0KGF0dGVtcHROZXh0LCB0aW1lb3V0KTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBjb25uZWN0KCkge1xuICAgICAgLy8gaWYgd2UgYXJlIGFscmVhZHkgY29ubmVjdGVkLCBhYm9ydFxuICAgICAgLy8gTk9URTogd29ya2Fyb3VuZCBmb3Igd2Vic29ja2V0cy93cyM0ODlcbiAgICAgIGlmIChpc0Nvbm5lY3RlZCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIC8vIGNsZWFyIGFueSBtb25pdG9yc1xuICAgICAgY2xlYXJUaW1lb3V0KGZhaWxUaW1lcik7XG4gICAgICBjbGVhclRpbWVvdXQoc3VjY2Vzc1RpbWVyKTtcblxuICAgICAgLy8gcmVtb3ZlIHRoZSBjbG9zZSBhbmQgZXJyb3IgbGlzdGVuZXJzIGFzIG1lc3Nlbmdlci13cyBoYXMgZG9uZVxuICAgICAgLy8gd2hhdCBpdCBzZXQgb3V0IHRvIGRvIGFuZCB0aGF0IGlzIGNyZWF0ZSBhIGNvbm5lY3Rpb25cbiAgICAgIC8vIE5PVEU6IGlzc3VlIHdlYnNvY2tldHMvd3MjNDg5IGNhdXNlcyBtZWFucyB0aGlzIGZhaWxzIGluIHdzXG4gICAgICByZW1vdmVMaXN0ZW5lci5jYWxsKHNvY2tldCwgJ29wZW4nLCBoYW5kbGVPcGVuKTtcbiAgICAgIHJlbW92ZUxpc3RlbmVyLmNhbGwoc29ja2V0LCAnY2xvc2UnLCBoYW5kbGVDbG9zZSk7XG4gICAgICByZW1vdmVMaXN0ZW5lci5jYWxsKHNvY2tldCwgJ2Vycm9yJywgaGFuZGxlRXJyb3IpO1xuICAgICAgcmVtb3ZlTGlzdGVuZXIuY2FsbChzb2NrZXQsICdtZXNzYWdlJywgY29ubmVjdCk7XG5cbiAgICAgIC8vIHRyaWdnZXIgdGhlIGNhbGxiYWNrXG4gICAgICBpc0Nvbm5lY3RlZCA9IHRydWU7XG4gICAgICBjYWxsYmFjayhudWxsLCBzb3VyY2UsIHBzLnNpbmsoc29ja2V0LCBvcHRzKSk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gaGFuZGxlQ2xvc2UoZXZ0KSB7XG4gICAgICB2YXIgY2xlYW4gPSBldnQud2FzQ2xlYW4gJiYgKFxuICAgICAgICBldnQuY29kZSA9PT0gdW5kZWZpbmVkIHx8IGZhaWxjb2Rlcy5pbmRleE9mKGV2dC5jb2RlKSA8IDBcbiAgICAgICk7XG5cbiAgICAgIC8vIGlmIHRoaXMgd2FzIG5vdCBhIGNsZWFuIGNsb3NlLCB0aGVuIGhhbmRsZSBlcnJvclxuICAgICAgaWYgKCEgY2xlYW4pIHtcbiAgICAgICAgcmV0dXJuIGhhbmRsZUVycm9yKCk7XG4gICAgICB9XG5cbiAgICAgIGNsZWFyVGltZW91dChzdWNjZXNzVGltZXIpO1xuICAgICAgY2xlYXJUaW1lb3V0KGZhaWxUaW1lcik7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gaGFuZGxlRXJyb3IoKSB7XG4gICAgICBjbGVhclRpbWVvdXQoc3VjY2Vzc1RpbWVyKTtcbiAgICAgIGNsZWFyVGltZW91dChmYWlsVGltZXIpO1xuICAgICAgYXR0ZW1wdE5leHQoKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBoYW5kbGVPcGVuKCkge1xuICAgICAgLy8gY3JlYXRlIHRoZSBzb3VyY2UgaW1tZWRpYXRlbHkgdG8gYnVmZmVyIGFueSBkYXRhXG4gICAgICBzb3VyY2UgPSBwcy5zb3VyY2Uoc29ja2V0LCBvcHRzKTtcblxuICAgICAgLy8gbW9uaXRvciBkYXRhIGZsb3dpbmcgZnJvbSB0aGUgc29ja2V0XG4gICAgICBzdWNjZXNzVGltZXIgPSBzZXRUaW1lb3V0KGNvbm5lY3QsIDEwMCk7XG4gICAgfVxuXG4gICAgYXR0ZW1wdE5leHQoKTtcbiAgfVxuXG4gIHJldHVybiBjb25uZWN0O1xufTtcbiIsImV4cG9ydHMgPSBtb2R1bGUuZXhwb3J0cyA9IGR1cGxleDtcblxuZXhwb3J0cy5zb3VyY2UgPSByZXF1aXJlKCcuL3NvdXJjZScpO1xuZXhwb3J0cy5zaW5rID0gcmVxdWlyZSgnLi9zaW5rJyk7XG5cbmZ1bmN0aW9uIGR1cGxleCAod3MsIG9wdHMpIHtcbiAgcmV0dXJuIHtcbiAgICBzb3VyY2U6IGV4cG9ydHMuc291cmNlKHdzKSxcbiAgICBzaW5rOiBleHBvcnRzLnNpbmsod3MsIG9wdHMpXG4gIH07XG59O1xuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihzb2NrZXQsIGNhbGxiYWNrKSB7XG4gIHZhciByZW1vdmUgPSBzb2NrZXQgJiYgKHNvY2tldC5yZW1vdmVFdmVudExpc3RlbmVyIHx8IHNvY2tldC5yZW1vdmVMaXN0ZW5lcik7XG5cbiAgZnVuY3Rpb24gY2xlYW51cCAoKSB7XG4gICAgaWYgKHR5cGVvZiByZW1vdmUgPT0gJ2Z1bmN0aW9uJykge1xuICAgICAgcmVtb3ZlLmNhbGwoc29ja2V0LCAnb3BlbicsIGhhbmRsZU9wZW4pO1xuICAgICAgcmVtb3ZlLmNhbGwoc29ja2V0LCAnZXJyb3InLCBoYW5kbGVFcnIpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZU9wZW4oZXZ0KSB7XG4gICAgY2xlYW51cCgpOyBjYWxsYmFjaygpO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlRXJyIChldnQpIHtcbiAgICBjbGVhbnVwKCk7IGNhbGxiYWNrKGV2dCk7XG4gIH1cblxuICAvLyBpZiB0aGUgc29ja2V0IGlzIGNsb3Npbmcgb3IgY2xvc2VkLCByZXR1cm4gZW5kXG4gIGlmIChzb2NrZXQucmVhZHlTdGF0ZSA+PSAyKSB7XG4gICAgcmV0dXJuIGNhbGxiYWNrKHRydWUpO1xuICB9XG5cbiAgLy8gaWYgb3BlbiwgdHJpZ2dlciB0aGUgY2FsbGJhY2tcbiAgaWYgKHNvY2tldC5yZWFkeVN0YXRlID09PSAxKSB7XG4gICAgcmV0dXJuIGNhbGxiYWNrKCk7XG4gIH1cblxuICBzb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignb3BlbicsIGhhbmRsZU9wZW4pO1xuICBzb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignZXJyb3InLCBoYW5kbGVFcnIpO1xufTtcbiIsInZhciBwdWxsID0gcmVxdWlyZSgncHVsbC1jb3JlJyk7XG52YXIgcmVhZHkgPSByZXF1aXJlKCcuL3JlYWR5Jyk7XG5cbi8qKlxuICAjIyMgYHNpbmsoc29ja2V0LCBvcHRzPylgXG5cbiAgQ3JlYXRlIGEgcHVsbC1zdHJlYW0gYFNpbmtgIHRoYXQgd2lsbCB3cml0ZSBkYXRhIHRvIHRoZSBgc29ja2V0YC5cblxuICA8PDwgZXhhbXBsZXMvd3JpdGUuanNcblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IHB1bGwuU2luayhmdW5jdGlvbihyZWFkLCBzb2NrZXQsIG9wdHMpIHtcbiAgb3B0cyA9IG9wdHMgfHwge31cbiAgdmFyIGNsb3NlT25FbmQgPSBvcHRzLmNsb3NlT25FbmQgIT09IGZhbHNlO1xuICB2YXIgb25DbG9zZSA9ICdmdW5jdGlvbicgPT09IHR5cGVvZiBvcHRzID8gb3B0cyA6IG9wdHMub25DbG9zZTtcblxuICBmdW5jdGlvbiBuZXh0KGVuZCwgZGF0YSkge1xuICAgIC8vIGlmIHRoZSBzdHJlYW0gaGFzIGVuZGVkLCBzaW1wbHkgcmV0dXJuXG4gICAgaWYgKGVuZCkge1xuICAgICAgaWYgKGNsb3NlT25FbmQgJiYgc29ja2V0LnJlYWR5U3RhdGUgPD0gMSkge1xuICAgICAgICBpZihvbkNsb3NlKVxuICAgICAgICAgIHNvY2tldC5hZGRFdmVudExpc3RlbmVyKCdjbG9zZScsIGZ1bmN0aW9uIChldikge1xuICAgICAgICAgICAgaWYoZXYud2FzQ2xlYW4pIG9uQ2xvc2UoKVxuICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgIHZhciBlcnIgPSBuZXcgRXJyb3IoJ3dzIGVycm9yJylcbiAgICAgICAgICAgICAgZXJyLmV2ZW50ID0gZXZcbiAgICAgICAgICAgICAgb25DbG9zZShlcnIpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgc29ja2V0LmNsb3NlKCk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBzb2NrZXQgcmVhZHk/XG4gICAgcmVhZHkoc29ja2V0LCBmdW5jdGlvbihlbmQpIHtcbiAgICAgIGlmIChlbmQpIHtcbiAgICAgICAgcmV0dXJuIHJlYWQoZW5kLCBmdW5jdGlvbiAoKSB7fSk7XG4gICAgICB9XG5cbiAgICAgIHNvY2tldC5zZW5kKGRhdGEpO1xuICAgICAgcHJvY2Vzcy5uZXh0VGljayhmdW5jdGlvbigpIHtcbiAgICAgICAgcmVhZChudWxsLCBuZXh0KTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgcmVhZChudWxsLCBuZXh0KTtcbn0pO1xuIiwidmFyIHB1bGwgPSByZXF1aXJlKCdwdWxsLWNvcmUnKTtcbnZhciByZWFkeSA9IHJlcXVpcmUoJy4vcmVhZHknKTtcblxuLyoqXG4gICMjIyBgc291cmNlKHNvY2tldClgXG5cbiAgQ3JlYXRlIGEgcHVsbC1zdHJlYW0gYFNvdXJjZWAgdGhhdCB3aWxsIHJlYWQgZGF0YSBmcm9tIHRoZSBgc29ja2V0YC5cblxuICA8PDwgZXhhbXBsZXMvcmVhZC5qc1xuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gcHVsbC5Tb3VyY2UoZnVuY3Rpb24oc29ja2V0KSB7XG4gIHZhciBidWZmZXIgPSBbXTtcbiAgdmFyIHJlY2VpdmVyO1xuICB2YXIgZW5kZWQ7XG5cbiAgc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ21lc3NhZ2UnLCBmdW5jdGlvbihldnQpIHtcbiAgICBpZiAocmVjZWl2ZXIpIHtcbiAgICAgIHJldHVybiByZWNlaXZlcihudWxsLCBldnQuZGF0YSk7XG4gICAgfVxuXG4gICAgYnVmZmVyLnB1c2goZXZ0LmRhdGEpO1xuICB9KTtcblxuICBzb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignY2xvc2UnLCBmdW5jdGlvbihldnQpIHtcbiAgICBpZiAoZW5kZWQpIHJldHVybjtcbiAgICBpZiAocmVjZWl2ZXIpIHtcbiAgICAgIHJldHVybiByZWNlaXZlcihlbmRlZCA9IHRydWUpO1xuICAgIH1cbiAgfSk7XG5cbiAgc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgZnVuY3Rpb24gKGV2dCkge1xuICAgIGlmIChlbmRlZCkgcmV0dXJuO1xuICAgIGVuZGVkID0gZXZ0O1xuICAgIGlmIChyZWNlaXZlcikge1xuICAgICAgcmVjZWl2ZXIoZW5kZWQpO1xuICAgIH1cbiAgfSk7XG5cbiAgZnVuY3Rpb24gcmVhZChhYm9ydCwgY2IpIHtcbiAgICByZWNlaXZlciA9IG51bGw7XG5cbiAgICAvL2lmIHN0cmVhbSBoYXMgYWxyZWFkeSBlbmRlZC5cbiAgICBpZiAoZW5kZWQpXG4gICAgICByZXR1cm4gY2IoZW5kZWQpXG5cbiAgICAvLyBpZiBlbmRlZCwgYWJvcnRcbiAgICBpZiAoYWJvcnQpIHtcbiAgICAgIC8vdGhpcyB3aWxsIGNhbGxiYWNrIHdoZW4gc29ja2V0IGNsb3Nlc1xuICAgICAgcmVjZWl2ZXIgPSBjYlxuICAgICAgcmV0dXJuIHNvY2tldC5jbG9zZSgpXG4gICAgfVxuXG4gICAgcmVhZHkoc29ja2V0LCBmdW5jdGlvbihlbmQpIHtcbiAgICAgIGlmIChlbmQpIHtcbiAgICAgICAgcmV0dXJuIGNiKGVuZGVkID0gZW5kKTtcbiAgICAgIH1cblxuICAgICAgLy8gcmVhZCBmcm9tIHRoZSBzb2NrZXRcbiAgICAgIGlmIChlbmRlZCAmJiBlbmRlZCAhPT0gdHJ1ZSkge1xuICAgICAgICByZXR1cm4gY2IoZW5kZWQpO1xuICAgICAgfVxuICAgICAgZWxzZSBpZiAoYnVmZmVyLmxlbmd0aCA+IDApIHtcbiAgICAgICAgcmV0dXJuIGNiKG51bGwsIGJ1ZmZlci5zaGlmdCgpKTtcbiAgICAgIH1cbiAgICAgIGVsc2UgaWYgKGVuZGVkKSB7XG4gICAgICAgIHJldHVybiBjYih0cnVlKTtcbiAgICAgIH1cblxuICAgICAgcmVjZWl2ZXIgPSBjYjtcbiAgICB9KTtcbiAgfTtcblxuICByZXR1cm4gcmVhZDtcbn0pO1xuIiwiXG4vKipcbiAqIE1vZHVsZSBkZXBlbmRlbmNpZXMuXG4gKi9cblxudmFyIGdsb2JhbCA9IChmdW5jdGlvbigpIHsgcmV0dXJuIHRoaXM7IH0pKCk7XG5cbi8qKlxuICogV2ViU29ja2V0IGNvbnN0cnVjdG9yLlxuICovXG5cbnZhciBXZWJTb2NrZXQgPSBnbG9iYWwuV2ViU29ja2V0IHx8IGdsb2JhbC5Nb3pXZWJTb2NrZXQ7XG5cbi8qKlxuICogTW9kdWxlIGV4cG9ydHMuXG4gKi9cblxubW9kdWxlLmV4cG9ydHMgPSBXZWJTb2NrZXQgPyB3cyA6IG51bGw7XG5cbi8qKlxuICogV2ViU29ja2V0IGNvbnN0cnVjdG9yLlxuICpcbiAqIFRoZSB0aGlyZCBgb3B0c2Agb3B0aW9ucyBvYmplY3QgZ2V0cyBpZ25vcmVkIGluIHdlYiBicm93c2Vycywgc2luY2UgaXQnc1xuICogbm9uLXN0YW5kYXJkLCBhbmQgdGhyb3dzIGEgVHlwZUVycm9yIGlmIHBhc3NlZCB0byB0aGUgY29uc3RydWN0b3IuXG4gKiBTZWU6IGh0dHBzOi8vZ2l0aHViLmNvbS9laW5hcm9zL3dzL2lzc3Vlcy8yMjdcbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gdXJpXG4gKiBAcGFyYW0ge0FycmF5fSBwcm90b2NvbHMgKG9wdGlvbmFsKVxuICogQHBhcmFtIHtPYmplY3QpIG9wdHMgKG9wdGlvbmFsKVxuICogQGFwaSBwdWJsaWNcbiAqL1xuXG5mdW5jdGlvbiB3cyh1cmksIHByb3RvY29scywgb3B0cykge1xuICB2YXIgaW5zdGFuY2U7XG4gIGlmIChwcm90b2NvbHMpIHtcbiAgICBpbnN0YW5jZSA9IG5ldyBXZWJTb2NrZXQodXJpLCBwcm90b2NvbHMpO1xuICB9IGVsc2Uge1xuICAgIGluc3RhbmNlID0gbmV3IFdlYlNvY2tldCh1cmkpO1xuICB9XG4gIHJldHVybiBpbnN0YW5jZTtcbn1cblxuaWYgKFdlYlNvY2tldCkgd3MucHJvdG90eXBlID0gV2ViU29ja2V0LnByb3RvdHlwZTtcbiIsInZhciByZUh0dHBVcmwgPSAvXmh0dHAoLiopJC87XG5cbi8qKlxuICAjIHdzdXJsXG5cbiAgR2l2ZW4gYSB1cmwgKGluY2x1ZGluZyBwcm90b2NvbCByZWxhdGl2ZSB1cmxzIC0gaS5lLiBgLy9gKSwgZ2VuZXJhdGUgYW4gYXBwcm9wcmlhdGVcbiAgdXJsIGZvciBhIFdlYlNvY2tldCBlbmRwb2ludCAoYHdzYCBvciBgd3NzYCkuXG5cbiAgIyMgRXhhbXBsZSBVc2FnZVxuXG4gIDw8PCBleGFtcGxlcy9yZWxhdGl2ZS5qc1xuXG4qKi9cblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbih1cmwsIG9wdHMpIHtcbiAgdmFyIGN1cnJlbnQgPSAob3B0cyB8fCB7fSkuY3VycmVudCB8fCAodHlwZW9mIGxvY2F0aW9uICE9ICd1bmRlZmluZWQnICYmIGxvY2F0aW9uLmhyZWYpO1xuICB2YXIgY3VycmVudFByb3RvY29sID0gY3VycmVudCAmJiBjdXJyZW50LnNsaWNlKDAsIGN1cnJlbnQuaW5kZXhPZignOicpKTtcbiAgdmFyIGluc2VjdXJlID0gKG9wdHMgfHwge30pLmluc2VjdXJlO1xuICB2YXIgaXNSZWxhdGl2ZSA9IHVybC5zbGljZSgwLCAyKSA9PSAnLy8nO1xuICB2YXIgZm9yY2VXUyA9ICghIGN1cnJlbnRQcm90b2NvbCkgfHwgY3VycmVudFByb3RvY29sID09PSAnZmlsZTonO1xuXG4gIGlmIChpc1JlbGF0aXZlKSB7XG4gICAgcmV0dXJuIGZvcmNlV1MgP1xuICAgICAgKChpbnNlY3VyZSA/ICd3czonIDogJ3dzczonKSArIHVybCkgOlxuICAgICAgKGN1cnJlbnRQcm90b2NvbC5yZXBsYWNlKHJlSHR0cFVybCwgJ3dzJDEnKSArICc6JyArIHVybCk7XG4gIH1cblxuICByZXR1cm4gdXJsLnJlcGxhY2UocmVIdHRwVXJsLCAnd3MkMScpO1xufTtcbiIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbnZhciBkZWJ1ZyA9IHJlcXVpcmUoJ2NvZy9sb2dnZXInKSgncnRjL2NsZWFudXAnKTtcblxudmFyIENBTk5PVF9DTE9TRV9TVEFURVMgPSBbXG4gICdjbG9zZWQnXG5dO1xuXG52YXIgRVZFTlRTX0RFQ09VUExFX0JDID0gW1xuICAnYWRkc3RyZWFtJyxcbiAgJ2RhdGFjaGFubmVsJyxcbiAgJ2ljZWNhbmRpZGF0ZScsXG4gICduZWdvdGlhdGlvbm5lZWRlZCcsXG4gICdyZW1vdmVzdHJlYW0nLFxuICAnc2lnbmFsaW5nc3RhdGVjaGFuZ2UnXG5dO1xuXG52YXIgRVZFTlRTX0RFQ09VUExFX0FDID0gW1xuICAnaWNlY29ubmVjdGlvbnN0YXRlY2hhbmdlJ1xuXTtcblxuLyoqXG4gICMjIyBydGMtdG9vbHMvY2xlYW51cFxuXG4gIGBgYFxuICBjbGVhbnVwKHBjKVxuICBgYGBcblxuICBUaGUgYGNsZWFudXBgIGZ1bmN0aW9uIGlzIHVzZWQgdG8gZW5zdXJlIHRoYXQgYSBwZWVyIGNvbm5lY3Rpb24gaXMgcHJvcGVybHlcbiAgY2xvc2VkIGFuZCByZWFkeSB0byBiZSBjbGVhbmVkIHVwIGJ5IHRoZSBicm93c2VyLlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24ocGMpIHtcbiAgLy8gc2VlIGlmIHdlIGNhbiBjbG9zZSB0aGUgY29ubmVjdGlvblxuICB2YXIgY3VycmVudFN0YXRlID0gcGMuaWNlQ29ubmVjdGlvblN0YXRlO1xuICB2YXIgY2FuQ2xvc2UgPSBDQU5OT1RfQ0xPU0VfU1RBVEVTLmluZGV4T2YoY3VycmVudFN0YXRlKSA8IDA7XG5cbiAgZnVuY3Rpb24gZGVjb3VwbGUoZXZlbnRzKSB7XG4gICAgZXZlbnRzLmZvckVhY2goZnVuY3Rpb24oZXZ0TmFtZSkge1xuICAgICAgaWYgKHBjWydvbicgKyBldnROYW1lXSkge1xuICAgICAgICBwY1snb24nICsgZXZ0TmFtZV0gPSBudWxsO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgLy8gZGVjb3VwbGUgXCJiZWZvcmUgY2xvc2VcIiBldmVudHNcbiAgZGVjb3VwbGUoRVZFTlRTX0RFQ09VUExFX0JDKTtcblxuICBpZiAoY2FuQ2xvc2UpIHtcbiAgICBkZWJ1ZygnYXR0ZW1wdGluZyBjb25uZWN0aW9uIGNsb3NlLCBjdXJyZW50IHN0YXRlOiAnKyBwYy5pY2VDb25uZWN0aW9uU3RhdGUpO1xuICAgIHBjLmNsb3NlKCk7XG4gIH1cblxuICAvLyByZW1vdmUgdGhlIGV2ZW50IGxpc3RlbmVyc1xuICAvLyBhZnRlciBhIHNob3J0IGRlbGF5IGdpdmluZyB0aGUgY29ubmVjdGlvbiB0aW1lIHRvIHRyaWdnZXJcbiAgLy8gY2xvc2UgYW5kIGljZWNvbm5lY3Rpb25zdGF0ZWNoYW5nZSBldmVudHNcbiAgc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICBkZWNvdXBsZShFVkVOVFNfREVDT1VQTEVfQUMpO1xuICB9LCAxMDApO1xufTtcbiIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbnZhciBtYnVzID0gcmVxdWlyZSgnbWJ1cycpO1xudmFyIHF1ZXVlID0gcmVxdWlyZSgncnRjLXRhc2txdWV1ZScpO1xudmFyIGNsZWFudXAgPSByZXF1aXJlKCcuL2NsZWFudXAnKTtcbnZhciBtb25pdG9yID0gcmVxdWlyZSgnLi9tb25pdG9yJyk7XG52YXIgdGhyb3R0bGUgPSByZXF1aXJlKCdjb2cvdGhyb3R0bGUnKTtcbnZhciBwbHVjayA9IHJlcXVpcmUoJ3doaXNrL3BsdWNrJyk7XG52YXIgcGx1Y2tDYW5kaWRhdGUgPSBwbHVjaygnY2FuZGlkYXRlJywgJ3NkcE1pZCcsICdzZHBNTGluZUluZGV4Jyk7XG52YXIgQ0xPU0VEX1NUQVRFUyA9IFsgJ2Nsb3NlZCcsICdmYWlsZWQnIF07XG52YXIgQ0hFQ0tJTkdfU1RBVEVTID0gWyAnY2hlY2tpbmcnIF07XG5cbi8qKlxuICAjIyMgcnRjLXRvb2xzL2NvdXBsZVxuXG4gICMjIyMgY291cGxlKHBjLCB0YXJnZXRJZCwgc2lnbmFsbGVyLCBvcHRzPylcblxuICBDb3VwbGUgYSBXZWJSVEMgY29ubmVjdGlvbiB3aXRoIGFub3RoZXIgd2VicnRjIGNvbm5lY3Rpb24gaWRlbnRpZmllZCBieVxuICBgdGFyZ2V0SWRgIHZpYSB0aGUgc2lnbmFsbGVyLlxuXG4gIFRoZSBmb2xsb3dpbmcgb3B0aW9ucyBjYW4gYmUgcHJvdmlkZWQgaW4gdGhlIGBvcHRzYCBhcmd1bWVudDpcblxuICAtIGBzZHBmaWx0ZXJgIChkZWZhdWx0OiBudWxsKVxuXG4gICAgQSBzaW1wbGUgZnVuY3Rpb24gZm9yIGZpbHRlcmluZyBTRFAgYXMgcGFydCBvZiB0aGUgcGVlclxuICAgIGNvbm5lY3Rpb24gaGFuZHNoYWtlIChzZWUgdGhlIFVzaW5nIEZpbHRlcnMgZGV0YWlscyBiZWxvdykuXG5cbiAgIyMjIyMgRXhhbXBsZSBVc2FnZVxuXG4gIGBgYGpzXG4gIHZhciBjb3VwbGUgPSByZXF1aXJlKCdydGMvY291cGxlJyk7XG5cbiAgY291cGxlKHBjLCAnNTQ4Nzk5NjUtY2U0My00MjZlLWE4ZWYtMDlhYzFlMzlhMTZkJywgc2lnbmFsbGVyKTtcbiAgYGBgXG5cbiAgIyMjIyMgVXNpbmcgRmlsdGVyc1xuXG4gIEluIGNlcnRhaW4gaW5zdGFuY2VzIHlvdSBtYXkgd2lzaCB0byBtb2RpZnkgdGhlIHJhdyBTRFAgdGhhdCBpcyBwcm92aWRlZFxuICBieSB0aGUgYGNyZWF0ZU9mZmVyYCBhbmQgYGNyZWF0ZUFuc3dlcmAgY2FsbHMuICBUaGlzIGNhbiBiZSBkb25lIGJ5IHBhc3NpbmdcbiAgYSBgc2RwZmlsdGVyYCBmdW5jdGlvbiAob3IgYXJyYXkpIGluIHRoZSBvcHRpb25zLiAgRm9yIGV4YW1wbGU6XG5cbiAgYGBganNcbiAgLy8gcnVuIHRoZSBzZHAgZnJvbSB0aHJvdWdoIGEgbG9jYWwgdHdlYWtTZHAgZnVuY3Rpb24uXG4gIGNvdXBsZShwYywgJzU0ODc5OTY1LWNlNDMtNDI2ZS1hOGVmLTA5YWMxZTM5YTE2ZCcsIHNpZ25hbGxlciwge1xuICAgIHNkcGZpbHRlcjogdHdlYWtTZHBcbiAgfSk7XG4gIGBgYFxuXG4qKi9cbmZ1bmN0aW9uIGNvdXBsZShwYywgdGFyZ2V0SWQsIHNpZ25hbGxlciwgb3B0cykge1xuICB2YXIgZGVidWdMYWJlbCA9IChvcHRzIHx8IHt9KS5kZWJ1Z0xhYmVsIHx8ICdydGMnO1xuICB2YXIgZGVidWcgPSByZXF1aXJlKCdjb2cvbG9nZ2VyJykoZGVidWdMYWJlbCArICcvY291cGxlJyk7XG5cbiAgLy8gY3JlYXRlIGEgbW9uaXRvciBmb3IgdGhlIGNvbm5lY3Rpb25cbiAgdmFyIG1vbiA9IG1vbml0b3IocGMsIHRhcmdldElkLCBzaWduYWxsZXIsIChvcHRzIHx8IHt9KS5sb2dnZXIpO1xuICB2YXIgZW1pdCA9IG1idXMoJycsIG1vbik7XG4gIHZhciByZWFjdGl2ZSA9IChvcHRzIHx8IHt9KS5yZWFjdGl2ZTtcbiAgdmFyIGVuZE9mQ2FuZGlkYXRlcyA9IHRydWU7XG5cbiAgLy8gY29uZmlndXJlIHRoZSB0aW1lIHRvIHdhaXQgYmV0d2VlbiByZWNlaXZpbmcgYSAnZGlzY29ubmVjdCdcbiAgLy8gaWNlQ29ubmVjdGlvblN0YXRlIGFuZCBkZXRlcm1pbmluZyB0aGF0IHdlIGFyZSBjbG9zZWRcbiAgdmFyIGRpc2Nvbm5lY3RUaW1lb3V0ID0gKG9wdHMgfHwge30pLmRpc2Nvbm5lY3RUaW1lb3V0IHx8IDEwMDAwO1xuICB2YXIgZGlzY29ubmVjdFRpbWVyO1xuXG4gIC8vIGluaXRpbGFpc2UgdGhlIG5lZ290aWF0aW9uIGhlbHBlcnNcbiAgdmFyIGlzTWFzdGVyID0gc2lnbmFsbGVyLmlzTWFzdGVyKHRhcmdldElkKTtcblxuICAvLyBpbml0aWFsaXNlIHRoZSBwcm9jZXNzaW5nIHF1ZXVlIChvbmUgYXQgYSB0aW1lIHBsZWFzZSlcbiAgdmFyIHEgPSBxdWV1ZShwYywgb3B0cyk7XG5cbiAgdmFyIGNyZWF0ZU9yUmVxdWVzdE9mZmVyID0gdGhyb3R0bGUoZnVuY3Rpb24oKSB7XG4gICAgaWYgKCEgaXNNYXN0ZXIpIHtcbiAgICAgIHJldHVybiBzaWduYWxsZXIudG8odGFyZ2V0SWQpLnNlbmQoJy9uZWdvdGlhdGUnKTtcbiAgICB9XG5cbiAgICBxLmNyZWF0ZU9mZmVyKCk7XG4gIH0sIDEwMCwgeyBsZWFkaW5nOiBmYWxzZSB9KTtcblxuICB2YXIgZGVib3VuY2VPZmZlciA9IHRocm90dGxlKHEuY3JlYXRlT2ZmZXIsIDEwMCwgeyBsZWFkaW5nOiBmYWxzZSB9KTtcblxuICBmdW5jdGlvbiBkZWNvdXBsZSgpIHtcbiAgICBkZWJ1ZygnZGVjb3VwbGluZyAnICsgc2lnbmFsbGVyLmlkICsgJyBmcm9tICcgKyB0YXJnZXRJZCk7XG5cbiAgICAvLyBzdG9wIHRoZSBtb25pdG9yXG4vLyAgICAgbW9uLnJlbW92ZUFsbExpc3RlbmVycygpO1xuICAgIG1vbi5zdG9wKCk7XG5cbiAgICAvLyBjbGVhbnVwIHRoZSBwZWVyY29ubmVjdGlvblxuICAgIGNsZWFudXAocGMpO1xuXG4gICAgLy8gcmVtb3ZlIGxpc3RlbmVyc1xuICAgIHNpZ25hbGxlci5yZW1vdmVMaXN0ZW5lcignc2RwJywgaGFuZGxlU2RwKTtcbiAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ2NhbmRpZGF0ZScsIGhhbmRsZUNhbmRpZGF0ZSk7XG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCduZWdvdGlhdGUnLCBoYW5kbGVOZWdvdGlhdGVSZXF1ZXN0KTtcblxuICAgIC8vIHJlbW92ZSBsaXN0ZW5lcnMgKHZlcnNpb24gPj0gNSlcbiAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ21lc3NhZ2U6c2RwJywgaGFuZGxlU2RwKTtcbiAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ21lc3NhZ2U6Y2FuZGlkYXRlJywgaGFuZGxlQ2FuZGlkYXRlKTtcbiAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ21lc3NhZ2U6bmVnb3RpYXRlJywgaGFuZGxlTmVnb3RpYXRlUmVxdWVzdCk7XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVDYW5kaWRhdGUoZGF0YSkge1xuICAgIHEuYWRkSWNlQ2FuZGlkYXRlKGRhdGEpO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlU2RwKHNkcCwgc3JjKSB7XG4gICAgZW1pdCgnc2RwLnJlbW90ZScsIHNkcCk7XG5cbiAgICAvLyBpZiB0aGUgc291cmNlIGlzIHVua25vd24gb3Igbm90IGEgbWF0Y2gsIHRoZW4gZG9uJ3QgcHJvY2Vzc1xuICAgIGlmICgoISBzcmMpIHx8IChzcmMuaWQgIT09IHRhcmdldElkKSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHEuc2V0UmVtb3RlRGVzY3JpcHRpb24oc2RwKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZUNvbm5lY3Rpb25DbG9zZSgpIHtcbiAgICBkZWJ1ZygnY2FwdHVyZWQgcGMgY2xvc2UsIGljZUNvbm5lY3Rpb25TdGF0ZSA9ICcgKyBwYy5pY2VDb25uZWN0aW9uU3RhdGUpO1xuICAgIGRlY291cGxlKCk7XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVEaXNjb25uZWN0KCkge1xuICAgIGRlYnVnKCdjYXB0dXJlZCBwYyBkaXNjb25uZWN0LCBtb25pdG9yaW5nIGNvbm5lY3Rpb24gc3RhdHVzJyk7XG5cbiAgICAvLyBzdGFydCB0aGUgZGlzY29ubmVjdCB0aW1lclxuICAgIGRpc2Nvbm5lY3RUaW1lciA9IHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICBkZWJ1ZygnbWFudWFsbHkgY2xvc2luZyBjb25uZWN0aW9uIGFmdGVyIGRpc2Nvbm5lY3QgdGltZW91dCcpO1xuICAgICAgY2xlYW51cChwYyk7XG4gICAgfSwgZGlzY29ubmVjdFRpbWVvdXQpO1xuXG4gICAgbW9uLm9uKCdzdGF0ZWNoYW5nZScsIGhhbmRsZURpc2Nvbm5lY3RBYm9ydCk7XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVEaXNjb25uZWN0QWJvcnQoKSB7XG4gICAgZGVidWcoJ2Nvbm5lY3Rpb24gc3RhdGUgY2hhbmdlZCB0bzogJyArIHBjLmljZUNvbm5lY3Rpb25TdGF0ZSk7XG5cbiAgICAvLyBpZiB0aGUgc3RhdGUgaXMgY2hlY2tpbmcsIHRoZW4gZG8gbm90IHJlc2V0IHRoZSBkaXNjb25uZWN0IHRpbWVyIGFzXG4gICAgLy8gd2UgYXJlIGRvaW5nIG91ciBvd24gY2hlY2tpbmdcbiAgICBpZiAoQ0hFQ0tJTkdfU1RBVEVTLmluZGV4T2YocGMuaWNlQ29ubmVjdGlvblN0YXRlKSA+PSAwKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgcmVzZXREaXNjb25uZWN0VGltZXIoKTtcblxuICAgIC8vIGlmIHdlIGhhdmUgYSBjbG9zZWQgb3IgZmFpbGVkIHN0YXR1cywgdGhlbiBjbG9zZSB0aGUgY29ubmVjdGlvblxuICAgIGlmIChDTE9TRURfU1RBVEVTLmluZGV4T2YocGMuaWNlQ29ubmVjdGlvblN0YXRlKSA+PSAwKSB7XG4gICAgICByZXR1cm4gbW9uKCdjbG9zZWQnKTtcbiAgICB9XG5cbiAgICBtb24ub25jZSgnZGlzY29ubmVjdCcsIGhhbmRsZURpc2Nvbm5lY3QpO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlTG9jYWxDYW5kaWRhdGUoZXZ0KSB7XG4gICAgdmFyIGRhdGEgPSBldnQuY2FuZGlkYXRlICYmIHBsdWNrQ2FuZGlkYXRlKGV2dC5jYW5kaWRhdGUpO1xuXG4gICAgaWYgKGV2dC5jYW5kaWRhdGUpIHtcbiAgICAgIHJlc2V0RGlzY29ubmVjdFRpbWVyKCk7XG4gICAgICBlbWl0KCdpY2UubG9jYWwnLCBkYXRhKTtcbiAgICAgIHNpZ25hbGxlci50byh0YXJnZXRJZCkuc2VuZCgnL2NhbmRpZGF0ZScsIGRhdGEpO1xuICAgICAgZW5kT2ZDYW5kaWRhdGVzID0gZmFsc2U7XG4gICAgfVxuICAgIGVsc2UgaWYgKCEgZW5kT2ZDYW5kaWRhdGVzKSB7XG4gICAgICBlbmRPZkNhbmRpZGF0ZXMgPSB0cnVlO1xuICAgICAgZW1pdCgnaWNlLmdhdGhlcmNvbXBsZXRlJyk7XG4gICAgICBzaWduYWxsZXIudG8odGFyZ2V0SWQpLnNlbmQoJy9lbmRvZmNhbmRpZGF0ZXMnLCB7fSk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlTmVnb3RpYXRlUmVxdWVzdChzcmMpIHtcbiAgICBpZiAoc3JjLmlkID09PSB0YXJnZXRJZCkge1xuICAgICAgZW1pdCgnbmVnb3RpYXRlLnJlcXVlc3QnLCBzcmMuaWQpO1xuICAgICAgZGVib3VuY2VPZmZlcigpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHJlc2V0RGlzY29ubmVjdFRpbWVyKCkge1xuICAgIG1vbi5vZmYoJ3N0YXRlY2hhbmdlJywgaGFuZGxlRGlzY29ubmVjdEFib3J0KTtcblxuICAgIC8vIGNsZWFyIHRoZSBkaXNjb25uZWN0IHRpbWVyXG4gICAgZGVidWcoJ3Jlc2V0IGRpc2Nvbm5lY3QgdGltZXIsIHN0YXRlOiAnICsgcGMuaWNlQ29ubmVjdGlvblN0YXRlKTtcbiAgICBjbGVhclRpbWVvdXQoZGlzY29ubmVjdFRpbWVyKTtcbiAgfVxuXG4gIC8vIHdoZW4gcmVnb3RpYXRpb24gaXMgbmVlZGVkIGxvb2sgZm9yIHRoZSBwZWVyXG4gIGlmIChyZWFjdGl2ZSkge1xuICAgIHBjLm9ubmVnb3RpYXRpb25uZWVkZWQgPSBmdW5jdGlvbigpIHtcbiAgICAgIGVtaXQoJ25lZ290aWF0ZS5yZW5lZ290aWF0ZScpO1xuICAgICAgY3JlYXRlT3JSZXF1ZXN0T2ZmZXIoKTtcbiAgICB9O1xuICB9XG5cbiAgcGMub25pY2VjYW5kaWRhdGUgPSBoYW5kbGVMb2NhbENhbmRpZGF0ZTtcblxuICAvLyB3aGVuIHRoZSB0YXNrIHF1ZXVlIHRlbGxzIHVzIHdlIGhhdmUgc2RwIGF2YWlsYWJsZSwgc2VuZCB0aGF0IG92ZXIgdGhlIHdpcmVcbiAgcS5vbignc2RwLmxvY2FsJywgZnVuY3Rpb24oZGVzYykge1xuICAgIHNpZ25hbGxlci50byh0YXJnZXRJZCkuc2VuZCgnL3NkcCcsIGRlc2MpO1xuICB9KTtcblxuICAvLyB3aGVuIHdlIHJlY2VpdmUgc2RwLCB0aGVuXG4gIHNpZ25hbGxlci5vbignc2RwJywgaGFuZGxlU2RwKTtcbiAgc2lnbmFsbGVyLm9uKCdjYW5kaWRhdGUnLCBoYW5kbGVDYW5kaWRhdGUpO1xuXG4gIC8vIGxpc3RlbmVycyAoc2lnbmFsbGVyID49IDUpXG4gIHNpZ25hbGxlci5vbignbWVzc2FnZTpzZHAnLCBoYW5kbGVTZHApO1xuICBzaWduYWxsZXIub24oJ21lc3NhZ2U6Y2FuZGlkYXRlJywgaGFuZGxlQ2FuZGlkYXRlKTtcblxuICAvLyBpZiB0aGlzIGlzIGEgbWFzdGVyIGNvbm5lY3Rpb24sIGxpc3RlbiBmb3IgbmVnb3RpYXRlIGV2ZW50c1xuICBpZiAoaXNNYXN0ZXIpIHtcbiAgICBzaWduYWxsZXIub24oJ25lZ290aWF0ZScsIGhhbmRsZU5lZ290aWF0ZVJlcXVlc3QpO1xuICAgIHNpZ25hbGxlci5vbignbWVzc2FnZTpuZWdvdGlhdGUnLCBoYW5kbGVOZWdvdGlhdGVSZXF1ZXN0KTsgLy8gc2lnbmFsbGVyID49IDVcbiAgfVxuXG4gIC8vIHdoZW4gdGhlIGNvbm5lY3Rpb24gY2xvc2VzLCByZW1vdmUgZXZlbnQgaGFuZGxlcnNcbiAgbW9uLm9uY2UoJ2Nsb3NlZCcsIGhhbmRsZUNvbm5lY3Rpb25DbG9zZSk7XG4gIG1vbi5vbmNlKCdkaXNjb25uZWN0ZWQnLCBoYW5kbGVEaXNjb25uZWN0KTtcblxuICAvLyBwYXRjaCBpbiB0aGUgY3JlYXRlIG9mZmVyIGZ1bmN0aW9uc1xuICBtb24uY3JlYXRlT2ZmZXIgPSBjcmVhdGVPclJlcXVlc3RPZmZlcjtcblxuICByZXR1cm4gbW9uO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGNvdXBsZTtcbiIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbi8qKlxuICAjIyMgcnRjLXRvb2xzL2RldGVjdFxuXG4gIFByb3ZpZGUgdGhlIFtydGMtY29yZS9kZXRlY3RdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLWNvcmUjZGV0ZWN0KVxuICBmdW5jdGlvbmFsaXR5LlxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IHJlcXVpcmUoJ3J0Yy1jb3JlL2RldGVjdCcpO1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIGRlYnVnID0gcmVxdWlyZSgnY29nL2xvZ2dlcicpKCdnZW5lcmF0b3JzJyk7XG52YXIgZGV0ZWN0ID0gcmVxdWlyZSgnLi9kZXRlY3QnKTtcbnZhciBkZWZhdWx0cyA9IHJlcXVpcmUoJ2NvZy9kZWZhdWx0cycpO1xuXG52YXIgbWFwcGluZ3MgPSB7XG4gIGNyZWF0ZToge1xuICAgIGR0bHM6IGZ1bmN0aW9uKGMpIHtcbiAgICAgIGlmICghIGRldGVjdC5tb3opIHtcbiAgICAgICAgYy5vcHRpb25hbCA9IChjLm9wdGlvbmFsIHx8IFtdKS5jb25jYXQoeyBEdGxzU3J0cEtleUFncmVlbWVudDogdHJ1ZSB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn07XG5cbi8qKlxuICAjIyMgcnRjLXRvb2xzL2dlbmVyYXRvcnNcblxuICBUaGUgZ2VuZXJhdG9ycyBwYWNrYWdlIHByb3ZpZGVzIHNvbWUgdXRpbGl0eSBtZXRob2RzIGZvciBnZW5lcmF0aW5nXG4gIGNvbnN0cmFpbnQgb2JqZWN0cyBhbmQgc2ltaWxhciBjb25zdHJ1Y3RzLlxuXG4gIGBgYGpzXG4gIHZhciBnZW5lcmF0b3JzID0gcmVxdWlyZSgncnRjL2dlbmVyYXRvcnMnKTtcbiAgYGBgXG5cbioqL1xuXG4vKipcbiAgIyMjIyBnZW5lcmF0b3JzLmNvbmZpZyhjb25maWcpXG5cbiAgR2VuZXJhdGUgYSBjb25maWd1cmF0aW9uIG9iamVjdCBzdWl0YWJsZSBmb3IgcGFzc2luZyBpbnRvIGFuIFczQ1xuICBSVENQZWVyQ29ubmVjdGlvbiBjb25zdHJ1Y3RvciBmaXJzdCBhcmd1bWVudCwgYmFzZWQgb24gb3VyIGN1c3RvbSBjb25maWcuXG5cbiAgSW4gdGhlIGV2ZW50IHRoYXQgeW91IHVzZSBzaG9ydCB0ZXJtIGF1dGhlbnRpY2F0aW9uIGZvciBUVVJOLCBhbmQgeW91IHdhbnRcbiAgdG8gZ2VuZXJhdGUgbmV3IGBpY2VTZXJ2ZXJzYCByZWd1bGFybHksIHlvdSBjYW4gc3BlY2lmeSBhbiBpY2VTZXJ2ZXJHZW5lcmF0b3JcbiAgdGhhdCB3aWxsIGJlIHVzZWQgcHJpb3IgdG8gY291cGxpbmcuIFRoaXMgZ2VuZXJhdG9yIHNob3VsZCByZXR1cm4gYSBmdWxseVxuICBjb21wbGlhbnQgVzNDIChSVENJY2VTZXJ2ZXIgZGljdGlvbmFyeSlbaHR0cDovL3d3dy53My5vcmcvVFIvd2VicnRjLyNpZGwtZGVmLVJUQ0ljZVNlcnZlcl0uXG5cbiAgSWYgeW91IHBhc3MgaW4gYm90aCBhIGdlbmVyYXRvciBhbmQgaWNlU2VydmVycywgdGhlIGljZVNlcnZlcnMgX3dpbGwgYmVcbiAgaWdub3JlZCBhbmQgdGhlIGdlbmVyYXRvciB1c2VkIGluc3RlYWQuXG4qKi9cblxuZXhwb3J0cy5jb25maWcgPSBmdW5jdGlvbihjb25maWcpIHtcbiAgdmFyIGljZVNlcnZlckdlbmVyYXRvciA9IChjb25maWcgfHwge30pLmljZVNlcnZlckdlbmVyYXRvcjtcblxuICByZXR1cm4gZGVmYXVsdHMoe30sIGNvbmZpZywge1xuICAgIGljZVNlcnZlcnM6IHR5cGVvZiBpY2VTZXJ2ZXJHZW5lcmF0b3IgPT0gJ2Z1bmN0aW9uJyA/IGljZVNlcnZlckdlbmVyYXRvcigpIDogW11cbiAgfSk7XG59O1xuXG4vKipcbiAgIyMjIyBnZW5lcmF0b3JzLmNvbm5lY3Rpb25Db25zdHJhaW50cyhmbGFncywgY29uc3RyYWludHMpXG5cbiAgVGhpcyBpcyBhIGhlbHBlciBmdW5jdGlvbiB0aGF0IHdpbGwgZ2VuZXJhdGUgYXBwcm9wcmlhdGUgY29ubmVjdGlvblxuICBjb25zdHJhaW50cyBmb3IgYSBuZXcgYFJUQ1BlZXJDb25uZWN0aW9uYCBvYmplY3Qgd2hpY2ggaXMgY29uc3RydWN0ZWRcbiAgaW4gdGhlIGZvbGxvd2luZyB3YXk6XG5cbiAgYGBganNcbiAgdmFyIGNvbm4gPSBuZXcgUlRDUGVlckNvbm5lY3Rpb24oZmxhZ3MsIGNvbnN0cmFpbnRzKTtcbiAgYGBgXG5cbiAgSW4gbW9zdCBjYXNlcyB0aGUgY29uc3RyYWludHMgb2JqZWN0IGNhbiBiZSBsZWZ0IGVtcHR5LCBidXQgd2hlbiBjcmVhdGluZ1xuICBkYXRhIGNoYW5uZWxzIHNvbWUgYWRkaXRpb25hbCBvcHRpb25zIGFyZSByZXF1aXJlZC4gIFRoaXMgZnVuY3Rpb25cbiAgY2FuIGdlbmVyYXRlIHRob3NlIGFkZGl0aW9uYWwgb3B0aW9ucyBhbmQgaW50ZWxsaWdlbnRseSBjb21iaW5lIGFueVxuICB1c2VyIGRlZmluZWQgY29uc3RyYWludHMgKGluIGBjb25zdHJhaW50c2ApIHdpdGggc2hvcnRoYW5kIGZsYWdzIHRoYXRcbiAgbWlnaHQgYmUgcGFzc2VkIHdoaWxlIHVzaW5nIHRoZSBgcnRjLmNyZWF0ZUNvbm5lY3Rpb25gIGhlbHBlci5cbioqL1xuZXhwb3J0cy5jb25uZWN0aW9uQ29uc3RyYWludHMgPSBmdW5jdGlvbihmbGFncywgY29uc3RyYWludHMpIHtcbiAgdmFyIGdlbmVyYXRlZCA9IHt9O1xuICB2YXIgbSA9IG1hcHBpbmdzLmNyZWF0ZTtcbiAgdmFyIG91dDtcblxuICAvLyBpdGVyYXRlIHRocm91Z2ggdGhlIGZsYWdzIGFuZCBhcHBseSB0aGUgY3JlYXRlIG1hcHBpbmdzXG4gIE9iamVjdC5rZXlzKGZsYWdzIHx8IHt9KS5mb3JFYWNoKGZ1bmN0aW9uKGtleSkge1xuICAgIGlmIChtW2tleV0pIHtcbiAgICAgIG1ba2V5XShnZW5lcmF0ZWQpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gZ2VuZXJhdGUgdGhlIGNvbm5lY3Rpb24gY29uc3RyYWludHNcbiAgb3V0ID0gZGVmYXVsdHMoe30sIGNvbnN0cmFpbnRzLCBnZW5lcmF0ZWQpO1xuICBkZWJ1ZygnZ2VuZXJhdGVkIGNvbm5lY3Rpb24gY29uc3RyYWludHM6ICcsIG91dCk7XG5cbiAgcmV0dXJuIG91dDtcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuXG4ndXNlIHN0cmljdCc7XG5cbi8qKlxuICAjIHJ0Yy10b29sc1xuXG4gIFRoZSBgcnRjLXRvb2xzYCBtb2R1bGUgZG9lcyBtb3N0IG9mIHRoZSBoZWF2eSBsaWZ0aW5nIHdpdGhpbiB0aGVcbiAgW3J0Yy5pb10oaHR0cDovL3J0Yy5pbykgc3VpdGUuICBQcmltYXJpbHkgaXQgaGFuZGxlcyB0aGUgbG9naWMgb2YgY291cGxpbmdcbiAgYSBsb2NhbCBgUlRDUGVlckNvbm5lY3Rpb25gIHdpdGggaXQncyByZW1vdGUgY291bnRlcnBhcnQgdmlhIGFuXG4gIFtydGMtc2lnbmFsbGVyXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0Yy1zaWduYWxsZXIpIHNpZ25hbGxpbmdcbiAgY2hhbm5lbC5cblxuICAjIyBHZXR0aW5nIFN0YXJ0ZWRcblxuICBJZiB5b3UgZGVjaWRlIHRoYXQgdGhlIGBydGMtdG9vbHNgIG1vZHVsZSBpcyBhIGJldHRlciBmaXQgZm9yIHlvdSB0aGFuIGVpdGhlclxuICBbcnRjLXF1aWNrY29ubmVjdF0oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMtcXVpY2tjb25uZWN0KSBvclxuICBbcnRjXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0YykgdGhlbiB0aGUgY29kZSBzbmlwcGV0IGJlbG93XG4gIHdpbGwgcHJvdmlkZSB5b3UgYSBndWlkZSBvbiBob3cgdG8gZ2V0IHN0YXJ0ZWQgdXNpbmcgaXQgaW4gY29uanVuY3Rpb24gd2l0aFxuICB0aGUgW3J0Yy1zaWduYWxsZXJdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLXNpZ25hbGxlcikgKHZlcnNpb24gNS4wIGFuZCBhYm92ZSlcbiAgYW5kIFtydGMtbWVkaWFdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLW1lZGlhKSBtb2R1bGVzOlxuXG4gIDw8PCBleGFtcGxlcy9nZXR0aW5nLXN0YXJ0ZWQuanNcblxuICBUaGlzIGNvZGUgZGVmaW5pdGVseSBkb2Vzbid0IGNvdmVyIGFsbCB0aGUgY2FzZXMgdGhhdCB5b3UgbmVlZCB0byBjb25zaWRlclxuICAoaS5lLiBwZWVycyBsZWF2aW5nLCBldGMpIGJ1dCBpdCBzaG91bGQgZGVtb25zdHJhdGUgaG93IHRvOlxuXG4gIDEuIENhcHR1cmUgdmlkZW8gYW5kIGFkZCBpdCB0byBhIHBlZXIgY29ubmVjdGlvblxuICAyLiBDb3VwbGUgYSBsb2NhbCBwZWVyIGNvbm5lY3Rpb24gd2l0aCBhIHJlbW90ZSBwZWVyIGNvbm5lY3Rpb25cbiAgMy4gRGVhbCB3aXRoIHRoZSByZW1vdGUgc3RlYW0gYmVpbmcgZGlzY292ZXJlZCBhbmQgaG93IHRvIHJlbmRlclxuICAgICB0aGF0IHRvIHRoZSBsb2NhbCBpbnRlcmZhY2UuXG5cbiAgIyMgUmVmZXJlbmNlXG5cbioqL1xuXG52YXIgZ2VuID0gcmVxdWlyZSgnLi9nZW5lcmF0b3JzJyk7XG5cbi8vIGV4cG9ydCBkZXRlY3RcbnZhciBkZXRlY3QgPSBleHBvcnRzLmRldGVjdCA9IHJlcXVpcmUoJy4vZGV0ZWN0Jyk7XG52YXIgZmluZFBsdWdpbiA9IHJlcXVpcmUoJ3J0Yy1jb3JlL3BsdWdpbicpO1xuXG4vLyBleHBvcnQgY29nIGxvZ2dlciBmb3IgY29udmVuaWVuY2VcbmV4cG9ydHMubG9nZ2VyID0gcmVxdWlyZSgnY29nL2xvZ2dlcicpO1xuXG4vLyBleHBvcnQgcGVlciBjb25uZWN0aW9uXG52YXIgUlRDUGVlckNvbm5lY3Rpb24gPVxuZXhwb3J0cy5SVENQZWVyQ29ubmVjdGlvbiA9IGRldGVjdCgnUlRDUGVlckNvbm5lY3Rpb24nKTtcblxuLy8gYWRkIHRoZSBjb3VwbGUgdXRpbGl0eVxuZXhwb3J0cy5jb3VwbGUgPSByZXF1aXJlKCcuL2NvdXBsZScpO1xuXG4vKipcbiAgIyMjIGNyZWF0ZUNvbm5lY3Rpb25cblxuICBgYGBcbiAgY3JlYXRlQ29ubmVjdGlvbihvcHRzPywgY29uc3RyYWludHM/KSA9PiBSVENQZWVyQ29ubmVjdGlvblxuICBgYGBcblxuICBDcmVhdGUgYSBuZXcgYFJUQ1BlZXJDb25uZWN0aW9uYCBhdXRvIGdlbmVyYXRpbmcgZGVmYXVsdCBvcHRzIGFzIHJlcXVpcmVkLlxuXG4gIGBgYGpzXG4gIHZhciBjb25uO1xuXG4gIC8vIHRoaXMgaXMgb2tcbiAgY29ubiA9IHJ0Yy5jcmVhdGVDb25uZWN0aW9uKCk7XG5cbiAgLy8gYW5kIHNvIGlzIHRoaXNcbiAgY29ubiA9IHJ0Yy5jcmVhdGVDb25uZWN0aW9uKHtcbiAgICBpY2VTZXJ2ZXJzOiBbXVxuICB9KTtcbiAgYGBgXG4qKi9cbmV4cG9ydHMuY3JlYXRlQ29ubmVjdGlvbiA9IGZ1bmN0aW9uKG9wdHMsIGNvbnN0cmFpbnRzKSB7XG4gIHZhciBwbHVnaW4gPSBmaW5kUGx1Z2luKChvcHRzIHx8IHt9KS5wbHVnaW5zKTtcbiAgdmFyIFBlZXJDb25uZWN0aW9uID0gKG9wdHMgfHwge30pLlJUQ1BlZXJDb25uZWN0aW9uIHx8IFJUQ1BlZXJDb25uZWN0aW9uO1xuXG4gIC8vIGdlbmVyYXRlIHRoZSBjb25maWcgYmFzZWQgb24gb3B0aW9ucyBwcm92aWRlZFxuICB2YXIgY29uZmlnID0gZ2VuLmNvbmZpZyhvcHRzKTtcblxuICAvLyBnZW5lcmF0ZSBhcHByb3ByaWF0ZSBjb25uZWN0aW9uIGNvbnN0cmFpbnRzXG4gIGNvbnN0cmFpbnRzID0gZ2VuLmNvbm5lY3Rpb25Db25zdHJhaW50cyhvcHRzLCBjb25zdHJhaW50cyk7XG5cbiAgaWYgKHBsdWdpbiAmJiB0eXBlb2YgcGx1Z2luLmNyZWF0ZUNvbm5lY3Rpb24gPT0gJ2Z1bmN0aW9uJykge1xuICAgIHJldHVybiBwbHVnaW4uY3JlYXRlQ29ubmVjdGlvbihjb25maWcsIGNvbnN0cmFpbnRzKTtcbiAgfVxuXG4gIHJldHVybiBuZXcgUGVlckNvbm5lY3Rpb24oY29uZmlnLCBjb25zdHJhaW50cyk7XG59O1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIG1idXMgPSByZXF1aXJlKCdtYnVzJyk7XG5cbi8vIGRlZmluZSBzb21lIHN0YXRlIG1hcHBpbmdzIHRvIHNpbXBsaWZ5IHRoZSBldmVudHMgd2UgZ2VuZXJhdGVcbnZhciBzdGF0ZU1hcHBpbmdzID0ge1xuICBjb21wbGV0ZWQ6ICdjb25uZWN0ZWQnXG59O1xuXG4vLyBkZWZpbmUgdGhlIGV2ZW50cyB0aGF0IHdlIG5lZWQgdG8gd2F0Y2ggZm9yIHBlZXIgY29ubmVjdGlvblxuLy8gc3RhdGUgY2hhbmdlc1xudmFyIHBlZXJTdGF0ZUV2ZW50cyA9IFtcbiAgJ3NpZ25hbGluZ3N0YXRlY2hhbmdlJyxcbiAgJ2ljZWNvbm5lY3Rpb25zdGF0ZWNoYW5nZScsXG5dO1xuXG4vKipcbiAgIyMjIHJ0Yy10b29scy9tb25pdG9yXG5cbiAgYGBgXG4gIG1vbml0b3IocGMsIHRhcmdldElkLCBzaWduYWxsZXIsIHBhcmVudEJ1cykgPT4gbWJ1c1xuICBgYGBcblxuICBUaGUgbW9uaXRvciBpcyBhIHVzZWZ1bCB0b29sIGZvciBkZXRlcm1pbmluZyB0aGUgc3RhdGUgb2YgYHBjYCAoYW5cbiAgYFJUQ1BlZXJDb25uZWN0aW9uYCkgaW5zdGFuY2UgaW4gdGhlIGNvbnRleHQgb2YgeW91ciBhcHBsaWNhdGlvbi4gVGhlXG4gIG1vbml0b3IgdXNlcyBib3RoIHRoZSBgaWNlQ29ubmVjdGlvblN0YXRlYCBpbmZvcm1hdGlvbiBvZiB0aGUgcGVlclxuICBjb25uZWN0aW9uIGFuZCBhbHNvIHRoZSB2YXJpb3VzXG4gIFtzaWduYWxsZXIgZXZlbnRzXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0Yy1zaWduYWxsZXIjc2lnbmFsbGVyLWV2ZW50cylcbiAgdG8gZGV0ZXJtaW5lIHdoZW4gdGhlIGNvbm5lY3Rpb24gaGFzIGJlZW4gYGNvbm5lY3RlZGAgYW5kIHdoZW4gaXQgaGFzXG4gIGJlZW4gYGRpc2Nvbm5lY3RlZGAuXG5cbiAgQSBtb25pdG9yIGNyZWF0ZWQgYG1idXNgIGlzIHJldHVybmVkIGFzIHRoZSByZXN1bHQgb2YgYVxuICBbY291cGxlXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0YyNydGNjb3VwbGUpIGJldHdlZW4gYSBsb2NhbCBwZWVyXG4gIGNvbm5lY3Rpb24gYW5kIGl0J3MgcmVtb3RlIGNvdW50ZXJwYXJ0LlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24ocGMsIHRhcmdldElkLCBzaWduYWxsZXIsIHBhcmVudEJ1cykge1xuICB2YXIgbW9uaXRvciA9IG1idXMoJycsIHBhcmVudEJ1cyk7XG4gIHZhciBzdGF0ZTtcblxuICBmdW5jdGlvbiBjaGVja1N0YXRlKCkge1xuICAgIHZhciBuZXdTdGF0ZSA9IGdldE1hcHBlZFN0YXRlKHBjLmljZUNvbm5lY3Rpb25TdGF0ZSk7XG5cbiAgICAvLyBmbGFnIHRoZSB3ZSBoYWQgYSBzdGF0ZSBjaGFuZ2VcbiAgICBtb25pdG9yKCdzdGF0ZWNoYW5nZScsIHBjLCBuZXdTdGF0ZSk7XG5cbiAgICAvLyBpZiB0aGUgYWN0aXZlIHN0YXRlIGhhcyBjaGFuZ2VkLCB0aGVuIHNlbmQgdGhlIGFwcG9wcmlhdGUgbWVzc2FnZVxuICAgIGlmIChzdGF0ZSAhPT0gbmV3U3RhdGUpIHtcbiAgICAgIG1vbml0b3IobmV3U3RhdGUpO1xuICAgICAgc3RhdGUgPSBuZXdTdGF0ZTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVDbG9zZSgpIHtcbiAgICBtb25pdG9yKCdjbG9zZWQnKTtcbiAgfVxuXG4gIHBjLm9uY2xvc2UgPSBoYW5kbGVDbG9zZTtcbiAgcGVlclN0YXRlRXZlbnRzLmZvckVhY2goZnVuY3Rpb24oZXZ0TmFtZSkge1xuICAgIHBjWydvbicgKyBldnROYW1lXSA9IGNoZWNrU3RhdGU7XG4gIH0pO1xuXG4gIG1vbml0b3Iuc3RvcCA9IGZ1bmN0aW9uKCkge1xuICAgIHBjLm9uY2xvc2UgPSBudWxsO1xuICAgIHBlZXJTdGF0ZUV2ZW50cy5mb3JFYWNoKGZ1bmN0aW9uKGV2dE5hbWUpIHtcbiAgICAgIHBjWydvbicgKyBldnROYW1lXSA9IG51bGw7XG4gICAgfSk7XG4gIH07XG5cbiAgbW9uaXRvci5jaGVja1N0YXRlID0gY2hlY2tTdGF0ZTtcblxuICAvLyBpZiB3ZSBoYXZlbid0IGJlZW4gcHJvdmlkZWQgYSB2YWxpZCBwZWVyIGNvbm5lY3Rpb24sIGFib3J0XG4gIGlmICghIHBjKSB7XG4gICAgcmV0dXJuIG1vbml0b3I7XG4gIH1cblxuICAvLyBkZXRlcm1pbmUgdGhlIGluaXRpYWwgaXMgYWN0aXZlIHN0YXRlXG4gIHN0YXRlID0gZ2V0TWFwcGVkU3RhdGUocGMuaWNlQ29ubmVjdGlvblN0YXRlKTtcblxuICByZXR1cm4gbW9uaXRvcjtcbn07XG5cbi8qIGludGVybmFsIGhlbHBlcnMgKi9cblxuZnVuY3Rpb24gZ2V0TWFwcGVkU3RhdGUoc3RhdGUpIHtcbiAgcmV0dXJuIHN0YXRlTWFwcGluZ3Nbc3RhdGVdIHx8IHN0YXRlO1xufVxuIiwidmFyIGRldGVjdCA9IHJlcXVpcmUoJ3J0Yy1jb3JlL2RldGVjdCcpO1xudmFyIGZpbmRQbHVnaW4gPSByZXF1aXJlKCdydGMtY29yZS9wbHVnaW4nKTtcbnZhciBQcmlvcml0eVF1ZXVlID0gcmVxdWlyZSgncHJpb3JpdHlxdWV1ZWpzJyk7XG52YXIgcGx1Y2sgPSByZXF1aXJlKCd3aGlzay9wbHVjaycpO1xudmFyIHBsdWNrU2Vzc2lvbkRlc2MgPSBwbHVjaygnc2RwJywgJ3R5cGUnKTtcblxuLy8gc29tZSB2YWxpZGF0aW9uIHJvdXRpbmVzXG52YXIgY2hlY2tDYW5kaWRhdGUgPSByZXF1aXJlKCdydGMtdmFsaWRhdG9yL2NhbmRpZGF0ZScpO1xuXG4vLyB0aGUgc2RwIGNsZWFuZXJcbnZhciBzZHBjbGVhbiA9IHJlcXVpcmUoJ3J0Yy1zZHBjbGVhbicpO1xudmFyIHBhcnNlU2RwID0gcmVxdWlyZSgncnRjLXNkcCcpO1xuXG52YXIgUFJJT1JJVFlfTE9XID0gMTAwO1xudmFyIFBSSU9SSVRZX1dBSVQgPSAxMDAwO1xuXG4vLyBwcmlvcml0eSBvcmRlciAobG93ZXIgaXMgYmV0dGVyKVxudmFyIERFRkFVTFRfUFJJT1JJVElFUyA9IFtcbiAgJ2FkZEljZUNhbmRpZGF0ZScsXG4gICdzZXRMb2NhbERlc2NyaXB0aW9uJyxcbiAgJ3NldFJlbW90ZURlc2NyaXB0aW9uJyxcbiAgJ2NyZWF0ZUFuc3dlcicsXG4gICdjcmVhdGVPZmZlcidcbl07XG5cbi8vIGRlZmluZSBldmVudCBtYXBwaW5nc1xudmFyIE1FVEhPRF9FVkVOVFMgPSB7XG4gIHNldExvY2FsRGVzY3JpcHRpb246ICdzZXRsb2NhbGRlc2MnLFxuICBzZXRSZW1vdGVEZXNjcmlwdGlvbjogJ3NldHJlbW90ZWRlc2MnLFxuICBjcmVhdGVPZmZlcjogJ29mZmVyJyxcbiAgY3JlYXRlQW5zd2VyOiAnYW5zd2VyJ1xufTtcblxudmFyIE1FRElBX01BUFBJTkdTID0ge1xuICBkYXRhOiAnYXBwbGljYXRpb24nXG59O1xuXG4vLyBkZWZpbmUgc3RhdGVzIGluIHdoaWNoIHdlIHdpbGwgYXR0ZW1wdCB0byBmaW5hbGl6ZSBhIGNvbm5lY3Rpb24gb24gcmVjZWl2aW5nIGEgcmVtb3RlIG9mZmVyXG52YXIgVkFMSURfUkVTUE9OU0VfU1RBVEVTID0gWydoYXZlLXJlbW90ZS1vZmZlcicsICdoYXZlLWxvY2FsLXByYW5zd2VyJ107XG5cbi8qKlxuICAjIHJ0Yy10YXNrcXVldWVcblxuICBUaGlzIGlzIGEgcGFja2FnZSB0aGF0IGFzc2lzdHMgd2l0aCBhcHBseWluZyBhY3Rpb25zIHRvIGFuIGBSVENQZWVyQ29ubmVjdGlvbmBcbiAgaW4gYXMgcmVsaWFibGUgb3JkZXIgYXMgcG9zc2libGUuIEl0IGlzIHByaW1hcmlseSB1c2VkIGJ5IHRoZSBjb3VwbGluZyBsb2dpY1xuICBvZiB0aGUgW2BydGMtdG9vbHNgXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0Yy10b29scykuXG5cbiAgIyMgRXhhbXBsZSBVc2FnZVxuXG4gIEZvciB0aGUgbW9tZW50LCByZWZlciB0byB0aGUgc2ltcGxlIGNvdXBsaW5nIHRlc3QgYXMgYW4gZXhhbXBsZSBvZiBob3cgdG8gdXNlXG4gIHRoaXMgcGFja2FnZSAoc2VlIGJlbG93KTpcblxuICA8PDwgdGVzdC9jb3VwbGUuanNcblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHBjLCBvcHRzKSB7XG4gIC8vIGNyZWF0ZSB0aGUgdGFzayBxdWV1ZVxuICB2YXIgcXVldWUgPSBuZXcgUHJpb3JpdHlRdWV1ZShvcmRlclRhc2tzKTtcbiAgdmFyIHRxID0gcmVxdWlyZSgnbWJ1cycpKCcnLCAob3B0cyB8fCB7fSkubG9nZ2VyKTtcblxuICAvLyBpbml0aWFsaXNlIHRhc2sgaW1wb3J0YW5jZVxuICB2YXIgcHJpb3JpdGllcyA9IChvcHRzIHx8IHt9KS5wcmlvcml0aWVzIHx8IERFRkFVTFRfUFJJT1JJVElFUztcbiAgdmFyIHF1ZXVlSW50ZXJ2YWwgPSAob3B0cyB8fCB7fSkuaW50ZXJ2YWwgfHwgNTA7XG5cbiAgLy8gY2hlY2sgZm9yIHBsdWdpbiB1c2FnZVxuICB2YXIgcGx1Z2luID0gZmluZFBsdWdpbigob3B0cyB8fCB7fSkucGx1Z2lucyk7XG5cbiAgLy8gaW5pdGlhbGlzZSBzdGF0ZSB0cmFja2luZ1xuICB2YXIgY2hlY2tRdWV1ZVRpbWVyID0gMDtcbiAgdmFyIGRlZmF1bHRGYWlsID0gdHEuYmluZCh0cSwgJ2ZhaWwnKTtcblxuICAvLyBsb29rIGZvciBhbiBzZHBmaWx0ZXIgZnVuY3Rpb24gKGFsbG93IHNsaWdodCBtaXMtc3BlbGxpbmdzKVxuICB2YXIgc2RwRmlsdGVyID0gKG9wdHMgfHwge30pLnNkcGZpbHRlciB8fCAob3B0cyB8fCB7fSkuc2RwRmlsdGVyO1xuXG4gIC8vIGluaXRpYWxpc2Ugc2Vzc2lvbiBkZXNjcmlwdGlvbiBhbmQgaWNlY2FuZGlkYXRlIG9iamVjdHNcbiAgdmFyIFJUQ1Nlc3Npb25EZXNjcmlwdGlvbiA9IChvcHRzIHx8IHt9KS5SVENTZXNzaW9uRGVzY3JpcHRpb24gfHxcbiAgICBkZXRlY3QoJ1JUQ1Nlc3Npb25EZXNjcmlwdGlvbicpO1xuXG4gIHZhciBSVENJY2VDYW5kaWRhdGUgPSAob3B0cyB8fCB7fSkuUlRDSWNlQ2FuZGlkYXRlIHx8XG4gICAgZGV0ZWN0KCdSVENJY2VDYW5kaWRhdGUnKTtcblxuICBmdW5jdGlvbiBhYm9ydFF1ZXVlKGVycikge1xuICAgIGNvbnNvbGUuZXJyb3IoZXJyKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGFwcGx5Q2FuZGlkYXRlKHRhc2ssIG5leHQpIHtcbiAgICB2YXIgZGF0YSA9IHRhc2suYXJnc1swXTtcbiAgICAvLyBBbGxvdyBzZWxlY3RpdmUgZmlsdGVyaW5nIG9mIElDRSBjYW5kaWRhdGVzXG4gICAgaWYgKG9wdHMgJiYgb3B0cy5maWx0ZXJDYW5kaWRhdGUgJiYgIW9wdHMuZmlsdGVyQ2FuZGlkYXRlKGRhdGEpKSB7XG4gICAgICB0cSgnaWNlLnJlbW90ZS5maWx0ZXJlZCcsIGNhbmRpZGF0ZSk7XG4gICAgICByZXR1cm4gbmV4dCgpO1xuICAgIH1cbiAgICB2YXIgY2FuZGlkYXRlID0gZGF0YSAmJiBkYXRhLmNhbmRpZGF0ZSAmJiBjcmVhdGVJY2VDYW5kaWRhdGUoZGF0YSk7XG5cbiAgICBmdW5jdGlvbiBoYW5kbGVPaygpIHtcbiAgICAgIHRxKCdpY2UucmVtb3RlLmFwcGxpZWQnLCBjYW5kaWRhdGUpO1xuICAgICAgbmV4dCgpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGhhbmRsZUZhaWwoZXJyKSB7XG4gICAgICB0cSgnaWNlLnJlbW90ZS5pbnZhbGlkJywgY2FuZGlkYXRlKTtcbiAgICAgIG5leHQoZXJyKTtcbiAgICB9XG5cbiAgICAvLyB3ZSBoYXZlIGEgbnVsbCBjYW5kaWRhdGUsIHdlIGhhdmUgZmluaXNoZWQgZ2F0aGVyaW5nIGNhbmRpZGF0ZXNcbiAgICBpZiAoISBjYW5kaWRhdGUpIHtcbiAgICAgIHJldHVybiBuZXh0KCk7XG4gICAgfVxuXG4gICAgcGMuYWRkSWNlQ2FuZGlkYXRlKGNhbmRpZGF0ZSwgaGFuZGxlT2ssIGhhbmRsZUZhaWwpO1xuICB9XG5cbiAgZnVuY3Rpb24gY2hlY2tRdWV1ZSgpIHtcbiAgICAvLyBwZWVrIGF0IHRoZSBuZXh0IGl0ZW0gb24gdGhlIHF1ZXVlXG4gICAgdmFyIG5leHQgPSAoISBxdWV1ZS5pc0VtcHR5KCkpICYmIHF1ZXVlLnBlZWsoKTtcbiAgICB2YXIgcmVhZHkgPSBuZXh0ICYmIHRlc3RSZWFkeShuZXh0KTtcblxuICAgIC8vIHJlc2V0IHRoZSBxdWV1ZSB0aW1lclxuICAgIGNoZWNrUXVldWVUaW1lciA9IDA7XG5cbiAgICAvLyBpZiB3ZSBkb24ndCBoYXZlIGEgdGFzayByZWFkeSwgdGhlbiBhYm9ydFxuICAgIGlmICghIHJlYWR5KSB7XG4gICAgICAvLyBpZiB3ZSBoYXZlIGEgdGFzayBhbmQgaXQgaGFzIGV4cGlyZWQgdGhlbiBkZXF1ZXVlIGl0XG4gICAgICBpZiAobmV4dCAmJiBleHBpcmVkKG5leHQpKSB7XG4gICAgICAgIHRxKCd0YXNrLmV4cGlyZScsIG5leHQpO1xuICAgICAgICBxdWV1ZS5kZXEoKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuICghIHF1ZXVlLmlzRW1wdHkoKSkgJiYgaXNOb3RDbG9zZWQocGMpICYmIHRyaWdnZXJRdWV1ZUNoZWNrKCk7XG4gICAgfVxuXG4gICAgLy8gcHJvcGVybHkgZGVxdWV1ZSB0YXNrXG4gICAgbmV4dCA9IHF1ZXVlLmRlcSgpO1xuXG4gICAgLy8gcHJvY2VzcyB0aGUgdGFza1xuICAgIG5leHQuZm4obmV4dCwgZnVuY3Rpb24oZXJyKSB7XG4gICAgICB2YXIgZmFpbCA9IG5leHQuZmFpbCB8fCBkZWZhdWx0RmFpbDtcbiAgICAgIHZhciBwYXNzID0gbmV4dC5wYXNzO1xuICAgICAgdmFyIHRhc2tOYW1lID0gbmV4dC5uYW1lO1xuXG4gICAgICAvLyBpZiBlcnJvcmVkLCBmYWlsXG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IodGFza05hbWUgKyAnIHRhc2sgZmFpbGVkOiAnLCBlcnIpO1xuICAgICAgICByZXR1cm4gZmFpbChlcnIpO1xuICAgICAgfVxuXG4gICAgICBpZiAodHlwZW9mIHBhc3MgPT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBwYXNzLmFwcGx5KG5leHQsIFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKSk7XG4gICAgICB9XG5cbiAgICAgIHRyaWdnZXJRdWV1ZUNoZWNrKCk7XG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBjbGVhbnNkcChkZXNjKSB7XG4gICAgLy8gZW5zdXJlIHdlIGhhdmUgY2xlYW4gc2RwXG4gICAgdmFyIHNkcEVycm9ycyA9IFtdO1xuICAgIHZhciBzZHAgPSBkZXNjICYmIHNkcGNsZWFuKGRlc2Muc2RwLCB7IGNvbGxlY3Rvcjogc2RwRXJyb3JzIH0pO1xuXG4gICAgLy8gaWYgd2UgZG9uJ3QgaGF2ZSBhIG1hdGNoLCBsb2cgc29tZSBpbmZvXG4gICAgaWYgKGRlc2MgJiYgc2RwICE9PSBkZXNjLnNkcCkge1xuICAgICAgY29uc29sZS5pbmZvKCdpbnZhbGlkIGxpbmVzIHJlbW92ZWQgZnJvbSBzZHA6ICcsIHNkcEVycm9ycyk7XG4gICAgICBkZXNjLnNkcCA9IHNkcDtcbiAgICB9XG5cbiAgICAvLyBpZiBhIGZpbHRlciBoYXMgYmVlbiBzcGVjaWZpZWQsIHRoZW4gYXBwbHkgdGhlIGZpbHRlclxuICAgIGlmICh0eXBlb2Ygc2RwRmlsdGVyID09ICdmdW5jdGlvbicpIHtcbiAgICAgIGRlc2Muc2RwID0gc2RwRmlsdGVyKGRlc2Muc2RwLCBwYyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGRlc2M7XG4gIH1cblxuICBmdW5jdGlvbiBjb21wbGV0ZUNvbm5lY3Rpb24oKSB7XG4gICAgaWYgKFZBTElEX1JFU1BPTlNFX1NUQVRFUy5pbmRleE9mKHBjLnNpZ25hbGluZ1N0YXRlKSA+PSAwKSB7XG4gICAgICByZXR1cm4gdHEuY3JlYXRlQW5zd2VyKCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gY3JlYXRlSWNlQ2FuZGlkYXRlKGRhdGEpIHtcbiAgICBpZiAocGx1Z2luICYmIHR5cGVvZiBwbHVnaW4uY3JlYXRlSWNlQ2FuZGlkYXRlID09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiBwbHVnaW4uY3JlYXRlSWNlQ2FuZGlkYXRlKGRhdGEpO1xuICAgIH1cblxuICAgIHJldHVybiBuZXcgUlRDSWNlQ2FuZGlkYXRlKGRhdGEpO1xuICB9XG5cbiAgZnVuY3Rpb24gY3JlYXRlU2Vzc2lvbkRlc2NyaXB0aW9uKGRhdGEpIHtcbiAgICBpZiAocGx1Z2luICYmIHR5cGVvZiBwbHVnaW4uY3JlYXRlU2Vzc2lvbkRlc2NyaXB0aW9uID09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiBwbHVnaW4uY3JlYXRlU2Vzc2lvbkRlc2NyaXB0aW9uKGRhdGEpO1xuICAgIH1cblxuICAgIHJldHVybiBuZXcgUlRDU2Vzc2lvbkRlc2NyaXB0aW9uKGRhdGEpO1xuICB9XG5cbiAgZnVuY3Rpb24gZW1pdFNkcCgpIHtcbiAgICB0cSgnc2RwLmxvY2FsJywgcGx1Y2tTZXNzaW9uRGVzYyh0aGlzLmFyZ3NbMF0pKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGVucXVldWUobmFtZSwgaGFuZGxlciwgb3B0cykge1xuICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpO1xuXG4gICAgICBpZiAob3B0cyAmJiB0eXBlb2Ygb3B0cy5wcm9jZXNzQXJncyA9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGFyZ3MgPSBhcmdzLm1hcChvcHRzLnByb2Nlc3NBcmdzKTtcbiAgICAgIH1cblxuICAgICAgdmFyIHByaW9yaXR5ID0gcHJpb3JpdGllcy5pbmRleE9mKG5hbWUpO1xuXG4gICAgICBxdWV1ZS5lbnEoe1xuICAgICAgICBhcmdzOiBhcmdzLFxuICAgICAgICBuYW1lOiBuYW1lLFxuICAgICAgICBmbjogaGFuZGxlcixcbiAgICAgICAgcHJpb3JpdHk6IHByaW9yaXR5ID49IDAgPyBwcmlvcml0eSA6IFBSSU9SSVRZX0xPVyxcblxuICAgICAgICAvLyByZWNvcmQgdGhlIHRpbWUgYXQgd2hpY2ggdGhlIHRhc2sgd2FzIHF1ZXVlZFxuICAgICAgICBzdGFydDogRGF0ZS5ub3coKSxcblxuICAgICAgICAvLyBpbml0aWxhaXNlIGFueSBjaGVja3MgdGhhdCBuZWVkIHRvIGJlIGRvbmUgcHJpb3JcbiAgICAgICAgLy8gdG8gdGhlIHRhc2sgZXhlY3V0aW5nXG4gICAgICAgIGNoZWNrczogWyBpc05vdENsb3NlZCBdLmNvbmNhdCgob3B0cyB8fCB7fSkuY2hlY2tzIHx8IFtdKSxcblxuICAgICAgICAvLyBpbml0aWFsaXNlIHRoZSBwYXNzIGFuZCBmYWlsIGhhbmRsZXJzXG4gICAgICAgIHBhc3M6IChvcHRzIHx8IHt9KS5wYXNzLFxuICAgICAgICBmYWlsOiAob3B0cyB8fCB7fSkuZmFpbFxuICAgICAgfSk7XG5cbiAgICAgIHRyaWdnZXJRdWV1ZUNoZWNrKCk7XG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGV4ZWNNZXRob2QodGFzaywgbmV4dCkge1xuICAgIHZhciBmbiA9IHBjW3Rhc2submFtZV07XG4gICAgdmFyIGV2ZW50TmFtZSA9IE1FVEhPRF9FVkVOVFNbdGFzay5uYW1lXSB8fCAodGFzay5uYW1lIHx8ICcnKS50b0xvd2VyQ2FzZSgpO1xuICAgIHZhciBjYkFyZ3MgPSBbIHN1Y2Nlc3MsIGZhaWwgXTtcbiAgICB2YXIgaXNPZmZlciA9IHRhc2submFtZSA9PT0gJ2NyZWF0ZU9mZmVyJztcblxuICAgIGZ1bmN0aW9uIGZhaWwoZXJyKSB7XG4gICAgICB0cS5hcHBseSh0cSwgWyAnbmVnb3RpYXRlLmVycm9yJywgdGFzay5uYW1lLCBlcnIgXS5jb25jYXQodGFzay5hcmdzKSk7XG4gICAgICBuZXh0KGVycik7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gc3VjY2VzcygpIHtcbiAgICAgIHRxLmFwcGx5KHRxLCBbIFsnbmVnb3RpYXRlJywgZXZlbnROYW1lLCAnb2snXSwgdGFzay5uYW1lIF0uY29uY2F0KHRhc2suYXJncykpO1xuICAgICAgbmV4dC5hcHBseShudWxsLCBbbnVsbF0uY29uY2F0KFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKSkpO1xuICAgIH1cblxuICAgIGlmICghIGZuKSB7XG4gICAgICByZXR1cm4gbmV4dChuZXcgRXJyb3IoJ2Nhbm5vdCBjYWxsIFwiJyArIHRhc2submFtZSArICdcIiBvbiBSVENQZWVyQ29ubmVjdGlvbicpKTtcbiAgICB9XG5cbiAgICAvLyBpbnZva2UgdGhlIGZ1bmN0aW9uXG4gICAgdHEuYXBwbHkodHEsIFsnbmVnb3RpYXRlLicgKyBldmVudE5hbWVdLmNvbmNhdCh0YXNrLmFyZ3MpKTtcbiAgICBmbi5hcHBseShcbiAgICAgIHBjLFxuICAgICAgdGFzay5hcmdzLmNvbmNhdChjYkFyZ3MpLmNvbmNhdChpc09mZmVyID8gZ2VuZXJhdGVDb25zdHJhaW50cygpIDogW10pXG4gICAgKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGV4cGlyZWQodGFzaykge1xuICAgIHJldHVybiAodHlwZW9mIHRhc2sudHRsID09ICdudW1iZXInKSAmJiAodGFzay5zdGFydCArIHRhc2sudHRsIDwgRGF0ZS5ub3coKSk7XG4gIH1cblxuICBmdW5jdGlvbiBleHRyYWN0Q2FuZGlkYXRlRXZlbnREYXRhKGRhdGEpIHtcbiAgICAvLyBleHRyYWN0IG5lc3RlZCBjYW5kaWRhdGUgZGF0YSAobGlrZSB3ZSB3aWxsIHNlZSBpbiBhbiBldmVudCBiZWluZyBwYXNzZWQgdG8gdGhpcyBmdW5jdGlvbilcbiAgICB3aGlsZSAoZGF0YSAmJiBkYXRhLmNhbmRpZGF0ZSAmJiBkYXRhLmNhbmRpZGF0ZS5jYW5kaWRhdGUpIHtcbiAgICAgIGRhdGEgPSBkYXRhLmNhbmRpZGF0ZTtcbiAgICB9XG5cbiAgICByZXR1cm4gZGF0YTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGdlbmVyYXRlQ29uc3RyYWludHMoKSB7XG4gICAgdmFyIGFsbG93ZWRLZXlzID0ge1xuICAgICAgb2ZmZXJ0b3JlY2VpdmV2aWRlbzogJ09mZmVyVG9SZWNlaXZlVmlkZW8nLFxuICAgICAgb2ZmZXJ0b3JlY2VpdmVhdWRpbzogJ09mZmVyVG9SZWNlaXZlQXVkaW8nLFxuICAgICAgaWNlcmVzdGFydDogJ0ljZVJlc3RhcnQnLFxuICAgICAgdm9pY2VhY3Rpdml0eWRldGVjdGlvbjogJ1ZvaWNlQWN0aXZpdHlEZXRlY3Rpb24nXG4gICAgfTtcblxuICAgIHZhciBjb25zdHJhaW50cyA9IHtcbiAgICAgIE9mZmVyVG9SZWNlaXZlVmlkZW86IHRydWUsXG4gICAgICBPZmZlclRvUmVjZWl2ZUF1ZGlvOiB0cnVlXG4gICAgfTtcblxuICAgIC8vIHVwZGF0ZSBrbm93biBrZXlzIHRvIG1hdGNoXG4gICAgT2JqZWN0LmtleXMob3B0cyB8fCB7fSkuZm9yRWFjaChmdW5jdGlvbihrZXkpIHtcbiAgICAgIGlmIChhbGxvd2VkS2V5c1trZXkudG9Mb3dlckNhc2UoKV0pIHtcbiAgICAgICAgY29uc3RyYWludHNbYWxsb3dlZEtleXNba2V5LnRvTG93ZXJDYXNlKCldXSA9IG9wdHNba2V5XTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiB7IG1hbmRhdG9yeTogY29uc3RyYWludHMgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhc0xvY2FsT3JSZW1vdGVEZXNjKHBjLCB0YXNrKSB7XG4gICAgcmV0dXJuIHBjLl9faGFzRGVzYyB8fCAocGMuX19oYXNEZXNjID0gISFwYy5yZW1vdGVEZXNjcmlwdGlvbik7XG4gIH1cblxuICBmdW5jdGlvbiBpc05vdE5lZ290aWF0aW5nKHBjKSB7XG4gICAgcmV0dXJuIHBjLnNpZ25hbGluZ1N0YXRlICE9PSAnaGF2ZS1sb2NhbC1vZmZlcic7XG4gIH1cblxuICBmdW5jdGlvbiBpc05vdENsb3NlZChwYykge1xuICAgIHJldHVybiBwYy5zaWduYWxpbmdTdGF0ZSAhPT0gJ2Nsb3NlZCc7XG4gIH1cblxuICBmdW5jdGlvbiBpc1N0YWJsZShwYykge1xuICAgIHJldHVybiBwYy5zaWduYWxpbmdTdGF0ZSA9PT0gJ3N0YWJsZSc7XG4gIH1cblxuICBmdW5jdGlvbiBpc1ZhbGlkQ2FuZGlkYXRlKHBjLCBkYXRhKSB7XG4gICAgcmV0dXJuIGRhdGEuX192YWxpZCB8fFxuICAgICAgKGRhdGEuX192YWxpZCA9IGNoZWNrQ2FuZGlkYXRlKGRhdGEuYXJnc1swXSkubGVuZ3RoID09PSAwKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGlzQ29ublJlYWR5Rm9yQ2FuZGlkYXRlKHBjLCBkYXRhKSB7XG4gICAgdmFyIHNkcE1pZCA9IGRhdGEuYXJnc1swXSAmJiBkYXRhLmFyZ3NbMF0uc2RwTWlkO1xuXG4gICAgLy8gcmVtYXAgbWVkaWEgdHlwZXMgYXMgYXBwcm9wcmlhdGVcbiAgICBzZHBNaWQgPSBNRURJQV9NQVBQSU5HU1tzZHBNaWRdIHx8IHNkcE1pZDtcblxuICAgIGlmIChzZHBNaWQgPT09ICcnKVxuICAgICAgcmV0dXJuIHRydWU7XG5cbiAgICBpZiAoIXBjLl9fbWVkaWFUeXBlcykge1xuICAgICAgdmFyIHNkcCA9IHBhcnNlU2RwKHBjLnJlbW90ZURlc2NyaXB0aW9uICYmIHBjLnJlbW90ZURlc2NyaXB0aW9uLnNkcCk7XG4gICAgICBwYy5fX21lZGlhVHlwZXMgPSBzZHAuZ2V0TWVkaWFUeXBlcygpO1xuICAgIH1cblxuICAgIC8vIHRoZSBjYW5kaWRhdGUgaXMgdmFsaWQgaWYgd2Uga25vdyBhYm91dCB0aGUgbWVkaWEgdHlwZVxuICAgIHJldHVybiBwYy5fX21lZGlhVHlwZXMuaW5kZXhPZihzZHBNaWQpID49IDA7XG4gIH1cblxuICBmdW5jdGlvbiBvcmRlclRhc2tzKGEsIGIpIHtcbiAgICAvLyBhcHBseSBlYWNoIG9mIHRoZSBjaGVja3MgZm9yIGVhY2ggdGFza1xuICAgIHZhciB0YXNrcyA9IFthLGJdO1xuICAgIHZhciByZWFkaW5lc3MgPSB0YXNrcy5tYXAodGVzdFJlYWR5KTtcbiAgICB2YXIgdGFza1ByaW9yaXRpZXMgPSB0YXNrcy5tYXAoZnVuY3Rpb24odGFzaywgaWR4KSB7XG4gICAgICB2YXIgcmVhZHkgPSByZWFkaW5lc3NbaWR4XTtcbiAgICAgIHJldHVybiByZWFkeSA/IHRhc2sucHJpb3JpdHkgOiBQUklPUklUWV9XQUlUO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHRhc2tQcmlvcml0aWVzWzFdIC0gdGFza1ByaW9yaXRpZXNbMF07XG4gIH1cblxuICAvLyBjaGVjayB3aGV0aGVyIGEgdGFzayBpcyByZWFkeSAoZG9lcyBpdCBwYXNzIGFsbCB0aGUgY2hlY2tzKVxuICBmdW5jdGlvbiB0ZXN0UmVhZHkodGFzaykge1xuICAgIHJldHVybiAodGFzay5jaGVja3MgfHwgW10pLnJlZHVjZShmdW5jdGlvbihtZW1vLCBjaGVjaykge1xuICAgICAgcmV0dXJuIG1lbW8gJiYgY2hlY2socGMsIHRhc2spO1xuICAgIH0sIHRydWUpO1xuICB9XG5cbiAgZnVuY3Rpb24gdHJpZ2dlclF1ZXVlQ2hlY2soKSB7XG4gICAgaWYgKGNoZWNrUXVldWVUaW1lcikgcmV0dXJuO1xuICAgIGNoZWNrUXVldWVUaW1lciA9IHNldFRpbWVvdXQoY2hlY2tRdWV1ZSwgcXVldWVJbnRlcnZhbCk7XG4gIH1cblxuICAvLyBwYXRjaCBpbiB0aGUgcXVldWUgaGVscGVyIG1ldGhvZHNcbiAgdHEuYWRkSWNlQ2FuZGlkYXRlID0gZW5xdWV1ZSgnYWRkSWNlQ2FuZGlkYXRlJywgYXBwbHlDYW5kaWRhdGUsIHtcbiAgICBwcm9jZXNzQXJnczogZXh0cmFjdENhbmRpZGF0ZUV2ZW50RGF0YSxcbiAgICBjaGVja3M6IFtoYXNMb2NhbE9yUmVtb3RlRGVzYywgaXNWYWxpZENhbmRpZGF0ZSwgaXNDb25uUmVhZHlGb3JDYW5kaWRhdGUgXSxcblxuICAgIC8vIHNldCB0dGwgdG8gNXNcbiAgICB0dGw6IDUwMDBcbiAgfSk7XG5cbiAgdHEuc2V0TG9jYWxEZXNjcmlwdGlvbiA9IGVucXVldWUoJ3NldExvY2FsRGVzY3JpcHRpb24nLCBleGVjTWV0aG9kLCB7XG4gICAgcHJvY2Vzc0FyZ3M6IGNsZWFuc2RwLFxuICAgIHBhc3M6IGVtaXRTZHBcbiAgfSk7XG5cbiAgdHEuc2V0UmVtb3RlRGVzY3JpcHRpb24gPSBlbnF1ZXVlKCdzZXRSZW1vdGVEZXNjcmlwdGlvbicsIGV4ZWNNZXRob2QsIHtcbiAgICBwcm9jZXNzQXJnczogY3JlYXRlU2Vzc2lvbkRlc2NyaXB0aW9uLFxuICAgIHBhc3M6IGNvbXBsZXRlQ29ubmVjdGlvblxuICB9KTtcblxuICB0cS5jcmVhdGVPZmZlciA9IGVucXVldWUoJ2NyZWF0ZU9mZmVyJywgZXhlY01ldGhvZCwge1xuICAgIGNoZWNrczogWyBpc05vdE5lZ290aWF0aW5nIF0sXG4gICAgcGFzczogdHEuc2V0TG9jYWxEZXNjcmlwdGlvblxuICB9KTtcblxuICB0cS5jcmVhdGVBbnN3ZXIgPSBlbnF1ZXVlKCdjcmVhdGVBbnN3ZXInLCBleGVjTWV0aG9kLCB7XG4gICAgcGFzczogdHEuc2V0TG9jYWxEZXNjcmlwdGlvblxuICB9KTtcblxuICByZXR1cm4gdHE7XG59O1xuIiwiLyoqXG4gKiBFeHBvc2UgYFByaW9yaXR5UXVldWVgLlxuICovXG5tb2R1bGUuZXhwb3J0cyA9IFByaW9yaXR5UXVldWU7XG5cbi8qKlxuICogSW5pdGlhbGl6ZXMgYSBuZXcgZW1wdHkgYFByaW9yaXR5UXVldWVgIHdpdGggdGhlIGdpdmVuIGBjb21wYXJhdG9yKGEsIGIpYFxuICogZnVuY3Rpb24sIHVzZXMgYC5ERUZBVUxUX0NPTVBBUkFUT1IoKWAgd2hlbiBubyBmdW5jdGlvbiBpcyBwcm92aWRlZC5cbiAqXG4gKiBUaGUgY29tcGFyYXRvciBmdW5jdGlvbiBtdXN0IHJldHVybiBhIHBvc2l0aXZlIG51bWJlciB3aGVuIGBhID4gYmAsIDAgd2hlblxuICogYGEgPT0gYmAgYW5kIGEgbmVnYXRpdmUgbnVtYmVyIHdoZW4gYGEgPCBiYC5cbiAqXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufVxuICogQHJldHVybiB7UHJpb3JpdHlRdWV1ZX1cbiAqIEBhcGkgcHVibGljXG4gKi9cbmZ1bmN0aW9uIFByaW9yaXR5UXVldWUoY29tcGFyYXRvcikge1xuICB0aGlzLl9jb21wYXJhdG9yID0gY29tcGFyYXRvciB8fCBQcmlvcml0eVF1ZXVlLkRFRkFVTFRfQ09NUEFSQVRPUjtcbiAgdGhpcy5fZWxlbWVudHMgPSBbXTtcbn1cblxuLyoqXG4gKiBDb21wYXJlcyBgYWAgYW5kIGBiYCwgd2hlbiBgYSA+IGJgIGl0IHJldHVybnMgYSBwb3NpdGl2ZSBudW1iZXIsIHdoZW5cbiAqIGl0IHJldHVybnMgMCBhbmQgd2hlbiBgYSA8IGJgIGl0IHJldHVybnMgYSBuZWdhdGl2ZSBudW1iZXIuXG4gKlxuICogQHBhcmFtIHtTdHJpbmd8TnVtYmVyfSBhXG4gKiBAcGFyYW0ge1N0cmluZ3xOdW1iZXJ9IGJcbiAqIEByZXR1cm4ge051bWJlcn1cbiAqIEBhcGkgcHVibGljXG4gKi9cblByaW9yaXR5UXVldWUuREVGQVVMVF9DT01QQVJBVE9SID0gZnVuY3Rpb24oYSwgYikge1xuICBpZiAodHlwZW9mIGEgPT09ICdudW1iZXInICYmIHR5cGVvZiBiID09PSAnbnVtYmVyJykge1xuICAgIHJldHVybiBhIC0gYjtcbiAgfSBlbHNlIHtcbiAgICBhID0gYS50b1N0cmluZygpO1xuICAgIGIgPSBiLnRvU3RyaW5nKCk7XG5cbiAgICBpZiAoYSA9PSBiKSByZXR1cm4gMDtcblxuICAgIHJldHVybiAoYSA+IGIpID8gMSA6IC0xO1xuICB9XG59O1xuXG4vKipcbiAqIFJldHVybnMgd2hldGhlciB0aGUgcHJpb3JpdHkgcXVldWUgaXMgZW1wdHkgb3Igbm90LlxuICpcbiAqIEByZXR1cm4ge0Jvb2xlYW59XG4gKiBAYXBpIHB1YmxpY1xuICovXG5Qcmlvcml0eVF1ZXVlLnByb3RvdHlwZS5pc0VtcHR5ID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiB0aGlzLnNpemUoKSA9PT0gMDtcbn07XG5cbi8qKlxuICogUGVla3MgYXQgdGhlIHRvcCBlbGVtZW50IG9mIHRoZSBwcmlvcml0eSBxdWV1ZS5cbiAqXG4gKiBAcmV0dXJuIHtPYmplY3R9XG4gKiBAdGhyb3dzIHtFcnJvcn0gd2hlbiB0aGUgcXVldWUgaXMgZW1wdHkuXG4gKiBAYXBpIHB1YmxpY1xuICovXG5Qcmlvcml0eVF1ZXVlLnByb3RvdHlwZS5wZWVrID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmlzRW1wdHkoKSkgdGhyb3cgbmV3IEVycm9yKCdQcmlvcml0eVF1ZXVlIGlzIGVtcHR5Jyk7XG5cbiAgcmV0dXJuIHRoaXMuX2VsZW1lbnRzWzBdO1xufTtcblxuLyoqXG4gKiBEZXF1ZXVlcyB0aGUgdG9wIGVsZW1lbnQgb2YgdGhlIHByaW9yaXR5IHF1ZXVlLlxuICpcbiAqIEByZXR1cm4ge09iamVjdH1cbiAqIEB0aHJvd3Mge0Vycm9yfSB3aGVuIHRoZSBxdWV1ZSBpcyBlbXB0eS5cbiAqIEBhcGkgcHVibGljXG4gKi9cblByaW9yaXR5UXVldWUucHJvdG90eXBlLmRlcSA9IGZ1bmN0aW9uKCkge1xuICB2YXIgZmlyc3QgPSB0aGlzLnBlZWsoKTtcbiAgdmFyIGxhc3QgPSB0aGlzLl9lbGVtZW50cy5wb3AoKTtcbiAgdmFyIHNpemUgPSB0aGlzLnNpemUoKTtcblxuICBpZiAoc2l6ZSA9PT0gMCkgcmV0dXJuIGZpcnN0O1xuXG4gIHRoaXMuX2VsZW1lbnRzWzBdID0gbGFzdDtcbiAgdmFyIGN1cnJlbnQgPSAwO1xuXG4gIHdoaWxlIChjdXJyZW50IDwgc2l6ZSkge1xuICAgIHZhciBsYXJnZXN0ID0gY3VycmVudDtcbiAgICB2YXIgbGVmdCA9ICgyICogY3VycmVudCkgKyAxO1xuICAgIHZhciByaWdodCA9ICgyICogY3VycmVudCkgKyAyO1xuXG4gICAgaWYgKGxlZnQgPCBzaXplICYmIHRoaXMuX2NvbXBhcmUobGVmdCwgbGFyZ2VzdCkgPj0gMCkge1xuICAgICAgbGFyZ2VzdCA9IGxlZnQ7XG4gICAgfVxuXG4gICAgaWYgKHJpZ2h0IDwgc2l6ZSAmJiB0aGlzLl9jb21wYXJlKHJpZ2h0LCBsYXJnZXN0KSA+PSAwKSB7XG4gICAgICBsYXJnZXN0ID0gcmlnaHQ7XG4gICAgfVxuXG4gICAgaWYgKGxhcmdlc3QgPT09IGN1cnJlbnQpIGJyZWFrO1xuXG4gICAgdGhpcy5fc3dhcChsYXJnZXN0LCBjdXJyZW50KTtcbiAgICBjdXJyZW50ID0gbGFyZ2VzdDtcbiAgfVxuXG4gIHJldHVybiBmaXJzdDtcbn07XG5cbi8qKlxuICogRW5xdWV1ZXMgdGhlIGBlbGVtZW50YCBhdCB0aGUgcHJpb3JpdHkgcXVldWUgYW5kIHJldHVybnMgaXRzIG5ldyBzaXplLlxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBlbGVtZW50XG4gKiBAcmV0dXJuIHtOdW1iZXJ9XG4gKiBAYXBpIHB1YmxpY1xuICovXG5Qcmlvcml0eVF1ZXVlLnByb3RvdHlwZS5lbnEgPSBmdW5jdGlvbihlbGVtZW50KSB7XG4gIHZhciBzaXplID0gdGhpcy5fZWxlbWVudHMucHVzaChlbGVtZW50KTtcbiAgdmFyIGN1cnJlbnQgPSBzaXplIC0gMTtcblxuICB3aGlsZSAoY3VycmVudCA+IDApIHtcbiAgICB2YXIgcGFyZW50ID0gTWF0aC5mbG9vcigoY3VycmVudCAtIDEpIC8gMik7XG5cbiAgICBpZiAodGhpcy5fY29tcGFyZShjdXJyZW50LCBwYXJlbnQpIDw9IDApIGJyZWFrO1xuXG4gICAgdGhpcy5fc3dhcChwYXJlbnQsIGN1cnJlbnQpO1xuICAgIGN1cnJlbnQgPSBwYXJlbnQ7XG4gIH1cblxuICByZXR1cm4gc2l6ZTtcbn07XG5cbi8qKlxuICogUmV0dXJucyB0aGUgc2l6ZSBvZiB0aGUgcHJpb3JpdHkgcXVldWUuXG4gKlxuICogQHJldHVybiB7TnVtYmVyfVxuICogQGFwaSBwdWJsaWNcbiAqL1xuUHJpb3JpdHlRdWV1ZS5wcm90b3R5cGUuc2l6ZSA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5fZWxlbWVudHMubGVuZ3RoO1xufTtcblxuLyoqXG4gKiAgSXRlcmF0ZXMgb3ZlciBxdWV1ZSBlbGVtZW50c1xuICpcbiAqICBAcGFyYW0ge0Z1bmN0aW9ufSBmblxuICovXG5Qcmlvcml0eVF1ZXVlLnByb3RvdHlwZS5mb3JFYWNoID0gZnVuY3Rpb24oZm4pIHtcbiAgcmV0dXJuIHRoaXMuX2VsZW1lbnRzLmZvckVhY2goZm4pO1xufTtcblxuLyoqXG4gKiBDb21wYXJlcyB0aGUgdmFsdWVzIGF0IHBvc2l0aW9uIGBhYCBhbmQgYGJgIGluIHRoZSBwcmlvcml0eSBxdWV1ZSB1c2luZyBpdHNcbiAqIGNvbXBhcmF0b3IgZnVuY3Rpb24uXG4gKlxuICogQHBhcmFtIHtOdW1iZXJ9IGFcbiAqIEBwYXJhbSB7TnVtYmVyfSBiXG4gKiBAcmV0dXJuIHtOdW1iZXJ9XG4gKiBAYXBpIHByaXZhdGVcbiAqL1xuUHJpb3JpdHlRdWV1ZS5wcm90b3R5cGUuX2NvbXBhcmUgPSBmdW5jdGlvbihhLCBiKSB7XG4gIHJldHVybiB0aGlzLl9jb21wYXJhdG9yKHRoaXMuX2VsZW1lbnRzW2FdLCB0aGlzLl9lbGVtZW50c1tiXSk7XG59O1xuXG4vKipcbiAqIFN3YXBzIHRoZSB2YWx1ZXMgYXQgcG9zaXRpb24gYGFgIGFuZCBgYmAgaW4gdGhlIHByaW9yaXR5IHF1ZXVlLlxuICpcbiAqIEBwYXJhbSB7TnVtYmVyfSBhXG4gKiBAcGFyYW0ge051bWJlcn0gYlxuICogQGFwaSBwcml2YXRlXG4gKi9cblByaW9yaXR5UXVldWUucHJvdG90eXBlLl9zd2FwID0gZnVuY3Rpb24oYSwgYikge1xuICB2YXIgYXV4ID0gdGhpcy5fZWxlbWVudHNbYV07XG4gIHRoaXMuX2VsZW1lbnRzW2FdID0gdGhpcy5fZWxlbWVudHNbYl07XG4gIHRoaXMuX2VsZW1lbnRzW2JdID0gYXV4O1xufTtcbiIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbnZhciBudWIgPSByZXF1aXJlKCd3aGlzay9udWInKTtcbnZhciBwbHVjayA9IHJlcXVpcmUoJ3doaXNrL3BsdWNrJyk7XG52YXIgZmxhdHRlbiA9IHJlcXVpcmUoJ3doaXNrL2ZsYXR0ZW4nKTtcbnZhciByZUxpbmVCcmVhayA9IC9cXHI/XFxuLztcbnZhciByZVRyYWlsaW5nTmV3bGluZXMgPSAvXFxyP1xcbiQvO1xuXG4vLyBsaXN0IHNkcCBsaW5lIHR5cGVzIHRoYXQgYXJlIG5vdCBcInNpZ25pZmljYW50XCJcbnZhciBub25IZWFkZXJMaW5lcyA9IFsgJ2EnLCAnYycsICdiJywgJ2snIF07XG52YXIgcGFyc2VycyA9IHJlcXVpcmUoJy4vcGFyc2VycycpO1xuXG4vKipcbiAgIyBydGMtc2RwXG5cbiAgVGhpcyBpcyBhIHV0aWxpdHkgbW9kdWxlIGZvciBpbnRlcHJldGluZyBhbmQgcGF0Y2hpbmcgc2RwLlxuXG4gICMjIFVzYWdlXG5cbiAgVGhlIGBydGMtc2RwYCBtYWluIG1vZHVsZSBleHBvc2VzIGEgc2luZ2xlIGZ1bmN0aW9uIHRoYXQgaXMgY2FwYWJsZSBvZlxuICBwYXJzaW5nIGxpbmVzIG9mIFNEUCwgYW5kIHByb3ZpZGluZyBhbiBvYmplY3QgYWxsb3dpbmcgeW91IHRvIHBlcmZvcm1cbiAgb3BlcmF0aW9ucyBvbiB0aG9zZSBwYXJzZWQgbGluZXM6XG5cbiAgYGBganNcbiAgdmFyIHNkcCA9IHJlcXVpcmUoJ3J0Yy1zZHAnKShsaW5lcyk7XG4gIGBgYFxuXG4gIFRoZSBjdXJyZW50bHkgc3VwcG9ydGVkIG9wZXJhdGlvbnMgYXJlIGxpc3RlZCBiZWxvdzpcblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHNkcCkge1xuICB2YXIgb3BzID0ge307XG4gIHZhciBwYXJzZWQgPSBbXTtcbiAgdmFyIGFjdGl2ZUNvbGxlY3RvcjtcblxuICAvLyBpbml0aWFsaXNlIHRoZSBsaW5lc1xuICB2YXIgbGluZXMgPSBzZHAuc3BsaXQocmVMaW5lQnJlYWspLmZpbHRlcihCb29sZWFuKS5tYXAoZnVuY3Rpb24obGluZSkge1xuICAgIHJldHVybiBsaW5lLnNwbGl0KCc9Jyk7XG4gIH0pO1xuXG4gIHZhciBpbnB1dE9yZGVyID0gbnViKGxpbmVzLmZpbHRlcihmdW5jdGlvbihsaW5lKSB7XG4gICAgcmV0dXJuIGxpbmVbMF0gJiYgbm9uSGVhZGVyTGluZXMuaW5kZXhPZihsaW5lWzBdKSA8IDA7XG4gIH0pLm1hcChwbHVjaygwKSkpO1xuXG4gIHZhciBmaW5kTGluZSA9IG9wcy5maW5kTGluZSA9IGZ1bmN0aW9uKHR5cGUsIGluZGV4KSB7XG4gICAgdmFyIGxpbmVEYXRhID0gcGFyc2VkLmZpbHRlcihmdW5jdGlvbihsaW5lKSB7XG4gICAgICByZXR1cm4gbGluZVswXSA9PT0gdHlwZTtcbiAgICB9KVtpbmRleCB8fCAwXTtcblxuICAgIHJldHVybiBsaW5lRGF0YSAmJiBsaW5lRGF0YVsxXTtcbiAgfTtcblxuICAvLyBwdXNoIGludG8gcGFyc2VkIHNlY3Rpb25zXG4gIGxpbmVzLmZvckVhY2goZnVuY3Rpb24obGluZSkge1xuICAgIHZhciBjdXN0b21QYXJzZXIgPSBwYXJzZXJzW2xpbmVbMF1dO1xuXG4gICAgaWYgKGN1c3RvbVBhcnNlcikge1xuICAgICAgYWN0aXZlQ29sbGVjdG9yID0gY3VzdG9tUGFyc2VyKHBhcnNlZCwgbGluZSk7XG4gICAgfVxuICAgIGVsc2UgaWYgKGFjdGl2ZUNvbGxlY3Rvcikge1xuICAgICAgYWN0aXZlQ29sbGVjdG9yID0gYWN0aXZlQ29sbGVjdG9yKGxpbmUpO1xuICAgIH1cbiAgICBlbHNlIHtcbiAgICAgIHBhcnNlZC5wdXNoKGxpbmUpO1xuICAgIH1cbiAgfSk7XG5cbiAgLyoqXG4gICAgIyMjIGBzZHAuYWRkSWNlQ2FuZGlkYXRlKGRhdGEpYFxuXG4gICAgTW9kaWZ5IHRoZSBzZHAgdG8gaW5jbHVkZSBjYW5kaWRhdGVzIGFzIGRlbm90ZWQgYnkgdGhlIGRhdGEuXG5cbioqL1xuICBvcHMuYWRkSWNlQ2FuZGlkYXRlID0gZnVuY3Rpb24oZGF0YSkge1xuICAgIHZhciBsaW5lSW5kZXggPSAoZGF0YSB8fCB7fSkubGluZUluZGV4IHx8IChkYXRhIHx8IHt9KS5zZHBNTGluZUluZGV4O1xuICAgIHZhciBtTGluZSA9IHR5cGVvZiBsaW5lSW5kZXggIT0gJ3VuZGVmaW5lZCcgJiYgZmluZExpbmUoJ20nLCBsaW5lSW5kZXgpO1xuICAgIHZhciBjYW5kaWRhdGUgPSAoZGF0YSB8fCB7fSkuY2FuZGlkYXRlO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSB0aGUgbUxpbmUgYWRkIHRoZSBuZXcgY2FuZGlkYXRlXG4gICAgaWYgKG1MaW5lICYmIGNhbmRpZGF0ZSkge1xuICAgICAgbUxpbmUuY2hpbGRsaW5lcy5wdXNoKGNhbmRpZGF0ZS5yZXBsYWNlKHJlVHJhaWxpbmdOZXdsaW5lcywgJycpLnNwbGl0KCc9JykpO1xuICAgIH1cbiAgfTtcblxuICAvKipcbiAgICAjIyMgYHNkcC5nZXRNZWRpYVR5cGVzKCkgPT4gW11gXG5cbiAgICBSZXRyaWV2ZSB0aGUgbGlzdCBvZiBtZWRpYSB0eXBlcyB0aGF0IGhhdmUgYmVlbiBkZWZpbmVkIGluIHRoZSBzZHAgdmlhXG4gICAgYG09YCBsaW5lcy5cbiAgKiovXG4gIG9wcy5nZXRNZWRpYVR5cGVzID0gZnVuY3Rpb24oKSB7XG4gICAgZnVuY3Rpb24gZ2V0TWVkaWFUeXBlKGRhdGEpIHtcbiAgICAgIHJldHVybiBkYXRhWzFdLmRlZi5zcGxpdCgvXFxzLylbMF07XG4gICAgfVxuXG4gICAgcmV0dXJuIHBhcnNlZC5maWx0ZXIoZnVuY3Rpb24ocGFydHMpIHtcbiAgICAgIHJldHVybiBwYXJ0c1swXSA9PT0gJ20nICYmIHBhcnRzWzFdICYmIHBhcnRzWzFdLmRlZjtcbiAgICB9KS5tYXAoZ2V0TWVkaWFUeXBlKTtcbiAgfTtcblxuICAvKipcbiAgICAjIyMgYHNkcC50b1N0cmluZygpYFxuXG4gICAgQ29udmVydCB0aGUgU0RQIHN0cnVjdHVyZSB0aGF0IGlzIGN1cnJlbnRseSByZXRhaW5lZCBpbiBtZW1vcnksIGludG8gYSBzdHJpbmdcbiAgICB0aGF0IGNhbiBiZSBwcm92aWRlZCB0byBhIGBzZXRMb2NhbERlc2NyaXB0aW9uYCAob3IgYHNldFJlbW90ZURlc2NyaXB0aW9uYClcbiAgICBXZWJSVEMgY2FsbC5cblxuICAqKi9cbiAgb3BzLnRvU3RyaW5nID0gZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHBhcnNlZC5tYXAoZnVuY3Rpb24obGluZSkge1xuICAgICAgcmV0dXJuIHR5cGVvZiBsaW5lWzFdLnRvQXJyYXkgPT0gJ2Z1bmN0aW9uJyA/IGxpbmVbMV0udG9BcnJheSgpIDogWyBsaW5lIF07XG4gICAgfSkucmVkdWNlKGZsYXR0ZW4pLm1hcChmdW5jdGlvbihsaW5lKSB7XG4gICAgICByZXR1cm4gbGluZS5qb2luKCc9Jyk7XG4gICAgfSkuam9pbignXFxuJyk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMgU0RQIEZpbHRlcmluZyAvIE11bmdpbmcgRnVuY3Rpb25zXG5cbiAgICBUaGVyZSBhcmUgYWRkaXRpb25hbCBmdW5jdGlvbnMgaW5jbHVkZWQgaW4gdGhlIG1vZHVsZSB0byBhc3NpZ24gd2l0aFxuICAgIHBlcmZvcm1pbmcgXCJzaW5nbGUtc2hvdFwiIFNEUCBmaWx0ZXJpbmcgKG9yIG11bmdpbmcpIG9wZXJhdGlvbnM6XG5cbiAgKiovXG5cbiAgcmV0dXJuIG9wcztcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG5leHBvcnRzLm0gPSBmdW5jdGlvbihwYXJzZWQsIGxpbmUpIHtcbiAgdmFyIG1lZGlhID0ge1xuICAgIGRlZjogbGluZVsxXSxcbiAgICBjaGlsZGxpbmVzOiBbXSxcblxuICAgIHRvQXJyYXk6IGZ1bmN0aW9uKCkge1xuICAgICAgcmV0dXJuIFtcbiAgICAgICAgWydtJywgbWVkaWEuZGVmIF1cbiAgICAgIF0uY29uY2F0KG1lZGlhLmNoaWxkbGluZXMpO1xuICAgIH1cbiAgfTtcblxuICBmdW5jdGlvbiBhZGRDaGlsZExpbmUoY2hpbGRMaW5lKSB7XG4gICAgbWVkaWEuY2hpbGRsaW5lcy5wdXNoKGNoaWxkTGluZSk7XG4gICAgcmV0dXJuIGFkZENoaWxkTGluZTtcbiAgfVxuXG4gIHBhcnNlZC5wdXNoKFsgJ20nLCBtZWRpYSBdKTtcblxuICByZXR1cm4gYWRkQ2hpbGRMaW5lO1xufTsiLCJ2YXIgdmFsaWRhdG9ycyA9IFtcbiAgWyAvXihhXFw9Y2FuZGlkYXRlLiopJC8sIHJlcXVpcmUoJ3J0Yy12YWxpZGF0b3IvY2FuZGlkYXRlJykgXVxuXTtcblxudmFyIHJlU2RwTGluZUJyZWFrID0gLyhcXHI/XFxufFxcXFxyXFxcXG4pLztcblxuLyoqXG4gICMgcnRjLXNkcGNsZWFuXG5cbiAgUmVtb3ZlIGludmFsaWQgbGluZXMgZnJvbSB5b3VyIFNEUC5cblxuICAjIyBXaHk/XG5cbiAgVGhpcyBtb2R1bGUgcmVtb3ZlcyB0aGUgb2NjYXNpb25hbCBcImJhZCBlZ2dcIiB0aGF0IHdpbGwgc2xpcCBpbnRvIFNEUCB3aGVuIGl0XG4gIGlzIGdlbmVyYXRlZCBieSB0aGUgYnJvd3Nlci4gIEluIHBhcnRpY3VsYXIgdGhlc2Ugc2l0dWF0aW9ucyBhcmUgY2F0ZXJlZCBmb3I6XG5cbiAgLSBpbnZhbGlkIElDRSBjYW5kaWRhdGVzXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihpbnB1dCwgb3B0cykge1xuICB2YXIgbGluZUJyZWFrID0gZGV0ZWN0TGluZUJyZWFrKGlucHV0KTtcbiAgdmFyIGxpbmVzID0gaW5wdXQuc3BsaXQobGluZUJyZWFrKTtcbiAgdmFyIGNvbGxlY3RvciA9IChvcHRzIHx8IHt9KS5jb2xsZWN0b3I7XG5cbiAgLy8gZmlsdGVyIG91dCBpbnZhbGlkIGxpbmVzXG4gIGxpbmVzID0gbGluZXMuZmlsdGVyKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAvLyBpdGVyYXRlIHRocm91Z2ggdGhlIHZhbGlkYXRvcnMgYW5kIHVzZSB0aGUgb25lIHRoYXQgbWF0Y2hlc1xuICAgIHZhciB2YWxpZGF0b3IgPSB2YWxpZGF0b3JzLnJlZHVjZShmdW5jdGlvbihtZW1vLCBkYXRhLCBpZHgpIHtcbiAgICAgIHJldHVybiB0eXBlb2YgbWVtbyAhPSAndW5kZWZpbmVkJyA/IG1lbW8gOiAoZGF0YVswXS5leGVjKGxpbmUpICYmIHtcbiAgICAgICAgbGluZTogbGluZS5yZXBsYWNlKGRhdGFbMF0sICckMScpLFxuICAgICAgICBmbjogZGF0YVsxXVxuICAgICAgfSk7XG4gICAgfSwgdW5kZWZpbmVkKTtcblxuICAgIC8vIGlmIHdlIGhhdmUgYSB2YWxpZGF0b3IsIGVuc3VyZSB3ZSBoYXZlIG5vIGVycm9yc1xuICAgIHZhciBlcnJvcnMgPSB2YWxpZGF0b3IgPyB2YWxpZGF0b3IuZm4odmFsaWRhdG9yLmxpbmUpIDogW107XG5cbiAgICAvLyBpZiB3ZSBoYXZlIGVycm9ycyBhbmQgYW4gZXJyb3IgY29sbGVjdG9yLCB0aGVuIGFkZCB0byB0aGUgY29sbGVjdG9yXG4gICAgaWYgKGNvbGxlY3Rvcikge1xuICAgICAgZXJyb3JzLmZvckVhY2goZnVuY3Rpb24oZXJyKSB7XG4gICAgICAgIGNvbGxlY3Rvci5wdXNoKGVycik7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gZXJyb3JzLmxlbmd0aCA9PT0gMDtcbiAgfSk7XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4obGluZUJyZWFrKTtcbn07XG5cbmZ1bmN0aW9uIGRldGVjdExpbmVCcmVhayhpbnB1dCkge1xuICB2YXIgbWF0Y2ggPSByZVNkcExpbmVCcmVhay5leGVjKGlucHV0KTtcblxuICByZXR1cm4gbWF0Y2ggJiYgbWF0Y2hbMF07XG59XG4iLCJ2YXIgZGVidWcgPSByZXF1aXJlKCdjb2cvbG9nZ2VyJykoJ3J0Yy12YWxpZGF0b3InKTtcbnZhciByZVByZWZpeCA9IC9eKD86YT0pP2NhbmRpZGF0ZTovO1xuXG4vKlxuXG52YWxpZGF0aW9uIHJ1bGVzIGFzIHBlcjpcbmh0dHA6Ly90b29scy5pZXRmLm9yZy9odG1sL2RyYWZ0LWlldGYtbW11c2ljLWljZS1zaXAtc2RwLTAzI3NlY3Rpb24tOC4xXG5cbiAgIGNhbmRpZGF0ZS1hdHRyaWJ1dGUgICA9IFwiY2FuZGlkYXRlXCIgXCI6XCIgZm91bmRhdGlvbiBTUCBjb21wb25lbnQtaWQgU1BcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyYW5zcG9ydCBTUFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJpb3JpdHkgU1BcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3Rpb24tYWRkcmVzcyBTUCAgICAgO2Zyb20gUkZDIDQ1NjZcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIHBvcnQgICAgICAgICA7cG9ydCBmcm9tIFJGQyA0NTY2XG4gICAgICAgICAgICAgICAgICAgICAgICAgICBTUCBjYW5kLXR5cGVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIFtTUCByZWwtYWRkcl1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgIFtTUCByZWwtcG9ydF1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICooU1AgZXh0ZW5zaW9uLWF0dC1uYW1lIFNQXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dGVuc2lvbi1hdHQtdmFsdWUpXG5cbiAgIGZvdW5kYXRpb24gICAgICAgICAgICA9IDEqMzJpY2UtY2hhclxuICAgY29tcG9uZW50LWlkICAgICAgICAgID0gMSo1RElHSVRcbiAgIHRyYW5zcG9ydCAgICAgICAgICAgICA9IFwiVURQXCIgLyB0cmFuc3BvcnQtZXh0ZW5zaW9uXG4gICB0cmFuc3BvcnQtZXh0ZW5zaW9uICAgPSB0b2tlbiAgICAgICAgICAgICAgOyBmcm9tIFJGQyAzMjYxXG4gICBwcmlvcml0eSAgICAgICAgICAgICAgPSAxKjEwRElHSVRcbiAgIGNhbmQtdHlwZSAgICAgICAgICAgICA9IFwidHlwXCIgU1AgY2FuZGlkYXRlLXR5cGVzXG4gICBjYW5kaWRhdGUtdHlwZXMgICAgICAgPSBcImhvc3RcIiAvIFwic3JmbHhcIiAvIFwicHJmbHhcIiAvIFwicmVsYXlcIiAvIHRva2VuXG4gICByZWwtYWRkciAgICAgICAgICAgICAgPSBcInJhZGRyXCIgU1AgY29ubmVjdGlvbi1hZGRyZXNzXG4gICByZWwtcG9ydCAgICAgICAgICAgICAgPSBcInJwb3J0XCIgU1AgcG9ydFxuICAgZXh0ZW5zaW9uLWF0dC1uYW1lICAgID0gdG9rZW5cbiAgIGV4dGVuc2lvbi1hdHQtdmFsdWUgICA9ICpWQ0hBUlxuICAgaWNlLWNoYXIgICAgICAgICAgICAgID0gQUxQSEEgLyBESUdJVCAvIFwiK1wiIC8gXCIvXCJcbiovXG52YXIgcGFydFZhbGlkYXRpb24gPSBbXG4gIFsgLy4rLywgJ2ludmFsaWQgZm91bmRhdGlvbiBjb21wb25lbnQnLCAnZm91bmRhdGlvbicgXSxcbiAgWyAvXFxkKy8sICdpbnZhbGlkIGNvbXBvbmVudCBpZCcsICdjb21wb25lbnQtaWQnIF0sXG4gIFsgLyhVRFB8VENQKS9pLCAndHJhbnNwb3J0IG11c3QgYmUgVENQIG9yIFVEUCcsICd0cmFuc3BvcnQnIF0sXG4gIFsgL1xcZCsvLCAnbnVtZXJpYyBwcmlvcml0eSBleHBlY3RlZCcsICdwcmlvcml0eScgXSxcbiAgWyByZXF1aXJlKCdyZXUvaXAnKSwgJ2ludmFsaWQgY29ubmVjdGlvbiBhZGRyZXNzJywgJ2Nvbm5lY3Rpb24tYWRkcmVzcycgXSxcbiAgWyAvXFxkKy8sICdpbnZhbGlkIGNvbm5lY3Rpb24gcG9ydCcsICdjb25uZWN0aW9uLXBvcnQnIF0sXG4gIFsgL3R5cC8sICdFeHBlY3RlZCBcInR5cFwiIGlkZW50aWZpZXInLCAndHlwZSBjbGFzc2lmaWVyJyBdLFxuICBbIC8uKy8sICdJbnZhbGlkIGNhbmRpZGF0ZSB0eXBlIHNwZWNpZmllZCcsICdjYW5kaWRhdGUtdHlwZScgXVxuXTtcblxuLyoqXG4gICMjIyBgcnRjLXZhbGlkYXRvci9jYW5kaWRhdGVgXG5cbiAgVmFsaWRhdGUgdGhhdCBhbiBgUlRDSWNlQ2FuZGlkYXRlYCAob3IgcGxhaW4gb2xkIG9iamVjdCB3aXRoIGRhdGEsIHNkcE1pZCxcbiAgZXRjIGF0dHJpYnV0ZXMpIGlzIGEgdmFsaWQgaWNlIGNhbmRpZGF0ZS5cblxuICBTcGVjcyByZXZpZXdlZCBhcyBwYXJ0IG9mIHRoZSB2YWxpZGF0aW9uIGltcGxlbWVudGF0aW9uOlxuXG4gIC0gPGh0dHA6Ly90b29scy5pZXRmLm9yZy9odG1sL2RyYWZ0LWlldGYtbW11c2ljLWljZS1zaXAtc2RwLTAzI3NlY3Rpb24tOC4xPlxuICAtIDxodHRwOi8vdG9vbHMuaWV0Zi5vcmcvaHRtbC9yZmM1MjQ1PlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oZGF0YSkge1xuICB2YXIgZXJyb3JzID0gW107XG4gIHZhciBjYW5kaWRhdGUgPSBkYXRhICYmIChkYXRhLmNhbmRpZGF0ZSB8fCBkYXRhKTtcbiAgdmFyIHByZWZpeE1hdGNoID0gY2FuZGlkYXRlICYmIHJlUHJlZml4LmV4ZWMoY2FuZGlkYXRlKTtcbiAgdmFyIHBhcnRzID0gcHJlZml4TWF0Y2ggJiYgY2FuZGlkYXRlLnNsaWNlKHByZWZpeE1hdGNoWzBdLmxlbmd0aCkuc3BsaXQoL1xccy8pO1xuXG4gIGlmICghIGNhbmRpZGF0ZSkge1xuICAgIHJldHVybiBbIG5ldyBFcnJvcignZW1wdHkgY2FuZGlkYXRlJykgXTtcbiAgfVxuXG4gIC8vIGNoZWNrIHRoYXQgdGhlIHByZWZpeCBtYXRjaGVzIGV4cGVjdGVkXG4gIGlmICghIHByZWZpeE1hdGNoKSB7XG4gICAgcmV0dXJuIFsgbmV3IEVycm9yKCdjYW5kaWRhdGUgZGlkIG5vdCBtYXRjaCBleHBlY3RlZCBzZHAgbGluZSBmb3JtYXQnKSBdO1xuICB9XG5cbiAgLy8gcGVyZm9ybSB0aGUgcGFydCB2YWxpZGF0aW9uXG4gIGVycm9ycyA9IGVycm9ycy5jb25jYXQocGFydHMubWFwKHZhbGlkYXRlUGFydHMpKS5maWx0ZXIoQm9vbGVhbik7XG5cbiAgcmV0dXJuIGVycm9ycztcbn07XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUGFydHMocGFydCwgaWR4KSB7XG4gIHZhciB2YWxpZGF0b3IgPSBwYXJ0VmFsaWRhdGlvbltpZHhdO1xuXG4gIGlmICh2YWxpZGF0b3IgJiYgKCEgdmFsaWRhdG9yWzBdLnRlc3QocGFydCkpKSB7XG4gICAgZGVidWcodmFsaWRhdG9yWzJdICsgJyBwYXJ0IGZhaWxlZCB2YWxpZGF0aW9uOiAnICsgcGFydCk7XG4gICAgcmV0dXJuIG5ldyBFcnJvcih2YWxpZGF0b3JbMV0pO1xuICB9XG59XG4iLCIvKipcbiAgIyMjIGByZXUvaXBgXG5cbiAgQSByZWd1bGFyIGV4cHJlc3Npb24gdGhhdCB3aWxsIG1hdGNoIGJvdGggSVB2NCBhbmQgSVB2NiBhZGRyZXNzZXMuICBUaGlzIGlzIGEgbW9kaWZpZWRcbiAgcmVnZXggKHJlbW92ZSBob3N0bmFtZSBtYXRjaGluZykgdGhhdCB3YXMgaW1wbGVtZW50ZWQgYnkgQE1pa3VsYXMgaW5cbiAgW3RoaXMgc3RhY2tvdmVyZmxvdyBhbnN3ZXJdKGh0dHA6Ly9zdGFja292ZXJmbG93LmNvbS9hLzkyMDk3MjAvOTY2NTYpLlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gL14oKFswLTldfFsxLTldWzAtOV18MVswLTldezJ9fDJbMC00XVswLTldfDI1WzAtNV0pXFwuKXszfShbMC05XXxbMS05XVswLTldfDFbMC05XXsyfXwyWzAtNF1bMC05XXwyNVswLTVdKSR8Xig/Oig/Oig/Oig/Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTopezZ9KSg/Oig/Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTooPzooPzpbMC05YS1mQS1GXXsxLDR9KSkpfCg/Oig/Oig/Oig/Oig/OjI1WzAtNV18KD86WzEtOV18MVswLTldfDJbMC00XSk/WzAtOV0pKVxcLil7M30oPzooPzoyNVswLTVdfCg/OlsxLTldfDFbMC05XXwyWzAtNF0pP1swLTldKSkpKSkpKXwoPzooPzo6Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTopezV9KSg/Oig/Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTooPzooPzpbMC05YS1mQS1GXXsxLDR9KSkpfCg/Oig/Oig/Oig/Oig/OjI1WzAtNV18KD86WzEtOV18MVswLTldfDJbMC00XSk/WzAtOV0pKVxcLil7M30oPzooPzoyNVswLTVdfCg/OlsxLTldfDFbMC05XXwyWzAtNF0pP1swLTldKSkpKSkpKXwoPzooPzooPzooPzooPzpbMC05YS1mQS1GXXsxLDR9KSkpPzo6KD86KD86KD86WzAtOWEtZkEtRl17MSw0fSkpOil7NH0pKD86KD86KD86KD86KD86WzAtOWEtZkEtRl17MSw0fSkpOig/Oig/OlswLTlhLWZBLUZdezEsNH0pKSl8KD86KD86KD86KD86KD86MjVbMC01XXwoPzpbMS05XXwxWzAtOV18MlswLTRdKT9bMC05XSkpXFwuKXszfSg/Oig/OjI1WzAtNV18KD86WzEtOV18MVswLTldfDJbMC00XSk/WzAtOV0pKSkpKSkpfCg/Oig/Oig/Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTopezAsMX0oPzooPzpbMC05YS1mQS1GXXsxLDR9KSkpPzo6KD86KD86KD86WzAtOWEtZkEtRl17MSw0fSkpOil7M30pKD86KD86KD86KD86KD86WzAtOWEtZkEtRl17MSw0fSkpOig/Oig/OlswLTlhLWZBLUZdezEsNH0pKSl8KD86KD86KD86KD86KD86MjVbMC01XXwoPzpbMS05XXwxWzAtOV18MlswLTRdKT9bMC05XSkpXFwuKXszfSg/Oig/OjI1WzAtNV18KD86WzEtOV18MVswLTldfDJbMC00XSk/WzAtOV0pKSkpKSkpfCg/Oig/Oig/Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTopezAsMn0oPzooPzpbMC05YS1mQS1GXXsxLDR9KSkpPzo6KD86KD86KD86WzAtOWEtZkEtRl17MSw0fSkpOil7Mn0pKD86KD86KD86KD86KD86WzAtOWEtZkEtRl17MSw0fSkpOig/Oig/OlswLTlhLWZBLUZdezEsNH0pKSl8KD86KD86KD86KD86KD86MjVbMC01XXwoPzpbMS05XXwxWzAtOV18MlswLTRdKT9bMC05XSkpXFwuKXszfSg/Oig/OjI1WzAtNV18KD86WzEtOV18MVswLTldfDJbMC00XSk/WzAtOV0pKSkpKSkpfCg/Oig/Oig/Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTopezAsM30oPzooPzpbMC05YS1mQS1GXXsxLDR9KSkpPzo6KD86KD86WzAtOWEtZkEtRl17MSw0fSkpOikoPzooPzooPzooPzooPzpbMC05YS1mQS1GXXsxLDR9KSk6KD86KD86WzAtOWEtZkEtRl17MSw0fSkpKXwoPzooPzooPzooPzooPzoyNVswLTVdfCg/OlsxLTldfDFbMC05XXwyWzAtNF0pP1swLTldKSlcXC4pezN9KD86KD86MjVbMC01XXwoPzpbMS05XXwxWzAtOV18MlswLTRdKT9bMC05XSkpKSkpKSl8KD86KD86KD86KD86KD86KD86WzAtOWEtZkEtRl17MSw0fSkpOil7MCw0fSg/Oig/OlswLTlhLWZBLUZdezEsNH0pKSk/OjopKD86KD86KD86KD86KD86WzAtOWEtZkEtRl17MSw0fSkpOig/Oig/OlswLTlhLWZBLUZdezEsNH0pKSl8KD86KD86KD86KD86KD86MjVbMC01XXwoPzpbMS05XXwxWzAtOV18MlswLTRdKT9bMC05XSkpXFwuKXszfSg/Oig/OjI1WzAtNV18KD86WzEtOV18MVswLTldfDJbMC00XSk/WzAtOV0pKSkpKSkpfCg/Oig/Oig/Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTopezAsNX0oPzooPzpbMC05YS1mQS1GXXsxLDR9KSkpPzo6KSg/Oig/OlswLTlhLWZBLUZdezEsNH0pKSl8KD86KD86KD86KD86KD86KD86WzAtOWEtZkEtRl17MSw0fSkpOil7MCw2fSg/Oig/OlswLTlhLWZBLUZdezEsNH0pKSk/OjopKSkpJC87XG4iLCJtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKGEsIGIpIHtcbiAgcmV0dXJuIGFyZ3VtZW50cy5sZW5ndGggPiAxID8gYSA9PT0gYiA6IGZ1bmN0aW9uKGIpIHtcbiAgICByZXR1cm4gYSA9PT0gYjtcbiAgfTtcbn07XG4iLCIvKipcbiAgIyMgZmxhdHRlblxuXG4gIEZsYXR0ZW4gYW4gYXJyYXkgdXNpbmcgYFtdLnJlZHVjZWBcblxuICA8PDwgZXhhbXBsZXMvZmxhdHRlbi5qc1xuXG4qKi9cblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihhLCBiKSB7XG4gIC8vIGlmIGEgaXMgbm90IGFscmVhZHkgYW4gYXJyYXksIG1ha2UgaXQgb25lXG4gIGEgPSBBcnJheS5pc0FycmF5KGEpID8gYSA6IFthXTtcblxuICAvLyBjb25jYXQgYiB3aXRoIGFcbiAgcmV0dXJuIGEuY29uY2F0KGIpO1xufTsiLCJtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKGNvbXBhcmF0b3IpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uKGlucHV0KSB7XG4gICAgdmFyIG91dHB1dCA9IFtdO1xuICAgIGZvciAodmFyIGlpID0gMCwgY291bnQgPSBpbnB1dC5sZW5ndGg7IGlpIDwgY291bnQ7IGlpKyspIHtcbiAgICAgIHZhciBmb3VuZCA9IGZhbHNlO1xuICAgICAgZm9yICh2YXIgamogPSBvdXRwdXQubGVuZ3RoOyBqai0tOyApIHtcbiAgICAgICAgZm91bmQgPSBmb3VuZCB8fCBjb21wYXJhdG9yKGlucHV0W2lpXSwgb3V0cHV0W2pqXSk7XG4gICAgICB9XG5cbiAgICAgIGlmIChmb3VuZCkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgb3V0cHV0W291dHB1dC5sZW5ndGhdID0gaW5wdXRbaWldO1xuICAgIH1cblxuICAgIHJldHVybiBvdXRwdXQ7XG4gIH07XG59IiwiLyoqXG4gICMjIG51YlxuXG4gIFJldHVybiBvbmx5IHRoZSB1bmlxdWUgZWxlbWVudHMgb2YgdGhlIGxpc3QuXG5cbiAgPDw8IGV4YW1wbGVzL251Yi5qc1xuXG4qKi9cblxubW9kdWxlLmV4cG9ydHMgPSByZXF1aXJlKCcuL251Yi1ieScpKHJlcXVpcmUoJy4vZXF1YWxpdHknKSk7IiwiLyoqXG4gICMjIHBsdWNrXG5cbiAgRXh0cmFjdCB0YXJnZXRlZCBwcm9wZXJ0aWVzIGZyb20gYSBzb3VyY2Ugb2JqZWN0LiBXaGVuIGEgc2luZ2xlIHByb3BlcnR5XG4gIHZhbHVlIGlzIHJlcXVlc3RlZCwgdGhlbiBqdXN0IHRoYXQgdmFsdWUgaXMgcmV0dXJuZWQuXG5cbiAgSW4gdGhlIGNhc2Ugd2hlcmUgbXVsdGlwbGUgcHJvcGVydGllcyBhcmUgcmVxdWVzdGVkIChpbiBhIHZhcmFyZ3MgY2FsbGluZ1xuICBzdHlsZSkgYSBuZXcgb2JqZWN0IHdpbGwgYmUgY3JlYXRlZCB3aXRoIHRoZSByZXF1ZXN0ZWQgcHJvcGVydGllcyBjb3BpZWRcbiAgYWNyb3NzLlxuXG4gIF9fTk9URTpfXyBJbiB0aGUgc2Vjb25kIGZvcm0gZXh0cmFjdGlvbiBvZiBuZXN0ZWQgcHJvcGVydGllcyBpc1xuICBub3Qgc3VwcG9ydGVkLlxuXG4gIDw8PCBleGFtcGxlcy9wbHVjay5qc1xuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oKSB7XG4gIHZhciBmaWVsZHMgPSBbXTtcblxuICBmdW5jdGlvbiBleHRyYWN0b3IocGFydHMsIG1heElkeCkge1xuICAgIHJldHVybiBmdW5jdGlvbihpdGVtKSB7XG4gICAgICB2YXIgcGFydElkeCA9IDA7XG4gICAgICB2YXIgdmFsID0gaXRlbTtcblxuICAgICAgZG8ge1xuICAgICAgICB2YWwgPSB2YWwgJiYgdmFsW3BhcnRzW3BhcnRJZHgrK11dO1xuICAgICAgfSB3aGlsZSAodmFsICYmIHBhcnRJZHggPD0gbWF4SWR4KTtcblxuICAgICAgcmV0dXJuIHZhbDtcbiAgICB9O1xuICB9XG5cbiAgW10uc2xpY2UuY2FsbChhcmd1bWVudHMpLmZvckVhY2goZnVuY3Rpb24ocGF0aCkge1xuICAgIHZhciBwYXJ0cyA9IHR5cGVvZiBwYXRoID09ICdudW1iZXInID8gWyBwYXRoIF0gOiAocGF0aCB8fCAnJykuc3BsaXQoJy4nKTtcblxuICAgIGZpZWxkc1tmaWVsZHMubGVuZ3RoXSA9IHtcbiAgICAgIG5hbWU6IHBhcnRzWzBdLFxuICAgICAgcGFydHM6IHBhcnRzLFxuICAgICAgbWF4SWR4OiBwYXJ0cy5sZW5ndGggLSAxXG4gICAgfTtcbiAgfSk7XG5cbiAgaWYgKGZpZWxkcy5sZW5ndGggPD0gMSkge1xuICAgIHJldHVybiBleHRyYWN0b3IoZmllbGRzWzBdLnBhcnRzLCBmaWVsZHNbMF0ubWF4SWR4KTtcbiAgfVxuICBlbHNlIHtcbiAgICByZXR1cm4gZnVuY3Rpb24oaXRlbSkge1xuICAgICAgdmFyIGRhdGEgPSB7fTtcblxuICAgICAgZm9yICh2YXIgaWkgPSAwLCBsZW4gPSBmaWVsZHMubGVuZ3RoOyBpaSA8IGxlbjsgaWkrKykge1xuICAgICAgICBkYXRhW2ZpZWxkc1tpaV0ubmFtZV0gPSBleHRyYWN0b3IoW2ZpZWxkc1tpaV0ucGFydHNbMF1dLCAwKShpdGVtKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGRhdGE7XG4gICAgfTtcbiAgfVxufTsiXX0=
