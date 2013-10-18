/* jshint node: true */
'use strict';

var EventEmitter = require('events').EventEmitter;
var rtc = require('rtc');
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

  <<< examples/conference.js

**/
module.exports = function(opts) {
  var hash = location.hash.slice(1);
  var emitter = new EventEmitter();
  var signaller;
  var logger;
  var peers = {};

  function channel(peerId, dc) {
    dc.addEventListener('open', function(evt) {
      emitter.emit('dc:open', dc, peerId);
    });


  }

  // if the opts is a string, then we only have a namespace
  if (typeof opts == 'string' || (opts instanceof String)) {
    opts = {
      ns: opts
    };
  }

  // initialise the deafult opts
  opts = defaults(opts, {
    signaller: 'http://rtcjs.io:50000'
  });

  // create our logger
  logger = rtc.logger(opts.ns);

  // if debug is enabled, then let's get some noisy logging going
  if (opts.debug) {
    rtc.logger.enable('*');
  }

  // if the hash is not assigned, then create a random hash value
  if (! hash) {
    hash = location.hash = '' + (Math.pow(2, 53) * Math.random());
  }

  // load socket.io script
  loadSocketIO(opts.signaller, function() {
    // create our signaller
    signaller = rtc.signaller(io.connect(opts.signaller), {
      dataEvent: 'message',
      openEvent: 'connect'
    });

    signaller.on('announce', function(data) {
      var peer;
      var dc;

      // if this is a known peer then abort
      if ((! data) || peers[data.id]) {
        return;
      }

      // if the room is not a match, abort
      if (data.room !== (opts.ns + '#' + hash)) {
        return;
      }

      // create a peer
      peer = peers[data.id] = rtc.createConnection(opts);

      // trigger the peer event
      emitter.emit('peer', peer, data.id, data);

      // if we are working with data channels, create a data channel too
      if (opts.data && (! data.answer)) {
        channel(data.id, peer.createDataChannel('tx', { reliable: false }));
      }
      else if (opts.data) {
        peer.addEventListener('datachannel', function(evt) {
          channel(data.id, evt.channel);
        });
      }

      // couple the connections
      rtc.couple(peer, { id: data.id }, signaller, opts);

      // if not an answer, then announce back to the caller
      if (! data.answer) {
        signaller.to(data.id).announce({
          room: opts.ns + '#' + hash,
          answer: true
        });
      }
    });

    // pass on leave events
    signaller.on('leave', emitter.emit.bind(emitter, 'leave'));

    // time to announce ourselves
    signaller.announce({ room: opts.ns + '#' + hash });
  });

  return emitter;
};

function loadSocketIO(url, callback) {
  var script = document.createElement('script');
  script.src = url.replace(reTrailingSlash, '') + '/socket.io/socket.io.js';
  script.addEventListener('load', callback);
  document.body.appendChild(script);
};