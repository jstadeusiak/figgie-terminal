/* Narrow local fits; provisional, not validation against humans. */
(function(scope){
 const fits={
  "bots:Medium": {
    "id": "medium-bots-2026-10-28-v08",
    "blend": 0.55,
    "goalCalibration": {
      "id": "medium-four-goal-evidence-2026-10-30-v013",
      "kind": "likelihood-power",
      "strength": 16,
      "players": 4,
      "prospectivelyValidated": false,
      "developmentRounds": 28,
      "validationRounds": 10,
      "testRounds": 10,
      "testBrierBefore": 0.7128423205575627,
      "testBrierAfter": 0.6589508654089429,
      "testLogLossBefore": 1.351517897761187,
      "testLogLossAfter": 1.2155088558677059,
      "scope": "Four-player Medium bots only. Goal likelihood-ratio calibration with unchanged .55 structural/behavior mixture and failure guard. Retrospective chronological comparison; ten-game confidence intervals include zero. Preserves distributions within each goal and recalculates all values from reweighted worlds."
},
    "signals": {
      "temperature": 0.6,
      "quote": 0.2,
      "consent": 0.12,
      "cap": 5
    },
    "signalCheck": {
      "earlierRounds": 11,
      "laterRounds": 8,
      "newRounds": 4,
      "previousTemperature": 0.3,
      "laterBrierPrevious": 0.43848491609725254,
      "laterBrierFitted": 0.4306913454615376,
      "newBrierPrevious": 0.5520205521364087,
      "newBrierFitted": 0.5484908620431739,
      "candidatesCompared": 5,
      "prospectivelyValidated": false
    },
    "trainingRounds": 11,
    "holdoutRounds": 8,
    "previousBlend": 0.35,
    "holdoutBrierPrevious": 0.44203694015688655,
    "holdoutBrierFitted": 0.43848491609725254,
    "holdoutBrierCards": 0.4484068024066319,
    "prospectivelyValidated": false,
    "prospectiveCheck": {
      "rounds": 3,
      "checkpoints": 50,
      "referenceBrier": 0.558663,
      "candidateBrier": 0.548245,
      "improvedRounds": 3,
      "finalRankingFlips": 0
    },
    "scope": "Medium bots only; provisional. 55% mixture, 0.60 likelihood temperature and cap 5 unchanged. Four-player tables use the latest 24 opponent episodes, selected on 14 new rounds and checked on the final six and older 34. Small probability improvement with no final ranking flips; no human-table accuracy claim.",
    "inventoryCalibration": {
      "id": "medium-four-player-inventory-2026-10-27",
      "players": 4,
      "strength": 0.8,
      "minEffective": 64,
      "trainingRounds": 16,
      "chronologicalValidationRounds": 4,
      "scope": "Four-player Medium bots only. Empirical within-goal inventory calibration from official payouts and public flows; provisional, retrospective. Goal probabilities unchanged. No claim for Easy bots, humans, unknown difficulty or five players.",
      "prospectiveCheck": {
        "rounds": 20,
        "checkpoints": 314,
        "bonusMae": 7.026377828274091,
        "withoutInventoryMae": 14.145285496454164,
        "improvedRounds": 14,
        "unchangedRounds": 6,
        "worsenedRounds": 0,
        "scope": "Newly recorded v0.7 rounds, unseen when the .8 inventory coefficient was selected; same observed trade paths, not a causal P&L comparison."
      }
    },
    "evidenceWindow": {
      "players": 4,
      "recent": 24,
      "trainingRounds": 14,
      "chronologicalValidationRounds": 6,
      "trainingBrierPrevious": 0.5869439852410461,
      "trainingBrierUpdated": 0.5833102216142654,
      "validationBrierPrevious": 0.77049,
      "validationBrierUpdated": 0.765779,
      "scope": "Four-player Medium bots only; latest 24 opponent episodes replaces opening8 plus latest16. Same strength and cost. Small retrospective chronological improvement; no final goal-ranking flips."
    }
  }
};
 scope.FiggieModelFit=fits;if(typeof module!=='undefined')module.exports=fits;
})(globalThis);
