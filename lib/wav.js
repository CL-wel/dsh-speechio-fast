/**
 * WAV 读写与语音断句。
 *
 * 这里把参考实现 ASR/dictate.py 的 Segmenter 原样搬到 Node：
 *   - 16 kHz 单声道 PCM16
 *   - 20 ms 一帧
 *   - 停顿 550 ms 切一句，最短语音 250 ms
 *   - 单句最长 15 s，预卷 240 ms，结尾留 160 ms
 *
 * 区别只在“谁判断是不是人声”：Python 用 webrtcvad，这里用带迟滞的
 * 自适应能量阈值，省掉原生依赖，浏览器/Node 都能跑。
 */

export const TARGET_RATE = 16000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (TARGET_RATE * FRAME_MS) / 1000; // 320

const DEFAULTS = {
  silenceMs: 550,
  minSpeechMs: 250,
  maxUtteranceSeconds: 15,
  prerollMs: 240,
  padMs: 160,
  startMs: 60,
};

/** 解析 WAV；只接受 16 bit PCM。返回 { sampleRate, channels, samples }。 */
export function parseWav(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 12) throw new Error("WAV 数据太短");
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("不是 RIFF/WAVE 音频");
  }

  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buf.length) break;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
    }
    offset = body + size + (size & 1);
  }

  if (!fmt) throw new Error("WAV 缺少 fmt 块");
  if (!data) throw new Error("WAV 缺少 data 块");
  if (fmt.format !== 1) throw new Error(`只支持 PCM WAV（当前 format=${fmt.format}）`);
  if (fmt.bitsPerSample !== 16) throw new Error(`只支持 16 bit WAV（当前 ${fmt.bitsPerSample} bit）`);
  if (fmt.channels < 1) throw new Error("WAV 声道数无效");

  const samples = new Int16Array(Math.floor(data.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
}

/** 把 16 bit PCM 写成 16 kHz 单声道 WAV。 */
export function encodeWav(samples, sampleRate = TARGET_RATE) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(samples[i], i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 简单线性重采样；输入输出都是 Int16。 */
export function resample(samples, srcRate, dstRate = TARGET_RATE) {
  if (srcRate === dstRate || samples.length === 0) return samples;
  const ratio = dstRate / srcRate;
  const length = Math.max(1, Math.round(samples.length * ratio));
  const out = new Int16Array(length);
  const last = samples.length - 1;
  for (let i = 0; i < length; i++) {
    const at = i / ratio;
    const i0 = Math.min(last, Math.floor(at));
    const i1 = Math.min(last, i0 + 1);
    const t = at - i0;
    out[i] = Math.round(samples[i0] * (1 - t) + samples[i1] * t);
  }
  return out;
}

/** 多声道混成单声道。 */
export function toMono(samples, channels) {
  if (channels <= 1) return samples;
  const length = Math.floor(samples.length / channels);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c];
    out[i] = Math.round(sum / channels);
  }
  return out;
}

/** 把任意采样率/声道数的 PCM16 归一到 16 kHz 单声道。 */
export function normalizePcm(samples, sampleRate, channels) {
  return resample(toMono(samples, channels), sampleRate, TARGET_RATE);
}

function frameRms(samples, start, length) {
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const value = samples[start + i] / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / length);
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * fraction)));
  return sorted[index];
}

/**
 * 按参考实现的参数把连续 PCM 切成一话一话。
 *
 * @param {Int16Array} samples 16 kHz 单声道
 * @param {object} [options]
 * @returns {{ wavs: Buffer[], segments: Array<{start:number,duration:number}>, stats: object }}
 */
