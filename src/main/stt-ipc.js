/**
 * STT IPC — Speech-to-text via OpenAI-compatible /audio/transcriptions endpoint.
 */
const OPENAI_STT_BASE_URL = 'https://api.openai.com/v1';

function normalizeBaseURL(url) {
    return String(url || '').trim().replace(/\/$/, '');
}

function isOpenAIBaseURL(url) {
    return normalizeBaseURL(url).toLowerCase() === OPENAI_STT_BASE_URL;
}

function normalizeSTTLanguage(language) {
    if (typeof language !== 'string') return '';
    const raw = language.trim();
    if (!raw) return '';

    const normalized = raw.toLowerCase().replace('_', '-');
    const commonMap = {
        'zh-cn': 'zh',
        'zh-tw': 'zh',
        'en-us': 'en',
        'en-gb': 'en',
        'ja-jp': 'ja'
    };
    if (commonMap[normalized]) return commonMap[normalized];
    if (/^[a-z]{2,3}$/.test(normalized)) return normalized;

    const match = normalized.match(/^([a-z]{2,3})-[a-z0-9-]+$/);
    if (match) return match[1];
    return raw;
}

function getAudioFileName(mimeType) {
    if (typeof mimeType !== 'string') return 'speech.webm';
    const lower = mimeType.toLowerCase();
    if (lower.includes('mp4') || lower.includes('m4a')) return 'speech.m4a';
    if (lower.includes('wav')) return 'speech.wav';
    if (lower.includes('mpeg') || lower.includes('mp3')) return 'speech.mp3';
    return 'speech.webm';
}

function parseAPIError(text) {
    if (!text) return { code: '', message: '' };
    try {
        const parsed = JSON.parse(text);
        const code = parsed?.error?.code || '';
        const message = parsed?.error?.message || '';
        return { code: String(code), message: String(message) };
    } catch {
        return { code: '', message: String(text) };
    }
}

function isModelNotFound(status, errorCode, errorMessage, rawText) {
    const merged = `${errorCode} ${errorMessage} ${rawText}`.toLowerCase();
    return status === 404 || merged.includes('model_not_found') || merged.includes('model not found') || merged.includes('无可用渠道');
}

function registerSTTIPC(ctx, ipcMain, deps) {
    // deps: { configManager }
    const { configManager } = deps;

    ipcMain.handle('stt-transcribe', async (event, payload = {}) => {
        try {
            const audioBase64 = payload.audioBase64;
            const mimeType = payload.mimeType || 'audio/webm';
            const language = normalizeSTTLanguage(payload.language);
            if (!audioBase64) return { success: false, error: 'empty_audio' };

            const config = await configManager.loadConfigFile();
            const stt = config.speechToText || {};
            const sttApiKey = String(stt.apiKey || '').trim();
            const mainApiKey = String(config.apiKey || '').trim();
            const apiKey = sttApiKey || mainApiKey;

            const sttBaseURL = normalizeBaseURL(stt.baseURL);
            const mainBaseURL = normalizeBaseURL(config.baseURL);
            const sttUsesDefaultOrEmpty = !sttBaseURL || isOpenAIBaseURL(sttBaseURL);
            const shouldReuseMainBase = !sttApiKey && sttUsesDefaultOrEmpty && mainBaseURL && !isOpenAIBaseURL(mainBaseURL);
            const baseURL = shouldReuseMainBase
                ? mainBaseURL
                : (sttBaseURL || mainBaseURL || OPENAI_STT_BASE_URL);

            const explicitModelName = String(stt.modelName || '').trim();
            const modelCandidates = explicitModelName
                ? [explicitModelName]
                : ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'];

            if (!apiKey) return { success: false, error: 'api_not_configured' };

            const audioBuffer = Buffer.from(audioBase64, 'base64');
            if (!audioBuffer.length) return { success: false, error: 'empty_audio' };

            const blob = new Blob([audioBuffer], { type: mimeType });
            let lastFailure = '';
            let modelNotFoundCount = 0;

            for (const modelName of modelCandidates) {
                const form = new FormData();
                form.append('file', blob, getAudioFileName(mimeType));
                form.append('model', modelName);
                if (language) form.append('language', language);

                const response = await fetch(`${baseURL}/audio/transcriptions`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: form
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    const parsed = parseAPIError(errorText);
                    const detail = `API ${response.status}: ${errorText}`;
                    lastFailure = detail;

                    if (isModelNotFound(response.status, parsed.code, parsed.message, errorText)) {
                        modelNotFoundCount++;
                        continue;
                    }
                    return { success: false, error: detail };
                }

                const contentType = response.headers.get('content-type') || '';
                let text = '';
                if (contentType.includes('application/json')) {
                    const data = await response.json();
                    text = (data?.text || '').trim();
                } else {
                    text = (await response.text()).trim();
                }

                if (!text) return { success: false, error: 'empty_transcript' };
                return { success: true, text };
            }

            if (modelNotFoundCount === modelCandidates.length) {
                return { success: false, error: 'stt_model_not_found' };
            }
            return { success: false, error: lastFailure || 'stt_failed' };
        } catch (error) {
            return { success: false, error: error.message || String(error) };
        }
    });
}

module.exports = { registerSTTIPC };
