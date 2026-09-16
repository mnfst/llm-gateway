import type {
	GenericValue,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	IN8nHttpFullResponse,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { MANIFEST_ATTRIBUTION_HEADERS } from '../shared/attribution';

type ManifestOperation = 'chatCompletion' | 'createResponse' | 'listModels';
type ManifestHttpMethod = 'GET' | 'POST';

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, '');
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseJsonValue(
	value: unknown,
	parameterName: string,
	itemIndex: number,
	node: INode,
): unknown {
	if (typeof value !== 'string') return value;

	const trimmed = value.trim();
	if (!trimmed) return {};

	try {
		return JSON.parse(trimmed) as unknown;
	} catch (error) {
		throw new NodeOperationError(
			node,
			`${parameterName} must be valid JSON: ${errorMessage(error)}`,
			{ itemIndex },
		);
	}
}

function parseJsonObject(
	value: unknown,
	parameterName: string,
	itemIndex: number,
	node: INode,
): IDataObject {
	const parsed = parseJsonValue(value, parameterName, itemIndex, node);
	if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
		throw new NodeOperationError(node, `${parameterName} must be a JSON object`, { itemIndex });
	}
	return parsed as IDataObject;
}

function parseJsonArray(
	value: unknown,
	parameterName: string,
	itemIndex: number,
	node: INode,
): unknown[] {
	const parsed = parseJsonValue(value, parameterName, itemIndex, node);
	if (!Array.isArray(parsed)) {
		throw new NodeOperationError(node, `${parameterName} must be a JSON array`, { itemIndex });
	}
	return parsed;
}

function toOutputJson(value: unknown): JsonObject {
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		return value as JsonObject;
	}
	return { data: value } as JsonObject;
}

export function withoutRouteManagedStream(body: IDataObject): IDataObject {
	const requestBody = { ...body };
	delete requestBody.stream;
	return requestBody;
}

function responseContentType(headers: IDataObject): string {
	const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type');
	if (!entry) return '';

	const value = entry[1];
	return Array.isArray(value) ? value.join(',') : String(value);
}

function parseEventData(value: string): GenericValue {
	if (value === '[DONE]') return value;

	try {
		return JSON.parse(value) as GenericValue;
	} catch {
		return value;
	}
}

export function parseServerSentEvents(body: string): IDataObject {
	const events: IDataObject[] = [];
	const normalized = body.replace(/\r\n?/g, '\n');

	for (const block of normalized.split(/\n\n+/)) {
		let eventName = 'message';
		let eventId: string | undefined;
		const dataLines: string[] = [];

		for (const line of block.split('\n')) {
			if (!line || line.startsWith(':')) continue;

			const separatorIndex = line.indexOf(':');
			const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
			const rawValue = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1);
			const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

			if (field === 'event' && value) eventName = value;
			if (field === 'id') eventId = value;
			if (field === 'data') dataLines.push(value);
		}

		if (dataLines.length === 0) continue;

		const event: IDataObject = {
			event: eventName,
			data: parseEventData(dataLines.join('\n')),
		};
		if (eventId !== undefined) event.id = eventId;
		events.push(event);
	}

	return { responseMode: 'stream', events };
}

export function parseManifestResponse(response: IN8nHttpFullResponse): unknown {
	const body = response.body;
	if (typeof body !== 'string') return body;

	if (responseContentType(response.headers).toLowerCase().includes('text/event-stream')) {
		return parseServerSentEvents(body);
	}

	const trimmed = body.trim();
	if (!trimmed) return {};

	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return body;
	}
}

