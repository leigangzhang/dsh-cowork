import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANNOTATION_MARKER,
  COPIED_LABEL,
  COPY_LABEL,
  annotationDisplay,
  annotationFoldReducer,
  annotationNodeIds,
  bindAnnotationNode,
  formatMessageClock,
  messageContentParts,
  parseAnnotationText,
} from '../../src/client/annotation-model.ts'
import {
  ANNOTATION_MARKER as PLATFORM_MARKER,
  parseAnnotationText as parsePlatformAnnotationText,
} from '../../src/platform/annotation-prompt.ts'

/**
 * The renderer's pure layer: delivery recognition and parsing, message-content
 * extraction, stable ARIA ids, the fold reducer, and the slot-registration seam.
 * The DOM behaviour (click/Enter/Space/Esc, ARIA wiring) is exercised by the
 * browser lane; this suite proves the decisions those handlers consume.
 */
const MARKER = '\uE000cowork-annotation/v1\uE001'

/** One delivered message in the wire format. */
function delivery({ summary = '处理工作项「Spec」的 1 条批注', body = 'Work item: artifact-1' } = {}) {
  return [MARKER, summary, '', body].join('\n')
}

test('the browser marker is the exact documented sentinel', () => {
  assert.equal(ANNOTATION_MARKER, '\uE000cowork-annotation/v1\uE001')
  assert.equal(MARKER, ANNOTATION_MARKER)
  // One declaration per half (the client cannot import the platform module);
  // this equality is what keeps them from drifting.
  assert.equal(ANNOTATION_MARKER, PLATFORM_MARKER)
})

test('parseAnnotationText recognizes only a first-line marker', () => {
  assert.deepEqual(parseAnnotationText(delivery()), {
    summary: '处理工作项「Spec」的 1 条批注',
    body: 'Work item: artifact-1',
  })
  assert.equal(parseAnnotationText('帮我看下 hero 区块的文案'), null)
  assert.equal(parseAnnotationText(''), null)
  assert.equal(parseAnnotationText(MARKER), null)
  assert.equal(parseAnnotationText(`x${MARKER}\n摘要`), null)
  assert.equal(parseAnnotationText(`${MARKER}\r\n摘要`), null)
  assert.equal(parseAnnotationText(undefined), null)
  assert.equal(parseAnnotationText(null), null)
  assert.equal(parseAnnotationText(42), null)
})

test('parseAnnotationText falls back to the row title instead of throwing', () => {
  assert.deepEqual(parseAnnotationText(`${MARKER}\n\n\nWork item: artifact-1`), {
    summary: '批注投递',
    body: 'Work item: artifact-1',
  })
  assert.deepEqual(parseAnnotationText(`${MARKER}\n   \n\nbody line`), {
    summary: '批注投递',
    body: 'body line',
  })
  assert.deepEqual(parseAnnotationText(`${MARKER}\n`), { summary: '批注投递', body: '批注投递' })
  assert.deepEqual(parseAnnotationText(`${MARKER}\n摘要\n\n\n`), { summary: '摘要', body: '批注投递' })
  assert.doesNotThrow(() => parseAnnotationText(`${MARKER}\n\u0000\n\n\u0000`))
})

test('the browser parser matches the platform parser on every boundary', () => {
  const cases = [
    delivery(),
    delivery({ summary: '' }),
    delivery({ body: '' }),
    'ordinary user message',
    '',
    `${MARKER}\r\n摘要`,
    `${MARKER}\n`,
    undefined,
    null,
    0,
    {},
  ]
  for (const text of cases) {
    assert.deepEqual(parseAnnotationText(text), parsePlatformAnnotationText(text), JSON.stringify(text))
  }
})

test('messageContentParts mirrors the host split of text, attachments, and unknown blocks', () => {
  const image = { attachmentId: 'image-1' }
  const file = { attachmentId: 'file-1' }
  const parts = messageContentParts([
    { type: 'text', text: '描' },
    { type: 'text', text: '述' },
    { type: 'image', attachment: image },
    { type: 'file', attachment: file },
    { type: 'mystery-block', payload: 1 },
    'plain string block',
    null,
  ])
  assert.equal(parts.text, '描述plain string block')
  assert.deepEqual(parts.attachments, [
    { type: 'image', image: { attachment: image } },
    { type: 'file', file },
  ])
  assert.deepEqual(parts.extraBlocks, [{ type: 'mystery-block', payload: 1 }, null])
})

