/** Isolate ONNX inference and its cache from the server and embedding models. */
import { parentPort, workerData } from 'node:worker_threads';
import { pipeline, env } from '@xenova/transformers';

env.cacheDir = workerData.cacheDir;
env.allowLocalModels = false;
let transcriber;
let queue = Promise.resolve();

async function prepare() {
  if (!transcriber) {
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
      quantized: true,
      progress_callback: (progress) => {
        if (progress.status === 'progress') {
          parentPort.postMessage({ progress: Math.round(progress.progress), file: progress.file });
        }
      },
    });
  }
}

parentPort.on('message', (request) => {
  queue = queue.then(async () => {
    try {
      await prepare();
      let text = '';
      if (request.samples) {
        const result = await transcriber(request.samples, {
          chunk_length_s: 30, stride_length_s: 5,
          ...(request.language ? { language: request.language } : {}),
          task: 'transcribe',
        });
        text = result.text.trim();
      }
      parentPort.postMessage({ id: request.id, text });
    } catch (error) {
      parentPort.postMessage({ id: request.id, error: error.message });
    }
  });
});
