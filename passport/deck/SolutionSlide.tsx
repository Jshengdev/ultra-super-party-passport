import { SvgArtifact } from './SvgArtifact'
import { GALLERY_SAMPLE_VALUES } from './sampleValues'

/** A small relational graph: people nodes wired by shared context. */
function GraphMark() {
  const nodes = [
    { x: 100, y: 72, r: 9, accent: true },
    { x: 28, y: 34, r: 6 },
    { x: 172, y: 40, r: 6 },
    { x: 38, y: 120, r: 6 },
    { x: 166, y: 116, r: 6 },
    { x: 104, y: 18, r: 5 },
  ]
  const edges = [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
    [1, 5],
    [2, 5],
    [3, 4],
  ]
  return (
    <svg viewBox="0 0 200 150" className="flow-graph" aria-hidden="true">
      {edges.map(([a, b], i) => (
        <line key={i} x1={nodes[a].x} y1={nodes[a].y} x2={nodes[b].x} y2={nodes[b].y} className="flow-edge" />
      ))}
      {nodes.map((n, i) => (
        <circle key={i} cx={n.x} cy={n.y} r={n.r} className={n.accent ? 'flow-node flow-node--accent' : 'flow-node'} />
      ))}
    </svg>
  )
}

/**
 * Slide 3 — the solution. Names the product, then a three-step flow that
 * shows the mechanism: Luma sign-ups become a relational graph, and the graph
 * becomes each person's passport.
 */
export function SolutionSlide() {
  return (
    <div className="slide content-slide solution-slide">
      <div className="slide-paper" />
      <div className="slide-bgtext">
        <SvgArtifact asset="bgText" values={GALLERY_SAMPLE_VALUES.bgText} />
      </div>

      <div className="slide-col slide-col--text">
        <p className="slide-kicker">the solution</p>
        <h2 className="slide-headline paint-text">
          The ultra super <span className="headline-chroma">social passport</span>.
        </h2>
        <p className="slide-body solution-body">
          Hosts and guests turn what everyone submits through Luma into a relational graph. From it, each person
          generates their own artifact: a passport of the people they should meet.
        </p>
      </div>

      <div className="flow-band">
        <figure className="flow-step">
          <div className="flow-viz">
            <div className="flow-form">
              {['what do you do?', 'where from?', 'what is creative?'].map((t) => (
                <div className="flow-form-row" key={t}>
                  <span className="flow-form-dot" />
                  {t}
                </div>
              ))}
            </div>
          </div>
          <figcaption className="flow-cap">luma sign-ups</figcaption>
        </figure>

        <div className="flow-arrow" aria-hidden="true">
          →
        </div>

        <figure className="flow-step">
          <div className="flow-viz">
            <GraphMark />
          </div>
          <figcaption className="flow-cap">relational graph</figcaption>
        </figure>

        <div className="flow-arrow" aria-hidden="true">
          →
        </div>

        <figure className="flow-step">
          <div className="flow-viz flow-viz--stamp">
            <SvgArtifact asset="roundStamp" values={GALLERY_SAMPLE_VALUES.roundStamp} ariaLabel="your passport" />
          </div>
          <figcaption className="flow-cap">your passport</figcaption>
        </figure>
      </div>
    </div>
  )
}
