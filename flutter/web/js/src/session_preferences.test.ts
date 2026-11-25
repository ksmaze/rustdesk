import assert from "node:assert/strict";
import { test } from "node:test";
import { customVideoOptions, sessionToggle } from "./session_preferences.js";

test("session toggles inherit display defaults and respect explicit peer overrides", () => {
  const defaults = { disable_audio: "Y", follow_remote_window: "Y", "zoom-cursor": "Y" };
  assert.equal(sessionToggle({}, defaults, "disable-audio"), true);
  assert.equal(sessionToggle({ "disable-audio": false }, defaults, "disable-audio"), false);
  assert.equal(sessionToggle({}, defaults, "follow-remote-window"), true);
  assert.equal(sessionToggle({ "zoom-cursor": "" }, defaults, "zoom-cursor"), false);
  assert.equal(sessionToggle({ "view-only": "N" }, {}, "view-only"), false);
});

test("custom video settings encode the saved slider values for a LAN session", () => {
  assert.deepEqual(customVideoOptions("150.0", "20.0", true), {
    custom_image_quality: 150 << 8,
    custom_fps: 20,
  });
});
