document.addEventListener('DOMContentLoaded', function () {
  // ISI Read More offcanvas is handled by Bootstrap data attributes.
  // ZIP search demo handler
  var goBtn = document.querySelector('.epc-go-btn');
  if (goBtn) {
    goBtn.addEventListener('click', function (e) {
      e.preventDefault();
    });
  }
});
