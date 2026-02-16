/**
 * ScreenCapture — Screen capture, window detection, idle time.
 * Extracted from main.js lines 488-530.
 */
function registerScreenCapture(ctx, ipcMain, deps) {
    // deps: { desktopCapturer, powerMonitor }
    const { desktopCapturer, powerMonitor } = deps;

    ipcMain.handle('get-screen-capture', async (event, targetTitle) => {
        try {
            // If a window title is given, try capturing only that window (excludes pet overlay)
            if (targetTitle) {
                const winSources = await desktopCapturer.getSources({
                    types: ['window'], thumbnailSize: { width: 512, height: 512 }
                });
                const match = winSources.find(s => s.name === targetTitle);
                if (match) {
                    return match.thumbnail.toJPEG(30).toString('base64');
                }
            }
            // Fallback: full screen capture
            const sources = await desktopCapturer.getSources({
                types: ['screen'], thumbnailSize: { width: 512, height: 512 }
            });
            if (sources.length > 0) {
                return sources[0].thumbnail.toJPEG(30).toString('base64');
            }
            return null;
        } catch (error) {
            console.error('Screen capture failed:', error);
            return null;
        }
    });

    // High-quality window capture: targets specific window at 1024px, excludes pet overlay
    ipcMain.handle('get-screen-capture-hq', async (event, targetTitle) => {
        try {
            if (targetTitle) {
                const winSources = await desktopCapturer.getSources({
                    types: ['window'], thumbnailSize: { width: 1024, height: 1024 }
                });
                const match = winSources.find(s => s.name === targetTitle);
                if (match) {
                    return match.thumbnail.toJPEG(50).toString('base64');
                }
            }
            // Fallback: full screen at higher quality
            const sources = await desktopCapturer.getSources({
                types: ['screen'], thumbnailSize: { width: 1024, height: 1024 }
            });
            if (sources.length > 0) {
                return sources[0].thumbnail.toJPEG(50).toString('base64');
            }
            return null;
        } catch (error) {
            console.error('HQ screen capture failed:', error);
            return null;
        }
    });

    ipcMain.handle('get-active-window', async () => {
        try {
            const activeWin = (await import('active-win')).default;
            const result = await activeWin();
            if (result) return { success: true, data: result };
            return { success: false, error: 'no active window' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-open-windows', async () => {
        try {
            const { getOpenWindows } = await import('active-win');
            const windows = await getOpenWindows();
            return { success: true, data: windows || [] };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-system-idle-time', () => {
        return powerMonitor.getSystemIdleTime();
    });
}

module.exports = { registerScreenCapture };
