var mbus = require('mbus');

module.exports = function(signaller, opts) {

  opts = opts || {};

  /**
    Creates a new heartbeat
   **/
  function create(id) {

    var heartbeat = mbus();
    var delay = (typeof opts.heartbeat === 'number' ? opts.heartbeat : 2500);
    var ignoreDisconnection = (opts || {}).ignoreDisconnection || false; //if you want to rely on your switchboard to tell if the call is still going
    var timer = null;
    var connected = false;
    var lastping = 0;

    /**
      Pings the target peer
     **/
    function ping() {
      signaller.to(id).send('/ping');
    }

    /**
      Checks the state of the signaller connection
     **/
    function check() {
      var tickInactive = (Date.now() - (delay * 4)); //doesnt always work

      var currentlyConnected = ignoreDisconnection ? ignoreDisconnection : (lastping >= tickInactive);
      // If we have changed connection state, flag the change
      if (connected !== currentlyConnected) {
        heartbeat(currentlyConnected ? 'connected' : 'disconnected');
        heartbeat('signalling:state', currentlyConnected);
        connected = currentlyConnected;
      }
    }

    /**
      Checks the state of the connection, and pings as well
     **/
    function beat() {
      check();
      ping();
    }

    /**
      Starts the heartbeat
     **/
    heartbeat.start = function() {
      if (timer) heartbeat.stop();
      if (delay <= 0) return;

      timer = setInterval(beat, delay);
      beat();
    };

    /**
      Stops the heartbeat
     **/
    heartbeat.stop = function() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    /**
      Registers the receipt on a ping
     **/
    heartbeat.touch = function() {
      lastping = Date.now();
      check();
    };

    /**
      Updates the delay interval
     **/
    heartbeat.updateDelay = function(value) {
      delay = value;
      heartbeat.start();
    };

    heartbeat.start();
    return heartbeat;
  }

  return {
    create: create
  };
};
