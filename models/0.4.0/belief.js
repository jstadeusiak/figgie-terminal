/* Local inference: exact physical constraints, stratified hidden-hand worlds,
   and deliberately conservative, explicitly provisional opponent likelihoods. */
(function(scope){
'use strict';
const IDS=['s','c','d','h'], VERSION='0.4.0';
const MODEL_FITS={'bots:Medium':{blend:.55,signals:{temperature:.30,quote:.20,consent:.12,cap:5},prospectivelyValidated:false}};
const chooseTable=Array.from({length:41},(_,n)=>Array.from({length:41},(_,k)=>{if(k>n)return 0;let v=1;for(let i=1;i<=Math.min(k,n-k);i++)v*= (n-Math.min(k,n-k)+i)/i;return v;}));
const C=(n,k)=>n>=0&&k>=0&&k<=n?chooseTable[n][k]:0;
const sum=a=>a.reduce((x,y)=>x+y,0),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const sigmoid=x=>1/(1+Math.exp(-clamp(x,-40,40)));
const logsumexp=a=>{const m=Math.max(...a);return m+Math.log(sum(a.map(v=>Math.exp(v-m))));};
function hash(value){let h=2166136261;for(const c of String(value))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;}
function rng(seed){return ()=>{seed=(seed+0x6D2B79F5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=t+Math.imul(t^(t>>>7),61|t)^t;return ((t^(t>>>14))>>>0)/4294967296;};}
const DECKS=[];for(let a=0;a<4;a++)for(let b=0;b<4;b++)if(a!==b){const deck=[10,10,10,10];deck[a]=12;deck[b]=8;DECKS.push({deck,goal:a^1});}
const handCache=new Map();
function privateBelief(hand){
 const key=hand.join(',');if(handCache.has(key))return handCache.get(key);
 let total=0;const goals=[0,0,0,0],counts=[0,0,0,0];
 for(const d of DECKS){const w=d.deck.reduce((v,k,s)=>v*C(k,hand[s]),1);total+=w;goals[d.goal]+=w;d.deck.forEach((v,s)=>counts[s]+=w*v);}
 const result={goals:goals.map(v=>v/total),counts:counts.map(v=>v/total)};handCache.set(key,result);return result;
}
function physical(snapshot){
 const names=snapshot.players.map(p=>p.name),n=names.length,size=40/n,hand=snapshot.startingHand;
 if(![4,5].includes(n)||sum(hand)!==size||hand.some(v=>!Number.isInteger(v)||v<0||v>12))throw Error('Invalid deal');
 const net=names.map(()=>[0,0,0,0]),minimum=names.map(()=>[0,0,0,0]);
 for(const t of snapshot.trades){const s=IDS.indexOf(t.suit),a=names.indexOf(t.s),b=names.indexOf(t.b);if(s<0||a<0||b<0||a===b)throw Error('Invalid trade');net[a][s]--;minimum[a][s]=Math.max(minimum[a][s],-net[a][s]);net[b][s]++;}
 if(hand.some((v,s)=>v<minimum[0][s]))throw Error('Hand contradicts history');if(snapshot.held?.some((v,s)=>v!==hand[s]+net[0][s]))throw Error('Current inventory contradicts the reconstructed deal');
 return {names,n,size,hand,net,minimum};
}
/* Dynamic program over suit allocations. It integrates ALL feasible allocations,
   rather than assuming the Monte Carlo sample gives the structural goal odds. */
function allocationDP(remaining,lower,size){
 const k=lower.length,memo=new Map(),drawCache=new Map();
 const future=lower.map(row=>[0,1,2,3,4].map(s=>sum(row.slice(s))));
 const ways=counts=>{let left=sum(counts),v=1;for(let p=0;p<counts.length-1;p++){v*=C(left,counts[p]);left-=counts[p];}return v;};
 function key(s,caps){return s+':'+caps.join(',');}
 function transitions(s,caps){
  const result=[],row=Array(k).fill(0),total=remaining[s];
  function rec(p,left){
   if(p===k-1){row[p]=left;if(left<lower[p][s]||left>caps[p]-future[p][s+1])return;
    const next=caps.map((v,i)=>v-row[i]);if(next.some(v=>v<0))return;
    const tail=mass(s+1,next);if(tail>0)result.push({row:row.slice(),next,weight:ways(row)*tail});return;}
   const lo=lower[p][s],hi=Math.min(left,caps[p]-future[p][s+1]);
   for(let v=lo;v<=hi;v++){row[p]=v;rec(p+1,left-v);}
  }
  rec(0,total);return result;
 }
 function mass(s,caps){
  if(caps.some((v,p)=>v<future[p][s]))return 0;
  if(s===4)return caps.every(v=>v===0)?1:0;
  if(s===3)return sum(caps)===remaining[3]&&caps.every((v,p)=>v>=lower[p][3])?ways(caps):0;
  const id=key(s,caps);if(memo.has(id))return memo.get(id);
  const v=sum(transitions(s,caps).map(r=>r.weight));memo.set(id,v);return v;
 }
 const initial=Array(k).fill(size),total=mass(0,initial);
 function sample(random){
  const result=Array.from({length:k},()=>[0,0,0,0]);let caps=initial.slice();
  for(let s=0;s<3;s++){
   const id=key(s,caps);let choices=drawCache.get(id);if(!choices){choices=transitions(s,caps);drawCache.set(id,choices);}
   let pick=random()*sum(choices.map(v=>v.weight)),selected=choices.at(-1);
   for(const candidate of choices){pick-=candidate.weight;if(pick<=0){selected=candidate;break;}}
   if(!selected)throw Error('No feasible sampled allocation');
   selected.row.forEach((v,p)=>result[p][s]=v);caps=selected.next;
  }
  caps.forEach((v,p)=>result[p][3]=v);return result;
 }
 let denominator=1,left=sum(remaining);for(let p=0;p<k-1;p++){denominator*=C(left,size);left-=size;}
 return {mass:total/denominator,sample,states:memo.size};
}
function payout(counts,bonus){const max=Math.max(...counts);let tied=0;for(const v of counts)if(v===max)tied++;return 10*counts[0]+(counts[0]===max?bonus/tied:0);}
function transferValue(world,net,s,other,buy){
 if(s!==world.goal)return 0;const counts=world.initial.map((row,p)=>row[s]+net[p][s]),before=payout(counts,world.bonus);
 counts[0]+=buy?1:-1;counts[other]+=buy?-1:1;const after=payout(counts,world.bonus);return buy?after-before:before-after;
}
const STYLE_NAMES=['value','bonus','liquidity','noise'];
const DEFAULT_PRIOR=[.30,.25,.20,.25];
function reservation(initial,actor,s,context,style){
 const belief=privateBelief(initial),q=belief.goals[s],net=context.net||[],qty=initial[s]+(net[actor]?.[s]||0);
 const others=context.names?.length||4;
 const estimatedMax=Math.max(0,...Array.from({length:others},(_,p)=>p===actor?0:(belief.counts[s]-initial[s])/(others-1)+(net[p]?.[s]||0)));
 const lead=Math.exp(-.5*((qty-estimatedMax)/1.6)**2);
 if(style===2)return Math.max(1,context.anchor||5)-.25*(qty-3);
 return 10*q+(style===1?110*q*lead/(others-1):0);
}
function eventLogs(initial,actor,event,context){
 const s=IDS.indexOf(event.suit);if(s<0)return [0,0,0,0];
 const buy=event.direction==='buy',qty=initial[s]+(event.net?.[actor]?.[s]||0),price=event.price,ctx={...context,net:event.net,anchor:event.anchor};
 const results=[];
 for(let style=0;style<4;style++){
  if(style===3){results.push(Math.log(event.kind==='quote'?1/80:.5));continue;}
  const value=reservation(initial,actor,s,ctx,style),scale=style===2?6:4;
  let likelihood;
  if(event.kind==='take'||event.kind==='consent'){
   const willingness=sigmoid((buy?value-price:price-value)/scale);
   likelihood=.03+.94*willingness;
  }else{
   const center=value+(buy?-2:2),upper=sigmoid((price+.5-center)/scale),lower=sigmoid((price-.5-center)/scale);
   const normalizer=1-sigmoid((.5-center)/scale);
   likelihood=.025/80+.975*Math.max(1e-7,(upper-lower)/Math.max(.02,normalizer));
  }
  if(!buy&&qty<1)likelihood*=.02;
  results.push(Math.log(Math.max(1e-9,likelihood)));
 }
 return results;
}
function chooseEvidence(events,self){
 // Repeated pennies replace ONE quote episode. Our own choices never vote for
 // their own goal hypothesis. Absence, outbidding and forced resets are not sells.
 const episodes=new Map();
 for(const e of events){
  if(!['quote','take','consent'].includes(e.kind)||e.actor===self||!Number.isFinite(e.price)||!e.suit)continue;
  const id=[e.epoch,e.actor,e.suit,e.direction].join('|'),old=episodes.get(id);
  if(!old||e.kind==='take'||(e.kind==='consent'&&old.kind==='quote')||(old.kind==='quote'&&e.kind==='quote'&&(e.direction==='buy'?e.price>old.price:e.price<old.price)))episodes.set(id,e);
 }
 const byActor=new Map();for(const e of episodes.values()){if(!byActor.has(e.actor))byActor.set(e.actor,[]);byActor.get(e.actor).push(e);}
 const result=[];for(const list of byActor.values()){
  const sorted=list.sort((a,b)=>a.at-b.at),first=sorted.slice(0,8),recent=sorted.slice(-16);
  for(const e of new Set([...first,...recent]))result.push(e);
 }
 return result;
}
class BeliefEngine{
 constructor(options={}){this.samples=options.samples||512;this.pool=null;this.poolKey='';this.rebuilds=0;}
 build(snapshot){
  const state=physical(snapshot),key=JSON.stringify([state.names,state.hand,state.minimum]);
  if(this.poolKey===key){this.state=state;return;}
  const configurations=[],worlds=[],handOdds=[0,0,0,0];let handTotal=0,total=0;
  for(const d of DECKS){
   const h=d.deck.reduce((v,k,s)=>v*C(k,state.hand[s]),1)/C(40,state.size)/12;handOdds[d.goal]+=h;handTotal+=h;if(!h)continue;
   const remaining=d.deck.map((v,s)=>v-state.hand[s]);if(remaining.some(v=>v<0))continue;
   const dp=allocationDP(remaining,state.minimum.slice(1),state.size),mass=h*dp.mass;if(!(mass>0))continue;
   const config={...d,mass};configurations.push(config);total+=mass;
   const random=rng(hash(key+'|'+d.deck.join(','))),count=state.n===5?Math.max(192,Math.floor(this.samples*.75)):this.samples;
   for(let i=0;i<count;i++){const initial=[state.hand.slice(),...dp.sample(random)];worlds.push({initial,codes:initial.map(row=>row.join(',')),goal:d.goal,bonus:200-10*d.deck[d.goal],base:mass/count});}
  }
  if(!total)throw Error('No legal deals satisfy the observed inventories');
  for(const w of worlds)w.base/=total;
  this.pool={worlds,configurations:configurations.map(c=>({...c,probability:c.mass/total})),handOdds:handOdds.map(v=>v/handTotal),evidenceProbability:total/handTotal};this.poolKey=key;this.state=state;this.rebuilds++;
 }
 infer(snapshot,events=[],learning={}){
  const started=performance.now();this.build(snapshot);const {worlds}=this.pool,state=this.state,evidence=chooseEvidence(events,snapshot.self),context={names:state.names};
  const actorEvidence=state.names.map(name=>evidence.filter(e=>e.actor===name)),lookup=state.names.map(()=>new Map());
  const logWeights=[],stylesByWorld=[];
  const allBots=snapshot.players.every(p=>p.name===snapshot.self||/^Bot-/.test(p.name)),group=allBots?'bots'+(snapshot.context?.botDifficulty?':'+snapshot.context.botDifficulty:''):'mixed';
  const priors=state.names.map((name,p)=>{const prior=learning.stylePriors?.[name]||learning.population?.[group]||learning.population?.[allBots?'bots':'mixed']||DEFAULT_PRIOR;return prior.map(v=>Math.log(Math.max(.02,v)));});
  for(const world of worlds){let score=0;const actorStyles=[];
   for(let actor=1;actor<state.n;actor++){
    const code=world.codes[actor];let stats=lookup[actor].get(code);
    if(!stats){const logs=[0,0,0,0],observations=actorEvidence[actor],weightTotal=sum(observations.map(e=>e.kind==='take'?(e.recovered?.2:(e.confidence??1)):e.kind==='consent'?.12:(e.recovered?.05:.20))),cap=Math.min(1,5/Math.max(1,weightTotal));
     for(const e of observations){const l=eventLogs(world.initial[actor],actor,e,context),strength=(e.kind==='take'?(e.recovered?.2:(e.confidence??1)):e.kind==='consent'?.12:(e.recovered?.05:.20))*cap;for(let j=0;j<4;j++)logs[j]+=strength*l[j];}
     const joint=logs.map((v,j)=>v+priors[actor][j]),normalizer=logsumexp(joint);stats={score:normalizer,styles:joint.map(v=>Math.exp(v-normalizer))};lookup[actor].set(code,stats);
    }
    score+=stats.score;actorStyles[actor]=stats.styles;
   }
   logWeights.push(Math.log(world.base)+.30*score);stylesByWorld.push(actorStyles);
  }
  const normalizer=logsumexp(logWeights),behavior=logWeights.map(v=>Math.exp(v-normalizer));
  // Behavior has no calibrated track record at installation. A physical mixture
  // preserves uncertainty instead of presenting assumed policies as learned fact.
  const fit=MODEL_FITS[group],groupMetrics=learning.groupMetrics?.[group],calibrated=Boolean(fit?.prospectivelyValidated),failed=(groupMetrics?.rounds||0)>=12&&groupMetrics.opponentBrier>groupMetrics.baselineBrier+.025;
  const recommendedBlend=failed?.10:fit?.blend??.35,blend=learning.forceBaseline?0:recommendedBlend,weights=worlds.map((w,i)=>(1-blend)*w.base+blend*behavior[i]);
  const structural=[0,0,0,0],raw=[0,0,0,0],goals=[0,0,0,0],stylePosterior=state.names.map(()=>[0,0,0,0]);
  const bySuit=IDS.map(()=>({probability:0,base:0,buy:null,sell:null,holding:0,counterparties:{}}));
  for(const suit of bySuit)for(const name of state.names.slice(1))suit.counterparties[name]={mass:0,buyValue:0,sellValue:0};
  let expectedPayout=0,leaderProbability=0;
  for(let i=0;i<worlds.length;i++){
   const w=worlds[i],weight=weights[i],g=w.goal;structural[g]+=w.base;raw[g]+=behavior[i];goals[g]+=weight;
   const counts=w.initial.map((row,p)=>row[g]+state.net[p][g]),before=payout(counts,w.bonus);w.buyDelta=[];w.sellDelta=[];for(let actor=1;actor<state.n;actor++){const after=counts.slice();after[0]++;after[actor]--;w.buyDelta[actor]=payout(after,w.bonus)-before;after[0]-=2;after[actor]+=2;w.sellDelta[actor]=before-payout(after,w.bonus);}expectedPayout+=weight*before;if(counts[0]===Math.max(...counts))leaderProbability+=weight;
   bySuit[g].holding+=weight*before;
   for(let actor=1;actor<state.n;actor++){
    stylesByWorld[i][actor].forEach((v,j)=>stylePosterior[actor][j]+=weight*v);
    for(let s=0;s<4;s++){const item=bySuit[s].counterparties[state.names[actor]];
     if(w.initial[actor][s]+state.net[actor][s]>0){item.mass+=weight;if(g===s)item.buyValue+=weight*w.buyDelta[actor];}
     if(snapshot.held[s]>0&&g===s)item.sellValue+=weight*w.sellDelta[actor];
    }
   }
  }
  bySuit.forEach((v,s)=>{
   v.probability=goals[s];v.structuralProbability=structural[s];v.behaviorProbability=raw[s];v.handProbability=this.pool.handOdds[s];v.base=10*goals[s];
   for(const item of Object.values(v.counterparties)){item.buy=item.mass?item.buyValue/item.mass:null;item.sell=item.sellValue;item.hasCardProbability=item.mass;delete item.mass;delete item.buyValue;delete item.sellValue;}
   v.buy=v.counterparties[snapshot.markets[s].seller]?.buy??null;v.sell=v.counterparties[snapshot.markets[s].buyer]?.sell??null;
  });
  const expectedBase=sum(bySuit.map((s,i)=>s.base*snapshot.held[i])),effective=1/sum(weights.map(v=>v*v));
  const model={version:VERSION,mode:learning.forceBaseline?'Cards only':'Opponent',bySuit,expectedPayout,expectedBase,expectedBonus:expectedPayout-expectedBase,leaderProbability,stateCount:worlds.length,currentInventory:snapshot.held.slice(),net:state.net,minimum:state.minimum,
   scoringProbabilities:structural.map((p,i)=>(1-recommendedBlend)*p+recommendedBlend*raw[i]),baseline:{mode:'Exact constraints',probabilities:structural},behavior:{probabilities:raw,blend,group,validation:fit||null,observations:evidence.length,provisional:!calibrated||failed,styles:state.names.slice(1).map((name,i)=>({name,probabilities:Object.fromEntries(STYLE_NAMES.map((s,j)=>[s,stylePosterior[i+1][j]]))}))},
   metrics:learning.metrics||{rounds:0},effectiveWorlds:effective,configurations:this.pool.configurations,evidenceProbability:this.pool.evidenceProbability};
  model.resting=this.resting(snapshot,worlds,weights,stylesByWorld,learning);model.actualBook=this.resting(snapshot,worlds,weights,stylesByWorld,learning,true);
  this.latest={worlds,weights,stylesByWorld,names:state.names};model.computeMs=performance.now()-started;return model;
 }
 revealedStyles(goal){
  if(!this.latest)return [];const {worlds,weights,stylesByWorld,names}=this.latest,g=IDS.indexOf(goal);let mass=0;const values=names.map(()=>[0,0,0,0]);
  worlds.forEach((w,i)=>{if(w.goal!==g)return;mass+=weights[i];for(let actor=1;actor<names.length;actor++)stylesByWorld[i][actor].forEach((v,j)=>values[actor][j]+=weights[i]*v);});
  if(!mass)return [];return names.slice(1).map((name,i)=>({name,probabilities:Object.fromEntries(STYLE_NAMES.map((s,j)=>[s,values[i+1][j]/mass]))}));
 }
 resting(snapshot,worlds,weights,stylesByWorld,learning,actual=false){
  const state=this.state,result={},horizon=10,nowContext={names:state.names,net:state.net};
  for(let s=0;s<4;s++){
   const market=snapshot.markets[s];result[market.id]={};
   for(const side of ['bid','ask']){
    const buy=side==='bid',draft=learning.quotePrices?.[market.id]?.[side],custom=Number.isSafeInteger(draft)&&draft>0,price=actual?market[side]:custom?draft:buy?(Number.isFinite(market.bid)?market.bid+1:null):(Number.isFinite(market.ask)?market.ask-1:null);
    if(actual){if(market[buy?'buyer':'seller']!==snapshot.self||!Number.isFinite(price)||(buy?snapshot.cash<price:snapshot.held[s]<1))continue;}else if(!(custom?(buy?market.canBid:market.canOffer):(buy?market.canRaiseBid:market.canLowerAsk))||!Number.isSafeInteger(price)||price<1||(buy?snapshot.cash<price:snapshot.held[s]<1))continue;
    // A quote behind the current best never becomes top during this horizon.
    // Treat it as unavailable rather than borrowing a top-of-book fill rate.
    if(!actual&&custom&&Number.isFinite(market[side])&&((buy?price<market.bid:price>market.ask)||(price===market[side]&&market[buy?'buyer':'seller']!==snapshot.self)))continue;
    const rates=learning.rates?.[side]||{},baseFill=(1+(rates.fills||0))/(30+(rates.exposure||0)),outbid=(1+(rates.outbids||0))/(10+(rates.exposure||0)),reset=(1+(learning.rates?.resets||0))/(10+(learning.rates?.liveSeconds||0));
    const willingnessCache=state.names.map(()=>new Map());let pFill=0,ev=0;const parties=state.names.map(()=>({mass:0,value:0}));
    for(let i=0;i<worlds.length;i++){
     const world=worlds[i],hazards=[];let total=0;
     for(let actor=1;actor<state.n;actor++){
      const qty=world.initial[actor][s]+state.net[actor][s],cash=snapshot.players[actor].cash;if((buy&&qty<1)||(!buy&&cash<price)){hazards[actor]=0;continue;}
      const code=world.codes[actor];let willing=willingnessCache[actor].get(code);
      if(willing===undefined){willing=0;const style=stylesByWorld[i][actor],context={...nowContext,anchor:market.fills.at(-1)?.p||((market.bid&&market.ask)?(market.bid+market.ask)/2:5)};
       for(let j=0;j<4;j++){const value=j===3?0:reservation(world.initial[actor],actor,s,context,j);willing+=style[j]*(j===3?.5:sigmoid((buy?price-value:value-price)/(j===2?6:4)));}
       willingnessCache[actor].set(code,willing);
      }
      const intensity=baseFill*2*willing/(state.n-1);hazards[actor]=intensity;total+=intensity;
     }
     if(!total)continue;const competing=total+outbid+reset,fill=total/competing*(1-Math.exp(-competing*horizon));pFill+=weights[i]*fill;
     for(let actor=1;actor<state.n;actor++)if(hazards[actor]){
      const mass=weights[i]*fill*hazards[actor]/total,value=buy?(world.goal===s?world.buyDelta[actor]:0)-price:price-(world.goal===s?world.sellDelta[actor]:0);
      ev+=mass*value;parties[actor].mass+=mass;parties[actor].value+=mass*value;
     }
    }
    result[market.id][side]={price,horizon,pFill,ev,conditionalEdge:pFill?ev/pFill:null,provisional:learning.fillCalibrationValidated!==true,observedFills:rates.fills||0,exposureSeconds:rates.exposure||0,
     scope:'Before reset, losing top of book, or 10 seconds; no automatic cancellation',counterparties:state.names.slice(1).map((name,i)=>({name,probability:pFill?parties[i+1].mass/pFill:0,conditionalEdge:parties[i+1].mass?parties[i+1].value/parties[i+1].mass:null}))};
   }
  }
  return result;
 }
}
scope.FiggieBelief={VERSION,IDS,DECKS,STYLE_NAMES,DEFAULT_PRIOR,BeliefEngine,physical,allocationDP,privateBelief,chooseEvidence,eventLogs,hash};
if(typeof module!=='undefined')module.exports=scope.FiggieBelief;
})(globalThis);
