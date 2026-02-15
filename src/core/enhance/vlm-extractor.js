/**
 * VLM Extractor — Compressed situation buffer via vision LLM
 *
 * Architecture:
 *   Short-term: situationMap { title → { situation, timestamp, focusSec } }
 *     - Top-K entries kept in memory (K=10), LRU eviction
 *     - Current title's situation is fed to main AI
 *   Promotion: when focusSec exceeds promotionThreshold (300s),
 *     the entry is persisted to LongTermPool for cross-session reuse.
 *   Long-term eviction: entries older than retentionDays are pruned on flush.
 *
 * Uses keyword filtering via prompt to discard irrelevant accumulated knowledge.
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

        // Short-term situation map: top-K window situations
        this.situationMap = {};
        this.maxSituations = 10;
        this.promotionThreshold = 300; // seconds before persisting
        this.retentionDays = 7;
    }

    configure(config) {
        if (config.enabled !== undefined) this.enabled = config.enabled;
        if (config.baseIntervalMs) this.baseIntervalMs = config.baseIntervalMs;
        if (config.maxIntervalMs) this.maxIntervalMs = config.maxIntervalMs;
        if (config.minFocusSeconds) this.minFocusSeconds = config.minFocusSeconds;
        if (config.promotionThreshold) this.promotionThreshold = config.promotionThreshold;
        if (config.retentionDays) this.retentionDays = config.retentionDays;
    }

    /**
     * Get situation for a title — check short-term map first, then long-term.
     * @returns {string|null}
     */
    getSituation(title) {
        const entry = this.situationMap[title];
        if (entry) return entry.situation;
        // Fallback: check persisted long-term
        const persisted = this.longPool.getForTitle(title, 'vlm');
        if (persisted?.situation) return persisted.situation;
        return null;
    }

    /**
     * Get situation with metadata (timestamp) for a title.
     * @returns {{ situation: string, timestamp: number, focusSec: number }|null}
     */
    getSituationMeta(title) {
        const entry = this.situationMap[title];
        if (entry) return entry;
        const persisted = this.longPool.getForTitle(title, 'vlm');
        if (persisted?.situation) {
            return { situation: persisted.situation, timestamp: persisted.lastUpdated || 0, focusSec: 0 };
        }
        return null;
    }

    /**
     * Get the most recently updated situation across all titles.
     * @returns {{ title: string, situation: string, timestamp: number }|null}
     */
    getMostRecent() {
        let best = null;
        for (const [title, entry] of Object.entries(this.situationMap)) {
            if (!best || entry.timestamp > best.timestamp) {
                best = { title, situation: entry.situation, timestamp: entry.timestamp };
            }
        }
        return best;
    }

    /**
     * Main entry — called by orchestrator with long-term context
     * @param {string} title - current focused window title
     * @param {string|null} screenshotBase64 - latest screenshot
     * @param {string} longTermContext - pre-gathered memory/knowledge data
     */
    async maybeExtract(title, screenshotBase64, longTermContext) {
        if (!this.enabled || !title || !screenshotBase64 || !this.aiClient) return;
        if (this._extracting) return;
        if (isNoiseTitle(title)) return;

        const focusTime = this.shortPool.get('memory.today')?.[title] || 0;
        if (focusTime < this.minFocusSeconds) return;

        const now = Date.now();
        const lastExtract = this._lastExtractTime[title] || 0;
        const interval = this._intervals[title] || this.baseIntervalMs;
        if (now - lastExtract < interval) return;

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

            const messages = [
                {
                    role: 'system',
                    content: enhanceT('sys.vlmSituationPrompt').replace('{0}', enhanceLangName())
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: userText },
                        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + screenshotBase64 } }
                    ]
                }
            ];

            const result = await this.aiClient.callAPI(messages);
            if (result) {
                const situation = result.trim().slice(0, 250);

                // Update short-term map
                this.situationMap[title] = {
                    situation,
                    timestamp: now,
                    focusSec: focusTime
                };
                this.shortPool.set('vlm.situation', situation);

                // Promote to long-term if focus exceeds threshold
                if (focusTime >= this.promotionThreshold) {
                    this._promote(title, situation, now);
                }

                // Evict oldest if over capacity
                this._evictShortTerm();

                console.log(`[Enhance:VLM] Situation[${title.slice(0, 20)}]: ${situation.slice(0, 60)}`);
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

    /** Promote a situation entry to LongTermPool for persistence */
    _promote(title, situation, now) {
        const existing = this.longPool.getForTitle(title, 'vlm') || {};
        this.longPool.setForTitle(title, 'vlm', {
            situation,
            summary: situation.slice(0, 200),
            enrichedTitle: title,
            lastUpdated: now,
            updateCount: (existing.updateCount || 0) + 1,
            promoted: true
        });
    }

    /** Evict oldest short-term entries beyond maxSituations */
    _evictShortTerm() {
        const entries = Object.entries(this.situationMap);
        if (entries.length <= this.maxSituations) return;
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = entries.length - this.maxSituations;
        for (let i = 0; i < toRemove; i++) {
            delete this.situationMap[entries[i][0]];
        }
    }

    /** Prune long-term VLM entries older than retentionDays */
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

    /** Cap internal timing maps to prevent unbounded growth */
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
