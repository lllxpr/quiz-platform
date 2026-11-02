import test from 'node:test';
import assert from 'node:assert/strict';
import {sitePage} from '../src/site-page.mjs';
test('a configured site name cannot terminate the embedded settings script',()=>{
 const page=sitePage('<html><head></head><body></body></html>',{siteName:'</script><img src=x onerror=alert(1)>',language:'en'});
 assert(page.includes('\\u003c/script>'));
 assert(!page.includes('<img src=x'));
 assert(page.includes('window.QUIZ_SITE='));
});

test('localization follows the real page body, preserving awards replay HTML strings',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {Script}=await import('node:vm');
 const admin=await readFile(new URL('../src/admin.html',import.meta.url),'utf8');
 const page=sitePage(admin,{siteName:'繁體答題平台',language:'zh-TW'});
 const scripts=[...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
 for(const [,script] of scripts)new Script(script);
 assert.equal(scripts.length,[...admin.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].length+2);
 assert(page.includes("var labels=traditional?"));
 assert(page.lastIndexOf('var site=window.QUIZ_SITE')>page.indexOf('popup.document.write('));
});
