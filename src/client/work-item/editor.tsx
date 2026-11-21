/**
 * CodeMirror 6 source editor for the work-item viewer.
 *
 * The editor is a controlled field: `value` is the only source of truth and
 * every user change is reported through `onChange`. The document is replaced
 * only when the incoming value differs from the editor state, so a save
 * response or a model refresh cannot move the cursor on an unchanged draft.
 *
 * Anchored (unresolved) comment lines are marked through a compartment: the
 * decoration set is rebuilt when the list of lines changes and mapped through
 * document changes, so a shifted line keeps its marker.
 */
import { Compartment, EditorState, StateField, Transaction, type Range, type Text } from '@codemirror/state'
import { EditorView, Decoration, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

/** One anchored line marker; the class is styled by `styles.ts`. */
const anchoredLineDecoration = Decoration.line({ class: 'cwi-editor-anchored' })

/**
 * Build the line decorations for one document.
 *
 * Lines outside the document and empty line lists are dropped rather than
 * clamped: an anchor whose line disappeared should not move to a neighbour.
 */
function anchoredDecorations(lines: readonly number[], doc: Text): DecorationSet {
  const ranges: Range<Decoration>[] = []
  for (const lineNumber of lines) {
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || lineNumber > doc.lines) continue
    ranges.push(anchoredLineDecoration.range(doc.line(lineNumber).from))
  }
  return Decoration.set(ranges, true)
}

/**
 * Line markers that follow their text while the user types.
 *
 * A reconfigured field rebuilds from the server's line numbers after a save or
 * comment update; between those points each edit maps the markers through its
 * changes, so inserting a line above an annotated one does not move the marker
 * onto an unrelated neighbour.
 */
function anchoredLineMarkers(lines: readonly number[]) {
  return StateField.define<DecorationSet>({
    create: state => anchoredDecorations(lines, state.doc),
    update: (decorations, transaction) => {
      if (!transaction.docChanged) return decorations
      // Map first so a marker follows its text, then re-anchor it to a line
      // start: mapping can land on the position after an inserted character at
      // the line start, and a merged line drops the marker.
      const mapped = decorations.map(transaction.changes)
      const ranges: Range<Decoration>[] = []
      mapped.between(0, transaction.state.doc.length, (from) => {
        ranges.push(anchoredLineDecoration.range(transaction.state.doc.lineAt(from).from))
      })
      return Decoration.set(ranges, true)
    },
    provide: field => EditorView.decorations.from(field),
  })
}

/** One text editor; the caller owns the draft and the save schedule. */
export interface TextEditorProps {
  /** Current document text; external changes replace the editor document. */
  readonly value: string
  /** Called on every user edit with the whole new document. */
  readonly onChange: (value: string) => void
  /** Called when the editor loses focus (the viewer flushes dirty drafts). */
  readonly onBlur?: (() => void) | undefined
  /** Accessible name for the editing surface. */
  readonly ariaLabel: string
  /** Unresolved comment lines to mark; line numbers are 1-based. */
  readonly anchoredLines: readonly number[]
  /**
   * True when `anchoredLines` addresses the editor document (the draft is
   * clean). A dirty draft has its own line numbers, so server anchors only
   * apply again after a save or "load latest".
   */
  readonly anchorsAuthoritative: boolean
}

/** The controlled CodeMirror editor used by the work-item viewer. */
export function TextEditor({
  value,
  onChange,
  onBlur,
  ariaLabel,
  anchoredLines,
  anchorsAuthoritative,
}: TextEditorProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const onBlurRef = useRef(onBlur)
  const anchoredLinesRef = useRef(anchoredLines)
  const anchorsAuthoritativeRef = useRef(anchorsAuthoritative)
  const [anchoredCompartment] = useState(() => new Compartment())

  valueRef.current = value
  onChangeRef.current = onChange
  onBlurRef.current = onBlur
  anchoredLinesRef.current = anchoredLines
  anchorsAuthoritativeRef.current = anchorsAuthoritative

  // The view is created once; props flow through refs so a parent render never
  // destroys the editor state (history, selection) mid-edit.
  useEffect(() => {
    const parent = hostRef.current
    if (parent === null) return
    let disposed = false
    const state = EditorState.create({
      doc: valueRef.current,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        anchoredCompartment.of(anchoredLineMarkers([])),
        EditorView.contentAttributes.of({
          'aria-label': ariaLabel,
          'aria-multiline': 'true',
          'data-testid': 'cwi-editor',
          spellcheck: 'false',
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
        EditorView.domEventHandlers({
          blur: () => { if (!disposed) onBlurRef.current?.() },
        }),
      ],
    })
    const view = new EditorView({ state, parent })
    viewRef.current = view
    return () => {
      // A blur while the host is being removed must not schedule a second save
      // next to the explicit "exit edit" flush.
      disposed = true
      view.destroy()
      viewRef.current = null
    }
    // The editor is intentionally created once; the accessible name is a
    // session constant, not a value that changes mid-edit.
  }, [])

  // A server-side change (model merge, "load latest") replaces the document;
  // an identical value is a no-op so typing never resets the cursor.
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const current = view.state.doc.toString()
    if (current === value) return
    // The replacement is an external fact, not a user edit; keeping it out
    // of the undo history prevents an undo from restoring stale server text.
    // Mapping cannot preserve markers across a whole-document replacement, so
    // rebuild them from the current anchors in the same transaction.
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: Transaction.addToHistory.of(false),
      effects: anchoredCompartment.reconfigure(
        anchoredLineMarkers(anchorsAuthoritativeRef.current ? anchoredLinesRef.current : []),
      ),
    })
  }, [value])

  // Anchors change when a comment arrives or is resolved; rebuild the markers
  // without touching the document or the cursor. A dirty draft has shifted
  // lines, so server line numbers are applied only when they address the
  // document (clean draft or just-saved content).
  const anchoredKey = anchoredLines.join(',')
  useEffect(() => {
    if (!anchorsAuthoritative) return
    const view = viewRef.current
    if (view === null) return
    view.dispatch({
      effects: anchoredCompartment.reconfigure(anchoredLineMarkers(anchoredLines)),
    })
  }, [anchoredKey, anchorsAuthoritative])

  return <div className="cwi-editor-host" data-testid="cwi-editor-host" ref={hostRef} />
}
