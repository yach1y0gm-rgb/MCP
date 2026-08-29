import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "http://127.0.0.1:4170";
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_SESSION_TIMEOUT_MS = 15000;

export class QwenDaemonClient {
    constructor({
        baseUrl = DEFAULT_BASE_URL,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
        workspaceCwd = null,
        requestWorkspace = false,
        autoApproveTools = new Set([
            "read_file",
            "list_directory",
            "glob",
            "grep_search"
        ])
    } = {}) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.timeoutMs = timeoutMs;
        this.sessionTimeoutMs = sessionTimeoutMs;
        this.workspaceCwd = workspaceCwd;
        this.requestWorkspace = requestWorkspace;
        this.autoApproveTools = new Set(autoApproveTools);
    }

    async request(path, options = {}, timeoutMs = this.timeoutMs) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
                throw new Error(`Qwen daemon request timed out after ${timeoutMs} ms: ${path}`);
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    async health() { return this.request("/health"); }
    async capabilities() { return this.request("/capabilities"); }

    async createSession() {
        console.log("[QwenDaemonClient] createSession: checking capabilities");
        const capabilities = await this.capabilities();
        const features = new Set(capabilities?.features ?? []);
        const payload = {};
        if (features.has("session_scope_override")) payload.sessionScope = "thread";
        if (features.has("session_id_override")) payload.sessionId = randomUUID();
        if (this.requestWorkspace && this.workspaceCwd) payload.cwd = this.workspaceCwd;

        console.log(`[QwenDaemonClient] createSession: POST /session ${JSON.stringify(payload)}`);
        const result = await this.request("/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        }, this.sessionTimeoutMs);

        if (!result?.sessionId) {
            throw new Error(`Qwen daemon returned an invalid session response: ${JSON.stringify(result)}`);
        }
        console.log(`[QwenDaemonClient] createSession: OK sessionId=${result.sessionId}, attached=${result.attached ?? "(unknown)"}`);
        if (result.workspaceCwd) console.log(`[QwenDaemonClient] session workspace=${result.workspaceCwd}`);
        return result;
    }

    async sendPrompt(sessionId, prompt) {
        if (!sessionId) throw new Error("sessionId is required.");
        if (typeof prompt !== "string" || prompt.length === 0) throw new Error("prompt must be a non-empty string.");
        console.log(`[QwenDaemonClient] sendPrompt: sessionId=${sessionId}, promptLength=${prompt.length}`);
        const result = await this.request(`/session/${encodeURIComponent(sessionId)}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: [{ type: "text", text: prompt }] })
        });
        console.log(`[QwenDaemonClient] sendPrompt: OK promptId=${result?.promptId ?? "(none)"}`);
        return result;
    }

    async respondToPermission(requestId, outcome) {
        if (!requestId) throw new Error("requestId is required.");
        return this.request(`/permission/${encodeURIComponent(requestId)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ outcome })
        }, 10000);
    }

    extractToolName(permissionRequest) {
        const toolCall = permissionRequest?.data?.toolCall ?? permissionRequest?.toolCall;
        return toolCall?.name ?? toolCall?.toolName ?? toolCall?.tool?.name ?? toolCall?.kind ?? null;
    }

    async handlePermissionRequest(permissionRequest) {
        const requestId = permissionRequest?.data?.requestId ?? permissionRequest?.requestId;
        const options = permissionRequest?.data?.options ?? permissionRequest?.options ?? [];
        const toolName = this.extractToolName(permissionRequest);
        if (!requestId) {
            console.warn("[QwenDaemonClient] permission_request without requestId; ignoring.");
            return;
        }

        const allowed = toolName && this.autoApproveTools.has(toolName);
        const choice = allowed
            ? options.find(option => option?.kind === "allow_once")
                ?? options.find(option => option?.kind === "allow_always")
                ?? options[0]
            : options.find(option => option?.kind === "reject_once")
                ?? options.find(option => option?.kind === "deny_once")
                ?? options.find(option => option?.kind === "reject_always");

        console.log(`[QwenDaemonClient] permission_request: tool=${toolName ?? "(unknown)"}, requestId=${requestId}`);
        if (!choice?.id) {
            console.warn(`[QwenDaemonClient] no suitable permission option for tool=${toolName ?? "(unknown)"}`);
            return;
        }

        const outcome = { outcome: "selected", optionId: choice.id };
        console.log(`[QwenDaemonClient] permission ${allowed ? "ALLOW" : "REJECT"}: tool=${toolName ?? "(unknown)"}, option=${choice.id}`);
        try {
            await this.respondToPermission(requestId, outcome);
        } catch (error) {
            if (/HTTP 404/.test(error.message)) {
                console.log(`[QwenDaemonClient] permission already resolved: requestId=${requestId}`);
                return;
            }
            throw error;
        }
    }

    async cancelActivePrompt(sessionId) {
        const response = await fetch(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" });
        if (response.status === 204 || response.ok) return true;
        const text = await response.text();
        throw new Error(`Qwen daemon cancel HTTP ${response.status} ${response.statusText}: ${text}`);
    }

    async connectEvents(sessionId, onEvent, { signal, onConnected } = {}) {
        console.log(`[QwenDaemonClient] connectEvents: GET /session/${sessionId}/events`);
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
        if (onConnected) await onConnected();
        console.log(`[QwenDaemonClient] connectEvents: SSE connected for sessionId=${sessionId}`);

        const dispatch = async () => {
            if (currentEvent.data.length === 0) {
                currentEvent = { id: null, event: "message", data: [] };
                return;
            }
            const rawData = currentEvent.data.join("\n");
            const event = { id: currentEvent.id, event: currentEvent.event, data: rawData, parsed: null };
            try { event.parsed = JSON.parse(rawData); } catch { }
            const payload = event.parsed;
            const update = payload?.data?.update ?? payload?.update ?? payload;
            const logicalEvent = update?.sessionUpdate ?? payload?.sessionUpdate ?? null;
            console.log(`[QwenDaemonClient] SSE event: id=${event.id ?? "(none)"}, event=${event.event}, logical=${logicalEvent ?? "(none)"}`);
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
                const lines = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
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
        let resolveTurn;
        let rejectTurn;
        let connected = false;
        let turnComplete = false;
        let streamError = null;
        let timedOut = false;
        const chunks = [];
        let usage = null;
        let promptId = null;
        let stopReason = null;

        const turnPromise = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });

        const updateUsage = (payload, update) => {
            const eventUsage = update?._meta?.usage ?? payload._meta?.usage ?? payload.data?._meta?.usage;
            const meta = update?._meta ?? payload._meta ?? payload.data?._meta;
            if (!eventUsage && !meta?.durationMs) return;
            usage = {
                inputTokens: eventUsage?.inputTokens ?? usage?.inputTokens ?? null,
                outputTokens: eventUsage?.outputTokens ?? usage?.outputTokens ?? null,
                totalTokens: eventUsage?.totalTokens ?? usage?.totalTokens ?? null,
                thoughtTokens: eventUsage?.thoughtTokens ?? usage?.thoughtTokens ?? null,
                cachedReadTokens: eventUsage?.cachedReadTokens ?? usage?.cachedReadTokens ?? null,
                durationMs: meta?.durationMs ?? usage?.durationMs ?? null,
                contextSize: update?.size ?? payload.size ?? payload.data?.size ?? usage?.contextSize ?? null,
                contextUsed: update?.used ?? payload.used ?? payload.data?.used ?? usage?.contextUsed ?? null
            };
        };

        const eventPromise = this.connectEvents(sessionId, async event => {
            const payload = event.parsed;
            if (!payload) return;
            const update = payload.data?.update ?? payload.update ?? payload;
            const sessionUpdate = update?.sessionUpdate ?? payload.sessionUpdate;

            if (event.event === "permission_request" || sessionUpdate === "permission_request") {
                await this.handlePermissionRequest(payload);
                return;
            }

            if (sessionUpdate === "agent_message_chunk") {
                const text = update?.content?.text ?? payload.content?.text;
                if (typeof text === "string") chunks.push(text);
                updateUsage(payload, update);
            }
            if (sessionUpdate === "usage_update") updateUsage(payload, update);
            promptId = payload.promptId ?? update?.promptId ?? promptId;

            if (event.event === "turn_complete") {
                stopReason = payload.stopReason ?? payload.data?.stopReason ?? payload.data?.update?.stopReason ?? update?.stopReason ?? null;
                turnComplete = true;
                resolveTurn();
                return;
            }

            if (event.event === "prompt_cancelled") {
                const reason = payload.reason ?? payload.data?.reason ?? "prompt_cancelled";
                streamError = new Error(`Qwen prompt cancelled: ${reason}`);
                rejectTurn(streamError);
                return;
            }

            if (event.event === "turn_error") {
                const errorKind = payload.errorKind ?? payload.data?.errorKind ?? "turn_error";
                const message = payload.message ?? payload.error ?? payload.data?.message ?? JSON.stringify(payload);
                streamError = new Error(`Qwen turn error (${errorKind}): ${message}`);
                rejectTurn(streamError);
            }
        }, { signal: controller.signal, onConnected: () => { connected = true; } }).catch(error => {
            streamError = error;
            rejectTurn(error);
        });

        timeoutHandle = setTimeout(async () => {
            timedOut = true;
            try { await this.cancelActivePrompt(sessionId); }
            catch (cancelError) { streamError = new Error(`Qwen daemon turn timed out and cancel failed: ${cancelError.message}`); }
            rejectTurn(new Error(`Qwen daemon turn timed out after ${timeoutMs} ms.`));
        }, timeoutMs);

        try {
            while (!connected) {
                if (streamError) throw streamError;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            const promptResult = await this.sendPrompt(sessionId, prompt);
            promptId = promptResult?.promptId ?? promptId;
            await turnPromise;
            if (!turnComplete) throw new Error("Qwen turn ended without turn_complete.");
            return { response: chunks.join(""), promptId, stopReason, usage, turnComplete };
        } catch (error) {
            if (timedOut && streamError) throw streamError;
            if (streamError) throw streamError;
            throw error;
        } finally {
            clearTimeout(timeoutHandle);
            controller.abort();
            await eventPromise.catch(() => {});
        }
    }

    async run(prompt) {
        console.log("[QwenDaemonClient] run: creating session");
        const session = await this.createSession();
        console.log(`[QwenDaemonClient] run: collecting turn for sessionId=${session.sessionId}`);
        return this.collectTurn(session.sessionId, prompt);
    }
}

export default QwenDaemonClient;
