// 速度自检：用真实 WAV 测“音频时长 vs 转写耗时”。
//
//   node scripts/bench.mjs --root "C:\Users\<you>\.dsh\speechio" --wav a.wav b.wav --repeat 5
//
// 输出（每个文件取中位数）：
//   audio   音频时长
//   wall    端到端耗时（断句 + HTTP + 模型）
//   asr     Provider 统计的识别耗时（服务已就绪后的 HTTP + 模型）
//   RTF     wall / audio，越低越快
//   xRT     audio / wall，越高越快（例如 20x 表示 20 倍实时）
//
// 注意：首次请求包含服务预热；脚本会先跑一遍 warmup，不计入统计。
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { AsrService, defaultAsrRoot, resolveLayout } from "../lib/asr.js";
import { normalizePcm, parseWav, segmentSpeech } from "../lib/wav.js";

function parseArgs(argv) {
  const options = { root: "", backend: "auto", port: 10013, repeat: 3, wavs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") options.root = argv[++i];
    else if (arg === "--backend") options.backend = argv[++i];
    else if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--repeat") options.repeat = Number(argv[++i]);
    else if (arg === "--wav") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) options.wavs.push(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/bench.mjs --root <dir> --wav <file...> [--backend auto|cpu|vulkan] [--repeat 3] [--port 10013]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
if (args.wavs.length === 0) {
  console.error("请用 --wav 指定至少一个 16 kHz 单声道 WAV 文件");
  process.exit(2);
}

const root = args.root || defaultAsrRoot();

const service = new AsrService(
  { asrRoot: root, backend: args.backend, port: args.port, autoStart: true },
  (level, message) => console.error(`[${level}] ${message}`),
);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmt(value, digits = 2) {
  return Number(value).toFixed(digits);
}

let layout;
try {
  layout = resolveLayout({
    asrRoot: root,
    backend: args.backend,
    llamaServer: "",
    model: "",
    mmproj: "",
    modelFile: "Qwen3-ASR-0.6B-Q8_0.gguf",
    mmprojFile: "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
  });
} catch (error) {
  console.error(`布局检查失败：${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

console.log(`model:   ${layout.model}`);
console.log(`mmproj:  ${layout.mmproj}`);
console.log(`runtime: ${layout.llamaBase || layout.exe}`);
console.log(`backend: ${args.backend}`);
console.log(`port:    ${args.port}`);

try {
  const started = performance.now();
  await service.ensureRunning();
  const startupSeconds = (performance.now() - started) / 1000;
  const status = await service.status();
  console.log(`startup: ${fmt(startupSeconds)} s (pid=${status.pid ?? "?"})`);
  console.log("");

  // 预热：第一句不计入统计
  const warm = readFileSync(args.wavs[0]);
  await service.transcribe(warm);

  const rows = [];
  for (const file of args.wavs) {
    const wav = readFileSync(file);
    const parsed = parseWav(wav);
    const samples = normalizePcm(parsed.samples, parsed.sampleRate, parsed.channels);
    const segmented = segmentSpeech(samples);
    const audioSeconds = samples.length / 16000;
    const wallTimes = [];
    const asrTimes = [];
    let text = "";

    for (let i = 0; i < args.repeat; i++) {
      const begin = performance.now();
      const result = await service.transcribe(wav);
      wallTimes.push((performance.now() - begin) / 1000);
      asrTimes.push(result.inferenceSeconds);
      if (!text) text = result.text;
    }

    const wall = median(wallTimes);
    const asr = median(asrTimes);
    rows.push({
      file: basename(file),
      audio: audioSeconds,
      segments: segmented.wavs.length,
      wall,
      asr,
      rtf: wall / audioSeconds,
      xrt: audioSeconds / wall,
      text: text.length > 60 ? `${text.slice(0, 60)}…` : text,
    });
  }

  console.log("| file | audio | segments | wall | asr | RTF | xRT |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    console.log(
      `| ${row.file} | ${fmt(row.audio)} s | ${row.segments} | ${fmt(row.wall)} s | ${fmt(row.asr)} s | ${fmt(row.rtf, 3)} | ${fmt(row.xrt, 1)}x |`,
    );
  }
  console.log("");
  for (const row of rows) {
    console.log(`${row.file}: ${row.text}`);
  }
} finally {
  await service.dispose();
}
