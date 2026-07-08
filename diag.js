const xrpl = require('xrpl');
(async () => {
  const client = new xrpl.Client('wss://s1.ripple.com');
  await client.connect();
  const RLUSD_HEX = '524C555344000000000000000000000000000000';
  const RLUSD = { currency: RLUSD_HEX, issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' };
  const XRP = { currency: 'XRP' };
  const USD_B = { currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' };
  const v = (x) => typeof x === 'string' ? Number(x)/1e6 : Number(x.value);
  const [a, b, c, d] = await Promise.all([
    client.request({ command: 'book_offers', taker_gets: RLUSD, taker_pays: XRP, limit: 5 }),
    client.request({ command: 'book_offers', taker_gets: XRP, taker_pays: RLUSD, limit: 5 }),
    client.request({ command: 'book_offers', taker_gets: USD_B, taker_pays: RLUSD, limit: 5 }),
    client.request({ command: 'book_offers', taker_gets: RLUSD, taker_pays: USD_B, limit: 5 }),
  ]);
  console.log('XRP->RLUSD offres:', a.result.offers.length);
  a.result.offers.slice(0,3).forEach(o => console.log(' ', v(o.TakerGets).toFixed(4), 'RLUSD pour', v(o.TakerPays).toFixed(4), 'XRP'));
  console.log('RLUSD->XRP offres:', b.result.offers.length);
  b.result.offers.slice(0,3).forEach(o => console.log(' ', v(o.TakerGets).toFixed(4), 'XRP pour', v(o.TakerPays).toFixed(4), 'RLUSD'));
  console.log('RLUSD->USD offres:', c.result.offers.length);
  c.result.offers.slice(0,3).forEach(o => console.log(' ', v(o.TakerGets).toFixed(4), 'USD pour', v(o.TakerPays).toFixed(4), 'RLUSD'));
  console.log('USD->RLUSD offres:', d.result.offers.length);
  d.result.offers.slice(0,3).forEach(o => console.log(' ', v(o.TakerGets).toFixed(4), 'RLUSD pour', v(o.TakerPays).toFixed(4), 'USD'));
  await client.disconnect();
})().catch(console.error);