const B = require('../extension/belief.js');
const T = require('../extension/training.js');
function fixture(n = 4) {
  const names = ['You', 'Bot-Lynx', 'Bot-Deer', 'Bot-Dog', 'Bot-Crab'].slice(0, n);
  const hands =
    n === 4
      ? [
          [3, 3, 2, 2],
          [3, 3, 2, 2],
          [3, 2, 3, 2],
          [3, 2, 3, 2],
        ]
      : [
          [3, 2, 2, 1],
          [3, 2, 2, 1],
          [2, 2, 2, 2],
          [2, 2, 2, 2],
          [2, 2, 2, 2],
        ];
  const colors = [
    'rgb(39, 115, 222)',
    'rgb(26, 167, 123)',
    'rgb(239, 64, 67)',
    'rgb(239, 168, 35)',
    'rgb(169, 139, 233)',
  ];
  const map = Object.fromEntries(names.map((name, i) => [name, hands[i].slice()]));
  const s = {
    status: 'live',
    self: 'You',
    cash: 250,
    startingHand: hands[0].slice(),
    held: hands[0].slice(),
    players: names.map((name, i) => ({
      name,
      cash: 250,
      color: colors[i],
      cards: 40 / n,
      observedNet: [0, 0, 0, 0],
    })),
    net: names.map(() => [0, 0, 0, 0]),
    trades: [],
    context: { botDifficulty: 'Medium', learningMode: true },
    roundKey: 'local-learning-' + n,
    timer: '2:39',
    round: 1,
    room: 'Local learning QA',
    signature: 'qa-live',
    markets: B.IDS.map((id, i) => ({
      id,
      name: ['Spades', 'Clubs', 'Diamonds', 'Hearts'][i],
      symbol: ['♠', '♣', '♦', '♥'][i],
      held: hands[0][i],
      bid: 4,
      ask: 7,
      buyer: names[1],
      seller: names[1],
      canBuy: true,
      canSell: true,
      canBid: true,
      canOffer: true,
      canRaiseBid: true,
      canLowerAsk: true,
      canCancelBid: false,
      canCancelOffer: false,
      fills: [],
    })),
    training: {
      enabled: true,
      handsVisible: true,
      valid: true,
      hands: map,
      startingHands: JSON.parse(JSON.stringify(map)),
      deckTotals: [12, 10, 10, 8],
    },
  };
  return s;
}
function model(s) {
  const m = new B.BeliefEngine().infer(T.blindSnapshot(s));
  m.training = T.analyze(s, m);
  return m;
}
module.exports = { fixture, model };
