/**
 * Small shared visual atoms: the status dot, the topic badge, the header count
 * chips, the marker chips and the verification exit chip. State is never
 * color-only — every dot and tone is paired with its Chinese label in the same
 * element group.
 */
import type { ReactElement } from 'react'
import type { PanelCounts, PanelReviewStatus, PanelTopicStatus } from '../api-contract.ts'
import {
  reviewBadgeTitle,
  reviewStatusLabel,
  reviewStatusTone,
  statusChips,
  statusLabel,
  statusTone,
  verificationExitLabel,
  verificationTone,
  type StatusTone,
  type TopicMarker,
} from './model.ts'

/** One status dot; decorative, the label beside it carries the meaning. */
export function StatusDot({ tone }: { readonly tone: StatusTone }): ReactElement {
  return <span className="cw-dot" data-tone={tone} aria-hidden="true" />
}

/** Dot + state label, the unit the list rows and the detail badge use. */
export function StatusBadge({ status }: { readonly status: PanelTopicStatus }): ReactElement {
  return (
    <span className="cw-badge">
      <StatusDot tone={statusTone(status)} />
      <span className="cw-status-text">{statusLabel(status)}</span>
    </span>
  )
}

/** Header chips: current topic-state and marker counts. */
export function StatusChips({ counts }: { readonly counts: PanelCounts }): ReactElement {
  return (
    <div className="cw-chips" role="group" aria-label="主题状态计数">
      {statusChips(counts).map(chip => (
        <span key={chip.key} className="cw-chip" data-zero={chip.count === 0 ? 'true' : 'false'}>
          <StatusDot tone={chip.tone} />
          <span className="cw-chip-label">{chip.label}</span>
          <span className="cw-chip-count">{chip.count}</span>
        </span>
      ))}
    </div>
  )
}

/** The blocked / awaiting-review marker chips of one topic row. */
export function MarkerChips({ markers }: { readonly markers: readonly TopicMarker[] }): ReactElement | null {
  if (markers.length === 0) return null
  return (
    <span className="cw-markers">
      {markers.map(marker => (
        <span key={marker.label} className="cw-marker" data-tone={marker.tone}>{marker.label}</span>
      ))}
    </span>
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

/**
 * Review state badge: the Chinese label is always visible (`审查中 / 审查通过 /
 * 需修改 / 已拒绝`), so the state never depends on color alone. The title adds
 * the absolute review time and the finding count.
 */
export function ReviewBadge({
  status,
  reviewedAt,
  findingCount = 0,
}: {
  readonly status: PanelReviewStatus
  readonly reviewedAt: string | null
  readonly findingCount?: number
}): ReactElement {
  return (
    <span
      className="cw-review-badge"
      data-review-status={status}
      data-tone={reviewStatusTone(status)}
      title={reviewBadgeTitle(status, reviewedAt, findingCount)}
    >
      {reviewStatusLabel(status)}
    </span>
  )
}
