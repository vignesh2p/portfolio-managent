// Read only the provider key; never print credentials or Axios request objects.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createQuoteService } = require('../stock-quote-api');
const contents = fs.readFileSync(path.join(__dirname, '../.env.production'), 'utf8');
const key = contents.match(/^FIRECRAWL_API_KEY=([^\r\n]+)/m)?.[1]?.trim();
const getQuote = createQuoteService({ env: { FIRECRAWL_API_KEY: key }, post: async (url, body, options) => {
  const started = Date.now();
  try {
    const response = await axios.post(url, body, options);
    console.log(JSON.stringify({ operation: url.split('/').pop(), status: response.status, elapsed_ms: Date.now() - started }));
    if (url.endsWith('/search')) console.log(JSON.stringify({ results: response.data?.data?.web?.map(row => ({ title: row.title, url: row.url })) }));
    return response;
  } catch (error) {
    const message = JSON.stringify(error.response?.data?.error || error.response?.data?.message || error.code || 'Unknown error');
    console.log(JSON.stringify({ operation: url.split('/').pop(), status: error.response?.status, elapsed_ms: Date.now() - started, error: key ? message.split(key).join('[REDACTED]').slice(0,1500) : 'Missing key' }));
    throw error;
  }
} });
const task = process.argv[2] === '--search'
  ? axios.post('https://api.firecrawl.dev/v2/search', { query: process.argv[3], limit: 5, sources: ['web'] }, { headers: { Authorization: `Bearer ${key}` }, timeout: 30000 }).then(response => response.data)
  : getQuote(process.argv[2] || 'BOM:504605');
task.then(quote => console.log(JSON.stringify(quote, null, 2))).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
