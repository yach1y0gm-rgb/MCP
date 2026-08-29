import fs from "fs";
import path from "path";
import https from "https";
import readline from "readline";
import { execFile } from "child_process";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const GEMINI_MODEL = "gemini-3.7-flash";
const NEMOTRON_MODEL =
    "nvidia/nemotron-3-ultra-550b-a55b:free";

const GEMINI_HOSTNAME =
    "generativelanguage.googleapis.com";

const OPENROUTER_HOSTNAME =
    "openrouter.ai";

const GEMINI_PATH =
    `/v1beta/models/${GEMINI_MODEL}:generateContent`;

const OPENROUTER_PATH =
    "/api/v1/chat/completions";

const REQUEST_TIMEOUT_MS = 120000;

// 最大修正回数
const MAX_REVISIONS = 2;

const SESSION_MEMORY_PATH = path.join(
    process.cwd(),
    "prompts",
    "session-memory.txt"
);

// ============================================================
// HTTP
// ============================================================

function postJson({
    hostname,
    path,
    headers,
    body,
    serviceName
}) {
    const MAX_RETRIES = 3;

    const RETRY_DELAYS_MS = [
        30000,
        60000,
        120000
    ];

    const RETRYABLE_STATUS_CODES = new Set([
        429,
        500,
        502,
        503,
        504
    ]);

    function sleep(ms) {
        return new Promise(
            resolve => setTimeout(resolve, ms)
        );
    }

    function getRetryAfterMs(response) {
        const retryAfter =
            response.headers?.["retry-after"];

        if (!retryAfter) {
            return null;
        }

        // Retry-After: 秒
        const seconds =
            Number(retryAfter);

        if (
            Number.isFinite(seconds) &&
            seconds >= 0
        ) {
            return seconds * 1000;
        }

        // Retry-After: HTTP-date
        const retryDate =
            Date.parse(retryAfter);

        if (!Number.isNaN(retryDate)) {
            const delay =
                retryDate - Date.now();

            return Math.max(
                0,
                delay
            );
        }

        return null;
    }

    async function requestOnce() {
        return new Promise((resolve, reject) => {
            const request = https.request(
                {
                    hostname,
                    path,
                    method: "POST",
                    headers: {
                        ...headers,
                        "Content-Type":
                            "application/json",
                        "Content-Length":
                            Buffer.byteLength(body)
                    }
                },
                (response) => {
                    let responseBody = "";

                    response.setEncoding("utf8");

                    response.on(
                        "data",
                        (chunk) => {
                            responseBody += chunk;
                        }
                    );

                    response.on(
                        "end",
                        () => {
                            let data;

                            try {
                                data = JSON.parse(
                                    responseBody
                                );
                            } catch {
                                const error =
                                    new Error(
                                        `${serviceName}: ` +
                                        `JSON解析に失敗しました。\n` +
                                        responseBody
                                    );

                                error.statusCode =
                                    response.statusCode;

                                reject(error);
                                return;
                            }

                            if (
                                response.statusCode < 200 ||
                                response.statusCode >= 300
                            ) {
                                const error =
                                    new Error(
                                        `${serviceName}: HTTP ` +
                                        response.statusCode
                                    );

                                error.statusCode =
                                    response.statusCode;

                                error.response =
                                    data;

                                error.retryAfterMs =
                                    getRetryAfterMs(
                                        response
                                    );

                                reject(error);
                                return;
                            }

                            resolve({
                                statusCode:
                                    response.statusCode,
                                data
                            });
                        }
                    );
                }
            );

            request.setTimeout(
                REQUEST_TIMEOUT_MS,
                () => {
                    request.destroy(
                        new Error(
                            `${serviceName}: ` +
                            `request timed out after ` +
                            `${REQUEST_TIMEOUT_MS / 1000} seconds.`
                        )
                    );
                }
            );

            request.on(
                "error",
                (error) => {
                    reject(error);
                }
            );

            request.write(body);
            request.end();
        });
    }

    return (async () => {
        for (
            let retry = 0;
            retry <= MAX_RETRIES;
            retry++
        ) {
            try {
                return await requestOnce();
            } catch (error) {
                const isRetryable =
                    RETRYABLE_STATUS_CODES.has(
                        error.statusCode
                    );

                const hasRetry =
                    retry < MAX_RETRIES;

                if (
                    !isRetryable ||
                    !hasRetry
                ) {
                    throw error;
                }

                let delay =
                    error.retryAfterMs;

                if (
                    delay === null ||
                    delay === undefined
                ) {
                    delay =
                        RETRY_DELAYS_MS[retry];
                }

                console.log("");

                console.log(
                    `${serviceName}: HTTP ${error.statusCode}`
                );

                console.log(
                    "一時的なAPIエラーを検出しました。"
                );

                console.log(
                    `Retry ${retry + 1}/${MAX_RETRIES} ` +
                    `in ${Math.ceil(delay / 1000)} seconds...`
                );

                console.log("");

                await sleep(delay);

                console.log(
                    `${serviceName}: リトライを実行します...`
                );
            }
        }
    })();
}

