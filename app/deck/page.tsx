/**
 * /deck — the pitch deck, in the passport design system. Standalone: it reuses
 * the passport document's tokens and Figma-exported artifacts, but is not wired
 * to the graph/backend. Click or arrow through slides; press expand (or f) for
 * fullscreen.
 */
import { EB_Garamond, IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google'
import DeckPage from '@/passport/deck/DeckPage'
import '@/passport/document/tokens.css'

const plexSans = IBM_Plex_Sans({ weight: ['400', '500'], subsets: ['latin'], variable: '--np-plex-sans' })
const plexMono = IBM_Plex_Mono({ weight: ['400'], subsets: ['latin'], variable: '--np-plex-mono' })
const garamond = EB_Garamond({ weight: ['400'], subsets: ['latin'], variable: '--np-garamond' })

export const metadata = { title: 'The ultra super social passport — deck' }

export default function DeckRoute() {
  return (
    <div className={`${plexSans.variable} ${plexMono.variable} ${garamond.variable}`}>
      <DeckPage />
    </div>
  )
}
