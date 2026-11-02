import test from 'node:test';
import assert from 'node:assert/strict';
import {sitePage} from '../src/site-page.mjs';
test('a configured site name cannot terminate the embedded settings script',()=>{
 const page=sitePage('<html><head></head><body></body></html>',{siteName:'</script><img src=x onerror=alert(1)>',language:'en'});
 assert(page.includes('\\u003c/script>'));
 assert(!page.includes('<img src=x'));
 assert(page.includes('window.QUIZ_SITE='));
});
