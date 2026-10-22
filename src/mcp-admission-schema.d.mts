export declare const MCP_ADMISSION_LIMITS: Readonly<{
  serversPerRun: 8;
  executionHostsPerServer: 64;
  identifierCharacters: 128;
  endpointCharacters: 2048;
  policyBytes: number;
}>;
export declare const MCP_ADMISSION_IDENTIFIER_PATTERN = "^[\\u0021-\\u007e]{1,128}(?![\\s\\S])";
type IdentifierSchema = {
  readonly type: "string";
  readonly pattern: typeof MCP_ADMISSION_IDENTIFIER_PATTERN;
};
type EndpointSchema = {
  readonly type: "string";
  readonly minLength: 1;
  readonly maxLength: 2048;
};
export declare const mcpAdmissionPolicySchema: {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly title: "Operator MCP run admission policy v1";
  readonly type: "object";
  readonly additionalProperties: false;
  readonly required: readonly ["version", "servers"];
  readonly properties: {
    readonly version: { readonly const: 1; readonly type: "integer" };
    readonly servers: {
      readonly type: "object";
      readonly propertyNames: IdentifierSchema;
      readonly additionalProperties: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly required: readonly ["url", "gatewayUrl", "serverHostId", "executionHostIds"];
        readonly properties: {
          readonly url: EndpointSchema;
          readonly gatewayUrl: EndpointSchema;
          readonly serverHostId: IdentifierSchema;
          readonly executionHostIds: {
            readonly type: "array";
            readonly minItems: 1;
            readonly maxItems: 64;
            readonly items: IdentifierSchema;
          };
        };
      };
    };
  };
};
export declare const mcpRunBindingSchema: {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly title: "MCP run delivery binding v1";
  readonly type: "object";
  readonly additionalProperties: false;
  readonly required: readonly ["runId", "executionHostId", "serverHostId", "gatewayUrl"];
  readonly properties: {
    readonly runId: IdentifierSchema;
    readonly executionHostId: IdentifierSchema;
    readonly serverHostId: IdentifierSchema;
    readonly gatewayUrl: EndpointSchema;
    readonly authorizedCrossHost: { readonly type: "boolean" };
  };
};
