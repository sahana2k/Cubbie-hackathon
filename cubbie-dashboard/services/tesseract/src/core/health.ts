import type { RequestListener } from 'http';

/** No project data or credentials are exposed by this public endpoint. */
export function healthHandler(isReady: () => boolean): RequestListener {
  return (req, res) => {
    if (req.url !== '/health' && req.url !== '/') {
      res.writeHead(404).end();
      return;
    }
    let ready = false;
    try { ready = isReady(); } catch { /* DB or worker unavailable */ }
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: ready ? 'ready' : 'unavailable' }));
  };
}
