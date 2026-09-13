/**
 * Compare what was said against what is about to be granted.
 *
 * This is deliberately a weak, transparent check that SURFACES a mismatch for a
 * human rather than deciding by itself. A confident-looking NLP scope matcher
 * would be the kind of thing that silently approves the wrong grant, which is
 * precisely the failure this product exists to prevent.
 */
export function checkSpokenScope(transcript, requested) {
  const said = (transcript || '').toLowerCase()
  const checks = []
  const seen = term => said.includes(String(term).toLowerCase())

  checks.push({ term: 'consent', matched: /\b(consent|agree|authorise|authorize|permission|allow)\b/.test(said) })
  for (const u of requested.useClass ?? []) checks.push({ term: u, matched: seen(u) })
  for (const t of requested.territory ?? []) checks.push({ term: t, matched: seen(t) })

  const missing = checks.filter(c => !c.matched).map(c => c.term)
  return {
    checks,
    missing,
    covered: checks.filter(c => c.matched).length,
    total: checks.length,
    // Never "verified" — we report coverage and let a person decide.
    note: missing.length
      ? `spoken consent does not mention: ${missing.join(', ')} — review before granting`
      : 'spoken consent mentions every requested term',
  }
}
