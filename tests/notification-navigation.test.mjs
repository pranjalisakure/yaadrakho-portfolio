import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
const origin='https://app.example.test';
async function click(clients,data={url:'/?customer=42'},action='') {
 const handlers={}, opened=[];let pending,closed=false;
 vm.runInNewContext(source,{URL,console,self:{location:{origin},addEventListener:(name,fn)=>handlers[name]=fn,clients:{matchAll:async()=>clients,openWindow:async url=>opened.push(url)}}});
 handlers.notificationclick({action,notification:{data,close:()=>closed=true},waitUntil:p=>pending=p});
 await pending;assert.equal(closed,true);return opened;
}
let focused=0,navigated=[];
assert.deepEqual(await click([{url:origin+'/invoices/5',navigate:async url=>{navigated.push(url);return {focus:async()=>focused++};},focus:async()=>focused++}]),[]);
assert.deepEqual(navigated,[origin+'/?customer=42']);assert.equal(focused,1);
assert.deepEqual(await click([{url:origin+'/?customer=42',focus:async()=>focused++}]),[]);assert.equal(focused,2);
assert.deepEqual(await click([]),[origin+'/?customer=42']);
assert.deepEqual(await click([{url:origin+'/login',navigate:async()=>null,focus:async()=>{throw Error('Must not focus stale page');}}]),[origin+'/?customer=42']);
assert.deepEqual(await click([{url:origin+'/login',navigate:async()=>{throw Error('Tab closed');},focus:async()=>{}}]),[origin+'/?customer=42']);
assert.deepEqual(await click([{url:origin+'.evil.test/',focus:async()=>{throw Error('Foreign origin');}}]),[origin+'/?customer=42']);
assert.deepEqual(await click([],{url:'https://other.example/'}),[origin+'/']);
assert.deepEqual(await click([],{url:'http://['}),[origin+'/']);
assert.deepEqual(await click([],{callUrl:'tel:9999911111'},'call'),['tel:9999911111']);
assert.deepEqual(await click([],{whatsappUrl:'https://wa.me/919999911111'},'whatsapp'),['https://wa.me/919999911111']);
console.log('Notification navigation passed: existing tab, exact target, new window, failed navigation, origin guard and call/WhatsApp actions.');
