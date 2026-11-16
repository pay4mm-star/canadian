// Countdown timers, photo gallery and small form helpers. The site works without this file.
(function () {
  function left(ms) {
    var s = Math.floor((ms - Date.now()) / 1000);
    if (s <= 0) return 'Ended';
    var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  }
  var timers = document.querySelectorAll('[data-ends]');
  if (timers.length) setInterval(function () { timers.forEach(function (el) { el.textContent = left(+el.dataset.ends); }); }, 1000);

  document.querySelectorAll('.gallery .thumbs button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelector('.gallery .big img').src = b.dataset.src;
      document.querySelectorAll('.gallery .thumbs button').forEach(function (x) { x.setAttribute('aria-current', x === b); });
    });
  });

  // Show only the fields that apply to the chosen listing format and shipping mode.
  function toggle(selectId, attr) {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    function apply() { document.querySelectorAll('[' + attr + ']').forEach(function (el) { el.hidden = el.getAttribute(attr).split(' ').indexOf(sel.value) < 0; }); }
    sel.addEventListener('change', apply); apply();
  }
  toggle('format', 'data-format');
  toggle('ship_mode', 'data-ship');
  toggle('ship_country', 'data-country');
})();
