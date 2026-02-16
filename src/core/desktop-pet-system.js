/**
 * Standalone Desktop Pet System
 * No game engine dependency - runs independently
 */
class DesktopPetSystem {
    constructor() {
        this.isActive = false;
        this.aiClient = null;
        this.promptBuilder = null;
        this.systemPrompt = null;
        this.detectionInterval = null;
        this.detectionIntervalMs = 30000;
        this.lastAppName = null;
        this.isRequesting = false;
        this.emotionSystem = null;

        // Audio state machine + playback tracking
        this.audioStateMachine = null;
        this.currentAudio = null;
        this.currentAudioUrl = null;
        this.currentSession = null;

        // Screenshot: captured on-demand in sendRequest (VLM captures independently)
        this.screenshotTimer = null; // kept for API compat, unused

        // Window focus tracking (1s sampling, cleared after each AI request)
        this.focusTimer = null;
        this.focusTracker = {};

        // Conversation history buffer (avoid repeating topics)
        this.conversationHistory = [];
        this.maxHistoryPairs = 4;

        // Message double-buffer: always play the latest, skip stale ones
        this.pendingMessage = null;   // next message to play (overwritten by newer)
        this.isPlayingMessage = false; // lock: currently playing a session
        this.chatGapMs = 5000;        // minimum gap between two message sessions

        // Enhancement orchestrator
        this.enhancer = null;
    }

    async init() {
        this.aiClient = new AIChatClient();
        await this.aiClient.init();

        this.promptBuilder = new PetPromptBuilder();
        await this.promptBuilder.init();

        this.systemPrompt = this.promptBuilder.buildSystemPrompt();

        this.emotionSystem = new EmotionSystem(this);
        await this.emotionSystem.loadConfig();

        // Audio state machine
        this.audioStateMachine = new AudioStateMachine();
        await this._initAudioState();

        // Enhancement orchestrator
        if (typeof EnhancementOrchestrator !== 'undefined') {
            this.enhancer = new EnhancementOrchestrator(this.aiClient);
            await this.enhancer.init();
        }

        console.log('[DesktopPetSystem] Initialized');
    }

    async _initAudioState() {
        if (!window.electronAPI) return;
        // Load preferred mode from config
        try {
            const config = await window.electronAPI.loadConfig();
            const mode = config.tts?.audioMode || 'tts';
            this.audioStateMachine.setPreferredMode(mode);
        } catch (e) {}
        // Check TTS availability
        if (window.electronAPI.ttsGetStatus) {
            try {
                const status = await window.electronAPI.ttsGetStatus();
                this.audioStateMachine.setTTSAvailable(status.initialized && !status.degraded);
            } catch (e) {}
        }
        // Load default audio clips
        if (window.electronAPI.loadDefaultAudio) {
            try {
                const result = await window.electronAPI.loadDefaultAudio();
                if (result.success && result.files.length > 0) {
                    const clips = result.files.map(f => {
                        const bytes = Uint8Array.from(atob(f.base64), c => c.charCodeAt(0));
                        const blob = new Blob([bytes], { type: 'audio/wav' });
                        return new Audio(URL.createObjectURL(blob));
                    });
                    this.audioStateMachine.setDefaultAudioAvailable(true, clips);
                }
            } catch (e) {}
        }
        console.log('[DesktopPetSystem] Audio mode:', this.audioStateMachine.effectiveMode);
    }

    async start() {
        if (this.isActive) return;
        if (!this.aiClient.isConfigured()) {
            console.warn('[DesktopPetSystem] API not configured');
            if (window.electronAPI) window.electronAPI.showSettings();
            return;
        }

        try {
            const result = await window.electronAPI.createPetWindow({});
            if (result.success) {
                this.isActive = true;
                this.startDetection();
                this.startFocusTimer();
                this.emotionSystem.start();
                console.log('[DesktopPetSystem] Started');
            }
        } catch (error) {
            console.error('[DesktopPetSystem] Failed to start:', error);
        }
    }

