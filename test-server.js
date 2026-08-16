import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
    name: "promptdictionary-test",
    version: "1.0.0"
});

server.tool(
    "test_connection",
    "MCP接続テスト用のツールです。",
    {},
    async () => {
        return {
            content: [
                {
                    type: "text",
                    text: "MCP接続成功。PromptDictionary環境には変更を加えていません。"
                }
            ]
        };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
