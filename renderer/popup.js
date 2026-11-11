(function () {
  var GRACE_MS = 1200;
  var started = Date.now();
  var dismissOnInput = true;

  function dismiss() { window.popup.dismiss(); }
  function afterGrace() { return Date.now() - started > GRACE_MS; }

  window.popup.onContent(function (data) {
    started = Date.now();
    dismissOnInput = data.dismissOnInput !== false;

    var card = document.getElementById("card");
    var photo = document.getElementById("photo");
    if (data.image) {
      photo.src = data.image;
      card.classList.remove("no-image");
    } else {
      photo.removeAttribute("src");
      card.classList.add("no-image");
    }

    var timer = document.getElementById("timer");
    timer.style.animation = "none";
    void timer.offsetWidth; // restart the drain animation
    timer.style.animation = "drain " + (data.displaySec || 18) + "s linear forwards";
    card.classList.add("ready");
  });

  document.addEventListener("click", dismiss);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" || (dismissOnInput && afterGrace())) dismiss();
  });
  document.addEventListener("mousemove", function (e) {
    // Ignore the synthetic move that can fire while the window maps.
    if (e.movementX === 0 && e.movementY === 0) return;
    if (dismissOnInput && afterGrace()) dismiss();
  });

  // A file can be corrupt or mislabeled even when its extension says it is an
  // image. Tell the main process so that file is retired instead of leaving a
  // blank card on screen.
  document.getElementById("photo").addEventListener("error", function () {
    if (!this.getAttribute("src")) return;
    window.popup.imageFailed();
  });
})();
