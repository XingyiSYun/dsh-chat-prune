/**
 * dsh-chat-prune — Host half.
 *
 * Hides one finished chat turn of a live Session from the model, so that no
 * later request carries what the user sent by mistake.
 *
 * The session log is append-only (and zstd-framed on disk), so this cannot
 * rewrite history. Instead it appends a single surface REPLACEMENT —
 * `surfaceOp: { op: 'replace', startSeq, endSeq }` — that shadows the turn's
 * model-visible nodes with one empty `developer/message`. An empty
 * system/developer node projects to no model message, so the model sees nothing
 * at all while the record itself stays in the log.
 *
 * The Chat transcript is projected from append order, not from the folded
 * surface, so the rows keep rendering what was sent; the browser half renders
 * an "already removed" marker in that turn's footer instead. The Trajectory
 * ledger keeps the original events too. Replacement is the only removal
 * mechanism the Session surface offers: "compaction hides superseded entries
 * from the active conversation without deleting them".
 */

/** Largest accepted request body, in bytes. */
const BODY_LIMIT = 64 * 1024
/** Browser route that prunes one turn. */
const PRUNE_PATH = '/chat-prune/prune'
/** Browser route that reports whether one turn is already pruned. */
const STATE_PATH = '/chat-prune/turn'
/** Source kind stamped on every replacement this plugin appends. */
const PRUNE_SOURCE = 'chat-prune'

/** Hard dependencies: the browser carrier and the session store. */
export const inject = ['webServer', 'sessions']

/**
 * Register the browser routes for this plugin.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.effect(function* registerRoutes() {
    yield ctx.webServer.register({
      kind: 'exact',
      path: PRUNE_PATH,
      handler: (req, res) => settle(res, () => pruneRoute(ctx, req, res)),
    })
    yield ctx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: (req, res) => settle(res, () => turnStateRoute(ctx, req, res)),
    })
  })
}

/**
 * Run one route body and answer with a JSON failure when it throws.
 * @param res - the server response.
 * @param run - the route body.
 * @returns a promise resolved once the response finished.
 */
async function settle(res, run) {
  try {
    await run()
  } catch (error) {
    if (res.writableEnded) return
    writeJson(res, 500, { ok: false, error: 'internal', message: messageOf(error) })
  }
}

/**
 * Read a human-readable message from an unknown thrown value.
 * @param error - the thrown value.
 * @returns its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Write one JSON response.
 * @param res - the server response.
 * @param status - the HTTP status code.
 * @param body - the JSON-serializable body.
 */
function writeJson(res, status, body) {
  if (res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Read and parse a JSON request body.
 * @param req - the incoming message.
 * @returns the parsed body, or an empty object.
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/u, '')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/**
 * Fold a session log into its current model-visible surface node sequences.
 *
 * This mirrors the documented surface contract: an `append` op adds one node,
 * and a `replace` op swaps the inclusive node range `[startSeq, endSeq]` for
 * the single node belonging to the replacing event.
 * @param events - the session events in log order.
 * @returns the surface node sequences in model-visible order.
 */
function surfaceNodes(events) {
  const nodes = []
  for (const event of events) {
    const op = event.surfaceOp
    if (op === undefined) continue
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (op === null || typeof op !== 'object' || op.op !== 'replace') continue
    const startIndex = nodes.indexOf(op.startSeq)
    const endIndex = nodes.indexOf(op.endSeq)
    if (startIndex < 0 || endIndex < startIndex) continue
    nodes.splice(startIndex, endIndex - startIndex + 1, event.seq)
  }
  return nodes
}

/**
 * Resolve the turn that owns one sequence and plan its removal.
 * @param session - the live session.
 * @param atSeq - a sequence inside the turn, or undefined for the last event.
 * @returns the plan, or a failure describing why nothing can be removed.
 */
function planPrune(session, atSeq) {
  const events = session.snapshotEvents()
  if (events.length === 0) return { ok: false, error: 'empty-session' }
  const turn = turnAt(events, atSeq)
  if (turn === undefined) return { ok: false, error: 'no-turn' }
  if (isPruned(events, turn)) return { ok: false, error: 'already-pruned' }

  let startSeq
  let nextStart = Number.POSITIVE_INFINITY
  let closed = false
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (startSeq === undefined) {
        if (event.data?.turn === turn) startSeq = event.seq
        continue
      }
      nextStart = event.seq
      break
    }
    if (event.type === 'turn/end' && startSeq !== undefined && event.data?.turn === turn) closed = true
  }
  if (startSeq === undefined) return { ok: false, error: 'no-turn' }
  if (!closed) return { ok: false, error: 'turn-open' }

  let step = 1
  for (const event of events) {
    if (event.seq < startSeq) continue
    if (event.seq >= nextStart) break
    const value = event.data?.step
    if (Number.isSafeInteger(value) && value > step) step = value
  }

  const nodes = surfaceNodes(events)
  let shadowed = nodes.filter((seq) => seq >= startSeq && seq < nextStart)
  // The surface lets node 0 — the system prompt — be rewritten only by a
  // system/message over exactly that node, so a replacement keeps it out of the
  // removed range and leaves it standing.
  while (shadowed.length > 0 && nodes.indexOf(shadowed[0]) === 0 && typeOf(events, shadowed[0]) === 'system/message') {
    shadowed = shadowed.slice(1)
  }
  if (shadowed.length === 0) return { ok: false, error: 'already-pruned' }

  return {
    ok: true,
    turn,
    step,
    startSeq: shadowed[0],
    endSeq: shadowed[shadowed.length - 1],
    shadowed,
  }
}

