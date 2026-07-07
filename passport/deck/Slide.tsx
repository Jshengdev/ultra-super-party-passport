'use client'

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** Authoring canvas size; every slide is composed at this fixed 16:9 size and
 *  scaled to fit its container, so positions are predictable like real slides. */
export const SLIDE_W = 1280
export const SLIDE_H = 720

/**
 * Fits a fixed 1280x720 slide canvas into whatever space it is given,
 * preserving the 16:9 aspect (letterboxed). Used both in the deck flow and
 * in fullscreen.
 */
export function Slide({ children }: { children: ReactNode }) {
  const fitRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  useLayoutEffect(() => {
    const el = fitRef.current
    if (!el) return
    const measure = () => {
      const { width, height } = el.getBoundingClientRect()
      setScale(Math.min(width / SLIDE_W, height / SLIDE_H))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={fitRef} className="slide-fit">
      <div className="slide-canvas" style={{ width: SLIDE_W, height: SLIDE_H, transform: `scale(${scale})` }}>
        {children}
        {/* Monet painterly surface, pulled from pepl (pepl-tech): a lit
            canvas/impasto weave under fine film grain, over every slide. */}
        <div className="slide-paper-texture" aria-hidden="true" />
        <div className="slide-grain" aria-hidden="true" />
        {/* hand-painted-edge filter for .paint-text (pepl #paintTexture) */}
        <svg aria-hidden="true" className="slide-defs">
          <filter id="paintTexture" x="-4%" y="-4%" width="108%" height="108%">
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.5" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>
      </div>
    </div>
  )
}
