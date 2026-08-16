import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = "E:\\tools\\AI\\project\\PromptDictionary";

const ALLOWED_DOCUMENTS = {
    "QWEN.md": path.join(PROJECT_ROOT, "QWEN.md"),
    "SPEC.md": path.join(PROJECT_ROOT, "docs", "SPEC.md"),
    "DESIGN.md": path.join(PROJECT_ROOT, "docs", "DESIGN.md"),
    "TODO.md": path.join(PROJECT_ROOT, "docs", "TODO.md")
};

const server = new McpServer({
    name: "promptdictionary-readonly",
    version: "1.1.0"
});

// ============================================================
// Path validation
// ============================================================

function resolveProjectPath(filePath) {
    if (!filePath || typeof filePath !== "string") {
        throw new Error("filePath must be a non-empty string.");
    }

    const resolvedPath = path.resolve(PROJECT_ROOT, filePath);
    const relativePath = path.relative(PROJECT_ROOT, resolvedPath);

    // PROJECT_ROOT の外側へのアクセスを禁止
    if (
        relativePath.startsWith("..") ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error(
            `Project Root outside access is not allowed: ${filePath}`
        );
    }

    return resolvedPath;
}

// ============================================================
// Tool: get_project_structure
// ============================================================

server.tool(
    "get_project_structure",
    "PromptDictionaryプロジェクトのトップレベル構造を読み取ります。読み取り専用です。",
    {},
    async () => {
        const entries = await readdir(PROJECT_ROOT, {
            withFileTypes: true
        });

        const structure = entries
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(entry => {
                const type = entry.isDirectory()
                    ? "[DIR]"
                    : "[FILE]";

                return `${type} ${entry.name}`;
            })
            .join("\n");

        return {
            content: [
                {
                    type: "text",
                    text:
                        `Project Root: ${PROJECT_ROOT}\n\n` +
                        structure
                }
            ]
        };
    }
);

// ============================================================
// Tool: get_document
// ============================================================

server.tool(
    "get_document",
    "PromptDictionaryの設計・仕様・TODO・Qwenルール文書を読み取ります。読み取り専用です。",
    {
        document: z.enum([
            "QWEN.md",
            "SPEC.md",
            "DESIGN.md",
            "TODO.md"
        ])
    },
    async ({ document }) => {
        const filePath = ALLOWED_DOCUMENTS[document];

        if (!filePath) {
            throw new Error(
                `許可されていないドキュメントです: ${document}`
            );
        }

        const content = await readFile(filePath, "utf8");

        return {
            content: [
                {
                    type: "text",
                    text:
                        `Document: ${document}\n` +
                        `Path: ${filePath}\n\n` +
                        content
                }
            ]
        };
    }
);

// ============================================================
// Tool: get_file
// ============================================================

server.tool(
    "get_file",
    "PromptDictionaryプロジェクト配下の指定されたファイルを読み取ります。読み取り専用です。",
    {
        filePath: z.string().min(1)
    },
    async ({ filePath }) => {
        const resolvedPath = resolveProjectPath(filePath);

        const fileInfo = await stat(resolvedPath);

        if (!fileInfo.isFile()) {
            throw new Error(
                `指定されたパスはファイルではありません: ${filePath}`
            );
        }

        const content = await readFile(
            resolvedPath,
            "utf8"
        );

        return {
            content: [
                {
                    type: "text",
                    text:
                        `File: ${filePath}\n` +
                        `Path: ${resolvedPath}\n\n` +
                        content
                }
            ]
        };
    }
);

// ============================================================
// Tool: get_git_status
// ============================================================

server.tool(
    "get_git_status",
    "PromptDictionaryプロジェクトのGit変更状態を読み取ります。Git操作による変更は行いません。",
    {},
    async () => {
        const { stdout, stderr } = await execFileAsync(
            "git",
            ["status", "--short", "--branch"],
            {
                cwd: PROJECT_ROOT,
                windowsHide: true
            }
        );

        return {
            content: [
                {
                    type: "text",
                    text:
                        `Project Root: ${PROJECT_ROOT}\n\n` +
                        (stdout || "(変更なし)") +
                        (
                            stderr
                                ? `\n\nGit stderr:\n${stderr}`
                                : ""
                        )
                }
            ]
        };
    }
);

// ============================================================
// Server startup
// ============================================================

const transport = new StdioServerTransport();

console.error(
    "[MCP] promptdictionary-readonly starting..."
);

console.error(
    `[MCP] PROJECT_ROOT: ${PROJECT_ROOT}`
);

console.error(
    "[MCP] Available tools: get_project_structure, get_document, get_file, get_git_status"
);

await server.connect(transport);

console.error(
    "[MCP] promptdictionary-readonly connected."
);
