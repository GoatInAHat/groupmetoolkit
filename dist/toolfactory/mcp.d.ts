import { McpServer } from "@modelcontextprotocol/server";
export declare const server: McpServer;
export declare function serve(): Promise<void>;
export interface HttpOptions {
    port?: number;
    host?: string;
    path?: string;
    /** Mint a fresh pairing token, print `<url>#<token>`, and require it from every client. */
    pair?: boolean;
}
/** Serve over MCP streamable HTTP instead of stdio. Opt-in; stdio stays the default transport. */
export declare function serveHttp(options?: HttpOptions): Promise<void>;
