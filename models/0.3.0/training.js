/* Training truth is an isolated teaching result, never an inference input.
   Values below settle the current hands immediately; they predict no future trades. */
(function(scope){
'use strict';
const B=scope.FiggieBelief||(typeof require==='function'?require('./belief.js'):null),IDS=['s','c','d','h'];
const sum=a=>a.reduce((a,b)=>a+b,0),copy=a=>a.slice(),unavailable=reason=>({available:false,reason});
const validHand=h=>Array.isArray(h)&&h.length===4&&h.every(v=>Number.isSafeInteger(v)&&v>=0&&v<=12);
const validProbabilities=p=>Array.isArray(p)&&p.length===4&&p.every(v=>Number.isFinite(v)&&v>=0&&v<=1)&&Math.abs(sum(p)-1)<1e-8;
function choose(n,k){if(k<0||k>n)return 0;let v=1;for(let i=1;i<=Math.min(k,n-k);i++)v*= (n-Math.min(k,n-k)+i)/i;return v;}
function pick(source,keys){const out={};for(const key of keys)if(source&&Object.hasOwn(source,key))out[key]=source[key];return out;}
function publicTrade(t){return pick(t,['b','s','suit','p']);}
/* Explicit public-field allowlists prevent new truth fields from silently entering
   either the blind model or its cache/signature. The returned snapshot is a copy. */
function blindSnapshot(snapshot){
 if(!snapshot||typeof snapshot!=='object')return null;
 const s=pick(snapshot,['status','reason','antePending','self','cash','round','timer','room','roundKey']);
 for(const key of ['held','startingHand'])if(Array.isArray(snapshot[key]))s[key]=copy(snapshot[key]);
 if(Array.isArray(snapshot.net))s.net=snapshot.net.map(copy);
 if(Array.isArray(snapshot.players))s.players=snapshot.players.map(p=>{const x=pick(p,['name','cash','color','cards']);if(Array.isArray(p.observedNet))x.observedNet=copy(p.observedNet);return x;});
 if(Array.isArray(snapshot.trades))s.trades=snapshot.trades.map(publicTrade);
 if(Array.isArray(snapshot.markets))s.markets=snapshot.markets.map(m=>{const x=pick(m,['id','name','symbol','color','card','viewBox','held','bid','ask','buyer','seller','canBuy','canSell','canBid','canOffer','canRaiseBid','canLowerAsk','canCancelBid','canCancelOffer']);if(Array.isArray(m.fills))x.fills=m.fills.map(publicTrade);return x;});
 s.context=pick(snapshot.context,['botDifficulty']);if(typeof snapshot.context?.learningMode==='boolean')s.context.learningMode=snapshot.context.learningMode;
 s.signature=JSON.stringify({roundKey:s.roundKey,cash:s.cash,held:s.held,trades:s.trades,quotes:s.markets?.map(m=>[m.bid,m.ask,m.buyer,m.seller,m.canBuy,m.canSell,m.canBid,m.canOffer,m.canRaiseBid,m.canLowerAsk,m.canCancelBid,m.canCancelOffer])});
 return s;
}
/* Exact posterior from a chosen subset of STARTING hands. Each legal deck is
   equally likely a priori; sequential hypergeometric deal likelihoods provide
   the weight. No behavioral assumption, current inventory or future data enters. */
function knownHandProbabilities(hands={},options={}){
 const n=options.playerCount??4;if(![4,5].includes(n))return unavailable('Expected four or five players.');
 if(!hands||typeof hands!=='object'||Array.isArray(hands))return unavailable('Supply starting hands keyed by player name.');
 const entries=Object.entries(hands),size=40/n;if(!entries.length)return unavailable('Choose at least one known starting hand.');if(entries.length>n||entries.some(([name,h])=>!name||!validHand(h)||sum(h)!==size))return unavailable('Known starting hands are incomplete or invalid.');
 const configurations=[];let total=0;const probabilities=[0,0,0,0];
 for(const config of B.DECKS){const remaining=copy(config.deck);let weight=1,left=40;for(const [,hand]of entries){let likelihood=1;for(let s=0;s<4;s++){likelihood*=choose(remaining[s],hand[s]);remaining[s]-=hand[s];}weight*=likelihood/choose(left,size);left-=size;if(!weight)break;}if(weight>0){configurations.push({deck:copy(config.deck),goal:IDS[config.goal],weight});total+=weight;probabilities[config.goal]+=weight;}}
 if(!(total>0))return unavailable('Known hands cannot come from a legal Figgie deck.');
 return {available:true,probabilities:probabilities.map(v=>v/total),knownPlayers:entries.map(([name])=>name),knownCards:entries.length*size,scope:'Starting hands only; exact deal probabilities.',configurations:configurations.map(c=>({deck:c.deck,goal:c.goal,probability:c.weight/total}))};
}
function scorePrediction(probabilities,goal){
 const g=typeof goal==='number'?goal:IDS.indexOf(goal);if(!Number.isInteger(g)||g<0||g>3||!validProbabilities(probabilities))return unavailable('A valid goal and four probabilities summing to one are required.');
 const top=probabilities.indexOf(Math.max(...probabilities));
 return {available:true,goal:IDS[g],probabilities:copy(probabilities),goalProbability:probabilities[g],brier:sum(probabilities.map((p,i)=>(p-Number(i===g))**2)),logLoss:-Math.log(Math.max(1e-12,probabilities[g])),logLossClipped:probabilities[g]<1e-12,topChoice:IDS[top],correct:top===g,confidence:probabilities[top]};
}
function settlement(hands,names,goal,bonusPool){
 const counts=names.map(name=>hands[name][goal]),maximum=Math.max(...counts),leaders=names.filter((name,i)=>counts[i]===maximum),tieCount=leaders.length;
 return Object.fromEntries(names.map((name,i)=>{const leader=leaders.includes(name),base=10*counts[i],bonus=leader?bonusPool/tieCount:0;return[name,{base,bonus,total:base+bonus,leader,solo:leader&&tieCount===1,tieCount:leader?tieCount:0}];}));
}
function analyze(snapshot,blindModel=null){
 const training=snapshot?.training;if(training?.enabled!==true||training.handsVisible!==true)return unavailable('Visible-hands training is not enabled.');
 if(!['live','paused'].includes(snapshot.status))return unavailable('Training comparison requires a live practice round; post-round reveals do not enable it.');
 if(training.valid!==true)return unavailable(training.reason||'Waiting for complete, consistent visible hands.');
 const players=snapshot.players,n=players?.length;if(![4,5].includes(n)||players.some(p=>typeof p.name!=='string'||!p.name))return unavailable('Player list is incomplete.');
 const names=players.map(p=>p.name),self=snapshot.self,size=40/n;if(new Set(names).size!==n||!names.includes(self))return unavailable('Player identities are inconsistent.');
 const initial=training.startingHands,current=training.hands;if(!initial||!current||names.some(name=>!validHand(initial[name])||sum(initial[name])!==size||!validHand(current[name])))return unavailable('All starting and current hands are required.');
 const deckTotals=IDS.map((_,s)=>sum(names.map(name=>initial[name][s]))),currentTotals=IDS.map((_,s)=>sum(names.map(name=>current[name][s])));
 if(deckTotals.slice().sort((a,b)=>a-b).join(',')!=='8,10,10,12'||deckTotals.some((v,s)=>v!==currentTotals[s])||!validHand(training.deckTotals)||training.deckTotals.some((v,s)=>v!==deckTotals[s]))return unavailable('Visible hands do not reconcile to a legal 40-card deck.');
 if(!validHand(snapshot.startingHand)||snapshot.startingHand.some((v,s)=>v!==initial[self][s])||!validHand(snapshot.held)||snapshot.held.some((v,s)=>v!==current[self][s]))return unavailable('Your visible hand disagrees with the public snapshot.');
 if(!Array.isArray(snapshot.trades))return unavailable('Public trade history is missing.');
 const reconstructed=Object.fromEntries(names.map(name=>[name,copy(initial[name])])),cash=Object.fromEntries(names.map(name=>[name,0]));
 for(const t of snapshot.trades){const s=IDS.indexOf(t.suit);if(s<0||!names.includes(t.b)||!names.includes(t.s)||t.b===t.s||!Number.isFinite(t.p)||t.p<0||reconstructed[t.s][s]<1)return unavailable('Visible hands disagree with public trade history.');reconstructed[t.b][s]++;reconstructed[t.s][s]--;cash[t.b]-=t.p;cash[t.s]+=t.p;}
 if(names.some(name=>current[name].some((v,s)=>v!==reconstructed[name][s])))return unavailable('Visible current hands disagree with public trade history.');
 const goal=deckTotals.indexOf(12)^1,exactGoal=IDS[goal],exactProbabilities=IDS.map((_,i)=>Number(i===goal)),bonusPool=200-10*deckTotals[goal],ante=200/n,payouts=settlement(current,names,goal,bonusPool),own=payouts[self],leaders=names.filter(name=>payouts[name].leader);
 const playerRows=names.map(name=>{const handOdds=copy(B.privateBelief(initial[name]).goals);return{name,startingHand:copy(initial[name]),currentHand:copy(current[name]),handOdds,privateHandProbabilities:copy(handOdds),probabilityScope:'Starting hand only; excludes public trading and all other hands.',withYourHandProbabilities:knownHandProbabilities(Object.fromEntries([...new Set([self,name])].map(p=>[p,initial[p]])),{playerCount:n}).probabilities,settlement:{...payouts[name]},netCash:cash[name],roundPnl:cash[name]-ante+payouts[name].total};});
 const knownHandSets={},selfMask=1<<names.indexOf(self);for(let mask=1;mask<(1<<n);mask++){if(!(mask&selfMask))continue;const selected=Object.fromEntries(names.filter((name,i)=>mask&(1<<i)).map(name=>[name,initial[name]])),posterior=knownHandProbabilities(selected,{playerCount:n});knownHandSets[mask]=posterior.available?{probabilities:posterior.probabilities,knownPlayers:posterior.knownPlayers}:posterior;}
 const candidate=blindModel?.bySuit?.map(s=>s.probability),blind=validProbabilities(candidate)?copy(candidate):validProbabilities(blindModel?.scoringProbabilities)?copy(blindModel.scoringProbabilities):null;
 const bySuit=IDS.map((id,s)=>{const market=snapshot.markets?.find(m=>m.id===id)||{},counterparties=Object.create(null);for(const name of names.filter(name=>name!==self)){
   let buy=null,sell=null;if(current[name][s]>0){const after=Object.fromEntries(names.map(p=>[p,copy(current[p])]));after[self][s]++;after[name][s]--;buy=settlement(after,names,goal,bonusPool)[self].total-own.total;}
   if(current[self][s]>0){const after=Object.fromEntries(names.map(p=>[p,copy(current[p])]));after[self][s]--;after[name][s]++;sell=own.total-settlement(after,names,goal,bonusPool)[self].total;}
   const buyBase=buy===null?null:s===goal?10:0,sellBase=sell===null?null:s===goal?10:0;
   counterparties[name]={buy,sell,buyBase,buyBonus:buy===null?null:buy-buyBase,sellBase,sellBonus:sell===null?null:sell-sellBase,buyEdge:buy!==null&&market.seller===name&&Number.isFinite(market.ask)?buy-market.ask:null,sellEdge:sell!==null&&market.buyer===name&&Number.isFinite(market.bid)?market.bid-sell:null};
  }const ask=counterparties[market.seller],bid=counterparties[market.buyer];return{id,probability:exactProbabilities[s],base:s===goal?10:0,buy:ask?.buy??null,sell:bid?.sell??null,buyEdge:ask?.buyEdge??null,sellEdge:bid?.sellEdge??null,counterparties};});
 return {available:true,roundKey:snapshot.roundKey,asOfTradeCount:snapshot.trades.length,noFutureTrades:true,scope:'Exact settlement of current visible hands; one-card transfers assume immediate settlement and predict no future trades or fills.',exactGoal,exactProbabilities,deckTotals:copy(deckTotals),players:playerRows,knownHandSets,probabilityTable:{blind,selfHand:copy(playerRows.find(p=>p.name===self).handOdds),allHands:copy(exactProbabilities),otherHands:knownHandProbabilities(Object.fromEntries(names.filter(name=>name!==self).map(name=>[name,initial[name]])),{playerCount:n}).probabilities,players:playerRows.map(p=>({name:p.name,probabilities:copy(p.handOdds)}))},blindScore:blind?scorePrediction(blind,exactGoal):null,settlement:{...own,bonusPool,leaders,tieCount:leaders.length},roundPnl:{netCash:cash[self],ante,settlement:own.total,settleNowPnl:cash[self]-ante+own.total},bySuit};
}
scope.FiggieTraining={analyze,blindSnapshot,knownHandProbabilities,scorePrediction};
if(typeof module!=='undefined')module.exports=scope.FiggieTraining;
})(globalThis);
