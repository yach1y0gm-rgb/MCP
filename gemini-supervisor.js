import { GoogleGenAI } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// Configuration
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_MODEL = "gemini-3.6-flash";

const MCP_SERVER = path.join(
    __dirname,
    "promptdictionary-readonly.js"
);

const PROJECT_ROOT =
    "E:\\tools\\AI\\project\\PromptDictionary";

const PROMPT_DIR = path.join(
    __dirname,
    "prompts"
);

const SUPERVISOR_PROMPT_FILE = path.join(
    PROMPT_DIR,
    "supervisor.txt"
);

const QWEN_PROMPT_FILE = path.join(
    PROMPT_DIR,
    "qwen.txt"
);

const TASK_FILE = path.join(
    PROMPT_DIR,
    "task.txt"
);

const QWEN_CMD = "qwen.cmd";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    console.error("GEMINI_API_KEY is not set.");
    process.exit(1);
}

// ============================================================
// Gemini
// ============================================================

const gemini = new GoogleGenAI({
    apiKey
});

// ============================================================
// Gemini API Rate Limit
// ============================================================

const GEMINI_RPM_LIMIT = 5;
const GEMINI_RATE_WINDOW_MS = 60 * 1000;
const GEMINI_MAX_RETRIES = 3;

const geminiRequestTimestamps = [];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function pruneGeminiRequestTimestamps() {
    const now = Date.now();

    while (
        geminiRequestTimestamps.length > 0 &&
        now - geminiRequestTimestamps[0] >= GEMINI_RATE_WINDOW_MS
    ) {
        geminiRequestTimestamps.shift();
    }
}

async function waitForGeminiRateLimit() {
    while (true) {
        pruneGeminiRequestTimestamps();

        if (
            geminiRequestTimestamps.length <
            GEMINI_RPM_LIMIT
        ) {
            return;
        }

        const oldestRequest =
            geminiRequestTimestamps[0];

        const waitMs =
            GEMINI_RATE_WINDOW_MS -
            (Date.now() - oldestRequest) +
            100;

        console.log(
            `\n===== Gemini Rate Limit =====`
        );

        console.log(
            `直近1分のGemini APIリクエスト数: ` +
            `${geminiRequestTimestamps.length}/${GEMINI_RPM_LIMIT}`
        );

        console.log(
            `約${Math.ceil(waitMs / 1000)}秒待機します。`
        );

        await sleep(waitMs);
    }
}

function extractRetryDelayMs(error) {
    const retryDelay =
        error?.details
            ?.find(
                detail =>
                    detail["@type"] ===
                    "type.googleapis.com/google.rpc.RetryInfo"
            )
            ?.retryDelay;

    if (!retryDelay) {
        return null;
    }

    const match =
        String(retryDelay).match(
            /^(\d+(?:\.\d+)?)s$/
        );

    if (!match) {
        return null;
    }

    return Math.ceil(
        Number(match[1]) * 1000
    );
}

function isDailyQuotaExceeded(error) {
    return error?.details?.some(
        detail =>
            detail["@type"] ===
            "type.googleapis.com/google.rpc.QuotaFailure" &&
            detail.violations?.some(
                violation =>
                    String(violation.quotaId ?? "")
                        .includes("PerDay")
            )
    ) ?? false;
}

async function generateGeminiContent(request) {
    for (
        let attempt = 0;
        attempt <= GEMINI_MAX_RETRIES;
        attempt++
    ) {
        await waitForGeminiRateLimit();

        geminiRequestTimestamps.push(
            Date.now()
        );

        try {
            return await gemini.models.generateContent(
                request
            );
        } catch (error) {
            if (error?.status !== 429) {
                throw error;
            }
        
            if (isDailyQuotaExceeded(error)) {
                console.error(
                    "\n===== Gemini Daily Quota Exceeded ====="
                );
        
                console.error(
                    "Gemini APIの日次無料枠を使い切りました。"
                );
        
                console.error(
                    "自動再試行は行いません。"
                );
        
                throw error;
            }
        
            if (attempt >= GEMINI_MAX_RETRIES) {
                throw error;
            }
        
            const retryDelayMs =
                extractRetryDelayMs(error);
        
            const waitMs =
                retryDelayMs ??
                GEMINI_RATE_WINDOW_MS;
        
            console.warn(
                `\n===== Gemini 429 =====`
            );
        
            console.warn(
                `Gemini APIのレート制限に達しました。`
            );
        
            console.warn(
                `${Math.ceil(waitMs / 1000)}秒待機して再試行します。`
            );
        
            await sleep(waitMs);
        }
    }

    throw new Error(
        "Gemini request failed unexpectedly."
    );
}

