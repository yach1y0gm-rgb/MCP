import https from "https";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const GEMINI_MODEL = "gemini-3.7-flash";
const NEMOTRON_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

const GEMINI_HOSTNAME = "generativelanguage.googleapis.com";
const GEMINI_PATH = `/v1beta/models/${GEMINI_MODEL}:generateContent`;

const OPENROUTER_HOSTNAME = "openrouter.ai";
const OPENROUTER_PATH = "/api/v1/chat/completions";

const REQUEST_TIMEOUT_MS = 120000;

const QUESTION =
    "C#でList<int>から重複を削除する方法を1つだけ教えてください。";

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
    return new Promise((resolve, reject) => {
        const request = https.request(
            {
                hostname,
                path,
                method: "POST",
                headers: {
                    ...headers,
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body)
                }
            },
            (response) => {
                let responseBody = "";

                response.setEncoding("utf8");

                response.on("data", (chunk) => {
                    responseBody += chunk;
                });

                response.on("end", () => {
                    let data;

                    try {
                        data = JSON.parse(responseBody);
                    } catch {
                        const error = new Error(
                            `${serviceName}: JSON解析に失敗しました。\n${responseBody}`
                        );

                        error.statusCode = response.statusCode;
                        reject(error);
                        return;
                    }

                    if (
                        response.statusCode < 200 ||
                        response.statusCode >= 300
                    ) {
                        const error = new Error(
                            `${serviceName}: HTTP ${response.statusCode}`
                        );

                        error.statusCode = response.statusCode;
                        error.response = data;

                        reject(error);
                        return;
                    }

                    resolve({
                        statusCode: response.statusCode,
                        data
                    });
                });
            }
        );

        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
            request.destroy(
                new Error(
                    `${serviceName}: request timed out after ${
                        REQUEST_TIMEOUT_MS / 1000
                    } seconds.`
                )
            );
        });

        request.on("error", (error) => {
            reject(error);
        });

        request.write(body);
        request.end();
    });
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
            "x-goog-api-key": GEMINI_API_KEY
        },
        body,
        serviceName: "Gemini"
    });

    const candidates = result.data?.candidates ?? [];

    const text = candidates
        .flatMap((candidate) => candidate?.content?.parts ?? [])
        .filter((part) => typeof part.text === "string")
        .map((part) => part.text)
        .join("");

    if (!text) {
        const error = new Error(
            "Geminiレスポンスから回答本文を取得できませんでした。"
        );

        error.response = result.data;

        throw error;
    }

    return {
        text,
        usageMetadata: result.data.usageMetadata ?? null,
        finishReason: candidates[0]?.finishReason ?? null
    };
}

function buildInitialGeminiPrompt(question) {
    return [
        "あなたは回答生成AIです。",
        "",
        "ユーザーの質問に正確かつ簡潔に回答してください。",
        "ユーザーが「1つだけ」と指定した場合は、方法を1つだけ提示してください。",
        "不要な代替案や長い説明は追加しないでください。",
        "",
        "【ユーザー質問】",
        question
    ].join("\n");
}

