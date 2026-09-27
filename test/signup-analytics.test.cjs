const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const app=path.basename(path.join(__dirname,'..'));
const html=fs.readFileSync(path.join(__dirname,'../public',app==='zenflo'?'index.html':'register.html'),'utf8');
const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
const script=scripts.find(s=>s.includes(app==='zenflo'?'async function doRegister':'async function handleRegister'));
async function register(result,reject=false){
 const events=[],nodes=new Map();let requests=0;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:id.includes('email')?'private@example.test':id.includes('pw')||id==='password'?'secretpassword':'private text',style:{},addEventListener(){},classList:{add(){},remove(){}}});return nodes.get(id)};
 const context={document:{getElementById:node,querySelectorAll:()=>[]},window:{productAnalytics:{capture:name=>events.push(name)},addEventListener(){},location:{}},navigator:{},fetch:async()=>{requests++;if(reject)throw Error('network');return{json:async()=>result}},gtag(){},gtag_report_conversion(){},setTimeout(){},clearTimeout(){},setInterval(){},clearInterval(){},console};
 vm.createContext(context);vm.runInContext(script,context);
 if(app==='zenflo')vm.runInContext('showApp=()=>{}',context);
 await vm.runInContext(app==='zenflo'?'doRegister()':'handleRegister({preventDefault(){}})',context);
 return {events,requests};
}
test('signup success emits account_created once with no form properties',async()=>{const x=await register({success:true,user:{name:'private'}});assert.deepEqual(x.events,['signup_attempted','account_created']);assert.equal(x.requests,1)});
test('signup rejection emits failure but never account_created',async()=>{const x=await register({error:'private email already exists'});assert.deepEqual(x.events,['signup_attempted','signup_failed'])});
test('signup network error emits failure without a false success',async()=>{const x=await register({},true);assert.deepEqual(x.events,['signup_attempted','signup_failed'])});
