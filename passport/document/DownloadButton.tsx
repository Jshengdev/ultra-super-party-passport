'use client'

import { useState } from 'react'
import { exportPassportPng } from './exportPng'

/** Downloads the rendered passport document as a 2x PNG. */
export function DownloadButton({ personId }: { personId: string }) {
  const [exporting, setExporting] = useState(false)

  const download = async () => {
    setExporting(true)
    try {
      const blob = await exportPassportPng(document.body, 2)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `passport-${personId}.png`
      a.click()
      URL.revokeObjectURL(a.href)
    } finally {
      setExporting(false)
    }
  }

  return (
    <button
      type="button"
      onClick={download}
      disabled={exporting}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        fontSize: 'var(--usp-fs-sm, 14px)',
        color: 'var(--usp-ink-muted, #6b6b74)',
        textDecoration: 'underline',
        textUnderlineOffset: 4,
      }}
    >
      {exporting ? 'exporting...' : 'download as png'}
    </button>
  )
}
