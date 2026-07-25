# North Star — Johnny's brain dump (2026-07-25, verbatim)

> **Protocol:** this document is the clarification anchor. Every vision-level question gets asked
> AGAINST it, in the form: *"here is the quote → we think it leads to this → what did you think?"*
> The verbatim below is never edited — additions land as dated addenda. Interpretations live in
> the map underneath and carry a status.

## The verbatim

> ok so im going to just do a masssive brain dump yapapge about everything that i see and what i
> think it should be optimzied for. THis execersicese is desinged for better clarity but also just
> establihsing a basic understadning of what we are looking to make and work towards to enhance and
> ensure that its extremely polished including the infromation itself. so from what i understadn we
> are going to jsut in the graph view. we spawn in, and theres a massiv bubble. At this point we
> should hide the connections box view and the hometowns view temporary as a little pill container
> button to turn on and off for now. Thiss makes it somethign we can work with ain a clean
> enviornment including the bottom live slider. we just need to ensure each one of these are
> components that cna be toggled on and off. - this marks the first success critieara to ensure it
> isnt overcomplicated.
>
> next. once you click it pops the bubble. Right now what i want to consider is just how the view of
> everythign looks. so right now what i see if dotted outlines as each grouping. this is basicaly
> the assumed identity familiy of the people who signed up and filled in the form that we computed
> from the 300 peoples. Theres a couple task in this bracnh which is first. how we can change these
> peices of infromation aroudn and see if there is any routing that we need ot adjust in temrs of
> how ew create nodes and ensureings modular to some degree. but i like the flashing integrations of
> what we had as the securtiy tage form the passprot before. Nice sublte effect. But I want to
> restore a little bit of the previous knowledge graph structure into this. Keep the same texture of
> the dots themselves but ensure that for each name, it should have either color coded with a simple
> light palletle or something netural and not overaly the top. But this isj ust to make it a little
> more easy to understand the groupoings. Then when we restore a little bit of hte previouse
> knowledge graph style. we should be able ot drag around the dots themselves of each inficivual and
> watch how everythign else around still stays gropued proeprly no amterr the location and the
> dotted lines act as like smooth guidelines around each grouping for the ux clairty aspect and give
> it a super sublye rainblow glow edge that fades in and out extremly subltyl like at a 5-10%
> almost. THis is just for the live movmenet knoweldge graph to just see each of the fields. This is
> socped as its own task and backgrond agent branch that needs to be spitting out PRs.
>
> but next, i want to look into the interaction itself when you select an indiviudal. these 3 assets
> appear super cutely and show of a little bit of information and want to see where this exists and
> ensure it has clear locaiton routing that we know if we make choices where it should go into. So
> when we click on it, it should smoothyl blur out the background so we can focus on teh things that
> popped up. it shoudl be extremely sublte with a slight 5% dimming and here is where we already see
> the cnonections component update with hte live informaitno we can populate for htis indivudal
> about the number of poeple its connected to and things of that sort. and then for the their
> threads, it should be showing like the feature about how it can connect with other people there
> and see who is there and how we are seeing hwo you would like to connect with. So the connections
> comonent that exists on the bottom left updates to show htemselves and their connections by number
> and value. the three pop ups show more cute specific cards about who we think they are summed up,
> and then the thier threads is how they cna find other people to connect with based on their
> responses. SO what is really importatn in theis section is knowing how we can split up everything
> so that its well established how we would update the scehmea and where the source of truth doc for
> what we computed for each peroson to update at. This is kidn of two parts, the ux side but also
> the technical implmentation side where there is something that we want to do with it
>
> so fianlly this is everything we wanted to do and everything we want to achieve. this is the
> verbatim of everything and what it means is that we will always ask calrifiying questions to THIS.
> it should always be, "here is the quote, we think its elads to this but hwat did you think for
> clarification" this is how we want to effecitly know how we can create whats neccesary. so THese
> are all the changes that we possibly need and unloaded them all so they can all be done in
> paraellel, utilizng workflows espeicalyl dynamic workflows with each major section governed by a
> fable 5 background agent, which spawns its opus 5 subagents to lead each PR and report bak otoeh
> fable, who reports to this window so we can review each impolmetnation and how we can ship out all
> these changes piece by piece as effecitly and efficienlty as possible. When it comes to search or
> quick task, just use sonnnet to ensure we have the speed needed from it but fi it requires
> intelligence consider opus and fable. save this doc and ensure that we are processing everything
> in here to effecitly create teh dynamci workflow we are trying to estalbilish