    async stop() {
        if (!this.isActive) return;
        this.stopDetection();
        this.stopFocusTimer();
        this.stopCurrentAudio();
        this.emotionSystem.stop();
        if (this.enhancer) await this.enhancer.stop();
        try {
            await window.electronAPI.closePetWindow();
        } catch (e) {}
        this.isActive = false;
        this.focusTracker = {};
        this.conversationHistory = [];
        this.pendingMessage = null;
        this.isPlayingMessage = false;
        console.log('[DesktopPetSystem] Stopped');
    }

    startDetection() {
        this.stopDetection();
        this.detectionInterval = setInterval(() => this.tick(), this.detectionIntervalMs);
        setTimeout(() => this.tick(), 3000);
        console.log(`[DesktopPetSystem] Detection started, interval: ${this.detectionIntervalMs}ms`);
    }

    stopDetection() {
        if (this.detectionInterval) {
            clearInterval(this.detectionInterval);
            this.detectionInterval = null;
        }
    }

    setInterval(ms) {
        this.detectionIntervalMs = Math.max(10000, ms);
        if (this.isActive) this.startDetection();
    }

    // ========== Focus Tracking (1s) ==========

    startFocusTimer() {
        this.stopFocusTimer();
        this.focusTimer = setInterval(() => this.focusTick(), 1000);
        console.log('[DesktopPetSystem] Focus timer started (1s interval)');
    }

    stopFocusTimer() {
        if (this.focusTimer) {
            clearInterval(this.focusTimer);
            this.focusTimer = null;
        }
    }

    async focusTick() {
        if (!this.isActive) return;
        try {
            const result = await window.electronAPI.getActiveWindow();
            if (!result?.success || !result.data?.owner?.name) return;
            if (this.shouldSkipApp(result.data.owner.name)) return;
            const windowKey = result.data.title || result.data.owner.name;
            if (!this.focusTracker[windowKey]) this.focusTracker[windowKey] = 0;
            this.focusTracker[windowKey] += 1;
            if (this.enhancer) this.enhancer.onFocusTick(windowKey);
        } catch (e) {}
    }

    // ========== Knowledge Layer ==========

    /**
     * i18n helper — delegates to prompt builder's _t()
     */
    _t(key) {
        return this.promptBuilder ? this.promptBuilder._t(key) : key;
    }

    buildDynamicContext() {
        const parts = [];

        // Self-awareness: appearance (know but don't mention)
        parts.push(this._t('sys.selfAwareness'));

        // Window focus tracking summary (top 5) — core focus content
        if (Object.keys(this.focusTracker).length > 0) {
            const secLabel = this._t('sys.seconds');
            const focusEntries = Object.entries(this.focusTracker)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([name, seconds]) => `${this._shortenTitle(name)}: ${seconds}${secLabel}`)
                .join(', ');
            parts.push(this._t('sys.windowUsage') + focusEntries);
        }

        // Anti-repetition: detect repeated patterns in recent assistant responses
        const recentAssistant = this.conversationHistory
            .filter(m => m.role === 'assistant')
            .slice(-3)
            .map(m => m.content);
        if (recentAssistant.length >= 2) {
            const hint = this._detectRepetition(recentAssistant);
            if (hint) parts.push(hint);
        }

