import https from "https";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import QwenDaemonClient from "./qwen-daemon-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = "E:\\tools\\AI\\project\\PromptDictionary";
const QWEN_DAEMON_URL = "http://127.0.0.1:4170";
const QWEN_COMMAND = process.env.QWEN_COMMAND || "qwen";
const QWEN_DAEMON_TIMEOUT_MS = 60 * 60 * 1000;
const QWEN_DAEMON_START_TIMEOUT_MS = 60000;
const QWEN_DAEMON_POLL_INTERVAL_MS = 1000;
const PROMPT_DIR = path.join(__dirname, "prompts");
const SUPERVISOR_PROMPT_FILE = path.join(PROMPT_DIR, "openrouter-supervisor.txt");
const TASK_FILE = path.join(PROMPT_DIR, "task.txt");
const MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const MAX_ITERATIONS = 5;
const MAX_QWEN_RESULT_CHARS = 12000;
const MAX_BUILD_RESULT_CHARS = 12000;
const MAX_GIT_RESULT_CHARS = 8000;
const OPENROUTER_MAX_RETRIES = 3;
const OPENROUTER_RETRY_DELAY_MS = 3000;
const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
    console.error("ERROR: OPENROUTER_API_KEY is not set.");
    process.exit(1);
}

const qwenClient = new QwenDaemonClient({
    baseUrl: QWEN_DAEMON_URL,
    timeoutMs: QWEN_DAEMON_TIMEOUT_MS,
    workspaceCwd: __dirname
});

async function readPromptFile(filePath) {
    try {
        return await readFile(filePath, "utf8");
    } catch (error) {
        throw new Error(["Prompt file could not be read:", filePath, error.message].join("\n"));
    }
}

function applyTemplate(template, values) {
    let result = template;
    for (const [key, value] of Object.entries(values)) {
        result = result.replaceAll(`{{${key}}}`, value ?? "");
    }
    return result;
}

function limitText(text, maxChars) {
    if (!text) return "";
    if (text.length <= maxChars) return text;
    return [text.slice(0, maxChars), "", `[TRUNCATED: original ${text.length} chars]`].join("\n");
}

async function ensureQwenDaemon() {
    console.log("\n===== Qwen Daemon =====");

    try {
        const capabilities = await qwenClient.capabilities();
        if (capabilities?.mode === "http-bridge") {
            console.log(`Qwen daemon already running at ${QWEN_DAEMON_URL}`);
            return;
        }
        console.log("Qwen daemon responded, but mode is not http-bridge. Attempting to start HTTP bridge.");
    } catch {
        console.log("Qwen daemon is not available. Starting qwen serve --http-bridge...");
    }

    let child;
    try {
        child = spawn(QWEN_COMMAND, ["serve", "--http-bridge"], {
            cwd: __dirname,
            detached: true,
            windowsHide: true,
            shell: true,
            stdio: "ignore"
        });
        child.unref();
    } catch (error) {
        throw new Error(`Failed to start qwen serve --http-bridge: ${error.message}`);
    }

    const deadline = Date.now() + QWEN_DAEMON_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const health = await qwenClient.health();
            const capabilities = await qwenClient.capabilities();
            if (health?.status === "ok" && capabilities?.mode === "http-bridge") {
                console.log("Qwen daemon is ready.");
                return;
            }
        } catch {
            // Daemon is still starting.
        }
        await new Promise(resolve => setTimeout(resolve, QWEN_DAEMON_POLL_INTERVAL_MS));
    }
    throw new Error(`Qwen daemon did not become ready within ${QWEN_DAEMON_START_TIMEOUT_MS} ms.`);
}

async function runCommand(command, args) {
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: PROJECT_ROOT, windowsHide: true, shell: true });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", data => { stdout += data; });
        child.stderr.on("data", data => { stderr += data; });
        child.on("error", reject);
        child.on("close", code => resolve({ code, stdout, stderr }));
    });
}

