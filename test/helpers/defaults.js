var isTestling = typeof __testlingConsole != 'undefined';

module.exports = {
  signallingServer: isTestling ? location.origin : 'http://rtc.io/switchboard'
};