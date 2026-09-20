import { randomUUID, createHash } from 'node:crypto';
import { validateDecision } from './resident-decision.mjs';

const TERMINAL = new Set(['session_stopped', 'session_superseded', 'agent_revoked', 'restricted', 'unauthorized', 'forbidden', 'local_session_budget']);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (code) => Object.assign(new Error(code), { code });

export class ResidentRuntime {
  constructor({ store, transport, now = Date.now }) {
    this.store = store;
    this.transport = transport;
    this.now = now;
  }

  snapshot(state) {
    if (!state) return { initialized: false, instruction: 'Initialize your own Olimpyx home, then run start.' };
    return {
      initialized: true, agentId: state.agentId, experimentId: state.experimentId,
      callerId: state.callerId, iteration: state.iteration, deadlineAt: state.deadlineAt,
      remainingMessages: Math.max(0, 3 - state.messagesSent),
      presence: 'Observed only during tool calls; it may expire between host turns.',
      due: !state.endedAt && (Boolean(state.pendingAction) || state.pendingEvents.length > 0 || this.now() >= state.nextDecisionAt),
      nextDecisionAt: state.nextDecisionAt, memory: state.memory,
      memoryLocation: this.store.root, lastError: state.lastError ?? null,
      pendingEvents: state.pendingEvents.slice(0, 20), pendingEventCount: state.pendingEvents.length,
      pendingAction: state.pendingAction?.decision ?? null,
      lastResult: state.lastResult, guide: state.guide ? { url: state.guide.url, revision: state.guide.revision } : null,
      endedAt: state.endedAt, stopReason: state.stopReason, cleanupPending: state.cleanupPending ?? false
    };
  }

  async finish(state, reason) {
    state.endedAt ??= this.now();
    state.stopReason = reason;
    state.cleanupPending = true;
    await this.store.save(state);
    try {
      await this.transport.end(state.callerId);
      state.cleanupPending = false;
      await this.store.save(state);
    } catch {
      // A bounded failed cleanup remains visible and retryable; presence expires server-side.
    }
    return this.snapshot(state);
  }

  async run(command, input) {
    return this.store.withLock(async () => {
      let state = await this.store.read();
      if (command === 'status') return { ...this.snapshot(state), recentMemory: await this.store.readRecent(3, 6000) };
      if (!['start', 'observe', 'act', 'end'].includes(command)) throw failure('unknown_command');
      if (state && (state.version !== 1 || !Array.isArray(state.pendingEvents) || !Number.isFinite(state.deadlineAt))) throw failure('invalid_runtime_state');
      if (!state && command !== 'start') throw failure('run_start_first');
      try {
        if (command === 'act') input = validateDecision(input);
        const identity = await this.transport.initialize();
        if (state && state.agentId !== identity.agentId) throw failure('identity_mismatch');
        let previousMemory;
        if (command === 'start' && input?.newExperiment) {
          if (state && !state.endedAt) throw failure('end_current_experiment_first');
          if (state?.pendingAction) throw failure('unresolved_previous_action');
          previousMemory = state?.memory;
          if (state) await this.store.append({ ts: this.now(), type: 'experiment_archived', experimentId: state.experimentId, memory: state.memory });
          state = null;
        }
        if (!state) {
          const now = this.now();
          state = { version: 1, agentId: identity.agentId, experimentId: randomUUID(),
            callerId: `archi-${randomUUID()}`, startedAt: now, deadlineAt: now + 30 * 60_000,
            messagesSent: 0, iteration: 0, nextDecisionAt: now, cursor: null, ackPending: null,
            pendingEvents: [], pendingAction: null, completedActions: {}, lastResult: null,
            memory: previousMemory ?? { summary: '', nextStep: 'Explore how to organize and recover your memory.' },
            endedAt: null, stopReason: null };
          await this.store.save(state);
          await this.store.append({ ts: now, type: 'experiment_started', experimentId: state.experimentId });
        }
        if (command === 'end') return this.finish(state, state.stopReason ?? 'owner_ended');
        if (state.endedAt) return this.snapshot(state);
        if (this.now() >= state.deadlineAt) return this.finish(state, 'time_budget');
        await this.transport.connect(state.callerId);
        if (command === 'start') {
          // A guide failure must not discard already durable participant state.
          if (!state.guide) {
            const response = await this.transport.read('/v1/city-guide');
            const guide = response.data;
            state.guide = { url: '/v1/city-guide.md', revision: guide.revision, body: String(guide.body).slice(0, 18000) };
            await this.store.save(state);
          }
          return { ...this.snapshot(state), guide: state.guide, recentMemory: await this.store.readRecent(3, 6000) };
        }
        if (command === 'observe') return await this.observe(state);
        return await this.act(state, input);
      } catch (error) {
        if (state) {
          if (TERMINAL.has(error.code)) {
            state.endedAt ??= this.now();
            state.stopReason = error.code;
            if (error.code === 'local_session_budget') await this.finish(state, error.code);
          }
          state.lastError = { code: safeErrorCode(error), at: this.now() };
          await this.store.save(state);
          await this.store.append({ ts: this.now(), type: 'error', ...state.lastError });
        }
        throw error;
      }
    });
  }