// ============================================================
// Gemini
// ============================================================

async function callGemini(prompt) {
    const body = JSON.stringify({
        contents: [
            {
                parts: [
                    {
                        text: prompt
                    }
                ]
            }
        ],
        generationConfig: {
            thinkingConfig: {
                thinkingLevel: "low"
            }
        }
    });

    const result = await postJson({
        hostname: GEMINI_HOSTNAME,
        path: GEMINI_PATH,
        headers: {
            "x-goog-api-key":
                GEMINI_API_KEY
        },
        body,
        serviceName: "Gemini"
    });

    const candidates =
        result.data?.candidates ?? [];

    const text =
        candidates
            .flatMap(
                candidate =>
                    candidate
                        ?.content
                        ?.parts ?? []
            )
            .filter(
                part =>
                    typeof part.text ===
                    "string"
            )
            .map(
                part =>
                    part.text
            )
            .join("");

    if (!text) {
        const error =
            new Error(
                "Geminiレスポンスから回答本文を取得できませんでした。"
            );

        error.response =
            result.data;

        throw error;
    }

    return {
        text,
        usageMetadata:
            result.data
                .usageMetadata ?? null,
        finishReason:
            candidates[0]
                ?.finishReason ?? null
    };
}


// ============================================================
// Gemini Prompt
// ============================================================

function buildInitialGeminiPrompt(
    question,
    memory = null
) {
    const prompt = [
        "あなたは回答生成AIです。",
        "",
        "ユーザーの質問に正確かつ簡潔に回答してください。",
        "事実関係や技術的内容を慎重に確認してください。",
        "",
        "ユーザーが「1つだけ」と指定した場合は、方法を1つだけ提示してください。",
        "不要な代替案や長い説明は追加しないでください。",
        "",
        "ユーザーに直接提示できる完成した回答だけを出してください。"
    ];

    if (memory) {
        prompt.push(
            "",
            "【過去の回答（参考情報）】",
            "以下はユーザーが明示的に参照を指定した過去の回答です。",
            "必要な場合のみ参考にしてください。",
            "過去の回答を無条件に正しいものとして扱わないでください。",
            "",
            memory
        );
    }

    prompt.push(
        "",
        "【ユーザー質問】",
        question
    );

    return prompt.join("\n");
}

function buildRevisionGeminiPrompt({
    question,
    answer,
    review
}) {
    return [
        "あなたは回答生成AIです。",
        "",
        "あなたが作成した回答について、別のAIレビュアーからレビューを受けました。",
        "",
        "レビュー内容を確認し、指摘が妥当かどうかを自分で判断してください。",
        "妥当な指摘だけを反映して回答を修正してください。",
        "レビュアーの指摘を盲目的に採用してはいけません。",
        "",
        "ユーザーの元の要求を最優先してください。",
        "質問にない情報を勝手に追加しないでください。",
        "",
        "元の質問で「1つだけ」と指定されている場合、",
        "修正版でも方法を1つだけ提示してください。",
        "",
        "回答にはレビューへの反論や修正理由を書かず、",
        "ユーザーに提示する完成した回答だけを出してください。",
        "",
        "【ユーザー質問】",
        question,
        "",
        "【現在の回答】",
        answer,
        "",
        "【レビュアーの指摘】",
        JSON.stringify(
            review,
            null,
            2
        ),
        "",
        "【修正版の回答】"
    ].join("\n");
}


// ============================================================
// Nemotron
// ============================================================

