if (!window.process) {
  window.process = {
    platform: /Mac|Darwin/i.test(navigator.platform)
      ? "darwin"
      : /Win/i.test(navigator.platform)
        ? "win32"
        : "linux",
    env: { NODE_ENV: "production" },
  };
}
