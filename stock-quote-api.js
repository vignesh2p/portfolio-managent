const axios = require('axios');
const crypto = require('crypto');

class QuoteError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const unavailable = message => new QuoteError(502, 'SOURCE_UNAVAILABLE', message);
function normalizeCode(value) {
  if (typeof value !== 'string' || value.length > 50) throw new QuoteError(400, 'INVALID_CODE', 'Use BOM:504605, BSE:504605 or NSE:RELIANCE.');
  const match = value.trim().toUpperCase().match(/^(BOM|BSE|NSE):([A-Z0-9&_-]{1,30})$/);
  if (!match || (match[1] !== 'NSE' && !/^\d{6}$/.test(match[2]))) throw new QuoteError(400, 'INVALID_CODE', 'Use BOM:504605, BSE:504605 or NSE:RELIANCE.');
  return `${match[1] === 'BSE' ? 'BOM' : match[1]}:${match[2]}`;
}
function clean(text) { return String(text || '').replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '').replace(/\u00a0|\u202f/g, ' '); }
function companyKey(text) { return text.toLowerCase().replace(/\b(ltd|limited)\b/g, '').replace(/[^a-z0-9]/g, ''); }
function parseGoogle(data, code) {
  const [exchange, symbol] = code.split(':');
  const title = data?.metadata?.title || '';
  const marker = `(${symbol}) Stock Price`;
  const name = title.includes(marker) ? title.slice(0, title.indexOf(marker)).trim() : '';
  const markdown = clean(data?.markdown);
  const start = markdown.indexOf(`${symbol}:${exchange}`);
  if (!name || start < 0) throw unavailable('Google Finance did not return the requested stock.');
  const section = markdown.slice(start);
  const nameStart = section.indexOf(name);
  const quote = nameStart >= 0 ? section.slice(nameStart + name.length) : '';
  const priceMatch = quote.match(/^\s*\n+₹([\d,]+(?:\.\d+)?)\s*\n/);
  const asOf = quote.match(/^([^\n]+(?:UTC[+-][\d:]+|GMT[+-][\d:]+)[^\n]*[·⋅]\s*INR)\s*$/m);
  const price = Number(priceMatch?.[1]?.replace(/,/g, ''));
  if (!Number.isFinite(price) || price <= 0 || !asOf) throw unavailable('Google Finance price or quote timestamp could not be verified.');
  return { name, price, price_as_of: asOf[1].trim() };
}
function parseAth(data, name, tvSymbol) {
  const markdown = clean(data?.markdown);
  const heading = markdown.match(/^# ([^\n]+)$/m)?.[1];
  if (!heading || companyKey(heading) !== companyKey(name)) throw unavailable('The ATH source does not match the requested company.');
  const match = markdown.match(/\b([A-Z0-9&_-]+) reached its all-time high on ([A-Z][a-z]{2} \d{1,2}, \d{4}) with the price of ([\d,]+(?:\.\d+)?)\s+INR/);
  if (!match || match[1] !== tvSymbol) throw unavailable('The source did not provide a verified all-time high and date.');
  const ath = Number(match[3].replace(/,/g, ''));
  const date = new Date(`${match[2]} 00:00:00 GMT`);
  if (!Number.isFinite(ath) || ath <= 0 || !Number.isFinite(date.getTime()) || date.getTime() > Date.now()) throw unavailable('The ATH values are invalid.');
  return { ath, ath_date: date.toISOString().slice(0, 10) };
}
function createQuoteService({ env = process.env, post = axios.post, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  async function firecrawl(path, body) {
    try {
      const response = await post(`https://api.firecrawl.dev/v2/${path}`, body, {
        headers: { Authorization: `Bearer ${env.FIRECRAWL_API_KEY.trim()}` }, timeout: 35000,
      });
      if (!response.data?.success || !response.data.data) throw unavailable('The data provider returned an unsuccessful response.');
      return response.data.data;
    } catch (error) {
      if (error instanceof QuoteError) throw error;
      const status = error.response?.status;
      // Never log Axios errors: they contain the Authorization header.
      console.warn('Firecrawl request failed', { operation: path, status: status || null, code: error.code || null });
      if (status === 401 || status === 403) throw new QuoteError(503, 'PROVIDER_AUTH', 'Firecrawl rejected the configured API key or its permissions. Check the production Firecrawl key.');
      if (status === 402) throw new QuoteError(503, 'PROVIDER_CREDITS', 'Firecrawl credits are exhausted. Add credits to the Firecrawl account and retry.');
      if (status === 429) {
        const failure = new QuoteError(429, 'PROVIDER_RATE_LIMIT', 'Firecrawl rate limit reached. Wait before retrying.');
        const retry = error.response?.headers?.['retry-after'];
        const seconds = /^\d+$/.test(String(retry)) ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
        failure.retryAfter = Number.isFinite(seconds) ? Math.max(1, Math.min(300, seconds)) : 60;
        throw failure;
      }
      if (['ECONNABORTED', 'ETIMEDOUT'].includes(error.code) || [408, 504].includes(status)) throw new QuoteError(504, 'PROVIDER_TIMEOUT', `Firecrawl timed out during ${path}. Retry this stock shortly.`);
      if (status === 400 || status === 422) throw new QuoteError(502, 'PROVIDER_REQUEST', `Firecrawl rejected the ${path} request (HTTP ${status}).`);
      throw unavailable(`Firecrawl ${path} failed${status ? ` (HTTP ${status})` : ''}. Please retry later.`);
    }
  }
  async function scrape(url) {
    const data = await firecrawl('scrape', { url, formats: ['markdown'], onlyMainContent: true, maxAge: 0, timeout: 30000 });
    if (data.metadata?.statusCode >= 400) throw unavailable('The source page could not be retrieved.');
    // Reject redirects to a different instrument or site; Google may add /beta/.
    const finalUrl = data.metadata?.url;
    if (finalUrl) {
      const expected = new URL(url), actual = new URL(finalUrl);
      if (actual.hostname !== expected.hostname || actual.pathname.replace('/finance/beta/', '/finance/') !== expected.pathname) throw unavailable('The source redirected to a different page.');
    }
    return data;
  }
  async function fetchQuote(code) {
    const [exchange, symbol] = code.split(':');
    const priceUrl = `https://www.google.com/finance/quote/${encodeURIComponent(symbol)}:${exchange}?hl=en`;
    const priceData = parseGoogle(await scrape(priceUrl), code);
    const tvExchange = exchange === 'BOM' ? 'BSE' : 'NSE';
    let tvSymbol = symbol;
    if (exchange === 'BOM') {
      const results = await firecrawl('search', {
        query: `${priceData.name.replace(/\b(ltd|limited)\b/gi, '').replace(/[^a-z0-9 ]/gi, ' ').trim()} TradingView`,
        limit: 5, sources: ['web'], timeout: 20000,
      });
      const candidates = [...new Set((results.web || []).map(row => row.url).filter(url => /^https:\/\/www\.tradingview\.com\/symbols\/BSE-[A-Z0-9_&-]+\/$/.test(url)))];
      if (candidates.length !== 1) throw unavailable('Could not unambiguously resolve the BSE stock on the ATH source.');
      tvSymbol = new URL(candidates[0]).pathname.split('/')[2].slice(4);
    }
    const athUrl = `https://www.tradingview.com/symbols/${tvExchange}-${tvSymbol}/`;
    const athData = parseAth(await scrape(athUrl), priceData.name, tvSymbol);
    if (athData.ath < priceData.price) throw unavailable('Sources disagree: the reported ATH is below the latest price. Retry after the sources update.');
    return { stock_code: code, ...priceData, ...athData, currency: 'INR', fetched_at: new Date(now()).toISOString(), sources: { price: priceUrl, ath: athUrl } };
  }
  return async function getQuote(input) {
    const code = normalizeCode(input);
    if (!env.FIRECRAWL_API_KEY?.trim()) throw new QuoteError(503, 'NOT_CONFIGURED', 'Stock quote service is not configured.');
    const cached = cache.get(code);
    if (cached && cached.expires > now()) return { ...cached.data, cached: true };
    if (pending.has(code)) return pending.get(code);
    if (pending.size >= 4) throw new QuoteError(429, 'BUSY', 'Too many quote lookups. Retry shortly.');
    const task = fetchQuote(code).then(data => {
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      cache.set(code, { data, expires: now() + 3600000 });
      return { ...data, cached: false };
    }).finally(() => pending.delete(code));
    pending.set(code, task);
    return task;
  };
}
function createQuoteRouter(options = {}) {
  const router = require('express').Router();
  const env = options.env || process.env;
  const getQuote = options.getQuote || createQuoteService(options);
  router.get('/', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const expected = env.STOCK_QUOTE_API_KEY?.trim();
    if (!expected) return res.status(503).json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'Stock quote service is not configured.' } });
    const supplied = req.get('x-api-key') || '';
    const digest = value => crypto.createHash('sha256').update(value).digest();
    if (!crypto.timingSafeEqual(digest(supplied), digest(expected))) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'A valid X-API-Key header is required.' } });
    try {
      res.json({ success: true, ...await getQuote(req.query.code) });
    } catch (error) {
      if (error.status === 429) res.set('Retry-After', String(error.retryAfter || 5));
      res.status(error instanceof QuoteError ? error.status : 502).json({ success: false, error: { code: error.code || 'SOURCE_UNAVAILABLE', message: error instanceof QuoteError ? error.message : 'Stock data could not be retrieved.' } });
    }
  });
  return router;
}
module.exports = { createQuoteRouter, createQuoteService, normalizeCode, parseGoogle, parseAth };
