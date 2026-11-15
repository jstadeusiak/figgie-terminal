/* Local inference: exact physical constraints, stratified hidden-hand worlds,
   and deliberately conservative, explicitly provisional opponent likelihoods. */
(function(scope){
'use strict';
const IDS=['s','c','d','h'], VERSION='0.11.0';
const MODEL_FITS=typeof require==='function'?require('./model-fit-v0.11.js'):(scope.FiggieModelFit||{});
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
// A native live ask exposes ownership even when it never executes. Validate its
// epoch against public trade flow before using it as an inventory lower bound.
function askInventoryConstraints(snapshot,state,events){
 const byEpoch=new Map(),diagnostic={qualifiedAsks:0,tightenedBounds:0,rejectedAsks:0,fallback:false};
 for(const e of events){if(e.kind!=='quote'||e.direction!=='sell'||e.recovered)continue;
  const actor=state.names.indexOf(e.actor),s=IDS.indexOf(e.suit);
  if(actor<=0||s<0)continue;
  if(!Number.isSafeInteger(e.epoch)||e.epoch<0||e.epoch>snapshot.trades.length||!Number.isSafeInteger(e.price)||e.price<=0||!Array.isArray(e.net)||e.net.length!==state.n){diagnostic.rejectedAsks++;continue;}
  if(!byEpoch.has(e.epoch))byEpoch.set(e.epoch,[]);byEpoch.get(e.epoch).push({e,actor,s});
 }
 const net=state.names.map(()=>[0,0,0,0]);
 for(let epoch=0;epoch<=snapshot.trades.length;epoch++){
  for(const {e,actor,s}of byEpoch.get(epoch)||[]){
   if(e.net.some((row,p)=>!Array.isArray(row)||row.length!==4||row.some((v,i)=>!Number.isSafeInteger(v)||v!==net[p][i]))){diagnostic.rejectedAsks++;continue;}
   const minimum=Math.max(0,1-net[actor][s]);
   if(minimum>state.size){diagnostic.rejectedAsks++;continue;}
   diagnostic.qualifiedAsks++;if(minimum>state.minimum[actor][s]){state.minimum[actor][s]=minimum;diagnostic.tightenedBounds++;}
  }
  const t=snapshot.trades[epoch];if(t){const s=IDS.indexOf(t.suit);net[state.names.indexOf(t.b)][s]++;net[state.names.indexOf(t.s)][s]--;}
 }
 return diagnostic;
}
// Residual inventory calibration: net acquirers tended to start with more cards
// in the audited four-player Medium-bot rounds. Renormalize within each goal so
// this changes bonus/selection estimates, never the goal-suit marginal itself.
function inventoryWeights(worlds,weights,net,strength,minEffective=64){
 const mass=[0,0,0,0],maxScore=[-Infinity,-Infinity,-Infinity,-Infinity],scores=worlds.map(w=>strength*sum(w.initial.slice(1).map((row,a)=>Math.max(0,net[a+1][w.goal])*row[w.goal])));
 worlds.forEach((w,i)=>{mass[w.goal]+=weights[i];maxScore[w.goal]=Math.max(maxScore[w.goal],scores[i]);});
 const norm=[0,0,0,0],raw=worlds.map((w,i)=>{const x=weights[i]*Math.exp(scores[i]-maxScore[w.goal]);norm[w.goal]+=x;return x;});
 const p2=[0,0,0,0],q2=[0,0,0,0],pq=[0,0,0,0];worlds.forEach((w,i)=>{const g=w.goal;if(!mass[g])return;const p=weights[i]/mass[g],q=raw[i]/norm[g];p2[g]+=p*p;q2[g]+=q*q;pq[g]+=p*q;});
 const blends=mass.map((m,g)=>{if(!m||!minEffective)return 1;const target=Math.min(minEffective,1/p2[g]);if(1/q2[g]>=target)return 1;const a=q2[g]+p2[g]-2*pq[g],b=2*(pq[g]-p2[g]),c=p2[g]-1/target;return a>1e-15?clamp((-b+Math.sqrt(Math.max(0,b*b-4*a*c)))/(2*a),0,1):0;});
 const after2=[0,0,0,0],result=worlds.map((w,i)=>{const g=w.goal;if(!mass[g])return 0;const p=weights[i]/mass[g],q=raw[i]/norm[g],v=p+blends[g]*(q-p);after2[g]+=v*v;return mass[g]*v;});
 return {weights:result,goals:mass.map((m,g)=>({suit:IDS[g],probability:m,effectiveBefore:m?1/p2[g]:null,effectiveAfter:m?1/after2[g]:null,calibrationBlend:blends[g]}))};
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
/* A second, deliberately separate information set for a hypothetical opponent.
   It never receives the viewer's dealt hand or the other hands of an outer
   inference world. Lower bounds are reconstructed at the action's public cut.
   Public goal probabilities integrate all feasible allocations by polynomial
   convolution; bonus ownership uses bounded conditional importance sampling. */
const LOG_FACTORIAL=[0];for(let i=1;i<=40;i++)LOG_FACTORIAL[i]=LOG_FACTORIAL[i-1]+Math.log(i);
const HYPERGEOMETRIC=[];
function hypergeometricDraw(total,successes,draws,random){
 if(!successes||!draws)return 0;if(successes===total)return draws;
 const key=(total*13+successes)*11+draws;let table=HYPERGEOMETRIC[key];
 if(!table){const low=Math.max(0,draws-(total-successes)),high=Math.min(draws,successes),cdf=[];let mass=0;for(let k=low;k<=high;k++){mass+=C(successes,k)*C(total-successes,draws-k);cdf.push(mass);}table={low,cdf,mass};HYPERGEOMETRIC[key]=table;}
 const pick=random()*table.mass;let i=0;while(i<table.cdf.length-1&&pick>=table.cdf[i])i++;return table.low+i;
}
const PUBLIC_HAND_ROWS=new Map();
function publicHandRows(size,lower){
 const key=size+'|'+lower.join(',');if(PUBLIC_HAND_ROWS.has(key))return PUBLIC_HAND_ROWS.get(key);const rows=[];
 for(let a=lower[0];a<=size-lower[1]-lower[2]-lower[3];a++)for(let b=lower[1];b<=size-a-lower[2]-lower[3];b++)for(let c=lower[2];c<=size-a-b-lower[3];c++){
  const d=size-a-b-c;rows.push({a,b,c,d,index:a*169+b*13+c,weight:Math.exp(-LOG_FACTORIAL[a]-LOG_FACTORIAL[b]-LOG_FACTORIAL[c]-LOG_FACTORIAL[d])});
 }
 PUBLIC_HAND_ROWS.set(key,rows);if(PUBLIC_HAND_ROWS.size>256)PUBLIC_HAND_ROWS.delete(PUBLIC_HAND_ROWS.keys().next().value);return rows;
}
// Integrate every legal unknown hand once per public-bound pattern. Coefficients
// of the product of hand polynomials are sums of 1/prod(card-count factorials).
// Legal decks all share 12!10!10!8!, so for a fixed private hand these exact
// coefficients are proportional to the deck posterior. The fourth suit count
// follows from the known total; only three coordinates need storage.
function publicMassTable(size,lower){
 let layer=new Float64Array(2197);layer[0]=1;let active=[{a:0,b:0,c:0,d:0,index:0}];
 for(const bound of lower){const next=new Float64Array(2197),nextActive=[],rows=publicHandRows(size,bound);
  for(const p of active){const previous=layer[p.index];for(const h of rows){const a=p.a+h.a,b=p.b+h.b,c=p.c+h.c,d=p.d+h.d;if(a>12||b>12||c>12||d>12)continue;const index=p.index+h.index;if(!next[index])nextActive.push({a,b,c,d,index});next[index]+=previous*h.weight;}}
  layer=next;active=nextActive;
 }
 return layer;
}
class OpponentKnowledge{
 constructor(options={}){this.samples=Math.max(8,Math.min(128,options.samples||12));this.maxEntries=options.maxEntries||6000;this.cache=new Map();this.massCache=new Map();this.prefixCache=new Map();this.namespace='';this.stats={builds:0,hits:0,samples:0,minEffective:Infinity};}
 prepare(snapshot,events){
  const namespace=JSON.stringify([snapshot.roundKey,snapshot.players.map(p=>p.name)]);if(namespace!==this.namespace){this.cache.clear();this.massCache.clear();this.prefixCache.clear();this.namespace=namespace;}
  this.names=snapshot.players.map(p=>p.name);this.n=this.names.length;this.size=40/this.n;this.events=events;this.trades=snapshot.trades;
  const zero=()=>this.names.map(()=>[0,0,0,0]);this.nets=[zero()];this.floors=[zero()];
  for(const t of this.trades){const net=this.nets.at(-1).map(r=>r.slice()),floor=this.floors.at(-1).map(r=>r.slice()),s=IDS.indexOf(t.suit),a=this.names.indexOf(t.s),b=this.names.indexOf(t.b);if(s<0||a<0||b<0)break;net[a][s]--;net[b][s]++;floor[a][s]=Math.max(floor[a][s],-net[a][s]);this.nets.push(net);this.floors.push(floor);}
  this.asks=[];for(const e of events){if(e.kind!=='quote'||e.direction!=='sell'||e.recovered)continue;const a=this.names.indexOf(e.actor),s=IDS.indexOf(e.suit),net=this.nets[e.epoch];if(a<0||s<0||!net||!Number.isSafeInteger(e.price)||e.price<=0||!this.sameNet(e.net,net))continue;this.asks.push({event:e,actor:a,suit:s,minimum:Math.max(0,1-net[a][s])});}
  this.prefixCache.clear();
 }
 sameNet(a,b){return Array.isArray(a)&&a.length===b.length&&a.every((r,p)=>Array.isArray(r)&&r.length===4&&r.every((v,s)=>v===b[p][s]));}
 before(a,b){
  if(a.epoch!==b.epoch)return a.epoch<b.epoch;if(b.passive===true||b.recovered)return false;
  // Quotes read in the same DOM observation have an arbitrary append order.
  // Their source sequence does not prove one was visible before the other.
  if(Number.isFinite(a.at)&&a.at===b.at)return false;
  if(Number.isFinite(a.sourceSeq)&&Number.isFinite(b.sourceSeq))return a.sourceSeq<b.sourceSeq;
  return Number.isFinite(a.at)&&Number.isFinite(b.at)&&a.at<b.at;
 }
 prefix(event=null){
  const epoch=event?event.epoch:this.trades.length,net=this.nets[epoch];if(!net||(event&&!this.sameNet(event.net,net)))return null;
  const key=event?JSON.stringify([epoch,event.sourceSeq??null,event.at??null,event.passive===true,event.recovered===true]):'current';if(this.prefixCache.has(key))return this.prefixCache.get(key);
  const lower=this.floors[epoch].map(r=>r.slice());for(const ask of this.asks)if(!event||this.before(ask.event,event))lower[ask.actor][ask.suit]=Math.max(lower[ask.actor][ask.suit],ask.minimum);
  const value={epoch,net,lower,key:lower.map(r=>r.join(',')).join(';')};this.prefixCache.set(key,value);return value;
 }
 posterior(initial,actor,prefix,other=-1,buy=false,suit=-1){
  if(!prefix||initial.some((v,s)=>v<prefix.lower[actor][s]))return null;
  let lower=prefix.lower;
  // Taking a named seller's offer discloses that one card is available now.
  // This is observable ownership, not the seller's hidden inventory quantity.
  if(buy&&other>=0&&other!==actor&&suit>=0){const minimum=Math.max(0,1-prefix.net[other][suit]);if(minimum>lower[other][suit]){lower=lower.map(r=>r.slice());lower[other][suit]=minimum;}}
  // An actor already knows their exact hand; changes in their own public floor
  // supply no new information and must not create another conditional pool.
  // Seat names do not affect deal probability. Canonical seat order shares a
  // conditional pool across actors while restoring actual identities at value
  // time. Equal-bound seats remain exchangeable, not known hidden hands.
  const others=this.names.map((_,p)=>p).filter(p=>p!==actor).sort((a,b)=>{for(let s=0;s<4;s++)if(lower[a][s]!==lower[b][s])return lower[a][s]-lower[b][s];return a-b;}),order=[actor,...others];
  const cacheKey=initial.join(',')+'|'+others.map(p=>lower[p].join(',')).join(';');let result=this.cache.get(cacheKey);if(result){this.stats.hits++;this.cache.delete(cacheKey);this.cache.set(cacheKey,result);return {pool:result,order};}
  const caps=others.map(p=>this.size-sum(lower[p]));if(caps.some(v=>v<0))return null;
  const massKey=this.size+'|'+others.map(p=>lower[p].join(',')).join(';');let masses=this.massCache.get(massKey);if(!masses){masses=publicMassTable(this.size,others.map(p=>lower[p]));this.massCache.set(massKey,masses);if(this.massCache.size>256)this.massCache.delete(this.massCache.keys().next().value);}
  const residualTotal=sum(caps),mandatory=IDS.map((_,s)=>sum(others.map(p=>lower[p][s]))),packedValues=[],goalValues=[],bonusValues=[],logWeights=[],ranges=[];let totalMass=0;
  for(let di=0;di<DECKS.length;di++){
   const config=DECKS[di],remaining=config.deck.map((v,s)=>v-initial[s]),residual=remaining.map((v,s)=>v-mandatory[s]);if(residual.some(v=>v<0))continue;
   const mass=masses[remaining[0]*169+remaining[1]*13+remaining[2]];if(!(mass>0))continue;const start=logWeights.length,random=rng(hash(cacheKey+'|'+di));totalMass+=mass;
   for(let sample=0;sample<this.samples;sample++){
    const left=residual.slice();let count=residualTotal,weight=0,packed=initial[config.goal];
    for(let p=0;p<others.length;p++){
     let population=count,draw=caps[p];const lo=lower[others[p]];
     for(let s=0;s<4;s++){const available=left[s],x=p===others.length-1?available:s===3?draw:hypergeometricDraw(population,available,draw,random);population-=available;draw-=x;left[s]-=x;const v=lo[s]+x;weight+=LOG_FACTORIAL[x]-LOG_FACTORIAL[v];if(s===config.goal)packed|=v<<((p+1)*4);}
     count-=caps[p];
    }
    packedValues.push(packed);goalValues.push(config.goal);bonusValues.push(200-10*config.deck[config.goal]);logWeights.push(weight);
   }
   ranges.push({start,end:logWeights.length,mass});
  }
  if(!logWeights.length)return null;
  const probabilities=[0,0,0,0],packed=Uint32Array.from(packedValues),goals=Uint8Array.from(goalValues),bonuses=Uint8Array.from(bonusValues),weights=new Float64Array(logWeights.length);let square=0;
  for(const range of ranges){const normalizer=logsumexp(logWeights.slice(range.start,range.end));for(let i=range.start;i<range.end;i++){const weight=range.mass/totalMass*Math.exp(logWeights[i]-normalizer);weights[i]=weight;probabilities[goals[i]]+=weight;square+=weight*weight;}}
  result={probabilities,packed,goals,bonuses,weights,effective:1/square,values:new Map()};this.cache.set(cacheKey,result);this.stats.builds++;this.stats.samples+=logWeights.length;this.stats.minEffective=Math.min(this.stats.minEffective,result.effective);if(this.cache.size>this.maxEntries)this.cache.delete(this.cache.keys().next().value);return {pool:result,order};
 }
 value(initial,actor,event=null,options={}){
  const prefix=options.prefix||this.prefix(event),s=options.suit??IDS.indexOf(event?.suit),buy=options.buy??event?.direction==='buy';
  const known=options.counterparty!==undefined?options.counterparty:event?.counterpartyKnownBeforeAction===true?this.names.indexOf(event.counterparty):-1,other=known>=0&&known!==actor?known:-1;
  const posterior=this.posterior(initial,actor,prefix,other,buy,s);if(!posterior||s<0)return null;const {pool:belief,order}=posterior,peerIndex=order.indexOf(other);
  const key=s+'|'+Number(buy)+'|'+peerIndex+'|'+order.map(p=>prefix.net[p][s]).join(',');if(belief.values.has(key))return belief.values.get(key);
  const q=belief.probabilities[s];let bonus=0;
  for(let i=0;i<belief.weights.length;i++){
   if(belief.goals[i]!==s)continue;const counts=order.map((p,j)=>((belief.packed[i]>>>(4*j))&15)+prefix.net[p][s]);if(!buy&&counts[0]<1)continue;
   const before=this.share(counts,0,belief.bonuses[i]),peers=peerIndex>=0?[peerIndex]:order.map((_,p)=>p).filter(p=>p!==0&&(!buy||counts[p]>0));let change=0,n=0;
   for(const peer of peers){if(buy&&counts[peer]<1)continue;counts[0]+=buy?1:-1;counts[peer]+=buy?-1:1;const after=this.share(counts,0,belief.bonuses[i]);counts[0]+=buy?-1:1;counts[peer]+=buy?1:-1;change+=buy?after-before:before-after;n++;}
   if(n)bonus+=belief.weights[i]*change/n;
  }
  const result={base:10*q,bonus,total:10*q+bonus,probabilities:belief.probabilities,effective:belief.effective,knownCounterparty:other>=0};belief.values.set(key,result);if(belief.values.size>48)belief.values.delete(belief.values.keys().next().value);return result;
 }
 share(counts,actor,bonus){const maximum=Math.max(...counts);if(counts[actor]!==maximum)return 0;return bonus/counts.filter(v=>v===maximum).length;}
 summary(){return {method:'Exact causal public goal probabilities; sampled conditional bonus',goalMethod:'Exact public-hand polynomial convolution',bonusMethod:'Conditional importance sampling',approximate:true,samplesPerDeck:this.samples,cachedHands:this.cache.size,exactPublicTables:this.massCache.size,builds:this.stats.builds,cacheHits:this.stats.hits,minEffective:Number.isFinite(this.stats.minEffective)?this.stats.minEffective:null};}
}
const STYLE_NAMES=['value','bonus','liquidity','noise'];
const DEFAULT_PRIOR=[.30,.25,.20,.25];
const DEFAULT_SIGNALS={temperature:.30,quote:.20,consent:.12,cap:5};
const evidenceStrength=(e,p)=>e.kind==='take'?(e.recovered?.2:(e.confidence??1)):e.kind==='consent'?p.consent:(e.recovered?.05:p.quote);
function reservation(initial,actor,s,context,style){
 if(context.knowledge&&style!==2){const value=context.knowledge.value(initial,actor,context.event,{prefix:context.prefix,suit:s,buy:context.buy,counterparty:context.counterparty});if(value)return style===1?value.total:value.base;}
 const belief=privateBelief(initial),q=belief.goals[s],net=context.net||[],qty=initial[s]+(net[actor]?.[s]||0);
 const others=context.names?.length||4;
 const estimatedMax=Math.max(0,...Array.from({length:others},(_,p)=>p===actor?0:(belief.counts[s]-initial[s])/(others-1)+(net[p]?.[s]||0)));
 const lead=Math.exp(-.5*((qty-estimatedMax)/1.6)**2);
 if(style===2)return Math.max(1,context.anchor||5)-.25*(qty-3);
 return 10*q+(style===1?110*q*lead/(others-1):0);
}
function eventLogs(initial,actor,event,context){
 const s=IDS.indexOf(event.suit);if(s<0)return [0,0,0,0];
 const buy=event.direction==='buy',qty=initial[s]+(event.net?.[actor]?.[s]||0),price=event.price,ctx={...context,net:event.net,anchor:event.anchor,event,buy};
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
function chooseEvidence(events,self,options={}){
 // Repeated pennies replace ONE quote episode. Our own choices never vote for
 // their own goal hypothesis. Absence, outbidding and forced resets are not sells.
 const episodes=new Map();
 for(const e of events){
  if(!['quote','take','consent'].includes(e.kind)||e.actor===self||!Number.isFinite(e.price)||!e.suit)continue;
  const id=[e.epoch,e.actor,e.suit,e.direction].join('|'),old=episodes.get(id);
  if(!old||e.kind==='take'||(e.kind==='consent'&&old.kind==='quote'&&e.passive!==true)||(old.kind==='quote'&&e.kind==='quote'&&(e.direction==='buy'?e.price>old.price:e.price<old.price)))episodes.set(id,e);
 }
 const byActor=new Map();for(const e of episodes.values()){if(!byActor.has(e.actor))byActor.set(e.actor,[]);byActor.get(e.actor).push(e);}
 const result=[];for(const list of byActor.values()){
  const sorted=list.sort((a,b)=>a.at-b.at),first=options.recentOnly?[]:sorted.slice(0,8),recent=sorted.slice(options.recentOnly?-24:-16);
  for(const e of new Set([...first,...recent]))result.push(e);
 }
 return result;
}
class BeliefEngine{
 constructor(options={}){this.samples=options.samples||512;this.pool=null;this.poolKey='';this.rebuilds=0;this.signalPolicy=options.signalPolicy;this.skipPricing=options.skipPricing===true;this.eventLogCache=new Map();this.opponentLearning=options.opponentLearning!==false;this.knowledge=this.opponentLearning?new OpponentKnowledge({samples:options.opponentSamples}):null;}
 build(snapshot,events=[]){
  const state=physical(snapshot),inventoryEvidence=askInventoryConstraints(snapshot,state,events);this.inventoryEvidence=inventoryEvidence;const key=JSON.stringify([state.names,state.hand,state.minimum]);
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
  if(!total){if(inventoryEvidence.tightenedBounds){this.build(snapshot,[]);this.inventoryEvidence={...inventoryEvidence,fallback:true,reason:'Ask constraints conflict; using executed trades only'};return;}throw Error('No legal deals satisfy the observed inventories');}
  for(const w of worlds)w.base/=total;
  this.pool={worlds,configurations:configurations.map(c=>({...c,probability:c.mass/total})),handOdds:handOdds.map(v=>v/handTotal),evidenceProbability:total/handTotal};this.poolKey=key;this.state=state;this.rebuilds++;
 }
 infer(snapshot,events=[],learning={}){
  const started=performance.now();this.build(snapshot,events);const {worlds}=this.pool,state=this.state;
  const allBots=snapshot.players.every(p=>p.name===snapshot.self||/^Bot-/.test(p.name)),group=allBots?'bots'+(snapshot.context?.botDifficulty?':'+snapshot.context.botDifficulty:''):'mixed';
  if(this.knowledge)this.knowledge.prepare(snapshot,events);
  const recentOnly=MODEL_FITS[group]?.evidenceWindow?.players===state.n,evidence=chooseEvidence(events,snapshot.self,{recentOnly}),context={names:state.names,knowledge:this.knowledge};
  const actorEvidence=state.names.map(name=>evidence.filter(e=>e.actor===name)),lookup=state.names.map(()=>new Map());
  const logWeights=[],stylesByWorld=[];
  const signalPolicy=this.signalPolicy||MODEL_FITS[group]?.signals||DEFAULT_SIGNALS;
  // Cache likelihoods of unchanged public episodes, never their posterior weights.
  // Keys include actor, inventory flow and price anchor; prune to current evidence.
  const logMaps=new Map(),active=new Set();for(const e of evidence){const actor=state.names.indexOf(e.actor),prefix=this.knowledge?.prefix(e),key=JSON.stringify([actor,e.kind,e.suit,e.direction,e.price,e.net,e.anchor,state.names,e.counterparty,e.counterpartyKnownBeforeAction,prefix?.key]);active.add(key);if(!this.eventLogCache.has(key))this.eventLogCache.set(key,new Map());logMaps.set(e,this.eventLogCache.get(key));}for(const key of this.eventLogCache.keys())if(!active.has(key))this.eventLogCache.delete(key);
  const priors=state.names.map((name,p)=>{const prior=learning.stylePriors?.[name]||learning.population?.[group]||learning.population?.[allBots?'bots':'mixed']||DEFAULT_PRIOR;return prior.map(v=>Math.log(Math.max(.02,v)));});
  for(const world of worlds){let score=0;const actorStyles=[];
   for(let actor=1;actor<state.n;actor++){
    const code=world.codes[actor];let stats=lookup[actor].get(code);
    if(!stats){const logs=[0,0,0,0],observations=actorEvidence[actor],weightTotal=sum(observations.map(e=>evidenceStrength(e,signalPolicy))),cap=Math.min(1,signalPolicy.cap/Math.max(1,weightTotal));
     for(const e of observations){const cache=logMaps.get(e);let l=cache.get(code);if(!l){l=eventLogs(world.initial[actor],actor,e,context);cache.set(code,l);}const strength=evidenceStrength(e,signalPolicy)*cap;for(let j=0;j<4;j++)logs[j]+=strength*l[j];}
     const joint=logs.map((v,j)=>v+priors[actor][j]),normalizer=logsumexp(joint);stats={score:normalizer,styles:joint.map(v=>Math.exp(v-normalizer))};lookup[actor].set(code,stats);
    }
    score+=stats.score;actorStyles[actor]=stats.styles;
   }
   logWeights.push(Math.log(world.base)+signalPolicy.temperature*score);stylesByWorld.push(actorStyles);
  }
  const normalizer=logsumexp(logWeights),behavior=logWeights.map(v=>Math.exp(v-normalizer));
  // Behavior has no calibrated track record at installation. A physical mixture
  // preserves uncertainty instead of presenting assumed policies as learned fact.
  const fit=MODEL_FITS[group],groupMetrics=learning.groupMetrics?.[group],calibrated=Boolean(fit?.prospectivelyValidated),failed=(groupMetrics?.rounds||0)>=12&&groupMetrics.opponentBrier>groupMetrics.baselineBrier+.025;
  const recommendedBlend=failed?.10:fit?.blend??.35,blend=learning.forceBaseline?0:recommendedBlend;let weights=worlds.map((w,i)=>(1-blend)*w.base+blend*behavior[i]);
  const inventoryFit=!learning.forceBaseline&&fit?.inventoryCalibration?.players===state.n?fit.inventoryCalibration:null,inventoryCalibration={active:Boolean(inventoryFit),provisional:true,id:inventoryFit?.id||null};
  if(inventoryFit){const adjusted=inventoryWeights(worlds,weights,state.net,inventoryFit.strength,inventoryFit.minEffective);weights=adjusted.weights;Object.assign(inventoryCalibration,{strength:inventoryFit.strength,goals:adjusted.goals});}
  const structural=[0,0,0,0],raw=[0,0,0,0],goals=[0,0,0,0],stylePosterior=state.names.map(()=>[0,0,0,0]);
  const bySuit=IDS.map(()=>({probability:0,base:0,buy:null,sell:null,holding:0,conditionalPayout:null,conditionalBonus:null,conditionalLeaderProbability:null,conditionalSoloProbability:null,conditionalTieProbability:null,conditionalNoBonusProbability:null,conditionalBasePayout:null,conditionalPayoutFloor:null,leaderMass:0,soloMass:0,tieMass:0,payoutFloor:Infinity,counterparties:{}}));
  for(const suit of bySuit)for(const name of state.names.slice(1))suit.counterparties[name]={mass:0,buyValue:0,sellValue:0,buyBaseValue:0};
  let expectedPayout=0,leaderProbability=0;
  for(let i=0;i<worlds.length;i++){
   const w=worlds[i],weight=weights[i],g=w.goal;structural[g]+=w.base;raw[g]+=behavior[i];goals[g]+=weight;
   const counts=w.initial.map((row,p)=>row[g]+state.net[p][g]),maxCount=Math.max(...counts),ties=counts.reduce((n,v)=>n+Number(v===maxCount),0),leads=counts[0]===maxCount,before=10*counts[0]+(leads?w.bonus/ties:0);w.buyDelta=[];w.sellDelta=[];for(let actor=1;actor<state.n;actor++){const after=counts.slice();after[0]++;after[actor]--;w.buyDelta[actor]=payout(after,w.bonus)-before;after[0]-=2;after[actor]+=2;w.sellDelta[actor]=before-payout(after,w.bonus);}expectedPayout+=weight*before;if(leads)leaderProbability+=weight;
   bySuit[g].holding+=weight*before;if(leads){bySuit[g].leaderMass+=weight;if(ties===1)bySuit[g].soloMass+=weight;else bySuit[g].tieMass+=weight;}
   // This floor follows from deck size, not from the finite sampled worlds.
   // Five of ten guarantees half the bonus; six guarantees the entire bonus.
   const otherCards=(200-w.bonus)/10-counts[0],guaranteedBonus=counts[0]>otherCards?w.bonus:counts[0]===otherCards?w.bonus/2:0;
   bySuit[g].payoutFloor=Math.min(bySuit[g].payoutFloor,10*counts[0]+guaranteedBonus);
   for(let actor=1;actor<state.n;actor++){
    stylesByWorld[i][actor].forEach((v,j)=>stylePosterior[actor][j]+=weight*v);
    for(let s=0;s<4;s++){const item=bySuit[s].counterparties[state.names[actor]];
     if(w.initial[actor][s]+state.net[actor][s]>0){item.mass+=weight;if(g===s){item.buyValue+=weight*w.buyDelta[actor];item.buyBaseValue+=weight*10;}}
     if(snapshot.held[s]>0&&g===s)item.sellValue+=weight*w.sellDelta[actor];
    }
   }
  }
  bySuit.forEach((v,s)=>{
   v.conditionalPayout=goals[s]>0?v.holding/goals[s]:null;v.conditionalBonus=goals[s]>0?Math.max(0,v.conditionalPayout-10*snapshot.held[s]):null;v.conditionalLeaderProbability=goals[s]>0?clamp(v.leaderMass/goals[s],0,1):null;v.conditionalSoloProbability=goals[s]>0?clamp(v.soloMass/goals[s],0,1):null;v.conditionalTieProbability=goals[s]>0?clamp(v.tieMass/goals[s],0,1):null;v.conditionalNoBonusProbability=goals[s]>0?clamp(1-v.leaderMass/goals[s],0,1):null;v.conditionalBasePayout=goals[s]>0?10*snapshot.held[s]:null;v.conditionalPayoutFloor=goals[s]>0?v.payoutFloor:null;delete v.leaderMass;delete v.soloMass;delete v.tieMass;delete v.payoutFloor;v.probability=goals[s];v.structuralProbability=structural[s];v.behaviorProbability=raw[s];v.handProbability=this.pool.handOdds[s];v.base=10*goals[s];
   for(const item of Object.values(v.counterparties)){item.buy=item.mass?item.buyValue/item.mass:null;item.buyBase=item.mass?item.buyBaseValue/item.mass:null;item.buyBonus=item.buy===null?null:item.buy-item.buyBase;item.sell=item.sellValue;item.sellBase=snapshot.held[s]>0?10*goals[s]:0;item.sellBonus=item.sell-item.sellBase;item.hasCardProbability=item.mass;delete item.mass;delete item.buyValue;delete item.sellValue;delete item.buyBaseValue;}
   v.buy=v.counterparties[snapshot.markets[s].seller]?.buy??null;v.sell=v.counterparties[snapshot.markets[s].buyer]?.sell??null;for(const field of ['buyBase','buyBonus'])v[field]=v.counterparties[snapshot.markets[s].seller]?.[field]??null;for(const field of ['sellBase','sellBonus'])v[field]=v.counterparties[snapshot.markets[s].buyer]?.[field]??null;
  });
  const expectedBase=sum(bySuit.map((s,i)=>s.base*snapshot.held[i])),effective=1/sum(weights.map(v=>v*v));
  const model={version:VERSION,inventoryEvidence:this.inventoryEvidence,inventoryCalibration,mode:learning.forceBaseline?'Cards only':'Opponent',bySuit,expectedPayout,expectedBase,expectedBonus:expectedPayout-expectedBase,leaderProbability,stateCount:worlds.length,currentInventory:snapshot.held.slice(),net:state.net,minimum:state.minimum,
   scoringProbabilities:structural.map((p,i)=>(1-recommendedBlend)*p+recommendedBlend*raw[i]),baseline:{mode:'Exact constraints',probabilities:structural},behavior:{probabilities:raw,blend,group,evidenceSelection:recentOnly?'latest24':'opening8-plus-latest16',signals:signalPolicy,validation:fit||null,observations:evidence.length,provisional:!calibrated||failed,styles:state.names.slice(1).map((name,i)=>({name,probabilities:Object.fromEntries(STYLE_NAMES.map((s,j)=>[s,stylePosterior[i+1][j]]))}))},
   metrics:learning.metrics||{rounds:0},bonusMetrics:learning.bonusGroupMetrics?.[group]||null,effectiveWorlds:effective,configurations:this.pool.configurations,evidenceProbability:this.pool.evidenceProbability};
  model.resting=this.skipPricing?{}:this.resting(snapshot,worlds,weights,stylesByWorld,learning);model.actualBook=this.skipPricing?{}:this.resting(snapshot,worlds,weights,stylesByWorld,learning,true);
  if(this.knowledge)model.behavior.opponentLearning=this.knowledge.summary();this.latest={worlds,weights,stylesByWorld,names:state.names};model.computeMs=performance.now()-started;return model;
 }
 revealedStyles(goal){
  if(!this.latest)return [];const {worlds,weights,stylesByWorld,names}=this.latest,g=IDS.indexOf(goal);let mass=0;const values=names.map(()=>[0,0,0,0]);
  worlds.forEach((w,i)=>{if(w.goal!==g)return;mass+=weights[i];for(let actor=1;actor<names.length;actor++)stylesByWorld[i][actor].forEach((v,j)=>values[actor][j]+=weights[i]*v);});
  if(!mass)return [];return names.slice(1).map((name,i)=>({name,probabilities:Object.fromEntries(STYLE_NAMES.map((s,j)=>[s,values[i+1][j]/mass]))}));
 }
 resting(snapshot,worlds,weights,stylesByWorld,learning,actual=false){
  const state=this.state,result={},horizon=10,nowContext={names:state.names,net:state.net,knowledge:this.knowledge,prefix:this.knowledge?.prefix()};
  for(let s=0;s<4;s++){
   const market=snapshot.markets[s];result[market.id]={};
   for(const side of ['bid','ask']){
    const buy=side==='bid',draft=learning.quotePrices?.[market.id]?.[side],custom=Number.isSafeInteger(draft)&&draft>0,price=actual?market[side]:custom?draft:buy?(Number.isFinite(market.bid)?market.bid+1:null):(Number.isFinite(market.ask)?market.ask-1:null);
    if(actual){if(market[buy?'buyer':'seller']!==snapshot.self||!Number.isFinite(price)||(buy?snapshot.cash<price:snapshot.held[s]<1))continue;}else if(!(custom?(buy?market.canBid:market.canOffer):(buy?market.canRaiseBid:market.canLowerAsk))||!Number.isSafeInteger(price)||price<1||(buy?snapshot.cash<price:snapshot.held[s]<1))continue;
    // A quote behind the current best never becomes top during this horizon.
    // Treat it as unavailable rather than borrowing a top-of-book fill rate.
    if(!actual&&custom&&Number.isFinite(market[side])&&((buy?price<market.bid:price>market.ask)||(price===market[side]&&market[buy?'buyer':'seller']!==snapshot.self)))continue;
    const rates=learning.rates?.[side]||{},baseFill=(1+(rates.fills||0))/(30+(rates.exposure||0)),outbid=(1+(rates.outbids||0))/(10+(rates.exposure||0)),reset=(1+(learning.rates?.resets||0))/(10+(learning.rates?.liveSeconds||0));
    const willingnessCache=state.names.map(()=>new Map());let pFill=0,ev=0,baseEv=0;const parties=state.names.map(()=>({mass:0,value:0}));
    for(let i=0;i<worlds.length;i++){
     const world=worlds[i],hazards=[];let total=0;
     for(let actor=1;actor<state.n;actor++){
      const qty=world.initial[actor][s]+state.net[actor][s],cash=snapshot.players[actor].cash;if((buy&&qty<1)||(!buy&&cash<price)){hazards[actor]=0;continue;}
      const code=world.codes[actor];let willing=willingnessCache[actor].get(code);
      if(willing===undefined){willing=0;const style=stylesByWorld[i][actor],context={...nowContext,buy:!buy,counterparty:0,anchor:market.fills.at(-1)?.p||((market.bid&&market.ask)?(market.bid+market.ask)/2:5)};
       for(let j=0;j<4;j++){const value=j===3?0:reservation(world.initial[actor],actor,s,context,j);willing+=style[j]*(j===3?.5:sigmoid((buy?price-value:value-price)/(j===2?6:4)));}
       willingnessCache[actor].set(code,willing);
      }
      const intensity=baseFill*2*willing/(state.n-1);hazards[actor]=intensity;total+=intensity;
     }
     if(!total)continue;const competing=total+outbid+reset,fill=total/competing*(1-Math.exp(-competing*horizon));pFill+=weights[i]*fill;
     for(let actor=1;actor<state.n;actor++)if(hazards[actor]){
      const mass=weights[i]*fill*hazards[actor]/total,value=buy?(world.goal===s?world.buyDelta[actor]:0)-price:price-(world.goal===s?world.sellDelta[actor]:0);
      ev+=mass*value;baseEv+=mass*(buy?(world.goal===s?10:0)-price:price-(world.goal===s?10:0));parties[actor].mass+=mass;parties[actor].value+=mass*value;
     }
    }
    result[market.id][side]={price,horizon,pFill,ev,conditionalEdge:pFill?ev/pFill:null,conditionalBaseEdge:pFill?baseEv/pFill:null,conditionalBonusEdge:pFill?(ev-baseEv)/pFill:null,provisional:learning.fillCalibrationValidated!==true,observedFills:rates.fills||0,exposureSeconds:rates.exposure||0,
     scope:'Before reset, losing top of book, or 10 seconds; no automatic cancellation',counterparties:state.names.slice(1).map((name,i)=>({name,probability:pFill?parties[i+1].mass/pFill:0,conditionalEdge:parties[i+1].mass?parties[i+1].value/parties[i+1].mass:null}))};
   }
  }
  return result;
 }
}
scope.FiggieBelief={VERSION,IDS,DECKS,STYLE_NAMES,DEFAULT_PRIOR,DEFAULT_SIGNALS,BeliefEngine,OpponentKnowledge,physical,allocationDP,privateBelief,chooseEvidence,eventLogs,hash,askInventoryConstraints,inventoryWeights};
if(typeof module!=='undefined')module.exports=scope.FiggieBelief;
})(globalThis);
