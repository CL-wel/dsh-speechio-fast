/**
 * 本地 Qwen3-ASR（llama.cpp llama-server）客户端与服务管理。
 *
 * 行为对齐参考实现 ASR/dictate.py + start_asr.ps1：
 *   - 先探测 127.0.0.1:<port>/health
 *   - 没起就从 <asrRoot>/llama.cpp/<backend>/llama-server.exe 拉一个
 *   - 录音按 VAD 断句，每句 POST /v1/audio/transcriptions
 *   - 结果剥掉模型自带的 "language xxx<asr_text>" 前缀
 *
 * 不依赖 Python、sounddevice、webrtcvad；麦克风采集在浏览器完成。
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  TARGET_RATE,
  joinTranscripts,
  normalizePcm,
  parseWav,
  segmentSpeech,
} from "./wav.js";

const PREFIX = /^\s*language\s+\S+\s*<asr_text>/i;

/** 把配置里的后端写法归一成 UI 使用的三种模式。 */
export function normalizeBackendMode(value) {
  const text = String(value ?? "auto").toLowerCase();
  if (text === "gpu" || text === "vulkan") return "gpu";
  if (text === "cpu") return "cpu";
  return "auto";
}

/** 模式对应的 llama.cpp 目录/候选顺序。 */
function backendPreference(mode) {
  if (mode === "gpu") return "vulkan";
  if (mode === "cpu") return "cpu";
  return "auto";
}

function backendMatchesMode(mode, backend) {
  // 显式 llamaServer 只有一个可执行文件，没有 GPU/CPU 两套目录可切。
  if (backend === "custom") return true;
  if (mode === "gpu") return backend === "vulkan";
  if (mode === "cpu") return backend === "cpu";
  return backend === "vulkan" || backend === "cpu";
}

const DEFAULTS = {
  asrRoot: "",
  llamaServer: "",
  model: "",
  mmproj: "",
  port: 10012,
  backend: "auto",
  autoStart: true,
  threads: 8,
  contextSize: 2048,
  ngl: 99,
  mmprojOffload: true,
  modelFile: "Qwen3-ASR-0.6B-Q8_0.gguf",
  mmprojFile: "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
  prompt: "请转写这段语音。",
  startupTimeoutMs: 90_000,
  requestTimeoutMs: 120_000,
  maxUtteranceSeconds: 15,
  silenceMs: 550,
};

/** 程序与模型解耦后的默认模型目录：<DSH_HOME>/speechio（通常是 ~/.dsh/speechio）。 */
export function defaultAsrRoot() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "speechio");
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

// 本插件拉起、尚未退出的 llama-server；DSH 进程退出时兜底清理，避免留下孤儿进程。
const liveServers = new Set();
let exitHookInstalled = false;

function trackServer(proc) {
  liveServers.add(proc);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of liveServers) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
  });
}

function untrackServer(proc) {
  liveServers.delete(proc);
}

