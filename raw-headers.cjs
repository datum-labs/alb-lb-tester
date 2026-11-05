// Preloaded with `node --require` (NODE_OPTIONS in Dockerfile.datum) so the
// origin echo can report the request headers exactly as they arrived.
//
// Next fills in X-Forwarded-For, -Host, -Port and -Proto when a request
// doesn't carry them, before a route handler runs. That hides what the proxy
// in front actually sent: a header the proxy dropped would come back filled in
// by Next. This stamps the raw header list onto the request first, as
// x-lbt-received (base64 JSON), overwriting any copy a client sent; whoami
// reads it, and leaves it out of what it echoes.
const http = require('node:http');

const HEADER = 'x-lbt-received';
const emit = http.Server.prototype.emit;

http.Server.prototype.emit = function (event, req, ...rest) {
  if (event === 'request' && req && Array.isArray(req.rawHeaders)) {
    const raw = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() !== HEADER) raw.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
    }
    req.headers[HEADER] = Buffer.from(JSON.stringify(raw)).toString('base64');
  }
  return emit.call(this, event, req, ...rest);
};
