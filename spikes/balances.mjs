const RPC = 'https://sepolia.base.org'
const W = {
  'grantor-admin':   '0x20EffFDf9135d1DCD4E2756d7bd23E4b3644eECB',
  'grantor-primary': '0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69',
  'producer-admin':  '0xA4479AF7199f9205D377CEfb6bF0a26CbBD92850',
  'producer-primary':'0x8EaA4857B22dddbfb5ebC476087FEc39336e0CB5',
}
const out = {}
for (const [name, addr] of Object.entries(W)) {
  try {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [addr, 'latest'] }) })
    const j = await r.json()
    out[name] = Number(BigInt(j.result ?? '0x0')) / 1e18
  } catch { out[name] = null }
}
console.log(JSON.stringify(out))
