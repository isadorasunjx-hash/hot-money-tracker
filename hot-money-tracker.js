/**
 * 热钱追踪者 (Hot Money Tracker)
 * OKX Agentic Wallet Trading Competition - Skill Quality Award Submission
 *
 * Strategy: Solana Volume Surge Sniper
 * Author: @isadora288881
 *
 * OnchainOS Tools: okx-dex-token, okx-dex-market, okx-wallet-portfolio,
 *                  okx-dex-swap, okx-onchain-gateway
 */

const CONFIG = {
  chain: "solana",
  quote_token: "USDC",
  volume_surge_multiplier: 3,
  min_market_cap_usd: 500_000,
  min_token_age_hours: 24,
  min_holder_count: 200,
  max_top10_concentration: 0.60,
  min_price_vs_1h_low: 1.10,
  max_price_vs_1h_high: 0.95,
  min_buy_ratio: 0.60,
  max_concurrent_positions: 3,
  max_position_pct: 0.05,
  max_position_usd: 200,
  min_entry_usd: 20,
  stop_loss_pct: 0.85,
  take_profit_pct: 1.40,
  trailing_profit_threshold: 1.20,
  trailing_drawdown: 0.10,
  volume_decay_exit: 0.30,
  entry_slippage: 0.02,
  exit_slippage: 0.03,
  scan_interval_minutes: 5,
};

let positions = {};

async function scanVolumeSignals() {
  console.log("📡 [Phase 1] Scanning Solana volume surges...");
  const topTokens = await okxDexToken.getTrendingTokens({
    chain: CONFIG.chain, sort_by: "volume_1h", limit: 50,
  });
  const candidates = [];
  for (const token of topTokens) {
    const avg1hVolume = token.volume_24h / 24;
    const surgeMult = token.volume_1h / avg1hVolume;
    if (surgeMult >= CONFIG.volume_surge_multiplier &&
        token.market_cap >= CONFIG.min_market_cap_usd &&
        token.age_hours >= CONFIG.min_token_age_hours &&
        token.holder_count >= CONFIG.min_holder_count &&
        token.top10_concentration <= CONFIG.max_top10_concentration) {
      candidates.push({ ...token, surge_multiplier: surgeMult, entry_volume: token.volume_1h });
    }
  }
  return candidates;
}

async function validateMomentum(token) {
  const market = await okxDexMarket.getTokenMarketData({
    chain: CONFIG.chain, token_address: token.address,
    candle_interval: "15m", candle_limit: 4, recent_trades_limit: 20,
  });
  const { current_price, high_1h, low_1h, recent_trades } = market;
  const priceVsLow = current_price / low_1h;
  const priceVsHigh = current_price / high_1h;
  const buyRatio = recent_trades.filter(t => t.side === "buy").length / recent_trades.length;
  if (priceVsLow >= CONFIG.min_price_vs_1h_low &&
      priceVsHigh <= CONFIG.max_price_vs_1h_high &&
      buyRatio >= CONFIG.min_buy_ratio) {
    return { valid: true, current_price };
  }
  return { valid: false };
}

async function checkRisk() {
  const portfolio = await okxWalletPortfolio.getPortfolio({ chain: CONFIG.chain });
  const { usdc_balance, total_value_usd } = portfolio;
  if (Object.keys(positions).length >= CONFIG.max_concurrent_positions) {
    return { approved: false, reason: "已达最大仓位数" };
  }
  const positionSize = Math.min(total_value_usd * CONFIG.max_position_pct, CONFIG.max_position_usd);
  if (positionSize < CONFIG.min_entry_usd || usdc_balance < CONFIG.min_entry_usd) {
    return { approved: false, reason: "可用余额不足" };
  }
  return { approved: true, position_size: positionSize };
}

async function executeEntry(token, positionSize, currentPrice) {
  const swapTx = await okxDexSwap.buildSwap({
    chain: CONFIG.chain, from_token: "USDC", to_token: token.address,
    amount_usd: positionSize, slippage: CONFIG.entry_slippage,
  });
  const simulation = await okxOnchainGateway.simulateTransaction({
    chain: CONFIG.chain, tx_data: swapTx.tx_data,
  });
  if (!simulation.success || simulation.gas_fee_usd / positionSize > 0.01) return null;
  const broadcast = await okxOnchainGateway.broadcastTransaction({
    chain: CONFIG.chain, signed_tx: swapTx.signed_tx,
  });
  if (!broadcast.tx_hash) return null;
  positions[token.address] = {
    symbol: token.symbol, entryPrice: currentPrice, amount: simulation.expected_output,
    entryTime: Date.now(), entryVolume: token.entry_volume, peakPrice: currentPrice,
    tx_hash: broadcast.tx_hash,
  };
  return broadcast.tx_hash;
}

async function monitorPositions() {
  for (const [address, pos] of Object.entries(positions)) {
    const market = await okxDexMarket.getTokenMarketData({
      chain: CONFIG.chain, token_address: address, candle_interval: "5m", candle_limit: 3,
    });
    const { current_price, volume_1h } = market;
    const priceRatio = current_price / pos.entryPrice;
    const volumeRatio = volume_1h / pos.entryVolume;
    if (current_price > pos.peakPrice) positions[address].peakPrice = current_price;
    const peakDrawdown = current_price / pos.peakPrice;
    let exitReason = null;
    if (priceRatio <= CONFIG.stop_loss_pct) exitReason = `止损 -${((1 - priceRatio) * 100).toFixed(1)}%`;
    else if (volumeRatio <= CONFIG.volume_decay_exit) exitReason = "量能枯竭";
    else if (priceRatio >= CONFIG.take_profit_pct) exitReason = `止盈 +${((priceRatio - 1) * 100).toFixed(1)}%`;
    else if (priceRatio >= CONFIG.trailing_profit_threshold && peakDrawdown <= (1 - CONFIG.trailing_drawdown))
      exitReason = "动态止盈";
    if (exitReason) {
      const swapTx = await okxDexSwap.buildSwap({
        chain: CONFIG.chain, from_token: address, to_token: "USDC",
        amount_tokens: pos.amount, slippage: CONFIG.exit_slippage,
      });
      await okxOnchainGateway.broadcastTransaction({ chain: CONFIG.chain, signed_tx: swapTx.signed_tx });
      delete positions[address];
    }
  }
}

async function runStrategy() {
  await monitorPositions();
  const candidates = await scanVolumeSignals();
  for (const token of candidates) {
    if (positions[token.address]) continue;
    const momentum = await validateMomentum(token);
    if (!momentum.valid) continue;
    const risk = await checkRisk();
    if (!risk.approved) continue;
    await executeEntry(token, risk.position_size, momentum.current_price);
  }
}

module.exports = { runStrategy, CONFIG, positions };
