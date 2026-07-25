/* The zoom-in choreography — Layer 4's state machine.
   Per cluster: rest → approach → focused → release. Only the active
   cluster's board morphs; everyone else stays at rest. */

import type { BoardState } from "./boards";
import type { GraphLayout } from "./sheetLayout";
import type { FieldName } from "./segments";
import { hash2 } from "./prng";

/* glyphs are texture now, not the main voice: only some people get
   the board to re-condense into their name — deterministic per id */
const glyphMoment = (id: string) => {
  let acc = 0;
  for (let i = 0; i < id.length; i++) acc += id.charCodeAt(i) * (i + 1);
  return hash2(acc % 977, 7.31) < 0.3;
};

export type ClusterPhase = "rest" | "approach" | "focused";

export type ChoreoParams = {
  morphDur: number; // ms — full morph
  morphHold: number; // ms — pure field in the middle
  hopDur: number; // ms — dot-to-dot flicker
  hopHold: number;
  field: FieldName;
};

export type FocusedPerson = {
  id: string;
  name: string;
  clusterIndex: number;
};

export class Choreography {
  phases: ClusterPhase[];
  private shownPerson: (string | null)[];

  constructor(n: number) {
    this.phases = new Array(n).fill("rest");
    this.shownPerson = new Array(n).fill(null);
  }

  update(
    now: number,
    activeCluster: number | null,
    focused: FocusedPerson | null,
    boards: BoardState[],
    layout: GraphLayout,
    p: ChoreoParams,
    reduced: boolean
  ) {
    layout.clusters.forEach((_cl, ci) => {
      const board = boards[ci];
      if (!board) return;
      const want: ClusterPhase =
        ci === activeCluster
          ? focused && focused.clusterIndex === ci
            ? "focused"
            : "approach"
          : "rest";
      const cur = this.phases[ci];

      const opts = { duration: p.morphDur, fieldHold: p.morphHold };

      if (want !== cur) {
        if (want === "approach") {
          /* board dissolves from whatever it spelled into the field */
          board.morphToField(p.field, now, opts, reduced);
          this.shownPerson[ci] = null;
        } else if (want === "focused" && focused) {
          /* the serif echo carries the name; the board mostly keeps
             weathering — only a glyph-moment person condenses to text */
          if (glyphMoment(focused.id)) {
            board.morphToText(focused.name, now, opts, reduced);
          } else if (cur === "rest") {
            board.morphToField(p.field, now, opts, reduced);
          }
          this.shownPerson[ci] = focused.id;
        } else {
          /* release: whatever is up → field → blank; the serif group
             name fades back in over the resting board */
          board.morphToText("", now, opts, reduced);
          this.shownPerson[ci] = null;
        }
        this.phases[ci] = want;
      } else if (
        want === "focused" &&
        focused &&
        this.shownPerson[ci] !== focused.id
      ) {
        /* person hop inside the cluster: short flicker, glyphs only
           for glyph-moment people; otherwise settle back to field */
        if (glyphMoment(focused.id)) {
          board.morphToText(
            focused.name,
            now,
            { duration: p.hopDur + p.hopHold, fieldHold: p.hopHold },
            reduced
          );
        } else if (board.currentText !== "") {
          board.morphToField(p.field, now, opts, reduced);
        }
        this.shownPerson[ci] = focused.id;
      }
    });
  }

  labelTarget(ci: number): number {
    return this.phases[ci] === "rest" ? 0 : 1;
  }
}
