/**
 * CodeMirror 6 source editor for the work-item viewer.
 *
 * The editor is a controlled field: `value` is the only source of truth and
 * every user change is reported through `onChange`. The document is replaced
 * only when the incoming value differs from the editor state, so a save
 * response or a model refresh cannot move the cursor on an unchanged draft.
 *
 * Anchored (unresolved) comment lines are marked through a compartment: the
 * decoration set is rebuilt when the list of lines changes and re-derived on
 * every document change, so a shifted line keeps its marker.
 */
import { Compartment, EditorState, Transaction, type Range } from '@codemirror/state'
import { EditorView, ViewPlugin, Decoration, keymap, lineNumbers, type DecorationSet, type ViewUpdate } from '@codemirror/view'
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
function anchoredDecorations(lines: readonly number[], lineCount: number, lineStart: (line: number) => number): DecorationSet {
  const ranges: Range<Decoration>[] = []
  for (const lineNumber of lines) {
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || lineNumber > lineCount) continue
    ranges.push(anchoredLineDecoration.range(lineStart(lineNumber)))
  }
  return Decoration.set(ranges, true)
}

/** A view plugin that keeps anchored markers in sync with its line list. */
function anchoredLineMarkers(lines: readonly number[]) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = anchoredDecorations(lines, view.state.doc.lines, line => view.state.doc.line(line).from)
    }

    update(update: ViewUpdate): void {
      if (!update.docChanged && !update.viewportChanged) return
      this.decorations = anchoredDecorations(lines, update.state.doc.lines, line => update.state.doc.line(line).from)
    }
  }, {
    decorations: plugin => plugin.decorations,
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
}

/** The controlled CodeMirror editor used by the work-item viewer. */
export function TextEditor({
  value,
  onChange,
  onBlur,
  ariaLabel,
  anchoredLines,
}: TextEditorProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const onBlurRef = useRef(onBlur)
  const [anchoredCompartment] = useState(() => new Compartment())

  valueRef.current = value
  onChangeRef.current = onChange
  onBlurRef.current = onBlur

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
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: Transaction.addToHistory.of(false),
    })
  }, [value])

  // Anchors change when a comment arrives or is resolved; rebuild the markers
  // without touching the document or the cursor.
  const anchoredKey = anchoredLines.join(',')
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    view.dispatch({
      effects: anchoredCompartment.reconfigure(anchoredLineMarkers(anchoredLines)),
    })
  }, [anchoredKey])

  return <div className="cwi-editor-host" data-testid="cwi-editor-host" ref={hostRef} />
}
