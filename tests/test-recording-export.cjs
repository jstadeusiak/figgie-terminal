const assert = require('node:assert/strict');
const { RecordStore } = require('../extension/record-store.js');
const { read } = require('../extension/recording-export.js');
const { start, db } = require('./background-harness.cjs');
(async () => {
  const store = new RecordStore();
  const round = { id: 'round-export', seq: 1 };
  const event = { id: 'e1', roundId: round.id, seq: 1, kind: 'snapshot', note: '🂡♠♥'.repeat(250) };
  const rating = { id: 'rating', kind: 'rating_observation', at: 1 };
  store.flush = async () => {};
  store.all = async (name) => (name === 'rounds' ? [round] : [rating]);
  store.events = async () => [event, { id: 'future', seq: 2 }];
  const parts = [];
  for await (const chunk of store.exportChunks(round.id, 101)) {
    assert(chunk.length <= 101);
    assert(!/[\uD800-\uDBFF]$/.test(chunk), 'UTF-16 pair stays together for Blob encoding');
    parts.push(chunk);
  }
  const text = await new Blob(parts).text();
  const rows = text.trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].version, require('../extension/manifest.json').version);
  assert.equal(rows[0].modelVersion, require('../extension/belief.js').VERSION);
  assert.deepEqual(rows[2], event);
  assert.deepEqual(rows[3], rating);
  assert.equal(rows.length, 4, 'export freezes the metadata event prefix');
  await assert.rejects(async () => {
    for await (const _ of store.exportChunks('missing')) {
    }
  }, /not found/);
  // Exercise more than Chrome's 64MiB single-message ceiling through the real
  // worker protocol. Every individual message stays bounded; data is complete.
  db.rounds.set(round.id, { ...round, seq: 70 });
  const payload = 'x'.repeat(1024 * 1024);
  for (let i = 1; i <= 70; i++)
    db.events.set('e' + i, { id: 'e' + i, roundId: round.id, seq: i, payload });
  let now = 1000;
  const send = start({ now: () => now });
  const request = async (m) => {
    const r = await send(m);
    if (r.error) throw Error(r.error);
    return r;
  };
  const archive = await read(request, 'all');
  assert(archive.parts.length > 256);
  assert(archive.parts.every((p) => p.length <= 262144));
  const total = archive.parts.reduce((n, p) => n + p.length, 0);
  assert(total > 64 * 1024 * 1024);
  const parsed = archive.parts.join('').trim().split('\n').map(JSON.parse);
  assert.equal(parsed.length, 72);
  assert.equal(parsed.at(-1).seq, 70);
  assert.equal(parsed.at(-1).payload.length, payload.length);
  const job = await request({ type: 'figgie-export-start', roundId: 'all' });
  const a = await request({ type: 'figgie-export-chunk', exportId: job.exportId, index: 0 });
  assert.deepEqual(
    await request({ type: 'figgie-export-chunk', exportId: job.exportId, index: 0 }),
    a,
    'retry returns same chunk',
  );
  await assert.rejects(
    request({ type: 'figgie-export-chunk', exportId: job.exportId, index: 3 }),
    /position changed/,
  );
  const foreign = await send(
    { type: 'figgie-export-chunk', exportId: job.exportId, index: 1 },
    { id: 'test', tab: { id: 7, url: 'https://www.figgie.com/play/' } },
  );
  assert.match(foreign.error, /expired/);
  now += 300001;
  await assert.rejects(
    request({ type: 'figgie-export-chunk', exportId: job.exportId, index: 1 }),
    /expired/,
  );
  let closed = false;
  await assert.rejects(
    read(
      async (m) =>
        m.type === 'figgie-export-start'
          ? { exportId: 'broken', filename: 'x' }
          : m.type === 'figgie-export-close'
            ? ((closed = true), {})
            : { index: 5, text: 'bad', done: true },
      'all',
    ),
    /Incomplete/,
  );
  assert(closed, 'failure closes session without a partial download');
  const rejected = await send(
    { type: 'figgie-export-start', roundId: 'all' },
    { id: 'wrong', tab: { id: 6, url: 'https://www.figgie.com/play/' } },
  );
  assert(rejected.rejected);
  console.log(
    JSON.stringify({
      bytes: total,
      parts: archive.parts.length,
      unicode: 'lossless',
      prefix: 'consistent',
      protocol: 'retry, position, expiry, sender and tab isolation',
      failure: 'no partial download',
    }),
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
