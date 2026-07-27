const { exec } = require("child_process");

require("./server");

if (process.platform === "win32") {
  setTimeout(() => {
    try {
      exec('cmd /c start "" "http://localhost:3000"', (error) => {
        if (error) console.warn(`Browser auto-open failed: ${error.message}`);
      });
    } catch (error) {
      console.warn(`Browser auto-open failed: ${error.message}`);
    }
  }, 1400);
}
