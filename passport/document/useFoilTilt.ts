import { useEffect, type RefObject } from 'react'

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1)

/**
 * Writes --pointer-x / --pointer-y / --tilt custom properties on the passport
 * root from pointer position (and device orientation on mobile). Writes style
 * properties directly: zero react re-renders on pointer move.
 *
 * Under prefers-reduced-motion the listeners are never attached, so the sweep
 * stays frozen at the token defaults while the colors remain.
 */
export function useFoilTilt(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let raf = 0
    const apply = (nx: number, ny: number, hovering: boolean) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        el.style.setProperty('--pointer-x', `${(nx * 100).toFixed(2)}%`)
        el.style.setProperty('--pointer-y', `${(ny * 100).toFixed(2)}%`)
        el.style.setProperty('--tilt', `${((nx - 0.5) * 28).toFixed(2)}deg`)
        // 3d tilt only while the pointer is over the document
        el.style.setProperty('--tilt-x', hovering ? `${((nx - 0.5) * 10).toFixed(2)}deg` : '0deg')
        el.style.setProperty('--tilt-y', hovering ? `${(-(ny - 0.5) * 8).toFixed(2)}deg` : '0deg')
      })
    }

    const onMove = (e: PointerEvent) => {
      // the sketch frame opts out of tilt (raw/0035): drawing never fights the card
      if ((e.target as Element | null)?.closest?.('[data-no-tilt]')) {
        apply(0.5, 0.5, false)
        return
      }
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) return
      const rawX = (e.clientX - r.left) / r.width
      const rawY = (e.clientY - r.top) / r.height
      const hovering = rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1
      apply(clamp01(rawX), clamp01(rawY), hovering)
    }

    const onOrient = (e: DeviceOrientationEvent) => {
      apply(clamp01(((e.gamma ?? 0) + 45) / 90), clamp01((e.beta ?? 45) / 90), true)
    }

    let orientationAttached = false
    const attachOrientation = () => {
      window.addEventListener('deviceorientation', onOrient)
      orientationAttached = true
    }
    const requestOrientation = () => {
      window.removeEventListener('touchstart', requestOrientation)
      type PermissionRequester = { requestPermission?: () => Promise<string> }
      const ctor = DeviceOrientationEvent as unknown as PermissionRequester
      if (typeof ctor.requestPermission === 'function') {
        ctor
          .requestPermission()
          .then((state) => {
            if (state === 'granted') attachOrientation()
          })
          .catch(() => {
            /* degrade silently */
          })
      } else {
        attachOrientation()
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('touchstart', requestOrientation)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('touchstart', requestOrientation)
      if (orientationAttached) window.removeEventListener('deviceorientation', onOrient)
    }
  }, [ref])
}
