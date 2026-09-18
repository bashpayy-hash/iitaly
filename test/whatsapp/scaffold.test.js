'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, createHash } = require('node:crypto');
const { configFromEnv, createClient, phone, subscriptionAllowed, payloadFor } = require('../../integrations/whatsapp/client');
const { MAX_BYTES, validSignature, normalize, createWebhookHandlers, advanceStatus } = require('../../integrations/whatsapp/webhook');
const { issueLink, subscriptionFromLink, CONSENT_VERSION } = require('../../integrations/whatsapp/linking');
const NOW = Date.parse('2026-09-18T10:00:00Z');
const PHONE = '+77010000000'; // Synthetic only; fetch is always replaced below.
const env = { WHATSAPP_MODE:'test', WHATSAPP_ACCESS_TOKEN:'test-secret', WHATSAPP_PHONE_NUMBER_ID:'123', WHATSAPP_API_VERSION:'v25.0', WHATSAPP_TEMPLATE_DUE:'iitaly_deadline_ru', WHATSAPP_TEMPLATE_OVERDUE:'iitaly_overdue_ru', WHATSAPP_TEMPLATE_DIGEST:'iitaly_digest_ru', WHATSAPP_TEST_RECIPIENTS:PHONE };
const subscription = () => ({ enabled:true, phone:PHONE, verifiedPhone:PHONE, verifiedAt:'2026-09-18T09:30:00Z', optInAt:'2026-09-18T09:29:00Z', consentVersion:CONSENT_VERSION });
const event = () => ({ kind:'due', taskLabel:'Подать заявку', deadlineLabel:'25 сентября 2026', relativeLabel:'7 дней' });
const response = (data, status=200, retry=null) => ({ ok:status>=200&&status<300, status, json:async()=>data, headers:{get:()=>retry} });
function client(fetchImpl, opts={}) { return createClient(configFromEnv(env), {fetchImpl,now:()=>NOW,...opts}); }
function payload() { return {object:'whatsapp_business_account',entry:[{id:'456',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'123'},statuses:[{id:'wamid.unit',status:'delivered',timestamp:'1789725600',recipient_id:PHONE.slice(1)}]}}]}]}; }
const scope = {wabaId:'456',phoneNumberId:'123'};
const value = p=>p.entry[0].changes[0].value;
const signed = b=>'sha256='+createHmac('sha256','test-app-secret').update(b).digest('hex');
function fakeRes() { return { code:null, body:null, contentType:null, status(n){this.code=n;return this;},type(s){this.contentType=s;return this;},send(s){this.body=s;return this;},end(){return this;} }; }
function handlers(persistEvents) { return createWebhookHandlers({...scope,appSecret:'test-app-secret',verifyToken:'test-verify',persistEvents}); }
async function post(p, persistEvents=async()=>true, signature) { const body=Buffer.isBuffer(p)?p:Buffer.from(JSON.stringify(p)); const res=fakeRes(); await handlers(persistEvents).receive({body,get:()=>signature??signed(body)},res); return res; }

