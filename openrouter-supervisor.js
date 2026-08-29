import https from "https";
import { spawn } from "node:child_process";
import {
    readFile,
    writeFile,
    unlink
} from "node:fs/promises";
import path from "node:path";
import {
    fileURLToPath
} from "node:url";
import {
    tmpdir
} from "node:os";
import {
    join
} from "node:path";
import {
    randomBytes
} from "node:crypto";

// ============================================================
// Configuration
// ============================================================

const __filename =
    fileURLToPath(import.meta.url);

const __dirname =
    path.dirname(__filename);

const PROJECT_ROOT =
    "E:\\tools\\AI\\project\\PromptDictionary";

const PROMPT_DIR =
    path.join(
        __dirname,
        "prompts"
    );

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

// ------------------------------------------------------------
// Supervisor input limits
// ------------------------------------------------------------
//
// Supervisorは「実装者」ではないため、巨大な情報を送らない。
// Qwenの回答やBuildログが巨大になった場合も上限を設ける。
// ------------------------------------------------------------

const MAX_QWEN_RESULT_CHARS = 12000;

const MAX_BUILD_RESULT_CHARS = 12000;

const MAX_GIT_RESULT_CHARS = 8000;

// ------------------------------------------------------------
// OpenRouter retry
// ------------------------------------------------------------

const OPENROUTER_MAX_RETRIES = 3;

const OPENROUTER_RETRY_DELAY_MS = 3000;

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

        return await readFile(
            filePath,
            "utf8"
        );

    } catch (error) {

        throw new Error(
            [
                "Prompt file could not be read:",
                filePath,
                error.message
            ].join("\n")
        );
    }
}

// ------------------------------------------------------------
// Template
// ------------------------------------------------------------

function applyTemplate(
    template,
    values
) {

    let result =
        template;

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

// ------------------------------------------------------------
// Text limiting
// ------------------------------------------------------------

function limitText(
    text,
    maxChars
) {

    if (!text) {
        return "";
    }

    if (
        text.length <= maxChars
    ) {
        return text;
    }

    return [
        text.slice(
            0,
            maxChars
        ),
        "",
        `[TRUNCATED: original ${text.length} chars]`
    ].join("\n");
}

// ============================================================
// Qwen result extraction
// ============================================================

function extractQwenResult(
    output
) {

    try {

        const events =
            JSON.parse(output);

        if (
            !Array.isArray(events)
        ) {

            return output;
        }

        // resultイベントを優先
        const resultEvent =
            events.find(
                event =>
                    event.type === "result" &&
                    typeof event.result === "string"
            );

        if (resultEvent) {

            return resultEvent.result;
        }

        // assistant textを結合
        const assistantTexts =
            events
                .filter(
                    event =>
                        event.type === "assistant" &&
                        event.message?.content
                )
                .flatMap(
                    event =>
                        event.message.content
                )
                .filter(
                    content =>
                        content.type === "text"
                )
                .map(
                    content =>
                        content.text
                );

        if (
            assistantTexts.length > 0
        ) {

            return assistantTexts.join(
                "\n"
            );
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
                        cwd:
                            PROJECT_ROOT,

                        windowsHide:
                            true,

                        shell:
                            true
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
//
// 重要:
// IterationごとにQwenプロセスを終了させる。
// SupervisorがQwenの会話履歴を保持する方式にはしない。
//
// Qwenはshell経由のリダイレクトではなく、
// 直接spawnしてstdinへPromptを渡す。
// ============================================================

async function runQwen(
    prompt
) {


    console.log(
        "\n===== Qwen starting =====\n"
    );

    const tempFile =
        join(
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

                const child =
                    spawn(
                        `"C:\\Users\\kz_ya\\AppData\\Roaming\\npm\\qwen.ps1" -y -o json < "${tempFile}"`,
                        {
                            cwd:
                                PROJECT_ROOT,
                
                            windowsHide:
                                true,
                
                            shell:
                                true,
                
                            env:
                                {
                                    ...process.env,
                
                                    OPENROUTER_API_KEY:
                                        process.env.OPENROUTER_API_KEY,
                
                                    OPENAI_BASE_URL:
                                        process.env.OPENAI_BASE_URL
                                }
                        }
                    );
                    
                let stdout = "";

                let stderr = "";

                let settled = false;

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

                        process.stdout.write(
                            "."
                        );
                    }
                );

                child.stderr.on(
                    "data",
                    data => {

                        stderr += data;

                        process.stderr.write(
                            data
                        );
                    }
                );

                child.on(
                    "error",
                    error => {

                        if (
                            settled
                        ) {
                            return;
                        }

                        settled = true;

                        reject(
                            new Error(
                                [
                                    "Qwen spawn error:",
                                    error.message,
                                    "",
                                    "===== stdout =====",
                                    stdout,
                                    "",
                                    "===== stderr =====",
                                    stderr
                                ].join("\n")
                            )
                        );
                    }
                );

                child.on(
                    "close",
                    (
                        code,
                        signal
                    ) => {

                        console.log("");

                        if (
                            settled
                        ) {
                            return;
                        }

                        settled = true;

                        if (
                            code !== 0
                        ) {

                            reject(
                                new Error(
                                    [
                                        `Qwen exited with code ${code}`,
                                        `Qwen signal: ${signal ?? "(none)"}`,
                                        "",
                                        "===== stdout =====",
                                        stdout,
                                        "",
                                        "===== stderr =====",
                                        stderr
                                    ].join("\n")
                                )
                            );

                            return;
                        }

                        try {

                            resolve(
                                extractQwenResult(
                                    stdout
                                )
                            );

                        } catch (
                            error
                        ) {

                            reject(
                                new Error(
                                    [
                                        "Failed to extract Qwen result.",
                                        error.message,
                                        "",
                                        "===== stdout =====",
                                        stdout,
                                        "",
                                        "===== stderr =====",
                                        stderr
                                    ].join("\n")
                                )
                            );
                        }
                    }
                );

                child.stdin.on(
                    "error",
                    error => {

                        if (
                            settled
                        ) {
                            return;
                        }

                        settled = true;

                        reject(
                            new Error(
                                [
                                    "Qwen stdin error:",
                                    error.message,
                                    "",
                                    "===== stdout =====",
                                    stdout,
                                    "",
                                    "===== stderr =====",
                                    stderr
                                ].join("\n")
                            )
                        );
                    }
                );

                child.stdin.write(
                    prompt,
                    "utf8"
                );

                child.stdin.end();

            }
        );

    } catch (
        error
    ) {

        console.error(
            "\n===== Qwen execution failed =====\n"
        );

        console.error(
            error.message
        );

        throw error;
    }
}

