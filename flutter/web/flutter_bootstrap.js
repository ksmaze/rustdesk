// Custom Flutter bootstrap for RustDesk web client
// See: https://docs.flutter.dev/platform-integration/web/initialization

{{flutter_js}}
{{flutter_build_config}}

_flutter.loader.load({
  config: {
    // Load canvaskit from local server, not Google CDN
    canvasKitBaseUrl: "canvaskit/"
  },
  serviceWorkerSettings: {
    serviceWorkerVersion: {{flutter_service_worker_version}}
  },
  onEntrypointLoaded: async function(engineInitializer) {
    let appRunner = await engineInitializer.initializeEngine();
    // Remove the loading spinner
    var el = document.querySelector(".loading");
    if (el) el.remove();
    await appRunner.runApp();
  }
});
