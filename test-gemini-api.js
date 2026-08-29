import https from "https";

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3.7-flash";

const HOSTNAME = "generativelanguage.googleapis.com";
const PATH = `/v1beta/models/${MODEL}:generateContent`;

const QUESTION =
  "C#でList<int>から重複を削除する方法を1つだけ教えてください。";

function callGemini(question) {
    return new Promise((resolve, reject) => {
        if (!API_KEY) {
            reject(
                new Error(
                    "GEMINI_API_KEY が環境変数に設定されていません。"
                )
            );
            return;
        }

        const body = JSON.stringify({
            contents: [
                {
                    parts: [
                        {
                            text: question
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

        const options = {
            hostname: HOSTNAME,
            path: PATH,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
                "x-goog-api-key": API_KEY
            }
        };

        console.log("===== Gemini API Test =====");
        console.log(`Model: ${MODEL}`);
        console.log(`Question: ${question}`);
        console.log("");
        console.log("Gemini APIへ接続しています...");

        const req = https.request(options, (res) => {
            let responseBody = "";

            res.setEncoding("utf8");

            res.on("data", (chunk) => {
                responseBody += chunk;
            });

            res.on("end", () => {
                console.log(`HTTP Status: ${res.statusCode}`);
                console.log("");

                let data;

                try {
                    data = JSON.parse(responseBody);
                } catch (error) {
                    reject(
                        new Error(
                            `JSON解析に失敗しました。\n${responseBody}`
                        )
                    );
                    return;
                }

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    console.error("===== Gemini API Error =====");
                    console.error(JSON.stringify(data, null, 2));

                    reject(
                        new Error(
                            `Gemini API returned HTTP ${res.statusCode}`
                        )
                    );
                    return;
                }

                const text =
                    data?.candidates?.[0]?.content?.parts
                        ?.filter((part) => typeof part.text === "string")
                        ?.map((part) => part.text)
                        ?.join("") ?? "";

                if (!text) {
                    console.error(
                        "===== Unexpected Gemini Response ====="
                    );
                    console.error(JSON.stringify(data, null, 2));

                    reject(
                        new Error(
                            "Geminiレスポンスから回答本文を取得できませんでした。"
                        )
                    );
                    return;
                }

                resolve({
                    text,
                    usageMetadata: data.usageMetadata ?? null,
                    finishReason:
                        data?.candidates?.[0]?.finishReason ?? null
                });
            });
        });

        req.setTimeout(120000, () => {
            req.destroy(
                new Error("Gemini API request timed out after 120 seconds.")
            );
        });

        req.on("error", (error) => {
            reject(error);
        });

        req.write(body);
        req.end();
    });
}

async function main() {
    try {
        if (!API_KEY) {
            console.error(
                "ERROR: GEMINI_API_KEY が環境変数に設定されていません。"
            );
            process.exitCode = 1;
            return;
        }

        console.log("GEMINI_API_KEY: configured");
        console.log("");

        const result = await callGemini(QUESTION);

        console.log("===== Gemini Response =====");
        console.log(result.text);
        console.log("");

        console.log("===== Metadata =====");

        if (result.finishReason) {
            console.log(`Finish reason: ${result.finishReason}`);
        }

        if (result.usageMetadata) {
            console.log(
                `Prompt tokens: ${
                    result.usageMetadata.promptTokenCount ?? "N/A"
                }`
            );

            console.log(
                `Output tokens: ${
                    result.usageMetadata.candidatesTokenCount ?? "N/A"
                }`
            );

            console.log(
                `Total tokens: ${
                    result.usageMetadata.totalTokenCount ?? "N/A"
                }`
            );
        }

        console.log("");
        console.log("===== TEST PASSED =====");
    } catch (error) {
        console.error("");
        console.error("===== TEST FAILED =====");
        console.error(error.message);
        process.exitCode = 1;
    }
}

main();
