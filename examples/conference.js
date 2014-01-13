var quickconnect = require('../');
var crel = require('crel');

// create containers for our local and remote video
var local = crel('div', { class: 'local' });
var remote = crel('div', { class: 'remote' });
var peerMedia = {};

quickconnect('http://rtc.io/switchboard/', { ns: 'dctest' })
  // add some media (use rtc-captureclass) to configure the stream
  .addMedia('camera:0 min:1280x768', function(err, media) {
    media.render(local);
  })
  // when a peer is connected (and active) pass it to us for use
  .on('peer:connect', function(pc, id, data) {
    // render the remote streams
    pc.getRemoteStreams().forEach(renderRemote(id));
  })
  // when a peer leaves, remove teh media
  .on('peer:leave', function(id) {
    // remove media for the target peer from the dom
    (peerMedia[id] || []).splice(0).forEach(function(el) {
      el.parentNode.removeChild(el);
    });
  })

// render a remote video
function renderRemote(id) {
  // create the peer media list
  peerMedia[id] = peerMedia[id] || [];

  return function(stream) {
    peerMedia[id] = peerMedia[id].concat(media(stream).render(remote));
  }
}

/* extra code to handle dynamic html and css creation */

// add some basic styling
document.head.appendChild(crel('style', [
  '.local { position: absolute;  right: 10px; }',
  '.local video { max-width: 200px; }'
].join('\n')));

// add the local and remote elements
document.body.appendChild(local);
document.body.appendChild(remote);