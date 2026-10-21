function validateTradeNumbers(type, shares, price) {
  const tradeType = String(type || '').trim().toUpperCase();
  if (!['BUY', 'SELL'].includes(tradeType)) throw new Error('Trade type must be BUY or SELL');
  const number = value => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' ? Number(value) : NaN;
  const quantity = number(shares), unitPrice = number(price);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Shares must be greater than zero');
  if (!Number.isFinite(unitPrice) || unitPrice < 0 || (tradeType === 'SELL' && unitPrice === 0)) throw new Error('Price must be positive, or zero for a bonus BUY');
  const amount = quantity * unitPrice;
  if (!Number.isFinite(amount)) throw new Error('Trade amount is invalid');
  return { type: tradeType, shares: quantity, price: unitPrice, amount };
}
module.exports = { validateTradeNumbers };
