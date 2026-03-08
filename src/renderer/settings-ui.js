/**
 * Settings UI Controller
 * Handles all tab interactions, model import, expression management, etc.
 */
let petSystem = null;
let currentModelConfig = {};
let suggestedMapping = null;
let scannedParamIds = [];
let scannedMotions = {};  // {group: [{file}]} from scan-model-info
let voiceRecognition = null;
let voiceListening = false;
let voiceSessionAutoSent = false;
let voiceRecorder = null;
let voiceRecorderStream = null;
let voiceRecordChunks = [];
let voiceRecordTimer = null;
let voiceTranscribing = false;
let voiceAutoLoopEnabled = false;
let voiceStopRequested = false;
let voiceAutoLoopTimer = null;
let voiceSendQueue = [];
let voiceSending = false;
let voiceAudioContext = null;
let voiceAnalyser = null;
let voiceVolumeMonitor = null;
let voiceSelectedDeviceId = null;
let voiceAvailableDevices = [];

// ========== i18n System ==========
let currentLang = 'en';

function t(key) {
    return (window.I18N && window.I18N[currentLang] && window.I18N[currentLang][key])
        || (window.I18N && window.I18N['en'] && window.I18N['en'][key])
        || key;
}

function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => {
        el.placeholder = t(el.dataset.i18nPh);
    });
}

function setLanguage(lang) {
    currentLang = lang;
    document.getElementById('lang-select').value = lang;
    applyI18n();
    updateVoiceButtons();
    if (window.electronAPI) window.electronAPI.saveConfig({ uiLanguage: lang });
    // Reload character card in new language (for built-in i18n cards)
    if (currentCharacterId) {
        loadCharacterPrompt(currentCharacterId);
        // Also refresh the character list labels (builtin tag is localized)
        loadCharacterList();
    }
    reloadPetPrompt();
}

document.getElementById('lang-select').addEventListener('change', (e) => {
    setLanguage(e.target.value);
});

document.addEventListener('DOMContentLoaded', async () => {
    petSystem = new DesktopPetSystem();
    await petSystem.init();
    let fileConfig = {};

    // Wire emotion system callbacks to IPC
    petSystem.emotionSystem.onEmotionTriggered = (emotionName) => {
        console.log(`[SettingsUI] onEmotionTriggered → IPC triggerExpression("${emotionName}")`);
        if (window.electronAPI) window.electronAPI.triggerExpression(emotionName);
    };
    petSystem.emotionSystem.onEmotionReverted = () => {
        console.log('[SettingsUI] onEmotionReverted → IPC revertExpression');
        if (window.electronAPI) window.electronAPI.revertExpression();
    };
    petSystem.emotionSystem.onMotionTriggered = (group, index, emotionName) => {
        console.log(`[SettingsUI] onMotionTriggered → IPC triggerMotion("${group}", ${index}, "${emotionName}")`);
        if (window.electronAPI) window.electronAPI.triggerMotion(group, index);
    };

    // Load saved config
    const config = petSystem.aiClient.getConfig();
    document.getElementById('api-url').value = config.baseURL || '';
    document.getElementById('api-key').value = config.apiKey || '';
    document.getElementById('model-name').value = config.modelName || '';

    // Load full config
    if (window.electronAPI && window.electronAPI.loadConfig) {
        fileConfig = await window.electronAPI.loadConfig();
        // Load UI language
        if (fileConfig.uiLanguage && window.I18N && window.I18N[fileConfig.uiLanguage]) {
            currentLang = fileConfig.uiLanguage;
            document.getElementById('lang-select').value = currentLang;
        }
        applyI18n();
        if (fileConfig.interval) {
            document.getElementById('interval').value = fileConfig.interval;
            petSystem.setInterval(parseInt(fileConfig.interval) * 1000);
        }
        if (fileConfig.chatGap != null) {
            document.getElementById('chat-gap').value = fileConfig.chatGap;
            petSystem.chatGapMs = parseInt(fileConfig.chatGap) * 1000;
        }
        // Load translation API config
        if (fileConfig.translation) {
            document.getElementById('tl-api-url').value = fileConfig.translation.baseURL || '';
            document.getElementById('tl-api-key').value = fileConfig.translation.apiKey || '';
            document.getElementById('tl-model-name').value = fileConfig.translation.modelName || '';
        }
        // Load model config
        currentModelConfig = fileConfig.model || { type: 'none' };
        loadModelUI();
        loadEmotionUI(fileConfig);
        // Load max_tokens multiplier
        loadTokenMultiplierUI(fileConfig.maxTokensMultiplier || 1.0);
        // Load enhance config
        loadEnhanceToggle(fileConfig.enhance || {});
        // Reload prompt with correct language (after language is set)
        await reloadPetPrompt();
    }
    initVoiceInput(fileConfig);
});

// ========== Tab Switching ==========
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'prompt') loadCharacterList();
    });
});

// ========== Status Helper ==========
function showStatus(id, msg, type) {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.className = 'status ' + type;
    if (type !== 'info') setTimeout(() => { el.className = 'status'; }, 5000);
}

// ========== API Settings ==========
document.getElementById('btn-save-api').addEventListener('click', () => {
    const cfg = {
        baseURL: document.getElementById('api-url').value.trim(),
        apiKey: document.getElementById('api-key').value.trim(),
        modelName: document.getElementById('model-name').value.trim()
    };
    petSystem.aiClient.saveConfig(cfg);
    petSystem.systemPrompt = petSystem.promptBuilder.buildSystemPrompt();
    showStatus('api-status', t('status.saved'), 'success');
});

// ========== Translation API Settings ==========
document.getElementById('btn-save-tl').addEventListener('click', () => {
    const tl = {
        baseURL: document.getElementById('tl-api-url').value.trim(),
        apiKey: document.getElementById('tl-api-key').value.trim(),
        modelName: document.getElementById('tl-model-name').value.trim()
    };
    if (window.electronAPI) window.electronAPI.saveConfig({ translation: tl });
    showStatus('tl-status', t('status.saved'), 'success');
});

document.getElementById('btn-test-api').addEventListener('click', async () => {
    showStatus('api-status', t('status.testing'), 'info');
    const result = await petSystem.aiClient.testConnection();
    if (result.success) {
        showStatus('api-status', t('status.connected') + result.response, 'success');
    } else {
        showStatus('api-status', t('status.failed') + result.error, 'error');
    }
});

document.getElementById('btn-save-interval').addEventListener('click', () => {
    const seconds = parseInt(document.getElementById('interval').value);
    const chatGap = parseInt(document.getElementById('chat-gap').value);
    if (window.electronAPI) window.electronAPI.saveConfig({ interval: seconds, chatGap });
    petSystem.setInterval(seconds * 1000);
    petSystem.chatGapMs = chatGap * 1000;
});

// ========== Start/Stop ==========
document.getElementById('btn-start').addEventListener('click', () => petSystem.start());
document.getElementById('btn-stop').addEventListener('click', () => petSystem.stop());
document.getElementById('link-github').addEventListener('click', async (e) => {
    e.preventDefault();
    const url = 'https://github.com/x380kkm/Live2DPet';
    try {
        if (window.electronAPI?.openExternal) {
            const result = await window.electronAPI.openExternal(url);
            if (result?.success === false) throw new Error(result.error || 'open_external_failed');
            return;
        }
    } catch (err) {
        console.warn('[SettingsUI] openExternal failed, fallback to window.open:', err);
    }
    window.open(url, '_blank', 'noopener,noreferrer');
});

if (window.electronAPI) {
    window.electronAPI.onPetWindowClosed(() => {
        petSystem.isActive = false;
        petSystem.stopDetection();
    });
}

// ========== Voice Input ==========
function getVoiceMode() {
    return document.getElementById('voice-mode')?.value || 'webspeech';
}

function getDefaultVoiceLang() {
    if (currentLang === 'zh') return 'zh-CN';
    if (currentLang === 'ja') return 'ja-JP';
    return 'en-US';
}

function clearVoiceRecordTimer() {
    if (voiceRecordTimer) {
        clearTimeout(voiceRecordTimer);
        voiceRecordTimer = null;
    }
}

function clearVoiceAutoLoopTimer() {
    if (voiceAutoLoopTimer) {
        clearTimeout(voiceAutoLoopTimer);
        voiceAutoLoopTimer = null;
    }
}

function shouldEnableAutoLoop() {
    return !!document.getElementById('voice-auto-mode')?.checked;
}

function shouldEnableTextRepair() {
    const el = document.getElementById('voice-text-repair');
    return !el || el.checked;
}

function shouldContinueVoiceAutoLoop() {
    return voiceAutoLoopEnabled && !voiceStopRequested;
}

function stopVoiceAutoLoop() {
    voiceStopRequested = true;
    voiceAutoLoopEnabled = false;
    clearVoiceAutoLoopTimer();
    updateVoiceButtons();
}

function scheduleNextVoiceSession(delayMs = 240) {
    clearVoiceAutoLoopTimer();
    if (!shouldContinueVoiceAutoLoop()) {
        updateVoiceButtons();
        return;
    }

    voiceAutoLoopTimer = setTimeout(() => {
        voiceAutoLoopTimer = null;
        if (!shouldContinueVoiceAutoLoop()) {
            updateVoiceButtons();
            return;
        }
        if (voiceListening || voiceTranscribing) return;
        startVoiceSessionByCurrentMode({ clearTranscript: true });
    }, Math.max(0, delayMs));
    updateVoiceButtons();
}

function stopVoiceRecorderTracks() {
    if (!voiceRecorderStream) return;
    try {
        for (const track of voiceRecorderStream.getTracks()) track.stop();
    } catch (e) {}
    voiceRecorderStream = null;
}

function stopVoiceVolumeMonitor() {
    if (voiceVolumeMonitor) {
        cancelAnimationFrame(voiceVolumeMonitor);
        voiceVolumeMonitor = null;
    }
    const meterEl = document.getElementById('voice-volume-meter');
    const barEl = document.getElementById('voice-volume-bar');
    const textEl = document.getElementById('voice-volume-text');
    if (meterEl) meterEl.style.display = 'none';
    if (barEl) barEl.style.width = '0%';
    if (textEl) textEl.textContent = '0%';
}

function startVoiceVolumeMonitor(stream) {
    stopVoiceVolumeMonitor();
    const meterEl = document.getElementById('voice-volume-meter');
    const barEl = document.getElementById('voice-volume-bar');
    const textEl = document.getElementById('voice-volume-text');
    if (!meterEl || !barEl || !textEl) {
        console.warn('Volume meter elements not found');
        return;
    }

    try {
        if (!voiceAudioContext) voiceAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (voiceAudioContext.state === 'suspended') voiceAudioContext.resume();

        if (!voiceAnalyser) {
            voiceAnalyser = voiceAudioContext.createAnalyser();
            voiceAnalyser.fftSize = 256;
            voiceAnalyser.smoothingTimeConstant = 0.8;
        }

        const source = voiceAudioContext.createMediaStreamSource(stream);
        source.connect(voiceAnalyser);

        const dataArray = new Uint8Array(voiceAnalyser.frequencyBinCount);
        meterEl.style.display = 'block';

        function updateVolume() {
            if (!voiceVolumeMonitor) return;
            voiceAnalyser.getByteFrequencyData(dataArray);
            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
            const percent = Math.min(100, Math.round((avg / 128) * 100));
            barEl.style.width = percent + '%';
            textEl.textContent = percent + '%';
            voiceVolumeMonitor = requestAnimationFrame(updateVolume);
        }
        voiceVolumeMonitor = true;
        updateVolume();
    } catch (e) {
        console.error('Volume monitor failed:', e);
        meterEl.style.display = 'none';
    }
}

