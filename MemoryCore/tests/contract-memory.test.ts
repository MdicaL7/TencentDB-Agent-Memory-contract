import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ContractStore,ContractError} from '../src/contract-memory/store.js';
import {ContractMemory} from '../src/contract-memory/service.js';
const c={instance:'i',team:'a',agent:'ag',user:'u',role:'member'};
const d={kind:'experience' as const,title:'付款保障',content:'60 天账期须20%预付款，仅本项目',topic:'付款',conditions:['20%预付款','仅本项目'],exceptions:['非企业统一标准'],source_ids:['source']};
function store(){return new ContractStore(join(mkdtempSync(join(tmpdir(),'contract-test-')),'data.sqlite'));}
test('personal/team/instance isolation and team review never exposes personal contents',()=>{
 const s=store(),e=s.create(c,d);assert.equal(s.list({...c,user:'v'}).length,0);assert.throws(()=>s.entry({...c,user:'v'},e.id),ContractError);assert.equal(s.list({...c,team:'b'}).length,0);assert.equal(s.list({...c,instance:'j'}).length,0);
 const p=s.proposal(c,e.id,'share',{...d,content:'经预付款保障的较长账期案例'},1);const admin={...c,user:'v',role:'admin'};
 assert.equal(s.proposals(admin)[0].before,null);assert.deepEqual(s.proposals(admin)[0].data.source_ids,[]);
 assert.throws(()=>s.review(c,p.id,true),ContractError);s.review(admin,p.id,true);assert.equal(s.list(admin,'team').length,1);assert.equal(s.list({...admin,team:'b'},'team').length,0);s.db.close();
});
test('candidate confirmation is idempotent; stale versions conflict; audit is transactional',()=>{
 const s=store();s.proposeCandidate(c,'task','session',d);assert.equal(s.list(c).length,0);const p=s.candidates(c)[0];
 const req={id:p.id};const e=s.mutation(c,'key',req,'confirm',p.id,()=>s.confirm(c,p.id));const retry=s.mutation(c,'key',req,'confirm',p.id,()=>s.confirm(c,p.id));assert.equal(e.id,retry.id);assert.equal(s.list(c).length,1);assert.equal(s.all('SELECT * FROM audit').length,1);
 assert.throws(()=>s.mutation(c,'key',{id:'other'},'confirm','',()=>null),ContractError);
 s.mutation(c,'edit',{},'update',e.id,()=>s.edit(c,e.id,1,{...d,content:'人工修正'}));assert.throws(()=>s.edit(c,e.id,1,d),ContractError);
 const before=s.all('SELECT * FROM audit').length;assert.throws(()=>s.mutation(c,'bad',{},'update',e.id,()=>{s.create(c,d);throw new Error('failure')}));assert.equal(s.list(c).length,1);assert.equal(s.all('SELECT * FROM audit').length,before);s.db.close();
});
test('human edit/delete and ignored source cannot be resurrected; changed evidence is a new draft',()=>{
 const s=store();s.proposeCandidate(c,'t','s',d);const e=s.confirm(c,s.candidates(c)[0].id);s.edit(c,e.id,1,null);s.proposeCandidate(c,'t','s',d);assert.equal(s.candidates(c).length,0);assert.equal(s.list(c).length,0);
 s.proposeCandidate(c,'t','s',{...d,source_ids:['new-source']});assert.equal(s.candidates(c).length,1);s.confirm(c,s.candidates(c)[0].id,undefined,true);s.proposeCandidate(c,'t','s',{...d,source_ids:['new-source']});assert.equal(s.candidates(c).length,0);s.db.close();
});
test('review checks published target version and leaves personal entry unchanged',()=>{
 const s=store(),e=s.create(c,d),p=s.proposal(c,e.id,'share',d,1);s.edit(c,e.id,1,{...d,content:'新版本'});assert.throws(()=>s.review({...c,role:'admin'},p.id,true),ContractError);assert.equal(s.list(c,'team').length,0);assert.equal(s.entry(c,e.id).data.content,'新版本');s.db.close();
});
test('raw is immutable/deduplicated; atoms retain conditions and cannot claim approval',()=>{
 const s=store();s.capture(c,'t','s',[{role:'user',content:d.content}],'model','v1');s.capture(c,'t','s',[{role:'user',content:d.content}],'model','v1');assert.equal(s.raw(c).length,1);
 s.saveAtoms(c,'t','s',[{content:d.content,kind:'decision',topic:'付款',conditions:d.conditions,exceptions:d.exceptions,source_ids:[s.raw(c)[0].id],business_state:'approved'}]);assert.equal(s.atoms(c)[0].data.business_state,'proposed');assert.deepEqual(s.atoms(c)[0].data.conditions,d.conditions);
 assert.throws(()=>s.saveAtoms(c,'t','s',[{content:'fake',kind:'decision',conditions:[],exceptions:[],source_ids:['invented']}]),ContractError);s.db.close();
});
test('service rejects forged identity, revoked membership and old Hub writes',async()=>{
 let active=true;const meta:any={verifyAuth:async(k:string)=>k==='key'?{user_id:'u',status:'active'}:null,getAgentById:async()=>({team_id:'a',status:'active',metadata_json:'{"prompt_mode":"contract"}'}),getTeamMember:async()=>({status:active?'active':'removed',role:'member'}),getUserById:async()=>({status:'active'}),getTaskById:async()=>({team_id:'a',creator_user_id:'u'})};
 const service=new ContractMemory({controlKey:'test-controller',baseDir:mkdtempSync(join(tmpdir(),'contract-service-')),meta:async()=>meta,llm:()=>({baseUrl:'http://unused',apiKey:'none',model:'test'})});const body={team_id:'a',agent_id:'ag',user_id:'u'};
 await assert.rejects(()=>service.dispatch('/v3/contract-memory/list','i',{...body,user_id:'v'},'key'));
 await assert.rejects(()=>service.dispatch('/v3/scenario/write','i',body,'key'));
 await service.dispatch('/v3/contract-memory/create','i',{...body,operation_id:'x',data:d},'key','test-controller');assert.equal((await service.dispatch('/v3/scenario/ls','i',body,'key')).entries.length,1);
 active=false;await assert.rejects(()=>service.dispatch('/v3/core/read','i',body,'key'));service.close();
});
test('document version and paragraph hash must match a genuine tool result',()=>{
 const s=store(),citation='【Ddoc:B5】',quote='预付20%，仅限本项目';
 s.context(c,'t','s',{documents:[{document_id:'doc',version:'v1',read_path:'/contract.md',paragraphs:[{id:'B5',citation,hash:createHash('sha256').update(quote).digest('hex')}]}]});
 s.capture(c,'t','s',[{role:'tool',tool_name:'read',tool_path:'/contract.md',content:citation+' '+quote}],'model','v1');
 const record={content:quote,kind:'contract_fact',conditions:['仅限本项目'],exceptions:[],source_ids:[s.raw(c)[0].id],document_refs:[{document_id:'doc',version:'v1',paragraph_id:'B5',source_id:s.raw(c)[0].id}]};
 s.saveAtoms(c,'t','s',[record]);assert.equal(s.atoms(c)[0].data.evidence_status,'verified_document');
 assert.throws(()=>s.saveAtoms(c,'t','s',[{...record,document_refs:[{...record.document_refs[0],version:'v2'}]}]),ContractError);s.db.close();
});
test('assistant claims are suggestions, and withdrawal preserves historical state',()=>{
 const s=store();s.capture(c,'t','s',[{role:'assistant',content:'已经批准'}],'model','v1');
 s.saveAtoms(c,'t','s',[{content:'已经批准',kind:'decision',conditions:[],exceptions:[],source_ids:[s.raw(c)[0].id]}]);const first=s.atoms(c)[0];assert.equal(first.data.kind,'agent_suggestion');
 s.capture(c,'t','s',[{role:'user',content:'撤回意见'}],'model','v1');s.saveAtoms(c,'t','s',[{content:'意见已撤回',kind:'human_opinion',conditions:[],exceptions:[],source_ids:[s.raw(c)[1].id],supersedes_ids:[first.id],validity:'withdrawn'}]);
 assert.equal(s.one('SELECT data FROM atoms WHERE id=?',first.id).data.includes('withdrawn'),true);assert.equal(s.all('SELECT * FROM atom_revisions').length,1);s.db.close();
});
test('ordinary runtime key cannot publish or forge evidence without controller credential',async()=>{
 const meta:any={verifyAuth:async()=>({user_id:'u',status:'active'}),getAgentById:async()=>({team_id:'a',status:'active',metadata_json:'{"prompt_mode":"contract"}'}),getTeamMember:async()=>({status:'active',role:'member'})};
 const service=new ContractMemory({controlKey:'controller',baseDir:mkdtempSync(join(tmpdir(),'contract-control-')),meta:async()=>meta,llm:()=>({baseUrl:'http://unused',apiKey:'none',model:'test'})});const body={team_id:'a',agent_id:'ag',user_id:'u',operation_id:'x',data:d};
 await assert.rejects(()=>service.dispatch('/v3/contract-memory/create','i',body,'user-key'),ContractError);
 await assert.rejects(()=>service.dispatch('/v3/contract-memory/context','i',body,'user-key'),ContractError);
 assert.equal((await service.dispatch('/v3/contract-memory/list','i',body,'user-key')).items.length,0);service.close();
});
test('long tool results are reconstructed before extraction and evidence validation',()=>{
 const s=store();s.capture(c,'t','s',[{role:'tool',tool_name:'read',content:'A'.repeat(8192),source_event_id:'tool-1:0',chunk_group:'tool-1',chunk_index:0,chunk_count:2}],'model','v1');assert.equal(s.raw(c).length,0);
 s.capture(c,'t','s',[{role:'tool',tool_name:'read',content:'20%预付款，仅本项目',source_event_id:'tool-1:1',chunk_group:'tool-1',chunk_index:1,chunk_count:2}],'model','v1');assert.equal(s.raw(c).length,1);assert.ok(s.raw(c)[0].data.content.endsWith('20%预付款，仅本项目'));s.db.close();
});
