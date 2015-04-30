var media = require('rtc-media');
var quickconnect = require('..');
var webaudio = require('webaudio');
var context = new AudioContext();
var destination = context.createMediaStreamDestination();

var tau = Math.PI * 2;
var frequency = 555;
var signal = webaudio(context, sine);
var gain = webaudio(context, gain);

function sine(time, i){
  return Math.sin(time * tau * frequency)
}

function gain(time, i, inputSample){
  return inputSample * 1 / 4
}

signal.connect(gain);
gain.connect(destination);

quickconnect('http://switchboard.rtc.io', { room: 'audiotest' })
  .addStream(destination.stream)
  .on('call:started', function(id, pc) {
    media(pc.getRemoteStreams()[0]).render(document.body);
  });
