/**
 * Publish skills/likeness-consent.md as a Livepeer community skill.
 *
 *   node scripts/publish-skill.mjs                 # dry run: print the payload and limits
 *   node scripts/publish-skill.mjs --publish       # publish (requires LIVEPEER_AGENT_KEY)
 *   add --env-path <path> to read settings from that file (default ~/.mandate/.env)
 *
 * The task/domain/persona tags and scope are a closed vocabulary that no tool
 * exposes; if publish_skill rejects them, its error names the problem. Override
 * with --task a,b --domain a,b --persona a,b --scope episode|epic|story.
 *
 * Refuses to publish without a key: a keyless publish may create a skill no one
 * can later update or delete, since ownership is verified by API key.
 */
import { readFileSync } from 'node:fs'
import { loadMandateEnv } from '../bin/config.mjs'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : def
}

// The same env file as the CLI: --env-path <path>, else MANDATE_ENV_FILE, else
// $MANDATE_HOME/.env (default ~/.mandate/.env); a .env in the working directory
// is never read. Only MANDATE_* and LIVEPEER_AGENT_KEY come from it. This
// request carries the key, so a stray NODE_TLS_REJECT_UNAUTHORIZED=0 or proxy
// setting copied into the file must not reach it.
if (process.argv.slice(2).some(a => /^--env-file(?:-if-exists)?(?:=|$)/.test(a))) {
  console.error('--env-file is read by Node.js itself, which applies a NODE_OPTIONS from that file; name the env file with --env-path <path> instead')
  process.exit(1)
}
let envFile
try {
  envFile = loadMandateEnv({ flag: arg('env-path') })
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
for (const w of envFile.warnings) console.error(`warning: ${w}`)
console.log(envFile.path ? `env file: ${envFile.path}` : `env file: none (looked for ${envFile.searched})`)
if (envFile.ignored.length) console.log(`.env: ignored ${envFile.ignored.join(', ')} (only MANDATE_* and LIVEPEER_AGENT_KEY are read)`)
const list = (name, def) => arg(name, def).split(',').map(s => s.trim()).filter(Boolean)

const payload = {
  namespace: arg('namespace', 'media:oojae/likeness-consent'),
  name: 'likeness-consent',
  description: "Ask before depicting a real person's face or voice; refuse and say why",
  agent_rule: 'Depict a real, identifiable person only with their explicit, current, in-scope consent; otherwise stop and say why.',
  task: list('task', 'generate,edit'),
  domain: list('domain', 'image,video,audio'),
  persona: list('persona', 'creator'),
  scope: arg('scope', 'episode'),
  body: readFileSync('skills/likeness-consent.md', 'utf8'),
  version: '1.0.0',
  author: 'OoJae',
}

const limits = [
  ['description', payload.description.length, 80],
  ['agent_rule', payload.agent_rule.length, 120],
  ['body', payload.body.length, 20000],
]
let over = false
for (const [field, n, max] of limits) {
  console.log(`${field.padEnd(12)} ${String(n).padStart(5)} / ${max}${n > max ? '  OVER' : ''}`)
  if (n > max) over = true
}
const steering = payload.body.match(/https?:\/\/|\$\d|run_capability|create_media|livepeer|mandate\b/gi)
console.log(`steering    ${steering ? steering.join(', ') : 'none'}  (lint forbids tool, cost and URL steering)`)
console.log(`namespace   ${payload.namespace}`)
console.log(`tags        task=${payload.task} domain=${payload.domain} persona=${payload.persona} scope=${payload.scope}`)
if (over || steering) process.exit(1)

if (!process.argv.includes('--publish')) {
  console.log('\ndry run — pass --publish to publish')
  process.exit(0)
}
if (!process.env.LIVEPEER_AGENT_KEY) {
  console.error('\nLIVEPEER_AGENT_KEY is not set. Add it to your env file (~/.mandate/.env, or pass --env-path); refusing to publish keyless.')
  process.exit(2)
}
if (process.env.LIVEPEER_AGENT_KEY.startsWith('sk_')) {
  // Measured 2026-09-13: the endpoint rejects the whole connection with 401,
  // "Daydream sk_ API keys are retired … Use a pymthouse composite key instead".
  console.error('\nLIVEPEER_AGENT_KEY is a Daydream sk_ key, which Livepeer Agent has retired.\n'
    + 'It needs a PymtHouse composite key: app_<appId>_pmth_<token>.')
  process.exit(2)
}

const { connect, textOf, FULL } = await import('../src/livepeer.mjs')
const client = await connect(FULL)
try {
  const res = await client.callTool({ name: 'publish_skill', arguments: payload })
  console.log('\npublish_skill:\n' + textOf(res))
  if (res.isError) process.exit(3)
  const ref = `skill:${payload.namespace}`
  console.log('\nget_skill:\n' + textOf(await client.callTool({ name: 'get_skill', arguments: { ref } })))
  console.log('\nlist_skills (consent):\n' + textOf(await client.callTool({ name: 'list_skills', arguments: { query: 'consent' } })))
} finally {
  await client.close()
}
