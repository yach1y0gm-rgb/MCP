import https from "https";

const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

const HOSTNAME = "openrouter.ai";
const PATH = "/api/v1/chat/completions";

const QUESTION =
    "C#でList<int>から重複を削除する方法を1つだけ教えてください。";

function callNemotron(question) {
    return new Promise((resolve, reject) => {
        if (!API_KEY) {
            reject(
                new Error(
                    "OPENROUTER_API_KEY が環境変数に設定されていません。"
                )
            );
            return;
        }

        const body = JSON.stringify({
            model: MODEL,
            messages: [
                {
                    role: "user",
                    content: question
                }
            ],
            temperature: 0.3
        });

        const options = {
            hostname: HOSTNAME,
            path: PATH,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${API_KEY}`,
                "Content-Length": Buffer.byteLength(body)
            }
        };

        console.log("===== Nemotron API Test =====");
        console.log(`Model: ${MODEL}`);
        console.log(`Question: ${question}`);
        console.log("");
        console.log("OpenRouter経由でNemotronへ接続しています...");

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
                    console.error("===== Invalid JSON Response =====");
                    console.error(responseBody);

                    reject(
                        new Error(
                            `JSON解析に失敗しました: ${error.message}`
                        )
                    );
                    return;
                }

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    console.error("===== Nemotron API Error =====");
                    console.error(JSON.stringify(data, null, 2));

                    reject(
                        new Error(
                            `OpenRouter returned HTTP ${res.statusCode}`
                        )
                    );
                    return;
                }

                const choice = data?.choices?.[0];
                const text = choice?.message?.content;

                if (typeof text !== "string" || text.length === 0) {
                    console.error(
                        "===== Unexpected Nemotron Response ====="
                    );
                    console.error(JSON.stringify(data, null, 2));

                    reject(
                        new Error(
                            "Nemotronレスポンスから回答本文を取得できませんでした。"
                        )
                    );
                    return;
                }

                resolve({
                    text,
                    finishReason: choice.finish_reason ?? null,
                    usage: data.usage ?? null,
                    model: data.model ?? null,
                    id: data.id ?? null
                });
            });
        });

        req.setTimeout(120000, () => {
            req.destroy(
                new Error(
                    "Nemotron API request timed out after 120 seconds."
                )
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
                "ERROR: OPENROUTER_API_KEY が環境変数に設定されていません。"
            );
            process.exitCode = 1;
            return;
        }

        console.log("OPENROUTER_API_KEY: configured");
        console.log("");

        const result = await callNemotron(QUESTION);

        console.log("===== Nemotron Response =====");
        console.log(result.text);
        console.log("");

        console.log("===== Metadata =====");

        if (result.id) {
            console.log(`Request ID: ${result.id}`);
        }

        if (result.model) {
            console.log(`Model: ${result.model}`);
        }

        if (result.finishReason) {
            console.log(`Finish reason: ${result.finishReason}`);
        }

        if (result.usage) {
            console.log(
                `Prompt tokens: ${
                    result.usage.prompt_tokens ?? "N/A"
                }`
            );

            console.log(
                `Completion tokens: ${
                    result.usage.completion_tokens ?? "N/A"
                }`
            );

            console.log(
                `Total tokens: ${
                    result.usage.total_tokens ?? "N/A"
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
