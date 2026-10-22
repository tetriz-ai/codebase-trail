import { defineExtractorPlugin, runExtractorPlugin } from '../../plugin-sdk.mjs';

const plugin = defineExtractorPlugin({
  id: 'example-declarations', version: '1.0.0', api_version: '1.0',
  capabilities: { languages: ['example'], file_extensions: ['.example'], claim_kinds: [] },
  supports: (file) => String(file.path).endsWith('.example'),
  extract: (file) => ({ discoveries: [{ kind: 'component', name: String(file.content).trim() }], claims: [], diagnostics: [] }),
});
const file = { path: 'service.example', content: 'Example Worker' };
const result = runExtractorPlugin(plugin, file, { repository_id: 'example', revision: 'synthetic' });
console.log(`Plugin: ${plugin.id}`);
console.log(`Discovered: ${JSON.stringify(result.discoveries)}`);
