import assert from 'node:assert/strict';
import {test} from 'node:test';
import {saveBlob, dataUrlBlob} from '../web/native-downloads.js';

function fixture(cancel = false, fail = false) {
  const messages = [];
  const bridge = {
    onmessage: null,
    postMessage(raw) {
      const msg = JSON.parse(raw);
      messages.push(msg);
      if (msg.action === 'abort') return;
      let status = {begin:cancel?'cancel':'ready',chunk:fail?'error':'ack',finish:'saved'}[msg.action];
      queueMicrotask(() => this.onmessage?.({data:JSON.stringify({id:msg.id,status,message:fail?'fixture failure':undefined})}));
    },
  };
  globalThis.MemoryMapNativeDownloads = bridge;
  return messages;
}

test('native save streams exact bytes in bounded acknowledged chunks, with safe name', async () => {
  const messages = fixture();
  const bytes = Uint8Array.from({length: 120_005}, (_, i) => i % 256);
  try {
    assert.equal(await saveBlob(new Blob([bytes], {type:'application/octet-stream'}), '../data.bin'), true);
    assert.equal(messages[0].action,'begin');
    assert.equal(messages[0].size,bytes.length);
    assert.equal(messages[0].name,'.._data.bin');
    const chunks = messages.filter(m=>m.action==='chunk');
    assert.equal(chunks.length,3);
    assert.deepEqual(chunks.map(x=>x.offset),[0,49152,98304]);
    assert.deepEqual(Buffer.concat(chunks.map(c=>Buffer.from(c.data,'base64'))),Buffer.from(bytes));
    assert.equal(messages.at(-1).action,'finish');
  } finally { delete globalThis.MemoryMapNativeDownloads; }
});

test('cancel does not write bytes; native failures abort and allow retry', async () => {
  try {
    const canceled = fixture(true);
    assert.equal(await saveBlob(new Blob(['no write']),'test.txt'),false);
    assert.equal(canceled.length,1);
    const failed = fixture(false,true);
    await assert.rejects(saveBlob(new Blob(['failure']),'test.txt'),/fixture failure/);
    assert.equal(failed.at(-1).action,'abort');
    fixture();
    assert.equal(await saveBlob(new Blob([]),'empty.txt'),true);
  } finally { delete globalThis.MemoryMapNativeDownloads; }
});

test('exported graph data URL is decoded to original bytes', async () => {
  const blob = dataUrlBlob('data:image/png;base64,AAEC/w==');
  assert.equal(blob.type,'image/png');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())],[0,1,2,255]);
  assert.throws(()=>dataUrlBlob('https://example.org/asset'));
});
