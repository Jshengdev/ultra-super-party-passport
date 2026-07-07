# Demo script — the <60s run

> Source: `docs/STORY-AMMO.md` (c). Judges decide in ~15s and remember the first and last thing
> (primacy + recency). The **wow fires before 30s**. No setup, no "so what we built is…" — open cold
> on the artifact. Total: ~60 seconds.

## The one breath (memorize; it is the whole pitch)

> *"Every event you've ever been to was curated — you just never got to see it. Sign up to this
> party and you do: the room wires itself toward you, and a passport writes itself — the two
> people to find tonight and one thing it somehow knew about you. **Relational, not a knowledge
> graph**; the AI is completely **invisible**."*

*(Reframed at raw/0016: the problem lives at CURATION-OPACITY — events sell CTAs, never the
people; the graph is finally SEEING the curation; the passport is carrying it into the room.)*

## Problem framings — curation-opacity (raw/0016; pick ONE, tell it like a memory)

1. **Curated, blind.** "Every event you've ever been to was curated — someone picked every name in
   that room. You just never got to see it." *(Image: walking into a room somebody designed for
   you, blindfolded.)*
2. **The poster problem.** "Events show you everything except the thing you came for. The lineup,
   the venue, the open bar — never the people. And people go to events for the people." *(Image: a
   flyer crowded with logos and CTAs, and not one face.)*
3. **Trapped in your head** *(pass-1 survivor — now the DURING half)*: "Because the curation is
   invisible, all the *should-I-go-talk-to-them* math happens alone, in your head. That's why
   events are exhausting." *(Image: rehearsing an opener you never say.)*

Arc: #1 or #2 opens (before-the-event blindness), #3 lands the during-the-event cost, the product
answers both — **see the curation before; carry it with you during.**

## The 90-second judge pitch (30% problem / 70% solution)

| t | Say |
|---|-----|
| 0:00–0:10 | *(hold up a passport)* "Every event you've ever been to was curated. You just never got to see it. Everyone at this party does — and gets one of these." |
| 0:10–0:35 | "Events sell you the lineup, the venue, the CTAs — never the people. And people come for the people. Someone built that room *for* you, and you walk in blind — so the who-should-I-meet math happens in your head, alone. That's why events are exhausting." |
| 0:35–0:55 | "Here, you see the curation. Sign up — three facts and one belief — and the room wires itself toward you: school, work, what you make, what you *believe* creativity is. Watch —" *(live sign-up → the room wires them in)* |
| 0:55–1:15 | "And the passport writes itself: the two people to find tonight and the real reason why — every claim traces to actual paths in the graph. Then this line —" *(read the magic inference, pause)* "— we never told it that." |
| 1:15–1:30 | "Before the event it shows you how the room is curated toward you; during, it curates live as people check in. Relational, not a knowledge graph. The AI is invisible — guests just get a passport. Live at [URL], pipeline on RocketRide, backend on Butterbase, every claim receipted in Neo4j." |

## The messaging spine (repeat everywhere — README, submission, demo, marketing)

1. **"Every event you've been to was curated — you just never got to see it."**
2. **"See how the room is curated toward you — before you arrive, and live while you're there."**
3. **"Sign up to a party; a passport writes itself."**
4. **"Relational, not a knowledge graph — it connects people, not taglines."**
5. **"It never says AI and never feels like AI — the room just knows you."**

*(Judge-facing corollary kept in the submission copy: "everything it claims, it can point to."
Sarah's artifact line stays for marketing: "a ticket that went viral was a flex — yours knows
your people.")*

## Wow-in-first-30s rule

Everything before the 30-second mark exists to make a judge *want a passport of their own* before they
know how it works. Lead with the artifact, never the architecture. The relational graph igniting in the
Universe is the visual money shot — that must land by 0:30.

---

## The beats (timed)

| t | Beat | On screen | Who | Say |
|---|------|-----------|-----|-----|
| 0:00–0:08 | **Cold-open on the wow.** | A single finished passport, beautiful, Teri-skinned. | Johnny | "This is a party for creatives. Everyone who signed up got **this**." (hold up the passport) |
| 0:08–0:20 | **Sign up live.** | The Luma-style form → submit. | Johnny | "Watch — I sign up. Name, and one question: *what does it mean to be creative?*" (type a real answer, submit) |
| 0:20–0:32 | **The star ignites.** | The new node joins the Universe; edges snap to their shared-work + values cloud, which glows. | Teri | "There I am. It just wired me to the people I share work and values with — every edge is real." |
| 0:32–0:48 | **The passport writes itself.** | Passport renders: 2 people to find + why (one same-work, one same-values); flip to the gradient back. | Johnny | "My passport: the two people to find tonight, and *why*. And this line — *[read the magic inference out loud, let it land]* — I never told it that. **How does it know?**" |
| 0:48–0:60 | **Land the spine + the ship.** | The URL + one-line architecture. | Teri → Johnny | Teri: "It's **relational, not a knowledge graph** — it connects people." Johnny: "The AI is invisible — they just got a passport. Live at **[URL]**, deployed pipe, open repo." |

**Emotional peak** = the magic-inference line at ~0:40. Read it slowly. Silence after it is good.
**Last words** = the three-word differentiator ("relational, not knowledge-graph") + proof it ships.

---

## Rules for the live run

- **Pre-seed the room.** The ~40-person test CSV is already ingested so the Universe glows *before* the
  live sign-up — an empty graph has no wow. Only ONE person is typed live (the presenter).
- **Type a real answer**, not lorem. Concreteness beats a mockup: "this is real, not a slide."
- **The magic line must be specific.** A vague horoscope ("you love connecting with people") kills it;
  a specific bridge ("find the other person who left finance to make things") reads as *it knew*.
- **Never say "AI" on stage as the product.** It's a *passport*. The moment you name the mechanism, the
  "how does it know?" wow dies (`claim:engineer-subconsciously-not-explicit`). Warm, first-person copy.
- **Recognition, not reduction.** The passport is a gift, not a dossier — frame every inference as a
  compliment or an invitation.

## If check-in (G5) is cut

Do **not** put a dead button on stage. The two-state / passport-updates-when-you-check-in-at-the-door
idea becomes **one spoken roadmap sentence**, not a live beat: *"Check in at the door and the graph
shifts — your passport updates in real time. That's the next build."*

## Fallback path (if the live demo fails)

Fail loud to yourself, smooth to the room. In priority order:

1. **Live URL is down / slow →** switch to the local `npm run dev` build already open on the machine.
2. **Live sign-up write fails →** narrate over a **pre-generated passport** from `data/passports/`
   (these are committed, so they always render). "Here's one generated earlier —" and read its magic
   line. The story is identical; only the typing is skipped.
3. **Everything is down →** the deck's screenshot of a finished passport + the one-breath line. The
   pitch survives on the artifact alone.

Never debug on stage. If a beat fails, drop to the next fallback and keep the spine intact:
**relational, not a knowledge graph; invisible AI; a passport that writes itself.**
