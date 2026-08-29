const DEFAULT_BASE_URL = "http://127.0.0.1:4170";
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Thin HTTP/SSE client for Qwen Code's qwen serve HTTP bridge.
 *
 * The client deliberately depends only on Node.js built-ins / global fetch.
 * It keeps the transport layer separate from Supervisor-specific logic.
 */
export class QwenDaemonClient {
    constructor({
        baseUrl = DEFAULT_BASE_URL,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        workspaceCwd = null
    } = {}) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.timeoutMs = timeoutMs;
        this.workspaceCwd = workspaceCwd;
    }

    async request(path, options = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const response = await fetch(`${this.baseUrl}${path}`, {
                ...options,
                signal: controller.signal
            });

            const text = await response.text();

            if (!response.ok) {
                throw new Error(
                    `Qwen daemon HTTP ${response.status} ${response.statusText}: ${text}`
                );
            }

            if (!text) {
                return null;
            }

            try {
                return JSON.parse(text);
            } catch {
                return text;
            }
        } catch (error) {
            if (error?.name === "AbortError") {
                throw new Error(
                    `Qwen daemon request timed out after ${this.timeoutMs} ms: ${path}`
                );
            }

            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    async health() {
        return this.request("/health");
    }

    async capabilities() {
        return this.request("/capabilities");
    }

    async createSession() {
        const body = this.workspaceCwd
            ? JSON.stringify({ workspaceCwd: this.workspaceCwd })
            : undefined;

        const result = await this.request("/session", {
            method: "POST",
            headers: body
                ? { "Content-Type": "application/json" }
                : undefined,
            body
        });

        if (!result?.sessionId) {
            throw new Error(
                `Qwen daemon returned an invalid session response: ${JSON.stringify(result)}`
            );
        }

        return result;
    }

    async sendPrompt(sessionId, prompt) {
        if (!sessionId) {
            throw new Error("sessionId is required.");
        }

        if (typeof prompt !== "string" || prompt.length === 0) {
            throw new Error("prompt must be a non-empty string.");
        }

        return this.request(`/session/${encodeURIComponent(sessionId)}/prompt`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                prompt: [
                    {
                        type: "text",
                        text: prompt
                    }
                ]
            })
        });
    }

    /**
     * Open the session SSE stream and invoke onEvent for each parsed event.
     * The promise resolves only when the HTTP stream closes or the callback
     * throws. Turn completion is handled by collectTurn(), not here.
     */
    async connectEvents(sessionId, onEvent, { signal } = {}) {
        if (!sessionId) {
            throw new Error("sessionId is required.");
        }

        const response = await fetch(
            `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/events`,
            {
                headers: {
                    Accept: "text/event-stream"
                },
                signal
            }
        );

        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Qwen daemon SSE HTTP ${response.status} ${response.statusText}: ${text}`
            );
        }

        if (!response.body) {
            throw new Error("Qwen daemon SSE response has no body.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent = {
            id: null,
            event: "message",
            data: []
        };

        const dispatch = async () => {
            if (currentEvent.data.length === 0) {
                currentEvent = { id: null, event: "message", data: [] };
                return;
            }

            const rawData = currentEvent.data.join("\n");
            const event = {
                id: currentEvent.id,
                event: currentEvent.event,
                data: rawData,
                parsed: null
            };

            try {
                event.parsed = JSON.parse(rawData);
            } catch {
                // Keep parsed=null for non-JSON SSE payloads.
            }

            await onEvent(event);
            currentEvent = { id: null, event: "message", data: [] };
        };

        const processLine = async line => {
            if (line === "") {
                await dispatch();
                return;
            }

            if (line.startsWith(":")) {
                return;
            }

            const separator = line.indexOf(":");
            const field = separator === -1
                ? line
                : line.slice(0, separator);
            let value = separator === -1
                ? ""
                : line.slice(separator + 1);

            if (value.startsWith(" ")) {
                value = value.slice(1);
            }

            switch (field) {
                case "id":
                    currentEvent.id = value;
                    break;
                case "event":
                    currentEvent.event = value;
                    break;
                case "data":
                    currentEvent.data.push(value);
                    break;
                // retry is server guidance and is intentionally ignored here.
                default:
                    break;
            }
        };

        try {
            while (true) {
                const { value, done } = await reader.read();

                if (done) {
                    buffer += decoder.decode();
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    await processLine(line);
                }
            }

            if (buffer.length > 0) {
                await processLine(buffer);
            }

            await dispatch();
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Run one prompt in a session and collect the complete assistant turn.
     * SSE subscription is established before POST /prompt to avoid missing
     * fast events.
     */
    async collectTurn(sessionId, prompt, { timeoutMs = this.timeoutMs } = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            timeoutMs
        );

        const chunks = [];
        let usage = null;
        let promptId = null;
        let stopReason = null;
        let turnComplete = false;
        let streamError = null;

        let resolveTurn;
        let rejectTurn;
        const turnPromise = new Promise((resolve, reject) => {
            resolveTurn = resolve;
            rejectTurn = reject;
        });

        const eventPromise = this.connectEvents(
            sessionId,
            async event => {
                const payload = event.parsed;

                if (!payload || event.event !== "session_update" && event.event !== "turn_complete") {
                    return;
                }

                if (payload.sessionUpdate === "agent_message_chunk") {
                    const text = payload.content?.text;
                    if (typeof text === "string") {
                        chunks.push(text);
                    }
                }

                if (payload.sessionUpdate === "usage_update") {
                    usage = {
                        inputTokens: payload._meta?.usage?.inputTokens ?? usage?.inputTokens ?? null,
                        outputTokens: payload._meta?.usage?.outputTokens ?? usage?.outputTokens ?? null,
                        totalTokens: payload._meta?.usage?.totalTokens ?? usage?.totalTokens ?? null,
                        thoughtTokens: payload._meta?.usage?.thoughtTokens ?? usage?.thoughtTokens ?? null,
                        cachedReadTokens: payload._meta?.usage?.cachedReadTokens ?? usage?.cachedReadTokens ?? null,
                        durationMs: payload._meta?.durationMs ?? usage?.durationMs ?? null,
                        contextSize: payload.size ?? usage?.contextSize ?? null,
                        contextUsed: payload.used ?? usage?.contextUsed ?? null
                    };
                }

                if (payload.promptId) {
                    promptId = payload.promptId;
                }

                if (event.event === "turn_complete") {
                    stopReason = payload.stopReason ?? null;
                    turnComplete = true;
                    resolveTurn();
                }
            },
            { signal: controller.signal }
        ).catch(error => {
            streamError = error;
            rejectTurn(error);
        });

        try {
            const promptResult = await this.sendPrompt(sessionId, prompt);
            promptId = promptResult?.promptId ?? promptId;

            await turnPromise;

            return {
                response: chunks.join(""),
                promptId,
                stopReason,
                usage,
                turnComplete
            };
        } catch (error) {
            if (streamError && error === turnPromise) {
                throw streamError;
            }
            throw error;
        } finally {
            clearTimeout(timeout);
            controller.abort();
            await eventPromise.catch(() => {});
        }
    }

    /**
     * High-level convenience API: create a fresh session and run one prompt.
     */
    async run(prompt) {
        const session = await this.createSession();
        return this.collectTurn(session.sessionId, prompt);
    }
}

export default QwenDaemonClient;