        return parts.join('\n');
    }

    /**
     * Detect repeated sentence patterns in recent responses.
     * Returns a hint string if repetition is found, or empty string.
     */
    _detectRepetition(responses) {
        if (responses.length < 2) return '';
        const patterns = [];

        // Check for repeated question marks (rhetorical questions)
        const questionCount = responses.filter(r => r.includes('？') || r.includes('?')).length;
        if (questionCount >= 2) patterns.push(this._t('sys.patternQuestion'));

        // Check for repeated opening words (first 2 chars)
        const openings = responses.map(r => r.slice(0, 2));
        if (openings.length >= 2 && new Set(openings).size === 1) {
            patterns.push(this._t('sys.patternOpening'));
        }

        // Check for repeated sentence-ending patterns (last 4 chars before punctuation)
        const endings = responses.map(r => {
            const clean = r.replace(/[。！？…\s]+$/, '');
            return clean.slice(-4);
        });
        if (endings.length >= 2 && new Set(endings).size === 1) {
            patterns.push(this._t('sys.patternEnding'));
        }

        if (patterns.length > 0) {
            return this._t('sys.antiRepetition').replace('{0}', patterns.join('、'));
        }
        return '';
    }

    // ========== Main Tick & Request ==========

    async tick() {
        if (!this.isActive || this.isRequesting || !this.aiClient.isConfigured()) return;

        try {
            const result = await window.electronAPI.getActiveWindow();
            if (!result?.success || !result.data?.owner?.name) return;

            if (this.shouldSkipApp(result.data.owner.name)) return;

            const windowTitle = result.data.title || result.data.owner.name;
            const bounds = result.data.bounds;
            this.lastAppName = windowTitle;
            await this.sendRequest(windowTitle, bounds);
        } catch (error) {
            console.error('[DesktopPetSystem] Tick error:', error);
        }
    }

    stopCurrentAudio() {
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }
        if (this.currentAudioUrl) {
            URL.revokeObjectURL(this.currentAudioUrl);
            this.currentAudioUrl = null;
        }
    }

    /**
     * Prepare audio for playback (synthesis/loading phase).
     * Returns { play: () => Promise<void>, duration: number } or null.
     */
    async prepareAudio(text) {
        if (!this.audioStateMachine) return null;
        const mode = this.audioStateMachine.effectiveMode;

        if (mode === 'tts' && window.electronAPI?.ttsSynthesize) {
            try {
                const result = await window.electronAPI.ttsSynthesize(text);
                if (!result.success || !result.wav) return null;

                const audio = this._createAudioFromBase64(result.wav);
                // Wait for metadata to get duration
                const duration = await new Promise((resolve, reject) => {
                    audio.addEventListener('loadedmetadata', () => resolve(audio.duration * 1000));
                    audio.addEventListener('error', () => reject(new Error('audio load failed')));
                });

                return {
                    duration,
                    play: () => this._playPreparedAudio(audio)
                };
            } catch (e) {
                console.warn('[TTS] Prepare failed:', e.message);
                return null;
            }
        } else if (mode === 'default-audio') {
            const clip = this.audioStateMachine.getRandomClip();
            if (!clip) return null;
            const audio = clip.cloneNode();
            return {
                duration: 0, // unknown for default clips
                play: () => this._playPreparedAudio(audio)
            };
        }
        return null; // silent
    }

    _createAudioFromBase64(base64) {
        const wavBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const blob = new Blob([wavBytes], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio._objectUrl = url;
        return audio;
    }

    /**
     * Play a prepared Audio element. Returns Promise that resolves when playback ends.
     */
    _playPreparedAudio(audio) {
        this.stopCurrentAudio();
        this.currentAudio = audio;
        this.currentAudioUrl = audio._objectUrl || null;
        return new Promise(resolve => {
            audio.addEventListener('ended', () => { this.stopCurrentAudio(); resolve(); });
            audio.addEventListener('error', () => { this.stopCurrentAudio(); resolve(); });
            audio.play().catch(() => { this.stopCurrentAudio(); resolve(); });
        });
    }

    shouldSkipApp(appName) {
        const skip = ['desktop-pet', 'electron'];
        return skip.some(s => appName.toLowerCase().includes(s));
    }

    /**
     * Shorten a window title for prompt use.
     * Strips common browser/app suffixes and truncates.
     */
    _shortenTitle(title, maxLen = 30) {
        if (!title) return '';
        // Strip trailing " - AppName" patterns (browser suffixes, IDE names, etc.)
        let short = title.replace(/\s*[-–—]\s*(?:Google Chrome|Microsoft\s*Edge|Firefox|Brave|Opera|Safari|Cursor|Visual Studio Code|VSCode|Code)$/i, '');
        if (short.length > maxLen) short = short.slice(0, maxLen) + '…';
        return short;
    }

    // ========== Message Double-Buffer ==========

    /**
     * Log the full request text (system prompt + history + user message),
     * stripping base64 image data for readability.
     */
    _logRequestText(messages) {
        const lines = messages.map(m => {
            const role = m.role;
            let text;
            if (typeof m.content === 'string') {
                text = m.content;
            } else if (Array.isArray(m.content)) {
                text = m.content
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join(' ');
                const imgCount = m.content.filter(c => c.type === 'image_url').length;
                if (imgCount > 0) text += ` [+${imgCount} image(s)]`;
            } else {
                text = JSON.stringify(m.content);
            }
            return `[${role}] ${text}`;
        });
        console.log(`[DesktopPetSystem] === Request (${messages.length} messages) ===\n${lines.join('\n')}`);
    }

    async _processQueue() {
        if (this.isPlayingMessage) return;
        this.isPlayingMessage = true;

        while (this.pendingMessage && this.isActive) {
            // Grab latest and clear the slot
            const text = this.pendingMessage;
            this.pendingMessage = null;

            if (this.currentSession) this.currentSession.cancel();
            this.stopCurrentAudio();
            if (this.emotionSystem) this.emotionSystem.forceRevert();

            const session = MessageSession.create(text);
            this.currentSession = session;
            await session.run(this);

            // Wait minimum gap before playing next message
            if (this.chatGapMs > 0 && this.pendingMessage) {
                await new Promise(r => setTimeout(r, this.chatGapMs));
            }
        }

        this.isPlayingMessage = false;
    }

    async sendRequest(appName, bounds) {
        if (this.isRequesting) return;
        this.isRequesting = true;

        try {
            // Fetch all open windows for layout context
            let layoutSummary = '';
            if (window.electronAPI?.getOpenWindows) {
                try {
                    const winResult = await window.electronAPI.getOpenWindows();
                    if (winResult?.success && winResult.data.length > 0) {
                        const lines = winResult.data
                            .filter(w => {
                                if (!w.owner?.name || this.shouldSkipApp(w.owner.name)) return false;
                                // Skip minimized windows (taskbar button size)
                                const b = w.bounds;
                                return b && b.width > 200 && b.height > 200;
                            })
                            .slice(0, 5)
                            .map(w => {
                                const b = w.bounds;
                                const size = b ? `${b.width}x${b.height}` : '?';
                                return `${this._shortenTitle(w.title || w.owner.name)} [${size}]`;
                            });
                        if (lines.length > 2) {
                            layoutSummary = '\n' + this._t('sys.windowLayout') + lines.join(', ');
                        }
                    }
                } catch (e) {}
            }

            // System idle time (seconds since last keyboard/mouse input)
            let idleInfo = '';
            if (window.electronAPI?.getSystemIdleTime) {
                try {
                    const idleSec = await window.electronAPI.getSystemIdleTime();
                    if (idleSec >= 10) {
                        idleInfo = '\n' + this._t('sys.userIdle').replace('{0}', idleSec);
                    }
                } catch (e) {}
            }

            // Pet window position (for self-identification in screenshots)
            let petPosInfo = '';
            if (window.electronAPI?.getWindowBounds) {
                try {
                    const pb = await window.electronAPI.getWindowBounds();
                    if (pb) {
                        petPosInfo = '\n' + this._t('sys.petPosition')
                            .replace('{x}', pb.x).replace('{y}', pb.y)
                            .replace('{w}', pb.width).replace('{h}', pb.height);
                    }
                } catch (e) {}
            }

            // Build fresh system prompt with dynamic context
            // Focus content first: enhanced context (VLM situation) → window usage
            // Meta info last: emotion, layout, idle, position
            let enhancedContext = '';
            if (this.enhancer) {
                enhancedContext = await this.enhancer.beforeRequest(appName, null);
                if (enhancedContext) console.log('[DesktopPetSystem] Enhanced context:', enhancedContext);
            }
            let metaInfo = '';
            if (this.emotionSystem) {
                const nextEmotion = this.emotionSystem.nextEmotionBuffer;
                if (nextEmotion) {
                    metaInfo += '\n' + this._t('sys.toneHint').replace('{0}', nextEmotion);
                }
            }
            metaInfo += layoutSummary + idleInfo + petPosInfo;
            const dynamicContext = enhancedContext + '\n' + this.buildDynamicContext() + metaInfo;
            const currentSystemPrompt = this.promptBuilder.buildSystemPrompt(dynamicContext);

            const boundsInfo = bounds ? ` [${bounds.width}x${bounds.height}]` : '';
            const textPrompt = this.promptBuilder.getAppDetectionPrompt(this._shortenTitle(appName, 50) + boundsInfo);

            // Gather screenshots: fresh capture + older ones from VLM mipmap for temporal spread
            // When VLM is active with a valid situation, limit to 2 screenshots (fresh + 1 older)
            const screenshots = [];
            const vlmHasSituation = this.enhancer?.vlmExtractor?.getSituation(appName);
            const maxScreenshots = vlmHasSituation ? 2 : 3;
            if (window.electronAPI?.getScreenCapture) {
                try {
                    const fresh = await window.electronAPI.getScreenCapture();
                    if (fresh) screenshots.push({ base64: fresh, timestamp: Date.now() });
                } catch (e) {}
            }
            // Add older screenshots from VLM's mipmap (L1/L2, already downsampled)
            if (this.enhancer?.vlmExtractor) {
                const older = this.enhancer.vlmExtractor.getScreenshotsForMainAI(2);
                for (const entry of older) {
                    // Skip if same as fresh capture (L0 latest ≈ fresh)
                    if (screenshots.length > 0 && entry.base64 === screenshots[0].base64) continue;
                    if (screenshots.length < maxScreenshots) screenshots.push(entry);
                }
            }

            // Build messages: system + history + current user message
            const messages = [
                { role: 'system', content: currentSystemPrompt },
                ...this.conversationHistory
            ];

            let response;
            const hasScreenshots = screenshots.length > 0;

            if (hasScreenshots) {
                const now = new Date();
                const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
                const userContent = [
                    { type: 'text', text: `[${timeStr}] ${textPrompt}${this._t('sys.screenshotAttached')}` }
                ];
                for (const shot of screenshots) {
                    userContent.push({
                        type: 'image_url',
                        image_url: { url: 'data:image/jpeg;base64,' + shot.base64 }
                    });
                }

                messages.push({ role: 'user', content: userContent });
                this._logRequestText(messages);
                response = await this.aiClient.callAPI(messages);
            } else {
                // No new screenshots — use idle prompt with timestamp
                const now = new Date();
                const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
                const idlePrompt = this.promptBuilder.getIdlePrompt();
                messages.push({ role: 'user', content: `[${timeStr}] ${idlePrompt}` });
                this._logRequestText(messages);
                response = await this.aiClient.callAPI(messages);
            }

            if (response) {
                // Append to conversation history (text-only summary for user turn)
                const userSummary = hasScreenshots
                    ? this._t('sys.historyScreenshot').replace('{0}', appName)
                    : this._t('sys.historyUsing').replace('{0}', appName);
                this.conversationHistory.push(
                    { role: 'user', content: userSummary },
                    { role: 'assistant', content: response }
                );
                // Keep only last N pairs
                while (this.conversationHistory.length > this.maxHistoryPairs * 2) {
                    this.conversationHistory.splice(0, 2);
                }

                // Double-buffer: overwrite pending with latest
                this.pendingMessage = response;
                this._processQueue();
            }

            // Clear focus tracker after each AI request
            this.focusTracker = {};

        } catch (error) {
            console.error('[DesktopPetSystem] Request failed:', error);
        } finally {
            this.isRequesting = false;
        }
    }
}

window.DesktopPetSystem = DesktopPetSystem;
