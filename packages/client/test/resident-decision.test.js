import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision } from '../src/resident/resident-decision.mjs';

const decision = (plan, payload) => ({ actionId: 'turn-1', plan, payload, compress: 'Known state.', nextStep: 'Continue.' });
const samples = [
  decision('explore', { target: 'rooms' }),
  decision('explore', { target: 'peers' }),
  decision('explore', { target: 'guide' }),
  decision('explore', { target: 'knowledge', query: 'memory' }),
  decision('explore', { target: 'room', roomId: 'rom_1' }),
  decision('explore', { target: 'message', messageId: 'msg_1' }),
  decision('reply', { roomId: 'rom_1', replyToMessageId: 'msg_1', body: 'Hello.' }),
  decision('note', { title: 'Memory', body: 'A checked fact.' }),
  decision('propose_knowledge', { topic: 'Memory', summary: 'Short summary', body: 'Details' }),
  decision('propose_room', { title: 'Memory', description: 'Research' }),
  decision('rest', { reason: 'No useful action yet.', revisitAfterSeconds: 300 })
];

test('accepts the six declarative actions and every exploration target', () => {
  for (const input of samples) {
    const output = validateDecision(input);
    assert.deepEqual(output, input);
    assert.notEqual(output.payload, input.payload);
  }
});

test('rejects missing, extra and malformed fields without reflecting their contents', () => {
  const cases = [null, [], 'secret-input', {},
    { ...samples[0], shell: 'secret-input' },
    { ...samples[0], payload: { target: 'rooms', url: 'secret-input' } },
    { ...samples[0], actionId: '../escape' },
    { ...samples[0], actionId: '' },
    { ...samples[0], plan: 'exec' },
    { ...samples[0], compress: 'x'.repeat(1201) },
    { ...samples[0], nextStep: 'x'.repeat(501) },
    decision('explore', { target: 'room' }),
    decision('explore', { target: 'message' }),
    decision('explore', { target: 'knowledge' }),
    decision('explore', { target: 'room', roomId: 'rom_../../etc' }),
    decision('reply', { roomId: 'msg_1', replyToMessageId: 'msg_1', body: 'Hello' }),
    decision('reply', { roomId: 'rom_1', replyToMessageId: 'msg_1', body: 'x'.repeat(2001) }),
    decision('rest', { reason: 'Wait', revisitAfterSeconds: 59 }),
    decision('rest', { reason: 'Wait', revisitAfterSeconds: 301 }),
    decision('rest', { reason: 'Wait', revisitAfterSeconds: 60.5 })
  ];
  for (const input of cases) assert.throws(() => validateDecision(input), error => {
    assert.equal(error.code, 'INVALID_RESIDENT_DECISION');
    assert.ok(error.message.length < 150);
    assert.ok(!error.message.includes('secret-input'));
    return true;
  });
});

test('rejects credentials in publications, private notes and compact memory', () => {
  const secret = 'Bearer abcdefghijklmnopqrstuvwxyz123456789';
  for (const input of samples) {
    assert.throws(() => validateDecision({ ...input, compress: secret }));
    assert.throws(() => validateDecision({ ...input, nextStep: secret }));
  }
  for (const plan of ['reply', 'note', 'propose_knowledge', 'propose_room']) {
    const input = structuredClone(samples.find(sample => sample.plan === plan));
    input.payload[plan === 'propose_room' ? 'description' : 'body'] = secret;
    assert.throws(() => validateDecision(input), { code: 'INVALID_RESIDENT_DECISION' });
  }
});

test('rejects extra payload fields for every action and requires every top-level field', () => {
  for (const input of samples) {
    assert.throws(() => validateDecision({ ...input, payload: { ...input.payload, command: 'echo test' } }));
    for (const key of Object.keys(input)) {
      const incomplete = { ...input };
      delete incomplete[key];
      assert.throws(() => validateDecision(incomplete));
    }
  }
});
