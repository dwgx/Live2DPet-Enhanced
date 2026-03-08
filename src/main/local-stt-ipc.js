/**
 * Local STT IPC (Windows) — Offline speech-to-text using System.Speech.
 */
const { spawn } = require('child_process');

function normalizeCulture(language) {
    const raw = String(language || '').trim().toLowerCase().replace('_', '-');
    if (!raw) return 'zh-CN';
    if (raw.startsWith('zh')) return 'zh-CN';
    if (raw.startsWith('ja')) return 'ja-JP';
    if (raw.startsWith('en')) return 'en-US';
    return language;
}

function buildPowerShellScript(language, timeoutSec) {
    return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$lang = '${language}'
$timeout = [Math]::Max(5, [Math]::Min(45, ${timeoutSec}))
$engine = $null
try {
    $ri = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq $lang } | Select-Object -First 1
    if ($null -eq $ri) {
        Write-Output '__ERR__:language_not_installed'
        exit 2
    }
    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($ri)
    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    # Improve practical dictation accuracy for long/continuous utterances.
    $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(5)
    $engine.BabbleTimeout = [TimeSpan]::FromSeconds(4)
    $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(1500)
    $engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(2200)
    $engine.MaxAlternates = 3
    $engine.SetInputToDefaultAudioDevice()

    $deadline = [DateTime]::UtcNow.AddSeconds($timeout)
    $segments = New-Object System.Collections.Generic.List[string]
    while ([DateTime]::UtcNow -lt $deadline) {
        $left = [Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds)
        if ($left -le 0) { break }
        $slice = [Math]::Min(8, [int]$left)
        $result = $engine.Recognize([TimeSpan]::FromSeconds($slice))
        if ($null -eq $result -or [string]::IsNullOrWhiteSpace($result.Text)) { continue }

        $txt = $result.Text.Trim()
        if (-not [string]::IsNullOrWhiteSpace($txt)) { $segments.Add($txt) }

        # High-confidence sentence: stop early for responsiveness.
        if ($result.Confidence -ge 0.70) { break }
    }

    $finalText = ($segments | Select-Object -Unique) -join ' '
    if ([string]::IsNullOrWhiteSpace($finalText)) {
        Write-Output '__ERR__:no_speech'
        exit 3
    }
    Write-Output ('__OK__:' + $finalText.Trim())
    exit 0
} catch {
    $msg = $_.Exception.Message
    if ($msg -match 'audio' -or $msg -match 'microphone' -or $msg -match 'input') {
        Write-Output '__ERR__:device_unavailable'
        exit 4
    }
    Write-Output ('__ERR__:local_stt_failed::' + $msg)
    exit 1
} finally {
    if ($engine -ne $null) { $engine.Dispose() }
}
`.trim();
}

function parseMarker(output) {
    const lines = String(output || '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.startsWith('__OK__:')) return { ok: true, text: line.slice('__OK__:'.length).trim() };
        if (line.startsWith('__ERR__:')) return { ok: false, error: line.slice('__ERR__:'.length).trim() };
    }
    return null;
}

function registerLocalSTTIPC(ctx, ipcMain) {
    let activeSession = null; // { proc, aborted }

    ipcMain.handle('local-stt-transcribe', async (_, payload = {}) => {
        if (process.platform !== 'win32') return { success: false, error: 'local_stt_unavailable' };
        if (activeSession?.proc) return { success: false, error: 'busy' };

        const language = normalizeCulture(payload.language);
        const timeoutSec = Number.isFinite(Number(payload.timeoutSec)) ? Number(payload.timeoutSec) : 18;
        const script = buildPowerShellScript(language, timeoutSec);
        const encoded = Buffer.from(script, 'utf16le').toString('base64');

        return await new Promise((resolve) => {
            const proc = spawn('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy', 'Bypass',
                '-EncodedCommand', encoded
            ], { windowsHide: true });

            activeSession = { proc, aborted: false };
            let stdout = '';
            let stderr = '';

            proc.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
            proc.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });

            proc.on('error', (err) => {
                activeSession = null;
                resolve({ success: false, error: err?.message || 'local_stt_unavailable' });
            });

            proc.on('close', (code, signal) => {
                const aborted = !!activeSession?.aborted || signal === 'SIGTERM';
                activeSession = null;
                if (aborted) {
                    resolve({ success: false, error: 'aborted' });
                    return;
                }

                const parsed = parseMarker(stdout);
                if (parsed?.ok) {
                    if (!parsed.text) resolve({ success: false, error: 'no_speech' });
                    else resolve({ success: true, text: parsed.text });
                    return;
                }
                if (parsed && !parsed.ok) {
                    const normalizedError = parsed.error.split('::')[0] || 'local_stt_failed';
                    resolve({ success: false, error: normalizedError });
                    return;
                }

                if (code === 0 && String(stdout || '').trim()) {
                    resolve({ success: true, text: String(stdout).trim() });
                    return;
                }

                const detail = String(stderr || stdout || '').trim();
                resolve({ success: false, error: detail || 'local_stt_failed' });
            });
        });
    });

    ipcMain.handle('local-stt-stop', async () => {
        if (!activeSession?.proc) return { success: true, stopped: false };
        activeSession.aborted = true;
        try {
            activeSession.proc.kill();
        } catch (e) {}
        return { success: true, stopped: true };
    });
}

module.exports = { registerLocalSTTIPC };