async function runQwen(prompt) {
    console.log("\n===== Qwen HTTP Bridge =====\n");
    try {
        const result = await qwenClient.run(prompt);
        console.log(`Qwen stopReason: ${result.stopReason ?? "(none)"}`);
        console.log(`Qwen response length: ${result.response.length} chars`);
        return result.response;
    } catch (error) {
        console.error("\n===== Qwen execution failed =====\n");
        console.error(error.message);
        throw error;
    }
}

async function reviewWithOpenRouter(prompt) {
    const body = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }] });
    let lastError = null;
    for (let attempt = 1; attempt <= OPENROUTER_MAX_RETRIES; attempt++) {
        try {
            console.log(`Supervisor API attempt ${attempt}/${OPENROUTER_MAX_RETRIES}`);
            return await new Promise((resolve, reject) => {
                const req = https.request({
                    hostname: "openrouter.ai",
                    path: "/api/v1/chat/completions",
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(body)
                    }
                }, res => {
                    let responseData = "";
                    res.setEncoding("utf8");
                    res.on("data", chunk => { responseData += chunk; });
                    res.on("end", () => {
                        let parsed;
                        try { parsed = JSON.parse(responseData); }
                        catch { reject(new Error("OpenRouter returned invalid JSON.")); return; }
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            const error = new Error(`OpenRouter HTTP ${res.statusCode}\n${JSON.stringify(parsed, null, 2)}`);
                            error.statusCode = res.statusCode;
                            reject(error);
                            return;
                        }
                        resolve(parsed);
                    });
                });
                req.on("error", reject);
                req.write(body);
                req.end();
            });
        } catch (error) {
            lastError = error;
            console.error(`Supervisor API error: ${error.message}`);
            if (attempt < OPENROUTER_MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, OPENROUTER_RETRY_DELAY_MS * attempt));
            }
        }
    }
    throw lastError;
}

