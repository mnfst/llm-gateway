"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManifestApi = void 0;
const attribution_1 = require("../nodes/shared/attribution");
class ManifestApi {
    constructor() {
        this.name = 'manifestApi';
        this.displayName = 'Manifest API';
        this.icon = {
            light: 'file:../nodes/Manifest/manifest-logo.svg',
            dark: 'file:../nodes/Manifest/manifest-logo.dark.svg',
        };
        this.documentationUrl = 'https://manifest.build/docs';
        this.properties = [
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
        this.authenticate = {
            type: 'generic',
            properties: {
                headers: {
                    Authorization: '=Bearer {{$credentials.apiKey}}',
                    ...attribution_1.MANIFEST_ATTRIBUTION_HEADERS,
                },
            },
        };
        this.test = {
            request: {
                method: 'GET',
                baseURL: '={{$credentials.baseUrl}}',
                url: '/v1/models',
                headers: {
                    Authorization: '=Bearer {{$credentials.apiKey}}',
                    ...attribution_1.MANIFEST_ATTRIBUTION_HEADERS,
                },
            },
        };
    }
}
exports.ManifestApi = ManifestApi;
//# sourceMappingURL=ManifestApi.credentials.js.map