var isTestling = typeof __testlingConsole != 'undefined';
var remoteSignaller = '//switchboard.rtc.io';
// var remoteSignaller = 'http://localhost:3000';

module.exports = {
  signallingServer: require('./signaling-server') // isTestling ? location.origin : remoteSignaller
};
