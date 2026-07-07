import { SvgArtifact } from './SvgArtifact'
import { GALLERY_SAMPLE_VALUES } from './sampleValues'

/**
 * The deck title slide, composed in the passport design system: periwinkle
 * paper, the three artifacts blown up and scattered, and the document title
 * as the hero — solid dark ink with a printed texture, revealing a hint of
 * chromatic foil shine on hover.
 */
export function TitleSlide() {
  return (
    <div className="slide title-slide">
      {/* paper + background text texture, as on the passport */}
      <div className="slide-paper" />
      <div className="slide-bgtext">
        <SvgArtifact asset="bgText" values={GALLERY_SAMPLE_VALUES.bgText} />
      </div>

      {/* scattered oversized stamps */}
      <div className="title-stamp title-stamp--nametag" style={{ transform: 'rotate(-6deg)' }}>
        <SvgArtifact asset="nametag" values={GALLERY_SAMPLE_VALUES.nametag} ariaLabel="nametag sticker" />
      </div>
      <div className="title-stamp title-stamp--belief" style={{ transform: 'rotate(5deg)' }}>
        <SvgArtifact asset="beliefStamp" values={GALLERY_SAMPLE_VALUES.beliefStamp} ariaLabel="belief stamp" />
      </div>
      <div className="title-stamp title-stamp--round" style={{ transform: 'rotate(-9deg)' }}>
        <SvgArtifact asset="roundStamp" values={GALLERY_SAMPLE_VALUES.roundStamp} ariaLabel="round stamp" />
      </div>

      {/* hero title */}
      <div className="title-block">
        <p className="title-kicker">the ultra super</p>
        <h1 className="title-hero">
          <span className="title-line" data-text="SOCIAL">
            SOCIAL
          </span>
          <span className="title-line" data-text="PASSPORT">
            PASSPORT
          </span>
        </h1>
      </div>
    </div>
  )
}
