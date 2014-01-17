var quickconnect = require('../');
var media = require('rtc-media');
var videoproc = require('rtc-videoproc');
var captureConfig = require('rtc-captureconfig');
// var channelbuffer = require('rtc-channelbuffer');

// create a video processing canvas that will capture an update every second
var canvas = videoproc(document.body, { fps: 1 });
var channels = [];
var images = {};

// capture media and render to the canvas
media({
  constraints: captureConfig('camera max:320x240').toConstraints()
}).render(canvas);

// add the processing options
canvas.pipeline.add(require('rtc-videoproc/filters/grayscale'))

// once the canvas has been updated with the filters applied
// capture the image data from the canvas and send via the data channel
canvas.addEventListener('postprocess', function(evt) {
  var dataUri = canvas.toDataURL('image/jpeg', 0.8);

  channels.forEach(function(channel) {
    channel.send(dataUri);
  })
});

quickconnect('http://rtc.io/switchboard/', { room: 'demo-snaps' })
  // tell quickconnect we want a datachannel called test
  .createDataChannel('snaps')
  // when the test channel is open, let us know
  .on('snaps:open', function(channel, id) {
    channel.onmessage = function(evt) {
      if (images[id]) {
        images[id].src = evt.data;
      }
    };

    // add this data channel to the list of channels
    console.log('detect new channel open for peer: ' + id);
    channels.push(channel);

    // create an image output for this peer
    images[id] = document.createElement('img');
    document.body.appendChild(images[id]);
  })
  // when a peer leaves, clean up their image
  .on('peer:leave', function(id) {
    if (images[id]) {
      document.body.removeChild(images[id]);
      images[id] = undefined;
    }
  });