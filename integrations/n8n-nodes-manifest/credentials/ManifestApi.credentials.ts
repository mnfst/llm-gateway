import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';
import { MANIFEST_ATTRIBUTION_HEADERS } from '../nodes/shared/attribution';

export class ManifestApi implements ICredentialType {
	name = 'manifestApi';

	displayName = 'Manifest API';

	icon = {
		light: 'file:../nodes/Manifest/manifest-logo.svg',
		dark: 'file:../nodes/Manifest/manifest-logo.dark.svg',
	} as const;

	documentationUrl = 'https://manifest.build/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://app.manifest.build',
			placeholder: 'https://app.manifest.build',
			required: true,
			description: 'Manifest Cloud URL or your self-hosted Manifest URL',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description: 'Manifest agent API key, usually starting with mnfst_',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
				...MANIFEST_ATTRIBUTION_HEADERS,
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			method: 'GET',
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/models',
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
				...MANIFEST_ATTRIBUTION_HEADERS,
			},
		},
	};
}
