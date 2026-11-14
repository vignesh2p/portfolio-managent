const {yahooSymbol}=require('./yahoo-prices');

async function validateYahooCodes(yf,codes){
  if(!Array.isArray(codes)||codes.length<1||codes.length>10||codes.some(code=>typeof code!=='string'||code.length>54)){
    throw Object.assign(new Error('Provide 1–10 Yahoo Finance codes, up to 54 characters each.'),{status:400});
  }
  const results=new Map();
  for(const code of new Set(codes)){
    const value=code.trim().toUpperCase();
    if(!/^[A-Z0-9][A-Z0-9&._-]{0,49}\.(NS|BO)$/.test(value)){
      let suggestion;
      try{suggestion=yahooSymbol(code);}catch{}
      results.set(code,{code,status:'invalid',message:suggestion?'Use Yahoo symbol '+suggestion+' instead of '+value+'. Update the code, validate again, then Save.':'Invalid Yahoo Finance code. Use a symbol ending .NS or .BO, such as RELIANCE.NS.'});continue;
    }
    let symbol;
    try{symbol=yahooSymbol(code);}catch{
      results.set(code,{code,status:'invalid',message:'Invalid format. Use a Yahoo symbol such as RELIANCE.NS or an exchange-qualified code.'});continue;
    }
    try{
      const quote=await yf.quote(symbol);
      const valid=quote?.symbol===symbol&&quote.quoteType==='EQUITY';
      results.set(code,{code,symbol,status:valid?'valid':'invalid',message:valid?'Valid Yahoo Finance equity.':'Yahoo Finance did not return an equity for this code.'});
    }catch{
      results.set(code,{code,symbol,status:'unavailable',message:'Yahoo lookup could not be completed. Retry validation.'});
    }
  }
  return codes.map(code=>results.get(code));
}
module.exports={validateYahooCodes};