async function callNemotron(
    question,
    answer,
    mode
) {
    const prompt =
        mode === "initial"
            ? buildInitialReviewPrompt(
                  question,
                  answer
              )
            : buildFinalReviewPrompt(
                  question,
                  answer
              );

    const body = JSON.stringify({
        model: NEMOTRON_MODEL,
        messages: [
            {
                role: "user",
                content: prompt
            }
        ],
        temperature: 0.1
    });

    const result = await postJson({
        hostname:
            OPENROUTER_HOSTNAME,
        path:
            OPENROUTER_PATH,
        headers: {
            Authorization:
                `Bearer ${OPENROUTER_API_KEY}`
        },
        body,
        serviceName: "Nemotron"
    });

    const choice =
        result.data?.choices?.[0];

    const text =
        choice?.message?.content;

    if (
        typeof text !== "string" ||
        text.length === 0
    ) {
        const error =
            new Error(
                "Nemotronレスポンスからレビュー本文を取得できませんでした。"
            );

        error.response =
            result.data;

        throw error;
    }

    return {
        text,
        finishReason:
            choice.finish_reason ?? null,
        usage:
            result.data.usage ?? null,
        model:
            result.data.model ?? null,
        id:
            result.data.id ?? null
    };
}


// ============================================================
// Initial Review Prompt
// ============================================================

function buildInitialReviewPrompt(
    question,
    answer
) {
    return [
        "あなたは厳格な回答品質レビュアーです。",
        "",
        "以下の回答をレビューしてください。",
        "",
        "特に以下を確認してください。",
        "",
        "1. 技術的事実が正しいか",
        "2. コードが実際に正しく動作するか",
        "3. 質問に正しく回答しているか",
        "4. ユーザーの明示的な要求を満たしているか",
        "5. 回答内部に矛盾がないか",
        "6. 説明とコードが一致しているか",
        "",
        "問題が1つでも存在する場合はFIX。",
        "問題が存在しない場合のみPASS。",
        "",
        "PASSを安易に返さないでください。",
        "回答を肯定することではなく、問題を発見することを目的としてください。",
        "",
        "【ユーザー質問】",
        question,
        "",
        "【レビュー対象の回答】",
        answer,
        "",
        "以下のJSONだけを返してください。",
        "Markdownのコードフェンスは使用しないでください。",
        "",
        "{",
        '  "decision": "PASS" または "FIX",',
        '  "issues": [',
        "    {",
        '      "severity": "major" または "minor",',
        '      "description": "問題の具体的な説明"',
        "    }",
        "  ]",
        "}"
    ].join("\n");
}


// ============================================================
// Final Review Prompt
// ============================================================

function buildFinalReviewPrompt(
    question,
    answer
) {
    return [
        "あなたは最終回答品質を検証するレビュアーです。",
        "",
        "以下のユーザー質問と現在の回答だけを評価してください。",
        "",
        "過去の回答、過去のレビュー、修正前の内容は評価対象ではありません。",
        "",
        "現在提示されている回答に実際の問題があるかどうかだけを判断してください。",
        "",
        "【レビュー基準】",
        "1. 技術的事実が正しいか",
        "2. コードが実際に正しく動作するか",
        "3. 質問に正しく回答しているか",
        "4. ユーザーの明示的な要求を満たしているか",
        "5. 不要な情報を追加していないか",
        "6. 回答内部に矛盾がないか",
        "7. コードと説明が一致しているか",
        "",
        "問題がなければPASS。",
        "修正が必要な問題がある場合のみFIX。",
        "",
        "過去のレビュー内容を理由にFIXしてはいけません。",
        "現在の回答に問題がなければ必ずPASSしてください。",
        "",
        "【ユーザー質問】",
        question,
        "",
        "【現在の回答】",
        answer,
        "",
        "以下のJSONだけを返してください。",
        "Markdownのコードフェンスは使用しないでください。",
        "",
        "{",
        '  "decision": "PASS" または "FIX",',
        '  "issues": [',
        "    {",
        '      "severity": "major" または "minor",',
        '      "description": "問題の具体的な説明"',
        "    }",
        "  ]",
        "}"
    ].join("\n");
}


// ============================================================
// Review JSON Parser
// ============================================================

function parseReview(text) {
    let jsonText =
        text.trim();

    const fencedMatch =
        jsonText.match(
            /^```(?:json)?\s*([\s\S]*?)\s*```$/i
        );

    if (fencedMatch) {
        jsonText =
            fencedMatch[1].trim();
    }

    let review;

    try {
        review =
            JSON.parse(jsonText);
    } catch {
        throw new Error(
            "NemotronのレビューJSONを解析できませんでした。\n" +
            `Raw response:\n${text}`
        );
    }

    if (
        review?.decision !== "PASS" &&
        review?.decision !== "FIX"
    ) {
        throw new Error(
            `レビュー結果のdecisionが不正です: ` +
            `${review?.decision}`
        );
    }

    if (
        !Array.isArray(
            review.issues
        )
    ) {
        throw new Error(
            "レビュー結果のissuesが配列ではありません。"
        );
    }

    return review;
}


