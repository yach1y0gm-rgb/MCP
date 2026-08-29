import https from "https";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const GEMINI_MODEL = "gemini-3.7-flash";
const NEMOTRON_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

const GEMINI_HOSTNAME = "generativelanguage.googleapis.com";
const GEMINI_PATH = `/v1beta/models/${GEMINI_MODEL}:generateContent`;

const OPENROUTER_HOSTNAME = "openrouter.ai";
const OPENROUTER_PATH = "/api/v1/chat/completions";

const QUESTION =
    "C#でList<int>から重複を削除する方法を1つだけ教えてください。";

const REQUEST_TIMEOUT_MS = 120000;

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
                        reject(
                            new Error(
                                `${serviceName}: JSON解析に失敗しました。\n${responseBody}`
                            )
                        );
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

async function callGemini(question) {
    const body = JSON.stringify({
        contents: [
            {
                parts: [
                    {
                        text: [
                            "あなたは回答生成AIです。",
                            "",
                            "ユーザーの質問に正確かつ簡潔に回答してください。",
                            "ユーザーが「1つだけ」と指定した場合は、方法を1つだけ提示してください。",
                            "不要な代替案や長い説明は追加しないでください。",
                            "",
                            "ユーザーの質問:",
                            question
                        ].join("\n")
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

function buildReviewPrompt(question, answer) {
    return [
        "あなたは回答品質を検証するレビュアーです。",
        "",
        "以下のユーザー質問とGeminiの回答を厳密にレビューしてください。",
        "",
        "【レビュー基準】",
        "1. 質問に正しく回答しているか",
        "2. 事実誤認や技術的な誤りがないか",
        "3. ユーザーの明示的な要求を満たしているか",
        "4. 不要な情報や要求されていない代替案を追加していないか",
        "5. 回答に重大な欠落がないか",
        "6. 説明とコードの内容が矛盾していないか",
        "",
        "問題がなければ PASS としてください。",
        "修正が必要な問題がある場合のみ FIX としてください。",
        "",
        "【重要】",
        "Geminiの回答が正しい場合、無理に問題を探してFIXにしないでください。",
        "単なる好みや表現上の違いはFIXにしないでください。",
        "",
        "【ユーザー質問】",
        question,
        "",
        "【Gemini回答】",
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

async function callNemotron(question, answer) {
    const reviewPrompt = buildReviewPrompt(question, answer);

    const body = JSON.stringify({
        model: NEMOTRON_MODEL,
        messages: [
            {
                role: "user",
                content: reviewPrompt
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

    if (typeof text !== "string" || text.length === 0) {
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

function parseReview(text) {
    let jsonText = text.trim();

    // 念のため ```json ... ``` が付いた場合にも対応
    const fencedMatch = jsonText.match(
        /^```(?:json)?\s*([\s\S]*?)\s*```$/i
    );

    if (fencedMatch) {
        jsonText = fencedMatch[1].trim();
    }

    let review;

    try {
        review = JSON.parse(jsonText);
    } catch (error) {
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

function printError(error) {
    console.error("");
    console.error("===== TEST FAILED =====");
    console.error(error.message);

    if (error.statusCode) {
        console.error(`HTTP Status: ${error.statusCode}`);
    }

    if (error.response) {
        console.error("");
        console.error("===== API Error Response =====");
        console.error(
            JSON.stringify(error.response, null, 2)
        );
    }
}

async function main() {
    console.log("========================================");
    console.log(" AI Review - 2 Step Test");
    console.log("========================================");
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

    console.log("GEMINI_API_KEY: configured");
    console.log("OPENROUTER_API_KEY: configured");
    console.log("");

    console.log("===== QUESTION =====");
    console.log(QUESTION);
    console.log("");

    try {
        // ----------------------------------------
        // Step 1: Gemini
        // ----------------------------------------

        console.log("========================================");
        console.log(" Step 1: Gemini 3.7 Flash");
        console.log("========================================");
        console.log("");
        console.log("Geminiに回答を生成させています...");

        const geminiResult = await callGemini(QUESTION);

        console.log("");
        console.log("===== GEMINI ANSWER =====");
        console.log(geminiResult.text);
        console.log("");

        if (geminiResult.usageMetadata) {
            console.log("===== GEMINI USAGE =====");
            console.log(
                `Prompt tokens: ${
                    geminiResult.usageMetadata.promptTokenCount ??
                    "N/A"
                }`
            );
            console.log(
                `Output tokens: ${
                    geminiResult.usageMetadata.candidatesTokenCount ??
                    "N/A"
                }`
            );
            console.log(
                `Total tokens: ${
                    geminiResult.usageMetadata.totalTokenCount ??
                    "N/A"
                }`
            );
            console.log("");
        }

        // ----------------------------------------
        // Step 2: Nemotron
        // ----------------------------------------

        console.log("========================================");
        console.log(" Step 2: Nemotron");
        console.log("========================================");
        console.log("");
        console.log("Geminiの回答をNemotronにレビューさせています...");

        const nemotronResult = await callNemotron(
            QUESTION,
            geminiResult.text
        );

        console.log("");
        console.log("===== NEMOTRON RAW REVIEW =====");
        console.log(nemotronResult.text);
        console.log("");

        // ----------------------------------------
        // Parse review
        // ----------------------------------------

        const review = parseReview(nemotronResult.text);

        console.log("===== PARSED REVIEW =====");
        console.log(JSON.stringify(review, null, 2));
        console.log("");

        if (nemotronResult.usage) {
            console.log("===== NEMOTRON USAGE =====");
            console.log(
                `Prompt tokens: ${
                    nemotronResult.usage.prompt_tokens ??
                    "N/A"
                }`
            );
            console.log(
                `Completion tokens: ${
                    nemotronResult.usage.completion_tokens ??
                    "N/A"
                }`
            );
            console.log(
                `Total tokens: ${
                    nemotronResult.usage.total_tokens ??
                    "N/A"
                }`
            );
            console.log("");
        }

        console.log("========================================");
        console.log(" 2 STEP TEST PASSED");
        console.log("========================================");
        console.log("");
        console.log(`Review decision: ${review.decision}`);
        console.log(`Issue count: ${review.issues.length}`);
    } catch (error) {
        printError(error);
        process.exitCode = 1;
    }
}

main();
