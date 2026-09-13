/**
 * Build the namespace documents served at https://oojae.github.io/mandate/ns/v1
 * from the canonical ontology in vocab/. The page is generated rather than
 * hand-written so the human-readable spec cannot drift from the machine-readable
 * one; test/vocab.test.mjs checks the copies are current.
 */
import { Parser } from 'n3'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'

const NS = 'https://oojae.github.io/mandate/ns/v1#'
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#'
const OUT = 'docs/ns/v1'

const ttl = readFileSync('vocab/mandate.ttl', 'utf8')
const quads = new Parser().parse(ttl)

const bySubject = new Map()
for (const q of quads) {
  const s = q.subject.value
  if (!bySubject.has(s)) bySubject.set(s, [])
  bySubject.get(s).push(q)
}
const one = (s, p) => bySubject.get(s)?.find(q => q.predicate.value === p)?.object.value
const short = iri => iri.startsWith(NS) ? `mandate:${iri.slice(NS.length)}`
  : iri.replace('http://www.w3.org/2001/XMLSchema#', 'xsd:').replace(RDFS, 'rdfs:')
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const terms = [...bySubject.keys()].filter(s => s.startsWith(NS))
const isClass = s => bySubject.get(s).some(q => q.predicate.value === RDF_TYPE && q.object.value === `${RDFS}Class`)
const classes = terms.filter(isClass)
const props = terms.filter(s => !isClass(s))

const ontology = NS.slice(0, -1)
const title = one(ontology, 'http://purl.org/dc/terms/title')
const description = one(ontology, 'http://purl.org/dc/terms/description')
const version = one(ontology, 'http://www.w3.org/2002/07/owl#versionInfo')

const termBlock = s => {
  const name = s.slice(NS.length)
  const domain = one(s, `${RDFS}domain`), range = one(s, `${RDFS}range`)
  return `<article class="term" id="${name}">
  <h3><a href="#${name}">${esc(name)}</a></h3>
  <p class="iri"><code>${esc(s)}</code></p>
  ${one(s, `${RDFS}comment`) ? `<p>${esc(one(s, `${RDFS}comment`))}</p>` : ''}
  ${domain || range ? `<dl>${domain ? `<dt>domain</dt><dd><code>${esc(short(domain))}</code></dd>` : ''}${range ? `<dt>range</dt><dd><code>${esc(short(range))}</code></dd>` : ''}</dl>` : ''}
</article>`
}

const propsFor = c => props.filter(p => one(p, `${RDFS}domain`) === c)

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mandate vocabulary v1</title>
<link rel="alternate" type="text/turtle" href="mandate.ttl">
<link rel="alternate" type="application/ld+json" href="context.jsonld">
<style>
  :root { --bg:#fbfaf7; --fg:#1b1a17; --muted:#6b675e; --line:#e4e0d6; --accent:#8a3b12; --code:#f1ede3; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#141311; --fg:#ebe7dd; --muted:#9d988c; --line:#2c2a25; --accent:#e0915f; --code:#1f1d19; }
  }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 ui-serif, Georgia, "Iowan Old Style", serif; }
  main { max-width:46rem; margin:0 auto; padding:3rem 1.25rem 5rem; }
  h1 { font-size:2rem; line-height:1.2; margin:0 0 .25rem; letter-spacing:-.01em }
  h2 { font:600 .8rem/1 ui-sans-serif, system-ui, sans-serif; text-transform:uppercase; letter-spacing:.12em;
       color:var(--muted); margin:3rem 0 1rem; padding-top:1.5rem; border-top:1px solid var(--line) }
  h3 { font-size:1.15rem; margin:0 0 .15rem }
  h3 a { color:inherit; text-decoration:none }
  h3 a:hover { color:var(--accent) }
  .meta { color:var(--muted); font:14px/1.5 ui-sans-serif, system-ui, sans-serif; margin:0 0 2rem }
  code { font:13px/1.4 ui-monospace, "SF Mono", Menlo, monospace; background:var(--code); padding:.1em .35em; border-radius:3px; overflow-wrap:anywhere }
  .iri { margin:0 0 .5rem; color:var(--muted) }
  .iri code { background:none; padding:0 }
  .term { padding:1rem 0; border-bottom:1px solid var(--line) }
  .term p { margin:.25rem 0 }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:.15rem .75rem; margin:.5rem 0 0;
       font:14px/1.5 ui-sans-serif, system-ui, sans-serif }
  dt { color:var(--muted) }
  dd { margin:0 }
  .rule { border-left:3px solid var(--accent); padding:.5rem 0 .5rem 1rem; margin:1.5rem 0 }
  .rule strong { color:var(--accent) }
  ul.downloads { padding-left:1.1rem; font:15px/1.8 ui-sans-serif, system-ui, sans-serif }
  a { color:var(--accent) }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<p class="meta">Version ${esc(version)} · Namespace <code>${esc(NS)}</code> · Apache-2.0</p>
<p>${esc(description)}</p>

<div class="rule">
  <p><strong>The authorship rule.</strong> A <code>mandate:GrantState</code> assertion counts only when its
  <code>mandate:stateAuthor</code> is the <code>mandate:grantor</code> of the grant it refers to. The graph is
  append-only, so “active” and “revoked” assertions coexist and anyone can write either; a resolver that skips
  this check lets the party that profits from rendering defeat any revocation.</p>
</div>

<h2>Downloads</h2>
<ul class="downloads">
  <li><a href="mandate.ttl">mandate.ttl</a> — the ontology, Turtle</li>
  <li><a href="context.jsonld">context.jsonld</a> — JSON-LD context</li>
  <li><a href="https://github.com/OoJae/mandate">github.com/OoJae/mandate</a> — reference resolver and gate</li>
</ul>

${classes.map(c => `<h2>${esc(one(c, `${RDFS}label`) ?? c.slice(NS.length))}</h2>
${termBlock(c)}
${propsFor(c).map(termBlock).join('\n')}`).join('\n')}
</main>
</body>
</html>
`

mkdirSync(OUT, { recursive: true })
writeFileSync(`${OUT}/index.html`, html)
copyFileSync('vocab/mandate.ttl', `${OUT}/mandate.ttl`)
copyFileSync('vocab/context.jsonld', `${OUT}/context.jsonld`)
writeFileSync('docs/.nojekyll', '')
console.log(`built ${OUT}: ${classes.length} classes, ${props.length} properties`)
