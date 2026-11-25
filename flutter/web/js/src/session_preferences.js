// Session commands predate the corresponding keys in Display Settings.
const defaultKeys = {
  "view-only": "view_only",
  "show-my-cursor": "show_my_cursor",
  "show-remote-cursor": "show_remote_cursor",
  "follow-remote-cursor": "follow_remote_cursor",
  "follow-remote-window": "follow_remote_window",
  "show-quality-monitor": "show_quality_monitor",
  "disable-audio": "disable_audio",
  "disable-clipboard": "disable_clipboard",
  "lock-after-session-end": "lock_after_session_end",
  "privacy-mode": "privacy_mode",
};

export function sessionToggle(peerOptions, userDefaults, name) {
  const value = peerOptions?.[name] ?? userDefaults[defaultKeys[name] ?? name];
  return value === true || value === "true" || value === "Y";
}

// The native client sends the quality percentage in the high byte and
// limits higher settings to direct connections or a private server.
export function customVideoOptions(qualityValue, fpsValue, allowMore) {
  const quality = Number(qualityValue);
  const fps = Number(fpsValue);
  const validQuality = Number.isInteger(quality) && quality >= 10 && quality <= (allowMore ? 2000 : 100);
  const validFps = Number.isInteger(fps) && fps >= 5 && fps <= (allowMore ? 120 : 30);
  return {
    custom_image_quality: (validQuality ? quality : 50) << 8,
    custom_fps: validFps ? fps : 30,
  };
}
