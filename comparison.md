# Comparison of runQwen() Implementations

## ai-review.js implementation (line ~80-105)
```javascript
async function runQwen(prompt) {
    console.log("\n===== QWEN starting =====\n");

    const tempFile = path.join(
        tmpdir(),
        `qwen-prompt-${randomBytes(8).toString("hex")}.txt`
    );

    await writeFile(tempFile, prompt, "utf8");

    return await new Promise((resolve, reject) => {
        const child = spawn(`qwen -y -o json < "${tempFile}"`, {
            cwd: __dirname,
            windowsHide: true,
            shell: true
        });

        let stdout = "";
        let stderr = "";

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");

        child.stdout.on("data", data => {
            stdout += data;
            process.stdout.write(".");
        });

        child.stderr.on("data", data => {
            stderr += data;
            process.stderr.write(data);
        });

        child.on("error", reject);

        child.on("close", code => {
            console.log("");

            if (code !== 0) {
                reject(new Error(`Qwen exited with code ${code}\n${stderr}`));
                return;
            }

            resolve(stdout);
        });
    }).finally(async () => {
        try {
            await writeFile(tempFile, "");
            await writeFile(tempFile, "");
        } catch {
            // 無視
        }
    });
}
```

## openrouter-supervisor.js implementation (line ~142-175)
```javascript
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
```

## Key Differences:

1. **Working Directory**:
   - ai-review.js: `cwd: __dirname` (E:\tools\AI\MCP)
   - openrouter-supervisor.js: `cwd: PROJECT_ROOT` (E:\tools\AI\project\PromptDictionary)

2. **Cleanup Method**:
   - ai-review.js: Writes empty string to temp file twice with writeFile
   - openrouter-supervisor.js: Uses unlink() function

3. **Return Value Processing**:
   - ai-review.js: Direct stdout resolution
   - openrouter-supervisor.js: Passes stdout through `extractQwenResult()` function

4. **Timeout Handling**:
   - Both scripts have timeout at parent process level (120s)
   
5. **Error Message Format**:
   - Both scripts are similar but openrouter-supervisor.js uses a custom `extractQwenResult` that parses JSON output