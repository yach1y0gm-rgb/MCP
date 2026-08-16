import https from "https";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// ============================================================
// Configuration
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROMPT_FILE = path.join(
    __dirname,
    "prompts",
    "openrouter-review.txt"
);

const MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
    console.error("ERROR: OPENROUTER_API_KEY is not set.");
    process.stdout.write("\x07");
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

async function notifyCompletion() {
    await runCommand(
        "powershell",
        [
            "-NoProfile",
            "-Command",
            "[console]::beep(800,200)"
        ]
    );
}

async function runCommand(command, args) {
    return await new Promise((resolve, reject) => {
        const child = spawn(
            command,
            args,
            {
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
        });

        child.stderr.on("data", data => {
            stderr += data;
        });

        child.on("error", error => {
            reject(error);
        });

        child.on("close", code => {
            resolve({
                code,
                stdout,
                stderr
            });
        });
    });
}

// ============================================================
// Main
// ============================================================

async function main() {
    try {
        console.log("========================================");
        console.log(" OpenRouter - PromptDictionary Review Test");
        console.log("========================================");
        console.log("");
        console.log(`Model: ${MODEL}`);
        console.log(`Prompt: ${PROMPT_FILE}`);
        console.log("");

        // ----------------------------------------------------
        // 1. Read external prompt
        // ----------------------------------------------------

        const supervisorPrompt =
            await readPromptFile(PROMPT_FILE);

        if (!supervisorPrompt.trim()) {
            throw new Error(
                `Prompt file is empty:\n${PROMPT_FILE}`
            );
        }

        // ----------------------------------------------------
        // 2. Review input
        // ----------------------------------------------------

        const reviewContext = `
プロジェクト:
ComfyUI PromptDictionary

技術構成:
- .NET 10
- Avalonia UI
- CommunityToolkit.Mvvm
- SQLite
- Entity Framework Core
- MVVM
- Repository Pattern

現在のPhase:
Phase 1-4

Qwenの作業報告:

1. MainView.axaml にCategory一覧とWord一覧を表示するUIを追加した。

2. MainViewModel.cs にCategoriesとWordsを取得する処理を追加した。

3. 起動時にSQLiteからCategoryとWordを取得できることを確認した。

4. dotnet build は成功したと報告した。

5. UIを実際に起動して確認したところ、Category一覧は表示された。

6. Word一覧については、Categoryを選択した後に表示される実装だが、
   Category選択時のWords再取得処理については明確な動作確認を行っていない。

7. PromptRegisterView.axaml は存在するが、
   PromptRegisterViewModel.cs は存在しない。

8. 現在のMainViewからPromptRegisterViewへの遷移処理はまだ実装していない。
   そのため現時点では問題ないと判断した。

9. Git statusではMainView.axamlとMainViewModel.csに未コミット変更がある。

今回、別途実行した現在の実ファイル確認結果:

MainWindow.axaml:
指定パス
E:\\tools\\AI\\project\\PromptDictionary\\ComfyUI.PromptDictionary.Desktop\\Views\\MainWindow.axaml
には存在しない。

MainView.axaml:
存在する。

MainViewModel.cs:
存在する。

PromptRegisterView.axaml:
存在する。

PromptRegisterViewModel.cs:
存在しない。

現在のMainViewModel.csには以下の処理が存在する:

- Categories
- Words
- SelectedCategory
- SelectedWord
- Prompt
- LoadData()
- FilterWordsByCategory()
- UpdatePrompt()
- Copy()

ただしCopy()では、

System.Windows.Clipboard.SetText(Prompt);

を使用している。

現在の実際のdotnet build結果:

ComfyUI.PromptDictionary.slnx を指定した場合、
CoreとRepositoryはBuild成功。

DesktopはBuild失敗。

エラー:

E:\\tools\\AI\\project\\PromptDictionary\\ComfyUI.PromptDictionary.Desktop\\ViewModels\\MainViewModel.cs(123,17):
error CS0234:
型または名前空間の名前 'Clipboard' が名前空間 'System.Windows' に存在しません

また、以下の警告がある:

CS8618:
_categoryRepository
_wordRepository

がDefault constructor終了時に初期化されていない。

なお、

ComfyUI.PromptDictionary.sln

は存在せず、

ComfyUI.PromptDictionary.slnx

は存在する。

TODO.md上ではPhase 1-4の未完了項目として、

- Category一覧表示
- Word一覧表示
- Categoryフィルタ
- Word選択
- Positive Prompt生成
- Negative Prompt生成
- Positiveコピー
- Negativeコピー
- Prompt解析
- 解析結果一覧表示
- Category一括変更
- Model選択
- Word登録
- 重複チェック
- DB保存
- 各種動作確認

などが残っている。

以上の情報を第三者としてレビューしてください。
`;

        const prompt =
            `${supervisorPrompt.trim()}\n\n${reviewContext}`;

        // ----------------------------------------------------
        // 3. OpenRouter request
        // ----------------------------------------------------

        const requestBody = {
            model: MODEL,
            messages: [
                {
                    role: "user",
                    content: prompt
                }
            ]
        };

        const body = JSON.stringify(requestBody);

        const options = {
            hostname: "openrouter.ai",
            path: "/api/v1/chat/completions",
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body)
            }
        };

        // ----------------------------------------------------
        // 4. API request
        // ----------------------------------------------------

        const response =
            await new Promise((resolve, reject) => {
                const req = https.request(
                    options,
                    res => {
                        let responseData = "";

                        res.setEncoding("utf8");

                        res.on("data", chunk => {
                            responseData += chunk;
                        });

                        res.on("end", () => {
                            let parsed;

                            try {
                                parsed =
                                    JSON.parse(responseData);
                            } catch (error) {
                                reject(
                                    new Error(
                                        `JSON parse failed:\n${responseData}`
                                    )
                                );
                                return;
                            }

                            resolve({
                                statusCode: res.statusCode,
                                data: parsed
                            });
                        });
                    }
                );

                req.on("error", error => {
                    reject(error);
                });

                req.write(body);
                req.end();
            });

        // ----------------------------------------------------
        // 5. Response validation
        // ----------------------------------------------------

        console.log(
            `HTTP Status: ${response.statusCode}`
        );
        console.log("");

        if (
            response.statusCode < 200 ||
            response.statusCode >= 300
        ) {
            console.error(
                "ERROR: OpenRouter API returned an error."
            );

            console.error(
                JSON.stringify(
                    response.data,
                    null,
                    2
                )
            );

            process.stdout.write("\x07");
            process.exit(1);
        }

        const reviewResult =
            response.data
                ?.choices?.[0]
                ?.message
                ?.content;

        if (!reviewResult) {
            throw new Error(
                "OpenRouter returned an empty response."
            );
        }

        // ----------------------------------------------------
        // 6. Output
        // ----------------------------------------------------

        console.log("Review Result:");
        console.log(reviewResult);
        console.log("");

        console.log("Model:");
        console.log(
            response.data.model ?? "(unknown)"
        );
        console.log("");

        console.log("Provider:");
        console.log(
            response.data.provider ?? "(unknown)"
        );
        console.log("");

        console.log("Usage:");
        console.log(
            JSON.stringify(
                response.data.usage ?? {},
                null,
                2
            )
        );
        console.log("");

        console.log("========================================");
        console.log(" REVIEW TEST SUCCESS");
        console.log("========================================");

        // 正常終了通知音
        await notifyCompletion();

    } catch (error) {
        console.error("");
        console.error("========================================");
        console.error(" OpenRouter Review Test ERROR");
        console.error("========================================");
        console.error("");
        console.error(error);

        // エラー通知音
        process.stdout.write("\x07");

        process.exitCode = 1;
    }
}

main();
