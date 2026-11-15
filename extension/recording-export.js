/*
 * Recording export reader. Fetches an NDJSON export from the background worker
 * as a series of bounded extension messages; the requesting page assembles the
 * download from the returned parts. All I/O goes through the `request` function
 * it is given: no storage, network, or DOM access of its own.
 */
(function (scope) {
  'use strict';

  let exportRunning = false;

  async function read(request, roundId) {
    if (exportRunning) throw Error('A recording export is already running.');
    exportRunning = true;
    let exportId;
    try {
      const start = await request({ type: 'figgie-export-start', roundId });
      exportId = start.exportId;
      if (!exportId || typeof start.filename !== 'string') throw Error('Invalid export response');
      const parts = await readChunks(request, exportId);
      return { parts, filename: start.filename };
    } finally {
      if (exportId) await closeExport(request, exportId);
      exportRunning = false;
    }
  }

  // Chunks must arrive complete and in order; anything else abandons the whole
  // export so the page never offers a partial download.
  async function readChunks(request, exportId) {
    const parts = [];
    for (let index = 0; ; index++) {
      const chunk = await request({ type: 'figgie-export-chunk', exportId, index });
      if (!isExpectedChunk(chunk, index)) throw Error('Incomplete recording export. Please retry.');
      if (chunk.text) parts.push(chunk.text);
      if (chunk.done) return parts;
    }
  }

  function isExpectedChunk(chunk, index) {
    return (
      chunk.index === index && typeof chunk.text === 'string' && typeof chunk.done === 'boolean'
    );
  }

  // Closing is a courtesy: the worker also expires sessions that are never
  // closed, so a failure here must not mask the result or the original error.
  async function closeExport(request, exportId) {
    try {
      await request({ type: 'figgie-export-close', exportId });
    } catch {}
  }

  scope.FiggieRecordingExport = { read };
  if (typeof module !== 'undefined') module.exports = { read };
})(globalThis);
