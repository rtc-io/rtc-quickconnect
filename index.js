/* jshint node: true */
'use strict';

var EventEmitter = require('events').EventEmitter;
var rtc = require('rtc');

/**
  # rtc-quickconnect

  This is a very high level helper library designed to help you get up
  an running with WebRTC really, really quickly.  By using this module you
  are trading off some flexibility, so if you need a more flexible
  configuration you should drill down into lower level components of the
  [rtc.io](http://www.rtc.io) suite.

  ## Example Usage

  <<< examples/index.js

**/

module.exports = function(namespace, opts) {
  var hash = location.hash.slice(1);
  var emitter = new EventEmitter();

  // if the hash is not assigned, then create a random hash value
  if (! hash) {
    hash = location.hash = '' + (Math.pow(2, 53) * Math.random());
  }

  return emitter;
};