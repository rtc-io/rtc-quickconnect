var isTestling = typeof __testlingConsole != 'undefined';
var remoteSignaller = 'http://rtc.io/switchboard';
// var remoteSignaller = 'http://localhost:3000';

module.exports = {
  signallingServer: isTestling ? location.origin : remoteSignaller
};