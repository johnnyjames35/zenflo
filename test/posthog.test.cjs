const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/product-analytics.js'),'utf8');
function boot({saved=null,dnt='0',gpc=false,url='https://example.test/',failStorage=false}={}){
 const scripts=[],calls=[],listeners={},storage=new Map();
 const match=source.match(/const APP = '([^']+)'/),app=match[1],key=app+'_posthog_consent_v1';
 if(saved)storage.set(key,saved);
 let options,stopped=0,out=0,reset=0;
 const sdk={capture:(name)=>calls.push(name),opt_in_capturing(){},opt_out_capturing(){out++},stopSessionRecording(){stopped++},reset(){reset++}};
 const element=()=>({style:{},setAttribute(){},addEventListener(){},dataset:{}});
 const document={readyState:'complete',createElement:element,head:{appendChild:e=>scripts.push(e)},body:{append(){}},getElementById(){return null}};
 const window={addEventListener:(n,f)=>listeners[n]=f,dispatchEvent(){},posthog:{init:(token,o)=>{options=o;o.loaded(sdk)}}};
 const context={window,document,navigator:{doNotTrack:dnt,globalPrivacyControl:gpc},location:new URL(url),URL,Event:class{},localStorage:{getItem:k=>{if(failStorage)throw Error('blocked');return storage.get(k)||null},setItem:(k,v)=>{if(failStorage)throw Error('blocked');storage.set(k,v)}}};
 vm.runInNewContext(source,context);
 return {app,key,window,scripts,calls,listeners,context,get options(){return options},get out(){return out},get stopped(){return stopped},get reset(){return reset},load(){scripts[0].onload()}};
}
test('no SDK or queued events before permission',()=>{
 const b=boot();b.window.productAnalytics.capture('account_created');assert.equal(b.scripts.length,0);
 b.window.productAnalytics.consent(true);b.load();assert.deepEqual(b.calls,['page_viewed']);
});
test('DNT and GPC override consent',()=>{
 for(const args of [{dnt:'1'},{gpc:true}]){const b=boot(args);b.window.productAnalytics.consent(true);assert.equal(b.scripts.length,0)}
});
test('withdrawal suppresses events and handles in-flight SDK load',()=>{
 const b=boot();b.window.productAnalytics.consent(true);b.window.productAnalytics.consent(false);b.load();assert.equal(b.options,undefined);
 const c=boot();c.window.productAnalytics.consent(true);c.load();c.window.productAnalytics.consent(false);c.window.productAnalytics.capture('account_created');assert.deepEqual(c.calls,['page_viewed']);assert.equal(c.out,1);assert.equal(c.stopped,1);
 c.window.productAnalytics.consent(true);c.window.productAnalytics.capture('account_created');assert.deepEqual(c.calls,['page_viewed','page_viewed','account_created']);
});
test('event allowlist strips sensitive enrichment but keeps ingestion token',()=>{
 const b=boot({url:'https://example.test/signup?email=secret@example.test#private'});b.window.productAnalytics.consent(true);b.load();
 const event=b.options.before_send({event:'account_created',properties:{token:'public-token',email:'secret',answers:'secret',$set:{name:'secret'},$current_url:'bad',arbitrary:'secret'}});
 assert.equal(event.properties.token,'public-token');assert.equal(event.properties.app,b.app);assert.equal(event.properties.$current_url,'https://example.test/signup');
 assert.ok(!JSON.stringify(event).includes('secret'));assert.equal(b.options.before_send({event:'$autocapture',properties:{}}),null);
});
test('no duplicate page views on query-only changes; new routes count once',()=>{
 const b=boot();b.window.productAnalytics.consent(true);b.load();b.window.productAnalytics.page();
 b.context.location=new URL('https://example.test/?secret=1');b.window.productAnalytics.page();assert.equal(b.calls.length,1);
 b.context.location=new URL('https://example.test/pricing');b.window.productAnalytics.page();b.window.productAnalytics.page();assert.equal(b.calls.length,2);
});
test('SDK blocked on admin, reset and invite routes',()=>{
 for(const route of ['/admin','/admin-dashboard.html','/reset-password','/accept-invite','/delete-account.html']){const b=boot({url:'https://example.test'+route});b.window.productAnalytics.consent(true);assert.equal(b.scripts.length,0);assert.equal(b.calls.length,0)}
});
test('privacy settings and masked replay selectors',()=>{
 const b=boot();b.window.productAnalytics.consent(true);b.load();const o=b.options;
 assert.equal(o.api_host,'https://eu.i.posthog.com');assert.equal(o.person_profiles,'never');assert.equal(o.autocapture,false);assert.equal(o.capture_performance,false);assert.equal(o.enable_recording_console_log,false);
 assert.equal(o.session_recording.maskTextSelector,'*');assert.equal(o.session_recording.maskAllInputs,true);
 for(const selector of ['form','[data-ph-private]','#app-screen','.zf-chat-panel'])assert.ok(o.session_recording.blockSelector.includes(selector));
 assert.equal(o.session_recording.maskCapturedNetworkRequestFn({name:'https://example.test/app/12345?secret=1'}).name,'https://example.test/app');
});
test('replay and event delivery stop after permission is withdrawn',()=>{
 const b=boot();b.window.productAnalytics.consent(true);b.load();b.window.productAnalytics.consent(false);assert.equal(b.options.before_send({event:'$snapshot',properties:{$snapshot_data:[]}}),null);
});
test('blocked storage does not break product script',()=>{const b=boot({failStorage:true});b.window.productAnalytics.consent(true);b.load();assert.equal(b.calls[0],'page_viewed')});
test('external consent never reuses an old Google permission',()=>{
 const b=boot({saved:'yes'});if(b.app==='kelvori')assert.equal(b.scripts.length,0);else{b.load();b.listeners.storage({key:b.key,newValue:'no'});assert.equal(b.out,1)}
});
