const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
	Manifest,
	parseManifestResponse,
	parseServerSentEvents,
	withoutRouteManagedStream,
} = require('../dist/nodes/Manifest/Manifest.node.js');

const ATTRIBUTION_HEADERS = {
	Authorization: 'Bearer manifest_test_key',
	'User-Agent': 'n8n-nodes-manifest',
	'X-Title': 'n8n',
	'HTTP-Referer': 'https://n8n.io',
};

test('keeps node metadata valid in package and repository files', () => {
	const packageName = require('../package.json').name;
	const manifestDescription = new Manifest().description;
	const allowedFields = new Set([
		'alias',
		'categories',
		'codexVersion',
		'node',
		'nodeVersion',
		'resources',
	]);
	const codexFiles = [
		['../nodes/Manifest/Manifest.node.json', `${packageName}.${manifestDescription.name}`],
		['../dist/nodes/Manifest/Manifest.node.json', `${packageName}.${manifestDescription.name}`],
		['../../../nodes/Manifest/Manifest.node.json', `${packageName}.${manifestDescription.name}`],
		['../nodes/LmChatManifest/LmChatManifest.node.json', `${packageName}.lmChatManifest`],
		['../dist/nodes/LmChatManifest/LmChatManifest.node.json', `${packageName}.lmChatManifest`],
		['../../../nodes/LmChatManifest/LmChatManifest.node.json', `${packageName}.lmChatManifest`],
	];

	assert.equal(manifestDescription.usableAsTool, true);

	for (const [relativePath, expectedNode] of codexFiles) {
		const codex = JSON.parse(fs.readFileSync(path.join(__dirname, relativePath), 'utf8'));

		assert.equal(codex.node, expectedNode);
		assert.deepEqual(codex.categories, ['Development']);
		assert.ok(Object.keys(codex).every((field) => allowedFields.has(field)));
	}
});

function executionContext(parameters, response, requests) {
	return {
		continueOnFail: () => false,
		getCredentials: async () => ({
			apiKey: 'manifest_test_key',
			baseUrl: 'http://manifest.test/',
		}),
		getInputData: () => [{ json: {} }],
		getNode: () => ({
			name: 'Manifest',
			type: 'n8n-nodes-manifest.manifest',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		getNodeParameter: (name, _itemIndex, fallback) => parameters[name] ?? fallback,
		helpers: {
			httpRequest: async (request) => {
				requests.push(request);
				return response;
			},
		},
	};
}

test('removes a client stream override without mutating additional fields', () => {
	const additionalBody = { stream: true, temperature: 0.2 };

	assert.deepEqual(withoutRouteManagedStream(additionalBody), { temperature: 0.2 });
	assert.deepEqual(additionalBody, { stream: true, temperature: 0.2 });
});

test('returns buffered JSON responses as objects', () => {
	const response = parseManifestResponse({
		body: '{"id":"chatcmpl_123","choices":[]}',
		headers: { 'content-type': 'application/json' },
		statusCode: 200,
	});

	assert.deepEqual(response, { id: 'chatcmpl_123', choices: [] });
});

test('parses chat completion event streams including the terminal marker', () => {
	const response = parseManifestResponse({
		body:
			': keepalive\r\n\r\n' +
			'id: evt_1\r\ndata: {"choices":[{"delta":{"content":"Hello"}}]}\r\n\r\n' +
			'data: [DONE]\r\n\r\n',
		headers: { 'Content-Type': 'Text/Event-Stream; Charset=UTF-8' },
		statusCode: 200,
	});

	assert.deepEqual(response, {
		responseMode: 'stream',
		events: [
			{
				event: 'message',
				id: 'evt_1',
				data: { choices: [{ delta: { content: 'Hello' } }] },
			},
			{ event: 'message', data: '[DONE]' },
		],
	});
});

test('preserves named Responses API events and multiline data', () => {
	assert.deepEqual(
		parseServerSentEvents(
			'event: response.output_text.delta\ndata: first line\ndata: second line\n\n',
		),
		{
			responseMode: 'stream',
			events: [
				{
					event: 'response.output_text.delta',
					data: 'first line\nsecond line',
				},
			],
		},
	);
});

test('preserves a non-JSON buffered response as text', () => {
	const response = parseManifestResponse({
		body: 'plain text',
		headers: { 'content-type': 'text/plain' },
		statusCode: 200,
	});

	assert.equal(response, 'plain text');
});

test('attaches Manifest attribution headers when listing models', async () => {
	const requests = [];
	const context = executionContext(
		{ operation: 'listModels' },
		{
			body: '{"data":[]}',
			headers: { 'content-type': 'application/json' },
			statusCode: 200,
		},
		requests,
	);

	await new Manifest().execute.call(context);

	assert.deepEqual(requests[0].headers, ATTRIBUTION_HEADERS);
	assert.equal(requests[0].method, 'GET');
	assert.equal(requests[0].url, 'http://manifest.test/v1/models');
});

test('executes chat completions without overriding the route response mode', async () => {
	const requests = [];
	const context = executionContext(
		{
			operation: 'chatCompletion',
			model: 'auto',
			messages: '[{"role":"user","content":"Hello"}]',
			additionalBody: '{"stream":true,"temperature":0.2}',
		},
		{
			body: '{"choices":[]}',
			headers: { 'content-type': 'application/json' },
			statusCode: 200,
		},
		requests,
	);

	const result = await new Manifest().execute.call(context);

	assert.deepEqual(result, [[{ json: { choices: [] }, pairedItem: { item: 0 } }]]);
	assert.deepEqual(requests, [
		{
			method: 'POST',
			url: 'http://manifest.test/v1/chat/completions',
			headers: ATTRIBUTION_HEADERS,
			encoding: 'text',
			returnFullResponse: true,
			json: true,
			body: {
				temperature: 0.2,
				model: 'auto',
				messages: [{ role: 'user', content: 'Hello' }],
			},
		},
	]);
});

test('executes Responses API calls with parsed streaming output', async () => {
	const requests = [];
	const context = executionContext(
		{
			operation: 'createResponse',
			model: 'auto',
			input: 'Hello',
			additionalBody: '{"stream":false,"max_output_tokens":20}',
		},
		{
			body:
				'event: response.output_text.delta\ndata: {"delta":"Hello"}\n\n' +
				'event: response.completed\ndata: {"response":{"status":"completed"}}\n\n',
			headers: { 'content-type': 'text/event-stream' },
			statusCode: 200,
		},
		requests,
	);

	const result = await new Manifest().execute.call(context);

	assert.deepEqual(requests[0].headers, ATTRIBUTION_HEADERS);
	assert.deepEqual(requests[0].body, {
		max_output_tokens: 20,
		model: 'auto',
		input: 'Hello',
	});
	assert.deepEqual(result, [
		[
			{
				json: {
					responseMode: 'stream',
					events: [
						{
							event: 'response.output_text.delta',
							data: { delta: 'Hello' },
						},
						{
							event: 'response.completed',
							data: { response: { status: 'completed' } },
						},
					],
				},
				pairedItem: { item: 0 },
			},
		],
	]);
});

test('sends requests to the app API when no base URL was saved', async () => {
	const requests = [];
	const context = executionContext(
		{ operation: 'listModels' },
		{ body: '{"data":[]}', headers: { 'content-type': 'application/json' }, statusCode: 200 },
		requests,
	);
	context.getCredentials = async () => ({ apiKey: 'manifest_test_key' });

	await new Manifest().execute.call(context);

	assert.equal(requests[0].url, 'https://app.manifest.build/v1/models');
});
