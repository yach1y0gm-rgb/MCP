import { GoogleGenAI } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";

const GEMINI_MODEL = "gemini-3.6-flash";
const MCP_SERVER = "E:\\tools\\AI\\MCP\\promptdictionary-readonly.js";
const PROJECT_ROOT = "E:\\tools\\AI\\project\\PromptDictionary";

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

function extractText(result) {
    return result.content
        .filter(item => item.type === "text")
        .map(item => item.text)
        .join("\n");
}

function extractQwenResult(output) {
    try {
        const events = JSON.parse(output);

        const resultEvent = events.find(
            event =>
                event.type === "result" &&
                typeof event.result === "string"
        );

        if (resultEvent) {
            return resultEvent.result;
        }

        const assistantEvent = events.find(
            event =>
                event.type === "assistant" &&
                event.message?.content
        );

        if (assistantEvent) {
            return assistantEvent.message.content
                .filter(item => item.type === "text")
                .map(item => item.text)
                .join("\n");
        }

        return output;
    } catch {
        return output;
    }
}

async function runQwen(task) {
    const prompt = `
あなたはPromptDictionaryプロジェクトの実装担当AIです。

これはGemini監督AIからの作業指示です。

===== TASK =====
${task}

===== 今回の実行ルール =====

今回は接続テストです。

絶対に以下を行わないでください。

- コード変更
- ファイル作成
- ファイル削除
- ファイル移動
- Git操作
- Build
- アプリケーション実行

実際の実装は行わず、
「このTASKを実装する場合に必要となる変更対象」
と
「実装手順」
だけを回答してください。

現在のPromptDictionaryのCurrent Phase、
QWEN.md、
既存設計を尊重してください。

===== 回答形式 =====

RECEIVED:
指示を受信したか

TASK:
受け取ったタスク

TARGET:
変更対象となるファイルまたは機能

PLAN:
実装する場合の手順

===== END =====
`;

    console.log("\n===== Qwen starting =====\n");

    return await new Promise((resolve, reject) => {
        const child = spawn(
            "cmd.exe",
            ["/c", "qwen.cmd", "-o", "json"],
            {
                cwd: PROJECT_ROOT,
                windowsHide: true
            }
        );

        let stdout = "";
        let stderr = "";

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");

        child.stdout.on("data", data => {
            stdout += data;
        });

        child.stderr.on("data", data => {
            stderr += data;
        });

        child.on("error", error => {
            reject(error);
        });

        child.on("close", code => {
            if (stderr) {
                console.error("Qwen stderr:");
                console.error(stderr);
            }

            if (code !== 0) {
                reject(
                    new Error(
                        `Qwen exited with code ${code}\n${stderr}`
                    )
                );
                return;
            }

            resolve(extractQwenResult(stdout));
        });

        child.stdin.write(prompt);
        child.stdin.end();
    });
}

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

        const todoText = extractText(todoResult);
        const gitText = extractText(gitResult);

        const supervisorPrompt = `
あなたはPromptDictionaryプロジェクトの監督AIです。

以下のプロジェクト情報を分析してください。

===== TODO.md =====
${todoText}

===== Git Status =====
${gitText}

現在のCurrent Phaseの範囲内で、
次に実装すべき具体的なタスクを1つだけ決定してください。

ルール:

- Current Phase外は禁止
- 完了済みTODOは禁止
- 大規模リファクタリングは禁止
- 既存設計を尊重する
- 具体的なタスクを1つだけ出す

以下の形式で回答してください。

TASK:
タスク名

REASON:
理由

TARGET:
主な変更対象
`;

        console.log("\n===== Gemini Supervisor =====\n");

        const geminiResponse = await gemini.models.generateContent({
            model: GEMINI_MODEL,
            contents: supervisorPrompt
        });

        const geminiText = geminiResponse.text;

        console.log(geminiText);

        const taskMatch = geminiText.match(
            /TASK:\s*([\s\S]*?)(?=\nREASON:|\nTARGET:|$)/i
        );

        const task = taskMatch
            ? taskMatch[1].trim()
            : geminiText.trim();

        console.log("\n===== Gemini → Qwen =====\n");
        console.log(task);

        const qwenResult = await runQwen(task);

        console.log("\n===== Qwen Response =====\n");
        console.log(qwenResult);

        console.log("\n===== Supervisor Test Complete =====\n");
        console.log("Gemini → Qwen の指示受け渡しを確認しました。");
        console.log("今回、コード変更は許可していません。");

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