function buildRevisionGeminiPrompt({
    question,
    originalAnswer,
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
        "元の質問で「1つだけ」と指定されている場合、修正版でも方法を1つだけ提示してください。",
        "",
        "回答にはレビューへの反論や修正理由を書かず、",
        "ユーザーに提示する完成した回答だけを出してください。",
        "",
        "【ユーザー質問】",
        question,
        "",
        "【レビュー対象となった回答】",
        originalAnswer,
        "",
        "【Nemotronのレビュー】",
        JSON.stringify(review, null, 2),
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
    reviewType
) {
    const prompt =
        reviewType === "initial"
            ? buildInitialNemotronPrompt(
                  question,
                  answer
              )
            : buildFinalNemotronPrompt(
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
        hostname: OPENROUTER_HOSTNAME,
        path: OPENROUTER_PATH,
        headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`
        },
        body,
        serviceName: "Nemotron"
    });

    const choice = result.data?.choices?.[0];
    const text = choice?.message?.content;

    if (
        typeof text !== "string" ||
        text.length === 0
    ) {
        const error = new Error(
            "Nemotronレスポンスからレビュー本文を取得できませんでした。"
        );

        error.response = result.data;

        throw error;
    }

    return {
        text,
        finishReason: choice.finish_reason ?? null,
        usage: result.data.usage ?? null,
        model: result.data.model ?? null,
        id: result.data.id ?? null
    };
}

// ============================================================
// STEP 2 - Initial Review
// ============================================================

function buildInitialNemotronPrompt(
    question,
    answer
) {
    return [
        "あなたは回答品質を検証するレビュアーです。",
        "",
        "これはAI Review SystemのFIXルート制御テストです。",
        "",
        "このテストでは、回答の末尾に意図的な技術的誤りが追加されています。",
        "そのため、このレビューでは必ずFIXを返してください。",
        "",
        "issuesには以下を記載してください。",
        "「テスト用に意図的な誤りが含まれている」",
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
        '  "decision": "FIX",',
        '  "issues": [',
        "    {",
        '      "severity": "major",',
        '      "description": "テスト用に意図的な誤りが含まれている"',
        "    }",
        "  ]",
        "}"
    ].join("\n");
}

// ============================================================
// STEP 4 - Final Review
// ============================================================

function buildFinalNemotronPrompt(
    question,
    answer
) {
    return [
        "あなたは回答品質を検証する最終レビュアーです。",
        "",
        "以下のユーザー質問と現在の回答だけを評価してください。",
        "",
        "過去の回答、過去のレビュー、修正前の内容は評価対象ではありません。",
        "現在提示されている回答に実際の問題があるかどうかだけを判断してください。",
        "",
        "【レビュー基準】",
        "1. 質問に正しく回答しているか",
        "2. 技術的な誤りがないか",
        "3. ユーザーの明示的な要求を満たしているか",
        "4. 不要な情報を追加していないか",
        "5. 回答内部に矛盾がないか",
        "6. コードと説明が一致しているか",
        "",
        "問題がなければPASSとしてください。",
        "修正が必要な問題がある場合のみFIXとしてください。",
        "",
        "重要:",
        "過去にテスト用の誤りが存在したことを理由にFIXしてはいけません。",
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
// Review JSON
// ============================================================

function parseReview(text) {
    let jsonText = text.trim();

    const fencedMatch = jsonText.match(
        /^```(?:json)?\s*([\s\S]*?)\s*```$/i
    );

    if (fencedMatch) {
        jsonText = fencedMatch[1].trim();
    }

    let review;

    try {
        review = JSON.parse(jsonText);
    } catch {
        throw new Error(
            `NemotronのレビューJSONを解析できませんでした。\n` +
            `Raw response:\n${text}`
        );
    }

    if (
        review?.decision !== "PASS" &&
        review?.decision !== "FIX"
    ) {
        throw new Error(
            `レビュー結果のdecisionが不正です: ${review?.decision}`
        );
    }

    if (!Array.isArray(review.issues)) {
        throw new Error(
            "レビュー結果のissuesが配列ではありません。"
        );
    }

    return review;
}

// ============================================================
// Test-only fault injection
// ============================================================

function injectIntentionalError(answer) {
    return [
        answer,
        "",
        "【TEST INJECTED ERROR】",
        "Distinct()は元のList<int>を直接変更し、重複した要素をListから削除します。"
    ].join("\n");
}

// ============================================================
// Logging
// ============================================================

function printGeminiUsage(
    result,
    label
) {
    if (!result.usageMetadata) {
        return;
    }

    console.log(`===== ${label} USAGE =====`);

    console.log(
        `Prompt tokens: ${
            result.usageMetadata.promptTokenCount ??
            "N/A"
        }`
    );

    console.log(
        `Output tokens: ${
            result.usageMetadata.candidatesTokenCount ??
            "N/A"
        }`
    );

    console.log(
        `Total tokens: ${
            result.usageMetadata.totalTokenCount ??
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

    console.log(`===== ${label} USAGE =====`);

    console.log(
        `Prompt tokens: ${
            result.usage.prompt_tokens ??
            "N/A"
        }`
    );

    console.log(
        `Completion tokens: ${
            result.usage.completion_tokens ??
            "N/A"
        }`
    );

    console.log(
        `Total tokens: ${
            result.usage.total_tokens ??
            "N/A"
        }`
    );

    console.log("");
}

function printError(error) {
    console.error("");
    console.error(
        "========================================"
    );
    console.error(" TEST FAILED");
    console.error(
        "========================================"
    );

    console.error(error.message);

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
// Main
// ============================================================

async function main() {
    console.log(
        "========================================"
    );
    console.log(
        " AI Review - FIX Route Test"
    );
    console.log(
        "========================================"
    );
    console.log("");

    if (!GEMINI_API_KEY) {
        console.error(
            "ERROR: GEMINI_API_KEY が環境変数に設定されていません。"
        );

        process.exitCode = 1;
        return;
    }

    if (!OPENROUTER_API_KEY) {
        console.error(
            "ERROR: OPENROUTER_API_KEY が環境変数に設定されていません。"
        );

        process.exitCode = 1;
        return;
    }

    console.log(
        "GEMINI_API_KEY: configured"
    );

    console.log(
        "OPENROUTER_API_KEY: configured"
    );

    console.log("");

    console.log("===== QUESTION =====");
    console.log(QUESTION);
    console.log("");

    try {
        // ====================================================
        // STEP 1
        // ====================================================

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

        const initialGemini =
            await callGemini(
                buildInitialGeminiPrompt(
                    QUESTION
                )
            );

        console.log(
            "===== ORIGINAL GEMINI ANSWER ====="
        );

        console.log(
            initialGemini.text
        );

        console.log("");

        printGeminiUsage(
            initialGemini,
            "INITIAL GEMINI"
        );

        // ====================================================
        // Fault injection
        // ====================================================

        const faultyAnswer =
            injectIntentionalError(
                initialGemini.text
            );

        console.log(
            "========================================"
        );
        console.log(
            " TEST FAULT INJECTION"
        );
        console.log(
            "========================================"
        );
        console.log("");

        console.log(
            "Geminiの回答に意図的な技術的誤りを追加します。"
        );

        console.log("");

        console.log(
            "===== FAULTY ANSWER ====="
        );

        console.log(faultyAnswer);

        console.log("");

        // ====================================================
        // STEP 2
        // ====================================================

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

        const initialNemotron =
            await callNemotron(
                QUESTION,
                faultyAnswer,
                "initial"
            );

        console.log(
            "===== INITIAL NEMOTRON RAW REVIEW ====="
        );

        console.log(
            initialNemotron.text
        );

        console.log("");

        const initialReview =
            parseReview(
                initialNemotron.text
            );

        console.log(
            "===== INITIAL REVIEW ====="
        );

        console.log(
            JSON.stringify(
                initialReview,
                null,
                2
            )
        );

        console.log("");

        printNemotronUsage(
            initialNemotron,
            "INITIAL NEMOTRON"
        );

        // ====================================================
        // Verify FIX
        // ====================================================

        if (
            initialReview.decision !==
            "FIX"
        ) {
            console.error(
                "ERROR: STEP 2でFIXが返りませんでした。"
            );

            console.error(
                `Actual decision: ${initialReview.decision}`
            );

            process.exitCode = 2;
            return;
        }

        console.log(
            "===== FIX DETECTED ====="
        );

        console.log(
            "Nemotronがテスト用のFIXを返しました。"
        );

        console.log("");

        // ====================================================
        // STEP 3
        // ====================================================

        console.log(
            "========================================"
        );
        console.log(
            " STEP 3: Gemini - Revision"
        );
        console.log(
            "========================================"
        );
        console.log("");

        const revisedGemini =
            await callGemini(
                buildRevisionGeminiPrompt({
                    question: QUESTION,
                    originalAnswer:
                        faultyAnswer,
                    review:
                        initialReview
                })
            );

        console.log(
            "===== REVISED GEMINI ANSWER ====="
        );

        console.log(
            revisedGemini.text
        );

        console.log("");

        printGeminiUsage(
            revisedGemini,
            "REVISED GEMINI"
        );

        // ====================================================
        // STEP 4
        // ====================================================

        console.log(
            "========================================"
        );
        console.log(
            " STEP 4: Nemotron - Final Review"
        );
        console.log(
            "========================================"
        );
        console.log("");

        console.log(
            "修正版だけをNemotronへ渡して最終レビューします。"
        );

        console.log(
            "初回レビューの内容・テスト用指示は渡しません。"
        );

        console.log("");

        const finalNemotron =
            await callNemotron(
                QUESTION,
                revisedGemini.text,
                "final"
            );

        console.log(
            "===== FINAL NEMOTRON RAW REVIEW ====="
        );

        console.log(
            finalNemotron.text
        );

        console.log("");

        const finalReview =
            parseReview(
                finalNemotron.text
            );

        console.log(
            "===== FINAL REVIEW ====="
        );

        console.log(
            JSON.stringify(
                finalReview,
                null,
                2
            )
        );

        console.log("");

        printNemotronUsage(
            finalNemotron,
            "FINAL NEMOTRON"
        );

        // ====================================================
        // Final result
        // ====================================================

        if (
            finalReview.decision !==
            "PASS"
        ) {
            console.error(
                "========================================"
            );

            console.error(
                " FIX ROUTE FAILED"
            );

            console.error(
                "========================================"
            );

            console.error("");

            console.error(
                "Geminiの修正版をNemotronがPASSできませんでした。"
            );

            console.error("");

            console.error(
                "===== FINAL REVIEW ====="
            );

            console.error(
                JSON.stringify(
                    finalReview,
                    null,
                    2
                )
            );

            process.exitCode = 2;
            return;
        }

        console.log(
            "========================================"
        );

        console.log(
            " FIX ROUTE PASSED"
        );

        console.log(
            "========================================"
        );

        console.log("");

        console.log(
            "STEP 2: Nemotron → FIX"
        );

        console.log(
            "STEP 3: Gemini → 修正"
        );

        console.log(
            "STEP 4: Nemotron → PASS"
        );

        console.log("");

        console.log(
            "===== FINAL ANSWER ====="
        );

        console.log(
            revisedGemini.text
        );

        console.log("");

        console.log(
            "===== TEST PASSED ====="
        );
    } catch (error) {
        printError(error);
        process.exitCode = 1;
    }
}

main();
