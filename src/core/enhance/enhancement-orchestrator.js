/**
 * Enhancement Orchestrator — Coordinates memory, search, knowledge, VLM
 *
 * New architecture: VLM is the single compression point.
 * Long-term data (memory, search, knowledge) is gathered and fed TO the VLM,
 * which outputs a compressed ~200 char situation per window title.
 * Main AI only sees this single situation buffer — no multi-section context.
 */
class EnhancementOrchestrator {
    constructor(aiClient) {
        this.aiClient = aiClient;
        this.shortPool = new ShortTermPool();
        this.longPool = new LongTermPool();
        this.memoryTracker = new MemoryTracker(this.shortPool, this.longPool);
        this.searchService = new SearchService();
        this.knowledgeStore = new KnowledgeStore(this.shortPool, this.longPool, aiClient);
        this.vlmExtractor = new VLMExtractor(this.shortPool, this.longPool, aiClient);
        this.knowledgeAcq = typeof KnowledgeAcquisition !== 'undefined'
            ? new KnowledgeAcquisition(this.shortPool, this.longPool, aiClient, this.searchService)
            : null;

        this._lastSearchTime = 0;
        this._maxSearchFrequencyMs = 30000;
        this._minFocusSeconds = 10;
        this._lastTitle = null;
    }

    async init() {
        try {
            if (window.electronAPI?.loadConfig) {
                const config = await window.electronAPI.loadConfig();
                const enhance = config.enhance || {};
                this.memoryTracker.configure(enhance.memory || {});
                this.searchService.configure(enhance.search || {});
                this.knowledgeStore.configure(enhance.knowledge || {});
                this.vlmExtractor.configure(enhance.vlm || {});
                if (this.knowledgeAcq) this.knowledgeAcq.configure(enhance.knowledgeAcq || {});
                this._maxSearchFrequencyMs = enhance.search?.maxFrequencyMs || 30000;
                this._minFocusSeconds = enhance.search?.minFocusSeconds || 10;
            }
            await this.longPool.load();
            if (this.knowledgeAcq) await this.knowledgeAcq.init();
            this.memoryTracker.start();
            console.log('[Enhance:Orchestrator] Initialized');
        } catch (e) {
            console.warn('[Enhance:Orchestrator] Init error:', e.message);
        }
    }

    onFocusTick(title) {
        this.memoryTracker.recordFocus(title);
    }

    async beforeRequest(title, screenshotBase64 = null) {
        if (!title) return '';

        // Publish current session data to short pool
        this.memoryTracker.publishToShortPool();

        const todayData = this.shortPool.get('memory.today');
        const focusTime = todayData?.[title] || 0;
        const safeTitle = sanitizeSecrets(title);

        // Background: trigger search if needed (results feed into VLM via long-term)
        if (this._shouldSearch(title)) {
            const result = await this.searchService.search(safeTitle);
            if (result.success) {
                this.shortPool.set('search.results', result.results);
                this.shortPool.set('search.lastQuery', title);
                this._lastSearchTime = Date.now();
                this.longPool.setForTitle(title, 'search', {
                    results: result.results.slice(0, 500),
                    cachedAt: Date.now()
                });
                await this.knowledgeStore.maybeUpdate(title, result.results);
            }
        }

        this._lastTitle = title;

        // Gather long-term context for VLM compression
        const longTermContext = this._gatherLongTermContext(title);

        // VLM extraction — fire-and-forget, feeds long-term context for filtering
        if (screenshotBase64) {
            this.vlmExtractor.maybeExtract(title, screenshotBase64, longTermContext).catch(e => {
                console.warn('[Enhance:Orchestrator] VLM extract error:', e.message);
            });
        }

        // Knowledge acquisition — fire-and-forget
        if (this.knowledgeAcq?.enabled) {
            const vlmSituation = this.vlmExtractor.getSituation(title);
            if (vlmSituation && focusTime >= this.knowledgeAcq.minFocusSeconds) {
                this.knowledgeAcq.maybeAcquire(title, vlmSituation, focusTime).catch(e =>
                    console.warn('[Enhance:KBAcq] error:', e.message));
            }
            this.knowledgeAcq.processQueue(2).catch(e =>
                console.warn('[Enhance:KBAcq] queue error:', e.message));
        }

        // Flush long pool periodically
        if (this.longPool.isDirty) {
            await this.longPool.flush();
        }

        return this.buildEnhancedContext(title);
    }