// ============================================================
// OpenRouter
// ============================================================

async function reviewWithOpenRouter(
    prompt
) {

    const requestBody = {

        model:
            MODEL,

        messages: [
            {
                role:
                    "user",

                content:
                    prompt
            }
        ]
    };

    const body =
        JSON.stringify(
            requestBody
        );

    let lastError = null;

    for (
        let attempt = 1;
        attempt <= OPENROUTER_MAX_RETRIES;
        attempt++
    ) {

        try {

            console.log(
                `Supervisor API attempt ${attempt}/${OPENROUTER_MAX_RETRIES}`
            );

            const response =
                await new Promise(
                    (resolve, reject) => {

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
                                    Buffer.byteLength(
                                        body
                                    )
                            }
                        };

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

                                            let parsed;

                                            try {

                                                parsed =
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

                                                const error =
                                                    new Error(
                                                        `OpenRouter HTTP ${res.statusCode}\n` +
                                                        JSON.stringify(
                                                            parsed,
                                                            null,
                                                            2
                                                        )
                                                    );

                                                error.statusCode =
                                                    res.statusCode;

                                                reject(
                                                    error
                                                );

                                                return;
                                            }

                                            resolve(
                                                parsed
                                            );
                                        }
                                    );
                                }
                            );

                        req.on(
                            "error",
                            reject
                        );

                        req.write(
                            body
                        );

                        req.end();
                    }
                );

            return response;

        } catch (error) {

            lastError =
                error;

            console.error(
                `Supervisor API error: ${error.message}`
            );

            if (
                attempt <
                OPENROUTER_MAX_RETRIES
            ) {

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            OPENROUTER_RETRY_DELAY_MS *
                                attempt
                        )
                );
            }
        }
    }

    throw lastError;
}

// ============================================================
// Supervisor Review
// ============================================================