test('messageContentParts tolerates strings and unknown values without throwing', () => {
  assert.deepEqual(messageContentParts('hi'), { text: 'hi', attachments: [], extraBlocks: [] })
  assert.deepEqual(messageContentParts({ type: 'text', text: 'single' }), {
    text: 'single', attachments: [], extraBlocks: [],
  })
  assert.deepEqual(messageContentParts(null), { text: '', attachments: [], extraBlocks: [] })
  assert.deepEqual(messageContentParts(undefined), { text: '', attachments: [], extraBlocks: [] })
  assert.deepEqual(messageContentParts({ type: 'image', attachment: {} }), {
    text: '', attachments: [], extraBlocks: [{ type: 'image', attachment: {} }],
  })
  assert.doesNotThrow(() => messageContentParts([{}, 7, true]))
})

test('annotationDisplay folds a delivery and never exposes the marker', () => {
  const display = annotationDisplay(delivery({ summary: '处理工作项「Spec」的 2 条批注', body: 'Work item: artifact-9' }))
  assert.ok(display)
  assert.equal(display.title, '批注投递')
  assert.equal(display.summary, '处理工作项「Spec」的 2 条批注')
  assert.equal(display.body, 'Work item: artifact-9')
  for (const value of [display.title, display.summary, display.body]) {
    assert.equal(value.includes('\uE000'), false)
    assert.equal(value.includes('\uE001'), false)
    assert.equal(value.includes('cowork-annotation/v1'), false)
  }
  // The real host content shape is an array of blocks, not one string.
  assert.deepEqual(annotationDisplay([
    { type: 'text', text: `${MARKER}\n摘要\n\n正文` },
  ]), { title: '批注投递', summary: '摘要', body: '正文' })
})

test('annotationDisplay returns null for ordinary messages', () => {
  assert.equal(annotationDisplay([{ type: 'text', text: '普通消息' }]), null)
  assert.equal(annotationDisplay([{ type: 'image', attachment: {} }]), null)
  assert.equal(annotationDisplay(undefined), null)
  assert.equal(annotationDisplay('普通消息'), null)
})

test('annotationNodeIds derive stable, unique, id-safe pairs', () => {
  const first = annotationNodeIds({ messageId: 'msg-1' })
  assert.deepEqual(first, annotationNodeIds({ messageId: 'msg-1' }))
  const second = annotationNodeIds({ messageId: 'msg-2' })
  assert.notDeepEqual(first, second)
  assert.notEqual(first.triggerId, first.bodyId)
  assert.match(first.triggerId, /^cw-annotation-trigger-msg-1$/)
  assert.match(first.bodyId, /^cw-annotation-body-msg-1$/)

  const unsafe = annotationNodeIds({ messageId: 'msg/1 x' })
  assert.equal(unsafe.triggerId, 'cw-annotation-trigger-msg-1-x')
  assert.match(unsafe.triggerId, /^[A-Za-z0-9_-]+$/)

  assert.equal(annotationNodeIds({ seq: 12 }).bodyId, 'cw-annotation-body-seq-12')
  assert.equal(annotationNodeIds({}).bodyId, 'cw-annotation-body-message')
  assert.equal(annotationNodeIds(undefined).triggerId, 'cw-annotation-trigger-message')
})

test('the fold reducer starts collapsed and handles toggle and escape', () => {
  assert.equal(annotationFoldReducer(false, 'toggle'), true)
  assert.equal(annotationFoldReducer(true, 'toggle'), false)
  assert.equal(annotationFoldReducer(true, 'escape'), false)
  assert.equal(annotationFoldReducer(false, 'escape'), false)
})

