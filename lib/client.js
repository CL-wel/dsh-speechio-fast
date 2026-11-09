window.__ModuleLoader__.load({
  id: "dsh-plugin-speechio-fast",
  factory: (require) => {
    const React = require("react");
    const {
      Button,
      Tooltip,
      StateDot,
      IconMicrophoneOutlineRegular,
      IconCloseOutlineRegular,
      IconStopFillRegular,
    } = require("@deepseek-ai/dsh-client-ui-primitives");

    const zodNs = require("zod");
    const z = zodNs.z ?? zodNs;

    const h = React.createElement;

    // ------------------------------------------------------------------
    // Remote descriptor
    //
    // The Host exposes speech through @deepseek-ai/dsh-experimental-api-speech-to-text.
    // Its generated browser contribution normally ships inside the built-in
    // voice-input client. This bundle replaces that UI, so it mounts a small
    // descriptor for the three calls it actually uses: catalog, configure and
    // transcribe. Only the declaration is duplicated here; routing and auth
    // still belong to the Host Gateway.
    // ------------------------------------------------------------------
    function createTypertRemoteInfo(spec, zod) {
      return new RemoteInfo(spec, zod);
    }

    class RemoteInfo {
      constructor(spec, zod) {
        this.spec = spec;
        this.zod = zod;
        this.index = undefined;
      }
      get package() {
        return this.spec.package;
      }
      get descriptors() {
        return this.resolve().descriptors;
      }
      get methods() {
        return this.resolve().methods;
      }
      resolve() {
        if (this.index !== undefined) return this.index;
        const zod = this.zod;
        const descriptors = [];
        const methods = Object.create(null);
        for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
          const separator = endpoint.indexOf("/");
          const namespace = endpoint.slice(0, separator);
          const method = endpoint.slice(separator + 1);
          const parameters = definition.parameters.map((parameter) => ({
            ...parameter,
            wire: parameter.wire ?? parameter.name,
          }));
          const descriptor = {
            ...definition,
            id: `${this.spec.package}#${endpoint}`,
            namespace,
            method,
            parameters,
            result:
              definition.result.description === undefined
                ? definition.result
                : new ResultValue(definition.result),
          };
          if (definition.invocation.kind === "direct") {
            const inputs = [];
            const direct = Object.assign(descriptor, {
              input(options) {
                const strict = options?.strict === true;
                return (inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zod));
              },
              invoke(remote, input, signal) {
                const named = input;
                const values = parameters.map((parameter) => named[parameter.wire]);
                if (definition.cancellation !== undefined) values.push(signal);
                const receiver = Reflect.get(remote, namespace);
                const call = Reflect.get(receiver, method);
                return call.apply(receiver, values);
              },
            });
            methods[endpoint] = direct;
          }
          descriptors.push(descriptor);
        }
        return (this.index = { descriptors, methods });
      }
    }

    function optional(parameter) {
      return parameter.source === "json" && parameter.acceptsUndefined === true;
    }

    class NamedInput {
      constructor(parameters, strict, zod) {
        this.parameters = parameters;
        this.strict = strict;
        this.zod = zod;
        this.schema = undefined;
        this.projection = undefined;
        this.create = () =>
          (this.schema ??= this.zod.strictObject(
            Object.fromEntries(
              this.parameters.map((parameter) => {
                const value = this.codec(parameter).create();
                return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()];
              }),
            ),
          ));
      }
      codec(parameter) {
        return this.strict ? parameter.strictCodec : parameter.codec;
      }
      get jsonSchema() {
        return this.project().jsonSchema;
      }
      get jsonSchemaError() {
        return this.project().jsonSchemaError;
      }
      project() {
        if (this.projection !== undefined) return this.projection;
        const unavailable = this.parameters.find(
          (parameter) => this.codec(parameter).jsonSchema === undefined,
        );
        if (unavailable !== undefined) {
          return (this.projection = {
            jsonSchemaError:
              this.codec(unavailable).jsonSchemaError ??
              `No JSON Schema for parameter ${unavailable.wire}`,
          });
        }
        return (this.projection = {
          jsonSchema: {
            type: "object",
            properties: Object.fromEntries(
              this.parameters.map((parameter) => [
                parameter.wire,
                {
                  ...this.codec(parameter).jsonSchema,
                  ...(parameter.description === undefined
                    ? {}
                    : { description: parameter.description }),
                },
              ]),
            ),
            required: this.parameters
              .filter((parameter) => !optional(parameter))
              .map((parameter) => parameter.wire),
            additionalProperties: false,
          },
        });
      }
    }

    class ResultValue {
      constructor(spec) {
        this.spec = spec;
        this.projection = undefined;
      }
      get mode() {
        return this.spec.mode;
      }
      get typeSymbol() {
        return this.spec.typeSymbol;
      }
      get create() {
        return this.spec.create;
      }
      get decode() {
        return this.spec.decode;
      }
      get encode() {
        return this.spec.encode;
      }
      get description() {
        return this.spec.description;
      }
      get jsonSchemaError() {
        return this.spec.jsonSchemaError;
      }
      get jsonSchema() {
        if (this.projection === undefined) {
          const schema = this.spec.jsonSchema;
          this.projection = {
            value: schema === undefined ? undefined : { ...schema, description: this.spec.description },
          };
        }
        return this.projection.value;
      }
    }

    const optionalString = () => z.string().readonly().optional();
    const configurePatch = () =>
      z.object({
        providerId: optionalString(),
        language: optionalString(),
      });
    const configurePatchStrict = () =>
      z.strictObject({
        providerId: optionalString(),
        language: optionalString(),
      });
    const transcriptionRequest = () =>
      z.object({
        audioBase64: z.string().readonly(),
        providerId: optionalString(),
        language: optionalString(),
      });
    const transcriptionRequestStrict = () =>
      z.strictObject({
        audioBase64: z.string().readonly(),
        providerId: optionalString(),
        language: optionalString(),
      });

    const SPEECH_REMOTE = createTypertRemoteInfo(
      {
        package: "@deepseek-ai/dsh-experimental-api-speech-to-text",
        methods: {
          "speech/catalog": {
            service: "speechController",
            description: "Read provider choices without preparing a recognizer.",
            invocation: { kind: "direct" },
            parameters: [],
            result: {
              mode: "strict",
              typeSymbol: "@deepseek-ai/dsh-experimental-api-speech-to-text#speech/catalog:result",
              create: () => z.any(),
              description: "available providers, resolved default, and recording limits.",
            },
          },
          "speech/configure": {
            service: "speechController",
            description: "Persist the user's recognition preferences.",
            invocation: { kind: "direct" },
            parameters: [
              {
                name: "patch",
                description: "changed preference fields.",
                source: "json",
                codec: {
                  mode: "strict",
                  typeSymbol: "@deepseek-ai/dsh-experimental-speech-to-text/types#SpeechSelectionPatch",
                  create: configurePatch,
                  jsonSchema: {
                    type: "object",
                    properties: { providerId: { type: "string" }, language: { type: "string" } },
                    required: [],
                    additionalProperties: true,
                  },
                },
                strictCodec: {
                  mode: "strict",
                  typeSymbol: "@deepseek-ai/dsh-experimental-speech-to-text/types#SpeechSelectionPatch",
                  create: configurePatchStrict,
                  jsonSchema: {
                    type: "object",
                    properties: { providerId: { type: "string" }, language: { type: "string" } },
                    required: [],
                    additionalProperties: false,
                  },
                },
              },
            ],
            result: {
              mode: "strict",
              typeSymbol: "@deepseek-ai/dsh-experimental-api-speech-to-text#speech/configure:result",
              create: () => z.any(),
              description: "after preferences are saved.",
            },
          },
          "speech/transcribe": {
            service: "speechController",
            description: "Validate and transcribe one recording through the explicit provider selection.",
            invocation: { kind: "direct" },
            parameters: [
              {
                name: "request",
                description: "canonical WAV encoded as base64, provider id and language hint.",
                source: "json",
                codec: {
                  mode: "strict",
                  typeSymbol: "@deepseek-ai/dsh-experimental-api-speech-to-text/types#TranscriptionRequest",
                  create: transcriptionRequest,
                  jsonSchema: {
                    type: "object",
                    properties: {
                      audioBase64: { type: "string" },
                      providerId: { type: "string" },
                      language: { type: "string" },
                    },
                    required: ["audioBase64"],
                    additionalProperties: true,
                  },
                },
                strictCodec: {
                  mode: "strict",
                  typeSymbol: "@deepseek-ai/dsh-experimental-api-speech-to-text/types#TranscriptionRequest",
                  create: transcriptionRequestStrict,
                  jsonSchema: {
                    type: "object",
                    properties: {
                      audioBase64: { type: "string" },
                      providerId: { type: "string" },
                      language: { type: "string" },
                    },
                    required: ["audioBase64"],
                    additionalProperties: false,
                  },
                },
              },
            ],
            cancellation: { parameter: "signal" },
            result: {
              mode: "strict",
              typeSymbol: "@deepseek-ai/dsh-experimental-speech-to-text/types#Transcript",
              create: () => z.any(),
              description: "final transcript without adding a Session event.",
            },
          },
        },
      },
      z,
    );

    // ------------------------------------------------------------------
    // Locale
    // ------------------------------------------------------------------
    const NS = "speechio";
    const OUR_PROVIDER_IDS = [
      "qwen3-asr-local",
      "qwen3-asr-local-gpu",
      "qwen3-asr-local-cpu",
    ];

    const zh = {
      dictate: "语音输入",
      start: "开始语音输入",
      stop: "停止并插入",
      cancel: "取消",
      discard: "丢弃",
      insert: "插入文本",
      retry: "重新录音",
      requesting: "正在请求麦克风权限…",
      recording: "正在听写",
      transcribing: "正在完成最后一句…",
      listening: "正在听…",
      empty: "没有识别到语音",
      cancelled: "已取消语音输入",
      cancelledKept: "已取消录音；已转写的文字保留在输入框，可直接编辑",
      conflict: "草稿已改变，转写文字已保留，可点击插入",
      failed: "语音识别失败：{message}",
      unavailable: "此浏览器无法录音，请使用支持麦克风的浏览器",
      permission: "麦克风权限被拒绝，请在浏览器和系统设置中允许",
      deviceMissing: "找不到可用的麦克风",
      interrupted: "录音被中断，请重试",
      tooLarge: "录音超出长度限制",
      liveLabel: "实时转写",
      engine: "引擎",
      engineAuto: "自动",
      engineGpu: "GPU",
      engineCpu: "CPU",
      statusEngine: "{engine} · {time}",
      "settings.title": "语音引擎",
      "settings.description":
        "选择本机 Qwen3-ASR 的推理后端。GPU 走 Vulkan（不需要 CUDA），通常比 CPU 快 6–10 倍，但需要 Vulkan 运行库和约 2 GB 显存；两种后端共用同一份模型。",
      "settings.auto": "自动（GPU 优先）",
      "settings.autoHint": "启动时优先 Vulkan，失败自动回退 CPU",
      "settings.gpu": "GPU（Vulkan）",
      "settings.gpuHint": "最快；需要 Vulkan 版 llama-server（不需要 CUDA）",
      "settings.cpu": "CPU",
      "settings.cpuHint": "兼容性最好；需要 CPU 版 llama-server",
      "settings.saveError": "切换失败：{message}",
      "settings.saved": "已切换，下一次识别生效",
      "settings.note":
        "两种后端共用同一份模型；缺少对应运行时会报错。切换会重启本机识别服务，手动启动的外部服务不会被打断。",
      "settings.connection": "语音服务未连接",
      "settings.connectionHint": "请确认 speechio-api 与 speechio-provider 两个插件行已启用。",
      "settings.loading": "正在读取语音服务…",
      "settings.missing": "语音服务已连接，但没有找到本插件的 Provider；请确认 speechio-provider 行已启用且未被禁用。",
      "settings.selected": "当前使用：{name}",
      "settings.refresh": "重新检测",
    };

    const en = {
      dictate: "Voice input",
      start: "Start voice input",
      stop: "Stop and insert",
      cancel: "Cancel",
      discard: "Discard",
      insert: "Insert text",
      retry: "Record again",
      requesting: "Requesting microphone access…",
      recording: "Listening",
      transcribing: "Finishing the last sentence…",
      listening: "Listening…",
      empty: "No speech recognized",
      cancelled: "Voice input cancelled",
      cancelledKept: "Recording cancelled; transcribed text stays in the composer for editing",
      conflict: "Your draft changed. The transcript is preserved and can be inserted.",
      failed: "Speech recognition failed: {message}",
      unavailable: "This browser cannot record audio. Use a browser with microphone support.",
      permission: "Microphone access is blocked. Allow it in the browser and system settings.",
      deviceMissing: "No microphone is available",
      interrupted: "Recording was interrupted. Try again.",
      tooLarge: "The recording exceeds the length limit",
      liveLabel: "Live transcript",
      engine: "Engine",
      engineAuto: "Auto",
      engineGpu: "GPU",
      engineCpu: "CPU",
      statusEngine: "{engine} · {time}",
      "settings.title": "Speech engine",
      "settings.description":
        "Choose the inference backend for local Qwen3-ASR. GPU uses Vulkan (no CUDA), is usually 6–10× faster than CPU, and needs the Vulkan runtime plus about 2 GB of free VRAM. Both backends share the same model files.",
      "settings.auto": "Auto (GPU first)",
      "settings.autoHint": "Try Vulkan at startup, fall back to CPU",
      "settings.gpu": "GPU (Vulkan)",
      "settings.gpuHint": "Fastest; needs the Vulkan llama-server (no CUDA)",
      "settings.cpu": "CPU",
      "settings.cpuHint": "Most compatible; needs the CPU llama-server",
      "settings.saveError": "Switch failed: {message}",
      "settings.saved": "Switched; takes effect on the next recognition",
      "settings.note":
        "Both backends share the same model files; a missing runtime reports an error. Switching restarts the local service; a manually started server is left alone.",
      "settings.connection": "Speech service is not connected",
      "settings.connectionHint": "Check that the speechio-api and speechio-provider rows are enabled.",
      "settings.loading": "Reading the speech service…",
      "settings.missing":
        "The speech service is connected, but this plugin's providers are missing. Check that the speechio-provider row is enabled.",
      "settings.selected": "Currently using: {name}",
      "settings.refresh": "Check again",
    };

    // ------------------------------------------------------------------
    // Small utilities
    // ------------------------------------------------------------------
    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        get: () => value,
        set(next) {
          value = next;
          for (const listener of [...listeners]) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    function useStore(store, selector) {
      return React.useSyncExternalStore(
        store.subscribe,
        () => selector(store.get()),
        () => selector(store.get()),
      );
    }

    function errorText(error) {
      if (error instanceof Error) return error.message;
      if (error && typeof error === "object" && typeof error.message === "string") return error.message;
      return String(error);
    }

    function isAbortError(error) {
      return (
        (error && (error.name === "AbortError" || error.name === "TimeoutError")) ||
        (error && typeof error.message === "string" && /abort|cancel/i.test(error.message))
      );
    }

    function isNoSpeech(error) {
      return typeof errorText(error).includes("没有检测到语音");
    }

    function captureFailureText(error, t) {
      if (error instanceof CaptureError) return t(error.kind);
      return t("failed", { message: errorText(error) });
    }

    function formatClock(seconds) {
      const total = Math.max(0, Math.floor(seconds));
      const minutes = Math.floor(total / 60);
      const rest = total % 60;
      return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
    }

    function engineIdOf(providerId) {
      if (providerId === "qwen3-asr-local-gpu") return "gpu";
      if (providerId === "qwen3-asr-local-cpu") return "cpu";
      return "auto";
    }

    function engineLabel(providerId, t) {
      const id = engineIdOf(providerId);
      return id === "gpu" ? t("engineGpu") : id === "cpu" ? t("engineCpu") : t("engineAuto");
    }

    /** 中文之间不留空格，英文词之间留一个空格。 */
    function joinTranscripts(parts) {
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

    /** 16 kHz mono PCM16 WAV。 */
    function encodeWav16(samples, sampleRate = 16000) {
      const bytes = new Uint8Array(44 + samples.length * 2);
      const view = new DataView(bytes.buffer);
      const text = (at, value) => {
        for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
      };
      text(0, "RIFF");
      view.setUint32(4, bytes.length - 8, true);
      text(8, "WAVE");
      text(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      text(36, "data");
      view.setUint32(40, samples.length * 2, true);
      for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
      return bytes;
    }

    function audioBase64(bytes) {
      let text = "";
      for (let i = 0; i < bytes.length; i += 8192) {
        text += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      return btoa(text);
    }

    // ------------------------------------------------------------------
    // Microphone capture
    // ------------------------------------------------------------------
    class CaptureError extends Error {
      constructor(kind) {
        super(kind);
        this.kind = kind;
        this.name = "CaptureError";
      }
    }

    class LinearResampler {
      constructor(sourceRate, targetRate) {
        this.ratio = sourceRate / targetRate;
        this.position = 0;
        this.tail = new Float32Array(0);
      }
      process(input) {
        const buffer = new Float32Array(this.tail.length + input.length);
        buffer.set(this.tail);
        buffer.set(input, this.tail.length);
        const out = [];
        while (this.position + 1 < buffer.length) {
          const index = Math.floor(this.position);
          const fraction = this.position - index;
          out.push(
            buffer[index] * (1 - fraction) + buffer[index + 1] * fraction,
          );
          this.position += this.ratio;
        }
        const consumed = Math.min(buffer.length, Math.floor(this.position));
        this.tail = buffer.slice(consumed);
        this.position -= consumed;
        return Float32Array.from(out);
      }
    }

    const FRAME_SAMPLES = 320; // 20 ms at 16 kHz

    class StreamingCapture {
      constructor() {
        this.stream = undefined;
        this.context = undefined;
        this.source = undefined;
        this.processor = undefined;
        this.analyser = undefined;
        this.sink = undefined;
        this.resampler = undefined;
        this.levels = new Float32Array(256);
        this.buffer = new Int16Array(16000);
        this.length = 0;
        this.lifetime = new AbortController();
        this.disposal = undefined;
      }

      async start(onFrame, onError) {
        const media = navigator.mediaDevices;
        if (!media) throw new CaptureError("unavailable");
        if (typeof AudioContext === "undefined" || typeof AudioContext.prototype.createScriptProcessor !== "function") {
          throw new CaptureError("unavailable");
        }

        let stream;
        try {
          stream = await media.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              channelCount: 1,
            },
            video: false,
          });
        } catch (error) {
          if (error instanceof DOMException) {
            if (error.name === "NotAllowedError" || error.name === "SecurityError") {
              throw new CaptureError("permission");
            }
            if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
              throw new CaptureError("deviceMissing");
            }
          }
          throw error;
        }

        if (this.lifetime.signal.aborted) {
          stream.getTracks().forEach((track) => track.stop());
          throw new CaptureError("cancelled");
        }
        this.stream = stream;

        try {
          const context = new AudioContext();
          this.context = context;
          await context.resume().catch(() => {});
          const source = context.createMediaStreamSource(stream);
          const analyser = context.createAnalyser();
          analyser.fftSize = this.levels.length;
          const processor = context.createScriptProcessor(1024, 1, 1);
          const sink = context.createGain();
          sink.gain.value = 0;
          this.source = source;
          this.analyser = analyser;
          this.processor = processor;
          this.sink = sink;
          this.resampler = new LinearResampler(context.sampleRate, 16000);

          source.connect(analyser);
          source.connect(processor);
          processor.connect(sink);
          sink.connect(context.destination);

          processor.onaudioprocess = (event) => {
            if (this.lifetime.signal.aborted) return;
            const input = event.inputBuffer.getChannelData(0);
            const resampled = this.resampler.process(input);
            this.append(resampled, onFrame);
          };

          for (const track of stream.getTracks()) {
            track.addEventListener(
              "ended",
              () => this.interrupted(onError),
              { signal: this.lifetime.signal },
            );
          }
        } catch (error) {
          await this.dispose();
          throw error;
        }
      }

      append(samples, onFrame) {
        const needed = this.length + samples.length;
        if (needed > this.buffer.length) {
          let capacity = this.buffer.length * 2;
          while (capacity < needed) capacity *= 2;
          const next = new Int16Array(capacity);
          next.set(this.buffer.subarray(0, this.length));
          this.buffer = next;
        }
        for (let i = 0; i < samples.length; i++) {
          const value = Math.max(-1, Math.min(1, samples[i]));
          this.buffer[this.length++] = Math.round(value < 0 ? value * 32768 : value * 32767);
        }
        while (this.length >= FRAME_SAMPLES) {
          const frame = this.buffer.slice(0, FRAME_SAMPLES);
          this.buffer.copyWithin(0, FRAME_SAMPLES, this.length);
          this.length -= FRAME_SAMPLES;
          try {
            onFrame(frame);
          } catch (error) {
            console.error("speechio: frame handler failed", error);
          }
        }
      }

      amplitude() {
        if (!this.analyser) return 0;
        this.analyser.getFloatTimeDomainData(this.levels);
        let sum = 0;
        for (const sample of this.levels) sum += sample * sample;
        return Math.sqrt(sum / this.levels.length);
      }

      interrupted(onError) {
        if (this.lifetime.signal.aborted) return;
        this.dispose().catch(() => {});
        try {
          onError?.(new CaptureError("interrupted"));
        } catch (error) {
          console.error("speechio: capture error handler failed", error);
        }
      }

      dispose() {
        if (this.disposal !== undefined) return this.disposal;
        this.disposal = (async () => {
          this.lifetime.abort(new CaptureError("cancelled"));
          if (this.processor) {
            this.processor.onaudioprocess = null;
            try {
              this.processor.disconnect();
            } catch {
              // ignore
            }
          }
          this.source?.disconnect?.();
          this.analyser?.disconnect?.();
          this.sink?.disconnect?.();
          this.stream?.getTracks().forEach((track) => track.stop());
          this.stream = undefined;
          const context = this.context;
          this.context = undefined;
          if (context && context.state !== "closed") {
            await context.close().catch(() => {});
          }
        })();
        return this.disposal;
      }
    }

    // ------------------------------------------------------------------
    // Client-side VAD / sentence segmentation
    // ------------------------------------------------------------------
    class SpeechSegmenter {
      constructor(onSegment) {
        this.onSegment = onSegment;
        this.active = false;
        this.frames = [];
        this.preroll = [];
        this.speechRun = 0;
        this.speechFrames = 0;
        this.silenceRun = 0;
        this.voicing = false;
        this.noise = 0.004;
        this.calibration = 0;
      }

      push(frame) {
        if (frame.length !== FRAME_SAMPLES) return;
        const rms = frameRms(frame);
        // 开头 200 ms 估计底噪，但把估计值限制在很低的区间：
        // 宁可阈值偏低、让 Host 的静音保护兜底，也不要让说话声把阈值抬高。
        if (this.calibration < 10) {
          this.noise = this.noise * 0.7 + Math.min(rms, 0.01) * 0.3;
          this.noise = Math.min(0.004, Math.max(0.0025, this.noise));
          this.calibration += 1;
        } else if (!this.voicing && rms < 0.008) {
          this.noise = this.noise * 0.9 + rms * 0.1;
          this.noise = Math.min(0.004, Math.max(0.0025, this.noise));
        }
        const high = Math.min(0.02, Math.max(0.009, this.noise * 2.4));
        const low = Math.min(0.012, Math.max(0.0045, this.noise * 1.5));
        this.voicing = this.voicing ? rms > low : rms > high;

        if (!this.active) {
          if (this.voicing) {
            this.speechRun += 1;
            this.preroll.push(frame);
            if (this.preroll.length > 12) this.preroll.shift();
            if (this.speechRun >= 3) {
              this.active = true;
              this.frames = this.preroll.slice();
              this.speechFrames = this.speechRun;
              this.silenceRun = 0;
            }
          } else {
            this.speechRun = 0;
            this.preroll.push(frame);
            if (this.preroll.length > 12) this.preroll.shift();
          }
          return;
        }

        this.frames.push(frame);
        if (this.voicing) {
          this.speechFrames += 1;
          this.silenceRun = 0;
        } else {
          this.silenceRun += 1;
        }
        if (this.silenceRun >= 25 || this.frames.length >= 600) this.flush();
      }

      currentSamples() {
        if (!this.active) return undefined;
        const keep = this.frames.length - Math.max(0, this.silenceRun - 8);
        const samples = concatFrames(this.frames.slice(0, Math.max(0, keep)));
        return samples.length >= 16000 * 0.35 ? samples : undefined;
      }

      flush() {
        if (!this.active) return;
        const keep = this.frames.length - Math.max(0, this.silenceRun - 8);
        const kept = this.frames.slice(0, Math.max(0, keep));
        const enough = this.speechFrames >= 13;
        const samples = concatFrames(kept);
        this.reset();
        if (enough && samples.length >= 16000 * 0.2) this.onSegment(samples);
      }

      reset() {
        this.active = false;
        this.frames = [];
        this.preroll = [];
        this.speechRun = 0;
        this.speechFrames = 0;
        this.silenceRun = 0;
      }
    }

    function frameRms(frame) {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) {
        const value = frame[i] / 32768;
        sum += value * value;
      }
      return Math.sqrt(sum / frame.length);
    }

    function concatFrames(frames) {
      let total = 0;
      for (const frame of frames) total += frame.length;
      const out = new Int16Array(total);
      let offset = 0;
      for (const frame of frames) {
        out.set(frame, offset);
        offset += frame.length;
      }
      return out;
    }

    // ------------------------------------------------------------------
    // Waveform
    // ------------------------------------------------------------------
    function Waveform({ activeRef, label }) {
      const svg = React.useRef(null);
      React.useEffect(() => {
        const element = svg.current;
        if (!element) return undefined;
        const bars = Array.from(element.querySelectorAll("line"))
          .reverse()
          .map((line) => ({ line, level: 0 }));
        let frame;
        let previous = -Infinity;
        const draw = (now) => {
          if (now - previous >= 50) {
            previous = now;
            let next = activeRef.current?.capture?.amplitude() ?? 0;
            for (const bar of bars) {
              const previousLevel = bar.level;
              bar.level = next;
              next = previousLevel;
              const height = 1 + Math.min(1, bar.level * 5) * 17;
              bar.line.setAttribute("y1", String(20 - height));
              bar.line.setAttribute("y2", String(20 + height));
            }
          }
          frame = requestAnimationFrame(draw);
        };
        frame = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(frame);
      }, [activeRef]);
      return h(
        "svg",
        {
          ref: svg,
          className: "speechio-wave",
          viewBox: "0 0 640 40",
          preserveAspectRatio: "none",
          role: "img",
          "aria-label": label,
        },
        Array.from({ length: 80 }, (_, index) =>
          h("line", {
            key: index,
            x1: index * 8 + 4,
            x2: index * 8 + 4,
            y1: "19",
            y2: "21",
            stroke: "currentColor",
            strokeWidth: "3",
            strokeLinecap: "round",
            opacity: 0.25 + index / 120,
          }),
        ),
      );
    }

    // ------------------------------------------------------------------
    // Voice input activity
    // ------------------------------------------------------------------
    function VoiceInputActivity(props) {
      const {
        sessionId,
        inputActions,
        locked,
        onActiveChange,
        t,
        speech,
        refreshCatalog,
        readiness,
      } = props;
      const readinessValue = useStore(readiness, (value) => value);
      const catalog = readinessValue.catalog;
      const [phase, setPhase] = React.useState("idle");
      const [message, setMessage] = React.useState("");
      const [pending, setPending] = React.useState("");
      const [elapsed, setElapsed] = React.useState(0);
      const current = React.useRef(undefined);
      const starting = React.useRef(false);
      const generation = React.useRef(0);
      const finishRef = React.useRef(() => {});
      const cancelRef = React.useRef(() => {});
      const expanded = phase !== "idle";

      // uiSession.provide() exposes useInput to every session slot. It lets the
      // activity read the draft before recording and restore it if the user
      // cancels after some text has already been inserted live.
      const inputHook = typeof props.useInput === "function" ? props.useInput : undefined;
      const inputSnapshot = inputHook ? inputHook((value) => value) : undefined;
      const inputRef = React.useRef(inputSnapshot);
      inputRef.current = inputSnapshot;
      const hasInputHook = inputHook !== undefined;

      React.useLayoutEffect(() => {
        onActiveChange(expanded);
        return () => onActiveChange(false);
      }, [expanded, onActiveChange]);

      const clearState = () => {
        setMessage("");
        setPending("");
        setElapsed(0);
      };

      const cleanup = (active, abortRequests) => {
        if (!active) return;
        active.aborted = true;
        clearInterval(active.interval);
        clearTimeout(active.timer);
        if (abortRequests) {
          for (const controller of active.finalControllers) controller.abort();
        }
        active.capture.dispose().catch(() => {});
        active.resolveFinish?.();
      };

      const failActive = (error) => {
        const active = current.current;
        current.current = undefined;
        generation.current += 1;
        cleanup(active, true);
        setPending("");
        setMessage(captureFailureText(error, t));
        setPhase("feedback");
      };

      const cancel = () => {
        generation.current += 1;
        const active = current.current;
        current.current = undefined;
        const inserted = active?.insertedText ?? "";
        // Only restore an originally empty draft. With existing content (and
        // possible reference chips) keeping the transcript is safer than
        // rewriting the whole draft on cancel.
        const canRestore =
          Boolean(active?.startDraftKnown) &&
          active.startDraft === "" &&
          (inputRef.current?.draft ?? "") === inserted;
        cleanup(active, true);
        clearState();
        if (inserted && canRestore) {
          try {
            inputActions.setDraft("");
          } catch {
            // keep the text if the editor rejects the restore
          }
          setPhase("idle");
          return;
        }
        if (inserted) {
          setMessage(t("cancelledKept"));
          setPhase("feedback");
          return;
        }
        setPhase("idle");
      };

      const insertIntoDraft = (active, text) => {
        if (!text) return true;
        const combined = joinTranscripts([active.insertedText, text]);
        const addition = combined.slice(active.insertedText.length);
        if (!addition) return true;
        try {
          if (inputActions.insertText(addition, inputActions.captureInsertion())) {
            active.insertedText = combined;
            return true;
          }
        } catch {
          // fall through to the pending buffer
        }
        active.insertFailed = true;
        active.pendingText = joinTranscripts([active.pendingText, text]);
        return false;
      };

      // Insert completed sentences in serial order. Results may settle out of
      // order; buffer until the next serial is available so the composer never
      // shows sentences swapped.
      const drain = (active) => {
        if (active.insertFailed) return;
        while (active.settled.has(active.nextSerial)) {
          const serial = active.nextSerial;
          const text = active.results.get(serial) ?? "";
          active.results.delete(serial);
          active.settled.delete(serial);
          active.nextSerial += 1;
          if (text && !insertIntoDraft(active, text)) return;
        }
      };

      const settle = (active, serial, text) => {
        active.results.set(serial, text);
        active.settled.add(serial);
        drain(active);
      };

      const enqueueFinal = (active, samples, serial) => {
        if (active.aborted || active.run !== generation.current) return;
        if (samples.length < 16000 * 0.2) {
          settle(active, serial, "");
          return;
        }
        active.pending += 1;
        const controller = new AbortController();
        active.finalControllers.add(controller);
        Promise.resolve()
          .then(() =>
            speech.transcribe(
              {
                audioBase64: audioBase64(encodeWav16(samples)),
                providerId: active.providerId,
                language: active.language,
              },
              controller.signal,
            ),
          )
          .then((result) => {
            if (active.run !== generation.current || active.aborted) return;
            if (!result.ok) throw result.error;
            settle(active, serial, String(result.value?.text ?? "").trim());
          })
          .catch((error) => {
            if (active.run !== generation.current || active.aborted) return;
            if (isAbortError(error) || controller.signal.aborted) return;
            if (!isNoSpeech(error)) active.finalError = errorText(error);
            settle(active, serial, "");
          })
          .finally(() => {
            active.finalControllers.delete(controller);
            active.pending -= 1;
            if (active.finishing && active.pending === 0) active.resolveFinish?.();
          });
      };

      const complete = (active) => {
        if (active.run !== generation.current) return;
        active.aborted = true;
        current.current = undefined;
        drain(active);
        const remaining = [...active.results.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([, text]) => text);
        const pendingText = joinTranscripts([active.pendingText, ...remaining]);
        if (pendingText) {
          setPending(pendingText);
          setMessage(t("conflict"));
          setPhase("feedback");
          return;
        }
        if (!active.insertedText) {
          setMessage(active.finalError ? t("failed", { message: active.finalError }) : t("empty"));
          setPhase("feedback");
          return;
        }
        clearState();
        setPhase("idle");
      };

      const finish = async () => {
        const active = current.current;
        if (!active || active.phase !== "recording") return;
        active.phase = "transcribing";
        setPhase("transcribing");
        clearInterval(active.interval);
        clearTimeout(active.timer);
        const run = active.run;
        try {
          await active.capture.dispose();
          if (run !== generation.current) return;
          active.finishing = true;
          active.segmenter.flush();
          if (active.pending === 0) {
            complete(active);
            return;
          }
          await new Promise((resolve) => {
            active.resolveFinish = resolve;
            if (active.pending === 0) resolve();
          });
          if (run !== generation.current) return;
          complete(active);
        } catch (error) {
          if (run === generation.current) failActive(error);
        }
      };

      const startInner = async () => {
        // Keep the click's user activation for getUserMedia: use the cached
        // catalog immediately and refresh it in the background. Only a cold
        // start (no catalog yet) waits for the service.
        let latest = readiness.get().catalog;
        if (!latest) {
          const ready = await refreshCatalog();
          latest = readiness.get().catalog;
          if (!ready || !latest) {
            setPending("");
            setMessage(
              t("failed", {
                message: readiness.get().error ?? t("settings.connection"),
              }),
            );
            setPhase("feedback");
            return;
          }
        } else {
          refreshCatalog();
        }
        const provider = latest.providers.find(
          (item) => item.id === latest.selection.providerId,
        );
        if (!provider) {
          setMessage(t("failed", { message: t("settings.connection") }));
          setPhase("feedback");
          return;
        }
        if (provider.preparation?.phase === "failed") {
          setMessage(t("failed", { message: provider.preparation.message }));
          setPhase("feedback");
          return;
        }

        const run = generation.current + 1;
        generation.current = run;
        const active = {
          run,
          capture: new StreamingCapture(),
          segmenter: undefined,
          phase: "requesting",
          startDraft: inputRef.current?.draft ?? "",
          startDraftKnown: hasInputHook && inputRef.current !== undefined,
          providerId: latest.selection.providerId,
          language: latest.selection.language,
          finalSerial: 0,
          finalControllers: new Set(),
          results: new Map(),
          settled: new Set(),
          nextSerial: 1,
          insertedText: "",
          pendingText: "",
          insertFailed: false,
          pending: 0,
          aborted: false,
          finishing: false,
          resolveFinish: undefined,
          startedAt: Date.now(),
          interval: undefined,
          timer: undefined,
          finalError: undefined,
        };
        active.segmenter = new SpeechSegmenter((samples) => {
          if (active.run !== generation.current || active.aborted) return;
          const serial = active.finalSerial + 1;
          active.finalSerial = serial;
          enqueueFinal(active, samples, serial);
        });
        current.current = active;
        setMessage("");
        setPending("");
        setElapsed(0);
        setPhase("requesting");

        try {
          await active.capture.start(
            (frame) => {
              if (active.run !== generation.current || active.aborted) return;
              active.segmenter.push(frame);
            },
            (failure) => {
              if (active.run !== generation.current || active.aborted) return;
              failActive(failure);
            },
          );
          if (active.run !== generation.current || current.current !== active) return;
          active.phase = "recording";
          active.startedAt = Date.now();
          setPhase("recording");
          active.interval = setInterval(() => {
            if (current.current !== active || active.phase !== "recording") return;
            setElapsed(Math.floor((Date.now() - active.startedAt) / 1000));
          }, 200);
          active.timer = setTimeout(
            () => finishRef.current(),
            Math.max(5, latest.maxDurationSeconds || 120) * 1000,
          );
        } catch (error) {
          if (active.run === generation.current) failActive(error);
        }
      };

      const start = async () => {
        if (locked || current.current || starting.current) return;
        starting.current = true;
        try {
          await startInner();
        } catch (error) {
          failActive(error);
        } finally {
          starting.current = false;
        }
      };

      const insertPending = () => {
        if (!pending) return;
        let inserted = false;
        try {
          inserted = inputActions.insertText(pending, inputActions.captureInsertion());
        } catch {
          inserted = false;
        }
        if (inserted) {
          clearState();
          setPhase("idle");
        }
      };

      finishRef.current = finish;
      cancelRef.current = cancel;

      React.useEffect(() => {
        setMessage("");
        setPending("");
        setElapsed(0);
        setPhase("idle");
        const blur = () => {
          if (current.current?.phase === "recording") cancelRef.current();
        };
        const visibility = () => {
          if (document.hidden && current.current) cancelRef.current();
        };
        const escape = (event) => {
          if (event.key === "Escape" && current.current) {
            event.preventDefault();
            cancelRef.current();
          }
        };
        window.addEventListener("blur", blur);
        document.addEventListener("visibilitychange", visibility);
        document.addEventListener("keydown", escape);
        return () => {
          window.removeEventListener("blur", blur);
          document.removeEventListener("visibilitychange", visibility);
          document.removeEventListener("keydown", escape);
          generation.current += 1;
          const active = current.current;
          current.current = undefined;
          cleanup(active, true);
        };
      }, [sessionId]);

      if (!expanded) {
        return h(
          Tooltip,
          {
            label: t("start"),
            side: "top",
            portal: true,
            disabled: locked,
          },
          h(
            "span",
            { className: "speechio-triggerAnchor" },
            h(
              Button,
              {
                type: "button",
                className: "speechio-trigger",
                size: "sm",
                disabled: locked,
                "aria-label": t("start"),
                onMouseDown: (event) => event.preventDefault(),
                onClick: start,
              },
              h(IconMicrophoneOutlineRegular, { size: 18 }),
            ),
          ),
        );
      }

      const active = current.current;
      const providerId = active?.providerId ?? catalog?.selection?.providerId;
      const status =
        phase === "requesting"
          ? t("requesting")
          : phase === "recording"
            ? t("statusEngine", {
                engine: engineLabel(providerId, t),
                time: formatClock(elapsed),
              })
            : phase === "transcribing"
              ? t("transcribing")
              : message;

      return h(
        "div",
        { className: "speechio-activity", "data-speechio-activity": phase },
        h(
          "div",
          { className: "speechio-row" },
          h(
            Button,
            {
              type: "button",
              className: "speechio-round",
              size: "sm",
              "aria-label": pending ? t("discard") : t("cancel"),
              onClick: pending ? () => { clearState(); setPhase("idle"); } : cancel,
            },
            h(IconCloseOutlineRegular, { size: 14 }),
          ),
          phase === "recording"
            ? h(Waveform, { activeRef: current, label: t("recording") })
            : h(
                "span",
                {
                  className: "speechio-status",
                  role: "status",
                  "aria-live": phase === "recording" ? "off" : "polite",
                  title: status,
                },
                (phase === "requesting" || phase === "transcribing") &&
                  h(StateDot, { state: "ongoing" }),
                h("span", { className: "speechio-statusText" }, status),
              ),
          phase === "recording" &&
            h(
              Button,
              {
                type: "button",
                className: "speechio-round",
                size: "sm",
                "aria-label": t("stop"),
                onClick: () => finishRef.current(),
              },
              h(IconStopFillRegular, { size: 14 }),
            ),
          phase === "feedback" &&
            (pending
              ? h(
                  Button,
                  {
                    type: "button",
                    size: "sm",
                    variant: "outline",
                    onClick: insertPending,
                  },
                  t("insert"),
                )
              : h(
                  Button,
                  {
                    type: "button",
                    className: "speechio-round",
                    size: "sm",
                    "aria-label": t("retry"),
                    onClick: start,
                  },
                  h(IconMicrophoneOutlineRegular, { size: 18 }),
                )),
        ),
      );
    }

    // ------------------------------------------------------------------
    // Plugins page: CPU / GPU setting
    // ------------------------------------------------------------------
    const ENGINE_OPTIONS = [
      {
        id: "qwen3-asr-local",
        label: "settings.auto",
        hint: "settings.autoHint",
      },
      {
        id: "qwen3-asr-local-gpu",
        label: "settings.gpu",
        hint: "settings.gpuHint",
      },
      {
        id: "qwen3-asr-local-cpu",
        label: "settings.cpu",
        hint: "settings.cpuHint",
      },
    ];

    function EngineSettings(props) {
      const { t, speech, readiness, refreshCatalog } = props;
      const value = useStore(readiness, (snapshot) => snapshot);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState("");
      const [notice, setNotice] = React.useState("");
      const selection = value.catalog?.selection?.providerId;

      React.useEffect(() => {
        refreshCatalog();
      }, [refreshCatalog]);

      const choose = async (id) => {
        if (saving || id === selection) return;
        setSaving(true);
        setError("");
        setNotice("");
        try {
          const result = await speech.configure({ providerId: id });
          if (!result.ok) throw result.error;
          const refreshed = await refreshCatalog();
          setNotice(refreshed ? t("settings.saved") : "");
        } catch (failure) {
          setError(t("settings.saveError", { message: errorText(failure) }));
        } finally {
          setSaving(false);
        }
      };

      const available = new Set(
        (value.catalog?.providers ?? []).map((provider) => provider.id),
      );
      const selectedOption = ENGINE_OPTIONS.find((option) => option.id === selection);

      return h(
        "div",
        { className: "speechio-settings" },
        h("h4", null, t("settings.title")),
        h("p", { className: "speechio-muted" }, t("settings.description")),
        h(
          "div",
          {
            className: "speechio-segments",
            role: "radiogroup",
            "aria-label": t("settings.title"),
          },
          ENGINE_OPTIONS.map((option) =>
            h(
              "button",
              {
                key: option.id,
                type: "button",
                role: "radio",
                "aria-checked": selection === option.id,
                "data-selected": selection === option.id,
                className: "speechio-segment",
                disabled: saving || !value.connected || !available.has(option.id),
                onClick: () => choose(option.id),
              },
              h("span", { className: "speechio-segmentLabel" }, t(option.label)),
              h("span", { className: "speechio-segmentHint" }, t(option.hint)),
            ),
          ),
        ),
        selectedOption &&
          h(
            "p",
            { className: "speechio-muted" },
            t("settings.selected", { name: t(selectedOption.label) }),
          ),
        !value.connected &&
          (value.error
            ? h(
                "p",
                { className: "speechio-error", role: "alert" },
                `${t("settings.connection")}: ${value.error} ${t("settings.connectionHint")}`,
              )
            : h(
                "p",
                { className: "speechio-muted", role: "status" },
                t("settings.loading"),
              )),
        value.connected &&
          !ENGINE_OPTIONS.some((option) => available.has(option.id)) &&
          h("p", { className: "speechio-error", role: "alert" }, t("settings.missing")),
        error && h("p", { className: "speechio-error", role: "alert" }, error),
        notice && h("p", { className: "speechio-ok", role: "status" }, notice),
        h("p", { className: "speechio-muted" }, t("settings.note")),
        h(
          "div",
          { className: "speechio-settingsActions" },
          h(
            "button",
            {
              type: "button",
              className: "speechio-link",
              disabled: saving,
              onClick: () => refreshCatalog(),
            },
            t("settings.refresh"),
          ),
        ),
      );
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------
    const CSS = `
.speechio-triggerAnchor{flex:none;display:inline-flex}
.speechio-trigger{flex:none;width:28px;padding:0}
.speechio-activity{display:flex;flex-direction:column;gap:8px;width:100%;min-width:0}
.speechio-row{display:flex;align-items:center;gap:10px;width:100%;min-width:0;min-height:34px}
.speechio-round{corner-shape:round;background:var(--dsw-specific-selector);border-radius:50%;flex:none;width:32px;height:32px;padding:0}
@media (hover:hover){.speechio-round:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}}
.speechio-wave{width:0;min-width:24px;height:24px;color:var(--dsw-alias-label-secondary);flex:1;display:block}
.speechio-status{min-width:0;color:var(--dsw-alias-label-secondary);flex:1;align-items:center;gap:8px;font-size:12px;display:flex;overflow:hidden}
.speechio-statusText{min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.speechio-settings{display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--dsw-alias-label-primary);max-width:640px}
.speechio-settings h4{margin:0;font-size:14px;font-weight:600}
.speechio-muted{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}
.speechio-segments{display:flex;gap:4px;flex-wrap:wrap}
.speechio-segment{flex:1 1 150px;display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;font:inherit}
.speechio-segment:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.speechio-segment[data-selected=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary) inset}
.speechio-segment:disabled{opacity:.55;cursor:default}
.speechio-segmentLabel{font-weight:600;font-size:13px}
.speechio-segmentHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45}
.speechio-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.55;overflow-wrap:anywhere}
.speechio-ok{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.55}
.speechio-settingsActions{display:flex;gap:8px;align-items:center}
.speechio-link{border:0;background:none;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;padding:2px 0;cursor:pointer}
.speechio-link:disabled{opacity:.5;cursor:default}
`;

    function installStyles() {
      if (typeof document === "undefined") return () => {};
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-plugin-speechio-fast";
      style.dataset.pluginCss = "dsh-plugin-speechio-fast/styles";
      style.textContent = CSS;
      document.head.append(style);
      return () => style.remove();
    }

    // ------------------------------------------------------------------
    // Client apply
    // ------------------------------------------------------------------
    function createReadiness(speech) {
      const store = createStore({ catalog: null, connected: false, error: null });
      let timer;
      let attempts = 0;
      let disposed = false;

      const refresh = async () => {
        try {
          const result = await speech.catalog();
          if (!result.ok) throw result.error;
          if (disposed) return false;
          const catalog = result.value;
          const ready = (catalog?.providers ?? []).some((provider) =>
            OUR_PROVIDER_IDS.includes(provider.id),
          );
          if (!ready) {
            // The API row and this row can start in the same composition;
            // report "loading" until our providers are registered.
            store.set({ catalog, connected: false, error: null });
            return false;
          }
          store.set({ catalog, connected: true, error: null });
          return true;
        } catch (error) {
          if (disposed) return false;
          store.set({
            ...store.get(),
            connected: false,
            error: errorText(error),
          });
          return false;
        }
      };

      const retry = () => {
        if (disposed || attempts >= 6) return;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          attempts += 1;
          const ok = await refresh();
          if (!ok) retry();
        }, 1500);
      };

      return {
        store,
        refresh,
        start() {
          refresh().then((ok) => {
            if (!ok) retry();
          });
        },
        dispose() {
          disposed = true;
          clearTimeout(timer);
        },
      };
    }

    function registerUi(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }));
      ctx.effect(() => installStyles(), "speechio: styles");
      const speech = ctx.remote.speech;
      const readiness = createReadiness(speech);
      ctx.effect(() => {
        readiness.start();
        return () => readiness.dispose();
      }, "speechio: readiness");

      const actions = {
        speech,
        readiness: readiness.store,
        refreshCatalog: readiness.refresh,
      };

      ctx.slots.inject("conversation.input.activity", () =>
        ctx.slots.register(
          {
            name: "conversation.input.activity",
            locale: NS,
            inject: () => actions,
          },
          VoiceInputActivity,
        ),
      );

      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          {
            name: "plugins.bundle.config",
            key: "dsh-plugin-speechio-fast",
            locale: NS,
            inject: () => actions,
          },
          EngineSettings,
        ),
      );
    }

    async function apply(ctx) {
      let disposeRemote = async () => {};
      let mounted = false;
      for (let attempt = 0; ctx.get("remote.speech") === undefined; attempt += 1) {
        try {
          disposeRemote = await ctx.remote.$mount(SPEECH_REMOTE);
          mounted = true;
          break;
        } catch (error) {
          // A stale composition may still have the built-in voice-input client
          // mounting the same namespace. Reuse it when it appears; retry briefly
          // for the concurrent-mount race, then surface an unrelated failure.
          const race = /already mounted/i.test(errorText(error));
          if (!race || attempt >= 9) {
            if (ctx.get("remote.speech") === undefined) throw error;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      let ui;
      try {
        ui = ctx.inject(["remote.speech", "slots", "locale"], (scope) => registerUi(scope));
        await ui;
      } catch (error) {
        if (mounted) await disposeRemote();
        throw error;
      }
      return async () => {
        await ui.dispose();
        if (mounted) await disposeRemote();
      };
    }

    return { apply, inject: ["remote", "slots", "locale"] };
  },
});