async function runSupervisorReview({
    supervisorTemplate,
    task,
    qwenResult,
    buildRequired,
    buildText,
    gitDiff,
    iteration
}) {

    // --------------------------------------------------------
    // Supervisorへ渡す情報を圧縮
    // --------------------------------------------------------

    const compactQwenResult =
        limitText(
            qwenResult,
            MAX_QWEN_RESULT_CHARS
        );

    const compactBuildResult =
        limitText(
            buildText,
            MAX_BUILD_RESULT_CHARS
        );

    const compactGitDiff =
        limitText(
            gitDiff,
            MAX_GIT_RESULT_CHARS
        );

    const supervisorPrompt =
        applyTemplate(
            supervisorTemplate,
            {
                PROJECT_ROOT,
                TASK:
                    task,

                QWEN_RESULT:
                    compactQwenResult,

                BUILD_RESULT:
                    compactBuildResult,

                GIT_DIFF:
                    compactGitDiff,

                ITERATION:
                    String(iteration),

                BUILD_REQUIRED:
                    String(buildRequired)
            }
        );

    console.log(
        `Supervisor prompt size: ${supervisorPrompt.length} chars`
    );

    async function reviewWithOpenRouterRetry(
        prompt,
        maxRetries = 2
    ) {
    
        let lastError = null;
    
        for (
            let attempt = 1;
            attempt <= maxRetries + 1;
            attempt++
        ) {
    
            try {
    
                const response =
                    await reviewWithOpenRouter(
                        prompt
                    );
    
                // ------------------------------------------------
                // OpenRouter / Provider error
                // ------------------------------------------------
    
                if (
                    response?.error
                ) {
    
                    const errorCode =
                        response.error.code ??
                        "unknown";
    
                    const errorMessage =
                        response.error.message ??
                        "Unknown OpenRouter error.";
    
                    throw new Error(
                        `OpenRouter API error ` +
                        `(code ${errorCode}): ` +
                        errorMessage
                    );
                }
    
                return response;
    
            } catch (error) {
    
                lastError = error;
    
                console.error(
                    `OpenRouter review failed ` +
                    `(attempt ${attempt}/${maxRetries + 1})`
                );
    
                console.error(
                    error.message
                );
    
                if (
                    attempt <= maxRetries
                ) {
    
                    const delay =
                        2000 * attempt;
    
                    console.log(
                        `Retrying in ${delay / 1000} seconds...`
                    );
    
                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                delay
                            )
                    );
                }
            }
        }
    
        throw lastError;
    }

    const response =
        await reviewWithOpenRouterRetry(
            supervisorPrompt
        );
        
    console.log(
        "\n===== Raw Nemotron Response =====\n"
    );

    console.log(
        JSON.stringify(
            response,
            null,
            2
        )
    );

    const reviewText =
        response
            .choices?.[0]
            ?.message
            ?.content ??
        "";

    if (
        !reviewText.trim()
    ) {

        throw new Error(
            "Nemotron returned empty review."
        );
    }

    return {

        text:
            reviewText,

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
    buildRequired,
    buildExitCode
) {

    let parsed;

    try {

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
            JSON.parse(
                cleaned
            );

    } catch {

        return {

            decision:
                "FIX",

            summary:
                "SupervisorのJSON解析に失敗しました。安全側に倒してFIXとします。",

            instructions: [
                "現在の実装状態を確認してください。",
                buildRequired &&
                buildExitCode !== 0
                    ? "Buildエラーを確認して修正してください。"
                    : "作業内容と実際の変更状態を再確認してください。"
            ],

            continue:
                true
        };
    }

    // --------------------------------------------------------
    // decision validation
    // --------------------------------------------------------

    if (
        parsed.decision !== "PASS" &&
        parsed.decision !== "FIX"
    ) {

        return {

            ...parsed,

            decision:
                "FIX",

            summary:
                "SupervisorのdecisionがPASS/FIXではありません。",

            instructions: [
                "現在の実装状態を再確認してください。"
            ],

            continue:
                true
        };
    }

    // --------------------------------------------------------
    // Build failure => PASS禁止
    // --------------------------------------------------------

    if (
        buildRequired &&
        buildExitCode !== 0 &&
        parsed.decision === "PASS"
    ) {

        return {

            ...parsed,

            decision:
                "FIX",

            summary:
                `${parsed.summary ?? ""}\n` +
                "BUILD_REQUIRED=true ですがBuildが失敗しているためPASSは禁止されています。",

            continue:
                true
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

    const result =
        await runCommand(
            "dotnet",
            [
                "build",
                "ComfyUI.PromptDictionary.slnx"
            ]
        );

    console.log(
        `Build exit code: ${result.code}`
    );

    if (
        result.stdout
    ) {

        console.log(
            result.stdout
        );
    }

    if (
        result.stderr
    ) {

        console.error(
            result.stderr
        );
    }

    return {

        code:
            result.code,

        text:
            [
                `Exit code: ${result.code}`,
                "",
                "STDOUT:",
                limitText(
                    result.stdout,
                    MAX_BUILD_RESULT_CHARS
                ),
                "",
                "STDERR:",
                limitText(
                    result.stderr,
                    MAX_BUILD_RESULT_CHARS
                )
            ].join("\n")
    };
}

// ============================================================
// Git
// ============================================================

async function getGitDiff() {

    const stat =
        await runCommand(
            "git",
            [
                "diff",
                "--stat"
            ]
        );

    const nameStatus =
        await runCommand(
            "git",
            [
                "diff",
                "--name-status"
            ]
        );

    return [
        "===== Diff Stat =====",
        stat.stdout,
        "",
        "===== Changed Files =====",
        nameStatus.stdout
    ].join("\n");
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
// Initial Qwen Prompt
// ============================================================

function createInitialQwenPrompt(
    task
) {

    return [
        task,
        "",
        "作業完了後、以下の形式で日本語報告してください。",
        "",
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
        "-",
        "",
        "重要:",
        "実際のファイルを確認してから判断してください。",
        "推測だけでAPIや型を決めないでください。",
        "必要な実装・調査はあなた自身で行ってください。",
        "作業完了後、可能な範囲でBuild/Testを実行してください。"
    ].join("\n");
}

// ============================================================
// FIX Prompt
// ============================================================

function createFixQwenPrompt({
    task,
    decision,
    buildText
}) {

    const instructions =
        Array.isArray(
            decision.instructions
        )
            ? decision.instructions
            : [
                decision.summary ??
                "問題を調査して修正してください。"
            ];

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
        ...instructions.map(
            (
                instruction,
                index
            ) =>
                `${index + 1}. ${instruction}`
        ),
        "",
        "===== Build Result =====",
        limitText(
            buildText,
            MAX_BUILD_RESULT_CHARS
        ),
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
        "作業完了後、実施内容と結果を日本語で報告してください。"
    ].join("\n");
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

        if (
            !task
        ) {

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
        // 2. Build policy
        // ----------------------------------------------------

        const buildRequired =
            /^\s*BUILD_REQUIRED\s*:\s*true\s*$/im.test(
                task
            );

        console.log(
            `BUILD_REQUIRED: ${buildRequired}`
        );

        // ----------------------------------------------------
        // 3. Initial Qwen task
        // ----------------------------------------------------

        let qwenPrompt =
            [
                "以下のTaskを厳密に実行してください。",
                "",
                "===== Task =====",
                task,
                "",
                "===== 最重要ルール =====",
                "Task本文に明示された禁止事項を最優先してください。",
                "",
                "Taskでコード変更禁止と指定されている場合、",
                "ファイル編集・削除・生成を一切行わないでください。",
                "",
                "TaskでBuild禁止と指定されている場合、",
                "Buildを実行しないでください。",
                "",
                "Taskに明示されていない変更・改善・リファクタリングを行わないでください。",
                "",
                "調査Taskの場合は、実ファイルを直接確認し、",
                "確認できた事実と推測を明確に分離してください。",
                "",
                "推測だけでAPI・型・ライブラリ仕様を判断しないでください。",
                "",
                "===== 作業完了時の報告 =====",
                "以下の形式で日本語報告してください。",
                "",
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
        
        // ----------------------------------------------------
        // 4. Supervisor loop
        // ----------------------------------------------------

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
            let qwenExecutionFailed = false;
            let qwenError = null;
            
            try {
            
                qwenResult =
                    await runQwen(
                        qwenPrompt
                    );
            
            } catch (error) {
            
                qwenExecutionFailed = true;
                qwenError = error.message;
            
                qwenResult =
                    `Qwen execution failed:\n${qwenError}`;
            
                console.error(
                    qwenResult
                );
            }
            
            // ------------------------------------------------
            // Build
            // ------------------------------------------------

            let build;

            if (
                buildRequired
            ) {

                build =
                    await runBuild();

            } else {

                console.log(
                    "\n===== Build Skipped =====\n"
                );

                console.log(
                    "This task does not require build verification."
                );

                build = {

                    code:
                        null,

                    text:
                        "Build skipped."
                };
            }

            // ------------------------------------------------
            // Git
            // ------------------------------------------------

            const gitDiffText =
                await getGitDiff();

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
                    buildRequired,
                    buildText: build.text,
                    gitDiff: gitDiffText,
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
            // Decision
            // ------------------------------------------------

            const decision =
                parseSupervisorDecision(
                    review.text,
                    buildRequired,
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
                (
                    !buildRequired ||
                    build.code === 0
                )
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

                await notifyCompletion();

                return;
            }

            // ------------------------------------------------
            // MAX ITERATIONS
            // ------------------------------------------------

            if (
                iteration >=
                MAX_ITERATIONS
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

            qwenPrompt =
                createFixQwenPrompt({
                    task,
                    decision,
                    buildText: build.text
                });

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

// ============================================================
// Start
// ============================================================

main();
