/**
 * A stand-in DKG node for resolver tests. It answers exactly the query shapes
 * src/queries.mjs builds, from Knowledge Assets made with ./build.mjs, and can
 * reproduce the v10.0.16 fault of leaving whole graphs out of a result.
 */
import { ReadTruncatedError } from '../../src/dkg.mjs'
import { cgIri } from '../../src/queries.mjs'
import * as V from '../../src/vocab.mjs'

const unquote = o => (typeof o === 'string' && o.startsWith('"') ? o.slice(1, o.indexOf('"', 1)) : o)

export class FakeNode {
  /**
   * @param {object} o
   * @param {Object<string, {kas?: object[], graphs?: {graph: string, rows: object[]}[]}>} o.world  keyed by context graph id
   * @param {(q: {kind: string, call: number, graph?: string}) => boolean} [o.drop]  true drops that result (or graph)
   * @param {boolean} [o.mergedView]  false models a live node that did not publish the data: no `<cg>/context/` copy
   */
  constructor({ world, drop = () => false, name = 'fake', mergedView = true }) {
    this.world = world
    this.drop = drop
    this.mergedView = mergedView
    this.name = name
    this.calls = []
  }

  data(cg, { view, includeSharedMemory } = {}) {
    const w = this.world[cg] ?? {}
    const quads = []
    const meta = []
    for (const ka of w.kas ?? []) {
      meta.push(...ka.metaRows)
      quads.push(...ka.contentRows)
      // A merged view repeats every Verifiable Memory triple without its publisher.
      if (view === 'verifiable-memory' && this.mergedView) quads.push(...ka.contentRows.map(r => ({ ...r, g: `${cgIri(cg)}/context/1` })))
    }
    for (const extra of w.graphs ?? []) {
      const isSwm = extra.graph.includes('/_shared_memory/')
      const isContext = extra.graph.includes('/context/')
      if (isSwm && !includeSharedMemory) continue
      if (isContext && view !== 'verifiable-memory') continue
      quads.push(...extra.rows.map(r => ({ g: extra.graph, ...r })))
    }
    return { quads, meta }
  }

  async queryJson(sparql, { contextGraphId, includeSharedMemory, view, max = 5000 } = {}) {
    const call = this.calls.length
    const { quads, meta } = this.data(contextGraphId, { view, includeSharedMemory })
    const prefix = (sparql.match(/STRSTARTS\(STR\(\?g\), "([^"]+)"\)/) ?? [])[1]
    const distinct = /^SELECT DISTINCT /.test(sparql)
    let kind
    let rows
    if (sparql.includes('/_meta>')) {
      kind = 'meta'
      const publisher = (sparql.match(/CONTAINS\(LCASE\(STR\(\?s\)\), "\/(0x[0-9a-f]{40})\/"\)/) ?? [])[1]
      const uals = [...sparql.matchAll(/<(did:dkg:[^>]+)>/g)].map(m => m[1]).filter(u => !u.startsWith('did:dkg:context-graph'))
      rows = meta.filter(r => sparql.includes('?s IN') ? uals.includes(r.s) : (!publisher || r.s.toLowerCase().includes(`/${publisher}/`)))
    } else if (sparql.includes('COUNT(DISTINCT ?g)')) {
      kind = 'count'
      rows = [{ n: `"${new Set(quads.filter(q => q.g.startsWith(prefix)).map(q => q.g)).size}"^^<http://www.w3.org/2001/XMLSchema#integer>` }]
    } else if (/^SELECT (DISTINCT )?\?g \?s \?o \?v/.test(sparql)) {
      kind = 'states'
      const ids = [...sparql.matchAll(/<(urn:[^>]+)>/g)].map(m => m[1])
      // Like a SPARQL engine: one row per stateOf triple per state value.
      rows = quads.filter(q => q.g.startsWith(prefix) && q.p === V.stateOf && ids.includes(q.o)).flatMap(q => {
        const vs = quads.filter(x => x.g === q.g && x.s === q.s && x.p === V.state)
        return vs.length ? vs.map(v => ({ g: q.g, s: q.s, o: q.o, v: v.o })) : [{ g: q.g, s: q.s, o: q.o }]
      })
    } else if (/^SELECT (DISTINCT )?\?g \?s WHERE/.test(sparql)) {
      kind = 'grant-subjects'
      const subject = (sparql.match(new RegExp(`<${V.subject.replace(/[.#/]/g, '\\$&')}> "([^"]+)"`)) ?? [])[1]
      rows = quads.filter(q => q.g.startsWith(prefix) && q.p === V.subject && unquote(q.o) === subject).map(q => ({ g: q.g, s: q.s }))
    } else if (sparql.includes('?m <')) {
      kind = 'marked'
      const [, pred, obj] = sparql.match(/\?m <([^>]+)> (\S+) \./)
      const markers = quads.filter(q => q.g.startsWith(prefix) && q.p === pred && (q.o === obj || `<${q.o}>` === obj))
      // The join repeats every triple of a graph once per marker in it.
      rows = markers.flatMap(m => quads.filter(q => q.g === m.g).map(({ g, s, p, o }) => ({ g, s, p, o })))
    } else if (sparql.includes('GRAPH ?g { ?s ?p ?o }')) {
      kind = 'content'
      rows = quads.filter(q => q.g.startsWith(prefix)).map(({ g, s, p, o }) => ({ g, s, p, o }))
    } else {
      throw new Error(`fake node cannot answer:\n${sparql}`)
    }
    this.calls.push({ kind, contextGraphId, view, includeSharedMemory, prefix })
    if (this.drop({ kind, call, contextGraphId })) rows = []
    else if (rows.some(r => r.g)) rows = rows.filter(r => !r.g || !this.drop({ kind, call, graph: r.g, contextGraphId }))
    if (distinct) rows = [...new Map(rows.map(r => [JSON.stringify(r), r])).values()]
    if (/ORDER BY/.test(sparql)) {
      const key = r => JSON.stringify([r.g ?? '', r.s ?? '', r.p ?? '', r.o ?? ''])
      rows = [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    }
    const offset = Number((sparql.match(/ OFFSET (\d+)$/) ?? [])[1] ?? 0)
    const limit = (sparql.match(/ LIMIT (\d+)(?: OFFSET \d+)?$/) ?? [])[1]
    if (offset || limit !== undefined) rows = rows.slice(offset, limit === undefined ? undefined : offset + Number(limit))
    if (rows.length > max) throw new ReadTruncatedError(`${rows.length} rows`)
    return rows
  }
}
