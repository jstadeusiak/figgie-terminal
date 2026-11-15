/* Score stored bonus forecasts after settlement, without changing any forecast.
   Official payouts identify feasible final goal holdings. Reverse public fills
   to label the SAME inventory checkpoint; later trades are never forecast error. */
(function(scope){'use strict';
const IDS=['s','c','d','h'],EPS=1e-6,MAX_EVENTS=20000,MAX_TRADES=2000,MAX_HISTORY_CHECKS=200000;
const sum=a=>a.reduce((x,y)=>x+y,0),near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=EPS;
const vector=(a,n=4)=>Array.isArray(a)&&a.length===n&&a.every(v=>Number.isInteger(v)&&v>=0&&v<=40);
const sameTrade=(a,b)=>a&&b&&a.b===b.b&&a.s===b.s&&a.suit===b.suit&&a.p===b.p;
const sameVector=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((v,i)=>v===b[i]);
const validProb=p=>Number.isFinite(p)&&p>=0&&p<=1;
function fail(reason){return {score:null,reason};}
function auditRound(journal){
 const Journal=scope.FiggieJournal||(typeof require==='function'?require('./journal.js'):null);if(Journal?.isPractice(journal))return fail('Practice rounds are excluded from normal bonus calibration');
 const s=journal?.previous||journal?.snapshot,r=journal?.revealed,events=journal?.events;
 if(!s||s.status!=='ended'||!r||r.verified!==true||r.source!=='official-round-rankings'||!IDS.includes(r.goal))return fail('Verified official settlement required');
 if(!Array.isArray(s.players)||![4,5].includes(s.players.length)||!Array.isArray(s.trades)||s.trades.length>MAX_TRADES||!Array.isArray(events)||!events.length||events.length>MAX_EVENTS)return fail('Missing or oversized round history');
 const names=s.players.map(p=>p?.name),n=names.length,size=40/n,self=names.indexOf(s.self),g=IDS.indexOf(r.goal),ante=200/n;
 if(names.some(x=>typeof x!=='string'||!x)||new Set(names).size!==n||self<0||!vector(s.startingHand)||sum(s.startingHand)!==size||!vector(s.held))return fail('Invalid players or own inventory');
 if(!r.profits||Object.keys(r.profits).length!==n||!names.every(name=>Object.hasOwn(r.profits,name)&&Number.isFinite(r.profits[name]))||!near(sum(names.map(name=>r.profits[name])),0))return fail('Complete zero-sum official profits required');
 if(r.settledProfit!==undefined&&!near(r.settledProfit,r.profits[s.self]))return fail('Official self profit mismatch');
 const net=names.map(()=>[0,0,0,0]),minimum=names.map(()=>[0,0,0,0]),cash=names.map(()=>0);
 for(const t of s.trades){
  const a=names.indexOf(t?.s),b=names.indexOf(t?.b),suit=IDS.indexOf(t?.suit);
  if(a<0||b<0||a===b||suit<0||!Number.isFinite(t.p)||t.p<0)return fail('Malformed trade');
  net[a][suit]--;net[b][suit]++;minimum[a][suit]=Math.max(minimum[a][suit],-net[a][suit]);cash[a]+=t.p;cash[b]-=t.p;
 }
 if(!s.held.every((v,i)=>v===s.startingHand[i]+net[self][i])||s.startingHand.some((v,i)=>v<minimum[self][i])||s.players.some((p,i)=>!Number.isInteger(p.cards)||p.cards!==size+sum(net[i])))return fail('Final inventory does not reconcile with complete fills');
 const payouts=names.map((name,i)=>r.profits[name]-cash[i]+ante);
 if(payouts.some(v=>v<-EPS||v>200+EPS)||!near(sum(payouts),200))return fail('Official payouts do not reconcile');
 // With a fixed goal column and own hand, the remaining cells form a complete
 // transportation table. Nonnegative row/column residuals are sufficient for a
 // feasible integer allocation above the executed-sale minimum in every suit.
 function feasibleDeal(initial,total){
  for(let scarce=0;scarce<4;scarce++){
   if(scarce===(g^1))continue;
   const deck=[10,10,10,10];deck[g^1]=12;deck[scarce]=8;if(deck[g]!==total)continue;
   if(s.startingHand.some((v,i)=>v>deck[i]))continue;
   if(initial.some((v,i)=>!Number.isInteger(v)||v<minimum[i][g]||v>size)||initial[self]!==s.startingHand[g])continue;
   if(initial.some((v,i)=>i!==self&&size-v-sum(minimum[i].filter((_,k)=>k!==g))<0))continue;
   if(deck.some((v,k)=>k!==g&&v-s.startingHand[k]-sum(minimum.map((row,i)=>i===self?0:row[k]))<0))continue;
   return true;
  }
  return false;
 }
 const candidates=[];
 for(const total of [8,10]){
  const counts=Array(n).fill(0),bonus=200-10*total;
  function enumerate(i,left){
   if(i===n){
    if(left)return;const max=Math.max(...counts),ties=counts.filter(v=>v===max).length;
    if(!counts.every((v,k)=>near(10*v+(v===max?bonus/ties:0),payouts[k])))return;
    const initial=counts.map((v,k)=>v-net[k][g]);if(feasibleDeal(initial,total))candidates.push({initial,bonus});return;
   }
   if(i===self){const v=s.held[g];if(v<=left){counts[i]=v;enumerate(i+1,left-v);}return;}
   for(let v=0;v<=Math.min(left,s.players[i].cards);v++){counts[i]=v;enumerate(i+1,left-v);}
  }
  enumerate(0,total);
 }
 if(!candidates.length)return fail('No feasible goal holdings reproduce official payouts');
 const current=names.map(()=>[0,0,0,0]),points=[];let tradeCount=0,started=false,phase='unknown',outcomeKnown=false,historyChecks=0,allPredictions=0,eligiblePredictions=0,ambiguous=0;
 function currentHeld(){return s.startingHand.map((v,i)=>v+current[self][i]);}
 function checkSnapshot(x){
  if(!x||x.self!==s.self||!sameVector(x.startingHand,s.startingHand)||!Array.isArray(x.players)||!sameVector(x.players.map(p=>p?.name),names)||!Array.isArray(x.trades)||x.trades.length!==tradeCount||!sameVector(x.held,currentHeld()))return false;
  historyChecks+=x.trades.length;if(historyChecks>MAX_HISTORY_CHECKS)return false;
  return x.trades.every((t,i)=>sameTrade(t,s.trades[i]));
 }
 for(let i=0;i<events.length;i++){
  const e=events[i];if(!e||e.seq!==i+1||(e.roundId!==undefined&&journal.id!==undefined&&e.roundId!==journal.id))return fail('Incomplete or unordered journal sequence');
  if(e.kind==='round_start'){
   if(started||tradeCount||e.snapshot?.trades?.length)return fail('Recovered or repeated round start');
   if(!checkSnapshot(e.snapshot))return fail('Inconsistent opening checkpoint');started=true;phase=e.snapshot.status;
  }
  if(e.kind==='fill'){
   if(!started||e.recovered||e.index!==tradeCount||!sameTrade(e.trade,s.trades[tradeCount]))return fail('Recovered, missing, or changed fill history');
   const t=e.trade,k=IDS.indexOf(t.suit);current[names.indexOf(t.s)][k]--;current[names.indexOf(t.b)][k]++;tradeCount++;
  }
  if(e.kind==='checkpoint'){
   if(!started||!checkSnapshot(e.snapshot))return fail('Inconsistent checkpoint history');phase=e.snapshot.status;
  }
  if(e.kind==='state'){
   if(!started||!sameVector(e.held,currentHeld()))return fail('State inventory contradicts fills');phase=e.status;
  }
  if(e.kind==='clock')phase=e.status;
  if(e.kind==='reveal'||(e.kind==='settlement_pending'&&IDS.includes(e.result?.goal))||phase==='ended'||IDS.includes(e.roundResult?.goal)||IDS.includes(e.snapshot?.roundResult?.goal))outcomeKnown=true;
  if(e.kind!=='prediction')continue;
  allPredictions++;
  if(!started||phase!=='live'||outcomeKnown||e.tradeCount!==tradeCount)continue;
  const scenario=Array.isArray(e.goalScenarios)?e.goalScenarios.find(v=>v?.suit===r.goal):null;
  if(!scenario||!Number.isFinite(scenario.bonus)||scenario.bonus<0||scenario.bonus>120)continue;
  eligiblePredictions++;
  const truths=candidates.map(c=>{
   const counts=c.initial.map((v,k)=>v+current[k][g]),max=Math.max(...counts),ties=counts.filter(v=>v===max).length,leader=counts[self]===max;
   return {bonus:leader?c.bonus/ties:0,category:leader?(ties===1?'solo':'tie'):'none'};
  });
  if(!truths.every(t=>near(t.bonus,truths[0].bonus)&&t.category===truths[0].category)){ambiguous++;continue;}
  const truth=truths[0],error=scenario.bonus-truth.bonus,ps=[scenario.soloProbability,scenario.tieProbability,scenario.noBonusProbability],category=['solo','tie','none'].indexOf(truth.category);
  const categoryBrier=ps.every(validProb)&&near(sum(ps),1)?sum(ps.map((p,k)=>(p-Number(k===category))**2)):null;
  const leaderBrier=validProb(scenario.leaderProbability)?(scenario.leaderProbability-Number(truth.category!=='none'))**2:null;
  points.push({error,categoryBrier,leaderBrier});
 }
 if(!started||tradeCount!==s.trades.length)return fail('Missing complete fill journal');
 if(!points.length)return {...fail(ambiguous?'All bonus truths are ambiguous':'No eligible live bonus forecasts'),settlementVerified:true};
 const categoryPoints=points.filter(p=>p.categoryBrier!==null),leaderPoints=points.filter(p=>p.leaderBrier!==null),average=(xs,key)=>xs.length?sum(xs.map(p=>p[key]))/xs.length:null;
 return {reason:null,settlementVerified:true,score:{roundId:journal.id,goal:r.goal,checkpoints:points.length,excludedCheckpoints:allPredictions-points.length,eligibleCheckpoints:eligiblePredictions,ambiguousCheckpoints:ambiguous,candidateAllocations:candidates.length,bonusMae:sum(points.map(p=>Math.abs(p.error)))/points.length,bonusBias:average(points,'error'),categoryBrier:average(categoryPoints,'categoryBrier'),categoryCheckpoints:categoryPoints.length,leaderBrier:average(leaderPoints,'leaderBrier'),leaderCheckpoints:leaderPoints.length,method:'Official payouts; settle-now bonus at each saved live inventory checkpoint'}};
}
function scoreRound(journal){return auditRound(journal).score;}
scope.FiggieBonusScore={scoreRound,auditRound};if(typeof module!=='undefined')module.exports=scope.FiggieBonusScore;
})(globalThis);
