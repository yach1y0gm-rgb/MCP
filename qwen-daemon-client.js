import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "http://127.0.0.1:4170";
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_SESSION_TIMEOUT_MS = 15000;
const DEFAULT_DIAGNOSTIC_RING_SIZE = 12;
const DEFAULT_CONTEXT_SAFETY_RATIO = 0.86;
const DEFAULT_MAX_CONTEXT_RETRIES = 1;

export class QwenContextLimitError extends Error {
    constructor(message, details = null) {
        super(message);
        this.name = "QwenContextLimitError";
        this.code = "QWEN_CONTEXT_LIMIT";
        this.details = details;
    }
}

export class QwenDaemonClient {
    constructor({
        baseUrl = DEFAULT_BASE_URL,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
        workspaceCwd = null,
        requestWorkspace = false,
        autoApproveTools = new Set(["read_file", "list_directory", "glob", "grep_search"]),
        diagnosticRingSize = DEFAULT_DIAGNOSTIC_RING_SIZE,
        contextSafetyRatio = DEFAULT_CONTEXT_SAFETY_RATIO,
        maxContextRetries = DEFAULT_MAX_CONTEXT_RETRIES
    } = {}) {
        if (contextSafetyRatio <= 0 || contextSafetyRatio >= 1) {
            throw new Error("contextSafetyRatio must be greater than 0 and less than 1.");
        }
        if (!Number.isInteger(maxContextRetries) || maxContextRetries < 0) {
            throw new Error("maxContextRetries must be a non-negative integer.");
        }

        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.timeoutMs = timeoutMs;
        this.sessionTimeoutMs = sessionTimeoutMs;
        this.workspaceCwd = workspaceCwd;
        this.requestWorkspace = requestWorkspace;
        this.autoApproveTools = new Set(autoApproveTools);
        this.diagnosticRingSize = diagnosticRingSize;
        this.contextSafetyRatio = contextSafetyRatio;
        this.maxContextRetries = maxContextRetries;
    }

