import type {
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { MANIFEST_ATTRIBUTION_HEADERS } from '../shared/attribution';

interface ManifestModelListResponse {
	data?: Array<{ id?: string }>;
}

interface ManifestChatModelOptions {
	temperature?: number;
	maxTokens?: number;
	topP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	timeout?: number;
	maxRetries?: number;
	useResponsesApi?: boolean;
}

function manifestApiBaseUrl(credentials: { baseUrl?: unknown }): string {
	const raw = String(credentials.baseUrl || 'https://app.manifest.build');
	return `${raw.replace(/\/+$/, '')}/v1`;
}

export class LmChatManifest implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Manifest Chat Model',
		name: 'lmChatManifest',
		subtitle: '={{$parameter["model"]}}',
		icon: { light: 'file:manifest-logo.svg', dark: 'file:manifest-logo.dark.svg' },
		group: ['transform'],
		version: [1],
		description: 'Language model routed through Manifest',
		defaults: {
			name: 'Manifest Chat Model',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
				'Language Models': ['Chat Models (Recommended)'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://github.com/mnfst/llm-gateway/tree/main/integrations/n8n-nodes-manifest',
					},
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [
			{
				name: 'manifestApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				default: 'auto',
				required: true,
				typeOptions: {
					loadOptionsMethod: 'getModels',
				},
				description:
					'The model that answers the request. Use "auto" to let Manifest route each request to the cheapest capable model. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Frequency Penalty',
						name: 'frequencyPenalty',
						type: 'number',
						default: 0,
						typeOptions: { minValue: -2, maxValue: 2 },
						description:
							"Positive values penalize new tokens based on their existing frequency in the text so far, decreasing the model's likelihood to repeat the same line verbatim",
					},
					{
						displayName: 'Max Retries',
						name: 'maxRetries',
						type: 'number',
						default: 2,
						description: 'Maximum number of retries to attempt on failure',
					},
					{
						displayName: 'Maximum Number of Tokens',
						name: 'maxTokens',
						type: 'number',
						default: -1,
						description:
							'The maximum number of tokens to generate in the completion. Use -1 for no limit.',
					},
					{
						displayName: 'Presence Penalty',
						name: 'presencePenalty',
						type: 'number',
						default: 0,
						typeOptions: { minValue: -2, maxValue: 2 },
						description:
							"Positive values penalize new tokens based on whether they appear in the text so far, increasing the model's likelihood to talk about new topics",
					},
					{
						displayName: 'Sampling Temperature',
						name: 'temperature',
						type: 'number',
						default: 0.7,
						typeOptions: { minValue: 0, maxValue: 2 },
						description:
							'Controls randomness: lowering results in less random completions. As the temperature approaches zero, the model will become deterministic and repetitive.',
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						default: 360000,
						description: 'Maximum amount of time a request is allowed to take, in milliseconds',
					},
					{
						displayName: 'Top P',
						name: 'topP',
						type: 'number',
						default: 1,
						typeOptions: { minValue: 0, maxValue: 1 },
						description:
							'Controls diversity via nucleus sampling: 0.5 means half of all likelihood-weighted options are considered. We generally recommend altering this or temperature but not both.',
					},
					{
						displayName: 'Use Responses API',
						name: 'useResponsesApi',
						type: 'boolean',
						default: false,
						description:
							'Whether to call Manifest through the OpenAI Responses API instead of Chat Completions',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await this.getCredentials('manifestApi');
				const response = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					'manifestApi',
					{
						method: 'GET',
						url: `${manifestApiBaseUrl(credentials)}/models`,
						headers: { ...MANIFEST_ATTRIBUTION_HEADERS },
						json: true,
					},
				)) as ManifestModelListResponse;

				const models: INodePropertyOptions[] = [
					{ name: 'Auto (Manifest Routing)', value: 'auto' },
				];
				for (const model of response.data ?? []) {
					if (model.id && model.id !== 'auto') {
						models.push({ name: model.id, value: model.id });
					}
				}
				return models;
			},
		},
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		// Lazy import: @n8n/ai-node-sdk is a peer dependency provided by the n8n
		// runtime itself, and only recent n8n versions ship it. Importing it here
		// instead of at module load keeps the rest of this package working on
		// older n8n installs.
		let sdk: typeof import('@n8n/ai-node-sdk');
		try {
			sdk = await import('@n8n/ai-node-sdk');
		} catch {
			throw new NodeOperationError(
				this.getNode(),
				'The Manifest Chat Model node requires an n8n version that includes @n8n/ai-node-sdk. Please update n8n to a recent version.',
				{ itemIndex },
			);
		}

		const credentials = await this.getCredentials('manifestApi');
		const model = this.getNodeParameter('model', itemIndex) as string;
		const options = this.getNodeParameter('options', itemIndex, {}) as ManifestChatModelOptions;

		return sdk.supplyModel(this, {
			type: 'openai',
			baseUrl: manifestApiBaseUrl(credentials),
			apiKey: String(credentials.apiKey),
			defaultHeaders: { ...MANIFEST_ATTRIBUTION_HEADERS },
			model,
			temperature: options.temperature,
			topP: options.topP,
			frequencyPenalty: options.frequencyPenalty,
			presencePenalty: options.presencePenalty,
			timeout: options.timeout,
			maxRetries: options.maxRetries,
			useResponsesApi: options.useResponsesApi,
			...(options.maxTokens !== undefined && options.maxTokens > 0
				? { maxTokens: options.maxTokens }
				: {}),
		});
	}
}
