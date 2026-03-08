/**
 * Memory System - Local long-term memory without external APIs
 * Uses keyword extraction and TF-IDF for similarity search
 */

class MemorySystem {
    constructor(config = {}) {
        this.memories = []; // {id, timestamp, role, content, keywords, metadata}
        this.maxMemories = config.maxMemories || 2000;
        this.shortTermLimit = config.shortTermLimit || 8;
        this.longTermRetrievalLimit = config.longTermRetrievalLimit || 3;
        this.autoSave = config.autoSave !== false;
        this.includeRelevant = config.includeRelevant !== false;
        this.enabled = config.enabled !== false;
        this.stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might', 'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who', 'when', 'where', 'why', 'how']);
    }

    configure(config) {
        if (config.maxMemories !== undefined) this.maxMemories = config.maxMemories;
        if (config.shortTermLimit !== undefined) this.shortTermLimit = config.shortTermLimit;
        if (config.longTermRetrievalLimit !== undefined) this.longTermRetrievalLimit = config.longTermRetrievalLimit;
        if (config.autoSave !== undefined) this.autoSave = config.autoSave;
        if (config.includeRelevant !== undefined) this.includeRelevant = config.includeRelevant;
        if (config.enabled !== undefined) this.enabled = config.enabled;
    }

    extractKeywords(text) {
        // Simple keyword extraction: lowercase, remove punctuation, filter stop words
        const words = text.toLowerCase()
            .replace(/[^\w\s\u4e00-\u9fa5]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 1 && !this.stopWords.has(w));

        // Count frequency
        const freq = {};
        words.forEach(w => freq[w] = (freq[w] || 0) + 1);

        // Return top keywords
        return Object.entries(freq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([word]) => word);
    }

    async addMemory(role, content, metadata = {}) {
        if (!this.enabled) return null;

        const memory = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            timestamp: Date.now(),
            role,
            content,
            keywords: this.extractKeywords(content),
            metadata
        };

        this.memories.push(memory);

        // Trim old memories
        if (this.memories.length > this.maxMemories) {
            this.memories = this.memories.slice(-this.maxMemories);
        }

        // Auto-save to localStorage
        if (this.autoSave) {
            this.saveToStorage();
        }

        return memory.id;
    }

    searchRelevantMemories(query, limit = 5) {
        const queryKeywords = this.extractKeywords(query);
        if (queryKeywords.length === 0) return [];

        // Score each memory by keyword overlap
        const scored = this.memories.map(m => {
            const overlap = m.keywords.filter(k => queryKeywords.includes(k)).length;
            const score = overlap / Math.max(queryKeywords.length, m.keywords.length);
            return { memory: m, score };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

        return scored.map(item => item.memory);
    }

    getRecentMemories(limit = 10) {
        return this.memories.slice(-limit);
    }

    getShortTermContext(limit) {
        return this.memories.slice(-(limit || this.shortTermLimit));
    }

    async getContextForPrompt(userMessage, includeRelevant) {
        if (!this.enabled) return [];

        const shouldIncludeRelevant = includeRelevant !== undefined ? includeRelevant : this.includeRelevant;
        const shortTerm = this.getShortTermContext();

        if (!shouldIncludeRelevant) {
            return shortTerm;
        }

        // Search for relevant long-term memories
        const relevant = this.searchRelevantMemories(userMessage, this.longTermRetrievalLimit);

        // Filter out memories already in short-term
        const shortTermIds = new Set(shortTerm.map(m => m.id));
        const uniqueRelevant = relevant.filter(m => !shortTermIds.has(m.id));

        // Combine: relevant memories + short-term context
        return [...uniqueRelevant, ...shortTerm];
    }

    formatMemoriesForPrompt(memories) {
        return memories.map(m => ({
            role: m.role,
            content: m.content
        }));
    }

    clear() {
        this.memories = [];
        this.saveToStorage();
    }

    saveToStorage() {
        try {
            localStorage.setItem('pet-memories', JSON.stringify({
                memories: this.memories,
                timestamp: Date.now()
            }));
        } catch (e) {
            console.warn('[Memory] Failed to save to localStorage:', e);
        }
    }

    loadFromStorage() {
        try {
            const data = localStorage.getItem('pet-memories');
            if (data) {
                const parsed = JSON.parse(data);
                if (parsed.memories && Array.isArray(parsed.memories)) {
                    this.memories = parsed.memories;
                    console.log(`[Memory] Loaded ${this.memories.length} memories from storage`);
                    return true;
                }
            }
        } catch (e) {
            console.warn('[Memory] Failed to load from localStorage:', e);
        }
        return false;
    }

    exportMemories() {
        return JSON.stringify({
            memories: this.memories,
            timestamp: Date.now(),
            version: '1.0'
        }, null, 2);
    }

    importMemories(jsonData) {
        try {
            const data = JSON.parse(jsonData);
            if (data.memories && Array.isArray(data.memories)) {
                this.memories = data.memories;
                this.saveToStorage();
                return true;
            }
        } catch (err) {
            console.error('[Memory] Import failed:', err);
        }
        return false;
    }

    getStats() {
        const now = Date.now();
        const day = 24 * 60 * 60 * 1000;
        const today = this.memories.filter(m => now - m.timestamp < day).length;
        const week = this.memories.filter(m => now - m.timestamp < 7 * day).length;

        return {
            totalMemories: this.memories.length,
            todayMemories: today,
            weekMemories: week,
            oldestMemory: this.memories[0]?.timestamp,
            newestMemory: this.memories[this.memories.length - 1]?.timestamp
        };
    }

    // Search by date range
    getMemoriesByDateRange(startTime, endTime) {
        return this.memories.filter(m =>
            m.timestamp >= startTime && m.timestamp <= endTime
        );
    }

    // Search by keyword
    searchByKeyword(keyword) {
        const kw = keyword.toLowerCase();
        return this.memories.filter(m =>
            m.content.toLowerCase().includes(kw) ||
            m.keywords.includes(kw)
        );
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MemorySystem };
}


