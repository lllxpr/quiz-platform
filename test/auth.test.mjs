import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { initializeSchema, accountRoute, checkAuth, siteSettings } from '../src/auth.mjs';
const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
function database() {
  const sqlite=new DatabaseSync(':memory:');
  const db={exec:async sql=>{sqlite.exec(sql);return {};},prepare(sql){return {args:[],bind(...args){this.args=args;return this;},async first(){return sqlite.prepare(sql).get(...this.args)||null;},async all(){return {results:sqlite.prepare(sql).all(...this.args)};},async run(){return sqlite.prepare(sql).run(...this.args);}};},async batch(statements){sqlite.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  return {db,sqlite};
}
const setup={siteName:'Sample Quiz',language:'en',password:'local-test-password-only',setupKey:'synthetic-installation-key'};
function post(path,data,headers={}){return new Request('https://quiz.example'+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});}
async function fresh(){const {db,sqlite}=database();await initializeSchema(db,schema);return {env:{QUIZ_DB:db,SETUP_TOKEN:setup.setupKey},sqlite};}
test('fresh installation has no quiz, question, history or configuration rows',async()=>{
 const {env,sqlite}=await fresh();for(const table of ['quizzes','quiz_questions','quiz_games','app_settings'])assert.equal(sqlite.prepare('SELECT count(*) AS n FROM '+table).get().n,0);assert.equal(await siteSettings(env.QUIZ_DB),null);
});
test('installation requires the owner key and refuses short passwords',async()=>{
 const {env}=await fresh();assert.equal((await accountRoute(post('/api/setup',{...setup,setupKey:'wrong'}),env)).status,403);assert.equal((await accountRoute(post('/api/setup',{...setup,password:'short'}),env)).status,400);
});
test('setup is locked after completion and stores a salted hash, never the password',async()=>{
 const {env,sqlite}=await fresh();assert.equal((await accountRoute(post('/api/setup',setup),env)).status,200);assert.equal((await accountRoute(post('/api/setup',{...setup,password:'different-password'}),env)).status,409);const row=sqlite.prepare('SELECT * FROM app_settings').get();assert.notEqual(row.password_hash,setup.password);assert.equal(row.password_hash.length,64);assert(!JSON.stringify(row).includes(setup.password));const publicSite=await (await accountRoute(new Request('https://quiz.example/api/site'),env)).json();assert(!JSON.stringify(publicSite).includes('password_hash'));
});
test('simultaneous setup requests produce one admin configuration',async()=>{
 const {env,sqlite}=await fresh();const responses=await Promise.all([accountRoute(post('/api/setup',setup),env),accountRoute(post('/api/setup',{...setup,password:'another-password-123'}),env)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM app_settings').get().n,1);
});
test('login issues a hashed expiring session and logout revokes it',async()=>{
 const {env,sqlite}=await fresh();await accountRoute(post('/api/setup',setup),env);assert.equal((await accountRoute(post('/api/auth/login',{password:'incorrect-password'}),env)).status,401);const data=await(await accountRoute(post('/api/auth/login',{password:setup.password}),env)).json();const request=new Request('https://quiz.example/api/quiz/history',{headers:{'X-Admin-Token':data.token}});assert.equal(await checkAuth(request,env),true);assert(!JSON.stringify(sqlite.prepare('SELECT * FROM admin_sessions').all()).includes(data.token));await accountRoute(post('/api/auth/logout',{}, {'X-Admin-Token':data.token}),env);assert.equal(await checkAuth(request,env),false);
});
test('expired sessions and bare passwords cannot authorize admin requests',async()=>{
 const {env,sqlite}=await fresh();await accountRoute(post('/api/setup',setup),env);const data=await(await accountRoute(post('/api/auth/login',{password:setup.password}),env)).json();sqlite.prepare('UPDATE admin_sessions SET expires_at=0').run();for(const token of [data.token,setup.password,''])assert.equal(await checkAuth(new Request('https://quiz.example/api/quiz/history',{headers:{'X-Admin-Token':token}}),env),false);
});
test('login attempts are rate limited and cross-origin setup is rejected',async()=>{
 const {env}=await fresh();assert.equal((await accountRoute(post('/api/setup',setup,{Origin:'https://other.example'}),env)).status,403);await accountRoute(post('/api/setup',setup),env);for(let i=0;i<10;i++)await accountRoute(post('/api/auth/login',{password:'wrong'}),env);assert.equal((await accountRoute(post('/api/auth/login',{password:setup.password}),env)).status,429);
});
