document.addEventListener('DOMContentLoaded', function () {
  // ZIP code "Go" button (no-op demo handler)
  var goBtn = document.querySelector('.ep-zip-go');
  if (goBtn) {
    goBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var input = document.querySelector('.ep-zip-input');
      if (input && input.value.trim()) {
        console.log('ZIP search:', input.value.trim());
      }
    });
  }

  // ISI offcanvas tab/section reset on open
  var offcanvasEl = document.getElementById('offcanvasRight');
  if (offcanvasEl) {
    offcanvasEl.addEventListener('shown.bs.offcanvas', function () {
      var body = offcanvasEl.querySelector('.isi-body');
      if (body) { body.scrollTop = 0; }
    });
  }
});
