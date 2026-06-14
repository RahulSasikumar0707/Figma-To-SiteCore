(function () {
  "use strict";

  // Toggle aria-expanded state visuals for accordion chevrons (Bootstrap handles collapse)
  document.addEventListener("DOMContentLoaded", function () {
    var buttons = document.querySelectorAll(".figma-page .livdelzi-accordion .accordion-button");
    buttons.forEach(function (btn) {
      var target = document.querySelector(btn.getAttribute("data-bs-target"));
      if (!target) return;
      target.addEventListener("shown.bs.collapse", function () {
        btn.classList.remove("collapsed");
      });
      target.addEventListener("hidden.bs.collapse", function () {
        btn.classList.add("collapsed");
      });
    });
  });
})();
