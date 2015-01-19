var quickconnect = require('../');
var media = require('rtc-media');
var crel = require('crel');

// create containers for our local and remote video
var local = crel('div', { class: 'local' });
var remote = crel('div', { class: 'remote' });

// require('cog/logger').enable('*');

// use quickconnect to connect to the signalling server
var qc = quickconnect('https://switchboard.rtc.io/', {
  room: 'reactive-test',
  expectedLocalStreams: 1
});

// when a new stream is added, then display it in the interface
qc.on('stream:added', function(id, stream) {
  var remoteVideo = crel('video', { id: 'remote_' + id });

  media(stream).render(remoteVideo)
  document.body.appendChild(remoteVideo);
});

// when a stream has been removed, then remove it from the display
qc.on('stream:removed', function(id, stream) {
  var remoteVideo = document.getElementById('remote_' + id);
  if (remoteVideo && remoteVideo.parentNode) {
    remoteVideo.parentNode.removeChild(remoteVideo);
  }
});

// capture media
media()
  // when media is captured broadcast the stream
  .once('capture', qc.addStream)
  // render to the local video display
  .render(local);

/* extra code to handle dynamic html and css creation */

// add some basic styling
document.head.appendChild(crel('style', [
  '.local { position: absolute;  right: 10px; }',
  '.local video { max-width: 200px; }'
].join('\n')));

// add the local and remote elements
document.body.appendChild(local);
document.body.appendChild(remote);
