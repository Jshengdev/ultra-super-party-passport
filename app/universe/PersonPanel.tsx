'use client';

/**
 * PersonPanel — the click-through side panel for a selected node.
 *
 * Everything shown is derived from the graph payload itself (nodes + links via the
 * adjacency map) — no separate fetch. For a Person: their belief, what they do /
 * are working on, affinity (school/major/company), their value-cloud, the peers
 * they SHARES_VALUE with, and the link into their passport. For a cluster or an
 * affinity hub: the people gathered there.
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import type { GraphNode, LinkType, Neighbor } from './lib/graph';
import styles from './universe.module.css';

interface Props {
  node: GraphNode;
  adjacency: Map<string, Neighbor[]>;
  hueFor: (clusterId: string | null | undefined) => string | null;
  clusterName: (clusterId: string | null | undefined) => string;
  onSelectNode: (id: string) => void;
  onClose: () => void;
}

const AFFINITY_LABEL: Record<string, string> = {
  School: 'Studies at',
  Major: 'Majors in',
  Company: 'Works at',
  Activity: 'Activity',
  Person: 'Person',
  ValueCluster: 'Value cluster',
};

function neighborsByRel(neighbors: Neighbor[], rel: LinkType, dir?: 'out' | 'in'): Neighbor[] {
  return neighbors.filter((n) => n.rel === rel && (dir ? n.dir === dir : true));
}

/** Read the going-mark from localStorage. Default ON — demo warmth. */
function readGoing(personId: string): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(`usp-going-${personId}`) !== '0';
  } catch {
    return true;
  }
}

/**
 * The pinned footer: the going-mark toggle + the primary "Generate my passport"
 * block button. The passport is for the going — flip the mark off and the button
 * copy softens to "Generate anyway".
 */
function GenerateFooter({ personId }: { personId: string }) {
  const [going, setGoing] = useState(() => readGoing(personId));

  // Re-sync when the selected person changes (panel stays mounted across selections).
  useEffect(() => {
    setGoing(readGoing(personId));
  }, [personId]);

  const toggleGoing = () => {
    const next = !going;
    setGoing(next);
    try {
      window.localStorage.setItem(`usp-going-${personId}`, next ? '1' : '0');
    } catch {
      // storage unavailable (private mode) — in-session state still works
    }
  };

  return (
    <div className={styles.panelFooter}>
      <button
        type="button"
        className={styles.goingRow}
        role="switch"
        aria-checked={going}
        onClick={toggleGoing}
      >
        <span className={going ? `${styles.goingBox} ${styles.goingBoxOn}` : styles.goingBox}>
          <AnimatePresence initial={false}>
            {going && (
              <motion.svg
                className={styles.goingCheck}
                viewBox="0 0 16 16"
                width="12"
                height="12"
                fill="none"
                aria-hidden="true"
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.5 }}
                transition={{ duration: 0.16, ease: 'easeOut' }}
              >
                <motion.path
                  d="M3 8.5 L6.5 12 L13 4.5"
                  stroke="var(--usp-surface)"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.26, ease: 'easeOut' }}
                />
              </motion.svg>
            )}
          </AnimatePresence>
        </span>
        <span className={styles.goingText}>
          <span className={styles.goingLabel}>I’m going to this party</span>
          <AnimatePresence initial={false}>
            {!going && (
              <motion.span
                className={styles.goingHint}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                The passport is for the going.
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      </button>

      <a className={styles.generateBtn} href={`/passport/${encodeURIComponent(personId)}?reveal=1`}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={going ? 'going' : 'anyway'}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.13, ease: 'easeOut' }}
          >
            {going ? 'Generate my passport →' : 'Generate anyway →'}
          </motion.span>
        </AnimatePresence>
      </a>
    </div>
  );
}

function labels(neighbors: Neighbor[], rel: LinkType, dir: 'out' | 'in' = 'out'): string[] {
  return neighborsByRel(neighbors, rel, dir).map((n) => n.node.label);
}

