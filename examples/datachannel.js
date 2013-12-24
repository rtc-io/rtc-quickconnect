var quickconnect = require('../');
var opts = {
  ns: 'dctest',
  data: true,
  signalhost: 'http://rtc.io/switchboard/'
};

quickconnect(opts)
  .on('peer', function(connection, id, data, monitor) {
    console.log('got a new friend: ' + id, connection);
  })
  .on('dc:open', function(dc, id) {
    dc.addEventListener('message', function(evt) {
      console.log('peer ' + id + ' says: ' + evt.data);
    });

    console.log('dc open for peer: ' + id);
    dc.send('hi');
  });