import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readCodexThreadNames, syncCodexNames } from '../../lib/codex-names.mjs';
import { runCodexHook } from '../../lib/codex-hook.mjs';
import { runIngestCodex } from '../../lib/ingest-codex.mjs';
import { loadProjection, readAllEvents } from '../../lib/storage.mjs';
import { rebuildFromEvents } from '../../lib/projection.mjs';
import { setAlias } from '../../lib/operations.mjs';
import { foldNameHistory, CHANNEL_CODEX_THREAD_NAME } from '../../lib/names.mjs';

const ID='01111111-1111-7111-8111-111111111111';
const OTHER='02222222-2222-7222-8222-222222222222';
const TS='2026-10-01T09:00:00.000Z';
const LATER='2026-10-01T10:00:00.000Z';
const CLI=new URL('../../cli/sessions-db.mjs',import.meta.url).pathname;
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'sdb-codex-names-')));
  const ws=join(root,'workspace'),home=join(root,'codex');
  mkdirSync(ws);mkdirSync(home);writeFileSync(join(ws,'CLAUDE.md'),'Druumen Workspace');
  const storage={rootPath:join(ws,'.dru-code')};
  const input={hook_event_name:'UserPromptSubmit',session_id:ID,cwd:ws,prompt:'original prompt'};
  const index=join(home,'session_index.jsonl');
  const put=rows=>writeFileSync(index,rows.map(row=>typeof row==='string'?row:JSON.stringify(row)).join('\n')+'\n');
  const row=(name,id=ID,ts=TS)=>({id,thread_name:name,updated_at:ts});
  const cli=args=>spawnSync(process.execPath,[CLI,...args],{cwd:ws,encoding:'utf8',
    env:{...process.env,CODEX_HOME:home,DRUUMEN_SESSIONS_DB_ROOT:storage.rootPath}});
  return {root,ws,home,storage,input,index,put,row,cli};
}
test('hook uses exact thread_name rather than prompt; repeated and concurrent observations keep one rename',async()=>{
  const f=fixture();try{
    f.put([f.row('foreign name',OTHER),f.row('排查 SDB 会话检索问题')]);
    const opts={env:{CODEX_HOME:f.home},now:TS};
    const results=await Promise.all(Array.from({length:3},()=>runCodexHook(f.input,opts)));
    assert.equal(new Set(results.map(r=>r.stable_id)).size,1);
    const s=(await loadProjection(f.storage)).sessions[results[0].stable_id];
    assert.equal(s.display_name,'排查 SDB 会话检索问题');
    assert.equal(s.display_name_channel,'codex_thread_name');
    assert.equal(s.first_prompt_preview,'original prompt');
    assert.equal(s.names[0].source,'harvest');assert.equal(s.names[0].observed_from,f.index);
    assert.equal(s.names[0].set_count,1);
    const {events}=await readAllEvents(f.storage);
    assert.equal(events.filter(e=>e.op==='name_set').length,1);
    assert.equal(JSON.parse(f.cli(['search','排查 SDB','--json']).stdout)[0].stable_id,s.stable_id);
    assert.equal(rebuildFromEvents(events).sessions[s.stable_id].display_name,s.display_name);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('rename and clear preserve history, first prompt fallback and operator alias precedence',async()=>{
  const f=fixture();try{
    f.put([f.row('first title')]);
    const opts={env:{CODEX_HOME:f.home},now:TS};
    const {stable_id}=await runCodexHook(f.input,opts);
    assert.equal((await setAlias({stableId:stable_id,alias:'operator alias',...f.storage})).ok,true);
    f.put([f.row('first title'),f.row('new title',ID,LATER)]);
    await runCodexHook({...f.input,hook_event_name:'Stop'}, {...opts,now:LATER});
    let s=(await loadProjection(f.storage)).sessions[stable_id];
    assert.equal(s.display_name,'operator alias');
    assert.equal(s.names.find(n=>n.channel===CHANNEL_CODEX_THREAD_NAME).value,'new title');
    const hist=foldNameHistory((await readAllEvents(f.storage)).events,{stableId:stable_id}).get(stable_id).get(CHANNEL_CODEX_THREAD_NAME);
    assert.deepEqual(hist.map(n=>n.value),['first title','new title']);
    await setAlias({stableId:stable_id,clear:true,...f.storage});
    assert.equal((await loadProjection(f.storage)).sessions[stable_id].display_name,'new title');
    f.put([f.row(null,ID,LATER)]);
    await runCodexHook({...f.input,prompt:'later prompt'},opts);
    s=(await loadProjection(f.storage)).sessions[stable_id];
    assert.equal(s.display_name,'original prompt');assert.equal(s.names.find(n=>n.channel===CHANNEL_CODEX_THREAD_NAME).value,null);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('metadata-only backfill previews, writes, stays idempotent, and does not register foreign UUIDs or bump activity',async()=>{
  const f=fixture();try{
    const {stable_id}=await runCodexHook(f.input,{env:{CODEX_HOME:f.home},now:TS});
    f.put([f.row('foreign title',OTHER),f.row('indexed title')]);
    const before=readFileSync(join(f.storage.rootPath,'sessions-db-events.jsonl'),'utf8');
    const preview=f.cli(['sync-codex-names','--json']);assert.equal(preview.status,0,preview.stderr);
    assert.equal(JSON.parse(preview.stdout).changed,1);
    assert.equal(readFileSync(join(f.storage.rootPath,'sessions-db-events.jsonl'),'utf8'),before);
    const write=f.cli(['sync-codex-names','--yes','--json']);assert.equal(write.status,0,write.stderr);
    let p=await loadProjection(f.storage);assert.equal(Object.keys(p.sessions).length,1);
    assert.equal(p.sessions[stable_id].display_name,'indexed title');assert.equal(p.sessions[stable_id].last_progress_at,TS);
    const after=readFileSync(join(f.storage.rootPath,'sessions-db-events.jsonl'),'utf8');
    assert.equal((await syncCodexNames({storage:f.storage,codexHome:f.home,dryRun:false})).changed,0);
    assert.equal(readFileSync(join(f.storage.rootPath,'sessions-db-events.jsonl'),'utf8'),after);
    const absent=f.cli(['sync-codex-names','--session-id',OTHER,'--yes']);assert.equal(absent.status,1);
    assert.equal(f.cli(['sync-codex-names','--session-id','bad']).status,2);
    assert.equal(f.cli(['sync-codex-names','--yes','--dry-run']).status,2);
    assert.equal(rebuildFromEvents((await readAllEvents(f.storage)).events).sessions[stable_id].display_name,'indexed title');
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('missing, malformed and unsafe metadata preserve stored names; I/O failure is explicit',async()=>{
  const f=fixture();try{
    f.put([f.row('safe title')]);
    const {stable_id}=await runCodexHook(f.input,{env:{CODEX_HOME:f.home},now:TS});
    f.put(['bad JSON',f.row('x'.repeat(513)),{id:ID,updated_at:TS},f.row('\u001b[31m'),f.row('other',OTHER)]);
    const read=await readCodexThreadNames([ID],{codexHome:f.home});assert.equal(read.names.size,0);assert.equal(read.malformed,4);
    await runCodexHook(f.input,{env:{CODEX_HOME:f.home},now:LATER});
    assert.equal((await loadProjection(f.storage)).sessions[stable_id].display_name,'safe title');
    rmSync(f.index);await runCodexHook(f.input,{env:{CODEX_HOME:f.home},now:LATER});
    assert.equal((await loadProjection(f.storage)).sessions[stable_id].display_name,'safe title');
    assert.equal(f.cli(['sync-codex-names','--yes']).status,1);
    mkdirSync(f.index);await assert.rejects(readCodexThreadNames([ID],{codexHome:f.home}),/EISDIR/);
    assert.equal(f.cli(['sync-codex-names','--yes']).status,1);
    assert.equal((await loadProjection(f.storage)).sessions[stable_id].display_name,'safe title');
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('new historical ingest captures name metadata without mixing Claude title channels',async()=>{
  const f=fixture();try{
    f.put([f.row('ingested title')]);
    const day=join(f.home,'sessions','2026','10','01');mkdirSync(day,{recursive:true});
    writeFileSync(join(day,`rollout-t-${ID}.jsonl`),JSON.stringify({type:'session_meta',timestamp:TS,payload:{id:ID,cwd:f.ws}})+'\n');
    const result=await runIngestCodex({workspaceRoot:f.ws,storage:f.storage,codexRoot:join(f.home,'sessions'),sessionId:ID,dryRun:false});
    assert.equal(result.ingested,1);
    const s=Object.values((await loadProjection(f.storage)).sessions)[0];
    assert.equal(s.display_name,'ingested title');assert.equal(s.names[0].channel,'codex_thread_name');
    assert.deepEqual(s.claude_session_ids,[]);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
