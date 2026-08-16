import https from "https";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ============================================================
// Configuration
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT =
    "E:\\tools\\AI\\project\\PromptDictionary";

const PROMPT_DIR =
    path.join(__dirname, "prompts");

const SUPERVISOR_PROMPT_FILE =
    path.join(
        PROMPT_DIR,
        "openrouter-supervisor.txt"
    );

const TASK_FILE =
    path.join(
        PROMPT_DIR,
        "task.txt"
    );

const QWEN_CMD = "qwen.cmd";

const MODEL =
    "nvidia/nemotron-3-ultra-550b-a55b:free";

const apiKey =
    process.env.OPENROUTER_API_KEY;

if (!apiKey) {
    console.error(
        "ERROR: OPENROUTER_API_KEY is not set."
    );

    process.exit(1);
}

// ============================================================
// Utility
// ============================================================

function sleep(ms) {
    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}

async function readPromptFile(filePath) {
    try {
        return await readFile(
            filePath,
            "utf8"
        );
    } catch (error) {
        throw new Error(
            `Prompt file could not be read:\n${filePath}\n${error.message}`
        );
    }
}

function applyTemplate(template, values) {
    let result = template;

    for (
        const [key, value]
        of Object.entries(values)
    ) {
        result =
            result.replaceAll(
                `{{${key}}}`,
                value ?? ""
            );
    }

    return result;
}

function extractQwenResult(output) {
    try {
        const events = JSON.parse(output);
        if (!Array.isArray(events)) return output;

        // 1. result イベントを優先
        const resultEvent = events.find(
            e => e.type === "result" && typeof e.result === "string"
        );
        if (resultEvent) return resultEvent.result;

        // 2. 最後の assistant の text を結合
        const assistantTexts = events
            .filter(e => e.type === "assistant" && e.message?.content)
            .flatMap(e => e.message.content)
            .filter(c => c.type === "text")
            .map(c => c.text);

        if (assistantTexts.length > 0) {
            return assistantTexts.join("\n");
        }

        return output;
    } catch {
        return output;
    }
}

// ============================================================
// Command
// ============================================================

async function runCommand(
    command,
    args
) {
    return await new Promise(
        (resolve, reject) => {

            const child =
                spawn(
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

            child.stdout.setEncoding(
                "utf8"
            );

            child.stderr.setEncoding(
                "utf8"
            );

            child.stdout.on(
                "data",
                data => {
                    stdout += data;
                }
            );

            child.stderr.on(
                "data",
                data => {
                    stderr += data;
                }
            );

            child.on(
                "error",
                error => {
                    reject(error);
                }
            );

            child.on(
                "close",
                code => {
                    resolve({
                        code,
                        stdout,
                        stderr
                    });
                }
            );
        }
    );
}

// ============================================================
// Qwen
// ============================================================

async function runQwen(prompt) {
    console.log("\n===== Qwen starting =====\n");

    // 一時ファイルにプロンプトを書く
    const tempFile = join(
        tmpdir(),
        `qwen-prompt-${randomBytes(8).toString("hex")}.txt`
    );
    await writeFile(tempFile, prompt, "utf8");

    try {
        return await new Promise((resolve, reject) => {
            // ファイル内容を stdin に流す形で起動
            const child = spawn(
                `qwen -y -o json < "${tempFile}"`,
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
                // 進行状況が見えるようにする
                process.stdout.write(".");
            });

            child.stderr.on("data", data => {
                stderr += data;
                console.error(data);
            });

            child.on("error", reject);

            child.on("close", code => {
                console.log(""); // 改行
                if (code !== 0) {
                    reject(new Error(`Qwen exited with code ${code}\n${stderr}`));
                    return;
                }
                resolve(extractQwenResult(stdout));
            });
        });
    } finally {
        // 一時ファイルを削除
        try {
            await unlink(tempFile);
        } catch {
            // 無視
        }
    }
}

// ============================================================
// OpenRouter
// ============================================================

async function reviewWithOpenRouter(
    prompt
) {

    const requestBody = {
        model: MODEL,

        messages: [
            {
                role: "user",
                content: prompt
            }
        ]
    };

    const body =
        JSON.stringify(
            requestBody
        );

    const options = {
        hostname:
            "openrouter.ai",

        path:
            "/api/v1/chat/completions",

        method:
            "POST",

        headers: {
            "Authorization":
                `Bearer ${apiKey}`,

            "Content-Type":
                "application/json",

            "Content-Length":
                Buffer.byteLength(body)
        }
    };

    return await new Promise(
        (resolve, reject) => {

            const req =
                https.request(
                    options,
                    res => {

                        let responseData =
                            "";

                        res.setEncoding(
                            "utf8"
                        );

                        res.on(
                            "data",
                            chunk => {
                                responseData +=
                                    chunk;
                            }
                        );

                        res.on(
                            "end",
                            () => {

                                let response;

                                try {
                                    response =
                                        JSON.parse(
                                            responseData
                                        );
                                } catch {
                                    reject(
                                        new Error(
                                            "OpenRouter returned invalid JSON."
                                        )
                                    );

                                    return;
                                }

                                if (
                                    res.statusCode < 200 ||
                                    res.statusCode >= 300
                                ) {
                                    reject(
                                        new Error(
                                            `OpenRouter HTTP ${res.statusCode}\n` +
                                            JSON.stringify(
                                                response,
                                                null,
                                                2
                                            )
                                        )
                                    );

                                    return;
                                }

                                resolve(
                                    response
                                );
                            }
                        );
                    }
                );

            req.on(
                "error",
                reject
            );

            req.write(body);
            req.end();
        }
    );
}

