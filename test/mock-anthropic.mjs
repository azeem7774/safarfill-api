import http from 'node:http';
let n = 0;
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c); req.on('end', () => {
    n++;
    const j = JSON.parse(body);
    if (j.messages[0].content[0].source.data.endsWith('bad')) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } })); }
    const ok = req.headers['x-api-key'] === 'sk-test' && j.messages[0].content[0].source.data === 'QUJDREVGR0hJSktMTU5PUFFS';
    res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { content: [{ type: 'tool_use', name: 'record_passport', input: { surname: 'AHMAD', model: j.model } }], usage: { input_tokens: 1500, output_tokens: 300 } } : { error: { message: 'bad mock request' } }));
  });
}).listen(8799, () => console.log('mock up'));
