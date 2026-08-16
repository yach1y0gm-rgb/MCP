import { GoogleGenAI } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const GEMINI_MODEL = "gemini-3.6-flash";
const MCP_SERVER = "E:\\tools\\AI\\MCP\\promptdictionary-readonly.js";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    console.error("GEMINI_API_KEY is not set.");
    process.exit(1);
}

const gemini = new GoogleGenAI({
    apiKey
});

const mcpClient = new Client({
    name: "gemini-supervisor",
    version: "1.0.0"
});

const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER]
});

async function main() {
    try {
        console.log("Connecting to PromptDictionary readonly MCP...");

        await mcpClient.connect(transport);

        console.log("MCP connected.");

        const todoResult = await mcpClient.callTool({
            name: "get_document",
            arguments: {
                document: "TODO.md"
            }
        });

        const gitResult = await mcpClient.callTool({
            name: "get_git_status",
            arguments: {}
        });

        const todoText = todoResult.content
            .filter(item => item.type === "text")
            .map(item => item.text)
            .join("\n");

        const gitText = gitResult.content
            .filter(item => item.type === "text")
            .map(item => item.text)
            .join("\n");

        console.log("\n===== PromptDictionary Status =====\n");
        console.log(todoText);
        console.log("\n===== Git Status =====\n");
        console.log(gitText);

        const prompt = `
あなたはPromptDictionaryプロジェクトの監督AIです。

以下は現在のプロジェクト情報です。

===== TODO.md =====
${todoText}

===== Git Status =====
${gitText}

この情報を分析し、現在のCurrent Phaseの範囲内で
「次に実装すべき具体的なタスク」を1つだけ提案してください。

以下のルールを守ってください。

- Current Phase外の機能を提案しない
- 既存設計を尊重する
- 大規模リファクタリングを提案しない
- 既に完了しているTODOを提案しない
- 具体的な実装対象を示す
- 理由を簡潔に説明する

以下の形式で回答してください。

TASK:
タスク名

REASON:
理由

TARGET:
変更対象となる主なファイルまたは機能
`;

        console.log("\n===== Gemini Supervisor =====\n");

        const response = await gemini.models.generateContent({
            model: GEMINI_MODEL,
            contents: prompt
        });

        console.log(response.text);

    } catch (error) {
        console.error("\nSupervisor error:");
        console.error(error);
        process.exitCode = 1;
    } finally {
        try {
            await mcpClient.close();
        } catch {
            // Ignore MCP close errors.
        }
    }
}

main();