// ============================================================
// Notification
// ============================================================

async function notifyCompletion() {

    await runCommand(
        "powershell",
        [
            "-NoProfile",
            "-Command",
            "[console]::beep(600,200); [console]::beep(800,200)"
        ]
    );
}

// ============================================================
// Main
// ============================================================

async function main() {

    try {

        console.log(
            "========================================"
        );

        console.log(
            " OpenRouter Supervisor"
        );

        console.log(
            "========================================"
        );

        console.log("");

        // ----------------------------------------------------
        // 1. External prompts
        // ----------------------------------------------------

        const supervisorTemplate =
            await readPromptFile(
                SUPERVISOR_PROMPT_FILE
            );

        const task =
            (
                await readPromptFile(
                    TASK_FILE
                )
            ).trim();

        if (!task) {
            throw new Error(
                "TASK is empty."
            );
        }

        console.log(
            "Task:"
        );

        console.log(
            task
        );

        console.log("");

        // ----------------------------------------------------
        // 2. Project information
        // ----------------------------------------------------

        const todoResult =
            await runCommand(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    "Get-Content " +
                    "'docs/TODO.md' " +
                    "-Raw"
                ]
            );

        const todoText =
            todoResult.stdout;

        const gitBeforeResult =
            await runCommand(
                "git",
                [
                    "status",
                    "--short"
                ]
            );

        const gitBeforeText =
            gitBeforeResult.stdout;

        // ----------------------------------------------------
        // 3. Qwen
        // ----------------------------------------------------

        const qwenPrompt =
            [
                task,
                "",
                "作業完了後、実施内容と結果を日本語で報告してください。"
            ].join("\n");

        const qwenResult =
            await runQwen(
                qwenPrompt
            );

        console.log(
            "\n===== Qwen Response =====\n"
        );

        console.log(
            qwenResult
        );

        // ----------------------------------------------------
        // 4. Build
        // ----------------------------------------------------

        console.log(
            "\n===== Build Verification =====\n"
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
            console.log(
                buildResult.stdout
            );
        }

        if (buildResult.stderr) {
            console.error(
                buildResult.stderr
            );
        }

        const buildText =
            [
                `Exit code: ${buildResult.code}`,
                "",
                "STDOUT:",
                buildResult.stdout,
                "",
                "STDERR:",
                buildResult.stderr
            ].join("\n");

        // ----------------------------------------------------
        // 5. Git after
        // ----------------------------------------------------

        const gitAfterResult =
            await runCommand(
                "git",
                [
                    "status",
                    "--short"
                ]
            );

        const gitAfterText =
            gitAfterResult.stdout;

        // ----------------------------------------------------
        // 6. Nemotron review
        // ----------------------------------------------------

        console.log(
            "\n===== Nemotron Supervisor =====\n"
        );

        const supervisorPrompt =
            applyTemplate(
                supervisorTemplate,
                {
                    PROJECT_ROOT,
                    TASK: task,
                    QWEN_RESULT: qwenResult,
                    BUILD_RESULT: buildText,
                    GIT_BEFORE: gitBeforeText,
                    GIT_AFTER: gitAfterText,
                    TODO: todoText
                }
            );

        const response =
            await reviewWithOpenRouter(
                supervisorPrompt
            );

        const reviewText =
            response
                .choices?.[0]
                ?.message
                ?.content ??
            "";

        if (!reviewText.trim()) {
            throw new Error(
                "Nemotron returned empty review."
            );
        }

        console.log(
            "\nReview Result:"
        );

        console.log(
            reviewText
        );

        console.log("");

        console.log(
            "Model:"
        );

        console.log(
            response.model ??
            "(unknown)"
        );

        console.log("");

        console.log(
            "Provider:"
        );

        console.log(
            response.provider ??
            "(unknown)"
        );

        console.log("");

        console.log(
            "Usage:"
        );

        console.log(
            JSON.stringify(
                response.usage ?? {},
                null,
                2
            )
        );

        // ----------------------------------------------------
        // 7. Complete
        // ----------------------------------------------------

        console.log(
            "\n========================================"
        );

        console.log(
            " OPENROUTER SUPERVISOR COMPLETE"
        );

        console.log(
            "========================================"
        );

        await notifyCompletion();

    } catch (error) {

        console.error(
            "\n===== Supervisor Error ====="
        );

        console.error(
            error
        );

        process.stdout.write(
            "\x07"
        );

        process.exitCode = 1;
    }
}

main();