export default function PersonPanel({ node, adjacency, hueFor, clusterName, onSelectNode, onClose }: Props) {
  const neighbors = adjacency.get(node.id) ?? [];
  const hue = hueFor(node.cluster);

  const close = (
    <button className={styles.panelClose} onClick={onClose} aria-label="Close">
      ×
    </button>
  );

  // ---- Person ----
  if (node.type === 'Person') {
    const does = labels(neighbors, 'DOES');
    const workingOn = labels(neighbors, 'WORKING_ON');
    const school = labels(neighbors, 'STUDIES_AT');
    const major = labels(neighbors, 'MAJORS_IN');
    const company = labels(neighbors, 'WORKS_AT');
    const clusters = neighborsByRel(neighbors, 'IN_CLUSTER', 'out').map((n) => n.node);
    const interests = labels(neighbors, 'INTERESTED_IN');
    const peers = neighborsByRel(neighbors, 'SHARES_VALUE').map((n) => n.node);
    const line2 = node.line2 ?? company[0] ?? school[0] ?? '';

    return (
      <aside className={styles.panel}>
        {close}
        <div className={styles.panelBody}>
          <div className={styles.panelKicker}>
            {hue && <span className={styles.kickerSwatch} style={{ background: hue }} />}
            {node.cluster ? clusterName(node.cluster) : 'Person'}
          </div>
          <h2 className={styles.panelName}>{node.label}</h2>
          {line2 && <p className={styles.panelLine2}>{line2}</p>}

          {node.belief && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Believes</p>
              <blockquote className={styles.belief}>“{node.belief}”</blockquote>
            </div>
          )}

          {does.length > 0 && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>What they do</p>
              <p className={styles.sectionBody}>{does.join(' · ')}</p>
            </div>
          )}

          {workingOn.length > 0 && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Working on</p>
              <p className={styles.sectionBody}>{workingOn.join(' · ')}</p>
            </div>
          )}

          {(school.length > 0 || major.length > 0 || company.length > 0) && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Affinity</p>
              <div className={styles.chips}>
                {[...company, ...school, ...major].map((t, i) => (
                  <span key={`${t}-${i}`} className={styles.chip}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {interests.length > 0 && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Into</p>
              <div className={styles.chips}>
                {interests.map((t, i) => (
                  <span key={`${t}-${i}`} className={styles.chip}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {clusters.length > 0 && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Value cloud</p>
              <div className={styles.chips}>
                {clusters.map((c) => {
                  const ch = hueFor(c.cluster);
                  return (
                    <span
                      key={c.id}
                      className={styles.chip}
                      onClick={() => onSelectNode(c.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      {ch && <span className={styles.chipSwatch} style={{ background: ch }} />}
                      {c.label}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {peers.length > 0 && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>People to find</p>
              <div>
                {peers.map((peer) => {
                  const ph = hueFor(peer.cluster);
                  return (
                    <div key={peer.id} className={styles.peer} onClick={() => onSelectNode(peer.id)}>
                      <span className={styles.peerDot} style={{ background: ph ?? 'var(--usp-orb-tint)' }} />
                      <span className={styles.peerText}>
                        <span className={styles.peerName}>{peer.label}</span>
                        {peer.cluster && <span className={styles.peerWhy}>shares {clusterName(peer.cluster)}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <GenerateFooter personId={node.id} />
        </div>
      </aside>
    );
  }

  // ---- ValueCluster ----
  if (node.type === 'ValueCluster') {
    const members = neighborsByRel(neighbors, 'IN_CLUSTER', 'in').map((n) => n.node);
    return (
      <aside className={styles.panel}>
        {close}
        <div className={styles.panelKicker}>
          {hue && <span className={styles.kickerSwatch} style={{ background: hue }} />}
          Value cloud
        </div>
        <h2 className={styles.panelName}>{node.label}</h2>
        <p className={styles.panelLine2}>{members.length} people share this value</p>
        <div className={styles.section}>
          <p className={styles.sectionLabel}>Who’s here</p>
          {members.length === 0 ? (
            <p className={styles.empty}>No members yet.</p>
          ) : (
            <div>
              {members.map((m) => (
                <div key={m.id} className={styles.peer} onClick={() => onSelectNode(m.id)}>
                  <span className={styles.peerDot} style={{ background: hueFor(m.cluster) ?? 'var(--usp-orb-tint)' }} />
                  <span className={styles.peerText}>
                    <span className={styles.peerName}>{m.label}</span>
                    {m.line2 && <span className={styles.peerWhy}>{m.line2}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    );
  }

  // ---- Affinity hub (School / Major / Company / Activity) ----
  const people = neighbors.filter((n) => n.node.type === 'Person').map((n) => n.node);
  return (
    <aside className={styles.panel}>
      {close}
      <div className={styles.panelKicker}>{AFFINITY_LABEL[node.type] ?? node.type}</div>
      <h2 className={styles.panelName}>{node.label}</h2>
      <p className={styles.panelLine2}>{people.length} people connected</p>
      <div className={styles.section}>
        <p className={styles.sectionLabel}>People here</p>
        {people.length === 0 ? (
          <p className={styles.empty}>No one connected yet.</p>
        ) : (
          <div>
            {people.map((m) => (
              <div key={m.id} className={styles.peer} onClick={() => onSelectNode(m.id)}>
                <span className={styles.peerDot} style={{ background: hueFor(m.cluster) ?? 'var(--usp-orb-tint)' }} />
                <span className={styles.peerText}>
                  <span className={styles.peerName}>{m.label}</span>
                  {m.line2 && <span className={styles.peerWhy}>{m.line2}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
