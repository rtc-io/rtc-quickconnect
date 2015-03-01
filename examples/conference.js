var quickconnect = require('../');
var crel = require('crel');
var capture = require('rtc-capture');
var attach = require('rtc-attach');
var qsa = require('fdom/qsa');
var plugins = [
  require('rtc-plugin-temasys')
];

// create containers for our local and remote video
var local = crel('div', { class: 'local' });
var remote = crel('div', { class: 'remote' });
var peerMedia = {};

// once media is captured, connect
capture({ audio: true, video: true }, { plugins: plugins }, function(err, localStream) {
  if (err) {
    return console.error('could not capture media: ', err);
  }

  // render the local media
  attach(localStream, { plugins: plugins }, function(err, el) {
    local.appendChild(el);
  });

  // initiate connection
  quickconnect('https://switchboard.rtc.io/', { room: 'conftest', plugins: plugins })
    // broadcast our captured media to other participants in the room
    .addStream(localStream)
    // when a peer is connected (and active) pass it to us for use
    .on('call:started', function(id, pc, data) {
      attach(pc.getRemoteStreams()[0], { plugins: plugins }, function(err, el) {
        if (err) return;

        el.dataset.peer = id;
        remote.appendChild(el);
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
