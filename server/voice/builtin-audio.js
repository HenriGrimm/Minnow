/** Decode the renderer's 16 kHz mono PCM WAV without an external audio tool. */
export function decodeVoiceWav(buffer, maxDurationSeconds = 300) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Unsupported audio: built-in dictation requires PCM WAV');
  }
  let format;
  let data;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size > buffer.length - start) throw new Error('Unsupported truncated WAV');
    const id = buffer.toString('ascii', offset, offset + 4);
    if (id === 'fmt ' && size >= 16) {
      format = [buffer.readUInt16LE(start), buffer.readUInt16LE(start + 2),
        buffer.readUInt32LE(start + 4), buffer.readUInt16LE(start + 14)];
    }
    if (id === 'data') data = buffer.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || format.join(',') !== '1,1,16000,16' || !data || data.length % 2) {
    throw new Error('Unsupported audio: use 16 kHz mono 16-bit PCM WAV');
  }
  if (data.length / 2 > maxDurationSeconds * 16_000) {
    throw new Error('Audio exceeds the recording duration limit');
  }
  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return samples;
}