## Interpretation map (quote → reading → status)

### Section A — the clean environment (toggles)
- *"hide the connections box view and the hometowns view temporary as a little pill container
  button to turn on and off … including the bottom live slider … each one of these are components
  that cna be toggled on and off"* → Every overlay widget (connections box, hometowns map, the
  bottom ticker) becomes an independently toggleable component behind small pill buttons; default
  hidden for a clean field. **First success criterion: not overcomplicated.** — CONFIRMED BY QUOTE.
- Reading: *"the bottom live slider"* = the school/company logo ticker along the bottom edge.
  — CONFIRMED (addendum 1).

### Section B — the living knowledge graph (own branch, spitting out PRs)
- *"dotted outlines as each grouping … the assumed identity familiy … computed from the 300
  peoples"* → the motive-cloud groupings are the identity families; they stay the organizing idea.
- *"how we can change these peices of infromation aroudn … any routing that we need ot adjust in
  temrs of how ew create nodes and ensureings modular"* → make the grouping FIELD swappable
  (node-creation routing modular: motive today; mission/craft/school tomorrow) with a clear seam.
- *"i like the flashing integrations of what we had as the securtiy tage form the passprot before"*
  → the passport security-tag flash effect is LIKED — keep it. — CONFIRMED BY QUOTE.
- *"Keep the same texture of the dots … for each name … color coded with a simple light palletle or
  something netural and not overaly the top … easy to understand the groupoings"* → dot texture
  unchanged; NAME LABELS get subtle grouping tints (light palette / neutral). — CONFIRMED, palette
  choice delegated to the implementer within "light + not over the top".
- *"drag around the dots themselves … everythign else around still stays gropued proeprly no amterr
  the location and the dotted lines act as like smooth guidelines … super sublye rainblow glow edge
  that fades in and out extremly subltyl like at a 5-10%"* → dots are draggable; group outlines
  re-fit smoothly around live positions; outlines get a 5–10% opacity rainbow glow that breathes.
  — CONFIRMED BY QUOTE (numbers pinned by Johnny).

### Section C — the selection experience (+ schema source-of-truth)
- *"smoothyl blur out the background … extremely sublte with a slight 5% dimming"* → focus
  treatment: soft blur + ~5% dim behind the popups. — CONFIRMED, numbers pinned.
- *"the cnonections component update with hte live informaitno … number of poeple its connected to
  … by number and value"* → bottom-left connections box becomes selection-reactive: the person's
  own connection counts/values, live. — CONFIRMED BY QUOTE.
- *"the three pop ups show more cute specific cards about who we think they are summed up"* → the
  3 stamps become identity-summary cards (who we computed they are). Reading: sourced from the
  conviction layer — card 1 who they are (motive), card 2 what they value (mission/impact),
  card 3 what they're working toward (aspiration/goal). — CONFIRMED (addendum 1).
