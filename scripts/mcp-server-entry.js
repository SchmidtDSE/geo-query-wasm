/**
 * Bundle entry point for vendor/mcp-server-sdk.js: the server half of the MCP
 * SDK, pre-bundled so the worker imports it by relative path with no module
 * host at runtime.
 *
 * Rebuild with `pnpm run build:vendor`.
 */
export { Server } from '@modelcontextprotocol/sdk/server/index.js';
export {
    ListToolsRequestSchema, CallToolRequestSchema,
    ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema,
    ListPromptsRequestSchema, GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
