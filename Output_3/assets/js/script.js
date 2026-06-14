document.addEventListener('DOMContentLoaded', function () {
  // Video player link placeholders (would open modal/player in production)
  document.querySelectorAll('.player-link, .watch-link').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
    });
  });
});