async function loadVoiceDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        voiceAvailableDevices = devices.filter(d => d.kind === 'audioinput');
        const deviceSelect = document.getElementById('voice-device');
        if (!deviceSelect) return;

        deviceSelect.innerHTML = '<option value="">Default Device</option>';
        voiceAvailableDevices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Microphone ${d.deviceId.slice(0, 8)}`;
            deviceSelect.appendChild(opt);
        });

        if (voiceSelectedDeviceId && voiceAvailableDevices.some(d => d.deviceId === voiceSelectedDeviceId)) {
            deviceSelect.value = voiceSelectedDeviceId;
        }
    } catch (e) {
        console.warn('Failed to load voice devices:', e);
    }
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
}

function updateVoiceButtons() {
    const modeSelect = document.getElementById('voice-mode');
    const sttConfig = document.getElementById('voice-stt-config');
    const listenBtn = document.getElementById('btn-voice-listen');
    const stopBtn = document.getElementById('btn-voice-stop');
    if (!modeSelect || !listenBtn || !stopBtn) return;

    const mode = modeSelect.value;
    const busy = voiceListening || voiceTranscribing || voiceAutoLoopEnabled;

    listenBtn.textContent = busy
        ? (voiceAutoLoopEnabled ? t('voice.listeningAuto') : t('voice.listening'))
        : t('voice.listen');
    listenBtn.disabled = busy;
    stopBtn.disabled = !(voiceListening || voiceTranscribing || voiceAutoLoopEnabled);
    if (sttConfig) sttConfig.style.display = mode === 'api-stt' ? '' : 'none';
}

function mapVoiceSendError(error) {
    if (error === 'api_not_configured') return t('voice.err.api');
    if (error === 'pet_not_started') return t('voice.err.pet');
    if (error === 'busy') return t('voice.err.busy');
    if (error === 'empty') return t('voice.err.empty');
    return t('status.failed') + error;
}

function mapSTTError(error) {
    if (error === 'busy') return t('voice.err.busy');
    if (error === 'api_not_configured') return t('voice.err.sttApi');
    if (error === 'empty_audio' || error === 'empty_transcript') return t('voice.err.noSpeech');
    if (error === 'stt_model_not_found') return t('voice.err.sttModel');
    if (error === 'local_stt_unavailable') return t('voice.err.localUnavailable');
    if (error === 'language_not_installed') return t('voice.err.localLangMissing');
    if (error === 'device_unavailable') return t('voice.err.localDevice');
    if (error === 'no_speech') return t('voice.err.noSpeech');
    if (String(error).includes('401') || String(error).includes('403')) return t('voice.err.sttAuth');
    if (String(error).includes('404')) return t('voice.err.sttEndpoint');
    if (/language|unsupported language|invalid language/i.test(String(error))) return t('voice.err.sttLanguage');
    return t('voice.err.sttFailed') + error;
}

function repairVoiceText(rawText, language) {
    let text = String(rawText || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!text) return '';

    text = text.replace(/\s+/g, ' ');
    text = text.replace(/([,，。.!！？?、])\1+/g, '$1');
    text = text.replace(/\b([A-Za-z]{2,})\s+\1\b/gi, '$1');
    text = text.replace(/([\u3040-\u30ff\u3400-\u9fff])\1{2,}/g, '$1$1');

    let prev = '';
    while (prev !== text) {
        prev = text;
        text = text.replace(/([\u3040-\u30ff\u3400-\u9fff])\s+([\u3040-\u30ff\u3400-\u9fff])/g, '$1$2');
    }

    if (String(language || '').toLowerCase().startsWith('en')) {
        text = text.replace(/\s+([,.!?;:])/g, '$1');
    }
    return text.trim();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendVoiceTextDirect(text) {
    showStatus('voice-status', t('voice.sending'), 'info');

    let result = null;
    try {
        for (let attempt = 0; attempt < 6; attempt++) {
            result = await petSystem.sendUserMessage(text);
            if (result.success) break;
            if (result.error !== 'busy') break;
            await sleep(1000);
        }
    } catch (e) {
        result = { success: false, error: e?.message || String(e) };
    }

    if (result?.success) {
        showStatus('voice-status', t('voice.sent'), 'success');
    } else {
        showStatus('voice-status', mapVoiceSendError(result?.error || 'unknown'), 'error');
    }
    return result || { success: false, error: 'unknown' };
}

async function flushVoiceSendQueue() {
    if (voiceSending) return;
    voiceSending = true;
    try {
        while (voiceSendQueue.length > 0) {
            const item = voiceSendQueue.shift();
            const result = await sendVoiceTextDirect(item.text);
            item.resolve(result);
        }
    } finally {
        voiceSending = false;
    }
}

function enqueueVoiceSend(text) {
    return new Promise((resolve) => {
        voiceSendQueue.push({ text, resolve });
        flushVoiceSendQueue();
    });
}

async function sendVoiceTextToAI(textOverride = null, options = {}) {
    const transcriptEl = document.getElementById('voice-transcript');
    const langSelect = document.getElementById('voice-lang');
    const rawText = textOverride == null ? transcriptEl.value : String(textOverride);
    let text = rawText.trim();

    if (shouldEnableTextRepair() && options.skipRepair !== true) {
        text = repairVoiceText(text, langSelect?.value || getDefaultVoiceLang());
        if (transcriptEl) transcriptEl.value = text;
    }

    if (!text) {
        if (!options.silentEmpty) showStatus('voice-status', t('voice.err.empty'), 'error');
        return { success: false, error: 'empty' };
    }

    return enqueueVoiceSend(text);
}

async function transcribeRecordedAudio(blob, language) {
    if (!window.electronAPI?.sttTranscribe) {
        showStatus('voice-status', t('voice.err.sttUnavailable'), 'error');
        return { success: false, error: 'stt_unavailable' };
    }
    if (!blob || blob.size === 0) {
        showStatus('voice-status', t('voice.err.noSpeech'), 'error');
        return { success: false, error: 'empty_audio' };
    }

    voiceTranscribing = true;
    updateVoiceButtons();
    showStatus('voice-status', t('voice.transcribing'), 'info');

    try {
        const buffer = await blob.arrayBuffer();
        const audioBase64 = arrayBufferToBase64(buffer);
        const result = await window.electronAPI.sttTranscribe({
            audioBase64,
            mimeType: blob.type || 'audio/webm',
            language
        });

        if (!result?.success || !result.text) {
            if (result?.error === 'stt_model_not_found') {
                const modeSelect = document.getElementById('voice-mode');
                if (modeSelect && modeSelect.value === 'api-stt') {
                    const fallbackMode = window.electronAPI?.localSttTranscribe ? 'local-stt' : 'webspeech';
                    modeSelect.value = fallbackMode;
                    if (window.electronAPI) window.electronAPI.saveConfig({ voiceInput: { mode: fallbackMode } });
                    updateVoiceButtons();
                    showStatus('voice-status', fallbackMode === 'local-stt' ? t('voice.err.sttModelSwitchLocal') : t('voice.err.sttModelSwitch'), 'error');
                    return { success: false, error: 'stt_model_not_found' };
                }
            }
            showStatus('voice-status', mapSTTError(result?.error || 'unknown'), 'error');
            return { success: false, error: result?.error || 'unknown' };
        }

        const transcriptEl = document.getElementById('voice-transcript');
        if (transcriptEl) transcriptEl.value = result.text.trim();
        return await sendVoiceTextToAI(result.text, { fromRecognition: true });
    } catch (e) {
        const err = e.message || String(e);
        showStatus('voice-status', mapSTTError(err), 'error');
        return { success: false, error: err };
    } finally {
        voiceTranscribing = false;
        updateVoiceButtons();
    }
}

async function startAPISTTRecording(language) {
    if (voiceListening || voiceTranscribing) return false;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        showStatus('voice-status', t('voice.err.recorderUnavailable'), 'error');
        stopVoiceAutoLoop();
        return false;
    }

    try {
        const constraints = { audio: voiceSelectedDeviceId ? { deviceId: { exact: voiceSelectedDeviceId } } : true };
        voiceRecorderStream = await navigator.mediaDevices.getUserMedia(constraints);
        startVoiceVolumeMonitor(voiceRecorderStream);
        const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
        const supportedMime = mimeCandidates.find(m => MediaRecorder.isTypeSupported?.(m));
        voiceRecorder = supportedMime
            ? new MediaRecorder(voiceRecorderStream, { mimeType: supportedMime })
            : new MediaRecorder(voiceRecorderStream);

        voiceRecordChunks = [];
        voiceSessionAutoSent = false;

        voiceRecorder.onstart = () => {
            voiceListening = true;
            updateVoiceButtons();
            showStatus('voice-status', t('voice.recordingHint'), 'info');
        };

        voiceRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) voiceRecordChunks.push(event.data);
        };

        voiceRecorder.onerror = (event) => {
            voiceListening = false;
            clearVoiceRecordTimer();
            stopVoiceRecorderTracks();
            updateVoiceButtons();
            showStatus('voice-status', t('status.failed') + (event?.error?.name || 'recorder'), 'error');
        };

        voiceRecorder.onstop = async () => {
            voiceListening = false;
            clearVoiceRecordTimer();
            stopVoiceRecorderTracks();
            updateVoiceButtons();

            const mimeType = voiceRecorder?.mimeType || 'audio/webm';
            const blob = new Blob(voiceRecordChunks, { type: mimeType });
            voiceRecordChunks = [];
            voiceRecorder = null;

            const result = await transcribeRecordedAudio(blob, language);
            if (shouldContinueVoiceAutoLoop()) {
                const errText = String(result?.error || '');
                const hardStopErrors = new Set(['api_not_configured', 'stt_unavailable']);
                const shouldHardStop = hardStopErrors.has(errText)
                    || /(^|[^\d])(401|403|404)([^\d]|$)/.test(errText);
                if (shouldHardStop) {
                    stopVoiceAutoLoop();
                } else {
                    scheduleNextVoiceSession();
                }
            }
        };

        voiceRecorder.start(200);
        clearVoiceRecordTimer();
        voiceRecordTimer = setTimeout(() => {
            if (voiceRecorder && voiceRecorder.state === 'recording') voiceRecorder.stop();
        }, 14000);
        return true;
    } catch (e) {
        stopVoiceRecorderTracks();
        voiceRecorder = null;
        voiceListening = false;
        updateVoiceButtons();
        showStatus('voice-status', t('voice.err.permission'), 'error');
        stopVoiceAutoLoop();
        return false;
    }
}

function stopAPISTTRecording() {
    if (voiceRecorder && voiceRecorder.state === 'recording') {
        voiceRecorder.stop();
        showStatus('voice-status', t('voice.stopped'), 'info');
    }
    stopVoiceVolumeMonitor();
}

async function startWhisperSTTRecording(language) {
    if (voiceListening || voiceTranscribing) return false;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        showStatus('voice-status', t('voice.err.recorderUnavailable'), 'error');
        stopVoiceAutoLoop();
        return false;
    }

    // Check if Whisper is available
    if (window.electronAPI?.whisperSttCheck) {
        const check = await window.electronAPI.whisperSttCheck();
        if (!check?.available) {
            showStatus('voice-status', 'Whisper not found. Please install whisper.cpp', 'error');
            stopVoiceAutoLoop();
            return false;
        }
    }

    try {
        const constraints = { audio: voiceSelectedDeviceId ? { deviceId: { exact: voiceSelectedDeviceId } } : true };
        voiceRecorderStream = await navigator.mediaDevices.getUserMedia(constraints);
        startVoiceVolumeMonitor(voiceRecorderStream);

        const mimeCandidates = ['audio/wav', 'audio/webm;codecs=opus', 'audio/webm'];
        const supportedMime = mimeCandidates.find(m => MediaRecorder.isTypeSupported?.(m));
        voiceRecorder = supportedMime
            ? new MediaRecorder(voiceRecorderStream, { mimeType: supportedMime })
            : new MediaRecorder(voiceRecorderStream);

        voiceRecordChunks = [];
        voiceSessionAutoSent = false;

        voiceRecorder.onstart = () => {
            voiceListening = true;
            updateVoiceButtons();
            showStatus('voice-status', 'Recording for Whisper...', 'info');
        };

        voiceRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) voiceRecordChunks.push(event.data);
        };

        voiceRecorder.onerror = (event) => {
            voiceListening = false;
            clearVoiceRecordTimer();
            stopVoiceRecorderTracks();
            updateVoiceButtons();
            showStatus('voice-status', t('status.failed') + (event?.error?.name || 'recorder'), 'error');
        };

        voiceRecorder.onstop = async () => {
            voiceListening = false;
            clearVoiceRecordTimer();
            stopVoiceRecorderTracks();
            updateVoiceButtons();

            const mimeType = voiceRecorder?.mimeType || 'audio/webm';
            const blob = new Blob(voiceRecordChunks, { type: mimeType });
            voiceRecordChunks = [];
            voiceRecorder = null;

            const result = await transcribeWithWhisper(blob, language);
            if (shouldContinueVoiceAutoLoop()) {
                const hardStopErrors = new Set(['whisper_not_found', 'whisper_model_not_found', 'permission_denied']);
                if (hardStopErrors.has(result?.error)) {
                    stopVoiceAutoLoop();
                } else {
                    scheduleNextVoiceSession();
                }
            }
        };

        voiceRecorder.start();
        voiceRecordTimer = setTimeout(() => {
            if (voiceRecorder && voiceRecorder.state === 'recording') voiceRecorder.stop();
        }, 8000);
        return true;
    } catch (e) {
        voiceListening = false;
        clearVoiceRecordTimer();
        stopVoiceRecorderTracks();
        updateVoiceButtons();
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
            showStatus('voice-status', t('voice.err.permission'), 'error');
        } else {
            showStatus('voice-status', t('status.failed') + (e.message || 'recorder'), 'error');
        }
        stopVoiceAutoLoop();
        return false;
    }
}

async function transcribeWithWhisper(blob, language) {
    if (!window.electronAPI?.whisperSttTranscribe) {
        showStatus('voice-status', 'Whisper API not available', 'error');
        return { success: false, error: 'whisper_unavailable' };
    }

    voiceTranscribing = true;
    updateVoiceButtons();
    showStatus('voice-status', 'Transcribing with Whisper...', 'info');

    try {
        const arrayBuffer = await blob.arrayBuffer();
        const base64Audio = arrayBufferToBase64(arrayBuffer);

        const result = await window.electronAPI.whisperSttTranscribe({
            audioData: base64Audio,
            language: language || 'auto',
            model: document.getElementById('whisper-model')?.value || 'small',
            mimeType: blob.type,
            useGpu: true
        });

        if (!result?.success || !result.text) {
            showStatus('voice-status', 'Whisper failed: ' + (result?.error || 'unknown'), 'error');
            return { success: false, error: result?.error || 'whisper_failed' };
        }

        const transcriptEl = document.getElementById('voice-transcript');
        if (transcriptEl) transcriptEl.value = result.text.trim();
        return await sendVoiceTextToAI(result.text, { fromRecognition: true });
    } catch (e) {
        const err = e.message || String(e);
        showStatus('voice-status', 'Whisper error: ' + err, 'error');
        return { success: false, error: err };
    } finally {
        voiceTranscribing = false;
        updateVoiceButtons();
    }
}

async function startLocalSTTRecognition(language) {
    if (voiceListening || voiceTranscribing) return false;
    if (!window.electronAPI?.localSttTranscribe) {
        showStatus('voice-status', t('voice.err.localUnavailable'), 'error');
        stopVoiceAutoLoop();
        return false;
    }

    voiceListening = true;
    updateVoiceButtons();
    showStatus('voice-status', t('voice.localListeningHint'), 'info');
    let fatalError = false;

    try {
        const result = await window.electronAPI.localSttTranscribe({
            language,
            timeoutSec: 18
        });

        if (!result?.success || !result.text) {
            if (result?.error === 'aborted') {
                showStatus('voice-status', t('voice.stopped'), 'info');
                return true;
            }
            showStatus('voice-status', mapSTTError(result?.error || 'local_stt_failed'), 'error');
            fatalError = ['local_stt_unavailable', 'language_not_installed', 'device_unavailable'].includes(result?.error);
            return false;
        }

        const transcriptEl = document.getElementById('voice-transcript');
        transcriptEl.value = result.text.trim();
        await sendVoiceTextToAI(result.text, { fromRecognition: true });
        return true;
    } catch (e) {
        const err = e.message || String(e);
        showStatus('voice-status', mapSTTError(err), 'error');
        fatalError = true;
        return false;
    } finally {
        voiceListening = false;
        updateVoiceButtons();
        if (shouldContinueVoiceAutoLoop()) {
            if (fatalError) stopVoiceAutoLoop();
            else scheduleNextVoiceSession();
        }
    }
}

async function stopLocalSTTRecognition() {
    if (!window.electronAPI?.localSttStop) return;
    try { await window.electronAPI.localSttStop(); } catch (e) {}
}

async function startVoiceSessionByCurrentMode({ clearTranscript = true } = {}) {
    const transcriptEl = document.getElementById('voice-transcript');
    const langSelect = document.getElementById('voice-lang');

    if (clearTranscript && transcriptEl) transcriptEl.value = '';

    const mode = getVoiceMode();
    const language = langSelect?.value || getDefaultVoiceLang();

    if (mode === 'api-stt') return startAPISTTRecording(language);
    if (mode === 'whisper-stt') return startWhisperSTTRecording(language);
    if (mode === 'local-stt') return startLocalSTTRecognition(language);

    if (!voiceRecognition || voiceListening) {
        showStatus('voice-status', t('voice.unsupported'), 'error');
        stopVoiceAutoLoop();
        return false;
    }

    voiceRecognition.lang = language;
    try {
        voiceRecognition.start();

        // Start volume monitor for WebSpeech API
        if (navigator.mediaDevices?.getUserMedia) {
            try {
                const constraints = { audio: voiceSelectedDeviceId ? { deviceId: { exact: voiceSelectedDeviceId } } : true };
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                startVoiceVolumeMonitor(stream);
            } catch (e) {
                console.warn('Volume monitor failed for WebSpeech:', e);
            }
        }

        return true;
    } catch (e) {
        showStatus('voice-status', t('status.failed') + e.message, 'error');
        stopVoiceAutoLoop();
        return false;
    }
}

function initVoiceInput(fileConfig = {}) {
    const modeSelect = document.getElementById('voice-mode');
    const langSelect = document.getElementById('voice-lang');
    const deviceSelect = document.getElementById('voice-device');
    const listenBtn = document.getElementById('btn-voice-listen');
    const stopBtn = document.getElementById('btn-voice-stop');
    const sendBtn = document.getElementById('btn-voice-send');
    const transcriptEl = document.getElementById('voice-transcript');
    const sttBaseUrlEl = document.getElementById('voice-stt-base-url');
    const sttApiKeyEl = document.getElementById('voice-stt-api-key');
    const sttModelEl = document.getElementById('voice-stt-model');
    const sttSaveBtn = document.getElementById('btn-voice-stt-save');
    const autoModeEl = document.getElementById('voice-auto-mode');
    const textRepairEl = document.getElementById('voice-text-repair');
    if (!modeSelect || !langSelect || !listenBtn || !stopBtn || !sendBtn || !transcriptEl) return;

    const savedMode = fileConfig.voiceInput?.mode || 'api-stt';
    const savedLang = fileConfig.voiceInput?.lang || getDefaultVoiceLang();
    const savedAutoContinuous = !!fileConfig.voiceInput?.autoContinuous;
    const savedTextRepair = fileConfig.voiceInput?.textRepair !== false;
    const savedDeviceId = fileConfig.voiceInput?.deviceId || '';
    const savedWhisperModel = fileConfig.voiceInput?.whisperModel || 'small';
    const sttCfg = fileConfig.speechToText || {};
    const rawSttBaseURL = (sttCfg.baseURL || '').trim();
    const rawSttModel = (sttCfg.modelName || '').trim();
    const isDefaultSttConfig = !sttCfg.apiKey
        && (rawSttBaseURL === '' || rawSttBaseURL === 'https://api.openai.com/v1')
        && (rawSttModel === '' || rawSttModel === 'gpt-4o-mini-transcribe');

    modeSelect.value = savedMode;
    langSelect.value = savedLang;
    voiceSelectedDeviceId = savedDeviceId;
    if (autoModeEl) autoModeEl.checked = savedAutoContinuous;
    if (textRepairEl) textRepairEl.checked = savedTextRepair;
    const whisperModelSelect = document.getElementById('whisper-model');
    if (whisperModelSelect) whisperModelSelect.value = savedWhisperModel;
    const whisperModelDiv = document.getElementById('whisper-model-select');
    if (whisperModelDiv) whisperModelDiv.style.display = savedMode === 'whisper-stt' ? 'block' : 'none';

    loadVoiceDevices();
    if (sttBaseUrlEl) sttBaseUrlEl.value = isDefaultSttConfig ? '' : rawSttBaseURL;
    if (sttApiKeyEl) sttApiKeyEl.value = sttCfg.apiKey || '';
    if (sttModelEl) sttModelEl.value = isDefaultSttConfig ? '' : rawSttModel;

    modeSelect.addEventListener('change', () => {
        if (window.electronAPI) window.electronAPI.saveConfig({ voiceInput: { mode: modeSelect.value } });
        updateVoiceButtons();
        const whisperModelDiv = document.getElementById('whisper-model-select');
        if (whisperModelDiv) whisperModelDiv.style.display = modeSelect.value === 'whisper-stt' ? 'block' : 'none';
        if (voiceAutoLoopEnabled && !voiceListening && !voiceTranscribing) scheduleNextVoiceSession(80);
    });
    langSelect.addEventListener('change', () => {
        if (window.electronAPI) window.electronAPI.saveConfig({ voiceInput: { lang: langSelect.value } });
        if (voiceRecognition) voiceRecognition.lang = langSelect.value;
    });
    autoModeEl?.addEventListener('change', () => {
        if (window.electronAPI) window.electronAPI.saveConfig({ voiceInput: { autoContinuous: autoModeEl.checked } });
        if (!autoModeEl.checked) stopVoiceAutoLoop();
        updateVoiceButtons();
    });
    textRepairEl?.addEventListener('change', () => {
        if (window.electronAPI) window.electronAPI.saveConfig({ voiceInput: { textRepair: textRepairEl.checked } });
    });
    deviceSelect?.addEventListener('change', () => {
        voiceSelectedDeviceId = deviceSelect.value || null;
        if (window.electronAPI) window.electronAPI.saveConfig({ voiceInput: { deviceId: deviceSelect.value } });
    });

    const whisperModelSelect = document.getElementById('whisper-model');
    whisperModelSelect?.addEventListener('change', () => {
        if (window.electronAPI) window.electronAPI.saveConfig({ voiceInput: { whisperModel: whisperModelSelect.value } });
    });

    sttSaveBtn?.addEventListener('click', () => {
        const speechToText = {
            baseURL: (sttBaseUrlEl?.value || '').trim(),
            apiKey: (sttApiKeyEl?.value || '').trim(),
            modelName: (sttModelEl?.value || '').trim()
        };
        if (window.electronAPI) window.electronAPI.saveConfig({ speechToText });
        showStatus('voice-status', t('status.saved'), 'success');
    });

    sendBtn.addEventListener('click', () => sendVoiceTextToAI());

    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognitionCtor) {
        voiceRecognition = new SpeechRecognitionCtor();
        voiceRecognition.lang = langSelect.value;
        voiceRecognition.continuous = false;
        voiceRecognition.interimResults = true;
        voiceRecognition.maxAlternatives = 1;

        voiceRecognition.onstart = () => {
            voiceListening = true;
            voiceSessionAutoSent = false;
            updateVoiceButtons();
            showStatus('voice-status', t('voice.listeningHint'), 'info');
        };

        voiceRecognition.onresult = (event) => {
            let mergedText = '';
            let finalText = '';

            for (let i = 0; i < event.results.length; i++) {
                const transcript = (event.results[i][0]?.transcript || '').trim();
                if (!transcript) continue;
                mergedText += (mergedText ? ' ' : '') + transcript;
                if (event.results[i].isFinal) {
                    finalText += (finalText ? ' ' : '') + transcript;
                }
            }

            if (mergedText) transcriptEl.value = mergedText;

            if (finalText && !voiceSessionAutoSent) {
                voiceSessionAutoSent = true;
                transcriptEl.value = finalText;
                sendVoiceTextToAI(finalText, { fromRecognition: true });
            }
        };

        voiceRecognition.onerror = (event) => {
            const err = event?.error || 'unknown';
            voiceListening = false;
            stopVoiceVolumeMonitor();
            updateVoiceButtons();
            if (err === 'not-allowed' || err === 'service-not-allowed') {
                showStatus('voice-status', t('voice.err.permission'), 'error');
                stopVoiceAutoLoop();
                return;
            }
            if (err === 'network') {
                const modeSelect = document.getElementById('voice-mode');
                if (modeSelect && modeSelect.value === 'webspeech') {
                    const fallbackMode = window.electronAPI?.localSttTranscribe ? 'local-stt' : 'api-stt';
                    modeSelect.value = fallbackMode;
                    if (window.electronAPI) window.electronAPI.saveConfig({ voiceInput: { mode: fallbackMode } });
                    updateVoiceButtons();
                    showStatus('voice-status', fallbackMode === 'local-stt' ? t('voice.err.networkSwitchLocal') : t('voice.err.networkSwitch'), 'error');
                    return;
                }
                showStatus('voice-status', t('voice.err.network'), 'error');
                return;
            }
            if (err === 'no-speech' || err === 'audio-capture') {
                showStatus('voice-status', t('voice.err.noSpeech'), 'error');
                return;
            }
            showStatus('voice-status', t('status.failed') + err, 'error');
        };

        voiceRecognition.onend = () => {
            voiceListening = false;
            stopVoiceVolumeMonitor();
            updateVoiceButtons();
            if (shouldContinueVoiceAutoLoop() && getVoiceMode() === 'webspeech') {
                scheduleNextVoiceSession();
            }
        };
    }

    listenBtn.addEventListener('click', async () => {
        voiceStopRequested = false;
        voiceAutoLoopEnabled = shouldEnableAutoLoop();
        if (voiceAutoLoopEnabled) {
            scheduleNextVoiceSession(0);
            return;
        }
        await startVoiceSessionByCurrentMode({ clearTranscript: true });
    });

    stopBtn.addEventListener('click', async () => {
        stopVoiceVolumeMonitor();
        stopVoiceAutoLoop();
        if (getVoiceMode() === 'api-stt' || getVoiceMode() === 'whisper-stt') {
            stopAPISTTRecording();
            return;
        }
        if (getVoiceMode() === 'local-stt') {
            await stopLocalSTTRecognition();
            showStatus('voice-status', t('voice.stopped'), 'info');
            return;
        }
        if (voiceRecognition && voiceListening) {
            voiceRecognition.stop();
            showStatus('voice-status', t('voice.stopped'), 'info');
            return;
        }
        showStatus('voice-status', t('voice.stopped'), 'info');
    });

    updateVoiceButtons();
}

// ========== Hover State ==========
if (window.electronAPI && window.electronAPI.onPetHoverState) {
    window.electronAPI.onPetHoverState((isHovering) => {
        if (petSystem && petSystem.emotionSystem) {
            petSystem.emotionSystem.setHoverState(isHovering);
        }
    });
}

// ========== Model Tab ==========
const PARAM_LABELS = {
    angleX: 'param.angleX', angleY: 'param.angleY', angleZ: 'param.angleZ',
    bodyAngleX: 'param.bodyAngleX', eyeBallX: 'param.eyeBallX', eyeBallY: 'param.eyeBallY'
};

function loadModelUI() {
    const typeSelect = document.getElementById('model-type');
    typeSelect.value = currentModelConfig.type || 'none';
    updateModelCards();

    // Load existing values
    if (currentModelConfig.type === 'live2d') {
        document.getElementById('l2d-info').textContent =
            currentModelConfig.modelJsonFile ? `${t('status.modelInfo')}${currentModelConfig.modelJsonFile}` : '';
        document.getElementById('canvas-y-slider').value = currentModelConfig.canvasYRatio || 0.60;
        document.getElementById('canvas-y-val').textContent = (currentModelConfig.canvasYRatio || 0.60).toFixed(2);
        renderParamMapping();
    }
    if (currentModelConfig.type === 'image') {
        // Restore folder mode
        if (currentModelConfig.imageFolderPath) {
            document.getElementById('folder-info').textContent =
                `${t('status.folderInfo')}${currentModelConfig.imageFolderPath}`;
            document.getElementById('image-list-container').style.display = '';
            // Restore crop slider
            const cropScale = currentModelConfig.imageCropScale || 1.0;
            document.getElementById('image-crop-slider').value = cropScale;
            document.getElementById('image-crop-val').textContent = cropScale.toFixed(2);
            // Restore image list from saved config
            renderImageListFromConfig(currentModelConfig);
        }
    }
}

function updateModelCards() {
    const type = document.getElementById('model-type').value;
    document.getElementById('card-live2d').style.display = type === 'live2d' ? '' : 'none';
    document.getElementById('card-param-mapping').style.display = type === 'live2d' ? '' : 'none';
    document.getElementById('card-canvas-y').style.display = type === 'live2d' ? '' : 'none';
    document.getElementById('card-image').style.display = type === 'image' ? '' : 'none';
}

document.getElementById('model-type').addEventListener('change', () => {
    currentModelConfig.type = document.getElementById('model-type').value;
    updateModelCards();
});

// Canvas Y slider
document.getElementById('canvas-y-slider').addEventListener('input', (e) => {
    document.getElementById('canvas-y-val').textContent = parseFloat(e.target.value).toFixed(2);
    currentModelConfig.canvasYRatio = parseFloat(e.target.value);
});

// Image crop slider
document.getElementById('image-crop-slider').addEventListener('input', (e) => {
    document.getElementById('image-crop-val').textContent = parseFloat(e.target.value).toFixed(2);
    currentModelConfig.imageCropScale = parseFloat(e.target.value);
});

// Import Live2D
document.getElementById('btn-import-l2d').addEventListener('click', async () => {
    const result = await window.electronAPI.selectModelFolder();
    if (!result.success) {
        if (result.error !== 'cancelled') showStatus('model-status', result.error, 'error');
        return;
    }
    const folderPath = result.folderPath;
    const modelFile = result.modelFiles[0]; // Use first found

    // Scan model info
    showStatus('model-status', t('status.scanning'), 'info');
    const scanResult = await window.electronAPI.scanModelInfo(folderPath, modelFile);
    if (!scanResult.success) {
        showStatus('model-status', scanResult.error, 'error');
        return;
    }

    currentModelConfig.folderPath = folderPath;
    currentModelConfig.modelJsonFile = modelFile;
    currentModelConfig.type = 'live2d';
    document.getElementById('model-type').value = 'live2d';
    updateModelCards();

    // Store scan results
    scannedParamIds = scanResult.parameterIds || [];
    suggestedMapping = scanResult.suggestedMapping || {};

    // Show info
    const motionCount = Object.values(scanResult.motions || {}).reduce((sum, arr) => sum + arr.length, 0);
    const info = [`${t('status.modelInfo')}${scanResult.modelName}`,
        `${scannedParamIds.length} params`,
        `${scanResult.expressions.length} expr`,
        `${motionCount} motions`,
        `Moc: ${scanResult.validation.mocValid ? '✓' : '✗'}`,
        `Tex: ${scanResult.validation.texturesValid ? '✓' : '✗'}`
    ].join(' | ');
    document.getElementById('l2d-info').textContent = info;

    // Clear old expression/motion data for new model
    currentModelConfig.expressions = [];
    currentModelConfig.motionEmotions = [];
    currentModelConfig.expressionDurations = {};
    currentModelConfig.motionDurations = {};
    currentModelConfig.hasExpressions = false;

    // Auto-populate expressions
    if (scanResult.expressions.length > 0) {
        currentModelConfig.hasExpressions = true;
        currentModelConfig.expressions = scanResult.expressions.map(e => ({
            name: e.name, label: e.name, file: e.file
        }));
    }

    // Auto-populate motions
    scannedMotions = scanResult.motions || {};
    if (Object.keys(scannedMotions).length > 0) {
        const motionEmotions = [];
        for (const [group, entries] of Object.entries(scannedMotions)) {
            entries.forEach((entry, idx) => {
                const fileName = (entry.file || '').replace(/^.*[\\/]/, '').replace('.motion3.json', '');
                motionEmotions.push({
                    name: fileName || `${group}_${idx}`,
                    group, index: idx
                });
            });
        }
        currentModelConfig.motionEmotions = motionEmotions;
    }

    renderParamMapping();
    renderExpressionList(currentModelConfig);
    renderMotionList(currentModelConfig);

    // Copy to userData if checked
    if (document.getElementById('copy-to-userdata').checked) {
        showStatus('model-status', t('status.copyingModel'), 'info');
        const copyResult = await window.electronAPI.copyModelToUserdata(folderPath, scanResult.modelName);
        if (copyResult.success) {
            currentModelConfig.userDataModelPath = copyResult.userDataModelPath;
            showStatus('model-status', t('status.modelImported'), 'success');
        } else {
            showStatus('model-status', t('status.copyFailed') + copyResult.error, 'error');
        }
    } else {
        showStatus('model-status', t('status.modelSelected'), 'success');
    }
});

function renderParamMapping() {
    const container = document.getElementById('param-mapping-list');
    container.innerHTML = '';
    const pm = currentModelConfig.paramMapping || {};
    for (const [key, labelKey] of Object.entries(PARAM_LABELS)) {
        const mapped = pm[key];
        const suggested = suggestedMapping ? suggestedMapping[key] : null;
        // Sort: suggested first, then rest alphabetically
        const sorted = [...scannedParamIds].sort((a, b) => {
            if (a === suggested) return -1;
            if (b === suggested) return 1;
            return a.localeCompare(b);
        });
        const row = document.createElement('div');
        row.className = 'param-row';
        row.innerHTML = `
            <span class="param-label">${t(labelKey)}</span>
            <select class="param-select" data-key="${key}" style="flex:1;padding:4px;font-size:12px;border-radius:4px;">
                <option value="">${t('status.unmapped')}</option>
                ${sorted.map(id =>
                    `<option value="${id}" ${id === mapped ? 'selected' : ''}>${id}${id === suggested ? ' ★' : ''}</option>`
                ).join('')}
            </select>
        `;
        container.appendChild(row);
    }
    // Listen for manual changes
    container.querySelectorAll('.param-select').forEach(sel => {
        sel.addEventListener('change', () => {
            if (!currentModelConfig.paramMapping) currentModelConfig.paramMapping = {};
            currentModelConfig.paramMapping[sel.dataset.key] = sel.value || null;
        });
    });
}

document.getElementById('btn-apply-suggested').addEventListener('click', () => {
    if (!suggestedMapping) return;
    if (!currentModelConfig.paramMapping) currentModelConfig.paramMapping = {};
    for (const [key, val] of Object.entries(suggestedMapping)) {
        if (val) currentModelConfig.paramMapping[key] = val;
    }
    renderParamMapping();
    showStatus('model-status', t('status.suggestedApplied'), 'success');
});

// Import image folder
document.getElementById('btn-select-image-folder').addEventListener('click', async () => {
    const result = await window.electronAPI.selectImageFolder();
    if (!result.success) {
        if (result.error !== 'cancelled') showStatus('model-status', result.error, 'error');
        return;
    }
    const folderPath = result.folderPath;
    currentModelConfig.imageFolderPath = folderPath;
    currentModelConfig.type = 'image';
    document.getElementById('model-type').value = 'image';
    updateModelCards();

    // Scan folder for images
    showStatus('model-status', t('status.scanningImages'), 'info');
    const scanResult = await window.electronAPI.scanImageFolder(folderPath);
    if (!scanResult.success) {
        showStatus('model-status', scanResult.error, 'error');
        return;
    }

    document.getElementById('folder-info').textContent =
        `${t('status.folderInfo')}${folderPath} (${scanResult.images.length})`;
    document.getElementById('image-list-container').style.display = '';

    // Build imageFiles from scan, preserving existing config if same folder
    const existingFiles = currentModelConfig.imageFiles || [];
    const existingMap = {};
    for (const f of existingFiles) existingMap[f.file] = f;

    currentModelConfig.imageFiles = scanResult.images.map(img => {
        const existing = existingMap[img.filename];
        return existing || { file: img.filename, idle: false, talking: false, emotionName: '' };
    });

    renderImageList(currentModelConfig);
    showStatus('model-status', t('status.imagesScanned').replace('{0}', scanResult.images.length), 'success');
});

function renderImageList(modelConfig) {
    const container = document.getElementById('image-list');
    container.innerHTML = '';
    const files = modelConfig.imageFiles || [];
    const folderPath = (modelConfig.imageFolderPath || '').replace(/\\/g, '/');

    files.forEach((f, i) => {
        const row = document.createElement('div');
        row.className = 'image-item';
        row.dataset.index = i;

        const emotionDisplay = f.emotionName ? '' : 'display:none;';
        row.innerHTML = `
            <img class="image-thumb" src="file:///${folderPath}/${encodeURIComponent(f.file)}" alt="${f.file}">
            <span style="flex:1;min-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${f.file}">${f.file}</span>
            <div class="cats">
                <label><input type="checkbox" class="cat-idle" ${f.idle ? 'checked' : ''}> ${t('img.idle')}</label>
                <label><input type="checkbox" class="cat-talking" ${f.talking ? 'checked' : ''}> ${t('img.talking')}</label>
                <label><input type="checkbox" class="cat-emotion" ${f.emotionName ? 'checked' : ''}> ${t('img.emotion')}</label>
                <input type="text" class="emotion-name" value="${f.emotionName || ''}" placeholder="${t('img.emotionPh')}" style="${emotionDisplay}">
            </div>
        `;

        // Toggle emotion name input visibility
        const emotionCb = row.querySelector('.cat-emotion');
        const emotionInput = row.querySelector('.emotion-name');
        emotionCb.addEventListener('change', () => {
            emotionInput.style.display = emotionCb.checked ? '' : 'none';
            if (!emotionCb.checked) emotionInput.value = '';
        });

        container.appendChild(row);
    });
}

function renderImageListFromConfig(modelConfig) {
    // Re-render from saved config (used on load)
    renderImageList(modelConfig);
}

function collectImageFiles() {
    const items = document.querySelectorAll('#image-list .image-item');
    const files = currentModelConfig.imageFiles || [];
    items.forEach((item, i) => {
        if (!files[i]) return;
        files[i].idle = item.querySelector('.cat-idle').checked;
        files[i].talking = item.querySelector('.cat-talking').checked;
        const emotionCb = item.querySelector('.cat-emotion');
        files[i].emotionName = emotionCb.checked
            ? (item.querySelector('.emotion-name').value.trim() || '')
            : '';
    });
    return files;
}

// Bubble frame
document.getElementById('btn-select-bubble').addEventListener('click', async () => {
    const result = await window.electronAPI.selectBubbleImage();
    if (!result.success) return;
    document.getElementById('bubble-info').textContent = `${t('status.bubbleInfo')}${result.filePath}`;
    // Save to config
    await window.electronAPI.saveConfig({ bubble: { frameImagePath: result.filePath } });
});

document.getElementById('btn-clear-bubble').addEventListener('click', async () => {
    document.getElementById('bubble-info').textContent = '';
    await window.electronAPI.saveConfig({ bubble: { frameImagePath: null } });
});

// App icon
document.getElementById('btn-select-icon').addEventListener('click', async () => {
    const result = await window.electronAPI.selectAppIcon();
    if (!result.success) return;
    document.getElementById('icon-preview').src = result.iconPath;
    document.getElementById('icon-preview').style.display = '';
    document.getElementById('icon-info').textContent = `${t('status.iconInfo')}${result.iconPath}`;
    await window.electronAPI.saveConfig({ appIcon: result.iconPath });
});

// Save model config
document.getElementById('btn-save-model').addEventListener('click', async () => {
    // Collect image folder data if in image mode
    if (currentModelConfig.type === 'image' && currentModelConfig.imageFolderPath) {
        currentModelConfig.imageFiles = collectImageFiles();
        currentModelConfig.imageCropScale = parseFloat(
            document.getElementById('image-crop-slider').value
        ) || 1.0;

        // Auto-generate expressions from emotion names for the emotion system
        const emotionNames = new Set();
        for (const f of currentModelConfig.imageFiles) {
            if (f.emotionName) emotionNames.add(f.emotionName);
        }
        if (emotionNames.size > 0) {
            currentModelConfig.hasExpressions = true;
            currentModelConfig.expressions = [...emotionNames].map(name => ({
                name, label: name, file: ''
            }));
        } else {
            currentModelConfig.hasExpressions = false;
            currentModelConfig.expressions = [];
        }
    }

    await window.electronAPI.saveConfig({ model: currentModelConfig });
    showStatus('model-status', t('status.modelSaved'), 'success');
});

// Clear model
document.getElementById('btn-clear-model').addEventListener('click', async () => {
    currentModelConfig = {
        type: 'none', folderPath: null, modelJsonFile: null,
        copyToUserData: true, userDataModelPath: null,
        staticImagePath: null, bottomAlignOffset: 0.5,
        gifExpressions: {},
        imageFolderPath: null, imageFiles: [], imageCropScale: 1.0,
        paramMapping: { angleX: null, angleY: null, angleZ: null, bodyAngleX: null, eyeBallX: null, eyeBallY: null },
        hasExpressions: false, expressions: [],
        expressionDurations: {}, defaultExpressionDuration: 5000,
        motionEmotions: [], motionDurations: {}, defaultMotionDuration: 3000,
        canvasYRatio: 0.60
    };
    await window.electronAPI.saveConfig({ model: currentModelConfig });
    document.getElementById('model-type').value = 'none';
    document.getElementById('image-list').innerHTML = '';
    document.getElementById('image-list-container').style.display = 'none';
    document.getElementById('folder-info').textContent = '';
    updateModelCards();
    showStatus('model-status', t('status.modelCleared'), 'success');
});

// ========== Emotion Tab ==========
function loadEmotionUI(fileConfig) {
    if (!fileConfig) return;
    if (fileConfig.emotionFrequency) {
        document.getElementById('emotion-frequency').value = fileConfig.emotionFrequency;
    }
    if (fileConfig.allowSimultaneous) {
        document.getElementById('allow-simultaneous').checked = true;
    }
    if (fileConfig.model && fileConfig.model.defaultExpressionDuration) {
        document.getElementById('default-expr-duration').value = fileConfig.model.defaultExpressionDuration / 1000;
    }
    if (fileConfig.model && fileConfig.model.defaultMotionDuration) {
        document.getElementById('default-motion-duration').value = fileConfig.model.defaultMotionDuration / 1000;
    }
    renderExpressionList(fileConfig.model);
    renderMotionList(fileConfig.model);
}

function renderExpressionList(modelConfig) {
    const container = document.getElementById('expression-list');
    container.innerHTML = '';
    const expressions = (modelConfig && modelConfig.expressions) || [];
    const durations = (modelConfig && modelConfig.expressionDurations) || {};
    const enabledList = [];

    if (expressions.length === 0) {
        document.getElementById('expr-hint').style.display = '';
        return;
    }
    document.getElementById('expr-hint').style.display = 'none';

    expressions.forEach((expr, i) => {
        const durMs = durations[expr.name];
        const durSec = durMs ? (durMs / 1000) : '';
        const row = document.createElement('div');
        row.className = 'expr-item';
        row.innerHTML = `
            <input type="checkbox" class="expr-enabled" data-name="${expr.name}" checked>
            <input type="text" class="expr-name" value="${expr.name}" style="width:80px;padding:2px 4px;font-size:12px;" data-index="${i}">
            <span style="color:#888;font-size:11px;">${expr.file || ''}</span>
            <input type="number" class="expr-dur" value="${durSec}" placeholder="${t('status.default')}" step="0.5" min="0" style="width:60px;padding:2px 4px;font-size:12px;" data-name="${expr.name}">
            <span style="color:#888;font-size:11px;">${t('sec')}</span>
            <button class="btn btn-danger btn-sm expr-del" data-index="${i}" style="padding:2px 8px;">✕</button>
        `;
        container.appendChild(row);
    });

    // Delete expression
    container.querySelectorAll('.expr-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.index);
            currentModelConfig.expressions.splice(idx, 1);
            renderExpressionList(currentModelConfig);
        });
    });
}

document.getElementById('btn-add-expr').addEventListener('click', () => {
    if (!currentModelConfig.expressions) currentModelConfig.expressions = [];
    currentModelConfig.expressions.push({ name: t('status.newExpr'), label: t('status.newExpr'), file: '' });
    currentModelConfig.hasExpressions = true;
    renderExpressionList(currentModelConfig);
});

// ========== Motion List ==========
function renderMotionList(modelConfig) {
    const container = document.getElementById('motion-list');
    container.innerHTML = '';
    const motionEmotions = (modelConfig && modelConfig.motionEmotions) || [];
    const durations = (modelConfig && modelConfig.motionDurations) || {};

    if (motionEmotions.length === 0) {
        document.getElementById('motion-hint').style.display = '';
        return;
    }
    document.getElementById('motion-hint').style.display = 'none';

    // Build group options from scanned motions
    const groupOptions = Object.keys(scannedMotions);

    motionEmotions.forEach((m, i) => {
        const durMs = durations[m.name];
        const durSec = durMs ? (durMs / 1000) : '';
        const maxIdx = scannedMotions[m.group] ? scannedMotions[m.group].length - 1 : 99;
        const row = document.createElement('div');
        row.className = 'expr-item';
        row.innerHTML = `
            <input type="checkbox" class="motion-enabled" data-name="${m.name}" checked>
            <input type="text" class="motion-name" value="${m.name}" style="width:80px;padding:2px 4px;font-size:12px;" data-index="${i}">
            <select class="motion-group" data-index="${i}" style="width:80px;padding:2px 4px;font-size:12px;">
                ${groupOptions.map(g => `<option value="${g}" ${g === m.group ? 'selected' : ''}>${g}</option>`).join('')}
                ${!groupOptions.includes(m.group) ? `<option value="${m.group}" selected>${m.group}</option>` : ''}
            </select>
            <input type="number" class="motion-index" value="${m.index}" min="0" max="${maxIdx}" style="width:45px;padding:2px 4px;font-size:12px;" data-index="${i}">
            <input type="number" class="motion-dur" value="${durSec}" placeholder="${t('status.default')}" step="0.5" min="0" style="width:60px;padding:2px 4px;font-size:12px;" data-name="${m.name}">
            <span style="color:#888;font-size:11px;">${t('sec')}</span>
            <button class="btn btn-danger btn-sm motion-del" data-index="${i}" style="padding:2px 8px;">✕</button>
        `;
        container.appendChild(row);
    });

    // Delete motion
    container.querySelectorAll('.motion-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.index);
            currentModelConfig.motionEmotions.splice(idx, 1);
            renderMotionList(currentModelConfig);
        });
    });
}

document.getElementById('btn-add-motion').addEventListener('click', () => {
    if (!currentModelConfig.motionEmotions) currentModelConfig.motionEmotions = [];
    const firstGroup = Object.keys(scannedMotions)[0] || 'Default';
    currentModelConfig.motionEmotions.push({ name: t('status.newMotion'), group: firstGroup, index: 0 });
    renderMotionList(currentModelConfig);
});

document.getElementById('btn-save-emotion-freq').addEventListener('click', () => {
    if (!petSystem || !petSystem.emotionSystem) return;
    const freq = parseInt(document.getElementById('emotion-frequency').value);
    const simultaneous = document.getElementById('allow-simultaneous').checked;
    petSystem.emotionSystem.setExpectedFrequency(freq);
    petSystem.emotionSystem.allowSimultaneous = simultaneous;
    if (window.electronAPI) window.electronAPI.saveConfig({ allowSimultaneous: simultaneous });
    showStatus('emotion-status', t('status.saved'), 'success');
});

document.getElementById('btn-save-expressions').addEventListener('click', async () => {
    // Collect expression data from UI
    const container = document.getElementById('expression-list');
    const names = container.querySelectorAll('.expr-name');
    const durs = container.querySelectorAll('.expr-dur');
    const enabled = container.querySelectorAll('.expr-enabled');

    const expressions = [];
    const expressionDurations = {};
    const enabledEmotions = [];

    names.forEach((nameInput, i) => {
        const name = nameInput.value.trim();
        if (!name) return;
        const expr = currentModelConfig.expressions[i] || {};
        expressions.push({ name, label: name, file: expr.file || '' });
        const durSec = parseFloat(durs[i]?.value);
        if (durSec > 0) expressionDurations[name] = Math.round(durSec * 1000);
        if (enabled[i]?.checked) enabledEmotions.push(name);
    });

    // Collect motion data from UI
    const motionContainer = document.getElementById('motion-list');
    const motionNames = motionContainer.querySelectorAll('.motion-name');
    const motionGroups = motionContainer.querySelectorAll('.motion-group');
    const motionIndices = motionContainer.querySelectorAll('.motion-index');
    const motionDurs = motionContainer.querySelectorAll('.motion-dur');
    const motionEnabled = motionContainer.querySelectorAll('.motion-enabled');

    const motionEmotions = [];
    const motionDurations = {};

    motionNames.forEach((nameInput, i) => {
        const name = nameInput.value.trim();
        if (!name) return;
        const group = motionGroups[i]?.value || 'Default';
        const index = parseInt(motionIndices[i]?.value) || 0;
        motionEmotions.push({ name, group, index });
        const durSec = parseFloat(motionDurs[i]?.value);
        if (durSec > 0) motionDurations[name] = Math.round(durSec * 1000);
        if (motionEnabled[i]?.checked) enabledEmotions.push(name);
    });

    const defaultDurSec = parseFloat(document.getElementById('default-expr-duration').value);
    const defaultDur = defaultDurSec > 0 ? Math.round(defaultDurSec * 1000) : 5000;
    const defaultMotionDurSec = parseFloat(document.getElementById('default-motion-duration').value);
    const defaultMotionDur = defaultMotionDurSec > 0 ? Math.round(defaultMotionDurSec * 1000) : 3000;

    currentModelConfig.expressions = expressions;
    currentModelConfig.expressionDurations = expressionDurations;
    currentModelConfig.defaultExpressionDuration = defaultDur;
    currentModelConfig.hasExpressions = expressions.length > 0;
    currentModelConfig.motionEmotions = motionEmotions;
    currentModelConfig.motionDurations = motionDurations;
    currentModelConfig.defaultMotionDuration = defaultMotionDur;

    await window.electronAPI.saveConfig({
        model: currentModelConfig,
        enabledEmotions
    });

    // Update emotion system
    if (petSystem && petSystem.emotionSystem) {
        petSystem.emotionSystem.configureExpressions(expressions, expressionDurations, defaultDur);
        petSystem.emotionSystem.configureMotions(motionEmotions, motionDurations, defaultMotionDur);
        petSystem.emotionSystem.setEnabledEmotions(enabledEmotions);
    }

    showStatus('save-emotion-status', t('status.exprSaved'), 'success');
});

// ========== Character Card Management ==========

let currentCharacterId = null;

function fillPromptFields(data) {
    document.getElementById('prompt-name').value = data.name || '';
    document.getElementById('prompt-user-identity').value = data.userIdentity || '';
    document.getElementById('prompt-user-term').value = data.userTerm || '';
    document.getElementById('prompt-desc').value = data.description || '';
    document.getElementById('prompt-personality').value = data.personality || '';
    document.getElementById('prompt-scenario').value = data.scenario || '';
    document.getElementById('prompt-rules').value = data.rules || '';
    document.getElementById('prompt-language').value = data.language || '';
    const ha = data.hitActions || {};
    document.getElementById('prompt-hit-click').value = ha.click || '';
    document.getElementById('prompt-hit-touch').value = ha.touch || '';
    document.getElementById('prompt-hit-drag').value = ha.drag || '';
    document.getElementById('prompt-hit-swipe').value = ha.swipe || '';
    document.getElementById('prompt-hit-resize').value = ha.resize || '';
}

async function loadCharacterList() {
    if (!window.electronAPI?.listCharacters) return;
    const { characters, activeCharacterId } = await window.electronAPI.listCharacters();
    const select = document.getElementById('character-select');
    select.innerHTML = '';
    for (const c of characters) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.builtin ? `${c.name} ${t('card.builtin')}` : c.name;
        select.appendChild(opt);
    }
    select.value = activeCharacterId;
    currentCharacterId = activeCharacterId;
    await loadCharacterPrompt(activeCharacterId);
}

async function loadCharacterPrompt(id) {
    if (!window.electronAPI?.loadPrompt) return;
    const result = await window.electronAPI.loadPrompt(id);
    if (result.success) {
        currentCharacterId = result.id || id;
        // Resolve i18n for built-in cards (display in current UI language)
        let data = { ...result.data };
        if (result.i18n && currentLang && result.i18n[currentLang]) {
            Object.assign(data, result.i18n[currentLang]);
        }
        fillPromptFields(data);
    }
}

async function reloadPetPrompt() {
    if (petSystem && petSystem.promptBuilder) {
        await petSystem.promptBuilder.loadCharacterPrompt(currentCharacterId, currentLang);
        petSystem.systemPrompt = petSystem.promptBuilder.buildSystemPrompt();
    }
}

document.getElementById('character-select').addEventListener('change', async (e) => {
    const id = e.target.value;
    await window.electronAPI.setActiveCharacter(id);
    currentCharacterId = id;
    await loadCharacterPrompt(id);
    await reloadPetPrompt();
    showStatus('prompt-status', t('status.switched'), 'success');
});

// Inline name input helper
let _nameAction = null; // 'new' | 'rename'

function showNameInput(defaultValue, action) {
    _nameAction = action;
    const row = document.getElementById('character-name-input-row');
    const input = document.getElementById('character-name-input');
    input.value = defaultValue || '';
    row.style.display = 'flex';
    input.focus();
    input.select();
}

function hideNameInput() {
    document.getElementById('character-name-input-row').style.display = 'none';
    _nameAction = null;
}

document.getElementById('btn-confirm-name').addEventListener('click', async () => {
    const name = document.getElementById('character-name-input').value.trim();
    if (!name) return;
    if (_nameAction === 'new') {
        const result = await window.electronAPI.createCharacter(name);
        if (result.success) {
            await window.electronAPI.setActiveCharacter(result.id);
            await loadCharacterList();
            showStatus('prompt-status', t('status.created') + name, 'success');
        }
    } else if (_nameAction === 'rename' && currentCharacterId) {
        const result = await window.electronAPI.renameCharacter(currentCharacterId, name);
        if (result.success) {
            await loadCharacterList();
            showStatus('prompt-status', t('status.renamed'), 'success');
        }
    }
    hideNameInput();
});

document.getElementById('btn-cancel-name').addEventListener('click', hideNameInput);

document.getElementById('character-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-confirm-name').click();
    if (e.key === 'Escape') hideNameInput();
});

document.getElementById('btn-new-character').addEventListener('click', () => {
    showNameInput('', 'new');
});

document.getElementById('btn-import-character').addEventListener('click', async () => {
    const result = await window.electronAPI.importCharacter();
    if (result.success && result.imported.length > 0) {
        const last = result.imported[result.imported.length - 1];
        await window.electronAPI.setActiveCharacter(last.id);
        await loadCharacterList();
        showStatus('prompt-status', t('status.created') + last.name, 'success');
    }
});

document.getElementById('btn-rename-character').addEventListener('click', () => {
    if (!currentCharacterId) return;
    const select = document.getElementById('character-select');
    const currentName = select.options[select.selectedIndex]?.textContent || '';
    showNameInput(currentName, 'rename');
});

document.getElementById('btn-delete-character').addEventListener('click', async () => {
    if (!currentCharacterId) return;
    const result = await window.electronAPI.deleteCharacter(currentCharacterId);
    if (result.success) {
        await loadCharacterList();
        await reloadPetPrompt();
        showStatus('prompt-status', t('status.deleted'), 'success');
    } else {
        showStatus('prompt-status', result.error, 'error');
    }
});

document.getElementById('btn-reset-builtin').addEventListener('click', async () => {
    if (!window.electronAPI?.resetBuiltinCards) return;
    const result = await window.electronAPI.resetBuiltinCards();
    if (result.success) {
        await loadCharacterList();
        await loadCharacterPrompt(currentCharacterId);
        await reloadPetPrompt();
        showStatus('prompt-status', t('status.builtinReset'), 'success');
    }
});

document.getElementById('btn-save-prompt').addEventListener('click', async () => {
    if (!currentCharacterId) return;
    const promptData = {
        name: document.getElementById('prompt-name').value,
        userIdentity: document.getElementById('prompt-user-identity').value,
        userTerm: document.getElementById('prompt-user-term').value,
        description: document.getElementById('prompt-desc').value,
        personality: document.getElementById('prompt-personality').value,
        scenario: document.getElementById('prompt-scenario').value,
        rules: document.getElementById('prompt-rules').value,
        language: document.getElementById('prompt-language').value,
        hitActions: {
            click: document.getElementById('prompt-hit-click').value.trim(),
            touch: document.getElementById('prompt-hit-touch').value.trim(),
            drag: document.getElementById('prompt-hit-drag').value.trim(),
            swipe: document.getElementById('prompt-hit-swipe').value.trim(),
            resize: document.getElementById('prompt-hit-resize').value.trim()
        }
    };
    const result = await window.electronAPI.savePrompt(currentCharacterId, promptData);
    if (result.success) {
        showStatus('prompt-status', t('status.saved'), 'success');
        await reloadPetPrompt();
    } else {
        showStatus('prompt-status', t('status.saveFail') + result.error, 'error');
    }
});

// ========== TTS Settings ==========

let ttsMetas = [];

async function loadTTSStatus() {
    if (!window.electronAPI || !window.electronAPI.ttsGetStatus) return;
    const status = await window.electronAPI.ttsGetStatus();
    const el = document.getElementById('tts-status');
    const restartBtn = document.getElementById('btn-restart-tts');
    if (status.initialized) {
        if (status.degraded) {
            const elapsed = Date.now() - status.degradedAt;
            const remaining = Math.max(0, Math.ceil((status.retryInterval - elapsed) / 1000));
            el.textContent = t('tts.circuitBreak').replace('{0}', remaining);
            el.className = 'status error';
            restartBtn.style.display = '';
        } else {
            el.textContent = t('tts.ready') + (status.gpuMode ? t('tts.readyGpu') : t('tts.readyCpu'));
            el.className = 'status success';
            restartBtn.style.display = 'none';
        }
        document.getElementById('tts-hint').style.display = 'none';
        // Load metas and populate dropdowns
        ttsMetas = await window.electronAPI.ttsGetMetas();
        populateSpeakerDropdown();
    } else {
        el.textContent = t('tts.offline');
        el.className = 'status error';
        restartBtn.style.display = '';
    }
    const config = await window.electronAPI.loadConfig();
    if (config.tts) {
        document.getElementById('tts-speed').value = config.tts.speedScale || 1.0;
        document.getElementById('tts-pitch').value = config.tts.pitchScale || 0.0;
        document.getElementById('tts-volume').value = config.tts.volumeScale || 1.0;
        document.getElementById('tts-speed-val').textContent = config.tts.speedScale || 1.0;
        document.getElementById('tts-pitch-val').textContent = config.tts.pitchScale || 0.0;
        document.getElementById('tts-volume-val').textContent = config.tts.volumeScale || 1.0;
        // Restore audio mode
        const audioMode = config.tts.audioMode || 'tts';
        const radio = document.querySelector(`input[name="audio-mode"][value="${audioMode}"]`);
        if (radio) radio.checked = true;
        // Restore saved speaker + style selection
        if (config.tts.styleId !== undefined) {
            selectStyleById(config.tts.styleId);
        }
        // Restore GPU mode checkbox
        const gpuCheckbox = document.getElementById('tts-gpu-mode');
        if (gpuCheckbox) gpuCheckbox.checked = config.tts.gpuMode || false;
    }
}

function populateSpeakerDropdown() {
    const speakerSel = document.getElementById('tts-speaker');
    speakerSel.innerHTML = '';
    ttsMetas.forEach((speaker, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = speaker.name;
        speakerSel.appendChild(opt);
    });
    speakerSel.addEventListener('change', () => populateStyleDropdown(parseInt(speakerSel.value)));
    if (ttsMetas.length > 0) populateStyleDropdown(0);
}

function populateStyleDropdown(speakerIdx) {
    const styleSel = document.getElementById('tts-style-id');
    styleSel.innerHTML = '';
    const speaker = ttsMetas[speakerIdx];
    if (!speaker) return;
    speaker.styles.forEach(style => {
        const opt = document.createElement('option');
        opt.value = style.id;
        opt.textContent = style.name;
        styleSel.appendChild(opt);
    });
}

function selectStyleById(styleId) {
    for (let i = 0; i < ttsMetas.length; i++) {
        const idx = ttsMetas[i].styles.findIndex(s => s.id === styleId);
        if (idx >= 0) {
            document.getElementById('tts-speaker').value = i;
            populateStyleDropdown(i);
            document.getElementById('tts-style-id').value = styleId;
            return;
        }
    }
}

['tts-speed', 'tts-pitch', 'tts-volume'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => {
        document.getElementById(id + '-val').textContent = el.value;
    });
});

document.getElementById('btn-save-tts').addEventListener('click', async () => {
    const ttsConfig = {
        styleId: parseInt(document.getElementById('tts-style-id').value),
        speedScale: parseFloat(document.getElementById('tts-speed').value),
        pitchScale: parseFloat(document.getElementById('tts-pitch').value),
        volumeScale: parseFloat(document.getElementById('tts-volume').value)
    };
    await window.electronAPI.ttsSetConfig(ttsConfig);
    // Save audio mode to config (only send tts section to avoid triggering model reload)
    const audioMode = document.querySelector('input[name="audio-mode"]:checked')?.value || 'tts';
    await window.electronAPI.saveConfig({
        tts: {
            audioMode,
            styleId: ttsConfig.styleId,
            speedScale: ttsConfig.speedScale,
            pitchScale: ttsConfig.pitchScale,
            volumeScale: ttsConfig.volumeScale,
            gpuMode: document.getElementById('tts-gpu-mode')?.checked || false
        }
    });
    showStatus('tts-save-status', t('status.saved'), 'success');
});

document.getElementById('btn-test-tts').addEventListener('click', async () => {
    const text = document.getElementById('tts-test-text').value.trim();
    if (!text) return;
    showStatus('tts-test-status', t('tts.synthesizing'), '');
    const result = await window.electronAPI.ttsSynthesize(text);
    if (result.success) {
        showStatus('tts-test-status', t('tts.translated') + result.jaText, 'success');
        const wavBytes = Uint8Array.from(atob(result.wav), c => c.charCodeAt(0));
        const blob = new Blob([wavBytes], { type: 'audio/wav' });
        const audio = new Audio(URL.createObjectURL(blob));
        audio.play();
    } else {
        showStatus('tts-test-status', t('tts.synthFailed') + result.error, 'error');
    }
});

loadTTSStatus();

// Restart TTS button
document.getElementById('btn-restart-tts')?.addEventListener('click', async () => {
    const el = document.getElementById('tts-status');
    el.textContent = t('tts.restarting');
    el.className = 'status';
    const result = await window.electronAPI.ttsRestart();
    if (result.success) {
        await loadTTSStatus();
    } else {
        el.textContent = t('tts.restartFailed') + (result.error || t('tts.unknownError'));
        el.className = 'status error';
    }
});

// One-click VOICEVOX setup
document.getElementById('btn-setup-voicevox')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-setup-voicevox');
    const status = document.getElementById('voicevox-setup-status');
    btn.disabled = true;
    btn.textContent = t('tts.installing');
    status.textContent = t('tts.preparing');
    status.className = 'status';

    if (window.electronAPI.onVoicevoxSetupProgress) {
        window.electronAPI.onVoicevoxSetupProgress((msg) => {
            status.textContent = msg;
        });
    }

    const result = await window.electronAPI.setupVoicevox();
    btn.disabled = false;
    btn.textContent = t('tts.setup');
    if (result.success) {
        status.textContent = t('tts.installDone');
        status.className = 'status success';
        // Auto-restart TTS
        const restartResult = await window.electronAPI.ttsRestart();
        if (restartResult.success) {
            await loadTTSStatus();
            status.textContent = t('tts.installDoneTts');
        }
    } else {
        status.textContent = t('tts.installFail') + result.error;
        status.className = 'status error';
    }
});

// Default audio generation
document.getElementById('btn-generate-default-audio')?.addEventListener('click', async () => {
    const textarea = document.getElementById('default-audio-phrases');
    const phrases = textarea.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (phrases.length === 0) {
        showStatus('default-audio-status', t('tts.enterPhrase'), 'error');
        return;
    }
    const styleId = parseInt(document.getElementById('tts-style-id').value) || 0;
    showStatus('default-audio-status', t('tts.generating').replace('{0}', phrases.length), '');
    const result = await window.electronAPI.generateDefaultAudio(phrases, styleId);
    if (result.success) {
        const ok = result.results.filter(r => r.success).length;
        showStatus('default-audio-status', t('tts.generateDone').replace('{0}', ok).replace('{1}', phrases.length), 'success');
    } else {
        showStatus('default-audio-status', t('status.failed') + result.error, 'error');
    }
});

// Load saved phrases into textarea
(async () => {
    const config = await window.electronAPI?.loadConfig();
    if (config?.tts?.defaultPhrases) {
        const textarea = document.getElementById('default-audio-phrases');
        if (textarea) textarea.value = config.tts.defaultPhrases.join('\n');
    }
})();

// VVM config
const VVM_CHARACTERS = {
    '0.vvm': '四国めたん, ずんだもん, 春日部つむぎ, 雨晴はう',
    '1.vvm': '冥鳴ひまり',
    '2.vvm': '九州そら',
    '3.vvm': '波音リツ, 中国うさぎ',
    '4.vvm': '玄野武宏, 剣崎雌雄',
    '5.vvm': '四国めたん(ささやき), ずんだもん(ささやき), 九州そら(ささやき)',
    '6.vvm': 'No.7',
    '7.vvm': '後鬼',
    '8.vvm': 'WhiteCUL',
    '9.vvm': '白上虎太郎',
    '10.vvm': '玄野武宏(追加), ちび式じい',
    '11.vvm': '櫻歌ミコ, ナースロボ＿タイプＴ',
    '12.vvm': '†聖騎士 紅桜†, 雀松朱司, 麒ヶ島宗麟',
    '13.vvm': '春歌ナナ, 猫使アル, 猫使ビィ',
    '14.vvm': '栗田まろん, あいえるたん, 満別花丸, 琴詠ニア',
    '15.vvm': 'ずんだもん(追加), 青山龍星, もち子さん, 小夜/SAYO',
    '16.vvm': '後鬼(追加)',
    '17.vvm': 'Voidoll',
    '18.vvm': 'ぞん子, 中部つるぎ',
    '19.vvm': '離途, 黒沢冴白',
    '20.vvm': 'ユーレイちゃん',
    '21.vvm': '東北ずん子, 東北きりたん, 東北イタコ, 猫使(追加)',
    '22.vvm': 'あんこもん',
    '23.vvm': 'あんこもん(ささやき)',
    'n0.vvm': 'VOICEVOX Nemo (女声1-6, 男声1-3)',
};

async function loadVvmConfig() {
    if (!window.electronAPI?.ttsGetAvailableVvms) return;
    const available = await window.electronAPI.ttsGetAvailableVvms();
    const config = await window.electronAPI.loadConfig();
    const loaded = config.tts?.vvmFiles || ['0.vvm'];
    const container = document.getElementById('vvm-checkboxes');
    if (!container) return;

    const allVvms = Object.keys(VVM_CHARACTERS);
    container.innerHTML = allVvms.map(f => {
        const onDisk = available.includes(f);
        const checked = loaded.includes(f) && onDisk ? 'checked' : '';
        const disabled = onDisk ? '' : 'disabled';
        const desc = VVM_CHARACTERS[f] || '';
        const dlBtn = onDisk
            ? '<span style="color:#4a4;font-size:11px;">OK</span>'
            : `<button class="btn-dl-vvm" data-vvm="${f}" style="font-size:11px;padding:1px 6px;cursor:pointer;">${t('tts.vvm.dl')}</button>`;
        return `<label style="display:flex;align-items:center;gap:4px;padding:2px 0;font-size:12px;">
            <input type="checkbox" value="${f}" ${checked} ${disabled}>
            <b>${f}</b> ${desc} ${dlBtn}
        </label>`;
    }).join('');

    container.querySelectorAll('.btn-dl-vvm').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const vvm = btn.dataset.vvm;
            btn.textContent = '...';
            btn.disabled = true;
            const result = await window.electronAPI.downloadVvm(vvm);
            if (result.success) {
                // Auto-add downloaded VVM to config and restart TTS
                const config = await window.electronAPI.loadConfig();
                const vvmFiles = config.tts?.vvmFiles || ['0.vvm'];
                if (!vvmFiles.includes(vvm)) {
                    vvmFiles.push(vvm);
                    await window.electronAPI.saveConfig({ tts: { vvmFiles } });
                }
                await loadVvmConfig();
                await window.electronAPI.ttsRestart();
                showStatus('vvm-save-status', t('tts.vvm.saved'), 'success');
            } else {
                btn.textContent = t('status.failed');
                showStatus('vvm-save-status', t('tts.vvm.dlFail') + result.error, 'error');
            }
        });
    });
}

document.getElementById('btn-save-vvm')?.addEventListener('click', async () => {
    const checks = document.querySelectorAll('#vvm-checkboxes input[type=checkbox]:checked');
    const vvmFiles = Array.from(checks).map(c => c.value);
    if (vvmFiles.length === 0) {
        showStatus('vvm-save-status', t('tts.vvm.selectOne'), 'error');
        return;
    }
    // Only save changed vvm list, not the full config
    await window.electronAPI.saveConfig({ tts: { vvmFiles } });
    // Relaunch app to apply VVM changes
    await window.electronAPI.appRelaunch();
});

loadVvmConfig();

// ========== Memory Settings ==========

document.getElementById('btn-save-memory-settings')?.addEventListener('click', async () => {
    const enabled = document.getElementById('memory-enabled')?.checked ?? true;
    const maxMemories = parseInt(document.getElementById('memory-max')?.value || '2000');

    if (petSystem?.memorySystem) {
        petSystem.memorySystem.maxMemories = maxMemories;
        if (!enabled) {
            petSystem.memorySystem.clear();
        }
    }

    await window.electronAPI?.saveConfig({
        memory: { enabled, maxMemories }
    });

    showStatus('memory-settings-status', t('status.saved'), 'success');
});

// ========== Memory System UI ==========

function refreshMemoryUI() {
    if (!petSystem?.memorySystem) {
        document.getElementById('memory-status').textContent = 'Memory system not initialized';
        return;
    }

    const stats = petSystem.memorySystem.getStats();
    document.getElementById('memory-total').textContent = stats.totalMemories;
    document.getElementById('memory-embedded').textContent = `${stats.todayMemories} / ${stats.weekMemories}`;

    const recent = petSystem.memorySystem.getRecentMemories(20);
    const listEl = document.getElementById('memory-list');

    if (recent.length === 0) {
        listEl.innerHTML = '<p class="model-info" data-i18n="memory.empty">No memories yet. Start chatting with your pet!</p>';
        applyI18n();
        return;
    }

    listEl.innerHTML = recent.reverse().map(m => {
        const time = new Date(m.timestamp).toLocaleString();
        const role = m.role === 'user' ? '👤' : '🤖';
        const content = m.content.length > 100 ? m.content.substring(0, 100) + '...' : m.content;
        const keywords = m.keywords?.slice(0, 5).join(', ') || '';
        return `<div style="margin-bottom:8px; padding:8px; background:#f5f5f5; border-radius:4px;">
            <div style="font-size:11px; color:#666; margin-bottom:4px;">${role} ${time}</div>
            <div style="font-size:13px; margin-bottom:4px;">${content}</div>
            ${keywords ? `<div style="font-size:10px; color:#999;">🏷️ ${keywords}</div>` : ''}
        </div>`;
    }).join('');
}

document.getElementById('btn-refresh-memory')?.addEventListener('click', () => {
    refreshMemoryUI();
    showStatus('memory-status', 'Refreshed', 'success');
});

document.getElementById('btn-export-memory')?.addEventListener('click', () => {
    if (!petSystem?.memorySystem) return;
    const data = petSystem.memorySystem.exportMemories();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `memory-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus('memory-status', 'Exported successfully', 'success');
});

