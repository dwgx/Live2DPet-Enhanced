/**
 * VLM Extractor — Compressed situation buffer via vision LLM
 *
 * Architecture:
 *   Independent capture: own 3s timer → electronAPI.getScreenCapture()
 *   Mipmap ring buffer: 3 levels with cascading downsample
 *     L0 (2 entries, full res) → L1 (2 entries, 50%) → L2 (1 entry, 25%)
 *   Short-term: situationMap { title → { situation, timestamp, focusSec } }
 *     - Top-K entries (K=10), LRU eviction
 *   Promotion: focusSec > threshold → persist to LongTermPool
 *   Situation history: recent situations for continuity reference
 */
class VLMExtractor {
    constructor(shortPool, longPool, aiClient) {
        this.shortPool = shortPool;
        this.longPool = longPool;
        this.aiClient = aiClient;
        this.enabled = false;
        this.baseIntervalMs = 15000;
        this.maxIntervalMs = 60000;
        this.minFocusSeconds = 10;
        this._lastExtractTime = {};
        this._intervals = {};
        this._extracting = false;

        // Short-term situation map
        this.situationMap = {};
        this.maxSituations = 10;
        this.promotionThreshold = 300;
        this.retentionDays = 7;

        // Mipmap screenshot levels: L0 full, L1 half, L2 quarter
        this._mipmapLevels = [
            { maxSize: 2, scale: 1.0, entries: [] },
            { maxSize: 2, scale: 0.5, entries: [] },
            { maxSize: 1, scale: 0.25, entries: [] }
        ];

        // Independent capture timer
        this._captureTimerMs = 3000;
        this._captureTimer = null;
        this._captureActive = false;
        this._contextGatherer = null;

        // Situation history for continuity
        this._situationHistory = [];
        this._maxHistory = 5;
    }

    configure(config) {
        if (config.enabled !== undefined) this.enabled = config.enabled;
        if (config.baseIntervalMs) this.baseIntervalMs = config.baseIntervalMs;
        if (config.maxIntervalMs) this.maxIntervalMs = config.maxIntervalMs;
        if (config.minFocusSeconds) this.minFocusSeconds = config.minFocusSeconds;
        if (config.promotionThreshold) this.promotionThreshold = config.promotionThreshold;
        if (config.retentionDays) this.retentionDays = config.retentionDays;
        if (config.captureTimerMs) this._captureTimerMs = config.captureTimerMs;
    }

    setContextGatherer(fn) { this._contextGatherer = fn; }

    startCapture() {
        this.stopCapture();
        this._captureActive = true;
        if (typeof window !== 'undefined' && window.electronAPI?.getScreenCapture) {
            this._captureTimer = setInterval(() => this._captureTick(), this._captureTimerMs);
            console.log(`[Enhance:VLM] Capture started (${this._captureTimerMs}ms interval)`);
        } else {
            console.log('[Enhance:VLM] Capture started (no electronAPI, timer skipped)');
        }
    }

    stopCapture() {
        if (this._captureTimer) {
            clearInterval(this._captureTimer);
            this._captureTimer = null;
        }
        this._captureActive = false;
        for (const level of this._mipmapLevels) level.entries = [];
        console.log('[Enhance:VLM] Capture stopped, buffer cleared');
    }

    async _captureTick() {
        if (!this._captureActive || !this.enabled) return;
        try {
            const result = await window.electronAPI.getActiveWindow();
            if (!result?.success || !result.data?.title) return;
            const title = result.data.title;
            if (isNoiseTitle(title)) return;

            const base64 = await window.electronAPI.getScreenCapture();
            if (!base64) return;

            await this.pushScreenshot(base64, title);

            const longTermContext = this._contextGatherer ? this._contextGatherer(title) : '';
            this.maybeExtract(title, base64, longTermContext).catch(e => {
                console.warn('[Enhance:VLM] Auto-extract error:', e.message);
            });
        } catch (e) {
            console.warn('[Enhance:VLM] Capture tick error:', e.message);
        }
    }

