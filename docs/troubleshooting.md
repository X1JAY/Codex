# Troubleshooting

## The panel says the page is not Douyin

Open a page under `https://www.douyin.com/` or another HTTPS `*.douyin.com` hostname. The extension deliberately does not treat arbitrary pages as Douyin.

## The panel cannot connect to the content script

After loading or reloading the unpacked extension, refresh the Douyin tab. Chrome does not retroactively inject a newly loaded content script into an already open page.

## No current video is detected

Play the target video or scroll it into view, then click the extraction button again. Phase 2 chooses a visible video element, preferring a playing video and then the largest visible video near the viewport center.

## A video is detected but no caption is found

This is a supported partial-result state. The adapter returns the URL, ID, author, and any hashtags it can identify, while the panel explains that no visible caption was found. Selector changes belong in `extension/src/content/adapters/douyin.ts`.

## Audio capture says the current tab is unavailable

Phase 3A only captures an active HTTPS Douyin tab after the user invokes the extension. Keep the target tab active, start playback, and click **测试音频捕获** from that tab's Side Panel. A background tab, closed tab, non-Douyin page, or a page that Chrome does not permit to capture will return an explicit error.

## The video keeps playing but capture has no audio

The Offscreen Document requires an audio track from `getUserMedia`. Check that the video is actually playing and not muted at the tab level. If Chrome supplies a stream without audio, the extension reports `NO_AUDIO_TRACK` and does not attempt to read a temporary media URL.

## The capture result is empty

The extension treats a zero-byte Blob as an error, stops every track, closes the AudioContext, clears timers/listeners, and leaves the session in an error state. Retry after the video has produced audible playback data.

## The Side Panel was closed during recording

Closing the Side Panel does not intentionally cancel the capture. The Offscreen Document continues up to the 15-second limit and keeps only result metadata in session storage. Reopen the Side Panel to read the current status. The audio Blob itself remains only in the Offscreen Document's memory and is not persisted.