test('formatMessageClock renders a local HH:mm and rejects unusable values', () => {
  const nineOhFive = new Date(2026, 0, 2, 9, 5, 0, 0)
  assert.equal(formatMessageClock(nineOhFive.getTime()), '09:05')
  assert.equal(formatMessageClock(new Date(2026, 0, 2, 23, 59).getTime()), '23:59')
  assert.equal(formatMessageClock(undefined), null)
  assert.equal(formatMessageClock(Number.NaN), null)
  assert.equal(formatMessageClock(Number.POSITIVE_INFINITY), null)
  assert.equal(formatMessageClock('2026-01-02'), null)
})

test('the copy affordance has fixed labels', () => {
  assert.equal(COPY_LABEL, '复制')
  assert.equal(COPIED_LABEL, '已复制')
})

/**
 * A slot-service double: the declaration already exists, so `inject` runs its
 * callback immediately, and both the injection and the registration have
 * independently observable disposers.
 */
function fakeSlots({ registerThrows = false } = {}) {
  const state = { injected: [], registrations: [], injectDisposed: 0, registeredDisposed: 0 }
  const slots = {
    inject(name, callback) {
      state.injected.push({ name })
      const inner = callback()
      return () => {
        state.injectDisposed += 1
        if (typeof inner === 'function') inner()
      }
    },
    register(options, component) {
      if (registerThrows) throw new Error('declaration rejected')
      const entry = { options, component, disposed: false }
      state.registrations.push(entry)
      return () => {
        entry.disposed = true
        state.registeredDisposed += 1
      }
    },
  }
  return { slots, state }
}

/** A placeholder component; the seat only needs a renderable reference. */
function View() {
  return null
}

test('the renderer registers under conversation.chat.node key user with a disposer', () => {
  const { slots, state } = fakeSlots()
  const dispose = bindAnnotationNode(slots, View)

  assert.equal(state.injected.length, 1)
  assert.equal(state.injected[0].name, 'conversation.chat.node')
  assert.equal(state.registrations.length, 1)
  const [{ options, component }] = state.registrations
  assert.equal(options.name, 'conversation.chat.node')
  assert.equal(options.key, 'user')
  // The host occupies the cell at priority 0; a lower rank shadows it regardless
  // of registration order (the browser lane rejected a same-priority duplicate).
  assert.equal(options.priority, -1)
  assert.deepEqual(options.children, {
    'conversation.chat.user.before': { kind: 'chain', scope: 'session' },
  })
  assert.equal(component, View)

  dispose()
  assert.equal(state.injectDisposed, 1)
  assert.equal(state.registeredDisposed, 1)
  assert.equal(state.registrations[0].disposed, true)
})

test('the registration waits for the slot declaration instead of racing it', () => {
  let callback
  const registrations = []
  const slots = {
    inject(name, received) {
      assert.equal(name, 'conversation.chat.node')
      callback = received
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
  const dispose = bindAnnotationNode(slots, View)
  assert.equal(registrations.length, 0)

  callback()
  assert.equal(registrations.length, 1)
  dispose()
})

test('a host without the slot capability degrades to a no-op disposer', () => {
  const unusable = [
    undefined,
    null,
    {},
    { inject() {} },
    { register() {} },
    { inject: 'not a function', register() {} },
  ]
  for (const slots of unusable) {
    let dispose
    assert.doesNotThrow(() => { dispose = bindAnnotationNode(slots, View) })
    assert.equal(typeof dispose, 'function')
    assert.doesNotThrow(() => dispose())
  }
})

test('an injection without a disposer still returns a callable no-op', () => {
  const slots = {
    inject() {
      return undefined
    },
    register() {
      return () => {}
    },
  }
  const dispose = bindAnnotationNode(slots, View)
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})

test('a rejected registration is reported through the injected logger', () => {
  const warnings = []
  const { slots } = fakeSlots({ registerThrows: true })
  const dispose = bindAnnotationNode(slots, View, { warn: (message) => { warnings.push(message) } })

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /keeping the host user renderer/)
  assert.match(warnings[0], /declaration rejected/)
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})

test('a rejected registration without a logger still degrades silently', () => {
  const { slots } = fakeSlots({ registerThrows: true })
  let dispose
  assert.doesNotThrow(() => { dispose = bindAnnotationNode(slots, View) })
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})