/**
 * Resolve the turn that owns one sequence.
 * @param events - the session events in log order.
 * @param atSeq - a sequence inside the turn, or undefined for the last event.
 * @returns the turn number, or undefined when the log holds no turn.
 */
function turnAt(events, atSeq) {
  if (events.length === 0) return undefined
  const tail = events.length - 1
  const from = Number.isSafeInteger(atSeq) ? Math.max(0, Math.min(atSeq, tail)) : tail
  return resolveTurn(events, from)
}

/**
 * Whether one turn already carries this plugin's replacement.
 * @param events - the session events in log order.
 * @param turn - the turn to inspect.
 * @returns true when this turn is already hidden from the model.
 */
function isPruned(events, turn) {
  return events.some(
    (event) =>
      event.type === 'developer/message' &&
      event.data?.turn === turn &&
      event.data?.message?.source?.kind === PRUNE_SOURCE,
  )
}

/**
 * Read the event type committed at one sequence.
 * @param events - the session events in log order.
 * @param seq - the sequence to look up.
 * @returns the event type, or undefined when the sequence holds no event.
 */
function typeOf(events, seq) {
  return events[seq]?.type
}

/**
 * Find the turn number that owns one sequence position.
 * @param events - the session events in log order.
 * @param from - the index the client pointed at.
 * @returns the turn number, or undefined when the log holds no turn.
 */
function resolveTurn(events, from) {
  for (let index = from; index < events.length; index += 1) {
    const event = events[index]
    if (event.type !== 'turn/start' && event.type !== 'turn/end') continue
    const turn = event.data?.turn
    if (Number.isSafeInteger(turn)) return turn
  }
  for (let index = from; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'turn/start') continue
    const turn = event.data?.turn
    if (Number.isSafeInteger(turn)) return turn
  }
  return undefined
}

/**
 * Append the replacement that removes one planned turn from the surface.
 * @param session - the live session.
 * @param plan - the plan from {@link planPrune}.
 * @returns the sequence of the committed replacement event.
 */
function commitPrune(session, plan) {
  session.append(
    'developer/message',
    {
      turn: plan.turn,
      step: plan.step,
      message: {
        id: `chat-prune-${plan.turn}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        role: 'developer',
        source: { kind: PRUNE_SOURCE },
        content: [],
      },
    },
    {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      sourceEventSeqs: plan.shadowed,
    },
  )
  return session.seq - 1
}

/**
 * Delete one turn of one live session.
 * @param session - the live session.
 * @param atSeq - a sequence inside the turn.
 * @param dryRun - plan only, do not commit.
 * @returns the outcome as a JSON body.
 */
function pruneTurn(session, atSeq, dryRun) {
  const plan = planPrune(session, atSeq)
  if (!plan.ok) return plan
  const summary = {
    ok: true,
    turn: plan.turn,
    from: plan.startSeq,
    to: plan.endSeq,
    removed: plan.shadowed.length,
  }
  if (dryRun) return { ...summary, dryRun: true }
  const seq = commitPrune(session, plan)
  return { ...summary, seq, remaining: session.deriveMessages().length }
}

/**
 * Look up the live session named by one request body.
 * @param ctx - the plugin context.
 * @param body - the parsed request body.
 * @returns either `{ session }` or `{ failure }` with the answer to send.
 */
function requireSession(ctx, body) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (sessionId === '') return { failure: { status: 400, body: { ok: false, error: 'missing-session' } } }
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) return { failure: { status: 409, body: { ok: false, error: 'session-not-live' } } }
  return { session }
}

/**
 * `POST /chat-prune/prune` — body `{ sessionId, seq?, dryRun? }`.
 * @param ctx - the plugin context.
 * @param req - the incoming message.
 * @param res - the server response.
 */
async function pruneRoute(ctx, req, res) {
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  const body = await readJson(req)
  const lookup = requireSession(ctx, body)
  if (lookup.failure !== undefined) {
    writeJson(res, lookup.failure.status, lookup.failure.body)
    return
  }
  const result = pruneTurn(lookup.session, body.seq, body.dryRun === true)
  if (!result.ok) {
    writeJson(res, 409, result)
    return
  }
  if (result.dryRun !== true) await ctx.sessions.flush(lookup.session)
  writeJson(res, 200, result)
}

/**
 * `GET /chat-prune/turn?sessionId=&seq=` — reports whether the turn that owns
 * one sequence is already hidden from the model. A read-only GET: a state
 * probe can never change the session.
 * @param ctx - the plugin context.
 * @param req - the incoming message.
 * @param res - the server response.
 */
async function turnStateRoute(ctx, req, res) {
  if (req.method !== 'GET') {
    writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams
  const seq = Number(query.get('seq'))
  const body = { sessionId: query.get('sessionId') ?? '', seq: Number.isSafeInteger(seq) ? seq : undefined }
  const lookup = requireSession(ctx, body)
  if (lookup.failure !== undefined) {
    writeJson(res, lookup.failure.status, lookup.failure.body)
    return
  }
  const events = lookup.session.snapshotEvents()
  const turn = turnAt(events, body.seq)
  if (turn === undefined) {
    writeJson(res, 200, { ok: true, turn: null, pruned: false })
    return
  }
  writeJson(res, 200, { ok: true, turn, pruned: isPruned(events, turn) })
}
