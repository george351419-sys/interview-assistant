# 面试助手 · 真实可运行版

练习场景下的「手机端实时 AI 提示屏」。**这是可运行的程序，不是演示动画**：Node.js 服务端、WebSocket 实时通信、真实 LLM 调用、真实语音转写、真实音频采集链路。

> ⚠️ **合规红线**：本工具仅用于「对面是朋友 / AI」的模拟练习。**严禁**在真实面试中使用。

---

## 它能做什么

对面（朋友或 AI）提问 → 你在**手机**上收到基于 **JD + 简历**生成的练习材料。提示屏支持两种模式：入门模式展示完整示范回答，降低开口门槛；进阶模式只给回答提纲，并在你作答时自动收起、下一题或追问时恢复。可从完整示范逐步切换到提纲练习，目标仍是练到不依赖 AI。

**滚动上下文闭环（已实现）**：你说话的回答经豆包流式 ASR 转写 → LLM 一次调用同时生成「本轮提示」和「记忆增量」（你真实说过的事实）→ 下一题的提示自动避开你已说过的内容、顺势接住追问。简历不再全量硬塞，而是按当前问题 + JD 关键词筛选出最相关的 3 段经历注入。记忆只存服务端内存，重启即清空。

### 模拟练习功能（练习向）
- **计时**：手机提示屏从提示推出起实时显示「思考耗时」，回答提交自动停止；顶部显示第几题 / 本场用时 / 卡壳数。练「30 秒内开口」。
- **题库模拟面试**：提问端切到「模拟面试」模式，从配置的陪练题库顺序出题、自动推进、可跳题、可看参考答案；进入即开一场新练习（清空旧记忆与回合）。
- **练习复盘**：`practice.html` 汇总本场每一题的题目 / 你的回答 / 耗时 / 自评 / 提示要点，顶部统计（总题数、已答、平均每题、AI 平均分、总时长、卡壳数、题型分布），一键导出 Markdown 复盘文档。提示屏每题可标 👍 答得好 / 🔁 卡壳，写入复盘统计。
- **AI 回答评分**（真实 LLM）：每次提交回答后，异步调用一次 LLM 做复盘评分——四维打分（结构 / 内容 / 证据 / 表达，各 25 分）、一句话总评、做得好 / 下次改进、一段「更好的说法」示范。评分诚实（敷衍回答会明显低分），不阻塞主提示链路、不写记忆；失败也不影响练习。复盘统计里显示 AI 平均分。
- **错题重练**：复盘页点「🔁 重练卡壳题」，自动筛出标了卡壳或评分 < 60 的题（没有则取本场全部答过的题），推到提问端切成「错题重练」模式，按弱题顺序重新练一轮，题目标注「卡壳 / 低分 / 复练」原因。
- **历史存档 + 进步对比**：换场（开始新一轮 / 进入模拟模式 / 错题重练）或点「结束本场」时，自动把当前练习落盘到 `data/history/`（一场一个 JSON，最多留 100 场）。复盘页底部两栏：📈 **进步趋势**——同一道题跨场次的评分链（如 `58 → 72 → 85 ↑27`），每题评分卡上也标「上次 X → 这次 Y」；🗂 **历史练习**——过往场次列表，可查看某场详情、删除单场或清空。数据真持久化，重启服务仍在。

> 本场（当前未结束的）复盘在服务端内存；换场/结束后自动存档到磁盘。AI 评分会多消耗一次 LLM 调用，约几秒后出现在复盘页。历史存 `data/history/`，导出 Markdown 可永久留存。

## 三条真实链路（按依赖从少到多）

| 链路 | 提问方式 | 依赖 | 适合 |
|---|---|---|---|
| **A. 最短闭环** | 浏览器语音识别 / 打字 | 一个 OpenAI 兼容 API key | 立即跑通，推荐先用 |
| **B. 本机免联网** | 浏览器语音 / 打字 | Ollama 本地模型 | 离线、免费、隐私 |
| **C. 系统音频采集** | ffmpeg 自动抓取会议播放声 | BlackHole + whisper/云端 ASR | 贴近 PRD 的 M0 原场景 |

**A 和 B 不需要装 BlackHole / whisper。** 浏览器自带语音识别，服务端只做 LLM 调用。

### 关于「我的回答」如何进入下一轮提示（豆包 ASR）

打开 `/me.html` 即为回答端。两种输入方式：

1. **豆包流式 ASR**：配置台填入火山引擎 API Key（`X-Api-Key`，新版控制台），点麦克风开始说话 → 浏览器采集 16k PCM 经 WebSocket 送服务端 → 服务端用豆包双向流式 ASR 实时转写（含说话人分离）。密钥只存服务端，不下发浏览器。
2. **文字输入**：直接在文本框写回答，走同一记忆闭环（无需 ASR 凭证）。

