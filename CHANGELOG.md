# Changelog

## v1.10.0 — Visual Analysis & Smart Search

- VLM visual analysis refactor: independent capture system, multi-resolution buffering, situation history tracking
- Smart search optimization: auto query extraction, per-title cooldown & failure backoff, IDE window filtering
- Context quality improvements: expanded enhancement budgets, activity summary noise filtering, higher RAG confidence
- Debugging improvements: renderer log forwarding to main process, new debug launcher script
- Major test coverage expansion (IDE detection, search cooldown, situation history, and more)

<details>
<summary>中文</summary>

- VLM 视觉分析重构：独立截图系统、多分辨率缓冲、情景历史追踪
- 智能搜索优化：自动查询提取、逐标题冷却与失败退避、IDE 窗口自动过滤
- 上下文质量提升：增强预算扩大、活动摘要噪声过滤、RAG 置信度提高
- 调试改善：渲染进程日志转发至主进程、新增调试启动脚本
- 测试覆盖大幅扩展（新增 IDE 检测、搜索冷却、情景历史等测试套件）

</details>

<details>
<summary>日本語</summary>

- VLM 視覚分析リファクタリング：独立キャプチャシステム、マルチ解像度バッファ、状況履歴追跡
- スマート検索の最適化：自動クエリ抽出、タイトル別クールダウンと失敗バックオフ、IDE ウィンドウフィルタリング
- コンテキスト品質の向上：拡張バジェット拡大、アクティビティ要約のノイズフィルタリング、RAG 信頼度向上
- デバッグ改善：レンダラーログのメインプロセス転送、デバッグランチャースクリプト追加
- テストカバレッジの大幅拡張（IDE 検出、検索クールダウン、状況履歴などのテストスイート追加）

</details>

## v1.9.0 — Main Process Modular Refactor

- Split main.js (1665 lines) into 15 independent modules (`src/main/`) with clear responsibilities
- New AppContext shared state management with dependency injection pattern
- AES-256-GCM API key encryption at rest, backward compatible with plaintext
- Input validation module: UUID / URL / path traversal protection
- Unit tests: config-manager / crypto-utils / validators (42 tests)
- Settings page TTS save optimization: only sends tts config section, avoids model hot-reload
- Architecture diagram updated to reflect modular structure

<details>
<summary>中文</summary>

- 将 main.js（1665 行）拆分为 15 个独立模块（`src/main/`），职责清晰
- 新增 AppContext 共享状态管理，依赖注入模式
- 新增 AES-256-GCM API 密钥加密存储，向后兼容明文
- 新增输入验证模块：UUID / URL / 路径遍历防护
- 新增单元测试：config-manager / crypto-utils / validators（42 个测试）
- 设置页 TTS 保存优化：仅发送 tts 配置段，避免触发模型热重载
- 架构图更新，反映模块化结构

</details>

<details>
<summary>日本語</summary>

- main.js（1665行）を 15 個の独立モジュール（`src/main/`）に分割、責務を明確化
- 新しい AppContext 共有状態管理、依存性注入パターン
- AES-256-GCM による API キーの暗号化保存、平文との後方互換性あり
- 入力バリデーションモジュール：UUID / URL / パストラバーサル防御
- ユニットテスト追加：config-manager / crypto-utils / validators（42 テスト）
- 設定画面の TTS 保存を最適化：tts セクションのみ送信し、モデルのホットリロードを回避
- アーキテクチャ図をモジュール構造に更新

</details>

## v1.8.0 — Enhancement System

- New "Enhance" settings tab with modular context enhancement: activity memory, context search, knowledge organization, screen analysis, knowledge acquisition
- Context Pool architecture: layered storage (short-term / long-term) with Jaccard-similarity RAG retrieval
- Main process Web Search IPC: DuckDuckGo HTML scraping and custom API support (Bing / SearXNG, etc.)
- Adjustable response length multiplier (×0.5 / ×1 / ×1.5 / ×2)
- Auto-sanitization of context data to prevent API key leakage
- Emotion classifier prompt fully internationalized
- Screenshot resolution optimized (640→512) to reduce API costs

<details>
<summary>中文</summary>

- 新增「增强」设置标签页，模块化上下文增强：活动记忆、上下文搜索、知识整理、屏幕分析、知识获取
- 上下文池架构：分层存储（短期/长期），Jaccard 相似度 RAG 检索
- 主进程 Web 搜索 IPC：DuckDuckGo HTML 抓取和自定义 API
- 可调节回复长度倍率（×0.5 / ×1 / ×1.5 / ×2）
- 上下文数据自动脱敏，防止敏感信息泄露
- 情绪分类提示词完全国际化
- 截图分辨率优化（640→512），降低 API 开销

</details>

<details>
<summary>日本語</summary>

- 新しい「拡張」設定タブ、モジュール式コンテキスト強化：アクティビティ記憶、コンテキスト検索、知識整理、画面分析、知識獲得
- コンテキストプールアーキテクチャ：階層型ストレージ（短期/長期）、Jaccard 類似度ベースの軽量 RAG 検索
- メインプロセス Web 検索 IPC：DuckDuckGo HTML スクレイピングとカスタム API 対応
- 応答長さ倍率の調整（×0.5 / ×1 / ×1.5 / ×2）
- コンテキストデータの自動サニタイズで機密情報漏洩を防止
- 感情分類プロンプトの完全国際化
- スクリーンショット解像度の最適化（640→512）で API コストを削減

</details>

## v1.7.1 — Self-Awareness & Idle Detection

- Pet can locate itself in screenshots via screen position info
- Window title shortening for cleaner context
- System idle time detection (keyboard/mouse inactivity)
- Minimized window filtering

## v1.7.0 — Window Awareness & GPU TTS

- Window detection reads window titles (e.g. browser tab titles), tracked independently per title
- AI requests include desktop window layout info and window dimensions
- One-click setup downloads DirectML (GPU) ONNX Runtime for GPU-accelerated TTS

## v1.6.1 — Hot-Reload & Auto-Restart

- Model config changes hot-reload the pet window without restart
- VVM download auto-adds to config and restarts TTS
- Fixed TTS restart failure caused by duplicate koffi type registration
- Fixed app relaunch for portable exe builds

## v1.6.0 — System Tray Support

- System tray icon, app minimizes to tray area
- Settings window auto-hides to tray when pet starts
- Closing settings window hides to tray instead of quitting

## v1.5.0 — Multi-Language UI

- i18n support for settings UI (English / 中文 / 日本語)
- Character card import, built-in card auto-sync on version update
- Built-in card label in character list

## v1.4.0 — Translation & Chat

- Separate translation API config from main API
- Message double-buffer mechanism with configurable chat gap

## v1.3.0 — Documentation & UX

- Streamlined API configuration guide with model recommendations
- Detailed VOICEVOX voice setup workflow documentation
- Troubleshooting guide and known issues

## v1.2.0 — Image Model

- Image folder model: select an image folder, tag each image as idle/talking/emotion
- Supports PNG / JPG / WebP

## v1.1.0 — Fast Response

- Fast response mode, conversation history buffer, screenshot dedup, language-agnostic translation & emotion

## v1.0.0 — Initial Release

- Live2D desktop pet, AI visual awareness, VOICEVOX TTS, emotion/expression system
