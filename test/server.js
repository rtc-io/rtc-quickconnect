var http = require('http');
var server = http.createServer();
var port = process.env.ZUUL_PORT || process.env.PORT;
var switchboard = require('rtc-switchboard')(server, { servelib: true });

server.listen(parseInt(port, 10) || 3000);