// ============================================================
// Usage
// ============================================================

function printGeminiUsage(
    result,
    label
) {
    if (
        !result.usageMetadata
    ) {
        return;
    }

    console.log(
        `===== ${label} USAGE =====`
    );

    console.log(
        `Prompt tokens: ${
            result
                .usageMetadata
                .promptTokenCount ??
            "N/A"
        }`
    );

    console.log(
        `Output tokens: ${
            result
                .usageMetadata
                .candidatesTokenCount ??
            "N/A"
        }`
    );

    console.log(
        `Total tokens: ${
            result
                .usageMetadata
                .totalTokenCount ??
            "N/A"
        }`
    );

    console.log("");
}


function printNemotronUsage(
    result,
    label
) {
    if (!result.usage) {
        return;
    }

    console.log(
        `===== ${label} USAGE =====`
    );

    console.log(
        `Prompt tokens: ${
            result
                .usage
                .prompt_tokens ??
            "N/A"
        }`
    );

    console.log(
        `Completion tokens: ${
            result
                .usage
                .completion_tokens ??
            "N/A"
        }`
    );

    console.log(
        `Total tokens: ${
            result
                .usage
                .total_tokens ??
            "N/A"
        }`
    );

    console.log("");
}


// ============================================================
// Single Review Cycle
// ============================================================

async function reviewAnswer(
    question,
    answer
) {
    const review =
        await callNemotron(
            question,
            answer,
            "initial"
        );

    const parsed =
        parseReview(
            review.text
        );

    return {
        raw: review,
        parsed
    };
}


// ============================================================
// Error
// ============================================================

function printError(error) {
    console.error("");
    console.error(
        "========================================"
    );
    console.error(
        " AI REVIEW ERROR"
    );
    console.error(
        "========================================"
    );

    console.error(
        error.message
    );

    if (error.statusCode) {
        console.error(
            `HTTP Status: ${error.statusCode}`
        );
    }

    if (error.response) {
        console.error("");
        console.error(
            "===== API ERROR RESPONSE ====="
        );

        console.error(
            JSON.stringify(
                error.response,
                null,
                2
            )
        );
    }
}


// ============================================================
// Question Input
// ============================================================

async function getQuestion() {
    const args =
        process.argv.slice(2);

    if (args.length > 0) {
        return args.join(" ").trim();
    }

    const rl =
        readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

    const question =
        await new Promise(
            resolve => {
                rl.question(
                    "質問を入力してください: ",
                    answer => {
                        rl.close();
                        resolve(
                            answer.trim()
                        );
                    }
                );
            }
        );

    return question;
}


// ============================================================
// Main
// ============================================================

