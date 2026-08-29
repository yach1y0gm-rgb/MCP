const DEFAULT_BASE_URL = "http://127.0.0.1:4170";
const DEFAULT_TIMEOUT_MS = 120000;

export class QwenDaemonClient {
    constructor({ baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS, workspaceCwd = null } = {}) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.timeoutMs = timeoutMs;
        this.workspaceCwd = workspaceCwd;
    }

    async request(path, options = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(`${this.baseUrl}${path}`, { ...options, signal: controller.signal });
            const text = await response.text();
            if (!response.ok) {
                throw new Error(`Qwen daemon HTTP ${response.status} ${response.statusText}: ${text}`);
            }
            if (!text) return null;
            try { return JSON.parse(text); } catch { return text; }
        } catch (error) {
            if (error?.name === "AbortError") {
                throw new Error(`Qwen daemon request timed out after ${this.timeoutMs} ms: ${path}`);
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    async health() { return this.request("/health"); }
    async capabilities() { return this.request("/capabilities"); }

    async createSession() {
        const body = this.workspaceCwd ? JSON.stringify({ workspaceCwd: this.workspaceCwd }) : undefined;
        const result = await this.request("/session", {
            method: "POST",
            headers: body ? { "Content-Type": "application/json" } : undefined,
            body
        });
        if (!result?.sessionId) {
            throw new Error(`Qwen daemon returned an invalid session response: ${JSON.stringify(result)}`);
        }
        return result;
    }

    async sendPrompt(sessionId, prompt) {
        if (!sessionId) throw new Error("sessionId is required.");
        if (typeof prompt !== "string" || prompt.length === 0) throw new Error("prompt must be a non-empty string.");
        return this.request(`/session/${encodeURIComponent(sessionId)}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: [{ type: "text", text: prompt }] })
        });
    }

    async connectEvents(sessionId, onEvent, { signal } = {}) {
        if (!sessionId) throw new Error("sessionId is required.");
        const response = await fetch(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/events`, {
            headers: { Accept: "text/event-stream" },
            signal
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Qwen daemon SSE HTTP ${response.status} ${response.statusText}: ${text}`);
        }
        if (!response.body) throw new Error("Qwen daemon SSE response has no body.");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent = { id: null, event: "message", data: [] };

        const dispatch = async () => {
            if (currentEvent.data.length === 0) {
                currentEvent = { id: null, event: "message", data: [] };
                return;
            }
            const rawData = currentEvent.data.join("\n");
            const event = { id: currentEvent.id, event: currentEvent.event, data: rawData, parsed: null };
            try { event.parsed = JSON.parse(rawData); } catch {}
            await onEvent(event);
            currentEvent = { id: null, event: "message", data: [] };
        };

        const processLine = async line => {
            if (line === "") { await dispatch(); return; }
            if (line.startsWith(":")) return;
            const separator = line.indexOf(":");
            const field = separator === -1 ? line : line.slice(0, separator);
            let value = separator === -1 ? "" : line.slice(separator + 1);
            if (value.startsWith(" ")) value = value.slice(1);
            if (field === "id") currentEvent.id = value;
            else if (field === "event") currentEvent.event = value;
            else if (field === "data") currentEvent.data.push(value);
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
                for (const line of lines) await processLine(line);
            }
            if (buffer.length > 0) await processLine(buffer);
            await dispatch();
        } finally {
            reader.releaseLock();
        }
    }

    async collectTurn(sessionId, prompt, { timeoutMs = this.timeoutMs } = {}) {
        const controller = new AbortController();
        let timeoutHandle;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                controller.abort();
                reject(new Error(`Qwen daemon turn timed out after ${timeoutMs} ms.`));
            }, timeoutMs);
        });

        const chunks = [];
        let usage = null;
        let promptId = null;
        let stopReason = null;
        let turnComplete = false;
        let streamError = null;
        let resolveTurn;
        let rejectTurn;
        const turnPromise = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });

        const eventPromise = this.connectEvents(sessionId, async event => {
            const payload = event.parsed;
            if (!payload) return;

            const update = payload.data?.update ?? payload.update ?? null;
            const sessionUpdate = update?.sessionUpdate ?? payload.sessionUpdate;

            if (sessionUpdate === "agent_message_chunk") {
                const text = update?.content?.text ?? payload.content?.text;
                if (typeof text === "string") chunks.push(text);
            }

            if (sessionUpdate === "usage_update") {
                const eventUsage = update?._meta?.usage ?? payload._meta?.usage;
                usage = {
                    inputTokens: eventUsage?.inputTokens ?? usage?.inputTokens ?? null,
                    outputTokens: eventUsage?.outputTokens ?? usage?.outputTokens ?? null,
                    totalTokens: eventUsage?.totalTokens ?? usage?.totalTokens ?? null,
                    thoughtTokens: eventUsage?.thoughtTokens ?? usage?.thoughtTokens ?? null,
                    cachedReadTokens: eventUsage?.cachedReadTokens ?? usage?.cachedReadTokens ?? null,
                    durationMs: update?._meta?.durationMs ?? payload._meta?.durationMs ?? usage?.durationMs ?? null,
                    contextSize: update?.size ?? payload.size ?? usage?.contextSize ?? null,
                    contextUsed: update?.used ?? payload.used ?? usage?.contextUsed ?? null
                };
            }

            promptId = payload.promptId ?? update?.promptId ?? promptId;

            if (event.event === "turn_complete") {
                stopReason = payload.stopReason ?? update?.stopReason ?? null;
                turnComplete = true;
                resolveTurn();
            }
        }, { signal: controller.signal }).catch(error => {
            streamError = error;
            rejectTurn(error);
        });

        try {
            await Promise.race([
                (async () => {
                    const promptResult = await this.sendPrompt(sessionId, prompt);
                    promptId = promptResult?.promptId ?? promptId;
                    await turnPromise;
                })(),
                timeoutPromise
            ]);
            return { response: chunks.join(""), promptId, stopReason, usage, turnComplete };
        } catch (error) {
            if (streamError) throw streamError;
            throw error;
        } finally {
            clearTimeout(timeoutHandle);
            controller.abort();
            await eventPromise.catch(() => {});
        }
    }

    async run(prompt) {
        const session = await this.createSession();
        return this.collectTurn(session.sessionId, prompt);
    }
}

export default QwenDaemonClient;
