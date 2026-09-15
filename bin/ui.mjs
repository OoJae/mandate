/**
 * Terminal output.
 *
 * Text that came from someone else — graph literals, platform messages, URLs —
 * is stripped of control characters before it is printed, so a crafted value
 * cannot rewrite the terminal or disguise a refusal as a permit.
 */
const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR

const ESC = String.fromCharCode(27)
const paint = code => s => (useColor() ? `${ESC}[${code}m${s}${ESC}[0m` : String(s))
export const c = {
  red: paint(31), green: paint(32), yellow: paint(33), dim: paint(2), bold: paint(1),
}

/** C0 and C1 control characters except tab and newline, plus DEL. */
const isControl = code => (code <= 0x1f && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)

/** Make untrusted text safe to print. */
export function clean(value, max = 2000) {
  let out = ''
  for (const ch of String(value ?? '')) {
    if (!isControl(ch.codePointAt(0))) out += ch
    if (out.length >= max) break
  }
  return out
}

const EXPLORERS = { 'base:84532': 'https://sepolia.basescan.org', 'base:8453': 'https://basescan.org' }

/** A block explorer link for a transaction, when the chain is known. */
export function txLink(ual, txHash) {
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null
  const chain = String(ual ?? '').match(/^did:dkg:([a-z0-9]+:\d+)\//)?.[1]
  return EXPLORERS[chain] ? `${EXPLORERS[chain]}/tx/${txHash}` : null
}

/**
 * Collects one command's output. In --json mode human lines are suppressed and
 * a single result object is printed at the end; notices — a link someone must
 * open, progress on a long wait — still reach the operator, on stderr.
 */
export function makeOutput({ json = false } = {}) {
  return {
    json,
    line: (...parts) => { if (!json) console.log(...parts) },
    notice: (...parts) => { if (json) console.error(...parts); else console.log(...parts) },
    result: obj => { if (json) console.log(JSON.stringify(obj, null, 2)) },
  }
}
