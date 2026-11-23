const fs = require('fs');

function edit(path, anchor, beforeBlock) {
  const t = fs.readFileSync(path, 'utf8');
  if (t.includes("id: 'crowllm'") || t.includes('crowllm: {')) { console.log('already', path); return; }
  if (!t.includes(anchor)) throw new Error('anchor missing in ' + path);
  fs.writeFileSync(path, t.replace(anchor, beforeBlock + anchor));
  console.log('edited', path);
}

edit(
  'packages/shared/src/providers.ts',
  "    keyPlaceholder: 'API key',\n  },\n] as const;",
  [
    '  {',
    "    id: 'crowllm',",
    "    displayName: 'CrowLLM',",
    '    aliases: [],',
    '    openRouterPrefixes: [],',
    '    requiresApiKey: true,',
    '    localOnly: false,',
    "    color: '#f59e0b',",
    "    keyPrefix: 'sk-',",
    '    minKeyLength: 10,',
    "    keyPlaceholder: 'sk-...',",
    '  },',
    '',
  ].join('\n')
);

edit(
  'packages/backend/src/model-discovery/provider-model-fetcher.service.ts',
  '  kilo: {\n    endpoint: `${KILO_GATEWAY_BASE}/models`,\n    buildHeaders: bearerHeaders,\n    parse: parseKilo,\n  },',
  [
    '  crowllm: {',
    "    endpoint: 'https://crowllm.com/v1/models',",
    '    buildHeaders: bearerHeaders,',
    '    parse: parseOpenAI,',
    '  },',
    '',
  ].join('\n')
);

edit(
  'packages/backend/src/routing/proxy/provider-endpoints.ts',
  "  kilo: {\n    baseUrl: KILO_GATEWAY_BASE,\n    buildHeaders: openaiHeaders,\n    buildPath: () => '/chat/completions',\n    format: 'openai',\n    ...openaiStreamUsage,\n  },",
  [
    '  crowllm: {',
    "    baseUrl: 'https://crowllm.com',",
    '    buildHeaders: openaiHeaders,',
    '    buildPath: openaiPath,',
    "    format: 'openai',",
    '    ...openaiStreamUsage,',
    '  },',
    '',
  ].join('\n')
);

console.log('done');
