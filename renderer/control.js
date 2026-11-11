(function () {
  function every(sec) {
    if (sec < 60) return sec + " seconds";
    var min = Math.round(sec / 60);
    return min + " minute" + (min >= 2 ? "s" : "");
  }

  function render(s) {
    document.getElementById("state").textContent = s.paused ? "Paused" : "Running";
    document.getElementById("state").classList.toggle("paused", s.paused);
    document.getElementById("images").textContent = s.images + (s.images === 1 ? " image" : " images");
    document.getElementById("idle").textContent = every(s.idleThresholdSec) + " idle";
    document.getElementById("cooldown").textContent = every(s.cooldownSec);
    document.getElementById("display").textContent = every(s.displaySec);
    document.getElementById("suppress").textContent = s.suppress ? "Yes" : "No";
    document.getElementById("detection").textContent = s.idle;
    document.getElementById("pause").textContent = s.paused ? "Resume" : "Pause";
    document.getElementById("autostart").checked = s.startAtLogin;
  }

  function refresh() {
    window.control.status().then(render).catch(function () {});
  }

  document.getElementById("show").addEventListener("click", function () {
    window.control.showNow();
  });
  document.getElementById("pause").addEventListener("click", function () {
    window.control.togglePause().then(render).catch(function () {});
  });
  document.getElementById("quit").addEventListener("click", function () {
    window.control.quit();
  });
  document.getElementById("autostart").addEventListener("change", function () {
    window.control.toggleAutoStart().then(render).catch(function () {});
  });

  refresh();
})();
