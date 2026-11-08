// 本机自检：不经过 DSH，直接跑 Provider 同一套代码。
//   node scripts/test-asr.mjs <wav> [wav ...]
// 默认模型目录为 <DSH_HOME>/speechio，可用 DSH_SPEECHIO_ASR_ROOT 覆盖。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AsrService, defaultAsrRoot } from "../lib/asr.js";
import { joinTranscripts, parseWav, segmentSpeech, normalizePcm } from "../lib/wav.js";

const ASR_ROOT = process.env.DSH_SPEECHIO_ASR_ROOT || defaultAsrRoot();
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/test-asr.mjs <16k-mono.wav> [more.wav ...]");
  console.error(`model root: ${ASR_ROOT}`);
  process.exit(2);
}

const service = new AsrService(
  { asrRoot: ASR_ROOT, port: 10012, backend: process.env.DSH_SPEECHIO_BACKEND || "auto" },
  (level, message) => console.log(`[${level}] ${message}`),
);

try {
  for (const file of files) {
    const path = resolve(file);
    const wav = readFileSync(path);
    const parsed = parseWav(wav);
    const samples = normalizePcm(parsed.samples, parsed.sampleRate, parsed.channels);
    const { wavs, segments, stats } = segmentSpeech(samples);
    console.log(`\n== ${path}`);
    console.log(
      `   ${parsed.sampleRate}Hz/${parsed.channels}ch  ${stats.seconds.toFixed(2)}s  ` +
        `底噪=${stats.noiseFloor} 阈值=${stats.threshold} 断句=${wavs.length}`,
    );
    console.log(
      "   " + segments.map((s) => `${s.start.toFixed(2)}s+${s.duration.toFixed(2)}s`).join("  "),
    );
    const result = await service.transcribe(wav);
    console.log(`   -> ${result.text}`);
    console.log(
      `   音频 ${result.audioSeconds}s / 推理 ${result.inferenceSeconds}s / ${result.segments} 句`,
    );
  }

  // 直接验证拼接函数（中文不留空格，英文留）
  console.log("\njoin:", joinTranscripts(["今天下午三点", "开会", "hello", "world"]));
} finally {
  await service.dispose();
}
