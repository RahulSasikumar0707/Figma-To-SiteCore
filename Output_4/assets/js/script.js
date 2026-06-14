(function () {
  "use strict";

  // Smooth-scroll guard for placeholder anchors
  document.querySelectorAll('a[href="#"]').forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
    });
  });

  // Language selector toggle (visual only placeholder)
  var lang = document.querySelector(".figma-page .hero-lang");
  if (lang) {
    lang.style.cursor = "pointer";
    lang.addEventListener("click", function () {
      lang.classList.toggle("is-open");
    });
  }
})();