    /**
     * Push screenshot into mipmap L0, cascade overflow to L1→L2.
     * Each level downsamples to its target scale (512 * scale).
     */
    async pushScreenshot(base64, title) {
        if (!base64 || !this._captureActive) return;
        const entry = { base64, timestamp: Date.now(), title };
        const L0 = this._mipmapLevels[0];
        L0.entries.push(entry);

        for (let i = 0; i < this._mipmapLevels.length - 1; i++) {
            const current = this._mipmapLevels[i];
            const next = this._mipmapLevels[i + 1];
            while (current.entries.length > current.maxSize) {
                const overflow = current.entries.shift();
                const maxDim = Math.round(512 * next.scale);
                overflow.base64 = await this._downsampleBase64(overflow.base64, maxDim);
                next.entries.push(overflow);
            }
        }
        const last = this._mipmapLevels[this._mipmapLevels.length - 1];
        while (last.entries.length > last.maxSize) {
            last.entries.shift();
        }
    }

    async _downsampleBase64(base64, maxDim) {
        if (typeof document === 'undefined') return base64;
        try {
            return await new Promise((resolve) => {
                const img = new Image();
                img.onload = () => {
                    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
                    if (scale >= 1) { resolve(base64); return; }
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.round(img.width * scale);
                    canvas.height = Math.round(img.height * scale);
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    const result = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
                    canvas.width = canvas.height = 0;
                    resolve(result);
                };
                img.onerror = () => resolve(base64);
                img.src = 'data:image/jpeg;base64,' + base64;
            });
        } catch { return base64; }
    }

