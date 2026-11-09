# dsh-plugin-speechio-fast

给 DSH 输入框加本机语音输入：点麦克风说话，停顿后已定稿的句子**直接写入消息输入框**；停止时收尾最后一句。识别用本地 **Qwen3-ASR-0.6B + llama.cpp**，音频不出本机。

```
[ 模型选择器 ]  [ 🎤 ]  [ ↑ 发送 ]
```

- **直接写入输入框**：每句话停顿后定稿，文字直接追加到光标处，不再单独显示草稿预览框。
- **CPU/GPU 切换**：插件页选自动 / GPU（Vulkan）/ CPU，选择持久化。
- **本机运行**：不需要 Python 或云服务；自动拉起服务、静音保护、长句切分。
- **原生位置**：使用 DSH 的 `conversation.input.activity` 槽位和原生麦克风图标。

## 下载模型与运行时

本仓库不含模型和 llama.cpp 二进制。

| 组件 | 来源 | 许可 | 大小 |
| --- | --- | --- | --- |
| `Qwen3-ASR-0.6B-Q8_0.gguf` | [unslothai/Qwen3-ASR-0.6B-GGUF](https://huggingface.co/unslothai/Qwen3-ASR-0.6B-GGUF/tree/main) | Apache-2.0 | 805 MB |
| `mmproj-Qwen3-ASR-0.6B-Q8_0.gguf` | 同上 | Apache-2.0 | 214 MB |
| llama.cpp Windows x64（b12199，CPU 或 Vulkan） | [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp/releases/tag/b12199) | MIT | 61 MB / 101 MB |

只下载两个 **Q8_0** 文件即可；bf16 更大更慢，一般不需要。

### 一键安装（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

默认下载到 `%DSH_HOME%\speechio`，并校验大小与 SHA256。常用参数：

```powershell
# 只装 CPU 运行时
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Backend cpu

# 自定义目录
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Root D:\models\speechio

# 显式代理
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Proxy http://127.0.0.1:7897

# 只检查，不下载
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -VerifyOnly
```

国内网络可用 `https://hf-mirror.com/unslothai/Qwen3-ASR-0.6B-GGUF/resolve/main/<file>`。

### 手动目录

```
<ROOT>\
├─ ASR\
│  ├─ Qwen3-ASR-0.6B-Q8_0.gguf
│  └─ mmproj-Qwen3-ASR-0.6B-Q8_0.gguf
└─ llama.cpp\
   ├─ vulkan\llama-server.exe
   └─ cpu\llama-server.exe
```

`<ROOT>` 默认是 `<DSH_HOME>\speechio`，可用 `asrRoot` 覆盖。

### SHA256

```
Qwen3-ASR-0.6B-Q8_0.gguf
bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971

mmproj-Qwen3-ASR-0.6B-Q8_0.gguf
41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d
```

## 系统要求

| 项目 | 最低 | 推荐 |
| --- | --- | --- |
| 系统 | Windows 10 x64 | Windows 11 x64 |
| 内存 | 8 GB | 16 GB |
| 显存（Vulkan） | 2 GB 空闲 | 4 GB+ |
| CPU（纯 CPU） | 4 核 | 8 核+ |
| 磁盘 | 1.2 GB | 1.5 GB |

## 安装插件

在 DSH 的 **Plugins → 本地安装** 选择本仓库目录。会加入三行：

| entry | 作用 |
| --- | --- |
| `speechio-stt` | DSH `speechToText` 服务，默认 Provider `qwen3-asr-local` |
| `speechio-api` | 把语音服务暴露给浏览器（`ctx.remote.speech`） |
| `speechio-provider` | 本插件：自动 / GPU / CPU Provider，以及麦克风、直接写入输入框和插件页设置 |

不要同时启用官方 `@deepseek-ai/dsh-experimental-client-ui-voice-input` 或 `@deepseek-ai/dsh-experimental-voice-input-bundle`，否则会出现第二个麦克风或重复注册 `speechToText`。

## 配置

覆盖 `speechio-provider` 的 `config`：

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

显式指向已有 llama.cpp：

```yaml
- id: speechio-provider
  config:
    llamaServer: 'D:\llama.cpp\llama-server.exe'
    model: 'D:\models\Qwen3-ASR-0.6B-Q8_0.gguf'
    mmproj: 'D:\models\mmproj-Qwen3-ASR-0.6B-Q8_0.gguf'
    ngl: 99                # 99=GPU，0=纯 CPU
    mmprojOffload: true
```

环境变量：`DSH_SPEECHIO_ASR_ROOT`、`DSH_SPEECHIO_ASR_PORT`、`DSH_SPEECHIO_BACKEND`、`DSH_SPEECHIO_LLAMA_SERVER`、`DSH_SPEECHIO_MODEL`、`DSH_SPEECHIO_MMPROJ`。

### 插件页切换 CPU / GPU

打开 **Plugins → 已安装插件 → dsh-plugin-speechio-fast**，在「语音引擎」中选择：

| 选项 | Provider | 行为 |
| --- | --- | --- |
| 自动（GPU 优先） | `qwen3-asr-local` | 启动时先试 Vulkan，失败回退 CPU |
| GPU（Vulkan） | `qwen3-asr-local-gpu` | 只用 Vulkan 版 `llama-server.exe` |
| CPU | `qwen3-asr-local-cpu` | 只用 CPU 版 `llama-server.exe` |

**切换前提：**

- GPU 走 Vulkan，**不需要 CUDA**；需要可用的 Vulkan 驱动和 `llama.cpp/vulkan/llama-server.exe`。CPU 需要 `llama.cpp/cpu/llama-server.exe`，无独显也能用。
- 两种后端共用同一份 `ASR/*.gguf`；`setup.ps1` 默认装两套。只装过 CPU 时，切 GPU 前先运行 `setup.ps1 -Backend vulkan`（或 `-Backend both`）。
- 两套运行时都在时可直接切换；缺少对应运行时会明确报错。

- 选择写入 `speechio-stt` 的 `defaultProvider`，重启 DSH 后保留。
- 切换会停止/重启本插件拉起的服务，下一次识别生效。
- 手动启动的外部服务不会被打断，只在日志中提示；显式 `llamaServer` 模式用 `ngl` 控制。

## 性能

测试机：i5-12500H / 15.6 GB / RTX 3050 Laptop 4 GB / Windows 11 / DSH 0.2.2-rc.1；llama.cpp b12199，`ctx=2048`，`-t 8`，5–8 次中位数。

这些数字偏保守：测试脚本包含断句、HTTP 和统计开销；实际连续使用、服务已预热时通常更快。

### 速度

| 后端 | 7.69 s 音频 | 11.35 s 音频 | 47.83 s 音频 |
| --- | ---: | ---: | ---: |
| **Vulkan（RTX 3050）** | 0.21 s（36.5x） | 0.25 s（44.7x） | 1.35 s（35.4x） |
| **CPU（8 线程）** | 2.06 s（3.7x） | 1.97 s（5.8x） | 7.54 s（6.3x） |

- `xRT` = 音频时长 ÷ 耗时，越高越快；`RTF` = 耗时 ÷ 音频时长，越低越好。
- Vulkan RTF≈0.02–0.03；CPU≈0.16–0.27。
- 5–10 秒一句话约 0.2 秒（Vulkan）/ 2 秒（CPU）；30 秒约 0.8 秒 / 5 秒。
- 长句会自动切分。
- 现在只发定稿请求，不再发预览请求；上面的数字是单次定稿识别的耗时。

### 资源

| 项目 | Vulkan | CPU |
| --- | ---: | ---: |
| 首次启动 | 约 8.7 s | — |
| 后续启动 | 3.8–4.1 s | 2.1–4.0 s |
| llama-server 工作集 | 约 0.9 GB | 约 1.4 GB |
| 私有/提交内存 | 约 2.3 GB | 约 1.4 GB |
| 显存 | 约 1.63 GB | 0 |
| CPU 峰值 | 约 3.6 核 | 约 8–9 核 |
| GPU 利用率峰值 | 约 69% | 0 |
| 磁盘 | 1.02 GB 模型 + 0.10 GB 运行时 | 1.02 GB + 0.06 GB |

服务加载后常驻，空闲时几乎不占 CPU/GPU。

### 怎么选

- **2 GB+ 空闲显存**：选 GPU（Vulkan），速度约为 CPU 的 6–10 倍。
- **无独显或显存不足**：选 CPU 或自动；8 线程仍快于实时。
- **内存**：8 GB 可跑，16 GB 更稳。
- **模型**：Q8_0 是推荐版本；1.7B 未做适配与测试。

### 复现

```powershell
node scripts\bench.mjs `
  --root "C:\Users\<你>\.dsh\speechio" `
  --backend vulkan `
  --repeat 5 `
  --wav "D:\samples\short.wav" "D:\samples\long.wav"
```

## 使用

1. 打开会话，点麦克风；首次允许麦克风权限。
2. 说话：每句话停顿后定稿，文字直接出现在消息输入框的光标处。
3. 点方形停止：等最后一句完成后收尾，所有文字都在输入框里，可直接编辑或发送。
4. 如果输入框原本为空，✕ 或 Esc 取消会清掉本次已写入的文字；如果输入框原本有内容或你中途编辑过，取消会保留已转写文字并提示。

按句写入，不是逐字流式；CPU 下每句的间隔会稍长。转写期间不再发预览请求，只发定稿请求，CPU/GPU 开销更低。

## 稳定性

- 每次识别前检查 `/health`；没有服务则自动拉起 `llama-server.exe`，最多等 90 秒。
- `auto` 先试 Vulkan，失败回退 CPU；显式 GPU 失败直接报错。
- 切换后端只重启本插件拉起的服务；外部服务不动。
- 识别请求串行；定稿句子按顺序写入输入框。
- 静音保护：无语音能量不送模型；静音片段不产生文字。
- 取消会中断等待和 HTTP；只清理本插件拉起的进程。

## 排障

- **没有麦克风按钮**：确认 `speechio-provider` 处于 active。
- **插件页没有「语音引擎」**：确认 `speechio-provider` 处于 active；该设置由本包浏览器半侧注册。
- **切换 CPU/GPU 没反应**：看 DSH 日志里的 `[speechio-fast]`；外部服务需手动停止；显式 `llamaServer` 用 `ngl`。
- **模型找不到**：检查 `asrRoot` 布局，或改用显式 `llamaServer` / `model` / `mmproj`。
- **麦克风权限**：Windows 设置 → 隐私 → 麦克风。
- **Vulkan 崩溃**：切到 CPU，或删除 `llama.cpp\vulkan`。
- **端口冲突**：改 `port`，确认 `10012` 没被占用。
- **自检**：`node scripts\test-asr.mjs "C:\path\to\16k.wav"`。

## 许可

- 本仓库代码：MIT。
- Qwen3-ASR-0.6B 模型：Apache-2.0。
- llama.cpp：MIT。

模型和 llama.cpp 二进制不随本仓库分发；下载和使用时遵守各自许可。
