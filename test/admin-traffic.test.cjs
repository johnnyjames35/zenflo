const {test}=require('node:test'),assert=require('node:assert/strict');
const {getTrafficSummary,reportRequests}=require('../lib/admin-traffic.cjs');
const now=Date.parse('2026-10-27T16:00:00Z');
const report=(users,views)=>({metricHeaders:[{name:'totalUsers'},{name:'screenPageViews'}],metadata:{timeZone:'Etc/GMT'},rows:users===null?undefined:[{metricValues:[{value:String(users)},{value:String(views)}]}]});
test('visitor queries filter site, page views and private routes, without summing daily users',()=>{
 const requests=reportRequests(['kelvori.co.uk'],now);
 assert.deepEqual(requests.map(r=>r.dateRanges[0]),[{startDate:'2026-10-27',endDate:'2026-10-27'},{startDate:'2026-10-21',endDate:'2026-10-27'},{startDate:'2026-09-28',endDate:'2026-10-27'}]);
 for(const r of requests){assert.equal(r.dimensions,undefined);assert.equal(r.metrics[0].name,'totalUsers');const filters=r.dimensionFilter.andGroup.expressions;assert.deepEqual(filters[0].filter.inListFilter.values,['kelvori.co.uk']);assert.equal(filters[1].filter.stringFilter.value,'page_view');const excluded=new RegExp(filters[2].notExpression.filter.stringFilter.value);for(const p of ['/admin','/admin/login','/admin/','/api/admin/data','/app/private','/reset-password'])assert.equal(excluded.test(p),true,p);for(const p of ['/','/signup','/guides','/adhd-task-paralysis-at-work.html'])assert.equal(excluded.test(p),false,p);}
});
test('returns distinct period totals, caches reports, and handles genuine empty data',async()=>{
 let calls=0;
 const fetch=async(url,options)=>{calls++;assert.match(url,/analyticsdata.googleapis.com/);assert.equal(JSON.parse(options.body).requests.length,3);return {ok:true,json:async()=>({reports:[report(2,4),report(3,8),report(null)]})}};
 const config={hosts:['test-success.example']};const a=await getTrafficSummary(config,{now,token:'test',fetch});const b=await getTrafficSummary(config,{now:now+1,token:'test',fetch});assert.equal(a.available,true);assert.deepEqual(a.periods.map(p=>[p.visitors,p.pageViews]),[[2,4],[3,8],[0,0]]);assert.equal(calls,1);assert.equal(a,b);assert.doesNotMatch(JSON.stringify(a),/Bearer|access_token/);
});
test('Google errors and malformed reports cannot become zero traffic',async()=>{
 for(const [name,response] of [['error',{ok:false,json:async()=>({secret:'private'})}],['malformed',{ok:true,json:async()=>({reports:[{},{},{}]})}]]){
  const result=await getTrafficSummary({hosts:[name+'.example']},{now,token:'test',fetch:async()=>response});assert.equal(result.available,false);assert.equal(result.periods,undefined);assert.doesNotMatch(JSON.stringify(result),/private|Bearer/);
 }
});
test('missing credentials produce an unavailable state without making a network request',async()=>{
 const previous=process.env.GA_SERVICE_ACCOUNT_JSON;delete process.env.GA_SERVICE_ACCOUNT_JSON;
 try{const result=await getTrafficSummary({hosts:['missing.example']},{now,fetch:()=>{throw Error('Network should not run')}});assert.deepEqual(result,{available:false,message:'Traffic reporting is not connected yet.'});}finally{if(previous!==undefined)process.env.GA_SERVICE_ACCOUNT_JSON=previous;}
});
