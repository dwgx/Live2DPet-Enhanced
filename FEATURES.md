# 新增功能 / New Features

## 🎤 Whisper 本地语音识别 / Local Speech Recognition

### 功能说明
- 使用 Whisper.cpp 实现高质量本地语音识别
- 支持 GPU 加速（CUDA/DirectML）
- 支持多种模型大小选择
- 完全离线运行，无需外部 API

### 使用方法

1. **安装 Whisper**
   - Whisper.cpp 已包含在项目中（`whisper.cpp/` 目录）
   - 模型文件会自动下载到 `whisper.cpp/models/`

2. **选择模型**
   - 在设置页面的"语音输入"部分
   - 选择"Whisper Local (GPU)"模式
   - 从下拉菜单选择模型：
     - **Tiny** (75MB) - 最快，准确率较低
     - **Base** (142MB) - 平衡
     - **Small** (466MB) - 推荐，准确率高
     - **Medium** (1.5GB) - 非常准确
     - **Large** (2.9GB) - 最佳质量

3. **开始使用**
   - 点击"开始监听"按钮
   - 说话后会自动识别并发送给 AI
   - 支持自动连续监听模式

### 模型下载

如果需要其他模型，运行：
```bash
cd whisper.cpp/models
bash download-ggml-model.sh medium  # 下载 medium 模型
bash download-ggml-model.sh large   # 下载 large 模型
```

### 技术细节
- 使用 FFmpeg 自动转换音频格式
- 支持中文、英文、日文等多种语言
- CPU 优化（AVX2）+ GPU 加速支持

---

## 🧠 长期记忆系统 / Long-term Memory System

### 功能说明
- AI 会记住你的所有对话
- 自动提取关键词并建立索引
- 智能检索相关历史对话
- 完全本地存储，无需外部 API

### 工作原理

1. **短期记忆**
   - 保留最近 8 条对话
   - 每次对话都会包含在上下文中

2. **长期记忆检索**
   - 根据当前对话内容自动搜索相关历史
   - 使用关键词匹配和 TF-IDF 算法
   - 最多检索 3 条最相关的历史对话

3. **本地存储**
   - 所有记忆保存在浏览器 localStorage
   - 重启应用后自动加载
   - 支持导出/导入 JSON 文件

### 使用方法

1. **启用记忆**
   - 在设置页面的"记忆设置"部分
   - 勾选"启用长期记忆"
   - 设置最大记忆数量（默认 2000 条）

2. **查看记忆**
   - 切换到"Memory"标签页
   - 查看统计信息和最近对话
   - 每条记忆显示关键词标签

3. **管理记忆**
   - **刷新** - 更新显示
   - **导出** - 保存为 JSON 文件
   - **导入** - 从 JSON 文件恢复
   - **清空** - 删除所有记忆

### 技术细节
- 关键词提取：自动过滤停用词
- 相似度计算：基于关键词重叠度
- 存储格式：JSON（包含时间戳、角色、内容、关键词）
- 性能优化：最多保存 2000 条记忆（可配置）

---

## 🎯 其他改进 / Other Improvements

### 语音输入增强
- 麦克风设备选择
- 实时音量可视化
- 自动连续监听模式
- 文本自动修复

### 用户体验
- 多语言支持（中文、英文、日文）
- 一键启动脚本（`启动.bat`）
- 自动检测依赖
- 友好的错误提示

---

## 📦 依赖说明 / Dependencies

### 必需
- Node.js 16+
- Electron

### 可选
- **Whisper.cpp** - 本地语音识别（已包含）
- **FFmpeg** - 音频格式转换（已包含在 `bin/` 目录）

### 不需要
- ❌ OpenAI API（记忆系统完全本地）
- ❌ 外部数据库
- ❌ 云服务

---

## 🚀 快速开始 / Quick Start

1. **安装依赖**
   ```bash
   npm install
   ```

2. **启动应用**
   ```bash
   npm start
   # 或双击 启动.bat
   ```

3. **配置 API**
   - 在设置页面填入 API Key
   - 推荐使用 OpenRouter 或其他兼容服务

4. **启用语音识别**
   - 选择 Whisper Local 模式
   - 选择合适的模型（推荐 Small）
   - 点击"开始监听"

5. **启用记忆系统**
   - 勾选"启用长期记忆"
   - 开始对话，AI 会自动记住

---

## 🔧 故障排除 / Troubleshooting

### Whisper 识别失败
- 检查 `whisper.cpp/whisper-cli.exe` 是否存在
- 检查模型文件是否下载完整
- 尝试使用更小的模型（base 或 tiny）

### 记忆系统不工作
- 检查浏览器是否支持 localStorage
- 查看浏览器控制台是否有错误
- 尝试清空记忆后重新开始

### 音频转换失败
- 检查 `bin/ffmpeg.exe` 是否存在
- 确保麦克风权限已授予

---

## 📝 更新日志 / Changelog

### v2.1.0 (2026-03-08)

**新增功能**
- ✨ Whisper 本地语音识别
- ✨ 长期记忆系统
- ✨ 模型大小选择
- ✨ 麦克风设备选择
- ✨ 音量可视化

**改进**
- 🎨 优化语音输入 UI
- 🐛 修复多个 JS 错误
- 📝 添加中文翻译
- 🚀 性能优化

**技术栈**
- Whisper.cpp (CPU + GPU)
- FFmpeg (音频转换)
- 关键词提取 + TF-IDF
- localStorage (本地存储)

---

## 📄 许可证 / License

MIT License - 开源免费

## 🙏 致谢 / Credits

- [Whisper.cpp](https://github.com/ggerganov/whisper.cpp) - 本地语音识别
- [FFmpeg](https://ffmpeg.org/) - 音频处理
- [Live2DPet](https://github.com/x380kkm/Live2DPet) - 原项目