  async observe(state) {
    if (state.ackPending) {
      await this.transport.ack(state.ackPending);
      state.ackPending = null;
      await this.store.save(state);
    }
    // Do not advance the server cursor beyond our bounded durable local queue.
    if (state.pendingEvents.length < 100) {
      const query = new URLSearchParams({ limit: String(Math.min(20, 100 - state.pendingEvents.length)) });
      if (state.cursor) query.set('after_cursor', state.cursor);
      const page = await this.transport.read(`/v1/inbox/events?${query}`);
      const known = new Set(state.pendingEvents.map((event) => event.event_id));
      for (const event of page.data ?? []) {
        if (!known.has(event.event_id)) {
          state.pendingEvents.push(event);
          known.add(event.event_id);
        }
      }
      if (page.page?.next_cursor) {
        state.cursor = page.page.next_cursor;
        state.ackPending = state.cursor;
      }
      await this.store.save(state); // Durable receipt precedes ACK and model invocation.
      if (state.ackPending) {
        await this.transport.ack(state.ackPending);
        state.ackPending = null;
        await this.store.save(state);
      }
    }
    return this.snapshot(state);
  }

  async act(state, decision) {
    const fingerprint = digest(decision);
    const actionKey = `action:${decision.actionId}`;
    const completed = state.completedActions[actionKey];
    if (completed) {
      if (completed.fingerprint !== fingerprint) throw failure('action_id_reused_with_different_body');
      return { ...this.snapshot(state), replayed: true, result: completed.result };
    }
    if (state.pendingAction && state.pendingAction.fingerprint !== fingerprint) throw failure('resolve_pending_action_first');
    if (!state.pendingAction) {
      if (!this.snapshot(state).due) throw failure('not_due');
      if (state.iteration >= 100) return this.finish(state, 'turn_budget');
      if (decision.plan === 'reply' && state.messagesSent >= 3) throw failure('message_budget');
      state.pendingAction = { decision, fingerprint, key: `archi-${state.experimentId}-${decision.actionId}`, eventIds: state.pendingEvents.slice(0, 20).map((event) => event.event_id) };
      // Reserve before attempting delivery. An ambiguous outcome cannot bypass the cap.
      if (decision.plan === 'reply') state.messagesSent += 1;
      await this.store.save(state);
      await this.store.append({ ts: this.now(), type: 'action_intent', actionId: decision.actionId, plan: decision.plan });
    }
    const intent = state.pendingAction;
    let result;
    try {
      result = await this.execute(decision, intent.key);
    } catch (error) {
      // Network/5xx outcomes remain pending. Definitive non-terminal client errors
      // complete as failures, allowing the model to choose a corrected new action.
      if ((error.status >= 400 && error.status < 500 && !TERMINAL.has(error.code) && error.status !== 429) || ['OLIMPYX_HELP_POLICY_BLOCKED', 'OLIMPYX_BUDGET_EXCEEDED'].includes(error.code)) {
        result = { ok: false, code: safeErrorCode(error) };
        if (decision.plan === 'reply') state.messagesSent -= 1;
      } else throw error;
    }
    state.iteration += 1;
    state.memory = { summary: decision.compress, nextStep: decision.nextStep };
    state.lastResult = { actionId: decision.actionId, plan: decision.plan, result };
    state.completedActions[actionKey] = { fingerprint, result };
    // Events remain queued for read-only exploration; a reply/note/rest constitutes
    // an explicit disposition of the currently presented batch.
    if (decision.plan !== 'explore' && result?.ok !== false) {
      const handled = new Set(intent.eventIds);
      state.pendingEvents = state.pendingEvents.filter((event) => !handled.has(event.event_id));
    }
    state.pendingAction = null;
    state.nextDecisionAt = this.now() + (decision.plan === 'rest' ? decision.payload.revisitAfterSeconds * 1000 : 300_000);
    await this.store.save(state);
    await this.store.append({ ts: this.now(), type: 'turn', iter: state.iteration, actionId: decision.actionId,
      plan: decision.plan, result, compress: decision.compress, nextStep: decision.nextStep });
    return this.snapshot(state);
  }

  async execute(decision, key) {
    const { plan, payload } = decision;
    if (plan === 'reply') return this.transport.reply(payload, key);
    if (plan === 'explore') {
      const paths = {
        rooms: '/v1/rooms?limit=10', peers: '/v1/agents?limit=10', guide: '/v1/city-guide',
        knowledge: `/v1/knowledge/cards?${new URLSearchParams({ q: payload.query ?? '', limit: '5' })}`,
        room: `/v1/rooms/${encodeURIComponent(payload.roomId ?? '')}/messages?limit=10`,
        message: `/v1/messages/${encodeURIComponent(payload.messageId ?? '')}`
      };
      return this.transport.read(paths[payload.target]);
    }
    if (plan === 'rest') return { ok: true, resting: true, reason: payload.reason };
    // Notes/proposals persist in the result and journal, without network mutations.
    return { ok: true, localOnly: true, kind: plan, ...payload };
  }
}

export function safeErrorCode(error) {
  const code = String(error?.code ?? error?.message ?? 'operation_failed');
  return /^[A-Za-z0-9_-]{1,80}$/.test(code) ? code : 'operation_failed';
}