    async request(path, options = {}, timeoutMs = this.timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`${this.baseUrl}${path}`, { ...options, signal: controller.signal });
            const text = await response.text();
            if (!response.ok) throw new Error(`Qwen daemon HTTP ${response.status} ${response.statusText}: ${text}`);
            if (!text) return null;
            try { return JSON.parse(text); } catch { return text; }
        } catch (error) {
            if (error?.name === "AbortError") {
                throw new Error(`Qwen daemon request timed out after ${timeoutMs} ms: ${path}`);
            }
            throw error;
        } finally {
            clearTimeout(timer);
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
        if (!result?.sessionId) throw new Error(`Qwen daemon returned an invalid session response: ${JSON.stringify(result)}`);
        console.log(`[QwenDaemonClient] createSession: OK sessionId=${result.sessionId}, attached=${result.attached ?? "(unknown)"}`);
        if (result.workspaceCwd) console.log(`[QwenDaemonClient] session workspace=${result.workspaceCwd}`);
        return result;
    }

    async sendPrompt(sessionId, prompt) {
        if (!sessionId) throw new Error("sessionId is required.");
        if (typeof prompt !== "string" || !prompt) throw new Error("prompt must be a non-empty string.");
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
        const allowed = Boolean(toolName && this.autoApproveTools.has(toolName));
        const choice = allowed
            ? options.find(option => option?.kind === "allow_once") ?? options.find(option => option?.kind === "allow_always") ?? options[0]
            : options.find(option => option?.kind === "reject_once") ?? options.find(option => option?.kind === "deny_once") ?? options.find(option => option?.kind === "reject_always");
        console.log(`[QwenDaemonClient] permission_request: tool=${toolName ?? "(unknown)"}, requestId=${requestId}, allowed=${allowed}`);
        if (!choice?.id) {
            console.warn(`[QwenDaemonClient] no suitable permission option: tool=${toolName ?? "(unknown)"}`);
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
        if (!sessionId) throw new Error("sessionId is required.");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/cancel`, { method: "POST", signal: controller.signal });
            if (response.status === 204 || response.ok) return true;
            const text = await response.text();
            throw new Error(`Qwen daemon cancel HTTP ${response.status} ${response.statusText}: ${text}`);
        } catch (error) {
            if (error?.name === "AbortError") throw new Error(`Qwen daemon cancel timed out: ${sessionId}`);
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    async connectEvents(sessionId, onEvent, { signal, onConnected } = {}) {
        if (!sessionId) throw new Error("sessionId is required.");
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

    isContextLimitError(error) {
        const text = [
            error?.message,
            error?.details?.message,
            error?.details?.data?.message,
            error?.details?.error?.message
        ].filter(Boolean).join("\n");

        return /context is too large|prompt tokens.*hard limit|compression_failed_empty_summary|context.{0,20}(?:limit|overflow)|(?:context|prompt).{0,40}too large/i.test(text);
    }

    createContextLimitError(message, details = null) {
        return new QwenContextLimitError(message, details);
    }

    async collectTurn(sessionId, prompt, { timeoutMs = this.timeoutMs } = {}) {
        const controller = new AbortController();
        let timeoutHandle;
        let resolveTurn;
        let rejectTurn;
        let connected = false;
        let streamError = null;
        let terminalEvent = null;
        let terminalPayload = null;
        const chunks = [];
        let usage = null;
        let promptId = null;
        let stopReason = null;
        let contextLimitDetected = false;
        const recentEvents = [];
        const stats = {
            totalEvents: 0,
            sessionUpdates: 0,
            agentMessageChunks: 0,
            agentMessageChars: 0,
            toolCallEvents: 0,
            toolCallUpdateEvents: 0,
            permissionRequests: 0,
            usageUpdates: 0,
            turnComplete: 0,
            turnErrors: 0,
            promptCancelled: 0,
            contextSafetyTriggered: 0,
            firstEventAt: null,
            lastEventAt: null
        };
        const turnPromise = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
        const startedAt = Date.now();

        const rememberEvent = event => {
            const update = event.parsed?.data?.update ?? event.parsed?.update ?? event.parsed;
            recentEvents.push({
                id: event.id,
                event: event.event,
                logical: update?.sessionUpdate ?? event.parsed?.sessionUpdate ?? null,
                promptId: event.parsed?.promptId ?? null,
                text: typeof update?.content?.text === "string" ? update.content.text.slice(0, 120) : null
            });
            while (recentEvents.length > this.diagnosticRingSize) recentEvents.shift();
        };

        const finishWithError = (message, event, payload, errorFactory = null) => {
            terminalEvent = event;
            terminalPayload = payload;
            streamError = errorFactory ? errorFactory(message, payload) : new Error(message);
            rejectTurn(streamError);
        };

        const updateUsage = (payload, update) => {
            const eventUsage = update?._meta?.usage ?? payload._meta?.usage ?? payload.data?._meta?.usage;
            const meta = update?._meta ?? payload._meta ?? payload.data?._meta;
            const contextSize = update?.size ?? payload.size ?? payload.data?.size ?? usage?.contextSize ?? null;
            const contextUsed = update?.used ?? payload.used ?? payload.data?.used ?? usage?.contextUsed ?? null;
            if (!eventUsage && !meta?.durationMs && contextSize === null && contextUsed === null) return;
            usage = {
                inputTokens: eventUsage?.inputTokens ?? usage?.inputTokens ?? null,
                outputTokens: eventUsage?.outputTokens ?? usage?.outputTokens ?? null,
                totalTokens: eventUsage?.totalTokens ?? usage?.totalTokens ?? null,
                thoughtTokens: eventUsage?.thoughtTokens ?? usage?.thoughtTokens ?? null,
                cachedReadTokens: eventUsage?.cachedReadTokens ?? usage?.cachedReadTokens ?? null,
                durationMs: meta?.durationMs ?? usage?.durationMs ?? null,
                contextSize,
                contextUsed
            };

            if (
                !contextLimitDetected &&
                Number.isFinite(contextSize) &&
                Number.isFinite(contextUsed) &&
                contextUsed >= contextSize * this.contextSafetyRatio
            ) {
                contextLimitDetected = true;
                stats.contextSafetyTriggered += 1;
                console.warn(`[QwenDaemonClient] context safety threshold reached: used=${contextUsed}, size=${contextSize}, ratio=${(contextUsed / contextSize).toFixed(3)}`);
                void this.cancelActivePrompt(sessionId).catch(cancelError => {
                    console.warn(`[QwenDaemonClient] context safety cancel failed: ${cancelError.message}`);
                });
                finishWithError(
                    `Qwen context usage reached the safety threshold (${contextUsed}/${contextSize}).`,
                    "context_safety_limit",
                    { contextSize, contextUsed },
                    (message, details) => this.createContextLimitError(message, details)
                );
            }
        };

        const eventPromise = this.connectEvents(sessionId, async event => {
            stats.totalEvents += 1;
            const now = Date.now();
            stats.firstEventAt ??= now;
            stats.lastEventAt = now;
            rememberEvent(event);

            const payload = event.parsed;
            if (!payload) return;
            const update = payload.data?.update ?? payload.update ?? payload;
            const sessionUpdate = update?.sessionUpdate ?? payload.sessionUpdate ?? null;

            if (event.event === "session_update") stats.sessionUpdates += 1;
            if (sessionUpdate === "agent_message_chunk") {
                stats.agentMessageChunks += 1;
                const text = update?.content?.text ?? payload.content?.text;
                if (typeof text === "string") {
                    chunks.push(text);
                    stats.agentMessageChars += text.length;
                }
                updateUsage(payload, update);
            } else if (sessionUpdate === "tool_call") {
                stats.toolCallEvents += 1;
            } else if (sessionUpdate === "tool_call_update") {
                stats.toolCallUpdateEvents += 1;
            } else if (sessionUpdate === "usage_update") {
                stats.usageUpdates += 1;
                updateUsage(payload, update);
            } else if (sessionUpdate === "permission_request" || event.event === "permission_request") {
                stats.permissionRequests += 1;
                await this.handlePermissionRequest(payload);
            }

            promptId = payload.promptId ?? update?.promptId ?? promptId;

            if (event.event === "turn_complete" || sessionUpdate === "turn_complete") {
                stats.turnComplete += 1;
                stopReason = payload.stopReason ?? payload.data?.stopReason ?? update?.stopReason ?? null;
                terminalEvent = event.event === "session_update" ? sessionUpdate : event.event;
                terminalPayload = payload;
                resolveTurn();
                return;
            }

            if (event.event === "prompt_cancelled" || sessionUpdate === "prompt_cancelled") {
                stats.promptCancelled += 1;
                const reason = payload.reason ?? payload.data?.reason ?? "unknown";
                const message = payload.message ?? payload.data?.message ?? "";
                if (contextLimitDetected || this.isContextLimitError(message) || this.isContextLimitError(payload)) {
                    finishWithError(
                        `Qwen prompt cancelled after context limit detection: ${reason}${message ? `: ${message}` : ""}`,
                        event.event === "session_update" ? sessionUpdate : event.event,
                        payload,
                        (errorMessage, details) => this.createContextLimitError(errorMessage, details)
                    );
                } else {
                    finishWithError(`Qwen prompt cancelled${message ? `: ${message}` : "."}`, event.event === "session_update" ? sessionUpdate : event.event, payload);
                }
                return;
            }

            if (event.event === "turn_error" || sessionUpdate === "turn_error") {
                stats.turnErrors += 1;
                const detail = payload.message ?? payload.error?.message ?? payload.data?.message ?? update?.message ?? JSON.stringify(payload);
                if (this.isContextLimitError(payload) || this.isContextLimitError(detail)) {
                    finishWithError(
                        `Qwen context limit error: ${detail}`,
                        event.event === "session_update" ? sessionUpdate : event.event,
                        payload,
                        (errorMessage, details) => this.createContextLimitError(errorMessage, details)
                    );
                } else {
                    finishWithError(`Qwen turn error: ${detail}`, event.event === "session_update" ? sessionUpdate : event.event, payload);
                }
            }
        }, { signal: controller.signal, onConnected: () => { connected = true; } }).catch(error => {
            streamError = error;
            rejectTurn(error);
        });

        timeoutHandle = setTimeout(async () => {
            try { await this.cancelActivePrompt(sessionId); }
            catch (cancelError) { streamError = new Error(`Qwen daemon turn timed out and cancel failed: ${cancelError.message}`); }
            rejectTurn(streamError ?? new Error(`Qwen daemon turn timed out after ${timeoutMs} ms.`));
        }, timeoutMs);

        try {
            while (!connected) {
                if (streamError) throw streamError;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            const promptResult = await this.sendPrompt(sessionId, prompt);
            promptId = promptResult?.promptId ?? promptId;
            await turnPromise;
            if (streamError) throw streamError;
            if (terminalEvent !== "turn_complete" && stats.turnComplete === 0) throw new Error("Qwen turn ended without turn_complete.");

            const elapsedMs = Math.max(0, (stats.lastEventAt ?? Date.now()) - (stats.firstEventAt ?? startedAt));
            const chunksPerSecond = elapsedMs > 0 ? Number((stats.agentMessageChunks / (elapsedMs / 1000)).toFixed(2)) : null;
            console.log(`[QwenDaemonClient] diagnostics: events=${stats.totalEvents}, sessionUpdates=${stats.sessionUpdates}, agentChunks=${stats.agentMessageChunks}, responseChars=${stats.agentMessageChars}, toolCalls=${stats.toolCallEvents}, toolCallUpdates=${stats.toolCallUpdateEvents}, permissions=${stats.permissionRequests}, usageUpdates=${stats.usageUpdates}, turnComplete=${stats.turnComplete}, contextSafetyTriggered=${stats.contextSafetyTriggered}, durationMs=${elapsedMs}, chunksPerSecond=${chunksPerSecond ?? "(n/a)"}`);
            return { response: chunks.join(""), promptId, stopReason, usage, turnComplete: stats.turnComplete > 0, diagnostics: stats };
        } catch (error) {
            const elapsedMs = Math.max(0, Date.now() - startedAt);
            console.error(`[QwenDaemonClient] diagnostics before failure: events=${stats.totalEvents}, sessionUpdates=${stats.sessionUpdates}, agentChunks=${stats.agentMessageChunks}, responseChars=${stats.agentMessageChars}, toolCalls=${stats.toolCallEvents}, toolCallUpdates=${stats.toolCallUpdateEvents}, permissions=${stats.permissionRequests}, usageUpdates=${stats.usageUpdates}, turnComplete=${stats.turnComplete}, turnErrors=${stats.turnErrors}, promptCancelled=${stats.promptCancelled}, contextSafetyTriggered=${stats.contextSafetyTriggered}, elapsedMs=${elapsedMs}`);
            if (terminalEvent) {
                console.error(`[QwenDaemonClient] terminal event: ${terminalEvent}`);
                console.error(`[QwenDaemonClient] terminal payload: ${JSON.stringify(terminalPayload, null, 2)}`);
            }
            if (recentEvents.length > 0) {
                console.error(`[QwenDaemonClient] recent events: ${JSON.stringify(recentEvents, null, 2)}`);
            }
            if (streamError) throw streamError;
            throw error;
        } finally {
            clearTimeout(timeoutHandle);
            controller.abort();
            await eventPromise.catch(() => {});
        }
    }

    async run(prompt) {
        if (typeof prompt !== "string" || !prompt) throw new Error("prompt must be a non-empty string.");

        let lastError = null;

        for (let attempt = 0; attempt <= this.maxContextRetries; attempt++) {
            if (attempt > 0) {
                console.warn(`[QwenDaemonClient] context recovery: starting fresh session (retry ${attempt}/${this.maxContextRetries})`);
            }

            console.log("[QwenDaemonClient] run: creating session");
            const session = await this.createSession();

            try {
                console.log(`[QwenDaemonClient] run: collecting turn for sessionId=${session.sessionId}`);
                return await this.collectTurn(session.sessionId, prompt);
            } catch (error) {
                lastError = error;
                if (!this.isContextLimitError(error)) throw error;
                if (attempt >= this.maxContextRetries) {
                    console.error("[QwenDaemonClient] context recovery exhausted.");
                    throw error;
                }
                console.warn(`[QwenDaemonClient] context limit detected; discarding sessionId=${session.sessionId} and retrying with a fresh session.`);
            }
        }

        throw lastError ?? new Error("Qwen run failed without an error.");
    }
}

export default QwenDaemonClient;
