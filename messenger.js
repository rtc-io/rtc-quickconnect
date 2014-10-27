module.exports = function(messenger) {
  if (typeof messenger == 'function') {
    return messenger;
  }

  return require('rtc-switchboard-messenger')(messenger);
};