async function main() {
    console.log(
        "========================================"
    );

    console.log(
        " AI Review System"
    );

    console.log(
        "========================================"
    );

    console.log("");

    if (!GEMINI_API_KEY) {
        throw new Error(
            "GEMINI_API_KEY が環境変数に設定されていません。"
        );
    }

    if (!OPENROUTER_API_KEY) {
        throw new Error(
            "OPENROUTER_API_KEY が環境変数に設定されていません。"
        );
    }

    console.log(
        "GEMINI_API_KEY: configured"
    );

    console.log(
        "OPENROUTER_API_KEY: configured"
    );

    console.log("");

    const question =
        await getQuestion();

    if (!question) {
        throw new Error(
            "質問が入力されていません。"
        );
    }

    const memoryId =
        extractMemoryId(question);
    
    let referencedMemory = null;
    
    if (memoryId) {
        console.log(
            `===== MEMORY REFERENCE =====`
        );
    
        console.log(
            `${memoryId} を参照します。`
        );
    
        console.log("");
    
        referencedMemory =
            loadSessionMemory(
                memoryId
            );
    
        console.log(
            referencedMemory
        );
    
        console.log("");
    }

    console.log(
        "===== QUESTION ====="
    );

    console.log(
        question
    );

    console.log("");

    // ========================================================
    // STEP 1
    // ========================================================

    console.log(
        "========================================"
    );

    console.log(
        " STEP 1: Gemini - Initial Answer"
    );

    console.log(
        "========================================"
    );

    console.log("");

    const initial =
        await callGemini(
            buildInitialGeminiPrompt(
                question,
                referencedMemory
            )
        );
        
    let currentAnswer =
        initial.text;

    console.log(
        "===== GEMINI ANSWER ====="
    );

    console.log(
        currentAnswer
    );

    console.log("");

    printGeminiUsage(
        initial,
        "GEMINI INITIAL"
    );

    // ========================================================
    // STEP 2
    // ========================================================

    console.log(
        "========================================"
    );

    console.log(
        " STEP 2: Nemotron - Initial Review"
    );

    console.log(
        "========================================"
    );

    console.log("");

    const initialReview =
        await reviewAnswer(
            question,
            currentAnswer
        );

    console.log(
        "===== NEMOTRON REVIEW ====="
    );

    console.log(
        initialReview.raw.text
    );

    console.log("");

    console.log(
        "===== PARSED REVIEW ====="
    );

    console.log(
        JSON.stringify(
            initialReview.parsed,
            null,
            2
        )
    );

    console.log("");

    printNemotronUsage(
        initialReview.raw,
        "NEMOTRON INITIAL"
    );

    // ========================================================
    // PASS
    // ========================================================

    if (
        initialReview.parsed
            .decision === "PASS"
    ) {
        console.log(
            "========================================"
        );

        console.log(
            " REVIEW PASSED"
        );

        console.log(
            "========================================"
        );

        console.log("");

        console.log(
            "修正不要と判断されました。"
        );

        console.log("");

        printFinalAnswer(
            question,
            currentAnswer
        );
        
        return;
    }

    // ========================================================
    // FIX LOOP
    // ========================================================

    for (
        let revision = 1;
        revision <= MAX_REVISIONS;
        revision++
    ) {
        console.log(
            "========================================"
        );

        console.log(
            ` REVISION ${revision}/${MAX_REVISIONS}`
        );

        console.log(
            "========================================"
        );

        console.log("");

        // ----------------------------------------------------
        // Gemini Revision
        // ----------------------------------------------------

        console.log(
            "===== Gemini Revision ====="
        );

        const revised =
            await callGemini(
                buildRevisionGeminiPrompt({
                    question,
                    answer:
                        currentAnswer,
                    review:
                        revision === 1
                            ? initialReview.parsed
                            : lastReview
                })
            );

        currentAnswer =
            revised.text;

        console.log("");

        console.log(
            currentAnswer
        );

        console.log("");

        printGeminiUsage(
            revised,
            `GEMINI REVISION ${revision}`
        );

        // ----------------------------------------------------
        // Nemotron Final Review
        // ----------------------------------------------------

        console.log(
            "===== Nemotron Final Review ====="
        );

        const finalReview =
            await callNemotron(
                question,
                currentAnswer,
                "final"
            );

        const parsedFinalReview =
            parseReview(
                finalReview.text
            );

        console.log("");

        console.log(
            parsedFinalReview
        );

        console.log("");

        console.log(
            JSON.stringify(
                parsedFinalReview,
                null,
                2
            )
        );

        console.log("");

        printNemotronUsage(
            finalReview,
            `NEMOTRON FINAL ${revision}`
        );

        // ----------------------------------------------------
        // PASS
        // ----------------------------------------------------

        if (
            parsedFinalReview
                .decision === "PASS"
        ) {
            console.log(
                "========================================"
            );

            console.log(
                " REVIEW PASSED"
            );

            console.log(
                "========================================"
            );

            console.log("");

            console.log(
                `Revision ${revision} でPASSしました。`
            );

            console.log("");

            printFinalAnswer(
                question,
                currentAnswer
            );

            return;
        }

        // ----------------------------------------------------
        // FIX
        // ----------------------------------------------------

        console.log(
            `Revision ${revision} はFIX判定でした。`
        );

        console.log("");

        // 次のRevisionで使用するレビュー
        lastReview =
            parsedFinalReview;
    }

    // ========================================================
    // Maximum Revision Reached
    // ========================================================

    console.log(
        "========================================"
    );

    console.log(
        " REVIEW FAILED"
    );

    console.log(
        "========================================"
    );

    console.log("");

    console.log(
        `最大修正回数 ${MAX_REVISIONS} 回に到達しました。`
    );

    console.log(
        "最終回答を確定できませんでした。"
    );

    console.log("");

    console.log(
        "===== LAST GENERATED ANSWER ====="
    );

    console.log(
        currentAnswer
    );
}

