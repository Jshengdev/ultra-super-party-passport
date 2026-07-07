import { SvgArtifact } from './SvgArtifact'
import { GALLERY_SAMPLE_VALUES } from './sampleValues'

const USES = [
  { n: '01', label: 'marketing', body: 'a cute passport your guests want to post on social.' },
  { n: '02', label: 'planning', body: 'curate your event, and the people who fill it.' },
  { n: '03', label: 'documenting', body: 'a keepsake artifact of who you actually met.' },
]

/**
 * Slide 4 — what it's for. Three jobs one artifact quietly does, then the
 * one-liner that ties them together: an interrelational crm.
 */
export function UseCasesSlide() {
  return (
    <div className="slide content-slide uses-slide">
      <div className="slide-paper" />
      <div className="slide-bgtext">
        <SvgArtifact asset="bgText" values={GALLERY_SAMPLE_VALUES.bgText} />
      </div>

      <div className="slide-col slide-col--text">
        <p className="slide-kicker">what it’s for</p>
        <h2 className="slide-headline paint-text">One artifact, three jobs.</h2>
      </div>

      <div className="uses-grid">
        {USES.map((u) => (
          <div className="use-card" key={u.n}>
            <span className="use-n">{u.n}</span>
            <h3 className="use-label">{u.label}</h3>
            <p className="use-body">{u.body}</p>
          </div>
        ))}
      </div>

      <p className="uses-tagline slide-punch">
        it’s like an <span className="punch-warm">interrelational crm</span>.
      </p>
    </div>
  )
}