    /**
     * Gather long-term data to feed to VLM for compression.
     * This is the "raw material" that VLM will filter and compress.
     */
    _gatherLongTermContext(title) {
        const parts = [];

        // Today's activity summary
        const today = this.shortPool.get('memory.today');
        if (today && Object.keys(today).length > 0) {
            const top = Object.entries(today)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([t, s]) => `${compactTitle(t)}: ${s}s`)
                .join(', ');
            parts.push(`Activity: ${top}`);
        }

        // RAG knowledge hits
        const knowledgeHits = this.longPool.query(title, { layer: 'knowledge', maxResults: 3, minConfidence: 0.3 });
        if (knowledgeHits.length > 0) {
            const kText = knowledgeHits.map(h => h.data.summary).join('; ').slice(0, 300);
            parts.push(`Knowledge: ${kText}`);
        }

        // Cached search results
        const searchResults = this.shortPool.get('search.results');
        if (searchResults) {
            parts.push(`Search: ${searchResults.slice(0, 300)}`);
        } else {
            const cachedHits = this.longPool.query(title, { layer: 'search', maxResults: 1, minConfidence: 0.3 });
            if (cachedHits.length > 0) {
                parts.push(`Search: ${cachedHits[0].data.results.slice(0, 300)}`);
            }
        }

        // Acquired knowledge
        const acquiredHits = this.longPool.query(title, { layer: 'acquired', maxResults: 3, minConfidence: 0.3 });
        if (acquiredHits.length > 0) {
            const aText = acquiredHits.map(h => h.data.summary).join('; ').slice(0, 200);
            parts.push(`Acquired: ${aText}`);
        }

        return parts.length > 0 ? parts.join('\n') : '';
    }

    _shouldSearch(title) {
        if (!this.searchService.enabled) return false;
        if (Date.now() - this._lastSearchTime < this._maxSearchFrequencyMs) return false;
        if (isNoiseTitle(title)) return false;
        const focusTime = this.shortPool.get('memory.today')?.[title] || 0;
        if (focusTime < this._minFocusSeconds) return false;
        if (title === this.shortPool.get('search.lastQuery')) return false;
        const existing = this.longPool.query(title, { layer: 'knowledge', maxResults: 1 });
        if (existing.length > 0 && existing[0].confidence > 0.7) return false;
        return true;
    }

    /**
     * Build enhanced context for main AI — single situation buffer.
     * Focus-based switching: if current window has low focus, keep previous situation.
     * Includes relative timestamp so AI knows freshness.
     */
    buildEnhancedContext(title) {
        const focusTime = this.shortPool.get('memory.today')?.[title] || 0;
        let meta = this.vlmExtractor.getSituationMeta(title);

        // Low focus on current window — fall back to most recent valid situation
        if (!meta && focusTime < this._minFocusSeconds) {
            const recent = this.vlmExtractor.getMostRecent();
            if (recent) meta = recent;
        }

        if (!meta) return '';

        const ageSec = Math.round((Date.now() - meta.timestamp) / 1000);
        const ageStr = ageSec < 60 ? `${ageSec}${enhanceT('sys.secsAgo')}`
            : `${Math.round(ageSec / 60)}${enhanceT('sys.minsAgo')}`;
        const label = enhanceT('sys.screenContent');
        return sanitizeSecrets(`\n[${label} (${ageStr})] ${meta.situation}`);
    }

    async stop() {
        this.memoryTracker.stop();
        this.vlmExtractor.pruneLongTerm();
        await this.longPool.flush();
        console.log('[Enhance:Orchestrator] Stopped');
    }

    async reloadConfig() {
        if (window.electronAPI?.loadConfig) {
            const config = await window.electronAPI.loadConfig();
            const enhance = config.enhance || {};
            this.memoryTracker.configure(enhance.memory || {});
            this.searchService.configure(enhance.search || {});
            this.knowledgeStore.configure(enhance.knowledge || {});
            this.vlmExtractor.configure(enhance.vlm || {});
            if (this.knowledgeAcq) this.knowledgeAcq.configure(enhance.knowledgeAcq || {});
            this._maxSearchFrequencyMs = enhance.search?.maxFrequencyMs || 30000;
            this._minFocusSeconds = enhance.search?.minFocusSeconds || 10;
        }
    }
}

if (typeof window !== 'undefined') window.EnhancementOrchestrator = EnhancementOrchestrator;