document.getElementById('btn-import-memory')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        if (petSystem?.memorySystem?.importMemories(text)) {
            refreshMemoryUI();
            showStatus('memory-status', 'Imported successfully', 'success');
        } else {
            showStatus('memory-status', 'Import failed', 'error');
        }
    };
    input.click();
});

document.getElementById('btn-clear-memory')?.addEventListener('click', () => {
    if (!confirm('Clear all memories? This cannot be undone.')) return;
    if (petSystem?.memorySystem) {
        petSystem.memorySystem.clear();
        refreshMemoryUI();
        showStatus('memory-status', 'All memories cleared', 'success');
    }
});

// ========== Max Tokens Multiplier ==========

function loadTokenMultiplierUI(multiplier) {
    updateTokenButtons(multiplier);
    updateTokenInfo(multiplier);
}

function updateTokenButtons(multiplier) {
    document.querySelectorAll('.token-mult-btn').forEach(btn => {
        const val = parseFloat(btn.dataset.mult);
        btn.className = val === multiplier
            ? 'btn btn-primary btn-sm token-mult-btn'
            : 'btn btn-secondary btn-sm token-mult-btn';
    });
}

function updateTokenInfo(multiplier) {
    const el = document.getElementById('token-info');
    if (el) {
        const tokens = Math.round(2048 * multiplier);
        el.textContent = t('enhance.tokens.info').replace('{0}', tokens).replace('{1}', multiplier);
    }
}

document.querySelectorAll('.token-mult-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const mult = parseFloat(btn.dataset.mult);
        if (petSystem && petSystem.aiClient) {
            petSystem.aiClient.maxTokensMultiplier = mult;
            petSystem.aiClient.saveConfig({ maxTokensMultiplier: mult });
        }
        updateTokenButtons(mult);
        updateTokenInfo(mult);
    });
});

// ========== Enhance Master Toggle ==========

function loadEnhanceToggle(enhance) {
    document.getElementById('enhance-enabled').checked = enhance.enabled || false;
}

document.getElementById('enhance-enabled').addEventListener('change', async () => {
    const enabled = document.getElementById('enhance-enabled').checked;
    await window.electronAPI.saveConfig({ enhance: { enabled } });
});
