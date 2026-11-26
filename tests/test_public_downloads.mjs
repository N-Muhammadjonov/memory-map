import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8').split('<script>')[1].split('</script>')[0];
const root = 'https://github.com/N-Muhammadjonov/memory-map/releases/download/v39/';
const digest = 'sha256:' + 'a'.repeat(64);
const names = ['MemoryMap-windows-x64.exe', 'MemoryMap-macos-arm64.zip', 'MemoryMap-macos-x64.zip',
  'MemoryMap-linux-x64.tar.gz', 'MemoryMap-linux-arm64.tar.gz', 'MemoryMap-android.apk'];
const assets = names.map(name => ({name, state:'uploaded', digest, size:1048576, browser_download_url:root+name}));
class Node {
  constructor(tag='div') { this.tag=tag; this.children=[]; this.textContent=''; this.href=''; }
  append(...items) { this.children.push(...items); }
}
async function render(userAgent, release) {
  const elements = new Map([['main-download',new Node('a')],['release-status',new Node()],['all',new Node()]]);
  elements.get('main-download').textContent='Choose your download';
  elements.get('main-download').href='#downloads';
  const document = {createElement: tag=>new Node(tag),getElementById:id=>elements.get(id)};
  await vm.runInNewContext(source, {document,navigator:{userAgent},fetch:async()=>({ok:Boolean(release),json:async()=>release})});
  return elements;
}

test('public portal lists only correctly named verified release assets', async () => {
  const release = {tag_name:'v39', assets:[...assets,{...assets[0],browser_download_url:'https://example.invalid/file.exe'},
    {name:'malicious.exe',size:1,state:'uploaded',digest,browser_download_url:root+'malicious.exe'}]};
  const elements = await render('Windows NT 10.0; Win64; x64', release);
  assert.equal(elements.get('all').children.length,7);
  const links = elements.get('all').children.flatMap(card=>card.children.filter(child=>child.tag==='a').map(child=>child.href));
  assert.deepEqual(links.sort(),assets.map(a=>a.browser_download_url).sort());
  assert.equal(elements.get('main-download').href,root+names[0]);
  const android = await render('Linux; Android 15; Pixel', release);
  assert.equal(android.get('main-download').href,root+names[5]);
  const mac = await render('Macintosh; Intel Mac OS X 10_15_7', release);
  assert.equal(mac.get('main-download').href,'#downloads');
});

test('unpublished releases and missing digests do not advertise downloads', async () => {
  for (const release of [null,{tag_name:'v39',draft:true,assets},{tag_name:'v39',prerelease:true,assets},
    {tag_name:'v39',assets:[{...assets[0],digest:''}]}]) {
    const elements=await render('Windows',release);
    assert.equal(elements.get('all').children.flatMap(card=>card.children.filter(child=>child.tag==='a')).length,0);
  }
});
