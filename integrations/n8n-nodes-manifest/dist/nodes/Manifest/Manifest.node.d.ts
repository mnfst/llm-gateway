import type { IDataObject, IExecuteFunctions, IN8nHttpFullResponse, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
export declare function withoutRouteManagedStream(body: IDataObject): IDataObject;
export declare function parseServerSentEvents(body: string): IDataObject;
export declare function parseManifestResponse(response: IN8nHttpFullResponse): unknown;
export declare class Manifest implements INodeType {
    description: INodeTypeDescription;
    execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]>;
}
