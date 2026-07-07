import { SvgArtifact } from './SvgArtifact'
import { GALLERY_SAMPLE_VALUES } from './sampleValues'

const PILLARS = [
  {
    name: 'Butterbase',
    tag: 'backbone',
    role: 'backend, auth, and the AI gateway',
    body: 'Every LLM and embedding call routes through one OpenAI-compatible gateway. Also the deploy target and submission venue.',
  },
  {
    name: 'RocketRide',
    tag: 'inference',
    role: 'the deployed inference path',
    body: 'The ingest and inference pipeline runs as a cloud endpoint the app calls over HTTP, not a local script.',
  },
  {
    name: 'Graph model',
    tag: 'source of truth',
    role: 'one zod ontology, one write gate',
    body: 'Every write validates against the manifest, then parameterized Cypher with stamped provenance. Off-ontology node and link types are unrepresentable. Values are computed, not typed: belief answers are embedded, clustered, and written back as shared-value edges.',
  },
  {
    name: 'Cognee',
    tag: 'bonus',
    role: 'agent memory',
    body: 'Long-term memory for the agent, layered on once the mandatories are green.',
  },
]

/**
 * Slide 5 — the stack. Four pillars, three mandatory and one bonus, each with
 * its role and the one detail that matters.
 */
export function StackSlide() {
  return (
    <div className="slide content-slide stack-slide">
      <div className="slide-paper" />
      <div className="slide-bgtext">
        <SvgArtifact asset="bgText" values={GALLERY_SAMPLE_VALUES.bgText} />
      </div>

      <div className="slide-col slide-col--text stack-head">
        <p className="slide-kicker">how it’s built</p>
        <h2 className="slide-headline paint-text">A graph you can trust.</h2>
      </div>

      <div className="stack-grid">
        {PILLARS.map((p) => (
          <div className={`stack-card${p.tag === 'bonus' ? ' stack-card--bonus' : ''}`} key={p.name}>
            <div className="stack-card-top">
              <h3 className="stack-name">{p.name}</h3>
              <span className="stack-tag">{p.tag}</span>
            </div>
            <p className="stack-role">{p.role}</p>
            <p className="stack-body">{p.body}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