function buildGeminiTools() {
    return [
        {
            functionDeclarations: [
                {
                    name: "get_file",
                    description:
                        "PromptDictionaryプロジェクト配下の指定されたファイルを読み取ります。読み取り専用です。",
                    parameters: {
                        type: "object",
                        properties: {
                            filePath: {
                                type: "string",
                                description:
                                    "プロジェクトルートからの相対ファイルパス"
                            }
                        },
                        required: ["filePath"]
                    }
                },
                {
                    name: "get_project_structure",
                    description:
                        "PromptDictionaryプロジェクトのトップレベル構造を取得します。読み取り専用です。",
                    parameters: {
                        type: "object",
                        properties: {}
                    }
                },
                {
                    name: "get_document",
                    description:
                        "PromptDictionaryのQWEN.md、SPEC.md、DESIGN.md、TODO.mdの内容を取得します。読み取り専用です。",
                    parameters: {
                        type: "object",
                        properties: {
                            document: {
                                type: "string",
                                enum: [
                                    "QWEN.md",
                                    "SPEC.md",
                                    "DESIGN.md",
                                    "TODO.md"
                                ]
                            }
                        },
                        required: ["document"]
                    }
                },
                {
                    name: "get_git_status",
                    description:
                        "PromptDictionaryプロジェクトの現在のGit状態を取得します。読み取り専用です。",
                    parameters: {
                        type: "object",
                        properties: {}
                    }
                }
            ]
        }
    ];
}

async function executeMcpTool(functionCall) {
    const name = functionCall.name;
    const args = functionCall.args ?? {};

    console.log(
        `\n===== Gemini MCP Tool Call =====\n${name}`
    );

    console.log(
        JSON.stringify(args, null, 2)
    );

    const result = await mcpClient.callTool({
        name,
        arguments: args
    });

    const text = extractText(result);

    console.log(
        "\n===== MCP Tool Result =====\n"
    );

    console.log(text);

    return text;
}

// ============================================================
// MCP
// ============================================================

const mcpClient = new Client({
    name: "gemini-supervisor",
    version: "1.0.0"
});

const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER]
});

// ============================================================
// Utility
// ============================================================

function extractText(result) {
    if (!result?.content) {
        return "";
    }

    return result.content
        .filter(item => item.type === "text")
        .map(item => item.text)
        .join("\n");
}

function extractQwenResult(output) {
    try {
        const events = JSON.parse(output);

        if (Array.isArray(events)) {
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
        }

        return output;
    } catch {
        return output;
    }
}

async function readPromptFile(filePath) {
    try {
        return await readFile(filePath, "utf8");
    } catch (error) {
        throw new Error(
            `Prompt file could not be read:\n${filePath}\n${error.message}`
        );
    }
}

function applyTemplate(template, values) {
    let result = template;

    for (const [key, value] of Object.entries(values)) {
        result = result.replaceAll(
            `{{${key}}}`,
            value ?? ""
        );
    }

    return result;
}

// ============================================================
// Qwen
// ============================================================

