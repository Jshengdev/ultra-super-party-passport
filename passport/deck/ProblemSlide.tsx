import { SvgArtifact } from './SvgArtifact'
import { GALLERY_SAMPLE_VALUES } from './sampleValues'

/** The sign-up rows trapped in a spreadsheet, echoing the party form fields. */
const ROWS = [
  ['SARAH FAN', 'NETFLIX', 'changes the world through art'],
  ['JOHNNY SHENG', 'USC', 'creatives can change the world'],
  ['TERI SHIM', 'USC', 'someone who makes you feel'],
  ['AARON FIGUEROA', 'UCLA', 'people who build in public'],
  ['LAUREN HSUEH', 'USC', 'hand-lettered, hand-carved'],
  ['ABRIANA CHEN', 'PARSONS', 'a perspective nobody else has'],
]

/**
 * Slide 2 — the problem. Editorial left column, and on the right the cold
 * sign-up spreadsheet with a warm nametag stamp lifting out of it: the data
 * exists, it just needs to be in your hand instead of a spreadsheet.
 */
export function ProblemSlide() {
  return (
    <div className="slide content-slide">
      <div className="slide-paper" />
      <div className="slide-bgtext">
        <SvgArtifact asset="bgText" values={GALLERY_SAMPLE_VALUES.bgText} />
      </div>

      <div className="slide-col slide-col--text problem-text">
        <p className="slide-kicker">the problem</p>
        <h2 className="slide-headline paint-text">
          You go to events for the people.
          <br />
          You can’t see the people.
        </h2>
        <p className="slide-body">
          You walk into a space designed for you, blind, and do all the who-should-i-talk-to math alone, in your head.
        </p>
        <p className="slide-lede">
          The information to fix this already exists. Everyone filled out the sign-up form.
        </p>
        <p className="slide-punch">
          It just sits in a <span className="punch-cold">spreadsheet</span> instead of{' '}
          <span className="punch-warm">in your hand</span>.
        </p>
      </div>

      <div className="problem-visual">
        <div className="ss-card">
          <div className="ss-row ss-head">
            <span>name</span>
            <span>school</span>
            <span>what’s creative?</span>
          </div>
          {ROWS.map((r) => (
            <div className="ss-row" key={r[0]}>
              <span>{r[0]}</span>
              <span>{r[1]}</span>
              <span>{r[2]}</span>
            </div>
          ))}
        </div>
        <div className="ss-sticker">
          <SvgArtifact asset="nametag" values={GALLERY_SAMPLE_VALUES.nametag} ariaLabel="a person, lifted out of the data" />
        </div>
      </div>
    </div>
  )
}
