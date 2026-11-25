export function isAudioMuted(peerOptions, userDefaults) {
  const mute = peerOptions?.["disable-audio"] ?? userDefaults.disable_audio;
  return mute === true || mute === "Y";
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