async function runSupervisorReview({ supervisorTemplate, task, qwenResult, buildRequired, buildText, gitDiff, iteration }) {
    const supervisorPrompt = applyTemplate(supervisorTemplate, {
        PROJECT_ROOT,
        TASK: task,
        QWEN_RESULT: limitText(qwenResult, MAX_QWEN_RESULT_CHARS),
        BUILD_RESULT: limitText(buildText, MAX_BUILD_RESULT_CHARS),
        GIT_DIFF: limitText(gitDiff, MAX_GIT_RESULT_CHARS),
        ITERATION: String(iteration),
        BUILD_REQUIRED: String(buildRequired)
    });

    console.log(`Supervisor prompt size: ${supervisorPrompt.length} chars`);
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await reviewWithOpenRouter(supervisorPrompt);
            if (response?.error) {
                throw new Error(`OpenRouter API error (code ${response.error.code ?? "unknown"}): ${response.error.message ?? "Unknown OpenRouter error."}`);
            }
            console.log("\n===== Raw Nemotron Response =====\n");
            console.log(JSON.stringify(response, null, 2));
            const reviewText = response.choices?.[0]?.message?.content ?? "";
            if (!reviewText.trim()) throw new Error("Nemotron returned empty review.");
            return {
                text: reviewText,
                model: response.model ?? "(unknown)",
                provider: response.provider ?? "(unknown)",
                usage: response.usage ?? {}
            };
        } catch (error) {
            lastError = error;
            console.error(`OpenRouter review failed (attempt ${attempt}/3)`);
            console.error(error.message);
            if (attempt < 3) {
                const delay = 2000 * attempt;
                console.log(`Retrying in ${delay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

function parseSupervisorDecision(reviewText, buildRequired, buildExitCode) {
    let parsed;
    try {
        parsed = JSON.parse(reviewText.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim());
    } catch {
        return {
            decision: "FIX",
            summary: "SupervisorのJSON解析に失敗しました。安全側に倒してFIXとします。",
            instructions: [
                "現在の実装状態を確認してください。",
                buildRequired && buildExitCode !== 0 ? "Buildエラーを確認して修正してください。" : "作業内容と実際の変更状態を再確認してください。"
            ],
            continue: true
        };
    }
    if (parsed.decision !== "PASS" && parsed.decision !== "FIX") {
        return {
            ...parsed,
            decision: "FIX",
            summary: "SupervisorのdecisionがPASS/FIXではありません。",
            instructions: ["現在の実装状態を再確認してください。"],
            continue: true
        };
    }
    if (buildRequired && buildExitCode !== 0 && parsed.decision === "PASS") {
        return {
            ...parsed,
            decision: "FIX",
            summary: `${parsed.summary ?? ""}\nBUILD_REQUIRED=true ですがBuildが失敗しているためPASSは禁止されています。`,
            continue: true
        };
    }
    return parsed;
}

async function runBuild() {
    console.log("\n===== Build Verification =====\n");
    const result = await runCommand("dotnet", ["build", "ComfyUI.PromptDictionary.slnx"]);
    console.log(`Build exit code: ${result.code}`);
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    return {
        code: result.code,
        text: [`Exit code: ${result.code}`, "", "STDOUT:", limitText(result.stdout, MAX_BUILD_RESULT_CHARS), "", "STDERR:", limitText(result.stderr, MAX_BUILD_RESULT_CHARS)].join("\n")
    };
}

async function getGitDiff() {
    const stat = await runCommand("git", ["diff", "--stat"]);
    const nameStatus = await runCommand("git", ["diff", "--name-status"]);
    return ["===== Diff Stat =====", stat.stdout, "", "===== Changed Files =====", nameStatus.stdout].join("\n");
}

async function notifyCompletion() {
    await runCommand("powershell", ["-NoProfile", "-Command", "[console]::beep(600,200); [console]::beep(800,200)"]);
}

function createFixQwenPrompt({ task, decision, buildText }) {
    const instructions = Array.isArray(decision.instructions) ? decision.instructions : [decision.summary ?? "問題を調査して修正してください。"];
    return [
        "前回の作業についてSupervisorから修正指示が出ています。",
        "",
        "===== Original Task =====",
        task,
        "",
        "===== Supervisor Summary =====",
        decision.summary ?? "",
        "",
        "===== 修正指示 =====",
        ...instructions.map((instruction, index) => `${index + 1}. ${instruction}`),
        "",
        "===== Build Result =====",
        limitText(buildText, MAX_BUILD_RESULT_CHARS),
        "",
        "===== 作業ルール =====",
        "Supervisorの指摘を確認してください。",
        "Task本文の禁止事項を最優先してください。",
        "実ファイルを確認してから作業してください。",
        "推測だけでAPIや型を判断しないでください。",
        "Taskが調査のみの場合、コード変更を行わないでください。",
        "Taskでコード変更が禁止されている場合、ファイルを変更しないでください。",
        "TaskでBuildが禁止されている場合、Buildを実行しないでください。",
        "Taskに明示されていない変更・改善・リファクタリングを行わないでください。",
        "作業完了後、実施内容と結果を日本語で報告してください."
    ].join("\n");
}

async function main() {
    try {
        console.log("========================================");
        console.log(" OpenRouter Supervisor");
        console.log("========================================\n");

        await ensureQwenDaemon();

        const supervisorTemplate = await readPromptFile(SUPERVISOR_PROMPT_FILE);
        const task = (await readPromptFile(TASK_FILE)).trim();
        if (!task) throw new Error("TASK is empty.");

        console.log("Task:");
        console.log(task);
        console.log("");

        const buildRequired = /^\s*BUILD_REQUIRED\s*:\s*true\s*$/im.test(task);
        console.log(`BUILD_REQUIRED: ${buildRequired}`);

        let qwenPrompt = [
            "以下のTaskを厳密に実行してください。",
            "",
            "===== Task =====",
            task,
            "",
            "===== 実行開始時の最優先手順 =====",
            "これはE:\\tools\\AI\\MCP workspace上の調査Taskです。",
            "まず次の実ファイルを直接読み取ってください。",
            "1. E:\\tools\\AI\\MCP\\openrouter-supervisor.js",
            "2. E:\\tools\\AI\\MCP\\prompts\\openrouter-supervisor.txt",
            "3. E:\\tools\\AI\\MCP\\prompts\\task.txt",
            "上記3ファイル以外のメモリファイル、過去のAI Review資料、PromptDictionary側ファイルを先に参照しないでください。",
            "特に .qwen のmemory配下にある ai-review.js などは今回の調査対象ではありません。",
            "必ず上記の実ファイルの内容を確認した後、その内容だけを根拠に調査結果をまとめてください。",
            "",
            "===== 最重要ルール =====",
            "Task本文に明示された禁止事項を最優先してください。",
            "Taskに明示されていない変更・改善・リファクタリングを行わないでください。",
            "調査Taskの場合は、実ファイルを直接確認し、確認できた事実と推測を明確に分離してください。",
            "推測だけでAPI・型・ライブラリ仕様を判断しないでください。",
            "",
            "===== 作業完了時の報告 =====",
            "変更ファイル:",
            "-",
            "",
            "実施内容:",
            "-",
            "",
            "Build/Test結果:",
            "-",
            "",
            "残存問題:",
            "-"
        ].join("\n");

        for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
            console.log("\n========================================");
            console.log(` Supervisor Iteration ${iteration}/${MAX_ITERATIONS}`);
            console.log("========================================\n");

            let qwenResult;
            try {
                qwenResult = await runQwen(qwenPrompt);
            } catch (error) {
                qwenResult = `Qwen execution failed:\n${error.message}`;
                console.error(qwenResult);
            }

            let build;
            if (buildRequired) {
                build = await runBuild();
            } else {
                console.log("\n===== Build Skipped =====\n");
                console.log("This task does not require build verification.");
                build = { code: null, text: "Build skipped." };
            }

            const gitDiffText = await getGitDiff();

            console.log("\n===== Nemotron Supervisor =====\n");
            const review = await runSupervisorReview({ supervisorTemplate, task, qwenResult, buildRequired, buildText: build.text, gitDiff: gitDiffText, iteration });

            console.log("\nReview Result:");
            console.log(review.text);
            console.log("");
            console.log("Model:");
            console.log(review.model);
            console.log("");
            console.log("Provider:");
            console.log(review.provider);
            console.log("");
            console.log("Usage:");
            console.log(JSON.stringify(review.usage, null, 2));

            const decision = parseSupervisorDecision(review.text, buildRequired, build.code);
            console.log("\n===== Supervisor Decision =====\n");
            console.log(JSON.stringify(decision, null, 2));

            if (decision.decision === "PASS" && (!buildRequired || build.code === 0)) {
                console.log("\n========================================");
                console.log(" SUPERVISOR PASS");
                console.log("========================================");
                await notifyCompletion();
                return;
            }

            if (iteration >= MAX_ITERATIONS) {
                console.error("\n========================================");
                console.error(" SUPERVISOR FAILED");
                console.error("========================================");
                console.error(`最大試行回数 ${MAX_ITERATIONS} 回に到達しました。`);
                console.error("人間による確認が必要です。");
                process.exitCode = 2;
                return;
            }

            qwenPrompt = createFixQwenPrompt({ task, decision, buildText: build.text });
            console.log("\n===== Returning to Qwen =====\n");
            console.log(qwenPrompt);
        }
    } catch (error) {
        console.error("\n===== Supervisor Error =====");
        console.error(error);
        process.stdout.write("\x07");
        process.exitCode = 1;
    }
}

main();
