'use client'

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { ASSETS, type AssetKey } from '../document/assets'
import { injectSvg, withRootAttrs } from '../document/injectSvg'

interface SvgArtifactProps {
  asset: AssetKey
  values?: Record<string, string>
  raw?: boolean
  className?: string
  style?: CSSProperties
  ariaLabel?: string
}

/**
 * Injects an asset and renders it inline. injectSvg parses with DOMParser
 * (browser only), so injection is deferred until mount; the placeholder space
 * is reserved so slide layout does not shift when the artifact appears.
 */
export function SvgArtifact({ asset, values, raw = false, className, style, ariaLabel }: SvgArtifactProps) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const html = useMemo(() => {
    if (!mounted) return ''
    const markup = raw ? ASSETS[asset].raw : injectSvg(ASSETS[asset].raw, values ?? {})
    return withRootAttrs(markup, { width: '100%', height: '100%' })
  }, [asset, values, raw, mounted])

  return (
    <div
      className={className}
      style={style}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
