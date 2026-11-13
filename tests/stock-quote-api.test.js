const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createQuoteRouter, createQuoteService, normalizeCode, parseGoogle, parseAth } = require('../stock-quote-api');
const google = {
  metadata: { title: 'Uni-Abex Alloy Products Ltd (504605) Stock Price & News - Google Finance' },
  markdown: 'Other stock ₹999\n504605:BOM\n\n_add_Add to list\n\nUni-Abex Alloy Products Ltd\n\n₹4,895.00\n\n+8.00%\n\nSep 22, 3:30:00 PM UTC+5:30 · INR\n52-wk high\n₹5,750.00',
};
const trading = { markdown: '# Uni-Abex Alloy Products Limited\nUNIABEXAL reached its all-time high on Jul 7, 2026 with the price of 5,750.00 INR, and its all-time low was 10.50 INR.' };
const env = { FIRECRAWL_API_KEY: 'provider-test-key', STOCK_QUOTE_API_KEY: 'application-test-key' };
function provider() {
  const calls = [];
  return { calls, post: async (url, body) => {
    calls.push({ url, body });
    const data = url.endsWith('/search') ? { web: [{ url: 'https://www.tradingview.com/symbols/BSE-UNIABEXAL/' }] }
      : body.url.includes('google.com') ? google : trading;
    return { data: { success: true, data } };
  } };
}
test('validates and normalizes stock codes', () => {
  assert.equal(normalizeCode(' bse:504605 '), 'BOM:504605');
  assert.equal(normalizeCode('NSE:M&M'), 'NSE:M&M');
  for (const value of [undefined, [], '504605', 'BOM:abc', 'NSE:../evil', 'NYSE:IBM']) assert.throws(() => normalizeCode(value));
});
test('extracts the target price and preserves the quote timestamp', () => {
  const quote = parseGoogle(google, 'BOM:504605');
  assert.equal(quote.price, 4895);
  assert.match(quote.price_as_of, /Sep 22/);
  assert.throws(() => parseGoogle(google, 'BOM:123456'));
  assert.throws(() => parseGoogle({ ...google, markdown: google.markdown.replace('UTC+5:30', '') }, 'BOM:504605'));
});
test('extracts ATH date, rejects 52-week high and wrong instruments', () => {
  assert.deepEqual(parseAth(trading, 'Uni-Abex Alloy Products Ltd', 'UNIABEXAL'), { ath: 5750, ath_date: '2026-07-07' });
  assert.throws(() => parseAth(trading, 'Different Company Ltd', 'UNIABEXAL'));
  assert.throws(() => parseAth(trading, 'Uni-Abex Alloy Products Ltd', 'OTHER'));
  assert.throws(() => parseAth({ markdown: '# Uni-Abex Alloy Products Limited\n52-week high: 5750' }, 'Uni-Abex Alloy Products Ltd', 'UNIABEXAL'));
});
test('caches, coalesces concurrent calls and refreshes expired quotes', async () => {
  const mock = provider(); let time = Date.now();
  const get = createQuoteService({ env, post: mock.post, now: () => time });
  const [a, b] = await Promise.all([get('BOM:504605'), get('BSE:504605')]);
  assert.equal(a.ath_date, '2026-07-07'); assert.deepEqual(a, b);
  assert.equal(mock.calls.length, 3);
  assert.equal((await get('BOM:504605')).cached, true);
  time += 3599999;
  assert.equal((await get('BOM:504605')).cached, true);
  assert.equal(mock.calls.length, 3);
  time += 1;
  assert.equal((await get('BOM:504605')).cached, false);
  assert.equal(mock.calls.length, 6);
  assert.equal(mock.calls[0].body.maxAge, 0);
});
test('does not leak provider errors or cache failures', async () => {
  let calls = 0;
  const get = createQuoteService({ env, post: async () => { calls++; throw new Error('secret provider token'); } });
  for (let i = 0; i < 2; i++) await assert.rejects(get('BOM:504605'), error => error.status === 502 && !error.message.includes('secret'));
  assert.equal(calls, 2);
});
test('rejects ambiguous BSE search results and redirects', async () => {
  const mock = provider();
  const get = createQuoteService({ env, post: async (url, body) => url.endsWith('/search')
    ? { data: { success: true, data: { web: [{ url: 'https://www.tradingview.com/symbols/BSE-A/' }, { url: 'https://www.tradingview.com/symbols/BSE-B/' }] } } }
    : mock.post(url, body) });
  await assert.rejects(get('BOM:504605'), /unambiguously/);
  const redirected = createQuoteService({ env, post: async () => ({ data: { success: true, data: { ...google, metadata: { ...google.metadata, url: 'https://www.google.com/finance/quote/OTHER:NSE' } } } }) });
  await assert.rejects(redirected('BOM:504605'), /redirected/);
});
test('rejects inconsistent ATH below current price', async () => {
  const mock = provider();
  const get = createQuoteService({ env, post: async (url, body) => body.url?.includes('tradingview.com')
    ? { data: { success: true, data: { markdown: trading.markdown.replace('5,750.00', '4,000.00') } } }
    : mock.post(url, body) });
  await assert.rejects(get('BOM:504605'), /Sources disagree/);
});
test('HTTP endpoint requires authentication and returns structured success/errors', async t => {
  const app = require('express')(); const mock = provider();
  app.use('/api/stock-quote', createQuoteRouter({ env, post: mock.post }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/stock-quote`;
  assert.equal((await fetch(base + '?code=BOM:504605')).status, 401);
  const headers = { 'X-API-Key': env.STOCK_QUOTE_API_KEY };
  assert.equal((await fetch(base, { headers })).status, 400);
  const response = await fetch(base + '?code=BOM%3A504605', { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).ath, 5750);
});
test('missing provider credentials fail before making an outbound request', async () => {
  await assert.rejects(createQuoteService({ env: {} })('BOM:504605'), error => error.status === 503);
});
test('provider errors distinguish credentials, credits, rate limits and timeouts', async () => {
  for(const [status, code] of [[401,'PROVIDER_AUTH'],[403,'PROVIDER_AUTH'],[402,'PROVIDER_CREDITS'],[429,'PROVIDER_RATE_LIMIT'],[504,'PROVIDER_TIMEOUT'],[400,'PROVIDER_REQUEST']]){
    const get = createQuoteService({ env, post: async () => { throw { response: { status, headers: { 'retry-after':'12' }, data: { error:'secret value' } } }; } });
    await assert.rejects(get('BOM:504605'), error => error.code === code && !error.message.includes('secret') && (status !== 429 || error.retryAfter === 12));
  }
});
test('NSE quotes use the same exchange directly without a symbol search', async () => {
  const calls = [];
  const get = createQuoteService({ env, post: async (url, body) => {
    calls.push(body.url);
    assert.ok(url.endsWith('/scrape'));
    const data = body.url.includes('google.com') ? {
      metadata: { title: 'Example Ltd (EXAMPLE) Stock Price & News - Google Finance' },
      markdown: 'EXAMPLE:NSE\nExample Ltd\n\n₹100.00\n\nSep 22, 3:30:00 PM UTC+5:30 · INR',
    } : { markdown: '# Example Limited\nEXAMPLE reached its all-time high on Jan 1, 2020 with the price of 200.00 INR' };
    return { data: { success: true, data } };
  } });
  assert.equal((await get('NSE:EXAMPLE')).ath, 200);
  assert.equal(calls[1], 'https://www.tradingview.com/symbols/NSE-EXAMPLE/');
});
