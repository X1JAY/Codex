import { AudioCaptureController } from "../services/audioCapture/controller";
import { authorizedTabStore, rawErrorMessage } from "../services/actionAuthorization";
import { TranscriptionController } from "../services/transcription/controller";
import { FullTranscriptionController } from "../services/fullTranscription/controller";
import { LearningAnalysisController } from "../services/learningAnalysis/controller";
import { ensureContentScript } from "../services/contentScript/bridge";
import { handleToolbarActionClick, type ActionClickLogger } from "./actionClick";

const audioCaptureController = new AudioCaptureController();
audioCaptureController.register();
const transcriptionController = new TranscriptionController(audioCaptureController);
transcriptionController.register();
const fullTranscriptionController = new FullTranscriptionController(audioCaptureController);
fullTranscriptionController.register();
const learningAnalysisController = new LearningAnalysisController();
learningAnalysisController.register();

function disableAutomaticSidePanelOpen(): void {
  if (!chrome.sidePanel?.setPanelBehavior) {
    return;
  }

  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((error: unknown) => {
      console.error(
        `[action] failed to disable openPanelOnActionClick rawError=${rawErrorMessage(error)}`,
      );
    });
}

// Explicitly clear the behavior persisted by earlier extension builds. This
// runs outside the toolbar-click user gesture; onClicked remains the only
// action entry that opens the panel.
disableAutomaticSidePanelOpen();

chrome.runtime.onInstalled.addListener(disableAutomaticSidePanelOpen);
chrome.runtime.onStartup.addListener(disableAutomaticSidePanelOpen);

const actionLogger: ActionClickLogger = {
  log(message, details) {
    if (details === undefined) {
      console.log(message);
    } else {
      console.log(message, details);
    }
  },
  error(message, details) {
    if (details === undefined) {
      console.error(message);
    } else {
      console.error(message, details);
    }
  }
};

chrome.action.onClicked.addListener((tab) => {
  try {
    const result = handleToolbarActionClick(tab, {
      store: authorizedTabStore,
      logger: actionLogger,
      openSidePanel: (tabId) => {
        if (!chrome.sidePanel?.open) {
          return Promise.reject(new Error("chrome.sidePanel.open is unavailable"));
        }
        return chrome.sidePanel.open({ tabId });
      },
      ensureContentScript,
    });

    if (result.status === "started") {
      void result.sidePanelTask;
      void result.persistenceTask;
      void result.contentScriptTask;
    }
  } catch (error) {
    console.error(
      `[action] onClicked flow failed rawError=${rawErrorMessage(error)}`,
    );
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void authorizedTabStore.invalidateIfTabClosed(tabId).then((invalidated) => {
    if (invalidated) {
      console.debug(`[action] authorized tab removed tab id=${tabId}`);
    }
  }).catch((error: unknown) => {
    console.error(
      `[action] failed to invalidate removed tab rawError=${rawErrorMessage(error)}`,
    );
  });
});