export function segmentSpeech(samples, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const frameCount = Math.floor(samples.length / FRAME_SAMPLES);
  const energies = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    energies[f] = frameRms(samples, f * FRAME_SAMPLES, FRAME_SAMPLES);
  }
  const sorted = Array.from(energies).sort((a, b) => a - b);
  const noise = percentile(sorted, 0.2);
  // 静音底噪的 2.4 倍作为开口阈值；继续说话的阈值更低，避免句子被切碎。
  const high = Math.min(0.04, Math.max(0.0065, noise * 2.4));
  const low = Math.min(0.03, Math.max(0.0035, noise * 1.5));

  const silenceFrames = Math.round(opts.silenceMs / FRAME_MS);
  const minSpeechFrames = Math.round(opts.minSpeechMs / FRAME_MS);
  const maxFrames = Math.round((opts.maxUtteranceSeconds * 1000) / FRAME_MS);
  const padFrames = Math.round(opts.padMs / FRAME_MS);
  const prerollFrames = Math.round(opts.prerollMs / FRAME_MS);
  const startFrames = Math.max(1, Math.round(opts.startMs / FRAME_MS));

  const preroll = [];
  let active = false;
  let buffer = [];
  let speechRun = 0;
  let speechCount = 0;
  let silenceRun = 0;
  let startFrame = 0;
  let voicing = false;
  const wavs = [];
  const segments = [];

  const reset = () => {
    active = false;
    buffer = [];
    speechRun = 0;
    speechCount = 0;
    silenceRun = 0;
    startFrame = 0;
    preroll.length = 0;
  };

  const flush = () => {
    if (buffer.length === 0) {
      reset();
      return;
    }
    // 掐掉结尾多余的静音，保留 pad 余量
    const keep = buffer.length - Math.max(0, silenceRun - padFrames);
    const frames = buffer.slice(0, Math.max(0, keep));
    const enough = speechCount >= minSpeechFrames;
    const pcm = Buffer.concat(frames);
    const segmentStart = startFrame;
    reset();
    if (!enough || pcm.length < FRAME_SAMPLES * 2 * 5) return;
    wavs.push(encodeWav(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)));
    segments.push({ start: (segmentStart * FRAME_MS) / 1000, duration: pcm.length / 2 / TARGET_RATE });
  };

  for (let f = 0; f < frameCount; f++) {
    const energy = energies[f];
    voicing = voicing ? energy > low : energy > high;
    const frame = Buffer.from(samples.buffer, samples.byteOffset + f * FRAME_SAMPLES * 2, FRAME_SAMPLES * 2).subarray();

    if (!active) {
      if (voicing) {
        speechRun++;
        if (preroll.length >= prerollFrames) preroll.shift();
        preroll.push(frame);
        if (speechRun >= startFrames) {
          active = true;
          buffer = preroll.slice();
          speechCount = speechRun;
          silenceRun = 0;
          startFrame = Math.max(0, f - speechRun + 1);
        }
      } else {
        speechRun = 0;
        if (preroll.length >= prerollFrames) preroll.shift();
        preroll.push(frame);
      }
      continue;
    }

    buffer.push(frame);
    if (voicing) {
      speechCount++;
      silenceRun = 0;
    } else {
      silenceRun++;
    }
    if (buffer.length >= maxFrames || silenceRun >= silenceFrames) flush();
  }

  // 收尾：还没断句的半句话也送出去
  if (active && speechCount >= minSpeechFrames) flush();
  else reset();

  if (wavs.length === 0 && samples.length > 0) {
    // 能量门限没抓到（例如音量极低）：整段兜底，避免“说了却没字”。
    // 但纯静音不能兜底，否则模型会对静音产生幻觉文本。
    let peak = 0;
    for (let f = 0; f < frameCount; f++) peak = Math.max(peak, energies[f]);
    if (peak >= Math.max(0.0065, high * 0.8)) {
      const maxSamples = Math.round(opts.maxUtteranceSeconds * TARGET_RATE);
      for (let offset = 0; offset < samples.length; offset += maxSamples) {
        const chunk = samples.subarray(offset, Math.min(samples.length, offset + maxSamples));
        if (chunk.length < TARGET_RATE * 0.2) continue;
        wavs.push(encodeWav(chunk));
        segments.push({ start: offset / TARGET_RATE, duration: chunk.length / TARGET_RATE });
      }
    }
  }

  return {
    wavs,
    segments,
    stats: {
      frames: frameCount,
      noiseFloor: Number(noise.toFixed(4)),
      threshold: Number(high.toFixed(4)),
      seconds: samples.length / TARGET_RATE,
    },
  };
}

/** 把逐句结果拼成一段可插入草稿的文字。中文之间不留空格。 */
export function joinTranscripts(parts) {
  let out = "";
  for (const raw of parts) {
    const part = String(raw ?? "").trim();
    if (!part) continue;
    if (!out) {
      out = part;
      continue;
    }
    const prev = out[out.length - 1];
    const next = part[0];
    const cjk = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
    out += cjk.test(prev) || cjk.test(next) ? part : ` ${part}`;
  }
  return out.trim();
}
