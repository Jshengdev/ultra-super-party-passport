/**
 * /passport/[id] — renders one person's passport from data/passports/<id>.json.
 *
 * Server component: reads the JSON off disk, validates it against the shared
 * `passportSchema` (passport/schema.ts), and renders the passport window's
 * `PassportCard` (passport/template.tsx). If the file is missing or malformed we
 * show an HONEST failed state — never a fabricated passport (dot / sayhello law).
 *
 * The passport JSON is produced by the passport window (`npm run passports`); this
 * page just presents it. tokens.css themes both the card and this shell.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { passportSchema } from '@/passport/schema';
import PassportCard from '@/passport/template';
import Reveal from './Reveal';
import '@/passport/tokens.css';

export const dynamic = 'force-static';

export async function generateStaticParams() {
  try {
    const dir = path.join(process.cwd(), 'data', 'passports');
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith('.json')).map((f) => ({ id: f.replace(/\.json$/, '') }));
  } catch {
    return [];
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--usp-bg)',
        color: 'var(--usp-ink)',
        fontFamily: 'var(--usp-font-sans)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 22,
        padding: '48px 20px 64px',
      }}
    >
      {children}
    </main>
  );
}

function Failed({ id, reason }: { id: string; reason: string }) {
  return (
    <Shell>
      <div style={{ textAlign: 'center', maxWidth: 460 }}>
        <div
          style={{
            fontSize: 'var(--usp-fs-xs)',
            textTransform: 'uppercase',
            letterSpacing: 'var(--usp-tracking-wide)',
            color: 'var(--usp-ink-faint)',
            marginBottom: 10,
          }}
        >
          Passport not available
        </div>
        <h1
          style={{
            fontSize: 'var(--usp-fs-xl)',
            fontWeight: 'var(--usp-weight-bold)',
            letterSpacing: 'var(--usp-tracking-tight)',
            margin: '0 0 12px',
          }}
        >
          No passport for “{id}” yet
        </h1>
        <p style={{ fontSize: 'var(--usp-fs-sm)', color: 'var(--usp-ink-muted)', lineHeight: 1.5, margin: 0 }}>
          {reason}
        </p>
      </div>
      <a
        href="/universe"
        style={{ fontSize: 'var(--usp-fs-sm)', color: 'var(--usp-ink-muted)', textDecoration: 'none' }}
      >
        ← Back to the Universe
      </a>
    </Shell>
  );
}

export default async function PassportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  // guard against path traversal — only ever read within data/passports/
  const safe = path.basename(id);
  const file = path.join(process.cwd(), 'data', 'passports', `${safe}.json`);

  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return (
      <Failed
        id={id}
        reason="Their passport hasn't been generated yet. Passports are built from the live graph (npm run passports)."
      />
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    return <Failed id={id} reason="The passport file exists but is not valid JSON. It may be mid-write." />;
  }

  const result = passportSchema.safeParse(parsedJson);
  if (!result.success) {
    const first = result.error.issues[0];
    return (
      <Failed
        id={id}
        reason={`The passport file is present but does not match the passport schema${
          first ? ` (${first.path.join('.') || 'root'}: ${first.message})` : ''
        }.`}
      />
    );
  }

  return (
    <Shell>
      <Reveal
        name={result.data.name}
        connections={result.data.find.reduce((n, f) => n + f.path_receipt.length, 0)}
      >
        <PassportCard passport={result.data} side="both" />
      </Reveal>
    </Shell>
  );
}
