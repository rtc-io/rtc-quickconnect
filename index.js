/* jshint node: true */
/* global document, location, Primus */
'use strict';

var EventEmitter = require('events').EventEmitter;
var rtc = require('rtc');
var defaults = require('cog/defaults');
var util = require('util');
var reTrailingSlash = /\/$/;

module.exports = QuickConnect;

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

  ## Full Reactive Stream Conference Example

  <<< examples/conference.js

**/

// QuickConnect inherits from EventEmitter
util.inherits(QuickConnect, EventEmitter);

function QuickConnect(opts) {
  // force instantiation via 'new' keyword
  if (!(this instanceof QuickConnect)) return new QuickConnect(opts);

  // if the opts is a string, then we only have a namespace
  if (typeof opts == 'string' || (opts instanceof String)) {
    opts = { ns: opts };
  }

  // back opts with defaults
  opts = defaults(opts, {
    signaller: 'http://localhost:3000',
    setHashLocation: true,
    hash: location.hash.slice(1) || generateHash(),
    ns: '',
  });

  // configure self
  var self = this;
  self.opts = opts;
  self.peers = {};
  self.hash = opts.hash;
  self.ns = opts.ns;

  // create our logger
  rtc.logger(opts.ns);

  // if debug is enabled, then let's get some noisy logging going
  if (opts.debug) {
    rtc.logger.enable('*');
  }

  // if setHashLocation is enabled, set the url hash location
  if (opts.setHashLocation) {
    location.hash = self.hash;
  }

  // load Primus.js client script
  loadPrimus(opts.signaller, self.onPrimusReady.bind(self));
}

QuickConnect.prototype.onPrimusReady = function onPrimusReady() {
  var self = this;

  // construct room name
  var roomName = self.ns + '#' + self.hash;

  // create our signaller
  var signaller = rtc.signaller(Primus.connect(self.opts.signaller));

  // provide the signaller via an event so it can be used externally
  self.emit('signaller', signaller);

  signaller.on('announce', function(data) {
    // if there is no data, about
    if (! data) return;
    // if this is a known peer, abort
    if (self.peers[data.id]) return;
    // if the room is not a match, abort
    if (data.room !== roomName) return;

    // create a peer
    var peer = self.peers[data.id] = rtc.createConnection(self.opts);

    // if we are working with data channels, create a data channel too
    if (self.opts.data) {
      if (data.answer) {
        peer.addEventListener('datachannel', function(evt) {
          self.bindToDataChannel(data.id, evt.channel);
        });
      } else {
        self.bindToDataChannel(data.id, peer.createDataChannel('tx', { reliable: false }));
      }
    }

    // couple the connections
    var monitor = rtc.couple(peer, { id: data.id }, signaller, self.opts);

    // trigger the peer event
    self.emit('peer', peer, data.id, data, monitor);

    // if not an answer, then announce back to the caller
    if (! data.answer) {
      signaller.to(data.id).announce({
        room: roomName,
        answer: true,
      });
    }
  });

  // pass on leave events
  signaller.on('leave', self.emit.bind(self, 'leave'));

  // time to announce ourselves
  signaller.announce({ room: roomName });
};

QuickConnect.prototype.bindToDataChannel = function bindToDataChannel(peerId, dc) {
  var self = this;

  // wait for channel to open, and then announce it
  dc.addEventListener('open', function(evt) {
    self.emit('dc:open', dc, peerId);
  });
};


// create a random hash
function generateHash() {
  return String(Math.pow(2, 53) * Math.random());
}

// Load appropriate Primus client from remote server
function loadPrimus(url, callback) {
  var script = document.createElement('script');
  script.src = url.replace(reTrailingSlash, '') + '/rtc.io/primus.js';
  script.addEventListener('load', callback);
  document.body.appendChild(script);
}