async function runQwen(prompt) {
    console.log("\n===== Qwen starting =====\n");

    return await new Promise((resolve, reject) => {
        /*
         * Windows環境ではqwen.cmdを使用する。
         *
         * Qwen CLI 0.21.8では
         * -p / --prompt は使用しない。
         *
         * promptを位置引数として渡す。
         */

        const child = spawn(
            QWEN_CMD,
            [
                prompt,
                "-o",
                "json",
                "--approval-mode",
                "auto"
            ],
            {
                cwd: PROJECT_ROOT,
                windowsHide: true,
                shell: true
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
    });
}

// ============================================================
// Command
// ============================================================

async function runCommand(command, args) {
    return await new Promise((resolve, reject) => {
        const child = spawn(
            command,
            args,
            {
                cwd: PROJECT_ROOT,
                windowsHide: true,
                shell: true
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
            resolve({
                code,
                stdout,
                stderr
            });
        });
    });
}

// ============================================================
// Main
// ============================================================

async function main() {
    try {
        console.log("========================================");
        console.log(" Gemini Supervisor - ONE TASK MODE");
        console.log("========================================");
        console.log("");

        // ----------------------------------------------------
        // 0. Read external prompts
        // ----------------------------------------------------

        const supervisorTemplate =
            await readPromptFile(
                SUPERVISOR_PROMPT_FILE
            );

        const qwenTemplate =
            await readPromptFile(
                QWEN_PROMPT_FILE
            );

        const task =
            (await readPromptFile(TASK_FILE)).trim();

        if (!task) {
            throw new Error(
                `TASK is empty:\n${TASK_FILE}`
            );
        }

        console.log("Allowed task:");
        console.log(task);
        console.log("");

        // ----------------------------------------------------
        // 1. MCP connect
        // ----------------------------------------------------

        await mcpClient.connect(transport);

        console.log("MCP connected.");

        // ----------------------------------------------------
        // 2. Read project information
        // ----------------------------------------------------

        const todoResult = await mcpClient.callTool({
            name: "get_document",
            arguments: {
                document: "TODO.md"
            }
        });

        const gitBeforeResult = await mcpClient.callTool({
            name: "get_git_status",
            arguments: {}
        });

        const todoText = extractText(todoResult);
        const gitBeforeText = extractText(
            gitBeforeResult
        );

        // ----------------------------------------------------
        // 3. Build Gemini supervisor prompt
        // ----------------------------------------------------

        const supervisorPrompt =
            applyTemplate(
                supervisorTemplate,
                {
                    TASK: task,
                    PROJECT_ROOT,
                    TODO: todoText,
                    GIT_BEFORE: gitBeforeText
                }
            );

        console.log(
            "\n===== Gemini Supervisor =====\n"
        );

        const geminiTools = buildGeminiTools();
        
        let contents = [
            {
                role: "user",
                parts: [
                    {
                        text: supervisorPrompt
                    }
                ]
            }
        ];
        
        let geminiText = "";
        
        const MAX_GEMINI_TURNS = 15;
        
        for (
            let turn = 0;
            turn < MAX_GEMINI_TURNS;
            turn++
        ) {
        
            const geminiResponse =
                await generateGeminiContent({
                    model: GEMINI_MODEL,
                    contents,
                    config: {
                        tools: geminiTools
                    }
                });
                
            const functionCalls =
                geminiResponse.functionCalls ?? [];
        
            if (functionCalls.length === 0) {
                geminiText =
                    geminiResponse.text ?? "";
        
                break;
            }
        
            console.log(
                `\n===== Gemini requested ${functionCalls.length} MCP tool(s) =====`
            );
        
            contents.push(
                geminiResponse.candidates[0].content
            );
        
            const functionResponses = [];
        
            for (const functionCall of functionCalls) {
        
                const result =
                    await executeMcpTool(functionCall);
        
                functionResponses.push({
                    functionResponse: {
                        name: functionCall.name,
                        response: {
                            result
                        }
                    }
                });
            }
        
            contents.push({
                role: "user",
                parts: functionResponses
            });
        }
        
        if (!geminiText) {
            throw new Error(
                "Gemini did not return supervisor text."
            );
        }
        
        console.log(geminiText);

        // ----------------------------------------------------
        // 4. Gemini result validation
        // ----------------------------------------------------
        
        if (!geminiText.trim()) {
            throw new Error(
                "Gemini returned empty supervisor text."
            );
        }

        console.log(
            "\n===== Gemini → Qwen =====\n"
        );

        console.log(
            `ONE TASK ONLY: ${task}`
        );

        // ----------------------------------------------------
        // 5. Build Qwen prompt
        // ----------------------------------------------------

        const qwenPrompt =
            applyTemplate(
                qwenTemplate,
                {
                    TASK: task,
                    PROJECT_ROOT,
                    TODO: todoText,
                    GIT_BEFORE: gitBeforeText,
                    GEMINI_RESULT: geminiText
                }
            );

        // ----------------------------------------------------
        // 6. Qwen implementation
        // ----------------------------------------------------

        const qwenResult =
            await runQwen(qwenPrompt);

        console.log(
            "\n===== Qwen Response =====\n"
        );

        console.log(qwenResult);

        // ----------------------------------------------------
        // 7. Supervisor build verification
        // ----------------------------------------------------

        console.log(
            "\n===== Supervisor Build Verification =====\n"
        );

        const buildResult =
            await runCommand(
                "dotnet",
                [
                    "build",
                    "ComfyUI.PromptDictionary.slnx"
                ]
            );

        console.log(
            `Build exit code: ${buildResult.code}`
        );

        if (buildResult.stdout) {
            console.log(buildResult.stdout);
        }

        if (buildResult.stderr) {
            console.error(buildResult.stderr);
        }

        // ----------------------------------------------------
        // 8. Git status after implementation
        // ----------------------------------------------------

        const gitAfterResult =
            await mcpClient.callTool({
                name: "get_git_status",
                arguments: {}
            });

        const gitAfterText =
            extractText(gitAfterResult);

        console.log(
            "\n===== Git Status After =====\n"
        );

        console.log(gitAfterText);

        // ----------------------------------------------------
        // 9. Final report
        // ----------------------------------------------------

        console.log(
            "\n========================================"
        );

        console.log(
            " ONE TASK RESULT"
        );

        console.log(
            "========================================"
        );

        console.log("");

        if (buildResult.code === 0) {
            console.log("BUILD: SUCCESS");
        } else {
            console.log("BUILD: FAILED");
        }

        console.log("");

        console.log("TASK:");
        console.log(task);

        console.log("");

        console.log("GEMINI RESULT:");
        console.log(geminiText);

        console.log("");

        console.log("QWEN RESULT:");
        console.log(qwenResult);

        console.log("");

        console.log("GIT BEFORE:");
        console.log(gitBeforeText);

        console.log("");

        console.log("GIT AFTER:");
        console.log(gitAfterText);

        console.log("");

        console.log(
            "========================================"
        );

        console.log(
            " ONE TASK MODE COMPLETE"
        );

        await notifyCompletion();

        console.log(
            "========================================"
        );

        if (buildResult.code !== 0) {
            process.exitCode = 1;
        }

    } catch (error) {
        console.error(
            "\nSupervisor error:"
        );
    
        console.error(error);
    
        // エラー通知音
        process.stdout.write("\x07");
    
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

async function notifyCompletion() {
    await runCommand(
        "powershell",
        [
            "-NoProfile",
            "-Command",
            "[console]::beep(1000,500)"
        ]
    );
}
