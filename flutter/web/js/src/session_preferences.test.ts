import assert from "node:assert/strict";
import { test } from "node:test";
import { customVideoOptions, isAudioMuted } from "./session_preferences.js";

test("new peers inherit Mute and an explicitly unmuted peer stays unmuted", () => {
  const defaults = { disable_audio: "Y" };
  assert.equal(isAudioMuted({}, defaults), true);
  assert.equal(isAudioMuted({ "disable-audio": false }, defaults), false);
  assert.equal(isAudioMuted({}, {}), false);
});

test("custom video settings encode the saved slider values for a LAN session", () => {
  assert.deepEqual(customVideoOptions("150.0", "20.0", true), {
    custom_image_quality: 150 << 8,
    custom_fps: 20,
  });
});
