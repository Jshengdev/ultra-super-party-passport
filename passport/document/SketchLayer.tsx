'use client'

/**
 * SketchLayer — the headshot frame as a drawing surface (raw/0035).
 *
 * An absolutely-positioned canvas over the photo window (PHOTO_WINDOW, in the
 * page's own coordinate space, mapped to percentages so it scales with the
 * container). The brush is the brand gradient itself: each stroke segment's
 * color is interpolated along the soft-premium stops by the point's y within
 * the frame — pink ink at the top of the frame, dusty blue at the bottom.
 *
 * Saves to localStorage (usp-sketch-<id>) as a dataURL; restores on mount.
 * The wrapper carries data-no-tilt so the card's hover tilt can be gated out
 * while drawing (wired in useFoilTilt).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { PAGE, PHOTO_WINDOW } from './figmaGeometry'

// the soft-premium blend (raw/0032) as brush stops, top → bottom of the frame
const BRUSH_STOPS: [number, string][] = [
  [0.0, '#e9b7c4'],
  [0.22, '#eab288'],
  [0.42, '#ddb96e'],
  [0.62, '#a8bd8f'],
  [0.82, '#7d9cc9'],
  [1.0, '#6c8ec2'],
]

function hexToRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}

function brushColor(t: number): string {
  const c = Math.min(Math.max(t, 0), 1)
  for (let i = 1; i < BRUSH_STOPS.length; i++) {
    const [t1, h1] = BRUSH_STOPS[i]
    if (c <= t1) {
      const [t0, h0] = BRUSH_STOPS[i - 1]
      const k = t1 === t0 ? 0 : (c - t0) / (t1 - t0)
      const a = hexToRgb(h0)
      const b = hexToRgb(h1)
      const mix = a.map((v, j) => Math.round(v + (b[j] - v) * k))
      return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`
    }
  }
  return BRUSH_STOPS[BRUSH_STOPS.length - 1][1]
}

const SCALE = 3 // canvas backing resolution multiplier (crisp on retina)

export function SketchLayer({ sketchId }: { sketchId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const [hasInk, setHasInk] = useState(false)
  const [saved, setSaved] = useState(false)
  const storageKey = `usp-sketch-${sketchId}`

  // restore a saved sketch
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    try {
      const data = localStorage.getItem(storageKey)
      if (!data) return
      const img = new Image()
      img.onload = () => {
        const ctx = el.getContext('2d')
        if (!ctx) return
        ctx.clearRect(0, 0, el.width, el.height)
        ctx.drawImage(img, 0, 0, el.width, el.height)
        setHasInk(true)
        setSaved(true)
      }
      img.src = data
    } catch {
      /* storage unavailable — sketch stays session-only */
    }
  }, [storageKey])

  const point = useCallback((e: React.PointerEvent) => {
    const el = canvasRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      x: ((e.clientX - r.left) / r.width) * el.width,
      y: ((e.clientY - r.top) / r.height) * el.height,
    }
  }, [])

  const down = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const p = point(e)
      if (!p) return
      drawing.current = true
      last.current = p
      canvasRef.current?.setPointerCapture(e.pointerId)
    },
    [point],
  )

  const move = useCallback(
    (e: React.PointerEvent) => {
      if (!drawing.current) return
      const el = canvasRef.current
      const ctx = el?.getContext('2d')
      const p = point(e)
      if (!el || !ctx || !p || !last.current) return
      ctx.strokeStyle = brushColor(p.y / el.height)
      ctx.lineWidth = 3 * SCALE
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(last.current.x, last.current.y)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
      last.current = p
      if (!hasInk) setHasInk(true)
      if (saved) setSaved(false)
    },
    [point, hasInk, saved],
  )

  const up = useCallback(() => {
    drawing.current = false
    last.current = null
  }, [])

  const clear = useCallback(() => {
    const el = canvasRef.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    ctx.clearRect(0, 0, el.width, el.height)
    setHasInk(false)
    setSaved(false)
    try {
      localStorage.removeItem(storageKey)
    } catch {
      /* fine */
    }
  }, [storageKey])

  const save = useCallback(() => {
    const el = canvasRef.current
    if (!el) return
    try {
      localStorage.setItem(storageKey, el.toDataURL('image/png'))
      setSaved(true)
    } catch {
      /* storage full/unavailable — stays session-only */
    }
  }, [storageKey])

  // frame position as percentages of the page → scales with the container
  const left = (PHOTO_WINDOW.x / PAGE.width) * 100
  const top = (PHOTO_WINDOW.y / PAGE.height) * 100
  const width = (PHOTO_WINDOW.width / PAGE.width) * 100
  const height = (PHOTO_WINDOW.height / PAGE.height) * 100

  return (
    <div
      data-no-tilt
      style={{
        position: 'absolute',
        left: `${left}%`,
        top: `${top}%`,
        width: `${width}%`,
        height: `${height}%`,
        zIndex: 6,
      }}
    >
      <canvas
        ref={canvasRef}
        width={PHOTO_WINDOW.width * SCALE}
        height={PHOTO_WINDOW.height * SCALE}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          cursor: 'crosshair',
          touchAction: 'none',
          borderRadius: 2,
        }}
        aria-label="sketch yourself — the headshot frame is a drawing surface"
      />
      {!hasInk && (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            fontFamily: 'var(--np-plex-mono, ui-monospace, monospace)',
            fontSize: 8.5,
            letterSpacing: '0.18em',
            color: 'oklch(45% 0.03 285 / 0.55)',
            textTransform: 'uppercase',
          }}
        >
          sketch yourself
        </span>
      )}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: -16,
          display: 'flex',
          justifyContent: 'center',
          gap: 12,
          fontFamily: 'var(--np-plex-mono, ui-monospace, monospace)',
          fontSize: 8,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
        }}
      >
        <button
          onClick={clear}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'oklch(45% 0.03 285 / 0.7)', font: 'inherit', letterSpacing: 'inherit' }}
        >
          clear
        </button>
        <button
          onClick={save}
          disabled={!hasInk}
          style={{
            background: 'none',
            border: 'none',
            cursor: hasInk ? 'pointer' : 'default',
            color: saved ? 'oklch(55% 0.09 150 / 0.9)' : 'oklch(36% 0.045 285 / 0.85)',
            font: 'inherit',
            letterSpacing: 'inherit',
          }}
        >
          {saved ? 'saved ✓' : 'save'}
        </button>
      </div>
    </div>
  )
}
