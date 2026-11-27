import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8').split('<script>')[1].split('</script>')[0];
const root = 'https://github.com/N-Muhammadjonov/memory-map/releases/download/v39/';
const digest = 'sha256:' + 'a'.repeat(64);
const names = ['MemoryMap-windows-x64.exe', 'MemoryMap-macos-arm64.dmg', 'MemoryMap-macos-x64.dmg',
  'MemoryMap-linux-x64.tar.gz', 'MemoryMap-linux-arm64.tar.gz', 'MemoryMap-android.apk'];
const assets = names.map(name => ({name, state:'uploaded', digest, size:1048576, browser_download_url:root+name}));
class Node {
  constructor(tag='div') { this.tag=tag; this.children=[]; this.textContent=''; this.href=''; }
  append(...items) { this.children.push(...items); }
}
async function render(userAgent, release, candidates = []) {
  const elements = new Map([['main-download',new Node('a')],['release-status',new Node()],['all',new Node()]]);
  elements.get('main-download').textContent='Choose your download';
  elements.get('main-download').href='#downloads';
  const document = {createElement: tag=>new Node(tag),getElementById:id=>elements.get(id)};
  await vm.runInNewContext(source, {document,navigator:{userAgent},fetch:async url=>url.endsWith("/latest")?({ok:Boolean(release),status:release?200:404,json:async()=>release}):({ok:true,status:200,json:async()=>candidates})});
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


test('first published beta is offered without replacing a stable release', async () => {
  const beta = {tag_name:'v39', prerelease:true, draft:false, assets};
  const draft = {...beta,draft:true};
  const rendered = await render('Windows', null, [draft,beta]);
  assert.equal(rendered.get('release-status').textContent,'Public beta: v39');
  assert.equal(rendered.get('main-download').href,root+names[0]);
  const stable = await render('Windows',{tag_name:'v39',assets},[beta]);
  assert.equal(stable.get('release-status').textContent,'Latest release: v39');
});


test('macOS prefers verified DMG for both architectures and falls back to verified legacy ZIP', async () => {
  const legacy = assets.filter(asset => asset.name.endsWith('.dmg')).map(asset => ({...asset,
    name:asset.name.replace(/\.dmg$/,'.zip'), browser_download_url:asset.browser_download_url.replace(/\.dmg$/,'.zip')}));
  const all = await render('Macintosh', {tag_name:'v39', assets:[...legacy,...assets]});
  const links = root => root.get('all').children.flatMap(card=>card.children.filter(child=>child.tag==='a').map(child=>child.href));
  assert.equal(links(all).length,6);
  assert.equal(links(all).filter(href=>href.endsWith('.dmg')).length,2);
  assert.equal(links(all).filter(href=>href.endsWith('.zip')).length,0);
  const fallback = await render('Macintosh', {tag_name:'v39', assets:[...legacy,...assets.map(asset=>asset.name.endsWith('.dmg')?{...asset,digest:''}:asset)]});
  assert.equal(links(fallback).length,6);
  assert.equal(links(fallback).filter(href=>href.endsWith('.zip')).length,2);
});
