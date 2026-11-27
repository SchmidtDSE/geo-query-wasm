import { describe, it, expect } from 'vitest';
import { addFile, removeFile, FILES_MESSAGE } from '../src/files.js';

// A stand-in for a Worker: answers file messages as `reply` says, and counts
// its listeners so a test can see that none is left behind.
function fakeWorker(reply) {
    const target = new EventTarget();
    const listeners = new Map();
    const worker = {
        sent: [],
        addEventListener(type, fn) { listeners.set(fn, type); target.addEventListener(type, fn); },
        removeEventListener(type, fn) { listeners.delete(fn); target.removeEventListener(type, fn); },
        listening: () => listeners.size,
        postMessage(message, transfer) {
            worker.sent.push({ message, transfer });
            const answer = reply?.(message);
            if (answer) queueMicrotask(() => target.dispatchEvent(Object.assign(new Event('message'), { data: { type: FILES_MESSAGE, id: message.id, ...answer } })));
        },
        fail(message) { target.dispatchEvent(Object.assign(new Event('error'), { message })); },
    };
    return worker;
}

describe('files from the page', () => {
    it('sends the bytes, transferring the buffer, and resolves with the answer', async () => {
        const w = fakeWorker((m) => ({ ok: true, result: { name: m.name, bytes: m.bytes.byteLength } }));
        const buf = new Uint8Array([1, 2, 3]).buffer;
        expect(await addFile(w, buf, 'a.csv')).toEqual({ name: 'a.csv', bytes: 3 });
        expect(w.sent[0].message).toMatchObject({ type: FILES_MESSAGE, op: 'add', name: 'a.csv' });
        expect(w.sent[0].transfer).toEqual([buf]);
        expect(w.listening()).toBe(0);
    });

    it("takes a File's own name, and copies a Uint8Array instead of emptying it", async () => {
        const w = fakeWorker((m) => ({ ok: true, result: m.name }));
        expect(await addFile(w, new File(['{}'], 'site.geojson'))).toBe('site.geojson');
        const bytes = new Uint8Array([1, 2]);
        await addFile(w, bytes, 'b.csv');
        expect(bytes.byteLength).toBe(2);
        await expect(addFile(w, 'text', 'c.csv')).rejects.toThrow(/File, Blob, ArrayBuffer or Uint8Array/);
    });

    it("rejects with the worker's error", async () => {
        const w = fakeWorker(() => ({ ok: false, error: 'run.sh: only .geojson files can be added' }));
        await expect(removeFile(w, 'run.sh')).rejects.toThrow(/only \.geojson/);
        expect(w.listening()).toBe(0);
    });

    it('rejects when the worker fails, and stops listening', async () => {
        const w = fakeWorker(null);
        const pending = removeFile(w, 'a.csv');
        w.fail('out of memory');
        await expect(pending).rejects.toThrow('the worker failed: out of memory');
        expect(w.listening()).toBe(0);
    });

    it('rejects when a worker never answers, such as one too old to know the message', async () => {
        const w = fakeWorker(null);
        await expect(removeFile(w, 'a.csv', { timeout: 20 })).rejects.toThrow(/did not answer in 0 s; .* older than v0\.8\.0/);
        expect(w.listening()).toBe(0);
    });
});
