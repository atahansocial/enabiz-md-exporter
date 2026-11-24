/**
 * Background service worker for e-Nabız Markdown Arşivleyici.
 * Opens the Side Panel directly when the extension toolbar icon is clicked.
 */

async function configureSidePanel() {
  if (chrome.sidePanel?.setPanelBehavior) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch {
      // Ignore on browsers that don't support setPanelBehavior
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanel();
});