- *"the thier threads is how they cna find other people to connect with based on their responses"*
  → threads = the connect-with-others surface (who's there + how you want to connect).
  — CONFIRMED BY QUOTE.
- *"how we would update the scehmea and where the source of truth doc for what we computed for each
  peroson to update at"* → a pinned schema/source-of-truth map: every rendered fact → which file
  computes it → where a human edits it (the sheet + overrides is the intended station).
  — CONFIRMED; the deliverable is the map itself.

### The orchestration (this is the standing process)
- *"all be done in paraellel, utilizng workflows espeicalyl dynamic workflows with each major
  section governed by a fable 5 background agent, which spawns its opus 5 subagents to lead each
  PR and report bak"* → Fable-5 governor per section, isolated git worktree each, Opus-5 PR leads
  under them (serialized WITHIN a worktree), Sonnet for quick/search tasks, PRs reviewed and merged
  piece by piece in the main window. — CONFIRMED BY QUOTE.

## Addendum 1 (2026-07-25, verbatim)

> yes it is the btotom live ticker on teh bottme edges. and also yes the three popups are teh
> conviction layer. the conviction in who they are as indiviudials. clealry showiing the convicitno
> of who they are as indivudals and what they value. its clear what they are trying to work
> towards. So lets get this updated on butterbase or wherever it is deployed so we have a standard
> to view and share

## Addendum 2 (2026-07-25, verbatim)

> esnrue we are not working in /universe anymore. we are exlisuivly build the /graph as the final
> viewing port

Interpretation: /graph is THE product surface. /universe is frozen legacy — no work lands there,
no parity obligations against it; it may serve as historical reference for effects/ideas only.
— CONFIRMED BY QUOTE.

## Addendum 3 (2026-07-25, verbatim)

> for the blur, make sure whatever the bubble hovers on it converts that section into full clairty.
> Also for each text item, is there a way to render it with more clarity? We need to ensure the text
> is as clear as it can be

Interpretation: (1) the popped bubble becomes a CLARITY LENS through the focus veil — wherever it
hovers, that region renders fully sharp (a veil cutout tracking the bubble; this also answers the
veil's open question (b): a sharp window YES, tracked by the bubble, not the dot). (2) A text-clarity
pass across the scene: every rendered text item as crisp as achievable (DPR-aware canvas/WebGL label
rendering, contrast/alpha, grain-veil interaction) — clarity outranks subtlety where they conflict.
— CONFIRMED BY QUOTE.

## Addendum 4 (2026-07-25, verbatim)

> so basically for more clairty on the bubble. when we are in a zoomed out view. eveyrhting should
> be crystal clear and the buble just does the edge effect. but when you select on one individual
> whatever is in the buble will recieve the full calirty

Interpretation — the two-state clarity model: (1) AT REST (no selection, zoomed out): the entire
room is crystal clear; the bubble contributes ONLY its refractive edge effect — nothing inside or
outside it is blurred/distorted by the bubble. (2) ON SELECTING AN INDIVIDUAL: the focus veil
softens the room, and whatever sits inside the bubble receives full clarity (the lens cutout) —
the bubble becomes the reading glass for the softened room. — CONFIRMED BY QUOTE.

## Addendum 5 (2026-07-25, verbatim)

> for one of the adgents make it so the scale of the actual card items can be scaled to be slightly
> larger and the bubble as well. if we have a hidden command when we press 0 it should open this new
> menu

Interpretation: a HIDDEN tuning menu, toggled by pressing "0" (never while typing in an input),
exposing scale controls to make (a) the card/stamp items and (b) the bubble slightly larger —
live-adjustable so the right sizes can be found by feel. Built by extending the scene's existing
tune affordance (reuse-first), not a parallel panel. — CONFIRMED BY QUOTE.

## Addendum 6 (2026-07-25, verbatim)

> for teh connections tab, what it shoudl ship is the not the strongest ties because thats done
> through teh their treads tab. The connections tab is meant to be for the individual themselves to
> show their onw stats and how many people are similar to that. Yknow what im saying. like
> traditional knoweldge graph stats of who they are and what other people share. Imagine being able
> to visualize how everyone is connected to each other. try to really think what the best one is
> for this scneario and what is some information worth sharing this is lower prioity so focus on
> the other one. but for hte bubble it is defining feature is the morphsim. i just want to ensure
> that ht text behind it is not blurry and readable espcailly at differnet scales

Interpretation: (1) CONNECTIONS BOX RESCOPE (lower priority): on selection it must NOT show
"strongest ties" — that is the threads widget's job. It becomes the individual's EGO-STATS panel:
traditional knowledge-graph stats about who they are and how many people share each trait
(e.g. "1 of 14 from USC · 1 of 9 building-in-public · shares 3 conviction tags with 41 people"),
chosen to make "how everyone is connected" legible; leads think hard about the best stat set.
(2) BUBBLE GLASS RULING (priority): the morphism IS the bubble's identity — it stays (resolves the
open glass question: do NOT neutralize the shader). The requirement is that text seen THROUGH the
glass is not blurry and stays readable, especially across different scales (magnification + the
Addendum-5 scale controls) — refraction may bend, it must not smear. — CONFIRMED BY QUOTE.
