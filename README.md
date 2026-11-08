# dsh-plugin-speechio-fast

Local voice input for DeepSeek Harness. Click the microphone, speak, and see the transcript stream into the recording bar; stop and the finished text is inserted into the draft. Recognition runs through **Qwen3-ASR-0.6B + llama.cpp** on your machine. No Python, no cloud, no audio leaves the host.

```
[ model selector ]  [ 🎤 ]  [ ↑ send ]
```

- **Live transcript**: the current sentence previews as you speak and is finalized on a pause.
- **CPU/GPU switch**: Auto / GPU (Vulkan) / CPU on the plugin page; the choice persists.
- **Local runtime**: auto-starts `llama-server`, guards silent audio, and splits long speech.
- **Native placement**: uses DSH's `conversation.input.activity` slot and microphone icon.

## Models and runtime

This repository ships no model weights and no llama.cpp binaries.

| Component | Source | License | Size |
| --- | --- | --- | --- |
| `Qwen3-ASR-0.6B-Q8_0.gguf` | [unslothai/Qwen3-ASR-0.6B-GGUF](https://huggingface.co/unslothai/Qwen3-ASR-0.6B-GGUF/tree/main) | Apache-2.0 | 805 MB |
| `mmproj-Qwen3-ASR-0.6B-Q8_0.gguf` | same | Apache-2.0 | 214 MB |
| llama.cpp Windows x64 (b12199, CPU or Vulkan) | [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp/releases/tag/b12199) | MIT | 61 MB / 101 MB |

Download only the two **Q8_0** files; bf16 is larger and slower.

### One-click setup

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

Downloads to `%DSH_HOME%\speechio` and verifies size and SHA256. Common options:

```powershell
# CPU runtime only
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Backend cpu

# custom root
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Root D:\models\speechio

# explicit proxy
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Proxy http://127.0.0.1:7897

# verify only
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -VerifyOnly
```

In mainland China, use `https://hf-mirror.com/unslothai/Qwen3-ASR-0.6B-GGUF/resolve/main/<file>`.

### Manual layout

```
<ROOT>\
├─ ASR\
│  ├─ Qwen3-ASR-0.6B-Q8_0.gguf
│  └─ mmproj-Qwen3-ASR-0.6B-Q8_0.gguf
└─ llama.cpp\
   ├─ vulkan\llama-server.exe
   └─ cpu\llama-server.exe
```

`<ROOT>` defaults to `<DSH_HOME>\speechio`; override it with `asrRoot`.

### SHA256

```
Qwen3-ASR-0.6B-Q8_0.gguf
bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971

mmproj-Qwen3-ASR-0.6B-Q8_0.gguf
41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d
```

## Requirements

| Item | Minimum | Recommended |
| --- | --- | --- |
| OS | Windows 10 x64 | Windows 11 x64 |
| RAM | 8 GB | 16 GB |
| VRAM (Vulkan) | 2 GB free | 4 GB+ |
| CPU (CPU mode) | 4 cores | 8 cores+ |
| Disk | 1.2 GB | 1.5 GB |

## Install the plugin

Use **Plugins → local install** and select this repository. It adds three rows:

| entry | role |
| --- | --- |
| `speechio-stt` | DSH `speechToText` service, default provider `qwen3-asr-local` |
| `speechio-api` | exposes the speech service to the browser (`ctx.remote.speech`) |
| `speechio-provider` | this plugin: Auto / GPU / CPU providers, microphone, live transcript, plugin-page setting |

Do not also enable `@deepseek-ai/dsh-experimental-client-ui-voice-input` or `@deepseek-ai/dsh-experimental-voice-input-bundle`; they add a second microphone or duplicate `speechToText`.

## Configuration

Override the `speechio-provider` entry:

```yaml
- id: speechio-provider
  config:
    asrRoot: 'D:\models\speechio'
    port: 10012
    backend: auto          # auto | vulkan | cpu
    autoStart: true
    threads: 8
    contextSize: 2048
    maxUtteranceSeconds: 15
    silenceMs: 550
```

Point at an existing llama.cpp install explicitly:

```yaml
- id: speechio-provider
  config:
    llamaServer: 'D:\llama.cpp\llama-server.exe'
    model: 'D:\models\Qwen3-ASR-0.6B-Q8_0.gguf'
    mmproj: 'D:\models\mmproj-Qwen3-ASR-0.6B-Q8_0.gguf'
    ngl: 99                # 99=GPU, 0=CPU
    mmprojOffload: true
```

Environment: `DSH_SPEECHIO_ASR_ROOT`, `DSH_SPEECHIO_ASR_PORT`, `DSH_SPEECHIO_BACKEND`, `DSH_SPEECHIO_LLAMA_SERVER`, `DSH_SPEECHIO_MODEL`, `DSH_SPEECHIO_MMPROJ`.

### CPU / GPU on the plugin page

Open **Plugins → Installed plugins → dsh-plugin-speechio-fast** and choose under **Speech engine**:

| Option | Provider | Behavior |
| --- | --- | --- |
| Auto (GPU first) | `qwen3-asr-local` | Try Vulkan; fall back to CPU on failure |
| GPU (Vulkan) | `qwen3-asr-local-gpu` | Vulkan `llama-server.exe` only |
| CPU | `qwen3-asr-local-cpu` | CPU `llama-server.exe` only |

**Before switching:**

- GPU uses Vulkan, **not CUDA**; it needs a working Vulkan driver and `llama.cpp/vulkan/llama-server.exe`. CPU needs `llama.cpp/cpu/llama-server.exe` and works without a discrete GPU.
- Both backends share the same `ASR/*.gguf` files; `setup.ps1` installs both by default. If you installed only CPU, run `setup.ps1 -Backend vulkan` (or `-Backend both`) first.
- With both runtimes installed, switch directly; a missing runtime reports an error.

- The choice is written to `speechio-stt.defaultProvider` and survives a restart.
- Switching stops/restarts a server started by this plugin; the next recognition uses it.
- A manually started server is left alone and only logged; with explicit `llamaServer`, use `ngl` instead.

## Performance

Test machine: i5-12500H / 15.6 GB / RTX 3050 Laptop 4 GB / Windows 11 / DSH 0.2.2-rc.1; llama.cpp b12199, `ctx=2048`, `-t 8`, median of 5–8 runs.

These figures are conservative: the benchmark includes segmentation, HTTP, and measurement overhead; real continuous use with a warm server is usually faster.

### Speed

| Backend | 7.69 s audio | 11.35 s audio | 47.83 s audio |
| --- | ---: | ---: | ---: |
| **Vulkan (RTX 3050)** | 0.21 s (36.5x) | 0.25 s (44.7x) | 1.35 s (35.4x) |
| **CPU (8 threads)** | 2.06 s (3.7x) | 1.97 s (5.8x) | 7.54 s (6.3x) |

- `xRT` = audio duration ÷ time, higher is faster; `RTF` = time ÷ audio duration, lower is better.
- Vulkan RTF≈0.02–0.03; CPU≈0.16–0.27.
- A 5–10 s sentence takes about 0.2 s on Vulkan / 2 s on CPU; 30 s takes about 0.8 s / 5 s.
- Long speech is split automatically.
- Live preview adds inference work; nearly free on GPU, noticeable on CPU.

### Resources

| Item | Vulkan | CPU |
| --- | ---: | ---: |
| First start | ~8.7 s | — |
| Later starts | 3.8–4.1 s | 2.1–4.0 s |
| llama-server working set | ~0.9 GB | ~1.4 GB |
| Private/commit memory | ~2.3 GB | ~1.4 GB |
| VRAM | ~1.63 GB | 0 |
| CPU peak | ~3.6 cores | ~8–9 cores |
| GPU peak | ~69% | 0 |
| Disk | 1.02 GB models + 0.10 GB runtime | 1.02 GB + 0.06 GB |

The server stays resident after loading; idle CPU/GPU is near zero.

### Choosing a backend

- **2 GB+ free VRAM**: GPU (Vulkan); roughly 6–10x faster than CPU.
- **No discrete GPU or <2 GB free VRAM**: CPU or Auto; 8 threads still run faster than real time.
- **RAM**: 8 GB works; 16 GB is more comfortable.
- **Model**: Q8_0 is recommended; 1.7B is untested.

### Reproduce

```powershell
node scripts\bench.mjs `
  --root "C:\Users\<you>\.dsh\speechio" `
  --backend vulkan `
  --repeat 5 `
  --wav "D:\samples\short.wav" "D:\samples\long.wav"
```

## Usage

1. Open a session and click the microphone; allow access on first use.
2. Speak: the current sentence previews live and is finalized on a pause.
3. Click the square stop button; the finished transcript is inserted into the draft.
4. If the draft changed, the text stays in the recording bar with **Insert**; ✕ or Esc cancels.

Live preview updates by sentence, not word by word; CPU preview is slower. Provisional text is not inserted.

## Stability

- Health check before every recognition; start an owned `llama-server.exe` when needed, waiting up to 90 s.
- `auto` tries Vulkan and falls back to CPU; an explicit GPU choice reports failure.
- Switching backends restarts only the server owned by this plugin.
- Recognition requests are serialized; a preview request is cancelled when its sentence is finalized.
- Silence guard: no speech energy means no model call; silent previews are ignored.
- Cancel aborts the wait and HTTP request; only plugin-owned processes are stopped.

## Troubleshooting

- **No microphone button**: confirm `speechio-provider` is active.
- **No “Speech engine” setting**: confirm `speechio-provider` is active; the setting is registered by this package's browser half.
- **CPU/GPU switch does nothing**: check `[speechio-fast]` in the DSH log; stop a manually started server; with explicit `llamaServer`, use `ngl`.
- **Model not found**: check the `asrRoot` layout, or use explicit `llamaServer` / `model` / `mmproj`.
- **Microphone permission**: Windows Settings → Privacy → Microphone.
- **Vulkan crashes**: switch to CPU, or remove `llama.cpp\vulkan`.
- **Port conflict**: change `port` and confirm `10012` is free.
- **Self-test**: `node scripts\test-asr.mjs "C:\path\to\16k.wav"`.

## License

- Plugin code: MIT.
- Qwen3-ASR-0.6B model: Apache-2.0.
- llama.cpp: MIT.

Model weights and llama.cpp binaries are not distributed with this repository; follow their licenses when downloading and using them.
