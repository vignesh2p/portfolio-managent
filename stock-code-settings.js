function matchStock(holding, stocks) {
  const ticker = holding.ticker.toUpperCase();
  const exact = stocks.find(s => [s.stock_code, s.ticker, s.code].some(v => String(v || '').toUpperCase() === ticker));
  if (exact) return exact;
  if (ticker.includes(':')) return null;
  const matches = stocks.filter(s => String(s.stock_code || '').toUpperCase().split(':').pop() === ticker);
  return matches.length === 1 ? matches[0] : null;
}

async function changeStockCode(tx, userId, id, expectedTicker, ticker, exchange, stocks, options = {}) {
  const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
  const result = await tx.execute({sql:'SELECT * FROM portfolio WHERE id=? AND user_id=?', args:[id,userId]});
  const holding = result.rows[0];
  if (!holding) fail(404, 'Portfolio stock not found');
  if (holding.ticker !== expectedTicker) fail(409, 'This stock changed. Refresh and try again.');
  const stock = matchStock(holding, stocks);
  const currentOkCode = holding.stock_name ? (holding.ok_code || '') : (holding.ok_code || stock?.code || '');
  if (options.expectedOkCode !== undefined && options.expectedOkCode !== currentOkCode) fail(409, 'This CODE changed. Refresh and try again.');
  const okCode = options.okCode === undefined ? currentOkCode : options.okCode;
  if (typeof okCode !== 'string' || okCode.length > 100 || /[\u0000-\u001f\u007f]/.test(okCode)) fail(400, 'CODE must be text of up to 100 characters without control characters.');
  if (holding.ticker !== ticker) {
    const duplicate = await tx.execute({sql:'SELECT id FROM portfolio WHERE user_id=? AND ticker=? UNION ALL SELECT id FROM trade_history WHERE user_id=? AND ticker=? LIMIT 1', args:[userId,ticker,userId,ticker]});
    if (duplicate.rows.length) fail(409, 'That stock code already has holdings or trades. Choose a different code.');
  }
  const name = holding.stock_name || stock?.name || holding.ticker;
  const trades = await tx.execute({sql:'UPDATE trade_history SET ticker=?,exchange=CASE WHEN ? THEN ? ELSE exchange END,stock_name=?,ok_code=? WHERE user_id=? AND ticker=?', args:[ticker,holding.ticker !== ticker ? 1 : 0,exchange,name,okCode,userId,holding.ticker]});
  await tx.execute({sql:'UPDATE portfolio SET ticker=?,stock_name=?,ok_code=? WHERE id=? AND user_id=?', args:[ticker,name,okCode,id,userId]});
  return {updatedTrades:Number(trades.rowsAffected),stock_code:ticker,ok_code:okCode};
}

module.exports = { matchStock, changeStockCode };
