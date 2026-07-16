// Configurable in-process mock gateway for the integration matrix.
// (Implementation plan section 10.2.) No real credentials, ever.
//
// Behaviors are toggled by the config passed to createMockGateway():
//   protocols:   which upstream endpoints are enabled
//   auth:        { kind:'bearer'|'x-api-key'|'custom-header'|'none', headerName?, secret }
//   models:      the /v1/models catalog to return (array of raw records)
//   failModels:  when true, /v1/models returns 503 (tests last-known-good)
//   etag:        optional etag; honors If-None-Match with 304

import http from 'node:http';

export function createMockGateway(config = {}) {
  const {
    protocols = ['anthropic', 'openai-chat', 'openai-responses'],
    auth = { kind: 'none' },
    models = [{ id: 'claude-opus-4-7' }],
    failModels = false,
    etag = null,
  } = config;

  const has = (p) => protocols.includes(p);
  const captured = []; // records upstream request bodies for assertion

  function authOk(req) {
    if (auth.kind === 'none') return true;
    if (auth.kind === 'bearer') {
      return req.headers['authorization'] === `Bearer ${auth.secret}`;
    }
    if (auth.kind === 'x-api-key') {
      return req.headers['x-api-key'] === auth.secret;
    }
    if (auth.kind === 'custom-header') {
      return req.headers[auth.headerName.toLowerCase()] === auth.secret;
    }
    return false;
  }

  const readBody = (req) =>
    new Promise((resolve) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => resolve(d));
    });

  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };

    if (!authOk(req)) {
      return send(401, { error: { message: 'unauthorized' } });
    }

    if (url.startsWith('/v1/models')) {
      if (failModels) return send(503, { error: { message: 'service unavailable' } });
      if (etag && req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        return res.end();
      }
      return send(200, { data: models }, etag ? { etag } : {});
    }

    if (url.startsWith('/v1/messages')) {
      if (!has('anthropic')) return send(400, { error: { message: 'use the correct endpoint' } });
      const body = JSON.parse((await readBody(req)) || '{}');
      return send(200, {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'anthropic-ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    }

    if (url.startsWith('/v1/chat/completions')) {
      if (!has('openai-chat')) return send(400, { error: { message: 'chat endpoint disabled' } });
      const body = JSON.parse((await readBody(req)) || '{}');
      captured.push({ endpoint: '/v1/chat/completions', body });
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"chat-stream-ok"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      const wantsTool = Array.isArray(body.tools) && body.tools.length;
      const message = wantsTool
        ? { content: null, tool_calls: [{ id: 'tc1', function: { name: body.tools[0].function.name, arguments: '{"value":"hi"}' } }] }
        : { content: 'chat-ok' };
      return send(200, {
        id: 'cmpl_mock',
        model: body.model,
        choices: [{ finish_reason: wantsTool ? 'tool_calls' : 'stop', message }],
        usage: { prompt_tokens: 4, completion_tokens: 6 },
      });
    }

    if (url.startsWith('/v1/responses')) {
      if (!has('openai-responses')) return send(400, { error: { message: 'responses endpoint disabled' } });
      const body = JSON.parse((await readBody(req)) || '{}');
      captured.push({ endpoint: '/v1/responses', body });
      return send(200, {
        id: 'resp_mock',
        model: body.model,
        output_text: body.reasoning ? `responses-ok(effort=${body.reasoning.effort})` : 'responses-ok',
        status: 'completed',
        usage: { input_tokens: 5, output_tokens: 7 },
      });
    }

    return send(404, { error: { message: 'not found' } });
  });

  return {
    server,
    captured,
    lastRequest() {
      return captured[captured.length - 1] || null;
    },
    async listen() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address();
      return `http://127.0.0.1:${port}`;
    },
    async close() {
      await new Promise((r) => server.close(r));
    },
  };
}