async function executeManifestOperation(
	executeFunctions: IExecuteFunctions,
	operation: ManifestOperation,
	itemIndex: number,
): Promise<unknown> {
	if (operation === 'listModels') {
		return await requestManifest(executeFunctions, 'GET', '/v1/models');
	}

	if (operation === 'chatCompletion') {
		const model = executeFunctions.getNodeParameter('model', itemIndex) as string;
		const messages = parseJsonArray(
			executeFunctions.getNodeParameter('messages', itemIndex),
			'Messages',
			itemIndex,
			executeFunctions.getNode(),
		);
		const additionalBody = withoutRouteManagedStream(
			parseJsonObject(
				executeFunctions.getNodeParameter('additionalBody', itemIndex, '{}'),
				'Additional Body',
				itemIndex,
				executeFunctions.getNode(),
			),
		);

		return await requestManifest(executeFunctions, 'POST', '/v1/chat/completions', {
			...additionalBody,
			model,
			messages,
		});
	}

	if (operation === 'createResponse') {
		const model = executeFunctions.getNodeParameter('model', itemIndex) as string;
		const input = executeFunctions.getNodeParameter('input', itemIndex) as string;
		const additionalBody = withoutRouteManagedStream(
			parseJsonObject(
				executeFunctions.getNodeParameter('additionalBody', itemIndex, '{}'),
				'Additional Body',
				itemIndex,
				executeFunctions.getNode(),
			),
		);

		return await requestManifest(executeFunctions, 'POST', '/v1/responses', {
			...additionalBody,
			model,
			input,
		});
	}

	throw new NodeOperationError(executeFunctions.getNode(), `Unsupported operation: ${operation}`, {
		itemIndex,
	});
}

async function requestManifest(
	executeFunctions: IExecuteFunctions,
	method: ManifestHttpMethod,
	path: string,
	body?: IDataObject,
): Promise<unknown> {
	const credentials = await executeFunctions.getCredentials('manifestApi');
	const baseUrl = trimTrailingSlash(String(credentials.baseUrl || 'https://app.manifest.build'));
	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${path}`,
		headers: {
			Authorization: `Bearer ${String(credentials.apiKey)}`,
			...MANIFEST_ATTRIBUTION_HEADERS,
		},
		encoding: 'text',
		returnFullResponse: true,
		json: true,
	};

	if (body !== undefined) {
		options.body = body;
	}

	const response = (await executeFunctions.helpers.httpRequest(options)) as IN8nHttpFullResponse;
	return parseManifestResponse(response);
}

export class Manifest implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Manifest',
		name: 'manifest',
		icon: { light: 'file:manifest-logo.svg', dark: 'file:manifest-logo.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"]}}',
		description: 'Route AI requests through Manifest',
		defaults: {
			name: 'Manifest',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'manifestApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Create Chat Completion',
						value: 'chatCompletion',
						description: 'Call Manifest using the OpenAI-compatible chat completions API',
						action: 'Create a chat completion',
					},
					{
						name: 'Create Response',
						value: 'createResponse',
						description: 'Call Manifest using the OpenAI-compatible Responses API',
						action: 'Create a response',
					},
					{
						name: 'List Models',
						value: 'listModels',
						description: 'List models available to this Manifest API key',
						action: 'List models',
					},
				],
				default: 'chatCompletion',
			},
			{
				displayName: 'Model',
				name: 'model',
				type: 'string',
				default: 'auto',
				required: true,
				description: 'Manifest model ID. Use auto to let Manifest route the request.',
				displayOptions: {
					show: {
						operation: ['chatCompletion', 'createResponse'],
					},
				},
			},
			{
				displayName: 'Messages',
				name: 'messages',
				type: 'json',
				default: '[{"role":"user","content":"Hello from n8n"}]',
				required: true,
				description: 'OpenAI-compatible chat messages array',
				displayOptions: {
					show: {
						operation: ['chatCompletion'],
					},
				},
			},
			{
				displayName: 'Input',
				name: 'input',
				type: 'string',
				default: '={{$json.prompt || $json.input || ""}}',
				required: true,
				description: 'Text input for the Responses API call',
				displayOptions: {
					show: {
						operation: ['createResponse'],
					},
				},
			},
			{
				displayName: 'Additional Body',
				name: 'additionalBody',
				type: 'json',
				default: '{}',
				description:
					'Additional JSON fields to merge into the request body. Manifest routing controls streaming, so the stream field is ignored.',
				displayOptions: {
					show: {
						operation: ['chatCompletion', 'createResponse'],
					},
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as ManifestOperation;
				const response = await executeManifestOperation(this, operation, itemIndex);

				returnData.push({
					json: toOutputJson(response),
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (!this.continueOnFail()) {
					throw new NodeOperationError(this.getNode(), error, { itemIndex });
				}

				returnData.push({
					json: { error: errorMessage(error) },
					pairedItem: { item: itemIndex },
				});
			}
		}

		return [returnData];
	}
}
