(function(root) {
  function validateSIPConfig(config) {
    if (!config || typeof config.max_budget !== 'number' || !Number.isFinite(config.max_budget) || config.max_budget <= 0) {
      throw new Error('Enter a budget greater than zero.');
    }
    const levels = config.levels;
    if (!Array.isArray(levels) || levels.length !== 7) throw new Error('Configure all seven SIP levels.');
    let previous = 0, total = 0;
    for (const level of levels) {
      if (!level || typeof level.fall !== 'number' || !Number.isFinite(level.fall) || level.fall <= -100 || level.fall >= previous) {
        throw new Error('Fall percentages must be between -100% and 0%, in strictly decreasing order (for example -10, -15, -20).');
      }
      if (typeof level.allocation !== 'number' || !Number.isFinite(level.allocation) || level.allocation < 0 || level.allocation > 100) {
        throw new Error('Each allocation must be a number between 0% and 100%.');
      }
      previous = level.fall;
      total += level.allocation;
    }
    if (Math.abs(total - 100) > 1e-8) throw new Error(`Allocations must total 100%. Current total: ${Number(total.toFixed(6))}%.`);
    return {max_budget:config.max_budget, levels:levels.map(({fall,allocation})=>({fall,allocation}))};
  }
  if (typeof module === 'object' && module.exports) module.exports = {validateSIPConfig};
  else root.validateSIPConfig = validateSIPConfig;
})(typeof globalThis !== 'undefined' ? globalThis : this);