    /** Get a previous screenshot for the same title from L1/L2 */
    _getPreviousScreenshot(title) {
        for (let lvl = 1; lvl < this._mipmapLevels.length; lvl++) {
            const entries = this._mipmapLevels[lvl].entries;
            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].title === title) return entries[i];
            }
        }
        return null;
    }

    getBufferSize() {
        return this._mipmapLevels.reduce((sum, lvl) => sum + lvl.entries.length, 0);
    }

    /**
     * Get time-staggered screenshots for main AI.
     * Returns up to maxCount entries from different mipmap levels for temporal spread.
     * L0 = most recent (full res), L1 = older (half res), L2 = oldest (quarter res).
     */
    getScreenshotsForMainAI(maxCount = 3) {
        const result = [];
        for (const level of this._mipmapLevels) {
            if (result.length >= maxCount) break;
            const latest = level.entries[level.entries.length - 1];
            if (latest) result.push(latest);
        }
        return result;
    }

    getSituation(title) {
        const entry = this.situationMap[title];
        if (entry) return entry.situation;
        const persisted = this.longPool.getForTitle(title, 'vlm');
        if (persisted?.situation) return persisted.situation;
        return null;
    }

    getSituationMeta(title) {
        const entry = this.situationMap[title];
        if (entry) return entry;
        const persisted = this.longPool.getForTitle(title, 'vlm');
        if (persisted?.situation) {
            return { situation: persisted.situation, timestamp: persisted.lastUpdated || 0, focusSec: 0 };
        }
        return null;
    }

    getMostRecent() {
        let best = null;
        for (const [title, entry] of Object.entries(this.situationMap)) {
            if (!best || entry.timestamp > best.timestamp) {
                best = { title, situation: entry.situation, timestamp: entry.timestamp };
            }
        }
        return best;
    }

    getRecentHistory(count = 3) {
        return this._situationHistory.slice(-count);
    }

    /**
     * Main extraction — sends current screenshot + optional previous (downsampled).
     */
    async maybeExtract(title, screenshotBase64, longTermContext) {
        if (!this.enabled || !title || !screenshotBase64 || !this.aiClient) return;
        if (this._extracting) { console.log('[Enhance:VLM] Skipped: already extracting'); return; }
        if (isNoiseTitle(title)) { console.log(`[Enhance:VLM] Skipped noise title: "${title.slice(0, 30)}"`); return; }

        const focusTime = this.shortPool.get('memory.today')?.[title] || 0;
        if (focusTime < this.minFocusSeconds) { console.log(`[Enhance:VLM] Skipped: focus ${focusTime}s < ${this.minFocusSeconds}s`); return; }

        const now = Date.now();
        const lastExtract = this._lastExtractTime[title] || 0;
        const interval = this._intervals[title] || this.baseIntervalMs;
        if (now - lastExtract < interval) { console.log(`[Enhance:VLM] Skipped: cooldown ${Math.round((now - lastExtract) / 1000)}s / ${Math.round(interval / 1000)}s`); return; }

        console.log(`[Enhance:VLM] Extracting for: "${title.slice(0, 30)}" focus:${focusTime}s`);

        this._extracting = true;
        try {
            let userText = `Window: ${title}`;
            const prevSituation = this.getSituation(title);
            if (prevSituation) {
                userText += `\nPrevious: ${prevSituation}`;
            }
            if (longTermContext) {
                userText += `\nBackground:\n${longTermContext}`;
            }

            const userContent = [
                { type: 'text', text: userText },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + screenshotBase64 } }
            ];

            // Attach previous screenshot from L1/L2 for temporal comparison
            const prevShot = this._getPreviousScreenshot(title);
            if (prevShot && prevShot.base64 !== screenshotBase64) {
                userContent.push(
                    { type: 'text', text: '(Previous:)' },
                    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + prevShot.base64 } }
                );
            }

            const messages = [
                {
                    role: 'system',
                    content: enhanceT('sys.vlmSituationPrompt').replace('{0}', enhanceLangName())
                },
                { role: 'user', content: userContent }
            ];

            const result = await this.aiClient.callAPI(messages);
            if (result) {
                const situation = result.trim().slice(0, 800);

                if (situation === 'UNCHANGED') {
                    console.log(`[Enhance:VLM] UNCHANGED for: "${title.slice(0, 20)}"`);
                } else if (prevSituation && situation === prevSituation) {
                    console.log(`[Enhance:VLM] Unchanged for: "${title.slice(0, 20)}" — keeping old timestamp`);
                } else {
                    this.situationMap[title] = { situation, timestamp: now, focusSec: focusTime };
                    this.shortPool.set('vlm.situation', situation);

                    // Push to situation history
                    this._situationHistory.push({
                        situation: situation.slice(0, 200),
                        timestamp: now,
                        title: typeof compactTitle !== 'undefined' ? compactTitle(title, 30) : title.slice(0, 30)
                    });
                    while (this._situationHistory.length > this._maxHistory) {
                        this._situationHistory.shift();
                    }

                    if (focusTime >= this.promotionThreshold) {
                        this._promote(title, situation, now);
                        console.log(`[Enhance:VLM] Promoted to long-term: "${title.slice(0, 20)}" (${focusTime}s)`);
                    }
                    this._evictShortTerm();
                    console.log(`[Enhance:VLM] Situation[${title.slice(0, 20)}]: ${situation.slice(0, 80)}`);
                }
            }

            this._intervals[title] = Math.min((interval || this.baseIntervalMs) * 2, this.maxIntervalMs);
        } catch (e) {
            this._intervals[title] = Math.min((this._intervals[title] || this.baseIntervalMs) * 2, this.maxIntervalMs);
            console.warn(`[Enhance:VLM] Failed for "${title}":`, e.message);
        } finally {
            this._lastExtractTime[title] = now;
            this._extracting = false;
        }
    }

    _promote(title, situation, now) {
        const existing = this.longPool.getForTitle(title, 'vlm') || {};
        this.longPool.setForTitle(title, 'vlm', {
            situation, summary: situation.slice(0, 600), enrichedTitle: title,
            lastUpdated: now, updateCount: (existing.updateCount || 0) + 1, promoted: true
        });
    }

    _evictShortTerm() {
        const entries = Object.entries(this.situationMap);
        if (entries.length <= this.maxSituations) return;
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = entries.length - this.maxSituations;
        for (let i = 0; i < toRemove; i++) delete this.situationMap[entries[i][0]];
    }

    pruneLongTerm() {
        const maxAge = this.retentionDays * 86400000;
        const now = Date.now();
        for (const title of this.longPool.getAllTitles()) {
            const vlm = this.longPool.getForTitle(title, 'vlm');
            if (vlm?.lastUpdated && (now - vlm.lastUpdated > maxAge)) {
                this.longPool.setForTitle(title, 'vlm', null);
            }
        }
    }

    resetInterval(title) {
        delete this._intervals[title];
        delete this._lastExtractTime[title];
    }

    _pruneCache(maxEntries = 100) {
        const keys = Object.keys(this._lastExtractTime);
        if (keys.length <= maxEntries) return;
        const sorted = keys.sort((a, b) => (this._lastExtractTime[a] || 0) - (this._lastExtractTime[b] || 0));
        for (let i = 0; i < sorted.length - maxEntries; i++) {
            delete this._lastExtractTime[sorted[i]];
            delete this._intervals[sorted[i]];
        }
    }
}

if (typeof window !== 'undefined') window.VLMExtractor = VLMExtractor;