回答写入会话记忆后，下一题生成提示时会自动带上。这是**一次 LLM 调用**完成的（提示 + 记忆增量一起出），不会因记忆功能额外增加延迟。

> 说话人区分的正确做法不是声纹猜人，而是物理分轨：对面声音走会议播放回路（链路 C 的 loopback），你的声音走麦克风（本页）。两路天然分离。即便戴耳机外放导致混音，豆包 ASR 的 `enable_speaker_info` 也能按 speaker_id 兜底分组。

### 网页会议标签页自动听题

朋友在网页会议室（例如浏览器中的腾讯会议、飞书或 Google Meet）提问时，可以在电脑的「提问端」点击「连接网页会议并开始听题」：

1. 在浏览器弹出的共享窗口中选择正在开会的标签页，并勾选「共享标签页音频」。
2. 浏览器把该标签页的音频流交给提问端；服务端通过已配置的豆包流式 ASR 转写。
3. 转写结果以面试官问题进入现有提示生成链路，自动推到手机；不会被记录成用户回答。
4. 点「停止会议听题」或结束浏览器共享即可停止。

需要桌面版 Chrome/Chromium 支持 `getDisplayMedia` 标签页音频共享，并需要在配置台配置豆包 ASR。若没有勾选音频、浏览器不支持或会议本身不在浏览器标签页中，请改用系统音频链路 C。浏览器会显示明确的共享授权 UI，不能静默接入；请仅在朋友知情同意的模拟练习中使用。所共享音频会发送至火山引擎进行 ASR 转写。

---

## 快速开始（链路 A，最短真实闭环）

```bash
cd interview-assistant
npm install
npm start
```

浏览器打开 http://localhost:8787 ，按三页走：

1. **配置台** `/console.html`：填 LLM（选 OpenAI 兼容接口，填 Base URL / 模型 / key），填入 JD 和简历，保存。点「测试真实连接」确认能出提示。
2. **提问端** `/interviewer.html`：点麦克风说话（浏览器真实转写），或直接用文字/快捷题提问。
3. **手机提示屏** `/phone.html`：手机连同一 Wi-Fi，访问 `http://<电脑局域网IP>:8787/phone.html`，实时收提示。

> 查电脑局域网 IP：macOS `ipconfig getifaddr en0`。

如果没有 API key，想用本机模型走链路 B：先 `brew install ollama && ollama pull qwen2.5:7b`，配置台 Provider 选 Ollama 即可。

## 发布到公网（Render）

GitHub 用来保存和协作管理代码；GitHub Pages 只托管静态文件，不能运行本项目需要的 Node.js 服务和 WebSocket。仓库提供 `render.yaml`，可通过 Render 创建 Node Web Service 并获得公网 HTTPS 地址。

从 GitHub 导入 `george351419-sys/interview-assistant` 时选择 **Blueprint**，按提示设置 `APP_PASSWORD`、`LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`。`APP_SESSION_SECRET` 由 Render 生成。不要把密钥或个人简历提交到 GitHub；本地 `data/config.json`、练习历史与 `.env` 已加入忽略列表。生产模式没有 `APP_PASSWORD` / `APP_SESSION_SECRET` 时会拒绝启动；登录后 HTTP 页面、API 和 WebSocket 才能访问。

Render 免费实例适合验收：闲置 15 分钟后会休眠，首次访问唤醒可能约需一分钟；实例文件系统是临时的，重启、休眠或重新部署后 `data/history/` 中的练习历史会丢失。需要长期保留历史时应接入持久化数据库或磁盘。

---

## 配置说明

所有配置写入 `data/config.json`，也可复制 `.env.example` 为 `.env` 提供初次默认值。网页配置台改动优先。

- **LLM**：`provider`（ollama / openai）、`baseUrl`、`model`、`apiKey`。
  - 云端：`baseUrl=https://api.openai.com/v1`，`model=gpt-4o-mini`，填 key。任何 OpenAI 兼容端点（含中转 / 自建）都行。
  - 本机：`provider=ollama`，`baseUrl=http://127.0.0.1:11434`，`model=qwen2.5:7b`，key 留空。
- **ASR**：`browser`（默认，浏览器语音）/ `whisper`（采集器用）。
- **JD / 简历 / 陪练题库**：提示的内容源，决定提示是否「针对岗位」。

**未配置 LLM 时，服务端会明确报错，绝不返回假提示。** 这是刻意设计——真实是这条产品线的唯一护城河。

---

## 链路 C：系统音频自动采集（进阶，贴近 PRD M0）

