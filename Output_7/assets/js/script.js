document.addEventListener('DOMContentLoaded', function () {
  // ISI offcanvas is handled by Bootstrap bundle.
  // Smooth, accessible focus on Read More open (optional enhancement).
  var offcanvasEl = document.getElementById('offcanvasRight');
  if (offcanvasEl) {
    offcanvasEl.addEventListener('shown.bs.offcanvas', function () {
      var heading = offcanvasEl.querySelector('.section-heading');
      if (heading) heading.setAttribute('tabindex', '-1');
    });
  }
});
