const { normalizeCode } = require('./stock-quote-api');

function stockQuoteCode(row) {
  // Prefer the explicit exchange code. Do not interpret an internal OK code as a ticker.
  const value = String(row.stock_code || row.ticker || '').trim().toUpperCase();
  return normalizeCode(/^\d{6}$/.test(value) ? `BOM:${value}` : value);
}

function savedQuoteIsFresh(row, now = Date.now()) {
  const age = now - Date.parse(row.quote_fetched_at);
  return row.source === 'FIRECRAWL' && Number(row.cmp) > 0 && Number(row.ath) >= Number(row.cmp)
    && /^\d{4}-\d{2}-\d{2}$/.test(row.ath_date || '') && age >= 0 && age < 3600000;
}

function preserveQuote(row, previous) {
  if (!previous || previous.source !== 'FIRECRAWL') return row;
  try { if (stockQuoteCode(row) !== stockQuoteCode(previous)) return row; }
  catch { return row; }
  return { ...row, cmp: previous.cmp, change: null, ath: previous.ath,
    ath_date: previous.ath_date, source: previous.source, price_as_of: previous.price_as_of,
    quote_fetched_at: previous.quote_fetched_at, quote_error: previous.quote_error };
}

// Called once per stock, keeping each HTTP request independent of list size.
async function refreshWatchlistQuote({ db, userId, id, getQuote, now = Date.now }) {
  const row = await db.prepare('SELECT * FROM watchlist WHERE id=? AND user_id=?').get(id, userId);
  if (!row) { const error = new Error('Watchlist changed. Reload and try again.'); error.status = 409; throw error; }
  try {
    const code = stockQuoteCode(row);
    if (savedQuoteIsFresh(row, now())) {
      await db.prepare('UPDATE watchlist SET quote_error=NULL WHERE id=? AND user_id=?').run(id, userId);
      return { data: { ...row, quote_error: null }, cached: true };
    }
    const quote = await getQuote(code);
    const result = await db.prepare(`UPDATE watchlist SET cmp=?,ath=?,ath_date=?,price_as_of=?,
      quote_fetched_at=?,quote_error=NULL,change=NULL,source='FIRECRAWL',updated_at=?
      WHERE id=? AND user_id=? AND stock_code=? AND ticker=?`).run(
      quote.price, quote.ath, quote.ath_date, quote.price_as_of, quote.fetched_at,
      new Date(now()).toISOString(), id, userId, row.stock_code, row.ticker);
    if (!result.changes) { const error = new Error('Watchlist changed during the lookup. Reload and try again.'); error.status = 409; throw error; }
    return { data: { ...row, cmp: quote.price, ath: quote.ath, ath_date: quote.ath_date,
      price_as_of: quote.price_as_of, quote_fetched_at: quote.fetched_at, quote_error: null,
      change: null, source: 'FIRECRAWL', updated_at: new Date(now()).toISOString() }, cached: quote.cached };
  } catch (error) {
    await db.prepare('UPDATE watchlist SET quote_error=? WHERE id=? AND user_id=?').run(error.message, id, userId);
    throw error;
  }
}

module.exports = { stockQuoteCode, savedQuoteIsFresh, preserveQuote, refreshWatchlistQuote };
