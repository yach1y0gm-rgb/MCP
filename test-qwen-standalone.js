#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test the exact same command as in ai-review.js and openrouter-supervisor.js
async function testCommand() {
    // Create a simple prompt
    const prompt = [
        "PromptDictionaryの開発で、ChatGPTからの提案をQwenに実装させていますが、提案が何度も的外れになり開発が進みません。AI同士で事前レビューする仕組みを導入する場合、どのような構成が最も効果的でしょうか？"
    ].join("\n");
    
    console.log("Testing Qwen command execution with prompt:");
    console.log(prompt);
    console.log();
    
    const tempFile = path.join(
        tmpdir(),
        `test-prompt-${randomBytes(8).toString("hex")}.txt`
    );
    
    await writeFile(tempFile, prompt, "utf8");

    // Test the same command as ai-review.js (with __dirname)
    console.log("\n=== Testing ai-review.js style ===");
    console.log(`Command: qwen -y -o json < "${tempFile}"`);
    console.log(`Working directory: ${__dirname}`);
    
    const startTime = Date.now();
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
            const endTime = Date.now();
            console.log(`\nCompleted in ${(endTime - startTime) / 1000} seconds`);
            console.log(`Exit code: ${code}`);
            
            if (code !== 0) {
                reject(new Error(`Qwen exited with code ${code}\n${stderr}`));
                return;
            }
            
            resolve({
                stdout,
                stderr,
                code
            });
        });
    }).finally(async () => {
        // Cleanup
        try {
            await writeFile(tempFile, "");
        } catch {
            // ignore
        }
    });
}

testCommand().then(res => {
    console.log("\n=== SUCCESS ===");
    console.log("Output:", res.stdout.substring(0, 200), "...");
}).catch(err => {
    console.error("\n=== ERROR ===");
    console.error(err.message);
});