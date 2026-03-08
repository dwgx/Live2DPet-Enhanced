# Whisper Local STT Setup Guide

## Quick Setup (Recommended)

### 1. Download whisper.cpp (Pre-built)

**Windows (GPU - CUDA):**
```bash
# Download from releases
https://github.com/ggerganov/whisper.cpp/releases

# Or build with CUDA support
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
mkdir build && cd build
cmake .. -DWHISPER_CUBLAS=ON
cmake --build . --config Release
```

**Windows (GPU - DirectML/Vulkan):**
```bash
# Build with Vulkan support (works on AMD/Intel/NVIDIA)
cmake .. -DWHISPER_VULKAN=ON
cmake --build . --config Release
```

### 2. Download Whisper Model

```bash
# Download base model (74MB, fast, good quality)
cd whisper.cpp
bash ./models/download-ggml-model.sh base

# Or download tiny model (39MB, fastest, lower quality)
bash ./models/download-ggml-model.sh tiny

# Or download small model (244MB, slower, better quality)
bash ./models/download-ggml-model.sh small
```

### 3. Place Files

```
Live2DPet/
├── whisper.cpp/
│   ├── main.exe (or main on Linux/Mac)
│   └── models/
│       └── ggml-base.bin
```

Or alternative structure:
```
Live2DPet/
├── bin/
│   └── whisper.exe
└── models/
    └── whisper/
        └── ggml-base.bin
```

### 4. Test Whisper

```bash
# Test whisper.cpp
cd whisper.cpp
./main -m models/ggml-base.bin -f samples/jfk.wav

# Should output transcribed text
```

## Model Comparison

| Model | Size | Speed | Quality | Recommended For |
|-------|------|-------|---------|-----------------|
| tiny  | 39MB | Fastest | Basic | Real-time, low-end GPU |
| base  | 74MB | Fast | Good | **Recommended for most users** |
| small | 244MB | Medium | Better | High accuracy needed |
| medium| 769MB | Slow | Best | Professional use |

## GPU Acceleration

### NVIDIA (CUDA)
- Requires CUDA Toolkit 11.8+
- 10-20x faster than CPU
- Recommended for RTX 20/30/40 series

### AMD/Intel (Vulkan)
- Works on most modern GPUs
- 5-10x faster than CPU
- Good compatibility

### CPU Only
- Works everywhere
- Slower but still usable
- Use `tiny` or `base` model

## Troubleshooting

### "Whisper not found"
- Make sure `main.exe` is in `whisper.cpp/` or `bin/` folder
- Check file permissions

### "Model not found"
- Download model using script above
- Place in `whisper.cpp/models/` or `models/whisper/`

### Slow transcription
- Use smaller model (tiny/base)
- Enable GPU acceleration
- Reduce recording length to 5-8 seconds

### Poor accuracy
- Use larger model (small/medium)
- Speak clearly and slowly
- Reduce background noise
- Select correct language (don't use "auto")

## Advanced Configuration

Edit `src/main/whisper-stt-ipc.js` to customize:

```javascript
// Change default model
whisperModel = 'small';  // tiny, base, small, medium

// Adjust threads (CPU mode)
'-t', '8',  // Use 8 CPU threads

// GPU layers (more = faster, needs more VRAM)
'-ngl', '999',  // Offload all layers to GPU
```

## Performance Tips

1. **Use GPU acceleration** - 10-20x faster
2. **Use base model** - Best balance of speed/quality
3. **Keep recordings short** - 5-8 seconds optimal
4. **Select language explicitly** - Faster than auto-detect
5. **Close other GPU apps** - Free up VRAM

## Links

- whisper.cpp: https://github.com/ggerganov/whisper.cpp
- CUDA Toolkit: https://developer.nvidia.com/cuda-downloads
- Vulkan SDK: https://vulkan.lunarg.com/
