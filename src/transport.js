/**
 * MCP over postMessage: the MCP SDK's Transport interface (start, send, close,
 * onmessage, onerror, onclose) on anything with postMessage and
 * addEventListener('message') — a Worker, a worker's global scope, or a
 * MessagePort.
 *
 * The worker serves on `new PostMessageTransport(self)`, and a page connects
 * with the same class around the Worker, or with any client transport that
 * sends MCP's JSON-RPC messages as postMessage data (glen-harness's
 * PostMessageTransport does).
 *
 * Messages that arrive before start() — a page sending `initialize` while the
 * worker is still starting DuckDB — are queued, not dropped.
 */

export class PostMessageTransport {
    /** @param {Worker|MessagePort|DedicatedWorkerGlobalScope} port */
    constructor(port) {
        this.port = port;
        this.queue = [];
        this.started = false;
        this.closed = false;
        this.handleMessage = (event) => {
            if (this.closed) return;
            if (this.started) this.onmessage?.(event.data);
            else this.queue.push(event.data);
        };
        this.handleError = (event) => {
            this.onerror?.(event.error ?? new Error(event.message ?? 'postMessage transport error'));
        };
        // Listen from construction so nothing sent before start() is lost.
        port.addEventListener('message', this.handleMessage);
        port.addEventListener('messageerror', this.handleError);
        port.start?.(); // a MessagePort delivers nothing until started
    }

    async start() {
        if (this.started) throw new Error('PostMessageTransport already started');
        this.started = true;
        while (this.queue.length && !this.closed) this.onmessage?.(this.queue.shift());
    }

    async send(message) {
        if (this.closed) throw new Error('Not connected');
        this.port.postMessage(message);
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        this.queue = [];
        this.port.removeEventListener('message', this.handleMessage);
        this.port.removeEventListener('messageerror', this.handleError);
        this.onclose?.();
    }
}
