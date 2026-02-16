/**
 * Enhancement Orchestrator — Coordinates memory, search, knowledge, VLM
 *
 * New architecture: VLM is the single compression point.
 * Long-term data (memory, search, knowledge) is gathered and fed TO the VLM,
 * which outputs a compressed ~500 char situation per window title.
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
        this._searchedTitles = {};  // {title: timestamp} — per-title search cooldown
        this._searchTitleCooldownMs = 300000; // 5 min per-title cooldown
        this._searchFailCount = 0;
        this._searchFailCooldownMs = 0; // exponential backoff on consecutive failures
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
            this.vlmExtractor.setContextGatherer((title) => this._gatherLongTermContext(title));
            this.vlmExtractor.startCapture();
            console.log('[Enhance:Orchestrator] Initialized — memory:', enhance.memory?.enabled ?? true,
                'search:', enhance.search?.enabled ?? false, 'knowledge:', enhance.knowledge?.enabled ?? false,
                'vlm:', enhance.vlm?.enabled ?? false, 'kbAcq:', enhance.knowledgeAcq?.enabled ?? false);
        } catch (e) {
            console.warn('[Enhance:Orchestrator] Init error:', e.message);
        }
    }

    onFocusTick(title) {
        this.memoryTracker.recordFocus(title);
    }

    async beforeRequest(title, screenshotBase64 = null) {
        if (!title) return '';
        console.log(`[Enhance:Orchestrator] beforeRequest: "${title.slice(0, 40)}" screenshot:${!!screenshotBase64}`);

        // Publish current session data to short pool
        this.memoryTracker.publishToShortPool();

        const todayData = this.shortPool.get('memory.today');
        const focusTime = todayData?.[title] || 0;
        const safeTitle = sanitizeSecrets(title);

        // Background: trigger search if needed (results feed into VLM via long-term)
        if (this._shouldSearch(title)) {
            const cleanQuery = await this._optimizeSearchQuery(title);
            if (cleanQuery) {
                console.log(`[Enhance:Search] Searching: "${cleanQuery}" (from: "${safeTitle.slice(0, 30)}")`);
                const result = await this.searchService.search(cleanQuery);
                if (result.success) {
                    console.log(`[Enhance:Search] Got results: ${result.results.slice(0, 80)}...`);
                    this.shortPool.set('search.results', result.results);
                    this._searchedTitles[title] = Date.now();
                    this.longPool.setForTitle(title, 'search', {
                        results: result.results.slice(0, 800),
                        cachedAt: Date.now()
                    });
                    await this.knowledgeStore.maybeUpdate(title, result.results);
                    this._searchFailCount = 0;
                    this._searchFailCooldownMs = 0;
                } else {
                    // Exponential backoff on consecutive failures: 60s, 120s, 240s, max 600s
                    this._searchFailCount++;
                    this._searchFailCooldownMs = Math.min(60000 * Math.pow(2, this._searchFailCount - 1), 600000);
                    console.log(`[Enhance:Search] Failed (${this._searchFailCount}x), cooldown ${Math.round(this._searchFailCooldownMs / 1000)}s`);
                }
                this._lastSearchTime = Date.now();
            } else {
                // LLM deemed title unsearchable — set per-title cooldown
                this._searchedTitles[title] = Date.now();
                console.log(`[Enhance:Search] Skipped unsearchable: "${safeTitle.slice(0, 30)}"`);
            }
        }

        this._lastTitle = title;

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

        // Today's activity summary (filter noise titles)
        const today = this.shortPool.get('memory.today');
        if (today && Object.keys(today).length > 0) {
            const top = Object.entries(today)
                .filter(([t]) => !isNoiseTitle(t))
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([t, s]) => `${compactTitle(t)}: ${s}s`)
                .join(', ');
            if (top) parts.push(`Activity: ${top}`);
        }

        // RAG knowledge hits
        const knowledgeHits = this.longPool.query(title, { layer: 'knowledge', maxResults: 3, minConfidence: 0.5 });
        if (knowledgeHits.length > 0) {
            const kText = knowledgeHits.map(h => h.data.summary).join('; ').slice(0, 500);
            parts.push(`Knowledge: ${kText}`);
        }

        // Cached search results
        const searchResults = this.shortPool.get('search.results');
        if (searchResults) {
            parts.push(`Search: ${searchResults.slice(0, 500)}`);
        } else {
            const cachedHits = this.longPool.query(title, { layer: 'search', maxResults: 1, minConfidence: 0.5 });
            if (cachedHits.length > 0) {
                parts.push(`Search: ${cachedHits[0].data.results.slice(0, 500)}`);
            }
        }

        // Acquired knowledge
        const acquiredHits = this.longPool.query(title, { layer: 'acquired', maxResults: 3, minConfidence: 0.5 });
        if (acquiredHits.length > 0) {
            const aText = acquiredHits.map(h => h.data.summary).join('; ').slice(0, 400);
            parts.push(`Acquired: ${aText}`);
        }

        return parts.length > 0 ? parts.join('\n') : '';
    }

    _shouldSearch(title) {
        if (!this.searchService.enabled) return false;
        const timeSinceLastSearch = Date.now() - this._lastSearchTime;
        if (timeSinceLastSearch < this._maxSearchFrequencyMs) return false;
        // Failure cooldown — exponential backoff on consecutive failures
        if (this._searchFailCooldownMs > 0 && timeSinceLastSearch < this._searchFailCooldownMs) return false;
        if (isNoiseTitle(title)) return false;
        if (this._isIDETitle(title)) return false;
        const focusTime = this.shortPool.get('memory.today')?.[title] || 0;
        if (focusTime < this._minFocusSeconds) return false;
        // Per-title cooldown
        const lastSearched = this._searchedTitles[title];
        if (lastSearched && Date.now() - lastSearched < this._searchTitleCooldownMs) return false;
        const existing = this.longPool.query(title, { layer: 'knowledge', maxResults: 1 });
        if (existing.length > 0 && existing[0].confidence > 0.7) return false;
        return true;
    }

    /** Detect IDE project titles — web search is useless for local project names */
    _isIDETitle(title) {
        const ideSuffixes = [' - Cursor', ' - VS Code', ' - Visual Studio', ' - IntelliJ',
            ' - WebStorm', ' - Sublime', ' - Atom', ' - Neovim', ' - Vim', ' - Emacs',
            ' - PyCharm', ' - GoLand', ' - CLion', ' - Rider', ' - Android Studio',
            ' - Eclipse', ' - NetBeans', ' - Xcode'];
        const lower = title.toLowerCase();
        return ideSuffixes.some(s => lower.endsWith(s.toLowerCase()));
    }

    /** Use LLM to extract 1-3 short search keywords from a window title */
    async _optimizeSearchQuery(title) {
        if (!this.aiClient) return sanitizeSecrets(compactTitle(title, 60));
        try {
            const prompt = enhanceT('sys.searchQueryPrompt');
            const result = await this.aiClient.callAPI([
                { role: 'system', content: prompt },
                { role: 'user', content: title }
            ]);
            const terms = this._parseJSON(result);
            if (!terms || terms.length === 0) return null;
            return terms.slice(0, 3).join(' ');
        } catch (e) {
            console.warn('[Enhance:Search] Query optimization failed:', e.message);
            return sanitizeSecrets(compactTitle(title, 60));
        }
    }

    _parseJSON(text) {
        if (!text) return null;
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) return parsed;
        } catch {}
        const match = text.match(/\[[\s\S]*?\]/);
        if (match) {
            try { return JSON.parse(match[0]); } catch {}
        }
        return null;
    }

    /**
     * Build enhanced context for main AI — background/dynamic split.
     * age <= 30s → dynamic: [屏幕内容 (Ns前)] — AI should react
     * age 30s–30min → background: [背景信息（无需反应）(Nm前)] — reference only
     * age > 30min → dropped (stale)
     * UNCHANGED → no context output
     * Appends recent situation history for continuity (truncated, deduplicated).
     */
    buildEnhancedContext(title) {
        const focusTime = this.shortPool.get('memory.today')?.[title] || 0;
        let meta = this.vlmExtractor.getSituationMeta(title);

        // Low focus on current window — fall back to most recent valid situation
        if (!meta && focusTime < this._minFocusSeconds) {
            const recent = this.vlmExtractor.getMostRecent();
            if (recent) meta = recent;
        }

        if (!meta || meta.situation === 'UNCHANGED') return '';

        const ageSec = Math.round((Date.now() - meta.timestamp) / 1000);

        // Drop stale situations (>30 min)
        if (ageSec > 1800) return '';

        const ageStr = ageSec < 60 ? `${ageSec}${enhanceT('sys.secsAgo')}`
            : `${Math.round(ageSec / 60)}${enhanceT('sys.minsAgo')}`;

        let ctx;
        if (ageSec <= 30) {
            // Dynamic — AI should consider reacting
            const label = enhanceT('sys.screenContent');
            ctx = `\n[${label} (${ageStr})] ${meta.situation}`;
        } else {
            // Background — reference only, no reaction needed
            const label = enhanceT('sys.backgroundInfo');
            ctx = `\n[${label} (${ageStr})] ${meta.situation}`;
        }

        // Append situation history for continuity (deduplicated by title, truncated, max 30min)
        const history = this.vlmExtractor.getRecentHistory(2);
        const seenTitles = new Set();
        const historyLines = history
            .filter(h => {
                if (h.situation === meta.situation) return false;
                // Deduplicate by title — only keep the most recent entry per title
                if (seenTitles.has(h.title)) return false;
                seenTitles.add(h.title);
                // Skip entries with the same title as the current situation
                if (h.title === (typeof compactTitle !== 'undefined' ? compactTitle(title, 30) : title.slice(0, 30))) return false;
                const hAge = Math.round((Date.now() - h.timestamp) / 1000);
                return hAge <= 1800; // drop stale history too
            })
            .map(h => {
                const hAge = Math.round((Date.now() - h.timestamp) / 1000);
                const hAgeStr = hAge < 60 ? `${hAge}${enhanceT('sys.secsAgo')}`
                    : `${Math.round(hAge / 60)}${enhanceT('sys.minsAgo')}`;
                // Truncate each history entry to 150 chars to save token budget
                const truncated = h.situation.length > 150 ? h.situation.slice(0, 150) + '…' : h.situation;
                return `[${hAgeStr}] ${h.title}: ${truncated}`;
            });
        if (historyLines.length > 0) {
            const histLabel = enhanceT('sys.situationHistory');
            ctx += `\n[${histLabel}] ${historyLines.join(' | ')}`;
        }

        ctx = sanitizeSecrets(ctx);
        console.log(`[Enhance:Orchestrator] Enhanced context (${ctx.length} chars): ${ctx.slice(0, 100)}...`);
        return ctx;
    }

    async stop() {
        this.memoryTracker.stop();
        this.vlmExtractor.stopCapture();
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
