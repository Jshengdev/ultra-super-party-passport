import type { ComponentType } from 'react'
import { TitleSlide } from './TitleSlide'
import { ProblemSlide } from './ProblemSlide'
import { SolutionSlide } from './SolutionSlide'
import { UseCasesSlide } from './UseCasesSlide'
import { StackSlide } from './StackSlide'

export interface SlideDef {
  id: string
  Component: ComponentType
}

/** The deck, in order. Append new slides here as content arrives. */
export const SLIDES: SlideDef[] = [
  { id: 'title', Component: TitleSlide },
  { id: 'problem', Component: ProblemSlide },
  { id: 'solution', Component: SolutionSlide },
  { id: 'uses', Component: UseCasesSlide },
  { id: 'stack', Component: StackSlide },
]
