/**
 * dsh-plugin-speechio-fast 的宿主半侧。
 *
 * 往 DSH 的 speechToText 服务注册三个共享同一份模型的 Provider：
 *   - qwen3-asr-local      自动（启动时 GPU 优先，失败回退 CPU）
 *   - qwen3-asr-local-gpu  只用 Vulkan
 *   - qwen3-asr-local-cpu  只用 CPU
 * 插件页的 CPU/GPU 开关就是选择其中一个 Provider；选择通过 DSH 的
 * settings 服务持久化，后端切换由 AsrService 在请求前完成。
 *
 * 浏览器半侧在本包的 ./client 导出里（麦克风按钮、实时转写、插件页设置）。
 * 模型与 llama.cpp 都不随本包发布；默认从 <DSH_HOME>/speechio 读取，
 * 也可以用 llamaServer + model + mmproj 直接指向任意已有安装。
 */
import { AsrService, defaultAsrRoot } from "./asr.js";

export const name = "speechio-fast";
export const inject = ["speechToText"];

const PROVIDER_ID = "qwen3-asr-local";

// 三个 Provider 共用同一个 AsrService（同一个端口、同一份模型），
// 区别只是让服务使用哪套 llama.cpp 后端。插件页的 CPU/GPU 开关
// 实际就是通过 speechToText.configure({ providerId }) 选择其中一个，
// 因此复用 DSH 自带的偏好持久化，不需要额外的 Host Remote。
const PROVIDERS = [
  {
    id: PROVIDER_ID,
    mode: "auto",
    name: "Qwen3-ASR 0.6B（自动 / GPU 优先）",
  },
  {
    id: "qwen3-asr-local-gpu",
    mode: "gpu",
    name: "Qwen3-ASR 0.6B（GPU / Vulkan）",
  },
  {
    id: "qwen3-asr-local-cpu",
    mode: "cpu",
    name: "Qwen3-ASR 0.6B（CPU）",
  },
];

// Qwen3-ASR 官方支持 30 种语言 + 22 种中文方言；这里列出语言提示，
// 实际识别由模型自动判断，language 只是提示。
const LANGUAGES = [
  "auto",
  "zh",
  "en",
  "yue",
  "ar",
  "de",
  "fr",
  "es",
  "pt",
  "id",
  "it",
  "ko",
  "ru",
  "th",
  "vi",
  "ja",
  "tr",
  "hi",
  "ms",
  "nl",
  "sv",
  "da",
  "fi",
  "pl",
  "cs",
  "fil",
  "fa",
  "el",
  "hu",
  "mk",
  "ro",
];

function resolveOptions(config = {}) {
  const env = process.env;
  return {
    asrRoot: config.asrRoot || env.DSH_SPEECHIO_ASR_ROOT || defaultAsrRoot(),
    llamaServer: config.llamaServer || env.DSH_SPEECHIO_LLAMA_SERVER || "",
    model: config.model || env.DSH_SPEECHIO_MODEL || "",
    mmproj: config.mmproj || env.DSH_SPEECHIO_MMPROJ || "",
    port: Number(config.port || env.DSH_SPEECHIO_ASR_PORT || 10012),
    backend: config.backend || env.DSH_SPEECHIO_BACKEND || "auto",
    autoStart: config.autoStart !== false,
    threads: Number(config.threads || 8),
    contextSize: Number(config.contextSize || 2048),
    ngl: config.ngl === undefined ? 99 : Number(config.ngl),
    mmprojOffload: config.mmprojOffload !== false,
    maxUtteranceSeconds: Number(config.maxUtteranceSeconds || 15),
    silenceMs: Number(config.silenceMs || 550),
  };
}

function makeLogger(ctx) {
  return (level, message) => {
    const text = `[speechio-fast] ${message}`;
    try {
      const method = ctx.logger?.[level];
      if (typeof method === "function") {
        method.call(ctx.logger, text);
        return;
      }
    } catch {
      // fall through
    }
    if (level === "error") console.error(text);
    else if (level === "warn") console.warn(text);
    else console.log(text);
  };
}

/**
 * 注册本机识别 Provider。
 * @param ctx Cordis 上下文（已注入 speechToText）。
 * @param config 组合包 patch 里的 entry.config。
 */
export function apply(ctx, config) {
  const options = resolveOptions(config);
  const log = makeLogger(ctx);
  const service = new AsrService(options, log);

  const makeProvider = ({ id, mode, name }) => ({
    info: {
      id,
      name,
      location: "host-local",
      languages: LANGUAGES,
    },

    /**
     * @param {{ audio: Buffer, language?: string }} input
     * @param {AbortSignal} signal
     */
    async transcribe(input, signal) {
      const result = await service.transcribe(input.audio, signal, mode);
      return {
        text: result.text,
        audioSeconds: result.audioSeconds,
        inferenceSeconds: result.inferenceSeconds,
      };
    },
  });

  ctx.effect(() => {
    const disposers = PROVIDERS.map((provider) =>
      ctx.speechToText.register(makeProvider(provider)),
    );
    const where = options.llamaServer
      ? `llamaServer=${options.llamaServer}`
      : `asrRoot=${options.asrRoot}`;
    log(
      "info",
      `已注册 Provider ${PROVIDERS.map((provider) => provider.id).join(", ")}` +
        `（${where}, port=${options.port}, 默认=${service.backendMode}）`,
    );
    return async () => {
      for (const dispose of disposers.reverse()) {
        try {
          await dispose();
        } catch {
          // keep unloading the remaining providers
        }
      }
      await service.dispose();
      log("info", "Provider 已卸载");
    };
  }, "speechio-fast: speech providers");

  // 后台预热：DSH 启动后先偷偷把模型加载好，第一次点麦克风就快。
  // 读取持久化的 Provider 选择，避免用户选了 CPU 却先加载 GPU。
  const warmup = setTimeout(() => {
    let mode = "auto";
    try {
      const selected = ctx.speechToText.snapshot()?.selection?.providerId;
      mode = PROVIDERS.find((provider) => provider.id === selected)?.mode ?? "auto";
    } catch {
      // snapshot 不可用时按 auto 预热
    }
    service.warmUp(mode);
  }, 2500);
  warmup.unref?.();
  ctx.effect(() => () => clearTimeout(warmup), "speechio-fast: warmup timer");
}
