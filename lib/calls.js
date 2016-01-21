var rtc = require('rtc-tools');
var debug = rtc.logger('rtc-quickconnect');
var cleanup = require('rtc-tools/cleanup');
var getable = require('cog/getable');

module.exports = function(signaller, opts) {
  var calls = getable({});
  var getPeerData = require('./getpeerdata')(signaller.peers);
  var heartbeats = require('./heartbeat')(signaller, opts);
  var debugPrefix = '[' + signaller.id + '] ';

  function create(id, pc, data) {
    var heartbeat = heartbeats.create(id);
    var call = {
      active: false,
      signalling: false,
      pc: pc,
      channels: getable({}),
      streams: [],
      lastping: Date.now(),
      heartbeat: heartbeat
    };
    calls.set(id, call);

    // Detect changes to the communication with this peer via
    // the signaller
    heartbeat.on('signalling:state', function(connected) {
      call.signalling = connected;
    });

    // Indicate the call creation
    debug(debugPrefix + 'call has been created for ' + id + ' (not yet started)');
    signaller('call:created', id, pc, data);
    return call;
  }

  function createStreamAddHandler(id) {
    return function(evt) {
      debug(debugPrefix + 'peer ' + id + ' added stream');
      updateRemoteStreams(id);
      receiveRemoteStream(id)(evt.stream);
    };
  }

  function createStreamRemoveHandler(id) {
    return function(evt) {
      debug(debugPrefix + 'peer ' + id + ' removed stream');
      updateRemoteStreams(id);
      signaller('stream:removed', id, evt.stream);
    };
  }

  /**
    Failing is invoked when a call in the process of failing, usually as a result
    of a disconnection in the PeerConnection. A connection that is failing can
    be recovered, however, encountering this state does indicate the call is in trouble
   **/
  function failing(id) {
    var call = calls.get(id);
    // If no call exists, do nothing
    if (!call) {
      return;
    }

    debug(debugPrefix + 'call is failing for ' + id);
    signaller('call:failing', id, call && call.pc);
  }

  /**
    Recovered is invoked when a call which was previously failing has recovered. Namely,
    the PeerConnection has been restored by connectivity being reestablished (primary cause
    would probably be network connection drop outs, such as WiFi)
   **/
  function recovered(id) {
    var call = calls.get(id);
    // If no call exists, do nothing
    if (!call) {
      return;
    }

    debug(debugPrefix + 'call has recovered for ' + id);
    signaller('call:recovered', id, call && call.pc);
  }

  function fail(id) {
    var call = calls.get(id);
    // If no call exists, do nothing
    if (!call) {
      return;
    }

    debug(debugPrefix + 'call has failed for ' + id);
    signaller('call:failed', id, call && call.pc);
    end(id);
  }

  function end(id) {
    var call = calls.get(id);

    // if we have no data, then do nothing
    if (! call) {
      return;
    }

    // Stop the heartbeat
    if (call.heartbeat) {
      call.heartbeat.stop();
    }

    // If a monitor is attached, remove all listeners
    if (call.monitor) {
      call.monitor.clear();
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

    // trigger the call:ended event
    debug(debugPrefix + 'call has ended for ' + id);
    signaller('call:ended', id, call.pc);
    signaller('call:' + id + ':ended', call.pc);

    // ensure the peer connection is properly cleaned up
    cleanup(call.pc);
  }

  function ping(sender) {
    var call = calls.get(sender && sender.id);

    // set the last ping for the data
    if (call) {
      call.lastping = Date.now();
      call.heartbeat.touch();
    }
  }

  function receiveRemoteStream(id) {
    return function(stream) {
      signaller('stream:added', id, stream, getPeerData(id));
    };
  }

  function start(id, pc, data) {
    var call = calls.get(id);
    var streams = [].concat(pc.getRemoteStreams());

    // flag the call as active
    call.active = true;
    call.streams = [].concat(pc.getRemoteStreams());

    pc.onaddstream = createStreamAddHandler(id);
    pc.onremovestream = createStreamRemoveHandler(id);

    debug(debugPrefix + ' -> ' + id + ' call start: ' + streams.length + ' streams');
    signaller('call:started', id, pc, data);

    // configure the heartbeat timer
    call.lastping = Date.now();

    // Monitor the heartbeat for signaller disconnection
    call.heartbeat.once('disconnected', function() {
      signaller('call:expired', id, call.pc);
      return end(id);
    });

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
  calls.fail = fail;
  calls.failing = failing;
  calls.ping = ping;
  calls.start = start;
  calls.recovered = recovered;

  return calls;
};
