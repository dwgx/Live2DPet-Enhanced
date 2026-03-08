/**
 * Whisper STT IPC — High-quality local speech-to-text using whisper.cpp
 * Supports GPU acceleration (CUDA/DirectML) and low-latency streaming
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let whisperProcess = null;
let whisperReady = false;
let whisperModel = 'small';

function getWhisperExecutable() {
    // Check for whisper.cpp executable in project directory
    // Prioritize whisper-cli.exe over deprecated main.exe
    const possiblePaths = [
        path.join(__dirname, '../../whisper.cpp/whisper-cli.exe'),
        path.join(__dirname, '../../whisper.cpp/build/bin/Release/whisper-cli.exe'),
        path.join(__dirname, '../../bin/whisper-cli.exe'),
        path.join(__dirname, '../../whisper.cpp/main.exe'),
        path.join(__dirname, '../../whisper.cpp/build/bin/Release/main.exe'),
        path.join(__dirname, '../../bin/main.exe')
    ];

    console.log('[Whisper] Searching for executable...');
    for (const p of possiblePaths) {
        try {
            const resolved = path.resolve(p);
            if (fs.existsSync(resolved)) {
                console.log('[Whisper] Found:', resolved);
                return resolved;
            }
        } catch (e) {
            console.error('[Whisper] Error checking path:', e);
        }
    }

    console.log('[Whisper] Not found in any path');
    return null;
}

function getWhisperModel(modelSize = 'base') {
    const modelDir = path.join(__dirname, '../../models/whisper');
    const modelFile = `ggml-${modelSize}.bin`;
    const modelPath = path.join(modelDir, modelFile);

    if (fs.existsSync(modelPath)) return modelPath;

    // Try alternative locations
    const altPaths = [
        path.join(__dirname, '../../whisper.cpp/models', modelFile),
        path.join(os.homedir(), '.whisper', modelFile)
    ];

    for (const p of altPaths) {
        if (fs.existsSync(p)) return p;
    }

    return null;
}

async function transcribeWithWhisper(audioPath, options = {}) {
    const whisperExe = getWhisperExecutable();
    if (!whisperExe) {
        return { success: false, error: 'whisper_not_found' };
    }

    const modelPath = getWhisperModel(options.model || whisperModel);
    if (!modelPath) {
        return { success: false, error: 'whisper_model_not_found' };
    }

    const language = options.language || 'auto';
    const langCode = language === 'auto' ? 'auto' : language.split('-')[0];

    const args = [
        '-m', modelPath,
        '-f', audioPath,
        '-l', langCode,
        '-t', String(options.threads || Math.max(1, os.cpus().length - 1)),
        '--output-txt'
    ];

    console.log('[Whisper] Running:', whisperExe, args.join(' '));

    return new Promise((resolve) => {
        const proc = spawn(whisperExe, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: path.dirname(whisperExe)
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (d) => {
            const chunk = d.toString('utf8');
            stdout += chunk;
        });
        proc.stderr?.on('data', (d) => {
            const chunk = d.toString('utf8');
            stderr += chunk;
        });

        proc.on('error', (err) => {
            console.error('[Whisper] Process error:', err);
            resolve({ success: false, error: err.message || 'whisper_exec_failed' });
        });

        proc.on('close', (code) => {
            console.log('[Whisper] Exit code:', code);
            console.log('[Whisper] stdout:', stdout.substring(0, 200));
            console.log('[Whisper] stderr:', stderr.substring(0, 200));

            if (code === 0) {
                // Check for output txt file
                const txtFile = audioPath + '.txt';
                try {
                    if (fs.existsSync(txtFile)) {
                        const text = fs.readFileSync(txtFile, 'utf8').trim();
                        fs.unlinkSync(txtFile);
                        if (text) {
                            console.log('[Whisper] Transcribed:', text);
                            resolve({ success: true, text });
                            return;
                        }
                    }
                } catch (e) {
                    console.error('[Whisper] Failed to read output:', e);
                }

                // Fallback: parse stdout
                const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
                let text = lines.join(' ').trim();

                if (text) {
                    console.log('[Whisper] Transcribed from stdout:', text);
                    resolve({ success: true, text });
                } else {
                    console.error('[Whisper] No text output');
                    resolve({ success: false, error: 'no_speech', detail: stderr });
                }
            } else {
                console.error('[Whisper] Failed with code:', code);
                console.error('[Whisper] stderr:', stderr);
                resolve({ success: false, error: 'whisper_failed', detail: stderr });
            }
        });

        setTimeout(() => {
            try { proc.kill(); } catch (e) {}
            resolve({ success: false, error: 'timeout' });
        }, 30000);
    });
}

function registerWhisperSTTIPC(ctx, ipcMain) {
    ipcMain.handle('whisper-stt-transcribe', async (_, payload = {}) => {
        if (!payload.audioData) {
            return { success: false, error: 'no_audio_data' };
        }

        const tempDir = os.tmpdir();
        const ext = payload.mimeType?.includes('webm') ? '.webm' : '.wav';
        const tempFile = path.join(tempDir, `whisper-${Date.now()}${ext}`);
        const wavFile = tempFile.replace(/\.(webm|wav)$/, '.wav');

        try {
            const buffer = Buffer.from(payload.audioData, 'base64');
            fs.writeFileSync(tempFile, buffer);

            console.log('[Whisper] Transcribing:', tempFile, 'size:', buffer.length);

            // Convert to WAV if needed using ffmpeg
            if (ext === '.webm') {
                const { spawn } = require('child_process');
                const ffmpegPath = path.join(__dirname, '../../bin/ffmpeg.exe');
                await new Promise((resolve, reject) => {
                    const ffmpeg = spawn(ffmpegPath, [
                        '-i', tempFile,
                        '-ar', '16000',
                        '-ac', '1',
                        '-c:a', 'pcm_s16le',
                        wavFile
                    ], { windowsHide: true });

                    ffmpeg.on('close', (code) => {
                        if (code === 0) resolve();
                        else reject(new Error('ffmpeg failed'));
                    });

                    ffmpeg.on('error', reject);

                    setTimeout(() => {
                        ffmpeg.kill();
                        reject(new Error('ffmpeg timeout'));
                    }, 10000);
                });

                fs.unlinkSync(tempFile);
            }

            const result = await transcribeWithWhisper(wavFile, {
                language: payload.language || 'auto',
                model: payload.model || 'base',
                threads: payload.threads,
                useGpu: payload.useGpu !== false
            });

            console.log('[Whisper] Result:', result);

            // Cleanup
            try { fs.unlinkSync(wavFile); } catch (e) {}

            return result;
        } catch (e) {
            console.error('[Whisper] Error:', e);
            try { fs.unlinkSync(tempFile); } catch (err) {}
            try { fs.unlinkSync(wavFile); } catch (err) {}
            return { success: false, error: e.message || 'whisper_failed' };
        }
    });

    ipcMain.handle('whisper-stt-check', async () => {
        const whisperExe = getWhisperExecutable();
        const modelPath = getWhisperModel('base');

        console.log('[Whisper] Check - exe:', whisperExe, 'model:', modelPath);

        return {
            available: !!whisperExe && !!modelPath,
            executable: whisperExe,
            model: modelPath
        };
    });
}

module.exports = { registerWhisperSTTIPC };
