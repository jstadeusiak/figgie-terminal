/* Round wealth accounting. Trading cash flow is not profit until settlement. */
(function(scope){'use strict';
const IDS=['s','c','d','h'],finite=Number.isFinite;
function cashFlow(s){
 const bySuit=Object.fromEntries(IDS.map(id=>[id,{spent:0,received:0,bought:0,sold:0,netCash:0}]));
 for(const t of s.trades||[]){const v=bySuit[t.suit];if(!v||!finite(t.p)||t.p<0)throw Error('Invalid trade for round accounting');if(t.b===s.self){v.spent+=t.p;v.bought++;}if(t.s===s.self){v.received+=t.p;v.sold++;}}
 const total={spent:0,received:0,bought:0,sold:0,netCash:0,bySuit};for(const v of Object.values(bySuit)){v.netCash=v.received-v.spent;for(const k of ['spent','received','bought','sold','netCash'])total[k]+=v[k];}return total;
}
function observe(a,s,at){
 if(!a)a={};const flow=cashFlow(s),ante=200/s.players.length;
 // The ante overlay animates balances. Freeze a reconciled opening bank only
 // after the live balance minus trade cash has stayed consistent for a second.
 if(s.status==='live'&&!s.antePending&&finite(s.cash)&&(/^\d+:\d\d$/.test(s.timer)&&s.timer!=='0:00'||s.trades.length)){
  const candidate=s.cash-flow.netCash+ante;
  if(a.bankCandidate!==candidate){a.bankCandidate=candidate;a.candidateSince=at;}
  else if(!finite(a.openingBank)&&at-a.candidateSince>=1000){a.openingBank=candidate;a.anchorAt=at;a.anchorSource='Reconciled live cash + ante − net trading cash';}
 }
 if(s.status==='ended'){
  if(!finite(a.endedAt))a.endedAt=at;
  if(a.endCash!==s.cash){a.endCash=s.cash;a.endCashSince=at;}
  a.endObservedAt=at;
 }
 return a;
}
function handPayout(s,result){
 const goal=IDS.indexOf(result?.goal),hands=result?.finalHands;if(goal<0||!hands||!s.players.every(p=>Array.isArray(hands[p.name])))return null;
 const counts=s.players.map(p=>hands[p.name][goal]);if(counts.some(n=>!Number.isInteger(n)||n<0))return null;
 const total=counts.reduce((a,b)=>a+b,0);if(total!==8&&total!==10)return null;
 if(counts[0]!==s.held[goal])return null;const max=Math.max(...counts),bonus=200-10*total;
 return 10*counts[0]+(counts[0]===max?bonus/counts.filter(n=>n===max).length:0);
}
function summary(s,model=null,a={},result=null){
 const flow=cashFlow(s),ante=200/s.players.length,estimatedSettlement=finite(model?.expectedPayout)?model.expectedPayout:null;
 const settled=s.status==='ended'&&finite(a.endedAt)&&a.endObservedAt-a.endedAt>=3000&&a.endObservedAt-a.endCashSince>=1500;
 let actualPayout=s.status==='ended'?handPayout(s,result):null,actualPnl=actualPayout===null?null:flow.netCash-ante+actualPayout,source=actualPnl===null?null:'Revealed hands';
 const official=s.roundResult||result;
 if(s.status==='ended'&&official?.verified&&official.source==='official-round-rankings'&&finite(official.settledProfit)&&official.settledBank===s.cash){
  const payout=official.settledProfit-flow.netCash+ante;if(payout>=-1e-6&&payout<=200+1e-6){actualPnl=official.settledProfit;actualPayout=Math.max(0,payout);source='Official round result';}
 }
 if(actualPnl===null&&settled&&finite(a.openingBank)&&finite(a.endCash)){
  const payout=a.endCash-a.openingBank+ante-flow.netCash;
  // Reject unreconciled cash and partial updates rather than inventing profit.
  if(payout>=-1e-6&&payout<=200+1e-6){actualPayout=Math.max(0,payout);actualPnl=a.endCash-a.openingBank;source='Settled bank − pre-ante opening bank';}
 }
 const goalScenarios=IDS.map((id,i)=>{const item=model?.bySuit?.[i],settlement=item?.conditionalPayout,probability=item?.probability??null,pnl=finite(settlement)?flow.netCash-ante+settlement:null,weightedPnl=probability===0?0:finite(probability)&&finite(pnl)?probability*pnl:null,noBonusPnl=finite(probability)&&probability>0?flow.netCash-ante+10*s.held[i]:null;return {suit:id,probability,settlement:finite(settlement)?settlement:null,bonus:finite(item?.conditionalBonus)?item.conditionalBonus:null,leaderProbability:item?.conditionalLeaderProbability??null,soloProbability:item?.conditionalSoloProbability??null,tieProbability:item?.conditionalTieProbability??null,noBonusProbability:item?.conditionalNoBonusProbability??null,noBonusPnl,pnl,weightedPnl};});
 return {...flow,goalScenarios,roundKey:s.roundKey,ante,openingBank:finite(a.openingBank)?a.openingBank:null,endingBank:settled?a.endCash:null,estimatedSettlement,estimatedPnl:estimatedSettlement===null?null:flow.netCash-ante+estimatedSettlement,actualPayout,actualPnl,source,settlementPending:s.status==='ended'&&actualPnl===null};
}
function restore(events,snapshot,at){
 let a={},s=null;for(const e of events){
  if(e.kind==='round_start'||e.kind==='checkpoint')s=JSON.parse(JSON.stringify(e.snapshot));
  if(!s)continue;
  if(e.kind==='fill'&&e.index>=s.trades.length)s.trades.push(e.trade);
  if(e.kind==='state')Object.assign(s,{cash:e.cash,status:e.status,timer:e.timer,held:e.held});
  if(e.kind==='clock')Object.assign(s,{timer:e.timer,status:e.status});
  if(['round_start','checkpoint','state','clock'].includes(e.kind))observe(a,s,e.at);
 }
 if(snapshot)observe(a,snapshot,at);return a;
}
scope.FiggiePnl={cashFlow,observe,summary,restore,handPayout};if(typeof module!=='undefined')module.exports=scope.FiggiePnl;
})(globalThis);
