var quickconnect = require('../');
var crel = require('crel');
var getUserMedia = require('getusermedia');
var attachmediastream = require('attachmediastream');
var qsa = require('fdom/qsa');

// create containers for our local and remote video
var local = crel('div', { class: 'local' });
var remote = crel('div', { class: 'remote' });
var peerMedia = {};

// once media is captured, connect
getUserMedia({ audio: true, video: true }, function(err, localStream) {
  if (err) {
    return console.error('could not capture media: ', err);
  }

  // render the local media
  local.appendChild(attachmediastream(localStream));

  // initiate connection
  quickconnect('https://switchboard.rtc.io/', { room: 'conftest' })
    // broadcast our captured media to other participants in the room
    .addStream(localStream)
    // when a peer is connected (and active) pass it to us for use
    .on('call:started', function(id, pc, data) {
      var videos = pc.getRemoteStreams().map(attachmediastream);
      videos.forEach(function(video) {
        video.dataset.peer = id;
        remote.appendChild(video);
      });
    })
    // when a peer leaves, remove teh media
    .on('call:ended', function(id) {
      qsa('*[data-peer="' + id + '"]', remote).forEach(function(el) {
        el.parentNode.removeChild(el);
      });
    });
});

/* extra code to handle dynamic html and css creation */

// add some basic styling
document.head.appendChild(crel('style', [
  '.local { position: absolute;  right: 10px; }',
  '.local video { max-width: 200px; }'
].join('\n')));

// add the local and remote elements
document.body.appendChild(local);
document.body.appendChild(remote);
