import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8').split('<script>')[1].split('</script>')[0];
const root = 'https://github.com/N-Muhammadjonov/memory-map/releases/download/v44/';
const digest = 'sha256:' + 'a'.repeat(64);
const names = ['MemoryMap-windows-x64.exe', 'MemoryMap-macos-arm64.dmg', 'MemoryMap-macos-x64.dmg',
  'MemoryMap-linux-x64.tar.gz', 'MemoryMap-linux-arm64.tar.gz', 'MemoryMap-android.apk'];
const assets = names.map(name => ({name, state:'uploaded', digest, size:1048576, browser_download_url:root+name}));
class Node {
  constructor(tag='div') { this.tag=tag; this.children=[]; this.textContent=''; this.href=''; this.hidden=false; this.events=new Map(); }
  append(...items) { this.children.push(...items); }
  addEventListener(type, fn) { const list=this.events.get(type)||[];list.push(fn);this.events.set(type,list); }
  removeAttribute(name) { this[name]=''; }
  dispatch(type) { const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};for(const f of this.events.get(type)||[])f(event);return event; }
}
async function render(userAgent, release, candidates = []) {
  const elements = new Map([['main-download',new Node('a')],['release-status',new Node()],['all',new Node()]]);
  elements.get('main-download').textContent='Choose your download';elements.get('main-download').href='#downloads';
  const document = {createElement: tag=>new Node(tag),getElementById:id=>elements.get(id)};
  await vm.runInNewContext(source, {document,navigator:{userAgent},fetch:async url=>url.endsWith('/latest')?({ok:Boolean(release),status:release?200:404,json:async()=>release}):({ok:true,status:200,json:async()=>candidates})});
  return elements;
}
const links=e=>e.get('all').children.flatMap(card=>card.children.filter(child=>child.tag==='a'&&!child.hidden&&child.href));
const mac=e=>e.get('all').children.find(card=>card.id==='macos-download');
const selectChip=(e,chip)=>{const select=mac(e).children.find(n=>n.tag==='select');select.value=chip;select.dispatch('change');return mac(e).children.find(n=>n.tag==='a');};

test('public portal lists only correctly named verified release assets', async () => {
  const release = {tag_name:'v44',assets:[...assets,{...assets[0],browser_download_url:'https://example.invalid/file.exe'},
    {name:'malicious.exe',size:1,state:'uploaded',digest,browser_download_url:root+'malicious.exe'}]};
  const elements = await render('Windows NT 10.0; Win64; x64', release);
  assert.equal(elements.get('all').children.length,6);
  assert.deepEqual(links(elements).map(a=>a.href).sort(),[names[0],names[3],names[4],names[5]].map(n=>root+n).sort());
  assert.equal(elements.get('main-download').href,root+names[0]);
  const android = await render('Linux; Android 15; Pixel', release);assert.equal(android.get('main-download').href,root+names[5]);
  const apple = await render('Macintosh; Intel Mac OS X 10_15_7', release);assert.equal(apple.get('main-download').href,'#macos-download');
  assert.equal(apple.get('main-download').textContent,'Choose your Mac chip');
  assert.equal(links(apple).filter(a=>a.href.endsWith('.dmg')).length,0);
});

test('unpublished releases and missing digests do not advertise downloads', async () => {
  for (const release of [null,{tag_name:'v44',draft:true,assets},{tag_name:'v44',prerelease:true,assets},
    {tag_name:'v44',assets:[{...assets[0],digest:''}]}]) {
    const elements=await render('Windows',release);assert.equal(links(elements).length,0);
  }
});

test('first published beta is offered without replacing a stable release', async () => {
  const beta={tag_name:'v44',prerelease:true,draft:false,assets};const draft={...beta,draft:true};
  const rendered=await render('Windows',null,[draft,beta]);assert.equal(rendered.get('release-status').textContent,'Public beta: v44');
  assert.equal(rendered.get('main-download').href,root+names[0]);
  const stable=await render('Windows',{tag_name:'v44',assets},[beta]);assert.equal(stable.get('release-status').textContent,'Latest release: v44');
});

test('macOS selector exposes only one DMG and suppresses repeated clicks', async () => {
  const elements=await render('Macintosh',{tag_name:'v44',assets});
  const first=selectChip(elements,'arm64');assert.equal(first.href,root+names[1]);assert.equal(links(elements).filter(a=>a.href.endsWith('.dmg')).length,1);
  assert.equal(first.dispatch('click').defaultPrevented,false);assert.equal(first.dispatch('click').defaultPrevented,true);
  const second=selectChip(elements,'x64');assert.equal(second,first);assert.equal(second.href,root+names[2]);assert.equal(links(elements).filter(a=>a.href.endsWith('.dmg')).length,1);
  assert.equal(second.dispatch('click').defaultPrevented,false);
  const cleared=selectChip(elements,'');assert.equal(cleared.hidden,true);assert.equal(cleared.href,'');assert.equal(cleared.dispatch('click').defaultPrevented,true);
});

test('macOS prefers verified DMG and falls back to the verified ZIP for the selected chip', async () => {
  const legacy=assets.filter(a=>a.name.endsWith('.dmg')).map(a=>({...a,name:a.name.replace(/\.dmg$/,'.zip'),browser_download_url:a.browser_download_url.replace(/\.dmg$/,'.zip')}));
  const both=await render('Macintosh',{tag_name:'v44',assets:[...legacy,...assets]});assert.equal(selectChip(both,'arm64').href,root+names[1]);
  const fallback=await render('Macintosh',{tag_name:'v44',assets:[...legacy,...assets.map(a=>a.name.endsWith('.dmg')?{...a,digest:''}:a)]});
  assert.equal(selectChip(fallback,'arm64').href,root+names[1].replace(/\.dmg$/,'.zip'));
  assert.equal(selectChip(fallback,'x64').href,root+names[2].replace(/\.dmg$/,'.zip'));
  assert.equal(links(fallback).filter(a=>a.href.endsWith('.zip')).length,1);
});


test('known invalid v43 macOS bundle is not advertised', async () => {
  const oldAssets=assets.map(a=>({...a,browser_download_url:a.browser_download_url.replace('/v44/','/v43/')}));
  const e=await render('Macintosh',{tag_name:'v43',assets:oldAssets});
  assert.equal(mac(e).children.find(n=>n.tag==='select').disabled,true);
  assert.equal(links(e).length,4);
  assert.equal(links(e).filter(a=>a.href.endsWith('.dmg')).length,0);
});
