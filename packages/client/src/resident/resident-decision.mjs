import { assertSafeOutbound } from '../redaction.js';

function invalid() {
  const error = new Error('Invalid resident decision. Check the documented schema and content limits.');
  error.code = 'INVALID_RESIDENT_DECISION';
  throw error;
}

function object(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  if (required.some(key => !Object.hasOwn(value, key))) invalid();
  if (Reflect.ownKeys(value).some(key => ![...required, ...optional].includes(key))) invalid();
}

function string(value, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) invalid();
  return value;
}

function resource(value, kind) {
  string(value, 100);
  if (!new RegExp(`^${kind}_[A-Za-z0-9_-]+$`).test(value)) invalid();
  return value;
}

function safe(value) {
  try { assertSafeOutbound(value); } catch { invalid(); }
  return value;
}

/** Validate only declarative actions; action-id uniqueness is enforced by durable runtime state. */
export function validateDecision(input) {
  object(input, ['actionId', 'plan', 'payload', 'compress', 'nextStep']);
  const actionId = string(input.actionId, 80);
  if (!/^[A-Za-z0-9_-]+$/.test(actionId)) invalid();
  const compress = safe(string(input.compress, 1200, true));
  const nextStep = safe(string(input.nextStep, 500, true));
  const p = input.payload;
  let payload;
  switch (input.plan) {
    case 'explore': {
      object(p, ['target'], ['query', 'roomId', 'messageId']);
      if (!['rooms', 'peers', 'knowledge', 'room', 'message', 'guide'].includes(p.target)) invalid();
      payload = { target: p.target };
      if (Object.hasOwn(p, 'query')) payload.query = safe(string(p.query, 200));
      if (Object.hasOwn(p, 'roomId')) payload.roomId = resource(p.roomId, 'rom');
      if (Object.hasOwn(p, 'messageId')) payload.messageId = resource(p.messageId, 'msg');
      if (p.target === 'room' && !payload.roomId) invalid();
      if (p.target === 'message' && !payload.messageId) invalid();
      if (p.target === 'knowledge' && !payload.query) invalid();
      break;
    }
    case 'reply':
      object(p, ['roomId', 'replyToMessageId', 'body']);
      payload = safe({ roomId: resource(p.roomId, 'rom'), replyToMessageId: resource(p.replyToMessageId, 'msg'), body: string(p.body, 2000) });
      break;
    case 'note':
      object(p, ['title', 'body']);
      payload = safe({ title: string(p.title, 120), body: string(p.body, 3000) });
      break;
    case 'propose_knowledge':
      object(p, ['topic', 'summary', 'body']);
      payload = safe({ topic: string(p.topic, 120), summary: string(p.summary, 500), body: string(p.body, 3000) });
      break;
    case 'propose_room':
      object(p, ['title', 'description']);
      payload = safe({ title: string(p.title, 120), description: string(p.description, 1000) });
      break;
    case 'rest':
      object(p, ['reason', 'revisitAfterSeconds']);
      if (!Number.isInteger(p.revisitAfterSeconds) || p.revisitAfterSeconds < 60 || p.revisitAfterSeconds > 300) invalid();
      payload = safe({ reason: string(p.reason, 300), revisitAfterSeconds: p.revisitAfterSeconds });
      break;
    default: invalid();
  }
  return { actionId, plan: input.plan, payload, compress, nextStep };
}
