# 如何提交代码到 GitHub

## 步骤 1: Fork 原仓库

1. 打开浏览器访问：https://github.com/x380kkm/Live2DPet
2. 点击右上角的 **Fork** 按钮
3. 选择你的账号，创建 Fork

## 步骤 2: 修改远程仓库地址

```bash
# 查看当前远程仓库
git remote -v

# 移除旧的 origin
git remote remove origin

# 添加你 Fork 后的仓库（替换 YOUR_USERNAME 为你的 GitHub 用户名）
git remote add origin https://github.com/YOUR_USERNAME/Live2DPet.git

# 验证
git remote -v
```

## 步骤 3: 推送代码

```bash
# 推送到你的 Fork
git push origin main
```

## 步骤 4: 创建 Pull Request

1. 访问你 Fork 的仓库：https://github.com/YOUR_USERNAME/Live2DPet
2. 点击 **Pull requests** 标签
3. 点击 **New pull request** 按钮
4. 确认 base repository 是 `x380kkm/Live2DPet`，base 分支是 `main`
5. 确认 head repository 是你的 Fork，compare 分支是 `main`
6. 点击 **Create pull request**
7. 填写 PR 标题和说明：

### PR 标题建议：
```
feat: Add Whisper local STT and long-term memory system
```

### PR 说明建议：
```markdown
## 新增功能 / New Features

### 🎤 Whisper 本地语音识别
- 使用 Whisper.cpp 实现高质量本地语音识别
- 支持 GPU 加速（CUDA/DirectML）
- 支持多种模型大小选择（tiny/base/small/medium/large）
- 完全离线运行，无需外部 API
- 麦克风设备选择
- 实时音量可视化
- 自动连续监听模式

### 🧠 长期记忆系统
- AI 会记住所有对话历史
- 自动提取关键词并建立索引
- 智能检索相关历史对话
- 完全本地存储（localStorage）
- 支持导出/导入 JSON
- 记忆管理 UI

### 🎨 其他改进
- 增强语音输入 UI
- 多语言支持（中文、英文、日文）
- 一键启动脚本（启动.bat）
- FFmpeg 集成用于音频转换
- 修复多个 JS 错误

## 技术细节 / Technical Details

- **Whisper.cpp**: AVX2 CPU 优化 + GPU 加速
- **FFmpeg**: WebM 到 WAV 音频转换
- **记忆系统**: 关键词提取 + TF-IDF 相似度搜索
- **存储**: localStorage（无需外部数据库）
- **依赖**: 已包含 FFmpeg 和 Whisper 相关文件

## 使用说明 / Usage

详细使用说明请查看 [FEATURES.md](./FEATURES.md)

## 测试 / Testing

- ✅ Whisper 语音识别正常工作
- ✅ 记忆系统正常保存和检索
- ✅ 多语言界面正常显示
- ✅ 一键启动脚本正常运行

## 截图 / Screenshots

（可以添加截图展示新功能）

## 注意事项 / Notes

- Whisper.cpp 目录已添加到 .gitignore（用户需要自行编译或下载）
- FFmpeg 已包含在 bin/ 目录
- 记忆系统完全本地，不依赖任何外部 API
```

8. 点击 **Create pull request** 完成

## 步骤 5: 等待审核

- 原作者会收到通知
- 可能会有代码审查和修改建议
- 修改后推送到同一分支会自动更新 PR

## 常见问题

### Q: 如何更新我的 Fork？
```bash
# 添加上游仓库
git remote add upstream https://github.com/x380kkm/Live2DPet.git

# 拉取上游更新
git fetch upstream

# 合并到本地
git merge upstream/main

# 推送到你的 Fork
git push origin main
```

### Q: 如何修改已提交的代码？
```bash
# 修改文件后
git add .
git commit -m "fix: 修复说明"
git push origin main
# PR 会自动更新
```

### Q: 如何撤销提交？
```bash
# 撤销最后一次提交（保留修改）
git reset --soft HEAD~1

# 撤销最后一次提交（丢弃修改）
git reset --hard HEAD~1
```

## 完成！

提交 PR 后，你的贡献就会被原作者看到。感谢你的贡献！🎉
