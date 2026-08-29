import https from "https";

const API_KEY = process.env.XAI_API_KEY;
const MODEL = "grok-4.6";

const HOSTNAME = "api.x.ai";
const PATH = "/v1/responses";

const QUESTION =
    "C#でList<int>から重複を削除する方法を1つだけ教えてください。";

function callGrok(question) {
    return new Promise((resolve, reject) => {
        if (!API_KEY) {
            reject(
                new Error(
                    "XAI_API_KEY が環境変数に設定されていません。"
                )
            );
            return;
        }

        const body = JSON.stringify({
            model: MODEL,
            input: [
                {
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: question
                        }
                    ]
                }
            ]
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

        console.log("===== Grok API Test =====");
        console.log(`Model: ${MODEL}`);
        console.log(`Question: ${question}`);
        console.log("");
        console.log("Grok APIへ接続しています...");

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
                    console.error("===== Grok API Error =====");
                    console.error(JSON.stringify(data, null, 2));

                    reject(
                        new Error(
                            `Grok API returned HTTP ${res.statusCode}`
                        )
                    );
                    return;
                }

                let text = "";

                if (typeof data.output_text === "string") {
                    text = data.output_text;
                } else if (Array.isArray(data.output)) {
                    for (const item of data.output) {
                        if (item?.type !== "message") {
                            continue;
                        }

                        if (!Array.isArray(item.content)) {
                            continue;
                        }

                        for (const content of item.content) {
                            if (
                                content?.type === "output_text" &&
                                typeof content.text === "string"
                            ) {
                                text += content.text;
                            }
                        }
                    }
                }

                if (!text) {
                    console.error(
                        "===== Unexpected Grok Response ====="
                    );
                    console.error(JSON.stringify(data, null, 2));

                    reject(
                        new Error(
                            "Grokレスポンスから回答本文を取得できませんでした。"
                        )
                    );
                    return;
                }

                resolve({
                    text,
                    usage: data.usage ?? null,
                    status: data.status ?? null
                });
            });
        });

        req.setTimeout(120000, () => {
            req.destroy(
                new Error("Grok API request timed out after 120 seconds.")
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
                "ERROR: XAI_API_KEY が環境変数に設定されていません。"
            );
            process.exitCode = 1;
            return;
        }

        console.log("XAI_API_KEY: configured");
        console.log("");

        const result = await callGrok(QUESTION);

        console.log("===== Grok Response =====");
        console.log(result.text);
        console.log("");

        console.log("===== Metadata =====");

        if (result.status) {
            console.log(`Status: ${result.status}`);
        }

        if (result.usage) {
            console.log(
                `Input tokens: ${
                    result.usage.input_tokens ?? "N/A"
                }`
            );

            console.log(
                `Output tokens: ${
                    result.usage.output_tokens ?? "N/A"
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
