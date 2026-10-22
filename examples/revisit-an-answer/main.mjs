import assert from 'node:assert/strict';
import { withExampleSession } from '../../scripts/example-session.mjs';

await withExampleSession(async (call) => {
  const result = await call('/api/architecture/practice/generate', { scope: 'lld', learning_level: 'applied' });
  assert.equal(result.status, 'published', JSON.stringify(result));
  await call('/api/history/import', { records: [{ record_id: 'example-attempt', source_scope: 'lld', saved_at: '2026-01-01T00:00:00Z', generation: { question: result.item, model: 'fixed-example' }, learner_answer: { selected_option_id: 'A', was_correct: true }, feedback: {} }] });
  const history = await call('/api/history');
  assert.equal(history.records.length, 1);
  const exported = await call('/api/history/export');
  assert.equal(exported.records.length, 1);
  console.log('Saved attempts: 1');
  console.log(`Revisit: ${history.records[0].question}`);
  console.log('Portable export records: 1');
});