test('off by default; no credentials and no network needed',async()=>{
 let calls=0; const c=createClient(configFromEnv({}),{fetchImpl:async()=>{calls++;throw Error();}});
 assert.equal((await c.send(subscription(),event())).reason,'disabled'); assert.equal(calls,0);
});
test('unknown mode fails closed',()=>assert.throws(()=>configFromEnv({...env,WHATSAPP_MODE:'live'})));
test('requires explicit API version and configured templates',()=>{
 for(const key of ['WHATSAPP_API_VERSION','WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','WHATSAPP_TEMPLATE_DUE'])assert.throws(()=>configFromEnv({...env,[key]:''}));
 assert.throws(()=>configFromEnv({...env,WHATSAPP_PHONE_NUMBER_ID:'123/evil'}));
});
test('test mode needs one to five allowlisted phone numbers',()=>{
 assert.throws(()=>configFromEnv({...env,WHATSAPP_TEST_RECIPIENTS:''}));
 assert.throws(()=>configFromEnv({...env,WHATSAPP_TEST_RECIPIENTS:Array(6).fill(PHONE).join(',')}));
});
test('strict international format does not guess country or turn 8 into +7',()=>{
 for(const p of ['87010000000','+7 text','+00701','+7701','+1234567890123456',null])assert.throws(()=>phone(p));
 assert.equal(phone(PHONE),PHONE);
});
test('explicit consent, verified same number, timestamp and policy version required',()=>{
 assert(subscriptionAllowed(subscription(),NOW));
 for(const change of [{enabled:false},{verifiedPhone:'+77020000000'},{revokedAt:'2026-09-18'},{verifiedAt:null},{optInAt:'2099-01-01'},{consentVersion:'old'}, {phone:'+77020000000'}])assert.equal(subscriptionAllowed({...subscription(),...change},NOW),false);
});
test('unverified and non-allowlisted recipients never reach fetch',async()=>{
 let calls=0;const c=client(async()=>{calls++;throw Error();});
 assert.equal((await c.send({...subscription(),enabled:false},event())).reason,'consent_or_phone_not_verified');
 assert.equal((await c.send({...subscription(),phone:'+77020000000',verifiedPhone:'+77020000000'},event())).reason,'not_allowlisted');
 assert.equal(calls,0);
});
test('7/3/1 use one due template with parameters; no free text messages',()=>{
 const c=configFromEnv(env);
 for(const label of ['7 дней','3 дня','1 день']){
  const p=payloadFor(c,subscription(),{...event(),relativeLabel:label});
  assert.equal(p.type,'template'); assert.equal(p.template.name,'iitaly_deadline_ru'); assert.equal(p.template.language.code,'ru');assert.equal(p.template.components[0].parameters[2].text,label);
 }
 assert.equal(payloadFor(c,subscription(),{kind:'digest',weekLabel:'21–27 сентября',summary:'Три шага в кабинете'}).template.components[0].parameters.length,2);
});
test('success is accepted, not delivered; token only in fixed-host authorization header',async()=>{
 let seen;
 const c=client(async(url,init)=>{seen={url,init};return response({messages:[{id:'wamid.unit'}]});});
 const r=await c.send(subscription(),event());
 assert.equal(r.state,'accepted');assert.equal(r.messageId,'wamid.unit');assert.equal(r.deliveredAt,undefined);
 assert.equal(seen.url,'https://graph.facebook.com/v25.0/123/messages');assert.equal(seen.init.headers.Authorization,'Bearer test-secret');assert.equal(seen.init.redirect,'error');
 assert.equal(JSON.parse(seen.init.body).to,PHONE.slice(1));assert(!JSON.stringify(r).includes('test-secret'));
});
test('invalid or multiline template parameters cannot be sent',async()=>{
 let calls=0; const c=client(async()=>{calls++;throw Error();});
 for(const e of [{...event(),taskLabel:'x'.repeat(161)},{...event(),taskLabel:'a\nb'},{kind:'marketing'}])assert.equal((await c.send(subscription(),e)).reason,'invalid_template_parameters');
 assert.equal(calls,0);
});
test('HTTP 200 API error is not accepted',async()=>{
 const r=await client(async()=>response({error:{code:190,message:'SECRET'}})).send(subscription(),event());
 assert.equal(r.ok,false);assert.equal(r.providerCode,190);assert.equal(r.retryable,false);assert(!JSON.stringify(r).includes('SECRET'));
});
test('rate limit is retryable after bounded wait, not an immediate second POST',async()=>{
 let calls=0; const r=await client(async()=>{calls++;return response({error:{code:130429}},429,'1800');}).send(subscription(),event());
 assert.equal(r.reason,'rate_limited');assert.equal(r.retryAfterMs,1800000);assert.equal(calls,1);
});
test('explicit transient API failure carries retry permission',async()=>{
 const r=await client(async()=>response({error:{code:2,is_transient:true}},503)).send(subscription(),event());assert.equal(r.retryable,true);
});
test('missing receipt and malformed JSON are unknown, not silently retried',async()=>{
 for(const f of [async()=>response({}),async()=>({ok:true,json:async()=>{throw Error('bad json');}})]){
  const r=await client(f).send(subscription(),event());assert.equal(r.state,'unknown');assert.equal(r.retryable,false);
 }
});
test('timeout covers response body; uncertain send is not duplicate-retried',async()=>{
 const r=await client(async(_,init)=>({ok:true,json:()=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('abort'))))}),{timeoutMs:10}).send(subscription(),event());
 assert.equal(r.reason,'timeout');assert.equal(r.state,'unknown');assert.equal(r.retryable,false);
});
test('signature covers exact raw bytes; rejects absent secret, forged header and changed body',()=>{
 const b=Buffer.from('{"x":1}');assert(validSignature(b,signed(b),'test-app-secret'));
 assert(!validSignature(Buffer.from('{"x":2}'),signed(b),'test-app-secret'));assert(!validSignature(b,signed(b),''));assert(!validSignature(b,'bad','test-app-secret'));assert(!validSignature({},signed(b),'test-app-secret'));
});
test('GET verifies challenge only with correct token and mode',()=>{
 for(const [q,code] of [[{'hub.mode':'subscribe','hub.verify_token':'test-verify','hub.challenge':'123'},200],[{'hub.mode':'subscribe','hub.verify_token':'bad','hub.challenge':'123'},403],[{},403]]){
  const r=fakeRes();handlers(async()=>true).verify({query:q},r);assert.equal(r.code,code);if(code===200)assert.equal(r.body,'123');
 }
});
test('raw parser, payload limit, signature and malformed JSON failures are distinct',async()=>{
 const res=fakeRes();await handlers(async()=>true).receive({body:{},get:()=>''},res);assert.equal(res.code,400);
 assert.equal((await post(Buffer.alloc(MAX_BYTES+1))).code,413);assert.equal((await post(payload(),async()=>true,'sha256='+'0'.repeat(64))).code,403);assert.equal((await post(Buffer.from('{'))).code,400);
});
test('foreign WABA or business phone cannot mutate our subscriptions',async()=>{
 for(const mutate of [p=>p.entry[0].id='789',p=>value(p).metadata.phone_number_id='999']){
  const p=payload();mutate(p);let calls=0;assert.equal((await post(p,async()=>{calls++;return true;})).code,200);assert.equal(calls,0);
 }
});
test('persist happens before acknowledgement; failure returns 503 for redelivery',async()=>{
 let received;assert.equal((await post(payload(),async events=>{received=events;return true;})).code,200);assert.equal(received[0].status,'delivered');
 assert.equal((await post(payload(),async()=>false)).code,503);assert.equal((await post(payload(),async()=>{throw Error('private database failure');})).code,503);
});
test('duplicate callbacks have stable dedupe keys; arbitrary chats are not retained',()=>{
 const p=payload();assert.deepEqual(normalize(p,scope),normalize(p,scope));
 value(p).messages=[{id:'wamid.chat',from:PHONE.slice(1),timestamp:'1789725600',type:'text',text:{body:'private document details'}}];
 assert.equal(normalize(p,scope).length,1);
});
test('STOP in Russian/English and quick replies normalizes to opt-out only',()=>{
 for(const command of ['STOP','стоп','Отписаться','отключить','IITALY_STOP']){
  const p=payload();value(p).statuses=[];value(p).messages=[{id:'wamid.stop',from:PHONE.slice(1),timestamp:'1789725600',type:'text',text:{body:command}}];
  const e=normalize(p,scope)[0];assert.equal(e.type,'opt_out');assert.equal(e.phone,PHONE);assert.equal(e.text,undefined);
 }
});
test('LINK stores token hash, never raw token or access code in event',()=>{
 const token='a'.repeat(64),p=payload();value(p).statuses=[];value(p).messages=[{id:'wamid.link',from:PHONE.slice(1),timestamp:'1789725600',type:'text',text:{body:'IITALY LINK '+token}}];
 const e=normalize(p,scope)[0];assert.equal(e.type,'link');assert.equal(e.tokenHash,createHash('sha256').update(token).digest('hex'));assert(!JSON.stringify(e).includes(token));
});
test('out-of-order sent/failed cannot downgrade delivered or read',()=>{
 let r={messageId:'wamid.unit',phone:PHONE,state:'accepted'};
 const e=normalize(payload(),scope)[0];r=advanceStatus(r,e);assert.equal(r.state,'delivered');
 assert.equal(advanceStatus(r,{...e,status:'sent'}).state,'delivered');assert.equal(advanceStatus(r,{...e,status:'failed'}).state,'delivered');
 r=advanceStatus(r,{...e,status:'read'});assert.equal(r.state,'read');assert.equal(advanceStatus(r,e).state,'read');
});
test('unknown message/recipient cannot create false delivery; delivered can supersede failure',()=>{
 const r={messageId:'wamid.unit',phone:PHONE,state:'failed'},e=normalize(payload(),scope)[0];
 assert.strictEqual(advanceStatus(r,{...e,messageId:'wamid.other'}),r);assert.strictEqual(advanceStatus(r,{...e,phone:'+77020000000'}),r);assert.equal(advanceStatus(r,e).state,'delivered');
});
test('link nonce is persisted before URL; contains no portal code',async()=>{
 let saved;const link=await issueLink({accountId:'internal-account',consent:true,businessPhone:PHONE,now:NOW,store:{insertLink:async r=>{saved=r;return true;}}});
 assert.equal(saved.accountId,'internal-account');assert(!link.url.includes('internal-account'));const token=new URL(link.url).searchParams.get('text').split(' ').at(-1);
 assert.equal(token.length,64);assert.equal(saved.tokenHash,createHash('sha256').update(token).digest('hex'));assert.equal(Date.parse(link.expiresAt)-NOW,600000);
});
test('no consent/no durable write yields no linking URL',async()=>{
 await assert.rejects(issueLink({accountId:'x',consent:false,businessPhone:PHONE,store:{insertLink:async()=>true}}));
 await assert.rejects(issueLink({accountId:'x',consent:true,businessPhone:PHONE,store:{insertLink:async()=>false}}));
});
test('atomic link validation rejects expired/consumed/future/wrong tokens',()=>{
 const record={tokenHash:'abc',consentVersion:CONSENT_VERSION,issuedAt:new Date(NOW-1000).toISOString(),expiresAt:new Date(NOW+599000).toISOString()};
 const e={type:'link',tokenHash:'abc',phone:PHONE,timestamp:NOW/1000};assert(subscriptionFromLink(record,e,NOW));
 for(const r of [{...record,consumedAt:'used'},{...record,expiresAt:new Date(NOW).toISOString()},{...record,tokenHash:'other'},{...record,issuedAt:'bad'}])assert.equal(subscriptionFromLink(r,e,NOW),null);
 assert.equal(subscriptionFromLink(record,{...e,timestamp:NOW/1000+3600},NOW),null);
});
test('approved schema samples and payload arity stay aligned',()=>{
 const templates=require('../../integrations/whatsapp/templates.ru.json');
 for(const t of templates){assert.equal(t.language,'ru');assert.equal(t.category,'UTILITY');assert.equal(t.components.find(x=>x.type==='BUTTONS').buttons[0].url,'https://iitaly.netlify.app/portal');}
 assert.equal(templates.length,3);
});