让 ffmpeg 自动捕获会议软件的「对面声音」，VAD 检测说话段，自动转写并推送问题——无需你手动说话。

### 1. 装 BlackHole（捕获系统输出）

```bash
brew install blackhole-2ch
```

装后在「系统设置 → 声音 → 输出」把 BlackHole 设为输出（或用「音频 MIDI 设置」创建多输出设备，把 BlackHole 和扬声器一起选中，这样你能听到、程序也能抓到）。会议软件（腾讯会议/Zoom）的输出也选 BlackHole。

### 2. 确认设备

```bash
node capture/loopback.js --list
```

记下 BlackHole 的设备索引或名称。

### 3. 启动采集器（先启动服务端）

云端 ASR（用同一个 key，省得装 whisper）：
```bash
node capture/loopback.js --asr openai --device "BlackHole 2ch" --asr-key sk-你的key
```

本机 ASR（免费离线，需先装 whisper.cpp）：
```bash
brew install whisper-cpp
# 下载中文模型到 ~/models/ggml-small.bin.zh
node capture/loopback.js --asr whisper --device "BlackHole 2ch" \
  --whisper-bin "$(which whisper-cli)" --whisper-model ~/models/ggml-small.bin.zh
```

采集器做真实 VAD（能量阈值），检测到一段语音结束才转写，避免半句话就推送。转写结果通过 WebSocket 以 `interviewer` 角色推送，后续链路与 A/B 完全一致。

> 没有 BlackHole 时，可用麦克风索引（如 `--device 1`）采集你自己的声音做链路测试，但那是「你的声音」不是「对面声音」，只用于验证采集管线。

---

## 自检

```bash
node scripts/check.js
```

真实检测 Node/ffmpeg/ws/LLM/Ollama/BlackHole/whisper，缺什么报什么，并给出最短可跑通路径。

---

## 目录结构

```
interview-assistant/
├─ server.js                 HTTP服务 + 配置API + 启动WS
├─ lib/
│  ├─ config.js              配置持久化 + .env
│  ├─ llm.js                 真实LLM调用 + 提示生成 + AI回答评分evaluate() + JSON容错重试
│  ├─ hub.js                 WebSocket多角色路由（interviewer/me/phone/console/practice）+ ASR桥接 + 练习会话/计时/复盘统计/AI评分/错题重练/自动存档
│  ├─ doubao-asr.js          豆包双向流式ASR客户端（帧封装/gzip/WAV头/说话人分离，真实端点已验证）
│  ├─ memory.js              滚动会话记忆 + 简历结构化 + 相关经历筛选
│  └─ history.js             练习历史持久化（data/history/）+ 同题跨场进步对比
├─ data/
│  ├─ config.json            配置（LLM/ASR/JD/简历/题库）
│  └─ history/               每场练习存档 JSON（最多100场）
├─ public/
│  ├─ index.html             首页
│  ├─ interviewer.html       提问端（浏览器语音 / 文字 / 题库模拟面试 / 接收错题重练队列）
│  ├─ me.html                我的回答端（麦克风PCM→豆包ASR→记忆 / 文字输入）
│  ├─ phone.html             手机提示屏（思考计时 + 自评 + "已结合你的回答"标记）
│  ├─ practice.html          练习复盘（统计卡 + AI评分卡 + 逐题回顾 + 导出Markdown + 错题重练 + 历史/进步趋势）
│  ├─ console.html           配置台 + 运行事件（含豆包ASR密钥）
│  └─ css/ js/               样式 + WS客户端（含 PracticeTimer / 时长格式化）
├─ capture/loopback.js        ffmpeg采集 + VAD + ASR（链路C）
├─ scripts/check.js           环境自检
├─ data/config.json          运行时配置（自动生成）
├─ prototype/                 v0.1 浏览器演示原型（留档，非主程序）
└─ .env.example / start.sh
```

## 数据与隐私边界

- 使用本机 Ollama 时，LLM 请求留在本机；使用云端 LLM 时，提问、岗位 JD、相关简历片段和必要的回答上下文会发送给所配置的模型服务。
- 使用豆包 ASR 时，麦克风采集的回答音频会发送至火山引擎进行转写；系统音频链路若选择云端 ASR，也会发送相应音频。改用本地 Whisper 才能避免这部分云端传输。
- 配置保存在 `data/config.json`，练习记录（包括题目、回答和 AI 反馈）保存在 `data/history/`；请勿把真实个人信息放入不可信的模型服务。
- 本地开发默认不启用登录；生产部署必须设置访问密码，并通过登录 Cookie 保护页面、API 和 WebSocket。公网部署时仍需仅使用可信的 LLM/ASR 服务，并避免录入不应上传的个人信息。
- 无账号、无计费、无多用户——自用优先。