function abortError() {
  const error = new Error("转写已取消");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/** 在 signal 取消时 reject，但不取消被等待的共享任务。 */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function resolveLayout(options) {
  // 方式一：完全显式 —— 程序只认三个路径，适合已经装好 llama.cpp 的用户。
  if (options.llamaServer) {
    const exe = resolve(options.llamaServer);
    if (!existsSync(exe)) throw new Error(`llamaServer 不存在：${exe}`);
    if (!options.model) throw new Error("配置了 llamaServer 时必须同时配置 model");
    if (!options.mmproj) throw new Error("配置了 llamaServer 时必须同时配置 mmproj");
    const model = resolve(options.model);
    const mmproj = resolve(options.mmproj);
    if (!existsSync(model)) throw new Error(`model 不存在：${model}`);
    if (!existsSync(mmproj)) throw new Error(`mmproj 不存在：${mmproj}`);
    return { root: dirname(exe), model, mmproj, llamaBase: "", exe, explicit: true };
  }

  // 方式二：约定目录 —— <asrRoot>/ASR/*.gguf + <asrRoot>/llama.cpp/<backend>/llama-server.exe
  const root = resolve(options.asrRoot || defaultAsrRoot());
  if (!existsSync(root)) {
    throw new Error(
      `模型目录不存在：${root}。请先运行 scripts/setup.ps1，或配置 asrRoot / llamaServer+model+mmproj`,
    );
  }

  const candidates = [join(root, "ASR", options.modelFile), join(root, options.modelFile)];
  const model = candidates.find((path) => existsSync(path));
  if (!model) {
    throw new Error(
      `在 ${root} 下找不到 ${options.modelFile}（应位于 ASR/ 子目录或根目录）`,
    );
  }
  const mmproj = existsSync(join(dirname(model), options.mmprojFile))
    ? join(dirname(model), options.mmprojFile)
    : join(root, "ASR", options.mmprojFile);
  if (!existsSync(mmproj)) throw new Error(`找不到 mmproj：${mmproj}`);

  // 从模型目录向上找 llama.cpp，适配“根目录 = voice”与“根目录 = voice/ASR”两种布局。
  let base = dirname(model);
  let llamaBase = "";
  for (let depth = 0; depth < 4; depth++) {
    if (existsSync(join(base, "llama.cpp"))) {
      llamaBase = join(base, "llama.cpp");
      break;
    }
    const parent = dirname(base);
    if (parent === base) break;
    base = parent;
  }
  if (!llamaBase) throw new Error(`在 ${root} 附近找不到 llama.cpp 目录`);

  return { root, model, mmproj, llamaBase, exe: "", explicit: false };
}

function backendCandidates(options, layout) {
  if (layout.explicit) return [{ backend: "custom", exe: layout.exe }];
  const wanted = String(options.backend || "auto").toLowerCase();
  const exists = (name) =>
    existsSync(join(layout.llamaBase, name, "llama-server.exe")) &&
    statSync(join(layout.llamaBase, name, "llama-server.exe")).isFile();
  const names = wanted === "cpu" || wanted === "vulkan" ? [wanted] : ["vulkan", "cpu"];
  return names
    .filter((name) => exists(name))
    .map((name) => ({ backend: name, exe: join(layout.llamaBase, name, "llama-server.exe") }));
}

function health(port, timeoutMs = 1200) {
  return new Promise((done) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/health", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 4096) body += chunk;
        });
        res.on("end", () => done(res.statusCode === 200 && /ok/i.test(body)));
        res.on("error", () => done(false));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.on("error", () => done(false));
  });
}

export class AsrService {
  constructor(options, log = () => {}) {
    this.options = { ...DEFAULTS, ...options };
    this.mode = normalizeBackendMode(this.options.backend);
    this.options.backend = backendPreference(this.mode);
    this.log = log;
    this.proc = null;
    this.backend = "";
    this.ensureTask = null;
    this.disposed = false;
    this.stderrTail = "";
    this.layout = null;
    this.queue = Promise.resolve();
    this.externalWarned = false;
    this.gpuFailed = false;
  }

  /** 约定目录下是否存在某个后端的 llama-server.exe。 */
  hasBackend(name) {
    try {
      const layout = this.layout ?? (this.layout = resolveLayout(this.options));
      if (layout.explicit) return true;
      return existsSync(join(layout.llamaBase, name, "llama-server.exe"));
    } catch {
      return false;
    }
  }

