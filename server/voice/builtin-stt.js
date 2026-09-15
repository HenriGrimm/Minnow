/** Managed built-in dictation. No Python, pip, GPU or provider credentials. */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import fs from 'node:fs';
import { getVoiceModelsRoot } from './paths.js';
import { decodeVoiceWav } from './builtin-audio.js';

let worker;
let preparation;
let nextId = 0;
const pending = new Map();
let state = { phase: 'idle', progress: null, error: null };
const cacheDir = () => path.join(getVoiceModelsRoot(), 'builtin');

export function getBuiltinSttStatus() {
  return { ...state, cached: fs.existsSync(path.join(cacheDir(), 'Xenova', 'whisper-tiny', 'onnx', 'encoder_model_quantized.onnx')) };
}

function failWorker(error, current) {
  if (worker !== current) return;
  worker = null;
  state = { phase: 'error', progress: null, error: error.message };
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
  void current.terminate();
}

function request(payload) {
  if (!worker) {
    const current = new Worker(new URL('./builtin-worker.js', import.meta.url), {
      workerData: { cacheDir: cacheDir() },
      execArgv: [],
    });
    worker = current;
    current.on('message', (message) => {
      if (worker !== current) return;
      if (!message.id) {
        state = { phase: 'loading', progress: message.progress ?? null, error: null };
        return;
      }
      const item = pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(message.id);
      if (message.error) {
        state = { phase: 'error', progress: null, error: message.error };
        item.reject(new Error(message.error));
      } else {
        state = { phase: 'ready', progress: 100, error: null };
        item.resolve(message.text);
      }
      if (!pending.size) current.unref();
    });
    current.on('error', (error) => failWorker(error, current));
    current.on('exit', (code) => failWorker(new Error(`Dictation stopped (${code}). Try again.`), current));
  }
  if (pending.size >= 4) return Promise.reject(new Error('Dictation is busy. Try again shortly.'));
  const current = worker;
  current.ref();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      failWorker(new Error('Dictation timed out. Check your connection and try again.'), current);
    }, 10 * 60_000);
    pending.set(id, { resolve, reject, timer });
    current.postMessage({ id, ...payload });
  });
}

export function prepareBuiltinStt() {
  if (state.phase === 'ready') return Promise.resolve();
  if (!preparation) {
    state = { phase: 'loading', progress: null, error: null };
    preparation = request({}).finally(() => { preparation = null; });
  }
  return preparation;
}

export async function transcribeBuiltin({ audioBuffer, language, maxDurationSeconds }) {
  const samples = decodeVoiceWav(audioBuffer, maxDurationSeconds);
  if (!samples.length || !samples.some((sample) => Math.abs(sample) > 0.001)) return '';
  await prepareBuiltinStt();
  return request({ samples, language });
}
