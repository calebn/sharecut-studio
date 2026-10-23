const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(__dirname + '/2149-transport-bridge.js', 'utf8');

async function test(malformed = false) {
  const run = 'a'.repeat(32), instance = 'fixed-instance', rows = [];
  let condition = 'sham', stopped = false, removed = false, nextPoll, command, epoch = 0;
  let gateTimer = 120000;
  const logs = [], payloads = [], chunks = [];
  const gate = {
    export: () => ({ condition, stopReason: removed ? 'removed' : null, touchCount: 0,
      activePointerIds: [], rows, metadata: { original: true } }),
    mark: (label) => rows.push({ kind: 'mark', label, viewport: { scale: 1 } }),
    setCondition: (value) => { condition = value; },
    remove: () => { removed = true; condition = 'stopped'; delete context.window.__sharecut2149Gate; return gate.export(); },
  };
  rows.push({ kind: 'installed', at: 11 });
  command = { v: 1, run, epoch, prev: null, op: 'export', label: 'ready' };
  const context = {
    window: { __sharecut2149Gate: gate }, location: new URL('http://127.0.0.1:8765/?token=SECRET#PRIVATE'),
    document: { baseURI: 'http://127.0.0.1:8765/?token=SECRET#PRIVATE',
      currentScript: { dataset: { run, command: '/assets/private.json', receipt: '/assets/private.txt' } },
      querySelectorAll: () => [{ querySelectorAll: () => [{ getAttribute: () => 'true' }] }] },
    crypto: { subtle: webcrypto.subtle, randomUUID: () => instance },
    performance: { now: () => 20, timeOrigin: 1000 }, TextEncoder, URL, URLSearchParams,
    AbortSignal, btoa, console: { error: () => { stopped = true; } },
    setTimeout: (fn) => { nextPoll = fn; },
    fetch: async (url) => {
      if (url.pathname.endsWith('.json')) return { status: 200, url: url.href,
        headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(command) };
      logs.push(`INFO: 127.0.0.1:1234 - "GET ${url.pathname}${url.search} HTTP/1.1" 200 OK`);
      const q = url.searchParams;
      if (q.get('k') === 'd') chunks[Number(q.get('i'))] = q.get('b');
      else {
        const body = Buffer.from(chunks.join(''), 'base64url');
        const payload = JSON.parse(body);
        assert.equal(require('node:crypto').createHash('sha256').update(body).digest('hex'), q.get('h'));
        assert.equal(body.length, Number(q.get('l')));
        payloads.push(payload);
        const op = ['mark', 'export', 'remove'][epoch++];
        command = { v: 1, run, epoch, prev: q.get('h'), op, label: op || 'done' };
        if (malformed) command.prev = 'wrong';
        chunks.length = 0;
      }
      return { status: 200, url: url.href };
    },
  };
  vm.runInNewContext(source, context);
  for (let loops = 0; loops < 200 && !removed && !stopped; loops++) {
    await new Promise(setImmediate);
    if (nextPoll) { const fn = nextPoll; nextPoll = null; await fn(); }
  }
  assert.equal(gateTimer, 120000);
  assert.equal(payloads[0].remaining_ms, 119991);
  assert.equal(payloads[0].timeline_pressed, 'true');
  assert(!JSON.stringify(payloads).includes('SECRET'));
  assert(!JSON.stringify(payloads).includes('PRIVATE'));
  assert(payloads.every(p => p.instance === instance));
  if (malformed) { assert(stopped); assert(!removed); assert.equal(condition, 'sham'); }
  else { assert(removed); assert.equal(payloads.length, 4); assert(payloads.at(-1).cleanup); assert(!nextPoll); }
  return logs;
}
(async () => {
  const logs = await test();
  await test(true);
  if (process.argv[2]) fs.writeFileSync(process.argv[2], logs.join('\n') + '\n');
  console.log('PASS synthetic bridge ready/mark/export/remove, receipt hashes, redaction, original clock, stale-chain stop');
})().catch(error => { console.error(error); process.exitCode = 1; });
