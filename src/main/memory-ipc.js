/**
 * Memory IPC - Handle memory persistence via file system
 */
const { ipcMain } = require('electron');
const fs = require('fs').promises;
const path = require('path');

function setupMemoryIPC(app) {
    const memoryFilePath = path.join(app.getPath('userData'), 'memories.json');

    // Save memories to file
    ipcMain.handle('memory:save', async (event, data) => {
        try {
            await fs.writeFile(memoryFilePath, JSON.stringify(data, null, 2), 'utf-8');
            return { success: true };
        } catch (error) {
            console.error('[Memory IPC] Save failed:', error);
            return { success: false, error: error.message };
        }
    });

    // Load memories from file
    ipcMain.handle('memory:load', async () => {
        try {
            const data = await fs.readFile(memoryFilePath, 'utf-8');
            return { success: true, data: JSON.parse(data) };
        } catch (error) {
            if (error.code === 'ENOENT') {
                // File doesn't exist yet
                return { success: true, data: null };
            }
            console.error('[Memory IPC] Load failed:', error);
            return { success: false, error: error.message };
        }
    });

    // Export memories
    ipcMain.handle('memory:export', async () => {
        try {
            const data = await fs.readFile(memoryFilePath, 'utf-8');
            return { success: true, data };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Import memories
    ipcMain.handle('memory:import', async (event, jsonData) => {
        try {
            // Validate JSON first
            JSON.parse(jsonData);
            await fs.writeFile(memoryFilePath, jsonData, 'utf-8');
            return { success: true };
        } catch (error) {
            console.error('[Memory IPC] Import failed:', error);
            return { success: false, error: error.message };
        }
    });

    // Clear all memories
    ipcMain.handle('memory:clear', async () => {
        try {
            await fs.unlink(memoryFilePath);
            return { success: true };
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { success: true }; // Already doesn't exist
            }
            return { success: false, error: error.message };
        }
    });

    console.log('[Memory IPC] Initialized, file path:', memoryFilePath);
}

module.exports = { setupMemoryIPC };