  /** 把一次识别请求串行化：llama-server 一次只应接收一个请求，也避免切换后端时互相打断。 */
  enqueue(task, signal) {
    const run = this.queue.then(async () => {
      throwIfAborted(signal);
      return task();
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 当前请求模式；UI 的 GPU/CPU 开关通过 Provider 选择传入。 */
  get backendMode() {
    return this.mode;
  }

  /**
   * 切换识别后端。仅由本插件拉起的 llama-server 会被重启；
   * 用户手动启动的外部服务无法安全热切换，只记录一次警告。
   */
  async useBackend(mode, signal) {
    const wanted = normalizeBackendMode(mode);
    throwIfAborted(signal);
    const owned = this.proc && this.proc.exitCode === null;
    // auto 在冷启动时优先 GPU；从 CPU 切回 auto 时也尝试重新用 GPU，
    // 但本次进程里 GPU 已经失败过就不再反复重启。
    const preferGpu =
      wanted === "auto" &&
      owned &&
      this.backend === "cpu" &&
      !this.gpuFailed &&
      this.hasBackend("vulkan");
    if (
      wanted === this.mode &&
      (this.backend === "" || backendMatchesMode(wanted, this.backend)) &&
      !preferGpu
    ) {
      return;
    }
    this.mode = wanted;
    this.options.backend = backendPreference(wanted);

    if (owned && (preferGpu || !backendMatchesMode(wanted, this.backend))) {
      this.log("info", `切换识别后端：${this.backend || "未启动"} → ${wanted}`);
      await this.stopServer();
      return;
    }
    if (!owned && (await health(this.port)) && !this.externalWarned) {
      this.externalWarned = true;
      this.log(
        "warn",
        `端口 ${this.port} 上已有外部启动的 ASR 服务，CPU/GPU 热切换只对本插件拉起的服务生效；` +
          "如需切换，请先手动停止它。",
      );
    }
  }

  /** 停止本插件拉起的服务；外部服务不动。 */
  async stopServer() {
    const proc = this.proc;
    this.proc = null;
    this.backend = "";
    if (!proc || proc.exitCode !== null) return;
    try {
      proc.kill();
    } catch {
      // ignore
    }
    const deadline = Date.now() + 3000;
    while (proc.exitCode === null && Date.now() < deadline) await delay(50);
    if (proc.exitCode === null) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
    untrackServer(proc);
  }

  get port() {
    return Number(this.options.port) || 10012;
  }

  /** 只读状态，方便自检脚本与排障。 */
  async status() {
    let layout = null;
    let layoutError = null;
    try {
      layout = this.layout ?? (this.layout = resolveLayout(this.options));
    } catch (error) {
      layoutError = error instanceof Error ? error.message : String(error);
    }
    return {
      port: this.port,
      mode: this.mode,
      backend: this.backend || this.options.backend,
      serverDown: !(await health(this.port)),
      owned: Boolean(this.proc && this.proc.exitCode === null),
      pid: this.proc?.pid ?? null,
      layout,
      layoutError,
    };
  }

  /** 服务在跑就直接返回；否则拉起一个（并发调用共享同一次启动）。 */
  async ensureRunning(signal) {
    if (this.disposed) throw new Error("语音服务已卸载");
    throwIfAborted(signal);
    if (await health(this.port)) {
      if (!this.proc || backendMatchesMode(this.mode, this.backend)) return;
      // 本插件拉起、但后端与当前选择不符：先停掉再重新启动。
      await this.stopServer();
    }
    if (!this.ensureTask) {
      this.ensureTask = this.startServer().finally(() => {
        this.ensureTask = null;
      });
    }
    await untilAborted(this.ensureTask, signal);
  }

  async startServer() {
    if (!this.options.autoStart) {
      throw new Error(`ASR 服务未运行（${this.port}），且 autoStart 已关闭`);
    }
    const layout = this.layout ?? (this.layout = resolveLayout(this.options));
    const backends = backendCandidates(this.options, layout);
    if (backends.length === 0) {
      const where = layout.explicit ? layout.exe : `${layout.llamaBase}/<backend>/llama-server.exe`;
      if (!layout.explicit && this.mode === "gpu") {
        throw new Error(
          `找不到 Vulkan（GPU）版 llama-server.exe（${where}）。` +
            "请先运行 scripts/setup.ps1 -Backend vulkan，或在插件页切换为 CPU。",
        );
      }
      if (!layout.explicit && this.mode === "cpu") {
        throw new Error(
          `找不到 CPU 版 llama-server.exe（${where}）。请先运行 scripts/setup.ps1 -Backend cpu。`,
        );
      }
      throw new Error(`找不到可用的 llama-server.exe（${where}）`);
    }

    const failures = [];
    for (const candidate of backends) {
      const { backend, exe } = candidate;
      const args = [
        "-m",
        layout.model,
        "--mmproj",
        layout.mmproj,
        "-c",
        String(this.options.contextSize),
        "-t",
        String(this.options.threads),
        "--host",
        "127.0.0.1",
        "--port",
        String(this.port),
        "--no-webui",
        ...this.offloadArgs(layout, backend),
      ];

      this.log("info", `启动 ASR 服务（${backend}, port=${this.port}）：${exe}`);
      const proc = spawn(exe, args, {
        cwd: dirname(exe),
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      this.stderrTail = "";
      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (chunk) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-8000);
      });

      const started = await this.waitForServer(proc);
      if (started && !this.disposed) {
        this.proc = proc;
        this.backend = backend;
        if (backend === "vulkan") this.gpuFailed = false;
        trackServer(proc);
        proc.once("exit", (code) => {
          untrackServer(proc);
          if (this.proc === proc) {
            this.proc = null;
            this.log("warn", `ASR 服务已退出（code=${code}）`);
          }
        });
        this.log("info", `ASR 服务就绪（${backend}, pid=${proc.pid}）`);
        return;
      }

      proc.kill();
      if (backend === "vulkan") this.gpuFailed = true;
      if (this.disposed) throw new Error("语音服务已卸载");
      failures.push(`${backend}: ${this.stderrTail.trim().split(/\r?\n/).slice(-3).join(" | ") || "启动超时"}`);
    }

    throw new Error(
      `ASR 服务启动失败。${failures.join("；")}。` +
        (layout.explicit
          ? `请检查 llamaServer：${layout.exe}`
          : `可先运行 ${join(layout.root, "ASR", "start_asr.ps1")} 查看日志`),
    );
  }

  /** 显式 llamaServer 时按 ngl 决定卸载；约定目录时按后端给默认值。 */
  offloadArgs(layout, backend) {
    if (layout.explicit) {
      const ngl = Number(this.options.ngl);
      if (ngl > 0) {
        return [
          "-ngl",
          String(ngl),
          ...(this.options.mmprojOffload !== false ? ["--mmproj-offload"] : []),
        ];
      }
      return ["-ngl", "0"];
    }
    return backend === "vulkan" ? ["-ngl", "99", "--mmproj-offload"] : ["-ngl", "0"];
  }

  async waitForServer(proc) {
    const deadline = Date.now() + this.options.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) return false;
      if (await health(this.port)) return true;
      await delay(400);
    }
    return false;
  }

