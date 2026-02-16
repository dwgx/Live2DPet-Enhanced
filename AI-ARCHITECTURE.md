# Live2DPet — AI 子系统架构与 Prompt 工程

## 目录

- [系统总览](#系统总览)
- [核心数据流](#核心数据流)
- [模块详解](#模块详解)
  - [1. AI Chat Client — API 通信层](#1-ai-chat-client--api-通信层)
  - [2. Prompt Builder — 提示词构建器](#2-prompt-builder--提示词构建器)
  - [3. Desktop Pet System — 主循环调度器](#3-desktop-pet-system--主循环调度器)
  - [4. Enhancement System — 增强子系统](#4-enhancement-system--增强子系统)
  - [5. Emotion System — 情感系统](#5-emotion-system--情感系统)
  - [6. Message Session — 消息同步播放](#6-message-session--消息同步播放)
  - [7. Audio Pipeline — 语音合成管线](#7-audio-pipeline--语音合成管线)
- [Prompt 工程详解](#prompt-工程详解)
- [设计决策与权衡](#设计决策与权衡)

---

## 系统总览

Live2DPet 的 AI 子系统由 7 个核心模块组成，形成一个 **感知 → 理解 → 生成 → 表达** 的完整闭环：

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Desktop Pet System (主循环)                    │
│                                                                     │
│  ┌──────────┐   ┌──────────────┐   ┌──────────┐   ┌─────────────┐ │
│  │ 截屏采集  │──▶│ Enhancement  │──▶│  Prompt   │──▶│  AI Chat    │ │
│  │ 5s/次    │   │ Orchestrator │   │  Builder  │   │  Client     │ │
│  │ 焦点追踪  │   │              │   │           │   │  (API调用)   │ │
│  │ 1s/次    │   │ ┌──────────┐ │   └──────────┘   └──────┬──────┘ │
│  └──────────┘   │ │VLM压缩器 │ │                         │        │
│                 │ │记忆追踪器 │ │                         ▼        │
│                 │ │知识存储   │ │              ┌──────────────────┐ │
│                 │ │网页搜索   │ │              │ Message Session  │ │
│                 │ │知识获取   │ │              │ (文字+情感+语音)  │ │
│                 │ └──────────┘ │              └────────┬─────────┘ │
│                 └──────────────┘                      │           │
│                                                       ▼           │
│                 ┌──────────────┐              ┌──────────────────┐ │
│                 │Emotion System│◀─────────────│  Audio Pipeline  │ │
│                 │ (AI选择表情)  │              │ TTS/默认/静音     │ │
│                 └──────────────┘              └──────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**AI 调用点统计**：系统中共有 5 个独立的 AI API 调用点：
1. 主对话生成（Vision API，含截图）
2. VLM 场景压缩（Vision API，含截图）
3. 情感分类（纯文本）
4. 知识整理（纯文本）
5. 知识获取 — 主题提取 + 搜索词生成（纯文本，2次调用）

另有 1 个独立的翻译 API 调用（中文→日语，用于 TTS）。

---

## 核心数据流

### 主循环时序（每 30 秒一次 tick）

```
时间轴 ──────────────────────────────────────────────────────────▶

[截屏采集 5s/次]  ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ...
[焦点追踪 1s/次]  |||||||||||||||||||||||||||||| ...

[主 tick 30s]     ├─────────── 一次完整请求 ──────────────┤
                  │                                       │
                  │  1. 获取活动窗口信息                     │
                  │  2. 收集桌面布局 + 空闲时间               │
                  │  3. Enhancement 预处理                  │
                  │     ├─ 记忆发布到短期池                   │
                  │     ├─ 触发搜索（如需要）                 │
                  │     ├─ VLM 场景压缩（fire-and-forget）   │
                  │     └─ 知识获取（fire-and-forget）       │
                  │  4. 构建动态上下文                       │
                  │  5. 组装 system prompt + 历史 + 截图     │
                  │  6. 调用 AI API                        │
                  │  7. 响应 → 双缓冲队列                    │
                  │  8. MessageSession 播放                 │
                  │     ├─ 并行：TTS合成 + AI情感选择         │
                  │     └─ 同步：气泡 + 音频 + 表情           │
                  │                                       │
                  ├───────────────────────────────────────┤
```

### 消息双缓冲机制

```
AI 响应 A ──▶ pendingMessage = A
AI 响应 B ──▶ pendingMessage = B  (A 被覆盖，永远不会播放)
AI 响应 C ──▶ pendingMessage = C  (B 被覆盖)

播放器取出 C ──▶ pendingMessage = null
                 isPlayingMessage = true
                 播放 C（气泡 + 音频 + 表情）
                 播放完毕 → chatGap 等待
                 isPlayingMessage = false
```

设计意图：AI 响应可能因网络延迟堆积，双缓冲确保用户永远只看到最新的消息，避免"消息排队"的不自然体验。

---

## 模块详解

### 1. AI Chat Client — API 通信层

**文件**: `src/core/ai-chat.js` (131 行)

统一的 OpenAI 兼容 API 客户端，所有 AI 调用都通过此模块。

```
支持的 API 格式: OpenAI / OpenRouter / Grok / Gemini / 任何兼容端点
请求格式:       POST {baseURL}/chat/completions
超时:           120 秒 (AbortController)
温度:           0.86 (偏高，增加对话多样性)
max_tokens:     2048 × multiplier (可配置 0.5~4.0)
```

关键设计：
- **思维链清理**: 自动剥离 `<think>` / `<thinking>` 标签，兼容 DeepSeek 等带推理过程的模型
- **单一入口**: `callAPI(messages)` 接受完整的 messages 数组，调用方自行构建 system/user/assistant 消息

### 2. Prompt Builder — 提示词构建器

**文件**: `src/core/prompt-builder.js` (134 行)

负责将角色卡、规则、动态上下文组装成最终的 system prompt。

**System Prompt 结构**:
```
┌─────────────────────────────────────────┐
│ [响应模式] 不要过度思考，尽快给出回复      │  ← 最高优先级，放在最前
├─────────────────────────────────────────┤
│ 角色描述 (description)                   │  ← 模板变量替换
│ 性格设定 (personality)                   │
│ 场景设定 (scenario)                      │
├───────── 分隔线 ─────────────────────────┤
│ 规则 (rules)                            │  ← 硬性约束
│ [重要提醒] 以上规则必须严格遵守            │  ← 强化遵守
├───────── 分隔线 ─────────────────────────┤
│ 动态上下文 (每次请求实时生成)              │  ← 见下方详解
├─────────────────────────────────────────┤
│ 使用{语言}                               │  ← 语言指令放最后
└─────────────────────────────────────────┘
```

**模板变量系统**:
```
{{petName}}       → 角色名称 (如 "后辈")
{{userIdentity}}  → 用户身份 (如 "后辈" / "kouhai")
{{userTerm}}      → 对用户的称呼 (如 "前辈" / "senpai")
```

### 3. Desktop Pet System — 主循环调度器

**文件**: `src/core/desktop-pet-system.js` (556 行)

系统的中枢，协调所有子模块。

**三层定时器架构**:
```
截屏定时器 (5s)  ──▶ 按窗口标题分桶存储，每窗口最多 3 张
焦点定时器 (1s)  ──▶ 记录每个窗口的累计使用秒数
主循环定时器 (30s) ──▶ 触发 AI 请求
```

**动态上下文构建** (`buildDynamicContext`):

每次 AI 请求前实时生成，注入到 system prompt 中：

```
[自我认知] 不要主动提及自己的外观或自己是Live2D角色
[当前情绪状态] 情绪值: 45/100, 下一个情绪: happy
[最近窗口使用情况] VSCode: 120秒, Chrome: 45秒, Discord: 30秒
[桌面布局] VSCode [1920x1080], Chrome [960x1080]
[用户输入空闲] 已有30秒无键盘/鼠标操作
[你的位置] 屏幕坐标(1800,900)，大小200x300。截图中该位置的角色就是你自己
[屏幕内容 (15秒前)] 用户正在VSCode中编写React组件...  ← Enhancement 输出
```

**User 消息构建**:
```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "[14:30] （system：当前用户正在使用 VSCode，请自然地回应一句）（附上屏幕截图）" },
    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } },
    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
  ]
}
```

**对话历史管理**:
- 保留最近 4 轮对话 (8 条消息)
- 历史中的 user 消息用文本摘要替代截图（节省 token）：
  `"(用户正在使用 VSCode，附截图)"` 而非原始的 base64 图片

### 4. Enhancement System — 增强子系统

**文件**: `src/core/enhance/` (6 个模块，~900 行)

这是系统最复杂的部分。核心设计理念：**VLM 作为单一压缩点**。

```
                    ┌─────────────────────────────────┐
                    │     Enhancement Orchestrator     │
                    │         (协调器)                  │
                    └──────────┬──────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
   ┌─────────────┐    ┌──────────────┐    ┌──────────────┐
   │Memory Tracker│    │Search Service│    │Knowledge     │
   │ 活动记忆追踪  │    │ 网页搜索      │    │Acquisition   │
   │              │    │              │    │ 自动知识获取   │
   └──────┬──────┘    └──────┬──────┘    └──────┬──────┘
          │                  │                   │
          │    长期数据汇聚    │                   │
          └────────┬─────────┘                   │
                   ▼                             │
          ┌──────────────┐                       │
          │ VLM Extractor│◀──────────────────────┘
          │ 视觉场景压缩   │
          │              │
          │ 输入: 截图     │
          │      + 标题   │
          │      + 长期   │
          │        上下文  │
          │              │
          │ 输出: ~200字符 │
          │   情景描述     │
          └──────┬───────┘
                 │
                 ▼
          ┌──────────────┐
          │  主 AI 对话    │  ← 只看到这一行压缩后的情景
          └──────────────┘
```

#### 4.1 VLM Extractor — 视觉场景压缩器

**核心思想**: 将截图 + 所有长期积累的知识压缩为一句 ~200 字符的情景描述，主 AI 只需要消费这一句话。

**VLM Prompt**:
```
你是一个上下文压缩器。根据截图、窗口标题和可选的背景数据，
输出简洁的情景描述（最多200字符）。
聚焦于用户当前正在做什么。
丢弃与当前屏幕无关的背景信息。
如果背景数据与截图矛盾，以截图为准。
如果提供了上次情景，描述变化的部分，不要重复未变的内容。
用{语言}输出。不要解释，只输出情景。
```

**VLM User 消息结构**:
```
Window: React Tutorial - Chrome
Previous: 用户在看React教程，正在学习useState hook
Background:
Activity: VSCode: 300s, Chrome: 120s
Knowledge: [React] 前端框架，组件化开发
Search: React hooks best practices 2024...

[附截图]
```

**短期/长期存储**:
```
短期 situationMap (内存，Top-10 LRU):
  "React Tutorial - Chrome" → { situation: "...", timestamp, focusSec }
  "VSCode - project"        → { situation: "...", timestamp, focusSec }

长期 LongTermPool (持久化 JSON):
  当 focusSec ≥ 300s 时自动晋升
  跨会话复用，7天过期
```

**自适应频率**: 指数退避，从 15s 到 60s，避免频繁调用 VLM。

**焦点切换策略**: 当用户切换到一个低焦点时间的窗口时，保持显示上一个有效的情景描述，避免频繁切换导致的空白。

#### 4.2 Context Pool — 双层上下文池

**ShortTermPool** (会话级，纯内存):
```javascript
shortPool.set('memory.today', { "VSCode": 300, "Chrome": 120 })
shortPool.set('vlm.situation', "用户正在编写React组件")
shortPool.set('search.results', "React hooks best practices...")
```

**LongTermPool** (持久化，按窗口标题隔离):
```javascript
longPool.setForTitle("React Tutorial", "vlm", { situation, lastUpdated })
longPool.setForTitle("React Tutorial", "knowledge", { summary, updateCount })
longPool.setForTitle("React Tutorial", "search", { results, cachedAt })
longPool.setForTitle("React Tutorial", "memory", { totalSec, lastSeen, recentDays })
longPool.setForTitle("React Tutorial", "acquired", { summary, confidence })
```

**轻量级 RAG 检索** (Jaccard 相似度):
```javascript
// 查询: 当前标题 vs 所有存储标题的 token 集合
longPool.query("React hooks guide", {
  layer: 'knowledge', maxResults: 3, minConfidence: 0.3
})

// Token 丰富化: 标题分词 + VLM 关键词
// "React Tutorial - Chrome" → ["react", "tutorial"]
// + VLM summary → ["react", "tutorial", "hooks", "usestate", "组件"]
```

#### 4.3 Knowledge Acquisition — 自动知识获取

**三阶段管线**:
```
VLM 情景 ──▶ LLM 主题提取 ──▶ LLM 搜索词生成 ──▶ 分布式搜索 ──▶ 知识存储

示例:
VLM: "用户��看Elden Ring的Boss攻略视频"
  ↓
主题提取 Prompt:
  "从以下关键词中提取1-3个具体的命名实体"
  → ["Elden Ring"]
  ↓
搜索词生成 Prompt:
  "作为搜索工具，给我 Elden Ring 相关的知识搜索词。
   当前时间：2026-02-16T14:30。
   专注于内容本身。排除低置信度和低时效性内容。"
  → ["Elden Ring DLC", "Elden Ring boss guide", "Shadow of the Erdtree"]
  ↓
搜索队列 (持久化，跨会话):
  每次 tick 处理 2 个任务 → 结果存入 LongTermPool
```

**知识衰减**: 初始 confidence=0.8，每 7 天 -0.1，≤0.1 时删除。已验证主题冷却 ×24。

#### 4.4 Knowledge Store — 知识整理

```
Prompt: "你是一个知识整理者。用最多150字符总结上下文。格式：[主题] 关键事实。"
策略: 指数退避 (60s → 1h)，已有高置信度知识时跳过更新
```

#### 4.5 Memory Tracker — 活动记忆

纯内存记录 → 5 分钟批量刷入持久化，保留最近 7 天明细，30 天过期清理。

### 5. Emotion System — 情感系统

**文件**: `src/core/emotion-system.js` (398 行)

**情绪值累积**:
```
每秒: baseRate ≈ 1.67    鼠标悬停: +50%    AI响应: +5~30 随机
情绪值 ≥ 100 → 触发表情/动作
```

**AI 情感选择 Prompt**:
```
你是一个情绪分类器。根据角色最后说的话，从以下列表中选择最合适的一个情绪：
[happy(开心), sad(难过), angry(生气), surprised(惊讶), shy(害羞)]
只回复列表中的情绪名称，不要其他内容。
```

模糊匹配兜底 + TTS 对齐模式（表情时长 = 音频时长）。

### 6. Message Session — 消息同步播放

**文件**: `src/core/message-session.js` (133 行)

```
TTS 模式:
  Phase 1 (并行): TTS合成 + AI情感选择
  Phase 2 (同步): 气泡(audio+800ms) + 音频播放 + 对齐表情

非 TTS 模式:
  气泡(8s) + 默认音频(fire-and-forget) + 独立情感累积
```

### 7. Audio Pipeline — 语音合成管线

```
AI 响应 → LLM翻译(中→日) → VOICEVOX FFI → WAV → Web Audio

降级链: tts → default-audio → silent
断路器: 3次失败 → 降级，60s 后重试
```

**翻译 Prompt** (纯日语系统提示 + few-shot):
```
あなたは翻訳機です。入力文を自然な日本語の完全な文に翻訳してください。
英単語はカタカナに変換。翻訳結果の文だけを出力。出力にアルファベットを含めないこと。

Few-shot:
User: 嘻嘻……你在看YouTube上的ASMR吧，杂鱼哥哥真是变态呢~
AI:   うふふ……ユーチューブでエーエスエムアール見てるでしょ、雑魚お兄ちゃんって本当に変態だよね～
```

---

## Prompt 工程详解

### 设计原则

1. **分层优先级**: 响应模式 > 角色设定 > 规则 > 动态上下文 > 语言指令
2. **规则强化**: 规则后追加"重要提醒"，利用 recency bias 增强遵守率
3. **负面约束优先**: "不要长篇大论" 比 "简短回复" 更有效
4. **系统指令伪装**: 用 `(system: ...)` 格式包装 user 消息中的指令，模拟系统级指示
5. **单一职责 Prompt**: 每个 AI 调用点有独立的、极简的 prompt，避免多任务干扰

### 角色卡设计模式

```json
{
  "description": "身份定义 + 交互模式 + 特殊场景处理",
  "personality": "性格特征（简短关键词）",
  "scenario":   "存在意义 + 行为风格",
  "rules":      "硬性约束（编号列表，7条）"
}
```

**规则设计要点**:
- 规则 1: 长度控制（最核心，放第一条）
- 规则 2: 防幻觉（不编造截图中没有的内容）
- 规则 3: 防破角（不提及 AI/桌宠身份）
- 规则 4: 自然表达（禁止机械化描述）
- 规则 5: 单向对话（不提问等待回答）
- 规则 6: 降级策略（截图模糊时的行为）
- 规则 7: 自我认知（识别截图中的自己）

### 完整请求示例

```
System Prompt:
  【响应模式】不要过度思考过程，尽快给出最终回复。

  你是后辈，用户的后辈。你以桌面宠物的形式陪伴在用户身边...
  温柔清楚。有点怕生，说话语气��稳克制。毒舌...
  你的存在提供「陪伴感」和「节奏感」...

  ---
  【规则——必须严格遵守】
  1. 只回复1-2句话...
  2. 不要无中生有...
  ...
  【重要提醒】以上规则必须严格遵守，每次回复前请检查是否符合所有规则。

  ---
  [自我认知] 不要主动提及自己的外观或自己是Live2D角色
  [当前情绪状态] 情绪值: 72/100
  [最近窗口使用情况] VSCode: 180秒, Chrome: 45秒
  [桌面布局] VSCode [1920x1080]
  [你的位置] 屏幕坐标(1800,900)，大小200x300
  [屏幕内容 (8秒前)] 用户在VSCode中编写一个React登录表单组件，正在处理表单验证逻辑

  使用中文。

History:
  User: (用户正在使用 Chrome - React文档，附截图)
  Assistant: 哦，在看React文档啊。useState用多了记得用useReducer整理一下状态~
  User: (用户正在使用 VSCode，附截图)
  Assistant: 嗯……写得还挺认真的嘛，前辈。

Current:
  User: [14:35] （system：当前用户正在使用 VSCode，请自然地回应一句）（附上屏幕截图）
        [截图1] [截图2]
```

---

## 设计决策与权衡

| 决策 | 选择 | 理由 |
|------|------|------|
| VLM 作为压缩层 vs 直接传递上下文 | 压缩层 | 主 AI 的 token 预算有限，200字符的情景描述比原始数据更高效 |
| 双缓冲 vs 消息队列 | 双缓冲 | 桌宠场景下"最新消息"比"所有消息"更重要，避免消息堆积 |
| Jaccard RAG vs 向量检索 | Jaccard | 零依赖、纯前端实现，窗口标题的 token 集合足够做粗粒度匹配 |
| FFI 调用 VOICEVOX vs HTTP 服务 | FFI | 无需用户启动额外服务，便携式 exe 一键运行 |
| 翻译用独立 API 配置 | 独立 | 翻译需要低温度高准确性，与主对话的高温度需求冲突 |
| 情感选择用 AI vs 规则 | AI | 规则难以覆盖所有情景，AI 能理解语义选择更合适的表情 |
| 知识衰减 vs 永久存储 | 衰减 | 过时知识会误导 AI，定期衰减保持知识新鲜度 |
| fire-and-forget VLM/知识获取 | 异步 | 不阻塞主对话循环，下次 tick 时使用上次的结果 |