// ============================================================
// Session Memory Reference
// ============================================================

function extractMemoryId(question) {
    const match = question.match(
        /\bMEMORY-(\d{4})\b/i
    );

    if (!match) {
        return null;
    }

    return `MEMORY-${match[1]}`;
}

function loadSessionMemory(memoryId) {
    if (!fs.existsSync(SESSION_MEMORY_PATH)) {
        throw new Error(
            "session-memory.txt が存在しません。"
        );
    }

    const content = fs.readFileSync(
        SESSION_MEMORY_PATH,
        "utf8"
    );

    const sections = content.split(
        /^## (MEMORY-\d{4})\s*$/m
    );

    for (let i = 1; i < sections.length; i += 2) {
        const id = sections[i];
        const body = sections[i + 1];

        if (
            id.toUpperCase() ===
            memoryId.toUpperCase()
        ) {
            return [
                `## ${id}`,
                body.trim()
            ].join("\n");
        }
    }

    throw new Error(
        `${memoryId} が session-memory.txt に存在しません。`
    );
}

// ============================================================
// Session Memory
// ============================================================

function saveSessionMemory(question, finalAnswer) {
    const directory = path.dirname(SESSION_MEMORY_PATH);

    fs.mkdirSync(directory, {
        recursive: true
    });

    let nextId = 1;

    if (fs.existsSync(SESSION_MEMORY_PATH)) {
        const content = fs.readFileSync(
            SESSION_MEMORY_PATH,
            "utf8"
        );

        const matches = [
            ...content.matchAll(
                /^## MEMORY-(\d{4})$/gm
            )
        ];

        if (matches.length > 0) {
            const maxId = Math.max(
                ...matches.map(match =>
                    Number(match[1])
                )
            );

            nextId = maxId + 1;
        }
    }

    const memoryId =
        `MEMORY-${String(nextId).padStart(4, "0")}`;

    const timestamp =
        new Date().toLocaleString(
            "ja-JP",
            {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false
            }
        );

    const entry = [
        `## ${memoryId}`,
        `DATE: ${timestamp}`,
        "",
        "### QUESTION",
        question,
        "",
        "### FINAL ANSWER",
        finalAnswer,
        "",
        "---",
        ""
    ].join("\n");

    fs.appendFileSync(
        SESSION_MEMORY_PATH,
        entry,
        "utf8"
    );

    return memoryId;
}

// ============================================================
// Completion Notification
// ============================================================

function playCompletionSound() {
    execFile(
        "powershell.exe",
        [
            "-NoProfile",
            "-Command",
            "[Console]::Beep(1000, 300)"
        ],
        {
            windowsHide: true
        },
        (error) => {
            if (error) {
                console.error(
                    "通知音の再生に失敗しました:",
                    error.message
                );
            }
        }
    );
}

// ============================================================
// Completion Notification
// ============================================================

function playNotification(type) {
    let script;

    switch (type) {
        case "success":
            // 高めの2音
            script =
                "[Console]::Beep(1000, 150); " +
                "[Console]::Beep(1400, 250)";
            break;

        case "warning":
            // 低めの2音
            script =
                "[Console]::Beep(700, 250); " +
                "[Console]::Beep(500, 350)";
            break;

        case "error":
            // 低い長音
            script =
                "[Console]::Beep(400, 700)";
            break;

        default:
            return;
    }

    execFile(
        "powershell.exe",
        [
            "-NoProfile",
            "-Command",
            script
        ],
        {
            windowsHide: true
        },
        (error) => {
            if (error) {
                console.error(
                    "通知音の再生に失敗しました:",
                    error.message
                );
            }
        }
    );
}

// ============================================================
// Final Answer
// ============================================================

function printFinalAnswer(question, answer) {
    console.log("===== FINAL ANSWER =====");

    console.log(answer);

    console.log("");

    const memoryId = saveSessionMemory(
        question,
        answer
    );

    console.log(
        `Session memory saved: ${memoryId}`
    );

    console.log(
        `Path: ${SESSION_MEMORY_PATH}`
    );

    console.log("");

    console.log("===== AI REVIEW COMPLETED =====");
    
    playNotification("success");
}

// ============================================================
// Entry Point
// ============================================================

let lastReview = null;

main().catch(
    error => {
        printError(error);
        playNotification("error");
        process.exitCode = 1;
    }
);
