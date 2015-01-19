var quickconnect = require('../');
var media = require('rtc-media');
var videoproc = require('rtc-videoproc');
var bc = require('rtc-bufferedchannel');
var crel = require('crel');

var video = crel('video');
var canvas = crel('canvas');

// initialise capture constraints
var captureConfig = require('rtc-captureconfig');
var constraints = captureConfig('camera max:320x240').toConstraints();

// create a video processing canvas that will capture an update every second
var channels = [];
var processor = videoproc(video, canvas, {
  filters: [ require('rtc-filter-grayscale') ],
  greedy: true,
  fps: 1
});

var images = {};

// capture media and render to the canvas
media({ constraints: constraints }).render(video);

// once the canvas has been updated with the filters applied
// capture the image data from the canvas and send via the data channel
processor.on('frame', function() {
  var dataUri = canvas.toDataURL('image/jpeg', 0.8);

  channels.forEach(function(channel) {
    channel.send(dataUri);
  })
});

quickconnect('https://switchboard.rtc.io/', { room: 'demo-snaps' })
  // tell quickconnect we want a datachannel called test
  .createDataChannel('snaps')
  // when the test channel is open, let us know
  .on('channel:opened:snaps', function(id, dc) {
    var channel = bc(dc);

    channel.on('data', function(data) {
      if (images[id]) {
        images[id].src = data;
      }
    });

    // add this data channel to the list of channels
    console.log('detect new channel open for peer: ' + id);
    channels.push(channel);

    // create an image output for this peer
    images[id] = crel('img');
    document.body.appendChild(images[id]);
  })
  // when a peer leaves, clean up their image
  .on('call:ended', function(id) {
    if (images[id]) {
      document.body.removeChild(images[id]);
      images[id] = undefined;
    }
  });
