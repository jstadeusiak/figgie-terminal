/*
 * Player flow chart: who has been accumulating each suit.
 *
 * For one suit, draws a lane per player whose step line is that player's
 * purchases minus sales since the deal, and summarizes the largest accumulators.
 * Pure SVG markup built from public card transfers. No game controls or timers.
 */
(function (scope) {
  'use strict';

  const SUIT_NAMES = { s: 'Spades', c: 'Clubs', d: 'Diamonds', h: 'Hearts' };
  const FALLBACK_PLAYER_COLORS = ['#5eabff', '#63d8b0', '#ff8a9c', '#f6ca72', '#bf9eff'];
  const SAFE_COLOR = /^(?:#[0-9a-f]{3,8}|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\))$/i;
  const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  const DEFAULT_WIDTH_PX = 320;
  const MIN_WIDTH_PX = 160;
  const DEFAULT_HEIGHT_PX = 74;
  const FIVE_PLAYER_HEIGHT_PX = 86;
  const MIN_HEIGHT_PX = 40;

  // Player names sit left of the plot; each player's final net change sits right of it.
  const WIDE_CHART_MIN_WIDTH_PX = 300;
  const WIDE_NAME_GUTTER_PX = 79;
  const NARROW_NAME_GUTTER_PX = 64;
  const NET_GUTTER_PX = 31;
  const NET_LABEL_INSET_PX = 4;
  const NAME_COLUMN_PADDING_PX = 17;
  const MIN_NAME_CHARS = 5;
  const AVERAGE_GLYPH_WIDTH_EM = 0.57;

  // Lanes share the height between the top padding and the axis labels.
  const TOP_PADDING_PX = 2;
  const AXIS_HEIGHT_PX = 12;
  const AXIS_LABEL_INSET_PX = 1;
  const LANE_PADDING_PX = 2;
  const MIN_LANE_AMPLITUDE_PX = 2;
  const MIN_FONT_PX = 8;
  const MAX_FONT_PX = 11;
  const TEXT_BASELINE_SHIFT_EM = 0.34;

  const NET_COLORS = {
    positive: 'var(--ff-green,#85e6bf)',
    negative: 'var(--ff-red,#ff9aaa)',
    zero: 'var(--ff-dim,#b3c2c5)',
  };
  const SELL_MARK_FILL = 'var(--ff-panel,#223138)';

  const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
  const roundCoordinate = (value) => Math.round(value * 100) / 100;
  const signed = (count) => (count > 0 ? '+' + count : String(count));

  // Player colors are read from the page, so anything but a plain color is replaced.
  function safeColor(value, fallback) {
    return typeof value === 'string' && SAFE_COLOR.test(value) ? value : fallback;
  }

  function playerColor(player, playerIndex) {
    const fallback = FALLBACK_PLAYER_COLORS[playerIndex % FALLBACK_PLAYER_COLORS.length];
    return safeColor(player.color, fallback);
  }

  function netColor(net) {
    if (net > 0) return NET_COLORS.positive;
    if (net < 0) return NET_COLORS.negative;
    return NET_COLORS.zero;
  }

  // ── Trade flow ─────────────────────────────────────────────────────────

  // Groups a snapshot's valid fills by suit once, so every chart and summary can share
  // the result. Self-transfers, unknown players and unknown suits are left out.
  function prepare(snapshot) {
    const players = snapshot?.players || [];
    const index = new Map(players.map((player, playerIndex) => [player.name, playerIndex]));
    const bySuit = Object.fromEntries(
      Object.keys(SUIT_NAMES).map((suitId) => [suitId, { fills: [], net: players.map(() => 0) }]),
    );
    for (const [tradeIndex, trade] of (snapshot?.trades || []).entries()) {
      const flow = bySuit[trade.suit];
      if (!flow || !index.has(trade.b) || !index.has(trade.s) || trade.b === trade.s) continue;
      flow.fills.push({ ...trade, roundIndex: tradeIndex + 1 });
      flow.net[index.get(trade.b)]++;
      flow.net[index.get(trade.s)]--;
    }
    return { players, index, bySuit };
  }

  function suitFlow(snapshot, suitId, prepared) {
    const flows = prepared || prepare(snapshot);
    const flow = flows.bySuit[suitId] || { fills: [], net: flows.players.map(() => 0) };
    return { players: flows.players, index: flows.index, fills: flow.fills, net: flow.net };
  }

  function summarize(snapshot, suitId, prepared) {
    const { players, index, fills, net } = suitFlow(snapshot, suitId, prepared);
    const totalNet = net.reduce((sum, value) => sum + value, 0);
    const selfIndex = index.get(snapshot?.self);
    const selfNet = selfIndex === undefined ? 0 : net[selfIndex];
    const largestNet = Math.max(0, ...net);
    return {
      volume: fills.length,
      totalNet,
      selfNet,
      opponentNet: totalNet - selfNet,
      largestAccumulators: largestNet > 0 ? playersWithNet(players, net, largestNet) : [],
    };
  }

  function playersWithNet(players, net, wanted) {
    return players.flatMap((player, playerIndex) => {
      if (net[playerIndex] !== wanted) return [];
      return [{ name: player.name, color: playerColor(player, playerIndex), net: wanted }];
    });
  }

  function createLane(player, laneIndex) {
    return {
      player,
      index: laneIndex,
      ink: escapeHtml(playerColor(player, laneIndex)),
      net: 0,
      buys: 0,
      sells: 0,
      netAfterFill: [0],
      transfers: [],
    };
  }

  // Replays the fills in order. Every lane records its running net after each fill, so a
  // round trip stays visible even when the final net is zero. Returns the largest position
  // any player reached, which sets the shared vertical scale.
  function replayFills(lanes, index, fills) {
    let extent = 1;
    fills.forEach((trade, fillIndex) => {
      const sequence = fillIndex + 1;
      const buyer = lanes[index.get(trade.b)];
      const seller = lanes[index.get(trade.s)];
      buyer.net++;
      seller.net--;
      buyer.buys++;
      seller.sells++;
      buyer.transfers.push({ sequence, direction: 'buy', net: buyer.net, trade });
      seller.transfers.push({ sequence, direction: 'sell', net: seller.net, trade });
      for (const lane of lanes) {
        lane.netAfterFill.push(lane.net);
        extent = Math.max(extent, Math.abs(lane.net));
      }
    });
    return extent;
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  function chartSize(options, playerCount) {
    const defaultHeight = playerCount === 5 ? FIVE_PLAYER_HEIGHT_PX : DEFAULT_HEIGHT_PX;
    const { width, height } = options;
    return {
      width: Number.isFinite(width) ? Math.max(MIN_WIDTH_PX, width) : DEFAULT_WIDTH_PX,
      height: Number.isFinite(height) ? Math.max(MIN_HEIGHT_PX, height) : defaultHeight,
    };
  }

  // All lanes share one vertical scale (±extent cards) and one horizontal scale (trade sequence).
  function chartGeometry({ width, height }, laneCount, fillCount, extent) {
    const left = width >= WIDE_CHART_MIN_WIDTH_PX ? WIDE_NAME_GUTTER_PX : NARROW_NAME_GUTTER_PX;
    const right = width - NET_GUTTER_PX;
    const laneHeight = (height - AXIS_HEIGHT_PX - TOP_PADDING_PX) / laneCount;
    const amplitude = Math.max(MIN_LANE_AMPLITUDE_PX, laneHeight / 2 - LANE_PADDING_PX);
    const baselineOf = (laneIndex) => TOP_PADDING_PX + laneHeight * (laneIndex + 0.5);
    return {
      width,
      height,
      left,
      right,
      fontSize: Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, laneHeight - LANE_PADDING_PX)),
      baselineOf,
      xAt: (sequence) => left + (right - left) * (fillCount ? sequence / fillCount : 0),
      yAt: (laneIndex, net) => baselineOf(laneIndex) - (net / extent) * amplitude,
    };
  }

  function render(snapshot, suitId, options = {}) {
    const players = snapshot?.players || [];
    const suitName = SUIT_NAMES[suitId] || 'Cards';
    if (!players.length) {
      return `<title>${escapeHtml(suitName)} player flow</title><desc>No players available.</desc>`;
    }
    const { index, fills } = suitFlow(snapshot, suitId, options.prepared);
    const lanes = players.map(createLane);
    const extent = replayFills(lanes, index, fills);
    const size = chartSize(options, players.length);
    const chart = {
      suitName,
      self: snapshot.self,
      fillCount: fills.length,
      extent,
      geometry: chartGeometry(size, players.length, fills.length, extent),
    };
    return [
      renderDescription(chart),
      ...lanes.map((lane) => renderLane(chart, lane)),
      renderAxis(chart),
    ].join('');
  }

  function renderDescription({ suitName, extent, fillCount }) {
    const description = [
      'One colored lane per player.',
      'Step lines show cumulative purchases minus sales since the deal, not total holdings.',
      `All lanes use the same scale, plus or minus ${extent} cards.`,
      'Filled circles are buys; hollow circles are sells.',
      `Horizontal position is ${escapeHtml(suitName)} trade sequence, not elapsed time.`,
      `${fillCount} trades recorded.`,
    ].join(' ');
    return `<title>${escapeHtml(suitName)} player card flow</title><desc>${description}</desc>`;
  }

  function renderLane(chart, lane) {
    const { left, right, width, fontSize, baselineOf } = chart.geometry;
    const { player, ink } = lane;
    const baseline = baselineOf(lane.index);
    const baselineY = roundCoordinate(baseline);
    const textY = roundCoordinate(baseline + fontSize * TEXT_BASELINE_SHIFT_EM);
    const detail =
      `${player.name}: ${lane.buys} bought, ${lane.sells} sold; ` +
      `net ${signed(lane.net)} ${chart.suitName} since the deal. ` +
      'Net change is not total inventory.';
    return [
      `<g class="ff-flow-lane" data-player="${escapeHtml(player.name)}" data-net="${lane.net}"` +
        ` data-buys="${lane.buys}" data-sells="${lane.sells}">`,
      `<title>${escapeHtml(detail)}</title>`,
      `<line x1="${left}" x2="${right}" y1="${baselineY}" y2="${baselineY}"` +
        ' stroke="var(--ff-line,#3b4b52)" stroke-dasharray="2 3"/>',
      `<circle cx="6" cy="${baselineY}" r="2.6" fill="${ink}"/>`,
      `<text x="12" y="${textY}" style="font-size:${fontSize}px;fill:var(--ff-ink,#f0f5f4)">` +
        `${escapeHtml(laneLabel(chart, player))}</text>`,
      `<path class="ff-flow-path" d="${stepPath(chart, lane)}" fill="none"` +
        ` stroke="${ink}" stroke-width="1.5" stroke-linejoin="round"/>`,
      ...lane.transfers.map((transfer) => renderTransfer(chart, lane, transfer)),
      `<text x="${width - NET_LABEL_INSET_PX}" y="${textY}" text-anchor="end"` +
        ` style="font-size:${fontSize}px;font-weight:650;fill:${netColor(lane.net)}">` +
        `${signed(lane.net)}</text>`,
      '</g>',
    ].join('');
  }

  function laneLabel({ self, geometry }, player) {
    const name = player.name === self ? 'You' : String(player.name).replace(/^Bot-/, '');
    const nameWidth = geometry.left - NAME_COLUMN_PADDING_PX;
    const glyphWidth = geometry.fontSize * AVERAGE_GLYPH_WIDTH_EM;
    const maxChars = Math.max(MIN_NAME_CHARS, Math.floor(nameWidth / glyphWidth));
    return name.length > maxChars ? name.slice(0, maxChars - 1) + '…' : name;
  }

  // A horizontal run to each fill, then a vertical step to the lane's new net position.
  function stepPath({ geometry, fillCount }, lane) {
    const { xAt, yAt, baselineOf, right } = geometry;
    let path = `M${roundCoordinate(xAt(0))},${roundCoordinate(baselineOf(lane.index))}`;
    for (let sequence = 1; sequence <= fillCount; sequence++) {
      const y = yAt(lane.index, lane.netAfterFill[sequence]);
      path += `H${roundCoordinate(xAt(sequence))}V${roundCoordinate(y)}`;
    }
    if (!fillCount) path += `H${roundCoordinate(right)}`;
    return path;
  }

  function renderTransfer({ suitName, geometry }, lane, transfer) {
    const { sequence, direction, net, trade } = transfer;
    const isBuy = direction === 'buy';
    const price = Number.isFinite(trade.p) ? trade.p : 'unknown';
    const tip =
      `${suitName} trade ${sequence} (round trade ${trade.roundIndex}): ` +
      `${trade.b} bought from ${trade.s} at ${price} chips. ` +
      `${lane.player.name} ${isBuy ? 'bought' : 'sold'} 1; net ${signed(net)}.`;
    return [
      `<circle class="ff-flow-transfer" data-direction="${direction}" data-trade="${sequence}"` +
        ` cx="${roundCoordinate(geometry.xAt(sequence))}"` +
        ` cy="${roundCoordinate(geometry.yAt(lane.index, net))}" r="1.9"` +
        ` fill="${isBuy ? lane.ink : SELL_MARK_FILL}" stroke="${lane.ink}" stroke-width="1">`,
      `<title>${escapeHtml(tip)}</title>`,
      '</circle>',
    ].join('');
  }

  function renderAxis({ geometry, fillCount, extent }) {
    const { left, right, height } = geometry;
    const y = height - AXIS_LABEL_INSET_PX;
    const middle = roundCoordinate((left + right) / 2);
    const caption = fillCount ? 'Trade sequence' : 'No trades yet';
    const labels = [
      `<text x="${left}" y="${y}" style="font-size:8px">0</text>`,
      `<text x="${middle}" y="${y}" text-anchor="middle" style="font-size:8px">` +
        `${caption} · ±${extent}</text>`,
    ];
    if (fillCount) {
      labels.push(
        `<text x="${right}" y="${y}" text-anchor="end" style="font-size:8px">${fillCount}</text>`,
      );
    }
    return labels.join('');
  }

  scope.FiggieFlowChart = { render, summarize, prepare };
  if (typeof module !== 'undefined') module.exports = scope.FiggieFlowChart;
})(globalThis);
