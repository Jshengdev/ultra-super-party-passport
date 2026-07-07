'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Slide } from './Slide'
import { SLIDES } from './slides'
import './deck.css'

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/**
 * Slide deck in the passport design system. Click or arrow-key through the
 * slides; press expand (or f) to take the current 16:9 slide fullscreen.
 */
export default function DeckPage() {
  const [index, setIndex] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)

  const go = useCallback((delta: number) => setIndex((i) => clamp(i + delta, 0, SLIDES.length - 1)), [])

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) stageRef.current?.requestFullscreen?.()
    else document.exitFullscreen?.()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        go(1)
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        go(-1)
      } else if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen()
      } else if (e.key === 'Home') {
        setIndex(0)
      } else if (e.key === 'End') {
        setIndex(SLIDES.length - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, toggleFullscreen])

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const Current = SLIDES[index].Component

  return (
    <div className="deck-root">
      <div className={`deck-stage${isFullscreen ? ' is-fullscreen' : ''}`} ref={stageRef}>
        {/* click the slide to advance; left edge to go back */}
        <button className="deck-hit deck-hit--prev" aria-label="previous slide" onClick={() => go(-1)} />
        <button className="deck-hit deck-hit--next" aria-label="next slide" onClick={() => go(1)} />

        <Slide>
          <Current />
        </Slide>

        <button
          type="button"
          className="deck-expand"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? 'exit fullscreen' : 'expand to fullscreen'}
        >
          {isFullscreen ? 'exit' : 'expand'}
        </button>

        <div className="deck-counter" aria-hidden={SLIDES.length < 2}>
          {index + 1} / {SLIDES.length}
        </div>
      </div>

      <nav className="deck-controls" aria-label="slide navigation">
        <button type="button" className="deck-btn" onClick={() => go(-1)} disabled={index === 0}>
          prev
        </button>
        <div className="deck-dots" role="tablist" aria-label="slides">
          {SLIDES.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`slide ${i + 1}`}
              className={`deck-dot${i === index ? ' is-active' : ''}`}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
        <button type="button" className="deck-btn" onClick={() => go(1)} disabled={index === SLIDES.length - 1}>
          next
        </button>
      </nav>
    </div>
  )
}
