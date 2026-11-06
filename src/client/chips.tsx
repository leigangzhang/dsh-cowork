/**
 * Small shared visual atoms: the status dot, its label, the header count chips
 * and the verification exit chip. Status is never color-only — every dot is
 * paired with its Chinese label in the same element group.
 */
import type { ReactElement } from 'react'
import type { PanelCounts, PanelThreadStatus } from '../api-contract.ts'
import {
  statusChips,
  statusLabel,
  statusTone,
  verificationExitLabel,
  verificationTone,
  type StatusTone,
} from './model.ts'

/** One status dot; decorative, the label beside it carries the meaning. */
export function StatusDot({ tone }: { readonly tone: StatusTone }): ReactElement {
  return <span className="cw-dot" data-tone={tone} aria-hidden="true" />
}

/** The visible Chinese status text. */
export function StatusLabel({ status }: { readonly status: PanelThreadStatus }): ReactElement {
  return <span className="cw-status-text">{statusLabel(status)}</span>
}

/** Dot + label, the unit the list rows and the detail badge use. */
export function StatusBadge({ status }: { readonly status: PanelThreadStatus }): ReactElement {
  return (
    <span className="cw-badge">
      <StatusDot tone={statusTone(status)} />
      <StatusLabel status={status} />
    </span>
  )
}

/** Header chips: current per-status thread counts. */
export function StatusChips({ counts }: { readonly counts: PanelCounts }): ReactElement {
  return (
    <div className="cw-chips" role="group" aria-label="Thread 状态计数">
      {statusChips(counts).map(chip => (
        <span key={chip.status} className="cw-chip" data-zero={chip.count === 0 ? 'true' : 'false'}>
          <StatusDot tone={statusTone(chip.status)} />
          <span className="cw-chip-label">{chip.label}</span>
          <span className="cw-chip-count">{chip.count}</span>
        </span>
      ))}
    </div>
  )
}

/** Verification exit code chip; the `exit N` text carries the meaning. */
export function ExitChip({ exitCode }: { readonly exitCode: number }): ReactElement {
  return (
    <span className="cw-exit" data-tone={verificationTone(exitCode)}>
      {verificationExitLabel(exitCode)}
    </span>
  )
}
