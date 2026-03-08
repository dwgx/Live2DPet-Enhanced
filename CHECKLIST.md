# 功能检查清单 / Feature Checklist

## ✅ 已实现的功能

### 🎤 Whisper 语音识别
- [x] Whisper.cpp 集成
- [x] 模型选择器（Settings 页面 → Voice Input 部分）
  - Tiny (75MB)
  - Base (142MB)
  - Small (466MB) ⭐ 推荐
  - Medium (1.5GB)
  - Large (2.9GB)
- [x] FFmpeg 音频转换
- [x] GPU 加速支持
- [x] 麦克风设备选择
- [x] 实时音量显示
- [x] 自动连续监听

### 🧠 记忆系统

#### 设置页面（Settings Tab）
- [x] **记忆设置卡片**（在 Voice Input 下方）
  - [x] 启用/禁用长期记忆
  - [x] 最大记忆数量（100-10000）
  - [x] 短期记忆大小（3-20条）
  - [x] 长期检索限制（0-10条）
  - [x] 自动保存开关
  - [x] 测试记忆按钮

#### Memory 标签页
- [x] **统计信息**
  - 总记忆数
  - 今天/本周记忆数
- [x] **最近记忆列表**
  - 显示最近20条
  - 显示时间戳
  - 显示角色（用户/AI）
  - 显示关键词标签
- [x] **管理按钮**
  - 刷新
  - 导出 JSON
  - 导入 JSON
  - 清空全部

### 🌐 多语言支持
- [x] 英文（English）
- [x] 中文（简体）
- [x] 日文（日本語）

### 📝 文档
- [x] FEATURES.md - 详细功能说明
- [x] CONTRIBUTING.md - GitHub 提交指南
- [x] WHISPER_SETUP.md - Whisper 安装说明

## 📍 UI 位置说明

### 在哪里找到记忆设置？

1. **打开应用**
2. **点击 Settings 标签**（第一个标签）
3. **向下滚动**，在 "Voice Input" 卡片下方
4. **找到 "Memory Settings" 卡片**

```
Settings Tab
├── API Configuration
├── Translation API
├── Voice Input
│   ├── Recognition Mode
│   ├── Whisper Model ← 这里选择 Whisper 模型
│   └── ...
├── Memory Settings ← 这里配置记忆系统
│   ├── ☑ Enable Long-term Memory
│   ├── Max Memories to Keep: [2000]
│   ├── Short-term Memory Size: [8]
│   ├── Long-term Retrieval Limit: [3]
│   ├── ☑ Auto-save to Browser Storage
│   └── [Save] [Test Memory]
└── ...
```

### 在哪里查看记忆？

1. **点击 Memory 标签**（最后一个标签）
2. **查看统计信息和最近记忆**

```
Memory Tab
├── Memory System
│   └── 说明文字
├── Statistics
│   ├── Total Memories: 42
│   └── Today / This Week: 5 / 12
├── Recent Memories
│   ├── 👤 2026-03-08 09:30 - 用户消息
│   ├── 🤖 2026-03-08 09:30 - AI 回复
│   └── ...
└── [Refresh] [Export] [Import] [Clear All]
```

## 🔧 配置文件位置

记忆系统配置保存在：
- **配置文件**: `config.json`
- **记忆数据**: 浏览器 localStorage（`pet-memories`）

示例配置：
```json
{
  "memory": {
    "enabled": true,
    "maxMemories": 2000,
    "shortTermLimit": 8,
    "longTermRetrievalLimit": 3,
    "autoSave": true,
    "includeRelevant": true
  }
}
```

## 🚀 快速测试

### 测试记忆系统

1. **启用记忆**
   - Settings → Memory Settings
   - 勾选 "Enable Long-term Memory"
   - 点击 Save

2. **开始对话**
   - 启动宠物
   - 使用语音或文字与 AI 对话

3. **查看记忆**
   - 切换到 Memory 标签
   - 点击 Refresh
   - 查看最近记忆列表

4. **测试检索**
   - 点击 "Test Memory" 按钮
   - 查看弹窗显示的统计信息

### 测试 Whisper

1. **选择模型**
   - Settings → Voice Input
   - Recognition Mode: Whisper Local (GPU)
   - Whisper Model: Small (推荐)

2. **开始识别**
   - 点击 "Start Listening"
   - 说话
   - 查看识别结果

## ⚠️ 常见问题

### Q: 为什么看不到 Memory Settings？
**A**: 需要重启应用才能看到新的 UI。关闭应用后重新运行 `npm start` 或 `启动.bat`

### Q: 记忆系统不工作？
**A**: 检查：
1. Settings → Memory Settings → 确认已勾选 "Enable Long-term Memory"
2. 点击 "Test Memory" 查看状态
3. 查看浏览器控制台是否有错误

### Q: Whisper 模型选择器在哪？
**A**: Settings → Voice Input → 选择 "Whisper Local (GPU)" 后会显示模型下拉菜单

### Q: 如何导出记忆？
**A**: Memory 标签 → 点击 "Export" → 保存 JSON 文件

## 📊 性能建议

### 记忆系统
- **轻量使用**: 最大记忆 500-1000，短期 5，长期 2
- **标准使用**: 最大记忆 2000，短期 8，长期 3 ⭐ 推荐
- **重度使用**: 最大记忆 5000+，短期 10，长期 5

### Whisper 模型
- **快速**: Tiny/Base（准确率较低）
- **平衡**: Small ⭐ 推荐
- **高质量**: Medium/Large（速度较慢）

## 🎯 下一步

1. **重启应用**查看新功能
2. **配置记忆系统**（Settings → Memory Settings）
3. **选择 Whisper 模型**（Settings → Voice Input）
4. **开始使用**并查看 Memory 标签

---

**提示**: 所有设置都会自动保存到 `config.json`，重启后保留。