  async transcribe(wavBytes, signal, mode = this.mode) {
    return this.enqueue(async () => {
      throwIfAborted(signal);
      const parsed = parseWav(wavBytes);
      const samples = normalizePcm(parsed.samples, parsed.sampleRate, parsed.channels);
      if (samples.length < TARGET_RATE * 0.15) throw new Error("录音太短");

      const { wavs } = segmentSpeech(samples, {
        maxUtteranceSeconds: this.options.maxUtteranceSeconds,
        silenceMs: this.options.silenceMs,
      });
      if (wavs.length === 0) throw new Error("没有检测到语音");

      await this.useBackend(mode, signal);
      await this.ensureRunning(signal);
      const startedAt = Date.now();
      const texts = [];
      for (const wav of wavs) {
        throwIfAborted(signal);
        const text = await this.postTranscription(wav, signal);
        if (text) texts.push(text);
      }
      return {
        text: joinTranscripts(texts),
        audioSeconds: Number((samples.length / TARGET_RATE).toFixed(2)),
        inferenceSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
        segments: wavs.length,
        backend: this.backend || this.mode,
      };
    }, signal);
  }

  postTranscription(wav, signal) {
    const boundary = `----speechio-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    const field = (name, value) =>
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        "utf8",
      );
    const body = Buffer.concat([
      field("model", "qwen3-asr"),
      field("prompt", this.options.prompt),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
        "utf8",
      ),
      wav,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);

    return new Promise((resolvePromise, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: this.port,
          path: "/v1/audio/transcriptions",
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": String(body.length),
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
              reject(new Error(`ASR 返回 ${response.statusCode}：${text.slice(0, 300)}`));
              return;
            }
            try {
              const json = JSON.parse(text);
              resolvePromise(String(json.text ?? "").replace(PREFIX, "").trim());
            } catch (error) {
              const hint = text.slice(0, 160).replace(/[^\x20-\x7e]/g, ".");
              reject(
                new Error(
                  `ASR 返回无法解析（${error instanceof Error ? error.message : error}）：${hint}`,
                ),
              );
            }
          });
        },
      );

      const onAbort = () => {
        request.destroy();
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      request.setTimeout(this.options.requestTimeoutMs, () => {
        request.destroy(new Error(`ASR 请求超时（${this.options.requestTimeoutMs} ms）`));
      });
      request.on("error", (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      request.on("close", () => signal?.removeEventListener("abort", onAbort));
      request.end(body);
    });
  }

  /** 后台预热，失败只记日志，不影响 DSH 启动。 */
  warmUp(mode = this.mode) {
    if (this.disposed || !this.options.autoStart) return Promise.resolve();
    return this.enqueue(async () => {
      await this.useBackend(mode);
      await this.ensureRunning();
    }).catch((error) => {
      this.log("warn", `ASR 预热失败：${error instanceof Error ? error.message : error}`);
    });
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.stopServer();
  }
}

export { health as asrHealth };
