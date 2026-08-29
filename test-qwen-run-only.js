#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Using the same PROJECT_ROOT as in openrouter-supervisor.js
const PROJECT_ROOT = "E:\\tools\\AI\\project\\PromptDictionary";

async function runQwen(prompt) {
    console.log("\n===== QWEN starting =====\n");

    const tempFile = path.join(
        tmpdir(),
        `qwen-prompt-${randomBytes(8).toString("hex")}.txt`
    );

    await writeFile(tempFile, prompt, "utf8");

    return await new Promise((resolve, reject) => {
        const child = spawn(`qwen -y -o json < "${tempFile}"`, {
            cwd: PROJECT_ROOT,
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
    });
}

async function main() {
    try {
        const testPrompt = "C#でList<int>から重複を削除する方法を1つだけ教えてください。";
        console.log("Testing Qwen execution with prompt:");
        console.log(testPrompt);
        
        const startTime = Date.now();
        const result = await runQwen(testPrompt);
        const endTime = Date.now();
        
        console.log(`\n=== SUCCESS ===`);
        console.log(`Execution time: ${endTime - startTime} ms`);
        console.log(`Output: ${result}`);
        
    } catch (error) {
        console.error("Error:", error.message);
        process.exitCode = 1;
    }
}

main();