import http from 'node:http';
import { createRemoteCompanionServer } from '../../apps/remote-companion/src/server.js';

const adapterToken = 'browser-test-adapter-token';
const adapter = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${adapterToken}`) {
    res.writeHead(401); return res.end();
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [
      { id: 'mobile-model', display_name: 'Mobile Test Model', effort_options: [{ id: 'high', name: 'High' }] },
      { id: 'fast-model', display_name: 'Fast Test Model', effort_options: [] },
    ] }));
  }
  if (req.url === '/usage') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ total: { input_tokens: 12, output_tokens: 8 } }));
  }
  if (req.url === '/v1/messages') {
    if (req.headers['x-claude-open-effort'] !== 'high') {
      res.writeHead(409); return res.end();
    }
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const parts = ['Connected', ' through', ' a secure', ' resumable', ' stream.'];
    let index = 0;
    const timer = setInterval(() => {
      if (index >= parts.length) {
        clearInterval(timer);
        return res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      }
      const value = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: parts[index++] } });
      res.write(`event: content_block_delta\ndata: ${value}\n\n`);
    }, 350);
    return;
  }
  res.writeHead(404); res.end();
});

await new Promise((resolve) => adapter.listen(43198, '127.0.0.1', resolve));
const companion = createRemoteCompanionServer({
  adapterBaseUrl: 'http://127.0.0.1:43198',
  clientToken: adapterToken,
  pairingCode: '123456',
});
await companion.listen(43199, '127.0.0.1');
process.stdout.write('companion demo ready\n');

async function stop() {
  await companion.close();
  await new Promise((resolve) => adapter.close(resolve));
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
