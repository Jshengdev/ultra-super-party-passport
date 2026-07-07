'use client'

/**
 * The passport document renderer, imported from the social-passport project
 * (Desktop/freaky/passport). One 617x774 SVG matching the Figma frame exactly,
 * with Figma-exported artifacts injected via CHANGE_ placeholders, texture
 * filters, chromatic foil overlays, and the cover-flip open animation.
 *
 * `gradientStops` (the person's DNA gradient from the graph) overrides the
 * photo-window placeholder gradient when provided.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { DocGradientStop, DocPassportData } from './types'
import { ASSETS, connectionValues, KIND_TO_ASSET, type AssetKey } from './assets'
import { injectSvg, withRootAttrs } from './injectSvg'
import { wrapLines } from './textMetrics'
import { TextureDefs } from './TextureDefs'
import { FoilLayer } from './FoilLayer'
import { useFoilTilt } from './useFoilTilt'
import {
  CONTEXT_LABEL,
  IDENTITY_GRID,
  MRZ_BAND,
  PAGE,
  PERFORATION_Y,
  PHOTO_FRAMES,
  PHOTO_WINDOW,
  PROMPT_QA,
  SAFE_ZONE,
  SECTION_BORDER,
  TITLE,
} from './figmaGeometry'
import { placeConnections } from './placeConnections'
import { generateMrz } from './mrz'
import './tokens.css'
import './passport.css'
import './foil.css'

interface NestedArtifactProps {
  asset: AssetKey
  x: number
  y: number
  width?: number
  height?: number
  preserveAspectRatio?: string
  values?: Record<string, string>
  className?: string
  filter?: string
  label?: string
}

/** Inject an exported artifact and nest it into the document at its Figma size. */
function NestedArtifact({
  asset,
  x,
  y,
  width,
  height,
  preserveAspectRatio,
  values,
  className,
  filter,
  label,
}: NestedArtifactProps) {
  const def = ASSETS[asset]
  const html = useMemo(
    () =>
      withRootAttrs(injectSvg(def.raw, values ?? {}), {
        x,
        y,
        width: width ?? def.width,
        height: height ?? def.height,
        ...(preserveAspectRatio ? { preserveAspectRatio } : {}),
      }),
    [def, x, y, width, height, preserveAspectRatio, values],
  )
  return (
    <g
      className={className}
      filter={filter}
      role={label ? 'img' : undefined}
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function PassportDocument({
  data,
  gradientStops,
}: {
  data: DocPassportData
  gradientStops?: DocGradientStop[]
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  useFoilTilt(rootRef)

  // injectSvg parses with DOMParser, which only exists in the browser. On the
  // server (Next static export) we render just the closed cover; the client
  // mounts, injects the artifacts, and the cover-flip reveals the document.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const placements = useMemo(() => placeConnections(data.connections, SAFE_ZONE), [data.connections])
  const byId = useMemo(() => new Map(data.connections.map((c) => [c.id, c])), [data.connections])
  const mrz = useMemo(() => generateMrz(data.holder, data.meta.issued), [data.holder, data.meta.issued])
  const mrzValues = useMemo(() => ({ mrz }), [mrz])
  // long answers (the hidden mission) drop to a smaller face so they stay
  // inside the Q&A region above the mrz band
  const longAnswer = data.holder.prompt.answer.length > 64
  const answerSize = longAnswer ? 12 : PROMPT_QA.answerSize
  const answerLineHeight = longAnswer ? 16 : PROMPT_QA.answerLineHeight
  const answerLines = wrapLines(data.holder.prompt.answer, PROMPT_QA.width, answerSize, 'document')

  const { holder } = data
  const identityFields = [
    { label: 'Full name', value: holder.fullName, x: IDENTITY_GRID.col1x, y: IDENTITY_GRID.rowsY[0] },
    { label: 'Company', value: holder.company, x: IDENTITY_GRID.col1x, y: IDENTITY_GRID.rowsY[1] },
    { label: 'Position', value: holder.position, x: IDENTITY_GRID.col1x, y: IDENTITY_GRID.rowsY[2] },
    { label: 'Grad year', value: holder.gradYear, x: IDENTITY_GRID.col2x, y: IDENTITY_GRID.rowsY[0] },
    { label: 'School', value: holder.school, x: IDENTITY_GRID.col2x, y: IDENTITY_GRID.rowsY[1] },
    { label: 'Major', value: holder.major, x: IDENTITY_GRID.col2x, y: IDENTITY_GRID.rowsY[2] },
  ]

  /* the document renders twice: the full page under the cover, and the
     bottom half again on the cover's back face, so the flip physically
     carries the bottom page down with it */
  const documentSvg = (viewBox: string, hidden = false) => (
    <svg
      className="passport-doc"
      viewBox={viewBox}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={hidden || undefined}
      aria-label={hidden ? undefined : data.meta.title}
    >
      <TextureDefs />

      {gradientStops && gradientStops.length >= 2 && (
        <linearGradient id="photo-holo-data" x1="0" y1="0" x2="1" y2="1">
          {[...gradientStops]
            .sort((a, b) => a.at - b.at)
            .map((stop, i) => (
              <stop key={i} offset={stop.at} stopColor={stop.color} stopOpacity={0.55} />
            ))}
        </linearGradient>
      )}

      {/* paper */}
      <clipPath id="page-clip">
        <rect width={PAGE.width} height={PAGE.height} rx={PAGE.radius} />
      </clipPath>
      <rect className="page-paper" width={PAGE.width} height={PAGE.height} rx={PAGE.radius} />
      <rect width={PAGE.width} height={PAGE.height} rx={PAGE.radius} fill="url(#paper-tone)" />

      {/* subtle background text texture, Figma Frame 13 export */}
      <g clipPath="url(#page-clip)" className="bg-text">
        <NestedArtifact
          asset="bgText"
          x={0}
          y={0}
          width={PAGE.width}
          height={PAGE.height}
          preserveAspectRatio="xMidYMid slice"
        />
      </g>

      {/* top region */}
      <text className="doc-label" x={CONTEXT_LABEL.x} y={CONTEXT_LABEL.y} dominantBaseline="text-before-edge">
        {data.meta.context}
      </text>

      {placements.map((p) => {
        const connection = byId.get(p.id)!
        const cx = p.x + p.width / 2
        const cy = p.y + p.height / 2
        return (
          <g
            key={p.id}
            className="stamp-artifact"
            data-kind={connection.kind}
            transform={`rotate(${p.rotation.toFixed(2)} ${cx.toFixed(1)} ${cy.toFixed(1)})`}
            style={{ '--stagger': p.order, '--lift': `${(-p.rotation * 0.3).toFixed(2)}deg` } as CSSProperties}
          >
            <g className="stamp-pop">
              <NestedArtifact
                asset={KIND_TO_ASSET[connection.kind]}
                x={p.x}
                y={p.y}
                values={connectionValues(connection)}
                filter={connection.kind === 'nametag' ? 'url(#sticker-shadow)' : undefined}
                label={`${connection.person.name}, ${connection.relation}`}
              />
              {connection.kind === 'nametag' && (
                <rect
                  x={p.x + 7}
                  y={p.y + 17}
                  width={p.width - 14}
                  height={p.height - 36}
                  rx={12}
                  fill="url(#sticker-sheen)"
                  opacity={0.4}
                  transform={`rotate(-7.98 ${(p.x + p.width / 2).toFixed(1)} ${(p.y + p.height / 2).toFixed(1)})`}
                />
              )}
            </g>
          </g>
        )
      })}

      {/* perforation between the halves */}
      <NestedArtifact asset="perforation" x={0} y={PERFORATION_Y - 1} />

      {/* bottom region */}
      <text className="doc-title" x={TITLE.xRight} y={TITLE.y} textAnchor="end" dominantBaseline="text-before-edge">
        {data.meta.title}
      </text>

      <g filter="url(#press-strong)">
        <NestedArtifact asset="sectionBorder" x={SECTION_BORDER.x} y={SECTION_BORDER.y} />
      </g>

      <NestedArtifact asset="photoFrames" x={PHOTO_FRAMES.x} y={PHOTO_FRAMES.y} filter="url(#deboss)" />
      {!holder.photoUrl && (
        <rect
          x={PHOTO_WINDOW.x}
          y={PHOTO_WINDOW.y}
          width={PHOTO_WINDOW.width}
          height={PHOTO_WINDOW.height}
          fill={gradientStops && gradientStops.length >= 2 ? 'url(#photo-holo-data)' : 'url(#photo-holo)'}
        />
      )}
      {holder.photoUrl && (
        <g role="img" aria-label={`Photo of ${holder.fullName}`}>
          <clipPath id="photo-window-clip">
            <rect x={PHOTO_WINDOW.x} y={PHOTO_WINDOW.y} width={PHOTO_WINDOW.width} height={PHOTO_WINDOW.height} />
          </clipPath>
          <image
            href={holder.photoUrl}
            x={PHOTO_WINDOW.x}
            y={PHOTO_WINDOW.y}
            width={PHOTO_WINDOW.width}
            height={PHOTO_WINDOW.height}
            preserveAspectRatio="xMidYMid slice"
            clipPath="url(#photo-window-clip)"
          />
        </g>
      )}

      <g filter="url(#press-text)">
        {identityFields.map((f) => (
          <g key={f.label}>
            <text className="id-label" x={f.x} y={f.y} dominantBaseline="text-before-edge">
              {f.label}
            </text>
            <text className="id-value" x={f.x} y={f.y + IDENTITY_GRID.valueOffsetY} dominantBaseline="text-before-edge">
              {f.value}
            </text>
          </g>
        ))}

        <text className="id-label" x={PROMPT_QA.x} y={PROMPT_QA.y} dominantBaseline="text-before-edge">
          {holder.prompt.question}
        </text>
        <text
          className="qa-answer"
          x={PROMPT_QA.x}
          y={PROMPT_QA.y + PROMPT_QA.answerOffsetY}
          dominantBaseline="text-before-edge"
          style={{ fontSize: answerSize }}
        >
          {answerLines.map((line, i) => (
            <tspan key={i} x={PROMPT_QA.x} dy={i === 0 ? 0 : answerLineHeight}>
              {line}
            </tspan>
          ))}
        </text>
        {holder.note && (
          <text
            className="personal-note"
            x={PROMPT_QA.x}
            y={Math.min(
              PROMPT_QA.y + PROMPT_QA.answerOffsetY + answerLines.length * answerLineHeight + 14,
              MRZ_BAND.y - 12,
            )}
            dominantBaseline="text-before-edge"
          >
            {holder.note}
          </text>
        )}
      </g>

      <g filter="url(#press-strong)">
        <NestedArtifact asset="mrzBand" x={MRZ_BAND.x} y={MRZ_BAND.y} values={mrzValues} />
      </g>

      {/* full-bleed grain, multiplied over everything */}
      <rect className="page-grain" width={PAGE.width} height={PAGE.height} rx={PAGE.radius} filter="url(#paper-grain)" />
    </svg>
  )

  // Server / pre-mount: render only the closed cover (no DOMParser needed).
  // Its size matches one page so there is no layout shift when the doc mounts.
  if (!mounted) {
    return (
      <div className="passport-root passport-closed" aria-label={data.meta.title}>
        <div className="passport-cover-static" />
      </div>
    )
  }

  return (
    <div className="passport-root" ref={rootRef}>
      <div className="passport-3d">
        <div className="passport-reveal">
          {documentSvg(`0 0 ${PAGE.width} ${PAGE.height}`)}
          <FoilLayer placements={placements} mrz={mrz} title={data.meta.title} />
        </div>
        <div className="passport-cover" aria-hidden="true">
          <div className="cover-flip">
            <div className="cover-face" />
            <div className="cover-page">{documentSvg(`0 ${PAGE.height / 2} ${PAGE.width} ${PAGE.height / 2}`, true)}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
