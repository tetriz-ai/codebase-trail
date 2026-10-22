import assert from 'node:assert/strict';
import { withExampleSession } from '../../scripts/example-session.mjs';

await withExampleSession(async (call) => {
  const result = await call('/api/architecture/practice/generate', { scope: 'lld', learning_level: 'applied' });
  assert.equal(result.status, 'published', JSON.stringify(result));
  assert.equal(result.item.correct_option_id, 'A');
  console.log('Fixed model responses demonstrate the pipeline and output format, not model accuracy.');
  console.log(result.item.question);
  console.log(`Answer ${result.item.correct_option_id}: ${result.item.answer_options[0].text}`);
  console.log(`Grounded claims: ${result.item.supporting_claim_ids.length}`);
});
