import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';
export declare class ManifestApi implements ICredentialType {
    name: string;
    displayName: string;
    icon: {
        readonly light: "file:../nodes/Manifest/manifest-logo.svg";
        readonly dark: "file:../nodes/Manifest/manifest-logo.dark.svg";
    };
    documentationUrl: string;
    properties: INodeProperties[];
    authenticate: IAuthenticateGeneric;
    test: ICredentialTestRequest;
}
