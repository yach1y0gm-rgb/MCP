import https from "https";
import { spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const MODEL =
    "nvidia/nemotron-3-ultra-550b-a55b:free";

const MAX_ITERATIONS = 5;

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

function extractQwenResult(output) {
    try {
        const events = JSON.parse(output);

        if (!Array.isArray(events)) {
            return output;
        }

        // resultイベントを優先
        const resultEvent = events.find(
            e =>
                e.type === "result" &&
                typeof e.result === "string"
        );

        if (resultEvent) {
            return resultEvent.result;
        }

        // assistant textを結合
        const assistantTexts = events
            .filter(
                e =>
                    e.type === "assistant" &&
                    e.message?.content
            )
            .flatMap(
                e => e.message.content
            )
            .filter(
                c => c.type === "text"
            )
            .map(
                c => c.text
            );

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

    console.log(
        "\n===== Qwen starting =====\n"
    );

    const tempFile = join(
        tmpdir(),
        `qwen-prompt-${randomBytes(8).toString("hex")}.txt`
    );

    await writeFile(
        tempFile,
        prompt,
        "utf8"
    );

    try {

        return await new Promise(
            (resolve, reject) => {

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

                child.stdout.on(
                    "data",
                    data => {
                        stdout += data;

                        // 進行状況
                        process.stdout.write(".");
                    }
                );

                child.stderr.on(
                    "data",
                    data => {
                        stderr += data;

                        process.stderr.write(data);
                    }
                );

                child.on(
                    "error",
                    reject
                );

                child.on(
                    "close",
                    code => {

                        console.log("");

                        if (code !== 0) {

                            reject(
                                new Error(
                                    `Qwen exited with code ${code}\n${stderr}`
                                )
                            );

                            return;
                        }

                        resolve(
                            extractQwenResult(
                                stdout
                            )
                        );
                    }
                );
            }
        );

    } finally {

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
        JSON.stringify(requestBody);

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

                        res.setEncoding("utf8");

                        res.on(
                            "data",
                            chunk => {
                                responseData += chunk;
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

                                resolve(response);
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
// Nemotron Review
// ============================================================

async function runSupervisorReview({
    supervisorTemplate,
    task,
    qwenResult,
    buildText,
    gitBefore,
    gitAfter,
    todo,
    iteration
}) {

    const supervisorPrompt =
        applyTemplate(
            supervisorTemplate,
            {
                PROJECT_ROOT,
                TASK: task,
                QWEN_RESULT: qwenResult,
                BUILD_RESULT: buildText,
                GIT_BEFORE: gitBefore,
                GIT_AFTER: gitAfter,
                TODO: todo,
                ITERATION: String(iteration)
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

    return {
        text: reviewText,
        model:
            response.model ??
            "(unknown)",
        provider:
            response.provider ??
            "(unknown)",
        usage:
            response.usage ??
            {}
    };
}

// ============================================================
// Supervisor Decision Parser
// ============================================================

function parseSupervisorDecision(
    reviewText,
    buildExitCode
) {

    let parsed;

    try {

        // ```json ... ``` を除去
        const cleaned =
            reviewText
                .replace(
                    /^```json\s*/i,
                    ""
                )
                .replace(
                    /\s*```$/i,
                    ""
                )
                .trim();

        parsed =
            JSON.parse(cleaned);

    } catch {

        // JSONとして解析できなかった場合
        // Build失敗なら安全側に倒してFIX
        if (buildExitCode !== 0) {

            return {
                decision: "FIX",
                summary:
                    "NemotronのJSON解析に失敗し、Buildも失敗しているためFIXと判定します。",
                instructions: [
                    "現在のBuildエラーを確認し、原因を調査して修正してください。",
                    "修正後にdotnet buildを実行してください。"
                ],
                continue: true
            };
        }

        // Build成功でもSupervisor判定不明なら
        // PASSにはしない
        return {
            decision: "FIX",
            summary:
                "Nemotronの判定をJSONとして解析できませんでした。",
            instructions: [
                "現在の実装状態を再確認してください。",
                "dotnet buildを実行し、問題があれば修正してください。"
            ],
            continue: true
        };
    }

    // Build失敗時のPASS禁止
    if (
        buildExitCode !== 0 &&
        parsed.decision === "PASS"
    ) {

        return {
            ...parsed,
            decision: "FIX",
            summary:
                `${parsed.summary ?? ""}\n` +
                "ただしBuild exit codeが0ではないため、PASSは禁止されています。",
            continue: true
        };
    }

    if (
        parsed.decision !== "PASS" &&
        parsed.decision !== "FIX"
    ) {

        return {
            ...parsed,
            decision: "FIX",
            summary:
                "NemotronのdecisionがPASS/FIXではありません。",
            instructions: [
                "現在の状態を再確認し、Build成功まで修正してください。"
            ],
            continue: true
        };
    }

    return parsed;
}

// ============================================================
// Build
// ============================================================

async function runBuild() {

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

    return {
        code:
            buildResult.code,
        text:
            buildText
    };
}

// ============================================================
// Git
// ============================================================

async function getGitStatus() {

    const result =
        await runCommand(
            "git",
            [
                "status",
                "--short"
            ]
        );

    return result.stdout;
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
        // 1. Load prompts
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

        console.log(task);

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

        const gitBeforeText =
            await getGitStatus();

        // ----------------------------------------------------
        // 3. Initial Qwen task
        // ----------------------------------------------------

        let qwenPrompt =
            [
                task,
                "",
                "作業完了後、実施内容と結果を日本語で報告してください。",
                "",
                "重要:",
                "実際にファイルを確認してから判断してください。",
                "推測だけでAPIや型を決めないでください。",
                "作業後は可能な限りビルドまたはテストを実行してください。"
            ].join("\n");

        // ----------------------------------------------------
        // 4. Supervisor loop
        // ----------------------------------------------------

        let finalReview = null;

        for (
            let iteration = 1;
            iteration <= MAX_ITERATIONS;
            iteration++
        ) {

            console.log(
                "\n========================================"
            );

            console.log(
                ` Supervisor Iteration ${iteration}/${MAX_ITERATIONS}`
            );

            console.log(
                "========================================\n"
            );

            // ------------------------------------------------
            // Qwen
            // ------------------------------------------------

            let qwenResult;

            try {

                qwenResult =
                    await runQwen(
                        qwenPrompt
                    );

            } catch (error) {

                qwenResult =
                    `Qwen execution failed:\n${error.message}`;

                console.error(
                    qwenResult
                );
            }

            console.log(
                "\n===== Qwen Response =====\n"
            );

            console.log(
                qwenResult
            );

            // ------------------------------------------------
            // Build
            // ------------------------------------------------

            const build =
                await runBuild();

            // ------------------------------------------------
            // Git after
            // ------------------------------------------------

            const gitAfterText =
                await getGitStatus();

            // ------------------------------------------------
            // Nemotron
            // ------------------------------------------------

            console.log(
                "\n===== Nemotron Supervisor =====\n"
            );

            const review =
                await runSupervisorReview({
                    supervisorTemplate,
                    task,
                    qwenResult,
                    buildText: build.text,
                    gitBefore: gitBeforeText,
                    gitAfter: gitAfterText,
                    todo: todoText,
                    iteration
                });

            console.log(
                "\nReview Result:"
            );

            console.log(
                review.text
            );

            console.log("");

            console.log(
                "Model:"
            );

            console.log(
                review.model
            );

            console.log("");

            console.log(
                "Provider:"
            );

            console.log(
                review.provider
            );

            console.log("");

            console.log(
                "Usage:"
            );

            console.log(
                JSON.stringify(
                    review.usage,
                    null,
                    2
                )
            );

            // ------------------------------------------------
            // Parse decision
            // ------------------------------------------------

            const decision =
                parseSupervisorDecision(
                    review.text,
                    build.code
                );

            console.log(
                "\n===== Supervisor Decision =====\n"
            );

            console.log(
                JSON.stringify(
                    decision,
                    null,
                    2
                )
            );

            // ------------------------------------------------
            // PASS
            // ------------------------------------------------

            if (
                decision.decision === "PASS" &&
                build.code === 0
            ) {

                console.log(
                    "\n========================================"
                );

                console.log(
                    " SUPERVISOR PASS"
                );

                console.log(
                    "========================================"
                );

                finalReview =
                    decision;

                await notifyCompletion();

                return;
            }

            // ------------------------------------------------
            // MAX ITERATION
            // ------------------------------------------------

            if (
                iteration >= MAX_ITERATIONS
            ) {

                console.error(
                    "\n========================================"
                );

                console.error(
                    " SUPERVISOR FAILED"
                );

                console.error(
                    "========================================"
                );

                console.error(
                    `最大試行回数 ${MAX_ITERATIONS} 回に到達しました。`
                );

                console.error(
                    "人間による確認が必要です。"
                );

                process.exitCode = 2;

                return;
            }

            // ------------------------------------------------
            // FIX
            // ------------------------------------------------

            const instructions =
                Array.isArray(
                    decision.instructions
                )
                    ? decision.instructions
                    : [
                        decision.summary ??
                        "問題を調査して修正してください。"
                    ];

            qwenPrompt =
                [
                    "前回の作業についてSupervisorから修正指示が出ています。",
                    "",
                    "===== Supervisor Review =====",
                    decision.summary ?? "",
                    "",
                    "===== 修正指示 =====",
                    ...instructions.map(
                        (instruction, index) =>
                            `${index + 1}. ${instruction}`
                    ),
                    "",
                    "===== Build Result =====",
                    build.text,
                    "",
                    "===== 重要ルール =====",
                    "Supervisorの指摘を確認してください。",
                    "実ファイルを確認してから修正してください。",
                    "推測だけでAPIを変更しないでください。",
                    "修正後は可能な限りdotnet buildを実行してください。",
                    "作業完了後、実施内容と結果を日本語で報告してください。"
                ].join("\n");

            console.log(
                "\n===== Returning to Qwen =====\n"
            );

            console.log(
                qwenPrompt
            );
        }

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
