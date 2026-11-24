"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Manifest = void 0;
exports.withoutRouteManagedStream = withoutRouteManagedStream;
exports.parseServerSentEvents = parseServerSentEvents;
exports.parseManifestResponse = parseManifestResponse;
const n8n_workflow_1 = require("n8n-workflow");
const attribution_1 = require("../shared/attribution");
function trimTrailingSlash(value) {
    return value.replace(/\/+$/, '');
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function parseJsonValue(value, parameterName, itemIndex, node) {
    if (typeof value !== 'string')
        return value;
    const trimmed = value.trim();
    if (!trimmed)
        return {};
    try {
        return JSON.parse(trimmed);
    }
    catch (error) {
        throw new n8n_workflow_1.NodeOperationError(node, `${parameterName} must be valid JSON: ${errorMessage(error)}`, { itemIndex });
    }
}
function parseJsonObject(value, parameterName, itemIndex, node) {
    const parsed = parseJsonValue(value, parameterName, itemIndex, node);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new n8n_workflow_1.NodeOperationError(node, `${parameterName} must be a JSON object`, { itemIndex });
    }
    return parsed;
}
function parseJsonArray(value, parameterName, itemIndex, node) {
    const parsed = parseJsonValue(value, parameterName, itemIndex, node);
    if (!Array.isArray(parsed)) {
        throw new n8n_workflow_1.NodeOperationError(node, `${parameterName} must be a JSON array`, { itemIndex });
    }
    return parsed;
}
function toOutputJson(value) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    return { data: value };
}
function withoutRouteManagedStream(body) {
    const requestBody = { ...body };
    delete requestBody.stream;
    return requestBody;
}
function responseContentType(headers) {
    const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type');
    if (!entry)
        return '';
    const value = entry[1];
    return Array.isArray(value) ? value.join(',') : String(value);
}
function parseEventData(value) {
    if (value === '[DONE]')
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function parseServerSentEvents(body) {
    const events = [];
    const normalized = body.replace(/\r\n?/g, '\n');
    for (const block of normalized.split(/\n\n+/)) {
        let eventName = 'message';
        let eventId;
        const dataLines = [];
        for (const line of block.split('\n')) {
            if (!line || line.startsWith(':'))
                continue;
            const separatorIndex = line.indexOf(':');
            const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
            const rawValue = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1);
            const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
            if (field === 'event' && value)
                eventName = value;
            if (field === 'id')
                eventId = value;
            if (field === 'data')
                dataLines.push(value);
        }
        if (dataLines.length === 0)
            continue;
        const event = {
            event: eventName,
            data: parseEventData(dataLines.join('\n')),
        };
        if (eventId !== undefined)
            event.id = eventId;
        events.push(event);
    }
    return { responseMode: 'stream', events };
}
function parseManifestResponse(response) {
    const body = response.body;
    if (typeof body !== 'string')
        return body;
    if (responseContentType(response.headers).toLowerCase().includes('text/event-stream')) {
        return parseServerSentEvents(body);
    }
    const trimmed = body.trim();
    if (!trimmed)
        return {};
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return body;
    }
}
async function executeManifestOperation(executeFunctions, operation, itemIndex) {
    if (operation === 'listModels') {
        return await requestManifest(executeFunctions, 'GET', '/v1/models');
    }
    if (operation === 'chatCompletion') {
        const model = executeFunctions.getNodeParameter('model', itemIndex);
        const messages = parseJsonArray(executeFunctions.getNodeParameter('messages', itemIndex), 'Messages', itemIndex, executeFunctions.getNode());
        const additionalBody = withoutRouteManagedStream(parseJsonObject(executeFunctions.getNodeParameter('additionalBody', itemIndex, '{}'), 'Additional Body', itemIndex, executeFunctions.getNode()));
        return await requestManifest(executeFunctions, 'POST', '/v1/chat/completions', {
            ...additionalBody,
            model,
            messages,
        });
    }
    if (operation === 'createResponse') {
        const model = executeFunctions.getNodeParameter('model', itemIndex);
        const input = executeFunctions.getNodeParameter('input', itemIndex);
        const additionalBody = withoutRouteManagedStream(parseJsonObject(executeFunctions.getNodeParameter('additionalBody', itemIndex, '{}'), 'Additional Body', itemIndex, executeFunctions.getNode()));
        return await requestManifest(executeFunctions, 'POST', '/v1/responses', {
            ...additionalBody,
            model,
            input,
        });
    }
    throw new n8n_workflow_1.NodeOperationError(executeFunctions.getNode(), `Unsupported operation: ${operation}`, {
        itemIndex,
    });
}
async function requestManifest(executeFunctions, method, path, body) {
    const credentials = await executeFunctions.getCredentials('manifestApi');
    const baseUrl = trimTrailingSlash(String(credentials.baseUrl || 'https://app.manifest.build'));
    const options = {
        method,
        url: `${baseUrl}${path}`,
        headers: {
            Authorization: `Bearer ${String(credentials.apiKey)}`,
            ...attribution_1.MANIFEST_ATTRIBUTION_HEADERS,
        },
        encoding: 'text',
        returnFullResponse: true,
        json: true,
    };
    if (body !== undefined) {
        options.body = body;
    }
    const response = (await executeFunctions.helpers.httpRequest(options));
    return parseManifestResponse(response);
}
class Manifest {
    constructor() {
        this.description = {
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
            inputs: [n8n_workflow_1.NodeConnectionTypes.Main],
            outputs: [n8n_workflow_1.NodeConnectionTypes.Main],
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
                    description: 'Additional JSON fields to merge into the request body. Manifest routing controls streaming, so the stream field is ignored.',
                    displayOptions: {
                        show: {
                            operation: ['chatCompletion', 'createResponse'],
                        },
                    },
                },
            ],
        };
    }
    async execute() {
        const items = this.getInputData();
        const returnData = [];
        for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
            try {
                const operation = this.getNodeParameter('operation', itemIndex);
                const response = await executeManifestOperation(this, operation, itemIndex);
                returnData.push({
                    json: toOutputJson(response),
                    pairedItem: { item: itemIndex },
                });
            }
            catch (error) {
                if (!this.continueOnFail()) {
                    throw new n8n_workflow_1.NodeOperationError(this.getNode(), error, { itemIndex });
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
exports.Manifest = Manifest;
//# sourceMappingURL=Manifest.node.js.map